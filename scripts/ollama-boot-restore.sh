#!/bin/bash
# ollama-boot-restore.sh -- auto-restart Ollama after a machine reboot (card b9a657e6).
#
# Unifies the earlier one-shot manual fix with bbd0c4dd's ask into ONE mechanism, not two:
# bbd0c4dd ("Ollama automatikus visszaindítása gép-újraindulás után") asked for the same
# boot-reconciler hook, health line and pid/port dedup this script provides, and was never built
# (still `planned` when this card started) -- so there is nothing separate to merge, this IS that
# mechanism, and bbd0c4dd's scope is a subset of this one.
#
# Incident (2026-09-19): WSL down 22:25-07:21, the desired-agent reconciler (channel-monitor.ts's
# reconcileDesiredAgents(), the "boot-reconciler" this script's caller wraps) brought the 7 desired
# agents back by 07:26, but nothing restarted Ollama -- every local-first route fell back to ONLINE
# until Peti started it by hand at 08:22 (setsid nohup ollama serve; there was no systemd unit for
# ollama on this box at the time, despite local-llm.sh's ollama_start_hint() assuming `systemctl
# --user start ollama` would work).
#
# UPDATE (card 085444e9): the unit this script's own comment above wished for now exists
# (~/.config/systemd/user/ollama.service, card 8192b9ee, plus the OLLAMA_VULKAN=0 drop-in from card
# 53fffd74) -- but this script still started a bare `nohup ollama serve`, bypassing it (RedHat F-RH4,
# card 39b958a4 comment 19024), so a boot-restore started Ollama WITHOUT the dxgkrnl mitigation and
# the flash-attention/KV-cache tuning. Fixed below: restart now goes through the unit.
#
# Intended caller: channel-monitor.ts's periodic sweep (~60s cadence, same one that runs
# reconcileDesiredAgents()), invoked ONCE per sweep, BEFORE agents are reconciled -- so a sub-agent's
# first local-first attempt after a reboot finds Ollama already answering, instead of falling back to
# ONLINE and not trying local-first again until the next router call re-checks health (which it
# already does on every call; see the switchback note at the bottom).
#
# Guards, in order -- any one refusing is a clean "did nothing this cycle", exit 0, not an error:
#   1. pid/port check -- already listening -> nothing to do (never start a second instance, see
#      memory an-empty-log-is-not-a-dead-process: a duplicate would fight the original for the GPU).
#   2. gpu-crashloop-guard's masked flag (.gpu-crashloop-guard-masked.json, same path convention as
#      local-llm.sh's gpu_guard_mask_note()) -- respects a deliberate stop. Never auto-unmasks (that
#      stays a human/MikroB act, same rule gpu-crashloop-guard.sh itself follows); alerts the owner
#      ONCE per distinct mask (not every 60s sweep) that a restore attempt was deferred because of it
#      -- a signal distinct from gpu-crashloop-guard's own crash-detection alert.
#   3. boot stability -- uptime must be >= OLLAMA_RESTORE_MIN_UPTIME_SEC, so this never races a
#      still-booting kernel/GPU driver.
#   4. dxgkrnl crash check -- 0 dxgkrnl WARNING/crash-boot lines in the CURRENT boot's kernel log
#      (same journalctl -k -b 0 + regex gpu-crashloop-guard.sh uses to detect the same fault), so a
#      fresh crash-loop is not immediately re-poked by a naive restart before the guard has had a
#      chance to detect and mask it.
#
# All clear -> `setsid nohup ollama serve` (detached: survives this script's own exit) + probe
# (/api/tags, then a best-effort 1-token generate against the configured model) + log.
#
# SWITCHBACK (item 4 of the card, second half): the local-first router (store/route-classify.sh /
# card-build-route.sh) already re-checks Ollama's live health on every call -- there is no separate
# "restart dispatch" to write. This script logs that fact explicitly on a successful restore so the
# switchback is visible in the log, not just implied.
#
# Env seams (mirrors gpu-crashloop-guard.sh's naming):
#   OLLAMA_RESTORE_STATE_DIR       - state dir (default <install>/store)
#   OLLAMA_RESTORE_DRYRUN          - if 1, print what would run instead of starting Ollama
#   OLLAMA_RESTORE_MIN_UPTIME_SEC  - minimum uptime before considering a restart (default 300)
#   OLLAMA_RESTORE_UPTIME_OVERRIDE - path to a file standing in for /proc/uptime's first field (test)
#   OLLAMA_RESTORE_DMESG_OVERRIDE  - path to a file standing in for `journalctl -k -b 0` (test seam)
#   OLLAMA_RESTORE_PORT_CHECK_OVERRIDE - "up" or "down", stands in for the pid/port check (test seam)
#   OLLAMA_RESTORE_START_CMD_OVERRIDE  - command to run instead of `systemctl --user start <unit>` (test)
#   OLLAMA_RESTORE_UNIT_NAME       - the systemd --user unit to start (default ollama)
#   OLLAMA_RESTORE_ALERT_DRYRUN    - if 1, print "ALERT_DRYRUN: <msg>" instead of a real Telegram send
#   (a failed restart alerts via the same alert_owner() + OLLAMA_RESTORE_ALERT_DRYRUN seam, rate-
#   limited by $STATE_DIR/.ollama-boot-restore-fail-alerted -- one alert per failure streak, cleared
#   on the next successful start)
#   OLLAMA_HOST                    - Ollama base URL (default http://127.0.0.1:11434)
#
# CLI: ollama-boot-restore.sh   -- one cycle (what the caller runs every sweep)

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${OLLAMA_RESTORE_STATE_DIR:-$INSTALL_DIR/store}"
OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
MIN_UPTIME_SEC="${OLLAMA_RESTORE_MIN_UPTIME_SEC:-300}"
MASKED_FLAG="$STATE_DIR/.gpu-crashloop-guard-masked.json"
MASK_ALERTED_STAMP="$STATE_DIR/.ollama-boot-restore-mask-alerted"
FAIL_ALERTED_STAMP="$STATE_DIR/.ollama-boot-restore-fail-alerted"
TG_ENV="$HOME/.claude/channels/telegram/.env"
MODEL_FILE="$STATE_DIR/local-llm-model"
UNIT_NAME="${OLLAMA_RESTORE_UNIT_NAME:-ollama}"

log() { echo "ollama-boot-restore: $*"; }

# Same direct-Bot-API pattern as gpu-crashloop-guard.sh's alert_owner (duplicated on purpose --
# see wiring-manifest-guards.test.ts's stripComments comment for this repo's stance on a two-line
# helper with no shared module: kept in sync by hand rather than forced into a shared dependency).
alert_owner() {
  local msg="$1" token chat
  if [ "${OLLAMA_RESTORE_ALERT_DRYRUN:-}" = "1" ]; then
    echo "ALERT_DRYRUN: $msg"; return 0
  fi
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  chat="$(grep -E '^ALLOWED_CHAT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  [ -z "$chat" ] && chat="$(grep -E '^TELEGRAM_CHAT_ID=' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  if [ -z "$token" ] || [ -z "$chat" ]; then
    log "ALERT (no bot token or owner chat id configured, could not Telegram): $msg"; return 1
  fi
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" \
    | curl -s -m 10 -o /dev/null -K - \
    --data-urlencode "chat_id=${chat}" --data-urlencode "text=${msg}" \
    && log "owner alerted via direct Bot API" || log "ALERT sendMessage FAILED: $msg"
}

ollama_up() { curl -fsS -m 5 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; }

# Guard 1: pid/port check. Port first (cheap, no HTTP round-trip); pgrep as a fallback for a process
# that is up but not yet accepting connections (still loading a model into VRAM).
already_running_or_listening() {
  if [ -n "${OLLAMA_RESTORE_PORT_CHECK_OVERRIDE:-}" ]; then
    [ "$OLLAMA_RESTORE_PORT_CHECK_OVERRIDE" = "up" ] && return 0
    return 1
  fi
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ':11434[[:space:]]'; then
    return 0
  fi
  pgrep -f '(^|/)ollama serve' >/dev/null 2>&1
}

# Guard 3: boot stability.
get_uptime_sec() {
  if [ -n "${OLLAMA_RESTORE_UPTIME_OVERRIDE:-}" ]; then
    cut -d. -f1 "$OLLAMA_RESTORE_UPTIME_OVERRIDE" 2>/dev/null
  else
    cut -d. -f1 /proc/uptime 2>/dev/null
  fi
}

# Guard 4: same signature gpu-crashloop-guard.sh's boot_has_dxg_oops() checks, against the CURRENT
# boot (`-b 0`) rather than a completed one -- this script cares about "is the running kernel
# already showing the fault", not "did a past boot show it".
dxg_seen_this_boot() {
  local text status
  if [ -n "${OLLAMA_RESTORE_DMESG_OVERRIDE:-}" ]; then
    text="$(cat "$OLLAMA_RESTORE_DMESG_OVERRIDE" 2>/dev/null)"
    status=$?
  else
    text="$(journalctl -k -b 0 2>/dev/null)"
    status=$?
  fi
  # Card 39b958a4 (Cybersec F1, GO b9a657e6 comment 5821): a command failure is NOT the same as "a
  # successfully-read log with no dxgkrnl lines" -- the old `2>/dev/null` swallowed that distinction,
  # so an unreadable kernel log fell through to "no match" and started Ollama anyway, while
  # get_uptime_sec()'s own unreadable case fails closed. Mirror that stance here.
  if [ "$status" -ne 0 ]; then
    return 0
  fi
  # RedHat NO-GO F-RH1 (card 39b958a4, comment 19024): exit 0 with nothing useful in it -- empty
  # output, "-- No entries --", or only a stderr permission hint that `2>/dev/null` already discarded
  # -- is just as unreadable as a nonzero exit, and must defer the same way. Every real
  # `journalctl -k` line carries a "kernel:" field; its absence means the log was not actually read.
  case "$text" in
    *kernel:*) ;;
    *) return 0 ;;
  esac
  echo "$text" | grep -qE 'dxgk_ioctl|dxgadapter_release_lock|misc dxg: dxgk'
}

# Guard 2, part of it: has the CURRENT mask already been alerted on? Keyed on the flag's own
# detected_at, so a NEW mask (different detected_at) alerts again but a persisting one does not spam
# every 60s sweep.
mask_detected_at() {
  python3 -c '
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        print(json.load(fh).get("detected_at", ""))
except Exception:
    print("")
' "$MASKED_FLAG" 2>/dev/null
}

mask_restore_hint() {
  python3 -c '
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        d = json.load(fh)
    print(d.get("restore", ""))
except Exception:
    print("")
' "$MASKED_FLAG" 2>/dev/null
}

main() {
  if already_running_or_listening; then
    log "Ollama already up (port/pid check) -- nothing to do"
    return 0
  fi

  if ollama_up; then
    log "Ollama already answering /api/tags -- nothing to do"
    return 0
  fi

  if [ -f "$MASKED_FLAG" ]; then
    local detected_at alerted_at hint
    detected_at="$(mask_detected_at)"
    alerted_at="$(cat "$MASK_ALERTED_STAMP" 2>/dev/null || echo "")"
    hint="$(mask_restore_hint)"
    log "Ollama down, but gpu-crashloop-guard has it MASKED -- deferring, not restarting (restore: ${hint:-see .gpu-crashloop-guard-masked.json})"
    if [ -n "$detected_at" ] && [ "$detected_at" != "$alerted_at" ]; then
      alert_owner "Ollama helyi-LLM leallva maradt: gpu-crashloop-guard MASZKOLTA (visszakapcsolashoz: ${hint:-lasd .gpu-crashloop-guard-masked.json}). Nem inditom automatikusan ujra."
      mkdir -p "$STATE_DIR"
      echo "$detected_at" > "$MASK_ALERTED_STAMP"
    fi
    return 0
  fi

  local uptime
  uptime="$(get_uptime_sec)"
  case "$uptime" in
    ''|*[!0-9]*)
      log "could not read uptime -- not restarting this cycle (fail-closed: never restart on an unreadable signal)"
      return 0
      ;;
  esac
  if [ "$uptime" -lt "$MIN_UPTIME_SEC" ]; then
    log "boot not yet stable (uptime ${uptime}s < ${MIN_UPTIME_SEC}s) -- deferring to a later sweep"
    return 0
  fi

  if dxg_seen_this_boot; then
    log "dxgkrnl fault signature already present in this boot's kernel log, or the log could not be read -- deferring, letting gpu-crashloop-guard.sh's own timer classify/mask it rather than racing a restart against a live crash-loop"
    return 0
  fi

  # Guard 5 (card f67ce51e, WhiteHat2 16744 off the d57d8a01 gate): this restore used to start
  # Ollama regardless of the local-first-draft kill switch -- if Peti switched local-first OFF,
  # the boot-restore flipped it back ON every time the box rebooted, which defeats the point of a
  # switch. Reuses the SAME STORE_DIR-based reader card d57d8a01 fixed for every other caller
  # (local-first-draft-check.sh's local_first_draft_enabled), pointed at THIS install's own
  # STATE_DIR directly -- no worktree-resolution ambiguity here, since this script always runs
  # from the live install, never a copy in an agent worktree.
  if [ -z "${OLLAMA_RESTORE_IGNORE_LOCAL_FIRST_SWITCH:-}" ]; then
    local lfd_lib="$INSTALL_DIR/store/local-first-draft-check.sh"
    if [ -r "$lfd_lib" ]; then
      # shellcheck source=/dev/null
      . "$lfd_lib"
      if ! LOCAL_FIRST_DRAFT_FLAG_FILE="$STATE_DIR/local-first-draft.json" local_first_draft_enabled; then
        log "local-first-draft switch is OFF ($STATE_DIR/local-first-draft.json) -- not starting Ollama (override: OLLAMA_RESTORE_IGNORE_LOCAL_FIRST_SWITCH=1, logged if used)"
        return 0
      fi
    else
      log "WARN: $lfd_lib not found -- cannot check the local-first-draft switch, proceeding as if ON (same fail-open default that file's own absence case uses)"
    fi
  else
    log "OLLAMA_RESTORE_IGNORE_LOCAL_FIRST_SWITCH=1 -- starting Ollama regardless of the local-first-draft switch"
  fi

  # WhiteHat2 HIGH (card 085444e9 fix round): the production caller (channel-monitor.ts's
  # buildOllamaRestoreEnv(), pinned by ollama-boot-restore-narrow-env.test.ts) hands this script
  # ONLY PATH, HOME and an optional OLLAMA_HOST -- deliberately, so the detached ollama daemon never
  # inherits a secret from the dashboard process's full environment. But `systemctl --user` needs a
  # session bus to talk to, and without XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS it fails outright
  # ("Failed to connect to user scope bus ... XDG_RUNTIME_DIR not defined"), so every boot-restore
  # attempt in production was silently a no-op -- reproduced by WhiteHat2 under `env -i PATH HOME`.
  # Fixed here, in the script, NOT by widening channel-monitor.ts's narrow env (that pin stays): set
  # both, only if the caller did not already supply one (never override a real session's own bus).
  if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  fi
  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  fi

  # ONE shared variable for both the dryrun message and the real call (QA FAIL 28515 / WhiteHat2
  # MEDIUM, same fix round): the previous code built the dryrun log line and the executed command
  # from two separately-written expressions with the same text, so a mutation reverting ONLY the
  # real branch to a bare `nohup` left the dryrun string -- and the test pinning it -- unchanged and
  # green, even though every real restart under test (OLLAMA_RESTORE_DRYRUN unset) had regressed.
  # Card 085444e9 (RedHat F-RH4, 39b958a4 comment 19024): go through the systemd --user unit, not a
  # bare `nohup ollama serve`, so OLLAMA_VULKAN=0 (the dxgkrnl mitigation drop-in) and the
  # flash-attention/KV-cache tuning (card 8192b9ee) come from the SAME single source the unit itself
  # uses -- a bare nohup skips the unit's Environment= lines and its drop-in entirely.
  local start_cmd="${OLLAMA_RESTORE_START_CMD_OVERRIDE:-systemctl --user start $UNIT_NAME}"

  if [ "${OLLAMA_RESTORE_DRYRUN:-}" = "1" ]; then
    log "DRYRUN: would run: $start_cmd"
    return 0
  fi

  log "Ollama down, boot stable (${uptime}s), no dxgkrnl fault this boot, not masked -- restarting"
  eval "$start_cmd"
  local start_rc=$?
  if [ "$start_rc" -ne 0 ]; then
    # Loud, not a silent rc=0 (WhiteHat2 MEDIUM, same round): a failed restart must be visible to
    # whoever reads this script's log, not indistinguishable from "nothing needed doing".
    log "restart command failed (rc=${start_rc}): $start_cmd -- XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR} DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS} -- giving up this cycle, next sweep will retry"
    # Card 84181422 (WhiteHat2 CYBERSEC GO on 085444e9, c5243203e): the log line above was the only
    # trace -- channel-monitor.ts runs this script with stdio ignored, so a failing start was
    # invisible in production and repeated every sweep without ever reaching the owner. Same
    # alert-once-per-streak shape as the mask alert above (detected_at vs. a plain stamp file,
    # since a failure streak has no distinct identity to key on): alert once, then stay silent
    # until a start succeeds again.
    if [ ! -f "$FAIL_ALERTED_STAMP" ]; then
      alert_owner "Ollama boot-restore sikertelen (rc=${start_rc}): $start_cmd -- a kovetkezo sweep ujra probalja, tovabbi ertesites csak sikeres inditas utan jon."
      mkdir -p "$STATE_DIR"
      touch "$FAIL_ALERTED_STAMP"
    fi
    return 0
  fi
  rm -f "$FAIL_ALERTED_STAMP"

  local tries=0
  while [ "$tries" -lt 10 ]; do
    sleep 2
    if ollama_up; then break; fi
    tries=$((tries + 1))
  done

  if ! ollama_up; then
    log "restart attempted but /api/tags still not answering after ${tries} probes -- giving up this cycle, next sweep will retry"
    return 0
  fi
  log "/api/tags answering -- Ollama is back up"

  # Best-effort 1-token generate probe. Non-fatal either way: a missing/misconfigured model file must
  # not make this script report failure when the actual restart already succeeded (proven by /api/tags
  # above).
  if [ -f "$MODEL_FILE" ]; then
    local model
    model="$(tr -d '[:space:]' < "$MODEL_FILE" | head -c 200)"
    if [ -n "$model" ]; then
      if curl -fsS -m 30 -X POST "$OLLAMA_HOST/api/generate" \
        -d "{\"model\":\"${model}\",\"prompt\":\"hi\",\"stream\":false,\"options\":{\"num_predict\":1}}" \
        >/dev/null 2>&1; then
        log "1-token generate probe OK ($model)"
      else
        log "1-token generate probe FAILED ($model) -- /api/tags answers but generation does not yet; next sweep will re-probe"
      fi
    fi
  fi

  log "restore complete -- the local-first router re-checks Ollama health on every call, so routing resumes local-first automatically starting with the next card/dispatch, no separate switchback step needed"
}

main "$@"

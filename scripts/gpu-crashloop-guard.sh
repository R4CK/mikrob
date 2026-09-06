#!/bin/bash
# GPU (dxgkrnl) crash-loop guard for the WSL2 host (systemd --user timer, every minute).
#
# Incident it fixes (2026-08-03, recurred 2026-08-24): a GPU-passthrough kernel
# fault (dxgk_ioctl / dxgadapter_release_lock_shared, WSL's dxgkrnl driver) took
# down the ENTIRE WSL2 VM whenever Ollama's GPU discovery/inference touched the
# GPU on this box (GTX 1660 Ti). The VM auto-restarted every time (that is what
# WSL does on a VM crash), but each boot only lived ~30-40s before crashing
# again -- a silent ~5min-cycle crash-loop that looked to the owner like "WSL
# won't start", when it was actually restarting constantly and never staying up.
# The 2026-08-03 "fixed by a Windows NVIDIA driver update" conclusion did NOT
# hold: it recurred on 2026-08-24 with the confirmed-latest driver already
# installed, this time even without an active inference call (GPU discovery on
# boot was enough). See memory: wsl-vm-crashloop-ollama-gpu-dxgkrnl.
#
# THERE IS NO LAYER 1 TODAY -- THIS GUARD IS THE ONLY LAYER (card d5c05548).
#
# This header used to describe itself as "layer 2", under a CPU-only systemd
# drop-in (ollama.service.d/10-cpu-only-gpu-crashloop-safety.conf) that removed
# the GPU/dxg ioctl path entirely. That drop-in is GONE, on purpose: on
# 2026-08-24 Peti overrode the CPU-only stopgap because he wants the GPU as the
# PRIMARY path, and the drop-in was removed with the default GPU config restored
# (memory wsl-vm-crashloop-ollama-gpu-dxgkrnl; commit 13f92c99 records that the
# file was host-local and never versioned here). Measured again on 2026-09-06:
# /home/neon/.config/systemd/user/ollama.service.d/ does not exist at all.
#
# The old wording was not merely stale, it was load-bearing in the wrong
# direction: a reader deciding how hard this guard has to try would have
# believed a second, stronger mitigation was standing behind it. Nothing is.
# Whether a new lower layer should exist is Peti's call and is tracked on its
# own card, not assumed here.
#
# What this guard does: it detects the crash-loop signature from the outside
# (boot durations + kernel oops text), force-stops+masks the offending unit, and
# alerts the owner directly (Bot API, not MCP -- the in-session channel is one of
# the things that dies every cycle in a crash-loop, so it cannot be trusted to
# carry the alert).
#
# Determinism + safety:
#   - Thresholds are constants at the top.
#   - Only acts when BOTH the boot-duration pattern AND a dxgk-specific kernel
#     oops are present -- a short boot alone (e.g. host sleep/resume, a manual
#     `wsl --shutdown`) is not enough to mask a service.
#   - Masking (not just stop+disable) so a plain `systemctl --user enable`
#     mistake can't silently re-arm the GPU path; unmasking is a deliberate,
#     one-time human/MikroB act after a real fix.
#   - Never unmasks automatically -- no auto-recovery flip-flop.
#   - Alert cooldown so a persisting crash-loop pages the owner at most once/hour.
#
# Test hooks (env, used by scripts/__tests__/gpu-crashloop-guard.test.sh):
#   GPU_GUARD_BOOTS_OVERRIDE   - path to a file with `journalctl --list-boots` output
#   GPU_GUARD_KERNEL_LOG_OVERRIDE - path to a file standing in for `journalctl -k -b <idx>`
#   GPU_GUARD_STATE_DIR        - state dir (default <install>/store)
#   GPU_GUARD_ALERT_DRYRUN     - if 1, print "ALERT_DRYRUN: <msg>" not curl
#   GPU_GUARD_MASK_DRYRUN      - if 1, print "MASK_DRYRUN: <unit>" instead of systemctl mask
#   GPU_GUARD_UNITS            - space-separated systemd --user units to protect (default: ollama.service)
#   GPU_GUARD_SYSTEMCTL        - the systemctl binary to call (default: systemctl); the seam that
#                                lets the mask-fallback below be tested without a real service
#   GPU_GUARD_USER_UNIT_DIR    - where --user unit FILES live (default: ~/.config/systemd/user)
#
# CLI:
#   gpu-crashloop-guard.sh                 - one guard cycle (what the timer runs)
#   gpu-crashloop-guard.sh --restore-hint  - print the exact command that puts the masked units
#                                            back, read from the state flag. `unmask` ALONE IS NOT
#                                            ENOUGH and the difference is not obvious, so the answer
#                                            has to be askable at 3am without reading this file.

set -u

MIN_SHORT_BOOTS=3          # >= this many short boots ...
SHORT_BOOT_MAX_SEC=90      # ... each shorter than this (seconds) ...
RECENT_WINDOW_SEC=1800     # ... and ending within this many seconds of now = crash-loop
ALERT_COOLDOWN=3600        # at most one alert per hour while the loop persists

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${GPU_GUARD_STATE_DIR:-$INSTALL_DIR/store}"
ALERT_STAMP="$STATE_DIR/.gpu-crashloop-guard-alerted"
MASKED_FLAG="$STATE_DIR/.gpu-crashloop-guard-masked.json"
BASELINE_STAMP="$STATE_DIR/.gpu-crashloop-guard-baseline"
TG_ENV="$HOME/.claude/channels/telegram/.env"
LOG_TAG="gpu-crashloop-guard"
read -r -a UNITS <<< "${GPU_GUARD_UNITS:-ollama.service}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$LOG_TAG] $*" || true; }

# Direct Bot API alert (mirrors scripts/disk-space-guard.sh alert_owner) --
# bypasses MCP because the in-session channel is one of the casualties of a
# live crash-loop and cannot be trusted to deliver.
alert_owner() {
  local msg="$1" token chat
  if [ "${GPU_GUARD_ALERT_DRYRUN:-}" = "1" ]; then
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

# List of "start end" epoch-second pairs for completed boots (oldest first),
# most recent completed boot last. Boot 0 (the current, still-running boot)
# is excluded -- it has no end time yet.
list_boot_windows() {
  local raw
  if [ -n "${GPU_GUARD_BOOTS_OVERRIDE:-}" ]; then
    raw="$(cat "$GPU_GUARD_BOOTS_OVERRIDE" 2>/dev/null)"
  else
    raw="$(journalctl --list-boots 2>/dev/null)"
  fi
  [ -z "$raw" ] && return
  # Each line: "<idx> <boot-id> <start...> <end...>", start/end each
  # "Mon YYYY-MM-DD HH:MM:SS TZ". Drop boot 0 (current, unterminated).
  echo "$raw" | awk '{
    idx=$1; sub(/^-/,"",idx);
    if ($1 == "0" || $1 == "+0") next;
    # fields: 1=idx 2=id 3..6=start(dow date time tz) 7..10=end(dow date time tz)
    print $3" "$4" "$5" "$6"|"$7" "$8" "$9" "$10
  }'
}

# Epoch seconds for a "Mon YYYY-MM-DD HH:MM:SS TZ" chunk, or empty on failure.
to_epoch() {
  date -d "$1" +%s 2>/dev/null
}

# Does the given completed-boot index's kernel log carry the dxg GPU-fault
# signature? idx is negative-offset form as printed by --list-boots (e.g. -1).
boot_has_dxg_oops() {
  local idx="$1" text
  if [ -n "${GPU_GUARD_KERNEL_LOG_OVERRIDE:-}" ]; then
    text="$(cat "$GPU_GUARD_KERNEL_LOG_OVERRIDE" 2>/dev/null)"
  else
    text="$(journalctl -k -b "$idx" 2>/dev/null)"
  fi
  echo "$text" | grep -qE 'dxgk_ioctl|dxgadapter_release_lock|misc dxg: dxgk'
}

# Detect the crash-loop pattern: >= MIN_SHORT_BOOTS boots, each shorter than
# SHORT_BOOT_MAX_SEC, STARTING AT OR AFTER the guard's baseline (so pre-install
# crash history that a human/MikroB already resolved doesn't cause an
# immediate false trigger the moment the guard is installed) and ending within
# RECENT_WINDOW_SEC of now, AND at least one of them carrying the dxg oops
# signature (so an unrelated cause -- host sleep/resume, a manual
# `wsl --shutdown` -- doesn't trigger a false mask).
detect_crashloop() {
  local now baseline windows short_count=0 dxg_seen=0 idx=0 line start_s end_s dur total lineno
  now="$(date +%s)"
  baseline=0; [ -f "$BASELINE_STAMP" ] && baseline="$(cat "$BASELINE_STAMP" 2>/dev/null || echo 0)"
  case "$baseline" in (''|*[!0-9]*) baseline=0;; esac
  windows="$(list_boot_windows)"
  [ -z "$windows" ] && { echo "no"; return; }
  # Walk newest-first (last line of --list-boots is the most recently
  # completed boot); idx counts -1,-2,-3,... matching journalctl -b indices.
  total=$(echo "$windows" | wc -l)
  lineno=$total
  while [ "$lineno" -ge 1 ]; do
    line="$(echo "$windows" | sed -n "${lineno}p")"
    lineno=$((lineno - 1))
    idx=$((idx - 1))
    start_s="$(to_epoch "${line%%|*}")"
    end_s="$(to_epoch "${line##*|}")"
    [ -z "$start_s" ] || [ -z "$end_s" ] && continue
    [ "$start_s" -lt "$baseline" ] && break   # pre-dates the guard's baseline, stop scanning
    dur=$((end_s - start_s))
    [ $((now - end_s)) -gt "$RECENT_WINDOW_SEC" ] && break   # too old, stop scanning
    if [ "$dur" -lt "$SHORT_BOOT_MAX_SEC" ] && [ "$dur" -ge 0 ]; then
      short_count=$((short_count + 1))
      if boot_has_dxg_oops "$idx"; then dxg_seen=1; fi
    else
      break   # a normal-length boot breaks the current streak
    fi
  done
  if [ "$short_count" -ge "$MIN_SHORT_BOOTS" ] && [ "$dxg_seen" -eq 1 ]; then
    echo "yes:$short_count"
  else
    echo "no"
  fi
}

SYSTEMCTL="${GPU_GUARD_SYSTEMCTL:-systemctl}"
USER_UNIT_DIR="${GPU_GUARD_USER_UNIT_DIR:-$HOME/.config/systemd/user}"

# The units this run actually got masked, VERIFIED. main() writes the state flag from this and not
# from UNITS -- see the comment there.
MASKED_OK=()

# Masked according to systemd itself, not according to an exit code. `mask` returning 0 is not the
# same claim: this asks the unit what state it is in.
unit_is_masked() {
  [ "$("$SYSTEMCTL" --user show -p UnitFileState --value "$1" 2>/dev/null)" = "masked" ]
}

# "SYSTEMD SAID NO" AND "SYSTEMD COULD NOT BE ASKED" ARE DIFFERENT ANSWERS (Cybersec F-1/F-2 on
# Gate-SHA e2be6386, both MEDIUM, one root -- and the root is my own principle applied to only one
# of two inputs).
#
# unit_is_masked() compares a string to "masked", so an EMPTY answer -- no user bus, the user
# manager not up yet, systemctl missing, the unit gone -- reads exactly like "not masked".
# Reproduced: with a systemctl that exits 1 on "Failed to connect to bus", the output is '' and the
# comparison is false, indistinguishable from a live unmasked unit.
#
# Two decisions were being made from that false answer, and the second is the one that bites:
#   mask_one   -- would move the real unit aside and drop in the /dev/null symlink, then report
#                 that NOTHING was masked. The service ends up masked on disk while the alert says
#                 the machine is unprotected, and nothing records where the real unit went.
#   reconcile  -- runs FIRST in main(), on EVERY invocation, and DELETES the flag of a machine that
#                 really is masked, logging "none of [...] is masked any more". That does not heal:
#                 the only writer of the flag is mask_units, which runs only on a fresh detection.
#
# The file already states the right rule three functions up, for the OTHER input: "an unreadable
# claim is not a refuted one" -- written about an unparseable flag. An unanswerable systemd is the
# same shape and did not get it. Two inputs, one principle, one of them protected.
#
# Why it matters beyond tidiness: the flag's absence is exactly the signal that the machine is being
# held down ON PURPOSE. Missing that signal is what led another agent to restart ollama five times
# under this guard. That is measured precedent in this fleet, not a hypothetical.
unit_state_unknown() {
  local out rc
  out="$("$SYSTEMCTL" --user show -p UnitFileState --value "$1" 2>/dev/null)"
  rc=$?
  [ "$rc" -ne 0 ] || [ -z "$out" ]
}

# THE MASK THAT NEVER HAPPENED (card d5c05548).
#
# `systemctl --user mask` works by writing a symlink to /dev/null into the user unit directory. If a
# REGULAR unit file already sits at that path -- which is exactly the case for a hand-installed
# ollama.service -- systemd refuses rather than overwriting, and `--force` refuses too. Measured on
# this host with a throwaway probe unit:
#
#   systemctl --user mask <u>          -> "Failed to mask unit: File ... already exists", exit 1
#   systemctl --user mask --force <u>  -> the same
#   afterwards                          -> UnitFileState=static, i.e. still loadable and startable
#
# The old code logged that failure and moved on, then wrote a state flag naming the unit as masked.
# So for weeks the protection was APPARENT ONLY: the service was stopped, never masked, and any
# `systemctl --user start` re-armed the GPU path the guard exists to keep off. A guard whose failure
# mode is a reassuring log line is worse than no guard, because nobody goes looking.
#
# The fallback is what a human does by hand: move the real unit aside, put the /dev/null symlink
# there, reload. It is reversible, and the reversal is NOT just `unmask` -- see restore_hint().
mask_one() {
  local u unit_path backup
  u="$1"
  unit_path="$USER_UNIT_DIR/$u"
  backup="$unit_path.real-unit-backup"

  "$SYSTEMCTL" --user stop "$u" 2>/dev/null
  "$SYSTEMCTL" --user mask "$u" 2>/dev/null
  if unit_is_masked "$u"; then
    log "masked $u (verified)"
    return 0
  fi

  # Never take the destructive path on an answer we could not get. Moving the real unit aside is
  # only reversible if someone knows it happened, and the alert we would print says the opposite.
  if unit_state_unknown "$u"; then
    log "mask FAILED for $u -- systemd could not be asked (no bus / no user manager / systemctl missing). NOT moving the unit file aside: an unverifiable state is not a refusal, and a half-done mask nobody is told about is worse than an honest failure."
    return 1
  fi

  if [ -f "$unit_path" ] && [ ! -L "$unit_path" ]; then
    if [ -e "$backup" ]; then
      log "mask fallback for $u: $backup already exists -- refusing to overwrite a previous backup"
      return 1
    fi
    mv "$unit_path" "$backup" 2>/dev/null || { log "mask fallback for $u: could not move $unit_path aside"; return 1; }
    ln -s /dev/null "$unit_path" 2>/dev/null || {
      # Put the real unit back rather than leaving the service with no file at all.
      mv "$backup" "$unit_path" 2>/dev/null
      log "mask fallback for $u: could not create the /dev/null symlink; original restored"
      return 1
    }
    "$SYSTEMCTL" --user daemon-reload 2>/dev/null
    if unit_is_masked "$u"; then
      log "masked $u (verified, via unit-file fallback; real unit saved as $backup)"
      return 0
    fi
  fi

  log "mask FAILED for $u -- it is NOT masked and the fallback did not take. UnitFileState=$("$SYSTEMCTL" --user show -p UnitFileState --value "$u" 2>/dev/null)"
  return 1
}

# A FLAG THAT RECORDS A DECISION OUTLIVES THE DECISION UNLESS SOMEONE CLEARS IT (Cybersec, card
# 970156ce; folded in here by MikroB's decision on d5c05548).
#
# The state flag is not a log entry, it is a claim about the machine RIGHT NOW: card 970156ce made
# store/local-llm-model-routing.selftest.sh skip two routing cases when the flag names
# ollama.service, on the reasoning that the guard is deliberately holding the service down. Nothing
# ever deleted the flag. So the moment a human unmasks the unit after a real fix -- the documented,
# expected end of an incident -- the flag keeps asserting a mask that is gone, and those two cases
# are skipped forever on a perfectly healthy machine. Silently: a skip prints as a skip.
#
# So every cycle re-checks the claim against systemd and rewrites the flag to whatever is STILL
# true, deleting it when nothing is. This runs on EVERY invocation, including the overwhelmingly
# common "no crash-loop detected" path -- that is the path a recovered machine takes forever after.
#
# It does NOT run under MASK_DRYRUN: a dry run masks nothing, so letting it reconcile would delete a
# flag a real run wrote.
#
# Parse failure is NOT taken as "nothing is masked". A flag we cannot read is a flag we cannot
# refute, and deleting it would silently un-skip a routing case on a machine that may genuinely be
# held down. Leave it, say so, and let a human look.
reconcile_masked_flag() {
  [ "${GPU_GUARD_MASK_DRYRUN:-}" = "1" ] && return 0
  [ -f "$MASKED_FLAG" ] || return 0

  local claimed still u
  claimed="$(python3 - "$MASKED_FLAG" <<'PY' 2>/dev/null
import json, sys
try:
    with open(sys.argv[1], encoding='utf-8') as fh:
        d = json.load(fh)
except Exception:
    sys.exit(3)
u = d.get('units')
if isinstance(u, str):
    print(' '.join(u.split()))
elif isinstance(u, list) and all(isinstance(x, str) for x in u):
    print(' '.join(w for x in u for w in x.split()))
else:
    sys.exit(3)
PY
)" || {
    log "masked-flag reconcile: $MASKED_FLAG is unreadable/malformed -- leaving it alone (an unreadable claim is not a refuted one)"
    return 0
  }

  still=""
  for u in $claimed; do
    # THE SAME RULE AS THE UNREADABLE FLAG ABOVE, on the other input. If systemd cannot answer, the
    # claim is unverified, not refuted -- leave the whole flag exactly as it is and say why. Bailing
    # on the FIRST unknown rather than per-unit is deliberate: a partial rewrite driven by a half
    # answerable systemd would be a new claim built out of the same uncertainty.
    if unit_state_unknown "$u"; then
      log "masked-flag reconcile: systemd could not be asked about $u (no bus / no user manager / systemctl missing) -- flag left UNTOUCHED. An unanswerable systemd refutes nothing, and deleting the flag here would erase the only signal that this machine is held down on purpose."
      return 0
    fi
    if unit_is_masked "$u"; then still="$still $u"; fi
  done
  still="${still# }"

  if [ "$still" = "$claimed" ]; then
    return 0
  fi
  if [ -z "$still" ]; then
    rm -f "$MASKED_FLAG" 2>/dev/null || true
    log "masked-flag reconcile: none of [$claimed] is masked any more -- flag REMOVED (consumers must stop treating this machine as deliberately held down)"
  else
    local now2
    now2="$(date +%s)"
    cat > "$MASKED_FLAG" 2>/dev/null <<EOF
{"detected_at": $now2, "short_boots": 0, "units": "$still", "reason": "dxgkrnl GPU-passthrough crash-loop", "restore": "$(restore_hint "${still%% *}")"}
EOF
    log "masked-flag reconcile: [$claimed] -> [$still] (some units were unmasked outside this guard)"
  fi
}

mask_units() {
  local u
  MASKED_OK=()
  for u in "${UNITS[@]}"; do
    if [ "${GPU_GUARD_MASK_DRYRUN:-}" = "1" ]; then
      echo "MASK_DRYRUN: $u"
      MASKED_OK+=("$u")
      continue
    fi
    if mask_one "$u"; then MASKED_OK+=("$u"); fi
  done
}

# How to put a unit back, printed into the alert and the log. `systemctl --user unmask` alone is NOT
# enough and leaves the machine worse: measured on a probe unit, unmask removes the /dev/null
# symlink and stops there, so the unit ends at LoadState=not-found -- the service is gone, not
# restored. Whoever unmasks has to move the backup back, and they will only know that if the guard
# says so where they are looking.
restore_hint() {
  local u="$1"
  echo "$SYSTEMCTL --user unmask $u && mv $USER_UNIT_DIR/$u.real-unit-backup $USER_UNIT_DIR/$u && $SYSTEMCTL --user daemon-reload"
}

# Print the restore command for whatever the flag currently claims. Deliberately readable without
# any of the detection machinery: whoever needs this is mid-incident.
print_restore_hint() {
  local claimed u
  if [ ! -f "$MASKED_FLAG" ]; then
    echo "No units are recorded as masked by this guard ($MASKED_FLAG does not exist)."
    return 0
  fi
  claimed="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));u=d.get("units");print(" ".join(u.split()) if isinstance(u,str) else " ".join(u))' "$MASKED_FLAG" 2>/dev/null)" || {
    echo "$MASKED_FLAG exists but could not be parsed -- open it by hand."
    return 1
  }
  echo "The guard masked: $claimed"
  echo "A plain 'unmask' is NOT enough: it removes the /dev/null symlink and stops, leaving the unit"
  echo "at LoadState=not-found because the real unit file is parked under .real-unit-backup."
  echo "Full restore, per unit:"
  for u in $claimed; do echo "  $(restore_hint "$u")"; done
}

main() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  local result short_count now last

  # Before anything else: the flag has to describe the machine as it is NOW, not as it was when some
  # earlier run decided something. See reconcile_masked_flag().
  reconcile_masked_flag

  # First-ever run: stamp a baseline so pre-existing crash history (already
  # resolved by a human/MikroB before the guard existed) is never scanned.
  if [ ! -f "$BASELINE_STAMP" ]; then
    date +%s > "$BASELINE_STAMP" 2>/dev/null || true
    log "first run -- baseline stamped, will only react to boots from now on"
    return 0
  fi

  result="$(detect_crashloop)"
  if [ "${result%%:*}" != "yes" ]; then
    log "no GPU crash-loop signature detected"
    return 0
  fi
  short_count="${result##*:}"
  log "GPU crash-loop DETECTED ($short_count short/dxg-oops boots in last ${RECENT_WINDOW_SEC}s) -- masking: ${UNITS[*]}"

  mask_units

  now="$(date +%s)"

  # THE FLAG DESCRIBES WHAT IS TRUE, NOT WHAT WAS ATTEMPTED (card d5c05548).
  #
  # It used to be written from UNITS -- the list this run TRIED to mask -- immediately after a
  # mask_units() that logged its own failures and returned nothing. So on this host the artefact
  # said the unit was masked while the service sat there loaded and startable, for weeks.
  #
  # It matters more now than when it was written: card 970156ce made this file load-bearing for the
  # LANDING GATE (store/local-llm-model-routing.selftest.sh skips two cases when it names
  # ollama.service). A flag claiming a mask that never happened would make that gate go quiet about
  # a machine nobody actually protected. So it is written from MASKED_OK, which only holds units
  # whose UnitFileState systemd itself reports as masked.
  if [ "${#MASKED_OK[@]}" -eq 0 ]; then
    rm -f "$MASKED_FLAG" 2>/dev/null || true
    log "NOTHING was masked -- no state flag written (a flag here would claim a protection that does not exist)"
    alert_owner "GPU crashloop guard: crash-loop DETEKTALVA (${short_count}x rovid boot dxgkrnl-hibaval), de EGYETLEN unitot sem sikerult maszkolni: ${UNITS[*]}. A gep NINCS vedve, kezi beavatkozas kell MOST."
    echo "$now" > "$ALERT_STAMP" 2>/dev/null || true
    return 1
  fi

  cat > "$MASKED_FLAG" 2>/dev/null <<EOF
{"detected_at": $now, "short_boots": $short_count, "units": "${MASKED_OK[*]}", "reason": "dxgkrnl GPU-passthrough crash-loop", "restore": "$(restore_hint "${MASKED_OK[0]}")"}
EOF

  last=0; [ -f "$ALERT_STAMP" ] && last="$(cat "$ALERT_STAMP" 2>/dev/null || echo 0)"
  case "$last" in (''|*[!0-9]*) last=0;; esac
  if [ $(( now - last )) -ge "$ALERT_COOLDOWN" ]; then
    alert_owner "🔴 GPU crashloop guard: WSL VM ${short_count}x rövid (<${SHORT_BOOT_MAX_SEC}s) bootot élt meg dxgkrnl GPU-hibával az elmúlt $((RECENT_WINDOW_SEC/60)) percben. Automatikusan leállítva+maszkolva: ${MASKED_OK[*]}. A VM-nek mostantól stabilnak kell lennie. Visszakapcsoláshoz a puszta unmask NEM elég (a valódi unit-fájl félre van téve), ez a teljes parancs: $(restore_hint "${MASKED_OK[0]}")"
    echo "$now" > "$ALERT_STAMP" 2>/dev/null || true
  else
    log "crash-loop persists but within alert cooldown ($(( now - last ))s) -- skip alert"
  fi
}

case "${1:-}" in
--restore-hint) print_restore_hint; exit 0 ;;
esac

main "$@"
exit 0

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
# This is layer 2 of the defense. Layer 1 is the CPU-only systemd drop-in
# (ollama.service.d/10-cpu-only-gpu-crashloop-safety.conf) that removes the
# GPU/dxg ioctl path entirely -- this guard exists in case that is ever
# reverted, incomplete, or a DIFFERENT process starts touching the GPU:
# it detects the crash-loop signature from the outside (boot durations +
# kernel oops text), force-stops+masks the offending unit, and alerts the
# owner directly (Bot API, not MCP -- the in-session channel is one of the
# things that dies every cycle in a crash-loop, so it cannot be trusted to
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

mask_units() {
  local u already_masked=""
  for u in "${UNITS[@]}"; do
    if [ "${GPU_GUARD_MASK_DRYRUN:-}" = "1" ]; then
      echo "MASK_DRYRUN: $u"
      continue
    fi
    systemctl --user stop "$u" 2>/dev/null
    systemctl --user mask "$u" 2>/dev/null \
      && log "masked $u" \
      || log "mask FAILED for $u (may already be masked, or unit missing)"
  done
}

main() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  local result short_count now last

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
  cat > "$MASKED_FLAG" 2>/dev/null <<EOF
{"detected_at": $now, "short_boots": $short_count, "units": "${UNITS[*]}", "reason": "dxgkrnl GPU-passthrough crash-loop"}
EOF

  last=0; [ -f "$ALERT_STAMP" ] && last="$(cat "$ALERT_STAMP" 2>/dev/null || echo 0)"
  case "$last" in (''|*[!0-9]*) last=0;; esac
  if [ $(( now - last )) -ge "$ALERT_COOLDOWN" ]; then
    alert_owner "🔴 GPU crashloop guard: WSL VM ${short_count}x rövid (<${SHORT_BOOT_MAX_SEC}s) bootot élt meg dxgkrnl GPU-hibával az elmúlt $((RECENT_WINDOW_SEC/60)) percben. Automatikusan leállítva+maszkolva: ${UNITS[*]}. A VM-nek mostantól stabilnak kell lennie. Kézi unmask kell, ha vissza akarod kapcsolni: systemctl --user unmask ${UNITS[*]}."
    echo "$now" > "$ALERT_STAMP" 2>/dev/null || true
  else
    log "crash-loop persists but within alert cooldown ($(( now - last ))s) -- skip alert"
  fi
}

main "$@"
exit 0

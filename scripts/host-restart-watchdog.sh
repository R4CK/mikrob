#!/usr/bin/env bash
# host-restart-watchdog.sh
#
# Fires once at every user-manager start (oneshot, WantedBy=default.target).
# Under WSL2 the whole utility VM can shut down and re-boot (vmIdleTimeout
# auto-shutdown, Windows sleep/resume, `wsl --shutdown`), which tears down the
# kernel + system/user systemd + tmux + dashboard + channels all at once and is
# NOT an application crash. This watchdog detects that host/VM restart via the
# kernel boot time (/proc/stat btime) and sends ONE Telegram notice that names
# it as a host/WSL-VM restart (with an estimated downtime), so a fleet-wide
# silence is never mistaken for a CostOps/app crash.
#
# App/service crashes do NOT change btime and never trigger this script -- they
# are reported separately by the OnFailure= drop-ins (marveen-notify@.service).
# That split is the whole point: btime-change => host restart; OnFailure => app.
#
# Safe by construction: read-only except for the state file; Telegram send is
# best-effort; the script always exits 0 so the oneshot unit never enters
# `failed` (a failing watchdog would itself look like an incident).

set -uo pipefail

STATE_DIR="${MARVEEN_STORE:-$HOME/marveen/store}"
STATE_FILE="$STATE_DIR/.last-btime"
ENV_FILE="${TELEGRAM_ENV:-$HOME/.claude/channels/telegram/.env}"
# Alert target chat-id -- MUST come from the install's own config; there is
# deliberately NO hardcoded fallback (a hardcoded id would make every downstream
# install send its host-stability alerts to that one private chat).
CHAT_ID="${MARVEEN_ALERT_CHAT_ID:-}"

log() { echo "[host-restart-watchdog] $*"; }

# --- prior-shutdown cause classification (card RELIA-A, read-only diagnostic) ---
# When btime changes we know a (re)boot happened, but NOT why the PREVIOUS boot
# ended. These helpers attribute the cause (OOM-kill vs clean poweroff vs unclean
# crash) so the alert names it -- an OOM poweroff (the 2026-07-09 event) is
# directly actionable (tighten the MemAvailable safe-mode band), a clean restart
# is benign. Strictly read-only; every failure degrades to "unknown", never a
# false claim, and never fails the unit (the caller still exits 0).

# Pure classifier: given the PREVIOUS boot's log TEXT, echo oom|poweroff|crash.
# Empty input -> unknown. Order matters: OOM is checked first (a boot that OOM'd
# may still reach a shutdown target afterwards, so OOM must win); then a clean
# systemd shutdown/reboot marker; else a retained-but-markerless log => unclean.
# Unit-testable without touching journald (the log text is the only input).
classify_shutdown_from_log() {
  local log="${1:-}"
  [[ -z "$log" ]] && { echo unknown; return 0; }
  if grep -qiE 'out of memory: kill|invoked oom-killer|oom-kill|killed process [0-9]' <<<"$log"; then
    echo oom; return 0
  fi
  if grep -qiE 'reached target (power-?off|shutdown|reboot|halt)|systemd-shutdown\[|powering off|powering down|system is (powering down|rebooting|halting)' <<<"$log"; then
    echo poweroff; return 0
  fi
  echo crash
}

# Best-effort fetch of the PREVIOUS boot's log (read-only, may be empty). WSL
# journald is often volatile (wiped on VM reboot), so `-b -1` frequently returns
# nothing -- that is why the classifier degrades honestly to "unknown".
prev_boot_log() {
  command -v journalctl >/dev/null 2>&1 || { echo ""; return 0; }
  journalctl -b -1 --no-pager -o cat 2>/dev/null || echo ""
}

# Test hook: `HOST_RESTART_WATCHDOG_LIB=1 source host-restart-watchdog.sh` loads
# the helpers WITHOUT running the watchdog, so the classifier is unit-testable.
if [[ "${HOST_RESTART_WATCHDOG_LIB:-}" == "1" ]]; then return 0 2>/dev/null || exit 0; fi

# Real WSL check -- only under WSL is a whole-VM reboot the expected surprise;
# on a bare-metal/other Linux host a btime change is an ordinary reboot, so we
# word the alert accordingly instead of always claiming "WSL VM restarted".
if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null \
   || [[ -n "${WSL_DISTRO_NAME:-}" ]] || [[ -e /run/WSL ]]; then
  HOST_KIND="WSL VM"
else
  HOST_KIND="host"
fi

# Current kernel boot epoch (changes only on a real (re)boot of the VM/host).
# HOSTWD_PROC_STAT exists for tests only (there is no /proc to stub on macOS).
PROC_STAT="${HOSTWD_PROC_STAT:-/proc/stat}"
btime="$(awk '/^btime/{print $2}' "$PROC_STAT" 2>/dev/null)"
if [[ -z "${btime:-}" ]]; then
  log "no btime in $PROC_STAT; nothing to do"
  exit 0
fi

mkdir -p "$STATE_DIR" 2>/dev/null || true
prev=""
[[ -f "$STATE_FILE" ]] && prev="$(tr -dc '0-9' <"$STATE_FILE" 2>/dev/null)"

# The btime baseline is persisted on init below, but after a DETECTED restart
# only once the notice actually delivered (see the send block): this is a
# one-shot message, and stamping before a failed send lost it forever
# (NOTIFYVAKSWEEP826). While the send keeps failing, every timer run retries.

if [[ -z "$prev" ]]; then
  echo "$btime" >"$STATE_FILE" 2>/dev/null || true
  log "baseline initialised (btime=$btime); no alert on first run"
  exit 0
fi

if [[ "$prev" == "$btime" ]]; then
  log "btime unchanged ($btime) -- user-manager restart without a host reboot; no alert"
  exit 0
fi

# --- host/VM restart detected (btime changed) ---
boot_local="$(date -d "@$btime" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || echo "@$btime")"

# Estimate downtime: newest store/*.log mtime that predates this boot ~= last
# fleet activity before the VM went down. gap = boot_time - that mtime.
last_alive=0
if compgen -G "$STATE_DIR/*.log" >/dev/null 2>&1; then
  for f in "$STATE_DIR"/*.log; do
    m="$(stat -c '%Y' "$f" 2>/dev/null || echo 0)"
    if (( m < btime && m > last_alive )); then last_alive="$m"; fi
  done
fi
gap_txt="ismeretlen"
if (( last_alive > 0 )); then
  gap_min=$(( (btime - last_alive) / 60 ))
  last_txt="$(date -d "@$last_alive" '+%H:%M:%S' 2>/dev/null || echo '?')"
  gap_txt="~${gap_min} perc (utolsó aktivitás ${last_txt} előtt)"
fi

# Classify WHY the previous boot ended (read-only; card RELIA-A). Primary source
# is the previous boot's journal; if none was retained, fall back to wtmp (last),
# which records a "crash" pseudo-login when a boot follows an unclean shutdown.
cause="$(classify_shutdown_from_log "$(prev_boot_log)")"
if [[ "$cause" == "unknown" ]] && command -v last >/dev/null 2>&1; then
  wtmp="$(last -x -n 25 2>/dev/null || echo "")"
  if grep -qiE '^crash[[:space:]]' <<<"$wtmp"; then
    cause="crash"
  elif grep -qiE '^(shutdown|reboot)[[:space:]]' <<<"$wtmp"; then
    cause="poweroff"
  fi
fi
case "$cause" in
  oom)      cause_txt="Valószínű ok: MEMÓRIA-KIFOGYÁS (OOM-kill az előző boot naplójában). Érdemes szigorítani a MemAvailable safe-mode sávot (fleet-memory-gate.sh)." ;;
  poweroff) cause_txt="Valószínű ok: rendezett leállás/újraindítás (tiszta shutdown-marker az előző boot naplójában)." ;;
  crash)    cause_txt="Valószínű ok: RENDEZETLEN leállás/összeomlás (van előző-boot napló, de nincs benne tiszta shutdown-marker)." ;;
  *)        cause_txt="Ok: nem meghatározható (nincs megőrzött előző-boot napló; WSL-en a journald gyakran nem perzisztens)." ;;
esac
log "prior-shutdown cause classified: $cause"

msg="Marveen ${HOST_KIND} restarted.
Új boot: ${boot_local}
Becsült kiesés: ${gap_txt}
${cause_txt}
(Ez host/VM szintű restart, NEM app-crash. A dashboard/channels app-crash külön OnFailure-értesítést küld.)"

log "host restart detected: prev btime=$prev new=$btime; sending Telegram"

# Best-effort Telegram send. Never let a send failure fail the unit.
token=""
if [[ -f "$ENV_FILE" ]]; then
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
fi
if [[ -n "$token" && -n "$CHAT_ID" ]]; then
  # Honest send (curl exit 0 AND "ok":true -- an HTTP 200 with ok:false was
  # invisible here before). Baseline stamped ONLY on confirmed delivery: this
  # one-shot notice must survive a transient send failure by retrying on the
  # next run, not by being marked done.
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/send-telegram.sh"
  if send_err="$(send_telegram_message "$token" "$CHAT_ID" "$msg" 2>&1)"; then
    echo "$btime" >"$STATE_FILE" 2>/dev/null || true
    log "Telegram sent (btime baseline stamped)"
  else
    log "Telegram send FAILED -- baseline NOT stamped, will retry next run: ${send_err}"
  fi
else
  log "skipping Telegram (${HOST_KIND} restart still logged): missing${token:+}$( [[ -z "$token" ]] && echo ' TELEGRAM_BOT_TOKEN(via TELEGRAM_ENV)')$( [[ -z "$CHAT_ID" ]] && echo ' MARVEEN_ALERT_CHAT_ID')"
fi

exit 0

#!/usr/bin/env bash
# Detached update finalizer. Args:
#   $1 INSTALL_DIR  $2 OLD_FULL_SHA  $3 OLD_SHORT  $4 PORT
#   $5 RESULT_FILE  $6 BUILT_COMMIT_FILE  $7 NEW_SHORT  $8 NODE_PIN_DIR
#   $9 NOTIFY (1 = also send a channel report after the outcome; used by the
#             unattended auto-update task, silent for a dashboard-triggered run)
INSTALL_DIR="$1"; OLD_FULL="$2"; OLD_SHORT="$3"; PORT="$4"
RESULT_FILE="$5"; BUILT="$6"; NEW_SHORT="$7"; NODE_PIN_DIR="$8"; NOTIFY="${9:-0}"
[ -n "$NODE_PIN_DIR" ] && export PATH="$NODE_PIN_DIR:$PATH"
cd "$INSTALL_DIR" 2>/dev/null || true

_esc() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$1"; }
_write() { # status phase code message
  printf '{"status":%s,"phase":%s,"code":%s,"old":%s,"new":%s,"message":%s,"ts":%s}\n' \
    "$(_esc "$1")" "$(_esc "$2")" "$3" "$(_esc "$OLD_SHORT")" "$(_esc "$NEW_SHORT")" \
    "$(_esc "$4")" "$(date +%s)" > "$RESULT_FILE" 2>/dev/null || true
}
# Channel report for the unattended auto-update. Plugin-independent (Bot API via
# notify.sh), because at 4am the Telegram plugin may be down and the finalizer
# runs detached with no tmux session. Silent (NOTIFY!=1) for manual runs, where
# the dashboard UI already polls /api/updates/status.
_notify() { # status
  [ "$NOTIFY" = "1" ] || return 0
  [ -x "$INSTALL_DIR/scripts/notify.sh" ] || [ -f "$INSTALL_DIR/scripts/notify.sh" ] || return 0
  local msg
  case "$1" in
    success)     msg="✅ Auto-update kesz: ${OLD_SHORT} -> ${NEW_SHORT}. A dashboard ujraindult es valaszol (health OK)." ;;
    rolled-back) msg="⚠️ Auto-update: a frissites nem sikerult (a dashboard nem indult), visszaalltunk a korabbi mukodo verziora (${OLD_SHORT}). Reszletek: store/update.log" ;;
    *)           msg="🔴 Auto-update SIKERTELEN: a dashboard a frissites ES a rollback utan sem valaszol a ${PORT} porton. Kezi beavatkozas kell. Reszletek: store/update.log" ;;
  esac
  bash "$INSTALL_DIR/scripts/notify.sh" "$msg" >/dev/null 2>&1 || true
}
_finish() { _write "$1" "$2" "$3" "$4"; _notify "$1"; exit "$3"; }
_health() { local i=0; while [ "$i" -lt 20 ]; do
  curl -fsS -m 3 -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null && return 0
  sleep 1; i=$(( i + 1 )); done; return 1; }
_restart() { "$INSTALL_DIR/scripts/stop.sh"; "$INSTALL_DIR/scripts/start.sh"; }

_restart
if _health; then _finish success restart 0 ""; fi

# Restart did not bring the dashboard back -> auto-rollback to the pre-update
# commit (safe: ff-only ancestor, no force-push, no local-change discard) and
# restart that, so the box ends on a WORKING old version.
# Gated by the rollback distance-guard (card 980454f7). Incident 2026-08-06: a
# stale OLD_FULL sent the live install back 529 commits, three times, each run
# reported as a successful rollback. A refused rollback is the safer failure --
# it leaves a visibly broken version instead of a plausible two-week-old one.
ROLLED_BACK=0
if [ -n "$OLD_FULL" ]; then
  if [ -r "$INSTALL_DIR/store/rollback-guard.sh" ]; then
    . "$INSTALL_DIR/store/rollback-guard.sh"
  else
    rollback_guard_check() { echo "[rollback-guard] MEGTAGADVA: store/rollback-guard.sh hianyzik, a rollback-cel nem ellenorizheto" >&2; return 1; }
  fi
  if rollback_guard_check "$INSTALL_DIR" "$(git rev-parse HEAD 2>/dev/null || echo unknown)" "$OLD_FULL" "update-health-check"; then
    git reset --hard "$OLD_FULL" >/dev/null 2>&1 || true
    npm ci --silent 2>/dev/null || true
    npm rebuild better-sqlite3 --build-from-source --silent 2>/dev/null || true
    npm run build --silent 2>/dev/null || true
    [ -d "$INSTALL_DIR/dist" ] && echo "$OLD_FULL" > "$BUILT"
    ROLLED_BACK=1
    _restart
  fi
fi
if [ "$ROLLED_BACK" = "0" ]; then
  _finish failed health-check 1 "A dashboard a frissites utan nem valaszol a ${PORT} porton, a visszaallitast pedig a rollback-guard megtagadta (elavult vagy tul tavoli cel). A rendszer a jelenlegi verzion maradt. Kezi dontes kell: ./recovery-prev-version.sh --list"
elif _health; then
  _finish rolled-back health-check 6 "A frissites utan a dashboard nem indult el; visszaalltunk a korabbi mukodo verziora (${OLD_SHORT}). A frissites nem ment ki."
else
  _finish failed health-check 1 "A dashboard a frissites es a visszaallitas utan sem valaszol a ${PORT} porton. Kezi beavatkozas szukseges."
fi

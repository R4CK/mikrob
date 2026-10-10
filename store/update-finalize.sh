#!/usr/bin/env bash
# Detached update finalizer. Args:
#   $1 INSTALL_DIR  $2 OLD_FULL_SHA  $3 OLD_SHORT  $4 PORT
#   $5 RESULT_FILE  $6 BUILT_COMMIT_FILE  $7 NEW_SHORT  $8 NODE_PIN_DIR
#   $9 NOTIFY (1 = also send a channel report after the outcome; used by the
#             unattended auto-update task, silent for a dashboard-triggered run)
INSTALL_DIR="$1"; OLD_FULL="$2"; OLD_SHORT="$3"; PORT="$4"
RESULT_FILE="$5"; BUILT="$6"; NEW_SHORT="$7"; NODE_PIN_DIR="$8"; NOTIFY="${9:-0}"
# cf8d047a (MEDIUM F1, 3caa7e9f): the very first thing we do, before anything
# that could fail, is prove we actually started -- the launcher's fallback
# below reads this to tell "systemd-run itself never ran us" apart from "we
# ran and then exited non-zero" (a legitimate rolled-back/failed outcome).
touch "$RESULT_FILE.started" 2>/dev/null || true
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

# ZAKARFELUGY921: THE PORT ANSWERING IS NOT PROOF THAT THE SERVICES ARE UNDER
# THEIR UNITS. That is exactly how the reported install looked for two days: the
# dashboard answered, the channel answered, and both units were `inactive`, so
# Restart= and OnFailure= no longer applied to anything. _health cannot see this
# -- it only asks the port. This check asks systemd instead, and it reports
# rather than fails: a unit drift is not fixed by a rollback, so turning it into
# a failed update would swap a silent problem for a destructive one.
# The SLUG is derived the same way start.sh/stop.sh derive it.
_unit_drift() {
  command -v systemctl >/dev/null 2>&1 || return 0
  pidof systemd >/dev/null 2>&1 || return 0
  local slug drift="" u scope=""
  slug="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
  slug="${slug:-marveen}"
  if systemctl cat "${slug}-dashboard.service" >/dev/null 2>&1; then scope=""
  elif systemctl --user cat "${slug}-dashboard.service" >/dev/null 2>&1; then scope="--user"
  else return 0
  fi
  for u in "${slug}-dashboard" "${slug}-channels"; do
    # Only enabled units are a promise; a deliberately disabled one is not drift.
    systemctl $scope is-enabled --quiet "$u" 2>/dev/null || continue
    systemctl $scope is-active --quiet "$u" 2>/dev/null || drift="${drift} ${u}"
  done
  [ -n "$drift" ] && printf '%s' "${drift# }"
  return 0
}

_restart
UNIT_DRIFT="$(_unit_drift)"
if [ -n "$UNIT_DRIFT" ]; then
  echo "FIGYELEM: enabled, de NEM active unit(ok) a restart utan: ${UNIT_DRIFT}" >&2
  echo "          A szolgaltatas valaszolhat a portjan, de a unitjan KIVUL fut:" >&2
  echo "          a Restart= es az OnFailure= ilyenkor NEM vonatkozik ra." >&2
fi
if _health; then
  if [ -n "$UNIT_DRIFT" ]; then
    _finish success restart 0 "A frissites lement es a dashboard valaszol, DE enabled unit(ok) nem active: ${UNIT_DRIFT}. A szolgaltatas a unitjan kivul fut, tehat a Restart=/OnFailure= felugyelet nem ervenyes ra."
  fi
  _finish success restart 0 ""
fi

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
    # --include=dev: same reason as the main npm ci above, and it matters MORE here.
    # Without it the rollback re-creates the very pruned tree it is trying to escape,
    # and it does so silently (`|| true`), so the recovery path would report success on
    # a build that never ran. The fork's rollback_guard_check wrapper around this block
    # stays as it is -- upstream has no equivalent.
    npm ci --silent --include=dev 2>/dev/null || true
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

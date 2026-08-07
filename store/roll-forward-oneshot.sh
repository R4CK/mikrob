#!/usr/bin/env bash
# One-shot roll-forward: attach the live (possibly detached) install to a
# target commit on develop, build, restart. Originally hardcoded to the
# 2026-08-06 45004ec -> d4d8c56 incident target; that made it a live landmine
# once HEAD moved past the hardcoded TARGET (Cybered, 2026-08-07, msg 7514):
# a re-run would silently roll the install BACKWARD, undoing every fix landed
# since. TARGET is now an explicit arg (or origin/develop HEAD by default),
# and a re-run is REFUSED if TARGET is already an ancestor of the current HEAD
# -- that's not a forward roll, it's a rollback wearing this script's name.
#
# Runs inside its own systemd scope so it SURVIVES the mikrob-channels restart
# that kills the launching agent session. Writes a continuous, timestamped log.
#
# Usage: roll-forward-oneshot.sh [target-commit]   # default: origin/develop
set -uo pipefail

export HOME=/home/neon
export USER=neon
export PATH=/home/neon/.local/bin:/home/neon/.bun/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/1000}

INSTALL_DIR=/home/neon/marveen
LOG="$INSTALL_DIR/store/deploy.log"
CHAT=7929620734
TG_ENV=/home/neon/.claude/channels/telegram/.env

log(){ echo "[$(date '+%F %T %Z')] $*" >> "$LOG"; }

BOT_TOKEN=""
[ -f "$TG_ENV" ] && BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" | head -1 | sed 's/^TELEGRAM_BOT_TOKEN=//' | tr -d "\"' ")
notify(){
  # SECURITY: the bot token never touches argv/ps -- it's passed to curl via a
  # -K config file (only the URL line carries it), same pattern as
  # scripts/dashboard-watchdog.sh's notify_peti(). chat_id/text are not
  # secrets, so --data-urlencode on argv for those is fine.
  [ -z "$BOT_TOKEN" ] && return 0
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$BOT_TOKEN" \
    | curl -sS --max-time 20 -K - \
      --data-urlencode "chat_id=${CHAT}" \
      --data-urlencode "text=$1" >/dev/null 2>&1 || true
}

cd "$INSTALL_DIR" || { log "FATAL: cd $INSTALL_DIR failed"; notify "Roll-forward FATAL: cd failed."; exit 1; }
git fetch origin --quiet 2>>"$LOG"
TARGET="${1:-$(git rev-parse origin/develop)}"
CURRENT_HEAD="$(git rev-parse HEAD)"

log "================================================================"
log "ROLL-FORWARD START: HEAD=${CURRENT_HEAD:0:7} -> target=${TARGET:0:7}"

if git merge-base --is-ancestor "$TARGET" "$CURRENT_HEAD" 2>/dev/null; then
  log "REFUSED: target ${TARGET:0:7} is already an ancestor of current HEAD ${CURRENT_HEAD:0:7} -- this would be a rollback, not a roll-forward. Use recovery-prev-version.sh (rollback-guard-protected) if a rollback is actually intended."
  notify "Roll-forward MEGTAGADVA: a cel (${TARGET:0:7}) mar oskent szerepel a jelenlegi HEAD-ben (${CURRENT_HEAD:0:7}) -- ez visszalepes lenne, nem elorelepes. Nem futott le semmi."
  exit 3
fi

# 1. Attach live tree to develop branch at target (no longer detached HEAD)
if git checkout -B develop "$TARGET" >>"$LOG" 2>&1; then
  log "checkout: on develop, HEAD=$(git rev-parse --short HEAD)"
else
  log "FATAL: git checkout -B develop $TARGET failed"
  notify "Roll-forward FATAL: git checkout sikertelen, a live maradt ${CURRENT_HEAD:0:7}-en. Lasd store/deploy.log."
  exit 1
fi

# 2. Verify the security fixes are now on disk
[ -f store/rollback-guard.sh ] && log "rollback-guard.sh PRESENT on disk" || log "WARN: rollback-guard.sh still missing"

# 3. Quarantine the stray armed watchdog (belt-and-suspenders; start.sh also does this)
if [ -f store/rollback-guard.sh ] && [ -f store/update-health-watchdog.sh ]; then
  bash store/rollback-guard.sh --quarantine-stray "$INSTALL_DIR" >>"$LOG" 2>&1 \
    && log "stray update-health-watchdog.sh quarantined" \
    || { mv -f store/update-health-watchdog.sh "store/update-health-watchdog.sh.quarantined.$(date +%s)" 2>>"$LOG" && log "stray watchdog moved aside (fallback)"; }
fi

# 4. Deps (lockfile changed 45004ec..develop) + build (tsc)
log "npm ci (lockfile changed) ..."
if ! npm ci >>"$LOG" 2>&1; then
  log "npm ci failed -> falling back to npm install"
  npm install >>"$LOG" 2>&1 || log "WARN: npm install also reported errors"
fi
log "rm -rf dist + npm run build ..."
rm -rf dist
if npm run build >>"$LOG" 2>&1 && [ -f dist/index.js ]; then
  printf '%s' "$TARGET" > dist/.built-commit
  log "build OK: dist/index.js present, dist/.built-commit=${TARGET:0:7}"
else
  log "FATAL: build failed or dist/index.js missing -- NOT restarting (old service stays up)"
  notify "Roll-forward FAIL: a build elszallt, ezert NEM inditottam ujra a szolgaltatast (a regi verzio fut tovabb). Reszletek: store/deploy.log."
  exit 1
fi

# 5. Restart services. This scope is OUTSIDE the channels cgroup, so it survives
#    the restart that kills the old agent session.
log "restarting mikrob-dashboard ..."
systemctl --user restart mikrob-dashboard.service >>"$LOG" 2>&1 || log "WARN: dashboard restart returned nonzero"
log "restarting mikrob-channels (kills old agent session) ..."
systemctl --user restart mikrob-channels.service >>"$LOG" 2>&1 || log "WARN: channels restart returned nonzero"

# 6. Health probe
sleep 25
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $(cat store/.dashboard-token 2>/dev/null)" \
  http://localhost:3420/api/agents 2>/dev/null)
log "post-restart: dashboard http=${CODE:-none}, HEAD=$(git rev-parse --short HEAD), built=$(cat dist/.built-commit 2>/dev/null)"

if [ "$CODE" = "200" ]; then
  log "ROLL-FORWARD SUCCESS"
  notify "Roll-forward KESZ. A rendszer mostantol a legfrissebb verzion fut: develop@${TARGET:0:7} (530 commit elore a korabbi 45004ec-hez kepest). Minden fejlesztes visszaallt. Dashboard OK (200). A rollback-guard es a stray-watchdog karanten elesben. Folyamatos log irodik: store/deploy.log (deploy/health esemenyek), store/channels.log es store/dashboard.log (service kimenet), .error.log parjaik a hibakhoz. A friss MikroB session felall es jelentkezik."
else
  log "ROLL-FORWARD: code deployed, dashboard http=${CODE:-none} (may still be booting)"
  notify "Roll-forward: a kod telepitve (develop@${TARGET:0:7}), de a dashboard meg nem ad 200-at (http=${CODE:-none}) -- lehet meg boot alatt. A friss session felallasakor ellenorzom. Log: store/deploy.log."
fi
log "================================================================"

#!/usr/bin/env bash
# deploy-freshness-check.sh -- detect the "push != deploy" gap.
#
# WHY: FE/BE code can be committed to CleanCore `main` while the live VPS still
# serves an older image (the source froze at rsync time, the container was built
# then). Peti saw exactly this on 2026-07-31: legal pages / prices / trial were
# committed but the web container was a morning build, so the site looked stale.
# Nothing in the pipeline noticed. This script does.
#
# HOW: compare the timestamp of the newest commit touching a deployable path
# (apps/web / apps/api / packages) against the BUILD time of the live image.
# If a commit is newer than the image, the deploy lagged the push.
#
# OUTPUT (stdout, machine-readable first line):
#   FRESH                              -- both images newer than their last commit
#   STALE web=<mins> api=<mins>        -- one or both images older than a commit; drift in minutes
#   ERROR:<reason>                     -- could not evaluate (repo/ssh/docker unreachable)
# Exit: 0 fresh | 1 stale | 2 error. The scheduled heartbeat reads line 1 and
# only pings Peti on STALE (dedupe is the caller's job).
#
# NO SECRETS: read-only git + ssh (key auth) + docker inspect. Nothing written.
set -uo pipefail

REPO="${CLEANCORE_REPO:-/mnt/h/LM_Studio_Workdir/CleanCore}"
BRANCH="${CLEANCORE_BRANCH:-main}"
SSH_KEY="${CLEANCORE_SSH_KEY:-/home/neon/.ssh/cleancore_deploy}"
VPS="${CLEANCORE_VPS:-root@72.62.35.139}"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=15 $VPS"

[[ -d "$REPO/.git" ]] || { echo "ERROR:no-repo-at-$REPO"; exit 2; }

# newest commit epoch touching a path set (committed tree only, not working tree)
commit_epoch() { git -C "$REPO" log -1 --format=%ct "$BRANCH" -- "$@" 2>/dev/null; }
WEB_COMMIT=$(commit_epoch apps/web packages)
API_COMMIT=$(commit_epoch apps/api packages)
[[ -n "$WEB_COMMIT" && -n "$API_COMMIT" ]] || { echo "ERROR:git-log-failed"; exit 2; }

# live image build epoch
image_epoch() { $SSH "docker image inspect $1 --format '{{.Created}}'" 2>/dev/null; }
WEB_BUILT_ISO=$(image_epoch cleancore-web:latest)
API_BUILT_ISO=$(image_epoch cleancore-api:latest)
[[ -n "$WEB_BUILT_ISO" && -n "$API_BUILT_ISO" ]] || { echo "ERROR:ssh-or-docker-unreachable"; exit 2; }
WEB_BUILT=$(date -d "$WEB_BUILT_ISO" +%s 2>/dev/null)
API_BUILT=$(date -d "$API_BUILT_ISO" +%s 2>/dev/null)
[[ -n "$WEB_BUILT" && -n "$API_BUILT" ]] || { echo "ERROR:bad-image-date"; exit 2; }

web_drift=$(( (WEB_COMMIT - WEB_BUILT) / 60 ))   # >0 => commit newer than image => stale
api_drift=$(( (API_COMMIT - API_BUILT) / 60 ))
GRACE_MIN="${DEPLOY_FRESHNESS_GRACE_MIN:-10}"     # ignore drift under grace (build lag, clock skew)

stale=0
web_state="ok"; api_state="ok"
if (( web_drift > GRACE_MIN )); then stale=1; web_state="${web_drift}"; fi
if (( api_drift > GRACE_MIN )); then stale=1; api_state="${api_drift}"; fi

if (( stale == 1 )); then
  echo "STALE web=${web_state} api=${api_state}"
  echo "detail: last FE commit $(date -d @"$WEB_COMMIT" '+%F %T') vs web image built $(date -d @"$WEB_BUILT" '+%F %T')"
  echo "detail: last BE commit $(date -d @"$API_COMMIT" '+%F %T') vs api image built $(date -d @"$API_BUILT" '+%F %T')"
  echo "fix: rsync main -> VPS (env/ excluded) then infra/deploy.sh + web --no-cache rebuild"
  exit 1
fi
echo "FRESH"
echo "detail: web image $((-web_drift))m ahead of last FE commit; api $((-api_drift))m ahead of last BE commit"
exit 0

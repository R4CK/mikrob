#!/usr/bin/env bash
# cleancore-branch-drift-monitor.sh -- periodic READ-ONLY check for the misdirected-upstream drift
# in the shared CleanCore checkout (card cf3c25ea, Cybered's measurement on 63e2069c).
#
# THE GAP THIS CLOSES. store/branch-upstream-audit.sh answers the question at the moment it runs,
# but does not stay true: measured recurrence is roughly every 6 hours (fullstack fixed 9 branches
# at 00:38, 2-3 were wrong again 6 hours later). A one-off audit is a snapshot; this is what keeps
# looking.
#
# REPORT MODE ONLY. This script NEVER calls branch-upstream-audit.sh --fix and never writes
# anything into the shared checkout. --fix is only safe when the writing agent is not under an
# active NO-GO (the exact lesson from 63e2069c's own gate) -- a periodic monitor has no way to know
# that, so it must never decide to write. A human (or the agent who owns the moment) runs --fix
# deliberately; this script only tells them when to look.
#
# REPORTS ONLY WORSENING (same shape as cleancore-main-suite-guard.sh, card 6d46c7d3): a repo that
# already has known drift and shouts about it every run gets muted, and a muted monitor is not a
# monitor. It alerts when the drifted-branch SET grows a new member relative to the last run, and
# otherwise stays quiet. Newly-fixed branches leaving the set is progress, not silence to hide.
#
# Usage:
#   store/cleancore-branch-drift-monitor.sh            # the scheduled path: silent unless it worsened
#   store/cleancore-branch-drift-monitor.sh --status    # print the recorded baseline and exit
#
# Output contract:
#   STATE:measured
#   RESULT:OK | RESULT:WORSENED | RESULT:IMPROVED
# Exit: 0 always (a monitor's own hiccup must not look like a cron failure to anything watching
# exit codes; the alert path is the notification mechanism, not the exit code).
set -uo pipefail

ROOT="/home/neon/marveen"
REPO="${CC_REPO:-/mnt/h/LM_Studio_Workdir/CleanCore}"
AUDIT="$ROOT/store/branch-upstream-audit.sh"
STATE="${CC_DRIFT_STATE:-$ROOT/store/cleancore-branch-drift-state.json}"
# Overridable from the start (card 9cfed589's own lesson, discovered the hard way earlier tonight
# on cleancore-main-suite-guard.sh: an alert path with no isolation override sent real messages to
# mikrob from a selftest). Default unchanged.
DASH="${CC_DRIFT_DASH:-http://localhost:3420}"

case "${1:-}" in
  --status) [ -f "$STATE" ] && cat "$STATE" || echo '{}'; exit 0 ;;
  "") ;;
  *) echo "usage: $0 [--status]" >&2; exit 2 ;;
esac

[ -x "$AUDIT" ] || AUDIT="bash $AUDIT"
out="$($AUDIT "$REPO" 2>&1)"
# WRONG lines name the drifted branch, one per finding, in the exact format branch-upstream-audit.sh
# has printed since it was written (`WRONG  <branch>`, two spaces, no other line starts this way).
current_branches="$(printf '%s\n' "$out" | sed -n 's/^WRONG  //p' | sort)"
current_count=$(printf '%s\n' "$current_branches" | grep -c . || true)

first_run=1
prev_branches=""
if [ -f "$STATE" ]; then
  first_run=0
  prev_branches="$(python3 -c "
import json
try:
    d = json.load(open('$STATE'))
    print('\n'.join(sorted(d.get('branches', []))))
except Exception:
    pass
" 2>/dev/null)"
fi
prev_count=$(printf '%s\n' "$prev_branches" | grep -c . || true)

new_branches="$(comm -13 <(printf '%s\n' "$prev_branches" | sort) <(printf '%s\n' "$current_branches" | sort) | grep -v '^$' || true)"

# Atomic write (same reasoning as cleancore-main-suite-guard.sh's state file: a run killed
# mid-write must not hand the next run a corrupt baseline it silently trusts). Branch names go
# through STDIN, not interpolated into the python source -- a name is git-ref-charset in practice,
# but there is no reason to trust that by construction when a pipe costs nothing extra.
printf '%s\n' "$current_branches" | python3 -c "
import json, sys
branches = [b for b in sys.stdin.read().split(chr(10)) if b]
with open('$STATE.tmp.$$', 'w') as f:
    json.dump({'branches': branches, 'count': len(branches)}, f)
" 2>/dev/null
mv -f "$STATE.tmp.$$" "$STATE" 2>/dev/null || true

echo "STATE:measured"
echo "  $REPO: $current_count drifted branch(es)"

if [ "$first_run" -eq 1 ]; then
  # No prior baseline: whatever is drifted right now is being SEEN for the first time by this
  # monitor, not newly created since the last check. Recording it as WORSENED would fire a real
  # alert on install day for pre-existing drift this script had no part in missing -- the same
  # "first run has no baseline" case cleancore-main-suite-guard.sh already handles for its own
  # state file, for the identical reason.
  echo "RESULT:OK (baseline recorded, no previous measurement to compare)"
elif [ -n "$new_branches" ]; then
  echo "RESULT:WORSENED"
  echo "  new drifted branch(es) since the last check:"
  printf '%s\n' "$new_branches" | sed 's/^/    /'
  tok="$ROOT/store/.dashboard-token"
  if [ -r "$tok" ]; then
    body="$(printf '[cleancore-branch-drift-monitor / cron -- automatikus, nem kezi jelzes]\nUj driftelt ag(ak) a megosztott CleanCore checkoutban (%s osszesen, korabban %s volt):\n%s\nJavitas (csak akkor futtasd, ha a te ago(i)d NINCS eppen NO-GO alatt, 63e2069c tanulsaga): bash store/branch-upstream-audit.sh %s --fix' \
      "$current_count" "$prev_count" "$new_branches" "$REPO" \
      | python3 -c 'import json,sys; print(json.dumps({"from":"fullstack","to":"mikrob","content":sys.stdin.read()}))')"
    printf 'Authorization: Bearer %s\n' "$(cat "$tok")" \
      | curl -H @- -s -m 15 -X POST "$DASH/api/messages" \
        -H 'Content-Type: application/json' --data-binary "$body" >/dev/null 2>&1 \
      || echo "  (note: could not reach the message API -- the finding is only in this output)"
  fi
elif [ "$current_count" -lt "$prev_count" ]; then
  echo "RESULT:IMPROVED"
else
  echo "RESULT:OK"
fi
exit 0

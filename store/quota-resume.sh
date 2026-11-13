#!/bin/bash
# Quota reset auto-resume (Peti rule 2026-07-04).
# When an agent hits the 5h usage limit, quota-check.sh starts a countdown in
# store/quota-reset-countdown.json (hit_at + 5h05m = deadline). This script is
# run periodically by the `quota-reset-resume` scheduled task. Once the deadline
# passes it: (1) clears stale "Stop and wait for limit to reset" modals on the
# limited panes, (2) (re)starts those agents, (3) re-runs quota-check to verify.
# If the limit is truly gone, quota-check deletes the countdown -> RESUMED.
# If still limited (reset not there yet), the countdown stays -> retried next run.
#
# Card 7f112c2f point 1: the retry after the deadline used to happen every 15 min flat
# (whatever the `quota-reset-resume` schedule interval is), with no backoff. Each STILL-LIMITED
# result now writes store/quota-resume-backoff.json with a 15 -> 30 -> 60 min (capped) backoff
# before the NEXT attempt is allowed; sched-precheck-quota-reset-resume.sh reads it to decide
# whether to wake this script at all. A single early probe is still allowed at deadline-3min
# (EARLY_PROBE_WINDOW_SEC in store/quota-switchback.py), in case the reset landed a little early.
set -u
STORE="/home/neon/marveen/store"
CD="$STORE/quota-reset-countdown.json"
BACKOFF="$STORE/quota-resume-backoff.json"
TOK="$(cat "$STORE/.dashboard-token" 2>/dev/null)"
# Canonical phrase source, shared with src/model-fallback.ts and 5 other scripts (card 115c21e7).
# Was a hand-typed 3-phrase subset before -- e.g. it never matched "hit your session limit"
# (upstream aefa693) or "N-hour limit reached", so a stale modal in one of those exact shapes would
# not get Escape+restarted here (the authoritative re-check below, quota-check.sh, still caught it
# on its own full pattern -- but this pre-pass existed to do that promptly, not lag a cycle behind).
. "$STORE/session-limit-pattern.sh"

[ -f "$CD" ] || { echo "STATE:no-countdown"; exit 0; }

# SECURITY (Cybersec/gate-ops-scripts-token-in-argv, card edb7559f): the token must never be a curl
# argv (/proc/<pid>/cmdline is world-readable). Private 0600 header file instead, -H @"$hdr_file",
# removed on EXIT. Created only once we know there is a countdown to act on.
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
printf 'Authorization: Bearer %s\n' "$TOK" > "$hdr_file"

due=$(python3 -c "import json,time;d=json.load(open('$CD'));print(1 if time.time()>=d.get('deadline',9e18) else 0)" 2>/dev/null || echo 0)
rem_sec=$(python3 -c "import json,time;d=json.load(open('$CD'));print(int(d.get('deadline',0)-time.time()))" 2>/dev/null || echo 999999)
rem="$((rem_sec>0 ? rem_sec/60 : 0))m"
EARLY_PROBE_WINDOW_SEC=180
if [ "$due" != "1" ] && [ "$rem_sec" -gt "$EARLY_PROBE_WINDOW_SEC" ]; then
  echo "STATE:counting (deadline in $rem)"; exit 0
fi
early_probe=0
[ "$due" != "1" ] && early_probe=1

echo "STATE:due -- attempting resume"
resumed=()
for s in $(tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^agent-'); do
  pane=$(tmux capture-pane -t "$s" -p -S -8 2>/dev/null)
  if echo "$pane" | grep -qiE "$SESSION_LIMIT_RX"; then
    tmux send-keys -t "$s" Escape 2>/dev/null
    name="${s#agent-}"
    curl -s --max-time 15 -X POST "http://localhost:3420/api/agents/$name/start" -H @"$hdr_file" -d '{}' >/dev/null 2>&1
    resumed+=("$name")
  fi
done
# Parked limited agents have NO pane to scan (rule 7 stops idle agents), so the
# loop above can't catch them. Also restart every agent recorded in the
# countdown's `limited` list -- that record survives parking now that
# quota-check.sh no longer deletes the countdown on a parked-empty scan
# (Peti 2026-07-06 fix).
for s in $(python3 -c "import json;print(' '.join(json.load(open('$CD')).get('limited',[])))" 2>/dev/null); do
  name="${s#agent-}"
  case " ${resumed[*]:-} " in *" $name "*) continue ;; esac
  curl -s --max-time 15 -X POST "http://localhost:3420/api/agents/$name/start" -H @"$hdr_file" -d '{}' >/dev/null 2>&1
  resumed+=("$name")
done
echo "ATTEMPTED:${resumed[*]:-none}"
# small settle window so panes update before re-scan
for i in 1 2 3; do :; done
sleep 3 2>/dev/null || true
# re-check: quota-check.sh deletes the countdown when CURRENT is empty
out=$(bash "$STORE/quota-check.sh" 2>/dev/null)
echo "$out"
if echo "$out" | grep -q '^CURRENT:$'; then
  echo "RESULT:RESUMED"
  rm -f "$BACKOFF"
else
  echo "RESULT:STILL-LIMITED (reset not yet; will retry)"
  python3 - "$BACKOFF" "$early_probe" <<'PY' 2>/dev/null
import json, sys, time
backoff_path, early_probe = sys.argv[1], sys.argv[2] == "1"
BASE_SEC, CAP_SEC = 15 * 60, 60 * 60
try:
    with open(backoff_path) as f:
        state = json.load(f)
except (OSError, ValueError):
    state = {}
if early_probe:
    # The early deadline-3min probe does not count toward the post-deadline backoff --
    # it just marks itself spent so the precheck gate does not run it again before the
    # deadline actually passes.
    state["earlyProbeDone"] = True
    state.setdefault("consecutiveStillLimited", 0)
    state.setdefault("nextProbeAt", 0)
else:
    n = state.get("consecutiveStillLimited", 0) + 1
    backoff_sec = min(CAP_SEC, BASE_SEC * (2 ** (n - 1)))
    state["consecutiveStillLimited"] = n
    state["nextProbeAt"] = time.time() + backoff_sec
    state.setdefault("earlyProbeDone", True)
tmp = backoff_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f)
import os
os.replace(tmp, backoff_path)
PY
fi

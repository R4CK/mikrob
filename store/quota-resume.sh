#!/bin/bash
# Quota reset auto-resume (Peti rule 2026-07-04).
# When an agent hits the 5h usage limit, quota-check.sh starts a countdown in
# store/quota-reset-countdown.json (hit_at + 5h05m = deadline). This script is
# run periodically by the `quota-reset-resume` scheduled task. Once the deadline
# passes it: (1) clears stale "Stop and wait for limit to reset" modals on the
# limited panes, (2) (re)starts those agents, (3) re-runs quota-check to verify.
# If the limit is truly gone, quota-check deletes the countdown -> RESUMED.
# If still limited (reset not there yet), the countdown stays -> retried next run.
set -u
STORE="/home/neon/marveen/store"
CD="$STORE/quota-reset-countdown.json"
TOK="$(cat "$STORE/.dashboard-token" 2>/dev/null)"

[ -f "$CD" ] || { echo "STATE:no-countdown"; exit 0; }

# SECURITY (Cybersec/gate-ops-scripts-token-in-argv, card edb7559f): the token must never be a curl
# argv (/proc/<pid>/cmdline is world-readable). Private 0600 header file instead, -H @"$hdr_file",
# removed on EXIT. Created only once we know there is a countdown to act on.
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
printf 'Authorization: Bearer %s\n' "$TOK" > "$hdr_file"

due=$(python3 -c "import json,time;d=json.load(open('$CD'));print(1 if time.time()>=d.get('deadline',9e18) else 0)" 2>/dev/null || echo 0)
rem=$(python3 -c "import json,time;d=json.load(open('$CD'));s=int(d.get('deadline',0)-time.time());print(f'{max(0,s)//60}m')" 2>/dev/null || echo '?')
if [ "$due" != "1" ]; then echo "STATE:counting (deadline in $rem)"; exit 0; fi

echo "STATE:due -- attempting resume"
resumed=()
for s in $(tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^agent-'); do
  pane=$(tmux capture-pane -t "$s" -p -S -8 2>/dev/null)
  if echo "$pane" | grep -qiE 'stop and wait for limit|usage limit reached|limit will reset'; then
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
else
  echo "RESULT:STILL-LIMITED (reset not yet; will retry)"
fi

#!/bin/bash
# Quota/usage-limit monitor: scans each agent's tmux pane for the Claude
# 5-hour plan usage-limit banner (same phrasings as src/model-fallback.ts) and
# prints newly-limited sessions. Dedupes via store/quota-monitor-state.json so a
# session is reported only on the EDGE into the limited state, not every tick.
set -u
STORE="/home/neon/marveen/store"
STATE="$STORE/quota-monitor-state.json"
# NOTE: includes the interactive limit-PROMPT wording ("Stop and wait for limit
# to reset" / "Upgrade your plan") -- the older banner-only regex missed it and
# let backend+cybersec sit limited undetected (2026-06-29).
# NOTE (2026-06-30): removed the "upgrade to increase your usage limit" token --
# it matched Claude Code's "/upgrade to increase your usage limit." STARTUP HINT
# line that appears in every FRESH idle session, so the whole fleet read as
# limited seconds after boot (false positive). Real limits still match via
# "usage limit reached" / "limit will reset" / "stop and wait for limit".
RX='usage limit reached|reached your usage limit|hit (your|the) usage limit|approaching (your )?usage limit|usage limit (will )?reset|limit will reset at|[0-9]+-hour limit reached|wait for limit to reset|stop and wait for limit|upgrade your plan'

COUNTDOWN="$STORE/quota-reset-countdown.json"
prev=$(cat "$STATE" 2>/dev/null || echo '[]')
now=()
running=()
for s in $(tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^agent-|^mikrob-channels$'); do
  running+=("$s")
  pane=$(tmux capture-pane -t "$s" -p -S -20 2>/dev/null)
  if echo "$pane" | grep -qiE "$RX"; then now+=("$s"); fi
done
# newly-limited = in now but not in prev
# Also manage the 5h05m reset countdown (Peti rule 2026-07-04): on the EDGE into
# the limited state start a countdown (hit_at + 5h05m = deadline); when the limit
# clears, delete the countdown. The quota-reset-resume task acts at the deadline.
python3 - "$prev" "$STATE" "$COUNTDOWN" "$(IFS=,; echo "${running[*]:-}")" "${now[@]:-}" <<'PY'
import json,sys,time
prev=set(json.loads(sys.argv[1] or "[]"))
statepath=sys.argv[2]
countdownpath=sys.argv[3]
running=[x for x in sys.argv[4].split(",") if x]
now=[x for x in sys.argv[5:] if x]
new=[s for s in now if s not in prev]
json.dump(now, open(statepath,"w"))
# countdown management
import os
FIVE_H_FIVE_M = 5*3600 + 5*60
if now:
    # a limit is active: ensure a countdown exists (start it on the first edge)
    if not os.path.exists(countdownpath):
        t=time.time()
        json.dump({"hit_at":t,"deadline":t+FIVE_H_FIVE_M,"limited":now}, open(countdownpath,"w"))
    else:
        # keep the limited list fresh but DO NOT reset the deadline
        try:
            cd=json.load(open(countdownpath)); cd["limited"]=now; json.dump(cd,open(countdownpath,"w"))
        except Exception: pass
else:
    # now empty. BUT "no banner" can mean the limit cleared OR the limited agent
    # was PARKED (rule 7 stops idle agents; its tmux session is gone, so we never
    # scanned it). Only delete the countdown when EVERY previously-limited session
    # was actually re-scanned this run (present in `running`) and came back clean
    # -- positive evidence the limit lifted. If any limited session is missing
    # (parked), KEEP the countdown so quota-resume.sh can still restart it at the
    # deadline. Fixes the auto-resume-vs-park interaction (Peti 2026-07-06).
    if os.path.exists(countdownpath):
        try:
            cd=json.load(open(countdownpath))
            limited=cd.get("limited",[])
            if limited and all(s in running for s in limited):
                os.remove(countdownpath)
        except Exception: pass
print("NEW:"+",".join(new) if new else "NEW:")
print("CURRENT:"+",".join(now) if now else "CURRENT:")
PY

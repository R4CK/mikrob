#!/usr/bin/env bash
# Combined pre-check gate for the merged `quota-monitor` scheduled task
# (supersedes the separate quota-reset-resume + quota-limit-monitor gates).
#
# Protocol (src/web/schedule-runner.ts runPreCheck):
#   stdout == "SKIP"  -> scheduler skips the LLM entirely (no context reload)
#   stdout non-empty  -> LLM runs with stdout as context prefix
#   stdout empty/nonzero -> fail-open, LLM runs normally
#
# READ-ONLY / NON-CONSUMING: never runs quota-resume.sh or quota-check.sh (those
# have side effects that would clear the countdown / consume the NEW dedupe edge,
# leaving the subsequent LLM run with nothing to act on). It only decides whether
# either condition warrants a wake, and tells the merged prompt WHICH one via a
# marker line. If neither fires -> SKIP.
#
#   RESET-DUE     -> the 5h05m countdown deadline passed; LLM runs quota-resume.sh
#   LIMIT-BANNER  -> a usage-limit banner is on a fleet pane; LLM runs quota-check.sh
set -uo pipefail

CD="/home/neon/marveen/store/quota-reset-countdown.json"
markers=()

# --- Condition 1: countdown reset due (read-only view of the deadline) ---
if [ -f "$CD" ]; then
  due=$(python3 -c "import json,time;d=json.load(open('$CD'));print(1 if time.time()>=d.get('deadline',9e18) else 0)" 2>/dev/null || echo 0)
  [ "$due" = "1" ] && markers+=("RESET-DUE")
fi

# --- Condition 2: usage-limit banner present (non-consuming suspect scan) ---
# Canonical phrase source, shared with src/model-fallback.ts and 5 other scripts (card 115c21e7).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/session-limit-pattern.sh"
RX="$SESSION_LIMIT_RX"
sessions=$(tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^agent-|^mikrob-channels$' || true)
for s in $sessions; do
  if tmux capture-pane -t "$s" -p -S -25 2>/dev/null | grep -qiE "$RX"; then
    markers+=("LIMIT-BANNER"); break
  fi
done

# --- Verdict ---
if [ "${#markers[@]}" -eq 0 ]; then
  echo SKIP
else
  printf '%s\n' "${markers[@]}"
fi
exit 0

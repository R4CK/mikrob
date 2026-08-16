#!/usr/bin/env bash
# Pre-check gate for the `quota-limit-monitor` scheduled task.
#
# Protocol (see src/web/schedule-runner.ts runPreCheck):
#   stdout == "SKIP"  -> scheduler skips the LLM entirely (no context reload)
#   stdout non-empty  -> LLM runs with stdout as context prefix
#   stdout empty / non-zero exit -> fail-open, LLM runs normally
#
# This gate is READ-ONLY and NON-CONSUMING: it must NOT run quota-check.sh, which
# mutates the dedupe state (quota-monitor-state.json) and would consume the NEW
# edge, leaving the subsequent LLM run with nothing to report. It only does the
# cheap "suspect" scan quota-check.sh does first: capture the fleet agent panes
# and look for the limit-banner regex. No banner anywhere -> SKIP. Any banner ->
# let the LLM run quota-check.sh for the real restart-probe confirm + dedupe +
# Telegram notify.
#
# Effect: the quota-limit-monitor task only wakes the LLM when a usage-limit
# banner is actually present, instead of every 15 min. quota-check.sh (with its
# stale-modal restart-probe) remains the source of truth for NEW vs CURRENT.
set -uo pipefail

# Canonical phrase source, shared with src/model-fallback.ts and 5 other scripts (card 115c21e7).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/session-limit-pattern.sh"
RX="$SESSION_LIMIT_RX"

sessions=$(tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^agent-|^mikrob-channels$' || true)
for s in $sessions; do
  if tmux capture-pane -t "$s" -p -S -25 2>/dev/null | grep -qiE "$RX"; then
    # A banner is present somewhere -> wake the LLM to run the real check.
    # Empty stdout = "run LLM normally".
    exit 0
  fi
done

# No limit banner on any fleet pane -> nothing to report.
echo SKIP
exit 0

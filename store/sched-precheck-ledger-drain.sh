#!/usr/bin/env bash
# Pre-check gate for the `ledger-live-drain` scheduled task (card 53fffd74).
#
# The task fired every 2 minutes (720 LLM wakes/day) and was empty almost every time. This gate
# runs the drain itself and wakes the LLM only when it surfaced an unanswered inbound message.
#
# Protocol (src/web/schedule-runner.ts runPreCheck):
#   stdout == "SKIP"  -> scheduler skips the LLM entirely
#   stdout non-empty  -> LLM runs with stdout as context prefix
#
# Running the drain HERE consumes its "surface once" marker, so the OPEN_QUESTION block is handed
# to the LLM through the prefix; the task prompt tells it to answer from the prefix and not to
# re-run the drain (a re-run would now print nothing). The drain exits 0 with no output on every
# internal error, so a broken ledger reads as SKIP -- the same silent no-op the task had before.
set -uo pipefail
cd "$(dirname "$0")/.." || { echo SKIP; exit 0; }
out="$(python3 scripts/hooks/ledger-live-drain.py 2>/dev/null)"
if [ -z "$out" ]; then echo SKIP; else printf '%s\n' "$out"; fi

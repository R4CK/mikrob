#!/usr/bin/env bash
# Classify a finished vitest run's log: real failure, or the known worker-RPC flake? (card c6153a69)
#
# Usage:  vitest-flake-classify.sh <exit-status> <log-file>
# Prints an explanation to STDERR when the run is the known flake; silent otherwise.
# Exit:   0 = the run is the KNOWN BENIGN FLAKE (tests all passed)
#         1 = anything else (clean pass, or a genuine failure) -- the caller keeps its own status
#
# WHY THIS EXISTS. A full CleanCore suite that hits this exits 1 with ZERO failed tests, and the only
# clue is one "Unhandled Error" paragraph a thousand lines up. Card c6153a69 was opened because that
# happened three times in five runs; today it happened three more times, and each time the agent
# holding the card re-diagnosed it from scratch and wrote a paragraph about it in a REVIEW. That is
# the cost: not the flake, the RE-DIAGNOSIS. `fleet-test.sh` already solved this for the marveen
# suite (card 54699bbb); the CleanCore side had nothing, so this is that answer, extracted.
#
# THE MECHANISM, verified in the INSTALLED CleanCore vitest 3.2.6 rather than taken on trust:
#   dist/chunks/index.B521nVV-.js:3    const DEFAULT_TIMEOUT = 6e4;      <- 60s
#   dist/chunks/index.B521nVV-.js:21   timeout = DEFAULT_TIMEOUT         <- birpc's own default
#   dist/chunks/utils.CAioKnHs.js:25   createForksRpcOptions() returns serialize/deserialize/post/on
#                                      and NO timeout key, so that default stands.
# The worker reports progress to the MAIN process over that RPC; a CPU-starved main process misses
# the 60s round trip and the WORKER throws. Every test has already passed by then. There is no
# vitest config knob for it on this version -- so the only real levers are the ones that stop the
# main process from starving: fewer concurrent suites (the rule 18 semaphore) and fewer workers.
#
# IT DOES NOT SWALLOW THE EXIT CODE, deliberately. The caller keeps its own status; this only adds
# the sentence a reader would otherwise have to reconstruct. A wrapper that turned exit 1 into exit 0
# would be indistinguishable from one that hid a real regression -- and the whole point of the
# classification is telling those two apart, not blurring them.
set -uo pipefail

STATUS="${1:-}"
LOG="${2:-}"

if [ -z "$STATUS" ] || [ -z "$LOG" ]; then
  echo "usage: vitest-flake-classify.sh <exit-status> <log-file>" >&2
  exit 2
fi
[ -f "$LOG" ] || exit 1

# A clean run is not a flake, whatever the log says.
[ "$STATUS" -ne 0 ] 2>/dev/null || exit 1

# The signature: the worker-RPC timeout AND no failed test anywhere in the summary. Both halves are
# required -- a run that hits the flake AND has real failures is a REAL FAILURE, and calling it
# benign because the sentence appears would be exactly the swallow this file refuses to do.
grep -q 'Timeout calling "onTaskUpdate"' "$LOG" || exit 1
grep -qE '(Test Files|Tests)[[:space:]]+[0-9]+ failed' "$LOG" && exit 1

cat >&2 <<EXPLAIN

cleancore suite: KNOWN BENIGN FLAKE, not a regression (cards 54699bbb / c6153a69).
  Every test above passed -- there is no "N failed" in the summary. The nonzero exit ($STATUS)
  comes ONLY from vitest's own worker-RPC timeout: birpc's hardcoded 60s bound, which
  createForksRpcOptions() does not override on vitest 3.2.6, so it cannot be configured away.
  It fires when the MAIN process is too CPU-starved to answer in time, which is why the fix is
  fewer concurrent runs (store/cleancore-suite-run.sh, rule 18) rather than a config change.
  Upstream and non-deterministic: vitest-dev/vitest #6479, #4497, #8164.

  DO NOT read this as a pass. Read the summary line yourself: it is a pass only if it says
  0 failed. This message means "the exit code alone is not the verdict", not "ignore the run".
EXPLAIN
exit 0

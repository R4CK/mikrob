#!/usr/bin/env bash
# Self-test for landing-gate-verdict-check.sh + landing-gate-verdict-parse.py (card 9081d02d).
#
# Run:  bash store/landing-gate-verdict-check.selftest.sh
# Exit: 0 = all pass, 1 = at least one case wrong.
#
# The parser cases run on fixture JSON, so they need no dashboard and no network -- which is the
# point: this control decides whether a landing happens, and a check that can only be exercised
# against a live board is one nobody runs.
#
# The REFUSAL cases matter most. This gate sits in front of every CleanCore landing, so an
# over-eager refusal blocks real work and a lax one recreates the 08dcc153 incident it exists to
# prevent. Both directions are listed on purpose.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARSER="$HERE/landing-gate-verdict-parse.py"
fail=0
n=0

t() { # $1 = label, $2 = expected KIND, $3 = sha, stdin = comments JSON
  n=$((n + 1))
  local got kind
  got="$(python3 "$PARSER" "$3")"
  kind="${got%%|*}"
  if [ "$kind" = "$2" ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1 -> expected $2, got $got"
    fail=1
  fi
}

j() { # build a comments payload from author/content pairs
  python3 -c '
import json, sys
out = []
args = sys.argv[1:]
for i in range(0, len(args), 2):
    out.append({"author": args[i], "content": args[i + 1]})
print(json.dumps({"comments": out}))' "$@"
}

echo "landing-gate-verdict-check selftest"

t "a QA PASS naming the sha satisfies the gate" OK abc1234 \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234

looks good')"

t "a SHORT sha in the comment still matches a long one being landed" OK abc1234def5678 \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234')"

t "...and the other way round, a long sha in the comment vs a short one landed" OK abc1234 \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234def5678')"

t "several shas on one Gate-SHA line, one of them ours" OK bbb2222 \
  <<<"$(j qa 'QA PASS
Gate-SHA: aaa1111, bbb2222')"

t "a QA PASS for a DIFFERENT sha does not cover this landing" OTHERSHA zzz9999 \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234')"

t "a QA FAIL naming the sha refuses, even alongside a pass" FAILED abc1234 \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234' qa 'QA FAIL
Gate-SHA: abc1234
the fix was never re-gated')"

# Rule 4: QA runs on EVERY card; a security gate is risk-tiered on top of it. So a lone security
# GO means half the gate ran, not that the card was gated.
t "a lone CYBERSEC GO is reported but does NOT satisfy the check" NOQA abc1234 \
  <<<"$(j cybersec 'CYBERSEC GO
Gate-SHA: abc1234')"

t "a card with no verdict at all -- the 08dcc153 shape" NONE abc1234 \
  <<<"$(j backend 'REVIEW: done
Gate-SHA: abc1234')"

# Rule 4c: the verdict word must be the comment's FIRST line. Pinned because the fleet's own
# scanners key on it, and a comment that buries the verdict is invisible to all of them alike.
t "a verdict below the Gate-SHA line is not recognised (rule 4c)" NONE abc1234 \
  <<<"$(j qa 'Gate-SHA: abc1234
QA PASS')"

t "a QA PASS with NO Gate-SHA line names no sha, so it covers none" OTHERSHA abc1234 \
  <<<"$(j qa 'QA PASS

I checked the branch')"

t "an empty Gate-SHA line names no sha, so it covers nothing" OTHERSHA abc1234 \
  <<<"$(j qa 'QA PASS
Gate-SHA:')"

# THE MISPLACED GUARD, kept as two cases because a mutation is what found it. The original guard
# defended the wrong operand: an entry in the comment can never be empty (the sha pattern needs 7+
# characters), so deleting that guard changed nothing. The live hole was the sha being LANDED --
# with an empty one, `f.startswith("")` is true for every verdict on the card, so the check passed
# on a completely unrelated commit.
t "an EMPTY sha to check must never match a verdict" UNREADABLE "" \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234')"

t "...and a sha too short to identify a commit is refused, not prefix-matched" UNREADABLE abc \
  <<<"$(j qa 'QA PASS
Gate-SHA: abc1234')"

t "prose merely mentioning a verdict mid-sentence is not a verdict" NONE abc1234 \
  <<<"$(j backend 'I will ask for a QA PASS next
Gate-SHA: abc1234')"

t "malformed JSON is UNREADABLE, not silently empty" UNREADABLE abc1234 <<<'not json at all'
t "an empty comment list is NONE" NONE abc1234 <<<'[]'
t "an unexpected response shape is UNREADABLE" UNREADABLE abc1234 <<<'{"error":"nope"}'

# --- the shell wrapper: fail-closed vs report ------------------------------------------------
# shellcheck source=./landing-gate-verdict-check.sh
. "$HERE/landing-gate-verdict-check.sh"

n=$((n + 1))
if GATE_CHECK_TOKEN_FILE=/nonexistent/token gate_verdict_check c1 abc1234 refuse >/dev/null 2>&1; then
  echo "  FAIL an unreadable token in REFUSE mode must fail closed"; fail=1
else
  echo "  ok   an unreadable token in REFUSE mode fails CLOSED"
fi

n=$((n + 1))
if GATE_CHECK_TOKEN_FILE=/nonexistent/token gate_verdict_check c1 abc1234 report >/dev/null 2>&1; then
  echo "  ok   ...and the same in REPORT mode does not block a marveen landing"
else
  echo "  FAIL report mode must never block"; fail=1
fi

echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

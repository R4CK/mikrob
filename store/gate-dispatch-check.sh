#!/usr/bin/env bash
# gate-dispatch-check.sh -- suppress a gate dispatch that has ALREADY been answered.
#
# WHY (Cybersec 2026-08-07, approved by MikroB): four times in one afternoon a gate
# dispatch arrived for a card whose verdict was already on the card -- once by 5 minutes,
# once by 60. Each one costs a full gate re-load (the agent re-reads the card, the commit,
# the diff and the surrounding code) for an answer that was already published. The fix is
# one cheap read before the dispatch, not more discipline.
#
# THE RULE, and why it is NOT "has the agent commented":
#   A gate agent SHOULD be re-dispatched when new work has landed since its verdict --
#   that is a legitimate re-gate (e.g. NO-GO -> fix -> re-gate). What is wasteful is a
#   dispatch when the agent's own verdict is the LATEST word on the card.
#   So: ADVISE-SKIP only when the agent's most recent comment is NEWER than the most recent
#   REVIEW comment. A REVIEW that postdates the verdict means there is something new to
#   look at, and the dispatch goes through.
#
# CONTRACT:
#   gate-dispatch-check.sh check <cardId> <agent>
#       -> "ALLOW"                          exit 0  (nothing known; dispatch it)
#       -> "ALLOW:no-verdict"               exit 0  (agent has never commented)
#       -> "ALLOW:stale-verdict"            exit 0  (a REVIEW landed after the verdict)
#       -> "ADVISE-SKIP:already-gated:<ts>" exit 8  (the verdict is the newest word)
#   gate-dispatch-check.sh selftest         -> offline self-test, no API calls, no side effects
#
# ADVISORY, NOT A BLOCK -- and this is the important part, measured rather than assumed.
# Replayed against the six real gate dispatches of 2026-08-07 it returns:
#     74ba7c78 -> ALLOW:stale-verdict   (the fix landed after the NO-GO: a correct re-gate)
#     the other five -> ADVISE-SKIP
# but THREE of those five carried a NEW QUESTION from the dispatcher (sweep the shadow
# class / prove the bypass and the XSS reasoning / show the two rows open no oracle), and
# each produced findings the original verdict did not contain. Only two were true replays.
# So a hard block would have suppressed three useful dispatches to save two wasteful ones.
# "Is there a new question" is not something this script can read. Therefore the caller
# must treat ADVISE-SKIP as a PROMPT -- skip a pure re-request, or dispatch anyway and say
# in the message what is new -- never as an automatic refusal.
#
# FAIL-OPEN BY DESIGN: any API/parse/network failure prints ALLOW and exits 0. This is a
# COST guard, not a security control -- a broken check must never silence a real dispatch.
# (The opposite direction would be a monitor that stops dispatching when the dashboard
# hiccups, which is how a fleet quietly stops gating.)
#
# NOT WIRED ANYWHERE YET. It changes when a gate agent is woken, so it goes live only
# after MikroB's review (a gate agent must not silently edit its own dispatch path).
set -euo pipefail

STORE="$(cd "$(dirname "$0")" && pwd)"
DASH="${DASH:-http://localhost:3420}"
TOKEN_FILE="${STORE}/.dashboard-token"

# SECURITY (gate-ops-scripts-token-in-argv): the bearer token goes to curl through a 0600
# header file, never on the command line where `ps` would show it.
_curl_get() { # $1 = path
  local hf; hf="$(mktemp)"; chmod 600 "$hf"
  printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE" 2>/dev/null)" > "$hf"
  curl -s --max-time 12 -H @"$hf" "${DASH}$1" 2>/dev/null
  rm -f "$hf" 2>/dev/null || true
}

# Decide from a comments JSON array on stdin. Kept as its own function so the selftest can
# exercise the SAME code the live path uses, instead of a re-implementation of it.
_decide() { # $1 = agent
  AGENT="$1" python3 -c '
import json, re, sys, os
agent = os.environ["AGENT"]
try:
    d = json.load(sys.stdin)
except Exception:
    print("ALLOW"); sys.exit(0)          # unparseable -> fail OPEN
cs = d if isinstance(d, list) else d.get("comments", [])
if not isinstance(cs, list):
    print("ALLOW"); sys.exit(0)

def ts(c):
    v = c.get("created_at")
    return v if isinstance(v, (int, float)) else 0

mine = [c for c in cs if c.get("author") == agent]
if not mine:
    print("ALLOW:no-verdict"); sys.exit(0)

last_mine = max(ts(c) for c in mine)
# A REVIEW is the signal that new work is on the table. Two narrowings, both measured:
#  - by SOMEONE ELSE: a gate agent quoting the word in its own verdict must not re-arm itself;
#  - ANCHORED to the start of a line, not "contains". Across 28 real comments mentioning the
#    word, only 8 were submissions; the other 20 were verdicts by other agents quoting it
#    ("QA PASS -- ...the REVIEW claim holds") or prose ("a te REVIEW-od utan"). A substring
#    test re-arms on all of those, which is the fail-open direction but pure noise.
review_rx = re.compile(r"^\s*(?:[#*>\-]*\s*)?REVIEW\b", re.M)
reviews = [ts(c) for c in cs
           if c.get("author") != agent and review_rx.search(c.get("content") or "")]
last_review = max(reviews) if reviews else 0

if last_review > last_mine:
    print("ALLOW:stale-verdict")
else:
    print(f"ADVISE-SKIP:already-gated:{int(last_mine)}")
'
}

case "${1:-}" in
  check)
    CARD="${2:-}"; AGENT="${3:-}"
    [[ -n "$CARD" && -n "$AGENT" ]] || { echo "usage: $0 check <cardId> <agent>" >&2; exit 2; }
    body="$(_curl_get "/api/kanban/${CARD}/comments" || true)"
    [[ -n "$body" ]] || { echo "ALLOW"; exit 0; }   # no answer from the API -> fail OPEN
    verdict="$(printf '%s' "$body" | _decide "$AGENT" || echo ALLOW)"
    echo "$verdict"
    [[ "$verdict" == ADVISE-SKIP:* ]] && exit 8 || exit 0
    ;;

  selftest)
    fail=0
    t() { # $1 = label, $2 = expected prefix, $3 = agent, stdin = comments json
      local got; got="$(_decide "$3")"
      if [[ "$got" == "$2"* ]]; then echo "  ok   $1 -> $got"
      else echo "  FAIL $1 -> got '$got', expected '$2'*"; fail=1; fi
    }
    echo "gate-dispatch-check selftest"
    t "no comments at all"            "ALLOW:no-verdict"   cybersec <<< '[]'
    t "only someone else's REVIEW"    "ALLOW:no-verdict"   cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW -- done"}]'
    t "verdict is the newest word"    "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"cybersec","created_at":200,"content":"CYBERSEC GO"}]'
    t "new REVIEW after the verdict"  "ALLOW:stale-verdict" cybersec <<< '[{"author":"cybersec","created_at":200,"content":"NO-GO"},{"author":"backend2","created_at":300,"content":"REVIEW -- fixed"}]'
    t "another gate commented later"  "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"cybersec","created_at":200,"content":"GO"},{"author":"qa","created_at":300,"content":"QA PASS"}]'
    t "own comment says REVIEW"       "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"cybersec","created_at":200,"content":"GO -- the REVIEW claim holds"}]'
    t "malformed json"                "ALLOW"              cybersec <<< 'not json'
    t "object-wrapped comments"       "ADVISE-SKIP:already-gated" cybersec <<< '{"comments":[{"author":"backend","created_at":100,"content":"REVIEW"},{"author":"cybersec","created_at":200,"content":"GO"}]}'
    t "missing created_at"            "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"cybersec","content":"GO"}]'
    # Anchoring: a later comment that only MENTIONS the word must not re-arm the dispatch.
    t "later peer QUOTES the word"    "ADVISE-SKIP:already-gated" cybersec <<< '[{"author":"cybersec","created_at":200,"content":"GO"},{"author":"mikrob","created_at":300,"content":"bontsd fel, a te REVIEW-od utan nyitom a gyerekkartyat"}]'
    t "later peer SUBMITS a review"   "ALLOW:stale-verdict" cybersec <<< '[{"author":"cybersec","created_at":200,"content":"GO"},{"author":"backend","created_at":300,"content":"REVIEW -- kesz, commit abc1234"}]'
    t "submission behind a md bullet" "ALLOW:stale-verdict" cybersec <<< '[{"author":"cybersec","created_at":200,"content":"GO"},{"author":"backend","created_at":300,"content":"## REVIEW\nkesz"}]'
    [[ $fail -eq 0 ]] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }
    ;;

  *)
    echo "usage: $0 {check <cardId> <agent>|selftest}" >&2; exit 2 ;;
esac

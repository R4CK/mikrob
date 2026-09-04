#!/usr/bin/env bash
# Self-test for gate-pretriage-attribution.sh (card 928251b5).
#
# REAL git repos and REAL commits, not string fixtures: the predicate's whole job is to read a commit
# MESSAGE out of a repo, and a fixture would only prove the regex agrees with itself.
#
# The KEEP cases matter at least as much as the exclusion. This predicate decides whether pre-triage
# fires a new gate round; an over-eager exclusion means a real new commit never gets triaged, which
# is a silent miss rather than a loud one.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./gate-pretriage-attribution.sh
. "$HERE/gate-pretriage-attribution.sh"

fail=0
n=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
R="$TMP/repo"
git init -q -b main "$R"
git -C "$R" config user.email t@t; git -C "$R" config user.name t

mk() { # $1 = message -> prints the sha
  echo "$RANDOM$RANDOM" > "$R/f-$RANDOM.txt"
  git -C "$R" add -A >/dev/null
  git -C "$R" commit -q -m "$1"
  git -C "$R" rev-parse HEAD
}

t() { # $1 = label, $2 = expected (skip|keep), $3 = sha, $4 = card
  n=$((n + 1))
  local got
  if names_another_card "$R" "$3" "$4"; then got=skip; else got=keep; fi
  if [ "$got" = "$2" ]; then echo "  ok   $1"; else echo "  FAIL $1 -> expected $2, got $got"; fail=1; fi
}

echo "gate-pretriage-attribution selftest"

# THE MEASURED INCIDENT, reproduced in shape: ee864511's message named card 550befbf while pre-triage
# was running for card 54d4a4a3, and no commit named 54d4a4a3 at all.
FOREIGN="$(mk 'feat(proof): ProofWrite RBAC + presign/confirm photo-capture infrastructure (card 550befbf)')"
t 'a commit naming ANOTHER card is skipped -- the 54d4a4a3 incident' skip "$FOREIGN" 54d4a4a3
t '...and the SAME commit is kept on the card it actually names' keep "$FOREIGN" 550befbf

NOCARD="$(mk 'chore: tidy up a helper')"
t 'a commit naming NO card is KEPT -- no proof either way, and rebases depend on it' keep "$NOCARD" 54d4a4a3

MINE="$(mk 'fix(guard): narrow the sweep (card 54d4a4a3)')"
t 'a commit naming THIS card is kept' keep "$MINE" 54d4a4a3

BOTH="$(mk 'fix: follow-up to card 550befbf, landed under card 54d4a4a3')"
t 'a commit naming this card AND another is KEPT -- ours is present, that is enough' keep "$BOTH" 54d4a4a3

CASE="$(mk 'fix(x): something (Card 550BEFBF)')"
t 'the match is case-insensitive on both the word and the hex' skip "$CASE" 54d4a4a3

# THE LOOSE-READING TRAP THIS FIX EXISTS TO AVOID. A bare hex in the message is NOT a card claim --
# treating it as one would reintroduce exactly the bug being fixed, one layer down.
BARE="$(mk 'revert: back out ee864511, it broke the build')"
t 'a bare hex with no "card" word is not a card claim -- kept' keep "$BARE" 54d4a4a3

SPACED="$(mk 'fix(y): see  card   550befbf  for context')"
t 'extra whitespace between the word and the id still matches' skip "$SPACED" 54d4a4a3

t 'an unresolvable sha is kept, never skipped -- the caller decides what exists' keep deadbeefdeadbeef 54d4a4a3

echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

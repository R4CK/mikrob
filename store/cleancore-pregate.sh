#!/usr/bin/env bash
# cleancore-pregate.sh -- the two cheap measurements nobody ran, before a card reaches a gate
# (card 67beaf74, after 0a500b2e and cb6b2c70 both took PASS/GO while red at their own gated sha).
#
# WHAT WENT WRONG, so the shape of this is not arbitrary:
#   * 0a500b2e got QA PASS + Cybersec GO + Cybered GO with TWO typecheck errors and TWO failing
#     tests at its own gated commit, and the landing carried both onto main.
#   * cb6b2c70 got a GO while its OWN wiring-manifest-guards.test.ts was 7/20 red.
# Neither is gate-agent inattention. Nobody ran tsc and the suite on the gated sha, because doing
# it by hand costs ten minutes and a worktree, so it kept not happening.
#
# TWO DESIGN DECISIONS THAT ARE THE WHOLE VALUE:
#
#  1. DELTA, NOT ABSOLUTE. main carries inherited red of its own (today: two LEAVE tests). Refusing
#     on that would block every branch queued behind the first, and would train everyone to ignore
#     the output. Only what the branch ADDS over its merge-base is a finding; what it inherits is
#     reported separately, by count, so it is visible without being blamed on this card.
#
#  2. THE WHOLE SUITE, NOT THE BRANCH'S OWN TEST FILES. My first proposal was the cheap version --
#     run the test files the branch touches. Measured against the real queue it passed all six
#     cards, INCLUDING 9c47038a at 31/31, whose route-shadowing.test.ts is red at its own gated sha.
#     It passed because the branch does not EDIT that file; it merely breaks it (a handler went
#     async, the test still read the result synchronously). The cheap version would have waved
#     through the exact card it was written for, so it is not in here.
#
# Usage:  cleancore-pregate.sh <cardId> <gated-sha> [--no-tests]
#         cleancore-pregate.sh --selftest
# Exit: 0 nothing added | 1 the branch adds errors or failures | 2 bad usage | 3 refused | 4 harness
set -uo pipefail

MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
CACHE_DIR="${CLEANCORE_PREGATE_CACHE:-$HOME/.cache/cleancore-pregate}"
say() { echo "  $*"; }
die() { echo "REFUSED: $2" >&2; exit "$1"; }

# shellcheck source=./cleancore-tsc-lib.sh
. "$(dirname "$0")/cleancore-tsc-lib.sh"

# Lines present in $2 but not in $1. Both must be sorted; both come from sort -u upstream.
added() { comm -13 "$1" "$2"; }

if [ "${1:-}" = "--selftest" ]; then
  fail=0; n=0
  t() { n=$((n+1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }
  tmp="$(mktemp -d)"
  printf 'a: error TS1: x\n' > "$tmp/base"
  printf 'a: error TS1: x\nb: error TS2: y\n' > "$tmp/head"
  t "an ADDED error is reported"           "$(added "$tmp/base" "$tmp/head")" "b: error TS2: y"
  t "an INHERITED error is not"            "$(added "$tmp/base" "$tmp/base" | wc -l)" "0"
  t "a FIXED error does not read as added" "$(added "$tmp/head" "$tmp/base" | wc -l)" "0"
  # The line-number normaliser is what makes the delta usable at all: the same error under an
  # inserted hunk must not read as new.
  t "a shifted line is the same error" \
    "$(printf 'src/a.ts(12,5): error TS1: x\nsrc/a.ts(99,5): error TS1: x\n' | norm_errors | wc -l)" "1"
  # Test names arrive already stripped of vitest's `|packages|` prefix, so base and head compare.
  t "a FAIL line reduces to its test name" \
    "$(printf ' FAIL  |packages| apps/api/src/x.test.ts > suite > case\n' | sed -E 's/^ FAIL +\|[^|]*\| +//')" \
    "apps/api/src/x.test.ts > suite > case"
  rm -rf "$tmp"
  echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi

CARD="${1:-}"; SHA="${2:-}"; MODE="${3:-}"
[ -n "$CARD" ] && [ -n "$SHA" ] || { echo "usage: cleancore-pregate.sh <cardId> <gated-sha> [--no-tests]" >&2; exit 2; }
RUN_TESTS=1; [ "$MODE" = "--no-tests" ] && RUN_TESTS=0

git -C "$MAIN" fetch origin --quiet || die 3 "could not fetch origin"
[ "$(git -C "$MAIN" cat-file -t "$SHA" 2>/dev/null)" = "commit" ] || die 3 "$SHA is not a commit in $MAIN"
MB="$(git -C "$MAIN" merge-base "$SHA" origin/main)" || die 3 "no merge-base with origin/main"
SHORT="$(git -C "$MAIN" rev-parse --short "$SHA")"
MBSHORT="$(git -C "$MAIN" rev-parse --short "$MB")"
echo "PRE-GATE $CARD: $SHORT vs its merge-base $MBSHORT (origin/main $(git -C "$MAIN" rev-parse --short origin/main))"

mkdir -p "$CACHE_DIR"
# Keyed by the FULL sha of the tree measured, so the merge-base result is shared by every card that
# forked from it -- which is most of a queue, and is where the runtime actually goes.
measure() { # $1 = full sha, $2 = label
  local full="$1" label="$2" wt="/home/neon/cc-pregate-$2-$(git -C "$MAIN" rev-parse --short "$1")"
  local errf="$CACHE_DIR/tsc-$full.txt" testf="$CACHE_DIR/tests-$full.txt"
  if [ -f "$errf" ] && { [ "$RUN_TESTS" -eq 0 ] || [ -f "$testf" ]; }; then
    say "$label $(git -C "$MAIN" rev-parse --short "$1"): reused from cache"
    return 0
  fi
  rm -rf "$wt"
  git -C "$MAIN" worktree add --detach -q "$wt" "$full" || { echo "could not create worktree for $label"; return 1; }
  link_node_modules "$wt"
  [ -f "$errf" ] || typecheck_errors "$wt" 0 > "$errf"
  say "$label $(git -C "$MAIN" rev-parse --short "$1"): $(wc -l < "$errf") typecheck error(s)"
  if [ "$RUN_TESTS" -eq 1 ] && [ ! -f "$testf" ]; then
    test_failures "$wt" > "$testf"
    say "$label: $(wc -l < "$testf") failing test(s)"
  fi
  git -C "$MAIN" worktree remove --force "$wt" >/dev/null 2>&1
}

measure "$MB" base || exit 4
measure "$(git -C "$MAIN" rev-parse "$SHA")" head || exit 4

BASE_ERR="$CACHE_DIR/tsc-$MB.txt"
HEAD_ERR="$CACHE_DIR/tsc-$(git -C "$MAIN" rev-parse "$SHA").txt"

if grep -q '^HARNESS-FAULT' "$BASE_ERR" "$HEAD_ERR" 2>/dev/null; then
  echo "HARNESS FAULT -- this is NOT a clean measurement, do not read it as a pass:"
  grep -h '^HARNESS-FAULT' "$BASE_ERR" "$HEAD_ERR" | sed 's/^/    /'
  exit 4
fi

findings=0
NEW_ERR="$(added "$BASE_ERR" "$HEAD_ERR")"
INHERITED="$(comm -12 "$BASE_ERR" "$HEAD_ERR" | wc -l)"
if [ -n "$NEW_ERR" ]; then
  echo "TYPECHECK: the branch ADDS $(echo "$NEW_ERR" | wc -l) error(s) its merge-base does not have:"
  echo "$NEW_ERR" | sed 's/^/    /'
  findings=1
else
  say "typecheck: adds nothing"
fi
# Phrased from the number, not around it: the first version said "but the tree is red" even when
# the count was zero, which is a report stating something false -- the exact thing this tool exists
# to stop other people's work doing.
if [ "$INHERITED" -gt 0 ]; then
  say "typecheck: $INHERITED error(s) INHERITED from the base -- not this card's to fix, but the tree IS red"
else
  say "typecheck: nothing inherited either -- the base is clean"
fi

if [ "$RUN_TESTS" -eq 1 ]; then
  BASE_T="$CACHE_DIR/tests-$MB.txt"
  HEAD_T="$CACHE_DIR/tests-$(git -C "$MAIN" rev-parse "$SHA").txt"
  if grep -q '^HARNESS-FAULT' "$BASE_T" "$HEAD_T" 2>/dev/null; then
    echo "HARNESS FAULT in the test run -- NOT a green suite:"
    grep -h '^HARNESS-FAULT' "$BASE_T" "$HEAD_T" | sed 's/^/    /'
    exit 4
  fi
  NEW_T="$(added "$BASE_T" "$HEAD_T")"
  INH_T="$(comm -12 "$BASE_T" "$HEAD_T" | wc -l)"
  if [ -n "$NEW_T" ]; then
    echo "TESTS: the branch BREAKS $(echo "$NEW_T" | wc -l) test(s) that pass on its merge-base:"
    echo "$NEW_T" | sed 's/^/    /'
    findings=1
  else
    say "tests: breaks nothing"
  fi
  if [ "$INH_T" -gt 0 ]; then
    say "tests: $INH_T failure(s) INHERITED from the base -- red before this branch existed"
  else
    say "tests: nothing inherited either -- the base is green"
  fi
else
  say "tests: SKIPPED (--no-tests) -- the suite was NOT run, so this is a typecheck-only result"
fi

[ "$findings" -eq 0 ] && echo "PRE-GATE CLEAN: $CARD @ $SHORT adds no typecheck error and breaks no test."
exit "$findings"

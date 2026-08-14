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

# apps/web is a separate tsc project and was hardcoded OFF here, so the sentinel printed a clean
# "0 typecheck error(s)" for a branch it had not fully measured -- a filtered result reported without
# its filter, which is worse than a slow one. Same derived rule cleancore-land.sh already uses: the
# project is measured when the branch touches it, so nobody has to remember a flag.
WANT_WEB=0
git -C "$MAIN" diff --name-only "$MB..$SHA" | grep -q '^apps/web/' && WANT_WEB=1
[ "$WANT_WEB" = 1 ] && say "typecheck: including apps/web (the branch touches it)" \
                    || say "typecheck: apps/web NOT measured (the branch does not touch it)"

mkdir -p "$CACHE_DIR"
# Keyed by the FULL sha of the tree measured, so the merge-base result is shared by every card that
# forked from it -- which is most of a queue, and is where the runtime actually goes. The web flag is
# part of the key: without it a cached web-less run would be reused for a web-touching branch and
# report the narrower measurement as if it were the wider one.
# QA2 FAIL on 52fdfc7, reproduced against a live parallel run, not argued: the worktree path used to
# be `/home/neon/cc-pregate-$label-$shortsha` -- deterministic and NOT process-unique. Two gate agents
# running the SAME documented reproduction (the intended use) wrote the same path, and one run's
# closing `git worktree remove --force` pulled the directory out from under the other's tsc/vitest
# mid-cycle. That produced 161 "typecheck errors" (mostly TS6053 File not found) and 122 "failing
# tests" (whole-file load failures) -- numbers that LOOK real. The HARNESS-FAULT detector cannot see
# it, because the race lands half-way: files loaded before the directory vanished, so tsc exits
# non-zero WITH `error TS` lines. A silently wrong measurement is the exact class this tool exists to
# prevent, so it was vulnerable to its own subject. $$ makes the path private to this process.
measure() { # $1 = full sha, $2 = label
  local full="$1" label="$2" short; short="$(git -C "$MAIN" rev-parse --short "$1")"
  local wt="/home/neon/cc-pregate-$2-$short-$$"
  local errf="$CACHE_DIR/tsc-$full-web$WANT_WEB.txt" testf="$CACHE_DIR/tests-$full.txt"
  if [ -f "$errf" ] && { [ "$RUN_TESTS" -eq 0 ] || [ -f "$testf" ]; }; then
    say "$label $short: reused from cache"
    return 0
  fi
  rm -rf "$wt"
  # Self-heal, QA's second MINOR: an interrupted run leaves a registered-but-missing worktree, and
  # every later invocation against that sha then hard-fails until someone prunes by hand. Prune first,
  # and retry once after a forced removal -- a stale entry is bookkeeping, not a reason to refuse.
  git -C "$MAIN" worktree prune >/dev/null 2>&1
  if ! git -C "$MAIN" worktree add --detach -q "$wt" "$full" 2>/dev/null; then
    git -C "$MAIN" worktree remove --force "$wt" >/dev/null 2>&1
    git -C "$MAIN" worktree prune >/dev/null 2>&1
    git -C "$MAIN" worktree add --detach -q "$wt" "$full" || {
      echo "could not create worktree for $label at $wt"; return 1; }
    say "$label: recovered a stale worktree registration before measuring"
  fi
  link_node_modules "$wt"
  # Write to a private temp file and rename. The cache is shared BY DESIGN (a merge-base result serves
  # every card forked from it), so two runs can measure the same sha at once; without the rename a
  # reader could pick up a half-written file and compare against it.
  if [ ! -f "$errf" ]; then
    typecheck_errors "$wt" "$WANT_WEB" > "$errf.$$.tmp" && mv -f "$errf.$$.tmp" "$errf"
  fi
  # Count FAULT lines separately (QA's first MINOR): they used to be tallied as typecheck errors, so a
  # faulted run printed "base: 4 typecheck error(s)" when the file held 4 HARNESS-FAULT lines and no
  # errors at all. The final gate refused correctly, but the live log said something untrue.
  local faults errs
  faults="$(grep -c '^HARNESS-FAULT' "$errf" 2>/dev/null || true)"
  errs=$(( $(wc -l < "$errf") - faults ))
  if [ "$faults" -gt 0 ]; then
    say "$label $short: $errs typecheck error(s) + $faults HARNESS-FAULT line(s) -- not a measurement"
  else
    say "$label $short: $errs typecheck error(s)"
  fi
  if [ "$RUN_TESTS" -eq 1 ] && [ ! -f "$testf" ]; then
    test_failures "$wt" > "$testf.$$.tmp" && mv -f "$testf.$$.tmp" "$testf"
    say "$label: $(wc -l < "$testf") failing test(s)"
  fi
  git -C "$MAIN" worktree remove --force "$wt" >/dev/null 2>&1
}

measure "$MB" base || exit 4
measure "$(git -C "$MAIN" rev-parse "$SHA")" head || exit 4

# Same name measure() writes, web flag included. Reading a DIFFERENT name here would silently compare
# two files that do not exist: the diff comes out empty and the run reports CLEAN without having
# compared anything.
BASE_ERR="$CACHE_DIR/tsc-$MB-web$WANT_WEB.txt"
HEAD_ERR="$CACHE_DIR/tsc-$(git -C "$MAIN" rev-parse "$SHA")-web$WANT_WEB.txt"

# An ABSENT measurement is not an empty one. The compare below is a set difference, so two missing
# files produce "adds nothing" and the run announces CLEAN having read neither -- which is how the
# rename above would have failed if this check were not here. Fail on the missing file, not on the
# conclusion drawn from it.
for f in "$BASE_ERR" "$HEAD_ERR"; do
  [ -f "$f" ] || { echo "MEASUREMENT MISSING: $f -- nothing was compared, this is NOT a pass"; exit 4; }
done

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

# The summary line may only claim what was actually measured. Under --no-tests the old wording said
# "breaks no test" about a suite that never ran -- exactly the shape a reader quotes as evidence
# later, when the SKIPPED line four rows up has scrolled away.
if [ "$findings" -eq 0 ]; then
  if [ "$RUN_TESTS" -eq 1 ]; then
    echo "PRE-GATE CLEAN: $CARD @ $SHORT adds no typecheck error and breaks no test."
  else
    echo "PRE-GATE CLEAN (typecheck only): $CARD @ $SHORT adds no typecheck error. Tests NOT run."
  fi
fi
exit "$findings"

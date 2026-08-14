#!/usr/bin/env bash
# cleancore-land.sh -- land ONE gate-complete branch on CleanCore main, with the checks that a
# clean merge does NOT give you (cards 7336c383 / 36d559e5, MikroB's green light msg 14141).
#
# WHY THIS IS A SCRIPT AND NOT A HABIT. 15 cards were queued behind an SSH outage, and doing the
# same six-step verification by hand fifteen times is how step four gets skipped on the twelfth.
# Every check here exists because it caught something real:
#
#  * GATED SHA, NOT THE BRANCH TIP. A branch can move after its verdicts; landing the tip would land
#    ungated code (dispatched-sha-may-lag-its-branch-tip). This refuses if they differ.
#  * MIGRATION NUMBER FREE ON THE *CURRENT* main, not on the main the branch forked from -- main
#    moved while the queue was blocked. A duplicate number means two different migrations answer to
#    one name. Refuses on a clash; MikroB's rule is to renumber on the branch first.
#  * SEAM CHECK. A conflict-free merge is not a correct merge: on card 36d559e5 both sides had
#    touched server.ts and wiring-manifest.ts, and "no conflict" says nothing about whether one
#    side's additions survived. Every line the branch ADDED must be present in the merge result.
#  * DETACHED landing worktree from origin/main -- never the main clone's working tree (nobody
#    commits there) and never the agent's own branch.
#
# Usage:  cleancore-land.sh <cardId> <gated-sha> [--dry-run]
# Exit: 0 landed (or dry-run clean) | 2 bad usage | 3 refused a precondition | 4 merge/push failed
set -uo pipefail

CARD="${1:-}"; SHA="${2:-}"; DRY="${3:-}"
[ -n "$CARD" ] && [ -n "$SHA" ] || { echo "usage: cleancore-land.sh <cardId> <gated-sha> [--dry-run]" >&2; exit 2; }

MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
WT="/home/neon/cc-land-$CARD"
say() { echo "  $*"; }
die() { echo "REFUSED: $2" >&2; exit "$1"; }

git -C "$MAIN" fetch origin --quiet || die 3 "could not fetch origin"
BASE="$(git -C "$MAIN" rev-parse --short origin/main)"
say "origin/main = $BASE"

[ "$(git -C "$MAIN" cat-file -t "$SHA" 2>/dev/null)" = "commit" ] || die 3 "$SHA is not a commit in $MAIN"

if git -C "$MAIN" merge-base --is-ancestor "$SHA" origin/main 2>/dev/null; then
  say "already on origin/main -- nothing to do"; exit 0
fi

# The gated sha must BE the branch tip. If the branch moved on, the extra commits were never gated.
BRANCH="$(git -C "$MAIN" branch -a --contains "$SHA" 2>/dev/null | sed 's/^[+* ]*//' \
          | grep -v '^remotes/origin/main$' | grep -v '^main$' | head -1)"
[ -n "$BRANCH" ] || die 3 "no branch contains $SHA"
TIP="$(git -C "$MAIN" rev-parse --short "$BRANCH" 2>/dev/null)"
GSHORT="$(git -C "$MAIN" rev-parse --short "$SHA")"
[ "$TIP" = "$GSHORT" ] || die 3 "branch $BRANCH tip is $TIP but the GATED sha is $GSHORT -- the extra commits are ungated"
say "branch $BRANCH, tip == gated sha ($GSHORT)"

# Migration numbers, against the CURRENT main.
MIGS="$(git -C "$MAIN" diff --name-only "origin/main...$SHA" | grep 'migrations/' || true)"
for m in $MIGS; do
  n="$(basename "$m" | cut -d_ -f1)"
  if git -C "$MAIN" ls-tree --name-only origin/main packages/control-plane/migrations/ | grep -q "/${n}_"; then
    die 3 "migration number $n is ALREADY TAKEN on origin/main -- renumber on the branch first"
  fi
  say "migration $(basename "$m") -- number $n free on main"
done
[ -n "$MIGS" ] || say "no migrations in this branch"

rm -rf "$WT"
git -C "$MAIN" worktree add --detach -q "$WT" origin/main || die 3 "could not create the landing worktree"
cleanup() { git -C "$MAIN" worktree remove --force "$WT" >/dev/null 2>&1; }
trap cleanup EXIT

MSG="merge: $BRANCH (card $CARD, gate-teljes @ $GSHORT)"
# Capture git's own diagnosis instead of discarding it: the first version sent both stdout and
# stderr to /dev/null and printed a bare "CONFLICTS:" with an EMPTY file list -- which is what a
# merge that failed for some OTHER reason looks like. The useful half was the part being thrown away.
if ! merge_err="$(git -C "$WT" -c user.email=backend@marveen.local -c user.name=backend \
                  merge --no-ff "$SHA" -m "$MSG" 2>&1)"; then
  conflicted="$(git -C "$WT" diff --name-only --diff-filter=U)"
  if [ -n "$conflicted" ]; then
    echo "CONFLICTS in:"; echo "$conflicted" | sed 's/^/    /'
  else
    echo "MERGE FAILED (not a content conflict) -- git says:"; echo "$merge_err" | sed 's/^/    /'
  fi
  git -C "$WT" merge --abort 2>/dev/null
  exit 4
fi
say "merged --no-ff, no conflicts ($(git -C "$WT" diff --name-only "$BASE..HEAD" | wc -l) files)"

# SEAM CHECK on the files BOTH sides touched: every line the branch added must be in the result.
MB="$(git -C "$MAIN" merge-base "$SHA" "$BASE")"
BRANCH_FILES="$(git -C "$MAIN" diff --name-only "$MB..$SHA")"
MAIN_FILES="$(git -C "$MAIN" diff --name-only "$MB..$BASE")"
OVERLAP="$(comm -12 <(echo "$BRANCH_FILES" | sort) <(echo "$MAIN_FILES" | sort))"
if [ -z "$OVERLAP" ]; then
  say "seam: no file was touched by both sides"
else
  missing=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$WT/$f" ] || { echo "  SEAM FAIL: $f is missing from the merge result"; missing=$((missing+1)); continue; }
    while IFS= read -r line; do
      case "$line" in (''|'+++'*) continue ;; esac
      body="${line#+}"
      [ -n "${body// }" ] || continue
      grep -qF -- "$body" "$WT/$f" || { echo "  SEAM FAIL in $f: dropped line: ${body:0:90}"; missing=$((missing+1)); }
    done < <(git -C "$MAIN" diff "$MB..$SHA" -- "$f" | grep '^+')
  done < <(echo "$OVERLAP")
  [ "$missing" -eq 0 ] || { echo "REFUSED: the merge dropped $missing line(s) from the branch"; exit 4; }
  say "seam: $(echo "$OVERLAP" | wc -l) shared file(s), every added line survived"
fi

if [ "$DRY" = "--dry-run" ]; then say "DRY-RUN: not pushing"; exit 0; fi

git -C "$WT" push origin HEAD:main >/dev/null 2>&1 || { echo "PUSH FAILED"; exit 4; }
git -C "$MAIN" fetch origin --quiet
if git -C "$MAIN" merge-base --is-ancestor "$SHA" origin/main; then
  MERGE="$(git -C "$WT" rev-parse --short HEAD)"
  echo "LANDED $CARD: $GSHORT -> origin/main (merge $MERGE)"
  exit 0
fi
echo "PUSH reported success but $GSHORT is NOT an ancestor of origin/main -- verify by hand"
exit 4

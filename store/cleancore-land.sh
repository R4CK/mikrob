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
#  * SEAM CHECK, BOTH DIRECTIONS. A conflict-free merge is not a correct merge: on card 36d559e5
#    both sides had touched server.ts and wiring-manifest.ts, and "no conflict" says nothing about
#    whether one side's additions survived. The first version of this check was ONE-DIRECTIONAL --
#    it only asked whether the BRANCH's added lines survived. That is how the batch merge silently
#    dropped main's own `stockLevels` wiring-manifest entry: nothing on the branch side was missing,
#    so the check passed while main lost content. Both sides are checked now.
#  * POST-MERGE TYPECHECK, AS A DELTA. "No line was lost" does not mean "it compiles" -- card
#    0a500b2e landed 2 TS4104 errors on main through a full gate round, because nobody ran tsc on
#    the merge result. A plain pass/fail is useless here, though: main itself can already be red,
#    and refusing on inherited errors would block every branch. So this compares the merge result
#    against the CURRENT main and refuses only on errors the merge ADDS.
#  * DETACHED landing worktree from origin/main -- never the main clone's working tree (nobody
#    commits there) and never the agent's own branch.
#
# Usage:  cleancore-land.sh <cardId> <gated-sha> [--dry-run] [--allow-main-loss] [--skip-typecheck]
#         cleancore-land.sh --selftest
# Exit: 0 landed (or dry-run clean) | 2 bad usage | 3 refused a precondition | 4 merge/push failed
set -uo pipefail

MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
TSC_TIMEOUT="${TSC_TIMEOUT:-900}"
CACHE_DIR="${CLEANCORE_LAND_CACHE:-$HOME/.cache/cleancore-land}"
say() { echo "  $*"; }
die() { echo "REFUSED: $2" >&2; exit "$1"; }

# Measurement helpers (link_node_modules / norm_errors / typecheck_errors / test_failures) live in
# ONE place, so a trap fixed here is not left standing in the pre-gate sentinel that shares them.
# shellcheck source=./cleancore-tsc-lib.sh
. "$(dirname "$0")/cleancore-tsc-lib.sh"

# --- WHO ran this landing (card 7fe98031) -------------------------------------------------------
#
# THE PROBLEM THIS SOLVES. Every merge this script makes is authored as `backend <backend@marveen
# .local>` -- a hardcoded identity on the commit line below, the same for whoever runs it. That is
# fine for normal operation (the card assignee and the Gate-SHA line already say who owns the work),
# but it actively MISLEADS a forensic question. It happened twice on 2026-08-21: MikroB asked "did
# you run this landing, or someone else?", and backend suspected a third actor after finding an
# unexpected working tree -- both investigations reached for the commit author, and the author would
# have pointed at `backend`, who had done neither. A field that answers the wrong question
# confidently is worse than an absent one.
#
# DERIVED, NOT DECLARED, on purpose: asking the caller to pass a name means the name is missing on
# exactly the runs nobody thought about. The branch being landed is checked out in its owner's
# worktree, and `git worktree list` maps branch -> path -> agent, so the answer is already in the
# repo. LANDED_BY overrides it for the cases the mapping cannot see (a landing driven from a
# throwaway tree, or a human).
#
# REQUIRES the path to sit under CLEANCORE_WORKTREES: the same clone also holds ~95 older per-card
# worktrees under /home/neon/cc-*, whose basenames ("cc-appdburl") are not agent names, plus
# `landing-*` scratch trees that are not agents either. Anything else answers `unknown` -- which is
# the honest answer, and is printed rather than omitted so a reader can tell "not detectable" apart
# from "this script is too old to record it".
AGENT_WORKTREE_ROOT="${CLEANCORE_WORKTREES:-/mnt/h/LM_Studio_Workdir/CleanCore-worktrees}"

landed_by_from_worktrees() {
  local branch="$1" list="$2" root="${3:-$AGENT_WORKTREE_ROOT}" path name
  path="$(printf '%s\n' "$list" | awk -v b="[$branch]" '$NF == b { $NF=""; $(NF)=""; print $1 }' | head -1)"
  case "$path" in
    "$root"/*) name="${path##*/}" ;;
    *) echo unknown; return ;;
  esac
  case "$name" in
    ''|landing-*|cc-land-*) echo unknown ;;
    *[!a-z0-9-]*) echo unknown ;;
    *) echo "$name" ;;
  esac
}

# Pick the real branch out of `git branch -a --contains` output.
#
# WHY THIS IS NOT JUST `head -1`. That listing puts the CURRENT checkout first, and $MAIN lives in
# detached HEAD permanently -- gates check it out to whatever sha they are reading. So whenever the
# main clone is parked ON the gated sha, which is the normal state while a gate is reviewing it, the
# first line is the pseudo-entry `* (HEAD detached at <sha>)`. It is not a branch, `rev-parse` on it
# yields nothing, and the script then refused with the nonsense message "tip is  but the GATED sha
# is <sha>" -- i.e. it rejected precisely the branches that were ready to land. Measured on card
# 1e819a83. A branch name can never begin with `(` (git refuses to create one), so dropping lines
# that do is exact, not a heuristic.
pick_branch() {
  sed 's/^[+*[:space:]]*//' \
    | grep -v '^(' \
    | grep -v '^remotes/origin/main$' \
    | grep -v '^main$' \
    | head -1
}

if [ "${1:-}" = "--selftest" ]; then
  fail=0; n=0
  t() { n=$((n+1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }
  t "strips line:col" \
    "$(printf 'src/a.ts(12,5): error TS2322: bad\n' | norm_errors)" \
    "src/a.ts: error TS2322: bad"
  t "same error at a shifted line collapses to one" \
    "$(printf 'src/a.ts(12,5): error TS1: x\nsrc/a.ts(99,5): error TS1: x\n' | norm_errors | wc -l)" \
    "1"
  t "keeps two different errors in one file" \
    "$(printf 'src/a.ts(1,1): error TS1: x\nsrc/a.ts(1,1): error TS2: y\n' | norm_errors | wc -l)" \
    "2"
  t "drops non-error chatter" \
    "$(printf 'Found 0 errors.\n> tsc --noEmit\n' | norm_errors | wc -l)" \
    "0"
  t "a new error is reported by the delta" \
    "$(comm -13 <(printf 'a: error TS1: x\n') <(printf 'a: error TS1: x\nb: error TS2: y\n'))" \
    "b: error TS2: y"
  t "an inherited error is NOT reported by the delta" \
    "$(comm -13 <(printf 'a: error TS1: x\n') <(printf 'a: error TS1: x\n') | wc -l)" \
    "0"
  t "a FIXED error does not read as new" \
    "$(comm -13 <(printf 'a: error TS1: x\nb: error TS2: y\n') <(printf 'a: error TS1: x\n') | wc -l)" \
    "0"
  # Landed-by derivation (card 7fe98031). The fixture is the real `git worktree list` shape.
  WL="$(printf '%s\n' \
    "/mnt/h/LM_Studio_Workdir/CleanCore                    2695a037 (detached HEAD)" \
    "/home/neon/cc-appdburl                                a0e76a65 [fix/app-database-url-required-2f2a99b6]" \
    "/mnt/h/LM_Studio_Workdir/CleanCore-worktrees/backend2 0dca79af [feat/platform-company-stepup-e0ef6202]" \
    "/mnt/h/LM_Studio_Workdir/CleanCore-worktrees/landing-batch5 41e380ea [landing/batch7b]")"
  R="/mnt/h/LM_Studio_Workdir/CleanCore-worktrees"
  t "names the agent whose worktree holds the branch" \
    "$(landed_by_from_worktrees 'feat/platform-company-stepup-e0ef6202' "$WL" "$R")" "backend2"
  t "an OLD per-card worktree outside the agent root is not an agent" \
    "$(landed_by_from_worktrees 'fix/app-database-url-required-2f2a99b6' "$WL" "$R")" "unknown"
  t "a landing scratch tree is not an agent" \
    "$(landed_by_from_worktrees 'landing/batch7b' "$WL" "$R")" "unknown"
  t "a branch checked out nowhere is unknown, not empty" \
    "$(landed_by_from_worktrees 'fix/not-checked-out' "$WL" "$R")" "unknown"
  t "a branch name that is a PREFIX of another does not match it" \
    "$(landed_by_from_worktrees 'landing/batch' "$WL" "$R")" "unknown"
  t "pick_branch skips the detached-HEAD pseudo-entry (card 1e819a83)" \
    "$(printf '* (HEAD detached at 1a36a6d7)\n+ agent/backend/work\n' | pick_branch)" \
    "agent/backend/work"
  t "pick_branch still ignores main and origin/main" \
    "$(printf '  main\n  remotes/origin/main\n+ agent/backend/work\n' | pick_branch)" \
    "agent/backend/work"
  t "pick_branch takes the checked-out branch when there IS one" \
    "$(printf '* agent/backend/work\n  main\n' | pick_branch)" \
    "agent/backend/work"
  t "pick_branch yields nothing when only main contains the sha" \
    "$(printf '* (HEAD detached at deadbeef)\n  main\n  remotes/origin/main\n' | pick_branch)" \
    ""
  echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi

CARD="${1:-}"; SHA="${2:-}"; shift 2 2>/dev/null
[ -n "$CARD" ] && [ -n "$SHA" ] || { echo "usage: cleancore-land.sh <cardId> <gated-sha> [--dry-run] [--allow-main-loss] [--skip-typecheck]" >&2; exit 2; }
DRY=""; ALLOW_MAIN_LOSS=0; SKIP_TSC=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY="--dry-run" ;;
    --allow-main-loss) ALLOW_MAIN_LOSS=1 ;;
    --skip-typecheck) SKIP_TSC=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
# $$ makes the path private to this process. QA2's finding on card 67beaf74 was against the pre-gate,
# but the defect is the shape, not the script: a deterministic worktree path means a second run's
# closing `git worktree remove --force` can pull the directory out from under this one's tsc/vitest
# mid-cycle, and the result is REAL-LOOKING errors (TS6053 File not found, whole-file test load
# failures) that the harness-fault detector cannot recognise, because the race lands half-way.
WT="/home/neon/cc-land-$CARD-$$"

git -C "$MAIN" fetch origin --quiet || die 3 "could not fetch origin"
BASE="$(git -C "$MAIN" rev-parse --short origin/main)"
say "origin/main = $BASE"

[ "$(git -C "$MAIN" cat-file -t "$SHA" 2>/dev/null)" = "commit" ] || die 3 "$SHA is not a commit in $MAIN"

if git -C "$MAIN" merge-base --is-ancestor "$SHA" origin/main 2>/dev/null; then
  say "already on origin/main -- nothing to do"; exit 0
fi

# The gated sha must BE the branch tip. If the branch moved on, the extra commits were never gated.
BRANCH="$(git -C "$MAIN" branch -a --contains "$SHA" 2>/dev/null | pick_branch)"
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

# Lockfile vs package.json, BEFORE the merge (card b8c1ff36). Two cards in one day declared a
# workspace dependency and did not regenerate pnpm-lock.yaml; both passed every gate and both blocked
# the deploy, because nothing in the gate path reads the lockfile -- tsc/vitest/linters all resolve
# through an already-installed node_modules, so the first clean install happens at deploy time.
#
# REFUSES ONLY ON A REAL MISMATCH (exit 1). A harness fault (exit 3: no pnpm on PATH, network, a
# store that cannot be read) does NOT refuse -- otherwise a broken toolchain quietly becomes a policy
# that blocks every landing, which is a worse failure than the one being prevented. It is also
# skipped outright when the branch touches no package.json, which is most of them.
# The status is captured on its OWN line, never as `if ! cmd; then rc=$?`. Inside that branch `$?`
# is the status of the `!` inversion (always 0), so the exit-1 refusal below would never have fired
# and this guard would have been decorative -- measured, not guessed, before it shipped.
LF_OUT="$("$(dirname "$0")/lockfile-sync-check.sh" --repo "$MAIN" --ref "$SHA" --base origin/main 2>&1)"
LF_RC=$?
if [ "$LF_RC" -eq 1 ]; then
  printf '%s\n' "$LF_OUT" >&2
  die 3 "pnpm-lock.yaml does not match this branch's package.json files -- regenerate the lockfile (pnpm install --lockfile-only) and re-gate; landing it would break the deploy"
elif [ "$LF_RC" -ne 0 ]; then
  say "lockfile check skipped (harness fault, not a verdict): $(printf '%s' "$LF_OUT" | head -1)"
else
  say "$(printf '%s' "$LF_OUT" | head -1)"
fi

rm -rf "$WT"
git -C "$MAIN" worktree add --detach -q "$WT" origin/main || die 3 "could not create the landing worktree"
cleanup() { git -C "$MAIN" worktree remove --force "$WT" >/dev/null 2>&1; }
trap cleanup EXIT

LANDED_BY="${LANDED_BY:-$(landed_by_from_worktrees "$BRANCH" "$(git -C "$MAIN" worktree list 2>/dev/null)")}"
say "landed-by: $LANDED_BY"
MSG="$(printf 'merge: %s (card %s, gate-teljes @ %s)\n\nLanded-by: %s\n' "$BRANCH" "$CARD" "$GSHORT" "$LANDED_BY")"
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

# SEAM CHECK on the files BOTH sides touched, in BOTH directions: every line either side ADDED
# since the merge base must be present in the result. Checking only the branch side is what let the
# batch merge drop main's own `stockLevels` manifest entry unnoticed.
MB="$(git -C "$MAIN" merge-base "$SHA" "$BASE")"
BRANCH_FILES="$(git -C "$MAIN" diff --name-only "$MB..$SHA")"
MAIN_FILES="$(git -C "$MAIN" diff --name-only "$MB..$BASE")"
OVERLAP="$(comm -12 <(echo "$BRANCH_FILES" | sort) <(echo "$MAIN_FILES" | sort))"

# $1 = side label, $2 = the sha whose additions must survive. Echoes the number of losses.
seam_side() {
  local label="$1" tip="$2" f line body lost=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$WT/$f" ] || { echo "  SEAM FAIL ($label): $f is missing from the merge result" >&2; lost=$((lost+1)); continue; }
    while IFS= read -r line; do
      case "$line" in (''|'+++'*) continue ;; esac
      body="${line#+}"
      [ -n "${body// }" ] || continue
      grep -qF -- "$body" "$WT/$f" || { echo "  SEAM FAIL ($label) in $f: dropped line: ${body:0:90}" >&2; lost=$((lost+1)); }
    done < <(git -C "$MAIN" diff "$MB..$tip" -- "$f" | grep '^+')
  done < <(echo "$OVERLAP")
  echo "$lost"
}

if [ -z "$OVERLAP" ]; then
  say "seam: no file was touched by both sides"
else
  lost_branch="$(seam_side branch "$SHA")"
  lost_main="$(seam_side main "$BASE")"
  [ "$lost_branch" -eq 0 ] || { echo "REFUSED: the merge dropped $lost_branch line(s) the BRANCH added"; exit 4; }
  # A branch may legitimately delete something main added -- card cb6b2c70 replaces the whole
  # `stockLevels` port on purpose. That is a real decision, not a merge artefact, so it is refused
  # by default and released only by --allow-main-loss, after a human has read each line above.
  if [ "$lost_main" -ne 0 ]; then
    if [ "$ALLOW_MAIN_LOSS" -eq 1 ]; then
      say "seam: $lost_main line(s) of MAIN's own content are gone -- accepted via --allow-main-loss"
    else
      echo "REFUSED: the merge dropped $lost_main line(s) MAIN added."
      echo "         If the branch removes them ON PURPOSE, re-run with --allow-main-loss."
      exit 4
    fi
  fi
  say "seam: $(echo "$OVERLAP" | wc -l) shared file(s) checked in both directions"
fi

# POST-MERGE TYPECHECK, as a delta against the current main. Absolute pass/fail is the wrong
# question: main can already be red from earlier work, and the branch is not answerable for that.
if [ "$SKIP_TSC" -eq 1 ]; then
  say "typecheck: SKIPPED (--skip-typecheck) -- the merge result was NOT compiled"
else
  mkdir -p "$CACHE_DIR"
  link_node_modules "$WT"
  # apps/web is minutes slow, so it runs only when the merge actually reaches it. Said out loud,
  # because a silently narrowed check reads like full coverage in a report.
  WANT_WEB=0
  git -C "$MAIN" diff --name-only "$MB..$SHA" | grep -q '^apps/web/' && WANT_WEB=1
  [ "$WANT_WEB" = 1 ] && say "typecheck: including apps/web (the branch touches it)" \
                      || say "typecheck: apps/web NOT checked (the branch does not touch it)"

  BASE_FULL="$(git -C "$MAIN" rev-parse origin/main)"
  BASE_ERR="$CACHE_DIR/base-$BASE_FULL-web$WANT_WEB.txt"
  if [ -f "$BASE_ERR" ]; then
    say "typecheck: baseline for main $BASE reused from cache ($(wc -l < "$BASE_ERR") error(s))"
  else
    # The riskier of the two here: this path is keyed on the BASE sha, and a landing queue is mostly
    # cards forked from the same base -- so two concurrent landings of DIFFERENT cards would have
    # collided on it, which is the common case rather than the rare one.
    BWT="/home/neon/cc-land-base-$BASE-$$"
    rm -rf "$BWT"
    git -C "$MAIN" worktree add --detach -q "$BWT" origin/main || die 3 "could not create the baseline worktree"
    link_node_modules "$BWT"
    typecheck_errors "$BWT" "$WANT_WEB" > "$BASE_ERR"
    git -C "$MAIN" worktree remove --force "$BWT" >/dev/null 2>&1
    say "typecheck: baseline main $BASE has $(wc -l < "$BASE_ERR") error(s)"
  fi

  MERGE_ERR="$(mktemp)"
  typecheck_errors "$WT" "$WANT_WEB" > "$MERGE_ERR"
  if grep -q '^HARNESS-FAULT' "$MERGE_ERR" || grep -q '^HARNESS-FAULT' "$BASE_ERR"; then
    echo "REFUSED: the typecheck harness itself failed -- this is NOT a clean result:"
    grep -h '^HARNESS-FAULT' "$BASE_ERR" "$MERGE_ERR" | sed 's/^/    /'
    exit 4
  fi
  NEW="$(comm -13 "$BASE_ERR" "$MERGE_ERR")"
  if [ -n "$NEW" ]; then
    echo "REFUSED: the merge result adds $(echo "$NEW" | wc -l) typecheck error(s) main does not have:"
    echo "$NEW" | sed 's/^/    /'
    rm -f "$MERGE_ERR"; exit 4
  fi
  say "typecheck: no new error vs main ($(wc -l < "$MERGE_ERR") inherited)"
fi

if [ "$DRY" = "--dry-run" ]; then say "DRY-RUN: not pushing"; rm -f "${MERGE_ERR:-}" 2>/dev/null; exit 0; fi

if ! git -C "$WT" push origin HEAD:main >/dev/null 2>&1; then
  # A nonzero exit here does not always mean the remote rejected the push -- a dropped
  # connection after the remote already accepted it looks identical locally. Verify
  # against the remote before declaring failure, so a landed push is never reported as
  # PUSH FAILED (which would prompt a needless, racy retry against a shared branch).
  git -C "$MAIN" fetch origin --quiet
  if ! git -C "$MAIN" merge-base --is-ancestor "$SHA" origin/main; then
    echo "PUSH FAILED"; exit 4
  fi
  say "push exited nonzero but $GSHORT is already an ancestor of origin/main -- it landed, continuing"
fi
git -C "$MAIN" fetch origin --quiet
if git -C "$MAIN" merge-base --is-ancestor "$SHA" origin/main; then
  MERGE="$(git -C "$WT" rev-parse --short HEAD)"
  # What we just compiled IS the new main, so it is the next landing's baseline -- carried over so a
  # queue of landings pays for one baseline typecheck, not one per card. Keyed by the new sha, so a
  # main that moves underneath us (someone else pushing) simply misses the cache and re-measures.
  if [ "$SKIP_TSC" -eq 0 ] && [ -f "${MERGE_ERR:-/nonexistent}" ]; then
    cp "$MERGE_ERR" "$CACHE_DIR/base-$(git -C "$MAIN" rev-parse origin/main)-web$WANT_WEB.txt" 2>/dev/null
  fi
  rm -f "${MERGE_ERR:-}" 2>/dev/null
  echo "LANDED $CARD: $GSHORT -> origin/main (merge $MERGE)"
  exit 0
fi
echo "PUSH reported success but $GSHORT is NOT an ancestor of origin/main -- verify by hand"
exit 4

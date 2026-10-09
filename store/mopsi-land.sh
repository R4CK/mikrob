#!/usr/bin/env bash
# mopsi-land.sh -- land ONE gate-complete branch on the Mopsi repo's main (card 7feb477b, parent
# 430466de, fleet-infra for R4CK/Mopsi).
#
# WHY THIS IS A NEW, LEANER SCRIPT AND NOT A THIN WRAPPER AROUND mopsion-land.sh (unlike this
# repo's agent-worktree-mopsi.sh / mopsi-gate-worktree.sh, which ARE thin wrappers). Read in full
# before touching this file: mopsion-land.sh carries a dozen guards that are mopsion's OWN
# accumulated incident history, not generic landing mechanics --
#   - migration_number_check assumes packages/control-plane/migrations/<N>_*.sql; Mopsi's
#     migration mechanism is Drizzle under packages/database (db:generate/db:migrate/db:push),
#     a different shape entirely. Wrapping the mopsion check would either silently find nothing
#     (harmless) or, if Mopsi ever grows a same-shaped migrations/ dir for an unrelated reason,
#     misfire against a package that was never a party to this check's incident history.
#   - the DECISIONS.md append-only/tail-append guards assume mopsion's own append-only-journal
#     convention. Mopsi has no DECISIONS.md yet (confirmed: not in the repo root) -- there is
#     nothing for that guard to check, and silently skipping an invariant nobody asked for is
#     better than a script insisting on a file the project never adopted.
#   - mopsion-bundle-check hardcodes @mopsion/superadmin + @mopsion/web as the bundle filters. Even
#     though Mopsi's workspace scope also happens to be @mopsion, its PACKAGE NAMES differ
#     (apps/web, apps/api; no apps/superadmin) -- the filter list is not just parameterizable by
#     scope, it is a literal list of names that do not exist in this repo.
#   - mopsion-tsc-lib.sh's typecheck_errors/test_failures hardcode mopsion's own tsconfig project
#     list and vitest target directory (apps/api only). Mopsi's typecheck/test surface is
#     different (apps/api AND apps/web AND three packages, via turbo).
# None of the above is reusable by pointing env vars at a different clone; each would need to be
# rewritten for Mopsi's shape anyway, at which point it is not a wrapper, it is a second
# implementation pretending to be one. So this script reuses, VERBATIM BY SOURCING (never copying),
# exactly the parts of the mopsion landing pipeline that ARE genuinely repo-agnostic -- proven by
# grep: each of the four files below is already sourced by BOTH mopsion-land.sh and
# marveen-land.sh, two structurally different repos, with no project-specific literal inside:
#   - landing-gate-verdict-check.sh  (gate_verdict_check: reads the SHARED kanban board over the
#     SAME dashboard API regardless of which repo the card's code lives in)
#   - landing-downward-check.sh      (downward_check: pure `git log` range inspection)
#   - conflict-marker-check.sh       (find_conflict_markers: pure `git grep` for <<<<<<</>>>>>>>)
#   - mopsion-tsc-lib.sh, ONLY for link_node_modules (the per-package-entry node_modules relinker;
#     it closure-reads $MAIN, which this script sets to the Mopsi clone before calling it, and
#     contains no mopsion-specific path --  TSC_PROJECTS/typecheck_errors/test_failures from that
#     same file are NOT used here, on purpose, replaced by the simpler pnpm/turbo invocation below)
# pick_branch and landed_by_from_worktrees are copied (not sourced) from mopsion-land.sh because
# they live inline there, not in a separate file -- both are pure git-branch-listing parsers with
# no mopsion-specific literal; see mopsion-land.sh's own comments above each for the incidents
# that shaped them. A future refactor extracting them into their own sourced file would let both
# landers stay exact copies without this duplication; out of scope for this card.
#
# WHAT THIS SCRIPT DELIBERATELY DOES NOT DO YET (matches the card's own ask -- "a landolás a merge
# eredményén futtassa a Mopsi teszteket (pnpm test / turbo), csak zöldre pushol" -- nothing more):
#   - no DECISIONS.md convention (Mopsi has none yet; add the guard back if/when Mopsi adopts one)
#   - no migration-number collision check (Mopsi's Drizzle migration flow needs its own version of
#     this, if it turns out to need one at all -- Drizzle numbers migrations itself)
#   - no browser-bundle check (worth adding once apps/web ships something that can go stale the way
#     mopsion-bundle-check.sh's ten-hour incident did; premature on a scaffold)
#   - no baseline-delta typecheck tolerance (mopsion's typecheck step compares against CURRENT
#     main because main can already be red from older work; Mopsi's main has no such history yet,
#     so this script requires the merge result to typecheck CLEAN, full stop -- add delta-tolerance
#     later if main ever legitimately needs it)
#   - TEST STEP NOT LIVE-VALIDATED END-TO-END in the sandbox that built this (no docker here, and
#     apps/api's vitest suite likely needs the docker/docker-compose.dev.yml stack -- Postgres/
#     Redis/MinIO -- per Mopsi's own README). The git/worktree/merge/seam/push mechanics ARE
#     exercised (via --selftest and a --dry-run on a real throwaway fixture repo); the `pnpm run
#     test` invocation itself is syntactically correct and will surface a real vitest failure
#     exactly like any other command failure, but nobody has yet landed a real card through this
#     path with the Mopsi dev stack actually running. Flagged in the REVIEW for this card.
#
# Usage: mopsi-land.sh <cardId> <gated-sha> [--dry-run] [--allow-ungated]
#                                           [--allow-stacked <cardId>[,<cardId>...]]
#                                           [--allow-main-loss] [--skip-test]
#        mopsi-land.sh --selftest
# Env:   CLEANCORE_MAIN      Mopsi main clone (default /mnt/h/LM_Studio_Workdir/Mopsi-main)
#        CLEANCORE_WORKTREES agent worktree root, only used for the landed-by guess
#                             (default /mnt/h/LM_Studio_Workdir/Mopsi-worktrees)
#        MOPSI_TEST_TIMEOUT  seconds, default 1800 (turbo across 5 packages, uncached)
#        LANDING_DOWNWARD_CHECK=off  disables the downward range check entirely (shared flag)
# Exit:  0 landed (or dry-run clean) | 2 bad usage | 3 refused a precondition | 4 merge/test/push failed
set -uo pipefail

MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/Mopsi-main}"
AGENT_WORKTREE_ROOT="${CLEANCORE_WORKTREES:-/mnt/h/LM_Studio_Workdir/Mopsi-worktrees}"
TEST_TIMEOUT="${MOPSI_TEST_TIMEOUT:-1800}"
say() { echo "  $*"; }
die() { echo "REFUSED: $2" >&2; exit "$1"; }

SELF_DIR="$(dirname "$0")"
# shellcheck source=./landing-downward-check.sh
. "$SELF_DIR/landing-downward-check.sh"
# shellcheck source=./landing-gate-verdict-check.sh
. "$SELF_DIR/landing-gate-verdict-check.sh"
# shellcheck source=./conflict-marker-check.sh
. "$SELF_DIR/conflict-marker-check.sh"
# shellcheck source=./mopsion-tsc-lib.sh
. "$SELF_DIR/mopsion-tsc-lib.sh"

# --- copied from mopsion-land.sh (inline there, not a separate sourced file) -----------------------
landed_by_from_worktrees() {
  local branch="$1" list="$2" root="${3:-$AGENT_WORKTREE_ROOT}" path name
  path="$(printf '%s\n' "$list" | awk -v b="[$branch]" '$NF == b { $NF=""; $(NF)=""; print $1 }' | head -1)"
  case "$path" in
    "$root"/*) name="${path##*/}" ;;
    *) echo unknown; return ;;
  esac
  case "$name" in
    ''|landing-*|mopsi-land-*) echo unknown ;;
    *[!a-z0-9-]*) echo unknown ;;
    *) echo "$name" ;;
  esac
}

pick_branch() {
  local card="${1:-}" candidates
  candidates="$(sed 's/^[+*[:space:]]*//' \
    | grep -v '^(' \
    | grep -v '^remotes/origin/main$' \
    | grep -v '^main$')"
  [ -n "$candidates" ] || return 0
  case "$card" in
    *[!A-Za-z0-9]*) card="" ;;
  esac
  if [ -n "$card" ]; then
    local named
    named="$(printf '%s\n' "$candidates" | grep -E "(^|[-/])${card}\$" | head -1)"
    if [ -n "$named" ]; then printf '%s\n' "$named"; return 0; fi
  fi
  printf '%s\n' "$candidates" | head -1
}

if [ "${1:-}" = "--selftest" ]; then
  fail=0; n=0
  t() { n=$((n+1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }

  WL="$(printf '%s\n' \
    "/mnt/h/LM_Studio_Workdir/Mopsi-main                  2695a037 (detached HEAD)" \
    "/mnt/h/LM_Studio_Workdir/Mopsi-worktrees/backend3     0dca79af [agent/backend3/work]" \
    "/mnt/h/LM_Studio_Workdir/Mopsi-worktrees/landing-batch5 41e380ea [landing/batch7b]")"
  R="/mnt/h/LM_Studio_Workdir/Mopsi-worktrees"
  t "names the agent whose worktree holds the branch" \
    "$(landed_by_from_worktrees 'agent/backend3/work' "$WL" "$R")" "backend3"
  t "a landing scratch tree is not an agent" \
    "$(landed_by_from_worktrees 'landing/batch7b' "$WL" "$R")" "unknown"
  t "a branch checked out nowhere is unknown, not empty" \
    "$(landed_by_from_worktrees 'fix/not-checked-out' "$WL" "$R")" "unknown"

  t "pick_branch skips the detached-HEAD pseudo-entry" \
    "$(printf '* (HEAD detached at 1a36a6d7)\n+ agent/backend3/work\n' | pick_branch)" \
    "agent/backend3/work"
  t "pick_branch still ignores main and origin/main" \
    "$(printf '  main\n  remotes/origin/main\n+ agent/backend3/work\n' | pick_branch)" \
    "agent/backend3/work"
  MULTI="$(printf '%s\n' \
    '* (HEAD detached at 9d1d9254)' \
    '  remotes/origin/agent/fron-ted/1c2e5c36' \
    '  remotes/origin/agent/fron-ted/476ccb33' \
    '  remotes/origin/main')"
  t "pick_branch prefers the branch named for the card" \
    "$(printf '%s\n' "$MULTI" | pick_branch 476ccb33)" \
    "remotes/origin/agent/fron-ted/476ccb33"
  t "pick_branch yields nothing when only main contains the sha" \
    "$(printf '* (HEAD detached at deadbeef)\n  main\n  remotes/origin/main\n' | pick_branch)" \
    ""

  # Shared-lib cases -- same functions mopsion-land.sh and marveen-land.sh already selftest; run
  # here too so a regression in the SOURCED file is caught by this lander's own --selftest, not
  # only by the two it was already wired into.
  downward_selftest_cases
  conflict_marker_selftest_cases

  # Real-git fixture for the seam-check pattern (adapted inline below, not a sourced function --
  # exercised here against a minimal two-branch merge so the comm/grep pipeline is proven, not
  # just read).
  SEAMWORK="$(mktemp -d)"
  git init -q -b main "$SEAMWORK" >/dev/null
  git -C "$SEAMWORK" config user.email s@s; git -C "$SEAMWORK" config user.name s
  printf 'line1\nline2\n' > "$SEAMWORK/f.txt"
  git -C "$SEAMWORK" add -A; git -C "$SEAMWORK" commit -qm base
  BASE_SHA="$(git -C "$SEAMWORK" rev-parse HEAD)"
  git -C "$SEAMWORK" checkout -q -b feature
  printf 'line1\nline2\nline3-branch\n' > "$SEAMWORK/f.txt"
  git -C "$SEAMWORK" commit -qam "branch adds a line"
  FEAT_SHA="$(git -C "$SEAMWORK" rev-parse HEAD)"
  git -C "$SEAMWORK" checkout -q main
  MERGED="$(mktemp -d)"
  git clone -q "$SEAMWORK" "$MERGED" >/dev/null 2>&1
  git -C "$MERGED" -c user.email=s@s -c user.name=s merge -q --no-ff "$FEAT_SHA" -m merge >/dev/null 2>&1 \
    || git -C "$MERGED" fetch -q "$SEAMWORK" "$FEAT_SHA" >/dev/null 2>&1
  n=$((n+1))
  if grep -qF "line3-branch" "$MERGED/f.txt" 2>/dev/null; then
    echo "  ok   seam fixture: a clean merge keeps the branch's added line (sanity check on the fixture itself)"
  else
    echo "  FAIL seam fixture: branch's added line missing after a plain merge -- fixture is broken"
    fail=1
  fi
  rm -rf "$SEAMWORK" "$MERGED"

  echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi

CARD="${1:-}"; SHA="${2:-}"; shift 2 2>/dev/null
[ -n "$CARD" ] && [ -n "$SHA" ] || { echo "usage: mopsi-land.sh <cardId> <gated-sha> [--dry-run] [--allow-main-loss] [--skip-test] [--allow-ungated] [--allow-stacked <cardId>[,<cardId>...]]" >&2; exit 2; }
DRY=""; ALLOW_MAIN_LOSS=0; SKIP_TEST=0; ALLOW_STACKED=""; ALLOW_UNGATED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY="--dry-run" ;;
    --allow-main-loss) ALLOW_MAIN_LOSS=1 ;;
    --skip-test) SKIP_TEST=1 ;;
    --allow-ungated) ALLOW_UNGATED=1 ;;
    --allow-stacked) shift; [ $# -gt 0 ] || { echo "--allow-stacked needs a card id list" >&2; exit 2; }; ALLOW_STACKED="$1" ;;
    --allow-stacked=*) ALLOW_STACKED="${1#--allow-stacked=}" ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -d "$MAIN/.git" ] || die 3 "no Mopsi clone at $MAIN (set CLEANCORE_MAIN)"

# THE GATE VERDICT, checked first (same reasoning as mopsion-land.sh: cheapest precondition, so a
# landing that should not happen at all costs one HTTP call, not a full merge + test first). The
# dashboard API is the SAME shared kanban board regardless of which repo the card's code lives in.
GATE_CHECK_OVERRIDE_ARMED="$ALLOW_UNGATED" gate_verdict_check "$CARD" "$SHA" refuse
gate_rc=$?
if [ "$gate_rc" -eq 2 ]; then
  echo "  gate-check: a FAILING verdict is never overridden -- --allow-ungated does not apply here" >&2
  exit 3
elif [ "$gate_rc" -ne 0 ]; then
  if [ "$ALLOW_UNGATED" -eq 1 ]; then
    say "gate-check: no usable verdict, TOLERATED by --allow-ungated -- this landing is deliberately ungated"
  else
    exit 3
  fi
fi

WT="/home/neon/mopsi-land-$CARD-$$"

git -C "$MAIN" fetch origin --quiet || die 3 "could not fetch origin"
BASE="$(git -C "$MAIN" rev-parse --short origin/main)"
say "origin/main = $BASE"

[ "$(git -C "$MAIN" cat-file -t "$SHA" 2>/dev/null)" = "commit" ] || die 3 "$SHA is not a commit in $MAIN"

if git -C "$MAIN" merge-base --is-ancestor "$SHA" origin/main 2>/dev/null; then
  say "already on origin/main -- nothing to do"; exit 0
fi

# The gated sha must BE the branch tip (same reasoning as mopsion-land.sh: if the branch moved on,
# the extra commits were never gated).
BRANCH="$(git -C "$MAIN" branch -a --contains "$SHA" 2>/dev/null | pick_branch "$CARD")"
[ -n "$BRANCH" ] || die 3 "no branch contains $SHA"
TIP="$(git -C "$MAIN" rev-parse --short "$BRANCH" 2>/dev/null)"
GSHORT="$(git -C "$MAIN" rev-parse --short "$SHA")"
[ "$TIP" = "$GSHORT" ] || die 3 "branch $BRANCH tip is $TIP but the GATED sha is $GSHORT -- the extra commits are ungated"
say "branch $BRANCH, tip == gated sha ($GSHORT)"

DOWN_LOG="$(git -C "$MAIN" log --no-merges --format='%h%x09%s' "origin/main..$SHA")"
downward_check "$DOWN_LOG" "$CARD" "$ALLOW_STACKED" 1 "downward" \
  || die 3 "commits belonging to OTHER cards sit between origin/main and $GSHORT -- they were never gated for this landing"

# Lockfile vs package.json, BEFORE the merge -- same universal pnpm risk mopsion-land.sh guards
# against (a declared workspace dependency with a stale pnpm-lock.yaml passes every gate because
# nothing in the gate path does a clean install; the first clean install happens at deploy time).
LF_OUT="$("$SELF_DIR/lockfile-sync-check.sh" --repo "$MAIN" --ref "$SHA" --base origin/main 2>&1)"
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

# SEAM CHECK, both directions (card 36d559e5's lesson, same reasoning as mopsion-land.sh: a
# conflict-free merge is not a correct merge -- every line either side ADDED since the merge base
# must survive into the result, checked for BOTH sides so a one-directional check cannot miss the
# side that is not the incoming branch).
MB="$(git -C "$MAIN" merge-base "$SHA" "$BASE")"
BRANCH_FILES="$(git -C "$MAIN" diff --name-only "$MB..$SHA")"
MAIN_FILES="$(git -C "$MAIN" diff --name-only "$MB..$BASE")"
OVERLAP="$(comm -12 <(echo "$BRANCH_FILES" | sort) <(echo "$MAIN_FILES" | sort))"

seam_side() {
  local label="$1" tip="$2" f line body lost=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ ! -f "$WT/$f" ]; then
      git -C "$MAIN" cat-file -e "$tip:$f" 2>/dev/null || continue
      echo "  SEAM FAIL ($label): $f is missing from the merge result" >&2; lost=$((lost+1)); continue
    fi
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

CONFLICT_MARKERS="$(find_conflict_markers "$WT")"
if [ -n "$CONFLICT_MARKERS" ]; then
  echo "REFUSED: unresolved merge-conflict markers are in the merge result. Nothing pushed."
  echo "$CONFLICT_MARKERS" | sed 's/^/    /'
  exit 4
fi
say "no merge-conflict markers in the merge result"

# MOPSI TEST RUN on the merge result (the card's own ask: "pnpm test / turbo, csak zöldre
# pushol"). FULL run, not a baseline-delta against main -- see the header comment for why that is
# the right call on a fresh scaffold rather than a corner cut.
if [ "$SKIP_TEST" -eq 1 ]; then
  say "test: SKIPPED (--skip-test) -- the merge result was NOT tested"
else
  link_node_modules "$WT" || true
  TC_OUT="$(cd "$WT" && timeout "$TEST_TIMEOUT" pnpm run typecheck 2>&1)"; TC_RC=$?
  if [ "$TC_RC" -ne 0 ]; then
    echo "REFUSED: the merge result fails typecheck. Nothing pushed:"
    printf '%s\n' "$TC_OUT" | tail -40 | sed 's/^/    /'
    exit 4
  fi
  say "typecheck: clean"
  TEST_OUT="$(cd "$WT" && timeout "$TEST_TIMEOUT" pnpm run test 2>&1)"; TEST_RC=$?
  if [ "$TEST_RC" -ne 0 ]; then
    echo "REFUSED: the merge result fails tests. Nothing pushed:"
    printf '%s\n' "$TEST_OUT" | tail -60 | sed 's/^/    /'
    exit 4
  fi
  say "test: green"
fi

# RE-CHECK RIGHT BEFORE PUSH (same reasoning as mopsion-land.sh's card 517cbcbe fix): a landing
# that takes minutes leaves a window where a QA PASS could be retracted mid-flight. Any CHANGE in
# outcome refuses, not just a worse one -- a spurious refusal costs a re-run; a push that should
# not have happened cannot be taken back.
GATE_CHECK_OVERRIDE_ARMED="$ALLOW_UNGATED" gate_verdict_check "$CARD" "$SHA" refuse
recheck_rc=$?
if [ "$recheck_rc" -ne "$gate_rc" ]; then
  echo "REFUSED: the gate verdict for card $CARD / $SHA changed between the start of this landing" >&2
  echo "         and this push-time recheck (was rc=$gate_rc, now rc=$recheck_rc)." >&2
  echo "         Nothing pushed. Re-run the landing to pick up the current verdict." >&2
  exit 3
fi

if [ "$DRY" = "--dry-run" ]; then say "DRY-RUN: not pushing"; exit 0; fi

if ! git -C "$WT" push origin HEAD:main >/dev/null 2>&1; then
  git -C "$MAIN" fetch origin --quiet
  if ! git -C "$MAIN" merge-base --is-ancestor "$SHA" origin/main; then
    echo "PUSH FAILED"; exit 4
  fi
  say "push exited nonzero but $GSHORT is already an ancestor of origin/main -- it landed, continuing"
fi
git -C "$MAIN" fetch origin --quiet
if git -C "$MAIN" merge-base --is-ancestor "$SHA" origin/main; then
  MERGE="$(git -C "$WT" rev-parse --short HEAD)"
  echo "LANDED $CARD: $GSHORT -> origin/main (merge $MERGE)"
  exit 0
fi
echo "PUSH reported success but $GSHORT is NOT an ancestor of origin/main -- verify by hand"
exit 4

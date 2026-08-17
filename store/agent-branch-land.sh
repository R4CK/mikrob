#!/usr/bin/env bash
# agent-branch-land.sh -- MikroB-controlled periodic merge step for the marveen agent/*/work
# branches (card dc185b52, MikroB plan-grilling komment 14270). Sibling of store/cleancore-land.sh,
# deliberately lighter: no per-migration/typecheck-delta machinery (marveen is not that shape of
# repo) -- the gate is a real store/fleet-test.sh run against the merge RESULT, not the branch alone,
# so a branch that is individually green but breaks something on top of another agent's already-
# landed work is still caught before it reaches origin/develop.
#
# WHY A SCRIPT, NOT "just git merge by hand": every check here exists because doing it by hand
# eventually skips a step -- see cleancore-land.sh's own header for the class of bug that produced
# (ungated tip, silently dropped lines from a merge that reports "no conflicts", a merge that
# compiles-broken because nobody re-ran the suite on the RESULT).
#
# Usage:
#   agent-branch-land.sh <agent> [--dry-run]   # land one agent's branch
#   agent-branch-land.sh --all [--dry-run]     # land every agent/*/work branch with unmerged work,
#                                               # sequentially (never concurrent -- shared repo)
#   agent-branch-land.sh --selftest
#
# Env overrides (tests only):
#   AGENT_BRANCH_REPO         default /home/neon/marveen
#   AGENT_BRANCH_LAND_TEST    default "$REPO/store/fleet-test.sh --ref" -- the verification command;
#                             the merge sha is appended as the final argument. fleet-test.sh's own
#                             ROOT is hardcoded to the real marveen checkout, so an automated test of
#                             THIS script against a throwaway repo must override this to a stub.
#
# Exit: 0 landed (or dry-run clean, or nothing to land) | 2 bad usage | 3 refused a precondition
#       | 4 merge/verify/push failed
set -uo pipefail

REPO="${AGENT_BRANCH_REPO:-/home/neon/marveen}"
say() { echo "  $*"; }
die() { echo "REFUSED: $2" >&2; exit "$1"; }
g() { git -C "$REPO" "$@"; }

if [ "${1:-}" = "--selftest" ]; then
  fail=0; n=0
  t() { n=$((n+1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }
  # Pure logic only (branch-name parsing) -- the git/merge/push path is covered by the vitest
  # integration test against a throwaway repo, not here.
  agent_of() { case "$1" in agent/*/work) b="${1#agent/}"; echo "${b%/work}" ;; *) echo "" ;; esac; }
  t "extracts agent name from a work branch" "$(agent_of 'agent/backend/work')" "backend"
  t "rejects a non-agent branch" "$(agent_of 'develop')" ""
  t "rejects an agent branch with the wrong suffix" "$(agent_of 'agent/backend/scratch')" ""
  echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi

[ -d "$REPO/.git" ] || die 3 "$REPO is not a git repository"
DEFAULT_BRANCH="$(g symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
[ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="develop"
TEST_CMD="${AGENT_BRANCH_LAND_TEST:-$REPO/store/fleet-test.sh --ref}"

land_one() {
  local agent="$1" dry="$2"
  local branch="agent/${agent}/work"

  g show-ref --verify --quiet "refs/heads/$branch" || { say "$agent: no branch $branch -- nothing to land"; return 0; }

  g fetch -q origin "$DEFAULT_BRANCH" || die 3 "could not fetch origin/$DEFAULT_BRANCH"
  local base_sha; base_sha="$(g rev-parse "origin/$DEFAULT_BRANCH")"

  if g merge-base --is-ancestor "$branch" "origin/$DEFAULT_BRANCH" 2>/dev/null; then
    say "$agent: $branch already fully landed on origin/$DEFAULT_BRANCH -- nothing to do"
    return 0
  fi

  local wt="/home/neon/agent-branch-land-${agent}-$$"
  rm -rf "$wt"
  g worktree add --detach -q "$wt" "origin/$DEFAULT_BRANCH" || die 3 "could not create the landing worktree for $agent"
  cleanup() { g worktree remove --force "$wt" >/dev/null 2>&1; }
  trap cleanup RETURN

  local msg="merge: $branch into $DEFAULT_BRANCH (agent-branch-land, base @ $(git -C "$wt" rev-parse --short HEAD))"
  local merge_err
  if ! merge_err="$(git -C "$wt" -c user.email=mikrob@marveen.local -c user.name=mikrob \
                    merge --no-ff "$branch" -m "$msg" 2>&1)"; then
    local conflicted; conflicted="$(git -C "$wt" diff --name-only --diff-filter=U)"
    if [ -n "$conflicted" ]; then
      echo "$agent: CONFLICTS in:"; echo "$conflicted" | sed 's/^/    /'
    else
      echo "$agent: MERGE FAILED (not a content conflict) -- git says:"; echo "$merge_err" | sed 's/^/    /'
    fi
    git -C "$wt" merge --abort 2>/dev/null
    return 4
  fi
  local merge_sha; merge_sha="$(git -C "$wt" rev-parse HEAD)"
  say "$agent: merged --no-ff, no conflicts ($(git -C "$wt" diff --name-only "$base_sha..HEAD" | wc -l) file(s) changed since $DEFAULT_BRANCH base)"

  # SEAM CHECK, both directions (same reasoning as cleancore-land.sh): "no conflict" only means git
  # found no OVERLAPPING hunks, not that both sides' additions to a shared file both survived.
  local mb; mb="$(g merge-base "$branch" "$base_sha")"
  local branch_files main_files overlap
  branch_files="$(g diff --name-only "$mb..$branch")"
  main_files="$(g diff --name-only "$mb..$base_sha")"
  overlap="$(comm -12 <(echo "$branch_files" | sort) <(echo "$main_files" | sort))"
  if [ -n "$overlap" ]; then
    local lost=0 f line body
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      [ -f "$wt/$f" ] || { echo "$agent: SEAM FAIL: $f is missing from the merge result"; lost=$((lost+1)); continue; }
      while IFS= read -r line; do
        case "$line" in (''|'+++'*) continue ;; esac
        body="${line#+}"
        [ -n "${body// }" ] || continue
        grep -qF -- "$body" "$wt/$f" || { echo "$agent: SEAM FAIL in $f: dropped line: ${body:0:90}"; lost=$((lost+1)); }
      done < <(g diff "$mb..$branch" -- "$f" | grep '^+')
      while IFS= read -r line; do
        case "$line" in (''|'+++'*) continue ;; esac
        body="${line#+}"
        [ -n "${body// }" ] || continue
        grep -qF -- "$body" "$wt/$f" || { echo "$agent: SEAM FAIL in $f: $DEFAULT_BRANCH's own line dropped: ${body:0:90}"; lost=$((lost+1)); }
      done < <(g diff "$mb..$base_sha" -- "$f" | grep '^+')
    done < <(echo "$overlap")
    [ "$lost" -eq 0 ] || { echo "$agent: REFUSED, $lost seam loss(es)"; git -C "$wt" reset -q --hard "$base_sha"; return 4; }
    say "$agent: seam: $(echo "$overlap" | wc -l) shared file(s) checked in both directions, clean"
  else
    say "$agent: seam: no file touched by both sides"
  fi

  # shellcheck disable=SC2086 -- TEST_CMD is an intentional word-split command prefix (script + flags)
  if ! (cd "$wt" && eval "$TEST_CMD $merge_sha"); then
    echo "$agent: REFUSED -- fleet-test failed on the merge result. Nothing pushed; $branch is untouched."
    return 4
  fi
  say "$agent: fleet-test green on the merge result"

  if [ "$dry" = "1" ]; then say "$agent: DRY-RUN -- not pushing"; return 0; fi

  git -C "$wt" push origin "HEAD:$DEFAULT_BRANCH" >/dev/null 2>&1 || { echo "$agent: PUSH FAILED"; return 4; }
  g fetch -q origin "$DEFAULT_BRANCH"
  if g merge-base --is-ancestor "$merge_sha" "origin/$DEFAULT_BRANCH"; then
    # $branch itself is left untouched here on purpose: it is now an ancestor of origin/$DEFAULT_BRANCH,
    # so the agent's own next agent-branch.sh call fast-forwards it there automatically (its ff-only
    # sync step). No separate reset step needed, and none is attempted against a branch that might be
    # the CURRENTLY CHECKED-OUT one in this shared working tree.
    echo "$agent: LANDED $branch -> origin/$DEFAULT_BRANCH ($(git -C "$wt" rev-parse --short HEAD))"
    return 0
  fi
  echo "$agent: PUSH reported success but $merge_sha is NOT an ancestor of origin/$DEFAULT_BRANCH -- verify by hand"
  return 4
}

DRY=0
case "${2:-}" in --dry-run) DRY=1 ;; esac

case "${1:-}" in
  --all)
    overall=0
    while IFS= read -r b; do
      [ -n "$b" ] || continue
      agent="${b#agent/}"; agent="${agent%/work}"
      land_one "$agent" "$DRY" || overall=1
    done < <(g for-each-ref --format='%(refname:short)' 'refs/heads/agent/*/work')
    exit $overall
    ;;
  '') die 2 "usage: agent-branch-land.sh <agent> [--dry-run] | agent-branch-land.sh --all [--dry-run]" ;;
  *)
    land_one "$1" "$DRY"
    exit $?
    ;;
esac

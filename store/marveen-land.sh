#!/usr/bin/env bash
# marveen-land.sh -- land an agent's marveen worktree branch (card dc185b52, MikroB komment 14285).
# Sibling of store/cleancore-land.sh, matching naming on purpose: this repo now has the same
# worktree-per-agent shape CleanCore already proved out, and the landing step follows the same
# pattern -- merge in a THROWAWAY detached worktree (never the agent's own persistent worktree from
# store/agent-worktree-marveen.sh, and never the shared main checkout), verify the MERGE RESULT, push
# only on green.
#
# This script's core mechanics were already present, unchanged, in the now-retired
# store/agent-branch-land.sh and were explicitly confirmed safe by Cybersec's NO-GO review on
# card dc185b52 (komment 14284: "store/agent-branch-land.sh SOHA nem erinti a megosztott
# munkakonyvtarat, csak sajat throwaway worktree-t hasznal ... ez a resz biztonsagos"). The retired
# script's problem was its SIBLING (store/agent-branch.sh, "Step 0"), which ran `git checkout` on the
# ONE shared tree every agent's Read/Edit/Write tools also targeted -- a live-reproduced TOCTOU race.
# This script never did that, so it is renamed and kept (not rewritten) alongside the new
# agent-worktree-marveen.sh, which replaces Step 0 with real filesystem isolation instead of a
# checkout on shared ground.
#
# Usage:
#   marveen-land.sh <agent> [--dry-run]   # land one agent's worktree branch
#   marveen-land.sh --all [--dry-run]     # land every agent/*/work branch with unmerged work,
#                                         # sequentially (never concurrent -- shared object store)
#   marveen-land.sh --selftest
#
# Env overrides (tests only):
#   MARVEEN_MAIN     default /home/neon/marveen -- also where `origin` is fetched/pushed
#   MARVEEN_LAND_TEST   default "$MAIN/store/fleet-test.sh --ref" -- verification command, the merge
#                       sha is appended as the final argument. fleet-test.sh hardcodes the real repo
#                       as ROOT, so an automated test of THIS script against a throwaway repo must
#                       override this to a stub.
#
# Exit: 0 landed (or dry-run clean, or nothing to land) | 2 bad usage | 3 refused a precondition
#       | 4 merge/verify/push failed
set -uo pipefail

MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
say() { echo "  $*"; }
die() { echo "REFUSED: $2" >&2; exit "$1"; }
g() { git -C "$MAIN" "$@"; }

if [ "${1:-}" = "--selftest" ]; then
  fail=0; n=0
  t() { n=$((n+1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }
  agent_of() { case "$1" in agent/*/work) b="${1#agent/}"; echo "${b%/work}" ;; *) echo "" ;; esac; }
  t "extracts agent name from a work branch" "$(agent_of 'agent/backend/work')" "backend"
  t "rejects a non-agent branch" "$(agent_of 'develop')" ""
  t "rejects an agent branch with the wrong suffix" "$(agent_of 'agent/backend/scratch')" ""
  echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi

[ -d "$MAIN/.git" ] || die 3 "$MAIN is not a git repository"
DEFAULT_BRANCH="$(g symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
[ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="develop"
TEST_CMD="${MARVEEN_LAND_TEST:-$MAIN/store/fleet-test.sh --ref}"

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

  local wt="/home/neon/marveen-land-${agent}-$$"
  rm -rf "$wt"
  g worktree add --detach -q "$wt" "origin/$DEFAULT_BRANCH" || die 3 "could not create the landing worktree for $agent"
  cleanup() { g worktree remove --force "$wt" >/dev/null 2>&1; }
  trap cleanup RETURN

  local msg="merge: $branch into $DEFAULT_BRANCH (marveen-land, base @ $(git -C "$wt" rev-parse --short HEAD))"
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
    # so the agent's own next agent-worktree-marveen.sh top-up (or a plain `git pull --ff-only` inside
    # their persistent worktree) fast-forwards it there automatically. No reset attempted against a
    # branch that IS the agent's own currently-checked-out worktree.
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
  '') die 2 "usage: marveen-land.sh <agent> [--dry-run] | marveen-land.sh --all [--dry-run]" ;;
  *)
    land_one "$1" "$DRY"
    exit $?
    ;;
esac

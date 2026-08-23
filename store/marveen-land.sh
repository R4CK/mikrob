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
#   MARVEEN_LAND_MAX_ATTEMPTS  default 3 -- how many full merge+verify+push attempts before giving
#                       up on a repeatedly-raced push (card 65657bad).
#
# Exit: 0 landed (or dry-run clean, or nothing to land) | 2 bad usage | 3 refused a precondition
#       | 4 merge/verify/push failed
#       (5 is internal: land_one lost the push race; land_with_retry consumes it and never leaks it)
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
MAX_ATTEMPTS="${MARVEEN_LAND_MAX_ATTEMPTS:-3}"

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
  # `${wt:-}` and the explicit success, both deliberate (card 65657bad, caught by its own test): the
  # RETURN trap set here also fires when land_with_retry returns, where `wt` is a dead local -- under
  # `set -u` that aborted the whole script mid-landing. Nothing to remove is not a failure, either;
  # a non-zero last command in a RETURN trap would poison the return code it is riding on.
  cleanup() { [ -n "${wt:-}" ] && g worktree remove --force "$wt" >/dev/null 2>&1; return 0; }
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

  # Card 65657bad: this used to be `>/dev/null 2>&1`, so PUSH FAILED never said why. On a fleet that
  # lands often the usual cause is a LOST RACE -- another agent pushed during our merge+test window,
  # leaving this push non-fast-forward -- which is not a fault at all. Indistinguishable from a real
  # one (credentials, network, a rejecting hook) without git's own words, so two agents re-ran the
  # whole landing by hand to find out. Print them.
  local push_err
  if ! push_err="$(git -C "$wt" push origin "HEAD:$DEFAULT_BRANCH" 2>&1)"; then
    echo "$agent: PUSH FAILED -- git says:"; echo "$push_err" | sed 's/^/    /'
    # A race is the one failure worth retrying, and only these exact markers identify it -- they are
    # what git prints for a non-fast-forward. Matching a bare "rejected" would also catch a
    # pre-receive hook REFUSING the push, which is a decision, not a race: retrying that burns
    # another full merge+verify cycle and fails again for the same reason.
    case "$push_err" in
      *"(fetch first)"*|*"(non-fast-forward)"*) return 5 ;;
    esac
    return 4
  fi
  g fetch -q origin "$DEFAULT_BRANCH"
  if g merge-base --is-ancestor "$merge_sha" "origin/$DEFAULT_BRANCH"; then
    # $branch itself is left untouched here on purpose: it is now an ancestor of origin/$DEFAULT_BRANCH,
    # so the agent's own next agent-worktree-marveen.sh top-up (or a plain `git pull --ff-only` inside
    # their persistent worktree) fast-forwards it there automatically. No reset attempted against a
    # branch that IS the agent's own currently-checked-out worktree.
    # Same reason as in cleancore-land.sh: the blast-radius graph must follow HEAD,
    # or the guard silently stops enforcing. Non-fatal by construction.
    "$(dirname "$0")/blast-radius-check.py" --refresh "$MAIN" 2>&1 | sed 's/^/  /' || true
    # The graphify code-graph feeds the local model's RAG context at dispatch
    # (card 44477615). It rotted the same way the blast-radius graph did -- built once
    # on adoption day, then 24 days stale -- so it follows HEAD here too. Incremental
    # (~13s on marveen) and non-fatal: a graph refresh must not fail a landing.
    "$(dirname "$0")/graphify.sh" build "$MAIN" 2>&1 | tail -1 | sed 's/^/  graphify: /' || true
    echo "$agent: LANDED $branch -> origin/$DEFAULT_BRANCH ($(git -C "$wt" rev-parse --short HEAD))"
    return 0
  fi
  echo "$agent: PUSH reported success but $merge_sha is NOT an ancestor of origin/$DEFAULT_BRANCH -- verify by hand"
  return 4
}

# A raced push is retried from the TOP, not by pushing again: the base moved, so the merge result
# fleet-test approved no longer describes what would land. Re-merging and re-verifying is this
# script's whole point -- pushing the already-tested merge onto a different base, or skipping the
# re-test to save two minutes, would put code on develop that no fleet-test ever saw.
land_with_retry() {
  local agent="$1" dry="$2" attempt=1 rc
  while :; do
    land_one "$agent" "$dry"; rc=$?
    [ "$rc" -eq 5 ] || return "$rc"
    if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
      echo "$agent: REFUSED -- lost the push race $attempt time(s) in a row; origin/$DEFAULT_BRANCH keeps moving during the merge+test window. Nothing pushed; agent/${agent}/work is untouched."
      return 4
    fi
    attempt=$((attempt+1))
    say "$agent: another agent landed during the merge+test window -- re-merging onto the new origin/$DEFAULT_BRANCH and verifying again (attempt $attempt/$MAX_ATTEMPTS)"
  done
}

DRY=0
case "${2:-}" in --dry-run) DRY=1 ;; esac

case "${1:-}" in
  --all)
    overall=0
    while IFS= read -r b; do
      [ -n "$b" ] || continue
      agent="${b#agent/}"; agent="${agent%/work}"
      land_with_retry "$agent" "$DRY" || overall=1
    done < <(g for-each-ref --format='%(refname:short)' 'refs/heads/agent/*/work')
    exit $overall
    ;;
  '') die 2 "usage: marveen-land.sh <agent> [--dry-run] | marveen-land.sh --all [--dry-run]" ;;
  *)
    land_with_retry "$1" "$DRY"
    exit $?
    ;;
esac

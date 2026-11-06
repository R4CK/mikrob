#!/usr/bin/env bash
# agent-checkpoint.sh -- branchless checkpoint ref per card (card 295ae6a3 F1.1, phase ed332869).
# Ideas-only, no code copied, from pingdotgg/t3code @37481f04 (MIT): capture a turn's full
# worktree state as a commit nothing points at except a hidden ref, built from a TEMP index so the
# agent's real index/HEAD/branch/stash are never touched.
#
# Usage:
#   agent-checkpoint.sh <agent> <cardId>   creates refs/mikrob/ckpt/<cardId>/<n> (n = next unused)
#                                           from <agent>'s own worktree, prints "<ref> <sha>"
#   agent-checkpoint.sh --selftest         proves index/HEAD/branch/stash are untouched
#
# Env overrides (tests only -- production uses the real marveen checkout):
#   MARVEEN_MAIN   default /home/neon/marveen (passed through to agent-worktree-marveen.sh)
#
# Exit: 0 ok | 2 bad usage | 3 worktree path does not resolve to a real git worktree
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"

die() { echo "agent-checkpoint.sh: $2" >&2; exit "$1"; }

agent_checkpoint() {
  local agent="$1" card="$2"
  case "$agent" in *[!a-z0-9-]*|-*|'') die 2 "agent name must match [a-z0-9-]+ (got: $agent)" ;; esac
  case "$card" in *[!0-9a-f]*|'') die 2 "card id must be hex (got: $card)" ;; esac

  local wt
  wt="$(MARVEEN_MAIN="$MAIN" bash "$HERE/agent-worktree-marveen.sh" "$agent" --path)"

  # The worktree path NOT resolving to a real git worktree must refuse, never fall back to
  # running git against $MAIN -- a checkpoint "of the agent's state" taken against the SHARED
  # clone would record some other agent's in-flight files under this agent's name.
  [ -e "$wt/.git" ] || die 3 "worktree path does not resolve to a real git worktree: $wt (run agent-worktree-marveen.sh $agent first; never falling back to the shared clone)"

  local head
  head="$(git -C "$wt" rev-parse HEAD)"

  local tmp_index
  tmp_index="$(mktemp -u)"
  trap 'rm -f "$tmp_index"' RETURN

  # Blank temp index + add -A: git populates it from the CURRENT WORKING TREE (tracked, modified
  # and untracked-but-not-ignored paths), which is exactly the full snapshot a checkpoint wants --
  # same shape t3code uses (apps/server/src/vcs/GitVcsDriverCore.ts:4209, ideas only, no code
  # copied). This never touches $wt/.git/index: GIT_INDEX_FILE redirects every index read/write
  # below to $tmp_index instead.
  GIT_INDEX_FILE="$tmp_index" git -C "$wt" add -A

  local tree commit
  tree="$(GIT_INDEX_FILE="$tmp_index" git -C "$wt" write-tree)"
  commit="$(git -C "$wt" commit-tree "$tree" -p "$head" -m "checkpoint $card")"

  local n=1
  while git -C "$wt" show-ref --verify --quiet "refs/mikrob/ckpt/$card/$n"; do
    n=$((n + 1))
  done
  local ref="refs/mikrob/ckpt/$card/$n"
  git -C "$wt" update-ref "$ref" "$commit"

  echo "$ref $commit"
}

if [ "${1:-}" = "--selftest" ]; then
  fail=0
  ok() { echo "  ok   $1"; }
  no() { echo "  FAIL $1"; fail=1; }

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  TEST_MAIN="$tmp/main"
  TEST_ROOT="$tmp/worktrees"

  git init -q -b develop "$TEST_MAIN"
  git -C "$TEST_MAIN" config user.email t@t
  git -C "$TEST_MAIN" config user.name t
  git -C "$TEST_MAIN" config commit.gpgsign false
  echo base > "$TEST_MAIN/notes.txt"
  git -C "$TEST_MAIN" add notes.txt
  git -C "$TEST_MAIN" commit -qm base

  ORIGIN="$tmp/origin.git"
  git init -q --bare -b develop "$ORIGIN"
  git -C "$TEST_MAIN" remote add origin "$ORIGIN"
  git -C "$TEST_MAIN" push -q origin develop
  git -C "$TEST_MAIN" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop

  run() { MARVEEN_MAIN="$TEST_MAIN" MARVEEN_WORKTREES="$TEST_ROOT" bash "$0" "$@"; }

  # 1. worktree path that does not resolve (never created) -> refuse, exit 3, never touches MAIN.
  if out="$(MARVEEN_MAIN="$TEST_MAIN" bash "$0" testagent deadbeef12 2>&1)"; then
    no "expected refusal for a non-existent worktree, got success: $out"
  else
    rc=$?
    if [ "$rc" = 3 ] && printf '%s' "$out" | grep -q "never falling back"; then
      ok "non-existent worktree path is refused (exit 3), never falls back to the shared clone"
    else
      no "expected exit 3 with the fallback-refusal message, got rc=$rc out=$out"
    fi
  fi

  # Now create the real worktree via the sibling script, same env.
  run_wt() { MARVEEN_MAIN="$TEST_MAIN" MARVEEN_WORKTREES="$TEST_ROOT" bash "$HERE/agent-worktree-marveen.sh" "$@"; }
  run_wt testagent >/dev/null
  WT="$TEST_ROOT/testagent"

  # An UNRELATED, pre-existing stash entry first (committed to the stash and the working tree
  # cleaned again), so "stash list untouched" has something real to prove without `git stash
  # push` later sweeping away the very staged/modified state the checkpoint is supposed to catch
  # (stash push reverts staged + unstaged tracked changes to HEAD by default).
  echo stashme > "$WT/stash-source.txt"
  git -C "$WT" add stash-source.txt
  git -C "$WT" stash push -q -m "selftest stash"

  # Seed real, varied worktree state: a staged file, an unstaged modification, an untracked file.
  echo staged > "$WT/staged.txt"
  git -C "$WT" add staged.txt
  echo modified >> "$WT/notes.txt"
  echo untracked > "$WT/untracked.txt"

  real_index="$(git -C "$WT" rev-parse --git-path index)"
  before_index_hash="$(sha256sum "$real_index" | awk '{print $1}')"
  before_head="$(git -C "$WT" rev-parse HEAD)"
  before_branch="$(git -C "$WT" rev-parse --abbrev-ref HEAD)"
  before_stash="$(git -C "$WT" stash list)"
  before_status="$(git -C "$WT" status --porcelain)"

  out="$(MARVEEN_MAIN="$TEST_MAIN" MARVEEN_WORKTREES="$TEST_ROOT" bash "$0" testagent cafebabe01)"
  ref="$(echo "$out" | awk '{print $1}')"
  sha="$(echo "$out" | awk '{print $2}')"

  after_index_hash="$(sha256sum "$real_index" | awk '{print $1}')"
  after_head="$(git -C "$WT" rev-parse HEAD)"
  after_branch="$(git -C "$WT" rev-parse --abbrev-ref HEAD)"
  after_stash="$(git -C "$WT" stash list)"
  after_status="$(git -C "$WT" status --porcelain)"

  [ "$ref" = "refs/mikrob/ckpt/cafebabe01/1" ] && ok "first checkpoint for a card is numbered /1" \
    || no "expected refs/mikrob/ckpt/cafebabe01/1, got $ref"

  git -C "$WT" cat-file -e "$sha" 2>/dev/null && ok "checkpoint commit object exists" \
    || no "checkpoint commit $sha does not exist"

  [ "$before_index_hash" = "$after_index_hash" ] && ok "real index file untouched (byte-identical)" \
    || no "index file CHANGED: $before_index_hash -> $after_index_hash"
  [ "$before_head" = "$after_head" ] && ok "HEAD untouched" || no "HEAD changed: $before_head -> $after_head"
  [ "$before_branch" = "$after_branch" ] && ok "current branch untouched" || no "branch changed: $before_branch -> $after_branch"
  [ "$before_stash" = "$after_stash" ] && ok "stash list untouched" || no "stash list changed"
  [ "$before_status" = "$after_status" ] && ok "working-tree status untouched" || no "working-tree status changed"

  # Checkpointed tree contains the staged + unstaged + untracked changes (the point of the
  # snapshot), proven by reading the commit's tree, not by re-deriving from the live worktree.
  tree_files="$(git -C "$WT" ls-tree -r --name-only "$sha")"
  if echo "$tree_files" | grep -qx staged.txt && echo "$tree_files" | grep -qx untracked.txt \
    && git -C "$WT" show "$sha:notes.txt" | grep -q modified; then
    ok "checkpoint tree captures staged + unstaged + untracked changes"
  else
    no "checkpoint tree missing expected files: $tree_files"
  fi

  # A second checkpoint for the SAME card gets the NEXT number, not a collision.
  out2="$(MARVEEN_MAIN="$TEST_MAIN" MARVEEN_WORKTREES="$TEST_ROOT" bash "$0" testagent cafebabe01)"
  ref2="$(echo "$out2" | awk '{print $1}')"
  [ "$ref2" = "refs/mikrob/ckpt/cafebabe01/2" ] && ok "a second checkpoint for the same card is numbered /2" \
    || no "expected refs/mikrob/ckpt/cafebabe01/2, got $ref2"

  if [ "$fail" -eq 0 ]; then echo "selftest: PASS"; else echo "selftest: FAIL"; fi
  exit "$fail"
fi

[ $# -eq 2 ] || die 2 "usage: agent-checkpoint.sh <agent> <cardId>  |  agent-checkpoint.sh --selftest"
agent_checkpoint "$1" "$2"

#!/usr/bin/env bash
# agent-worktree-marveen.sh -- give a fleet agent its OWN git worktree of the marveen repo itself
# (card dc185b52, MikroB's reversed decision komment 14285, after Cybersec's live-reproduced
# TOCTOU NO-GO on the branch-only attempt, komment 14284). Generalizes the ALREADY-PROVEN CleanCore
# pattern (store/agent-worktree.sh) to marveen's own self-hosted repo.
#
# WHY THE EARLIER BRANCH-ONLY FIX (store/agent-branch.sh / agent-branch-land.sh, now RETIRED) WAS
# NOT ENOUGH. That approach ran `git checkout` on the ONE shared working directory every agent's
# ordinary Read/Edit/Write tool calls also target. Its dirty-tree guard only refused when the tree
# was ALREADY dirty at the moment of the checkout call -- it could not see a DIFFERENT agent's
# in-flight Read-old-content -> (thinking) -> Write-new-content sequence, because that agent never
# calls agent-branch.sh at all; it just uses Read/Edit/Write like every agent does by default.
# Cybersec reproduced this live: a checkout landing in the ~1-second window between another agent's
# Read and Write silently swapped the file content under that agent's feet, with NO git error --
# the victim's next Write then overwrote a DIFFERENT branch's real, already-committed content with
# stale data, and a subsequent commit buried that loss with no conflict marker anywhere. A branch
# switch on a tree that other tools can write into at any moment cannot be made safe by a dirty
# check taken at one instant; the tree itself has to stop being shared.
#
# A WORKTREE CLOSES THIS STRUCTURALLY, not by discipline: each worktree has its OWN index AND its
# own checked-out files on disk. Nothing here ever runs `git checkout` against the path any OTHER
# agent's tools might be reading or writing -- there is no shared mutable ground left to race.
#
# HOOKS: deliberately NOT isolated per-worktree here (unlike CleanCore's agent-worktree.sh, which
# gives each worktree its own core.hooksPath). marveen's real git hooks are its pre-push guards
# (.git/hooks/pre-push.d/: no-force-push-protected, no-dashboard-token-in-push) -- security controls
# that must apply to EVERY agent's push uniformly. Worktrees share .git/hooks with the main clone by
# default, which is exactly what we want here; do not add per-worktree hooksPath isolation without
# re-checking that those guards still fire everywhere.
#
# marveen has no npm workspaces (flat single-package repo, checked via package.json) -- unlike
# CleanCore, only the root node_modules needs a symlink, no per-package pass.
#
# Usage:
#   agent-worktree-marveen.sh <agent>          # create (or top up) the agent's worktree
#   agent-worktree-marveen.sh <agent> --path   # print the path and exit (for scripting)
#
# Env overrides (tests only -- production uses the real marveen checkout):
#   MARVEEN_MAIN         default /home/neon/marveen
#   MARVEEN_WORKTREES    default /home/neon/marveen-agent-worktrees
#
# Exit: 0 ok | 2 bad usage | 3 setup failed
set -euo pipefail

MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
ROOT="${MARVEEN_WORKTREES:-/home/neon/marveen-agent-worktrees}"

die() { echo "agent-worktree-marveen.sh: $2" >&2; exit "$1"; }

AGENT="${1:-}"
[ -n "$AGENT" ] || die 2 "usage: agent-worktree-marveen.sh <agent> [--path]"
case "$AGENT" in
  # Same restriction as agent-worktree.sh / the retired agent-branch.sh, for the same reason: the
  # name becomes both a directory and a branch, and a case-only difference must never resolve two
  # agents to one tree on a filesystem that could be case-insensitive.
  *[!a-z0-9-]*|-*|'') die 2 "agent name must match [a-z0-9-]+ (got: $AGENT)" ;;
esac

TREE="$ROOT/$AGENT"
BRANCH="agent/${AGENT}/work"

[ -d "$MAIN/.git" ] || die 3 "no marveen clone at $MAIN (set MARVEEN_MAIN)"

DEFAULT_BRANCH="$(git -C "$MAIN" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
[ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="develop"

if [ "${2:-}" = "--path" ]; then echo "$TREE"; exit 0; fi

git -C "$MAIN" fetch origin "$DEFAULT_BRANCH" --quiet || die 3 "could not fetch origin/$DEFAULT_BRANCH"

if [ -e "$TREE/.git" ]; then
  echo "worktree already present: $TREE ($(git -C "$TREE" rev-parse --abbrev-ref HEAD))"
else
  mkdir -p "$ROOT"
  # NOT --force, no rm -rf: an occupied path fails loudly instead of silently deleting someone's work.
  # Try creating a NEW branch first (the common case); fall back to an existing local branch (a
  # worktree that was removed with `git worktree remove` but whose branch survived).
  add_err="$(git -C "$MAIN" worktree add "$TREE" -b "$BRANCH" "origin/$DEFAULT_BRANCH" 2>&1)" \
    || add_err="$add_err"$'\n'"$(git -C "$MAIN" worktree add "$TREE" "$BRANCH" 2>&1)" \
    || die 3 "could not create the worktree at $TREE -- git said:"$'\n'"$add_err"
  echo "created $TREE on $BRANCH"
fi

if [ -e "$TREE/node_modules" ]; then
  echo "node_modules: already linked"
else
  ln -s "$MAIN/node_modules" "$TREE/node_modules"
  echo "node_modules: linked from $MAIN/node_modules"
fi

echo "path:   $TREE"
echo "branch: $(git -C "$TREE" rev-parse --abbrev-ref HEAD) @ $(git -C "$TREE" rev-parse --short HEAD)"
echo "index:  $(git -C "$TREE" rev-parse --git-dir)/index   (own index -- peer commits/checkouts cannot reach it)"

#!/usr/bin/env bash
# agent-branch.sh -- give a fleet agent its OWN branch in the SHARED marveen checkout (card dc185b52,
# MikroB plan-grilling komment 14270, Peti-approved force despite the weekly newDevStop).
#
# WHY A BRANCH AND NOT A WORKTREE. CleanCore solved this exact entanglement class with full
# per-agent worktrees (store/agent-worktree.sh) -- separate index, separate working tree, the
# collision is structurally impossible. MikroB's plan-grilling explicitly rejected that here: the
# marveen repo is skill/config/script-heavy with frequent SMALL edits from many agents, not the
# CleanCore shape (few agents, large parallel feature branches). A full worktree-per-agent kataszter
# for that usage pattern is over-engineering. The lighter fix: everyone still shares ONE working
# tree, but each agent stages and commits on THEIR OWN branch, never on develop directly -- so one
# agent's `git commit` (on their branch) cannot sweep in another agent's staged-but-uncommitted files
# on develop's index, because they are never staged on the SAME branch checkout at the same time.
#
# THE PROTECTION MECHANISM: this script refuses to switch branches while the working tree is dirty
# and the caller is not already on their own branch. That is the actual guard -- it is what turns
# "agent forgot to switch first" (the single most likely failure MikroB's plan-grilling named) into
# a loud refusal instead of a silent branch-switch that could carry a DIFFERENT agent's staged work
# across. It does not eliminate every theoretical race (two agents editing in the same real-time
# instant on a genuinely shared working tree still touch the same files) -- it eliminates the
# observed incident class: stage-then-commit interleaving between two agents' turns.
#
# Usage:
#   agent-branch.sh <agent>          # idempotent: create/switch to agent/<agent>/work, ff-sync it
#   agent-branch.sh <agent> --path   # print "repo:branch" and exit (for scripting), no side effects
#
# Env overrides (tests only -- production always uses the real marveen checkout):
#   AGENT_BRANCH_REPO   default /home/neon/marveen
#
# Exit: 0 ok | 2 bad usage | 3 refused (dirty tree on a foreign branch) | 4 git operation failed
set -uo pipefail

REPO="${AGENT_BRANCH_REPO:-/home/neon/marveen}"

die() { echo "agent-branch.sh: $2" >&2; exit "$1"; }
say() { echo "  $*"; }
g() { git -C "$REPO" "$@"; }

AGENT="${1:-}"
[ -n "$AGENT" ] || die 2 "usage: agent-branch.sh <agent> [--path]"
case "$AGENT" in
  # Same restriction as agent-worktree.sh, kept even though this repo lives on a case-sensitive
  # filesystem: the branch name is user-visible in git log / landing scripts, and a stray uppercase
  # letter is how "Backend" and "backend" end up as two branches for one agent by accident.
  *[!a-z0-9-]*|-*|'') die 2 "agent name must match [a-z0-9-]+ (got: $AGENT)" ;;
esac
BRANCH="agent/${AGENT}/work"

[ -d "$REPO/.git" ] || die 4 "$REPO is not a git repository"

# The default branch is read from the remote-tracking symref (fast, no network), never hardcoded --
# a script that carries its own idea of "the default branch" goes stale the day that changes.
DEFAULT_BRANCH="$(g symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
[ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="develop"

if [ "${2:-}" = "--path" ]; then echo "$REPO:$BRANCH"; exit 0; fi

CURRENT="$(g branch --show-current)"
DIRTY=0
[ -n "$(g status --porcelain 2>/dev/null)" ] && DIRTY=1

if [ "$CURRENT" = "$BRANCH" ]; then
  say "already on $BRANCH"
elif [ "$DIRTY" -eq 1 ]; then
  # This is the guard, not a formality: switching branches with someone else's staged/unstaged
  # changes present would either carry them onto OUR branch or refuse to switch at all depending on
  # whether they conflict -- either way it is the exact hazard this script exists to close. Refuse
  # loudly instead of guessing whose changes those are.
  die 3 "working tree is dirty on branch '$CURRENT' (not yours: $BRANCH) -- commit or the OTHER agent's work is still staged here. Not switching."
else
  if g show-ref --verify --quiet "refs/heads/$BRANCH"; then
    g checkout -q "$BRANCH" || die 4 "checkout $BRANCH failed"
    say "switched to existing $BRANCH"
  else
    g checkout -q -b "$BRANCH" "$DEFAULT_BRANCH" || die 4 "could not create $BRANCH from $DEFAULT_BRANCH"
    say "created $BRANCH from $DEFAULT_BRANCH"
  fi
fi

# Keep the branch fresh: pull in whatever already landed on the default branch since this branch was
# last synced. ff-only on purpose -- if it does not fast-forward (this branch has commits AND the
# default branch moved past the fork point), that is a real merge decision, not something this
# idempotent pre-commit step should make silently. Report and move on; agent-branch-land.sh (or the
# agent by hand) resolves it.
g fetch -q origin "$DEFAULT_BRANCH" 2>/dev/null || say "warning: could not fetch origin/$DEFAULT_BRANCH (offline? stale remote-tracking used)"
if g merge-base --is-ancestor "$BRANCH" "origin/$DEFAULT_BRANCH" 2>/dev/null; then
  if ! g merge --ff-only -q "origin/$DEFAULT_BRANCH" 2>/dev/null; then
    say "note: $BRANCH has no commits of its own yet but ff-only merge failed -- check by hand"
  else
    say "fast-forwarded to origin/$DEFAULT_BRANCH"
  fi
else
  say "$BRANCH has unmerged commits ahead of origin/$DEFAULT_BRANCH -- not auto-syncing (would need a real merge)"
fi

say "ready: $BRANCH"
exit 0

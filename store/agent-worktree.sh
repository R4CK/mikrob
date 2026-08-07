#!/usr/bin/env bash
# Give a dev agent its OWN git worktree on the CleanCore clone (card aa381758, plan 5a60e163).
#
# WHY: every dev agent used to commit in one shared checkout. With 30+ tracked-modified paths from
# several agents at once, a commit could sweep in a peer's file or leave one of yours behind, and no
# amount of commit discipline fully closes it -- the index is shared. A worktree has its OWN index,
# so the entanglement class disappears rather than being managed.
#
# The main clone stays the fetch/PR base. Nobody commits into it directly.
#
#   store/agent-worktree.sh <agent>            # create (or top up) the agent's worktree
#   store/agent-worktree.sh <agent> --path     # print the path and exit (for scripting)
#
# Exit: 0 ok | 2 bad usage | 3 setup failed
set -euo pipefail

MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
ROOT="${CLEANCORE_WORKTREES:-/mnt/h/LM_Studio_Workdir/CleanCore-worktrees}"

die() { echo "agent-worktree.sh: $2" >&2; exit "$1"; }

AGENT="${1:-}"
[ -n "$AGENT" ] || die 2 "usage: agent-worktree.sh <agent> [--path]"
case "$AGENT" in
  # Keep the name a single safe path segment: it becomes a directory AND a branch name.
  *[!a-z0-9-]*|-*|'') die 2 "agent name must match [a-z0-9-]+ (got: $AGENT)" ;;
esac

TREE="$ROOT/$AGENT"
BRANCH="agent/$AGENT/work"

if [ "${2:-}" = "--path" ]; then echo "$TREE"; exit 0; fi

[ -d "$MAIN/.git" ] || die 3 "no CleanCore clone at $MAIN (set CLEANCORE_MAIN)"
git -C "$MAIN" fetch origin main --quiet || die 3 "could not fetch origin/main"

if [ -e "$TREE/.git" ]; then
  echo "worktree already present: $TREE ($(git -C "$TREE" rev-parse --abbrev-ref HEAD))"
else
  mkdir -p "$ROOT"
  # NOT --force, and no rm -rf anywhere in this script: if the path is occupied by something we did
  # not create, the right outcome is a loud failure, not a silent delete of somebody's work.
  git -C "$MAIN" worktree add "$TREE" -b "$BRANCH" origin/main >/dev/null 2>&1 \
    || git -C "$MAIN" worktree add "$TREE" "$BRANCH" >/dev/null 2>&1 \
    || die 3 "could not create the worktree at $TREE"
  echo "created $TREE on $BRANCH"
fi

# node_modules: pnpm resolves per package, so the ROOT symlink alone is not enough. Without the
# per-package links vitest dies on '@vitejs/plugin-react' and tsc cannot see any @cleancore/* import,
# which reads like a broken recipe rather than a missing link. Measured: 30 package dirs + the root.
linked=0
[ -e "$TREE/node_modules" ] || { ln -s "$MAIN/node_modules" "$TREE/node_modules"; linked=$((linked + 1)); }
while IFS= read -r d; do
  d="${d%/}"
  [ -d "$MAIN/$d/node_modules" ] || continue
  [ -e "$TREE/$d/node_modules" ] && continue
  ln -s "$MAIN/$d/node_modules" "$TREE/$d/node_modules"
  linked=$((linked + 1))
done < <(cd "$MAIN" && ls -d apps/*/ packages/*/ packages/modules/*/ 2>/dev/null)
echo "node_modules links added: $linked"

echo "path:   $TREE"
echo "branch: $(git -C "$TREE" rev-parse --abbrev-ref HEAD) @ $(git -C "$TREE" rev-parse --short HEAD)"
echo "index:  $(git -C "$TREE" rev-parse --git-dir)/index   (own index -- peer commits cannot reach it)"

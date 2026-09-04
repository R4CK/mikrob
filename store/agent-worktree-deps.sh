#!/usr/bin/env bash
# agent-worktree-deps.sh -- give a marveen agent worktree a REAL node_modules directory instead of a
# directory symlink into the shared main clone (card 0b23ec28, plan-grilling verdict GO-WITH-CHANGES).
#
# WHY A SYMLINK IS THE ENABLER, AND WHY PER-ENTRY LINKS WOULD NOT FIX IT.
# agent-worktree-marveen.sh has always pointed $TREE/node_modules at $MAIN/node_modules with one
# directory symlink. The symlinked-node-modules guard defends against that, but while the link exists
# the guard is the ONLY control rather than one of several. Cybered's measured wedge:
#
#     cd $TREE/node_modules && rm -rf ../src        # deletes $MAIN/src, guard exits 0
#
# It works because `cd` lands the process in the RESOLVED directory, so the kernel expands `..`
# inside the main clone, while a guard reading the command text sees a path that stays in the
# worktree. The obvious hardening -- a real node_modules holding per-entry symlinks -- does NOT close
# this. It moves the exit one level deeper:
#
#     cd $TREE/node_modules/<any-package> && rm -rf ../../src
#
# and marveen's node_modules has 318 top-level entries, so it leaves 318 doors. As long as ANY
# directory symlink to shared ground survives in the tree, the class survives with it. A real
# directory is the only shape where `..` cannot leave the worktree.
#
# WHY A COPY AND NOT `npm ci`. The worktree must have the SAME dependency state as the install it was
# branched from; a fresh resolve could differ, needs the network, and takes far longer. `cp -a` is
# deterministic relative to the install and needs neither. Measured before choosing: marveen's
# node_modules is 990M and /home had 918G free (4% used), so 15 worktrees cost ~14.5G -- 1.6% of what
# is free. Hardlinking (`cp -al`) would be seconds instead of a minute, and is deliberately NOT the
# default: hardlinks share the INODE, so an in-place write to a package file through a worktree would
# reach into every other tree. That is a smaller hazard than today's, but this card exists to remove
# shared mutable ground, not to shrink it.
#
# SEPARATE SCRIPT ON PURPOSE. agent-worktree-marveen.sh is called idempotently from dispatch paths and
# skills as a cheap "make sure the worktree exists"; it runs in seconds. A minute-long copy inside
# that call would change the latency profile of every agent bootstrap and could time a dispatch out.
# So the fast path stays fast and this is the explicit, deliberate step.
#
# Usage:
#   agent-worktree-deps.sh <agent>            # make node_modules real (idempotent)
#   agent-worktree-deps.sh <agent> --check    # report the current shape, change nothing
#
# Env overrides (tests only):
#   MARVEEN_MAIN         default /home/neon/marveen
#   MARVEEN_WORKTREES    default /home/neon/marveen-agent-worktrees
#
# Exit: 0 ok (or already real) | 2 bad usage | 3 setup failed | 4 shape is a symlink (--check only)
set -euo pipefail

MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
ROOT="${MARVEEN_WORKTREES:-/home/neon/marveen-agent-worktrees}"

die() { echo "agent-worktree-deps.sh: $2" >&2; exit "$1"; }

AGENT="${1:-}"
[ -n "$AGENT" ] || die 2 "usage: agent-worktree-deps.sh <agent> [--check]"
case "$AGENT" in
  *[!a-z0-9-]*|-*|'') die 2 "agent name must match [a-z0-9-]+ (got: $AGENT)" ;;
esac
MODE="${2:-apply}"
case "$MODE" in apply|--check) ;; *) die 2 "second argument must be --check, if given" ;; esac

TREE="$ROOT/$AGENT"
NM="$TREE/node_modules"
[ -e "$TREE/.git" ] || die 3 "no worktree at $TREE -- run store/agent-worktree-marveen.sh $AGENT first"

# Order matters: a symlink to a directory answers YES to -d as well, so -L has to be asked first.
shape() {
  if   [ -L "$NM" ]; then echo symlink
  elif [ -d "$NM" ]; then echo real
  elif [ -e "$NM" ]; then echo other
  else                    echo absent
  fi
}

CURRENT="$(shape)"

if [ "$MODE" = "--check" ]; then
  case "$CURRENT" in
    real)    echo "node_modules: REAL directory -- no shared-ground symlink here"; exit 0 ;;
    symlink) echo "node_modules: SYMLINK -> $(readlink "$NM") (shared with every other worktree; run without --check to make it real)"; exit 4 ;;
    absent)  echo "node_modules: absent"; exit 0 ;;
    *)       echo "node_modules: unexpected file type"; exit 3 ;;
  esac
fi

case "$CURRENT" in
  real)
    echo "node_modules: already a real directory -- nothing to do"
    exit 0
    ;;
  other)
    die 3 "$NM exists and is neither a directory nor a symlink -- refusing to touch it"
    ;;
esac

[ -d "$MAIN/node_modules" ] || die 3 "no $MAIN/node_modules to copy from -- run npm ci in $MAIN first"

# COPY FIRST, SWAP LAST (card 65cc3860). The staging name was always here, but the symlink used to be
# removed BEFORE the copy -- which left the worktree with NO node_modules for the whole duration of the
# copy. That is fine for a tree nobody is using and wrong for this card, whose job is to convert 15
# trees belonging to agents that are mid-task: a vitest or tsc starting inside that window fails, and
# it fails looking like a broken dependency rather than a maintenance window. Copying first keeps the
# tree fully usable throughout and narrows the gap to the rm+mv pair (milliseconds).
#
# (The window is smaller than the header above assumed: the copy measured 9s, not a minute, on this
# machine -- 995M at ~110MB/s. Still worth the reorder, because the failure mode below does not depend
# on how long the copy takes.)
#
# It also fixes the failure mode. Under the old order a copy that died (disk full, interrupt) left the
# tree with the symlink already gone and nothing in its place -- broken, and needing manual repair.
# Now a failed copy leaves the worktree exactly as it was found.
STAGE="$TREE/.node_modules.incoming.$$"
rm -rf "$STAGE"
echo "node_modules: copying from $MAIN/node_modules (this is the slow step -- ~1GB)"
cp -a "$MAIN/node_modules" "$STAGE" || { rm -rf "$STAGE"; die 3 "copy failed (the worktree is untouched)"; }

# Replace the LINK, never the target. `rm` on a symlink unlinks the name; it cannot follow through
# into the shared tree. Guarded anyway, because getting this wrong once deletes the fleet's
# dependencies: refuse unless the thing being removed is genuinely a link.
if [ "$CURRENT" = "symlink" ]; then
  [ -L "$NM" ] || { rm -rf "$STAGE"; die 3 "$NM stopped being a symlink between the check and the removal -- aborting"; }
  rm "$NM"
  echo "node_modules: removed the shared symlink (the target in $MAIN is untouched)"
fi

mv "$STAGE" "$NM"
echo "node_modules: REAL directory now at $NM"
echo "  a 'cd node_modules && rm -rf ..' from here can no longer reach $MAIN"

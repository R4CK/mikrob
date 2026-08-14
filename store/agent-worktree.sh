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
# NEVER run a dependency installer (pnpm/npm install, npm ci, pnpm add) from inside a worktree.
# The worktree's node_modules are SYMLINKS into the main clone, so an install run here does not
# create a local copy -- it rewrites the tree every agent is reading, mid-work. Same class as the
# earlier npm-ci-in-a-shared-checkout incident, with a wider blast radius now that N agents share
# one node_modules. Install in $CLEANCORE_MAIN, then re-run this script to top up any new links.
#
#   store/agent-worktree.sh <agent>            # create (or top up) the agent's worktree
#   store/agent-worktree.sh <agent> --path     # print the path and exit (for scripting)
#
# Exit: 0 ok | 2 bad usage | 3 setup failed
set -euo pipefail

MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
ROOT="${CLEANCORE_WORKTREES:-/mnt/h/LM_Studio_Workdir/CleanCore-worktrees}"

die() { echo "agent-worktree.sh: $2" >&2; exit "$1"; }

# --check-links takes no agent: it asks about the MAIN clone, not about anyone's worktree. Handled
# before the name check so a sentinel can call it without inventing an agent to pass in.
if [ "${1:-}" = "--check-links" ]; then
  CHECK_LINKS_ONLY=1
else
  CHECK_LINKS_ONLY=0
  AGENT="${1:-}"
  [ -n "$AGENT" ] || die 2 "usage: agent-worktree.sh <agent> [--path] | agent-worktree.sh --check-links"
fi
if [ "$CHECK_LINKS_ONLY" -eq 0 ]; then
case "$AGENT" in
  # Keep the name a single safe path segment: it becomes a directory AND a branch name.
  #
  # LOWERCASE-ONLY IS LOAD-BEARING, not tidiness. Measured on this install: the default worktree
  # root sits on /mnt/h, which is CASE-INSENSITIVE (touch Agent; test -e agent -> true), while /home
  # is not. Relaxing this to [A-Za-z0-9-] would let two agents whose names differ only in case --
  # "backend" and "Backend" -- resolve to the SAME directory while git happily kept two distinct
  # branches, so each would silently commit over the other's tree. The root is configurable via
  # CLEANCORE_WORKTREES, so we cannot assume any particular filesystem: keep the restriction.
  *[!a-z0-9-]*|-*|'') die 2 "agent name must match [a-z0-9-]+ (got: $AGENT)" ;;
esac
fi

TREE="$ROOT/${AGENT:-}"
BRANCH="agent/${AGENT:-}/work"

if [ "${2:-}" = "--path" ]; then echo "$TREE"; exit 0; fi

# --- workspace-link integrity in the MAIN clone (card 67beaf74 follow-up, MikroB 14417) ----------
#
# THE FAILURE THIS CATCHES, seen for real on 2026-08-14:
#   apps/api/node_modules/@cleancore/i18n -> /tmp/tmp.bnTa1qNyAC/packages/i18n   (target deleted)
# Its 30 siblings are all RELATIVE (../../../../packages/...). A process ran an install from a
# throwaway temp worktree and pnpm wrote an ABSOLUTE link into the SHARED clone; when the temp
# directory was cleaned up the module stopped resolving -- for the main clone AND for every agent
# worktree that symlinks node_modules from it.
#
# It is worth catching here because the symptom lies: `TS2307: Cannot find module '@cleancore/i18n'`
# reads like the BRANCH is wrong. Card ea51e22a looked green in its own worktree (which happens to
# hold a real node_modules) and red everywhere else, and the honest-looking conclusion was "the card
# introduced a bad dependency".
#
# The repair target is DERIVED, never a hardcoded map: the package directory is found by reading
# package.json names under the main clone, and the relative path is computed from the link's own
# directory. A guard that carries its own list of answers goes stale the first time someone adds a
# package.
check_workspace_links() {
  local found=0 fixed=0 link target pkgdir rel
  while IFS= read -r link; do
    [ -n "$link" ] || continue
    found=$((found + 1))
    target="$(readlink "$link")"
    if [ -e "$link" ]; then
      # Points into /tmp but still resolves: not broken YET, and repairing a live link is not this
      # script's call. Say it and move on -- it will break the moment that directory is cleaned up.
      echo "  WARNING: $link -> $target (absolute, into /tmp -- will break when that path goes)"
      continue
    fi
    pkgdir="$(pkg_dir_for "$(basename "$link")")"
    if [ -z "$pkgdir" ]; then
      echo "  BROKEN: $link -> $target (target gone, and no package under $MAIN matches it -- fix by hand)"
      continue
    fi
    rel="$(python3 -c "import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$MAIN/$pkgdir" "$(dirname "$link")")"
    ln -sfn "$rel" "$link"
    echo "  REPAIRED: $link -> $rel (was $target, gone)"
    fixed=$((fixed + 1))
  done < <(find "$MAIN" -maxdepth 6 -type l -lname '/tmp/*' 2>/dev/null)
  if [ "$found" -eq 0 ]; then
    echo "workspace links: no /tmp-pointing symlink in the main clone"
  else
    echo "workspace links: $found /tmp-pointing symlink(s), $fixed repaired"
  fi
  [ "$found" -eq "$fixed" ]
}

# The directory of the workspace package whose package.json declares @cleancore/<name>, relative to
# $MAIN. Empty when nothing matches.
pkg_dir_for() {
  local name="$1" f
  while IFS= read -r f; do
    if grep -q "\"name\"[[:space:]]*:[[:space:]]*\"@cleancore/$name\"" "$MAIN/$f" 2>/dev/null; then
      dirname "$f"; return 0
    fi
  done < <(cd "$MAIN" && ls apps/*/package.json packages/*/package.json packages/modules/*/package.json 2>/dev/null)
  echo ""
}

if [ "$CHECK_LINKS_ONLY" -eq 1 ]; then
  check_workspace_links
  exit $?
fi



[ -d "$MAIN/.git" ] || die 3 "no CleanCore clone at $MAIN (set CLEANCORE_MAIN)"
git -C "$MAIN" fetch origin main --quiet || die 3 "could not fetch origin/main"

if [ -e "$TREE/.git" ]; then
  echo "worktree already present: $TREE ($(git -C "$TREE" rev-parse --abbrev-ref HEAD))"
else
  mkdir -p "$ROOT"
  # NOT --force, and no rm -rf anywhere in this script: if the path is occupied by something we did
  # not create, the right outcome is a loud failure, not a silent delete of somebody's work.
  # git's own diagnosis is the useful part when this fails (path occupied, branch already checked
  # out in another worktree, detached HEAD...). Capture it instead of discarding it: an earlier
  # version sent both attempts to /dev/null and left only "could not create", which says nothing.
  add_err="$(git -C "$MAIN" worktree add "$TREE" -b "$BRANCH" origin/main 2>&1)" \
    || add_err="$add_err"$'\n'"$(git -C "$MAIN" worktree add "$TREE" "$BRANCH" 2>&1)" \
    || die 3 "could not create the worktree at $TREE -- git said:"$'\n'"$add_err"
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

# Before those links are trusted, make sure the thing they point AT is sound: a dangling
# /tmp-pointing link in the main clone is inherited by every worktree that links from it.
check_workspace_links || echo "  (a link above needs a human -- the worktree is still usable)"

# HOOKS ISOLATION (card 420ef7b4, Cybersec NO-GO -- flagged by MikroB BEFORE this rollout, comment
# 10146, then missed by REVIEW+QA and caught only at the gate). The own-index property above stops
# a PEER'S STAGED WORK from being swept into a commit, but every worktree still shares ONE
# .git/hooks directory with the main clone by default (`git -C <tree> rev-parse --git-path hooks`
# resolves identically for all of them) -- an agent locally testing a hook variant (exactly what
# this session's own pre-commit work did, deliberately in a scratch clone instead) would otherwise
# rewrite every OTHER agent's commit path with one `cp`. `core.hooksPath`, set per-worktree via
# git's own supported mechanism (`extensions.worktreeConfig` + `git config --worktree`), gives each
# worktree its own hooks directory instead. Populated from THAT worktree's own checked-out
# scripts/hooks/ (so a worktree on a different ref gets that ref's hooks) and re-copied on every
# run, same idempotent top-up shape as the node_modules pass above -- a hook update in
# scripts/hooks/ propagates on the next re-run instead of silently going stale.
git -C "$MAIN" config extensions.worktreeConfig true
OWN_HOOKS="$(git -C "$TREE" rev-parse --git-dir)/hooks-own"
mkdir -p "$OWN_HOOKS"
hooks_copied=0
if [ -d "$TREE/scripts/hooks" ]; then
  for h in "$TREE"/scripts/hooks/*; do
    [ -f "$h" ] || continue
    cp "$h" "$OWN_HOOKS/$(basename "$h")"
    chmod +x "$OWN_HOOKS/$(basename "$h")"
    hooks_copied=$((hooks_copied + 1))
  done
fi
git -C "$TREE" config --worktree core.hooksPath "$OWN_HOOKS"
echo "hooks own-copied: $hooks_copied"

echo "path:   $TREE"
echo "branch: $(git -C "$TREE" rev-parse --abbrev-ref HEAD) @ $(git -C "$TREE" rev-parse --short HEAD)"
echo "index:  $(git -C "$TREE" rev-parse --git-dir)/index   (own index -- peer commits cannot reach it)"
echo "hooks:  $OWN_HOOKS   (own hooksPath -- isolated from the shared .git/hooks)"

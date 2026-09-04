#!/usr/bin/env bash
# A disposable, PINNED CleanCore worktree for a gate -- with a node_modules that cannot reach out
# and rewrite the shared clone (card 9dc0fba8).
#
# WHY THIS SCRIPT EXISTS AT ALL. Gates were hand-rolling this setup inline, every time, slightly
# differently. On 2026-09-02 one of those inline blocks did:
#
#     ln -s "$CC_MAIN/apps/web/node_modules" "$WT/apps/web/node_modules"   # directory symlink
#     ...
#     rm    "$WT/apps/web/node_modules/@cleancore/i18n"                    # reads local
#     ln -s "$WT/packages/i18n" "$WT/apps/web/node_modules/@cleancore/i18n"
#
# Both writes name paths under $WT and NEITHER names the shared clone -- but apps/web/node_modules
# WAS the symlink, so both landed in $CC_MAIN and rewrote the shared workspace link to an absolute
# path inside the worktree. Twenty minutes later the worktree was removed, the shared link dangled,
# and every agent's vite/vitest failed to resolve @cleancore/i18n for 38 minutes. The same block ran
# again 32 minutes later, so it had to be repaired twice.
#
# THE STRUCTURAL DIFFERENCE HERE: the worktree gets a REAL node_modules directory whose ENTRIES are
# symlinks to the main clone's entries. A write inside it therefore stays inside it -- the escaping
# path simply does not exist any more. Measured on this install the whole tree is ~100 entries
# (root 7, apps/web 27, apps/api 8, most packages 1), so per-entry linking costs nothing.
#
# AND IT REMOVES THE REASON for the dangerous command: @cleancore/* in the worktree points at the
# WORKTREE's own packages, so tests read the code at the gate SHA, not the shared clone's. That is
# what the inline block was reaching for (see the worktree-package-import-reads-the-shared-clone
# lesson); it is now the default, done safely.
#
#   store/cc-gate-worktree.sh <card> <sha>     # create or top up; prints the path
#   store/cc-gate-worktree.sh --path <card> <sha>
#   store/cc-gate-worktree.sh --remove <path>  # stop anything still running there, then remove
#
# NEVER run an installer here (pnpm/npm install, npm ci, pnpm add). The entries are links into the
# shared store; installing would rewrite what every agent is reading. Install in $CLEANCORE_MAIN.
#
# Exit: 0 ok | 2 bad usage | 3 setup failed
set -euo pipefail

MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
GATE_ROOT="${CC_GATE_ROOT:-$HOME}"

die() { echo "cc-gate-worktree.sh: $2" >&2; exit "$1"; }

# --- removal ------------------------------------------------------------------------------------
if [ "${1:-}" = "--remove" ]; then
  target="${2:-}"
  [ -n "$target" ] || die 2 "usage: cc-gate-worktree.sh --remove <path>"
  case "$target" in "$GATE_ROOT"/cc-gate-*) : ;; *) die 2 "refusing to remove a path outside $GATE_ROOT/cc-gate-* (got: $target)" ;; esac
  # A dev server left running in a removed worktree keeps recreating .vite cache dirs there and
  # holds a port -- exactly the orphan vite that had to be hunted down by hand after the incident.
  # Match on the process's own cwd, never on a command-line pattern: a pattern can catch a peer's
  # server on a different tree.
  killed=0
  for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    case "$cwd" in "$target"|"$target"/*) kill "$pid" 2>/dev/null && { echo "  stopped pid $pid (cwd was inside the worktree)"; killed=$((killed+1)); } ;; esac
  done
  [ "$killed" -eq 0 ] && echo "  no process was still running in that worktree"
  git -C "$MAIN" worktree remove --force "$target" 2>&1 | tail -2 || true
  git -C "$MAIN" worktree prune
  # `worktree remove` deletes the checkout; a cache directory recreated afterwards by a straggler
  # survives as a confusing skeleton (three of them were left behind on 2026-09-02). Sweep it.
  rm -rf "$target"
  echo "removed: $target"
  exit 0
fi

PATH_ONLY=0
if [ "${1:-}" = "--path" ]; then PATH_ONLY=1; shift; fi

CARD="${1:-}"; SHA="${2:-}"
[ -n "$CARD" ] && [ -n "$SHA" ] || die 2 "usage: cc-gate-worktree.sh <card> <sha> | --path <card> <sha> | --remove <path>"
case "$CARD" in *[!a-zA-Z0-9._-]*) die 2 "card id must be [a-zA-Z0-9._-]+ (got: $CARD)" ;; esac
case "$SHA"  in *[!a-zA-Z0-9._/-]*) die 2 "sha must be a plain rev (got: $SHA)" ;; esac

SHORT="$(git -C "$MAIN" rev-parse --short "$SHA" 2>/dev/null || true)"
[ -n "$SHORT" ] || die 3 "no such rev in $MAIN: $SHA"
TREE="$GATE_ROOT/cc-gate-$CARD-$SHORT"

if [ "$PATH_ONLY" -eq 1 ]; then echo "$TREE"; exit 0; fi

# --- create (idempotent) -------------------------------------------------------------------------
if [ -d "$TREE/.git" ] || [ -f "$TREE/.git" ]; then
  echo "worktree already present: $TREE"
else
  git -C "$MAIN" worktree add --detach "$TREE" "$SHORT" >/dev/null 2>&1 \
    || die 3 "git worktree add failed for $SHORT"
  echo "worktree created: $TREE @ $SHORT"
fi

# Map @cleancore/<name> -> directory inside the WORKTREE, derived from package.json names. Never a
# hardcoded list: a package added after this script was written must still resolve.
declare -A PKG_DIR=()
while IFS= read -r pj; do
  name="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('name',''))" "$pj" 2>/dev/null || true)"
  case "$name" in @cleancore/*) PKG_DIR["$name"]="$(dirname "$pj")" ;; esac
done < <(find "$TREE/packages" "$TREE/apps" -maxdepth 3 -name package.json -not -path '*/node_modules/*' 2>/dev/null)

link_entry() { # $1 = source entry, $2 = destination path
  [ -e "$2" ] || [ -L "$2" ] && rm -rf "$2"
  ln -s "$1" "$2"
}

linked=0; scoped=0
while IFS= read -r src; do
  rel="${src#"$MAIN"/}"                             # "node_modules" or "apps/web/node_modules"
  rel="${rel%node_modules}"; rel="${rel%/}"         # "" (the root) or "apps/web"
  dst="$TREE${rel:+/$rel}/node_modules"
  [ -d "$TREE${rel:+/$rel}" ] || continue           # a dir that does not exist at this SHA
  # An older hand-rolled setup may have left a DIRECTORY SYMLINK here. That is the shape this
  # script exists to eliminate: replace it, never write through it.
  [ -L "$dst" ] && rm -f "$dst"
  mkdir -p "$dst"
  # `find -mindepth 1 -maxdepth 1`, not a glob: a glob skips DOTFILES, and the two entries that
  # matter most here are dotted -- `.pnpm` (where every real package actually lives) and `.bin`
  # (where vitest/tsc live). A first cut of this script used `"$src"/*` and produced a worktree
  # whose `npx vitest` answered "vitest: not found".
  while IFS= read -r entry; do
    base="$(basename "$entry")"
    # An entry literally named node_modules inside a node_modules is never legitimate: it is the
    # residue of `ln -s <main>/x/node_modules <wt>/x/node_modules` run when the destination link
    # already existed, so the new link landed INSIDE the target. Two such self-referential loops
    # exist in the main clone today (apps/api, packages/control-plane, both dated 2026-08-26).
    # Copying them here would give every gate tree a symlink loop; skip them.
    [ "$base" = "node_modules" ] && continue
    # `.vite` is a WRITTEN cache, not a read-only dependency (card 0b23ec28, QA's measurement on the
    # 5762c0bd r2 gate, comment 18034). Linking it points every gate worktree's dev server at ONE
    # shared dep-cache: two of them running at once optimise into the same directory and serve each
    # other 504 Outdated Optimize Dep, which QA hit live and worked around by hand. Same directory-
    # symlink-to-shared-resource pattern as the node_modules link this script exists to remove, only
    # with a rebuildable artifact instead of source. A real empty directory costs nothing -- vite
    # repopulates it on first run -- and the collision cannot happen.
    if [ "$base" = ".vite" ]; then
      mkdir -p "$dst/.vite"
      continue
    fi
    if [ "$base" = "@cleancore" ]; then
      mkdir -p "$dst/@cleancore"
      while IFS= read -r pkg; do
        pname="@cleancore/$(basename "$pkg")"
        own="${PKG_DIR[$pname]:-}"
        # The worktree's own source when it has that package at this SHA, else the main clone's
        # entry (a package that did not exist yet at this SHA still has to resolve).
        link_entry "${own:-$(readlink -f "$pkg")}" "$dst/@cleancore/$(basename "$pkg")"
        scoped=$((scoped+1))
      done < <(find "$entry" -mindepth 1 -maxdepth 1 2>/dev/null)
    else
      link_entry "$entry" "$dst/$base"
      linked=$((linked+1))
    fi
  done < <(find "$src" -mindepth 1 -maxdepth 1 2>/dev/null)
done < <(find "$MAIN" -maxdepth 4 -type d -name node_modules -not -path '*/node_modules/*' 2>/dev/null)

echo "node_modules: $linked entry links + $scoped @cleancore links, in REAL directories (no directory symlink)"
echo "path: $TREE"
echo "tear down with: bash store/cc-gate-worktree.sh --remove $TREE"

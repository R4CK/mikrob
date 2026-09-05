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
#   store/cc-gate-worktree.sh --agent <you> <card> <sha>     # create or top up; prints the path
#   store/cc-gate-worktree.sh --agent <you> --path <card> <sha>
#   store/cc-gate-worktree.sh --agent <you> --remove <path>   # stop YOUR strays there, then remove
#
# The agent name may also come from CC_GATE_AGENT. One of the two is REQUIRED -- see below.
#
# THE AGENT IS PART OF THE PATH (card a7da80d6). It used to be card+sha ONLY, so two gates reviewing
# the SAME card at the SAME sha -- the normal case, since a card is gated by QA and Cybersec/Cybered
# together -- were handed the SAME directory. Then `--remove` by whichever finished first killed
# every process whose cwd was inside it and deleted the tree, taking a peer's running vitest with it
# SILENTLY: no error to the victim, just a suite that stops and a checkout that is gone. QA and
# Cybered each hit this independently in one gate round and each invented their own `<card>-<name>`
# path by hand. That is discipline; this is the structure, so it cannot be forgotten.
#
# WHY REQUIRED AND NOT DEFAULTED. A default would have to name SOME agent, and every caller that
# forgot the flag would collide on exactly that name -- reintroducing this bug for a subset of
# callers while looking fixed. Refusing is loud, immediate, and names the fix; an old two-argument
# call now dies with a usage error instead of silently sharing a tree with a peer.
#
# NEVER run an installer here (pnpm/npm install, npm ci, pnpm add). The entries are links into the
# shared store; installing would rewrite what every agent is reading. Install in $CLEANCORE_MAIN.
#
# Exit: 0 ok | 2 bad usage | 3 setup failed
set -euo pipefail

MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
GATE_ROOT="${CC_GATE_ROOT:-$HOME}"
AGENT="${CC_GATE_AGENT:-}"
FORCE=0
# The owner marker. Written at creation, read at removal -- the only authority on who owns a tree.
OWNER_FILE=".cc-gate-owner"

die() { echo "cc-gate-worktree.sh: $2" >&2; exit "$1"; }

# `--agent` and `--force` may appear anywhere, so a caller can put the agent first (matching
# agent-worktree.sh / cleancore-suite-run.sh) or last, without the meaning changing.
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENT="${2:-}"; shift 2 || die 2 "--agent needs a name" ;;
    --force) FORCE=1; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "${ARGS[@]:-}"

[ -n "$AGENT" ] || die 2 "the agent name is REQUIRED: pass --agent <you> or set CC_GATE_AGENT. Without it two gates on the same card+sha share one worktree, and --remove by one destroys the other's running work (card a7da80d6)."
case "$AGENT" in *[!a-zA-Z0-9._-]*) die 2 "agent name must be [a-zA-Z0-9._-]+ (got: $AGENT)" ;; esac

# --- removal ------------------------------------------------------------------------------------
if [ "${1:-}" = "--remove" ]; then
  target="${2:-}"
  [ -n "$target" ] || die 2 "usage: cc-gate-worktree.sh --remove <path>"
  # CONTAINMENT ON THE RESOLVED PATH, not on the string (Cybered F-2, card 5e4e629f). The old test
  # was `case "$target" in "$GATE_ROOT"/cc-gate-*)`, and a shell glob's `*` spans `/` -- so
  # "$GATE_ROOT/cc-gate-x/../../outside/..." matched, and `rm -rf` ran outside the gate root.
  # Reproduced before fixing. Resolving both sides and requiring the target to be a DIRECT child
  # closes it by construction: `..` cannot survive `realpath -m`, and a nested path fails the
  # child test. `-m` because the target may already be gone -- removal must stay idempotent.
  target_real="$(realpath -m -- "$target" 2>/dev/null || true)"
  root_real="$(realpath -m -- "$GATE_ROOT" 2>/dev/null || true)"
  [ -n "$target_real" ] && [ -n "$root_real" ] || die 2 "could not resolve the path (got: $target)"
  case "$target_real" in
    "$root_real"/cc-gate-*) : ;;
    *) die 2 "refusing to remove a path outside $root_real/cc-gate-* (got: $target -> $target_real)" ;;
  esac
  # WHAT EACH OF THESE TWO ACTUALLY HOLDS, measured rather than assumed: the `..` escape is caught
  # by EITHER of them, so reverting only the glob above leaves the selftest fully green and its two
  # escape cases look vacuous; a combined mutation (both reverted) turns them red. This NESTED test
  # is the one that is singly load-bearing -- removing it alone turns exactly one case red. Both are
  # kept: they answer different questions ("is it under the root" vs "is it a direct child"), and
  # the kill loop below makes a wrong answer expensive.
  case "${target_real#"$root_real"/}" in
    */*) die 2 "refusing to remove a NESTED path: only a direct child of $root_real may be removed (got: $target -> $target_real)" ;;
  esac

  # OWNERSHIP IS A MARKER FILE IN THE TREE, NOT A PATTERN ON THE PATH (Cybered F-1, card 5e4e629f).
  # The old test was a SUBSTRING match, `case "$(basename "$target")" in *"-$AGENT-"*)`, and it
  # handed a peer's tree to the wrong agent: "cc-gate-63f098ce-cybered-qa-deadbee" is owned by qa
  # (the layout is cc-gate-<card>-<agent>-<short>), but it contains "-cybered-", so cybered passed
  # the check and deleted it -- reproduced in a sandbox before this fix. A STRICTER PATTERN is not
  # the answer either: both card ids and agent names may contain "-" (fron-ted), so splitting the
  # basename into fields is ambiguous by construction. A file the creator writes is not.
  owner=""
  [ -f "$target_real/$OWNER_FILE" ] && owner="$(head -n1 "$target_real/$OWNER_FILE" 2>/dev/null || true)"
  if [ -n "$owner" ]; then
    [ "$owner" = "$AGENT" ] || {
      [ "$FORCE" -eq 1 ] || die 2 "refusing to remove '$target': it belongs to $owner, not $AGENT (per $OWNER_FILE). A peer may be running tests in it right now, and this command KILLS every process whose cwd is inside. Pass --force only if you know it is abandoned."
      echo "  --force: removing $owner's worktree" >&2
    }
  else
    # LEGACY TREES, created before the marker existed, are the reason this is not simply a refusal:
    # gates are in flight right now and must not have their teardown broken. The fallback is the
    # ANCHORED form of the old test -- the tree must END with "-$AGENT-<short>" -- which is exact
    # rather than a substring, so it rejects the case that started this card while still accepting
    # every tree this script has actually created.
    case "$(basename "$target_real")" in
      *"-$AGENT-"*)
        case "${target_real##*"-$AGENT-"}" in
          *-*) ownership_ok=0 ;;
          "") ownership_ok=0 ;;
          *) ownership_ok=1 ;;
        esac ;;
      *) ownership_ok=0 ;;
    esac
    [ "$ownership_ok" -eq 1 ] || {
      [ "$FORCE" -eq 1 ] || die 2 "refusing to remove '$target': no $OWNER_FILE, and the path does not end with -$AGENT-<short>, so it is not $AGENT's worktree. A peer may be running tests in it right now, and this command KILLS every process whose cwd is inside. Pass --force only if you know it is abandoned."
      echo "  --force: removing a worktree that is not $AGENT's" >&2
    }
  fi
  target="$target_real"
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
TREE="$GATE_ROOT/cc-gate-$CARD-$AGENT-$SHORT"

if [ "$PATH_ONLY" -eq 1 ]; then echo "$TREE"; exit 0; fi

# WRITE THE OWNER MARKER FIRST, and unconditionally on every run (card 5e4e629f). First, because a
# tree that exists without it falls back to the path heuristic on removal, and the whole point is to
# stop deciding ownership from the path. Unconditionally, because this script is idempotent "create
# or top up": an existing tree from before the marker gets one on its next top-up, which is how the
# legacy fallback stops being needed without anyone doing a migration.
mkdir -p "$TREE"
printf '%s\n' "$AGENT" >"$TREE/$OWNER_FILE"

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
echo "tear down with: bash store/cc-gate-worktree.sh --agent $AGENT --remove $TREE"

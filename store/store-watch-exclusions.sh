#!/usr/bin/env bash
# store-watch-exclusions.sh -- keep heavy vendored trees out of store-watcher's recursive
# fs.watch() (card 95adab18).
#
# THE PROBLEM. src/store-watcher.ts calls watch(STORE_DIR, { recursive: true }, ...) once, at
# startup. On Linux, Node emulates recursive watching by opening one inotify watch per entry
# (file AND directory) it finds under the root -- there is no native recursive inotify. Two
# vendored trees live under store/ and are gitignored precisely because they are large,
# externally-managed content: store/adopted (cloned reference skills, store/vendor-skill.sh's
# clone target) and store/stitch-tools/node_modules (an npm install). Together they accounted
# for ~10.7k of the process's inotify watches -- most of an FSWatcher fleet that exists only to
# log create-events for genuinely agent-authored files in store/.
#
# THE FIX. Node's recursive fs.watch does not descend into a symlinked subdirectory (verified
# empirically: a file written through a symlinked child produced no event, while the same write
# under a real child did). scanStore()'s own readdirSync(...).isDirectory() walk in
# store-watcher.ts independently skips symlinks too (a Dirent for a symlink-to-directory reports
# isDirectory() === false), so BOTH mechanisms that matter already do the right thing with zero
# code changes to store-watcher.ts -- moving the real content outside store/ and leaving a
# symlink at the original path is sufficient.
#
# THE node_modules TRAP (found and fixed while building this). stitch-tools has
# "type": "module", so its own requires are ESM. ESM import resolution REALPATHS symlinks before
# walking up for nested dependencies, and Node's node_modules algorithm requires the literal
# directory name "node_modules" at each level it checks. Relocating the real directory under any
# OTHER name (e.g. "stitch-tools-node_modules") breaks resolution of stitch-tools' own
# dependencies' dependencies once ESM resolves through the symlink to its real path. The target
# must therefore be a directory whose real, final path component is still exactly "node_modules"
# -- confirmed by an actual `import('@google/stitch-sdk')` in the moved tree, not by reasoning
# about the algorithm alone.
#
# WHY A SYMLINK AND NOT A watcher-topology REWRITE. Every other script/config in this repo
# (vendor-skill.sh, watched-repos.json, git-repo-watcher.sh, integrated-repos.ts) references
# store/adopted/... and store/stitch-tools/node_modules by their ORIGINAL path. A symlink needs
# no changes anywhere else, since existsSync/readFileSync/git/npm all resolve symlinks
# transparently for normal file access -- only fs.watch's recursive walk and scanStore's own walk
# treat them specially, and both already do the right thing.
#
# Usage:
#   store/store-watch-exclusions.sh check      # report only: are both exclusions correctly in place?
#   store/store-watch-exclusions.sh apply       # idempotent: move+symlink whatever is not yet excluded
#   store/store-watch-exclusions.sh selftest   # sandboxed, touches no real store/
#
# Exit: 0 all exclusions correctly in place | 1 problem found (check) or apply failed | 2 bad usage
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable so selftest never touches the real store/ or the real vendor-cache.
STORE_DIR="${STORE_WATCH_EXCL_STORE_DIR:-$HERE}"
VENDOR_CACHE="${STORE_WATCH_EXCL_VENDOR_CACHE:-$HOME/marveen-vendor-cache}"

# Each entry: <path relative to STORE_DIR> <external target dir under VENDOR_CACHE>
# The node_modules target's FINAL path component is deliberately still "node_modules" (see the
# ESM trap above); this is not a naming preference, it is required for correctness.
EXCLUSIONS=(
  "adopted:$VENDOR_CACHE/adopted"
  "stitch-tools/node_modules:$VENDOR_CACHE/stitch-tools/node_modules"
)

check_one() { # $1 = relpath, $2 = expected external target -> prints status, returns 0/1
  local rel="$1" target="$2" path="$STORE_DIR/$1"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    echo "MISSING  $rel  (nothing at this path -- nothing to exclude yet)"
    return 0
  fi
  if [ -L "$path" ]; then
    local real
    real="$(readlink -f "$path" 2>/dev/null || true)"
    local wantreal
    wantreal="$(readlink -f "$target" 2>/dev/null || echo "$target")"
    if [ "$real" = "$wantreal" ] && [ "$(basename "$path")" = "$(basename "$target")" ]; then
      echo "OK       $rel -> $target"
      return 0
    fi
    echo "WRONG    $rel is a symlink but points at '$real', expected '$wantreal'"
    return 1
  fi
  echo "REAL DIR $rel  (still a real directory under the watched tree -- fs.watch WILL walk it)"
  return 1
}

apply_one() { # $1 = relpath, $2 = external target
  local rel="$1" target="$2" path="$STORE_DIR/$1"
  if [ -L "$path" ]; then
    return 0 # already a symlink; check_one already validated it points the right place
  fi
  if [ ! -e "$path" ]; then
    return 0 # nothing to exclude yet, e.g. a fresh checkout that never cloned it
  fi
  mkdir -p "$(dirname "$target")"
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "refusing to move $path -> $target: target already exists" >&2
    return 1
  fi
  mv "$path" "$target"
  ln -s "$target" "$path"
  echo "MOVED    $rel -> $target"
}

cmd="${1:-check}"
case "$cmd" in
  check)
    fail=0
    for e in "${EXCLUSIONS[@]}"; do
      check_one "${e%%:*}" "${e#*:}" || fail=1
    done
    [ "$fail" -eq 0 ] && exit 0 || exit 1
    ;;
  apply)
    fail=0
    for e in "${EXCLUSIONS[@]}"; do
      apply_one "${e%%:*}" "${e#*:}" || fail=1
    done
    echo "--- post-apply check ---"
    for e in "${EXCLUSIONS[@]}"; do
      check_one "${e%%:*}" "${e#*:}" || fail=1
    done
    [ "$fail" -eq 0 ] && exit 0 || exit 1
    ;;
  selftest)
    sandbox="$(mktemp -d)"
    trap 'rm -rf "$sandbox"' EXIT
    st_fail=0
    chk() { # label, expected, actual
      if [ "$2" = "$3" ]; then echo "  ok   $1"
      else echo "  FAIL $1 -> got '$3', expected '$2'"; st_fail=1; fi
    }

    mkdir -p "$sandbox/store/adopted/some-repo" "$sandbox/store/stitch-tools/node_modules/leftpad"
    echo x > "$sandbox/store/adopted/some-repo/README.md"
    echo x > "$sandbox/store/stitch-tools/node_modules/leftpad/index.js"
    env_run() {
      STORE_WATCH_EXCL_STORE_DIR="$sandbox/store" STORE_WATCH_EXCL_VENDOR_CACHE="$sandbox/vendor-cache" \
        bash "${BASH_SOURCE[0]}" "$@"
    }

    echo "case: check reports REAL DIR before any apply"
    out="$(env_run check)"; rc=$?
    chk "exit code before apply"        "1"    "$rc"
    chk "reports adopted as REAL DIR"   "1"    "$(echo "$out" | grep -c '^REAL DIR  *adopted')"

    echo "case: apply moves both and leaves correct symlinks"
    env_run apply >/dev/null 2>&1; rc=$?
    chk "apply exit code"               "0"    "$rc"
    chk "adopted is now a symlink"      "1"    "$(test -L "$sandbox/store/adopted" && echo 1 || echo 0)"
    chk "node_modules leaf name preserved (ESM trap guard)" \
        "node_modules" "$(basename "$(readlink "$sandbox/store/stitch-tools/node_modules")")"
    chk "content survived the move (adopted)" \
        "x" "$(cat "$sandbox/store/adopted/some-repo/README.md" 2>/dev/null)"
    chk "content survived the move (node_modules)" \
        "x" "$(cat "$sandbox/store/stitch-tools/node_modules/leftpad/index.js" 2>/dev/null)"

    echo "case: check is now clean"
    out="$(env_run check)"; rc=$?
    chk "exit code after apply"         "0"    "$rc"
    chk "reports adopted OK"            "1"    "$(echo "$out" | grep -c '^OK  *adopted')"

    echo "case: apply is idempotent (no error re-running on an already-excluded tree)"
    env_run apply >/dev/null 2>&1; rc=$?
    chk "re-apply exit code"            "0"    "$rc"

    echo "case: check on a fresh checkout with nothing cloned yet is not a failure"
    mkdir -p "$sandbox/fresh-store"
    out="$(STORE_WATCH_EXCL_STORE_DIR="$sandbox/fresh-store" STORE_WATCH_EXCL_VENDOR_CACHE="$sandbox/fresh-cache" \
      bash "${BASH_SOURCE[0]}" check)"; rc=$?
    chk "MISSING is not an error"       "0"    "$rc"

    echo "case: a re-created REAL directory over an existing symlink target is detected as drift"
    rm "$sandbox/store/adopted"
    mkdir -p "$sandbox/store/adopted"
    out="$(env_run check)"; rc=$?
    chk "drift detected"                "1"    "$rc"
    chk "reports REAL DIR again"        "1"    "$(echo "$out" | grep -c '^REAL DIR  *adopted')"

    [ "$st_fail" -eq 0 ] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }
    ;;
  -h|--help)
    sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "unknown command: $cmd (expected check|apply|selftest)" >&2
    exit 2
    ;;
esac

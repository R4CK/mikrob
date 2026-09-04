#!/usr/bin/env bash
# Convert ~/.claude/skills/<name> symlinks into REAL directories (card 7d2ebd24).
#
# Usage:  bash store/skills-symlink-to-realdir.sh --check      # report only, changes nothing
#         bash store/skills-symlink-to-realdir.sh --dry-run    # say what would happen
#         bash store/skills-symlink-to-realdir.sh              # do it
#         SKILLS_DIR=... PREFIX=sp- ...                        # overridable for tests
#
# WHY. The fleet's fork-written additions to three vendored skills (70 lines, card 4a3c75a5) are
# git-tracked in seed-skills/ -- the SOURCE is safe. What agents actually READ is not: the entries
# under ~/.claude/skills are symlinks into a vendored third-party checkout, and the additions exist
# there only as UNCOMMITTED modifications to that checkout. A plain `git checkout` in that repo
# reverts them, and all 15 agents read the skills without those lines until the next update.sh.
#
# Converting to real directories also closes a second, older hazard in the same place: update.sh's
# refresh_untouched_seeds decides a target exists with `[ -d ... ]`, and a symlink-to-directory
# answers `-d` with yes, so the refresh wrote THROUGH the link into the vendored repo (measured:
# three files there had been rewritten by our updater). A real directory has nothing to write
# through.
#
# THE ORDER MATTERS, AND THE OBVIOUS ORDER IS WRONG. `mv newdir link` does NOT replace the link --
# it moves newdir INSIDE the link's target, i.e. into the vendored repo (reproduced in a sandbox
# before writing this). `mv -T` refuses outright: rename(2) cannot put a directory over a symlink.
# So the link is REMOVED first (plain `rm`, never `-r`, never a trailing slash -- that removes the
# link and leaves the target untouched, also verified) and the staged copy moved into place after.
#
# Fail-safe: the staged copy is built and VERIFIED against the source hash-for-hash BEFORE the link
# is touched. If anything about a skill does not check out, that skill is left exactly as it was.
set -uo pipefail

SKILLS_DIR="${SKILLS_DIR:-$HOME/.claude/skills}"
PREFIX="${PREFIX:-sp-}"
MODE="${1:-apply}"

case "$MODE" in
  --check|--dry-run|apply|"") ;;
  *) echo "usage: $0 [--check|--dry-run]" >&2; exit 4 ;;
esac
[ -d "$SKILLS_DIR" ] || { echo "skills dir not found: $SKILLS_DIR" >&2; exit 4; }

converted=0; skipped=0; failed=0; would=0

hash_tree() { # $1 = dir; prints "relpath sha256" per file, sorted, following links
  find -L "$1" -type f -print0 2>/dev/null | sort -z | while IFS= read -r -d '' f; do
    printf '%s %s\n' "${f#"$1"/}" "$(sha256sum "$f" | cut -d' ' -f1)"
  done
}

for link in "$SKILLS_DIR/$PREFIX"*; do
  # -e FOLLOWS the link, so a DANGLING symlink tests false. Testing -L as well is what keeps a
  # broken entry visible instead of silently skipped -- found by the sandbox, not by reading.
  [ -e "$link" ] || [ -L "$link" ] || continue
  name="$(basename "$link")"

  if [ ! -L "$link" ]; then
    [ -d "$link" ] && { skipped=$((skipped + 1)); [ "$MODE" = "--check" ] && echo "already real  $name"; }
    continue
  fi

  target="$(readlink -f "$link")"
  if [ ! -d "$target" ]; then
    echo "SKIP $name -- link target is not a directory ($target)" >&2
    failed=$((failed + 1)); continue
  fi

  if [ "$MODE" = "--check" ] || [ "$MODE" = "--dry-run" ]; then
    echo "would convert  $name  ($(find -L "$link" -type f 2>/dev/null | wc -l) file(s)) -> real dir"
    would=$((would + 1)); continue
  fi

  staging="$SKILLS_DIR/.$name.realdir.$$"
  rm -rf "$staging"
  if ! cp -a "$target/." "$staging/" 2>/dev/null; then
    echo "FAIL $name -- copy failed, link left untouched" >&2
    rm -rf "$staging"; failed=$((failed + 1)); continue
  fi

  # Verify BEFORE touching the link: the staged copy must match the source exactly.
  if [ "$(hash_tree "$target")" != "$(hash_tree "$staging")" ]; then
    echo "FAIL $name -- staged copy does not match source, link left untouched" >&2
    rm -rf "$staging"; failed=$((failed + 1)); continue
  fi

  # Plain rm: removes the LINK, not the target. Never -r, never a trailing slash.
  if ! rm "$link"; then
    echo "FAIL $name -- could not remove link, nothing changed" >&2
    rm -rf "$staging"; failed=$((failed + 1)); continue
  fi
  if ! mv "$staging" "$link"; then
    echo "FAIL $name -- link removed but move failed; restoring the symlink" >&2
    ln -s "$target/" "$link" || echo "FAIL $name -- COULD NOT RESTORE, needs a human" >&2
    rm -rf "$staging"; failed=$((failed + 1)); continue
  fi
  converted=$((converted + 1))
done

if [ "$MODE" = "--check" ] || [ "$MODE" = "--dry-run" ]; then
  echo "would convert $would, already real $skipped, unusable $failed"
  exit 0
fi
echo "converted $converted, already real $skipped, failed $failed"
[ "$failed" -eq 0 ] || exit 1

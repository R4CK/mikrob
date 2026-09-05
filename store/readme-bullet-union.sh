#!/usr/bin/env bash
# Sourceable wrapper for store/readme-bullet-union.py (card 8b73953c).
# Kept in its own file, matching decisions-append-union.sh, so the wiring can be tested
# end-to-end against a REAL git merge conflict without executing the whole landing script.

# try_readme_bullet_union <worktree> <relative-file> (card 8b73953c): the README counterpart.
# Thin wrapper over store/readme-bullet-union.py, which does the actual decision -- Python
# because this is list-of-lines work and because the sibling bash implementation lost three
# review rounds to byte-versus-character indexing, a class that does not exist there.
# Returns 0 = resolved and `git add`-ed (the CALLER must still commit the merge), 1 = refused
# with nothing written and nothing staged.
try_readme_bullet_union() {
  local wt="$1" file="$2" tool tmp rc
  tool="$(dirname "${BASH_SOURCE[0]}")/readme-bullet-union.py"
  [ -f "$tool" ] || return 1
  tmp="$(mktemp -d)" || return 1
  git -C "$wt" show ":1:$file" >"$tmp/base" 2>/dev/null &&
  git -C "$wt" show ":2:$file" >"$tmp/ours" 2>/dev/null &&
  git -C "$wt" show ":3:$file" >"$tmp/theirs" 2>/dev/null || { rm -rf "$tmp"; return 1; }
  # Written to a staging path first, then moved into the worktree only on success: a refusal
  # must never leave a half-resolved file behind for the caller to commit.
  python3 "$tool" resolve "$tmp/base" "$tmp/ours" "$tmp/theirs" "$file" "$tmp/out"
  rc=$?
  if [ "$rc" -ne 0 ]; then rm -rf "$tmp"; return 1; fi
  cp "$tmp/out" "$wt/$file" && git -C "$wt" add "$file"
  rc=$?
  rm -rf "$tmp"
  return "$rc"
}

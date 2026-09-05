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

# NOT A MERGE DRIVER, AND THE REFUSAL IS LOUD (Cybersec, card 3ae71df1). Measured: this file is mode
# 775 and, invoked with three path arguments, returned 0 -- which is exactly `git merge.<name>.driver`
# calling convention (%O %A %B). Nothing wires it that way today, but nothing structural prevents it
# either: one `merge.*.driver` config line plus a .gitattributes entry would be enough, and the
# failure mode is SILENT DATA LOSS -- a driver that exits 0 tells git the merge succeeded, so git
# keeps %A (ours) and discards theirs, with no conflict and no message.
#
# A comment cannot prevent that; an exit code can. Direct execution with anything other than
# --selftest now fails loudly. Sourcing is unaffected (BASH_SOURCE differs from $0), which is how
# every real caller uses this file, and this file has no --selftest path of its own.
if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" != "--selftest" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): this file is a SOURCED helper, not an executable." >&2
  echo "  It takes no positional arguments. If you reached this from a git merge driver" >&2
  echo "  configuration, REMOVE IT: exiting 0 there would make git keep ours and silently" >&2
  echo "  discard theirs. Source it and call its function instead." >&2
  exit 2
fi


#!/usr/bin/env bash
# decisions-append-only-guard.sh -- card 61b6d4b1, QA FAIL (comment 7823) + MikroB delta-gate
# (comment 7825): DECISIONS.md's append-only invariant must be checked independent of whether git
# even reports a conflict.
#
# THE GAP THIS CLOSES. try_append_union (decisions-append-union.sh) and decisions-sync-resolve.sh
# both fire ONLY when git itself reports a CONFLICT on DECISIONS.md. A git three-way merge only
# conflicts when the two sides' changed hunks are ADJACENT/overlapping (within diff context) --
# two edits to DISTANT lines in the same file merge SILENTLY, with zero conflict, even when one
# side REWRITES or DELETES an existing line rather than appending. QA measured this live (comment
# 7823, card 61b6d4b1, repeated on both a synthetic fixture and a copy of the real 13582-line
# DECISIONS.md): a branch that rewrites an OLD, distant entry and a branch that appends a new one
# merge with ZERO conflicts, keeping both the rewritten AND the original text nowhere checked --
# not by the existing SEAM CHECK in mopsion-land.sh (which only verifies ADDED lines survive, and
# says nothing about a line that vanished or changed), not by try_append_union or
# decisions-sync-resolve.sh (neither ever runs, because there was no conflict to resolve).
#
# THE CHECK is therefore independent of conflict, independent of any merge driver, and looks at
# the finished MERGE COMMIT rather than at git's conflict machinery: given a merge commit with
# exactly two parents, if EITHER parent's own diff against the merge-base OF THE TWO PARENTS
# contains a removed line for the watched file (a real delete, or the delete-half of a rewrite),
# that side violated the append-only invariant -- regardless of whether the merge conflicted,
# auto-unioned, or resolved with nothing to see.
#
# WHAT IS NOT FILTERED (MikroB delta-gate condition 3): no whitespace/line-ending exception, and no
# comment/blank-line exception. A rewrite disguised as a whitespace-only edit still removes the OLD
# byte sequence and must still refuse; every '-' line in the diff counts, unfiltered.
#
# API (source this file to get the functions):
#   decisions_append_only_ok <repo> <base-sha> <tip-sha> [<file>]
#     0 (true) if tip's diff against base for <file> (default DECISIONS.md) is a PURE ADDITION
#     (zero removed/changed lines); 1 otherwise, printing the offending removed lines to stderr.
#
#   decisions_append_only_check_merge <repo> <merge-commit> [<file>]
#     resolves the merge commit's own two parents and the merge-base BETWEEN THEM, then runs the
#     check above on EACH parent. Prints one line per violating side to stdout; the return code is
#     the violation count (0 = clean, 1 or 2 = that many sides violated it). A commit that is not a
#     two-parent merge (0 or 1 parent) has nothing to check and returns 0 silently.
#
# CLI (there is no single landing script on the SYNC path to source this as a function -- an agent
# runs `git merge origin/main` by hand in their own worktree):
#   decisions-append-only-guard.sh --check-merge <repo> <merge-commit> [<file>]
#   decisions-append-only-guard.sh --check-last-merge [<repo>] [<file>]   (merge-commit = HEAD)
#   decisions-append-only-guard.sh --selftest
set -u

decisions_append_only_ok() {
  local repo="$1" base="$2" tip="$3" f="${4:-DECISIONS.md}"
  # The file did not exist yet at the merge-base -- nothing to protect (a brand-new file arriving
  # is not an append-only violation).
  git -C "$repo" cat-file -e "$base:$f" 2>/dev/null || return 0
  # This side deleted the file entirely -- a different failure mode than this check's job (the
  # existing SEAM CHECK in mopsion-land.sh already refuses a file whose OWN tip no longer carries
  # it, when the other side's tip still needs it).
  git -C "$repo" cat-file -e "$tip:$f" 2>/dev/null || return 0
  local removed
  # `^-[^-]|^-$` matches every genuine removed line (including a removed BLANK line, the `^-$`
  # half) while excluding the `--- a/file` diff header, which starts with TWO dashes.
  removed="$(git -C "$repo" diff "$base..$tip" -- "$f" | grep -E '^-[^-]|^-$')"
  [ -z "$removed" ] && return 0
  echo "$removed" | sed 's/^/    /' >&2
  return 1
}

decisions_append_only_check_merge() {
  local repo="$1" merge="$2" f="${3:-DECISIONS.md}"
  local parents
  parents="$(git -C "$repo" show -s --format='%P' "$merge" 2>/dev/null)"
  # shellcheck disable=SC2206
  local -a p=($parents)
  [ "${#p[@]}" -eq 2 ] || return 0 # not a two-parent merge commit -- nothing to check
  local mb
  mb="$(git -C "$repo" merge-base "${p[0]}" "${p[1]}" 2>/dev/null)" || return 0
  local violations=0 label tip
  for label in 1 2; do
    tip="${p[$((label - 1))]}"
    if ! decisions_append_only_ok "$repo" "$mb" "$tip" "$f"; then
      echo "APPEND-ONLY VIOLATION: parent $label ($tip) removed/rewrote an existing line in $f since the merge-base ($mb)"
      violations=$((violations + 1))
    fi
  done
  return "$violations"
}

# CLI DISPATCH ONLY WHEN EXECUTED, NEVER WHEN SOURCED (same guard as decisions-append-union.sh).
# Without this, mopsion-land.sh sourcing this file with "$1" = "--selftest" would trigger THIS
# file's own selftest at source time and exit the whole caller before it ever reached its own
# tests -- BASH_SOURCE differs from $0 only when the file is being read via `.`/`source`.
if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--check-merge" ]; then
  decisions_append_only_check_merge "$2" "$3" "${4:-DECISIONS.md}"
  exit $?
fi

if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--check-last-merge" ]; then
  R="${2:-$PWD}"
  decisions_append_only_check_merge "$R" "$(git -C "$R" rev-parse HEAD)" "${3:-DECISIONS.md}"
  exit $?
fi

if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--selftest" ]; then
  fail=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  ok() { echo "  ok   $1"; }
  no() { echo "  FAIL $1"; fail=1; }
  R="$tmp/repo"

  mk_repo() {
    rm -rf "$R"
    mkdir -p "$R"
    git -C "$R" init -q -b main
    git -C "$R" config user.email t@t
    git -C "$R" config user.name t
    git -C "$R" config commit.gpgsign false
    # A padded body between the entry that gets rewritten/deleted and the tail where the append
    # lands -- large enough that the two hunks fall OUTSIDE git's default 3-line diff context, so a
    # real 3-way merge treats them as non-overlapping and merges with ZERO conflict. This is the
    # exact shape QA measured live on the real 13582-line file (comment 7823): the bug this guard
    # exists for is invisible on a small fixture where the changes happen to sit close together.
    {
      printf '# DECISIONS\n\n## 2026-01-01 -- old entry\n\nDontes: Peti NO-GO a Z ugyre.\n\n'
      seq 1 40 | sed 's/^/padding line /'
      printf '\n'
    } >"$R/DECISIONS.md"
    git -C "$R" add DECISIONS.md
    git -C "$R" commit -qm base
  }

  # 1. distant rewrite + parallel append -> git merges with ZERO conflict, guard REFUSES.
  mk_repo
  git -C "$R" checkout -qb branch-rewrite
  sed -i 's/Dontes: Peti NO-GO a Z ugyre\./Dontes: Peti GO a Z ugyre./' "$R/DECISIONS.md"
  git -C "$R" commit -qam "rewrite old decision"
  git -C "$R" checkout -q main
  git -C "$R" checkout -qb branch-append main
  printf '\n## 2026-01-02 -- new entry\n\nSomething new.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "append new entry"
  git -C "$R" checkout -q branch-rewrite
  if git -C "$R" merge --no-ff branch-append -m merge -q >/tmp/merge-out-1.$$ 2>&1; then
    ok "distant rewrite + append merges with ZERO conflict (the bug this guard exists for)"
  else
    no "expected the distant case to merge cleanly -- fixture no longer reproduces the gap"
  fi
  rm -f /tmp/merge-out-1.$$
  merge_sha="$(git -C "$R" rev-parse HEAD)"
  out="$(decisions_append_only_check_merge "$R" "$merge_sha" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then ok "guard REFUSES the silently-merged distant rewrite"
  else no "guard should have refused; got rc=0, out=$out"; fi

  # 2. distant line DELETION (no rewrite) + parallel append -> also REFUSE.
  mk_repo
  git -C "$R" checkout -qb branch-delete
  sed -i '/^Dontes: Peti NO-GO a Z ugyre\.$/d' "$R/DECISIONS.md"
  git -C "$R" commit -qam "delete old decision line"
  git -C "$R" checkout -q main
  git -C "$R" checkout -qb branch-append2 main
  printf '\n## 2026-01-02 -- new entry\n\nSomething new.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "append new entry"
  git -C "$R" checkout -q branch-delete
  git -C "$R" merge --no-ff branch-append2 -m merge -q >/dev/null 2>&1
  merge_sha="$(git -C "$R" rev-parse HEAD)"
  decisions_append_only_check_merge "$R" "$merge_sha" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then ok "guard REFUSES a distant line deletion"
  else no "guard should have refused the deletion case"; fi

  # 3. pure append on BOTH sides -> PASS.
  mk_repo
  git -C "$R" checkout -qb branch-a
  printf '\n## 2026-01-02 -- entry A\n\nA appended this.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "branch-a appends"
  git -C "$R" checkout -q main
  git -C "$R" checkout -qb branch-b main
  printf '\n## 2026-01-03 -- entry B\n\nB appended this.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "branch-b appends"
  git -C "$R" checkout -q branch-a
  git -C "$R" merge --no-ff branch-b -m merge -q >/dev/null 2>&1
  merge_sha="$(git -C "$R" rev-parse HEAD)"
  decisions_append_only_check_merge "$R" "$merge_sha" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then ok "pure append on both sides PASSES"
  else no "pure append on both sides should pass, got rc=$rc"; fi

  # 4. a correction written as a brand-new appended entry (never editing the old text) -> PASS.
  mk_repo
  git -C "$R" checkout -qb branch-correction
  printf '\n## 2026-01-02 -- correction\n\nThe 2026-01-01 decision above was reversed: Peti GO.\n' \
    >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "correction as new entry"
  git -C "$R" checkout -q main
  git -C "$R" checkout -qb branch-other main
  printf '\n## 2026-01-03 -- unrelated entry\n\nSomething else.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "unrelated append"
  git -C "$R" checkout -q branch-correction
  git -C "$R" merge --no-ff branch-other -m merge -q >/dev/null 2>&1
  merge_sha="$(git -C "$R" rev-parse HEAD)"
  decisions_append_only_check_merge "$R" "$merge_sha" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then ok "a correction filed as a new entry PASSES"
  else no "a correction-as-new-entry should pass, got rc=$rc"; fi

  # 5. a whitespace-only rewrite of an EXISTING line is NOT a bypass (delta-gate condition 3).
  mk_repo
  git -C "$R" checkout -qb branch-ws
  sed -i 's/Dontes: Peti NO-GO a Z ugyre\./Dontes: Peti NO-GO a Z ugyre. /' "$R/DECISIONS.md"
  git -C "$R" commit -qam "trailing whitespace on old decision"
  git -C "$R" checkout -q main
  git -C "$R" checkout -qb branch-append3 main
  printf '\n## 2026-01-02 -- new entry\n\nSomething new.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "append new entry"
  git -C "$R" checkout -q branch-ws
  git -C "$R" merge --no-ff branch-append3 -m merge -q >/dev/null 2>&1
  merge_sha="$(git -C "$R" rev-parse HEAD)"
  decisions_append_only_check_merge "$R" "$merge_sha" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then ok "a whitespace-only rewrite of an existing line is still REFUSED"
  else no "whitespace-only rewrite must not bypass the guard"; fi

  # 6. a non-merge commit (0 or 1 parent) has nothing to check -> returns 0 silently.
  mk_repo
  head_sha="$(git -C "$R" rev-parse HEAD)"
  decisions_append_only_check_merge "$R" "$head_sha" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then ok "a non-merge commit returns 0 (nothing to check)"
  else no "a non-merge commit should return 0, got rc=$rc"; fi

  if [ "$fail" -eq 0 ]; then echo "selftest: PASS"; else echo "selftest: FAIL"; fi
  exit "$fail"
fi

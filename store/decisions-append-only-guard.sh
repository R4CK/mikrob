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
# byte sequence and must still refuse; every removed line counts, unfiltered.
#
# 2026-09-27 CORRECTION (Cybersec NO-GO comment 7937, confirmed by QA FAIL comment 7941, card
# 61b6d4b1): the original implementation used `grep -E '^-[^-]|^-$'` on a plain `git diff`, which
# has to exclude any removed line starting with TWO dashes to skip the `--- a/file` diff header --
# but that same exclusion silently swallows a removed line whose own CONTENT starts with '-' (a
# markdown bullet renders as `-- bullet text` in the diff, P1; a literal '--' line renders as
# `--- ...`, P2) -- measured live: 551 of 14181 lines in the real DECISIONS.md start with '-', 92
# of those with '--'. The same code also `return 0`-ed when the file was absent at tip (P3, a full
# `git rm` sailed through as "nothing to check"), and produced zero visible '-' lines when
# `.gitattributes` marked the path `-diff` (P5, git reports "Binary files differ" instead of a
# line diff). Fixed: removed-line COUNT via `git diff --numstat` (immune to what the removed text
# looks like) with `--text` (forces line-based diffing even under a binary/-diff attribute) and
# `--no-textconv --no-ext-diff` (no configured filter reshapes the bytes first); file-present-at-
# base-but-absent-at-tip is now an explicit violation, not a `return 0`.
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
  # This side deleted the file entirely: that IS a violation (the ultimate line removal), not a
  # different failure mode to defer to the seam check (Cybersec comment 7937, P3 -- the old
  # `|| return 0` here let a full `git rm` of DECISIONS.md sail through as "nothing to check").
  if ! git -C "$repo" cat-file -e "$tip:$f" 2>/dev/null; then
    echo "    (file deleted entirely: present at $base:$f, absent at $tip:$f)" >&2
    return 1
  fi
  # Removed-line COUNT via --numstat, not a line-prefix regex (Cybersec comment 7937, P1/P2/P5).
  # A `^-[^-]|^-$` grep on a plain diff must exclude any removed line starting with two dashes to
  # skip the `--- a/file` header -- which also silently excludes a removed line whose own CONTENT
  # starts with '-': a markdown bullet ('- item') renders as `-- item` in the diff (P1), a literal
  # '--' line renders as `--- ...` (P2). `--text` forces line-based diffing even when
  # .gitattributes marks the path binary/-diff (P5: git reports "Binary files differ", zero '-'
  # lines to grep). `--no-textconv --no-ext-diff` stop any configured filter from reshaping the
  # bytes first. A count is immune to what the removed text looks like; a prefix match is not.
  local removed
  removed="$(git -C "$repo" -c color.ui=never diff --no-ext-diff --no-textconv --text --numstat \
    "$base" "$tip" -- "$f" | awk '{print $2}')"
  [ -z "$removed" ] && removed=0
  if [ "$removed" != 0 ]; then
    git -C "$repo" -c color.ui=never diff --no-ext-diff --no-textconv --text "$base" "$tip" -- "$f" \
      | grep -E '^-' | sed 's/^/    /' >&2
    return 1
  fi
  return 0
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

  # 7. P1 (Cybersec comment 7937): distant REMOVAL of a markdown bullet line ('- ...') + parallel
  # append -> merges with zero conflict (same distant-hunk shape as tests 1/2), and the OLD regex
  # silently passed this because the diff line ('-- Bullet line...') starts with two dashes, which
  # the old code excluded to skip the '--- a/file' header. Must now REFUSE.
  mk_repo
  git -C "$R" checkout -qb branch-bullet
  sed -i '1i # DECISIONS placeholder' "$R/DECISIONS.md" >/dev/null 2>&1 || true
  # Reset to a fixture that includes a bullet line before the padding, distant from the tail append.
  {
    printf '# DECISIONS\n\n## 2026-01-01 -- old entry\n\n- Bullet line that will be removed\n- Another bullet kept\n\n'
    seq 1 40 | sed 's/^/padding line /'
    printf '\n'
  } >"$R/DECISIONS.md"
  git -C "$R" commit -qam "seed bullet fixture"
  git -C "$R" checkout -qb branch-bullet-del branch-bullet
  sed -i '/^- Bullet line that will be removed$/d' "$R/DECISIONS.md"
  git -C "$R" commit -qam "remove bullet line (distant)"
  git -C "$R" checkout -q branch-bullet
  git -C "$R" checkout -qb branch-append-bullet branch-bullet
  printf '\n## 2026-01-02 -- new entry\n\nSomething new.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "append new entry"
  git -C "$R" checkout -q branch-bullet-del
  git -C "$R" merge --no-ff branch-append-bullet -m merge -q >/dev/null 2>&1
  merge_sha="$(git -C "$R" rev-parse HEAD)"
  decisions_append_only_check_merge "$R" "$merge_sha" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then ok "P1: removed markdown-bullet line is REFUSED (regex used to miss it)"
  else no "P1 REGRESSION: bullet-line removal bypassed the guard (Cybersec 7937)"; fi

  # 8. P2 (Cybersec comment 7937): distant removal of a line whose content ITSELF starts with two
  # dashes ('-- literal'), which renders as `--- literal` in the diff -- three dashes, so the old
  # regex's header-exclusion swallowed it just as thoroughly as the single-dash bullet case.
  git -C "$R" checkout -qb branch-dashdash main
  {
    printf '# DECISIONS\n\n## 2026-01-01 -- old entry\n\n-- Literal double-dash marker line\n\n'
    seq 1 40 | sed 's/^/padding line /'
    printf '\n'
  } >"$R/DECISIONS.md"
  git -C "$R" commit -qam "seed dashdash fixture"
  git -C "$R" checkout -qb branch-dashdash-del branch-dashdash
  sed -i '/^-- Literal double-dash marker line$/d' "$R/DECISIONS.md"
  git -C "$R" commit -qam "remove double-dash line (distant)"
  git -C "$R" checkout -q branch-dashdash
  git -C "$R" checkout -qb branch-append-dashdash branch-dashdash
  printf '\n## 2026-01-02 -- new entry\n\nSomething new.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "append new entry"
  git -C "$R" checkout -q branch-dashdash-del
  git -C "$R" merge --no-ff branch-append-dashdash -m merge -q >/dev/null 2>&1
  merge_sha="$(git -C "$R" rev-parse HEAD)"
  decisions_append_only_check_merge "$R" "$merge_sha" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then ok "P2: removed double-dash-prefixed line is REFUSED"
  else no "P2 REGRESSION: double-dash-line removal bypassed the guard (Cybersec 7937)"; fi

  # 9. P3 (Cybersec comment 7937): one side deletes DECISIONS.md entirely (git rm), the other
  # appends. The old code's `|| return 0` on the tip cat-file check treated "file absent" as
  # "nothing to protect" instead of the ultimate line removal. Built with commit-tree (not a real
  # merge) because a modify/delete is a genuine git conflict with no clean auto-resolution to
  # fixture -- the check only reads the two PARENTS against their merge-base, never the merge
  # commit's own tree, so a synthetic two-parent commit is a faithful equivalent.
  mk_repo
  git -C "$R" checkout -qb branch-fulldelete
  git -C "$R" rm -q DECISIONS.md
  git -C "$R" commit -qam "remove DECISIONS.md entirely"
  del_sha="$(git -C "$R" rev-parse HEAD)"
  git -C "$R" checkout -q main
  git -C "$R" checkout -qb branch-append-fd main
  printf '\n## 2026-01-02 -- new entry\n\nSomething new.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "append new entry"
  append_sha="$(git -C "$R" rev-parse HEAD)"
  tree="$(git -C "$R" rev-parse "$append_sha^{tree}")"
  merge_sha="$(git -C "$R" commit-tree "$tree" -p "$del_sha" -p "$append_sha" -m merge)"
  decisions_append_only_check_merge "$R" "$merge_sha" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then ok "P3: full-file deletion is REFUSED (not silently passed)"
  else no "P3 REGRESSION: full-file deletion bypassed the guard (Cybersec 7937)"; fi

  # 10. P5 (Cybersec comment 7937): .gitattributes marks DECISIONS.md `-diff`, so a plain `git
  # diff` reports "Binary files ... differ" with ZERO '-' lines to grep even though a distant
  # rewrite really happened -- the old regex-on-plain-diff approach had nothing to match and
  # silently passed. `--text` on the new numstat call forces line-based diffing regardless of the
  # attribute.
  rm -rf "$R"
  mkdir -p "$R"
  git -C "$R" init -q -b main
  git -C "$R" config user.email t@t
  git -C "$R" config user.name t
  git -C "$R" config commit.gpgsign false
  printf 'DECISIONS.md -diff\n' >"$R/.gitattributes"
  {
    printf '# DECISIONS\n\n## 2026-01-01 -- old entry\n\nDontes: Peti NO-GO a Z ugyre.\n\n'
    seq 1 40 | sed 's/^/padding line /'
    printf '\n'
  } >"$R/DECISIONS.md"
  git -C "$R" add DECISIONS.md .gitattributes
  git -C "$R" commit -qm base
  base_sha="$(git -C "$R" rev-parse HEAD)"
  git -C "$R" checkout -qb branch-attr-rewrite
  sed -i 's/Dontes: Peti NO-GO a Z ugyre\./Dontes: Peti GO a Z ugyre./' "$R/DECISIONS.md"
  git -C "$R" commit -qam "rewrite old decision under -diff attribute"
  rewrite_sha="$(git -C "$R" rev-parse HEAD)"
  # sanity: confirm this fixture really reproduces the P5 gap (a plain diff+grep finds nothing),
  # not just a copy of test 1 under a new name.
  if git -C "$R" diff "$base_sha..$rewrite_sha" -- DECISIONS.md 2>/dev/null | grep -qE '^-[^-]|^-$'; then
    no "P5 fixture invalid: -diff attribute did not suppress the plain line diff as expected"
  else
    ok "P5 fixture confirmed: -diff attribute hides the rewrite from a plain 'git diff' grep"
  fi
  git -C "$R" checkout -q main
  git -C "$R" checkout -qb branch-append-attr main
  printf '\n## 2026-01-02 -- new entry\n\nSomething new.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "append new entry"
  git -C "$R" checkout -q branch-attr-rewrite
  git -C "$R" merge --no-ff branch-append-attr -m merge -q >/dev/null 2>&1
  merge_sha="$(git -C "$R" rev-parse HEAD)"
  decisions_append_only_check_merge "$R" "$merge_sha" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then ok "P5: -diff-attributed rewrite is REFUSED (--text bypasses the attribute)"
  else no "P5 REGRESSION: -diff attribute let a rewrite bypass the guard (Cybersec 7937)"; fi

  if [ "$fail" -eq 0 ]; then echo "selftest: PASS"; else echo "selftest: FAIL"; fi
  exit "$fail"
fi

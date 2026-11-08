#!/usr/bin/env bash
# decisions-tail-append-guard.sh -- card 375a81c1: DECISIONS.md's real invariant is not just
# "nothing removed" (decisions-append-only-guard.sh already covers that), it is "new content only
# ever lands at the TAIL". Five mopsion landings in one morning (9d3ebe9e, fc11dd82, 2cd88790,
# 3f4545ab, 6e730b11) failed on a real git conflict even though BOTH sides were pure additions with
# zero deletions -- decisions-append-union.sh (the auto-union) correctly refused every one of them,
# because neither side's insertion point was the tail: each branch spliced its new entry into the
# MIDDLE of the file, right next to the earlier entry it continues, instead of appending it after
# the last line. Two branches inserting at the same (or an adjacent) mid-file point is a real git
# conflict -- adjacent/overlapping hunks -- not the append-append shape the union tool exists for.
#
# THE ONLY FIX THAT CLOSES THIS AT THE SOURCE is the convention itself (see the project-decisions-log
# skill and the root CLAUDE.md Dontesnaplo rule, both updated alongside this file): a new entry,
# including a delta/continuation of an earlier one, always goes at the file's own end, referencing
# the parent entry by its date/title instead of sitting next to it. This script is the structural
# check for that convention -- it does not repair a mid-file insertion (there is nothing safe to
# auto-fix: which of two branches' entry is "the real tail" is exactly the question a human answers
# by choosing where to put theirs), it only catches the violation EARLY, on a SINGLE branch, before
# a landing attempt ever reaches the merge machinery -- so the error an agent sees points at their
# own branch's insertion point, not at a conflict-marker dump three steps downstream.
#
# THE CHECK: given a branch tip and the merge-base it forked from, the branch's own version of the
# file must have the merge-base's FULL CONTENT as a byte-exact PREFIX. If it does, everything the
# branch added is strictly after everything the base already had -- a pure tail append, no matter
# how many entries. If it does not, the first byte where they diverge sits somewhere the base still
# had content of its own, which is only possible if the branch inserted (or removed, or reordered)
# something before the base's own end -- exactly the mid-file-splice shape this guard exists to
# catch. A file absent at the merge-base is not a violation (a brand-new file has no tail to violate).
#
# WHY A BYTE-PREFIX CHECK, not a "no lines removed" check: decisions-append-only-guard.sh already
# proves the WEAKER property (no line vanished). This guard proves the STRONGER one (every new byte
# comes after every old byte) using the exact same primitive decisions-append-union.sh's own
# _common_line_prefix_len was built to make cheap on a 447 KB file: `cmp` finds the first differing
# byte in one C-speed pass, so this never pays the O(n^2) bash-substring cost that card d56786a7
# measured at 405 seconds on the real file.
#
# API (source this file to get the function):
#   decisions_tail_append_ok <repo> <base-sha> <tip-sha> [<file> [<allow_archive>]]
#     0 (true)  if <file> did not exist at <base-sha> (nothing to violate), OR the file at
#               <base-sha> is a byte-exact prefix of the file at <tip-sha>, OR
#               allow_archive=1 AND the archive exception passes (see below).
#     1 (false) otherwise -- prints the first line at which the two diverge, and the reminder to
#               move the new entry to the tail, to stderr.
#
# ARCHIVING EXCEPTION (card acffb1d6): the project-decisions-log skill prescribes that entries
# older than 90 days are moved from DECISIONS.md's beginning into a DECISIONS-ARCHIVE-<YYYY>-Q<N>.md
# file.  After that move the merge-base is no longer a byte-exact prefix of the branch file, so the
# guard would refuse the archiving commit.  The caller enables the exception by passing allow_archive=1
# as the 5th argument (or --allow-archive on the CLI).  This is an EXPLICIT, LOGGED call-site option
# -- not an env var -- so no caller can silently disable the guard by setting an exported variable.
#
# Archive exception conditions (all required):
#   (a) A DECISIONS-ARCHIVE-<YYYY>-Q<N>.md file at the REPO ROOT appears in
#       `git diff --name-only <base> <tip>` (added or extended by this commit).
#   (b) The archive file only grew: its first archive_base_len bytes at tip match the entire
#       base version (the existing archive is a byte-exact prefix of the tip archive).
#   (c) The leading block removed from DECISIONS.md (base[0..N]) equals the bytes appended to the
#       archive (archive_tip[archive_base_len..]).
#   (d) The remainder of DECISIONS.md at base (base[N..]) is a byte-exact prefix of the tip
#       DECISIONS.md (the tail-append invariant still holds for everything that was not moved).
#
# CLI:
#   decisions-tail-append-guard.sh --check-branch <repo> <base-sha> <tip-sha> [<file>]
#   decisions-tail-append-guard.sh --check-branch --allow-archive <repo> <base-sha> <tip-sha> [<file>]
#   decisions-tail-append-guard.sh --selftest
set -u

# _decisions_check_archive <repo> <base> <tip> <decisions-file> <base_len>
# Returns 0 if the archive exception is satisfied, 1 otherwise.
# Writes one diagnostic line to stderr on success (logged per-use as required).
_decisions_check_archive() {
  local repo="$1" base="$2" tip="$3" f="$4" base_len="$5"

  # (a) Find root-anchored archive files that appear in this commit's diff.
  local changed_archives
  changed_archives="$(git -C "$repo" diff --name-only "$base" "$tip" 2>/dev/null \
    | grep -E '^DECISIONS-ARCHIVE-[0-9]{4}-Q[1-4]\.md$' || true)"
  if [ -z "$changed_archives" ]; then
    echo "    Archive exception: no DECISIONS-ARCHIVE-<YYYY>-Q<N>.md at repo root was added/extended by this commit." >&2
    echo "    (Changed files in diff: $(git -C "$repo" diff --name-only "$base" "$tip" 2>/dev/null | tr '\n' ' '))" >&2
    return 1
  fi

  local archive archive_base_len archive_tip_len removed_block_len remainder_len
  while IFS= read -r archive; do
    [ -z "$archive" ] && continue

    # Get archive size at base (0 if new file) and at tip.
    archive_base_len=0
    if git -C "$repo" cat-file -e "$base:$archive" 2>/dev/null; then
      archive_base_len="$(git -C "$repo" cat-file -s "$base:$archive" 2>/dev/null)" || archive_base_len=0
    fi
    archive_tip_len="$(git -C "$repo" cat-file -s "$tip:$archive" 2>/dev/null 2>/dev/null)" || continue

    # Archive must have grown (tip > base, not shrunk or empty-to-empty).
    if [ "$archive_tip_len" -le "$archive_base_len" ]; then
      echo "    Archive exception: $archive did not grow (base=$archive_base_len tip=$archive_tip_len bytes). Skipping." >&2
      continue
    fi
    removed_block_len=$(( archive_tip_len - archive_base_len ))

    # (b) Verify the existing archive content was not rewritten: first archive_base_len bytes of
    #     tip archive must equal the entire base archive blob.
    if [ "$archive_base_len" -gt 0 ]; then
      if ! cmp -s \
        <(git -C "$repo" cat-file blob "$base:$archive" 2>/dev/null) \
        <(git -C "$repo" cat-file blob "$tip:$archive" 2>/dev/null | head -c "$archive_base_len"); then
        echo "    Archive exception: $archive was rewritten (not just extended). Skipping." >&2
        continue
      fi
    fi

    # (c) The appended block in the archive must equal the leading block removed from DECISIONS.md.
    if ! cmp -s \
      <(git -C "$repo" cat-file blob "$base:$f" 2>/dev/null | head -c "$removed_block_len") \
      <(git -C "$repo" cat-file blob "$tip:$archive" 2>/dev/null | tail -c "$removed_block_len"); then
      echo "    Archive exception: leading $removed_block_len bytes of base $f do not match what was appended to $archive. Skipping." >&2
      continue
    fi

    # (d) The remainder of base DECISIONS.md (after the removed block) must be a byte-exact
    #     prefix of the tip DECISIONS.md.
    remainder_len=$(( base_len - removed_block_len ))
    if [ "$remainder_len" -gt 0 ]; then
      if ! cmp -s \
        <(git -C "$repo" cat-file blob "$base:$f" 2>/dev/null | tail -c "+$((removed_block_len + 1))") \
        <(git -C "$repo" cat-file blob "$tip:$f" 2>/dev/null | head -c "$remainder_len"); then
        echo "    Archive exception: the portion of base $f after the archived block is not preserved at the tip. Skipping." >&2
        continue
      fi
    fi

    # All four conditions met -- log per-use and return success.
    printf '    Archive exception accepted: %d bytes moved from leading %s to %s (allow-archive explicitly passed, commit %s)\n' \
      "$removed_block_len" "$f" "$archive" "$tip" >&2
    return 0
  done <<< "$changed_archives"

  echo "    Archive exception: none of the changed archive files contains the exact removed leading block of $f." >&2
  return 1
}

decisions_tail_append_ok() {
  local repo="$1" base="$2" tip="$3" f="${4:-DECISIONS.md}" allow_archive="${5:-0}"
  # New file at this branch, absent at the merge-base -- nothing to violate.
  git -C "$repo" cat-file -e "$base:$f" 2>/dev/null || return 0
  if ! git -C "$repo" cat-file -e "$tip:$f" 2>/dev/null; then
    echo "    $f existed at $base but was deleted entirely by $tip" >&2
    return 1
  fi
  local base_len
  base_len="$(git -C "$repo" cat-file -s "$base:$f" 2>/dev/null)" || return 1
  # An empty base file is trivially a prefix of anything -- nothing to compare.
  [ "$base_len" -eq 0 ] && return 0
  # Byte-exact prefix check via cmp (C-speed, immune to the bash O(n^2) substring trap this file's
  # sibling union tool already paid for once): the first $base_len bytes of tip's blob must be
  # byte-identical to base's whole blob. `head -c` on the tip's own stream, not a second full
  # checkout -- both sides read straight from git's object store.
  if git -C "$repo" cat-file blob "$base:$f" 2>/dev/null | \
     cmp -s - <(git -C "$repo" cat-file blob "$tip:$f" 2>/dev/null | head -c "$base_len"); then
    return 0
  fi
  # ARCHIVING EXCEPTION (card acffb1d6): entries distilled from the beginning of DECISIONS.md
  # into a DECISIONS-ARCHIVE-*.md file break the byte-exact prefix invariant.  Accept this iff
  # the caller explicitly passed allow_archive=1 AND all four archive-exception conditions hold.
  # Note: allow_archive is a function parameter, not an env var -- callers cannot bypass silently.
  if [ "$allow_archive" = "1" ]; then
    if _decisions_check_archive "$repo" "$base" "$tip" "$f" "$base_len"; then
      return 0
    fi
    echo "    Archive exception conditions not met. Fail-closed." >&2
    return 1
  fi
  echo "    DECISIONS.md tail-append violation: $tip's version of $f does not have $base's" >&2
  echo "    content as a byte-exact prefix -- something was inserted, removed, or reordered" >&2
  echo "    BEFORE the base's own end, not appended strictly after it." >&2
  echo "    Fix: move the new/continued entry to the VERY END of the file, referencing the" >&2
  echo "    parent entry by its date/title instead of inserting next to it." >&2
  echo "    If this is a 90-day distillation commit (project-decisions-log skill), pass" >&2
  echo "    allow_archive=1 as the 5th argument to decisions_tail_append_ok, or use" >&2
  echo "    --allow-archive on the CLI.  The archive exception requires that the removed leading" >&2
  echo "    bytes appear verbatim in a root-anchored DECISIONS-ARCHIVE-<YYYY>-Q<N>.md file that" >&2
  echo "    this commit adds or extends." >&2
  return 1
}

# CLI DISPATCH ONLY WHEN EXECUTED, NEVER WHEN SOURCED (same guard as the sibling DECISIONS.md
# scripts -- BASH_SOURCE differs from $0 only when the file is read via `.`/`source`).
if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--check-branch" ]; then
  shift  # consume --check-branch
  _cli_allow_archive=0
  if [ "${1:-}" = "--allow-archive" ]; then
    _cli_allow_archive=1
    shift
  fi
  decisions_tail_append_ok "$1" "$2" "$3" "${4:-DECISIONS.md}" "$_cli_allow_archive"
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
    printf '# DECISIONS\n\n## 2026-01-01 -- old entry\n\nDontes: Peti NO-GO a Z ugyre.\n\n' \
      >"$R/DECISIONS.md"
    git -C "$R" add DECISIONS.md
    git -C "$R" commit -qm base
  }

  # 1. pure tail append -> PASS.
  mk_repo
  base_sha="$(git -C "$R" rev-parse HEAD)"
  printf '## 2026-01-02 -- new entry\n\nSomething new.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "tail append"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" 2>/tmp/dtag-out.$$; then
    ok "pure tail append PASSES"
  else
    no "pure tail append should pass: $(cat /tmp/dtag-out.$$)"
  fi
  rm -f /tmp/dtag-out.$$

  # 2. mid-file insertion right after the entry it continues, with REAL content still following it
  # -- the exact shape this card measured (6e730b11: a delta-entry spliced in behind its parent,
  # with more of the file after that point, not at the tail) -> REFUSE. A fixture with nothing
  # after the insertion point would collapse into a tail append by construction (test 1's shape),
  # so padding after the entry is what makes this genuinely mid-file.
  mk_repo
  {
    printf '\n## 2026-02-01 -- later entry\n\nSomething filed after the one above.\n'
    seq 1 20 | sed 's/^/padding line /'
    printf '\n'
  } >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "seed padding after the old entry"
  base_sha="$(git -C "$R" rev-parse HEAD)"
  sed -i '/^Dontes: Peti NO-GO a Z ugyre\.$/a \\n## 2026-01-15 -- delta of the entry above\n\nMore detail, inserted right behind the parent instead of at the tail.' "$R/DECISIONS.md"
  git -C "$R" commit -qam "mid-file splice next to parent entry"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" >/dev/null 2>&1; then
    no "mid-file splice next to the parent entry should be REFUSED"
  else
    ok "mid-file splice next to the parent entry is REFUSED"
  fi

  # 3. two entries appended at the tail, in sequence -> still PASS (multiple appends, one commit).
  mk_repo
  base_sha="$(git -C "$R" rev-parse HEAD)"
  printf '## 2026-01-02 -- entry A\n\nA.\n\n## 2026-01-03 -- entry B\n\nB.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "two tail appends"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" >/dev/null 2>&1; then
    ok "two entries appended at the tail in one commit PASSES"
  else
    no "two tail appends in one commit should pass"
  fi

  # 4. a distant rewrite of an old entry (no tail append at all) -> REFUSE (this guard also catches
  # what decisions-append-only-guard.sh catches, from the branch side rather than the merge side).
  mk_repo
  base_sha="$(git -C "$R" rev-parse HEAD)"
  sed -i 's/Dontes: Peti NO-GO a Z ugyre\./Dontes: Peti GO a Z ugyre./' "$R/DECISIONS.md"
  git -C "$R" commit -qam "rewrite old decision, no append"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" >/dev/null 2>&1; then
    no "a distant rewrite with no tail append should be REFUSED"
  else
    ok "a distant rewrite with no tail append is REFUSED"
  fi

  # 5. brand-new file at tip, absent at base -> PASS (nothing to violate).
  mk_repo
  git -C "$R" rm -q DECISIONS.md
  git -C "$R" commit -qam "remove DECISIONS.md for this fixture"
  base_sha="$(git -C "$R" rev-parse HEAD)"
  printf '# DECISIONS\n\n## 2026-01-01 -- first entry ever\n\nFirst.\n' >"$R/DECISIONS.md"
  git -C "$R" add DECISIONS.md
  git -C "$R" commit -qam "add DECISIONS.md for the first time"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" >/dev/null 2>&1; then
    ok "a brand-new file absent at base PASSES"
  else
    no "a brand-new file absent at base should pass"
  fi

  # 6. full deletion of an existing file -> REFUSE (the ultimate non-append).
  mk_repo
  base_sha="$(git -C "$R" rev-parse HEAD)"
  git -C "$R" rm -q DECISIONS.md
  git -C "$R" commit -qam "delete DECISIONS.md entirely"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" >/dev/null 2>&1; then
    no "full deletion of an existing DECISIONS.md should be REFUSED"
  else
    ok "full deletion of an existing DECISIONS.md is REFUSED"
  fi

  # 7. empty base file -> trivially a prefix, PASS.
  rm -rf "$R"; mkdir -p "$R"
  git -C "$R" init -q -b main
  git -C "$R" config user.email t@t; git -C "$R" config user.name t
  git -C "$R" config commit.gpgsign false
  : >"$R/DECISIONS.md"
  git -C "$R" add DECISIONS.md
  git -C "$R" commit -qm "empty base"
  base_sha="$(git -C "$R" rev-parse HEAD)"
  printf '# DECISIONS\n\n## 2026-01-01 -- first entry\n\nFirst.\n' >"$R/DECISIONS.md"
  git -C "$R" commit -qam "fill in the first entry"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" >/dev/null 2>&1; then
    ok "an empty base file PASSES (trivially a prefix)"
  else
    no "an empty base file should pass"
  fi

  # 8. HONEST archiving commit: entire base moved byte-for-byte to archive, new entry appended,
  # allow_archive=1 passed explicitly as function parameter -> PASS.
  # Write archive using git cat-file blob to avoid shell $() trailing-newline stripping.
  mk_repo
  base_sha="$(git -C "$R" rev-parse HEAD)"
  archive_f="$R/DECISIONS-ARCHIVE-2026-Q1.md"
  git -C "$R" cat-file blob "${base_sha}:DECISIONS.md" >"$archive_f"
  printf '<!-- Korábbi bejegyzések: DECISIONS-ARCHIVE-2026-Q1.md -->\n\n' >"$R/DECISIONS.md"
  printf '## 2026-04-01 -- new entry after distillation\n\nSomething new.\n' >>"$R/DECISIONS.md"
  git -C "$R" add DECISIONS.md "$archive_f"
  git -C "$R" commit -qam "docs(decisions): distill entries older than 90 days into archive"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" DECISIONS.md 1 >/dev/null 2>&1; then
    ok "honest archiving commit with allow_archive=1 PASSES"
  else
    no "honest archiving commit with allow_archive=1 should pass"
  fi

  # 9. same archiving commit WITHOUT allow_archive -> REFUSE.
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" >/dev/null 2>&1; then
    no "archiving commit without allow_archive should be REFUSED"
  else
    ok "archiving commit without allow_archive is REFUSED"
  fi

  # 10. allow_archive=1 but no DECISIONS-ARCHIVE-*.md in this commit's diff -> REFUSE (fail-closed).
  # (Entries removed from DECISIONS.md but nothing placed into an archive file at all.)
  mk_repo
  base_sha="$(git -C "$R" rev-parse HEAD)"
  printf '<!-- Korábbi bejegyzések: DECISIONS-ARCHIVE-2026-Q1.md -->\n\n' >"$R/DECISIONS.md"
  printf '## 2026-04-01 -- new entry\n\nSomething.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "entries removed but NOT placed in archive file"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" DECISIONS.md 1 >/dev/null 2>&1; then
    no "allow_archive=1 but no archive file in diff should be REFUSED"
  else
    ok "allow_archive=1 without archive file in diff is REFUSED"
  fi

  # -- Cybersec S2-S5 fixture cases (card acffb1d6, comment 29359) --

  # 11. S2: entries A and B removed, an EMPTY archive file added in the same commit -> REFUSE.
  # Empty archive means archive_tip_len=0 (or not > archive_base_len=0), so archive did not grow.
  mk_repo
  base_sha="$(git -C "$R" rev-parse HEAD)"
  printf '<!-- Korábbi bejegyzések: DECISIONS-ARCHIVE-2026-Q1.md -->\n\n' >"$R/DECISIONS.md"
  printf '## 2026-04-01 -- new\n\nNew.\n' >>"$R/DECISIONS.md"
  : >"$R/DECISIONS-ARCHIVE-2026-Q1.md"  # empty archive
  git -C "$R" add DECISIONS.md DECISIONS-ARCHIVE-2026-Q1.md
  git -C "$R" commit -qam "S2: removed entries, empty archive"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" DECISIONS.md 1 >/dev/null 2>&1; then
    no "S2: removed entries + empty archive should be REFUSED"
  else
    ok "S2: removed entries + empty archive is REFUSED"
  fi

  # 12. S3: entries removed, but archive file already existed at base and was NOT changed -> REFUSE.
  # A pre-existing archive untouched by this commit does not appear in git diff --name-only.
  mk_repo
  printf '\nFiller archive entry.\n' >"$R/DECISIONS-ARCHIVE-2025-Q4.md"
  git -C "$R" add DECISIONS-ARCHIVE-2025-Q4.md
  git -C "$R" commit -qam "pre-existing archive"
  base_sha="$(git -C "$R" rev-parse HEAD)"
  printf '<!-- Korábbi bejegyzések: DECISIONS-ARCHIVE-2025-Q4.md -->\n\n' >"$R/DECISIONS.md"
  printf '## 2026-04-01 -- new\n\nNew.\n' >>"$R/DECISIONS.md"
  # Archive file not touched in this commit
  git -C "$R" commit -qam "S3: entries removed, pre-existing archive not in diff"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" DECISIONS.md 1 >/dev/null 2>&1; then
    no "S3: pre-existing unchanged archive should be REFUSED"
  else
    ok "S3: pre-existing unchanged archive is REFUSED"
  fi

  # 13. S4: entry A's approval text rewritten in place, plus an empty archive file -> REFUSE.
  # Rewrite is not a "removed leading block"; archive is empty so it didn't grow.
  mk_repo
  base_sha="$(git -C "$R" rev-parse HEAD)"
  sed -i 's/Dontes: Peti NO-GO a Z ugyre\./Dontes: Peti APPROVED the Z matter./' "$R/DECISIONS.md"
  : >"$R/DECISIONS-ARCHIVE-2026-Q1.md"
  git -C "$R" add DECISIONS.md DECISIONS-ARCHIVE-2026-Q1.md
  git -C "$R" commit -qam "S4: rewrite in-place + empty archive"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" DECISIONS.md 1 >/dev/null 2>&1; then
    no "S4: in-place rewrite + empty archive should be REFUSED"
  else
    ok "S4: in-place rewrite + empty archive is REFUSED"
  fi

  # 14. S5: entries reordered, archive file at a non-root path -> REFUSE.
  # Only root-anchored DECISIONS-ARCHIVE-<YYYY>-Q<N>.md counts.
  mk_repo
  {
    printf '\n## 2026-02-01 -- second entry\n\nSecond.\n'
  } >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "seed second entry"
  base_sha="$(git -C "$R" rev-parse HEAD)"
  # Reorder entries (swap first and second)
  printf '# DECISIONS\n\n## 2026-02-01 -- second entry\n\nSecond.\n\n## 2026-01-01 -- old entry\n\nDontes: Peti NO-GO a Z ugyre.\n\n' \
    >"$R/DECISIONS.md"
  mkdir -p "$R/some/dir"
  printf 'archive content\n' >"$R/some/dir/DECISIONS-ARCHIVE-2026-Q1.md"
  git -C "$R" add DECISIONS.md some/
  git -C "$R" commit -qam "S5: entries reordered, archive at non-root path"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" DECISIONS.md 1 >/dev/null 2>&1; then
    no "S5: reorder + non-root archive should be REFUSED"
  else
    ok "S5: reorder + non-root archive is REFUSED"
  fi

  # 15. MUTANT: honest archive shape (like test 8) but ONE BYTE tampered in the archive content.
  # The removed block no longer matches the archive -> REFUSE.
  mk_repo
  base_sha="$(git -C "$R" rev-parse HEAD)"
  archive_f="$R/DECISIONS-ARCHIVE-2026-Q1.md"
  # Write archive with one byte modified (Z -> X), keeping exact byte length via git cat-file blob.
  git -C "$R" cat-file blob "${base_sha}:DECISIONS.md" | sed 's/Z ugyre/X ugyre/' >"$archive_f"
  printf '<!-- Korábbi bejegyzések: DECISIONS-ARCHIVE-2026-Q1.md -->\n\n' >"$R/DECISIONS.md"
  printf '## 2026-04-01 -- new entry\n\nNew.\n' >>"$R/DECISIONS.md"
  git -C "$R" add DECISIONS.md "$archive_f"
  git -C "$R" commit -qam "mutant: archive has one byte different"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" DECISIONS.md 1 >/dev/null 2>&1; then
    no "mutant: tampered archive should be REFUSED"
  else
    ok "mutant: tampered archive is REFUSED"
  fi

  # pin-b: archive grew but existing archive bytes were falsified -> REFUSE (condition b).
  # Without the (b) prefix check, (c) passes because the removed block still matches the NEW bytes at
  # the end of the archive, and (d) passes with remainder_len=0.  The tampered prefix goes undetected.
  mk_repo
  base_sha="$(git -C "$R" rev-parse HEAD)"
  archive_f="$R/DECISIONS-ARCHIVE-2026-Q1.md"
  printf 'HISTORICAL_ENTRY_STUB_X\n' >"$archive_f"
  git -C "$R" add "$archive_f"
  git -C "$R" commit -qam "pin-b: seed archive at base"
  base2_sha="$(git -C "$R" rev-parse HEAD)"
  stub_len="$(git -C "$R" cat-file -s "${base2_sha}:DECISIONS-ARCHIVE-2026-Q1.md")"
  # Archive grows: tampered prefix (same length) + old DECISIONS content appended.
  printf 'FALSIFIED_ENTRY_STUB_X\n' | head -c "$stub_len" >"$archive_f"
  git -C "$R" cat-file blob "${base2_sha}:DECISIONS.md" >>"$archive_f"
  printf '## 2026-04-01 -- new entry\n\nNew.\n' >"$R/DECISIONS.md"
  git -C "$R" add DECISIONS.md "$archive_f"
  git -C "$R" commit -qam "pin-b: archive grew but existing bytes falsified"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base2_sha" "$tip_sha" DECISIONS.md 1 >/dev/null 2>&1; then
    no "pin-b: falsified archive prefix should be REFUSED (condition b)"
  else
    ok "pin-b: falsified archive prefix is REFUSED (condition b)"
  fi

  # pin-d: partial archiving but kept entries silently rewritten in tip -> REFUSE (condition d).
  # Without the (d) check, (a)/(b)/(c) all pass, and the tampered kept entries reach develop.
  mk_repo
  printf '\n## 2026-02-01 -- kept entry\n\nKept: something important.\n' >>"$R/DECISIONS.md"
  git -C "$R" commit -qam "pin-d: seed kept entry"
  base_sha="$(git -C "$R" rev-parse HEAD)"
  archive_f="$R/DECISIONS-ARCHIVE-2026-Q1.md"
  # Archive receives the first (old) entry exactly.
  first_len="$(printf '# DECISIONS\n\n## 2026-01-01 -- old entry\n\nDontes: Peti NO-GO a Z ugyre.\n\n' | wc -c)"
  git -C "$R" cat-file blob "${base_sha}:DECISIONS.md" | head -c "$first_len" >"$archive_f"
  # Tip DECISIONS.md starts with the kept entry BUT with tampered content.
  printf '## 2026-02-01 -- kept entry\n\nKept: SOMETHING CHANGED.\n\n## 2026-04-01 -- new\n\nNew.\n' \
    >"$R/DECISIONS.md"
  git -C "$R" add DECISIONS.md "$archive_f"
  git -C "$R" commit -qam "pin-d: kept entries modified in tip"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" DECISIONS.md 1 >/dev/null 2>&1; then
    no "pin-d: modified kept entries should be REFUSED (condition d)"
  else
    ok "pin-d: modified kept entries is REFUSED (condition d)"
  fi

  # pin-anchor: correct content but archive at a non-root path -> REFUSE (^ anchor in grep).
  # Without the ^ anchor the grep matches sub/dir/DECISIONS-ARCHIVE-2026-Q1.md, (c)+(d) pass trivially
  # (remainder_len=0), and the guard incorrectly accepts.
  mk_repo
  base_sha="$(git -C "$R" rev-parse HEAD)"
  mkdir -p "$R/sub/dir"
  archive_f="$R/sub/dir/DECISIONS-ARCHIVE-2026-Q1.md"
  git -C "$R" cat-file blob "${base_sha}:DECISIONS.md" >"$archive_f"
  printf '## 2026-04-01 -- new entry\n\nNew.\n' >"$R/DECISIONS.md"
  git -C "$R" add DECISIONS.md sub/
  git -C "$R" commit -qam "pin-anchor: archive at non-root path sub/dir/"
  tip_sha="$(git -C "$R" rev-parse HEAD)"
  if decisions_tail_append_ok "$R" "$base_sha" "$tip_sha" DECISIONS.md 1 >/dev/null 2>&1; then
    no "pin-anchor: non-root archive should be REFUSED (^ anchor)"
  else
    ok "pin-anchor: non-root archive is REFUSED (^ anchor)"
  fi

  if [ "$fail" -eq 0 ]; then echo "selftest: PASS"; else echo "selftest: FAIL"; fi
  exit "$fail"
fi

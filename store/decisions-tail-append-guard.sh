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
#   decisions_tail_append_ok <repo> <base-sha> <tip-sha> [<file>]
#     0 (true)  if <file> did not exist at <base-sha> (nothing to violate), OR the file at
#               <base-sha> is a byte-exact prefix of the file at <tip-sha>.
#     1 (false) otherwise -- prints the first line at which the two diverge, and the reminder to
#               move the new entry to the tail, to stderr.
#
# CLI:
#   decisions-tail-append-guard.sh --check-branch <repo> <base-sha> <tip-sha> [<file>]
#   decisions-tail-append-guard.sh --selftest
set -u

decisions_tail_append_ok() {
  local repo="$1" base="$2" tip="$3" f="${4:-DECISIONS.md}"
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
  echo "    DECISIONS.md tail-append violation: $tip's version of $f does not have $base's" >&2
  echo "    content as a byte-exact prefix -- something was inserted, removed, or reordered" >&2
  echo "    BEFORE the base's own end, not appended strictly after it." >&2
  echo "    Fix: move the new/continued entry to the VERY END of the file, referencing the" >&2
  echo "    parent entry by its date/title instead of inserting next to it." >&2
  return 1
}

# CLI DISPATCH ONLY WHEN EXECUTED, NEVER WHEN SOURCED (same guard as the sibling DECISIONS.md
# scripts -- BASH_SOURCE differs from $0 only when the file is read via `.`/`source`).
if [ "${BASH_SOURCE[0]}" = "${0}" ] && [ "${1:-}" = "--check-branch" ]; then
  decisions_tail_append_ok "$2" "$3" "$4" "${5:-DECISIONS.md}"
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

  if [ "$fail" -eq 0 ]; then echo "selftest: PASS"; else echo "selftest: FAIL"; fi
  exit "$fail"
fi

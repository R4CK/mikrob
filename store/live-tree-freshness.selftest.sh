#!/usr/bin/env bash
# live-tree-freshness.selftest.sh -- cases for store/live-tree-freshness.sh (card 99fccbcf).
#
# Every case runs against a THROWAWAY repo built here, never against the live install: the script
# under test is read-only, but a selftest that reads the real repo would measure whatever that repo
# happens to be doing today and go green or red for reasons unrelated to the code.
#
# The load-bearing case is case 8 and it carries its own NEGATIVE CONTROL: a plain recursive grep
# over the stale working tree must come back EMPTY for the same pattern the ref-search finds. A
# green ref-search proves nothing on its own -- it has to be green where the filesystem is silent,
# because that silence is the defect this script exists for.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/live-tree-freshness.sh"
pass=0; fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ok()   { pass=$((pass+1)); }
bad()  { fail=$((fail+1)); echo "  FAIL: $1"; }
check(){ # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then ok; else bad "$1 -- expected [$2] got [$3]"; fi
}

G() { git -C "$1" -c user.email=t@t -c user.name=t -c commit.gpgsign=false "${@:2}"; }

# --- fixture: an "origin" with 3 commits, and a clone parked at commit 1 ------------------------
UP="$TMP/up"; mkdir -p "$UP/src"; G "$UP" init -q -b develop 2>/dev/null || { mkdir -p "$UP"; git -C "$UP" init -q; }
echo "one" > "$UP/src/a.txt"; G "$UP" add -A; G "$UP" commit -qm c1
echo "callSiteAlpha()" > "$UP/src/b.txt"; G "$UP" add -A; G "$UP" commit -qm c2
echo "callSiteAlpha()" > "$UP/src/c.txt"; G "$UP" add -A; G "$UP" commit -qm c3

CL="$TMP/clone"; git clone -q "$UP" "$CL" 2>/dev/null
G "$CL" checkout -q develop 2>/dev/null || true
G "$CL" reset -q --hard HEAD~2          # the clone's TREE is now 2 commits behind origin/develop

R() { bash "$SUT" --repo "$1" "${@:2}" 2>&1; }

# 1. behind by 2 -------------------------------------------------------------------------------
out="$(R "$CL")"; rc=$?
case "$out" in BEHIND\ 2\ *) ok ;; *) bad "case1 behind-2 line: $out" ;; esac
check "case1 exit" "1" "$rc"
case "$out" in *oldest-missing=2*) ok ;; *) bad "case1 oldest-missing missing: $out" ;; esac

# 2. fresh -------------------------------------------------------------------------------------
G "$CL" merge -q --ff-only origin/develop
out="$(R "$CL")"; rc=$?
case "$out" in FRESH\ *) ok ;; *) bad "case2 fresh line: $out" ;; esac
check "case2 exit" "0" "$rc"

# 3. ahead only is FRESH: nothing is MISSING from this tree -------------------------------------
echo "local" > "$CL/src/local.txt"; G "$CL" add -A; G "$CL" commit -qm local
out="$(R "$CL")"; rc=$?
case "$out" in FRESH\ *) ok ;; *) bad "case3 ahead-only should be FRESH: $out" ;; esac
check "case3 exit" "0" "$rc"

# 4. diverged ----------------------------------------------------------------------------------
echo "four" > "$UP/src/d.txt"; G "$UP" add -A; G "$UP" commit -qm c4
G "$CL" fetch -q origin
out="$(R "$CL")"; rc=$?
case "$out" in DIVERGED\ ahead=1\ behind=1\ *) ok ;; *) bad "case4 diverged line: $out" ;; esac
check "case4 exit" "1" "$rc"

# 5. unresolvable ref is UNKNOWN, never FRESH --------------------------------------------------
out="$(R "$CL" --ref origin/nope)"; rc=$?
check "case5 line" "UNKNOWN:unresolvable-ref-origin/nope" "$out"
check "case5 exit" "3" "$rc"

# 6. not a git repo ----------------------------------------------------------------------------
mkdir -p "$TMP/plain"
out="$(R "$TMP/plain")"; rc=$?
check "case6 line" "UNKNOWN:not-a-git-repo" "$out"
check "case6 exit" "3" "$rc"

# 7. missing directory -------------------------------------------------------------------------
out="$(R "$TMP/does-not-exist")"; rc=$?
check "case7 line" "UNKNOWN:no-such-repo-dir" "$out"
check "case7 exit" "3" "$rc"

# 8. THE PRIMARY CASE, with its negative control -----------------------------------------------
#    Park the clone back at c1, where src/b.txt and src/c.txt do not exist on disk at all.
G "$CL" reset -q --hard origin/develop~3
#    CONTROL: the plain filesystem search is SILENT -- this is the false zero, reproduced.
fs_hits="$(grep -rl "callSiteAlpha" "$CL/src" 2>/dev/null | wc -l)"
check "case8 CONTROL filesystem grep finds nothing" "0" "$fs_hits"
#    And the ref-search finds both call sites the tree cannot see.
out="$(R "$CL" --grep "callSiteAlpha")"; rc=$?
ref_hits="$(printf '%s\n' "$out" | grep -c "callSiteAlpha")"
check "case8 ref-search finds both call sites" "2" "$ref_hits"
check "case8 exit (matches)" "0" "$rc"
case "$out" in BEHIND\ *) ok ;; *) bad "case8 must lead with the staleness verdict: $out" ;; esac

# 9. --grep against an unresolvable ref exits 3, NOT 1 ------------------------------------------
#    `git grep <bad-ref>` alone prints nothing and exits 1 -- indistinguishable from an honest
#    "no matches". That is the same false zero one level down, so it must be refused loudly.
out="$(R "$CL" --grep "callSiteAlpha" --ref origin/nope)"; rc=$?
check "case9 exit is unknown not no-match" "3" "$rc"
case "$out" in *UNKNOWN:unresolvable-ref-origin/nope*) ok ;; *) bad "case9 line: $out" ;; esac

# 10. an honest no-match is still exit 1 --------------------------------------------------------
out="$(R "$CL" --grep "zzz-no-such-symbol-zzz")"; rc=$?
check "case10 exit" "1" "$rc"

# 11. pathspec narrows the search ---------------------------------------------------------------
out="$(R "$CL" --grep "callSiteAlpha" -- "src/b.txt")"; rc=$?
check "case11 exit" "0" "$rc"
check "case11 one file only" "1" "$(printf '%s\n' "$out" | grep -c 'callSiteAlpha')"

# 12. THE SILENT SHAPE: a pathspec matching nothing at the ref ---------------------------------
#     CONTROL first -- bare `git grep` on that pathspec is byte-identical to an honest no-match,
#     which is precisely why this needs a guard rather than a comment.
G "$CL" grep -n -e "callSiteAlpha" origin/develop -- "src/no-such-file.txt" >/dev/null 2>&1
check "case12 CONTROL bare git grep exits 1, same as an honest no-match" "1" "$?"
out="$(R "$CL" --grep "callSiteAlpha" -- "src/no-such-file.txt")"; rc=$?
check "case12 exit is unknown not no-match" "3" "$rc"
case "$out" in *UNKNOWN:pathspec-matches-nothing-at-*) ok ;; *) bad "case12 line: $out" ;; esac

# 13. a VALID pathspec that simply has no match stays an honest exit 1 --------------------------
#     Without this, "refuse every empty result" would score as a passing guard while destroying the
#     ability to answer "no, nothing references this" -- which is the question being asked.
out="$(R "$CL" --grep "zzz-no-such-symbol-zzz" -- "src/a.txt")"; rc=$?
check "case13 exit stays an honest no-match" "1" "$rc"
case "$out" in *UNKNOWN*) bad "case13 must NOT refuse a valid pathspec: $out" ;; *) ok ;; esac

echo "selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

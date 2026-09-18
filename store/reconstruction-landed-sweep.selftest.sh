#!/usr/bin/env bash
# reconstruction-landed-sweep.selftest.sh -- cases for the ATTRIBUTED-vs-MENTIONED grep in
# store/reconstruction-landed-sweep.sh's first_landed() (card 6f887d39).
#
# The script itself talks to the live dashboard and two fixed repo paths, so this does not invoke it
# as a subprocess -- it runs the SAME git-log invocation the fix uses (extended regex, case-insensitive,
# "card|kártya|kartya" immediately before the id) against a throwaway repo, and checks it against real
# commit shapes pulled from marveen's own history so the cases are not invented.
set -uo pipefail

pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "  FAIL: $1"; }

G() { git -C "$1" -c user.email=t@t -c user.name=t -c commit.gpgsign=false "${@:2}"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/r"; mkdir -p "$REPO"
G "$REPO" init -q -b main
echo one > "$REPO/f"; G "$REPO" add -A; G "$REPO" commit -qm c0

# attributed(): 1 if any commit on main is found by the fixed pattern for <id>, else 0.
attributed() {
  local id="$1"
  git -C "$REPO" log --oneline --extended-regexp --regexp-ignore-case \
    --grep="(card|kártya|kartya)[^0-9a-zA-Z]{0,4}$id" main 2>/dev/null | grep -q .
  [ $? -eq 0 ] && echo 1 || echo 0
}

# case 1: the real false positive this card exists for -- 5f2499713903's actual body text.
#   "re-parented the 2 orphaned cards themselves (de7f4b15, 6c118f45) to top-level" -- a bare id in a
#   parenthesized list, no "card"/"kártya" keyword immediately before it. Must NOT be attributed.
echo two > "$REPO/f"; G "$REPO" add -A
G "$REPO" commit -qm "fix(kanban): refuse archiving a card with open non-done children (card 037277a0)

Also (part 1 of the card): re-parented the 2 orphaned cards themselves
(de7f4b15, 6c118f45) to top-level -- their lineage is entirely done."
[ "$(attributed de7f4b15)" = "0" ] && ok || bad "case1: bare id in a list must NOT be attributed"

# case 2: the true attribution in the SAME commit -- "(card 037277a0)" in the subject. Must match.
[ "$(attributed 037277a0)" = "1" ] && ok || bad "case2: '(card <id>)' in the subject must be attributed"

# case 3: Hungarian keyword "kártya <id>" also counts as attribution.
echo three > "$REPO/f"; G "$REPO" add -A
G "$REPO" commit -qm "fix(sites): javitas a kártya a1b2c3d4 leletere"
[ "$(attributed a1b2c3d4)" = "1" ] && ok || bad "case3: Hungarian 'kártya <id>' must be attributed"

# case 4: ASCII "kartya" (no diacritic, seen in some commit bodies) also counts.
echo four > "$REPO/f"; G "$REPO" add -A
G "$REPO" commit -qm "chore: kartya deadbeef01 rendben"
[ "$(attributed deadbeef01)" = "1" ] && ok || bad "case4: ASCII 'kartya <id>' must be attributed"

# case 5: NEGATIVE CONTROL -- an id that appears nowhere must not be attributed either way.
[ "$(attributed ffffffff)" = "0" ] && ok || bad "case5: an absent id must not be attributed"

# case 6: CONTROL reproducing the OLD bug -- bare substring grep (pre-fix behaviour) DOES match
# de7f4b15 in case 1's commit. If this control ever goes to 0, the fixture stopped reproducing the
# defect and the cases above are not testing anything.
old_bug="$(git -C "$REPO" log --oneline --grep="de7f4b15" main 2>/dev/null | grep -c .)"
[ "$old_bug" -ge 1 ] && ok || bad "case6 CONTROL: fixture must still reproduce the pre-fix false positive"

echo "selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

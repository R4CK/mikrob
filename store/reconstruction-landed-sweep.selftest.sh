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
    --grep="(cards?|kártya|kartya)[^0-9a-zA-Z]{0,4}$id" main 2>/dev/null | grep -q .
  [ $? -eq 0 ] && echo 1 || echo 0
}

# first_landed_sha(): mirrors the REAL first_landed() in reconstruction-landed-sweep.sh (same
# ordering, same ancestor check) so the revert-precedence case exercises the actual returned sha,
# not just whether something matched.
first_landed_sha() {
  local id="$1" sha
  while read -r sha _; do
    [ -n "$sha" ] || continue
    if git -C "$REPO" merge-base --is-ancestor "$sha" main 2>/dev/null; then
      echo "$sha"; return 0
    fi
  done < <(git -C "$REPO" log --oneline --reverse --extended-regexp --regexp-ignore-case \
    --grep="(cards?|kártya|kartya)[^0-9a-zA-Z]{0,4}$id" main 2>/dev/null)
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

# case 7: PLURAL attribution (QA, card 6f887d39, gate on 02c77848) -- "(cards X, Y)" is a real,
# 24-occurrence convention (e.g. 17bb1e79) for one commit shipping two cards at once. The pre-fix
# pattern's `s` fell into the `[^0-9a-zA-Z]{0,4}` gap (an alphanumeric char it must not skip), so the
# id immediately after the keyword was silently dropped. Must be attributed under the fix. NOTE ON
# SCOPE: this fixes the id ADJACENT to the keyword (what QA measured and verified against 17bb1e79's
# real commit), not an arbitrary later id in the same list -- "cards X, Y" only puts the keyword
# directly before X. A second id far enough from the keyword to fall outside the 4-char gap is a
# separate, wider problem (matching an entire parenthesized attribution group) that was not part of
# what QA asked for or measured, so it is not claimed fixed here.
echo seven > "$REPO/f"; G "$REPO" add -A
G "$REPO" commit -qm "merge: agent/backend/work (cards 0c4cf655, 108c7b10)

Found by Cybersec on the 0c4cf655 gate; 108c7b10 rides along."
[ "$(attributed 0c4cf655)" = "1" ] && ok || bad "case7a: plural '(cards X, Y)' must attribute the id adjacent to the keyword"

# case 7b: CONTROL -- the mutation (reverting cards? back to card) must NOT bring back case1's
# original false positive (de7f4b15 in a bare-id list). Confirms the widened keyword doesn't
# reopen the hole this card exists to close.
[ "$(attributed de7f4b15)" = "0" ] && ok || bad "case7b CONTROL: plural fix must not resurrect the bare-id false positive"

# case 8: REVERT PRECEDENCE + name-vs-behavior (Cybered, comment 4226/4230). `git log` without
# --reverse returns newest-first, and first_landed() takes the FIRST match -- so a `git revert`
# commit, which quotes the reverted subject's "(card <id>)" text verbatim, matched and was returned
# INSTEAD of the actual shipping commit, because the revert is newer. --reverse makes the walk
# oldest-first so the real shipper (which must predate any revert of it) wins.
echo eight > "$REPO/f"; G "$REPO" add -A
G "$REPO" commit -qm "fix(x): does the actual work (card cafebabe1)"
SHIP_SHA="$(git -C "$REPO" rev-parse HEAD)"
echo nine > "$REPO/f"; G "$REPO" add -A
G "$REPO" commit -qm "Revert \"fix(x): does the actual work (card cafebabe1)\"

This reverts commit $SHIP_SHA."
REVERT_SHA="$(git -C "$REPO" rev-parse HEAD)"
found="$(first_landed_sha cafebabe1)"
found_full="$(git -C "$REPO" rev-parse "$found" 2>/dev/null)"
[ "$found_full" = "$SHIP_SHA" ] && ok || bad "case8: must return the SHIPPING commit ($SHIP_SHA), got '$found' -> '$found_full' (revert was $REVERT_SHA)"

echo "selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

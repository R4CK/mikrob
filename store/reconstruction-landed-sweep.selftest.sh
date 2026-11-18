#!/usr/bin/env bash
# reconstruction-landed-sweep.selftest.sh -- cases for the ATTRIBUTED-vs-MENTIONED grep in
# store/reconstruction-landed-sweep.sh's first_landed() (card 6f887d39).
#
# The script itself talks to the live dashboard and two fixed repo paths, so this does not invoke it
# as a subprocess -- instead it SOURCES the real file (card 9ff184d8) and calls the real first_landed()
# against a throwaway repo, with real commit shapes pulled from marveen's own history so the cases
# are not invented. Sourcing (rather than running) skips the dashboard sweep below first_landed() in
# the real file -- see that file's own BASH_SOURCE guard comment.
#
# WHY SOURCING, NOT A COPIED REGEX (QA, card 6f887d39, gate on 02c77848 + comment 4226). This file
# used to hand-copy first_landed()'s grep pattern into its own attributed()/first_landed_sha()
# helpers. QA mutated the REAL file twice (reverted the plural "cards?" back to "card", and removed
# --reverse) and measured this selftest staying 9/9 green BOTH times -- it was testing its own frozen
# copy, not the function it claimed to cover. Sourcing the real file means a mutation there is now
# exercised directly; re-running the same two mutations after this fix turns the matching cases red
# (case7a for the plural revert, case8 for the --reverse removal), confirmed by hand before landing.
set -uo pipefail

pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "  FAIL: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/reconstruction-landed-sweep.sh"

G() { git -C "$1" -c user.email=t@t -c user.name=t -c commit.gpgsign=false "${@:2}"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/r"; mkdir -p "$REPO"
G "$REPO" init -q -b main
echo one > "$REPO/f"; G "$REPO" add -A; G "$REPO" commit -qm c0

# attributed(): 1 if the REAL first_landed() (sourced above) finds a commit on main for <id>, else 0.
attributed() {
  local id="$1"
  [ -n "$(first_landed "$REPO" main "$id")" ] && echo 1 || echo 0
}

# first_landed_sha(): thin wrapper so the revert-precedence case reads naturally; calls straight
# through to the REAL first_landed(), no copy.
first_landed_sha() {
  first_landed "$REPO" main "$1"
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

# case 9 (N1, RedHat 16908, card e2368d0a): the sourcing guard's R10 mutant ("if true; then
# return 0" regardless of BASH_SOURCE[0] vs $0) stayed GREEN on this selftest because nothing
# here actually executes the script DIRECTLY -- every case above sources it. A direct run with a
# bogus dashboard and a nonexistent MARVEEN_MAIN must still reach the token-read + curl failure
# and exit 3 (Cybered's measured baseline); a guard that returns early on every invocation would
# exit 0 instead and never even try.
direct_rc=0
DASHBOARD_URL="http://127.0.0.1:9" MARVEEN_MAIN="/nonexistent-$$" \
  bash "$SCRIPT_DIR/reconstruction-landed-sweep.sh" >/dev/null 2>&1 || direct_rc=$?
[ "$direct_rc" -eq 3 ] && ok || bad "case9: direct execution with unreachable dashboard must exit 3, got $direct_rc"

# N3-R3 (RedHat 16908) has NO case here on purpose: Cybered's own mutant (replacing the
# merge-base --is-ancestor check with "true") is an EQUIVALENT mutant for this function as
# actually called. `first_landed()`'s loop only ever iterates shas yielded by
# `git log --oneline ... "$branch"`, and `git log <rev>` by definition lists only commits
# reachable from <rev> -- so every $sha reaching the is-ancestor check is already guaranteed an
# ancestor of $branch before that check runs. Verified directly: replacing the check with `true`
# still passes every case in this file (13/13), including the plain happy-path attribution cases,
# because no case can produce a $sha from that same `git log "$branch"` call that ISN'T an
# ancestor of "$branch". A real test would need a $sha reaching the loop body through some path
# other than that one `git log` call, which first_landed() has no such path for -- fabricating
# one would test a scenario the function cannot encounter, not pin real behaviour.

# case 11 (N3-R7, RedHat 16908): --regexp-ignore-case makes a capitalized keyword ("Card <id>")
# still attribute. Without it, this commit would be missed.
echo eleven > "$REPO/f"; G "$REPO" add -A
G "$REPO" commit -qm "fix: Card deadbeef02 dashboard tweak"
[ "$(attributed deadbeef02)" = "1" ] && ok || bad "case11: capitalized 'Card <id>' must still be attributed (case-insensitive)"

# case 12 (N3-R8, RedHat 16908): the keyword-to-id gap is capped at {0,4} non-alnum chars. An id
# separated from the keyword by MORE than 4 non-alnum characters (here: no alnum in between at
# all, just a long run of dots) must NOT be attributed -- a widened gap (e.g. {0,80}) would wrongly
# catch it.
echo twelve > "$REPO/f"; G "$REPO" add -A
G "$REPO" commit -qm "chore: unrelated (card....................deadbeef03) note"
[ "$(attributed deadbeef03)" = "0" ] && ok || bad "case12: id separated from keyword by >4 non-alnum chars must NOT be attributed"

# case 13 (L1, Cybered GO 32918 on e2368d0a, card a9cd79a4): case12's gap is far longer than any of
# the 4/5/6-wide cap mutants, so {0,1}/{0,3}/{0,5}/{0,6} all still reject it and survive unpinned.
# Pin the boundary itself with the SHORTEST separators on each side of the real {0,4} cap: exactly
# 4 non-alnum chars must still attribute (a {0,1}/{0,2}/{0,3} mutant would wrongly reject this).
echo thirteen > "$REPO/f"; G "$REPO" add -A
G "$REPO" commit -qm "chore: unrelated (card::::deadbeef04) note"
[ "$(attributed deadbeef04)" = "1" ] && ok || bad "case13: id separated from keyword by EXACTLY 4 non-alnum chars must be attributed (boundary, lower)"

# case 14 (L1, same pin, upper side): exactly 5 non-alnum chars -- one past the real {0,4} cap --
# must NOT be attributed (a {0,5}/{0,6} mutant would wrongly accept this).
echo fourteen > "$REPO/f"; G "$REPO" add -A
G "$REPO" commit -qm "chore: unrelated (card:::::deadbeef05) note"
[ "$(attributed deadbeef05)" = "0" ] && ok || bad "case14: id separated from keyword by EXACTLY 5 non-alnum chars must NOT be attributed (boundary, upper)"

# case 15 (L2, Cybered GO 32918 on e2368d0a, card a9cd79a4): every case above runs via `source`
# (the top of this file), which never reaches the dashboard sweep below first_landed() because of
# the real file's own BASH_SOURCE[0]-vs-$0 guard -- but nothing until now actually PINNED that. If
# the guard ever goes inert, sourcing would silently fall through into `cat "$MAIN/store/.dashboard-
# token"` and a live curl against the real dashboard, using whatever MAIN/DASH the caller's
# environment happens to have (this selftest's own, or a CI box's). Verified by hand with a guard-
# stripped copy of the real file (sourced the same way, same bogus MARVEEN_MAIN/DASHBOARD_URL): it
# prints `cat: .../store/.dashboard-token: No such file or directory` and exits 3 -- i.e. a inert
# guard IS detectable this way. This case re-sources the REAL, unmutated file (not a copy) in a
# fresh bash subprocess with a nonexistent MARVEEN_MAIN and an unreachable DASHBOARD_URL, and
# asserts BOTH that it exits 0 (the guard returned early) AND that its stderr never mentions
# "dashboard-token" or the board-read failure -- so a future guard regression turns this case red
# instead of silently reaching for the live token file.
source_stderr="$TMP/source-stderr.log"
source_rc=0
bash -c "MARVEEN_MAIN=/nonexistent-sentinel-$$ DASHBOARD_URL=http://127.0.0.1:9 source '$SCRIPT_DIR/reconstruction-landed-sweep.sh'" \
  >/dev/null 2>"$source_stderr" || source_rc=$?
if [ "$source_rc" -eq 0 ] && ! grep -q "dashboard-token\|could not read the board" "$source_stderr"; then
  ok
else
  bad "case15: sourcing the real file must exit 0 and never touch store/.dashboard-token/the dashboard (rc=$source_rc, stderr: $(cat "$source_stderr"))"
fi

echo "selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

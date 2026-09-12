#!/usr/bin/env bash
# unlanded-branch-sweep.sh -- which remote WORK BRANCHES carry commits that never reached the main
# branch, and does a card still exist for them? (card a857b3db)
#
# THE MIRROR OF reconstruction-landed-sweep.sh. That one asks, from the CARD side, "is this open
# card's work already landed?". This asks the opposite, from the BRANCH side: "is this branch's work
# still unlanded, and did its card survive?". Same root cause -- the 2026-09-08 kanban-DB wipe -- and
# the worse symptom: there, a status is wrong; here, FINISHED AND OFTEN ALREADY GATED WORK is lost
# silently, because the card that would have chased it no longer exists.
#
# FOUNDING CASE, measured 2026-09-12. `b039b079` ("stripComments now catches a TRAILING // comment
# too", kodex, 2026-09-07) was written as Cybered's finding on card 5f84bf68's own gate round. It
# never reached origin/main: it sits alone on fix/fixture-privilege-scan-trailing-comment-b3a7bae9,
# and card b3a7bae9 is gone from the board. The bypass it fixes was still live on main five days
# later, and was only found because a different card happened to lead there.
#
# WHAT IT REPORTS, worst first:
#   ORPHAN        branch unlanded, and NO card it names still exists (or it names none)
#   CLOSED        branch unlanded, but its card is `done` -- closed without shipping (the 667e809b
#                 class: verdicts agreed, nothing checked that the sha reached main)
#   OPEN          branch unlanded, card still open -- normal work in progress, listed for completeness
#
# THREE THINGS IT GETS RIGHT, each from a measured failure of an earlier sweep:
#
#  1. BOTH REPOS. An earlier audit declared two cards "no commit found" because it searched only
#     CleanCore while the fixes were in marveen. One repo reproduces exactly that wrong answer.
#
#  2. ANCESTOR, NOT EQUALITY. Landing is a `--no-ff` merge, so the work commit becomes an ANCESTOR of
#     the main branch, never equal to its tip. `--no-merged` asks the same question git-side.
#
#  3. A HIT IS A CANDIDATE, NOT A VERDICT. An unlanded branch can be deliberately abandoned work, a
#     superseded attempt, or a rebased duplicate whose content DID land under another sha. The label
#     narrows the set to what a human should read; it does not decide. Nothing here closes a card,
#     lands a branch, or deletes a ref.
#
# Usage:  unlanded-branch-sweep.sh [--repo cleancore|marveen|both] [--only orphan|closed|open]
#         unlanded-branch-sweep.sh --selftest
set -uo pipefail

CC="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
MV="${MARVEEN_MAIN:-/home/neon/marveen}"
API="${DASHBOARD_URL:-http://localhost:3420}"
REPO=both
ONLY=all
FETCH=1

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-both}"; shift 2 ;;
    --only) ONLY="${2:-all}"; shift 2 ;;
    --no-fetch) FETCH=0; shift ;;
    --selftest) SELFTEST=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

hdr=$(mktemp); trap 'rm -f "$hdr" "$CARDS"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$MV/store/.dashboard-token")" > "$hdr"
CARDS=$(mktemp)
curl -sS -H @"$hdr" "$API/api/kanban" > "$CARDS" || { echo "REFUSED: cannot read the kanban board" >&2; exit 3; }

# A card id in a commit message: 8 hex chars. Deliberately loose on the way IN (the corpus writes
# "card X", "kartya X", "(X)", "@ X"), then every candidate is checked against the real board -- a
# string that is not a card simply resolves to "no such card" rather than being filtered by guesswork.
card_ids_in_range() { # <repo> <range>
  git -C "$1" log --format='%s%n%b' "$2" 2>/dev/null \
    | grep -oiE '\b[0-9a-f]{8}\b' | tr 'A-F' 'a-f' | sort -u
}

card_status() { # <id> -> status, or empty when the card does not exist
  python3 -c "
import json,sys
cards=json.load(open(sys.argv[1]))
cards=cards if isinstance(cards,list) else cards.get('cards',[])
print(next((c.get('status','?') for c in cards if c.get('id')==sys.argv[2]), ''))
" "$CARDS" "$1"
}

sweep_repo() { # <label> <dir> <mainref>
  local label="$1" dir="$2" main="$3"
  [ -d "$dir/.git" ] || [ -f "$dir/.git" ] || { echo "  (skipped: $dir is not a git checkout)"; return; }
  [ "$FETCH" = 1 ] && git -C "$dir" fetch origin --prune --quiet 2>/dev/null

  git -C "$dir" for-each-ref --format='%(refname:short)' refs/remotes/origin --no-merged "$main" \
  | grep -vE '^origin/(HEAD|main|master|develop)$' \
  | while read -r ref; do
      local range="$main..$ref"
      local ahead; ahead=$(git -C "$dir" rev-list --count "$range" 2>/dev/null || echo 0)
      [ "${ahead:-0}" -gt 0 ] || continue
      local last; last=$(git -C "$dir" log -1 --format='%ad' --date=short "$ref" 2>/dev/null)
      local subj; subj=$(git -C "$dir" log -1 --format='%s' "$ref" 2>/dev/null | cut -c1-64)
      local gated=''
      git -C "$dir" log --format='%s%n%b' "$range" 2>/dev/null | grep -qiE 'gate-teljes|QA PASS|CYBERSEC GO|CYBERED GO' && gated=' GATED'

      local verdict='ORPHAN' detail='no card id in the range'
      local ids; ids=$(card_ids_in_range "$dir" "$range")
      if [ -n "$ids" ]; then
        detail=''
        local found=0
        for id in $ids; do
          local st; st=$(card_status "$id")
          [ -n "$st" ] || continue
          found=1
          detail="$detail $id=$st"
          case "$st" in
            done) [ "$verdict" = OPEN ] || verdict='CLOSED' ;;
            *)    verdict='OPEN' ;;
          esac
        done
        if [ "$found" = 0 ]; then
          verdict='ORPHAN'
          detail="named ids exist in no card: $(echo $ids | cut -c1-60)"
        fi
      fi

      case "$ONLY" in
        orphan) [ "$verdict" = ORPHAN ] || continue ;;
        closed) [ "$verdict" = CLOSED ] || continue ;;
        open)   [ "$verdict" = OPEN ]   || continue ;;
      esac
      printf '%-7s %-9s %2s commit(s) %s%s\n    %s\n    %s\n    %s\n' \
        "$verdict" "$label" "$ahead" "$last" "$gated" "${ref#origin/}" "$subj" "$detail"
    done
}

if [ "${SELFTEST:-0}" = 1 ]; then
  # A sweep proven only against the live corpus is proven against a moving target: the FIRST version
  # of this selftest pinned the founding branch as ORPHAN, and passed for the wrong reason within the
  # hour -- once card 5f84bf68 started naming that branch's commit, its correct class became CLOSED,
  # while the assertion still went green because it checked "branch appears" and "some ORPHAN exists
  # somewhere" as two unrelated facts. So the classifier is proven on a THROWAWAY REPO, where all
  # three inputs are constructed, and only the two facts that cannot drift are asserted live.
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/ubs-selftest-XXXXXX")
  cleanup_selftest() { rm -rf "$tmp"; }
  trap 'cleanup_selftest; rm -f "$hdr" "$CARDS"' EXIT
  (
    set -e
    git init -q -b main "$tmp/origin"
    cd "$tmp/origin"
    git config user.email s@s; git config user.name s
    echo base > f; git add f; git commit -qm 'base'
    # (1) a branch naming a card that does NOT exist on the board -> ORPHAN
    git checkout -qb fix/gone-ffffffff
    echo a >> f; git commit -qam 'fix(x): something (card ffffffff)'
    # (2) a branch naming NO card at all -> ORPHAN
    git checkout -q main; git checkout -qb chore/nameless
    echo b >> f; git commit -qam 'chore: no card id here'
    # (3) a branch already merged into main -> must NOT be reported at all
    git checkout -q main; git checkout -qb fix/already-landed
    echo c >> f; git commit -qam 'fix(y): landed work'
    git checkout -q main; git merge -q --no-ff fix/already-landed -m 'merge: fix/already-landed'
    git checkout -q main
  ) >/dev/null 2>&1 || { echo "selftest: FAIL -- could not build the throwaway repo"; exit 1; }
  git init -q "$tmp/clone" && git -C "$tmp/clone" remote add origin "$tmp/origin" && git -C "$tmp/clone" fetch -q origin

  syn=$(FETCH=0 sweep_repo synth "$tmp/clone" origin/main)
  fail=0
  echo "$syn" | grep -q 'fix/gone-ffffffff' || { echo "selftest: FAIL -- unlanded branch with a dead card id not reported"; fail=1; }
  echo "$syn" | grep -A3 'fix/gone-ffffffff' | grep -q 'no card' \
    && echo "  ok: dead card id -> reported as having no live card" \
    || { echo "selftest: FAIL -- dead card id was not classified as ORPHAN"; fail=1; }
  echo "$syn" | grep -q 'chore/nameless' || { echo "selftest: FAIL -- unlanded branch with no card id not reported"; fail=1; }
  # NOTE for whoever mutates this next: "a merged branch is silent" is enforced TWICE and
  # independently -- by `--no-merged` on for-each-ref AND by the ahead-count test below it. Breaking
  # either one alone leaves the assertion green, which looks like a vacuous test and is not: it is
  # two real defences. Both had to be broken at once before this line went red (measured).
  if echo "$syn" | grep -q 'fix/already-landed'; then
    echo "selftest: FAIL -- a MERGED branch was reported as unlanded"; fail=1
  else
    echo "  ok: a merged branch is not reported"
  fi
  [ "$fail" = 0 ] || exit 1
  echo "selftest: PASS -- classifier proven on a constructed corpus (ORPHAN fires, merged is silent)"
  exit 0
fi

echo "unlanded-branch-sweep (card a857b3db) -- worst first: ORPHAN > CLOSED > OPEN"
echo
[ "$REPO" = both ] || [ "$REPO" = cleancore ] && sweep_repo cleancore "$CC" origin/main
[ "$REPO" = both ] || [ "$REPO" = marveen ]   && sweep_repo marveen   "$MV" origin/develop

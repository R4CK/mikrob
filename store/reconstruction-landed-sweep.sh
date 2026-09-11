#!/usr/bin/env bash
# reconstruction-landed-sweep.sh -- which OPEN cards from the 2026-09-08 reconstruction are already
# landed? (card 9caff605)
#
# WHY. The log-based reconstruction after the 2026-09-08 kanban-DB wipe brought cards back as
# planned/in_progress whose work was in fact finished, gated and landed. Measured by ONE agent on
# 2026-09-11, each found only because it checked before starting: 34c4840e, bb919fae (both landed in
# marveen), 1855a71d, 1da6fec3 (both in CleanCore). Four out of the handful that agent happened to be
# dispatched. Every such card otherwise costs a full dispatch, context load and investigation before
# anyone discovers there is nothing to do.
#
# THREE THINGS IT GETS RIGHT, each from a measured failure:
#
#  1. BOTH REPOS. An earlier audit declared 34c4840e and bb919fae "no commit found" because it
#     searched only CleanCore -- the fixes were in marveen. Searching one repo reproduces exactly
#     that wrong answer.
#
#  2. LANDED, NOT MERELY PRESENT. A commit existing proves nothing: it can sit on an unmerged branch.
#     Every candidate sha is confirmed an ANCESTOR of that repo's main branch.
#
#  3. THE FOOTER, NOT THE WORD. Selection anchors on the reconstruction FOOTER, not on a loose
#     "rekonstrukci" substring. Measured: the loose match returns 39 open cards, the anchored one 34
#     -- the five extra merely DISCUSS the reconstruction (this card's own is one of them). Matching
#     prose that talks about a thing instead of the thing itself is the same trap that bites guards
#     elsewhere in this tree.
#
# A HIT IS A CANDIDATE, NOT A VERDICT, and the label says so. What it proves is narrow: a commit
# that MENTIONS this card id is landed on a main branch. That is not the same as "this card is
# finished", for two measured reasons:
#   - a commit may name a card it merely relates to. `4db7bc17` says "Card 5b6dd606" inside a commit
#     whose subject is a DIFFERENT card, and `935c9f9e` says "card 8b5559cf class" -- addressing a
#     class the card belongs to.
#   - a card may be wider than its commit. 1da6fec3's title made TWO claims; the commit named one,
#     and the second half had to be verified separately (it was also done, but only checking showed
#     that).
# So this narrows ~34 cards to a short list worth checking by hand. It does not answer them.
#
# IT NEVER CLOSES A CARD. Default output is a REPORT. `--comment` posts a finding to each hit, and
# nothing else -- closing stays with MikroB/QA on independent verification, which is how 1855a71d and
# 1da6fec3 were actually handled.
#
# Usage: store/reconstruction-landed-sweep.sh [--comment] [--card <id>]
# Exit:  0 report produced | 2 usage | 3 the board could not be read
set -uo pipefail

MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
CLEANCORE="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
DASH="${DASHBOARD_URL:-http://localhost:3420}"
FOOTER='Log-alapú rekonstrukció a 2026-09-08-i kanban-DB-kiürülés után'

DO_COMMENT=0
ONLY_CARD=""
ONLY_ASSIGNEE=""
while [ $# -gt 0 ]; do
  case "$1" in
  --comment) DO_COMMENT=1 ;;
  --card) ONLY_CARD="${2:?--card needs an id}"; shift ;;
  # Narrow to one agent's cards. Exists so the FIRST --comment run can be limited to the author's
  # own board before anything is written to five other agents' cards (MikroB's call, msg 945).
  --assignee) ONLY_ASSIGNEE="${2:?--assignee needs a name}"; shift ;;
  *) echo "usage: $0 [--comment] [--card <id>] [--assignee <name>]" >&2; exit 2 ;;
  esac
  shift
done

hdr="$(mktemp)"; trap 'rm -f "$hdr"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$MAIN/store/.dashboard-token")" > "$hdr"

# `first_landed <repo> <branch> <cardId>` -> "<sha>" of the first commit naming the card that is also
# an ancestor of <branch>, or empty. Existence alone is not the question (see point 2 above).
first_landed() {
  local repo="$1" branch="$2" card="$3" sha
  git -C "$repo" rev-parse --verify -q "$branch" >/dev/null 2>&1 || return 0
  while read -r sha _; do
    [ -n "$sha" ] || continue
    if git -C "$repo" merge-base --is-ancestor "$sha" "$branch" 2>/dev/null; then
      echo "$sha"; return 0
    fi
  done < <(git -C "$repo" log --oneline --grep="$card" "$branch" 2>/dev/null)
}

cards_json="$(curl -sf -H @"$hdr" "$DASH/api/kanban?limit=600")" || {
  echo "reconstruction-sweep: could not read the board at $DASH" >&2; exit 3; }

# Select open, reconstruction-footered cards. Emits "<id>\t<assignee>\t<title>".
mapfile -t ROWS < <(printf '%s' "$cards_json" | FOOTER="$FOOTER" ONLY="$ONLY_CARD" ONLY_WHO="$ONLY_ASSIGNEE" python3 -c '
import json, os, sys
footer, only, only_who = os.environ["FOOTER"], os.environ["ONLY"], os.environ["ONLY_WHO"]
d = json.load(sys.stdin)
cards = d if isinstance(d, list) else d.get("cards", d.get("data", []))
for c in cards:
    if c.get("status") not in ("planned", "in_progress"):
        continue
    if footer not in (c.get("description") or ""):
        continue
    if only and c.get("id") != only:
        continue
    if only_who and (c.get("assignee") or "") != only_who:
        continue
    print("\t".join([c.get("id") or "", c.get("assignee") or "-", (c.get("title") or "")[:70]]))
')

landed=0; open_n=0
echo "reconstruction-landed-sweep: ${#ROWS[@]} open card(s) carrying the 2026-09-08 footer"
echo
for row in "${ROWS[@]}"; do
  id="${row%%$'\t'*}"; rest="${row#*$'\t'}"; who="${rest%%$'\t'*}"; title="${rest#*$'\t'}"
  m_sha="$(first_landed "$MAIN" origin/develop "$id")"
  c_sha="$(first_landed "$CLEANCORE" origin/main "$id")"
  if [ -n "$m_sha" ] || [ -n "$c_sha" ]; then
    landed=$((landed + 1))
    if [ -n "$m_sha" ]; then repo="marveen/origin/develop"; sha="$m_sha"; else repo="CleanCore/origin/main"; sha="$c_sha"; fi
    printf 'NAMED-BY-LANDED  %s  %-10s %s\n' "$id" "$who" "$title"
    printf '        -> %s %s\n' "$repo" "$sha"
    if [ "$DO_COMMENT" -eq 1 ]; then
      body="SWEEP (kártya 9caff605): ezt a kártyát MEGNEVEZI egy már landolt commit -- érdemes ellenőrizni, hogy a munkája nem készült-e el már, mielőtt bárki nekikezd. A kártya a 2026-09-08-i rekonstrukcióból jött vissza nyitottként.

  ${repo}: ${sha}

Ellenőrizve: a commit üzenete tartalmazza a kártya ID-jét, ÉS a commit ancestor-a az adott repó fő ágának (nem csak létezik egy ágon). Mindkét repóban kerestem, mert egy korábbi audit épp azért minősített két kártyát tévesen \"nincs commit\"-nak, mert csak az egyikben nézett.

EZ NEM ZÁRÁS, NEM VERDIKT, ÉS NEM IS BIZONYÍTÉK A KÉSZÜLTSÉGRE. Amit igazol, az szűk: egy landolt commit MEGEMLÍTI ezt az ID-t. Egy commit megnevezhet olyan kártyát is, amihez csak kapcsolódik (mérve: 4db7bc17 "Card 5b6dd606"-ot ír egy MÁSIK kártyáról szóló commitban; 935c9f9e "card 8b5559cf class"-t ír). És a commit megléte nem bizonyítja, hogy a kártya MINDEN fele le van fedve (mérve: az 1da6fec3 címe két külön állítást tett, és külön kellett ellenőrizni mindkettőt). A zárás MikroB/QA lépése, független ellenőrzéssel."
      python3 -c 'import json,sys; print(json.dumps({"author":"backend2","content":sys.argv[1]}))' "$body" \
        | curl -sf -X POST "$DASH/api/kanban/$id/comments" -H 'Content-Type: application/json' -H @"$hdr" -d @- >/dev/null \
        && echo "        -> commented" || echo "        -> COMMENT FAILED" >&2
    fi
  else
    open_n=$((open_n + 1))
    printf 'no-commit        %s  %-10s %s\n' "$id" "$who" "$title"
  fi
done

echo
echo "reconstruction-landed-sweep: ${landed} NAMED BY a landed commit, ${open_n} named by none."
echo "A hit is a CANDIDATE, not a verdict -- see the header. Each still needs a per-card check."
[ "$DO_COMMENT" -eq 1 ] || echo "(report only -- pass --comment to post the findings; it never closes a card)"

#!/usr/bin/env bash
# landing-downward-check.sh -- what ELSE rides along when a landing merges a branch (card dfff9b37).
#
# Sourced by BOTH store/cleancore-land.sh and store/marveen-land.sh, verbatim, for the same reason
# decisions-append-union.sh is: two copies of a landing precondition drift, and the half that drifts
# is the half nobody is looking at.
#
# THE GAP THIS CLOSES. Both landers already refuse when the gated sha is not the branch TIP, so a
# branch that moved on AFTER its verdicts cannot be landed. Neither looked DOWNWARDS: nothing asked
# what sits between origin/main (origin/develop) and that sha. The case that actually happens is the
# one they could not see -- the gated sha IS the tip, and underneath it sit an EARLIER card's
# ungated commits, because the agent finished a card, self-advanced (rule 11), and kept building on
# the same branch. Three cards hit this in one day on one branch (2026-09-02, agent/backend/work:
# 19c4684a, d284193f, 45b29528). Nothing was lost, because a human asked the question before each
# merge. Three times. See store/landing-cherry-pick-vs-branch-merge.md.
#
# --- THE THREE DECISIONS THAT DECIDE WHETHER THIS IS USEFUL OR JUST IN THE WAY -------------------
#
# 1. A COMMIT NAMING NO CARD IS NEUTRAL, NOT SUSPICIOUS -- BUT IT IS ALWAYS NAMED IN THE OUTPUT.
#    The card asked for fail-closed here. Measured before deciding: of CleanCore origin/main's last
#    40 non-merge commits, 35 carry `card <id>` and 5 do not -- and on marveen the card-less commit
#    is the MAJORITY (chore(fork-guard), chore(watched-repos), one-line fixes). The question this
#    check asks is "does ANOTHER CARD's work ride along". A commit that names no card is no evidence
#    either way. Treating absent evidence as evidence turns a DOCUMENTATION habit into a landing
#    gate, and the measurement says that habit is not universal: the guard would fire mostly on its
#    own blind spot rather than on the defect. A guard that mostly cries wolf collects a reflex
#    escape hatch, and then it does not catch the real case either -- worse than not existing.
#    So: refusal needs POSITIVE evidence (a commit naming a DIFFERENT card); everything it could not
#    classify is printed by name on every run, so silence is never the answer. Fail-closed on the
#    evidence, loud about its absence.
#
# 2. THE CARD ID IS READ ANCHORED TO THE WORD "card", NEVER AS BARE HEX. This false positive is
#    already in the data: `feat(local-llm): per-model operator kill switch (card 5d151091, pair-FE
#    5dd4a211)` carries TWO 8-hex ids, and the second one is a PAIRED card, not this commit's card.
#    A bare `[0-9a-f]{8}` scan reads it as a foreign card and refuses a perfectly good landing --
#    the same class the Gate-SHA: line (rule 4b) was introduced to end. Two shapes are accepted,
#    both taken from real history: `card <id>` (prose may follow a comma: ", round 4", ", pair-FE
#    ...", ", Cybered NO-GO") and `card <id> / <id>` (measured: `card e90505bb / 96ff46d4`).
#    This deliberately UNDER-detects rather than misfire: a missed warning is today's state, a false
#    stop is the whole fleet.
#
# 3. MERGE COMMITS ARE DROPPED FROM THE RANGE (--no-merges, applied by the caller). An agent merging
#    origin/main into their own branch is normal. The subtle part: that merge commit IS inside
#    `origin/main..$SHA` (it is not reachable from main), while the commits it brings in are NOT
#    (they are main's own ancestors). So --no-merges cuts exactly the noise and keeps the genuinely
#    new work. If the agent merged ANOTHER AGENT's branch, its commits appear as ordinary non-merge
#    commits carrying their own card ids -- and are correctly caught.
#
# WHY marveen-land.sh REPORTS WHERE cleancore-land.sh REFUSES. cleancore-land.sh is called as
# `<cardId> <gated-sha>`: one card per landing, and the gate happens BEFORE the landing. marveen has
# neither -- `marveen-land.sh <agent>` lands a whole agent branch, and the sha it returns IS the
# Gate-SHA (root CLAUDE.md), i.e. the gate happens AFTER. Measured over the last 14 marveen
# landings: 1-11 commits each, several carrying two or more cards plus card-less commits, and
# MikroB's `--all` sweep lands exactly that on purpose. A CleanCore-shaped refusal there would stop
# the majority of normal landings -- this card's own trap 4, on the real data. So marveen reports by
# default and refuses only when the caller NAMES the card (`--card <id>`), which is the case where
# "this landing is one card's work" is actually being claimed.
#
# Kill switch: LANDING_DOWNWARD_CHECK=off (the BLAST_RADIUS_GUARD=off pattern) -- a wrong call here
# blocks every landing, so it must be switchable off without a commit.

# Card ids referenced by ONE commit subject, one per line, lowercased. See decision 2 above.
cards_in_subject() {
  printf '%s\n' "${1:-}" \
    | grep -oiE '\bcards?[[:space:]]+[0-9a-f]{8}\b([[:space:]]*/[[:space:]]*[0-9a-f]{8}\b)*' \
    | grep -oiE '\b[0-9a-f]{8}\b' \
    | tr 'A-F' 'a-f'
}

# Every card id named in the log, unique and sorted. Reads "sha<TAB>subject" lines on stdin.
distinct_cards() {
  local sha subj
  while IFS=$'\t' read -r sha subj; do
    [ -n "$sha" ] || continue
    cards_in_subject "$subj"
  done | sort -u
}

# The commits that name no card at all -- printed, never judged. Reads "sha<TAB>subject" on stdin.
unattributed_commits() {
  local sha subj
  while IFS=$'\t' read -r sha subj; do
    [ -n "$sha" ] || continue
    [ -n "$(cards_in_subject "$subj")" ] || printf '%s %s\n' "$sha" "$subj"
  done
}

# The COMMITS that belong to no card we are landing. Reads "sha<TAB>subject", prints "sha subject".
#
# THE UNIT OF JUDGEMENT IS THE COMMIT, NOT THE CARD ID -- found by replaying this check over the
# last 14 real landings in each repo before trusting it. CleanCore's 1a61865f is ONE commit whose
# subject reads `(card e90505bb / 96ff46d4)`: it belongs to BOTH cards, legitimately. Scoring card
# ids independently would have called 96ff46d4 "another card's work" while landing e90505bb and
# refused a landing that is entirely correct. A commit is foreign only when NONE of the cards it
# names is the one being landed or explicitly allowed.
#   foreign_commits <own-card> <allow-csv>   < "sha<TAB>subject" lines
foreign_commits() {
  local own allow sha subj id ids mine
  own="$(printf '%s' "${1:-}" | tr 'A-F' 'a-f')"
  allow="$(printf '%s' "${2:-}" | tr 'A-F' 'a-f' | tr -d '[:space:]')"
  while IFS=$'\t' read -r sha subj; do
    [ -n "$sha" ] || continue
    ids="$(cards_in_subject "$subj")"
    # Names no card at all -> not foreign, only unattributed (decision 1); the caller lists it.
    [ -n "$ids" ] || continue
    mine=0
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      [ "$id" = "$own" ] && { mine=1; break; }
      case ",$allow," in *",$id,"*) mine=1; break ;; esac
    done <<< "$ids"
    [ "$mine" = "1" ] || printf '%s %s\n' "$sha" "$subj"
  done
}

# The card ids named by those foreign commits -- exactly what --allow-stacked would have to list.
foreign_cards() {
  local sha subj
  foreign_commits "$@" | while read -r sha subj; do cards_in_subject "$subj"; done | sort -u
}

# The whole check, rendered identically by both landers.
#   downward_check <log-text> <own-card|""> <allow-csv> <enforce 0|1> <label>
# log-text: "sha<TAB>subject" lines for the range, merges already dropped by the caller.
# Returns 0 = continue, 1 = refuse (only ever 1 when enforce=1).
downward_check() {
  local log="$1" own="${2:-}" allow="${3:-}" enforce="${4:-0}" label="${5:-landing}"

  if [ "${LANDING_DOWNWARD_CHECK:-on}" = "off" ]; then
    echo "  $label: downward check DISABLED (LANDING_DOWNWARD_CHECK=off)"
    return 0
  fi
  if [ -z "${log//[[:space:]]/}" ]; then
    echo "  $label: nothing rides along below the tip"
    return 0
  fi

  local n cards unattr fgc fgn
  n="$(printf '%s\n' "$log" | grep -c . || true)"
  cards="$(printf '%s\n' "$log" | distinct_cards | tr '\n' ' ')"
  unattr="$(printf '%s\n' "$log" | unattributed_commits)"
  fgc="$(printf '%s\n' "$log" | foreign_commits "$own" "$allow")"
  fgn="$(printf '%s\n' "$log" | foreign_cards "$own" "$allow")"

  echo "  $label: $n commit(s) ride along; cards named: ${cards:-none}"
  # An override that leaves no trace is the same silence this check exists to end: without this
  # line, a landing waved through with --allow-stacked reads exactly like a landing that had
  # nothing to wave. Print what the flag actually suppressed, not just that it was passed.
  if [ -n "${allow//[[:space:],]/}" ]; then
    local waved
    waved="$(printf '%s\n' "$log" | foreign_cards "$own" "" \
             | while IFS= read -r id; do case ",$(printf '%s' "$allow" | tr 'A-F' 'a-f' | tr -d '[:space:]')," in *",$id,"*) echo "$id" ;; esac; done | tr '\n' ' ')"
    [ -z "$waved" ] || echo "  $label: taken ON PURPOSE via --allow-stacked: $waved"
  fi
  if [ -n "$unattr" ]; then
    echo "  $label: naming no card (not judged, listed so it is never silent):"
    printf '%s\n' "$unattr" | sed 's/^/      /'
  fi
  [ -n "$fgc" ] || return 0

  if [ "$enforce" = "1" ]; then
    echo "  $label: OTHER cards' commits are in this range:"
  else
    # No card was named, so "other" would be a claim this call cannot make -- it is just the list.
    echo "  $label: the card-attributed commits riding along:"
  fi
  printf '%s\n' "$fgc" | sed 's/^/      /'

  if [ "$enforce" != "1" ]; then
    echo "  $label: reported only -- name the card (--card <id>) to make this a refusal"
    return 0
  fi
  {
    echo "         cherry-pick this card's own commits onto a fresh branch instead of merging,"
    echo "         or re-run with --allow-stacked $(printf '%s' "$fgn" | tr '\n' ',' | sed 's/,$//')"
    echo "         to say you are taking them ON PURPOSE. See store/landing-cherry-pick-vs-branch-merge.md."
  } >&2
  return 1
}

# --- selftest, called from BOTH landers' --selftest mode ----------------------------------------
# Lives here rather than duplicated in each lander for the same anti-drift reason as the code above.
# Expects the caller to have defined `t <name> <got> <want>`, which both landers already do.
# Cases 1-5 are the shapes card dfff9b37 names, plus the false positives that decide whether this
# guard is usable at all; case 6 runs the REAL range command on a synthetic repo, because the
# merge-dropping rule (decision 3) is a property of the git invocation, not of the classifier, and a
# unit test that hand-feeds a merge-free log would prove nothing about it.
downward_selftest_cases() {
  local L rc tmp
  rc_of() { downward_check "$1" "$2" "${3:-}" "${4:-1}" test >/dev/null 2>&1; echo $?; }

  t "anchored: reads the id after 'card'" \
    "$(cards_in_subject 'feat(x): thing (card 0f7f7fe9, round 4)')" "0f7f7fe9"
  t "anchored: a pair-FE id in the SAME subject is not a card ref" \
    "$(cards_in_subject 'feat: kill switch (card 5d151091, pair-FE 5dd4a211)')" "5d151091"
  t "anchored: the slash form names both cards" \
    "$(cards_in_subject 'docs: proto (card e90505bb / 96ff46d4)' | tr '\n' ' ')" "e90505bb 96ff46d4 "
  t "anchored: bare hex without the word 'card' is not a ref" \
    "$(cards_in_subject 'fix: Discard deadbeef leftovers')" ""

  L="$(printf 'aaa1111\tfeat: own (card 11111111)\n')"
  t "clean range -- only this card's commit -- passes" "$(rc_of "$L" 11111111)" "0"

  L="$(printf 'aaa1111\tfeat: own (card 11111111)\nbbb2222\tfix: own again (card 11111111)\n')"
  t "several commits for the SAME card still pass" "$(rc_of "$L" 11111111)" "0"

  L="$(printf 'aaa1111\tfeat: own (card 11111111)\nbbb2222\tfix: someone else (card 22222222)\n')"
  t "another card's commit in the range REFUSES" "$(rc_of "$L" 11111111)" "1"
  t "--allow-stacked naming it releases the refusal" "$(rc_of "$L" 11111111 22222222)" "0"
  t "...and SAYS so, so the override is never silent" \
    "$(downward_check "$L" 11111111 22222222 1 test 2>/dev/null | grep -c 'ON PURPOSE via --allow-stacked: 22222222')" "1"
  t "an --allow-stacked that suppressed nothing does not claim it did" \
    "$(downward_check "$L" 11111111 99999999 1 test 2>/dev/null | grep -c 'ON PURPOSE')" "0"
  t "--allow-stacked naming a DIFFERENT card does not release it" "$(rc_of "$L" 11111111 33333333)" "1"
  t "report mode (no card named) never refuses" "$(rc_of "$L" '' '' 0)" "0"
  t "the kill switch passes what would otherwise refuse" \
    "$(LANDING_DOWNWARD_CHECK=off rc_of "$L" 11111111)" "0"
  t "the refusal names the foreign commit itself, not just a count" \
    "$(downward_check "$L" 11111111 '' 1 test 2>/dev/null | grep -c 'bbb2222 fix: someone else')" "1"
  t "the refusal tells the operator the exact --allow-stacked to use" \
    "$(downward_check "$L" 11111111 '' 1 test 2>&1 >/dev/null | grep -c 'allow-stacked 22222222')" "1"

  # The real false positive this check was replayed against before being trusted: ONE commit that
  # legitimately names TWO cards (CleanCore 1a61865f). Landing either of them must NOT flag it.
  L="$(printf 'aaa1111\tdocs: proto (card e90505bb / 96ff46d4)\n')"
  t "a commit naming TWO cards is not foreign to EITHER of them" "$(rc_of "$L" e90505bb)" "0"
  t "...nor to the other one" "$(rc_of "$L" 96ff46d4)" "0"
  L="$(printf 'aaa1111\tdocs: proto (card e90505bb / 96ff46d4)\nbbb2222\tfix: third card (card 22222222)\n')"
  t "but a genuinely third card still refuses" "$(rc_of "$L" e90505bb)" "1"
  t "the --allow-stacked hint lists only the third card" \
    "$(printf '%s\n' "$L" | foreign_cards e90505bb '' | tr '\n' ' ')" "22222222 "

  L="$(printf 'aaa1111\tfeat: own (card 11111111)\nccc3333\tchore(fork-guard): re-acknowledge drift\n')"
  t "a commit naming NO card does not refuse (decision 1)" "$(rc_of "$L" 11111111)" "0"
  t "...but it is listed by name, so it is never silent" \
    "$(downward_check "$L" 11111111 '' 1 test 2>/dev/null | grep -c 'ccc3333 chore(fork-guard)')" "1"

  t "an empty range passes and says so" "$(rc_of '' 11111111)" "0"

  # Case 6: the real range command, on a throwaway repo. `git log --no-merges main..feature` must
  # drop BOTH the agent's merge of main AND main's own commits, and keep only the branch's work.
  tmp="$(mktemp -d)"
  (
    cd "$tmp" || exit 1
    export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
    git init -q . && git checkout -q -b main
    git commit -q --allow-empty -m 'chore: base (card 99999999)'
    git checkout -q -b feature
    git commit -q --allow-empty -m 'feat: own work (card 11111111)'
    git checkout -q main
    git commit -q --allow-empty -m 'chore: main moved on (card 88888888)'
    git checkout -q feature
    git merge -q --no-ff main -m 'Merge branch main into feature'
    git commit -q --allow-empty -m 'feat: more own work (card 11111111)'
  ) >/dev/null 2>&1
  L="$(git -C "$tmp" log --no-merges --format='%h%x09%s' main..feature 2>/dev/null)"
  t "synthetic repo: the range holds exactly the branch's own 2 commits" \
    "$(printf '%s\n' "$L" | grep -c .)" "2"
  t "synthetic repo: an interleaved merge of main does NOT refuse" "$(rc_of "$L" 11111111)" "0"
  t "synthetic repo: main's own commit is not read as a foreign card" \
    "$(printf '%s\n' "$L" | foreign_cards 11111111 '' | grep -c 88888888)" "0"
  git -C "$tmp" -c user.name=t -c user.email=t@t \
    commit -q --allow-empty -m 'fix: an earlier card, never gated here (card 22222222)' 2>/dev/null
  L="$(git -C "$tmp" log --no-merges --format='%h%x09%s' main..feature 2>/dev/null)"
  t "synthetic repo: an earlier card's commit under the tip REFUSES" "$(rc_of "$L" 11111111)" "1"
  rm -rf "$tmp"
}

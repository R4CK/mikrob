#!/usr/bin/env bash
# names_another_card -- is this commit provably SOMEONE ELSE'S card's work? (card 928251b5)
#
# THE INCIDENT. On card 54d4a4a3, Cybersec's prose quoted `ee864511` as a dated reference. It IS a
# real commit, so gate-pretriage-card.sh's "does it resolve to a commit" disambiguation accepted it
# as this card's new work -- but its own message reads `feat(proof): ... (card 550befbf)`. Pre-triage
# posted a verdict:null round for it, the close-time dependency check read that as a NEW gate round,
# and a perfectly valid Cybersec GO became "stale". 54d4a4a3 had to be closed with force:true, over a
# commit nobody on that card wrote.
#
# EXCLUSION, NOT PREFERENCE, and the difference is the entire fix. kanban-landed-guard's
# `attributedToCard` PREFERS commits naming the card and keeps everything when none does. That is
# right there and useless here: NO commit names 54d4a4a3 at all (checked in the repo), so a
# preference rule falls straight back to the same wrong answer. The commit message gives NEGATIVE
# evidence instead -- a message naming a card is its author saying whose work it is, so one naming a
# DIFFERENT card is provably not ours.
#
# A commit naming NO card is KEPT. Deliberate, and it preserves the breadth the earlier cards in this
# area asked for: not every commit carries an id, and the "same work, new sha after a rebase or
# cherry-pick" case depends on it. This narrows only where it has proof, never on a guess.
#
#   names_another_card <repo> <sha> <cardId>   -> 0 = foreign (skip it), 1 = keep
#
# Sourced by gate-pretriage-card.sh; its own selftest runs it against real git repos.

names_another_card() {
  local repo="$1" commit="$2" card="$3" msg ids
  msg="$(git -C "$repo" log -1 --format=%B "$commit" 2>/dev/null)" || return 1
  # Anchored on the fleet's own convention, `card <8hex>`. A bare hex ANYWHERE else in the message is
  # NOT a card claim -- that loose reading is precisely the failure this exists to stop, so widening
  # it here would reintroduce the bug in the fix.
  ids="$(printf '%s' "$msg" \
    | grep -oiE 'card[[:space:]]+[0-9a-f]{8}' \
    | grep -oiE '[0-9a-f]{8}$' \
    | tr 'A-F' 'a-f' | sort -u)"
  [[ -n "$ids" ]] || return 1                 # names no card: no proof either way, keep
  grep -qix "$card" <<< "$ids" && return 1    # names THIS card: best possible evidence, keep
  return 0                                    # names only other cards: provably not ours
}

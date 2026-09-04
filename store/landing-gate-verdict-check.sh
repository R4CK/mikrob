#!/usr/bin/env bash
# gate_verdict_check -- does the card actually CARRY a gate verdict for the sha being landed?
#
# WHY (card 9081d02d, the 08dcc153 incident). On 2026-09-03 a CleanCore card landed on origin/main
# with the commit message "gate-teljes @ 645b8ece" while the card carried NO REVIEW, NO QA, NO
# Cybersec and NO Cybered comment at all. Nothing in the landing path ever asked. "Gate-complete"
# was an assertion by whoever typed the command, and the commit message repeated it as if it were a
# measurement -- which is exactly the shape of claim the fleet keeps getting burned by.
#
# So the claim gets checked against the board before the merge, not after the fact.
#
#   gate_verdict_check <cardId> <sha> <mode>     mode = refuse | report
#
# Exit / return: 0 = a QA verdict for this sha was found (or mode=report), 1 = refuse.
#
# WHY THE TWO MODES, and why marveen is NOT the strict one. The two landers are not symmetric, and
# measuring beats assuming here:
#
#   cleancore-land.sh <cardId> <gated-sha>   ONE card, and the sha was gated BEFORE landing.
#                                            The verdict exists by the time we are called. STRICT.
#   marveen-land.sh <agent>                  a whole agent BRANCH, legitimately several cards, and
#                                            marveen gates AFTER landing: the root CLAUDE.md says
#                                            "a visszaadott sha a Gate-SHA", i.e. the Gate-SHA IS
#                                            the sha this script is about to produce. Verified on
#                                            the three cards landed 2026-09-04 (b3bf3cc2,
#                                            d9b1b418, af5d3dbf): every one was already an ancestor
#                                            of origin/develop when its gate ran. Demanding a
#                                            verdict up front there is not a stricter rule, it is a
#                                            deadlock on a sha that does not exist yet. REPORT.
#
# Same shape as landing-downward-check.sh next door: shared code, different default, and the
# asymmetry written down rather than rediscovered.
#
# FAIL-CLOSED ON AN UNREADABLE BOARD, in refuse mode. If the dashboard is down or the token is
# missing we cannot tell a gated card from an ungated one, and this control exists precisely for
# the case where nobody checked. An unreachable board therefore refuses, and says that --allow-
# ungated is how a human overrides it -- rather than waving the landing through on a shrug.

GATE_CHECK_API="${GATE_CHECK_API:-http://127.0.0.1:3420}"
GATE_CHECK_TOKEN_FILE="${GATE_CHECK_TOKEN_FILE:-/home/neon/marveen/store/.dashboard-token}"

# EXIT CODES (card 171c9f42): 0 = proceed, 1 = no usable verdict (a caller MAY override this with
# an explicit, named flag), 2 = a FAILING verdict (never overridable). A caller that treats every
# non-zero the same reopens exactly the hole this card closed.
gate_verdict_check() {
  local card="$1" sha="$2" mode="${3:-refuse}"
  local strict=1
  [ "$mode" = "refuse" ] || strict=0

  if [ ! -r "$GATE_CHECK_TOKEN_FILE" ]; then
    if [ "$strict" -eq 1 ]; then
      echo "REFUSED: cannot read $GATE_CHECK_TOKEN_FILE, so the gate verdict on card $card is" >&2
      echo "         unverifiable. This check fails CLOSED on purpose: an unreadable board cannot" >&2
      echo "         tell a gated card from an ungated one. Override with --allow-ungated." >&2
      return 1
    fi
    echo "  gate-check: board unreadable, skipped (report mode)"
    return 0
  fi

  local body
  body="$(printf 'Authorization: Bearer %s\n' "$(cat "$GATE_CHECK_TOKEN_FILE")" \
    | curl -sS -m 20 -H @- "$GATE_CHECK_API/api/kanban/$card/comments" 2>/dev/null)" || body=""

  local verdict parser
  parser="$(dirname "${BASH_SOURCE[0]}")/landing-gate-verdict-parse.py"
  verdict="$(printf '%s' "$body" | python3 "$parser" "$sha" 2>/dev/null)" || verdict="UNREADABLE|parser failed"
  [ -n "$verdict" ] || verdict="UNREADABLE|empty response from the board"

  local kind="${verdict%%|*}" detail="${verdict#*|}"
  case "$kind" in
  OK)
    say_or_echo "  gate-check: card $card carries a verdict for $sha -- $detail"
    return 0
    ;;
  FAILED)
    echo "REFUSED: card $card carries a FAILING gate verdict for $sha -- $detail" >&2
    echo "         A failing verdict is never overridden by --allow-ungated. Fix it and re-gate." >&2
    # RETURN 2, NOT 1, and the distinction is the whole point (card 171c9f42). Three places said a
    # failing verdict can never be waved through by --allow-ungated, and none of them was true: the
    # flag did not override the DECISION, it skipped the CALL, so this branch never ran. Making the
    # caller able to tell "no verdict" (1) from "a FAILING verdict" (2) is what lets the flag
    # tolerate the first and never the second -- with one code the caller cannot express it.
    return 2
    ;;
  esac

  if [ "$strict" -eq 0 ]; then
    say_or_echo "  gate-check: $detail (report only -- marveen gates AFTER landing, see this file's header)"
    return 0
  fi
  if [ "$kind" = "UNREADABLE" ]; then
    echo "REFUSED: could not read the gate verdicts for card $card -- $detail" >&2
    echo "         Fails CLOSED: an unreadable board cannot tell a gated card from an ungated one." >&2
    echo "         Override with --allow-ungated once you have checked the card by hand." >&2
    return 1
  fi
  echo "REFUSED: card $card has no passing gate verdict for the sha being landed ($sha)." >&2
  echo "         $detail" >&2
  echo "         This is the 08dcc153 shape: 'gate-complete' asserted by the caller, never checked." >&2
  # Do not tell someone to pass a flag they already passed (card 171c9f42). Now that the caller
  # ALWAYS calls this function, the override case reaches this branch too, and the old advice line
  # read as a refusal to a landing that was in fact about to proceed. The caller announces the
  # toleration itself; here we simply stop giving instructions that are already carried out.
  if [ "${GATE_CHECK_OVERRIDE_ARMED:-0}" != "1" ]; then
    echo "         If the landing is deliberately ungated (docs-only, own infra card), re-run with" >&2
    echo "         --allow-ungated, which says so in the open instead of leaving it implied." >&2
  fi
  return 1
}

# The landers define say(); a bare source in a selftest may not.
say_or_echo() { if declare -F say >/dev/null 2>&1; then say "$*"; else echo "$*"; fi; }

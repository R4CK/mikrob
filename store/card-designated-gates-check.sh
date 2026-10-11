#!/usr/bin/env bash
# card_designated_gates_agree -- do ALL the gates a card's own "Gate:" line(s) designate AGREE
# on the sha about to be landed? (card cd3e577b, MikroB's decisions on RedHat's second NO-GO,
# comment 16324, and third NO-GO, comment 16402 -- the latter is the N1 change below, overriding
# the weaker reading in 16277/16324.)
#
# WHY THIS EXISTS ON TOP OF gate_verdict_check (landing-gate-verdict-check.sh). That helper is
# QA-mandatory only: landing-gate-verdict-parse.py returns OK the moment it finds a QA PASS naming
# the sha, and treats a security-gate PASS/GO as purely informational ("also ...") even when the
# card's own Gate: line designates one. RedHat measured this directly against the real tool
# (comment 16322, finding B1): a scratch card designating "QA + Cybered", carrying an OLD Cybered
# NO-GO plus a NEW QA PASS on the tip being landed, landed successfully -- rc 0, "card ... carries a
# verdict ... qa: QA PASS" -- with the designated security gate never re-consulted for the new sha.
# That is exactly the "code reaches develop without its own required gate" class this whole card
# (F1, per-card worktree/landing) exists to close, so checking QA alone is not enough for --card mode.
#
# This reuses gate-closure-check.py (already measuring "do the gates agree with each other, on THIS
# sha" for the 4a board-reconciliation rule) rather than inventing a second comparison.
#
# N1 (MikroB decision 16402, on this card's own designation reading): TWO changes from the first
# cut of this file. (a) LABELS NO LONGER COUNT -- "A @qa címke nem kijelölés" -- only the
# description's own "Gate: ..." line(s) designate; a kanban label is informational routing, not a
# binding requirement, and mopsion-land.sh's older label-priority reading is a SEPARATE, unchanged
# tool for a separate lander. (b) the designated set is the UNION of EVERY "Gate: ..." line in the
# description (a card can grow a second Gate: line in a later delta round), not just the last one.
# (c) if NONE of the description's "Gate:" lines resolve to a known gate name at all, that is no
# longer "nothing extra to require" -- it is REFUSED (rc 1, overridable with --allow-ungated, same
# as every other missing-verdict case): a card must say what gates it needs, in words a machine can
# read, or an operator has to say "--allow-ungated" out loud to land it anyway.
#
#   card_designated_gates_agree <cardId> <sha>
#
# Return: 0 = AGREE on every description "Gate:" line's union,
#         1 = no usable AGREE yet (missing/stale/unresolved/unreadable/no-interpretable-Gate-line
#             -- overridable),
#         2 = a FAILING verdict for this sha exists among the designated gates (never overridable).
#
# Sets CARD_DESIGNATED_GATES_CSV (global, deliberately not `local`, same shape as LAND_LOCK_FD) to
# whatever it read -- possibly empty -- on every return path once the board was readable, so the
# caller can print the ACTUAL designation it checked against into its landing/ungated comment
# (MikroB decision 16402, N1: "a landolás-komment írja ki a kiolvasott kijelölést").
card_designated_gates_agree() {
  local card="$1" sha="$2" h="${GATE_CHECK_TOKEN_FILE:-/home/neon/marveen/store/.dashboard-token}"
  local api="${GATE_CHECK_API:-http://127.0.0.1:3420}"

  if [ ! -r "$h" ]; then
    echo "REFUSED: cannot read $h, so card $card's designated gates are unverifiable." >&2
    echo "         Fails CLOSED on purpose. Override with --allow-ungated." >&2
    return 1
  fi

  local cards_json
  cards_json="$(printf 'Authorization: Bearer %s\n' "$(cat "$h")" \
    | curl -sS -f -m 20 -H @- "$api/api/kanban" 2>/dev/null)" || cards_json=""
  if [ -z "$cards_json" ]; then
    echo "REFUSED: could not read the board to find card $card's designated gates." >&2
    return 1
  fi

  local here gates_csv rc
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # N1: labels are deliberately NOT read here any more -- only the description's "Gate:" line(s),
  # unioned across every match. gate_designation.py's designated_from_gate_line is imported
  # directly (not via its CLI, which only ever took one line) so every match can be unioned here.
  gates_csv="$(CID="$card" PYTHONPATH="$here${PYTHONPATH:+:$PYTHONPATH}" python3 -c '
import json, os, re, sys
from gate_designation import designated_from_gate_line
try:
    cards = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(cards, list):
    sys.exit(1)
cid = os.environ["CID"]
for c in cards:
    if c.get("id") == cid:
        rx = re.compile(r"\bGate\s*:\s*(.+)$", re.M | re.I)
        union = set()
        for m in rx.findall(c.get("description") or ""):
            names = designated_from_gate_line(m)
            if names:
                union |= names
        print(",".join(sorted(union)))
        sys.exit(0)
sys.exit(1)
' <<< "$cards_json" 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "REFUSED: card $card not found on the board -- cannot read its designated gates." >&2
    return 1
  fi
  CARD_DESIGNATED_GATES_CSV="$gates_csv"
  if [ -z "$gates_csv" ]; then
    # N1 (MikroB decision 16402): no "Gate:" line in the description resolved to a known gate name
    # at all -- this no longer passes through as "nothing extra to require". A card must say what
    # it needs in a machine-readable way, or --allow-ungated has to be said out loud to land it.
    echo "REFUSED: card $card has no interpretable 'Gate:' line in its description -- cannot tell" >&2
    echo "         what it designates. Fails CLOSED on purpose. Override with --allow-ungated." >&2
    return 1
  fi

  local comments_json verdict
  comments_json="$(printf 'Authorization: Bearer %s\n' "$(cat "$h")" \
    | curl -sS -f -m 20 -H @- "$api/api/kanban/$card/comments" 2>/dev/null)" || comments_json=""
  if [ -z "$comments_json" ]; then
    echo "REFUSED: could not read card $card's comments to check its designated gates." >&2
    return 1
  fi
  verdict="$(printf '%s' "$comments_json" \
    | python3 "$here/gate-closure-check.py" "$gates_csv" --expect "$sha" --no-landed 2>/dev/null)"
  local kind="${verdict%%|*}"
  case "$kind" in
    AGREE)
      say_or_echo "  designated-gate-check: $gates_csv all AGREE on $sha ($verdict)"
      return 0
      ;;
    FAILED)
      echo "REFUSED: card $card's designated gates ($gates_csv) carry a FAILING verdict -- $verdict" >&2
      echo "         A failing verdict is never overridden by --allow-ungated. Fix it and re-gate." >&2
      return 2
      ;;
    *)
      echo "REFUSED: card $card's designated gates ($gates_csv) do not all AGREE on $sha -- $verdict" >&2
      echo "         Override with --allow-ungated once you have checked the card by hand." >&2
      return 1
      ;;
  esac
}

# Shared with landing-gate-verdict-check.sh; redefine only if this file is sourced standalone.
declare -F say_or_echo >/dev/null 2>&1 || say_or_echo() {
  if declare -F say >/dev/null 2>&1; then say "$*"; else echo "$*"; fi
}

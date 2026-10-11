#!/usr/bin/env bash
# card_designated_gates_agree -- do ALL the gates a card's own "Gate:" line/labels designate AGREE
# on the sha about to be landed? (card cd3e577b, MikroB's decision on RedHat's second NO-GO, comment
# 16324, overriding the weaker reading in 16277.)
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
# sha" for the 4a board-reconciliation rule) rather than inventing a second comparison -- and reuses
# the exact labels/Gate-line extraction mopsion-land.sh's _gate_designation_snapshot already proved,
# rewritten here rather than sourced from that file: mopsion-land.sh is a separate, higher-risk
# production lander and this card's scope is marveen-land.sh's --card mode only (surgical change).
#
#   card_designated_gates_agree <cardId> <sha>
#
# Return: 0 = AGREE (or the card designates no gates at all -- nothing extra to require),
#         1 = no usable AGREE yet (missing/stale/unresolved/unreadable -- overridable),
#         2 = a FAILING verdict for this sha exists among the designated gates (never overridable).
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

  local here designated
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  designated="$(CID="$card" python3 -c '
import json, os, re, sys
try:
    cards = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(cards, list):
    sys.exit(1)
cid = os.environ["CID"]
for c in cards:
    if c.get("id") == cid:
        labels = ",".join(l.get("name", "").lstrip("@") for l in (c.get("labels") or []))
        rx = re.compile(r"\bGate\s*:\s*(.+)$", re.M | re.I)
        matches = rx.findall(c.get("description") or "")
        line = matches[-1] if matches else ""
        print(labels + "\n" + line)
        sys.exit(0)
sys.exit(1)
' <<< "$cards_json" 2>/dev/null)"
  if [ $? -ne 0 ]; then
    echo "REFUSED: card $card not found on the board -- cannot read its designated gates." >&2
    return 1
  fi
  local labels gate_line
  labels="$(printf '%s' "$designated" | sed -n '1p')"
  gate_line="$(printf '%s' "$designated" | sed -n '2p')"
  local gates_csv
  gates_csv="$(python3 "$here/gate_designation.py" "$labels" "$gate_line" 2>/dev/null)"
  if [ -z "$gates_csv" ]; then
    # No designation at all -- nothing extra to require (card cd3e577b's own card is the normal
    # case: it DOES designate, this branch is for cards that do not).
    return 0
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

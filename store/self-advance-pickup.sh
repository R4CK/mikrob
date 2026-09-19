#!/usr/bin/env bash
# self-advance-pickup.sh <agent> <cardId> -- the single entry point a self-advancing role-agent calls
# when it picks its own next planned card (root CLAUDE.md rule 11a), instead of hand-curling
# `POST /api/kanban/<id>/move {"status":"in_progress"}` itself.
#
# WHY THIS EXISTS (card 3906d77b, Peti Telegram 8748/8835): the heartbeat's own C section 4b step
# already runs card-build-route.sh before MikroB dispatches a card to another agent, and if the
# verdict is LOCAL, puts the local-llm-rag.sh command straight into the dispatch message. But that
# path only fires when MikroB itself picks the card up. A role-agent's SELF-advance pickup (11a) is a
# different code path entirely -- prose in CLAUDE.md that each agent's own turn follows -- and nothing
# on it ever called the router. MEASURED: card-build-route.log's last entry before this card was
# 2026-09-18 08:41; every card picked up by self-advance since then never reached the router at all.
# "Local-first" therefore lived on exactly one of the fleet's two dispatch paths.
#
# What this does, IN ORDER, and every step fails toward "pick the card up anyway":
#   1. LOCAL_FIRST_DRAFT flag (env var, or store/local-first-draft.json {"enabled":false}). Default ON;
#      the flag's ABSENCE means ON. OFF skips straight to step 5 -- the pre-3906d77b self-advance
#      behaviour: PUT in_progress, no draft attempt, exactly like the flag never existed.
#   2. Ollama health check FIRST (plan-grilling point 3): `local-llm.sh --health`, the SAME check
#      local-llm.sh's own --mode health already performs -- not reinvented. Down -> one log line,
#      skip straight to step 5. This is a genuinely measured failure mode: Ollama did not survive the
#      2026-09-18 07:21 WSL restart and stayed down until 08:22 (MikroB, comment 5355) -- without a
#      fast explicit check here, every leaf attempt inside offload-dispatch.sh would instead spend its
#      own internal timeout budget discovering the same thing, one leaf at a time.
#   3. card-build-route.sh <cardId>, with CARD_BUILD_ROUTE_DISPATCHER=self-advance exported so the log
#      (and card-build-route-24h-measure.sh's dispatcher breakdown) can tell this call apart from the
#      heartbeat's own mikrob-dispatch calls -- the actual measurement gap this card was opened to close.
#   4. LOCAL verdict -> offload-dispatch.sh <cardId> <agent>. That script already resolves the card's
#      open leaves, posts the "LOCAL-LLM DRAFT" comment itself, and nudges the owner -- nothing here
#      duplicates that. A non-LOCAL verdict (or offload-dispatch finding nothing local-eligible) simply
#      leaves the card undrafted, exactly like today.
#   5. PUT the card to in_progress, actor=<agent>. This is the ONE step that always runs, in every
#      branch above -- drafting is advisory, pickup is not.
#
# Usage: self-advance-pickup.sh <agent> <cardId>
# Exit 0 on a successful pickup (steps 1-4 are all best-effort and never change the exit code).
# Exit 1 only if step 5 itself fails (no token, or the API call did not return 200) -- the one failure
# the caller actually needs to react to, since nothing else in this script blocks the pickup.
# Exit 2 on bad usage.
#
# SECURITY: the dashboard token is never placed in argv -- read from file, sent via stdin header
# (`-H @-`), the fleet-wide pattern (token-in-argv-guard.test.ts enforces this repo-wide).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM="${SELF_ADVANCE_PICKUP_LLM:-$HERE/local-llm.sh}"
ROUTE="${SELF_ADVANCE_PICKUP_ROUTE:-$HERE/card-build-route.sh}"
OFFLOAD="${SELF_ADVANCE_PICKUP_OFFLOAD:-$HERE/offload-dispatch.sh}"
API="${SELF_ADVANCE_PICKUP_API:-http://localhost:3420}"
TOKEN_FILE="${SELF_ADVANCE_PICKUP_TOKEN_FILE:-$HERE/.dashboard-token}"
FLAG_FILE="${SELF_ADVANCE_PICKUP_FLAG_FILE:-$HERE/local-first-draft.json}"
LOG="${SELF_ADVANCE_PICKUP_LOG:-$HERE/card-build-route.log}"

AGENT="${1:-}"
CARD_ID="${2:-}"
if [ -z "$AGENT" ] || [ -z "$CARD_ID" ]; then
  echo "usage: self-advance-pickup.sh <agent> <cardId>" >&2
  exit 2
fi
# A card id is a hex slug, same guard card-build-route.sh uses -- refuse anything else rather than
# interpolating it into a URL or a shell command below.
if ! printf '%s' "$CARD_ID" | grep -Eq '^[0-9a-f]{6,40}$'; then
  echo "self-advance-pickup: bad card id '$CARD_ID'" >&2
  exit 2
fi

# EVIDENCE THAT THIS RAN, on the SAME log card-build-route.sh writes to, so a reader piecing together
# "why did/didn't card X get a draft" has one file to look at, not two. A SKIP line here (flag off,
# Ollama down) is deliberately shaped like a card-build-route.sh verdict line -- same field count, same
# tab layout -- so card-build-route-24h-measure.sh's capacity-reason regex can recognise it later if a
# future measurement wants to (it does not need to today; these two reasons never reach that script
# today because they short-circuit before card-build-route.sh would have logged anything at all).
log_skip() { # $1 = reason
  printf '%s\t%s\tONLINE\t%s\tcalls=0\tchars=0\tdispatcher=self-advance\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$CARD_ID" "$1" >> "$LOG" 2>/dev/null || true
}

# --- 1. FLAG --------------------------------------------------------------------------------------
# Env var wins over the file; either says the literal string "off" to disable. Anything else --
# including the flag file simply not existing -- means ON. Absence = ON (plan-grilling point 2).
LOCAL_FIRST_DRAFT="${LOCAL_FIRST_DRAFT:-}"
if [ -z "$LOCAL_FIRST_DRAFT" ] && [ -f "$FLAG_FILE" ]; then
  LOCAL_FIRST_DRAFT="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print("off" if d.get("enabled") is False else "on")
except Exception:
    print("on")
' "$FLAG_FILE" 2>/dev/null)"
fi

if [ "$LOCAL_FIRST_DRAFT" = "off" ]; then
  echo "self-advance-pickup: $CARD_ID -> LOCAL_FIRST_DRAFT=off, skipping local draft" >&2
  log_skip flag-off
else
  # --- 2. OLLAMA HEALTH, BEFORE ANYTHING ELSE (plan-grilling point 3) ------------------------------
  if ! bash "$LLM" --health >/dev/null 2>&1; then
    echo "self-advance-pickup: $CARD_ID -> ollama down, skipping local draft (never blocks pickup)" >&2
    log_skip ollama-down
  else
    # --- 3. CLASSIFY, ATTRIBUTED TO self-advance ----------------------------------------------------
    VERDICT="$(CARD_BUILD_ROUTE_DISPATCHER=self-advance bash "$ROUTE" "$CARD_ID" 2>/dev/null | tr -d '[:space:]')"
    if [ "$VERDICT" = "LOCAL" ]; then
      # --- 4. DRAFT. offload-dispatch.sh posts its own "LOCAL-LLM DRAFT" comment and nudge; nothing
      # here duplicates that. Its own output goes to stderr so it never corrupts this script's stdout.
      bash "$OFFLOAD" "$CARD_ID" "$AGENT" >&2 || true
    fi
  fi
fi

# --- 5. THE PICKUP ITSELF, ALWAYS ------------------------------------------------------------------
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null)"
if [ -z "$TOKEN" ]; then
  echo "self-advance-pickup: no dashboard token at $TOKEN_FILE, cannot PUT in_progress" >&2
  exit 1
fi
BODY="$(python3 -c 'import json,sys; print(json.dumps({"status":"in_progress","actor":sys.argv[1],"reason":"self-advance pickup"}))' "$AGENT")"
HTTP_CODE="$(printf 'Authorization: Bearer %s\n' "$TOKEN" \
  | timeout 10 curl -H @- -s -o /dev/null -w '%{http_code}' -X POST "$API/api/kanban/$CARD_ID/move" \
    -H 'Content-Type: application/json' -d "$BODY" 2>/dev/null)"
if [ "$HTTP_CODE" != "200" ]; then
  echo "self-advance-pickup: $CARD_ID -> PUT in_progress FAILED (http ${HTTP_CODE:-no-response})" >&2
  exit 1
fi
echo "self-advance-pickup: $CARD_ID -> in_progress (actor=$AGENT)"
exit 0

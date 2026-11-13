#!/usr/bin/env bash
# card-route-table-replay.sh -- retro check (card cdde2666, MikroB plan-grilling verdict
# comments 29500/29506, reassignment msg 17579: "retro check that zero money/auth/security cards
# would have left").
#
# F3's table layer invents no new sensitivity classifier -- it reuses the EXISTING gates. This
# proves that reuse holds on REAL history rather than merely asserting it: for every ONLINE
# verdict card-build-route.sh already logged for a content-shaped sensitive reason (sec-label,
# money, auth-tenant-scope, client-supplied-value, object-integrity, document-assembly -- the six
# reasons the verdict named by NAME; capacity/difficulty reasons like vram-hold or
# deterministic-multi-decision are a DIFFERENT axis and excluded on purpose), this re-fetches that
# real card and runs it through gemini-agy-category-check.py -- the pure content/secret filter
# that actually gates every freellm/Gemini egress call (store/freellm-call.sh,
# is_gemini_blocked()'s own content gate in store/offload-dispatch.sh). gemini-agy-category-check.py
# is used here rather than is_freellm_blocked() because that function ALSO gates on a project
# allowlist and the "gemini-ok" positive marker -- failing on those for unrelated reasons would
# make this check pass vacuously, telling us nothing about whether the CONTENT classification
# agrees. gemini-agy-category-check.py has no such gate; a match there is a real content signal.
#
# A VIOLATION is a card card-build-route.sh called sensitive-by-content that this filter finds
# clean -- exactly the gap that would let that card's text reach a non-Claude cloud hop once the
# table layer ever goes live.
#
# Usage: card-route-table-replay.sh [LOG_PATH]
# Exit 0 = zero violations (including "nothing to check"); exit 1 = at least one violation.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${1:-$HERE/card-build-route.log}"
GEMINI_CHECK="${CARD_ROUTE_REPLAY_GEMINI_CHECK:-$HERE/gemini-agy-category-check.py}"
API="${CARD_ROUTE_REPLAY_API:-http://localhost:3420}"
TOKEN_FILE="${CARD_ROUTE_REPLAY_TOKEN_FILE:-$HERE/.dashboard-token}"
# Test-only override: a command that prints a card's JSON given its id on argv, bypassing the
# live dashboard entirely. Production callers never set this.
CARD_JSON_CMD="${CARD_ROUTE_REPLAY_CARD_JSON_CMD:-}"

if [[ ! -f "$LOG" ]]; then
  echo "card-route-table-replay: no log at $LOG -- nothing to replay"
  exit 0
fi

# The six content-shaped reasons named in the plan-grilling verdict. Deliberately excludes every
# capacity/ambient ONLINE reason (vram-hold, model-busy, kill-switch, not-installed, no-token,
# card-unreadable, card-unparseable, empty-text, too-long, bad-card-id, no-argument,
# local-first-draft-off) and the two non-content-shaped reasons (deterministic-multi-decision,
# model-complex, route-classify-security/abstained, steering-attempt, deterministic-sec-label's
# siblings deterministic-shared-instruction-target/deterministic-ts-category) -- those are
# DIFFICULTY or SCOPE signals, not the sensitive-CONTENT signal this check is about (the
# verdict's own "sensitivity and difficulty are different axes" finding).
SENSITIVE_RE='^deterministic-(sec-label|money|auth-tenant-scope|client-supplied-value|object-integrity|document-assembly)$'

TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null)"
# Drop any inherited export attribute (same reasoning as card-build-route.sh's own TOKEN handling).
declare +x TOKEN

fetch_card_json() { # $1 = card id
  if [[ -n "$CARD_JSON_CMD" ]]; then
    "$CARD_JSON_CMD" "$1"
    return
  fi
  printf 'Authorization: Bearer %s\n' "$TOKEN" | timeout 10 curl -H @- -s "$API/api/kanban/$1" 2>/dev/null
}

mapfile -t CARD_IDS < <(awk -F'\t' -v re="$SENSITIVE_RE" \
  '$3=="ONLINE" && $4 ~ re && $2!="-" {print $2}' "$LOG" | sort -u)

checked=0
violations=0
skipped=0
for cid in "${CARD_IDS[@]}"; do
  [[ "$cid" =~ ^[0-9a-f]{6,40}$ ]] || continue
  json="$(fetch_card_json "$cid")"
  if [[ -z "${json// }" ]]; then
    echo "card-route-table-replay: SKIP $cid (unreadable -- archived/deleted/network)"
    skipped=$((skipped + 1))
    continue
  fi
  checked=$((checked + 1))
  cat_out="$(printf '%s' "$json" | python3 "$GEMINI_CHECK" "$cid" 2>/dev/null)"
  cat_rc=$?
  if [[ "$cat_rc" -eq 2 ]]; then
    : # "cannot verify" is itself fail-closed on freellm-call.sh's own side -- not a violation.
  elif [[ "$cat_rc" -ne 0 || -z "${cat_out// }" ]]; then
    violations=$((violations + 1))
    echo "card-route-table-replay: VIOLATION $cid -- card-build-route.sh called this sensitive, gemini-agy-category-check.py found nothing (rc=$cat_rc)"
  fi
done

echo "card-route-table-replay: checked=$checked skipped=$skipped violations=$violations log=$LOG"
[[ "$violations" -eq 0 ]]

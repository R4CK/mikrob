#!/usr/bin/env bash
# card-route-table-replay.sh -- retro check (card cdde2666, MikroB plan-grilling verdict
# comments 29500/29506, reassignment msg 17579: "retro check that zero money/auth/security cards
# would have left"). Fixed per Cybersec GO 29776 F-B and Cybered NO-GO 29789 F-A (MikroB dispatch
# msg 17674): the old version used gemini-agy-category-check.py (a narrower content/secret filter)
# and silently treated a 401/empty fetch (e.g. no token next to the script) and a checker rc=2 as
# "not a violation" -- a run with zero real cards checked printed the exact same
# "checked=146 skipped=0 violations=0" as a run that actually verified them.
#
# F3's table layer invents no new sensitivity classifier -- it reuses the EXISTING gates. This
# proves that reuse holds on REAL history rather than merely asserting it: for every ONLINE
# verdict card-build-route.sh already logged for a content-shaped sensitive reason (sec-label,
# money, auth-tenant-scope, client-supplied-value, object-integrity, document-assembly -- the six
# reasons the verdict named by NAME; capacity/difficulty reasons like vram-hold or
# deterministic-multi-decision are a DIFFERENT axis and excluded on purpose), this re-fetches that
# real card (authenticated) and runs it through the SAME REAL egress gate production code calls --
# is_freellm_blocked(), exposed by offload-dispatch.sh's own `--check-freellm-blocked` sub-command
# (the exact mechanism store/offload-dispatch.sh's --test-capacity-route already uses to check
# gate parity, no second copy of the decision). A VIOLATION is a card card-build-route.sh called
# sensitive-by-content that is_freellm_blocked() would ALLOW -- exactly the gap that would let
# that card's text reach a non-Claude cloud hop once the table layer ever goes live.
#
# FAIL LOUD, NOT QUIET: a 401/Unauthorized response, an empty/unparseable fetch, a missing or
# unreadable token file, a missing checker script, or a checker exit code other than the two the
# gate ever returns (0=blocked, 42=allowed) each make the run's result UNTRUSTWORTHY -- these now
# all count toward a non-zero exit, same as an actual violation. "Nothing could be verified" must
# never look like "verified, zero violations" on the exit code or in the summary line.
#
# Usage: card-route-table-replay.sh [LOG_PATH]
# Exit 0 = zero violations AND zero errors AND zero skips (including "nothing to replay", which
# has nothing to check by construction). Exit 1 = at least one violation, fetch/checker error, or
# skipped card.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${1:-$HERE/card-build-route.log}"
CHECKER="${CARD_ROUTE_REPLAY_CHECKER:-$HERE/offload-dispatch.sh}"
API="${CARD_ROUTE_REPLAY_API:-http://localhost:3420}"
TOKEN_FILE="${CARD_ROUTE_REPLAY_TOKEN_FILE:-$HERE/.dashboard-token}"
# Test-only override: a command that prints a card's JSON given its id on argv, bypassing the
# live dashboard entirely (also skips the token requirement below). Production callers never set this.
CARD_JSON_CMD="${CARD_ROUTE_REPLAY_CARD_JSON_CMD:-}"
# Test-only override: a command that prints a card's labels JSON (array) given its id on argv.
CARD_LABELS_CMD="${CARD_ROUTE_REPLAY_CARD_LABELS_CMD:-}"

if [[ ! -f "$LOG" ]]; then
  echo "card-route-table-replay: no log at $LOG -- nothing to replay"
  exit 0
fi

if [[ ! -f "$CHECKER" ]]; then
  echo "card-route-table-replay: FATAL -- checker not found at $CHECKER" >&2
  exit 1
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

TOKEN=""
if [[ -z "$CARD_JSON_CMD" ]]; then
  if [[ ! -r "$TOKEN_FILE" ]]; then
    echo "card-route-table-replay: FATAL -- no readable token at $TOKEN_FILE, cannot authenticate (a run without one cannot prove anything, see Cybered 29789 F-A)" >&2
    exit 1
  fi
  TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null)"
  # Drop any inherited export attribute (same reasoning as card-build-route.sh's own TOKEN handling).
  declare +x TOKEN
  if [[ -z "${TOKEN// }" ]]; then
    echo "card-route-table-replay: FATAL -- token file $TOKEN_FILE is empty" >&2
    exit 1
  fi
fi

fetch_json() { # $1 = url path (e.g. /api/kanban/<id>)
  printf 'Authorization: Bearer %s\n' "$TOKEN" | timeout 10 curl -H @- -s -w '\n%{http_code}' "$API$1" 2>/dev/null
}

fetch_card_json() { # $1 = card id; prints card JSON, or nothing on any failure
  if [[ -n "$CARD_JSON_CMD" ]]; then
    "$CARD_JSON_CMD" "$1"
    return
  fi
  local raw body code
  raw="$(fetch_json "/api/kanban/$1")"
  code="${raw##*$'\n'}"
  body="${raw%$'\n'*}"
  if [[ "$code" != "200" ]]; then
    echo "HTTP_$code"
    return
  fi
  printf '%s' "$body"
}

fetch_card_labels() { # $1 = card id; prints labels JSON array, or "[]" on any failure (absence of labels is not an error)
  if [[ -n "$CARD_LABELS_CMD" ]]; then
    "$CARD_LABELS_CMD" "$1"
    return
  fi
  local raw body code
  raw="$(fetch_json "/api/kanban/$1/labels")"
  code="${raw##*$'\n'}"
  body="${raw%$'\n'*}"
  [[ "$code" == "200" ]] || { printf '[]'; return; }
  printf '%s' "$body"
}

# tags_for_replay CARD_JSON LABELS_JSON -- prints a CSV of real label tags (upper, @-stripped).
# Deliberately does NOT re-extract title-bracket tags here: is_gemini_blocked() (called via
# --check-freellm-blocked below) already re-derives those from the title it is given, so doing it
# twice would only risk drifting from the one real implementation.
tags_for_replay() {
  python3 -c '
import json, sys
try:
    labels = json.loads(sys.argv[1])
except Exception:
    labels = []
tags = [str((lb or {}).get("name") or "").strip().lstrip("@").upper() for lb in (labels or [])]
print(",".join(dict.fromkeys(t for t in tags if t)))
' "$1" 2>/dev/null
}

mapfile -t CARD_IDS < <(awk -F'\t' -v re="$SENSITIVE_RE" \
  '$3=="ONLINE" && $4 ~ re && $2!="-" {print $2}' "$LOG" | sort -u)

checked=0
violations=0
skipped=0
errors=0
for cid in "${CARD_IDS[@]}"; do
  [[ "$cid" =~ ^[0-9a-f]{6,40}$ ]] || continue
  json="$(fetch_card_json "$cid")"
  if [[ -z "${json// }" ]]; then
    echo "card-route-table-replay: ERROR $cid -- empty response (timeout/network)"
    errors=$((errors + 1))
    continue
  fi
  if [[ "$json" == HTTP_401 ]]; then
    echo "card-route-table-replay: ERROR $cid -- 401 Unauthorized (bad or missing token)"
    errors=$((errors + 1))
    continue
  fi
  if [[ "$json" == HTTP_404 ]]; then
    echo "card-route-table-replay: SKIP $cid (404 -- archived/deleted)"
    skipped=$((skipped + 1))
    continue
  fi
  if [[ "$json" == HTTP_* ]]; then
    echo "card-route-table-replay: ERROR $cid -- $json"
    errors=$((errors + 1))
    continue
  fi
  parsed_id="$(printf '%s' "$json" | python3 -c '
import json, sys
try:
    print(json.loads(sys.stdin.read()).get("id") or "")
except Exception:
    print("")
' 2>/dev/null)"
  if [[ -z "$parsed_id" ]]; then
    echo "card-route-table-replay: ERROR $cid -- unparseable card response"
    errors=$((errors + 1))
    continue
  fi
  checked=$((checked + 1))
  title="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("title") or "")' 2>/dev/null)"
  desc="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("description") or "")' 2>/dev/null)"
  project="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("project") or "")' 2>/dev/null)"
  labels_json="$(fetch_card_labels "$cid")"
  tags="$(tags_for_replay "$labels_json")"

  bash "$CHECKER" --check-freellm-blocked "$project" "$tags" "$title" "$desc" >/dev/null 2>&1
  check_rc=$?
  case "$check_rc" in
    42)
      violations=$((violations + 1))
      echo "card-route-table-replay: VIOLATION $cid -- card-build-route.sh called this sensitive, is_freellm_blocked() says ALLOWED"
      ;;
    0)
      ;; # blocked -- agrees with card-build-route.sh, no violation
    *)
      errors=$((errors + 1))
      echo "card-route-table-replay: ERROR $cid -- checker exit $check_rc (expected 0=blocked or 42=allowed)"
      ;;
  esac
done

echo "card-route-table-replay: checked=$checked skipped=$skipped errors=$errors violations=$violations log=$LOG"
[[ "$violations" -eq 0 && "$skipped" -eq 0 && "$errors" -eq 0 ]]

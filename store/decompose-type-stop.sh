#!/usr/bin/env bash
# decompose-type-stop.sh -- per-decompose-type Draft-Review acceptance rate + auto stop-criterion
# (card d39fc5e7, requirement 3).
#
# WHAT. Scans kanban comments for local-llm drafts carrying the "<type> (mechanikus reszfeladat,
# card 501c489f)" marker card-build-route-24h-measure.sh already keys on, over a multi-day window
# (default 3 days, the card's own number), and matches each draft to the next Draft-Review verdict
# that lands on the SAME card afterward. A type with >= MIN_JUDGED (default 5) judged drafts and an
# acceptance rate (ELFOGADVA+RESZBEN / judged) under MIN_ACCEPT_PCT (default 30) gets written to
# decompose-type-disabled.json; card_decompose_candidates() (card-decompose-templates.sh) stops
# proposing that type the moment this file says so, in BOTH callers (offload-dispatch.sh and
# card-build-route.sh), because they share that one classifier.
#
# FULL RECOMPUTE EVERY RUN, NOT A STICKY ONE-WAY LOCK: this is not an incident log, it is a live
# gauge -- a type that was disabled can come back the moment a later run's window shows the rate
# recovered (e.g. after the sample-context fix, requirement 1 of this same card, actually lands).
# A one-way lock would require a human to remember to flip it back; this does not.
#
# WHY FELESLEGES/REDUNDANT IS EXCLUDED FROM THE DENOMINATOR: it means the draft was CORRECT but
# arrived after the agent had already fixed the thing itself -- a TIMING outcome, not a quality one
# (local-llm-offload skill, card 504ec76f). Counting it as a rejection would make a type that
# produces good-but-late drafts look like it produces BAD drafts, which is the wrong signal to stop
# a type over. A pending (undecided) draft is excluded too: it has not been judged yet.
#
# Usage:
#   decompose-type-stop.sh                        # recompute from the live board, 3-day window
#   decompose-type-stop.sh --days 7
#   decompose-type-stop.sh --json
#   decompose-type-stop.sh --test JUDGED ACCEPTED # pure threshold check, no network (see below)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="${DASHBOARD_URL:-http://localhost:3420}"
TOKEN_FILE="${DECOMPOSE_STOP_TOKEN_FILE:-$HERE/.dashboard-token}"
STATE_FILE="${DECOMPOSE_STOP_STATE_FILE:-$HERE/decompose-type-disabled.json}"
DAYS=3
MIN_JUDGED=5
MIN_ACCEPT_PCT=30
JSON=0

TYPES=(test-scaffold i18n-keys doc-update type-def)

while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="${2:-3}"; shift 2 ;;
    --json) JSON=1; shift ;;
    --min-judged) MIN_JUDGED="${2:-5}"; shift 2 ;;
    --min-accept-pct) MIN_ACCEPT_PCT="${2:-30}"; shift 2 ;;
    --test)
      # Pure threshold check, no network/board/state-file -- the exact decision rule a selftest can
      # pin without a live dashboard. --test JUDGED ACCEPTED -> prints DISABLE or KEEP.
      judged="${2:-0}"; accepted="${3:-0}"
      rate=0
      [ "$judged" -gt 0 ] && rate=$(( accepted * 100 / judged ))
      if [ "$judged" -ge "$MIN_JUDGED" ] && [ "$rate" -lt "$MIN_ACCEPT_PCT" ]; then
        echo "DISABLE"
      else
        echo "KEEP"
      fi
      exit 0 ;;
    *) printf 'usage: decompose-type-stop.sh [--days N] [--json] [--min-judged N] [--min-accept-pct N] [--test JUDGED ACCEPTED]\n' >&2; exit 2 ;;
  esac
done

NOW="$(date +%s)"
CUTOFF=$(( NOW - DAYS * 86400 ))
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"

CARDS_JSON="$(printf 'Authorization: Bearer %s\n' "$TOKEN" | timeout 15 curl -H @- -s "$DASH/api/kanban" 2>/dev/null)"
if [ -z "${CARDS_JSON// }" ]; then
  echo "decompose-type-stop: dashboard unreachable, nothing measured (state file left untouched)" >&2
  [ "$JSON" = 1 ] && printf '{"days":%s,"unreachable":true}\n' "$DAYS"
  exit 0
fi

CARD_IDS="$(printf '%s' "$CARDS_JSON" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
cards = d if isinstance(d, list) else d.get("cards", [])
for c in cards:
    cid = c.get("id")
    if cid:
        print(cid)
' 2>/dev/null)"

declare -A JUDGED ACCEPTED
for t in "${TYPES[@]}"; do JUDGED[$t]=0; ACCEPTED[$t]=0; done
# F4 fix: count fetch errors so we can detect total API unavailability; the
# stop decision stays fail-open (no type disabled) when ALL cards are unreachable,
# but we log it so operators can investigate rather than silently proceeding.
API_FETCH_ERRORS=0
API_FETCH_OK=0

while IFS= read -r cid; do
  [ -n "$cid" ] || continue
  comments="$(printf 'Authorization: Bearer %s\n' "$TOKEN" | timeout 10 curl -H @- -s "$DASH/api/kanban/$cid/comments" 2>/dev/null)"
  if [ -z "$comments" ]; then
    API_FETCH_ERRORS=$(( API_FETCH_ERRORS + 1 ))
    continue
  fi
  # Only count as "ok" if comments is valid JSON (not an HTML error page etc.)
  if ! printf '%s' "$comments" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
    API_FETCH_ERRORS=$(( API_FETCH_ERRORS + 1 ))
    continue
  fi
  API_FETCH_OK=$(( API_FETCH_OK + 1 ))
  result="$(printf '%s' "$comments" | CUTOFF="$CUTOFF" python3 -c '
import json, os, re, sys
cutoff = int(os.environ["CUTOFF"])
try:
    comments = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(comments, list):
    comments = comments.get("comments", []) if isinstance(comments, dict) else []
comments.sort(key=lambda c: c.get("created_at") or 0)
TYPES = ["test-scaffold", "i18n-keys", "doc-update", "type-def"]
rx_verdict = re.compile(r"^[ \t]*Draft-Review[ \t]*:[ \t]*(ELFOGADVA|ELUTAS[IÍ]TVA|R[EÉ]SZBEN|FELESLEGES|ACCEPTED|REJECTED|PARTIAL|REDUNDANT)\b", re.I | re.M)
drafts = []
for c in comments:
    if (c.get("author") or "").lower() != "local-llm":
        continue
    body = c.get("content") or ""
    if "LOCAL-LLM DRAFT" not in body:
        continue
    at = c.get("created_at") or 0
    if at < cutoff:
        continue
    for t in TYPES:
        if f"{t} (mechanikus reszfeladat" in body:
            drafts.append((t, at))
for dtype, draft_at in drafts:
    verdict = None
    for c in comments:
        if (c.get("author") or "").lower() == "local-llm":
            continue
        if (c.get("created_at") or 0) < draft_at:
            continue
        m = rx_verdict.search(c.get("content") or "")
        if m:
            verdict = m.group(1).upper()
            break
    if verdict is None:
        continue
    if verdict in ("FELESLEGES", "REDUNDANT"):
        continue
    outcome = "ACCEPT" if verdict in ("ELFOGADVA", "RESZBEN", "ACCEPTED", "PARTIAL") else "REJECT"
    print(f"{dtype}\t{outcome}")
' 2>/dev/null)"
  while IFS=$'\t' read -r dtype outcome; do
    [ -n "$dtype" ] || continue
    JUDGED[$dtype]=$(( ${JUDGED[$dtype]:-0} + 1 ))
    [ "$outcome" = "ACCEPT" ] && ACCEPTED[$dtype]=$(( ${ACCEPTED[$dtype]:-0} + 1 ))
  done <<< "$result"
done <<< "$CARD_IDS"

# F4: log when API was entirely unreachable so operators can notice
if [ "$API_FETCH_ERRORS" -gt 0 ]; then
  printf '[decompose-type-stop] API fetch errors: %d/%d cards unreachable (ok=%d); stop decision uses only ok cards\n' \
    "$API_FETCH_ERRORS" "$(( API_FETCH_ERRORS + API_FETCH_OK ))" "$API_FETCH_OK" >&2
fi

ROWS_FILE="$(mktemp)"
trap 'rm -f "$ROWS_FILE"' EXIT
NEWLY_DISABLED=()
for t in "${TYPES[@]}"; do
  j="${JUDGED[$t]:-0}"; a="${ACCEPTED[$t]:-0}"
  rate=0; [ "$j" -gt 0 ] && rate=$(( a * 100 / j ))
  disable=0
  if [ "$j" -ge "$MIN_JUDGED" ] && [ "$rate" -lt "$MIN_ACCEPT_PCT" ]; then
    disable=1
    NEWLY_DISABLED+=("$t")
  fi
  printf '%s\t%s\t%s\t%s\n' "$t" "$j" "$a" "$disable" >> "$ROWS_FILE"
done

python3 - "$STATE_FILE" "$NOW" "$ROWS_FILE" <<'PY'
import json, os, sys
state_file, now, rows_file = sys.argv[1], int(sys.argv[2]), sys.argv[3]
state = {}
with open(rows_file) as f:
    for line in f:
        line = line.rstrip("\n")
        if not line:
            continue
        t, judged, accepted, disable = line.split("\t")
        state[t] = {
            "judged": int(judged),
            "accepted": int(accepted),
            "disabled": disable == "1",
            "updated_at": now,
        }
tmp = state_file + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
os.replace(tmp, state_file)
PY

if [ "$JSON" = 1 ]; then
  python3 -c '
import json, sys
rows = {}
with open(sys.argv[1]) as f:
    for line in f:
        line = line.rstrip("\n")
        if not line:
            continue
        t, j, a, d = line.split("\t")
        rows[t] = {"judged": int(j), "accepted": int(a), "disabled": d == "1"}
print(json.dumps({"days": int(sys.argv[2]), "types": rows}))
' "$ROWS_FILE" "$DAYS"
else
  printf 'decompose-type-stop: last %sd window, min-judged=%s, min-accept-pct=%s\n' "$DAYS" "$MIN_JUDGED" "$MIN_ACCEPT_PCT"
  while IFS=$'\t' read -r t j a d; do
    [ -n "$t" ] || continue
    rate=0; [ "$j" -gt 0 ] && rate=$(( a * 100 / j ))
    state_word="enabled"; [ "$d" = "1" ] && state_word="DISABLED"
    printf '  %-14s judged=%-3s accepted=%-3s rate=%s%% -> %s\n' "$t" "$j" "$a" "$rate" "$state_word"
  done < "$ROWS_FILE"
  if [ "${#NEWLY_DISABLED[@]}" -gt 0 ]; then
    printf '  !! stop-criterion hit for: %s -- card_decompose_candidates() will not propose these types until a later run clears them\n' "${NEWLY_DISABLED[*]}"
  fi
fi

exit 0

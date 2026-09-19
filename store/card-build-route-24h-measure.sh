#!/usr/bin/env bash
# card-build-route-24h-measure.sh -- did the reversed default (card 3c075d74) actually change anything?
#
# THE THREE NUMBERS THE CARD ASKED FOR: how many cards went local-first in the measured window, how
# many the online agent continued with (Draft-Review: ELFOGADVA/RESZBEN), how many fell through to
# online (ELUTASITVA, or exhausted after 3 tries). Without this, "we reversed the default" is a claim
# about a skill file, not a measured fact about the fleet -- the same gap route-check-audit.sh (card
# 0c473a5e) closed for "did the router even run", applied one step further down the pipe: "did running
# it change anything".
#
# SOURCES, DELIBERATELY NOT DUPLICATED: card-build-route.log already names every verdict+reason per
# card (this script only reads it, never writes to it); the draft/review evidence already lives as
# kanban comments (author="local-llm" for the draft, a `Draft-Review:` line for the verdict, per
# kanban-draft-review-guard.ts, card 1338e68b) -- no new log format, no new comment convention.
#
# SOFT BY CONSTRUCTION, same as route-check-audit.sh: reports, never blocks, never moves a card. Exit
# 0 whenever the measurement itself ran; a non-zero exit means the SCRIPT broke, not that the fleet did
# something wrong.
#
#   card-build-route-24h-measure.sh              # human-readable report, last 24h
#   card-build-route-24h-measure.sh --hours 48   # a different window
#   card-build-route-24h-measure.sh --json
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${CARD_BUILD_ROUTE_MEASURE_LOG:-$HERE/card-build-route.log}"
API="${CARD_BUILD_ROUTE_MEASURE_API:-http://localhost:3420}"
TOKEN_FILE="${CARD_BUILD_ROUTE_MEASURE_TOKEN_FILE:-$HERE/.dashboard-token}"
HOURS=24
JSON=0

while [ $# -gt 0 ]; do
  case "$1" in
    --hours) HOURS="${2:-24}"; shift 2 ;;
    --json) JSON=1; shift ;;
    *) printf 'usage: card-build-route-24h-measure.sh [--hours N] [--json]\n' >&2; exit 2 ;;
  esac
done

# CAPACITY reasons: the card's content was never even considered, so it cannot count as "went
# local-first" or "fell through" -- there was nothing to attempt. Kept as a named list (not a
# heuristic) so a new capacity-reason added to card-build-route.sh has to be added here too, on
# purpose, rather than silently miscounted as a content decision.
CAPACITY_REGEX='^(vram-hold|model-busy|kill-switch|no-token|card-unreadable|card-unparseable|empty-text|too-long|bad-card-id|no-argument|route-check-failed|not-installed)$'

[ -f "$LOG" ] || { [ "$JSON" = 1 ] && printf '{"hours":%s,"dispatches":0,"capacity_skipped":0,"content_considered":0,"drafted":0,"continued_with_draft":0,"rejected_draft":0,"exhausted_no_draft":0,"pending_review":0,"dispatcher_self_advance":0,"dispatcher_orchestrator_dispatch":0,"dispatcher_unattributed":0}\n' "$HOURS" || printf 'card-build-route-24h-measure: no log at %s -- nothing to measure yet\n' "$LOG"; exit 0; }

now="$(date +%s)"
cutoff=$(( now - HOURS * 3600 ))

# One row per CARD, keeping only its LATEST verdict line inside the window (a card can be dispatched
# more than once; the latest verdict is the one that governed the dispatch this window cares about).
LATEST="$(TZ=$(date +%Z) awk -F'\t' -v cutoff="$cutoff" '
  NF >= 4 && $2 != "-" {
    cmd = "date -d \"" $1 "\" +%s 2>/dev/null"
    cmd | getline ts
    close(cmd)
    if (ts != "" && ts >= cutoff) {
      row[$2] = $3 "\t" $4 "\t" ts "\t" $7
    }
  }
  END { for (c in row) print c "\t" row[c] }
' "$LOG" 2>/dev/null)"

# DISPATCHER BREAKDOWN (card 3906d77b): which PATH produced a content decision -- the heartbeat's own
# C section 4b step (dispatcher=orchestrator-dispatch) or a role-agent's self-advance-pickup.sh
# (dispatcher=self-advance). A pre-3906d77b log line, or any caller that never set
# CARD_BUILD_ROUTE_DISPATCHER, carries no 7th field at all; that counts as "unattributed", not as
# either path -- guessing would misreport exactly the gap this field exists to close.
dispatches=0
capacity_skipped=0
content_considered=0
declare -a CONTENT_CARDS=()
dispatcher_self_advance=0
dispatcher_orchestrator_dispatch=0
dispatcher_unattributed=0

while IFS=$'\t' read -r card verdict path ts dispatcher_field; do
  [ -n "$card" ] || continue
  dispatches=$((dispatches + 1))
  if printf '%s' "$path" | grep -Eq "$CAPACITY_REGEX"; then
    capacity_skipped=$((capacity_skipped + 1))
  else
    content_considered=$((content_considered + 1))
    CONTENT_CARDS+=("$card")
    case "$dispatcher_field" in
      dispatcher=self-advance)    dispatcher_self_advance=$((dispatcher_self_advance + 1)) ;;
      dispatcher=orchestrator-dispatch) dispatcher_orchestrator_dispatch=$((dispatcher_orchestrator_dispatch + 1)) ;;
      *)                          dispatcher_unattributed=$((dispatcher_unattributed + 1)) ;;
    esac
  fi
done <<EOF
$LATEST
EOF

# For every content-considered card, ask the board: did it get a LOCAL-LLM DRAFT comment, and if so
# what Draft-Review verdict (if any) came after it. This is the ONLY network call this script makes,
# and it fails soft -- a card whose comments could not be read counts as "pending_review", never as a
# false positive in either direction.
drafted=0
continued_with_draft=0
rejected_draft=0
pending_review=0

TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
for card in "${CONTENT_CARDS[@]:-}"; do
  [ -n "$card" ] || continue
  comments="$(printf 'Authorization: Bearer %s\n' "$TOKEN" \
    | timeout 10 curl -H @- -s "$API/api/kanban/$card/comments" 2>/dev/null)"
  [ -n "$comments" ] || continue
  outcome="$(printf '%s' "$comments" | python3 -c '
import json, sys, re
try:
    comments = json.load(sys.stdin)
except Exception:
    print("unreadable"); raise SystemExit
if not isinstance(comments, list):
    comments = comments.get("comments", []) if isinstance(comments, dict) else []
draft_at = None
for c in comments:
    if (c.get("author") or "").lower() == "local-llm" and "LOCAL-LLM DRAFT" in (c.get("content") or ""):
        at = c.get("created_at") or 0
        if draft_at is None or at > draft_at:
            draft_at = at
if draft_at is None:
    print("no-draft"); raise SystemExit
rx = re.compile(r"^[ \t]*Draft-Review[ \t]*:[ \t]*(ELFOGADVA|ELUTAS[IÍ]TVA|R[EÉ]SZBEN|ACCEPTED|REJECTED|PARTIAL)\b", re.I | re.M)
verdict = None
for c in comments:
    if (c.get("author") or "").lower() == "local-llm":
        continue
    if (c.get("created_at") or 0) < draft_at:
        continue
    m = rx.search(c.get("content") or "")
    if m:
        verdict = m.group(1).upper()
if verdict is None:
    print("draft-pending"); raise SystemExit
if verdict in ("ELUTASITVA", "ELUTASÍTVA", "REJECTED"):
    print("draft-rejected")
else:
    print("draft-continued")
' 2>/dev/null)"
  case "$outcome" in
    no-draft) : ;;
    draft-continued) drafted=$((drafted + 1)); continued_with_draft=$((continued_with_draft + 1)) ;;
    draft-rejected)  drafted=$((drafted + 1)); rejected_draft=$((rejected_draft + 1)) ;;
    draft-pending)   drafted=$((drafted + 1)); pending_review=$((pending_review + 1)) ;;
    *) : ;;  # unreadable / network failure -- counted in neither direction
  esac
done

exhausted_no_draft=$(( content_considered - drafted ))
[ "$exhausted_no_draft" -ge 0 ] || exhausted_no_draft=0

if [ "$JSON" = 1 ]; then
  printf '{"hours":%s,"dispatches":%s,"capacity_skipped":%s,"content_considered":%s,"drafted":%s,"continued_with_draft":%s,"rejected_draft":%s,"exhausted_no_draft":%s,"pending_review":%s,"dispatcher_self_advance":%s,"dispatcher_orchestrator_dispatch":%s,"dispatcher_unattributed":%s}\n' \
    "$HOURS" "$dispatches" "$capacity_skipped" "$content_considered" "$drafted" "$continued_with_draft" "$rejected_draft" "$exhausted_no_draft" "$pending_review" \
    "$dispatcher_self_advance" "$dispatcher_orchestrator_dispatch" "$dispatcher_unattributed"
else
  printf 'card-build-route-24h-measure: last %sh -- %s dispatch(es) routed\n' "$HOURS" "$dispatches"
  printf '  %s kapacitas-okbol draft-kiserlet nelkul (GPU/router nem volt elerheto, nem a kartya tartalma miatt)\n' "$capacity_skipped"
  printf '  %s tartalmi dontes (draft-kiserlet ELVART), ebbol %s kapott tenylegesen LOCAL-LLM DRAFT kommentet\n' "$content_considered" "$drafted"
  printf '    %s a drafttal dolgozott tovabb (Draft-Review: ELFOGADVA/RESZBEN)\n' "$continued_with_draft"
  printf '    %s elutasitotta a draftot es nullarol irta meg (Draft-Review: ELUTASITVA)\n' "$rejected_draft"
  printf '    %s meg nincs elbiralva (draft all, review meg nem erkezett)\n' "$pending_review"
  printf '    %s tartalmi dontesu kartya NEM kapott draftot (kimerult a helyi modell, vagy a leaf-resolve ures volt)\n' "$exhausted_no_draft"
  printf '  dispatcher (kartya 3906d77b): %s orchestrator-dispatch, %s self-advance, %s unattributed (regi sor vagy nem-allitott env)\n' \
    "$dispatcher_orchestrator_dispatch" "$dispatcher_self_advance" "$dispatcher_unattributed"
  if [ "$content_considered" -gt 0 ] && [ "$dispatcher_self_advance" -eq 0 ] && [ "$dispatcher_orchestrator_dispatch" -gt 0 ]; then
    printf '  !! minden tartalmi dontes orchestrator-dispatch-bol jott, EGY sem self-advance-bol -- ez pontosan az a res, amiert a 3906d77b nyilt (09-18 08:41 utan a self-advance uton felvett kartyak nem hivtak a routert). Ellenorizd, hogy a role-agentek self-advance-pickup.sh-t hivjak-e PUT in_progress helyett.\n'
  fi
  if [ "$content_considered" -gt 0 ] && [ "$drafted" -eq 0 ]; then
    printf '  !! %s tartalmi dontesu kartya volt, es EGYETLEN draft sem erkezett -- ez pont az a hiba, amiert a 3c075d74 nyilt (2026-09-18 alapvonal: 7/7 dontes ONLINE, calls=0). Ellenorizd, hogy a C szekcio 4b lepese ELOTT fut-e a delegalo uzenetnek, es hogy a helyi modell egeszseges-e.\n' "$content_considered"
  fi
fi

exit 0

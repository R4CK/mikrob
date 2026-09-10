#!/usr/bin/env bash
# route-check-audit.sh -- did the dispatch that just happened actually RUN the route check? (card 0c473a5e)
#
# THE HOLE THIS CLOSES. CLAUDE.md rule 16 says a simple card should be BUILT by the local model
# first, and the heartbeat's C-section step 4b is where that is decided: run card-build-route.sh on
# the card being dispatched. The rule is real, the script works, the wiring exists -- and it still
# does not happen. MEASURED on this board before this file existed: kanban_card_events recorded 43
# transitions into in_progress since the log begins (2026-09-08 21:02), while card-build-route.log
# carried 4 lines in the same window. The step is skipped in roughly nine dispatches out of ten.
#
# WHY IT IS SKIPPED, and why more prose would not fix it: 4b is a sentence in a skill file that a
# model is asked to remember mid-dispatch. Nothing anywhere notices when it is forgotten. That is
# the same failure class rule 4b (Gate-SHA) already solved elsewhere -- replace a step someone must
# REMEMBER with a value someone can CHECK. The verdict line is already written (card-build-route.sh
# logs on every path, including every fail-safe path); what was missing is anyone comparing the
# dispatches that happened against the verdicts that were written.
#
# SOFT BY CONSTRUCTION (plan-grilling GO-WITH-CHANGES, MikroB 2026-09-09). This reports; it never
# blocks a dispatch and never moves a card. A brand-new mechanism that can stop the fleet's dispatch
# path is a worse bug than the one it audits, and rule 9 of the code-quality principles says a risky
# change goes behind a flag rather than replacing the working path. Exit status is 0 whenever the
# audit itself ran, whatever it found; a non-zero exit means the AUDIT broke, not that a dispatch
# did. Callers must not branch on findings via $?.
#
# THE CUTOFF IS A DISPATCH-TIME CUTOFF, NOT A CARD created_at CUTOFF, and this is a deliberate
# departure from the plan-grilling text, which said to filter on created_at. Both answers protect
# against the same thing MikroB identified -- 1659 mostly-reconstructed cards that never had a route
# verdict and would all light up as findings on day one. But created_at also permanently exempts a
# real case: an OLD card dispatched TOMORROW. That dispatch happens under the live mechanism and is
# exactly what this should catch, yet a created_at filter would silently ignore it forever. Filtering
# on the dispatch EVENT keeps every legacy card out (they have no post-cutoff dispatch event unless
# they are re-dispatched, at which point auditing them is correct) and leaves no permanent blind
# spot. Same protection, no hole.
#
# The cutoff is established on first run and then never moves: no argument to keep current, no date
# to maintain per install. The first run therefore reports ZERO findings by construction -- it has no
# dispatch events after a cutoff it just created. That is the correct start, not a bug to fix.
#
#   route-check-audit.sh              # human-readable report
#   route-check-audit.sh --json       # machine-readable, for a caller that wants the numbers
#   route-check-audit.sh --since <epoch>   # override the cutoff for one run (tests, backfill checks)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${ROUTE_AUDIT_DB:-$HERE/claudeclaw.db}"
LOG="${ROUTE_AUDIT_ROUTE_LOG:-$HERE/card-build-route.log}"
CUTOFF_FILE="${ROUTE_AUDIT_CUTOFF_FILE:-$HERE/.route-check-audit-cutoff}"

# How far a verdict line may sit from the dispatch event and still count as ITS verdict. The
# heartbeat writes the card to in_progress (step 4) and runs the router (step 4b) in the same turn,
# so the true gap is seconds; the window is wide enough that a slow model call or a clock that
# drifted between the API host and the script does not manufacture a finding, and narrow enough that
# a verdict from a DIFFERENT dispatch of the same card hours earlier cannot be borrowed to cover a
# later one. Without the window a naive "was this card ever routed" check goes permanently green
# after one dispatch, and every re-dispatch of that card is unaudited forever.
WINDOW="${ROUTE_AUDIT_WINDOW_SECONDS:-900}"

JSON=0
SINCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --since) SINCE="${2:-}"; shift 2 ;;
    *) printf 'usage: route-check-audit.sh [--json] [--since <epoch>]\n' >&2; exit 2 ;;
  esac
done

command -v sqlite3 >/dev/null 2>&1 || { printf 'route-check-audit: sqlite3 not found\n' >&2; exit 3; }
[ -f "$DB" ] || { printf 'route-check-audit: no kanban db at %s\n' "$DB" >&2; exit 3; }

now="$(date +%s)"
if [ -n "$SINCE" ]; then
  cutoff="$SINCE"
else
  if [ ! -f "$CUTOFF_FILE" ]; then
    # First run establishes the boundary and reports nothing. Writing it BEFORE the query is what
    # makes that true: a dispatch racing this very run lands after the cutoff and is audited next
    # time, rather than being counted against a mechanism that was not live when it happened.
    printf '%s\n' "$now" > "$CUTOFF_FILE" 2>/dev/null || true
  fi
  cutoff="$(head -1 "$CUTOFF_FILE" 2>/dev/null | tr -cd '0-9')"
  [ -n "$cutoff" ] || cutoff="$now"
fi

# Dispatch events after the cutoff. kanban_card_events is the board's own status-transition record,
# so this counts what ACTUALLY moved into in_progress -- not what a card's current status implies,
# which is unrecoverable once the card moves on to waiting or done.
events="$(sqlite3 -separator '	' "$DB" \
  "SELECT card_id, created_at FROM kanban_card_events
   WHERE to_status='in_progress' AND created_at >= $cutoff
   ORDER BY created_at;" 2>/dev/null)" || {
  printf 'route-check-audit: kanban_card_events query failed\n' >&2; exit 3; }

# Route verdicts. Field 1 is 'YYYY-MM-DD HH:MM:SS' local time, field 2 the card id ('-' for a
# --text run, which belongs to no card and is skipped).
verdicts=""
if [ -f "$LOG" ]; then
  verdicts="$(awk -F'\t' 'NF>=2 && $2 != "-" {
      cmd = "date -d \"" $1 "\" +%s 2>/dev/null"
      cmd | getline ts
      close(cmd)
      if (ts != "") print $2 "\t" ts
      ts = ""
    }' "$LOG" 2>/dev/null)"
fi

total=0; covered=0; missing_ids=""
while IFS="$(printf '\t')" read -r card ts; do
  [ -n "$card" ] || continue
  total=$((total + 1))
  hit=0
  if [ -n "$verdicts" ]; then
    # A verdict covers this dispatch when it names the same card within the window on either side.
    hit="$(printf '%s\n' "$verdicts" | awk -F'\t' -v c="$card" -v t="$ts" -v w="$WINDOW" '
      $1 == c { d = $2 - t; if (d < 0) d = -d; if (d <= w) { print 1; exit } }
      END { }' )"
    [ -n "$hit" ] || hit=0
  fi
  if [ "$hit" = "1" ]; then
    covered=$((covered + 1))
  else
    missing_ids="$missing_ids $card"
  fi
done <<EOF
$events
EOF

missing=$((total - covered))
pct=0
[ "$total" -gt 0 ] && pct=$(( covered * 100 / total ))

if [ "$JSON" = "1" ]; then
  printf '{"cutoff":%s,"window_seconds":%s,"dispatches":%s,"routed":%s,"missing":%s,"coverage_pct":%s,"missing_cards":[' \
    "$cutoff" "$WINDOW" "$total" "$covered" "$missing" "$pct"
  sep=""
  for m in $missing_ids; do printf '%s"%s"' "$sep" "$m"; sep=","; done
  printf ']}\n'
else
  printf 'route-check-audit: %s dispatch(es) since %s -- %s routed, %s MISSING (%s%% coverage)\n' \
    "$total" "$(date -d "@$cutoff" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "$cutoff")" \
    "$covered" "$missing" "$pct"
  if [ "$missing" -gt 0 ]; then
    printf '  dispatched without a route verdict (rule 16 step 4b skipped):\n'
    for m in $missing_ids; do printf '    %s\n' "$m"; done
    printf '  SOFT finding: nothing was blocked. Run card-build-route.sh at dispatch time,\n'
    printf '  or if it failed there, the caller must log route-check-failed rather than skip.\n'
  fi
fi

# 0 whenever the audit ran. Findings are data, not a failure of this script.
exit 0

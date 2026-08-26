#!/usr/bin/env bash
# Card 1128002b (Feladat 4 of the load-brake phase 19f3bbb5): bookkeeping + integration +
# alerting for the load-guard throttle mechanisms (cgroup_throttle / sigstop_freeze). Reads each
# mechanism's ALREADY-persisted state (never re-evaluates load or re-derives who is throttled --
# a pure read+diff+write layer, same "consume an already-computed decision" shape as
# load-guard-cgroup-apply.sh / load-guard-sigstop-apply.sh).
#
# WRITES store/load-paused-agents.json -- the single marker file store/redispatch-guard.sh's
# _is_load_paused() and the stuck-card-monitor scheduled task both consult, so a throttled/frozen
# agent's own in_progress card is never mistaken for stuck or nudged mid-pause.
#
# STALENESS (card 1128002b follow-up, Cybersec NO-GO + QA FAIL on Gate-SHA fce0df4e): if THIS
# script stops running (the same eval.sh chain failure already NO-GO'd on card 2bfbf805, or a
# disk-full/permission fault of its own), the file simply stops being rewritten and keeps
# whatever it last said forever -- and both consumers checked plain membership, so a paused
# agent from hours ago stayed permanently invisible to the fleet's two loop-closing safety nets
# (redispatch-guard's nudge gate, stuck-card-monitor's 10-minute restart). Every entry now also
# carries "last_seen" (refreshed on EVERY tick this agent is still paused, unlike "since" which
# stays fixed for the whole pause) so a consumer can tell "still genuinely paused" apart from
# "bookkeeping died, this is a stale corpse" without capping how LONG a legitimate pause may run
# (cgroup_throttle has no forced release, unlike sigstop_freeze's 90s -- capping on "since" alone
# would have falsely un-paused a real, ongoing throttle).
#
# On every PAUSE-START/RESUME transition: posts an INFO-ONLY PAUSED-LOAD / RESUMED-LOAD kanban
# comment on the agent's in_progress card (routine -- log/comment only, never Telegram on its
# own; INFO-ONLY so store/gate-dispatch-check.sh never mistakes it for a review, see that
# convention's own memory). An agent continuously paused across ticks (even across a mechanism
# hand-off, e.g. cgroup_throttle escalating to sigstop_freeze) is NOT a resume+re-pause -- only a
# fully absent -> present or present -> absent edge counts as a transition.
#
# ALERTING: only for REPEATED pausing (card's own words: "Rutin pause/resume esemeny csak
# logba/kommentbe megy, Telegramra csak ismetlodo/tartos ... eseten"). Tracks pause-START
# timestamps per agent in a rolling window (config alert_window_seconds, default 3600s);
# alert_repeat_threshold (default 2) pause-starts for the SAME agent within that window is
# "repeated", and triggers a direct-Bot-API Telegram alert -- but only once per
# alert_cooldown_seconds (default 3600s) per agent, confirmed-delivery-only stamp, same
# convention as every other guard in this repo (disk-space-guard.sh, ollama-down-guard.sh, ...).
#
# The DIFF/DECISION logic (below, COMPUTE_PY) is pure JSON-in/JSON-out and testable directly via
# --test-compute (mirrors load-guard-sigstop-target.sh's --test-select) -- real kanban/Telegram IO
# only happens in the thin wrapper around it.
#
# Usage: load-guard-bookkeeping.sh
#   [--cgroup-state <path>] [--sigstop-state <path>] [--paused <path>] [--events <path>]
#   [--alert-stamp <path>] [--config <path>] [--now <epoch>] [--alert-dryrun]
# All overrides are test-only; production passes none.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CGROUP_STATE="$SCRIPT_DIR/load-guard-cgroup-state.json"
SIGSTOP_STATE="$SCRIPT_DIR/load-guard-sigstop-state.json"
PAUSED="$SCRIPT_DIR/load-paused-agents.json"
EVENTS="$SCRIPT_DIR/load-guard-pause-events.json"
ALERT_STAMP="$SCRIPT_DIR/.load-guard-bookkeeping-alerted.json"
CONFIG="$SCRIPT_DIR/load-guard-config.json"
NOW=""
ALERT_DRYRUN=0
DASH="${DASH:-http://localhost:3420}"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOKEN_FILE="${DASHBOARD_TOKEN_FILE:-$ROOT/store/.dashboard-token}"
TG_ENV="$HOME/.claude/channels/telegram/.env"

COMPUTE_PY='
import json
import sys

cgroup_json, sigstop_json, prev_paused_json, prev_events_json, now_s, threshold_s, window_s = sys.argv[1:8]
now = int(now_s)
threshold = int(threshold_s)
window = int(window_s)

def jload(s, default):
    try:
        return json.loads(s) if s else default
    except json.JSONDecodeError:
        return default

cgroup = jload(cgroup_json, {})
sigstop = jload(sigstop_json, {})
prev_paused = jload(prev_paused_json, {})
prev_events = jload(prev_events_json, {})

mechanisms = {}
if cgroup.get("throttled"):
    mechanisms[cgroup["throttled"]] = ["cgroup_throttle"]
if sigstop.get("frozen"):
    mechanisms.setdefault(sigstop["frozen"], []).append("sigstop_freeze")

starts = []
ends = []
new_paused = {}

for agent, mechs in mechanisms.items():
    mech_str = "+".join(mechs)
    if agent in prev_paused:
        # Continuing pause (even across a mechanism hand-off): keep the ORIGINAL since/card_id,
        # just refresh which mechanism(s) currently hold it AND last_seen (this tick proves
        # bookkeeping is still alive -- unlike "since", which must NOT move, "last_seen" moves
        # every tick on purpose: it is the staleness signal that Cybersec and QA asked for on
        # card fce0df4e, distinct from "how long has this pause been running").
        new_paused[agent] = {**prev_paused[agent], "mechanism": mech_str, "last_seen": now}
    else:
        starts.append(agent)
        new_paused[agent] = {"mechanism": mech_str, "since": now, "card_id": None, "last_seen": now}

for agent in prev_paused:
    if agent not in mechanisms:
        ends.append({"agent": agent, "card_id": prev_paused[agent].get("card_id")})

# Rolling pause-START window per agent, pruned to `window` seconds before this tick'"'"'s own
# starts are appended -- an event exactly `window` seconds old has already aged out.
new_events = {}
for agent, ts_list in prev_events.items():
    kept = [t for t in ts_list if now - t < window]
    if kept:
        new_events[agent] = kept
for agent in starts:
    new_events.setdefault(agent, []).append(now)

alert_agents = [a for a in starts if len(new_events.get(a, [])) >= threshold]

print(json.dumps({
    "paused": new_paused,
    "events": new_events,
    "starts": starts,
    "ends": ends,
    "alert_agents": alert_agents,
}))
'

if [ "${1:-}" = "--test-compute" ]; then
  # candidates: cgroup-json sigstop-json prev-paused-json prev-events-json now threshold window
  python3 -c "$COMPUTE_PY" "$2" "$3" "$4" "$5" "$6" "$7" "$8"
  exit 0
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --cgroup-state) CGROUP_STATE="$2"; shift 2 ;;
    --sigstop-state) SIGSTOP_STATE="$2"; shift 2 ;;
    --paused) PAUSED="$2"; shift 2 ;;
    --events) EVENTS="$2"; shift 2 ;;
    --alert-stamp) ALERT_STAMP="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --now) NOW="$2"; shift 2 ;;
    --alert-dryrun) ALERT_DRYRUN=1; shift ;;
    *) echo "load-guard-bookkeeping.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$NOW" ] || NOW=$(date +%s)

# ---- config -----------------------------------------------------------------------------------
THRESHOLD=2
WINDOW=3600
COOLDOWN=3600
if [ -f "$CONFIG" ]; then
  read -r THRESHOLD WINDOW COOLDOWN < <(python3 -c "
import json
try:
    c = json.load(open('$CONFIG')).get('bookkeeping', {})
except Exception:
    c = {}
print(c.get('alert_repeat_threshold', 2), c.get('alert_window_seconds', 3600), c.get('alert_cooldown_seconds', 3600))
")
fi

# ---- read real state ----------------------------------------------------------------------------
cgroup_json="$(cat "$CGROUP_STATE" 2>/dev/null || echo '{}')"
sigstop_json="$(cat "$SIGSTOP_STATE" 2>/dev/null || echo '{}')"
prev_paused_json="$(cat "$PAUSED" 2>/dev/null || echo '{}')"
prev_events_json="$(cat "$EVENTS" 2>/dev/null || echo '{}')"

RESULT="$(python3 -c "$COMPUTE_PY" "$cgroup_json" "$sigstop_json" "$prev_paused_json" "$prev_events_json" "$NOW" "$THRESHOLD" "$WINDOW")"

# ---- real IO: kanban comments (INFO-ONLY) + card_id lookup for new starts ----------------------
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE" 2>/dev/null)" > "$hdr_file"

_kanban_get() { curl -sf -H @"$hdr_file" "$DASH/api/kanban" 2>/dev/null || echo '[]'; }
_post_comment() { # $1 cardId $2 text
  [ -n "$1" ] && [ "$1" != "null" ] || return 0
  curl -sf -H @"$hdr_file" -X POST "$DASH/api/kanban/$1/comments" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"author":"backend","content":sys.argv[1]}))' "$2")" \
    >/dev/null 2>&1 || true
}

KANBAN_JSON=""
mapfile -t starts < <(printf '%s' "$RESULT" | python3 -c "import json,sys; [print(a) for a in json.load(sys.stdin)['starts']]")
if [ "${#starts[@]}" -gt 0 ]; then
  KANBAN_JSON="$(_kanban_get)"
fi

for agent in "${starts[@]}"; do
  card_id="$(printf '%s' "$KANBAN_JSON" | AGENT="$agent" python3 -c "
import json, os, sys
cards = json.load(sys.stdin)
agent = os.environ['AGENT']
for c in cards:
    if c.get('status') == 'in_progress' and c.get('assignee') == agent:
        print(c['id']); break
")"
  mech="$(printf '%s' "$RESULT" | AGENT="$agent" python3 -c "import json,os,sys; print(json.load(sys.stdin)['paused'][os.environ['AGENT']]['mechanism'])")"
  if [ -n "$card_id" ]; then
    _post_comment "$card_id" "INFO-ONLY: PAUSED-LOAD ($mech) -- a load-guard terheles miatt szuneteltette ezt az ugynokot, a fagyasztas/fekezes ideje alatt a kartya nem szamit beragadtnak."
  fi
  # patch the computed card_id into RESULT for the write-out below
  RESULT="$(printf '%s' "$RESULT" | AGENT="$agent" CARD="$card_id" python3 -c "
import json, os, sys
r = json.load(sys.stdin)
a = os.environ['AGENT']
c = os.environ.get('CARD') or None
if a in r['paused']:
    r['paused'][a]['card_id'] = c
print(json.dumps(r))
")"
done

mapfile -t ends < <(printf '%s' "$RESULT" | python3 -c "
import json,sys
for e in json.load(sys.stdin)['ends']:
    print(e['agent'] + '\t' + str(e.get('card_id') or ''))
")
for line in "${ends[@]}"; do
  [ -n "$line" ] || continue
  agent="${line%%$'\t'*}"
  card_id="${line#*$'\t'}"
  [ -n "$card_id" ] || continue
  _post_comment "$card_id" "INFO-ONLY: RESUMED-LOAD -- a load-guard felengedte ezt az ugynokot, a terheles-alapu szuneteles veget ert."
done

# ---- write the new snapshots --------------------------------------------------------------------
printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['paused']))" > "$PAUSED"
printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['events']))" > "$EVENTS"

# ---- alerting: repeated pausing only, cooldown-stamped -------------------------------------------
alert_owner() {
  local msg="$1" token chat
  if [ "$ALERT_DRYRUN" = "1" ]; then echo "ALERT_DRYRUN: $msg"; return 0; fi
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  chat="$(grep -E '^ALLOWED_CHAT_ID=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  [ -z "$chat" ] && chat="$(grep -E '^TELEGRAM_CHAT_ID=' "$TG_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r ')"
  [ -n "$token" ] && [ -n "$chat" ] || return 1
  . "$SCRIPT_DIR/../scripts/lib/send-telegram.sh"
  send_telegram_message "$token" "$chat" "$msg"
}

mapfile -t alert_agents < <(printf '%s' "$RESULT" | python3 -c "import json,sys; [print(a) for a in json.load(sys.stdin)['alert_agents']]")
for agent in "${alert_agents[@]}"; do
  last=0
  [ -f "$ALERT_STAMP" ] && last="$(python3 -c "
import json
try:
    print(int(json.load(open('$ALERT_STAMP')).get('$agent', 0)))
except Exception:
    print(0)
")"
  if [ $(( NOW - last )) -ge "$COOLDOWN" ]; then
    if alert_owner "🟡 Load-guard: $agent ismetelten szuneteltetve terheles miatt (>= $THRESHOLD alkalommal az elmult ${WINDOW}mp-ben). Ha ez tartos, a flotta kapacitasa csokkent."; then
      python3 -c "
import json, os
path = '$ALERT_STAMP'
d = {}
try:
    d = json.load(open(path))
except Exception:
    d = {}
d['$agent'] = $NOW
with open(path, 'w') as f:
    json.dump(d, f)
"
    fi
  fi
done

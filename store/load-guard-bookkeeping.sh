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
#   [--alert-stamp <path>] [--config <path>] [--episodes <path>] [--now <epoch>] [--alert-dryrun]
# All overrides are test-only; production passes none.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CGROUP_STATE="$SCRIPT_DIR/load-guard-cgroup-state.json"
SIGSTOP_STATE="$SCRIPT_DIR/load-guard-sigstop-state.json"
PAUSED="$SCRIPT_DIR/load-paused-agents.json"
EVENTS="$SCRIPT_DIR/load-guard-pause-events.json"
EPISODES="$SCRIPT_DIR/load-guard-episodes.json"
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
prev_episodes_json, gap_s, heartbeat_s = sys.argv[8:11]
now = int(now_s)
threshold = int(threshold_s)
window = int(window_s)
episode_gap = int(gap_s)
heartbeat = int(heartbeat_s)

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

prev_episodes = jload(prev_episodes_json, {})

# EPISODE-LEVEL REPORTING (card 9c6b1802). The per-transition note was the wrong unit of news.
# sigstop_freeze is capped at max_freeze_seconds (90 by config), so under sustained load it can
# only ever freeze, hit the cap, release into a still-loaded machine and refreeze -- the flapping
# is INHERENT to the mechanism, not a fault. Measured on the live board: 988 of 1082 pause-starts
# were sigstop_freeze, median dwell 10s, and one card carried 342 of its 353 comments as these
# notes. An EPISODE (throttling began ... throttling ended) is the thing a reader wants, and its
# cycle count is real information that 46 identical pairs never conveyed.
#
# THE NOTE IS NOT ONLY NEWS -- it also moves the card `updated_at` field, which is why suppressing it
# outright would be unsafe. The stuck-card-monitor excludes agents listed in
# load-paused-agents.json, so a CONTINUOUSLY paused agent is protected by the marker file; but an
# agent flapping in and out of that set can be sampled while ADMITted, and then only `updated_at`
# stands between it and a 10-minute stuck verdict. Hence the heartbeat below: the silent window is
# BOUNDED, not removed. Simulated over all 2150 live notes, the worst silent window inside an
# active episode is 497s against the 600s monitor threshold.
new_episodes = {}
notes = []

for agent in set(mechanisms) | set(prev_episodes):
    is_paused = agent in mechanisms
    ep = dict(prev_episodes.get(agent) or {})
    mech_str = "+".join(mechanisms[agent]) if is_paused else ep.get("mechanism", "")

    if not ep:
        if is_paused:
            notes.append({"agent": agent, "kind": "start", "mechanism": mech_str,
                          "cycles": 1, "duration": 0, "card_id": None})
            new_episodes[agent] = {"start": now, "cycles": 1, "last_activity": now,
                                   "last_post": now, "mechanism": mech_str, "card_id": None}
        continue

    if is_paused:
        # A fresh pause START inside an open episode is another cycle, not another episode.
        if agent not in prev_paused:
            ep["cycles"] = int(ep.get("cycles", 0)) + 1
        ep["mechanism"] = mech_str
        ep["last_activity"] = now
    elif now - int(ep.get("last_activity", now)) > episode_gap:
        # Quiet long enough to call it over. The duration is measured to the last ACTIVITY, not to
        # now -- the lapse window itself is not part of the throttling.
        notes.append({"agent": agent, "kind": "end", "mechanism": ep.get("mechanism", ""),
                      "cycles": int(ep.get("cycles", 0)),
                      "duration": int(ep.get("last_activity", now)) - int(ep.get("start", now)),
                      "card_id": ep.get("card_id")})
        continue

    # Heartbeat only while actually paused: an ADMITted agent moves its own card.
    if is_paused and now - int(ep.get("last_post", ep.get("start", now))) >= heartbeat:
        notes.append({"agent": agent, "kind": "heartbeat", "mechanism": ep.get("mechanism", ""),
                      "cycles": int(ep.get("cycles", 0)),
                      "duration": now - int(ep.get("start", now)),
                      "card_id": ep.get("card_id")})
        ep["last_post"] = now

    new_episodes[agent] = ep

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
    "episodes": new_episodes,
    "notes": notes,
}))
'

if [ "${1:-}" = "--test-compute" ]; then
  # candidates: cgroup-json sigstop-json prev-paused-json prev-events-json now threshold window
  #             [prev-episodes-json episode-gap heartbeat]
  python3 -c "$COMPUTE_PY" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "${9:-{\}}" "${10:-300}" "${11:-240}"
  exit 0
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --cgroup-state) CGROUP_STATE="$2"; shift 2 ;;
    --sigstop-state) SIGSTOP_STATE="$2"; shift 2 ;;
    --paused) PAUSED="$2"; shift 2 ;;
    --events) EVENTS="$2"; shift 2 ;;
    --episodes) EPISODES="$2"; shift 2 ;;
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
EPISODE_GAP=300
HEARTBEAT=240
if [ -f "$CONFIG" ]; then
  read -r THRESHOLD WINDOW COOLDOWN EPISODE_GAP HEARTBEAT < <(python3 -c "
import json
try:
    c = json.load(open('$CONFIG')).get('bookkeeping', {})
except Exception:
    c = {}
print(c.get('alert_repeat_threshold', 2), c.get('alert_window_seconds', 3600), c.get('alert_cooldown_seconds', 3600),
      c.get('episode_gap_seconds', 300), c.get('heartbeat_seconds', 240))
")
fi

# ---- read real state ----------------------------------------------------------------------------
cgroup_json="$(cat "$CGROUP_STATE" 2>/dev/null || echo '{}')"
sigstop_json="$(cat "$SIGSTOP_STATE" 2>/dev/null || echo '{}')"
prev_paused_json="$(cat "$PAUSED" 2>/dev/null || echo '{}')"
prev_events_json="$(cat "$EVENTS" 2>/dev/null || echo '{}')"
prev_episodes_json="$(cat "$EPISODES" 2>/dev/null || echo '{}')"

RESULT="$(python3 -c "$COMPUTE_PY" "$cgroup_json" "$sigstop_json" "$prev_paused_json" "$prev_events_json" "$NOW" "$THRESHOLD" "$WINDOW" "$prev_episodes_json" "$EPISODE_GAP" "$HEARTBEAT")"

# ---- real IO: kanban comments (INFO-ONLY) + card_id lookup for new starts ----------------------
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE" 2>/dev/null)" > "$hdr_file"

_kanban_get() { curl -sf --max-time 10 -H @"$hdr_file" "$DASH/api/kanban" 2>/dev/null || echo '[]'; }

# THE AUTHOR RESTRICTION IS EXPLICIT, not a side effect (card be81d16c, Cybersec on 9444a7bb).
# Opening the hardcoded author to a parameter left the NAME unconstrained. It happened not to matter,
# because the only caller derives it from a kanban lookup filtered on assignee == agent -- but that
# is an accident of how today's caller is written, not a rule. A future caller that posts without
# that lookup would inherit nothing, and this function would happily sign a note with any string,
# including another agent's name or a reserved identity, straight into a card's audit trail.
#
# THE ONE SENTINEL that is not an agent. Kept out of the registry check on purpose: it is what an
# empty author falls back to, and it must never resolve to a person.
readonly LOAD_GUARD_AUTHOR='load-guard'

# The registry is the dashboard's own agent list -- the same source the rest of the fleet uses, so
# there is no second list here to drift out of step with reality.
_known_agents() { curl -sf --max-time 10 -H @"$hdr_file" "$DASH/api/agents" 2>/dev/null || echo '[]'; }
KNOWN_AGENTS_JSON=""

# A NAME THAT CANNOT HAVE BEEN THROTTLED MUST NOT SIGN A THROTTLE NOTE. MikroB and the whole gate
# pool are excluded from EVERY throttle mechanism (load-guard-excluded.sh, hardcoded on the d7a28a0a
# NO-GO), so a PAUSED-LOAD note signed by one of them asserts something that cannot be true. Sourced
# rather than re-listed: two copies of one policy is how one of them quietly stops matching.
# shellcheck source=/dev/null
. "$SCRIPT_DIR/load-guard-excluded.sh" 2>/dev/null || true

_valid_author() { # $1 = candidate; echoes the name to use
  local want="$1"
  [ "$want" = "$LOAD_GUARD_AUTHOR" ] && { echo "$LOAD_GUARD_AUTHOR"; return 0; }
  if [ -n "$want" ] && declare -F is_excluded >/dev/null 2>&1; then
    if is_excluded "$want" || is_excluded "agent-$want"; then
      echo "load-guard-bookkeeping: refusing to sign a throttle note as '$want' -- that identity is excluded from every throttle mechanism, so it cannot have been paused (card be81d16c)" >&2
      echo "$LOAD_GUARD_AUTHOR"; return 0
    fi
  fi
  [ -z "$KNOWN_AGENTS_JSON" ] && KNOWN_AGENTS_JSON="$(_known_agents)"
  if printf '%s' "$KNOWN_AGENTS_JSON" | WANT="$want" python3 -c "
import json, os, sys
want = os.environ['WANT']
try: rows = json.load(sys.stdin)
except Exception: sys.exit(1)          # unreadable registry -> not a known agent
rows = rows if isinstance(rows, list) else rows.get('agents', [])
ids = {(r.get('agent_id') or r.get('name') or '') for r in rows if isinstance(r, dict)}
sys.exit(0 if want in ids else 1)
" 2>/dev/null; then
    echo "$want"; return 0
  fi
  # Unknown, or the registry could not be read. Fall back to the sentinel rather than refusing the
  # comment outright: its other job is moving `updated_at` so the stuck-monitor does not take the
  # card away from an agent that is merely frozen. Never silent -- an unknown author is a caller bug.
  echo "load-guard-bookkeeping: '$want' is not a known agent (or the registry was unreadable); signing as $LOAD_GUARD_AUTHOR instead (card be81d16c)" >&2
  echo "$LOAD_GUARD_AUTHOR"
}
# THE AUTHOR IS A PARAMETER, not a constant (card 9444a7bb). It used to be hardcoded "backend", so
# every PAUSED-LOAD/RESUMED-LOAD note claimed backend had been frozen no matter who actually was --
# measured on card 98dbbcc9: 36 notes in ~4.5 minutes, all authored "backend", on FULLSTACK's card
# while fullstack was the SIGSTOPped process (the sigstop-state file named fullstack correctly, so
# only the attribution was wrong). That corrupts the one thing a card's comment history is for:
# who did what, when. Someone reading back through an incident would have gone looking for backend.
#
# NO DEFAULT. A default is what produced this bug: a caller that forgets the argument would silently
# blame whoever the default names. An empty author falls back to "load-guard" -- which is the honest
# answer (the guard IS the writer) and, unlike any agent name, cannot be mistaken for a person's own
# note. The comment still posts, because its other job is moving `updated_at` so the stuck-monitor
# does not take the card away from an agent that is merely frozen.
_post_comment() { # $1 cardId  $2 author  $3 text
  [ -n "$1" ] && [ "$1" != "null" ] || return 0
  local author="${2:-$LOAD_GUARD_AUTHOR}"
  [ -n "$author" ] || author="$LOAD_GUARD_AUTHOR"
  author="$(_valid_author "$author")"
  curl -sf --max-time 10 -H @"$hdr_file" -X POST "$DASH/api/kanban/$1/comments" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"author":sys.argv[1],"content":sys.argv[2]}))' "$author" "$3")" \
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
  # The NOTE is no longer posted here -- see the episode block in COMPUTE_PY. This loop still
  # resolves the card id, because load-paused-agents.json carries it and its consumers predate
  # episodes.
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
# `ends` stays in the compute output (the marker file and the selftests both read it); the RESUMED
# note itself is now an EPISODE end, emitted by the block below.

# ---- real IO: the episode notes -----------------------------------------------------------------
# One note per episode edge plus a bounded heartbeat, instead of one pair per freeze cycle.
_lookup_card() { # $1 agent -- the agent's in_progress card, or empty
  [ -n "$KANBAN_JSON" ] || KANBAN_JSON="$(_kanban_get)"
  printf '%s' "$KANBAN_JSON" | AGENT="$1" python3 -c "
import json, os, sys
try: cards = json.load(sys.stdin)
except Exception: sys.exit(0)
agent = os.environ['AGENT']
for c in cards:
    if c.get('status') == 'in_progress' and c.get('assignee') == agent:
        print(c['id']); break
"
}

mapfile -t notes < <(printf '%s' "$RESULT" | python3 -c "
import json, sys
for n in json.load(sys.stdin)['notes']:
    print('\t'.join([n['agent'], n['kind'], n.get('mechanism') or '', str(n.get('cycles') or 0),
                     str(n.get('duration') or 0), n.get('card_id') or '']))
")
for line in "${notes[@]}"; do
  [ -n "$line" ] || continue
  IFS=$'\t' read -r n_agent n_kind n_mech n_cycles n_dur n_card <<< "$line"
  [ -n "$n_card" ] || n_card="$(_lookup_card "$n_agent")"
  [ -n "$n_card" ] || continue
  mins=$(( (n_dur + 30) / 60 ))
  case "$n_kind" in
    start)
      _post_comment "$n_card" "$n_agent" "INFO-ONLY: PAUSED-LOAD ($n_mech) -- a load-guard terhelés miatt szüneteltette ezt az ügynököt. A fékezés ideje alatt a kártya nem számít beragadtnak." ;;
    heartbeat)
      _post_comment "$n_card" "$n_agent" "INFO-ONLY: PAUSED-LOAD ($n_mech) -- a fékezés tart: eddig $n_cycles ciklus, kb. $mins perce. A kártya nem számít beragadtnak." ;;
    end)
      _post_comment "$n_card" "$n_agent" "INFO-ONLY: RESUMED-LOAD -- a load-guard felengedte ezt az ügynököt. Az epizód $n_cycles ciklusból állt, kb. $mins percig tartott." ;;
  esac
  # the resolved id belongs to the episode too, so the next note does not look it up again
  RESULT="$(printf '%s' "$RESULT" | AGENT="$n_agent" CARD="$n_card" python3 -c "
import json, os, sys
r = json.load(sys.stdin)
a = os.environ['AGENT']
if a in r.get('episodes', {}):
    r['episodes'][a]['card_id'] = os.environ.get('CARD') or None
print(json.dumps(r))
")"
done

# ---- write the new snapshots --------------------------------------------------------------------
printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['paused']))" > "$PAUSED"
printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['episodes']))" > "$EPISODES"
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

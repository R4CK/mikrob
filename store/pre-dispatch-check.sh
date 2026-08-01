#!/bin/bash
# Pre-dispatch usage gate (Peti rule 2026-07-05).
#
# MikroB MUST run this before starting ANY new development dispatch (a planned
# card -> in_progress + delegate). It answers one question: is it safe to start
# NEW work right now, given the Claude session (5h) and WEEKLY usage limits?
#
# Output (last line, machine-readable):
#   DISPATCH:OK                      -> new dispatch allowed
#   DISPATCH:HOLD:<reason>           -> do NOT start new dev; finish in-flight only
#
# It never blocks finishing in-flight cards, running gates, or closing cards --
# only STARTING new development, exactly per the weekly-limit rule.
#
# Signals, in priority order (any HOLD wins):
#   1) usage-limit BANNER in any agent tmux pane (5h OR weekly, incl.
#      "approaching usage limit") -- reuses the quota-check.sh phrasings.
#   2) WEEKLY threshold: last-known weekly "All models" % vs a DYNAMIC threshold
#      derived from days-to-reset (>3d=90, <2d=92, <1d=95). Weekly % comes from
#      store/weekly-usage.json (set via `set-weekly`, or auto-read if an OAuth
#      usage token is ever available -- see try_oauth_usage).
#
# Subcommands:
#   (none)                       run the gate, print DISPATCH:OK|HOLD:...
#   set-weekly <pct> [reset]     record the weekly % + reset label (from Peti's
#                                usage screenshot), e.g. set-weekly 87 "Thu 15:59"
#   show                         print the current weekly state + computed threshold
set -euo pipefail

STORE="$(cd "$(dirname "$0")" && pwd)"
WEEKLY_STATE="$STORE/weekly-usage.json"
# Card f3248478 (Peti): the 90/92/95 thresholds are now superadmin-editable via
# the dashboard's Claude Limit panel sliders, persisted here. Absent/corrupt
# file -> the CLAUDE.md defaults below, never a script failure.
THRESHOLD_CONFIG="$STORE/weekly-threshold-config.json"
# Same limit phrasings as store/quota-check.sh / src/model-fallback.ts.
RX='usage limit reached|reached your usage limit|hit (your|the) usage limit|approaching (your )?usage limit|usage limit (will )?reset|limit will reset at|[0-9]+-hour limit reached|wait for limit to reset|stop and wait for limit'

# --- editable thresholds (cards f3248478 + d08b98f4) --------------------------
# Card d08b98f4 (Peti): the three DAY-DEPENDENT thresholds are gone. Two day-independent
# levels replace them, and they mean different things:
#   newDevStop (90) -- no NEW development; in-flight work and gate work continue
#   testStop   (97) -- GATE work stops too and every role agent is parked (MikroB stays)
# Absent/corrupt file -> the defaults below, never a script failure.
# Echoes "newDevStop testStop" (two ints, space-separated).
threshold_config() {
  python3 -c "
import json
try:
    with open('$THRESHOLD_CONFIG') as f:
        c = json.load(f)
    # Migration: a file written before d08b98f4 has gt3days as its 'stop new development'
    # level. Adopt it; the old shape has nothing meaning 'stop the gates too', so testStop
    # takes the default rather than inventing a policy nobody chose.
    nd = int(c.get('newDevStop', c.get('gt3days', 90)))
    ts = int(c.get('testStop', 97))
    # Fail-safe bounds: never let a bad edit disable the gate or exceed 100.
    nd = max(1, min(nd, 100)); ts = max(1, min(ts, 100))
    # Card d53c1e00: the API rejects a non-monotonic pair on write, but this file can be
    # hand-edited -- fall back to the defaults rather than stop verification BEFORE work.
    # Card 17905a6d: and SAY SO. A silent fallback means an operator who hand-edited the
    # file believes their thresholds are in force while the defaults are -- the edit was
    # rejected and nothing told them.
    if nd > ts:
        import sys
        print('WARN: weekly-threshold-config.json REJECTED as non-monotonic '
              '(newDevStop %d > testStop %d) -- using defaults 90/97. '
              'Fix it in the dashboard Claude Limit panel or the file itself.' % (nd, ts),
              file=sys.stderr)
        nd, ts = 90, 97
    print(nd, ts)
except Exception:
    print(90, 97)
" || echo "90 97"
}

# Read the config ONCE per run into NEW_DEV_STOP / TEST_STOP (card 17905a6d). threshold_config emits a
# warning when it rejects a hand-edited file, and calling it twice printed that warning twice, which
# reads like two separate problems. Assigned in the PARENT shell -- a `$(...)` cache would be set in a
# subshell and never survive.
NEW_DEV_STOP=""
TEST_STOP=""
load_thresholds() {
  [ -n "$NEW_DEV_STOP" ] && return 0
  read -r NEW_DEV_STOP TEST_STOP <<< "$(threshold_config)"
}

# Echoes the level at which NEW development stops.
new_dev_threshold() {
  load_thresholds
  echo "$NEW_DEV_STOP"
}

# Echoes the level at which GATE work stops too.
test_stop_threshold() {
  load_thresholds
  echo "$TEST_STOP"
}

# --- best-effort OAuth read of the real weekly % (future-proof) -----------------
# The endpoint https://api.anthropic.com/api/oauth/usage EXISTS (returns 429
# unauth, not 404), but no usage-scoped OAuth token is readable on this host
# (only a design-scoped, expired token in ~/.claude/.credentials.json; the
# subscription token lives in the keychain / process memory). IF a token is ever
# provided via $CLAUDE_OAUTH_TOKEN or $STORE/.oauth-usage-token, we try it and
# cache the % into weekly-usage.json. Silent no-op otherwise.
try_oauth_usage() {
  local tok="${CLAUDE_OAUTH_TOKEN:-}"
  [ -z "$tok" ] && [ -f "$STORE/.oauth-usage-token" ] && tok="$(cat "$STORE/.oauth-usage-token" 2>/dev/null || true)"
  [ -z "$tok" ] && return 1
  local body
  body="$(curl -s --max-time 8 -H "Authorization: Bearer $tok" \
    -H "anthropic-beta: oauth-2025-04-20" \
    https://api.anthropic.com/api/oauth/usage 2>/dev/null || true)"
  [ -z "$body" ] && return 1
  # Best-effort parse: look for a weekly "all models" utilization field. Schema
  # is undocumented, so we try a few likely keys and bail quietly on mismatch.
  python3 - "$body" "$WEEKLY_STATE" <<'PY' 2>/dev/null || return 1
import json,sys,datetime
body=json.loads(sys.argv[1]); out=sys.argv[2]
def find_pct(o):
    # heuristic: any number 0..100 under a key mentioning week+all/utilization/used
    best=None
    def walk(o,path=''):
        nonlocal best
        if isinstance(o,dict):
            for k,v in o.items():
                kp=(path+'.'+k).lower()
                if isinstance(v,(int,float)) and 0<=v<=100 and 'week' in kp and any(t in kp for t in('all','util','used','percent','ratio')):
                    best=float(v)
                walk(v,path+'.'+k)
        elif isinstance(o,list):
            for x in o: walk(x,path)
    walk(o)
    return best
p=find_pct(body)
if p is None: sys.exit(1)
json.dump({'percent':round(p),'reset':'','as_of':'oauth','source':'oauth'},open(out,'w'))
print(round(p))
PY
}

# --- hard-stop flag (card d08b98f4) -------------------------------------------
# The orchestrator scheduled-tasks (gate-reconciler / fleet-nudger / folyamatos-munka) do not
# all call this script; they read this ONE file. Written on every run so it can never go stale
# in the dangerous direction: an active flag is refreshed, and dropping below the level clears
# it immediately.
#
# The flag says WHAT IS TRUE, not what to do: `active` plus the numbers behind it. The consumers
# own the reaction (park role agents, close PASS/GO cards, never dispatch gate work). MikroB
# itself is never parked -- rule 7's standing exception -- and the file carries that as an
# explicit field so a consumer cannot forget it.
HARD_STOP_FLAG="$STORE/weekly-hard-stop.json"
# Card [threshold-live-wiring]: the file now carries BOTH levels, not just testStop. Before this,
# a consumer that only reads this ONE file (per the comment above) had no way to see the softer
# newDevStop crossing -- only a caller that ran this script directly could see it, and nothing did.
# newDevStopActive/newDevStop are additive fields; existing readers that only look at `active`
# (the testStop level) are unaffected.
write_hard_stop() { # $1=active(1|0) $2=percent $3=testStop $4=newDevStop $5=newDevActive(1|0)
  python3 - "$HARD_STOP_FLAG" "$1" "$2" "$3" "$4" "$5" <<'PYHS' 2>/dev/null || true
import json, os, sys, tempfile, time
path = sys.argv[1]
active = sys.argv[2] == '1'
pct = int(sys.argv[3])
thr = int(sys.argv[4])
nd = int(sys.argv[5])
nd_active = sys.argv[6] == '1'
reason = ''
if active:
    reason = 'weekly usage %d%% >= test-stop %d%%: gate work stops, park every role agent' % (pct, thr)
elif nd_active:
    reason = 'weekly usage %d%% >= new-dev-stop %d%%: no new development, in-flight + gates continue' % (pct, nd)
payload = {
    'active': active,
    'percent': pct,
    'testStop': thr,
    'newDevStop': nd,
    'newDevStopActive': nd_active,
    'updatedAt': int(time.time()),
    'exemptAgents': ['mikrob'],
    'reason': reason,
}
# Atomic: a half-written flag read by an orchestrator tick must be impossible.
directory = os.path.dirname(path) or '.'
fd, tmp = tempfile.mkstemp(dir=directory)
with os.fdopen(fd, 'w') as fh:
    json.dump(payload, fh, indent=2)
os.replace(tmp, path)
PYHS
}

# Is the flag file itself currently claiming an active hard stop? Used only for the disagreement
# warning above -- the dispatch decision never depends on it (card 17905a6d).
flag_says_active() {
  python3 -c "
import json
try:
    with open('$HARD_STOP_FLAG') as f:
        raise SystemExit(0 if json.load(f).get('active') is True else 1)
except SystemExit:
    raise
except Exception:
    raise SystemExit(1)
" 2>/dev/null
}

cmd="${1:-run}"
case "$cmd" in
  set-weekly)
    pct="${2:?usage: set-weekly <percent> [reset-label]}"; reset="${3:-}"
    python3 - "$WEEKLY_STATE" "$pct" "$reset" <<'PY'
import json,sys
json.dump({'percent':int(sys.argv[2]),'reset':sys.argv[3],'as_of':'manual','source':'screenshot'},open(sys.argv[1],'w'))
print(f"weekly-usage set: {sys.argv[2]}% reset='{sys.argv[3]}'")
PY
    exit 0 ;;
  show)
    [ -f "$WEEKLY_STATE" ] && cat "$WEEKLY_STATE" && echo || echo "no weekly-usage.json"
    if [ -f "$WEEKLY_STATE" ]; then
      r="$(python3 -c "import json;print(json.load(open('$WEEKLY_STATE')).get('reset',''))")"
      echo "new-dev stop: $(new_dev_threshold)%   test/gate stop: $(test_stop_threshold)%   (reset '$r')"
    fi
    exit 0 ;;
esac

# --- 1) limit banner in any agent pane ----------------------------------------
if command -v tmux >/dev/null 2>&1; then
  for s in $(tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^agent-|^mikrob-channels$' || true); do
    pane="$(tmux capture-pane -t "$s" -p -S -20 2>/dev/null || true)"
    if echo "$pane" | grep -qiE "$RX"; then
      echo "DISPATCH:HOLD:limit-banner($s)"; exit 0
    fi
  done
fi

# --- 2) weekly threshold ------------------------------------------------------
try_oauth_usage >/dev/null 2>&1 || true   # refresh % if a token exists (else no-op)
if [ -f "$WEEKLY_STATE" ]; then
  read -r pct reset < <(python3 - "$WEEKLY_STATE" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(int(d.get('percent',-1)), d.get('reset',''))
PY
)
  load_thresholds
  nd="$NEW_DEV_STOP"
  ts="$TEST_STOP"
  # Card d08b98f4: TWO levels, and the harder one is checked first. At testStop even GATE work
  # stops, so the caller must be able to tell the two apart, not merely see "held".
  if [ "$pct" -ge 0 ] 2>/dev/null && [ "$pct" -ge "$ts" ]; then
    # Read the flag BEFORE writing it -- comparing against what we just wrote would always agree.
    flag_was_active=0
    flag_says_active && flag_was_active=1
    write_hard_stop 1 "$pct" "$ts" "$nd" 1
    # Card 17905a6d (Cybersec LOW #1): SECOND opinion on the flag. This script computes the hard-stop
    # state from the percentage itself, so dispatch is held correctly even with an unreadable flag --
    # but PARKING the role agents is driven by the flag file, and a corrupt one means nobody parks and
    # the fleet burns the shared quota idle-but-running. If our own verdict and the flag disagree, say
    # so loudly rather than let the two drift silently apart.
    if [ "$flag_was_active" != "1" ]; then
      echo "WARN: hard-stop computed ACTIVE (weekly ${pct}% >= ${ts}%) but $HARD_STOP_FLAG is not active -- role agents may NOT be parked. Check the flag file." >&2
    fi
    echo "DISPATCH:HOLD:HARD-STOP weekly-${pct}%>=test-stop-${ts}% -- gate work stops too, park every role agent (reset ${reset:-unknown})"; exit 0
  fi
  nd_active=0
  if [ "$pct" -ge 0 ] 2>/dev/null && [ "$pct" -ge "$nd" ]; then
    nd_active=1
  fi
  write_hard_stop 0 "$pct" "$ts" "$nd" "$nd_active"
  if [ "$nd_active" = "1" ]; then
    echo "DISPATCH:HOLD:weekly-${pct}%>=new-dev-stop-${nd}% (gates still run; reset ${reset:-unknown})"; exit 0
  fi
  echo "# weekly ${pct}% < new-dev stop ${nd}% (test/gate stop ${ts}%, reset ${reset:-unknown})" >&2
else
  echo "# no weekly-usage.json -- relying on banner only; set with: pre-dispatch-check.sh set-weekly <pct> \"<reset>\"" >&2
fi

echo "DISPATCH:OK"

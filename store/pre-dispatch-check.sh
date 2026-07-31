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

# --- editable thresholds (card f3248478), CLAUDE.md defaults if unset/corrupt ---
# echoes "gt3days lt2days lt1day" (three ints, space-separated).
threshold_config() {
  python3 -c "
import json
try:
    with open('$THRESHOLD_CONFIG') as f:
        c = json.load(f)
    g = int(c.get('gt3days', 90))
    l2 = int(c.get('lt2days', 92))
    l1 = int(c.get('lt1day', 95))
    # Fail-safe bounds: never let a bad edit disable the gate or exceed 100.
    g = max(1, min(g, 100)); l2 = max(1, min(l2, 100)); l1 = max(1, min(l1, 100))
    print(g, l2, l1)
except Exception:
    print(90, 92, 95)
" 2>/dev/null || echo "90 92 95"
}

# --- dynamic threshold from days-to-reset --------------------------------------
# args: <reset-label like "Thu 15:59">  -> echoes the integer threshold
dynamic_threshold() {
  local reset="${1:-}"
  local days=99
  if [ -n "$reset" ]; then
    local rts now
    rts="$(date -d "$reset" +%s 2>/dev/null || echo 0)"
    now="$(date +%s)"
    if [ "$rts" -gt 0 ]; then
      [ "$rts" -lt "$now" ] && rts="$(date -d "next $reset" +%s 2>/dev/null || echo "$rts")"
      days=$(( (rts - now) / 86400 ))
    fi
  fi
  read -r gt3 lt2 lt1 <<< "$(threshold_config)"
  if   [ "$days" -lt 1 ]; then echo "$lt1"
  elif [ "$days" -lt 2 ]; then echo "$lt2"
  else echo "$gt3"; fi
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
      echo "threshold now: $(dynamic_threshold "$r")%"
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
  thr="$(dynamic_threshold "$reset")"
  if [ "$pct" -ge 0 ] 2>/dev/null && [ "$pct" -ge "$thr" ]; then
    echo "DISPATCH:HOLD:weekly-${pct}%>=threshold-${thr}% (reset ${reset:-unknown})"; exit 0
  fi
  echo "# weekly ${pct}% < threshold ${thr}% (reset ${reset:-unknown})" >&2
else
  echo "# no weekly-usage.json -- relying on banner only; set with: pre-dispatch-check.sh set-weekly <pct> \"<reset>\"" >&2
fi

echo "DISPATCH:OK"

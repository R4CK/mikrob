#!/usr/bin/env bash
# Real-source target discovery for the load-guard cgroup throttle (card d7a28a0a). Thin and
# untested directly (same role as load-guard-read.sh vs. load-guard-eval.sh): finds the
# lowest-priority CURRENTLY RUNNING engineer-agent tmux session, resolves it to its cgroup scope
# directory, and prints {"target": "<agent-name>|null", "scope": "<abs dir>|null", "degraded": bool}
# for load-guard-cgroup-apply.sh (the tested pure-logic layer) to act on.
#
# EXCLUSION IS HARDCODED, NOT CONFIGURABLE (KOCKAZAT #2 mitigation, phase 19f3bbb5 plan-grilling
# verdict): MikroB and the full gate-pool (qa/qa2/cybersec/cybered -- qa2 included even though the
# card's own prose only names qa, because rule 4/6a establish qa2 as an equal-standing QA-gate
# member for load-balancing; flagged here for the gate to confirm, not silently assumed) can never
# be a throttle target. A runtime config file cannot add or remove from this list.
#
# PRIORITY: among running, non-excluded "agent-*" tmux sessions, the target is whichever agent's
# current in_progress kanban card has the LOWEST priority (urgent>high>normal>low); an agent with
# no in_progress card ranks BELOW low (idle work is less protected than any active low card).
# Ties broken alphabetically by agent name for determinism.
#
# DEGRADED MODE: if the kanban API is unreachable, priority cannot be read -- rather than invent an
# unrequested role-ranking policy, this falls back to the alphabetically-first running candidate
# and sets "degraded": true so the caller/log can surface that the pick was not priority-informed.
set -euo pipefail

DASH="${DASH:-http://localhost:3420}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN_FILE="${DASHBOARD_TOKEN_FILE:-$ROOT/store/.dashboard-token}"
UID_N="$(id -u)"
APP_SLICE="${LOAD_GUARD_CGROUP_ROOT:-/sys/fs/cgroup/user.slice/user-$UID_N.slice/user@$UID_N.service/app.slice}"

EXCLUDED_SESSIONS=(agent-qa agent-qa2 agent-cybersec agent-cybered)

is_excluded() {
  local s="$1"
  [[ "$s" == mikrob* ]] && return 0
  local e
  for e in "${EXCLUDED_SESSIONS[@]}"; do
    [ "$s" = "$e" ] && return 0
  done
  return 1
}

scope_for_pid() {
  local pid="$1" f
  for f in "$APP_SLICE"/*.scope/cgroup.procs; do
    [ -e "$f" ] || continue
    if grep -qxF "$pid" "$f" 2>/dev/null; then
      dirname "$f"
      return 0
    fi
  done
  return 1
}

CANDIDATES_JSON="[]"
if command -v tmux >/dev/null 2>&1 && tmux list-sessions >/dev/null 2>&1; then
  ENTRIES=()
  while IFS= read -r session; do
    [ -n "$session" ] || continue
    [[ "$session" == agent-* ]] || continue
    is_excluded "$session" && continue
    agent="${session#agent-}"
    pid=$(tmux list-panes -t "$session" -F '#{pane_pid}' 2>/dev/null | head -1)
    [ -n "$pid" ] || continue
    scope=$(scope_for_pid "$pid") || continue
    ENTRIES+=("{\"agent\":\"$agent\",\"session\":\"$session\",\"scope\":\"$scope\"}")
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null)
  if [ "${#ENTRIES[@]}" -gt 0 ]; then
    CANDIDATES_JSON="[$(IFS=,; echo "${ENTRIES[*]}")]"
  fi
fi

# The board's raw JSON can be large (hundreds of KB) -- passed as a positional argv string it can
# exceed the combined argv+envp exec limit depending on how much of ARG_MAX this process's own
# environment already consumes (measured: a 570KB payload alone hit "Argument list too long" here).
# A temp file sidesteps the limit entirely regardless of board size.
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
kanban_file="$(mktemp)"
trap 'rm -f "$hdr_file" "$kanban_file"' EXIT
if [ "$CANDIDATES_JSON" != "[]" ] && [ -r "$TOKEN_FILE" ]; then
  printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$hdr_file"
  curl -sf -H @"$hdr_file" "$DASH/api/kanban" -o "$kanban_file" 2>/dev/null || true
fi

python3 - "$CANDIDATES_JSON" "$kanban_file" <<'PYEOF'
import json
import sys

candidates = json.loads(sys.argv[1])
kanban_path = sys.argv[2]
try:
    with open(kanban_path) as f:
        kanban_raw = f.read()
except OSError:
    kanban_raw = ""

if not candidates:
    print(json.dumps({"target": None, "scope": None, "degraded": False}))
    sys.exit(0)

RANK = {"urgent": 4, "high": 3, "normal": 2, "low": 1}

cards = None
if kanban_raw:
    try:
        cards = json.loads(kanban_raw)
    except json.JSONDecodeError:
        cards = None

degraded = cards is None

if not degraded:
    best_rank = {}
    for c in cards:
        if c.get("status") != "in_progress":
            continue
        a = c.get("assignee")
        if a is None:
            continue
        r = RANK.get(c.get("priority"), 0)
        best_rank[a] = max(best_rank.get(a, -1), r)
    for cand in candidates:
        cand["rank"] = best_rank.get(cand["agent"], 0)
    candidates.sort(key=lambda c: (c["rank"], c["agent"]))
else:
    candidates.sort(key=lambda c: c["agent"])

pick = candidates[0]
print(json.dumps({"target": pick["agent"], "scope": pick["scope"], "degraded": degraded}))
PYEOF

#!/usr/bin/env bash
# Real-source target discovery for the load-guard SIGSTOP/SIGCONT freeze (card 2bfbf805, Feladat 3
# of phase 19f3bbb5: "ha a fekezes [Feladat 2] sem eleg"). Finds the lowest-priority CURRENTLY
# RUNNING engineer-agent tmux session, resolves it to its pane pid, and prints
# {"target": "<agent-name>|null", "pid": <int>|null, "degraded": bool}
# for load-guard-sigstop-apply.sh (the tested pure-logic layer) to act on.
#
# EXCLUSION: shared with load-guard-cgroup-target.sh via load-guard-excluded.sh -- see that file.
# "MikroB es a 3 gate-ugynok SOSEM celpont" (card's own words) is a single source of truth for both
# throttle mechanisms, not two copies that could silently drift apart.
#
# ROUND-ROBIN, not plain alphabetical (the card's own distinction from Feladat 2's target
# selection: "korforgasos celpont-valasztas a tobbi kozott"). Priority still picks the WORST tier
# to draw from (lowest in_progress priority, no-card ranks below low) -- round-robin only decides
# WHICH one, among candidates tied at that worst tier, so a load spike does not keep re-freezing
# the same low-priority agent every tick while an equally-low-priority sibling never gets touched.
# The rotation pointer persists in a tiny state file (last picked agent); the candidate immediately
# AFTER it in a stable sort order is picked, wrapping around. A single eligible candidate degenerates
# to "always that one" -- unavoidable, not a bug.
#
# DEGRADED MODE: if the kanban API is unreachable, priority cannot be read -- same fallback as
# load-guard-cgroup-target.sh: alphabetically-first running candidate, "degraded": true, no invented
# role-ranking.
#
# The SELECTION logic (rank + round-robin, below) is real deterministic decision logic, not thin
# real-source discovery -- unlike load-guard-cgroup-target.sh, it is worth testing directly rather
# than only through --test-excluded's narrower is_excluded() check. --test-select runs the SAME
# code the production path runs (one variable, two call sites, kanban JSON via STDIN in both --
# never argv, same ARG_MAX reasoning as load-guard-cgroup-target.sh's own temp-file comment), so
# there is no drift between what a test exercises and what actually ships (mirrors
# store/offload-batch-run.sh's SELECT_PY pattern).
set -euo pipefail

DASH="${DASH:-http://localhost:3420}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN_FILE="${DASHBOARD_TOKEN_FILE:-$ROOT/store/.dashboard-token}"
ROTATION_STATE="${LOAD_GUARD_SIGSTOP_ROTATION_STATE:-$ROOT/store/load-guard-sigstop-rotation-state.json}"

# card 2bfbf805: shared with load-guard-cgroup-target.sh -- see load-guard-excluded.sh.
. "$(dirname "${BASH_SOURCE[0]}")/load-guard-excluded.sh"

SELECT_PY='
import json
import sys

candidates = json.loads(sys.argv[1])
prev_pick = sys.argv[2]
rotation_state_path = sys.argv[3]
kanban_raw = sys.stdin.read()

if not candidates:
    print(json.dumps({"target": None, "pid": None, "degraded": False}))
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
else:
    for cand in candidates:
        cand["rank"] = 0

# Stable order for the rotation: (rank, agent) ascending, same as load-guard-cgroup-target.sh.
candidates.sort(key=lambda c: (c["rank"], c["agent"]))
worst_rank = candidates[0]["rank"]
tied = [c for c in candidates if c["rank"] == worst_rank]

if degraded or len(tied) == 1:
    pick = tied[0]
else:
    # Round-robin among the tied worst-rank candidates: pick the one AFTER prev_pick in this
    # stable order, wrapping around. prev_pick absent/no-longer-eligible -> start from the front
    # (still deterministic, never crashes on a stale or foreign rotation pointer).
    names = [c["agent"] for c in tied]
    try:
        idx = (names.index(prev_pick) + 1) % len(tied)
    except ValueError:
        idx = 0
    pick = tied[idx]

try:
    with open(rotation_state_path, "w") as f:
        json.dump({"last_target": pick["agent"]}, f)
        f.write("\n")
except OSError:
    pass  # best-effort: a missing state dir degrades rotation to "always index 0", not a crash

print(json.dumps({"target": pick["agent"], "pid": pick["pid"], "degraded": degraded}))
'

# Test-only hook: candidates-json prev-pick rotation-state-path, kanban JSON (or empty for
# degraded) via STDIN -- runs SELECT_PY directly, no tmux/curl.
if [ "${1:-}" = "--test-select" ]; then
  python3 -c "$SELECT_PY" "$2" "${3:-}" "${4:-/dev/null}"
  exit 0
fi

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
    ENTRIES+=("{\"agent\":\"$agent\",\"session\":\"$session\",\"pid\":$pid}")
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null)
  if [ "${#ENTRIES[@]}" -gt 0 ]; then
    CANDIDATES_JSON="[$(IFS=,; echo "${ENTRIES[*]}")]"
  fi
fi

# Same ARG_MAX reasoning as load-guard-cgroup-target.sh: the board's raw JSON can exceed the
# combined argv+envp exec limit, so it is streamed via STDIN, never a positional argument.
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
kanban_file="$(mktemp)"
trap 'rm -f "$hdr_file" "$kanban_file"' EXIT
if [ "$CANDIDATES_JSON" != "[]" ] && [ -r "$TOKEN_FILE" ]; then
  printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$hdr_file"
  curl -sf -H @"$hdr_file" "$DASH/api/kanban" -o "$kanban_file" 2>/dev/null || true
fi

prev_pick=""
[ -r "$ROTATION_STATE" ] && prev_pick="$(python3 -c "import json,sys
try:
    print(json.load(open(sys.argv[1])).get('last_target') or '')
except Exception:
    print('')" "$ROTATION_STATE" 2>/dev/null || true)"

python3 -c "$SELECT_PY" "$CANDIDATES_JSON" "$prev_pick" "$ROTATION_STATE" < "$kanban_file"

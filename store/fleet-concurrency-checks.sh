#!/usr/bin/env bash
# fleet-concurrency-checks.sh -- two read-only fleet-health observability checks (card 9aa455c6,
# Peti's defense-mechanism audit findings 1 and 3, 2026-09-07). Neither check changes any dispatch
# decision -- both only REPORT, for the heartbeat D section to log/escalate.
#
# FINDING 1 (multi-in-progress): the fleet had no concurrency limit or alert when a single assignee
# holds MORE THAN ONE in_progress LEAF card at once -- measured live: `backend` was carrying 7
# simultaneous in_progress cards while only one tmux session actually works, so the other six sat
# abandoned with nothing surfacing that. `multi-in-progress` reports the current violations, but --
# same "alert only on CHANGE" shape agent-skill-drift-sync.sh already established for this fleet --
# only the FIRST time a given assignee's violating card-set is seen, not every heartbeat tick for as
# long as it persists (a steady-state violation that fires every 5 minutes for hours is the exact
# alert-fatigue shape this fleet has already rejected once, card 222fdc5e).
#
# FINDING 3 (dispatch-lock-age): project-dispatch-priority.json's exclusivity (root CLAUDE.md rule
# 11) can hold a single project locked out of self-advance for as long as that project's `planned`
# column has ANY dispatchable card -- correct per the rule, but with no signal to Peti that OTHER
# projects have gone untouched all day as a side effect. Measured: the MikroB-only lock had stood
# ~24h with CleanCore's 29 planned cards completely untouched. `dispatch-lock-age` does not change
# the lock -- it only notes, once per DISTINCT lock (keyed on the file's own `updated_at`), that it
# has stood past a threshold, so Peti can consciously decide whether to intervene.
#
# TESTABILITY: neither check calls curl/the dashboard directly in its own body -- both take their
# INPUT DATA from a file (--cards-file / --priority-file), defaulting to a fresh live fetch/read only
# when the flag is omitted. The companion store/fleet-concurrency-checks.selftest.sh always passes
# fixture files, so it never touches the live dashboard or the live project-dispatch-priority.json --
# same seam shape as offload-dispatch.sh's --test-resolve.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FLEET_CONCURRENCY_ROOT:-$(cd "$HERE/.." && pwd)}"
DASH="${DASH:-http://localhost:3420}"
TOKEN_FILE="${FLEET_CONCURRENCY_TOKEN_FILE:-$ROOT/store/.dashboard-token}"

MODE="${1:-}"; shift || true

_curl_get() { # $1 = path ; token via 0600 headerfile, never argv (same pattern as redispatch-guard.sh)
  local hf; hf="$(mktemp)"; chmod 600 "$hf"
  printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE" 2>/dev/null)" > "$hf"
  curl -s --max-time 12 -H @"$hf" "${DASH}$1" 2>/dev/null
  rm -f "$hf" 2>/dev/null || true
}

_hash() { shasum -a 256 | awk '{print $1}'; }

# ---- multi-in-progress -------------------------------------------------------------------------
case "$MODE" in
  multi-in-progress)
    CARDS_FILE=""
    STATE="${FLEET_CONCURRENCY_STATE:-$ROOT/store/multi-in-progress-state.json}"
    while [ $# -gt 0 ]; do
      case "$1" in
        --cards-file) CARDS_FILE="$2"; shift 2 ;;
        --state-file) STATE="$2"; shift 2 ;;
        *) echo "multi-in-progress: unknown arg '$1'" >&2; exit 2 ;;
      esac
    done
    # Written to a temp FILE, then passed as an argv path -- not fed over stdin alongside the
    # heredoc script below. `python3 -` already consumes stdin for the heredoc's OWN text, so a
    # SECOND stdin redirect (a here-string with the card data) does not layer on top of it; the two
    # conflict, and the script silently reads empty input instead of the data (measured while
    # building this: `sys.stdin.read()` came back `''` even with a here-string attached after the
    # heredoc terminator).
    if [ -n "$CARDS_FILE" ]; then
      cards_json="$(cat "$CARDS_FILE" 2>/dev/null)"
    else
      cards_json="$(_curl_get "/api/kanban")"
    fi
    cards_tmp="$(mktemp)"
    printf '%s' "$cards_json" > "$cards_tmp"
    result="$(python3 - "$STATE" "$cards_tmp" <<'PY'
import json, sys

state_path, cards_path = sys.argv[1], sys.argv[2]
try:
    with open(cards_path) as f:
        cards = json.load(f)
except Exception:
    print("ALERT:yes reasons=unreadable-cards")
    sys.exit(0)
if isinstance(cards, dict):
    cards = cards.get("cards", cards)

parents = {c.get("parent_id") for c in cards if c.get("parent_id")}
by_assignee = {}
for c in cards:
    if c.get("status") != "in_progress":
        continue
    if c.get("id") in parents:
        continue  # a Phase/Task container, not a real work unit (matches the D-section stuck-card query)
    if c.get("archived_at"):
        continue
    a = c.get("assignee")
    if not a:
        continue
    by_assignee.setdefault(a, []).append(c.get("id"))

violations = {a: sorted(ids) for a, ids in by_assignee.items() if len(ids) > 1}

try:
    with open(state_path) as f:
        prev = json.load(f)
except Exception:
    prev = {}

# Card-level, not just count-level: a set SWAP (one card replaced by another, same count) is still
# a change worth a fresh report, the same reasoning agent-skill-drift-sync.sh's own diverged-SET
# comparison uses (a count-based trigger would miss a swap).
new_or_changed = {a: ids for a, ids in violations.items() if prev.get(a) != ids}
resolved = [a for a in prev if a not in violations]

if new_or_changed or resolved:
    print(f"ALERT:yes reasons=multi-in-progress violations={len(violations)} new-or-changed={len(new_or_changed)} resolved={len(resolved)}")
    for a, ids in sorted(new_or_changed.items()):
        print(f"  {a}: {len(ids)} concurrent in_progress leaf cards -- {', '.join(ids)}")
    if resolved:
        print(f"  resolved (no longer violating): {', '.join(sorted(resolved))}")
else:
    print(f"ALERT:no (violating-set unchanged, {len(violations)} assignee(s) currently over the limit)")

fd_dir = None
import os, tempfile
try:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(state_path) or ".")
    with os.fdopen(fd, "w") as f:
        json.dump(violations, f, indent=2)
    os.replace(tmp, state_path)
except Exception:
    pass
PY
)"
    rm -f "$cards_tmp"
    echo "$result"
    ;;

  dispatch-lock-age)
    PRIORITY_FILE="${FLEET_CONCURRENCY_PRIORITY_FILE:-$ROOT/store/project-dispatch-priority.json}"
    STATE="${FLEET_CONCURRENCY_LOCK_STATE:-$ROOT/store/dispatch-lock-notified-state.json}"
    THRESHOLD="${FLEET_CONCURRENCY_LOCK_THRESHOLD_S:-43200}"  # 43200s = 12h; a bare numeric arg
                                                               # (see below) overrides this default.
    while [ $# -gt 0 ]; do
      case "$1" in
        --priority-file) PRIORITY_FILE="$2"; shift 2 ;;
        --state-file) STATE="$2"; shift 2 ;;
        [0-9]*) THRESHOLD="$1"; shift ;;
        *) echo "dispatch-lock-age: unknown arg '$1'" >&2; exit 2 ;;
      esac
    done
    python3 - "$PRIORITY_FILE" "$STATE" "$(date +%s)" "$THRESHOLD" <<'PY'
import json, sys

priority_path, state_path, now, threshold = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])

try:
    with open(priority_path) as f:
        cfg = json.load(f)
except Exception:
    print("ALERT:no (no project-dispatch-priority.json -- no exclusive lock)")
    sys.exit(0)

priority = cfg.get("priority") or []
updated_at = int(cfg.get("updated_at") or 0)

if not priority:
    print("ALERT:no (priority list is empty -- no exclusive lock)")
    sys.exit(0)

age = now - updated_at
if age < threshold:
    print(f"ALERT:no (lock age {age}s under the {threshold}s threshold, projects={priority})")
    sys.exit(0)

try:
    with open(state_path) as f:
        prev = json.load(f)
except Exception:
    prev = {}

# Keyed on updated_at, not on a boolean: a NEW lock setting (Peti changes the list, or it gets
# reset) gets its own future notification once IT also crosses the threshold -- only the SAME
# still-standing lock is silenced after the first report.
if prev.get("last_notified_updated_at") == updated_at:
    print(f"ALERT:no (already notified for this lock, age {age}s, projects={priority})")
    sys.exit(0)

print(f"ALERT:yes reasons=dispatch-lock-exceeded-threshold age={age}s threshold={threshold}s projects={priority}")

import os, tempfile
try:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(state_path) or ".")
    with os.fdopen(fd, "w") as f:
        json.dump({"last_notified_updated_at": updated_at}, f, indent=2)
    os.replace(tmp, state_path)
except Exception:
    pass
PY
    ;;

  *)
    echo "usage: $0 {multi-in-progress [--cards-file <f>] [--state-file <f>] | dispatch-lock-age [thresholdSeconds] [--priority-file <f>] [--state-file <f>]}" >&2
    exit 2 ;;
esac

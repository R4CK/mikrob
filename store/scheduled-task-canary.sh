#!/usr/bin/env bash
# scheduled-task-canary.sh -- catch a scheduled task that has gone silently dead.
#
# WHY: `offload-overnight-batch` was due at 03:00 every night and NEVER ran once in
# five days. Nothing noticed, because a task that does not fire produces no log, no
# error and no alert -- the absence of output looks exactly like a quiet success.
# The DB knew all along: every one of its 7 recorded runs had status `missed`.
#
# This reads that record and says so out loud. Two findings, both meaning "scheduled
# but not actually running":
#   never-fired   -- the task has run records, but not one of them is `fired`
#   all-missed    -- its last N runs (default 3) are all `missed`
#
# READ-ONLY: opens the DB with mode=ro and writes nothing.
#
# USAGE
#   store/scheduled-task-canary.sh [--tasks-dir <dir>] [--db <file>] [--window N]
#   store/scheduled-task-canary.sh --selftest
# OUTPUT (first line machine-readable): OK | STALE-TASKS <n> | ERROR:<why>
# Exit: 0 healthy | 1 findings | 2 error

set -uo pipefail

TASKS_DIR="${CANARY_TASKS_DIR:-$HOME/.claude/scheduled-tasks}"
DB="${CANARY_DB:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claudeclaw.db}"
WINDOW=3
MODE="check"

while [ $# -gt 0 ]; do
  case "$1" in
    --tasks-dir) [ $# -ge 2 ] || { echo "ERROR:missing-value:--tasks-dir"; exit 2; }; TASKS_DIR="$2"; shift 2 ;;
    --db) [ $# -ge 2 ] || { echo "ERROR:missing-value:--db"; exit 2; }; DB="$2"; shift 2 ;;
    --window) [ $# -ge 2 ] || { echo "ERROR:missing-value:--window"; exit 2; }; WINDOW="$2"; shift 2 ;;
    --selftest) MODE="selftest"; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR:unknown-argument:$1"; exit 2 ;;
  esac
done

# A non-numeric window would make `[ "$n" -ge "$WINDOW" ]` error to stderr and return
# false, so every task would silently look healthy -- the same fail-open shape this
# script exists to report.
case "$WINDOW" in ''|*[!0-9]*) echo "ERROR:invalid-window:$WINDOW"; exit 2 ;; esac
[ "$WINDOW" -gt 0 ] || { echo "ERROR:invalid-window:$WINDOW"; exit 2; }

check() {
  [ -d "$TASKS_DIR" ] || { echo "ERROR:no-tasks-dir:$TASKS_DIR"; exit 2; }
  [ -r "$DB" ] || { echo "ERROR:no-db:$DB"; exit 2; }
  command -v sqlite3 >/dev/null 2>&1 || { echo "ERROR:sqlite3-not-installed"; exit 2; }

  local findings=() cfg name enabled fired total recent
  local checked=0
  for cfg in "$TASKS_DIR"/*/task-config.json; do
    [ -r "$cfg" ] || continue
    name="$(basename "$(dirname "$cfg")")"
    enabled="$(python3 -c 'import json,sys; print("1" if json.load(open(sys.argv[1])).get("enabled",True) else "0")' "$cfg" 2>/dev/null || echo 1)"
    [ "$enabled" = "1" ] || continue
    checked=$((checked + 1))

    total="$(sqlite3 "file:$DB?mode=ro" "SELECT COUNT(*) FROM task_runs WHERE name='${name//\'/\'\'}';" 2>/dev/null || echo "")"
    case "$total" in ''|*[!0-9]*) continue ;; esac
    # No runs at all is not a finding: a freshly created task has simply not come
    # due yet, and flagging it would train everyone to ignore this output.
    [ "$total" -gt 0 ] || continue

    fired="$(sqlite3 "file:$DB?mode=ro" "SELECT COUNT(*) FROM task_runs WHERE name='${name//\'/\'\'}' AND status='fired';" 2>/dev/null || echo "")"
    case "$fired" in ''|*[!0-9]*) continue ;; esac
    if [ "$fired" -eq 0 ]; then
      findings+=("never-fired  $name  ($total run(s) recorded, not one fired)")
      continue
    fi

    # last WINDOW runs, newest first
    recent="$(sqlite3 "file:$DB?mode=ro" "SELECT status FROM task_runs WHERE name='${name//\'/\'\'}' ORDER BY ts DESC LIMIT $WINDOW;" 2>/dev/null || echo "")"
    local n_recent n_missed
    n_recent="$(printf '%s\n' "$recent" | sed '/^$/d' | wc -l)"
    n_missed="$(printf '%s\n' "$recent" | grep -c '^missed$' || true)"
    if [ "$n_recent" -ge "$WINDOW" ] && [ "$n_missed" -eq "$n_recent" ]; then
      findings+=("all-missed   $name  (last $n_recent runs all missed)")
    fi
  done

  [ "$checked" -gt 0 ] || { echo "ERROR:no-enabled-tasks-found"; exit 2; }

  if [ "${#findings[@]}" -eq 0 ]; then
    echo "OK ($checked enabled task(s) checked)"
    return 0
  fi
  echo "STALE-TASKS ${#findings[@]}"
  printf '  %s\n' "${findings[@]}"
  echo "  a scheduled task that never fires produces no log and no error -- check its type's catch-up budget and whether the host is up at its cron time"
  return 1
}

selftest() {
  local tmp fail=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/tasks/healthy" "$tmp/tasks/dead" "$tmp/tasks/off" "$tmp/tasks/fresh"
  for t in healthy dead fresh; do echo '{"enabled":true}' > "$tmp/tasks/$t/task-config.json"; done
  echo '{"enabled":false}' > "$tmp/tasks/off/task-config.json"
  local db="$tmp/db.sqlite"
  sqlite3 "$db" "CREATE TABLE task_runs (id INTEGER PRIMARY KEY, name TEXT, agent TEXT, ts INTEGER, status TEXT);
    INSERT INTO task_runs (name,agent,ts,status) VALUES
      ('healthy','a',1,'fired'),('healthy','a',2,'fired'),('healthy','a',3,'fired'),
      ('dead','a',1,'missed'),('dead','a',2,'missed'),('dead','a',3,'missed'),
      ('off','a',1,'missed'),('off','a',2,'missed'),('off','a',3,'missed');"
  TASKS_DIR="$tmp/tasks"; DB="$db"

  local out rc
  out="$(check 2>&1)"; rc=$?
  if [ "$rc" = "1" ] && printf '%s' "$out" | grep -q 'never-fired  dead'; then
    echo "ok   a task whose every run is missed -> finding"
  else echo "FAIL dead task: rc=$rc out=$out"; fail=1; fi
  if printf '%s' "$out" | grep -q 'healthy'; then echo "FAIL healthy task flagged"; fail=1
  else echo "ok   a firing task is not flagged"; fi
  if printf '%s' "$out" | grep -q ' off'; then echo "FAIL disabled task flagged"; fail=1
  else echo "ok   a DISABLED task is skipped"; fi
  if printf '%s' "$out" | grep -q 'fresh'; then echo "FAIL never-run task flagged"; fail=1
  else echo "ok   a task with no runs yet is not flagged"; fi

  # a task that fired before but has since gone quiet
  sqlite3 "$db" "INSERT INTO task_runs (name,agent,ts,status) VALUES
    ('lapsed','a',1,'fired'),('lapsed','a',2,'missed'),('lapsed','a',3,'missed'),('lapsed','a',4,'missed');"
  mkdir -p "$tmp/tasks/lapsed"; echo '{"enabled":true}' > "$tmp/tasks/lapsed/task-config.json"
  out="$(check 2>&1)"
  if printf '%s' "$out" | grep -q 'all-missed   lapsed'; then echo "ok   a previously-firing task gone quiet -> finding"
  else echo "FAIL lapsed task: $out"; fail=1; fi

  [ "$fail" = "0" ] && echo "selftest OK"
  return "$fail"
}

case "$MODE" in
  selftest) selftest; exit $? ;;
  *) check; exit $? ;;
esac

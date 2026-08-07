#!/usr/bin/env bash
# scheduled-task-canary.sh -- catch a scheduled task that has gone silently dead.
#
# WHY: `offload-overnight-batch` was due at 03:00 every night and NEVER ran once in
# five days. Nothing noticed, because a task that does not fire produces no log, no
# error and no alert -- the absence of output looks exactly like a quiet success.
# The DB knew all along: every one of its 7 recorded runs had status `missed`.
#
# This reads that record and says so out loud. Findings, all meaning "scheduled but
# not actually running":
#   never-fired    -- the task has run records, but not one is a SUCCESS
#   no-recent-run  -- none of its last N runs (default 3) succeeded
#   dropped-busy   -- its recent runs are `skipped` although it has no pre-check, so
#                     the scheduler dropped the ticks (skipIfBusy) rather than the task
#                     deciding there was nothing to do
#   unverifiable   -- a query about it failed, so nothing could be concluded
#
# SUCCESS means `fired` OR `fired_late`. The live table carries FOUR statuses -- fired
# 12151, skipped 1446, fired_late 273, missed 43 -- and an earlier version of this
# script knew only two. That hid two genuinely dead tasks (memoria-heartbeat and
# deploy-freshness-monitor: dropped every tick, no pre-check) and would have called a
# permanently-late-but-working task "never fired". 4 of 6 detected instead of 6 of 6.
#
# `skipped` is overloaded at the source: schedule-runner writes it both for "the
# pre-check said there is nothing to do" (healthy) and for "the session was busy, tick
# dropped" (not healthy). They are distinguishable from here only by whether the task
# HAS a pre-check at all, which is what dropped-busy keys on. The real fix is a
# distinct status at the write site; until then this is the honest approximation.
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

  # A failed query must never be a SILENT skip. The old code did `continue` on any
  # unparseable answer while `checked` had already been incremented, so a missing
  # table, a corrupt file or a lock produced a clean "OK (N tasks checked)" -- the
  # exact false all-clear this script exists to prevent. A schema rename alone would
  # have turned it permanently green. `.timeout` covers the lock case; reporting
  # `unverifiable` covers every other cause.
  q() { sqlite3 -cmd '.timeout 5000' "file:$DB?mode=ro" "$1" 2>/dev/null; }

  local findings=() cfg name enabled ok_runs total recent
  local checked=0
  for cfg in "$TASKS_DIR"/*/task-config.json; do
    [ -r "$cfg" ] || continue
    name="$(basename "$(dirname "$cfg")")"
    enabled="$(python3 -c 'import json,sys; print("1" if json.load(open(sys.argv[1])).get("enabled",True) else "0")' "$cfg" 2>/dev/null || echo 1)"
    [ "$enabled" = "1" ] || continue
    checked=$((checked + 1))
    local esc="${name//\'/\'\'}"

    total="$(q "SELECT COUNT(*) FROM task_runs WHERE name='$esc';")"
    case "$total" in ''|*[!0-9]*) findings+=("unverifiable $name  (a futas-szamlalo lekerdezes nem sikerult)"); continue ;; esac
    # No runs at all is not a finding: a freshly created task has simply not come
    # due yet, and flagging it would train everyone to ignore this output.
    [ "$total" -gt 0 ] || continue

    # SUCCESS = fired OR fired_late. A task that always runs late still runs.
    ok_runs="$(q "SELECT COUNT(*) FROM task_runs WHERE name='$esc' AND status IN ('fired','fired_late');")"
    case "$ok_runs" in ''|*[!0-9]*) findings+=("unverifiable $name  (a sikeres-futas lekerdezes nem sikerult)"); continue ;; esac
    if [ "$ok_runs" -eq 0 ]; then
      findings+=("never-fired   $name  ($total run(s) recorded, not one succeeded)")
      continue
    fi

    recent="$(q "SELECT status FROM task_runs WHERE name='$esc' ORDER BY ts DESC LIMIT $WINDOW;")"
    if [ -z "$recent" ]; then
      findings+=("unverifiable $name  (a legutobbi futasok lekerdezese nem sikerult)"); continue
    fi
    local n_recent n_ok n_skipped
    n_recent="$(printf '%s\n' "$recent" | sed '/^$/d' | wc -l)"
    n_ok="$(printf '%s\n' "$recent" | grep -cE '^(fired|fired_late)$' || true)"
    n_skipped="$(printf '%s\n' "$recent" | grep -c '^skipped$' || true)"
    [ "$n_recent" -ge "$WINDOW" ] || continue

    if [ "$n_ok" -eq 0 ]; then
      if [ "$n_skipped" -eq "$n_recent" ]; then
        # EVERY recent run was `skipped`. With a pre-check that is the healthy case --
        # the task itself decided there was nothing to do. Without one, the only writer
        # of `skipped` is the skipIfBusy drop, i.e. the task never got to run at all.
        if _has_precheck "$cfg"; then
          : # legitimately idle, not a finding
        else
          findings+=("dropped-busy  $name  (last $n_recent runs all skipped, no pre-check -> ticks dropped, not \"nothing to do\")")
        fi
      else
        # a mix of missed/other: real failures regardless of any pre-check
        findings+=("no-recent-run $name  (last $n_recent runs, none succeeded)")
      fi
    fi
  done

  [ "$checked" -gt 0 ] || { echo "ERROR:no-enabled-tasks-found"; exit 2; }

  if [ "${#findings[@]}" -eq 0 ]; then
    echo "OK ($checked enabled task(s) checked)"
    return 0
  fi
  echo "STALE-TASKS ${#findings[@]}"
  printf '  %s\n' "${findings[@]}"
  echo "  a scheduled task that never fires produces no log and no error -- check its type's catch-up budget, whether the host is up at its cron time, and whether skipIfBusy is dropping every tick"
  return 1
}

# True when the task config declares a pre-check. Without one, a `skipped` run cannot
# mean "the pre-check said there was nothing to do".
_has_precheck() {
  python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print("Y" if c.get("preCheck") else "N")' "$1" 2>/dev/null | grep -q '^Y$'
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
  if [ "$rc" = "1" ] && printf '%s' "$out" | grep -q 'never-fired   dead'; then
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
  if printf '%s' "$out" | grep -q 'no-recent-run lapsed'; then echo "ok   a previously-firing task gone quiet -> finding"
  else echo "FAIL lapsed task: $out"; fail=1; fi

  # fired_late is a SUCCESS: a task that always runs late still runs
  sqlite3 "$db" "INSERT INTO task_runs (name,agent,ts,status) VALUES
    ('late','a',1,'fired_late'),('late','a',2,'fired_late'),('late','a',3,'fired_late');"
  mkdir -p "$tmp/tasks/late"; echo '{"enabled":true}' > "$tmp/tasks/late/task-config.json"
  out="$(check 2>&1)"
  if printf '%s' "$out" | grep -q 'late'; then echo "FAIL always-late task reported dead: $out"; fail=1
  else echo "ok   a permanently-late but RUNNING task is not flagged"; fi

  # skipped with NO pre-check = ticks dropped by skipIfBusy, not "nothing to do"
  sqlite3 "$db" "INSERT INTO task_runs (name,agent,ts,status) VALUES
    ('dropped','a',1,'fired'),('dropped','a',2,'skipped'),('dropped','a',3,'skipped'),('dropped','a',4,'skipped');"
  mkdir -p "$tmp/tasks/dropped"; echo '{"enabled":true}' > "$tmp/tasks/dropped/task-config.json"
  out="$(check 2>&1)"
  if printf '%s' "$out" | grep -q 'dropped-busy  dropped'; then echo "ok   skipped without a pre-check -> dropped-busy finding"
  else echo "FAIL dropped-busy: $out"; fail=1; fi

  # the same shape WITH a pre-check is healthy: the task decided there was nothing to do
  sqlite3 "$db" "INSERT INTO task_runs (name,agent,ts,status) VALUES
    ('nothingtodo','a',1,'fired'),('nothingtodo','a',2,'skipped'),('nothingtodo','a',3,'skipped'),('nothingtodo','a',4,'skipped');"
  mkdir -p "$tmp/tasks/nothingtodo"; echo '{"enabled":true,"preCheck":"pre.sh"}' > "$tmp/tasks/nothingtodo/task-config.json"
  out="$(check 2>&1)"
  if printf '%s' "$out" | grep -q 'nothingtodo'; then echo "FAIL pre-check skip reported as dead: $out"; fail=1
  else echo "ok   skipped WITH a pre-check is not a finding"; fi

  # a broken query must be REPORTED, never silently skipped into a clean OK
  local db2="$tmp/db2.sqlite"
  sqlite3 "$db2" "CREATE TABLE unrelated (x INTEGER);"
  DB="$db2"
  out="$(check 2>&1)"
  if printf '%s' "$out" | grep -q 'unverifiable' && ! printf '%s' "$out" | grep -q '^OK ('; then
    echo "ok   missing task_runs table -> unverifiable, not a false OK"
  else echo "FAIL missing table: $out"; fail=1; fi
  DB="$db"

  [ "$fail" = "0" ] && echo "selftest OK"
  return "$fail"
}

case "$MODE" in
  selftest) selftest; exit $? ;;
  *) check; exit $? ;;
esac

#!/usr/bin/env bash
# Serialise full CleanCore suite runs to N at a time (card 5af57bd7, MikroB decision).
#
# THE PROBLEM, measured. A full CleanCore run takes ~60 minutes on an idle box and ~81 under load,
# and vitest defaults maxWorkers to the CPU count -- 12 here. With 18 CleanCore worktrees, three
# agents running the suite is 36 workers on 12 cores. What breaks then is not a test: the worker
# reports results to the MAIN process over an RPC whose timeout is birpc's hard-coded 60 seconds
# (vitest 3.2.6 passes no override, and `forks.js` exposes none), so a CPU-starved main process that
# cannot answer in time makes the worker throw. The run then exits 1 with ZERO test failures.
#
# Four occurrences in one day, on four different diffs. Twice the run was killed outright
# (ERR_IPC_CHANNEL_CLOSED). That is a false red waiting to happen, and a false red on a gate sends
# correct work back to in_progress.
#
# WHY A SEMAPHORE AND NOT A MUTEX. marveen's fleet-test.sh takes a single flock because its runs
# share ONE tree -- there the lock is about CORRECTNESS. Here every agent has its own worktree and
# the runs are independently correct; what they contend for is CPU. So this counts to N (2) rather
# than to 1: eighteen agents queueing for a 60-minute mutex would trade a rare false red for a
# permanent traffic jam.
#
# WHY flock ON A FILE DESCRIPTOR. The kernel drops the lock when the holder dies, so a SIGKILL --
# which is how two of today's four runs ended -- cannot leak a slot. A lock expressed as file
# CONTENT would have needed a stale-entry sweeper, which is another thing to get wrong.
#
# WHY A WAITER MUST NOT LOOK STUCK. Fleet rule 3 calls an in_progress card stuck when its
# `updated_at` has not moved for 10 minutes, and rule 3a hands it to a sibling agent after 60. A
# silent 80-minute wait would therefore get the waiting agent's card re-dispatched or taken away --
# strictly worse than the false red this exists to prevent. So the wait is NOT silent: it posts an
# INFO-ONLY PAUSED-SEMAPHORE comment when it starts waiting, refreshes it periodically, and posts
# RESUMED-SEMAPHORE on acquire. Each comment moves `updated_at`, which is the field the monitor
# actually reads.
#
# THE ROUTINE CASE STAYS QUIET. When a slot is free immediately -- the common case -- this posts
# NOTHING. A notice that fires on healthy traffic is one that gets skipped when it matters; that
# lesson is card 222fdc5e's, on this same board.
#
# Usage:
#   store/cleancore-suite-run.sh <agent> [-- <extra vitest args>]
#   CLEANCORE_SUITE_SLOTS=3 store/cleancore-suite-run.sh backend3
#
# Env:
#   MARVEEN_MAIN                 default /home/neon/marveen -- the SHARED anchor the slot files live
#                                under. This is what makes the cap fleet-wide instead of per-checkout
#                                (see LOCK_PREFIX below); pointing it somewhere private is how the
#                                selftest contends without touching the real fleet's slots.
#   CLEANCORE_SUITE_LOCK_PREFIX  overrides the slot path outright. Overriding it per checkout
#                                REMOVES the mutual exclusion -- that is the bug this default fixes.
#   CLEANCORE_SUITE_SLOTS        default 2
#
# Exit: the suite's own exit code | 2 usage or an unusable lock directory | 3 no slot within the cap
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SLOTS="${CLEANCORE_SUITE_SLOTS:-2}"
WAIT_MAX_S="${CLEANCORE_SUITE_WAIT_MAX_S:-7200}"   # 2h: two 60-90min runs can legitimately be ahead
POLL_S="${CLEANCORE_SUITE_POLL_S:-20}"
KEEPALIVE_S="${CLEANCORE_SUITE_KEEPALIVE_S:-300}"  # < the 10-minute stuck threshold, with margin
# THE ANCHOR IS THE WHOLE MECHANISM (card 5af57bd7, Cybered NO-GO). This defaulted to
# `$HERE/.cleancore-suite-slot` -- the script's OWN directory -- and every agent runs its own
# marveen worktree copy, each with a real `store/` (measured: distinct inodes). So the cap was 2 PER
# CHECKOUT: 16 checkouts x 2 = up to 32 concurrent suites, which is the state this script exists to
# prevent. Measured A/B, same script and same moment, differing only in this path: shared prefix ->
# the second run correctly queues; per-checkout prefix -> it sails straight through.
#
# A mutual-exclusion default must name something the participants SHARE. `MARVEEN_MAIN` is the
# fleet's existing anchor for exactly this (marveen-land.sh, agent-worktree-marveen.sh).
#
# NOTED, because the next reader will wonder: the contention is CPU contention, so a MACHINE-scoped
# path (/var/lock, /tmp) is arguably the more honest anchor -- two marveen installs on one box would
# each get their own 2 slots and over-subscribe the same cores. That is not a configuration we have,
# and following the fleet's one anchor convention beats inventing a second one for a case that does
# not exist. If a second install ever appears, this is the line to change.
MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
LOCK_PREFIX="${CLEANCORE_SUITE_LOCK_PREFIX:-$MAIN/store/.cleancore-suite-slot}"
API="${CLEANCORE_SUITE_API:-http://localhost:3420}"

usage() { echo "usage: cleancore-suite-run.sh <agent> [-- <vitest args>]" >&2; exit 2; }

# A LOCK DIRECTORY WE CANNOT WRITE MUST SAY SO. Without this, acquire() simply fails to create each
# slot file, returns "no slot", and the run queues for the full two hours before giving up -- an
# unreachable semaphore would be indistinguishable from a genuinely busy one. That is the same class
# of defect as the anchor bug above: a control that cannot bind must never look like a control that
# is merely busy.
LOCK_DIR="$(dirname "$LOCK_PREFIX")"
if [ ! -d "$LOCK_DIR" ] || [ ! -w "$LOCK_DIR" ]; then
  echo "cleancore-suite-run: lock directory '$LOCK_DIR' is missing or not writable -- refusing to run rather than silently queueing. Set MARVEEN_MAIN, or CLEANCORE_SUITE_LOCK_PREFIX." >&2
  exit 2
fi
AGENT="${1:-}"; [ -n "$AGENT" ] || usage
shift || true
[ "${1:-}" = "--" ] && shift || true

# --- kanban comment, best-effort ---------------------------------------------------------------
# NEVER fails the run. A suite must not depend on the dashboard being up; the comment is a courtesy
# to the stuck-monitor and to whoever is reading the board, not a precondition for testing.
_token_file() {
  [ -f "$HERE/.dashboard-token" ] && { echo "$HERE/.dashboard-token"; return; }
  local common; common="$(git -C "$HERE" rev-parse --git-common-dir 2>/dev/null)" || return 1
  echo "$(cd "$(dirname "$common")" && pwd)/store/.dashboard-token"
}

# SECURITY (Cybersec/gate-ops-scripts-token-in-argv, card edb7559f): the token never goes in argv.
# `-H "Authorization: Bearer $(cat ...)"` is readable from /proc/<pid>/cmdline by any local process
# for as long as the curl runs. A 0600 header file, removed on EXIT, is the house pattern
# (offload-dispatch.sh, weekly-usage-panel-read.sh). Caught here by token-in-argv-guard.test.ts on
# this script's first full-suite run -- the guard names the fix and the files to copy it from.
_hdr_file=""
_hdr() { # echoes a 0600 header file path, or returns 1
  [ -n "$_hdr_file" ] && { echo "$_hdr_file"; return 0; }
  local tf; tf="$(_token_file)" || return 1
  [ -f "$tf" ] || return 1
  _hdr_file="$(mktemp)" || return 1
  chmod 600 "$_hdr_file"
  printf 'Authorization: Bearer %s\n' "$(cat "$tf")" > "$_hdr_file"
  echo "$_hdr_file"
}
trap 'rm -f "$_hdr_file"' EXIT

_card_id() { # the agent's current in_progress card, or empty
  local h; h="$(_hdr)" || return 0
  curl -s --max-time 10 -H @"$h" "$API/api/kanban" 2>/dev/null \
    | python3 -c '
import json,sys
try: rows = json.load(sys.stdin)
except Exception: sys.exit(0)
for r in rows if isinstance(rows, list) else []:
    if r.get("status") == "in_progress" and r.get("assignee") == sys.argv[1]:
        print(r.get("id","")); break
' "$AGENT" 2>/dev/null
}

_comment() { # $1 = body
  local card h; card="$(_card_id)"; [ -n "$card" ] || return 0
  h="$(_hdr)" || return 0
  local payload; payload="$(python3 -c '
import json,sys; print(json.dumps({"card_id":sys.argv[1],"author":sys.argv[2],"content":sys.argv[3]}))' \
    "$card" "$AGENT" "$1")" || return 0
  curl -s --max-time 10 -o /dev/null -H @"$h" \
    -X POST "$API/api/kanban/$card/comments" -H 'Content-Type: application/json' \
    --data-binary "$payload" 2>/dev/null || true
}

# --- acquire one of SLOTS ----------------------------------------------------------------------
acquire() { # sets FD and SLOT on success
  # THE REDIRECTION IS SPLIT IN TWO ON PURPOSE. The obvious spelling,
  # `exec {FD}>"$f" 2>/dev/null || continue`, is a trap: `exec` with redirections and NO command
  # applies them to the SHELL ITSELF and they persist, so that 2>/dev/null silently swallowed every
  # later `echo >&2` in this script -- the queueing notice, the give-up reason, the worktree error.
  # Found by this script's own selftest, which saw exit 3 with completely empty output.
  # So: create/probe the file with an ORDINARY command first (its redirection is scoped to that
  # command), and let the `exec` run bare.
  local i f
  for ((i = 1; i <= SLOTS; i++)); do
    f="${LOCK_PREFIX}-${i}.lock"
    : >>"$f" 2>/dev/null || continue
    exec {FD}>>"$f" || continue
    if flock -n "$FD"; then SLOT="$i"; return 0; fi
    exec {FD}>&-
  done
  return 1
}

started="$(date +%s)"; waited=0; announced=0; last_note="$started"
while ! acquire; do
  now="$(date +%s)"; waited=$((now - started))
  if [ "$waited" -ge "$WAIT_MAX_S" ]; then
    echo "cleancore-suite-run: no slot after $((waited / 60)) min (${SLOTS} in use). Another run is stuck, or raise CLEANCORE_SUITE_SLOTS." >&2
    [ "$announced" -eq 1 ] && _comment "INFO-ONLY RESUMED-SEMAPHORE (GIVING UP)

Nem kaptam suite-slotot ${WAIT_MAX_S} masodperc alatt (${SLOTS} egyideju futas a felso korlat). Nem futtattam le a suite-ot -- ez NEM teszt-eredmeny."
    exit 3
  fi
  if [ "$announced" -eq 0 ]; then
    announced=1
    echo "cleancore-suite-run: all ${SLOTS} slots busy -- queueing (cap ${WAIT_MAX_S}s)" >&2
    _comment "INFO-ONLY PAUSED-SEMAPHORE

A teljes CleanCore suite SORBAN ALL, nem ragadt be: mind a ${SLOTS} egyideju futas-slot foglalt (kartya 5af57bd7). Amint felszabadul egy, indul, es RESUMED-SEMAPHORE kommentet kap.

Ez a komment azert van itt, hogy az updated_at mozogjon: a 3. szabaly szerint egy 10 perce nem mozdulo in_progress kartya beragadtnak szamit, a 3a. szerint 60 perc utan testverre szall. Egy nema varakozas pont azt valtana ki, amit a szemafor elkerulni hivatott."
  elif [ $((now - last_note)) -ge "$KEEPALIVE_S" ]; then
    last_note="$now"
    _comment "INFO-ONLY PAUSED-SEMAPHORE (meg mindig sorban, $((waited / 60)) perce)"
  fi
  sleep "$POLL_S"
done

if [ "$announced" -eq 1 ]; then
  _comment "INFO-ONLY RESUMED-SEMAPHORE

Kaptam suite-slotot $(( ( $(date +%s) - started ) / 60 )) perc varakozas utan (slot ${SLOT}/${SLOTS}), a teljes suite most indul."
fi

WT="$(bash "$HERE/agent-worktree.sh" "$AGENT" --path 2>/dev/null)"
if [ -z "$WT" ] || [ ! -d "$WT" ]; then
  echo "cleancore-suite-run: no CleanCore worktree for '$AGENT' (agent-worktree.sh --path gave nothing)" >&2
  exit 3
fi

echo "cleancore-suite-run: slot ${SLOT}/${SLOTS}, running in $WT" >&2
cd "$WT" || exit 3
./node_modules/.bin/vitest run "$@"

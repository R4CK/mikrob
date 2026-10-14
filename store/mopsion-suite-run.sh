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
# A SECOND, MORE DANGEROUS SHAPE FROM THE SAME ROOT (card 149f2200, Cybersec). The birpc timeout
# above fails LOUD -- exit 1, zero test failures, easy to recognise as an anomaly. Under the same
# CPU starvation, an individual I/O-bound test (one that walks the whole repo tree, say) can instead
# blow vitest's own PER-TEST default of 5000ms and show up as a REAL-LOOKING "1 failed" -- not an
# exit-code anomaly, an actual assertion-shaped failure a gate can plausibly send back to in_progress
# as a regression. Measured (card 617d6234, already fixed there):
# apps/api/src/e2e-project-membership.test.ts's tree-scan case took 10281ms cold / 1368ms warm on
# the SAME tree, past the 5000ms default; the fix was an explicit `testTimeout` on that one case
# (30000ms), not a change to this script. If a gate sees a lone I/O-bound test (tree-scan,
# large-file-read) fail on wall-clock alone with everything else green: rerun it warm/isolated
# before treating it as a regression -- if it is genuinely I/O-bound and slow under load, ITS OWN
# test needs the explicit testTimeout, which is the fix, not a change here.
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
#   store/mopsion-suite-run.sh <agent> [-- <extra vitest args>]
#   CLEANCORE_SUITE_SLOTS=3 store/mopsion-suite-run.sh backend3
#
# WATCHING A BACKGROUND RUN: WRITE TO A FILE, NEVER `| tail -N` (card 57f4f5f1). A run takes
# 60-90 minutes, so any caller watching it in the background pipes it somewhere -- and `| tail -45`
# is the wrong shape: the pipe buffers everything while the run is alive, and if the pipe breaks
# (the reader is stopped, the pane closes) the writer sees SIGPIPE and the run exits 141/144 with an
# EMPTY tail -- indistinguishable from a suite that failed instantly, when what actually happened is
# that nobody was watching any more. Redirect to a file and read the file instead:
#   store/mopsion-suite-run.sh <agent> > "$SP/suite.log" 2>&1; echo "SUITE_EXIT=$?" >> "$SP/suite.log"
# A file survives the reader going away; `tail -f`/`grep` on it later sees everything, live or dead.
#
# Env:
#   MARVEEN_MAIN                 default /home/neon/marveen -- the SHARED anchor the slot files live
#                                under. This is what makes the cap fleet-wide instead of per-checkout
#                                (see LOCK_PREFIX below); pointing it somewhere private is how the
#                                selftest contends without touching the real fleet's slots.
#   CLEANCORE_SUITE_LOCK_PREFIX  overrides the slot path outright. Overriding it per checkout
#                                REMOVES the mutual exclusion -- that is the bug this default fixes.
#   CLEANCORE_SUITE_SLOTS        default 2
#   CLEANCORE_SUITE_MAX_WORKERS  overrides the vitest --maxWorkers default (nproc / SLOTS, floor 1).
#                                Ignored if the caller already passed --maxWorkers after `--`.
#   CLEANCORE_SUITE_MIN_AVAIL_MB default 4096 -- MemAvailable a run needs before it may START, and
#                                (card e498502e) the floor it must stay above WHILE RUNNING. 0
#                                disables the memory check entirely, start and mid-run alike.
#   CLEANCORE_SUITE_MID_RUN_POLL_S default 45 -- how often (seconds) memory is re-checked while
#                                vitest is running, not just before it starts. Ignored if
#                                CLEANCORE_SUITE_MIN_AVAIL_MB=0.
#   CLEANCORE_SUITE_MID_RUN_TERM_GRACE_S default 10 -- seconds a mid-run stop waits after SIGTERM
#                                before escalating to SIGKILL. For the selftest; production suites
#                                should not need to change this.
#   CLEANCORE_SUITE_MEMINFO      /proc/meminfo override, for the selftest only.
#   CLEANCORE_SUITE_ALLOW_NO_CARD (card c0408a1c) set to 1 to skip the live-mopsion-card
#                                precondition below and take a slot anyway. Logged to stderr
#                                whenever used -- this is an explicit, auditable override, not a
#                                silent bypass.
#   CLEANCORE_SUITE_MARVEEN_WORKTREES_DIR (card c0408a1c, D1) overrides the marveen-worktrees
#                                path the cwd/argument check (below) refuses against, for the
#                                selftest only. Default /home/neon/marveen-agent-worktrees.
#
# Exit: the suite's own exit code | 2 usage, an unusable lock directory, OR (card c0408a1c, D1) the
#       caller's cwd or a vitest argument names a marveen-repo file -- use fleet-test.sh instead |
#       3 no slot within the
#       cap, OR (card c0408a1c) the calling agent has no in_progress/gated-waiting mopsion card
#       right now and CLEANCORE_SUITE_ALLOW_NO_CARD was not set | 4 memory pressure arrived WHILE
#       running and the suite was stopped in a controlled way (card e498502e) -- this is NOT a test
#       result, pass or fail
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SLOTS="${CLEANCORE_SUITE_SLOTS:-2}"
WAIT_MAX_S="${CLEANCORE_SUITE_WAIT_MAX_S:-7200}"   # 2h: two 60-90min runs can legitimately be ahead
POLL_S="${CLEANCORE_SUITE_POLL_S:-20}"
KEEPALIVE_S="${CLEANCORE_SUITE_KEEPALIVE_S:-300}"  # < the 10-minute stuck threshold, with margin

# THE SLOT CAP DOES NOT BOUND MEMORY EITHER (card 7e7ac40c, backend3's OOM finding 2026-09-10). A
# full suite was killed BEFORE IT STARTED with 474 MB available of 24032 MB, and an OOM kill looks
# exactly like the false red this whole script exists to prevent.
#
# WHAT I MEASURED, because the card's own root-cause numbers did not survive checking. Card text
# said ~2.6-3.2 GB PER WORKER, so ~17 GB per run and ~35 GB for two -- which would mean SLOTS=2 is
# structurally impossible on a 24 GB box. Sampled at 5s over one full suite run (909 files, 19308
# tests, 62 min, solo on the semaphore, 806 samples):
#     peak RSS of ALL vitest processes together ... 3153 MB (31 processes)
#     peak RSS of the largest single worker ....... 379 MB
#     lowest MemAvailable during the run .......... 11052 MB
# So a run costs ~3.2 GB, not ~17 GB, and two concurrent runs (~6.3 GB) fit with room to spare.
# The 15 largest processes on the box during that run contained NO vitest process above 379 MB;
# the memory was held by ollama (1557 MB), another agent's eslint (1548 MB) and twelve Claude
# sessions at 310-540 MB each.
#
# THAT CHANGES WHICH FIX IS RIGHT. The pressure comes from OUTSIDE the suite, so capping slots or
# workers -- the card's other two candidate fixes -- would not have prevented that OOM. What
# prevents it is refusing to START a ~3.2 GB job into a box that has no room for it, which is what
# this does. 4096 MB is the measured peak plus ~30%: enough that a future, larger suite still fits,
# low enough that it only fires when the box is genuinely full (it would have blocked at 474 MB).
#
# MemAvailable, NOT MemFree. Measured on this box in one instant: MemFree 1807 MB, MemAvailable
# 15221 MB -- the difference is 14.7 GB of reclaimable page cache. A MemFree guard would refuse
# nearly every run that fits comfortably.
#
# NOT WIRED TO scripts/fleet-memory-gate.sh, which already exists and reads the same field. It
# answers a different question (may an AGENT START, in percentage bands: 80% warn / 90% hard), and
# a band cannot express "this particular job needs N GB" -- on 24 GB the 80% band still leaves
# 4.8 GB, fine for this run and hopeless for a larger one. It also manages a safe-mode flag and
# sends Telegram alerts as a side effect of answering, which is wrong per suite start. Decisive:
# fork-upstream records it as "adopt upstream wholesale -- no fork-specific logic in this file", so
# every upstream merge replaces it, and a fork script parsing its output would break silently.
MEMINFO="${CLEANCORE_SUITE_MEMINFO:-/proc/meminfo}"
MIN_AVAIL_MB="${CLEANCORE_SUITE_MIN_AVAIL_MB:-4096}"
MID_RUN_POLL_S="${CLEANCORE_SUITE_MID_RUN_POLL_S:-45}"
MID_RUN_TERM_GRACE_S="${CLEANCORE_SUITE_MID_RUN_TERM_GRACE_S:-10}"
# A sentinel run_vitest() returns instead of vitest's own exit code, when the mid-run memory watch
# (below) had to stop the suite itself. 99 is outside vitest's own range (0 pass, 1 fail, 130/143
# on a signal) so it cannot be mistaken for a real result.
MID_RUN_OOM_STATUS=99
MID_RUN_OOM_DETAIL=""

# MemAvailable in MB, or a non-zero return when this box cannot answer.
mem_available_mb() {
  local kb
  kb="$(awk '/^MemAvailable:/ { print $2; exit }' "$MEMINFO" 2>/dev/null)" || return 1
  case "$kb" in ''|*[!0-9]*) return 1 ;; esac
  echo $((kb / 1024))
}
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

usage() { echo "usage: mopsion-suite-run.sh [--worktree <path>] <agent> [-- <vitest args>]" >&2; exit 2; }

# A LOCK DIRECTORY WE CANNOT WRITE MUST SAY SO. Without this, acquire() simply fails to create each
# slot file, returns "no slot", and the run queues for the full two hours before giving up -- an
# unreachable semaphore would be indistinguishable from a genuinely busy one. That is the same class
# of defect as the anchor bug above: a control that cannot bind must never look like a control that
# is merely busy.
LOCK_DIR="$(dirname "$LOCK_PREFIX")"
if [ ! -d "$LOCK_DIR" ] || [ ! -w "$LOCK_DIR" ]; then
  echo "mopsion-suite-run: lock directory '$LOCK_DIR' is missing or not writable -- refusing to run rather than silently queueing. Set MARVEEN_MAIN, or CLEANCORE_SUITE_LOCK_PREFIX." >&2
  exit 2
fi
# --worktree <path> (card 08eb6402): a caller that already checked out a SPECIFIC commit (not an
# agent's own branch tip) points this here instead of resolving via agent-worktree.sh -- the
# two-phase prepare/suite/land design needs to suite-test an exact prepared merge commit, which is
# never any agent's own worktree HEAD. <agent> is still required, purely as the label the evidence
# record and the best-effort kanban comment attribute the run to.
WORKTREE_OVERRIDE=""
if [ "${1:-}" = "--worktree" ]; then
  shift
  WORKTREE_OVERRIDE="${1:-}"
  [ -n "$WORKTREE_OVERRIDE" ] || usage
  shift
fi
AGENT="${1:-}"; [ -n "$AGENT" ] || usage
shift || true
[ "${1:-}" = "--" ] && shift || true

# --- D1: refuse a marveen test run outright (card c0408a1c, MikroB 18681, 2nd acceptance criterion
# of comment 17448) --------------------------------------------------------------------------
# Measured 2026-10-12/13: qa2 and backend2 ran a MARVEEN file (src/__tests__/gemini-offload-dispatch
# .test.ts) through this script, and backend3's cwd was a marveen worktree -- four agents, six runs
# in one day, all of them meant for marveen's own fleet-test.sh instead. This check runs before
# anything else below (even before the live-mopsion-card precondition, and NOT skippable by
# CLEANCORE_SUITE_ALLOW_NO_CARD -- that override is for "no live mopsion card", a different
# precondition; a marveen test never belongs in this script's lock regardless of override).
MARVEEN_MAIN_DIR="${MARVEEN_MAIN:-/home/neon/marveen}"
MARVEEN_WORKTREES_DIR="${CLEANCORE_SUITE_MARVEEN_WORKTREES_DIR:-/home/neon/marveen-agent-worktrees}"
CALLER_PWD="$(pwd -P)"
# The cwd half is skipped for --worktree callers: that flag already names an explicit, pinned
# mopsion worktree for a specific prepared commit (card 08eb6402's prepare/suite/land design,
# e.g. mopsion-preland.sh) -- the caller's own shell cwd is irrelevant there, and was never the
# failure mode (qa2/backend2 called this script directly, with no --worktree).
if [ -z "$WORKTREE_OVERRIDE" ]; then
  case "$CALLER_PWD" in
    "$MARVEEN_MAIN_DIR"|"$MARVEEN_MAIN_DIR"/*|"$MARVEEN_WORKTREES_DIR"|"$MARVEEN_WORKTREES_DIR"/*)
      echo "mopsion-suite-run: REFUSED -- the caller's cwd ('$CALLER_PWD') is a marveen checkout, not a mopsion worktree. Use 'bash store/fleet-test.sh --ref <sha> <fajl>' for marveen tests instead (card c0408a1c)." >&2
      exit 2
      ;;
  esac
fi
for _d1_arg in ${1+"$@"}; do
  case "$_d1_arg" in
    -*) continue ;;  # a flag (e.g. --maxWorkers=4) is never a file path
  esac
  case "$_d1_arg" in
    /*) _d1_path="$_d1_arg" ;;
    *) _d1_path="$CALLER_PWD/$_d1_arg" ;;
  esac
  case "$_d1_path" in
    "$MARVEEN_MAIN_DIR"/*|"$MARVEEN_WORKTREES_DIR"/*)
      if [ -e "$_d1_path" ]; then
        echo "mopsion-suite-run: REFUSED -- vitest argument '$_d1_arg' names a marveen-repo file, not a mopsion one. Use 'bash store/fleet-test.sh --ref <sha> $_d1_arg' for marveen tests instead (card c0408a1c)." >&2
        exit 2
      fi
      ;;
  esac
done
unset _d1_arg _d1_path

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
#
# M1 (card c0408a1c, RedHat NO-GO 18680): _hdr() used to be called as `h="$(_hdr)"` at every call
# site, inside functions (_card_id, _comment, _has_live_mopsion_card) that are themselves invoked
# via command substitution by THEIR callers. MEASURED (a tiny isolated repro, not a guess): a bash
# EXIT trap set in the main script never fires when a `$(...)` subshell forked from it terminates --
# only the real top-level process exit runs it. So a mktemp created anywhere inside such a subshell
# is simply never cleaned up; moving the `mktemp` call to a non-command-substitution call site (an
# earlier attempt here) does not help, because the ENCLOSING function call is still inside a
# subshell either way. Measured before the fix: 27 leftover 0600 Authorization-bearing files in
# TMPDIR after 25 precondition checks, none of them cleaned up.
# FIX: create the header file ONCE, here, eagerly, in the MAIN script process -- before any
# subshell that could hide the mktemp from the real EXIT trap ever forks. Every later `_hdr` call
# (even from deep inside a `$(_card_id)`/`$(_has_live_mopsion_card)` subshell) then just sees
# `_hdr_file` already non-empty -- forked subshells inherit the parent's variable VALUES at fork
# time, so this is a read, not a new mktemp -- and the file is removed exactly once, by the main
# process's own EXIT trap (this one, or the `_kill_orphaned_vitest` one further down which also
# does `rm -f "$_hdr_file"`), when the real process actually exits.
_hdr_file=""
_hdr() { # sets global _hdr_file to a 0600 header file path; returns 1 if unavailable
  [ -n "$_hdr_file" ] && return 0
  local tf; tf="$(_token_file)" || return 1
  [ -f "$tf" ] || return 1
  _hdr_file="$(mktemp)" || return 1
  chmod 600 "$_hdr_file"
  printf 'Authorization: Bearer %s\n' "$(cat "$tf")" > "$_hdr_file"
  return 0
}
trap 'rm -f "$_hdr_file"' EXIT
_hdr || true  # eager, in THIS (main) process -- see the comment above

_card_id() { # the agent's current in_progress card, or empty
  _hdr || return 0
  local h="$_hdr_file"
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
  local card; card="$(_card_id)"; [ -n "$card" ] || return 0
  _hdr || return 0
  local h="$_hdr_file"
  local payload; payload="$(python3 -c '
import json,sys; print(json.dumps({"card_id":sys.argv[1],"author":sys.argv[2],"content":sys.argv[3]}))' \
    "$card" "$AGENT" "$1")" || return 0
  curl -s --max-time 10 -o /dev/null -H @"$h" \
    -X POST "$API/api/kanban/$card/comments" -H 'Content-Type: application/json' \
    --data-binary "$payload" 2>/dev/null || true
}

# --- live-mopsion-card precondition (card c0408a1c) -------------------------------------------
# A full suite run is useless CPU when mopsion itself is stopped and the calling agent has no live
# card to justify running it anyway. Measured 2026-10-12: two full runs (40-50 min each) held BOTH
# shared slots while mopsion was in Peti's stop and no mopsion card was in_progress anywhere,
# blocking 5 marveen landings/gates behind this script's own semaphore.
#
# Checked BEFORE acquire(): a slot is already spent the moment a run starts WAITING on it (that is
# what blocked the 5 landings above), so this belongs ahead of the wait loop, not after.
#
# WHAT COUNTS, per the requirement: an in_progress card assigned to AGENT, OR a waiting card AGENT
# is gating (has commented on it) -- either way tagged project="mopsion" (the one semi-reliable
# mopsion/marveen signal this fleet has -- see self-advance-pickup.sh's own measurement) and NOT
# itself tagged BLOKKOLT-Peti-stop in the title (that tag IS the stop; a card carrying it cannot
# justify running during it).
#
# Prints the matching card id and returns 0 when found; returns 1 when the dashboard answered but
# named no such card (a real "no"); returns 2 when the dashboard could not be reached or parsed (an
# "unknown", not a "no" -- the caller below decides how to treat that, same fail-open stance as the
# memory precondition and the comment helpers above: a dashboard hiccup must not block every suite
# run fleet-wide).
_has_live_mopsion_card() {
  _hdr || return 2
  local h="$_hdr_file"
  local body
  body="$(curl -s --max-time 10 -H @"$h" "$API/api/kanban" 2>/dev/null)" || return 2

  local hit
  hit="$(python3 -c '
import json, sys
try:
    rows = json.loads(sys.argv[2])
except Exception:
    sys.exit(2)
if not isinstance(rows, list):
    sys.exit(2)
agent = sys.argv[1]
for r in rows:
    if not isinstance(r, dict):
        continue
    if (r.get("project") or "").strip().casefold() != "mopsion":
        continue
    if "blokkolt-peti-stop" in (r.get("title") or "").casefold():
        continue
    if r.get("status") == "in_progress" and r.get("assignee") == agent:
        print(r.get("id", ""))
        sys.exit(0)
sys.exit(1)
' "$AGENT" "$body")"
  local rc=$?
  if [ "$rc" -eq 0 ]; then echo "$hit"; return 0; fi
  [ "$rc" -eq 2 ] && return 2

  # No in_progress card of ours -- look for a waiting mopsion card we are actively GATING (a
  # comment from us on it), the "altala gate-elt waiting" half of the requirement.
  #
  # D2 (card c0408a1c, MikroB 18681): a GATE AGENT's first run on a card has, by definition, no
  # comment of its own yet -- it tests the suite BEFORE posting a verdict. Requiring "already
  # commented" would refuse exactly the run the gate needs to produce that verdict. So a gate agent
  # (qa/qa2/cybersec/cybersec2/cybered) is accepted on any non-stop-tagged waiting mopsion card that
  # already carries a builder's REVIEW comment, even without a comment of its own. A BUILDER agent
  # keeps the original rule unchanged: its own in_progress card, or a waiting card it has itself
  # commented on.
  local waiting_ids
  waiting_ids="$(python3 -c '
import json, sys
try:
    rows = json.loads(sys.argv[1])
except Exception:
    sys.exit(2)
if not isinstance(rows, list):
    sys.exit(2)
for r in rows:
    if not isinstance(r, dict):
        continue
    if (r.get("project") or "").strip().casefold() != "mopsion":
        continue
    if "blokkolt-peti-stop" in (r.get("title") or "").casefold():
        continue
    if r.get("status") == "waiting":
        print(r.get("id", ""))
' "$body")"
  [ $? -eq 2 ] && return 2

  local is_gate=0
  case " qa qa2 cybersec cybersec2 cybered " in
    *" $AGENT "*) is_gate=1 ;;
  esac

  local cid comments_body
  while IFS= read -r cid; do
    [ -n "$cid" ] || continue
    comments_body="$(curl -s --max-time 10 -H @"$h" "$API/api/kanban/$cid/comments" 2>/dev/null)" || continue
    if python3 -c '
import json, sys
try:
    rows = json.loads(sys.argv[3])
except Exception:
    sys.exit(1)
if not isinstance(rows, list):
    sys.exit(1)
agent, is_gate = sys.argv[1], sys.argv[2] == "1"
for r in rows:
    if not isinstance(r, dict):
        continue
    if r.get("author") == agent:
        sys.exit(0)
    if is_gate and (r.get("content") or "").lstrip().upper().startswith("REVIEW"):
        sys.exit(0)
sys.exit(1)
' "$AGENT" "$is_gate" "$comments_body"; then
      echo "$cid"; return 0
    fi
  done <<<"$waiting_ids"
  return 1
}

# Markers (NO-CARD-REFUSED / NO-CARD-OVERRIDE-USED / NO-CARD-CHECK-UNKNOWN) are deliberately
# grep-able, the same convention as PAUSED-SEMAPHORE/RESUMED-SEMAPHORE above: this script keeps no
# log file of its own (the usage note above has every caller redirect stderr to one), so a stable
# word is what lets a reader -- or card-build-route-24h-measure.sh's family of measurement scripts
# -- COUNT refusals across whatever log captured them, which is the card's own second requirement.
NO_CARD_OVERRIDE="${CLEANCORE_SUITE_ALLOW_NO_CARD:-0}"
if [ "$NO_CARD_OVERRIDE" = "1" ]; then
  echo "mopsion-suite-run: NO-CARD-OVERRIDE-USED -- CLEANCORE_SUITE_ALLOW_NO_CARD=1, skipping the live-mopsion-card check (card c0408a1c)" >&2
else
  live_card_id="$(_has_live_mopsion_card)"; live_card_rc=$?
  case "$live_card_rc" in
    0) : ;;  # a live card justifies this run -- the routine case stays quiet, same rule as the slot wait below
    1)
      echo "mopsion-suite-run: NO-CARD-REFUSED -- '$AGENT' has no in_progress or gated-waiting mopsion card right now, refusing to take a CPU slot for it (card c0408a1c). Set CLEANCORE_SUITE_ALLOW_NO_CARD=1 if this is deliberate." >&2
      exit 3
      ;;
    *)
      echo "mopsion-suite-run: NO-CARD-CHECK-UNKNOWN -- could not check for a live mopsion card (dashboard unreachable or unparsable), starting WITHOUT the card precondition (card c0408a1c)." >&2
      ;;
  esac
fi

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

# WHY THE MEMORY CHECK COMES BEFORE acquire() AND NOT AFTER. A run that is waiting for memory must
# not be holding a slot while it waits -- that would block a peer who DOES have room, turning a
# memory shortage into a slot shortage. So: decide on memory first, take the slot only when the run
# can actually proceed.
#
# NO RESERVATION BOOKKEEPING, deliberately, and this follows from the measurement rather than from
# taste. The race it would protect against is two runs both seeing free memory and then both ramping
# into it. At ~3.2 GB per run that is ~6.3 GB against a floor of 4096 MB free -- it fits, so the
# machinery would be complexity guarding a case that cannot occur here. If a future suite ever grows
# past roughly a third of MemAvailable, this is the assumption that breaks, and the fix is to record
# each run's footprint in its own slot file (the flock state already makes such a record
# self-cleaning: an unheld slot's content is simply not counted).
#
# FAIL OPEN, LOUDLY, when the box cannot answer. A guard that refuses every run on an unreadable
# /proc/meminfo would stop every gate on the machine -- strictly worse than the OOM it prevents,
# which is at least noisy. This matches what fleet-memory-gate.sh does with the same field.
WAIT_REASON=""; WAIT_DETAIL=""; MEM_WARNED=0
try_start() {
  local avail
  if [ "$MIN_AVAIL_MB" -gt 0 ]; then
    if avail="$(mem_available_mb)"; then
      if [ "$avail" -lt "$MIN_AVAIL_MB" ]; then
        WAIT_REASON="memory"
        WAIT_DETAIL="${avail}MB available, ${MIN_AVAIL_MB}MB needed"
        return 1
      fi
    elif [ "$MEM_WARNED" -eq 0 ]; then
      MEM_WARNED=1
      echo "mopsion-suite-run: cannot read MemAvailable from '$MEMINFO' -- starting WITHOUT the memory precondition (card 7e7ac40c). An OOM kill here would look like a test failure." >&2
    fi
  fi
  acquire && return 0
  WAIT_REASON="slot"; WAIT_DETAIL="all ${SLOTS} slots in use"
  return 1
}

started="$(date +%s)"; waited=0; announced=0; last_note="$started"
while ! try_start; do
  now="$(date +%s)"; waited=$((now - started))
  if [ "$waited" -ge "$WAIT_MAX_S" ]; then
    # THE GIVE-UP MESSAGE NAMES THE ACTUAL REASON. It used to say "no slot ... raise
    # CLEANCORE_SUITE_SLOTS" unconditionally, which is the wrong diagnosis and the wrong remedy for
    # a run that was queueing on memory -- raising the slot cap would make that case worse.
    if [ "$WAIT_REASON" = "memory" ]; then
      echo "mopsion-suite-run: not enough memory after $((waited / 60)) min ($WAIT_DETAIL). Something else on this box is holding it -- this is NOT a test result. Lower CLEANCORE_SUITE_MIN_AVAIL_MB only if you know the run fits." >&2
    else
      echo "mopsion-suite-run: no slot after $((waited / 60)) min (${SLOTS} in use). Another run is stuck, or raise CLEANCORE_SUITE_SLOTS." >&2
    fi
    [ "$announced" -eq 1 ] && _comment "INFO-ONLY RESUMED-SEMAPHORE (GIVING UP)

Nem indult el a suite ${WAIT_MAX_S} masodperc alatt. Ok: ${WAIT_REASON} (${WAIT_DETAIL}). Nem futtattam le a suite-ot -- ez NEM teszt-eredmeny."
    exit 3
  fi
  if [ "$announced" -eq 0 ]; then
    announced=1
    if [ "$WAIT_REASON" = "memory" ]; then
      echo "mopsion-suite-run: not enough free memory -- queueing ($WAIT_DETAIL, cap ${WAIT_MAX_S}s)" >&2
    else
      echo "mopsion-suite-run: all ${SLOTS} slots busy -- queueing (cap ${WAIT_MAX_S}s)" >&2
    fi
    _comment "INFO-ONLY PAUSED-SEMAPHORE

A teljes CleanCore suite SORBAN ALL, nem ragadt be. Ok: ${WAIT_REASON} (${WAIT_DETAIL}) -- vagy mind a ${SLOTS} egyideju futas-slot foglalt (kartya 5af57bd7), vagy nincs eleg szabad memoria az inditashoz (kartya 7e7ac40c). Amint megszunik, indul, es RESUMED-SEMAPHORE kommentet kap.

Ez a komment azert van itt, hogy az updated_at mozogjon: a 3. szabaly szerint egy 10 perce nem mozdulo in_progress kartya beragadtnak szamit, a 3a. szerint 60 perc utan testverre szall. Egy nema varakozas pont azt valtana ki, amit a szemafor elkerulni hivatott."
  elif [ $((now - last_note)) -ge "$KEEPALIVE_S" ]; then
    last_note="$now"
    _comment "INFO-ONLY PAUSED-SEMAPHORE (meg mindig sorban, $((waited / 60)) perce -- ok: ${WAIT_REASON}, ${WAIT_DETAIL})"
  fi
  sleep "$POLL_S"
done

if [ "$announced" -eq 1 ]; then
  _comment "INFO-ONLY RESUMED-SEMAPHORE

Kaptam suite-slotot $(( ( $(date +%s) - started ) / 60 )) perc varakozas utan (slot ${SLOT}/${SLOTS}), a teljes suite most indul."
fi

if [ -n "$WORKTREE_OVERRIDE" ]; then
  WT="$WORKTREE_OVERRIDE"
  if [ ! -d "$WT" ]; then
    echo "mopsion-suite-run: --worktree '$WT' does not exist" >&2
    exit 3
  fi
else
  WT="$(bash "$HERE/agent-worktree.sh" "$AGENT" --path 2>/dev/null)"
  if [ -z "$WT" ] || [ ! -d "$WT" ]; then
    echo "mopsion-suite-run: no CleanCore worktree for '$AGENT' (agent-worktree.sh --path gave nothing)" >&2
    exit 3
  fi
fi

# Card b846acf3 (Cybersec, measured on the b846acf3 finding itself): a suite-count without saying
# WHICH tree it measured is not evidence (rule 4d). The worktree's SOURCE is pinned by `cd "$WT"`
# below, but its node_modules links external (non-workspace) packages from $CLEANCORE_MAIN (see
# agent-worktree.sh), which moves independently -- any other agent can advance it mid-run. These two
# lines make that provenance explicit instead of silent; a mismatch is often harmless (most external
# deps do not change package.json exports mid-day) but must be VISIBLE, not just true. This does not
# block: a [SKEW] line is a fact for the reader of the log, not a verdict this script is qualified to
# make on its own.
CLEANCORE_MAIN_DIR="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/mopsion}"
# `git rev-parse HEAD` on an unborn branch (no commits yet) prints the literal string "HEAD" to
# STDOUT before failing -- `$(cmd || echo unknown)` would capture BOTH ("HEAD" then "unknown" on the
# next line) into one multi-line variable, since the fallback still shares the command substitution
# with the command it is meant to replace. The fallback must be OUTSIDE the substitution.
WT_SHA="$(git -C "$WT" rev-parse HEAD 2>/dev/null)" || WT_SHA="unknown"
[ -n "$WT_SHA" ] || WT_SHA="unknown"
MAIN_SHA="$(git -C "$CLEANCORE_MAIN_DIR" rev-parse HEAD 2>/dev/null)" || MAIN_SHA="unknown"
[ -n "$MAIN_SHA" ] || MAIN_SHA="unknown"
echo "mopsion-suite-run: slot ${SLOT}/${SLOTS}, running in $WT @ $WT_SHA" >&2
if [ "$WT_SHA" != "unknown" ] && [ "$MAIN_SHA" != "unknown" ] && [ "$WT_SHA" != "$MAIN_SHA" ]; then
  echo "mopsion-suite-run: node_modules -> $CLEANCORE_MAIN_DIR @ $MAIN_SHA   [SKEW]" >&2
else
  echo "mopsion-suite-run: node_modules -> $CLEANCORE_MAIN_DIR @ $MAIN_SHA" >&2
fi
cd "$WT" || exit 3

# THE SLOT CAP ALONE DOES NOT BOUND CPU (card 34587175, measured during a load-guard CRITICAL
# investigation). vitest defaults maxWorkers to the CPU count, so a SINGLE full suite run already
# claims every core -- 12 vitest processes on a 12-core box, load average 16-20. Two such runs
# under the SLOTS=2 cap then contend for the same 12 cores twice over, which is exactly the
# CPU-starved-main-process condition the header above describes causing the false-red RPC timeout.
# The slot semaphore bounds concurrent RUNS; this bounds concurrent WORKERS per run, so that SLOTS
# concurrent full runs together still fit within nproc instead of nproc*SLOTS.
#
# A caller-supplied --maxWorkers is never overridden: this is a default, not a policy the caller
# cannot opt out of, and a caller passing its own value has already made the CPU-budget decision.
CORES="$(nproc 2>/dev/null || echo 1)"
DEFAULT_MAX_WORKERS=$((CORES / SLOTS))
[ "$DEFAULT_MAX_WORKERS" -lt 1 ] && DEFAULT_MAX_WORKERS=1
MAX_WORKERS="${CLEANCORE_SUITE_MAX_WORKERS:-$DEFAULT_MAX_WORKERS}"

# Card d247e499 (QA measurement, msg 7237): `--dir <path>` forwarded straight to vitest's own CLI
# is a NO-OP here, measured in source -- the root vitest.config.ts defines `test.projects[]`, and
# each project's own `include` glob (e.g. 'packages/**/src/**/*.test.ts') already names paths from
# the repo root; vitest's `--dir` sets the search root for UNSCOPED collection, which a
# projects-array config does not use per project the way a flat config does. A caller passing
# `--dir apps/api` therefore still collects the WHOLE repo under every project -- the targeted,
# minutes-long measurement this flag exists for becomes the full 60-90 minute run instead, on a
# fully-claimed semaphore slot. A bare POSITIONAL path argument, by contrast, IS honoured per
# project (vitest filters collected files by substring match against each one) -- measured here:
# `vitest run apps/api/src/pg-pool.test.ts` collects exactly that file; `vitest run --dir
# apps/api/src` does not finish collecting in 15s (the whole-repo cost). So this script accepts
# `--dir <path>` / `--dir=<path>` as a caller convenience and REWRITES it to the equivalent bare
# positional before constructing vitest_args -- the caller's intent (narrow to this path) is
# honoured, just not via the flag that cannot do it in a projects-array config.
raw_args=()
translated_dir=0
skip_next=0
arglist=("$@")
idx=0
while [ "$idx" -lt "${#arglist[@]}" ]; do
  a="${arglist[$idx]}"
  if [ "$skip_next" -eq 1 ]; then
    skip_next=0
    idx=$((idx + 1))
    continue
  fi
  case "$a" in
    --dir=*)
      raw_args+=("${a#--dir=}")
      translated_dir=1
      ;;
    --dir)
      next_idx=$((idx + 1))
      if [ "$next_idx" -lt "${#arglist[@]}" ]; then
        raw_args+=("${arglist[$next_idx]}")
        skip_next=1
        translated_dir=1
      else
        echo "mopsion-suite-run: --dir given with no path argument after it -- ignoring, not forwarding a bare --dir to vitest" >&2
      fi
      ;;
    *)
      raw_args+=("$a")
      ;;
  esac
  idx=$((idx + 1))
done
if [ "$translated_dir" -eq 1 ]; then
  echo "mopsion-suite-run: --dir rewritten to a positional path filter (card d247e499: --dir alone does not narrow a projects-array vitest config)" >&2
fi
set -- "${raw_args[@]}"

vitest_args=("$@")
caller_set_max_workers=0
# CARD 08eb6402, CYBERSEC F1(b): evidence may ONLY be recorded for a run that covers the whole
# suite. --maxWorkers is the one flag this script itself may add and does not narrow what runs, so
# it is the one exception; ANY other caller-supplied argument (--shard=.., a bare file/dir path,
# -t/--testNamePattern, ...) means a partial run, and the evidence-record call below must be skipped
# -- a filtered run that happens to pass still proves nothing about the files it never touched.
caller_extra_args=0
for a in ${vitest_args[@]+"${vitest_args[@]}"}; do
  case "$a" in
    --maxWorkers|--maxWorkers=*) caller_set_max_workers=1 ;;
    *) caller_extra_args=1 ;;
  esac
done
[ "$caller_set_max_workers" -eq 0 ] && vitest_args=("--maxWorkers=$MAX_WORKERS" "${vitest_args[@]}")

# THE LOG IS CAPTURED so the run can be CLASSIFIED, not just returned (card c6153a69). A full suite
# that hits vitest's worker-RPC timeout exits 1 with ZERO failed tests, and the only evidence is one
# "Unhandled Error" paragraph a thousand lines above the summary. That has now cost three separate
# re-diagnoses on three separate cards, each ending in a hand-written REVIEW paragraph saying the
# same thing. `tee` keeps the live output exactly as before; PIPESTATUS keeps the real exit code.
run_log="$(mktemp)"
e2e_log="$(mktemp)"

# ORPHANED VITEST ON WRAPPER TERMINATION (card 57f4f5f1, backend's finding). setsid gives vitest its
# own session/process group precisely so mem_watch_and_wait can signal the whole tree with one `kill
# -TERM -- -$vpid` (see that function's header) -- but the SAME detachment means vitest does NOT die
# just because ITS PARENT (this script) does. Measured live: a stopped run stayed alive 25 minutes
# later, still spinning up workers, while the SLOTS flock it was holding had already been released
# (the flock lives on this script's own fd, which closes the instant this process exits) -- so a
# second and third run started on top of it. Exactly the CPU-starvation the semaphore exists to
# prevent (rule 17), from the one path the semaphore itself cannot see: its own abnormal exit.
#
# CURRENT_VITEST_PID is set the instant a vitest session starts and cleared the instant
# mem_watch_and_wait has reaped it (both in run_vitest, below) -- so at any moment this script might
# die, it names the exact live pid, or is empty because nothing is running. The EXIT trap fires for
# normal completion (empty by then, no-op) AND for termination by a signal bash's default disposition
# would otherwise just exit on (SIGTERM/SIGINT with no handler of their own) -- it cannot fire for
# SIGKILL, which no process can trap; that is a kernel-level limit, not a gap in this script.
#
# IDENTIFIED BY THE EXACT PID THIS SCRIPT ITSELF LAUNCHED, never a name-based `pkill vitest` -- this
# script only ever knows about, and only ever signals, the one process tree it started.
CURRENT_VITEST_PID=""
_kill_orphaned_vitest() {
  rm -f "$_hdr_file" "$run_log" "$e2e_log"
  [ -n "$CURRENT_VITEST_PID" ] || return 0
  kill -0 "$CURRENT_VITEST_PID" 2>/dev/null || return 0
  echo "mopsion-suite-run: exiting while vitest (pid $CURRENT_VITEST_PID) is still running -- killing its process group so it does not outlive this script (card 57f4f5f1)" >&2
  kill -TERM -- "-$CURRENT_VITEST_PID" 2>/dev/null || kill -TERM "$CURRENT_VITEST_PID" 2>/dev/null
  local waited=0
  while kill -0 "$CURRENT_VITEST_PID" 2>/dev/null && [ "$waited" -lt "$MID_RUN_TERM_GRACE_S" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -0 "$CURRENT_VITEST_PID" 2>/dev/null && {
    kill -KILL -- "-$CURRENT_VITEST_PID" 2>/dev/null || kill -KILL "$CURRENT_VITEST_PID" 2>/dev/null
  }
}
trap _kill_orphaned_vitest EXIT

# THE START-TIME PRECONDITION (try_start, above) ONLY LOOKS ONCE (card e498502e, backend's finding
# 2026-09-12). A full suite runs ~60-90 minutes; 249c6c6f started with ~13 GB free and was OOM-killed
# BY THE KERNEL partway through, with no summary and no record that this run's result is void. That
# is the exact false-red-by-a-different-name failure this whole script exists to prevent (see the
# file header) -- just arriving after the gate instead of before it.
#
# THE FIX WATCHES, IT DOES NOT PREVENT. Nothing here makes the suite use less memory; it makes an
# unavoidable shortage into a NAMED, CONTROLLED stop instead of a silent kernel kill: vitest runs in
# its own session (setsid) so the whole process TREE can be reached by one signal, a poller checks
# MemAvailable every MID_RUN_POLL_S while it runs, and on a breach it SIGTERMs the group, waits a
# few seconds for vitest to unwind, then SIGKILLs if it has not. The caller gets MID_RUN_OOM_STATUS
# back, never a fabricated pass or fail -- run_vitest's caller must treat that sentinel as "no result",
# not as one more exit code to interpret.
#
# WHY setsid AND NOT A PLAIN BACKGROUND JOB. This script itself is not run under a job-control shell
# (set -uo pipefail, no `set -m`), so `vitest run & vpid=$!` would NOT make vpid a process-group
# leader -- its child workers inherit THIS SCRIPT's process group, and `kill -TERM -- -$vpid` would
# either miss them or reach unrelated siblings. setsid makes vitest the leader of a fresh session and
# process group, so `-$vpid` is exactly the run's own tree, nothing else.
mem_watch_and_wait() { # $1 = vpid; sets MID_RUN_OOM_DETAIL; returns MID_RUN_OOM_STATUS or vitest's own exit
  local vpid="$1"
  MID_RUN_OOM_DETAIL=""
  if [ "$MIN_AVAIL_MB" -gt 0 ] && [ "$MID_RUN_POLL_S" -gt 0 ]; then
    # `kill -0` is TRUE for a zombie, not only a running process -- a plain "sleep, then kill -0"
    # poll would see vitest's own exit as "still alive" forever, because nothing ever reaps it
    # (bash only reaps a background job on an explicit `wait`, and this loop's own `wait` is the one
    # after the loop, which this bug would never reach). Fixed by racing the poll timer against
    # vpid itself with `wait -n`: whichever of the two it reaps is the one whose `kill -0` then
    # correctly reports gone, because reaping is what turns a zombie into "no such process".
    local avail sleep_pid
    while kill -0 "$vpid" 2>/dev/null; do
      sleep "$MID_RUN_POLL_S" &
      sleep_pid=$!
      wait -n "$vpid" "$sleep_pid" 2>/dev/null
      if ! kill -0 "$vpid" 2>/dev/null; then
        kill "$sleep_pid" 2>/dev/null; wait "$sleep_pid" 2>/dev/null
        break
      fi
      if avail="$(mem_available_mb)"; then
        if [ "$avail" -lt "$MIN_AVAIL_MB" ]; then
          MID_RUN_OOM_DETAIL="${avail}MB available, ${MIN_AVAIL_MB}MB needed, mid-run"
          echo "mopsion-suite-run: MID-RUN MEMORY PRESSURE ($MID_RUN_OOM_DETAIL) -- stopping the suite in a controlled way instead of letting the kernel OOM-kill it silently (card e498502e)" >&2
          kill -TERM -- "-$vpid" 2>/dev/null || kill -TERM "$vpid" 2>/dev/null
          local waited_term=0
          while kill -0 "$vpid" 2>/dev/null && [ "$waited_term" -lt "$MID_RUN_TERM_GRACE_S" ]; do sleep 1; waited_term=$((waited_term + 1)); done
          kill -0 "$vpid" 2>/dev/null && { kill -KILL -- "-$vpid" 2>/dev/null || kill -KILL "$vpid" 2>/dev/null; }
          wait "$vpid" 2>/dev/null
          return "$MID_RUN_OOM_STATUS"
        fi
      elif [ "$MEM_WARNED" -eq 0 ]; then
        MEM_WARNED=1
        echo "mopsion-suite-run: cannot read MemAvailable from '$MEMINFO' -- running WITHOUT the mid-run memory watch (card e498502e). An OOM kill here would look like a test failure." >&2
      fi
    done
  fi
  wait "$vpid" 2>/dev/null
}

# One vitest invocation, reported and classified. Returns vitest's real exit code, OR
# MID_RUN_OOM_STATUS when the mid-run memory watch had to stop it (no valid result either way).
run_vitest() {
  local log="$1"; shift
  setsid ./node_modules/.bin/vitest run "$@" >"$log" 2>&1 &
  local vpid=$!
  CURRENT_VITEST_PID="$vpid"
  tail -n +1 -f "$log" --pid="$vpid" 2>/dev/null &
  local tail_pid=$!
  mem_watch_and_wait "$vpid"
  local st=$?
  # By the time mem_watch_and_wait returns it has already reaped vpid (its own final `wait`, on
  # every path -- see that function). Clearing this NOW, not at the end of run_vitest, is what keeps
  # the EXIT trap's `kill -0 "$CURRENT_VITEST_PID"` from ever finding a REUSED pid: bash can recycle
  # a pid the instant it is reaped, and the flake-classify/skip-report calls below run real
  # subprocesses that could otherwise, in principle, collide with a stale value here.
  CURRENT_VITEST_PID=""
  wait "$tail_pid" 2>/dev/null
  if [ "$st" -eq "$MID_RUN_OOM_STATUS" ]; then
    _comment "INFO-ONLY SUITE-STOPPED-MEMORY

A teljes suite futas KOZBEN esett a rendelkezesre allo memoria a kuszob ala (${MID_RUN_OOM_DETAIL}) -- kontrolláltan leallitottam, mielott a kernel csendben OOM-kill-elte volna. EZ NEM TESZT-EREDMENY: se nem pass, se nem fail, a futas nem adott ervenyes valaszt (kartya e498502e)."
    return "$st"
  fi
  # Adds an explanation on stderr when the run is the known flake; NEVER changes the exit code. A
  # wrapper that turned exit 1 into exit 0 here would be indistinguishable from one hiding a real
  # regression, which is the opposite of what this is for.
  bash "$HERE/vitest-flake-classify.sh" "$st" "$log" || true
  # AND SAYS WHAT DID NOT RUN AT ALL (card beb9c8d3). This script sets no PG_E2E_URL and nothing
  # else in the fleet does, while CI does -- so every PG-gated e2e file skips here. Measured on the
  # api-e2e project alone: 58 of 65 files and 460 of 491 tests skipped, exit 0. vitest prints those
  # counts but attributes them to nothing, so a green run reads like evidence about files that never
  # executed. Same contract as the classifier: stderr only, never touches the exit code, silent when
  # nothing was skipped. Run PER INVOCATION -- it reads the LAST summary in the log, so one report
  # over two concatenated runs would silently describe only the second.
  bash "$HERE/vitest-skip-report.sh" "$log" "$WT" || true
  return "$st"
}

# THE api-e2e PROJECT GETS ITS OWN PROCESS (card cae9fb67). In one combined invocation it VANISHES
# from the report: zero of its 66 files appear, the totals count only the other projects, and the
# run ends with one "[vitest-worker]: Timeout calling onTaskUpdate". Measured, and each of these is
# a separate run, not a retelling of one:
#   api-e2e alone ....................... 66 files reported, exit 0
#   api-e2e + superadmin-tsx (83) ....... 66 files reported, 0 timeouts
#   api-e2e + @mopsion/web (276) ........ 66 files reported, 0 timeouts
#   api-e2e + packages (748) ............ 0 files reported, 1 timeout   <- reproduces
#   all four projects (975) ............. 0 files reported, 1 timeout   <- twice, incl. an idle box
# So it is not machine load (a fresh-boot run at load 1.10 lost it too), not the worker cap
# (--maxWorkers=12 loses it exactly the same), and not merely having a second project. What the
# failing runs share is the `packages` project: 682 files and ~15.9k tests of task updates through
# the main process, while api-e2e's SINGLE fork (singleFork, because these tests share one database)
# waits for its turn. The 60s birpc bound is hardcoded in vitest 3.2.6 and cannot be configured away.
#
# A SEPARATE PROCESS IS A WORKAROUND, NOT A DIAGNOSIS -- the exact mechanism inside vitest is not
# pinned here. It is the right shape anyway: this project is already isolated by design, and a run
# that silently drops 66 files is worse than one that takes 90 seconds longer.
#
# `!api-e2e` rather than a hand-listed project set, so adding a project does not silently start
# skipping it. Only when the CALLER did not pick projects: a caller naming its own --project has
# already said what it wants to run.
caller_set_project=0
for a in ${vitest_args[@]+"${vitest_args[@]}"}; do
  case "$a" in
    --project|--project=*) caller_set_project=1 ;;
  esac
done

if [ "$caller_set_project" -eq 1 ]; then
  run_vitest "$run_log" "${vitest_args[@]}"
  status=$?
  [ "$status" -eq "$MID_RUN_OOM_STATUS" ] && exit 4
  exit "$status"
fi

run_vitest "$run_log" "${vitest_args[@]}" --project '!api-e2e'
status=$?
# A mid-run OOM stop on the FIRST leg means there is no valid result to report at all -- running the
# api-e2e leg afterwards would only race the same memory shortage a second time. Say so and stop.
if [ "$status" -eq "$MID_RUN_OOM_STATUS" ]; then
  exit 4
fi

echo "mopsion-suite-run: the api-e2e project runs in its own process (card cae9fb67)" >&2
run_vitest "$e2e_log" "${vitest_args[@]}" --project api-e2e
e2e_status=$?
if [ "$e2e_status" -eq "$MID_RUN_OOM_STATUS" ]; then
  exit 4
fi

# A second run that matched NOTHING is the failure mode of hardcoding a project name: if `api-e2e`
# is ever renamed, the negation above stops excluding it and this run silently finds no files --
# which would look like success while the split quietly stopped happening. Say it out loud.
if grep -q "No test files found" "$e2e_log"; then
  echo "mopsion-suite-run: WARNING -- the api-e2e run matched NO files. The project name this" >&2
  echo "  script splits on ('api-e2e') no longer matches vitest.config.ts, so the split is inert" >&2
  echo "  and those tests are back in the main run (where they get lost). Fix the name here." >&2
  [ "$status" -eq 0 ] && status=1
fi

[ "$status" -eq 0 ] && status="$e2e_status"

# MACHINE-WRITTEN EVIDENCE (card 08eb6402, MikroB plan-grilling verdict 6011/3736): this is a FULL
# suite run (both projects), so it is exactly the shape a landing's Suite-SHA-equivalent check needs
# -- record it, keyed by the merge/branch tip's OWN tree hash, not the sha (a rebase/reword changes
# the sha without changing what was tested; two commits with the same tree hash are byte-identical
# in every tracked file, so no per-file diff heuristic is needed on the reading side either).
# Never touches $status: a broken recorder must not turn a real suite result into a script failure.
#
# TWO MORE GUARDS BEFORE RECORDING (Cybersec F1(b)/F1(c), card 08eb6402 delta-gate). A partial run
# (caller_extra_args) or a dirty worktree both mean the tree hash below would not describe what
# actually ran/what will actually land -- recording anyway is exactly how a filtered or uncommitted
# run got mistaken for full, green coverage of a tree nobody tested. `git status --porcelain` with
# no `-uno`: an untracked file is still part of what a future `git add` could land unmeasured.
EVIDENCE_SHA="$(git -C "$WT" rev-parse HEAD 2>/dev/null)"
EVIDENCE_TREE="$(git -C "$WT" rev-parse HEAD^{tree} 2>/dev/null)"
if [ "$caller_extra_args" -eq 1 ]; then
  echo "mopsion-suite-run: partial run (vitest arguments beyond --maxWorkers), no evidence recorded" >&2
elif [ -n "$(git -C "$WT" status --porcelain 2>/dev/null)" ]; then
  echo "mopsion-suite-run: dirty worktree ($WT), no evidence recorded" >&2
elif [ -n "$EVIDENCE_SHA" ] && [ -n "$EVIDENCE_TREE" ]; then
  python3 "$HERE/suite-evidence-record.py" record \
    --sha "$EVIDENCE_SHA" --tree "$EVIDENCE_TREE" --agent "$AGENT" \
    --main-log "$run_log" --main-status "$status" \
    --e2e-log "$e2e_log" --e2e-status "$e2e_status" >&2 || true
fi

exit "$status"

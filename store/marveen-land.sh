#!/usr/bin/env bash
# marveen-land.sh -- land an agent's marveen worktree branch (card dc185b52, MikroB komment 14285).
# Sibling of store/cleancore-land.sh, matching naming on purpose: this repo now has the same
# worktree-per-agent shape CleanCore already proved out, and the landing step follows the same
# pattern -- merge in a THROWAWAY detached worktree (never the agent's own persistent worktree from
# store/agent-worktree-marveen.sh, and never the shared main checkout), verify the MERGE RESULT, push
# only on green.
#
# WHAT ELSE RIDES ALONG (card dfff9b37). This used to be a note telling you to run
# `git log --oneline origin/develop..<gate-sha>` yourself. It is now measured by the script: every
# landing PRINTS the commits in that range grouped by the card they name, and the ones naming no
# card at all. It only REFUSES when you name the card you are landing (`--card <id>`) and somebody
# else's card is in there -- because a marveen landing legitimately carries several cards (measured
# over 14 landings; MikroB's `--all` sweep does exactly that on purpose), so a blanket refusal here
# would stop the normal path, not the defect. cleancore-land.sh, which is always called with one
# card, refuses by default. Shared code, different default; the reasoning is in
# store/landing-downward-check.sh, the cherry-pick recipe in
# store/landing-cherry-pick-vs-branch-merge.md.
#
# This script's core mechanics were already present, unchanged, in the now-retired
# store/agent-branch-land.sh and were explicitly confirmed safe by Cybersec's NO-GO review on
# card dc185b52 (komment 14284: "store/agent-branch-land.sh SOHA nem erinti a megosztott
# munkakonyvtarat, csak sajat throwaway worktree-t hasznal ... ez a resz biztonsagos"). The retired
# script's problem was its SIBLING (store/agent-branch.sh, "Step 0"), which ran `git checkout` on the
# ONE shared tree every agent's Read/Edit/Write tools also targeted -- a live-reproduced TOCTOU race.
# This script never did that, so it is renamed and kept (not rewritten) alongside the new
# agent-worktree-marveen.sh, which replaces Step 0 with real filesystem isolation instead of a
# checkout on shared ground.
#
# Usage:
#   marveen-land.sh <agent> [--dry-run] [--card <id>] [--allow-stacked <id>[,<id>...]]
#                                         # land one agent's worktree branch. --card turns the
#                                         # downward report into a refusal; --allow-stacked names
#                                         # the foreign cards you are taking on purpose.
#   marveen-land.sh --card <id> --agent <agent> [--dry-run] [--allow-ungated]
#                   [--allow-ungated-reason <text>]
#                                         # land that card's OWN card/<id> branch (card cd3e577b).
#                                         # REQUIRES a passing QA verdict AND an AGREE from every
#                                         # gate the card's own "Gate:" line/labels designate, on
#                                         # the sha being landed (refuse mode, card 9081d02d's
#                                         # helper + card-designated-gates-check.sh, MikroB decision
#                                         # comments 16277 and 16324 on cd3e577b) -- --allow-ungated
#                                         # tolerates a MISSING/non-AGREE verdict only, never a
#                                         # FAILING one, and leaves an "UNGATED LANDING" comment on
#                                         # the card (who/when/why); --allow-ungated-reason supplies
#                                         # the why in the open instead of a generic placeholder.
#   marveen-land.sh --all [--dry-run]     # REPORT ONLY (card cd3e577b, MikroB decision 16324): lists
#                                         # every agent/*/work and card/* branch that is not yet an
#                                         # ancestor of origin/develop. Lands NOTHING any more -- the
#                                         # owning agent lands its own agent/<agent>/work branch with
#                                         # a plain `marveen-land.sh <agent>` call, and a card/<id>
#                                         # branch with `--card <id> --agent <owner>`, so nothing
#                                         # reaches develop without the gate its own branch requires.
#   marveen-land.sh --selftest
#
# Env overrides (tests only):
#   MARVEEN_MAIN     default /home/neon/marveen -- also where `origin` is fetched/pushed
#   MARVEEN_LAND_TEST   default "$wt/store/fleet-test.sh --ref" (that AGENT's own merge worktree,
#                       resolved per-landing so a change to fleet-test.sh's own logic verifies
#                       itself -- cards 88a0a5e1 / 03cff5c1) -- verification command, the merge sha
#                       is appended as the final argument. fleet-test.sh hardcodes the real repo as
#                       ROOT regardless of which copy runs, so an automated test of THIS script
#                       against a throwaway repo must still override this to a stub.
#   MARVEEN_LAND_BUILD  default "npm run build" -- the rebuild run in the live install after a
#                       src/-touching land (card f1b3f2f0). MARVEEN_LAND_REBUILD=off disables the
#                       step entirely and says so in the output.
#   MARVEEN_LAND_MAX_ATTEMPTS  default 3 -- how many full merge+verify+push attempts before giving
#                       up on a repeatedly-raced push (card 65657bad).
#   LANDING_DOWNWARD_CHECK=off  disables the downward range check entirely (card dfff9b37).
#   MARVEEN_LAND_DEVELOP_LOCK_FILE  default $MAIN/store/.marveen-land-develop.lock -- machine-wide
#                       flock serialising the merge+fleet-test+push window across ALL marveen-land.sh
#                       invocations, not just within one --all sweep (card 24d1543f). Override is for
#                       tests only: the real repo's store/ always exists, a throwaway test clone does
#                       not by default.
#   MARVEEN_LAND_DEVELOP_LOCK_WAIT_MAX_S  default 7200 -- give up queueing for the lock after this
#                       long and refuse (nothing pushed), rather than wait forever.
#   MARVEEN_LAND_DEVELOP_LOCK_POLL_S      default 10 -- how often to retry acquiring the lock.
#   MARVEEN_LAND_DEVELOP_LOCK_KEEPALIVE_S default 300 -- how often to refresh the PAUSED-SEMAPHORE
#                       comment on the waiting card so a long queue is not mistaken for a stuck card.
#
# Exit: 0 landed (or dry-run clean, or nothing to land) | 2 bad usage | 3 refused a precondition
#       | 4 merge/verify/push failed
#       (5 is internal: land_one lost the push race; land_with_retry consumes it and never leaks it)
set -uo pipefail

MAIN="${MARVEEN_MAIN:-/home/neon/marveen}"
say() { echo "  $*"; }
die() { echo "REFUSED: $2" >&2; exit "$1"; }

# Card 9d1ee327 (CYBERSEC NO-GO 28823 LOW item 1): a signal received while bash blocks on a
# FOREGROUND subshell or pipeline is deferred until that subshell exits -- non-interactive bash
# only acts on a pending trap between commands, not while synchronously waiting on a child via
# waitpid(2) (measured on the real fleet-test call: 10s vs 0s -- the TERM trap in
# land_with_retry() below did not fire until the foreground fleet-test child finished). The
# `wait` builtin behaves differently: per the bash manual, if bash is blocked in `wait` and a
# signal arrives for which a trap is set, `wait` returns immediately and the trap runs right
# then, regardless of call-stack depth. This backgrounds $2 inside $1, records its pid in a
# global the already-registered TERM trap can act on immediately, and blocks on `wait` instead
# of a plain synchronous subshell.
run_fg_killable_pid=""
run_fg_killable() { # $1 = working dir, $2 = command string (already eval-safe)
  local dir="$1" cmd="$2" rc
  # card 81c6fbb5 Q3: close this subshell's OWN copy of LAND_LOCK_FD before cd/eval, same as the
  # old inline-subshell call sites did -- a subshell close never touches the parent's fd, and a
  # kill -9'd lander whose wrapped command survives no longer keeps the develop lock held.
  ( cd "$dir" && release_land_lock_fd && eval "$cmd" ) &
  run_fg_killable_pid=$!
  wait "$run_fg_killable_pid"
  rc=$?
  run_fg_killable_pid=""
  return "$rc"
}
g() { git -C "$MAIN" "$@"; }

# release_land_lock_fd (card cd3e577b, RedHat NO-GO 16401 finding B2): land_one's cleanup() calls
# THIS, so it is the one real fd-close land_one actually runs in production -- pulled out to its
# own top-level function, defined here (BEFORE the --selftest block below, which `exit`s well
# before land_one's own definition is ever reached) so --selftest can call this SAME function
# directly (it is already live by then) instead of testing a hand-written copy. RedHat measured
# the first attempt at this test (comment 16401, B2) doing exactly that: the old --selftest defined
# its own `cleanup_fixed`/`cleanup_buggy`, which pinned the test's OWN code, not land_one's
# cleanup() -- reverting land_one's real fd-close to the old bare-exec bug left all 55 cases green.
#
# RedHat NO-GO 16276, B2b (the bug this exists to prevent regressing): a bare `exec {FD}>&-
# 2>/dev/null` (no command) is not scoped to this one close -- bash applies a bare exec's
# redirections PERMANENTLY to the current shell, silencing the script's own stderr for every later
# call in the same process (the --all sweep, before R4 removed land_one from it). Wrapping the
# close in a brace group scopes the `2>/dev/null` to that group alone.
release_land_lock_fd() {
  [ -n "${LAND_LOCK_FD:-}" ] && { exec {LAND_LOCK_FD}>&-; } 2>/dev/null
  return 0
}

# Card 5d9731cd: acquire_land_lock's flock -n is NOT FIFO -- several waiters polling with `sleep`
# tend to hand the lock to whoever happens to retry right after release, not to the one that has
# been waiting longest (measured: a 106 min waiter lost the lock to arrivals 16-90 min behind it,
# three separate times). A ticket queue orders the ATTEMPTS, not the mutex itself: each waiter
# takes a numbered ticket (atomically, via a short flock on its own tiny counter file), and only
# the waiter holding the oldest still-live ticket ever calls acquire_land_lock -- everyone else
# just sleeps. acquire_land_lock/release_land_lock_fd (the actual flock on LAND_LOCK_FILE) are
# unchanged; this only changes who is allowed to try them next. Defined here (BEFORE the
# --selftest block below, same reasoning as release_land_lock_fd's own placement comment above)
# so --selftest can call these SAME functions, and reads $LAND_LOCK_FILE fresh on every call
# (never a load-time global) so a selftest run -- which overrides it before LAND_LOCK_FILE's own
# real default assignment further down ever executes -- exercises the real code path.

# card 81c6fbb5 (5d9731cd follow-up, CYBERSEC GO 28780 Q2a): a pid is not a stable identity on its
# own -- the OS can recycle it, and a recycled-pid ticket then looks alive forever (kill -0 succeeds
# against the NEW, unrelated process), blocking every later arrival until the 7200s cap. Linux keeps
# a process's start time (field 22 of /proc/<pid>/stat, clock ticks since boot) stable for that
# pid's whole life and different across any two processes that ever shared a pid, so a ticket
# records it alongside the pid and a reap compares both. $2 onward in /proc/<pid>/stat is the comm
# field in parens, which can itself contain spaces/parens, so field-count splitting is unsafe --
# this instead strips up to the LAST ")" and counts from there (same technique the kernel docs
# recommend for exactly this reason). Echoes nothing (not even a blank line) if the pid does not
# exist or /proc is unavailable, so callers must treat empty as "unknown", never as "0".
land_lock_pid_starttime() {
  local pid="$1" stat_line rest
  stat_line="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
  [ -n "$stat_line" ] || return 1
  rest="${stat_line##*) }"
  set -- $rest
  # state=1 ppid=2 pgrp=3 session=4 tty_nr=5 tpgid=6 flags=7 minflt=8 cminflt=9 majflt=10
  # cmajflt=11 utime=12 stime=13 cutime=14 cstime=15 priority=16 nice=17 num_threads=18
  # itrealvalue=19 starttime=20 (this file's own field-20-after-comm, i.e. overall field 22)
  [ "$#" -ge 20 ] || return 1
  echo "${20}"
}

# Takes the next ticket (a file named "<12-digit seq>.<pid>.<starttime>" in
# "$LAND_LOCK_FILE.tickets", content irrelevant) and echoes its path. The sequence number comes
# from a tiny counter file, read-incremented-written under its own short-lived flock so two
# waiters starting at the same instant never get the same number (the FIFO property rests on this
# being atomic, not on wall-clock arrival order).
#
# card 81c6fbb5 Q1a/Q1b fixes, both inside the SAME critical section as the increment (not two
# separate operations with a gap between them):
#   Q1a: the floor for the next number is max(counter file, any ticket already on disk) + 1, not
#   just the counter file alone -- a deleted/corrupted counter file used to fall back to 0, so the
#   very next arrival could outrank every waiter already queued (which all have ticket numbers
#   higher than a reset-to-0 counter). Scanning the ticket directory is safe here only because it
#   happens under the same flock that serializes every other write to that directory.
#   Q1b: the ticket FILE is created before the flock is released, not after -- closes the window
#   where a lower-numbered ticket's own allocation has completed (so land_lock_is_head could in
#   principle be asked about it) but the file proving it exists has not been written yet.
land_lock_take_ticket() {
  local ticket_dir="$LAND_LOCK_FILE.tickets"
  mkdir -p "$ticket_dir" 2>/dev/null || return 1
  local seq_lock_file="$LAND_LOCK_FILE.seq.lock" seq_file="$LAND_LOCK_FILE.seq"
  local seq_fd n floor existing ticket start
  exec {seq_fd}>>"$seq_lock_file" || return 1
  flock "$seq_fd" || { exec {seq_fd}>&-; return 1; }
  n="$(cat "$seq_file" 2>/dev/null || echo 0)"
  floor="$n"
  for existing in "$ticket_dir"/*; do
    [ -e "$existing" ] || continue
    existing="$(basename "$existing")"
    existing="${existing%%.*}"
    # card 81c6fbb5 N1 (CYBERSEC NO-GO 28862, regression): a stray non-numeric file in the ticket
    # directory (garbage, a half-written ticket, anything) used to hit `$((10#$existing))` on an
    # invalid base-10 literal, which made take_ticket return 1 and land_one `die 3` for EVERY
    # landing until someone deleted the file -- a hit under the pre-fix code (any file's name
    # fragment was fine, since the old code never did arithmetic on the ticket directory at all).
    # Skip anything whose seq-looking prefix is not purely digits instead of crashing on it.
    case "$existing" in
      ''|*[!0-9]*) continue ;;
    esac
    existing=$((10#$existing))
    [ "$existing" -gt "$floor" ] && floor="$existing"
  done
  n=$((floor + 1))
  echo "$n" >"$seq_file"
  start="$(land_lock_pid_starttime "$$")" || start="unknown"
  printf -v ticket '%012d.%d.%s' "$n" "$$" "$start"
  if : >"$ticket_dir/$ticket"; then
    { exec {seq_fd}>&-; } 2>/dev/null
    echo "$ticket_dir/$ticket"
  else
    { exec {seq_fd}>&-; } 2>/dev/null
    return 1
  fi
}

# Removes any ticket that is no longer a live waiter:
#   - pid part is not a positive integer (card 81c6fbb5 Q2b: a malformed/empty pid part used to
#     fall through to `kill -0 "$pid"` as-is; `kill -0 0` sends to the CALLER's own process group
#     and always succeeds, which made a ticket with pid part "0" immortal -- it could never be
#     reaped no matter how long it sat there) -- removed unconditionally, no liveness check
#     needed. CYBERSEC NO-GO 28862 N2: a bare `case ... 0)` only matched the single character
#     "0", so zero-padded spellings ("00", "000000000000") still reached `kill -0` with THEIR OWN
#     process-group semantics and survived -- the pid part is now compared NUMERICALLY (any
#     all-digit string base-10-equal to zero is reaped), not string-matched.
#   - pid is not alive (kill -0 fails) -- the original crash/kill-9 case this already covered.
#   - pid IS alive but its recorded start time no longer matches the live process's current start
#     time (card 81c6fbb5 Q2a) -- the pid was recycled by an unrelated later process; the ticket's
#     original owner is long gone. A ticket with no recorded start time ("unknown", from a
#     take_ticket call where /proc was unavailable) cannot be checked this way and keeps the old,
#     weaker pid-only liveness check -- same inherent limitation as before this card, not widened.
#     CYBERSEC NO-GO 28862 N3: a LIVE ticket written by the PRE-this-card format (two
#     dot-separated fields, "seq.pid", no third start-time field) used to be misread here --
#     `${base##*.}` then returns the pid itself as "recorded_start", which almost never equals
#     the live start time, so a still-running old-format waiter got reaped out from under
#     itself. Field COUNT (dots in the basename), not just the last field's content, now decides
#     whether a start-time comparison even applies: a two-field name is treated the same as an
#     explicit "unknown" (pid-liveness only), never compared against a start time that was never
#     recorded for it.
land_lock_reap_stale_tickets() {
  local ticket_dir="$LAND_LOCK_FILE.tickets"
  local f base pid dots recorded_start live_start
  for f in "$ticket_dir"/*; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    pid="${base#*.}"; pid="${pid%%.*}"
    case "$pid" in
      ''|*[!0-9]*)
        rm -f "$f" 2>/dev/null
        continue
        ;;
    esac
    if [ "$((10#$pid))" -le 0 ]; then
      rm -f "$f" 2>/dev/null
      continue
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$f" 2>/dev/null
      continue
    fi
    dots="${base//[^.]/}"
    [ "${#dots}" -lt 2 ] && continue
    recorded_start="${base##*.}"
    [ "$recorded_start" = "unknown" ] && continue
    live_start="$(land_lock_pid_starttime "$pid")" || live_start=""
    if [ -n "$live_start" ] && [ "$live_start" != "$recorded_start" ]; then
      rm -f "$f" 2>/dev/null
    fi
  done
}

# True (exit 0) only if $1 (this waiter's own ticket path) is the lowest-numbered ticket that
# still has a live pid behind it -- i.e. this waiter is at the head of the FIFO queue and may call
# acquire_land_lock. Reaps stale tickets first so a crashed head does not block the queue forever.
land_lock_is_head() {
  local my_ticket="$1" ticket_dir="$LAND_LOCK_FILE.tickets" head
  land_lock_reap_stale_tickets
  head="$(printf '%s\n' "$ticket_dir"/* 2>/dev/null | LC_ALL=C sort | head -n1)"
  [ "$head" = "$my_ticket" ]
}

# card 02f462e1: a landing pushes from a DISPOSABLE worktree (land_one's $wt) that shares $MAIN's
# .git, so `g fetch` above already refreshed $MAIN's origin/$DEFAULT_BRANCH ref -- but $MAIN's own
# CHECKED-OUT branch and working-tree files do not follow along on their own. Left alone, that is
# exactly the gap the card measured: 3 unrelated cards landed clean on one day while the live
# install (MikroB's own running checkout) kept serving the pre-landing code/scripts, until someone
# fetched + fast-forwarded it BY HAND. This is a plain `merge --ff-only` and NOTHING else: no
# rebuild, no service restart -- those remain ./update.sh + Peti's approval (a separate, deliberate
# gate). --ff-only is the whole safety story: it can only ever fast-forward or refuse, never force,
# so a dirty/diverged $MAIN is left untouched and reported, not overridden.
sync_live_install() {
  local current before
  current="$(git -C "$MAIN" symbolic-ref --short -q HEAD 2>/dev/null || true)"
  # Not on the tracked branch (detached, or mid manual work on something else) -- nothing to sync,
  # and merging origin/$DEFAULT_BRANCH into an unrelated checkout would not even make sense.
  [ "$current" = "$DEFAULT_BRANCH" ] || return 0
  before="$(git -C "$MAIN" rev-parse HEAD)"
  if git -C "$MAIN" merge --ff-only -q "origin/$DEFAULT_BRANCH" 2>/dev/null; then
    say "live install ($MAIN) fast-forwarded to origin/$DEFAULT_BRANCH"
    # card 5d365589 WhiteHat N3: this fast-forward only ever moves the SOURCE -- it never runs
    # `npm ci`, on purpose (a blind auto-install on every landing is its own risk: it would run
    # unattended against whatever the live install happens to be doing at that moment). Measured
    # consequence when nobody notices: after 2f05b3e3 (vitest 2.1.9 -> 5.0.3) landed, the live
    # node_modules stayed on 2.1.9 until someone manually ran `npm ci --include=dev` in $MAIN --
    # a step that exists nowhere in code, so the next dependency-bump land hits the exact same gap.
    # This does not auto-install either (same risk, unchanged) -- it only makes the gap loud instead
    # of silent, by diffing the two lockfile-relevant files across the fast-forward.
    if ! git -C "$MAIN" diff --quiet "$before" HEAD -- package.json package-lock.json 2>/dev/null; then
      say "live install's package.json/package-lock.json changed by this fast-forward -- run 'npm ci --include=dev' in $MAIN by hand (card 5d365589 N3), or the live node_modules stays on the OLD dependency set"
    fi
  else
    say "live install ($MAIN) NOT fast-forwarded (dirty tree or diverged) -- sync it by hand, tell MikroB"
  fi
}

# rebuild_live_install (card f1b3f2f0) -- turn a REPEATING CONDITION into a non-event.
#
# WHAT WAS ACTUALLY WRONG. store/local-llm-rag.sh imports dist/local-llm-router.js and refuses to
# use it unless checkBuildFreshness says `fresh`; anything else routes ONLINE. That is the correct
# fail-safe, but it means a stale dist SILENTLY DISABLES the whole local-model offload -- the
# symptom is one line in the output of whoever happened to call the script. And it is not a state
# that gets fixed once: every src/-touching land re-arms it, more than ten times a day.
#
# WHAT ALREADY EXISTED, measured rather than assumed (the card's premise said nobody watches this):
# scripts/build-freshness-guard.sh DOES watch it, on a live systemd --user timer every 5 minutes
# with a 300s build-time grace period -- verified running while writing this. So the gap was never
# invisible; it was just never CLOSED. Alerting is not fixing, and a condition that recurs ten times
# a day cannot be answered by a human running ./update.sh ten times a day.
#
# WHAT THIS DOES NOT DO: restart anything. mikrob-channels and mikrob-dashboard keep the modules
# they already loaded, and a restart stays the separate confirmed gate it was made in card 77075367
# -- that decision is untouched here. Rebuilding without restarting is exactly what the offload path
# needs, because local-llm-rag.sh spawns a FRESH node from dist/ on every call. Checked before
# writing this: nothing under src/web spawns node children from dist/ at runtime, so a rebuilt dist
# under the running services does not split them across two versions.
#
# SERIALIZED, because landings genuinely overlap -- two push races were observed on one evening --
# and two `tsc` runs writing the same dist/ would interleave their output.
#
# FAIL-SOFT AND LOUD. The commits are already pushed by the time this runs; failing the landing here
# would report a landing that happened as one that did not. A failed build leaves exactly today's
# situation (stale dist, guard alerts), so it is reported, not fatal.
rebuild_live_install() {
  [ "${MARVEEN_LAND_REBUILD:-on}" = "off" ] && { say "rebuild skipped (MARVEEN_LAND_REBUILD=off) -- dist/ stays stale"; return 0; }
  local current
  current="$(git -C "$MAIN" symbolic-ref --short -q HEAD 2>/dev/null || true)"
  # If the live install did not follow the landing, building it would produce a dist for SOME OTHER
  # source than the one just landed -- worse than stale, because it looks current.
  if [ "$current" != "$DEFAULT_BRANCH" ]; then
    say "rebuild skipped -- live install is not on $DEFAULT_BRANCH, so its dist/ would not match this land"
    return 0
  fi
  local out rc
  # The lock lives under .git, not store/: this script already refuses to run unless $MAIN/.git is a
  # directory, whereas store/ is not guaranteed (measured -- the land test fixture has no store/, and
  # flock exits 66 "cannot open lock file", which surfaced as a REBUILD FAILED for a build that was
  # never actually attempted).
  out="$(cd "$MAIN" && flock "$MAIN/.git/land-rebuild.lock" sh -c "$BUILD_CMD" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then
    say "$agent: dist/ rebuilt from the landed source (services NOT restarted -- that stays ./update.sh)"
  else
    say "$agent: WARNING -- dist/ REBUILD FAILED (exit $rc). The land itself is fine and pushed; dist/ is"
    say "  stale exactly as it would have been before this step, so the local-model offload routes"
    say "  online until someone builds by hand. Last lines:"
    printf '%s\n' "$out" | tail -5 | sed 's/^/    /'
  fi
  return 0
}

# try_append_union (card cbb66abf): the ONE conflict shape (both sides purely append to
# DECISIONS.md) this script auto-resolves, shared verbatim with cleancore-land.sh so the narrow
# precondition and the header-count check cannot drift between the two copies.
# shellcheck source=./decisions-append-union.sh
. "$(dirname "$0")/decisions-append-union.sh"
# decisions_tail_append_ok (card 375a81c1): the invariant try_append_union does not check -- a pure
# addition that lands somewhere other than the file's own tail. Run on the card branch alone, before
# the merge is even attempted, so a mid-file splice is refused with a clear pointer at the branch's
# own insertion point rather than a raw conflict three steps downstream.
# shellcheck source=./decisions-tail-append-guard.sh
. "$(dirname "$0")/decisions-tail-append-guard.sh"
# shellcheck source=./bump-fork-version.sh
. "$(dirname "$0")/bump-fork-version.sh"
# shellcheck source=./bump-upstream-version.sh
. "$(dirname "$0")/bump-upstream-version.sh"
# downward_check (card dfff9b37): what ELSE rides along in origin/develop..<branch>. Shared verbatim
# with cleancore-land.sh. REPORTS here by default and refuses only under --card <id> -- the reason
# is measured and written out in landing-downward-check.sh's header (marveen lands whole agent
# branches, gate-AFTER-landing, and multi-card landings are the normal case, not the anomaly).
# shellcheck source=./landing-downward-check.sh
. "$(dirname "$0")/landing-downward-check.sh"
# shellcheck source=./readme-bullet-union.sh
. "$(dirname "$0")/readme-bullet-union.sh"
# decisions_conflict_report (card 4a769a34, Trail-ötlet 2): report-only -- quotes a past
# DECISIONS.md entry when this landing's diff touches a file that entry is about. Never refuses.
# shellcheck source=./decisions-conflict-check.sh
. "$(dirname "$0")/decisions-conflict-check.sh"

# gate_verdict_check (card 9081d02d): shared with cleancore-land.sh, but run here in REPORT mode.
# Marveen gates AFTER landing -- the root CLAUDE.md says "a visszaadott sha a Gate-SHA", i.e. the
# sha a gate will judge is the one THIS script is about to produce -- so demanding a verdict up
# front would deadlock every marveen landing rather than tighten it. Measured on the cards landed
# 2026-09-04 (b3bf3cc2, d9b1b418, af5d3dbf): each was already an ancestor of origin/develop when
# its gate ran. Same shape as downward_check above: shared code, different default.
# shellcheck source=./landing-gate-verdict-check.sh
. "$(dirname "$0")/landing-gate-verdict-check.sh"
# card_designated_gates_agree (card cd3e577b, MikroB decision 16324): QA-mandatory alone is not
# enough for --card mode -- see that file's header for RedHat's measured finding (B1, comment
# 16322) and why it is a separate check rather than a change to gate_verdict_check itself.
# shellcheck source=./card-designated-gates-check.sh
. "$(dirname "$0")/card-designated-gates-check.sh"
# find_conflict_markers (card 4b4c89eb): shared with cleancore-land.sh, same reason as the two
# libraries above -- one copy of the check, not two that can drift.
# shellcheck source=./conflict-marker-check.sh
. "$(dirname "$0")/conflict-marker-check.sh"

if [ "${1:-}" = "--selftest" ]; then
  fail=0; n=0
  t() { n=$((n+1)); [ "$2" = "$3" ] || { echo "  FAIL $1: got [$2] want [$3]"; fail=1; }; }
  agent_of() { case "$1" in agent/*/work) b="${1#agent/}"; echo "${b%/work}" ;; *) echo "" ;; esac; }
  t "extracts agent name from a work branch" "$(agent_of 'agent/backend/work')" "backend"
  t "rejects a non-agent branch" "$(agent_of 'develop')" ""
  t "rejects an agent branch with the wrong suffix" "$(agent_of 'agent/backend/scratch')" ""
  # Downward range check (card dfff9b37) -- the cases live in the shared lib so the two landers
  # cannot end up testing different things about the same code.
  downward_selftest_cases
  # Conflict-marker check (card 4b4c89eb) -- same sharing reason.
  conflict_marker_selftest_cases

  # card cd3e577b, RedHat NO-GO 16276 B2b + 16401 B2 (second finding: the FIRST version of this
  # test pinned a hand-copied `cleanup_fixed`/`cleanup_buggy`, not land_one's actual cleanup() --
  # reverting the real fix left every case here green). Fixed per MikroB decision 16402: call the
  # REAL release_land_lock_fd (defined near the top of this file, already live by the time this
  # block runs, and the exact function land_one's cleanup() calls) directly, isolated from
  # git/network/the --all sweep (which R4 now removes land_one from entirely, making the bug
  # unreachable THERE) in a subshell so neither case touches this process's own stderr.
  n=$((n + 1))
  fixed_survives="$(
    {
      exec {LAND_LOCK_FD}>/dev/null
      release_land_lock_fd
      echo stderr-alive >&2
    } 2>&1 1>/dev/null
  )"
  if [ "$fixed_survives" = "stderr-alive" ]; then
    echo "  ok   the REAL release_land_lock_fd leaves this process's own stderr untouched afterwards"
  else
    echo "  FAIL expected stderr to survive the real release_land_lock_fd -> got: [$fixed_survives]"; fail=1
  fi

  # Sensitivity check: the test above must actually CATCH a regression to the old bare-exec bug,
  # not pass vacuously. Extracts release_land_lock_fd's OWN source text out of THIS running script
  # ($0, not a hand-written copy), mutates only the brace-group back to the old bare
  # `exec ... 2>/dev/null` (RedHat NO-GO 16276 B2b) in a throwaway string, and confirms that
  # reproduces the bug.
  n=$((n + 1))
  real_fn_src="$(awk '/^release_land_lock_fd\(\) \{/{p=1} p{print} p&&/^}/{exit}' "$0")"
  mutant_fn_src="$(printf '%s\n' "$real_fn_src" | sed 's/{ exec {LAND_LOCK_FD}>&-; } 2>\/dev\/null/exec {LAND_LOCK_FD}>\&- 2>\/dev\/null/')"
  if [ -z "$real_fn_src" ] || [ "$mutant_fn_src" = "$real_fn_src" ]; then
    echo "  FAIL could not extract/mutate release_land_lock_fd's real source from $0 -- selftest and production have drifted"; fail=1
  fi
  buggy_survives="$(
    {
      eval "$mutant_fn_src"
      exec {LAND_LOCK_FD}>/dev/null
      release_land_lock_fd
      echo stderr-alive >&2
    } 2>&1 1>/dev/null
  )"
  if [ -z "$buggy_survives" ]; then
    echo "  ok   MUTATION CAUGHT: reverting release_land_lock_fd to the old bare exec silences this process's own stderr (B2b)"
  else
    echo "  FAIL the bare-exec mutation should have silenced stderr too, but got: [$buggy_survives]"; fail=1
  fi

  # RedHat NO-GO 16486, B2' (fourth round): the two tests above pin release_land_lock_fd's OWN
  # body, but RedHat measured that reverting land_one's CALL SITES (the two cleanup() definitions,
  # or acquire_land_lock's own fd-close) back to an inline bare `exec {LAND_LOCK_FD}>&- 2>/dev/null`
  # left every one of the 55 prior cases green -- nothing pinned that the call sites actually call
  # the function. Two textual (comment-stripped) pins on $0 itself, scoped to production code only
  # (excluding this --selftest block's own string literals, which quote the bug pattern on purpose).
  n=$((n + 1))
  prod_src="$(awk '
    /^if \[ "\$\{1:-\}" = "--selftest" \]; then$/ { in_st = 1 }
    in_st { if ($0 == "fi") { in_st = 0 }; next }
    /^release_land_lock_fd\(\) \{$/ { in_fn = 1 }
    in_fn { if ($0 == "}") { in_fn = 0 }; next }
    { print }
  ' "$0" | grep -v '^[[:space:]]*#')"
  if printf '%s\n' "$prod_src" | grep -qE 'exec \{LAND_LOCK_FD\}>&-'; then
    echo "  FAIL found a bare 'exec {LAND_LOCK_FD}>&-' in production code outside release_land_lock_fd (B2')"; fail=1
  else
    echo "  ok   no bare exec {LAND_LOCK_FD}>&- exists outside release_land_lock_fd anywhere in production code (B2')"
  fi

  n=$((n + 1))
  cleanup_bodies="$(printf '%s\n' "$prod_src" | awk '
    /cleanup\(\) \{.*\}/ { print; next }
    /cleanup\(\) \{[[:space:]]*$/ { p = 1; print; next }
    p { print }
    p && /^[[:space:]]*}[[:space:]]*$/ { p = 0 }
  ')"
  cleanup_defs="$(printf '%s\n' "$cleanup_bodies" | grep -c 'cleanup() {')"
  cleanup_calls="$(printf '%s\n' "$cleanup_bodies" | grep -c 'release_land_lock_fd')"
  if [ "$cleanup_defs" -eq 2 ] && [ "$cleanup_calls" -eq 2 ]; then
    echo "  ok   both land_one cleanup() definitions call release_land_lock_fd, not an inline exec (B2')"
  else
    echo "  FAIL expected exactly 2 cleanup() definitions each calling release_land_lock_fd, got defs=$cleanup_defs calls=$cleanup_calls"; fail=1
  fi

  # Card 3731c807, QA2's own 4th mutant (cd3e577b comment 16517) vs. RedHat's Q1 (comment 16520):
  # the two claims were measured to be about DIFFERENT mutations, not the same one. RedHat's Q1
  # reverts acquire_land_lock's own fd-close back to a bare exec -- caught above by the B2' pin,
  # because that pin greps for the bare-exec STRING anywhere outside release_land_lock_fd. QA2's
  # mutant instead DELETES acquire_land_lock's own release_land_lock_fd call outright, leaving no
  # bare exec and no cleanup() mutation for either existing B2' pin to see -- confirmed by hand:
  # that deletion left all 57 prior cases green. Closes the gap with a pin that is actually scoped
  # to this one call site (the two above only cover release_land_lock_fd's own body and land_one's
  # two cleanup() definitions, never acquire_land_lock's).
  n=$((n + 1))
  acquire_body="$(printf '%s\n' "$prod_src" | awk '
    /^acquire_land_lock\(\) \{$/ { p = 1; next }
    p && /^}$/ { p = 0; next }
    p { print }
  ')"
  acquire_calls="$(printf '%s\n' "$acquire_body" | grep -c 'release_land_lock_fd')"
  if [ "$acquire_calls" -eq 1 ]; then
    echo "  ok   acquire_land_lock's own failed-flock path calls release_land_lock_fd exactly once (QA2 4th mutant, cd3e577b 16517)"
  else
    echo "  FAIL expected acquire_land_lock to call release_land_lock_fd exactly once, got calls=$acquire_calls (a deleted call site reads 0 here -- QA2's 4th mutant)"; fail=1
  fi

  # Card 3731c807 (RedHat 16520, Q2/Q3): every pin above reads TEXT -- it counts how many times a
  # call site mentions release_land_lock_fd, never whether calling it actually releases anything.
  # RedHat's own note: "a szoveg-pin a hivas szoveget szamolja, nem a viselkedest." This case drops
  # the text entirely and checks the OS-level effect: a held flock must become acquirable by a
  # SEPARATE process only AFTER release_land_lock_fd runs, never before. The sensitivity half (the
  # "before" check) proves the harness can tell a held lock from a released one at all -- without
  # it, a release_land_lock_fd that silently did nothing would still read as a pass.
  n=$((n + 1))
  behavioral_lock_file="$(mktemp)"
  behavioral_rc=0
  (
    exec {LAND_LOCK_FD}>>"$behavioral_lock_file" || exit 10
    flock -n "$LAND_LOCK_FD" || exit 10
    # Held: a second, independent flock on the same path must be refused.
    flock -n "$behavioral_lock_file" true 2>/dev/null && exit 11
    release_land_lock_fd
    # Released: a second, independent flock on the same path must now succeed.
    flock -n "$behavioral_lock_file" true 2>/dev/null || exit 12
    exit 0
  )
  behavioral_rc=$?
  rm -f "$behavioral_lock_file"
  if [ "$behavioral_rc" -eq 0 ]; then
    echo "  ok   release_land_lock_fd actually releases the OS-level flock -- a second flock on the same file only succeeds afterward (behavioral, not text-pin, RedHat 16520 Q2/Q3)"
  else
    echo "  FAIL behavioral lock-release check failed (rc=$behavioral_rc: 10=setup, 11=lock was never truly held before release, 12=still held after release)"; fail=1
  fi

  # Card 3731c807 (Designated: line on early exit paths): card_designated_gates_agree's own
  # CARD_DESIGNATED_GATES_CSV global must never carry a value forward from an EARLIER call once a
  # LATER call fails before it can read anything real -- otherwise land_one's "Designated:
  # ${CARD_DESIGNATED_GATES_CSV:-nincs kijelolve}" comment would post a stale or unrelated value as
  # if this call had actually determined it. Simulates a prior successful-looking call by
  # pre-seeding the variable, then forces the earliest possible failure (an unreadable token file)
  # and checks the sentinel replaced it rather than surviving untouched.
  n=$((n + 1))
  CARD_DESIGNATED_GATES_CSV="cybered,qa,qa2"
  GATE_CHECK_TOKEN_FILE="/nonexistent/$$/no-such-token" card_designated_gates_agree "whatever" "deadbeef" >/dev/null 2>&1
  case "$CARD_DESIGNATED_GATES_CSV" in
    *ismeretlen*)
      echo "  ok   an unreadable-token early exit resets CARD_DESIGNATED_GATES_CSV to the unknown sentinel, not a leftover value"
      ;;
    *)
      echo "  FAIL CARD_DESIGNATED_GATES_CSV should have been reset to the unknown sentinel, got: [$CARD_DESIGNATED_GATES_CSV]"; fail=1
      ;;
  esac

  # Card 5d9731cd: "Teszt: 3 parhuzamos szimulalt landolas, a sorrend = indulasi sorrend."
  # Three REAL background processes (not three sequential calls in this one process) simulate 3
  # concurrent landings: each races to take a ticket at the same instant, then stays alive
  # (sleeping) exactly like a real land_one waiter would while it holds its ticket -- this is what
  # proves land_lock_take_ticket's counter increment is atomic under genuine concurrency (not just
  # a single-threaded simulation) AND that land_lock_is_head's pid-liveness reaping does not treat
  # a still-queueing waiter as dead.
  n=$((n + 1))
  tq_base="$(mktemp -u)"
  tq_out="$(mktemp -d)"
  export -f land_lock_take_ticket >/dev/null 2>&1
  tq_pids=()
  for tq_i in 1 2 3; do
    ( LAND_LOCK_FILE="$tq_base" bash -c 'land_lock_take_ticket >"$1"; sleep 20' _ "$tq_out/$tq_i" 2>/dev/null ) &
    tq_pids+=("$!")
  done
  for _tq_wait in $(seq 1 100); do
    [ -s "$tq_out/1" ] && [ -s "$tq_out/2" ] && [ -s "$tq_out/3" ] && break
    sleep 0.05
  done
  tq_a="$(cat "$tq_out/1")"; tq_b="$(cat "$tq_out/2")"; tq_c="$(cat "$tq_out/3")"
  tq_seqs="$(printf '%s\n' "$tq_a" "$tq_b" "$tq_c" | sed -E 's@.*/([0-9]{12})\.[0-9]+\.[^.]+$@\1@' | LC_ALL=C sort | sed 's/^0*//')"
  if [ "$tq_seqs" = "$(printf '1\n2\n3\n')" ] && [ -n "$tq_a" ] && [ -n "$tq_b" ] && [ -n "$tq_c" ]; then
    echo "  ok   3 genuinely parallel (backgrounded) ticket-takers got distinct, gapless sequence numbers 1,2,3 -- the counter increment is atomic under real concurrency"
  else
    echo "  FAIL expected 3 parallel ticket-takers to get exactly {1,2,3}, got seqs=[$(printf '%s ' $tq_seqs)] tickets=[$tq_a][$tq_b][$tq_c]"; fail=1
  fi
  # Service order must follow TICKET order (ticket number = indulasi sorrend, the order the
  # atomic counter assigned them), never arrival-of-retry luck: with all 3 tickets still live,
  # only the lowest-numbered one may report itself head; once it is removed (simulating that
  # waiter being served and moving on), the next-lowest becomes head, then the last one. The 3
  # background waiters are still alive (sleeping) at this point, so this is a real check against
  # land_lock_reap_stale_tickets too, not just against an already-empty queue.
  n=$((n + 1))
  LAND_LOCK_FILE="$tq_base"
  tq_sorted="$(printf '%s\n' "$tq_a" "$tq_b" "$tq_c" | LC_ALL=C sort)"
  tq_first="$(printf '%s\n' "$tq_sorted" | sed -n 1p)"
  tq_second="$(printf '%s\n' "$tq_sorted" | sed -n 2p)"
  tq_third="$(printf '%s\n' "$tq_sorted" | sed -n 3p)"
  tq_order_ok=1
  land_lock_is_head "$tq_first" || tq_order_ok=0
  land_lock_is_head "$tq_second" && tq_order_ok=0
  land_lock_is_head "$tq_third" && tq_order_ok=0
  rm -f "$tq_first"
  land_lock_is_head "$tq_second" || tq_order_ok=0
  land_lock_is_head "$tq_third" && tq_order_ok=0
  rm -f "$tq_second"
  land_lock_is_head "$tq_third" || tq_order_ok=0
  if [ "$tq_order_ok" -eq 1 ]; then
    echo "  ok   with 3 simulated landings, service order (land_lock_is_head) follows ticket/indulasi sorrend exactly: lowest-numbered first, then the next, then the last"
  else
    echo "  FAIL service order did not follow ticket order -- land_lock_is_head picked a non-head ticket or missed the real head at some step"; fail=1
  fi
  for tq_pid in "${tq_pids[@]}"; do kill "$tq_pid" 2>/dev/null; done
  # The two cases above pin land_lock_is_head/land_lock_take_ticket's OWN behavior, but land_one
  # could still skip calling them -- e.g. revert to the old `while ! acquire_land_lock; do` and
  # every waiter is back to racing the raw flock on retry, exactly the starvation this card fixes.
  # Text-pin on land_one's actual wait-loop condition (same B2'-style call-site pin as
  # release_land_lock_fd's, below), scoped to production code only.
  n=$((n + 1))
  if printf '%s\n' "$prod_src" | grep -qE 'while ! \{ land_lock_is_head "\$land_lock_ticket" && acquire_land_lock; \}; do'; then
    echo "  ok   land_one's wait loop still gates acquire_land_lock on land_lock_is_head (card 5d9731cd)"
  else
    echo "  FAIL land_one's wait loop no longer gates acquire_land_lock on land_lock_is_head -- the FIFO fix for card 5d9731cd is not wired in"; fail=1
  fi
  # Sensitivity: confirm this pin actually catches the old bug class (anyone can be "head"), not
  # just a renamed no-op. Mutates land_lock_is_head's OWN source extracted from $0 to the vacuous
  # always-true shape and re-checks the ordering assertion above would then wrongly pass for the
  # non-head ticket too.
  n=$((n + 1))
  real_head_src="$(awk '/^land_lock_is_head\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$0")"
  mutant_head_src="$(printf '%s\n' "$real_head_src" | sed 's/\[ "\$head" = "\$my_ticket" \]/true/')"
  if [ -z "$real_head_src" ] || [ "$mutant_head_src" = "$real_head_src" ]; then
    echo "  FAIL could not extract/mutate land_lock_is_head's real source from $0 -- selftest and production have drifted"; fail=1
  else
    ( eval "$mutant_head_src"; land_lock_is_head "$tq_second" )
    if [ $? -eq 0 ]; then
      echo "  ok   MUTATION CAUGHT: a vacuous (always-true) land_lock_is_head would wrongly let a non-head ticket proceed -- the real check does not"
    else
      echo "  FAIL the vacuous mutant should have returned true for a non-head ticket too; it did not, so this pin is not sensitive"; fail=1
    fi
  fi
  rm -rf "$tq_base" "$tq_base.tickets" "$tq_base.seq" "$tq_base.seq.lock" "$tq_out" 2>/dev/null

  # card 1ce1059a (81c6fbb5 round 2 residual, QA2 28921 + CYBERSEC GO 28925 Q1b): the ticket FILE
  # write must happen BEFORE the seq-lock is released -- land_lock_take_ticket already does this,
  # but nothing pinned the ORDER itself; a regression that swapped them (release first, write
  # second) would pass every test above untouched. Splices an injected (test-only) sleep into the
  # REAL source extracted from $0 (not a hand-reconstructed copy, same technique as the
  # land_lock_is_head mutant above), runs it in the background, and polls mid-delay: the real
  # order must show the ticket file already present AND the seq lock still held; the reorder
  # mutant (release, then the same delay, then the write) must NOT.
  n=$((n + 1))
  real_tt_src="$(awk '/^land_lock_take_ticket\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$0")"
  tt_if_idx=-1; tt_release_idx=-1
  if [ -n "$real_tt_src" ]; then
    mapfile -t tt_lines <<<"$real_tt_src"
    for tt_i in "${!tt_lines[@]}"; do
      case "${tt_lines[$tt_i]}" in
        *'if : >"$ticket_dir/$ticket"; then'*) [ "$tt_if_idx" -lt 0 ] && tt_if_idx="$tt_i" ;;
        *'{ exec {seq_fd}>&-; } 2>/dev/null'*) [ "$tt_if_idx" -ge 0 ] && [ "$tt_release_idx" -lt 0 ] && tt_release_idx="$tt_i" ;;
      esac
    done
  fi
  if [ "$tt_if_idx" -lt 0 ] || [ "$tt_release_idx" -ne $((tt_if_idx + 1)) ]; then
    echo "  FAIL could not locate the write-then-release adjacency in land_lock_take_ticket -- selftest and production have drifted"; fail=1
  else
    tt_real_delayed=("${tt_lines[@]:0:$((tt_if_idx + 1))}" '    sleep "$TQ_DELAY"' "${tt_lines[@]:$((tt_if_idx + 1))}")
    tt_mutant=("${tt_lines[@]:0:$tt_if_idx}" "${tt_lines[$tt_release_idx]}" '    sleep "$TQ_DELAY"' "${tt_lines[$tt_if_idx]}" "${tt_lines[@]:$((tt_release_idx + 1))}")
    real_tt_delayed_src="$(printf '%s\n' "${tt_real_delayed[@]}")"
    mutant_tt_src="$(printf '%s\n' "${tt_mutant[@]}")"
    if [ "$real_tt_delayed_src" = "$mutant_tt_src" ]; then
      echo "  FAIL the reorder mutant is identical to the delayed-real source -- this pin is not sensitive"; fail=1
    else
      tt_base="$(mktemp -u)"
      ( eval "$real_tt_delayed_src"; LAND_LOCK_FILE="$tt_base" TQ_DELAY=3 land_lock_take_ticket >/dev/null 2>&1 ) &
      tt_real_pid=$!
      sleep 1
      tt_real_ticket_exists=0; [ -n "$(ls "$tt_base.tickets" 2>/dev/null)" ] && tt_real_ticket_exists=1
      exec {tt_fd}>>"$tt_base.seq.lock"
      if flock -n "$tt_fd"; then tt_real_lock_held=0; flock -u "$tt_fd"; else tt_real_lock_held=1; fi
      exec {tt_fd}>&-
      kill "$tt_real_pid" 2>/dev/null; wait "$tt_real_pid" 2>/dev/null
      rm -rf "$tt_base.tickets" "$tt_base.seq" "$tt_base.seq.lock" 2>/dev/null
      if [ "$tt_real_ticket_exists" -eq 1 ] && [ "$tt_real_lock_held" -eq 1 ]; then
        echo "  ok   land_lock_take_ticket writes the ticket file before releasing the seq lock (mid-delay: ticket present, lock still held)"
      else
        echo "  FAIL expected the ticket file to exist AND the seq lock to still be held mid-delay (ticket_exists=$tt_real_ticket_exists lock_held=$tt_real_lock_held)"; fail=1
      fi

      n=$((n + 1))
      tt_base2="$(mktemp -u)"
      ( eval "$mutant_tt_src"; LAND_LOCK_FILE="$tt_base2" TQ_DELAY=3 land_lock_take_ticket >/dev/null 2>&1 ) &
      tt_mut_pid=$!
      sleep 1
      tt_mut_ticket_exists=0; [ -n "$(ls "$tt_base2.tickets" 2>/dev/null)" ] && tt_mut_ticket_exists=1
      exec {tt_fd2}>>"$tt_base2.seq.lock"
      if flock -n "$tt_fd2"; then tt_mut_lock_held=0; flock -u "$tt_fd2"; else tt_mut_lock_held=1; fi
      exec {tt_fd2}>&-
      kill "$tt_mut_pid" 2>/dev/null; wait "$tt_mut_pid" 2>/dev/null
      rm -rf "$tt_base2.tickets" "$tt_base2.seq" "$tt_base2.seq.lock" 2>/dev/null
      if [ "$tt_mut_ticket_exists" -eq 1 ] && [ "$tt_mut_lock_held" -eq 1 ]; then
        echo "  FAIL MUTATION NOT CAUGHT: the release-before-write reorder mutant should have shown the lock already free and/or the ticket not yet written mid-delay, but it matched the real (good) state"; fail=1
      else
        echo "  ok   MUTATION CAUGHT: swapping write and release (release first) leaves the lock free and/or the ticket missing mid-delay -- the real ordering does not"
      fi
    fi
  fi

  # card 81c6fbb5 (5d9731cd follow-up, CYBERSEC GO 28780 Q2b): a ticket named with pid part "0"
  # used to be immortal, because `kill -0 0` sends to the CALLER's own process group and always
  # succeeds. Red-on-4aa472b37 + green-on-the-fix, both against the REAL functions of each commit
  # (not a hand-reconstructed copy), extracted via `git show` from this same object store (the
  # worktree shares .git with $MAIN, so the pre-fix blob is reachable without a network fetch).
  n=$((n + 1))
  q2b_base="$(mktemp -u)"
  mkdir -p "$q2b_base.tickets"
  : >"$q2b_base.tickets/000000000001.0"
  old_reap_src="$(git -C "$MAIN" show 4aa472b37:store/marveen-land.sh 2>/dev/null | awk '/^land_lock_reap_stale_tickets\(\) \{$/{p=1} p{print} p&&/^}$/{exit}')"
  if [ -z "$old_reap_src" ]; then
    echo "  FAIL could not extract the pre-fix land_lock_reap_stale_tickets from commit 4aa472b37 -- cannot prove red-before-fix"; fail=1
  else
    ( LAND_LOCK_FILE="$q2b_base"; eval "$old_reap_src"; land_lock_reap_stale_tickets )
    if [ -e "$q2b_base.tickets/000000000001.0" ]; then
      echo "  ok   RED CONFIRMED ON 4aa472b37: a pid-0 ticket survives the pre-fix reap (kill -0 0 always succeeds)"
    else
      echo "  FAIL the pre-fix reap should have left the pid-0 ticket in place (it did not -- the red-before-fix premise is wrong)"; fail=1
    fi
  fi
  rm -rf "$q2b_base.tickets"
  mkdir -p "$q2b_base.tickets"
  : >"$q2b_base.tickets/000000000001.0.unknown"
  ( LAND_LOCK_FILE="$q2b_base"; land_lock_reap_stale_tickets )
  if [ -e "$q2b_base.tickets/000000000001.0.unknown" ]; then
    echo "  FAIL the fixed land_lock_reap_stale_tickets should have removed the pid-0 ticket, it did not"; fail=1
  else
    echo "  ok   GREEN ON THE FIX: a pid-0 ticket is removed unconditionally, no kill -0 0 self-group false-alive (card 81c6fbb5 Q2b)"
  fi
  rm -rf "$q2b_base.tickets" "$q2b_base.seq" "$q2b_base.seq.lock" 2>/dev/null

  # card 81c6fbb5 Q2a: a ticket whose pid was recycled (the pid is alive, but belongs to a DIFFERENT
  # process than the one that took the ticket) must still be reaped. Simulated with this process's
  # own pid ($$, genuinely alive) but a deliberately WRONG recorded start time -- exactly what a
  # ticket looks like after its pid got reused, since the new owner's start time never matches the
  # old ticket's recorded one. A positive control (this process's OWN correct ticket) proves the fix
  # is not just "remove everything live-pid".
  n=$((n + 1))
  q2a_base="$(mktemp -u)"
  mkdir -p "$q2a_base.tickets"
  : >"$q2a_base.tickets/000000000001.$$"
  old_reap_src="$(git -C "$MAIN" show 4aa472b37:store/marveen-land.sh 2>/dev/null | awk '/^land_lock_reap_stale_tickets\(\) \{$/{p=1} p{print} p&&/^}$/{exit}')"
  if [ -z "$old_reap_src" ]; then
    echo "  FAIL could not extract the pre-fix land_lock_reap_stale_tickets from commit 4aa472b37 -- cannot prove red-before-fix"; fail=1
  else
    ( LAND_LOCK_FILE="$q2a_base"; eval "$old_reap_src"; land_lock_reap_stale_tickets )
    if [ -e "$q2a_base.tickets/000000000001.$$" ]; then
      echo "  ok   RED CONFIRMED ON 4aa472b37: the pre-fix reap only checks pid liveness, so a recycled-pid ticket (same pid, wrong owner) survives forever"
    else
      echo "  FAIL the pre-fix reap should have left this live-pid ticket in place (it did not -- the red-before-fix premise is wrong)"; fail=1
    fi
  fi
  rm -rf "$q2a_base.tickets"
  mkdir -p "$q2a_base.tickets"
  own_start="$(land_lock_pid_starttime "$$")" || own_start="unknown"
  : >"$q2a_base.tickets/000000000001.$$.999999999999"
  : >"$q2a_base.tickets/000000000002.$$.$own_start"
  ( LAND_LOCK_FILE="$q2a_base"; land_lock_reap_stale_tickets )
  q2a_ok=1
  [ -e "$q2a_base.tickets/000000000001.$$.999999999999" ] && q2a_ok=0
  [ -e "$q2a_base.tickets/000000000002.$$.$own_start" ] || q2a_ok=0
  if [ "$q2a_ok" -eq 1 ]; then
    echo "  ok   GREEN ON THE FIX: a recycled-pid ticket (wrong recorded start time) is reaped, a ticket with the correct start time for the same live pid survives (card 81c6fbb5 Q2a)"
  else
    echo "  FAIL expected the wrong-start-time ticket reaped and the correct-start-time ticket kept; got wrong-start exists=$([ -e "$q2a_base.tickets/000000000001.$$.999999999999" ] && echo yes || echo no), correct-start exists=$([ -e "$q2a_base.tickets/000000000002.$$.$own_start" ] && echo yes || echo no)"; fail=1
  fi
  rm -rf "$q2a_base.tickets" "$q2a_base.seq" "$q2a_base.seq.lock" 2>/dev/null

  # card 81c6fbb5 Q1a: a deleted/corrupted seq counter file must not let a new arrival outrank
  # tickets already queued -- the floor for the next number is max(counter, any ticket already on
  # disk) + 1, not the counter alone. Red-on-4aa472b37 first (same extraction technique as Q2a/Q2b
  # above), then green on the fix, against the same fixture.
  n=$((n + 1))
  q1a_base="$(mktemp -u)"
  mkdir -p "$q1a_base.tickets"
  : >"$q1a_base.tickets/000000000005.1"
  rm -f "$q1a_base.seq" 2>/dev/null
  old_take_src="$(git -C "$MAIN" show 4aa472b37:store/marveen-land.sh 2>/dev/null | awk '/^land_lock_take_ticket\(\) \{$/{p=1} p{print} p&&/^}$/{exit}')"
  if [ -z "$old_take_src" ]; then
    echo "  FAIL could not extract the pre-fix land_lock_take_ticket from commit 4aa472b37 -- cannot prove red-before-fix"; fail=1
  else
    old_ticket="$( ( LAND_LOCK_FILE="$q1a_base"; eval "$old_take_src"; land_lock_take_ticket ) )"
    old_seq="$(basename "$old_ticket" 2>/dev/null | sed -E 's/^([0-9]{12})\..*/\1/' | sed 's/^0*//')"
    rm -f "$old_ticket" 2>/dev/null
    if [ "${old_seq:-0}" -le 5 ]; then
      echo "  ok   RED CONFIRMED ON 4aa472b37: a missing seq file resets the counter to 0, so the pre-fix next ticket (seq $old_seq) outranks the already-queued seq-5 ticket"
    else
      echo "  FAIL the pre-fix land_lock_take_ticket should have produced seq <= 5 on a missing counter file, got $old_seq -- the red-before-fix premise is wrong"; fail=1
    fi
  fi
  q1a_new_ticket="$(LAND_LOCK_FILE="$q1a_base" land_lock_take_ticket)"
  q1a_new_seq="$(basename "$q1a_new_ticket" | sed -E 's/^([0-9]{12})\..*/\1/' | sed 's/^0*//')"
  if [ "${q1a_new_seq:-0}" -gt 5 ]; then
    echo "  ok   GREEN ON THE FIX: a missing seq counter file does not let a new arrival outrank an already-queued higher ticket (got seq $q1a_new_seq, card 81c6fbb5 Q1a)"
  else
    echo "  FAIL expected the new ticket's seq to be > 5 (the existing queued ticket), got $q1a_new_seq"; fail=1
  fi
  rm -rf "$q1a_base.tickets" "$q1a_base.seq" "$q1a_base.seq.lock" 2>/dev/null

  # card 81c6fbb5 T1, mutant 1/4: the post-acquire ticket cleanup (land_one, success path) must run
  # right after the wait loop exits, BEFORE the announced-check -- without it, a land_with_retry
  # retry takes a NEW ticket while the OLD one (still on disk, same live pid) outranks it forever,
  # since nothing is polling to remove the old one. Context-anchored (the bare string
  # `rm -f "$land_lock_ticket" 2>/dev/null` appears twice in production code -- this one and the
  # give-up one below -- so each pin is scoped to its own surrounding block, not a bare count).
  n=$((n + 1))
  postacq_block="$(printf '%s\n' "$prod_src" | awk '/^    sleep "\$LAND_LOCK_POLL_S"$/{p=1} p{print} p&&/^  if \[ "\$land_lock_announced" -eq 1 \]; then$/{exit}')"
  if printf '%s\n' "$postacq_block" | grep -qF 'rm -f "$land_lock_ticket" 2>/dev/null'; then
    echo "  ok   land_one removes its own ticket right after the wait loop exits (success path), before the announced-check (card 81c6fbb5 T1)"
  else
    echo "  FAIL land_one's success path no longer removes its own ticket right after the wait loop -- a retry would queue behind its own live ticket until the cap"; fail=1
  fi

  # T1, mutant 2/4: same cleanup on the give-up (timeout) path, so an agent that stops waiting does
  # not leave a ghost ticket blocking everyone behind it for up to LAND_LOCK_WAIT_MAX_S more.
  n=$((n + 1))
  giveup_block="$(printf '%s\n' "$prod_src" | awk '/if \[ "\$land_lock_waited" -ge "\$LAND_LOCK_WAIT_MAX_S" \]; then$/{p=1} p{print} p&&/GIVING UP/{exit}')"
  if printf '%s\n' "$giveup_block" | grep -qF 'rm -f "$land_lock_ticket" 2>/dev/null'; then
    echo "  ok   land_one removes its own ticket on the give-up (timeout) path too (card 81c6fbb5 T1)"
  else
    echo "  FAIL land_one's give-up path no longer removes its own ticket -- a timed-out waiter would leave a ghost ticket blocking the queue"; fail=1
  fi

  # T1, mutants 3/4 and 4/4: land_lock_is_head must actually reap before checking who is head --
  # tested behaviorally (not just a text pin), against two shapes of the same regression: the CALL
  # being removed from is_head's body, and the call staying but land_lock_reap_stale_tickets itself
  # being gutted into a no-op. Both must leave a dead ticket permanently blocking a live one.
  n=$((n + 1))
  t1_base="$(mktemp -u)"
  mkdir -p "$t1_base.tickets"
  ( : ) & t1_dead_pid=$!
  wait "$t1_dead_pid" 2>/dev/null
  : >"$t1_base.tickets/000000000001.$t1_dead_pid.unknown"
  : >"$t1_base.tickets/000000000002.$$.$own_start"
  t1_live_ticket="$t1_base.tickets/000000000002.$$.$own_start"
  # mutant 3/4: the reap call removed from is_head's body.
  real_is_head_src="$(awk '/^land_lock_is_head\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$0")"
  mutant_no_call_src="$(printf '%s\n' "$real_is_head_src" | grep -vF 'land_lock_reap_stale_tickets')"
  if [ -z "$real_is_head_src" ] || [ "$mutant_no_call_src" = "$real_is_head_src" ]; then
    echo "  FAIL could not extract/mutate land_lock_is_head's real source from $0 -- selftest and production have drifted"; fail=1
  else
    mutant3_result="$( ( LAND_LOCK_FILE="$t1_base"; eval "$mutant_no_call_src"; land_lock_is_head "$t1_live_ticket" && echo yes || echo no ) )"
    if [ "$mutant3_result" = "no" ]; then
      echo "  ok   MUTATION CAUGHT: removing the reap call from land_lock_is_head leaves a dead ticket permanently blocking a live one (card 81c6fbb5 T1, mutant 3/4)"
    else
      echo "  FAIL removing the reap call from land_lock_is_head should have left the dead ticket blocking the live one; it did not reproduce"; fail=1
    fi
  fi
  # mutant 4/4: the call stays, but land_lock_reap_stale_tickets itself is gutted into a no-op.
  mutant4_result="$( ( LAND_LOCK_FILE="$t1_base"; land_lock_reap_stale_tickets() { :; }; land_lock_is_head "$t1_live_ticket" && echo yes || echo no ) )"
  if [ "$mutant4_result" = "no" ]; then
    echo "  ok   MUTATION CAUGHT: gutting land_lock_reap_stale_tickets into a no-op leaves the same dead ticket permanently blocking a live one (card 81c6fbb5 T1, mutant 4/4)"
  else
    echo "  FAIL gutting land_lock_reap_stale_tickets into a no-op should have left the dead ticket blocking the live one; it did not reproduce"; fail=1
  fi
  # Sanity: the REAL (unmutated) functions must resolve this same fixture correctly -- otherwise the
  # two mutation checks above would be vacuous (always "no" regardless of the mutation).
  real_result="$( ( LAND_LOCK_FILE="$t1_base"; land_lock_is_head "$t1_live_ticket" && echo yes || echo no ) )"
  if [ "$real_result" != "yes" ]; then
    echo "  FAIL the real (unmutated) land_lock_is_head should resolve the live ticket as head once the dead one is reaped -- it did not, so mutants 3/4 and 4/4 above are vacuous"; fail=1
  fi
  rm -rf "$t1_base.tickets" "$t1_base.seq" "$t1_base.seq.lock" 2>/dev/null

  # card 81c6fbb5 N1 (CYBERSEC NO-GO 28862, regression caught in re-gate): a stray non-numeric
  # file in the ticket directory must not crash the floor-scan arithmetic and refuse to issue a
  # new ticket. Red-on-2d9a0e50f (the PREVIOUS round's commit, not 4aa472b37 -- the floor-scan
  # loop that has this bug did not exist until this card, so 4aa472b37 cannot demonstrate it).
  n=$((n + 1))
  n1_base="$(mktemp -u)"
  mkdir -p "$n1_base.tickets"
  : >"$n1_base.tickets/notes.txt"
  : >"$n1_base.tickets/abc.1.x"
  : >"$n1_base.tickets/12abc.5.x"
  : >"$n1_base.tickets/-5.1.x"
  old_take_src="$(git -C "$MAIN" show 2d9a0e50f:store/marveen-land.sh 2>/dev/null | awk '/^land_lock_take_ticket\(\) \{$/{p=1} p{print} p&&/^}$/{exit}')"
  if [ -z "$old_take_src" ]; then
    echo "  FAIL could not extract the pre-N1-fix land_lock_take_ticket from commit 2d9a0e50f -- cannot prove red-before-fix"; fail=1
  else
    old_n1_result="$( ( LAND_LOCK_FILE="$n1_base"; eval "$old_take_src"; land_lock_take_ticket 2>/dev/null; echo "rc=$?" ) )"
    if printf '%s\n' "$old_n1_result" | grep -q 'rc=0'; then
      echo "  FAIL the pre-fix take_ticket should have failed (rc!=0) with a stray non-numeric file in the ticket dir -- the red-before-fix premise is wrong, got: $old_n1_result"; fail=1
    else
      echo "  ok   RED CONFIRMED ON 2d9a0e50f: a stray non-numeric file in the ticket dir crashes the pre-fix floor-scan arithmetic, take_ticket fails"
    fi
  fi
  n1_new_ticket="$(LAND_LOCK_FILE="$n1_base" land_lock_take_ticket)"
  if [ -n "$n1_new_ticket" ] && [ -e "$n1_new_ticket" ]; then
    echo "  ok   GREEN ON THE FIX: stray non-numeric files in the ticket dir are skipped (not crashed on) by the floor scan, take_ticket still issues a ticket (card 81c6fbb5 N1)"
  else
    echo "  FAIL take_ticket should still have issued a ticket with stray non-numeric files present, got: [$n1_new_ticket]"; fail=1
  fi
  rm -rf "$n1_base.tickets" "$n1_base.seq" "$n1_base.seq.lock" 2>/dev/null

  # card 81c6fbb5 N2 (CYBERSEC NO-GO 28862): the pid-0 fix (Q2b) only matched the single
  # character "0" by string comparison -- zero-padded spellings ("00", a dotless all-zero name)
  # still reach `kill -0` with the caller's own process-group semantics and survive. Red-on-
  # 2d9a0e50f, same extraction technique as N1.
  n=$((n + 1))
  n2_base="$(mktemp -u)"
  mkdir -p "$n2_base.tickets"
  : >"$n2_base.tickets/000000000001.00.unknown"
  : >"$n2_base.tickets/000000000000"
  old_reap_src="$(git -C "$MAIN" show 2d9a0e50f:store/marveen-land.sh 2>/dev/null | awk '/^land_lock_reap_stale_tickets\(\) \{$/{p=1} p{print} p&&/^}$/{exit}')"
  if [ -z "$old_reap_src" ]; then
    echo "  FAIL could not extract the pre-N2-fix land_lock_reap_stale_tickets from commit 2d9a0e50f -- cannot prove red-before-fix"; fail=1
  else
    ( LAND_LOCK_FILE="$n2_base"; eval "$old_reap_src"; land_lock_reap_stale_tickets )
    if [ -e "$n2_base.tickets/000000000001.00.unknown" ] || [ -e "$n2_base.tickets/000000000000" ]; then
      echo "  ok   RED CONFIRMED ON 2d9a0e50f: a zero-padded (\"00\") or dotless-zero pid ticket survives the pre-fix string-only \"0\" check"
    else
      echo "  FAIL the pre-fix reap should have left at least one zero-padded/dotless-zero ticket in place -- the red-before-fix premise is wrong"; fail=1
    fi
  fi
  rm -rf "$n2_base.tickets"
  mkdir -p "$n2_base.tickets"
  : >"$n2_base.tickets/000000000001.00.unknown"
  : >"$n2_base.tickets/000000000000"
  ( LAND_LOCK_FILE="$n2_base"; land_lock_reap_stale_tickets )
  if [ -e "$n2_base.tickets/000000000001.00.unknown" ] || [ -e "$n2_base.tickets/000000000000" ]; then
    echo "  FAIL the fixed reap should have removed every zero-valued pid spelling (zero-padded, dotless), at least one survived"; fail=1
  else
    echo "  ok   GREEN ON THE FIX: zero-padded and dotless-zero pid tickets are reaped via a numeric comparison, not a bare string match (card 81c6fbb5 N2)"
  fi
  rm -rf "$n2_base.tickets" "$n2_base.seq" "$n2_base.seq.lock" 2>/dev/null

  # card 81c6fbb5 N3 (CYBERSEC NO-GO 28862): a LIVE ticket written by the format this card's
  # PREVIOUS round shipped (two fields, "seq.pid", no third start-time field) must not be
  # misread as "recorded_start = the pid itself" and reaped out from under a still-queueing
  # waiter running the older code during a mixed-version rollout. Red-on-2d9a0e50f.
  n=$((n + 1))
  n3_base="$(mktemp -u)"
  mkdir -p "$n3_base.tickets"
  : >"$n3_base.tickets/000000000001.$$"
  old_reap_src="$(git -C "$MAIN" show 2d9a0e50f:store/marveen-land.sh 2>/dev/null | awk '/^land_lock_reap_stale_tickets\(\) \{$/{p=1} p{print} p&&/^}$/{exit}')"
  if [ -z "$old_reap_src" ]; then
    echo "  FAIL could not extract the pre-N3-fix land_lock_reap_stale_tickets from commit 2d9a0e50f -- cannot prove red-before-fix"; fail=1
  else
    ( LAND_LOCK_FILE="$n3_base"; eval "$old_reap_src"; land_lock_reap_stale_tickets )
    if [ -e "$n3_base.tickets/000000000001.$$" ]; then
      echo "  FAIL the pre-fix reap should have wrongly removed this live legacy-format ticket -- the red-before-fix premise is wrong"; fail=1
    else
      echo "  ok   RED CONFIRMED ON 2d9a0e50f: a LIVE two-field legacy ticket (no start-time field) is wrongly reaped (recorded_start misread as the pid itself, mismatches the live start)"
    fi
  fi
  rm -rf "$n3_base.tickets"
  mkdir -p "$n3_base.tickets"
  : >"$n3_base.tickets/000000000001.$$"
  ( LAND_LOCK_FILE="$n3_base"; land_lock_reap_stale_tickets )
  if [ -e "$n3_base.tickets/000000000001.$$" ]; then
    echo "  ok   GREEN ON THE FIX: a live two-field legacy ticket survives (dots-count detects the missing start field, pid-liveness-only check applies) (card 81c6fbb5 N3)"
  else
    echo "  FAIL the fixed reap should have kept this live legacy-format ticket, it removed it instead"; fail=1
  fi
  rm -rf "$n3_base.tickets" "$n3_base.seq" "$n3_base.seq.lock" 2>/dev/null

  # card 81c6fbb5 Q3 (CYBERSEC NO-GO 28862, "I do NOT accept the residual as written"): the three
  # fleet-test subshells in land_one must close their OWN copy of LAND_LOCK_FD before running
  # fleet-test (and its vitest workers), so a kill -9'd lander no longer leaves the develop lock
  # held by a surviving grandchild. Card 9d1ee327 (TERM-deferral fix) moved all 4 of these
  # subshells behind run_fg_killable() (a backgrounded subshell + `wait`, interruptible instead of
  # a plain foreground subshell) -- the FD-close moved WITH them, into run_fg_killable's own body
  # (one place now, not re-typed per call site), so the pin checks two things: that
  # run_fg_killable's body still closes the fd before cd/eval, and that the 3 fleet-test call
  # sites (the TEST_CMD override is a 4th, separate call site, not counted here) actually go
  # through run_fg_killable with the fleet-test command.
  n=$((n + 1))
  q3_fd_close_in_wrapper="$(printf '%s\n' "$prod_src" | grep -cF 'cd "$dir" && release_land_lock_fd && eval "$cmd"')"
  q3_fleet_test_fd_close_count="$(printf '%s\n' "$prod_src" | grep -cF 'run_fg_killable "$wt" "$MAIN/store/fleet-test.sh --ref $merge_sha"')"
  q3_fleet_test_fd_close_count=$((q3_fleet_test_fd_close_count + $(printf '%s\n' "$prod_src" | grep -cF 'run_fg_killable "$wt" "$wt/store/fleet-test.sh --ref $merge_sha"')))
  if [ "$q3_fd_close_in_wrapper" -ge 1 ] && [ "$q3_fleet_test_fd_close_count" -ge 3 ]; then
    echo "  ok   all 3 fleet-test subshells in land_one close their own copy of LAND_LOCK_FD before running fleet-test, via run_fg_killable (card 81c6fbb5 Q3, card 9d1ee327)"
  else
    echo "  FAIL expected all 3 fleet-test subshell call sites to close LAND_LOCK_FD before eval, found $q3_fleet_test_fd_close_count"; fail=1
  fi

  # card 81c6fbb5 N4 (CYBERSEC NO-GO 28862, test gap): land_lock_pid_starttime must read the
  # CORRECT /proc/<pid>/stat field (22 overall, field 20 after the comm paren) -- a wrong-field
  # mutant (e.g. field 19 instead of 20) was not caught by any existing case, because every
  # fixture compared the helper's OWN output against itself (self-consistent but not externally
  # verified). This compares against an INDEPENDENT parse of the same /proc file (python3, not
  # the function under test) for this process's own pid, so a field-index mutation in either
  # implementation would disagree with the other.
  n=$((n + 1))
  n4_own_start="$(land_lock_pid_starttime "$$")"
  n4_independent_start="$(python3 -I -c "
import sys
with open('/proc/$$/stat') as f:
    line = f.read()
rest = line.rsplit(')', 1)[1].split()
print(rest[19])
" 2>/dev/null)"
  if [ -n "$n4_own_start" ] && [ "$n4_own_start" = "$n4_independent_start" ]; then
    echo "  ok   land_lock_pid_starttime reads the same field an INDEPENDENT /proc/<pid>/stat parse does -- a wrong-field mutation would disagree (card 81c6fbb5 N4)"
  else
    echo "  FAIL land_lock_pid_starttime ([$n4_own_start]) disagrees with an independent /proc/\$\$/stat parse ([$n4_independent_start])"; fail=1
  fi

  echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
  exit $fail
fi

[ -d "$MAIN/.git" ] || die 3 "$MAIN is not a git repository"
DEFAULT_BRANCH="$(g symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
[ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="develop"
# OVERRIDE-ONLY SENTINEL (cards 88a0a5e1 / 03cff5c1). This used to hardcode $MAIN/store/fleet-test.sh
# here -- always the LIVE copy, regardless of what the landing itself changes. Two consequences,
# named separately by the two cards but one defect: (a) a landing that fixes a BUG in fleet-test.sh's
# own bash logic never gets verified against its own fix, only the stale live copy; (b) if the live
# copy is the one that's BROKEN, it blocks landing its own repair -- a chicken-and-egg deadlock
# (Cybersec, card 03cff5c1). The real default is now computed per-agent inside land_one, from that
# agent's own merge worktree ($wt), so the copy that runs is always the MERGE RESULT's own
# fleet-test.sh. MARVEEN_LAND_TEST still overrides globally (the selftest's stub), read once here.
TEST_CMD="${MARVEEN_LAND_TEST:-}"
# fleet-test.sh posts PAUSED-SEMAPHORE / RESUMED-SEMAPHORE to the landing agent's card while it
# queues for a shared CPU slot (card 492a6d5c). It cannot find that card on its own -- it takes a
# ref, not an agent -- so the caller that DOES know which agent it is landing for passes the name.
# Exported rather than argument-passed so MARVEEN_LAND_TEST overrides keep working unchanged.
export FLEET_TEST_AGENT=""
# Card f1b3f2f0. Same seam as MARVEEN_LAND_TEST and for the same reason: the selftest must exercise
# the rebuild branch without running a real 16s tsc against the live install.
BUILD_CMD="${MARVEEN_LAND_BUILD:-npm run build}"
MAX_ATTEMPTS="${MARVEEN_LAND_MAX_ATTEMPTS:-3}"
# card cd3e577b (F1, software-factory phase b8ac0ef1): set by the top-level `--card` invocation
# below, never otherwise. Tells land_one's success path to ALSO post the Gate-SHA onto the card it
# just landed, instead of only printing it for a human to copy -- the copy-paste step is exactly
# where the 51-card vacuous-Gate-SHA class (card 0711c19b, see the comment on `gate_sha` further
# down) kept entering.
CARD_BRANCH_MODE=0
# card cd3e577b R1 (MikroB decision, comment 16277 on cd3e577b): a --card landing's gate-verdict
# check runs in refuse mode (see land_one below), never report -- set only by the top-level --card
# invocation's own --allow-ungated flag, mirroring cleancore-land.sh's ALLOW_UNGATED exactly.
CARD_ALLOW_UNGATED=0
# card cd3e577b, RedHat NO-GO 16322 non-blocking R1 + MikroB decision 16324 ("--allow-ungated
# hagyjon kommentet a kartyan: ki, mikor, miert"): an ungated --card landing used to leave no trace
# on the card at all (measured: zero "ungated" comments on it), only a line in the script's own
# stdout nobody reads later. --allow-ungated-reason lets the caller say WHY in the open; _note_
# ungated_landing (defined after kanban-comment-lib.sh is sourced below) posts who/when/why.
CARD_ALLOW_UNGATED_REASON=""

# ONE LANDING AT A TIME, MACHINE-WIDE (card 24d1543f). Measured 2026-09-18 14:30-15:40: two
# `--all` sweeps plus 3 per-agent landings plus 2 CleanCore suites plus gate vitests all in flight
# together -- backend3 lost the push race 3 times in a row, and the harness memory-guard killed 3
# of backend2's background jobs (loadavg 15-20). fleet-test.sh's own internal lock (card 2f0c7d24)
# already serialises the VITEST PORTION machine-wide, but the surrounding merge/seam-check/lockfile
# work in land_one is not covered by it, and neither is the push itself -- two landings can still
# both build a merge, both pass fleet-test (each in its own turn), and then race each other's push,
# which is recoverable (card 65657bad's retry) but not free: each lost race is a full re-merge +
# re-fleet-test. This lock removes the race at the source: only one land_one body (merge through
# push) runs at a time, everyone else queues. `--all`'s own sweep loop is already sequential
# in-process (see the usage comment above); this lock is what also serialises it against a SEPARATE
# marveen-land.sh invocation (another `--all` sweep, or a direct per-agent call) running at the same
# time -- exactly the incident shape. Same PAUSED/RESUMED-SEMAPHORE courtesy as the CleanCore CPU
# pool (card 492a6d5c), via the same shared library, so a long queue does not look like a stuck card
# (rule 3/3a).
LAND_LOCK_FILE="${MARVEEN_LAND_DEVELOP_LOCK_FILE:-$MAIN/store/.marveen-land-develop.lock}"
LAND_LOCK_WAIT_MAX_S="${MARVEEN_LAND_DEVELOP_LOCK_WAIT_MAX_S:-7200}"
LAND_LOCK_POLL_S="${MARVEEN_LAND_DEVELOP_LOCK_POLL_S:-10}"
LAND_LOCK_KEEPALIVE_S="${MARVEEN_LAND_DEVELOP_LOCK_KEEPALIVE_S:-300}"
# A LOCK DIRECTORY WE CANNOT WRITE MUST SAY SO (same reasoning as cleancore-suite-run.sh's own
# LOCK_DIR check). Without this, acquire_land_lock's `: >>"$LAND_LOCK_FILE"` would fail every single
# poll and land_one would queue silently forever, indistinguishable from a real lock-holder, until
# the wait-max timeout finally reports a misleading "another landing holds the develop lock".
LAND_LOCK_DIR="$(dirname "$LAND_LOCK_FILE")"
[ -d "$LAND_LOCK_DIR" ] || die 3 "landing lock directory '$LAND_LOCK_DIR' does not exist -- refusing to run rather than silently queueing forever. Set MARVEEN_LAND_DEVELOP_LOCK_FILE."
KANBAN_COMMENT_AGENT=""
export KANBAN_COMMENT_AGENT
# shellcheck source=./kanban-comment-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kanban-comment-lib.sh"

# card cd3e577b, MikroB decision 16324: every time --allow-ungated actually tolerates a missing/
# non-AGREE verdict, say so ON THE CARD -- who (the landing agent), when (the comment's own
# timestamp), why (the specific check's reason plus the caller's own --allow-ungated-reason, if
# given). Best-effort like every other kanban_comment* call; never fails the landing itself.
_note_ungated_landing() {
  local agent="$1" card="$2" why="$3"
  local reason_line="(nincs kulon indok megadva a hivashoz)"
  [ -n "$CARD_ALLOW_UNGATED_REASON" ] && reason_line="$CARD_ALLOW_UNGATED_REASON"
  kanban_comment_on "$card" "UNGATED LANDING (--allow-ungated, $agent)

Ok: $why. Indok a hivastol: $reason_line" "$agent"
}

# Sets LAND_LOCK_FD (global, deliberately not `local` -- same shape as fleet-test.sh's own
# acquire_cpu_slot/CPU_FD) on success.
acquire_land_lock() {
  : >>"$LAND_LOCK_FILE" 2>/dev/null || return 1
  exec {LAND_LOCK_FD}>>"$LAND_LOCK_FILE" || return 1
  if flock -n "$LAND_LOCK_FD"; then return 0; fi
  # RedHat NO-GO 16486, B2': route this fd-close through release_land_lock_fd too, so there is
  # exactly ONE place in production code that closes LAND_LOCK_FD with a bare exec (the function
  # itself) -- a selftest pin below greps for that invariant across the whole file.
  release_land_lock_fd
  return 1
}

land_one() {
  local agent="$1" dry="$2"
  # card cd3e577b (F1): a THIRD, optional argument overrides which branch gets landed -- the
  # top-level `--card <id>` mode (below) passes `card/<id>` here so a card-worktree branch (created
  # by agent-worktree-marveen.sh --card) lands on its own, structurally unable to carry another
  # card's commits along, instead of the shared agent/<agent>/work branch every other card on that
  # agent also commits to. Every other reference in this function already reads `$branch`, not
  # `$agent`, for the branch name, so this is the only line that needed to change.
  local branch="${3:-agent/${agent}/work}"
  # Scoped to this landing: --all lands several agents in one run, and a stale name here would post
  # one agent's queueing notice onto another agent's card.
  export FLEET_TEST_AGENT="$agent"
  KANBAN_COMMENT_AGENT="$agent"

  g show-ref --verify --quiet "refs/heads/$branch" || { say "$agent: no branch $branch -- nothing to land"; return 0; }

  # Card a8a83d48 (F2.1.2): the branch tip BEFORE the merge commit -- what a REVIEW's Gate-SHA
  # names and what a gate actually verdicted on (see the big comment near "Gate-SHA: $gate_sha"
  # further down on why that is NOT the same as the pushed develop tip). Captured here, once, so
  # every path below (including the retry loop re-entering land_one) uses the same value.
  local work_sha; work_sha="$(g rev-parse "$branch")"

  LAND_LOCK_FD=""
  local land_lock_started land_lock_announced=0 land_lock_last_note land_lock_waited
  land_lock_started="$(date +%s)"; land_lock_last_note="$land_lock_started"
  # Card 5d9731cd: take a FIFO ticket before ever trying the mutex. Only the head of this queue
  # (land_lock_is_head) is allowed to call acquire_land_lock -- everyone else sleeps without
  # touching the flock at all, which is what makes service order follow ticket order instead of
  # poll-retry luck.
  local land_lock_ticket
  land_lock_ticket="$(land_lock_take_ticket)" || die 3 "could not create a landing-queue ticket under '$LAND_LOCK_FILE.tickets' -- refusing to run rather than silently queueing forever."
  while ! { land_lock_is_head "$land_lock_ticket" && acquire_land_lock; }; do
    land_lock_waited=$(( $(date +%s) - land_lock_started ))
    if [ "$land_lock_waited" -ge "$LAND_LOCK_WAIT_MAX_S" ]; then
      rm -f "$land_lock_ticket" 2>/dev/null
      [ "$land_lock_announced" -eq 1 ] && kanban_comment "INFO-ONLY RESUMED-SEMAPHORE (GIVING UP)

Nem kaptam landolasi zart ${LAND_LOCK_WAIT_MAX_S} masodperc alatt (kartya 24d1543f: egyszerre legfeljebb 1 landolas celozhatja origin/${DEFAULT_BRANCH}-ot). A landolas NEM futott le -- nincs pusholva, $branch erintetlen."
      echo "$agent: REFUSED -- could not acquire the landing lock after $((land_lock_waited / 60)) min (another landing is stuck holding it -- find it with 'fuser -v $LAND_LOCK_FILE'). Nothing pushed; $branch is untouched." >&2
      return 4
    fi
    if [ "$land_lock_announced" -eq 0 ]; then
      land_lock_announced=1
      echo "$agent: another landing holds the develop lock -- queueing (cap ${LAND_LOCK_WAIT_MAX_S}s)" >&2
      kanban_comment "INFO-ONLY PAUSED-SEMAPHORE

Egy masik landolas foglalja az origin/${DEFAULT_BRANCH}-ot celzo landolasi zart (kartya 24d1543f: egyszerre legfeljebb 1 landolas fut a merge+fleet-test+push ablakban, a tobbi var FIFO sorrendben, kartya 5d9731cd). Amint felszabadul, ez a landolas folytatodik, es RESUMED-SEMAPHORE kommentet kap.

Ez a komment azert van itt, hogy az updated_at mozogjon: a 3. szabaly szerint egy nem mozdulo in_progress kartya beragadtnak szamit, a 3a. szerint 60 perc utan testverre szall."
    elif [ $(( $(date +%s) - land_lock_last_note )) -ge "$LAND_LOCK_KEEPALIVE_S" ]; then
      land_lock_last_note="$(date +%s)"
      kanban_comment "INFO-ONLY PAUSED-SEMAPHORE (meg mindig sorban a landolasi zaron, $((land_lock_waited / 60)) perce)"
    fi
    sleep "$LAND_LOCK_POLL_S"
  done
  rm -f "$land_lock_ticket" 2>/dev/null
  if [ "$land_lock_announced" -eq 1 ]; then
    kanban_comment "INFO-ONLY RESUMED-SEMAPHORE

Megkaptam a landolasi zart $(( ( $(date +%s) - land_lock_started ) / 60 )) perc varakozas utan, a landolas folytatodik."
  fi

  # From here on every return path (including `die`'s exit -- closing on process exit is automatic,
  # but redefining `cleanup` below to ALSO remove the worktree needs a trap already in place) must
  # release the lock, so the trap is set right after acquiring it rather than threaded through every
  # early return by hand.
  # release_land_lock_fd (defined near the top of this file, see its own header for RedHat NO-GO
  # 16276 B2b and 16401 B2): the actual fd-close, pulled into its own function so --selftest can
  # test the real one.
  cleanup() { release_land_lock_fd; }
  trap cleanup RETURN

  g fetch -q origin "$DEFAULT_BRANCH" || die 3 "could not fetch origin/$DEFAULT_BRANCH"
  local base_sha; base_sha="$(g rev-parse "origin/$DEFAULT_BRANCH")"

  if g merge-base --is-ancestor "$branch" "origin/$DEFAULT_BRANCH" 2>/dev/null; then
    say "$agent: $branch already fully landed on origin/$DEFAULT_BRANCH -- nothing to do"
    return 0
  fi

  local wt="/home/neon/marveen-land-${agent}-$$"
  rm -rf "$wt"
  g worktree add --detach -q "$wt" "origin/$DEFAULT_BRANCH" || die 3 "could not create the landing worktree for $agent"
  # `${wt:-}` and the explicit success, both deliberate (card 65657bad, caught by its own test): the
  # RETURN trap set here also fires when land_with_retry returns, where `wt` is a dead local -- under
  # `set -u` that aborted the whole script mid-landing. Nothing to remove is not a failure, either;
  # a non-zero last command in a RETURN trap would poison the return code it is riding on. Redefines
  # `cleanup` (the trap already fires whatever `cleanup` resolves to AT TRAP TIME, so re-registering
  # is not needed) to also remove the worktree, on top of the lock release set above.
  cleanup() {
    [ -n "${wt:-}" ] && g worktree remove --force "$wt" >/dev/null 2>&1
    release_land_lock_fd
    return 0
  }

  # DECISIONS.md TAIL-APPEND PRE-CHECK (card 375a81c1), on the CARD BRANCH ALONE, before the merge
  # is even attempted. $wt's HEAD is origin/$DEFAULT_BRANCH right now (just checked out above), so
  # its merge-base with $branch is exactly the branch's own fork point.
  local _dtag_mb; _dtag_mb="$(git -C "$wt" merge-base HEAD "$branch" 2>/dev/null)"
  [ "$ALLOW_ARCHIVE" -eq 1 ] && say "$agent: allow-archive: 90-day distillation accepted on $branch (explicitly passed by caller)"
  if [ -n "$_dtag_mb" ] && ! decisions_tail_append_ok "$wt" "$_dtag_mb" "$branch" "DECISIONS.md" "$ALLOW_ARCHIVE"; then
    echo "$agent: REFUSED -- DECISIONS.md on $branch is not a pure tail append (see the lines above)."
    echo "$agent: Move the new/continued entry to the file's own end, referencing the parent entry"
    echo "$agent: by date/title, and re-push."
    return 4
  fi

  # What ELSE rides along (card dfff9b37). Runs BEFORE the merge, so a refusal costs nothing and a
  # report is on screen at the one moment somebody is watching this landing. Merges dropped -- see
  # decision 3 in landing-downward-check.sh.
  local down_log
  down_log="$(g log --no-merges --format='%h%x09%s' "origin/$DEFAULT_BRANCH..$branch")"
  downward_check "$down_log" "$LAND_CARD" "$ALLOW_STACKED" "$([ -n "$LAND_CARD" ] && echo 1 || echo 0)" "$agent" || {
    echo "$agent: REFUSED -- commits belonging to OTHER cards are in $branch. Nothing merged, nothing pushed."
    return 4
  }

  # Only when the caller NAMED the card -- without one there is no single card to ask about, since
  # a marveen branch legitimately carries several. Report-only, for the reason in the source note.
  # THE SECOND ARGUMENT IS A SHA, NOT A BRANCH (card 171c9f42). It used to be "$branch", and the
  # parser compares HEX PREFIXES -- so an agent branch name could never match anything, and a fully
  # gated card (QA PASS + Cybersec GO) produced the same "no verdict for this sha" line as a card
  # with no verdict at all. The check ran, printed, and told us nothing.
  #
  # AND THE `|| true` IS GONE. In report mode the helper already returns 0 for every outcome except
  # a FAILING verdict, so `|| true` swallowed the one answer worth acting on: it made a QA FAIL
  # indistinguishable from a pass, on the branch about to be merged.
  # N2 (MikroB decision 16402, RedHat NO-GO 16401 finding N2): _note_ungated_landing used to be
  # called from inside this gate-check block, i.e. BEFORE the merge/fleet-test/push even run --
  # measured live: a fleet-test failure after an --allow-ungated tolerance left 2 "UNGATED LANDING"
  # comments on a card whose branch never actually landed (rc 4, nothing pushed). Collected here
  # instead and only posted once the push is CONFIRMED to have landed, further down.
  local -a _ungated_pending=()
  if [ -n "$LAND_CARD" ]; then
    local land_sha
    land_sha="$(git -C "$wt" rev-parse "$branch" 2>/dev/null)" || land_sha="$branch"
    # card cd3e577b R1 (MikroB decision 16277): a --card landing is the "gate first, land after"
    # path this feature exists to build, so CARD_BRANCH_MODE switches the check to refuse mode --
    # the agent/<agent>/work path stays report-only (that sha does not exist yet when its own gate
    # ran, see this file's header comment on gate_verdict_check).
    local verdict_mode="report"
    [ "$CARD_BRANCH_MODE" = "1" ] && verdict_mode="refuse"
    GATE_CHECK_OVERRIDE_ARMED="$CARD_ALLOW_UNGATED" gate_verdict_check "$LAND_CARD" "$land_sha" "$verdict_mode"
    local gate_rc=$?
    if [ "$gate_rc" -eq 2 ]; then
      echo "$agent: REFUSED -- card $LAND_CARD carries a FAILING gate verdict for $land_sha."
      echo "$agent: Nothing merged, nothing pushed. Fix the finding and re-gate."
      return 5
    elif [ "$gate_rc" -ne 0 ] && [ "$verdict_mode" = "refuse" ]; then
      if [ "$CARD_ALLOW_UNGATED" = "1" ]; then
        say "$agent: gate-check: no usable verdict, TOLERATED by --allow-ungated -- this landing is deliberately ungated"
        _ungated_pending+=("no usable QA verdict for $land_sha")
      else
        echo "$agent: REFUSED -- card $LAND_CARD has no passing gate verdict for $land_sha."
        echo "$agent: --card landings require one; override with --allow-ungated if this is deliberate."
        return 6
      fi
    fi

    # card cd3e577b, MikroB decision 16324: the QA-mandatory check above is not enough on its own --
    # every gate the card's OWN "Gate:" line/labels designate must AGREE on this sha, not just QA.
    if [ "$verdict_mode" = "refuse" ]; then
      card_designated_gates_agree "$LAND_CARD" "$land_sha"
      local designation_rc=$?
      if [ "$designation_rc" -eq 2 ]; then
        echo "$agent: REFUSED -- card $LAND_CARD's designated gates carry a FAILING verdict for $land_sha."
        echo "$agent: Nothing merged, nothing pushed. Fix the finding and re-gate."
        return 5
      elif [ "$designation_rc" -ne 0 ]; then
        if [ "$CARD_ALLOW_UNGATED" = "1" ]; then
          say "$agent: designated-gate-check: no AGREE from the card's designated gates, TOLERATED by --allow-ungated"
          _ungated_pending+=("the card's designated gates do not all AGREE on $land_sha")
        else
          echo "$agent: REFUSED -- card $LAND_CARD's designated gates do not all AGREE on $land_sha."
          echo "$agent: --card landings require this; override with --allow-ungated if this is deliberate."
          return 6
        fi
      fi
    fi
  fi

  # Cybersec2 NO-GO 28230 F7 on card a8a83d48: card_id in a card_landings row used to be bound to
  # a commit SUBJECT the server could scan, which the fix for F4/F5 removed (text scan = ReDoS +
  # forgeable range). The replacement binding is structural (work_sha == merge_sha's second
  # parent) but said nothing about WHICH card -- any caller could claim any real card_id for a
  # genuine, unrelated landing. --card mode already carries its card id in $branch itself
  # ("card/<id>", a substring of $msg below); agent mode's branch name ("agent/<agent>/work")
  # never did, so this is the one place that needs an explicit line. Built from the SAME down_log
  # the dispatch above already computed (before the merge), not from anything the committer typed.
  local merge_cards=""
  if [ -z "$LAND_CARD" ]; then
    merge_cards="$(printf '%s\n' "$down_log" | distinct_cards | tr '\n' ' ')"
    merge_cards="${merge_cards% }"
  fi
  local msg="merge: $branch into $DEFAULT_BRANCH (marveen-land, base @ $(git -C "$wt" rev-parse --short HEAD))"
  if [ -n "$merge_cards" ]; then
    msg="$msg

Cards: $merge_cards"
  fi
  local merge_err
  if ! merge_err="$(git -C "$wt" -c user.email=mikrob@marveen.local -c user.name=mikrob \
                    merge --no-ff "$branch" -m "$msg" 2>&1)"; then
    local conflicted; conflicted="$(git -C "$wt" diff --name-only --diff-filter=U)"
    # NARROW AUTO-UNION (card cbb66abf): only when DECISIONS.md is the SOLE conflicted file, and
    # only when try_append_union structurally confirms both sides purely appended -- see
    # decisions-append-union.sh for the full precondition and why it is safe to complete the merge
    # rather than abort it here. Everything else falls through to the unchanged refusal below.
    if [ "$conflicted" = "DECISIONS.md" ] && try_append_union "$wt" "DECISIONS.md"; then
      say "$agent: DECISIONS.md: both sides purely appended -- auto-unioned, header count verified"
      git -C "$wt" -c user.email=mikrob@marveen.local -c user.name=mikrob commit --no-edit -q \
        || { echo "$agent: auto-unioned DECISIONS.md but the merge commit itself failed"; return 4; }
    elif [ "$conflicted" = "README.md" ] && try_readme_bullet_union "$wt" "README.md"; then
      # SEPARATE TOOL, NOT A WIDENING of the DECISIONS union (card 8b73953c, variant (b)). The two
      # files collide in different shapes: DECISIONS.md grows at the TAIL, README's fork section is
      # a run of single-line `- **` bullets in the MIDDLE, with prose before it and a sub-heading
      # plus a doc table after. Measured before building: of the ways two branches add a bullet,
      # only insertions at the SAME point conflict at all -- far apart and even ADJACENT ones git
      # merges cleanly, so this one shape is 100% of the real cases.
      say "$agent: README.md: both sides appended a bullet at the same point -- auto-unioned"
      git -C "$wt" -c user.email=mikrob@marveen.local -c user.name=mikrob commit --no-edit -q \
        || { echo "$agent: auto-unioned README.md but the merge commit itself failed"; return 4; }
    elif [ -n "$conflicted" ]; then
      echo "$agent: CONFLICTS in:"; echo "$conflicted" | sed 's/^/    /'
      git -C "$wt" merge --abort 2>/dev/null
      return 4
    else
      echo "$agent: MERGE FAILED (not a content conflict) -- git says:"; echo "$merge_err" | sed 's/^/    /'
      git -C "$wt" merge --abort 2>/dev/null
      return 4
    fi
  fi
  local merge_sha; merge_sha="$(git -C "$wt" rev-parse HEAD)"
  # Card 0711c19b: the sha that CARRIES this card's files, captured here because the fork-own
  # version bump below commits a CHILD on top and reassigns merge_sha to it. merge_sha keeps its
  # existing meaning -- the tip about to be tested and pushed -- and every downstream use still
  # wants that tip (fleet-test runs on what actually lands, so does the ancestry check and the
  # src/ diff that triggers the rebuild). The one consumer that wants the OTHER sha is a human
  # copying a Gate-SHA into a REVIEW, and the report at the end of this function now says so.
  local gate_sha="$merge_sha"
  say "$agent: merged --no-ff, no conflicts ($(git -C "$wt" diff --name-only "$base_sha..HEAD" | wc -l) file(s) changed since $DEFAULT_BRANCH base)"

  # SEAM CHECK, both directions (same reasoning as cleancore-land.sh): "no conflict" only means git
  # found no OVERLAPPING hunks, not that both sides' additions to a shared file both survived.
  local mb; mb="$(g merge-base "$branch" "$base_sha")"
  local branch_files main_files overlap
  branch_files="$(g diff --name-only "$mb..$branch")"
  main_files="$(g diff --name-only "$mb..$base_sha")"
  overlap="$(comm -12 <(echo "$branch_files" | sort) <(echo "$main_files" | sort))"
  if [ -n "$overlap" ]; then
    local lost=0 f line body
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      if [ ! -f "$wt/$f" ]; then
        # Absent from BOTH tips = both sides deleted it, the merge is right to drop it (card b79078b5).
        # Absent from only one tip: the other side's content is gone, that is a real seam loss.
        if ! g cat-file -e "$branch:$f" 2>/dev/null && ! g cat-file -e "$base_sha:$f" 2>/dev/null; then continue; fi
        echo "$agent: SEAM FAIL: $f is missing from the merge result"; lost=$((lost+1)); continue
      fi
      while IFS= read -r line; do
        case "$line" in (''|'+++'*) continue ;; esac
        body="${line#+}"
        [ -n "${body// }" ] || continue
        grep -qF -- "$body" "$wt/$f" || { echo "$agent: SEAM FAIL in $f: dropped line: ${body:0:90}"; lost=$((lost+1)); }
      done < <(g diff "$mb..$branch" -- "$f" | grep '^+')
      while IFS= read -r line; do
        case "$line" in (''|'+++'*) continue ;; esac
        body="${line#+}"
        [ -n "${body// }" ] || continue
        grep -qF -- "$body" "$wt/$f" || { echo "$agent: SEAM FAIL in $f: $DEFAULT_BRANCH's own line dropped: ${body:0:90}"; lost=$((lost+1)); }
      done < <(g diff "$mb..$base_sha" -- "$f" | grep '^+')
    done < <(echo "$overlap")
    [ "$lost" -eq 0 ] || { echo "$agent: REFUSED, $lost seam loss(es)"; git -C "$wt" reset -q --hard "$base_sha"; return 4; }
    say "$agent: seam: $(echo "$overlap" | wc -l) shared file(s) checked in both directions, clean"
  else
    say "$agent: seam: no file touched by both sides"
  fi

  # npm lockfile drift on the MERGE RESULT (card c3f052ad). marveen is an npm repo, and the
  # pnpm-only store/lockfile-sync-check.sh never checked anything here -- it reported
  # ERR_PNPM_NO_LOCKFILE as drift on every landing until card fe06da0c made that "not applicable".
  # Fixing the noise left the real hole open: a dependency declared in package.json without
  # regenerating package-lock.json still reaches the deploy unseen, which is the exact incident
  # class (twice in one day, cards 8d673233 and af7441a3) that produced the pnpm check.
  #
  # ON THE MERGE RESULT, not the branch: two branches that are each internally consistent can
  # merge into an inconsistent whole (one adds a dependency, the other regenerates the lock), and
  # what matters is what LANDS. --base origin/<default> keeps it free on the majority of landings,
  # which touch no manifest at all.
  #
  # REFUSES ON 1, NEVER ON 3, mirroring cleancore-land.sh's pnpm refusal: "the lockfile is stale"
  # and "this lockfile shape is one the checker cannot read" are different facts, and treating a
  # harness fault as a policy would silently block every landing.
  NPM_LF_OUT="$("$(dirname "$0")/npm-lockfile-sync-check.sh" --repo "$wt" --ref "$merge_sha" --base "origin/$DEFAULT_BRANCH" 2>&1)"
  case $? in
    1)
      echo "$agent: REFUSED -- package-lock.json does not match package.json on the merge result."
      echo "$NPM_LF_OUT"
      echo "Regenerate the lockfile (npm install --package-lock-only) on $branch, re-gate, and land again. Nothing pushed; $branch is untouched."
      return 4 ;;
    3) say "$agent: npm lockfile check skipped (harness fault, not a verdict): $(printf '%s' "$NPM_LF_OUT" | head -1)" ;;
    *) : ;;
  esac

  # Main-version catch-up (card 165350f1), BEFORE the fork-own +mikrob.N bump below, same commit:
  # bump-fork-version.sh only ever touches +mikrob.N and documents X.Y.Z as "a SEPARATE flow this
  # script never touches" -- that flow never existed, so an upstream-sync merge (Köteg N cards,
  # landed by a separate ad hoc flow, not this script) left X.Y.Z frozen even once a higher
  # upstream vX.Y.Z tag became an ancestor of develop. Hooking the check in HERE, on every
  # fork-own landing, means X.Y.Z self-corrects on the next landing after ANY upstream-sync merge
  # lands, without relying on that separate flow to remember to call it. No-op (prints
  # "unchanged:...") on the overwhelming majority of landings, where no newer tag is an ancestor.
  if [ "$dry" != "1" ]; then
    if ! upstream_ver="$(bump_upstream_version "$wt" 2>&1)"; then
      say "$agent: upstream main-version check skipped ($upstream_ver) -- landing continues unbumped"
    elif [[ "$upstream_ver" != unchanged:* ]]; then
      say "$agent: main version caught up to $upstream_ver (upstream-sync ancestor tag)"
    fi
  fi

  # Fork-own version bump (DECISIONS.md 2026-08-20/25, automated 2026-08-26 per Peti request):
  # every fork-own landing bumps package.json's +mikrob.N build-metadata, keeping package-lock.json's
  # own version fields in sync too. Skipped on --dry-run (nothing gets pushed, so nothing to bump).
  # NON-FATAL by construction, same as the blast-radius/graphify steps further down this function:
  # this script's job is landing CODE safely, and a version-metadata hiccup must never be the reason
  # a real fork commit fails to land. On failure the merge lands with its N unbumped -- annoying, not
  # dangerous -- and the next successful landing's fresh re-read simply bumps from whatever N is
  # actually on disk.
  if [ "$dry" != "1" ]; then
    if new_ver="$(bump_fork_version "$wt" 2>&1)"; then
      git -C "$wt" add package.json package-lock.json 2>/dev/null
      if git -C "$wt" -c user.email=mikrob@marveen.local -c user.name=mikrob \
            commit -q -m "chore(version): bump to $new_ver (marveen-land, $agent)"; then
        merge_sha="$(git -C "$wt" rev-parse HEAD)"
        say "$agent: version bumped to $new_ver"
      else
        say "$agent: version bump produced no changes to commit -- left as-is"
      fi
    else
      say "$agent: version bump skipped ($new_ver) -- landing continues unbumped"
    fi
  fi

  # Cards 88a0a5e1 / 03cff5c1, NARROWED by Cybersec NO-GO (same cards, comment 3431) after the
  # first version of this fix over-widened it. The first version defaulted EVERY landing's judge
  # to $wt/store/fleet-test.sh -- the LANDING BRANCH'S OWN, never-yet-gated copy -- not just the
  # ones that actually touch fleet-test.sh. Since marveen-land.sh is the ONLY automated technical
  # gate a branch crosses BEFORE human/QA/Cybersec review (this repo's own design: "Marveen gates
  # AFTER landing"), and `eval "$test_cmd $merge_sha"` runs with the landing shell's own rights, no
  # sandbox -- that made every branch, gated or not, its own judge. A branch could ship a
  # fleet-test.sh that always exits 0, skips security-relevant suites, or runs arbitrary code in
  # the landing process, and nothing here would catch it.
  #
  # THE NARROW CASE THE ORIGINAL BUG WAS ABOUT is real and stays fixed: a branch that ACTUALLY
  # modifies store/fleet-test.sh's own orchestration logic must be verified by running that
  # modification, not a stale reviewed copy that cannot see it. So the choice of judge now turns on
  # whether THIS branch touches that one file, decided against $mb (the branch's actual merge-base
  # with $base_sha, already computed above for the seam-check), not $base_sha itself.
  #
  # Card 728bd10d: this used to diff "$base_sha..$branch" directly. For a long-lived agent branch
  # that has not rebased, $base_sha..$branch is a two-dot diff whose left side is develop's CURRENT
  # tip, not the branch's actual fork point -- so it ALSO picks up any store/fleet-test.sh change
  # that landed on develop AFTER the branch forked, purely on develop's own side, unrelated to the
  # branch. That false positive does not corrupt the verdict (both copies still have to pass
  # either way), it just forces the costly dual-copy run (both lines 851-860 below) on a landing
  # that never touched fleet-test.sh itself -- measured at +5-10 minutes. $mb is the correct anchor:
  # it is the last commit the branch and develop actually share, so diffing $mb..$branch only sees
  # what the BRANCH changed.
  local touched_fleet_test
  touched_fleet_test="$(g diff --name-only "$mb..$branch" -- store/fleet-test.sh)"
  # card 81c6fbb5 (CYBERSEC NO-GO 28862, Q3): fleet-test (and its vitest workers) used to inherit
  # LAND_LOCK_FD across these subshells -- a kill -9'd lander whose fleet-test child survives kept
  # the develop lock held with nobody left to release it, until the 7200s give-up cap. Each
  # subshell below now closes ITS OWN copy of the fd (release_land_lock_fd, the same real
  # fd-close land_one's own cleanup() uses -- a subshell close never touches the parent's fd) as
  # the FIRST thing it does, before cd or eval; `&&` means a cd failure still short-circuits
  # exactly as before (release_land_lock_fd always returns 0, so it never changes which branch
  # the surrounding `if !` takes).
  if [ -n "$TEST_CMD" ]; then
    # Env override wins outright (selftest stub) -- exactly the old, single-judge behaviour.
    # shellcheck disable=SC2086 -- TEST_CMD is an intentional word-split command prefix
    if ! run_fg_killable "$wt" "$TEST_CMD $merge_sha"; then
      echo "$agent: REFUSED -- fleet-test failed on the merge result. Nothing pushed; $branch is untouched."
      return 4
    fi
    say "$agent: fleet-test green on the merge result"
  elif [ -z "$touched_fleet_test" ]; then
    # THE SAFE DEFAULT, UNCHANGED FROM BEFORE THIS CARD PAIR: the branch has no reason to be its
    # own judge, so the judge stays the ALREADY-REVIEWED live copy at $MAIN.
    if ! run_fg_killable "$wt" "$MAIN/store/fleet-test.sh --ref $merge_sha"; then
      echo "$agent: REFUSED -- fleet-test failed on the merge result (judged by \$MAIN's already-reviewed copy). Nothing pushed; $branch is untouched."
      return 4
    fi
    say "$agent: fleet-test green on the merge result (judged by \$MAIN's already-reviewed copy -- $branch does not touch store/fleet-test.sh)"
  else
    # THE NARROW CASE: this branch DOES touch fleet-test.sh. BOTH copies must agree -- the
    # TRUSTED $MAIN copy proves the rest of the branch does not regress under a judge the branch
    # cannot have tampered with; the branch's OWN $wt copy proves its fleet-test.sh change actually
    # works. Twice the cost, paid only on the rare landing that touches this one file, in exchange
    # for closing the "the fox guards the henhouse" hole Cybersec measured (comment 3431).
    say "$agent: $branch touches store/fleet-test.sh -- requiring BOTH the trusted \$MAIN copy AND the branch's own copy to pass (Cybersec NO-GO, cards 88a0a5e1/03cff5c1)"
    if ! run_fg_killable "$wt" "$MAIN/store/fleet-test.sh --ref $merge_sha"; then
      echo "$agent: REFUSED -- fleet-test (the trusted \$MAIN copy) failed on the merge result. Nothing pushed; $branch is untouched."
      return 4
    fi
    say "$agent: fleet-test (the trusted \$MAIN copy) green"
    if ! run_fg_killable "$wt" "$wt/store/fleet-test.sh --ref $merge_sha"; then
      echo "$agent: REFUSED -- fleet-test (the branch's OWN fleet-test.sh) failed on the merge result. Nothing pushed; $branch is untouched."
      return 4
    fi
    say "$agent: fleet-test (the branch's own copy) also green -- its own fleet-test.sh change verifies itself"
  fi

  # Merge-conflict marker check (card 4b4c89eb) -- see store/conflict-marker-check.sh for the
  # incident this closes and why only the two unambiguous markers are checked.
  local conflict_markers
  conflict_markers="$(find_conflict_markers "$wt")"
  if [ -n "$conflict_markers" ]; then
    echo "$agent: REFUSED -- unresolved merge-conflict markers are in the merge result. Nothing pushed; $branch is untouched."
    echo "$conflict_markers" | sed 's/^/    /'
    git -C "$wt" reset -q --hard "$base_sha"
    return 4
  fi
  say "$agent: no merge-conflict markers in the merge result"

  # Decision-conflict report (card 4a769a34, Trail-ötlet 2): does this landing's diff touch a file a
  # past DECISIONS.md entry made a call about? Report-only, never refuses -- see
  # decisions-conflict-check.sh's header for why. Uses decisions_conflict_diff_paths (not a plain
  # `diff --name-only`) so a renamed file's old path and a non-ASCII path are never silently missed
  # (card 40b5038f, WhiteHat F1a/F1b), and reads DECISIONS.md at base_sha, not merge_sha -- this
  # landing's OWN freshly-appended entry must never be quoted back as if it were an earlier decision
  # (card 40b5038f, WhiteHat F3).
  local -a _dcr_files=()
  while IFS= read -r _dcr_f; do [ -n "$_dcr_f" ] && _dcr_files+=("$_dcr_f"); done \
    < <(decisions_conflict_diff_paths "$MAIN" "$base_sha" "$merge_sha" . ':!DECISIONS.md' ':!package.json' ':!package-lock.json')
  if [ "${#_dcr_files[@]}" -gt 0 ]; then
    local _dcr_out
    _dcr_out="$(git -C "$wt" cat-file blob "$base_sha:DECISIONS.md" 2>/dev/null | decisions_conflict_report "${_dcr_files[@]}")"
    [ -n "$_dcr_out" ] && { echo "$agent: decision-conflict report (earlier DECISIONS.md entries about files in this diff):"; echo "$_dcr_out" | sed 's/^/    /'; }
  fi

  if [ "$dry" = "1" ]; then say "$agent: DRY-RUN -- not pushing"; return 0; fi

  # Card 65657bad: this used to be `>/dev/null 2>&1`, so PUSH FAILED never said why. On a fleet that
  # lands often the usual cause is a LOST RACE -- another agent pushed during our merge+test window,
  # leaving this push non-fast-forward -- which is not a fault at all. Indistinguishable from a real
  # one (credentials, network, a rejecting hook) without git's own words, so two agents re-ran the
  # whole landing by hand to find out. Print them.
  local push_err
  if ! push_err="$(git -C "$wt" push origin "HEAD:$DEFAULT_BRANCH" 2>&1)"; then
    echo "$agent: PUSH FAILED -- git says:"; echo "$push_err" | sed 's/^/    /'
    # A race is the one failure worth retrying, and only these exact markers identify it -- they are
    # what git prints for a non-fast-forward. Matching a bare "rejected" would also catch a
    # pre-receive hook REFUSING the push, which is a decision, not a race: retrying that burns
    # another full merge+verify cycle and fails again for the same reason.
    case "$push_err" in
      *"(fetch first)"*|*"(non-fast-forward)"*) return 5 ;;
    esac
    return 4
  fi
  g fetch -q origin "$DEFAULT_BRANCH"
  if g merge-base --is-ancestor "$merge_sha" "origin/$DEFAULT_BRANCH"; then
    # $branch itself is left untouched here on purpose: it is now an ancestor of origin/$DEFAULT_BRANCH,
    # so the agent's own next agent-worktree-marveen.sh top-up (or a plain `git pull --ff-only` inside
    # their persistent worktree) fast-forwards it there automatically. No reset attempted against a
    # branch that IS the agent's own currently-checked-out worktree.
    # SYNC FIRST, THEN INDEX (card d2f4b273). Both graph tools read the WORKING TREE -- graphify
    # and code_review_graph discover changed files with `git diff --name-status -z <base> --`, no
    # second revision -- so refreshing before the live install has been fast-forwarded indexes the
    # PRE-landing tree and records the pre-landing sha. The graph was therefore always one landing
    # behind here, quietly: the refresh reported success, just about the wrong commit. The three
    # lines below used to run in the opposite order.
    sync_live_install
    # Same reason as in cleancore-land.sh: the blast-radius graph must follow the landed state,
    # or the guard silently stops enforcing. Non-fatal by construction.
    "$(dirname "$0")/blast-radius-check.py" --refresh "$MAIN" 2>&1 | sed 's/^/  /' || true
    # The graphify code-graph feeds the local model's RAG context at dispatch
    # (card 44477615). It rotted the same way the blast-radius graph did -- built once
    # on adoption day, then 24 days stale -- so it follows the landed state here too.
    # Incremental (~13s on marveen) and non-fatal: a graph refresh must not fail a landing.
    "$(dirname "$0")/graphify.sh" build "$MAIN" 2>&1 | tail -1 | sed 's/^/  graphify: /' || true
    # Card 77075367 made this gap VISIBLE at land time, after a gated security fix (f0389e81) sat
    # inactive for ~1h. Card f1b3f2f0 CLOSES it instead: a src/-touching land now rebuilds dist/
    # here. The restart half of 77075367's decision is unchanged -- still ./update.sh, still
    # confirmed -- and scripts/build-freshness-guard.sh stays the backstop for when this step is
    # skipped or fails.
    if git -C "$wt" diff --name-only "$base_sha..$merge_sha" -- src/ | grep -q .; then
      rebuild_live_install
    fi
    # MT-09 (card 9e2c33c2): re-check knowledge-graph anchors on the files this landing touched.
    # Behind KG_ENABLED, default off -- a no-op (exits 0, prints nothing) until that switch is on,
    # so this line changes nothing about today's landing behavior. Non-fatal by construction, same
    # as the blast-radius/graphify steps above.
    "$(dirname "$0")/kg-check-landing.sh" --repo marveen --repo-dir "$wt" --base "$base_sha" \
      --sha "$merge_sha" --actor "marveen-land:$agent" --main-dist "$MAIN/dist" 2>&1 | sed 's/^/  /' || true
    echo "$agent: LANDED $branch -> origin/$DEFAULT_BRANCH (develop tip $(git -C "$wt" rev-parse --short HEAD))"
    # Card a8a83d48 (F2.1.2): record this VERIFIED landing. One row per card this push actually
    # carries -- LAND_CARD alone in --card mode (that branch carries exactly one card, by
    # construction), else every card named in down_log (the commits this push just merged). The
    # server re-verifies merge_sha's ancestry itself before writing, so this call is informational,
    # never a gate the push itself depends on -- a failed call leaves a gap 3b82961f's
    # `--record-landing` repair flag closes, it does not undo an already-successful push.
    #
    # Cybersec2 NO-GO 28230 F6: this MUST be $gate_sha, not $merge_sha. $merge_sha gets reassigned
    # above (line ~811) to the +mikrob version-bump CHILD commit once one is made; $gate_sha keeps
    # its original meaning, the actual merge that carries this card's files. The server's
    # second-parent check (work_sha == merge_sha^2) has no second parent on a one-parent bump
    # child, so passing $merge_sha here made every normal landing's record_card_landing call 422,
    # silently swallowed by the caller's best-effort curl.
    if [ -n "$LAND_CARD" ]; then
      record_card_landing "$LAND_CARD" "$work_sha" "$gate_sha" marveen "$agent"
    else
      local _lc
      for _lc in $(printf '%s\n' "$down_log" | distinct_cards); do
        record_card_landing "$_lc" "$work_sha" "$gate_sha" marveen "$agent"
      done
    fi
    # Card 0711c19b, reported three times before it got a card. This line used to print ONLY the
    # develop tip, and on every landing since the version bump was automated (ea8b9b95) that tip is
    # a `chore(version)` child holding one line of package.json -- none of the card's files. Taken
    # at face value it produces a REVIEW whose Gate-SHA names a commit the card did not deliver.
    #
    # Measured on this board before the fix: 82 distinct version-bump shas appear on a `Gate-SHA:`
    # line across 51 cards, written by BUILDERS AND GATES ALIKE (qa, cybersec and cybered are all
    # among the authors) -- so it is not one agent's slip, it is what the tool told everyone.
    #
    # It also disarms the guard meant to catch exactly this. gate-closure-check.py compares the two
    # shas over "every file the declared commit delivers", minus package.json/DECISIONS.md/README.md
    # as known per-landing churn. A bump commit delivers package.json and NOTHING ELSE, so that
    # subtraction empties the comparison set and the check reports AGREE having compared zero files
    # -- the same vacuous pass its own `if not files: continue` guard was written to prevent, coming
    # in through the churn filter instead of the empty-list path. Verified live on 99fccbcf,
    # e5b7ff19, a14812e8 and f1b3f2f0.
    #
    # Printed at line start and in the exact shape a REVIEW needs, so the correct answer is the one
    # that is easy to copy. Fixing the source does not heal the 51 cards already written this way.
    echo "Gate-SHA: $gate_sha"
    [ "$gate_sha" = "$merge_sha" ] || say "$agent: the develop tip above is the +mikrob version bump committed on top of that merge -- it carries no card content, do not put it in the REVIEW"
    # card cd3e577b (F1): the --card top-level mode knows LAND_CARD is exactly the card this branch
    # belongs to (by construction -- card/<id> only ever carries that one card's commits), so it can
    # post the Gate-SHA onto the card directly instead of leaving it to be copied by hand into a
    # REVIEW comment. kanban_comment_on, not kanban_comment: the latter looks up "the agent's own
    # in_progress card by assignee", which is the wrong card if the agent has moved on to something
    # else by the time this landing (possibly queued behind the develop lock for a while) finishes.
    #
    # R1 fix (RedHat NO-GO 16276, B1): this is a POST-landing comment, after the REVIEW that already
    # carries the card's real Gate-SHA (the sha the gate actually verdicted on). gate-closure-check.py
    # reads the Gate-SHA line of the comment AFTER the latest REVIEW as a newly-declared sha with no
    # verdict of its own -- so a sor-elejen "Gate-SHA:" line here drops every successful --card
    # landing to STALE, and the gate-reconciler can never close it. "Merge-SHA:" is not that keyword
    # (measured against the real tool: a "Merge-SHA:" line, or the same sha only mentioned mid-
    # sentence, still gives AGREE), so this comment uses it instead -- the merge sha IS useful
    # information (it is what actually landed), it just must not look like a fresh gate declaration.
    if [ "$CARD_BRANCH_MODE" = "1" ] && [ -n "$LAND_CARD" ]; then
      # N1 (MikroB decision 16402): print the designation this landing actually checked against,
      # so a later weakening of the card's "Gate:" line (editable by anyone, not re-snapshotted) is
      # visible on the card itself instead of silent. "nincs kijelolve" when the card designated
      # nothing beyond the QA mandate (card_designated_gates_agree's CARD_DESIGNATED_GATES_CSV is
      # only set once the board was actually read, i.e. whenever LAND_CARD is set and the branch
      # got this far -- empty is a real answer, not "unknown").
      local _designated_note="${CARD_DESIGNATED_GATES_CSV:-nincs kijelolve}"
      [ -n "$_designated_note" ] || _designated_note="nincs kijelolve"
      kanban_comment_on "$LAND_CARD" "LANDOLVA (automatikus, marveen-land.sh --card)
Merge-SHA: $gate_sha (a gate altal mar verdiktelt Gate-SHA a korabbi REVIEW-ban all)
Designated: $_designated_note"
      # N2: ungated tolerances collected above are posted ONLY now, after the push is confirmed to
      # have actually landed -- never for a run that got this far and then failed later (there is
      # no "later" past this point in land_one).
      local _ungated_why
      for _ungated_why in "${_ungated_pending[@]}"; do
        _note_ungated_landing "$agent" "$LAND_CARD" "$_ungated_why"
      done
    fi
    return 0
  fi
  echo "$agent: PUSH reported success but $merge_sha is NOT an ancestor of origin/$DEFAULT_BRANCH -- verify by hand"
  return 4
}

# A raced push is retried from the TOP, not by pushing again: the base moved, so the merge result
# fleet-test approved no longer describes what would land. Re-merging and re-verifying is this
# script's whole point -- pushing the already-tested merge onto a different base, or skipping the
# re-test to save two minutes, would put code on develop that no fleet-test ever saw.
land_with_retry() {
  local agent="$1" dry="$2" branch_override="${3:-}" attempt=1 rc
  local disp_branch="${branch_override:-agent/${agent}/work}"
  # card 88b67fb4, requirement 2: journal this run (started/heartbeat/finished) so a killed process
  # (fullstack's land run that nobody saw die) shows up as STALE later instead of leaving no trace
  # at all. Best-effort: a journal write failure must never fail or block a landing.
  local _ljd _run_id _run_finished=0
  _ljd="$(dirname "$0")/land-run-journal.sh"
  _run_id="$(bash "$_ljd" start marveen-land.sh "$agent" "${LAND_CARD:--}" "$$" 2>/dev/null || true)"
  # card 88b67fb4, MikroB's live-D/5 gap 2 (msg_id:16818): a deliberate SIGTERM stop (an operator
  # asking an agent to stop a land run) would otherwise be indistinguishable from a crash. This
  # records it as "aborted" (not a crash, not a plain failure) BEFORE exiting, and sets
  # _run_finished so the EXIT trap below (which also fires after this `exit 143`) does not write a
  # second, competing finished line for the same run.
  trap '_run_finished=1; [ -n "${run_fg_killable_pid:-}" ] && kill -TERM "$run_fg_killable_pid" 2>/dev/null; [ -n "${_run_id:-}" ] && bash "$_ljd" finish "$_run_id" 143 "deliberate stop (SIGTERM)" aborted >/dev/null 2>&1; exit 143' TERM
  # WhiteHat NO-GO 28731, L4: `land_one` can call `die()` (an internal `exit N`, not a signal) if
  # it hits a hard refusal mid-landing -- that used to terminate the whole script immediately,
  # skipping every finish call site below entirely (they only run AFTER land_one RETURNS), so a
  # clean refusal read as STALE forever, same as a real crash. An EXIT trap fires on ANY shell
  # exit, including an internal `exit N` from a function still on the call stack (verified: `$?`
  # inside an EXIT trap correctly reflects that exit code) -- covers `die()` with no extra call
  # sites to remember. Cleared (`trap - EXIT`) before every explicit return below so it never
  # leaks into a later loop iteration (`--all` sweeps call this function once per agent) with a
  # stale run_id/journal path from a DIFFERENT call's local scope.
  trap '_exit_rc=$?; if [ -n "${_run_id:-}" ] && [ "${_run_finished:-0}" != "1" ]; then bash "$_ljd" finish "$_run_id" "$_exit_rc" >/dev/null 2>&1 || true; _run_finished=1; fi' EXIT
  while :; do
    land_one "$agent" "$dry" "$branch_override"; rc=$?
    if [ "$rc" -ne 5 ]; then
      if [ -n "$_run_id" ] && [ "$_run_finished" != "1" ]; then
        bash "$_ljd" finish "$_run_id" "$rc" >/dev/null 2>&1 || true
        _run_finished=1
      fi
      trap - TERM EXIT
      return "$rc"
    fi
    if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
      echo "$agent: REFUSED -- lost the push race $attempt time(s) in a row; origin/$DEFAULT_BRANCH keeps moving during the merge+test window. Nothing pushed; $disp_branch is untouched."
      if [ -n "$_run_id" ] && [ "$_run_finished" != "1" ]; then
        bash "$_ljd" finish "$_run_id" 4 "lost push race $attempt times" >/dev/null 2>&1 || true
        _run_finished=1
      fi
      trap - TERM EXIT
      return 4
    fi
    attempt=$((attempt+1))
    [ -n "$_run_id" ] && bash "$_ljd" heartbeat "$_run_id" >/dev/null 2>&1 || true
    say "$agent: another agent landed during the merge+test window -- re-merging onto the new origin/$DEFAULT_BRANCH and verifying again (attempt $attempt/$MAX_ATTEMPTS)"
  done
}

DRY=0; LAND_CARD=""; ALLOW_STACKED=""; ALLOW_ARCHIVE=0
TARGET="${1:-}"; [ $# -gt 0 ] && shift

# card cd3e577b (F1): `marveen-land.sh --card <id> --agent <agent> [--dry-run]` lands the card's OWN
# card/<id> worktree branch (created by `agent-worktree-marveen.sh <agent> --card <id>`) instead of
# the agent's shared agent/<agent>/work branch. Parsed separately from the existing per-agent
# `--card <id>` OPTION below (which names a card for the downward-check/gate-verdict report on an
# agent/*/work landing but never changes which branch is merged) -- that grammar already treats
# `--card` as an option of an agent target, so a `--card` TARGET needs its own branch here rather
# than overloading the same flag two ways in one loop. --agent is required (not inferred from the
# board) so this script keeps making zero API calls of its own -- the caller, which already knows
# the card's assignee because it just created the worktree, passes it.
if [ "$TARGET" = "--card" ]; then
  CARD_BRANCH_ID="${1:-}"
  [ -n "$CARD_BRANCH_ID" ] || die 2 "--card needs a card id"
  shift
  case "$CARD_BRANCH_ID" in *[!0-9a-f]*|'') die 2 "card id must be hex (got: $CARD_BRANCH_ID)" ;; esac
  [ "${#CARD_BRANCH_ID}" -ge 6 ] || die 2 "card id too short (got: $CARD_BRANCH_ID)"
  CARD_AGENT=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      --agent) shift; [ $# -gt 0 ] || die 2 "--agent needs a name"; CARD_AGENT="$1" ;;
      --agent=*) CARD_AGENT="${1#--agent=}" ;;
      --allow-ungated) CARD_ALLOW_UNGATED=1 ;;
      --allow-ungated-reason) shift; [ $# -gt 0 ] || die 2 "--allow-ungated-reason needs text"; CARD_ALLOW_UNGATED_REASON="$1" ;;
      --allow-ungated-reason=*) CARD_ALLOW_UNGATED_REASON="${1#--allow-ungated-reason=}" ;;
      *) die 2 "unknown option: $1" ;;
    esac
    shift
  done
  [ -n "$CARD_AGENT" ] || die 2 "--card requires --agent <name> for attribution (locking, fleet-test queue, version-bump commit message)"
  LAND_CARD="$CARD_BRANCH_ID"
  CARD_BRANCH_MODE=1
  land_with_retry "$CARD_AGENT" "$DRY" "card/$CARD_BRANCH_ID"
  exit $?
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    # Naming the card turns the downward report into a refusal (card dfff9b37). Without it marveen
    # only reports: a whole-branch landing legitimately carries several cards, see the shared lib.
    --card) shift; [ $# -gt 0 ] || die 2 "--card needs a card id"; LAND_CARD="$1" ;;
    --card=*) LAND_CARD="${1#--card=}" ;;
    # Not a --force: the operator NAMES the foreign cards they are taking on purpose.
    --allow-stacked) shift; [ $# -gt 0 ] || die 2 "--allow-stacked needs a card id list"; ALLOW_STACKED="$1" ;;
    --allow-stacked=*) ALLOW_STACKED="${1#--allow-stacked=}" ;;
    # 90-day distillation commits move entries from DECISIONS.md's beginning into an archive file,
    # breaking the byte-exact-prefix invariant.  Only MikroB passes this explicitly (card acffb1d6).
    --allow-archive) ALLOW_ARCHIVE=1 ;;
    *) die 2 "unknown option: $1" ;;
  esac
  shift
done
# --card names ONE card, so it cannot mean anything across a sweep of every agent's branch.
if [ "$TARGET" = "--all" ] && [ -n "$LAND_CARD" ]; then
  die 2 "--card cannot be combined with --all -- a sweep lands many agents' branches, not one card"
fi

case "$TARGET" in
  --all)
    # card cd3e577b, MikroB decision 16324 (overriding RedHat's "leave it" suggestion in 16322):
    # --all no longer LANDS agent/*/work branches -- it only lists/notifies, exactly like it
    # already did for card/* branches. RedHat measured the old behaviour directly: a real --all run
    # landed agent/alpha/work's commit with no gate check at all (alpha.txt reaching origin/develop
    # ungated) -- precisely the "code reaches develop without its own required gate" class this
    # whole card exists to close. An agent/<agent>/work branch now lands only via its OWNER calling
    # `marveen-land.sh <agent>` directly (report mode there, unchanged -- see this file's header on
    # gate_verdict_check for why marveen gates AFTER landing); a card/<id> branch only via its owner
    # calling `--card <id> --agent <owner>` (refuse mode, gated as of this same card). This also
    # changes what the repo-sync-deploy scheduled task's --all sweep actually does; MikroB owns
    # updating that task's own prompt separately.
    g fetch -q origin "$DEFAULT_BRANCH" || true
    while IFS= read -r b; do
      [ -n "$b" ] || continue
      agent="${b#agent/}"; agent="${agent%/work}"
      if g merge-base --is-ancestor "$b" "origin/$DEFAULT_BRANCH" 2>/dev/null; then
        continue
      fi
      say "marveen-land.sh --all: $b has unlanded commit(s), not landed automatically (land with: marveen-land.sh $agent)"
    done < <(g for-each-ref --format='%(refname:short)' 'refs/heads/agent/*/work')
    # card cd3e577b (F1), plan-grilling change (3): must NEVER land a card/<id> branch unattended --
    # only a card that is waiting+REVIEW (i.e. has a human/agent-declared Gate-SHA already on it) is
    # safe to land, and resolving "is this card waiting+REVIEW" needs the kanban API, which this
    # script otherwise never calls (see the --agent requirement above) -- so this sweep SKIPS card/*
    # branches by design, same as agent/*/work above. Landing one stays an explicit, one-at-a-time
    # `marveen-land.sh --card <id> --agent <agent>` call (by the owning agent, after REVIEW+waiting).
    # RedHat NO-GO 16276, B2b/B2c: this used to be `echo ... >&2`, and on a repo with any
    # agent/*/work branches the first cleanup reassigned the script's own stderr to /dev/null for
    # the rest of the process (fixed above) -- so this notice never reached anyone even though the
    # code producing it was correct. `say` (stdout) survives that bug's blast radius.
    # RedHat NO-GO 16322, non-blocking R2 + MikroB decision 16324 ("a landolt card/* agakat az
    # --all ne sorolja"): filter out branches already an ancestor of origin/develop, same as the
    # agent/*/work loop above -- card/* branches are never deleted after landing (requirement 5), so
    # an unfiltered list only grows and a human skimming it for "what still needs a --card landing"
    # has to re-check each one by hand.
    while IFS= read -r b; do
      [ -n "$b" ] || continue
      if g merge-base --is-ancestor "$b" "origin/$DEFAULT_BRANCH" 2>/dev/null; then
        continue
      fi
      say "marveen-land.sh --all: $b exists but card/* branches are not swept automatically (land with: marveen-land.sh --card ${b#card/} --agent <owner>)"
    done < <(g for-each-ref --format='%(refname:short)' 'refs/heads/card/*')
    exit 0
    ;;
  '') die 2 "usage: marveen-land.sh <agent> [--dry-run] [--card <id>] [--allow-stacked <id>[,<id>...]] | marveen-land.sh --card <id> --agent <agent> [--dry-run] | marveen-land.sh --all [--dry-run]" ;;
  *)
    land_with_retry "$TARGET" "$DRY"
    exit $?
    ;;
esac

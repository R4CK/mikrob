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
#                   [--allow-ungated-reason <text>] [--allow-stacked <id>[,<id>...]]
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
#                                         # --allow-stacked names the foreign card(s) you are
#                                         # knowingly taking on (card 78339a8a) -- same meaning as
#                                         # the agent-target mode's flag above; before this it was
#                                         # unknown-option-rejected here, forcing the full
#                                         # LANDING_DOWNWARD_CHECK=off kill switch for one stacked
#                                         # commit.
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
#   LANDING_DOWNWARD_CHECK=off  disables the downward range check entirely (card dfff9b37). Scoped
#                       to THIS script's own downward_check() call only (card 78339a8a) -- it does
#                       NOT reach fleet-test.sh or anything it spawns, because run_fg_killable()
#                       unsets it inside its own subshell before running the verification command.
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
  # card 07f1fe6e (CYBERSEC GO 29154 M1/M2): `set -m` makes bash put this backgrounded subshell
  # in its OWN process group (pgid == this subshell's own pid, not the script's pgid) instead of
  # the script's. Without this, the eval'd command's own children (the fleet-test/vitest tree)
  # stay in the SCRIPT's process group -- a TERM to just this one pid leaves them running as
  # orphans, reparented but alive, holding a CPU slot (measured). The TERM trap below sends the
  # signal to the whole group (`kill -- -<pgid>`), which this pgid assignment makes possible.
  # card 78339a8a: LANDING_DOWNWARD_CHECK=off, if exported at script invocation, otherwise
  # inherits into this subshell and everything it execs (fleet-test.sh, vitest workers, and any
  # selftest a test spawns) -- so a landing override meant for THIS script's own downward_check()
  # call also disables the kill switch inside the fleet-test run that verifies the merge, flipping
  # landing-downward-check.test.ts's own selftest cases (measured: 4f3c0287 land, 2026-11-13).
  # Unset it before cd/eval, not between release_land_lock_fd and eval, so the existing Q3 pin
  # (grep -cF 'cd "$dir" && release_land_lock_fd && eval "$cmd"') still matches byte-for-byte.
  set -m
  ( unset LANDING_DOWNWARD_CHECK; cd "$dir" && release_land_lock_fd && eval "$cmd" ) &
  run_fg_killable_pid=$!
  set +m
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
  # M3 (WhiteHat2 NO-GO 30647): `grep -qE` exits the instant it finds a match, closing its end of
  # the pipe -- under `set -o pipefail` (this file's own top line), the printf writer then dies of
  # SIGPIPE (rc 141) and pipefail reports the PIPELINE's status as that 141, not grep's 0, flipping
  # a genuine match to "not found". Measured: with land_batch's own +384 lines added, $prod_src grew
  # past the point where this flips, and this pin went flaky-false-negative on an ACTUAL regression
  # (the thing it exists to catch). `grep -c` never exits early -- it reads to EOF to count matching
  # lines -- so the pipe never closes underneath printf. Same fix at line ~674 below.
  if [ "$(printf '%s\n' "$prod_src" | grep -cE 'exec \{LAND_LOCK_FD\}>&-')" -gt 0 ]; then
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
  # Card 6ec8e9d8 added land_batch(), which defines its OWN two cleanup() stages (lock-only, then
  # lock+worktree) on the same pattern as land_one's -- so the count grew from 2 to 4. The actual
  # property this pin protects (no cleanup() closure skips release_land_lock_fd) is defs==calls,
  # not a fixed headcount; >=2 keeps this from vacuously passing at 0.
  if [ "$cleanup_defs" -ge 2 ] && [ "$cleanup_defs" -eq "$cleanup_calls" ]; then
    echo "  ok   every cleanup() definition (land_one + land_batch) calls release_land_lock_fd, not an inline exec (B2', count=$cleanup_defs)"
  else
    echo "  FAIL expected every cleanup() definition to call release_land_lock_fd, got defs=$cleanup_defs calls=$cleanup_calls"; fail=1
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
  # M3: same SIGPIPE/pipefail hazard as the B2' pin above -- `grep -c` instead of `grep -q`.
  if [ "$(printf '%s\n' "$prod_src" | grep -cE 'while ! \{ land_lock_is_head "\$land_lock_ticket" && acquire_land_lock; \}; do')" -gt 0 ]; then
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

  # card 07f1fe6e delta (CYBERSEC GO 29326 L2): marveen-land-run-fg-killable.selftest.sh was not
  # referenced from here, from package.json, or from any src/ test -- its TERM/M2/HUP pins never
  # ran unless someone invoked the file by hand. It exercises real signals and timing (not inline
  # assertions like the cases above), so it runs as a subprocess and its PASS/FAIL folds into this
  # run's totals.
  rfk_script="$(dirname "$0")/marveen-land-run-fg-killable.selftest.sh"
  if [ -f "$rfk_script" ]; then
    rfk_out="$(bash "$rfk_script" 2>&1)"
    rfk_cases=$(printf '%s\n' "$rfk_out" | grep -c '^  ok \|^  FAIL ')
    n=$((n + rfk_cases))
    printf '%s\n' "$rfk_out" | grep '^  ok \|^  FAIL '
    printf '%s\n' "$rfk_out" | grep -q '^  FAIL ' && fail=1
  else
    echo "  FAIL marveen-land-run-fg-killable.selftest.sh not found next to $0 -- wiring broken"; fail=1
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
  # Card b7d8ecc4: every fleet-test.sh call this function runs (below) holds the develop-push lock
  # for its whole wait, so it must jump fleet-test's own queue ahead of non-land callers -- see
  # fleet-test.sh's FLEET_TEST_PRIORITY/fleet_test_is_head for why. Exported once here, inherited
  # by every run_fg_killable subshell/eval in this function.
  export FLEET_TEST_PRIORITY=land
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
  # card 07f1fe6e (CYBERSEC GO 29154 M1): kill the WHOLE process group run_fg_killable put the
  # wrapped command in (`kill -- -<pgid>`, the negative-pid form), not just that one subshell pid
  # -- a plain `kill -TERM "$run_fg_killable_pid"` leaves the eval'd command's own children (the
  # fleet-test/vitest tree) running as orphans, reparented but alive, holding a CPU slot.
  # card 07f1fe6e delta (CYBERSEC GO 29326 L1): the group-kill fix above only covers TERM to the
  # LANDER's pid. Measured: HUP and KILL sent to the lander's whole PROCESS GROUP used to kill the
  # wrapped tree (no job-control subshell to reparent onto) and now orphan it instead -- a
  # regression in the opposite direction from M1. HUP and INT are trappable, so they get the same
  # group-kill as TERM. KILL cannot be trapped by any shell (SIGKILL always goes straight to
  # default disposition) -- a group-directed KILL kills every process in the group including the
  # wrapped tree itself, so nothing orphans; a lander-pid-only KILL still orphans the tree, same
  # inherent gap TERM had before this fix and with no code-level mitigation possible.
  _land_sig_stop() { # $1 = signal name (TERM/HUP/INT), $2 = its POSIX exit code (128+signum)
    _run_finished=1
    [ -n "${run_fg_killable_pid:-}" ] && kill -"$1" -- "-$run_fg_killable_pid" 2>/dev/null
    [ -n "${_run_id:-}" ] && bash "$_ljd" finish "$_run_id" "$2" "deliberate stop (SIG$1)" aborted >/dev/null 2>&1
    exit "$2"
  }
  trap '_land_sig_stop TERM 143' TERM
  trap '_land_sig_stop HUP 129' HUP
  trap '_land_sig_stop INT 130' INT
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
      trap - TERM HUP INT EXIT
      return "$rc"
    fi
    if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
      echo "$agent: REFUSED -- lost the push race $attempt time(s) in a row; origin/$DEFAULT_BRANCH keeps moving during the merge+test window. Nothing pushed; $disp_branch is untouched."
      if [ -n "$_run_id" ] && [ "$_run_finished" != "1" ]; then
        bash "$_ljd" finish "$_run_id" 4 "lost push race $attempt times" >/dev/null 2>&1 || true
        _run_finished=1
      fi
      trap - TERM HUP INT EXIT
      return 4
    fi
    attempt=$((attempt+1))
    [ -n "$_run_id" ] && bash "$_ljd" heartbeat "$_run_id" >/dev/null 2>&1 || true
    say "$agent: another agent landed during the merge+test window -- re-merging onto the new origin/$DEFAULT_BRANCH and verifying again (attempt $attempt/$MAX_ATTEMPTS)"
  done
}

# BATCHED LANDING (card 6ec8e9d8, MikroB plan-grilling GO msg 18291/comment 30593). Merges several
# gate-green --card branches into ONE worktree, runs fleet-test.sh ONCE on the combined result, and
# pushes ONCE -- instead of land_with_retry's one-card-at-a-time serial cost (measured 12-38 min per
# card). Reuses land_one's own per-card refusal checks (gate_verdict_check, card_designated_gates_agree,
# downward_check, decisions_tail_append_ok, the two auto-union helpers) rather than reimplementing
# them, so a card that the single-card path would refuse is dropped here too, never silently landed.
#
# A conflict or a failed check for ONE card never fails the whole batch (MikroB's explicit question,
# answered in the design comment 30551): it is dropped, named, and the batch continues with the rest
# -- symmetric with how land_one refuses a single card today. Only a RED fleet-test (or a stale push)
# abandons the whole batch, and even then the fallback is the already-proven land_with_retry path,
# one survivor at a time, not a new failure mode.
#
# No bisection in v1 (card's own instruction) and no dependency-ordering between batch members: the
# caller names the order, nothing here infers one.
#
# Usage: land_batch <dry 0|1> "<card1>:<agent1>" "<card2>:<agent2>" ...
land_batch() {
  local dry="$1"; shift
  local -a items=("$@")
  [ "${#items[@]}" -ge 1 ] || die 2 "--batch needs at least 1 card:agent pair"

  local batch_tag="batch-$$"
  export FLEET_TEST_AGENT="$batch_tag"
  export FLEET_TEST_PRIORITY=land
  KANBAN_COMMENT_AGENT="mikrob"

  local cards_csv=""
  local it
  for it in "${items[@]}"; do
    case "$it" in *:*) : ;; *) die 2 "--batch item must be <card>:<agent> (got: $it)" ;; esac
    cards_csv="${cards_csv:+$cards_csv,}${it%%:*}"
  done

  # A3: started/heartbeat/finished triple under ONE run_id, same journal as a single landing, plus
  # the batch's own extra land-runs.jsonl line (below) so land-run-stale-check sees a long batch as
  # alive, not STALE, and a reader can still tell "this was a batch" from the plain journal alone.
  local _ljd _run_id _run_finished=0
  _ljd="$(dirname "$0")/land-run-journal.sh"
  _run_id="$(bash "$_ljd" start marveen-land.sh "$batch_tag" "$cards_csv" "$$" 2>/dev/null || true)"
  trap '_exit_rc=$?; if [ -n "${_run_id:-}" ] && [ "${_run_finished:-0}" != "1" ]; then bash "$_ljd" finish "$_run_id" "$_exit_rc" >/dev/null 2>&1 || true; _run_finished=1; fi' EXIT

  # M4 (WhiteHat2 NO-GO 30647): land_with_retry has had group-kill TERM/HUP/INT traps since card
  # 07f1fe6e; land_batch had none. Measured: TERM to an untrapped land_batch orphaned the wrapped
  # fleet-test (reparented, still holding a CPU slot), left the disposable worktree behind, and
  # (since the only EXIT-trap write is the journal finish above) recorded the killed run as a plain
  # "finished" with no "aborted" marker. Same fix, same shape: kill the wrapped command's whole
  # process group (not just land_batch's own pid), mark the journal run aborted BEFORE exiting, and
  # run cleanup() explicitly -- a RETURN trap (set further down, once $wt exists) never fires on a
  # signal-forced exit, only on a normal function return.
  _batch_sig_stop() { # $1 = signal name (TERM/HUP/INT), $2 = its POSIX exit code (128+signum)
    _run_finished=1
    [ -n "${run_fg_killable_pid:-}" ] && kill -"$1" -- "-$run_fg_killable_pid" 2>/dev/null
    [ -n "${_run_id:-}" ] && bash "$_ljd" finish "$_run_id" "$2" "deliberate stop (SIG$1)" aborted >/dev/null 2>&1
    declare -F cleanup >/dev/null 2>&1 && cleanup 2>/dev/null
    trap - EXIT
    exit "$2"
  }
  trap '_batch_sig_stop TERM 143' TERM
  trap '_batch_sig_stop HUP 129' HUP
  trap '_batch_sig_stop INT 130' INT

  local _batch_start_ts; _batch_start_ts="$(date +%s)"
  local -a survivors=() drop_cards=() drop_reasons=()
  local -A surv_agent=() surv_work_sha=() surv_gate_sha=() surv_ungated_reason=()
  local ALLOW_UNGATED_CARDS="${ALLOW_UNGATED_CARDS:-}"
  local fleet_test_result="" batch_outcome="" first_failing_file="" bump_note="none"

  _batch_finish() { # $1 = fleet_test "green"/"red"/"-", $2 = result, $3 = exit code
    local wall; wall=$(( $(date +%s) - _batch_start_ts ))
    local dropped_json
    dropped_json="$(python3 -c '
import json,sys
cards=sys.argv[1].split(",") if sys.argv[1] else []
reasons=sys.argv[2].split("\x1e") if sys.argv[2] else []
print(json.dumps(dict(zip(cards,reasons))))' "$(IFS=,; echo "${drop_cards[*]:-}")" "$(IFS=$'\x1e'; echo "${drop_reasons[*]:-}")" 2>/dev/null)" || dropped_json="{}"
    local line
    line="$(python3 -c '
import json,sys
print(json.dumps({"mode":"batch","cards":sys.argv[1].split(",") if sys.argv[1] else [],
  "survivors":sys.argv[2].split(",") if sys.argv[2] else [],"dropped":json.loads(sys.argv[3]),
  "fleet_test":sys.argv[4],"first_failing_file":sys.argv[5] or None,"result":sys.argv[6],
  "wall_seconds":int(sys.argv[7])}))' \
      "$cards_csv" "$(IFS=,; echo "${survivors[*]:-}")" "$dropped_json" "$1" "$first_failing_file" "$2" "$wall" \
      2>/dev/null)" || line=""
    [ -n "$line" ] && printf '%s\n' "$line" >>"$(dirname "$0")/land-runs.jsonl" 2>/dev/null
    if [ -n "$_run_id" ] && [ "$_run_finished" != "1" ]; then
      bash "$_ljd" finish "$_run_id" "$3" "batch: $2" >/dev/null 2>&1 || true
      _run_finished=1
    fi
  }

  # L1 (WhiteHat2 NO-GO 30647): every fallback site used to `return 0` unconditionally, so a caller
  # could not tell "the batch fell back and every survivor still landed one-by-one" from "it fell
  # back and NOTHING landed" -- both read as success. Shared by all four fallback sites below.
  _fallback_land_all() { # $1 = fleet_test tag for the journal, $2 = result label
    local any_landed=0 fb_rc
    for card in "${survivors[@]}"; do
      LAND_CARD="$card" land_with_retry "${surv_agent[$card]}" 0 "card/$card"
      fb_rc=$?
      [ "$fb_rc" -eq 0 ] && any_landed=1
    done
    if [ "$any_landed" = 1 ]; then
      _batch_finish "$1" "$2" 0
      return 0
    fi
    _batch_finish "$1" "$2" 4
    return 4
  }

  g fetch -q origin "$DEFAULT_BRANCH" || die 3 "could not fetch origin/$DEFAULT_BRANCH"

  # Lock the batch WINDOW, same FIFO-ticket + flock as a single landing (card 5d9731cd/24d1543f) --
  # a batch is one landing-shaped unit from the lock's point of view, held once for every card in it.
  LAND_LOCK_FD=""
  local land_lock_started land_lock_announced=0 land_lock_last_note land_lock_waited land_lock_ticket
  land_lock_started="$(date +%s)"; land_lock_last_note="$land_lock_started"
  land_lock_ticket="$(land_lock_take_ticket)" || die 3 "could not create a landing-queue ticket under '$LAND_LOCK_FILE.tickets'"
  while ! { land_lock_is_head "$land_lock_ticket" && acquire_land_lock; }; do
    land_lock_waited=$(( $(date +%s) - land_lock_started ))
    if [ "$land_lock_waited" -ge "$LAND_LOCK_WAIT_MAX_S" ]; then
      rm -f "$land_lock_ticket" 2>/dev/null
      echo "batch: REFUSED -- could not acquire the landing lock after $((land_lock_waited / 60)) min. Nothing pushed." >&2
      _batch_finish "-" "lock-timeout" 4
      trap - TERM HUP INT EXIT
      return 4
    fi
    if [ "$land_lock_announced" -eq 0 ]; then
      land_lock_announced=1
      echo "batch ($cards_csv): another landing holds the develop lock -- queueing (cap ${LAND_LOCK_WAIT_MAX_S}s)" >&2
    elif [ $(( $(date +%s) - land_lock_last_note )) -ge "$LAND_LOCK_KEEPALIVE_S" ]; then
      land_lock_last_note="$(date +%s)"
      [ -n "$_run_id" ] && bash "$_ljd" heartbeat "$_run_id" >/dev/null 2>&1 || true
    fi
    sleep "$LAND_LOCK_POLL_S"
  done
  rm -f "$land_lock_ticket" 2>/dev/null

  cleanup() { release_land_lock_fd; }
  trap cleanup RETURN

  g fetch -q origin "$DEFAULT_BRANCH" || die 3 "could not fetch origin/$DEFAULT_BRANCH"
  local base_sha; base_sha="$(g rev-parse "origin/$DEFAULT_BRANCH")"
  local wt="/home/neon/marveen-land-${batch_tag}"
  rm -rf "$wt"
  g worktree add --detach -q "$wt" "origin/$DEFAULT_BRANCH" || die 3 "could not create the batch landing worktree"
  cleanup() {
    [ -n "${wt:-}" ] && g worktree remove --force "$wt" >/dev/null 2>&1
    release_land_lock_fd
    return 0
  }

  local card agent branch pre_head land_sha down_log mb merge_err conflicted gate_rc desig_rc work_sha

  _batch_drop() { # $1 = card id, $2 = reason -- names the drop out loud, not just into the journal
    drop_cards+=("$1"); drop_reasons+=("$2")
    say "batch: dropping $1 -- $2"
  }

  for it in "${items[@]}"; do
    card="${it%%:*}"; agent="${it#*:}"
    branch="card/$card"

    g show-ref --verify --quiet "refs/heads/$branch" || {
      _batch_drop "$card" "no branch $branch"; continue
    }

    # A1: re-check "already landed" INSIDE the lock, after a fresh fetch -- a card another agent
    # landed with a plain --card while THIS batch queued for the lock must never be merged twice.
    g fetch -q origin "$DEFAULT_BRANCH" >/dev/null 2>&1
    if g merge-base --is-ancestor "$branch" "origin/$DEFAULT_BRANCH" 2>/dev/null; then
      _batch_drop "$card" "already landed on origin/$DEFAULT_BRANCH (concurrent land while batch waited for the lock)"
      continue
    fi

    work_sha="$(g rev-parse "$branch")"
    pre_head="$(git -C "$wt" rev-parse HEAD)"

    local _dtag_mb; _dtag_mb="$(git -C "$wt" merge-base HEAD "$branch" 2>/dev/null)"
    if [ -n "$_dtag_mb" ] && ! decisions_tail_append_ok "$wt" "$_dtag_mb" "$branch" "DECISIONS.md" "$ALLOW_ARCHIVE" 2>/dev/null; then
      _batch_drop "$card" "DECISIONS.md on $branch is not a pure tail append"; continue
    fi

    down_log="$(git -C "$wt" log --no-merges --format='%h%x09%s' "$pre_head..$branch")"
    if ! downward_check "$down_log" "$card" "$ALLOW_STACKED" 1 "$agent" 2>/dev/null; then
      _batch_drop "$card" "foreign-card commits on $branch (downward check)"; continue
    fi

    land_sha="$(git -C "$wt" rev-parse "$branch" 2>/dev/null)" || land_sha="$branch"
    # M1 (WhiteHat2 NO-GO 30647): --allow-ungated used to be CARD_ALLOW_UNGATED, the SAME global
    # land_one's single-card path reads -- so one flag tolerated EVERY card in the batch, silently.
    # Scoped per-card here: a card only rides ungated if its own id is named in ALLOW_UNGATED_CARDS
    # (CSV, --allow-ungated-cards), same naming-not-blanket shape as --allow-stacked.
    local card_ungated_ok=0
    case ",$(printf '%s' "$ALLOW_UNGATED_CARDS" | tr 'A-F' 'a-f' | tr -d '[:space:]')," in
      *",$card,"*) card_ungated_ok=1 ;;
    esac
    GATE_CHECK_OVERRIDE_ARMED="$card_ungated_ok" gate_verdict_check "$card" "$land_sha" refuse >/dev/null 2>&1
    gate_rc=$?
    if [ "$gate_rc" -eq 2 ]; then
      _batch_drop "$card" "FAILING gate verdict for $land_sha"; continue
    elif [ "$gate_rc" -ne 0 ] && [ "$card_ungated_ok" != "1" ]; then
      _batch_drop "$card" "no passing gate verdict for $land_sha"; continue
    elif [ "$gate_rc" -ne 0 ]; then
      say "batch: $card gate-check: no usable verdict, TOLERATED by --allow-ungated-cards -- this card lands deliberately ungated"
      surv_ungated_reason[$card]="no usable QA verdict for $land_sha"
    fi

    card_designated_gates_agree "$card" "$land_sha" >/dev/null 2>&1
    desig_rc=$?
    if [ "$desig_rc" -eq 2 ]; then
      _batch_drop "$card" "FAILING designated-gate verdict for $land_sha"; continue
    elif [ "$desig_rc" -ne 0 ] && [ "$card_ungated_ok" != "1" ]; then
      _batch_drop "$card" "designated gates do not AGREE for $land_sha"; continue
    elif [ "$desig_rc" -ne 0 ]; then
      say "batch: $card designated-gate-check: no AGREE from the card's designated gates, TOLERATED by --allow-ungated-cards"
      surv_ungated_reason[$card]="${surv_ungated_reason[$card]:+${surv_ungated_reason[$card]}; }the card's designated gates do not all AGREE on $land_sha"
    fi

    local msg="merge: $branch into $DEFAULT_BRANCH (marveen-land --batch $batch_tag, card $card)"
    if ! merge_err="$(git -C "$wt" -c user.email=mikrob@marveen.local -c user.name=mikrob \
                      merge --no-ff "$branch" -m "$msg" 2>&1)"; then
      conflicted="$(git -C "$wt" diff --name-only --diff-filter=U)"
      if [ "$conflicted" = "DECISIONS.md" ] && try_append_union "$wt" "DECISIONS.md"; then
        git -C "$wt" -c user.email=mikrob@marveen.local -c user.name=mikrob commit --no-edit -q || {
          _batch_drop "$card" "auto-unioned DECISIONS.md but the merge commit failed"; git -C "$wt" merge --abort 2>/dev/null; continue
        }
      elif [ "$conflicted" = "README.md" ] && try_readme_bullet_union "$wt" "README.md"; then
        git -C "$wt" -c user.email=mikrob@marveen.local -c user.name=mikrob commit --no-edit -q || {
          _batch_drop "$card" "auto-unioned README.md but the merge commit failed"; git -C "$wt" merge --abort 2>/dev/null; continue
        }
      else
        git -C "$wt" merge --abort 2>/dev/null
        _batch_drop "$card" "merge conflict in: ${conflicted:-$merge_err}"; continue
      fi
    fi

    # SEAM CHECK against the merge-base of this card's branch and the batch's CURRENT head (what it
    # is actually merging onto, which already carries earlier survivors) -- not the original
    # base_sha, per the design comment: a later card must be checked against what is already IN
    # the batch.
    mb="$(git -C "$wt" merge-base "$branch" "$pre_head")"
    local branch_files main_files overlap lost=0 f line body
    branch_files="$(git -C "$wt" diff --name-only "$mb..$branch")"
    main_files="$(git -C "$wt" diff --name-only "$mb..$pre_head")"
    overlap="$(comm -12 <(echo "$branch_files" | sort) <(echo "$main_files" | sort))"
    if [ -n "$overlap" ]; then
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        if [ ! -f "$wt/$f" ]; then
          git -C "$wt" cat-file -e "$branch:$f" 2>/dev/null || git -C "$wt" cat-file -e "$pre_head:$f" 2>/dev/null || continue
          lost=$((lost+1)); continue
        fi
        while IFS= read -r line; do
          case "$line" in (''|'+++'*) continue ;; esac
          body="${line#+}"; [ -n "${body// }" ] || continue
          grep -qF -- "$body" "$wt/$f" || lost=$((lost+1))
        done < <(git -C "$wt" diff "$mb..$branch" -- "$f" | grep '^+')
        while IFS= read -r line; do
          case "$line" in (''|'+++'*) continue ;; esac
          body="${line#+}"; [ -n "${body// }" ] || continue
          grep -qF -- "$body" "$wt/$f" || lost=$((lost+1))
        done < <(git -C "$wt" diff "$mb..$pre_head" -- "$f" | grep '^+')
      done < <(echo "$overlap")
    fi
    if [ "$lost" -gt 0 ]; then
      git -C "$wt" reset -q --hard "$pre_head"
      _batch_drop "$card" "$lost seam loss(es) against the batch-so-far"; continue
    fi

    local this_merge_sha; this_merge_sha="$(git -C "$wt" rev-parse HEAD)"
    survivors+=("$card")
    surv_agent[$card]="$agent"
    surv_work_sha[$card]="$work_sha"
    surv_gate_sha[$card]="$this_merge_sha"
    say "batch: $card merged cleanly (own merge sha $(git -C "$wt" rev-parse --short HEAD))"
  done

  if [ "${#survivors[@]}" -eq 0 ]; then
    say "batch: no survivors -- nothing to land"
    _batch_finish "-" "nothing-to-land" 0
    trap - TERM HUP INT EXIT
    return 0
  fi

  if [ "$dry" = "1" ]; then
    say "batch: DRY-RUN -- survivors: ${survivors[*]}, dropped: ${drop_cards[*]:-none} -- not testing, not pushing"
    _batch_finish "-" "dry-run" 0
    trap - TERM HUP INT EXIT
    return 0
  fi

  # npm lockfile drift on the FINAL combined HEAD -- same check land_one runs, once here.
  local NPM_LF_OUT; NPM_LF_OUT="$("$(dirname "$0")/npm-lockfile-sync-check.sh" --repo "$wt" --ref "$(git -C "$wt" rev-parse HEAD)" --base "origin/$DEFAULT_BRANCH" 2>&1)"
  local npm_rc=$?
  if [ "$npm_rc" -eq 1 ]; then
    say "batch: npm lockfile drift on the combined result -- abandoning the batch, falling back one-by-one (that path re-checks per card)"
    say "$NPM_LF_OUT"
    git -C "$wt" worktree 2>/dev/null; # no-op, cleanup() below removes it
    cleanup
    trap - TERM HUP INT RETURN EXIT
    _fallback_land_all "-" "fallback-one-by-one (npm lockfile drift)"
    return $?
  fi

  # A2: exactly ONE version-bump commit per batch, after the last merge.
  local upstream_ver new_ver
  if upstream_ver="$(bump_upstream_version "$wt" 2>&1)" && [[ "$upstream_ver" != unchanged:* ]]; then
    say "batch: main version caught up to $upstream_ver"
  fi
  if new_ver="$(bump_fork_version "$wt" 2>&1)"; then
    git -C "$wt" add package.json package-lock.json 2>/dev/null
    if git -C "$wt" -c user.email=mikrob@marveen.local -c user.name=mikrob \
          commit -q -m "chore(version): bump to $new_ver (marveen-land --batch, $batch_tag)"; then
      bump_note="$new_ver"
      say "batch: version bumped to $new_ver (one commit for the whole batch)"
    fi
  fi

  local combined_head; combined_head="$(git -C "$wt" rev-parse HEAD)"

  # Dual-copy fleet-test.sh rule, same as land_one -- checked per SURVIVOR against the ORIGINAL
  # batch base (not per-merge-step), per the design comment.
  local touched_fleet_test="" c
  for c in "${survivors[@]}"; do
    [ -n "$(g diff --name-only "$base_sha..card/$c" -- store/fleet-test.sh)" ] && touched_fleet_test=1
  done

  # A5: tee the fleet-test output to a log so a red run's first failing test file can be named
  # (run_fg_killable streams straight to the terminal, it captures nothing on its own).
  local ft_log; ft_log="$(mktemp)"
  local ft_ok=1
  if [ -n "$TEST_CMD" ]; then
    run_fg_killable "$wt" "$TEST_CMD $combined_head 2>&1 | tee $ft_log" || ft_ok=0
  elif [ -z "$touched_fleet_test" ]; then
    run_fg_killable "$wt" "$MAIN/store/fleet-test.sh --ref $combined_head 2>&1 | tee $ft_log" || ft_ok=0
  else
    say "batch: a survivor touches store/fleet-test.sh -- requiring both the trusted \$MAIN copy and the batch's own copy"
    run_fg_killable "$wt" "$MAIN/store/fleet-test.sh --ref $combined_head 2>&1 | tee $ft_log" || ft_ok=0
    [ "$ft_ok" -eq 1 ] && { run_fg_killable "$wt" "$wt/store/fleet-test.sh --ref $combined_head 2>&1 | tee $ft_log" || ft_ok=0; }
  fi

  if [ "$ft_ok" -ne 1 ]; then
    first_failing_file="$(grep -m1 -oE '[A-Za-z0-9_./-]+\.test\.[jt]sx?' "$ft_log" 2>/dev/null || true)"
    rm -f "$ft_log" 2>/dev/null
    say "batch: fleet-test RED on the combined result (first failing file: ${first_failing_file:-unknown}) -- abandoning the batch, falling back to land_with_retry one card at a time (no bisection in v1)"
    cleanup
    trap - TERM HUP INT RETURN EXIT
    _fallback_land_all red "fallback-one-by-one"
    return $?
  fi
  rm -f "$ft_log" 2>/dev/null
  say "batch: fleet-test GREEN on the combined result ($(git -C "$wt" diff --name-only "$base_sha..$combined_head" | wc -l) file(s) changed since $DEFAULT_BRANCH base)"

  local conflict_markers; conflict_markers="$(find_conflict_markers "$wt")"
  if [ -n "$conflict_markers" ]; then
    say "batch: unresolved conflict markers in the combined result -- abandoning the batch, falling back one-by-one"
    echo "$conflict_markers" | sed 's/^/    /'
    git -C "$wt" reset -q --hard "$base_sha"
    cleanup
    trap - TERM HUP INT RETURN EXIT
    _fallback_land_all red "fallback-one-by-one (conflict markers)"
    return $?
  fi

  local push_err
  if ! push_err="$(git -C "$wt" push origin "HEAD:$DEFAULT_BRANCH" 2>&1)"; then
    say "batch: PUSH FAILED (likely lost a race against another landing) -- abandoning the batch, falling back one-by-one, which re-merges onto the new tip itself:"
    echo "$push_err" | sed 's/^/    /'
    cleanup
    trap - TERM HUP INT RETURN EXIT
    _fallback_land_all green "fallback-one-by-one (lost push race)"
    return $?
  fi
  g fetch -q origin "$DEFAULT_BRANCH"

  # L2 (WhiteHat2 NO-GO 30647): land_one runs these four steps after every single-card push so the
  # live checkout, blast-radius graph, code-graph and (if src/ moved) dist/ follow the landed state
  # -- land_batch pushed too, but never ran them, so a batch push left all four one landing stale
  # until the next single --card landing happened to refresh them. Once, for the combined result,
  # same order (sync BEFORE index) and same non-fatal-by-construction shape as land_one's copy.
  sync_live_install
  "$(dirname "$0")/blast-radius-check.py" --refresh "$MAIN" 2>&1 | sed 's/^/  /' || true
  "$(dirname "$0")/graphify.sh" build "$MAIN" 2>&1 | tail -1 | sed 's/^/  graphify: /' || true
  if git -C "$wt" diff --name-only "$base_sha..$combined_head" -- src/ | grep -q .; then
    rebuild_live_install
  fi
  "$(dirname "$0")/kg-check-landing.sh" --repo marveen --repo-dir "$wt" --base "$base_sha" \
    --sha "$combined_head" --actor "marveen-land:batch" --main-dist "$MAIN/dist" 2>&1 | sed 's/^/  /' || true

  say "batch: LANDED -- ${#survivors[@]} card(s) (${survivors[*]}) -> origin/$DEFAULT_BRANCH (develop tip $(git -C "$wt" rev-parse --short HEAD))"
  echo "Gate-SHA: n/a -- see per-card Merge-SHA below, each card's own merge commit"

  local unrecorded=()
  for card in "${survivors[@]}"; do
    # A4: if the push already succeeded, a record/comment failure must never trigger a retry of the
    # push -- it only gets named so a sweep can repair it later. Checks BOTH the card_landings row
    # and the LANDOLVA comment (record_card_landing itself is best-effort/fire-and-forget, same as
    # land_one's single-card use of it, so the row's own status is captured separately here).
    local tf; tf="$(_kc_token_file 2>/dev/null)"
    local http_code="000" rec_code="000"
    if [ -n "$tf" ] && [ -f "$tf" ]; then
      local rpayload; rpayload="$(python3 -c '
import json,sys
print(json.dumps({"card_id":sys.argv[1],"work_sha":sys.argv[2],"merge_sha":sys.argv[3],"repo":"marveen","landed_by":sys.argv[4]}))' \
        "$card" "${surv_work_sha[$card]}" "${surv_gate_sha[$card]}" "${surv_agent[$card]}" 2>/dev/null)"
      rec_code="$(printf 'Authorization: Bearer %s\n' "$(cat "$tf")" \
        | curl -s --max-time 10 -o /dev/null -w '%{http_code}' -H @- \
          -X POST "$KANBAN_COMMENT_API/api/card-landings" -H 'Content-Type: application/json' \
          --data-binary "$rpayload" 2>/dev/null)" || rec_code="000"
    fi
    if [ -n "$tf" ] && [ -f "$tf" ]; then
      local comment_body="LANDOLVA (automatikus, marveen-land.sh --batch $batch_tag)
Merge-SHA: ${surv_gate_sha[$card]} (a gate altal mar verdiktelt Gate-SHA a korabbi REVIEW-ban all)
Batch: ${survivors[*]}, version bump: $bump_note"
      local cpayload; cpayload="$(python3 -c '
import json,sys; print(json.dumps({"card_id":sys.argv[1],"author":"mikrob","content":sys.argv[2]}))' "$card" "$comment_body" 2>/dev/null)"
      http_code="$(printf 'Authorization: Bearer %s\n' "$(cat "$tf")" \
        | curl -s --max-time 10 -o /dev/null -w '%{http_code}' -H @- \
          -X POST "$KANBAN_COMMENT_API/api/kanban/$card/comments" -H 'Content-Type: application/json' \
          --data-binary "$cpayload" 2>/dev/null)" || http_code="000"
    fi
    case "$http_code" in 2??) : ;; *) unrecorded+=("$card"); continue ;; esac
    case "$rec_code" in 2??) : ;; *) unrecorded+=("$card") ;; esac
  done
  if [ "${#unrecorded[@]}" -gt 0 ]; then
    say "batch: landed but could not post the LANDOLVA comment for: ${unrecorded[*]} (dashboard unreachable?) -- named in the journal for a repair sweep, push was NOT retried"
    local urec_line; urec_line="$(python3 -c '
import json,sys
print(json.dumps({"mode":"batch-landed-unrecorded","cards":sys.argv[1].split(","),"merge_head":sys.argv[2]}))' \
      "$(IFS=,; echo "${unrecorded[*]}")" "$combined_head" 2>/dev/null)"
    [ -n "$urec_line" ] && printf '%s\n' "$urec_line" >>"$(dirname "$0")/land-runs.jsonl" 2>/dev/null
  fi

  # M1 (WhiteHat2 NO-GO 30647): post the SAME "UNGATED LANDING" note land_one posts, per card that
  # actually rode ungated -- only AFTER the push is confirmed (N2's own reasoning: a note posted
  # before the push is confirmed could end up on a card that never actually landed).
  for card in "${survivors[@]}"; do
    [ -n "${surv_ungated_reason[$card]:-}" ] || continue
    _note_ungated_landing "${surv_agent[$card]}" "$card" "${surv_ungated_reason[$card]}"
  done

  _batch_finish green pushed 0
  trap - TERM HUP INT EXIT
  return 0
}

# Self-test hook, card 46194693 F1 (WhiteHat 17020): the EXISTING --selftest block (above, in
# this same file) only ever exercises release_land_lock_fd/acquire_land_lock in isolation -- it
# `exit`s before land_one's own definition is reached, so it structurally CANNOT call the real
# function. WhiteHat measured exactly that gap: 3 mutants of the cleanup() call sites (a
# dead-branch `false &&` guard, and the call moved into a comment) left that block's own
# text-pin checks green. This hook runs AFTER land_one/land_with_retry are defined, so it can call
# land_one FOR REAL, through a real git fixture, and verify the OS-level flock with an
# independent, real `flock -n` afterward -- not a text search.
if [ "${1:-}" = "--selftest-land-lock-release" ]; then
  # $MAIN (and everything derived from it, like $LAND_LOCK_FILE's default) was already fixed at
  # this file's own top (line ~86, from $MARVEEN_MAIN) BEFORE this hook's code runs -- so the
  # fixture's own path has to be known and exported into MARVEEN_MAIN BEFORE this script starts,
  # not set from inside it. Build the fixture first, under a plain, git-only subshell (no `g`
  # helper needed yet), then re-exec THIS SAME script with MARVEEN_MAIN now pointing at it.
  LFTMP="$(mktemp -d)"
  git init -q --bare "$LFTMP/origin.git"
  git init -q "$LFTMP/seed"
  git -C "$LFTMP/seed" checkout -q -b develop
  git -C "$LFTMP/seed" -c user.email=t@t -c user.name=t commit -q --allow-empty -m seed
  git -C "$LFTMP/seed" remote add origin "$LFTMP/origin.git"
  git -C "$LFTMP/seed" push -q origin develop
  git -C "$LFTMP/origin.git" symbolic-ref HEAD refs/heads/develop
  git clone -q "$LFTMP/origin.git" "$LFTMP/main" 2>/dev/null
  git -C "$LFTMP/main" checkout -q develop
  mkdir -p "$LFTMP/main/store"
  # KANBAN_COMMENT_API dead so no real dashboard call can ever happen (the lock-file default
  # below already resolves correctly off MARVEEN_MAIN, no separate override needed for it).
  exec env MARVEEN_MAIN="$LFTMP/main" MARVEEN_LAND_SELFTEST_TMP="$LFTMP" \
    KANBAN_COMMENT_API="http://127.0.0.1:1" \
    bash "$0" --selftest-land-lock-release-inner
fi

if [ "${1:-}" = "--selftest-land-lock-release-inner" ]; then
  fail=0; n=0
  LFTMP="$MARVEEN_LAND_SELFTEST_TMP"
  trap 'rm -rf "$LFTMP"' EXIT
  # This hook calls land_one() directly, bypassing the main dispatch's own arg-parsing (line
  # ~1186) which normally sets these before land_one is ever reachable. Under `set -u` an unset
  # LAND_CARD at line ~608 (downward_check) is a fatal "unbound variable" that kills the whole
  # script with no RETURN-trap cleanup -- a test-fixture gap, not a real land_one bug. ALLOW_ARCHIVE
  # joined this list when card acffb1d6 wired it into the same decisions_tail_append_ok call site
  # that case B's land_one actually reaches (case A returns before that point, which is why it
  # passed while this was still missing).
  LAND_CARD=""
  ALLOW_STACKED=""
  ALLOW_ARCHIVE=0

  flock_is_free() { # 0 = free (lock acquired and released by THIS probe), 1 = still held
    (
      exec 8>>"$LAND_LOCK_FILE"
      flock -n 8
    ) 2>/dev/null
  }

  # --- case A: the CHEAP exit path through the FIRST cleanup() (lock-only, no worktree yet) ----
  # "already fully landed" (land_one:572) returns 0 before any worktree is created.
  git -C "$LFTMP/main" branch -q "agent/fixture-a/work" develop
  land_one fixture-a false > "$LFTMP/out-a" 2>&1
  n=$((n+1))
  if flock_is_free; then echo "  ok   case A (already-landed, first cleanup()): lock is free after land_one returns"
  else echo "  FAIL case A: lock STILL HELD after land_one returned (out: $(cat "$LFTMP/out-a"))"; fail=1; fi

  # --- case B: a REAL failure AFTER the worktree is created, through the SECOND cleanup() (lock
  # + worktree removal) -- MARVEEN_LAND_TEST=false forces fleet-test to "fail" without running it.
  git -C "$LFTMP/main" checkout -q -b "agent/fixture-b/work" develop
  echo change > "$LFTMP/main/fixture-b-file.txt"
  git -C "$LFTMP/main" add fixture-b-file.txt
  git -C "$LFTMP/main" -c user.email=t@t -c user.name=t commit -q -m "fixture-b change"
  git -C "$LFTMP/main" checkout -q develop
  n=$((n+1))
  # TEST_CMD is read ONCE from MARVEEN_LAND_TEST at this script's own top (line ~422, long before
  # this hook runs) -- a per-call env prefix on a shell FUNCTION call does not retroactively change
  # an already-computed global, so it is reassigned directly here instead.
  TEST_CMD=false
  land_one fixture-b false > "$LFTMP/out-b" 2>&1
  if flock_is_free; then echo "  ok   case B (fleet-test failure, second cleanup()): lock is free after land_one returns"
  else echo "  FAIL case B: lock STILL HELD after land_one returned (out: $(cat "$LFTMP/out-b"))"; fail=1; fi
  n=$((n+1))
  # F2 fix (Cybered NO-GO 29382): use the EXACT path -- marveen-land-fixture-b-$$ -- not a glob.
  # A glob matches every concurrent run's fixture worktree: 8-parallel test measured 1/8 false FAILs
  # and rm -rf on the glob deletes another run's live worktree mid-run.
  if ls -d "/home/neon/marveen-land-fixture-b-$$" >/dev/null 2>&1; then
    echo "  FAIL case B: the disposable landing worktree was not removed"; fail=1
    rm -rf "/home/neon/marveen-land-fixture-b-$$" 2>/dev/null
  else
    echo "  ok   case B: the disposable landing worktree was removed (second cleanup() ran)"
  fi

  echo
  if [ "$fail" -eq 0 ]; then echo "selftest-land-lock-release: $n case(s), PASS"; exit 0
  else echo "selftest-land-lock-release: $n case(s), FAIL"; exit 1
  fi
fi

# Self-test for land_batch (card 6ec8e9d8). Same two-step re-exec pattern as
# --selftest-land-lock-release above: build a fixture, re-exec THIS script with MARVEEN_MAIN
# pointing at it so land_batch's own definition is reachable and real, then run against it.
if [ "${1:-}" = "--selftest-land-batch" ]; then
  LBTMP="$(mktemp -d)"
  git init -q --bare "$LBTMP/origin.git"
  git init -q "$LBTMP/seed"
  git -C "$LBTMP/seed" checkout -q -b develop
  # A real package.json (QA FAIL 30639, Fix-Direction A2): without one, bump_fork_version silently
  # skips (no file to bump), and the version-bump amendment goes completely unexercised.
  printf '{\n  "name": "fixture",\n  "version": "0.0.1+mikrob.1",\n  "private": true\n}\n' >"$LBTMP/seed/package.json"
  # package-lock.json too (QA FAIL 30639 debugging note, not in the original card but needed for a
  # faithful fixture): `git add package.json package-lock.json` is atomic across its own arguments
  # -- a missing package-lock.json makes git refuse to stage EITHER file, so bump_fork_version's own
  # "commit -q" (land_one's pre-existing pattern, line ~1509, copied unchanged into land_batch)
  # silently produces no commit. Real landings never hit this because package-lock.json always
  # exists; the fixture needs it too, or the fixture lies about what production actually does.
  printf '{\n  "name": "fixture",\n  "version": "0.0.1",\n  "lockfileVersion": 3,\n  "packages": {"": {"name": "fixture", "version": "0.0.1"}}\n}\n' >"$LBTMP/seed/package-lock.json"
  git -C "$LBTMP/seed" add package.json package-lock.json
  git -C "$LBTMP/seed" -c user.email=t@t -c user.name=t commit -q -m seed
  git -C "$LBTMP/seed" remote add origin "$LBTMP/origin.git"
  git -C "$LBTMP/seed" push -q origin develop
  git -C "$LBTMP/origin.git" symbolic-ref HEAD refs/heads/develop
  git clone -q "$LBTMP/origin.git" "$LBTMP/main" 2>/dev/null
  git -C "$LBTMP/main" checkout -q develop
  mkdir -p "$LBTMP/main/store"
  # Dead-port overrides for BOTH the kanban-comment and gate-verdict API/token: real-dashboard
  # calls must never happen from a selftest (same reasoning as --selftest-land-lock-release).
  exec env MARVEEN_MAIN="$LBTMP/main" MARVEEN_LAND_BATCH_SELFTEST_TMP="$LBTMP" \
    KANBAN_COMMENT_API="http://127.0.0.1:1" GATE_CHECK_API="http://127.0.0.1:1" \
    GATE_CHECK_TOKEN_FILE="$LBTMP/no-such-token" \
    bash "$0" --selftest-land-batch-inner
fi

if [ "${1:-}" = "--selftest-land-batch-inner" ]; then
  fail=0; n=0
  LBTMP="$MARVEEN_LAND_BATCH_SELFTEST_TMP"
  trap 'rm -rf "$LBTMP"' EXIT
  LAND_CARD=""; ALLOW_STACKED=""; ALLOW_ARCHIVE=0
  # M2 (WhiteHat2 NO-GO 30647): this used to set CARD_ALLOW_UNGATED=1 BLANKET for every case, which
  # (with GATE_CHECK_TOKEN_FILE below deliberately unreadable) made every per-card refusal path --
  # FAILING verdict, no-AGREE designated gates, the downward/DECISIONS/seam-loss drops -- untestable
  # by construction: measured, 12 of those mutants survived --selftest-land-batch unchanged.
  # CARD_ALLOW_UNGATED stays 0 (its real default); each case below sets ALLOW_UNGATED_CARDS to
  # exactly its own survivors' ids -- the SAME scoped tolerance M1 now requires in production -- so
  # cases A-F keep tolerating their own fixture's unreadable-token "no usable verdict", but ONLY for
  # the cards actually in that call, never as a side effect of some other case's cards. Case G below
  # runs with a REAL gate stub and NO blanket tolerance at all, proving the drops are real.
  CARD_ALLOW_UNGATED=0
  ORIGIN="$LBTMP/origin.git"

  _lb_mkmain() { # $1 = subdir name; returns (echoes) the new $MAIN
    git clone -q "$ORIGIN" "$LBTMP/$1" 2>/dev/null
    git -C "$LBTMP/$1" checkout -q develop
    git -C "$LBTMP/$1" config user.email t@t
    git -C "$LBTMP/$1" config user.name t
    echo "$LBTMP/$1"
  }
  # Card branches are LOCAL refs in $MAIN, same as the real agent-worktree-marveen.sh --card
  # convention land_one itself reads (`g show-ref --verify refs/heads/$branch`) -- NOT something
  # fetched from origin.
  _lb_mkcard() { # $1 = card id, $2 = filename, $3 = content -- branches off $MAIN's current develop
    git -C "$MAIN" checkout -q -b "card/$1" develop
    echo "$3" >"$MAIN/$2"
    git -C "$MAIN" add "$2"
    git -C "$MAIN" -c user.email=t@t -c user.name=t commit -q -m "card $1"
    git -C "$MAIN" checkout -q develop
  }

  cat >"$LBTMP/stub-ok.sh" <<'EOS'
#!/usr/bin/env bash
echo "$(( $(cat "$STUB_COUNTER_FILE" 2>/dev/null || echo 0) + 1 ))" >"$STUB_COUNTER_FILE"
exit 0
EOS
  chmod +x "$LBTMP/stub-ok.sh"
  # First invocation (the combined batch run) fails; every later one (land_with_retry's one-by-one
  # fallback) succeeds -- simulates a real cross-card interaction that only shows up combined.
  cat >"$LBTMP/stub-first-red.sh" <<'EOS'
#!/usr/bin/env bash
n=$(( $(cat "$STUB_COUNTER_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$STUB_COUNTER_FILE"
if [ "$n" -eq 1 ]; then echo "FAIL in cross-card.test.ts"; exit 1; fi
exit 0
EOS
  chmod +x "$LBTMP/stub-first-red.sh"

  # Always red -- the combined run AND every fallback attempt fail (card I, L1).
  cat >"$LBTMP/stub-always-red.sh" <<'EOS'
#!/usr/bin/env bash
echo "FAIL in always-red.test.ts"
exit 1
EOS
  chmod +x "$LBTMP/stub-always-red.sh"

  # --- case A: green batch, 2 cards -- ONE fleet-test call, ONE push, both land -----------------
  # Also pins A2 (exactly one version-bump commit for the WHOLE batch, not per card) and A3 (the
  # journal's started/heartbeat/finished triple + the batch line, both land in land-runs.jsonl) --
  # QA FAIL 30639: neither was asserted before, and mutating either out stayed green.
  MAIN="$(_lb_mkmain caseA)"
  _lb_mkcard a1 a1.txt hello
  _lb_mkcard a2 a2.txt world
  n=$((n+1))
  export STUB_COUNTER_FILE="$LBTMP/caseA-count"
  TEST_CMD="$LBTMP/stub-ok.sh"
  _JRNL="$(dirname "$0")/land-runs.jsonl"
  _jrnl_before="$(wc -l <"$_JRNL" 2>/dev/null || echo 0)"
  _a_base="$(git -C "$MAIN" rev-parse origin/develop)"
  ALLOW_UNGATED_CARDS="a1,a2"
  land_batch 0 "a1:fixture" "a2:fixture" >"$LBTMP/out-a.txt" 2>&1
  out_a="$(cat "$LBTMP/out-a.txt")"
  calls_a="$(cat "$STUB_COUNTER_FILE" 2>/dev/null || echo 0)"
  bumps_a="$(git -C "$MAIN" log --oneline "${_a_base}..origin/develop" 2>/dev/null | grep -c 'chore(version): bump')"
  _jrnl_new="$(tail -n "+$((_jrnl_before + 1))" "$_JRNL" 2>/dev/null)"
  a3_ok=0
  if printf '%s\n' "$_jrnl_new" | python3 -c '
import sys, json
lines = [l for l in sys.stdin if l.strip()]
events = []
run_ids = set()
batch_line = None
for l in lines:
    try:
        o = json.loads(l)
    except Exception:
        continue
    if o.get("mode") == "batch":
        batch_line = o
        continue
    if "event" in o:
        events.append(o["event"])
        if o.get("run_id"):
            run_ids.add(o["run_id"])
ok = ("started" in events and "finished" in events
      and len(run_ids) == 1 and batch_line is not None
      and batch_line.get("result") == "pushed")
sys.exit(0 if ok else 1)
'; then a3_ok=1; fi
  # L2 (WhiteHat2 NO-GO 30647): land_one runs sync_live_install/blast-radius/graphify/kg-check
  # after every single-card push; land_batch pushed too but never ran them. Both leave a line in
  # this fixture's output (no API keys configured, so blast-radius/graphify/kg-check degrade to a
  # one-line "skipped"/"tip" message rather than erroring -- still proof the step was REACHED).
  l2_ok=0
  printf '%s' "$out_a" | grep -q "fast-forwarded to origin/develop" \
    && printf '%s' "$out_a" | grep -q "graphify:" \
    && l2_ok=1
  if [ "$calls_a" = "1" ] && [ "$bumps_a" = "1" ] && [ "$a3_ok" = "1" ] && [ "$l2_ok" = "1" ] \
     && git -C "$MAIN" merge-base --is-ancestor "card/a1" "origin/develop" \
     && git -C "$MAIN" merge-base --is-ancestor "card/a2" "origin/develop"; then
    echo "  ok   case A: green batch -- 1 fleet-test call, 1 version-bump commit (A2), journal triple + batch line present under one run_id (A3), both cards landed, post-push sync_live_install+graphify ran once (L2)"
  else
    echo "  FAIL case A: fleet-test calls=$calls_a (want 1), bump commits=$bumps_a (want 1), journal-ok=$a3_ok, l2-ok=$l2_ok; output:"; echo "$out_a" | sed 's/^/    /'; fail=1
  fi

  # --- case B: a card with no branch is dropped and named, the other still lands ----------------
  MAIN="$(_lb_mkmain caseB)"
  _lb_mkcard b1 b1.txt hello
  n=$((n+1))
  export STUB_COUNTER_FILE="$LBTMP/caseB-count"
  TEST_CMD="$LBTMP/stub-ok.sh"
  ALLOW_UNGATED_CARDS="b1,doesnotexist"
  land_batch 0 "b1:fixture" "doesnotexist:fixture" >"$LBTMP/out-b.txt" 2>&1
  out_b="$(cat "$LBTMP/out-b.txt")"
  if git -C "$MAIN" merge-base --is-ancestor "card/b1" "origin/develop" \
     && printf '%s' "$out_b" | grep -q "doesnotexist"; then
    echo "  ok   case B: card with no branch dropped and named by id, survivor still landed"
  else
    echo "  FAIL case B: output:"; echo "$out_b" | sed 's/^/    /'; fail=1
  fi

  # --- case C: a RED combined run falls back to landing survivors one at a time ------------------
  # Also pins A5 (first_failing_file in the batch's land-runs.jsonl line names the ACTUAL injected
  # failing test file, not just "a fallback happened" -- QA FAIL 30639).
  MAIN="$(_lb_mkmain caseC)"
  _lb_mkcard c1 c1.txt hello
  _lb_mkcard c2 c2.txt world
  n=$((n+1))
  export STUB_COUNTER_FILE="$LBTMP/caseC-count"
  TEST_CMD="$LBTMP/stub-first-red.sh"
  _jrnl_before="$(wc -l <"$_JRNL" 2>/dev/null || echo 0)"
  ALLOW_UNGATED_CARDS="c1,c2"
  land_batch 0 "c1:fixture" "c2:fixture" >"$LBTMP/out-c.txt" 2>&1
  out_c="$(cat "$LBTMP/out-c.txt")"
  calls_c="$(cat "$STUB_COUNTER_FILE" 2>/dev/null || echo 0)"
  c_fff="$(tail -n "+$((_jrnl_before + 1))" "$_JRNL" 2>/dev/null | python3 -c '
import sys, json
for l in sys.stdin:
    l = l.strip()
    if not l:
        continue
    try:
        o = json.loads(l)
    except Exception:
        continue
    if o.get("mode") == "batch":
        print(o.get("first_failing_file") or "")
' 2>/dev/null | tail -1)"
  # H1 (WhiteHat2 NO-GO 30647): the fallback MUST re-run land_one's own per-card gate-check for
  # EACH card it lands one-by-one, not just merge whatever the branch tip is now. The giveaway is
  # land_one's OWN "gate-check:" line (distinct from land_batch's "batch: cX gate-check:" line
  # above, which only proves the BATCH-level check ran, not the fallback's) -- it is printed ONLY
  # from inside land_one's `if [ -n "$LAND_CARD" ]` block, so it appears once per fallback card iff
  # the four fallback loops actually set LAND_CARD before calling land_with_retry. Mutating that
  # one `LAND_CARD="$card"` prefix back out (verified by hand) drops this count to 0 while every
  # other assertion in this case stays green -- this is the dedicated pin H1's own fix-direction
  # asked for ("it needs a selftest that fails without it").
  h1_gatecheck_lines="$(printf '%s' "$out_c" | grep -c 'skipped (report mode)')"
  if [ "$calls_c" -ge 2 ] && [ "$c_fff" = "cross-card.test.ts" ] \
     && git -C "$MAIN" merge-base --is-ancestor "card/c1" "origin/develop" \
     && git -C "$MAIN" merge-base --is-ancestor "card/c2" "origin/develop" \
     && printf '%s' "$out_c" | grep -q "falling back" \
     && [ "$h1_gatecheck_lines" -ge 2 ]; then
    echo "  ok   case C: RED combined run fell back -- both landed one-by-one ($calls_c fleet-test calls), first_failing_file=$c_fff (A5), land_one's own gate-check ran for both fallback cards, $h1_gatecheck_lines time(s) (H1)"
  else
    echo "  FAIL case C: fleet-test calls=$calls_c, first_failing_file=[$c_fff] (want cross-card.test.ts), H1 gate-check lines=$h1_gatecheck_lines (want >=2); output:"; echo "$out_c" | sed 's/^/    /'; fail=1
  fi

  # --- case D (A1): a card landed directly while the batch was forming is dropped, not re-merged -
  MAIN="$(_lb_mkmain caseD)"
  _lb_mkcard d1 d1.txt hello
  _lb_mkcard d2 d2.txt world
  git -C "$MAIN" fetch -q origin develop
  git -C "$MAIN" checkout -q develop
  git -C "$MAIN" merge --no-ff -q "card/d1" -m "pre-landed d1 (simulates a concurrent --card land)"
  git -C "$MAIN" push -q origin develop
  n=$((n+1))
  export STUB_COUNTER_FILE="$LBTMP/caseD-count"
  TEST_CMD="$LBTMP/stub-ok.sh"
  ALLOW_UNGATED_CARDS="d1,d2"
  land_batch 0 "d1:fixture" "d2:fixture" >"$LBTMP/out-d.txt" 2>&1
  out_d="$(cat "$LBTMP/out-d.txt")"
  if printf '%s' "$out_d" | grep -qi "already landed" \
     && git -C "$MAIN" merge-base --is-ancestor "card/d2" "origin/develop"; then
    echo "  ok   case D: a card landed concurrently is dropped as already-landed, never merged twice"
  else
    echo "  FAIL case D: output:"; echo "$out_d" | sed 's/^/    /'; fail=1
  fi

  # --- case F (A4): push succeeds, but the LANDOLVA comment/card-landings POST for the SECOND
  # survivor comes back non-2xx -- the push must NOT be retried, and the card must be named in a
  # "batch-landed-unrecorded" journal line. QA FAIL 30639: this amendment had no dedicated case at
  # all before. A tiny real HTTP stub (not a mock of record_card_landing/kanban_comment_on --
  # those functions run FOR REAL and make a real HTTP call, just to this stub) distinguishes the
  # two cards by id, so only f2's calls fail.
  cat >"$LBTMP/stub-dashboard.py" <<'EOS'
import http.server, json, os, socketserver, sys
FAIL_CARD = os.environ.get("STUB_FAIL_CARD", "")
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        body = self.rfile.read(length) if length else b""
        bad = bool(FAIL_CARD) and (FAIL_CARD in self.path)
        if FAIL_CARD and not bad:
            try:
                data = json.loads(body or b"{}")
                bad = data.get("card_id") == FAIL_CARD
            except Exception:
                pass
        self.send_response(500 if bad else 200)
        self.end_headers()
    def log_message(self, *a):
        pass
with socketserver.TCPServer(("127.0.0.1", 0), H) as httpd:
    print(httpd.server_address[1])
    sys.stdout.flush()
    httpd.serve_forever()
EOS
  n=$((n+1))
  MAIN="$(_lb_mkmain caseF)"
  _lb_mkcard f1 f1.txt hello
  _lb_mkcard f2 f2.txt world
  : >"$LBTMP/stub-dash-port"
  STUB_FAIL_CARD=f2 python3 "$LBTMP/stub-dashboard.py" >"$LBTMP/stub-dash-port" 2>/dev/null &
  stub_pid=$!
  for _i in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$LBTMP/stub-dash-port" ] && break
    sleep 0.2
  done
  stub_port="$(cat "$LBTMP/stub-dash-port" 2>/dev/null)"
  echo dummy >"$LBTMP/dummy-token"
  export STUB_COUNTER_FILE="$LBTMP/caseF-count"
  TEST_CMD="$LBTMP/stub-ok.sh"
  _jrnl_before="$(wc -l <"$_JRNL" 2>/dev/null || echo 0)"
  _f_base="$(git -C "$MAIN" rev-parse origin/develop)"
  ALLOW_UNGATED_CARDS="f1,f2"
  KANBAN_COMMENT_API="http://127.0.0.1:${stub_port}" KANBAN_COMMENT_TOKEN_FILE="$LBTMP/dummy-token" \
    land_batch 0 "f1:fixture" "f2:fixture" >"$LBTMP/out-f.txt" 2>&1
  out_f="$(cat "$LBTMP/out-f.txt")"
  kill "$stub_pid" 2>/dev/null; wait "$stub_pid" 2>/dev/null
  bumps_f="$(git -C "$MAIN" log --oneline "${_f_base}..origin/develop" 2>/dev/null | grep -c 'chore(version): bump')"
  f_unrec="$(tail -n "+$((_jrnl_before + 1))" "$_JRNL" 2>/dev/null | python3 -c '
import sys, json
for l in sys.stdin:
    l = l.strip()
    if not l:
        continue
    try:
        o = json.loads(l)
    except Exception:
        continue
    if o.get("mode") == "batch-landed-unrecorded":
        print(",".join(o.get("cards", [])))
' 2>/dev/null | tail -1)"
  if [ "$f_unrec" = "f2" ] && [ "$bumps_f" = "1" ] \
     && git -C "$MAIN" merge-base --is-ancestor "card/f1" "origin/develop" \
     && git -C "$MAIN" merge-base --is-ancestor "card/f2" "origin/develop"; then
    echo "  ok   case F (A4): both cards landed (1 push, bump commits=$bumps_f), f2's record/comment failure named in a batch-landed-unrecorded line, push not retried"
  else
    echo "  FAIL case F: unrecorded=[$f_unrec] (want f2), bump commits=$bumps_f (want 1); output:"; echo "$out_f" | sed 's/^/    /'; fail=1
  fi

  # --- case I (L1, WhiteHat2 NO-GO 30647): the combined run is red AND every fallback attempt is
  # ALSO refused (TEST_CMD always fails) -- land_batch used to `return 0` unconditionally from the
  # fallback sites, so a caller could not tell this apart from "fell back and everything landed".
  n=$((n+1))
  MAIN="$(_lb_mkmain caseI)"
  _lb_mkcard i1 i1.txt hello
  _lb_mkcard i2 i2.txt world
  export STUB_COUNTER_FILE="$LBTMP/caseI-count"
  TEST_CMD="$LBTMP/stub-always-red.sh"
  ALLOW_UNGATED_CARDS="i1,i2"
  _i_base="$(git -C "$MAIN" rev-parse origin/develop)"
  land_batch 0 "i1:fixture" "i2:fixture" >"$LBTMP/out-i.txt" 2>&1
  rc_i=$?
  out_i="$(cat "$LBTMP/out-i.txt")"
  if [ "$rc_i" -ne 0 ] \
     && ! git -C "$MAIN" merge-base --is-ancestor "card/i1" "origin/develop" 2>/dev/null \
     && ! git -C "$MAIN" merge-base --is-ancestor "card/i2" "origin/develop" 2>/dev/null \
     && [ "$(git -C "$MAIN" rev-parse origin/develop)" = "$_i_base" ]; then
    echo "  ok   case I (L1): combined run red + every fallback attempt refused -- land_batch exits non-zero ($rc_i), nothing landed, develop tip unchanged"
  else
    echo "  FAIL case I: rc=$rc_i (want non-zero), develop moved=$([ "$(git -C "$MAIN" rev-parse origin/develop)" = "$_i_base" ] && echo no || echo yes); output:"; echo "$out_i" | sed 's/^/    /'; fail=1
  fi

  # --- case J (M4, WhiteHat2 NO-GO 30647; P3 delta, CYBERED NO-GO 30643): TERM/HUP/INT mid-batch
  # -- the wrapped fleet-test's whole process group must die (no orphan), the disposable worktree
  # must be removed, and the journal must record the run as "aborted", not a plain
  # "finished"/exit 0. Runs land_batch as a genuinely separate process (see the
  # --selftest-land-batch-case-j-run hook above) so the signal lands on the SAME process that set
  # the trap -- backgrounding a function call in THIS shell would not.
  #
  # P3 fix (CYBERED NO-GO 30643): the old pin watched `pgrep -f stub-sleep.sh`, which matches the
  # STUB SHELL's own argv (it contains the string "stub-sleep.sh"), not the `sleep 300` GRANDCHILD
  # it spawns -- a mutant that kills only the single top-level pid (not the whole process group)
  # still kills that shell, so the pin stayed green while the real `sleep 300` was orphaned. The
  # pattern was also host-global, so it could match a leftover process from an unrelated run. The
  # stub now writes the REAL sleep pid to a file of its own, and the test reads that file instead
  # of pattern-matching a process list.
  for _sig_pair in "TERM:143" "HUP:129" "INT:130"; do
    _sig="${_sig_pair%%:*}"; _sig_rc="${_sig_pair#*:}"
    n=$((n+1))
    MAIN="$(_lb_mkmain "caseJ${_sig}")"
    _lb_mkcard j1 j1.txt hello
    _sleep_pid_file="$LBTMP/caseJ${_sig}-sleep-pid"
    rm -f "$_sleep_pid_file"
    # A non-interactive bash auto-ignores SIGINT/SIGQUIT for a backgrounded ('&') job when job
    # control is off (measured: a plain \`sleep 300 &\` in this stub survived a process-group
    # SIGINT untouched, while the identical TERM/HUP delivery killed it) -- the group kill below
    # genuinely reaches this child for all three signals, but the kernel drops INT for it before
    # that. \`trap - INT HUP TERM\` inside the subshell resets the disposition to default BEFORE
    # exec, which overrides the shell's auto-ignore; \`exec\` then replaces the subshell with sleep
    # itself (same pid), so \$! after backgrounding is still the real sleep pid.
    cat >"$LBTMP/stub-sleep-${_sig}.sh" <<EOF
#!/usr/bin/env bash
( trap - INT HUP TERM; exec sleep 300 ) &
echo \$! >"$_sleep_pid_file"
wait
EOF
    chmod +x "$LBTMP/stub-sleep-${_sig}.sh"
    : >"$LBTMP/caseJ${_sig}-count"
    _jrnl_before="$(wc -l <"$_JRNL" 2>/dev/null || echo 0)"
    # Same auto-ignore as the stub-sleep fix above, one level up: THIS shell backgrounds the
    # subject process with plain `&` from a non-job-control script, so bash sets that process's
    # OWN SIGINT disposition to SIG_IGN before it ever runs -- and an explicit `trap ... INT`
    # inside it (land_batch's own trap, line ~1900) cannot override an inherited ignore, only an
    # inherited default. Measured with a minimal repro: an identical child script with its own
    # `trap 'echo got INT' INT`, backgrounded by a plain `&` here, never printed and stayed alive
    # after `kill -INT`; wrapping the launch in `( trap - INT HUP TERM; exec ... )` made the same
    # child's trap fire immediately. `exec` keeps `$!` as the real subject process's pid.
    ( trap - INT HUP TERM; exec bash "$0" --selftest-land-batch-case-j-run "$MAIN" "$LBTMP/stub-sleep-${_sig}.sh" "j1" "$LBTMP/caseJ${_sig}-count" ) \
      >"$LBTMP/out-j${_sig}.txt" 2>&1 &
    lb_pid=$!
    worktree_path="/home/neon/marveen-land-batch-${lb_pid}"
    for _i in $(seq 1 100); do
      [ -s "$_sleep_pid_file" ] && [ -d "$worktree_path" ] && break
      sleep 0.1
    done
    sleep_pid="$(cat "$_sleep_pid_file" 2>/dev/null)"
    kill "-$_sig" "$lb_pid" 2>/dev/null
    wait "$lb_pid" 2>/dev/null
    rc_j=$?
    sleep 0.3
    out_j="$(cat "$LBTMP/out-j${_sig}.txt" 2>/dev/null)"
    sleep_dead=0
    { [ -n "$sleep_pid" ] && ! kill -0 "$sleep_pid" 2>/dev/null; } && sleep_dead=1
    wt_gone=0
    [ ! -d "$worktree_path" ] && wt_gone=1
    j_aborted="$(tail -n "+$((_jrnl_before + 1))" "$_JRNL" 2>/dev/null | python3 -c '
import sys, json
for l in sys.stdin:
    l = l.strip()
    if not l:
        continue
    try:
        o = json.loads(l)
    except Exception:
        continue
    if o.get("event") == "finished":
        print(o.get("result") or "")
' 2>/dev/null | tail -1)"
    if [ "$rc_j" = "$_sig_rc" ] && [ -n "$sleep_pid" ] && [ "$sleep_dead" = "1" ] && [ "$wt_gone" = "1" ] && [ "$j_aborted" = "aborted" ]; then
      echo "  ok   case J-$_sig (M4/P3): $_sig mid-batch kills the wrapped fleet-test's REAL child ($sleep_pid, process-group kill, not just the stub shell), no orphan, removes the disposable worktree, journal records aborted (rc $rc_j)"
    else
      echo "  FAIL case J-$_sig: rc=$rc_j (want $_sig_rc), sleep_pid=[$sleep_pid], dead=$sleep_dead (want 1), worktree_gone=$wt_gone (want 1), journal_result=[$j_aborted] (want aborted); output:"; echo "$out_j" | sed 's/^/    /'; fail=1
    fi
  done

  # --- case G (M2, WhiteHat2 NO-GO 30647): a REAL gate stub (not a dead port), no blanket
  # tolerance at all -- proves the per-card drops are real, not just "untested because every check
  # was overridden". Five cards in ONE batch call: g1 has a QA PASS + a matching "qa" designated
  # gate -> lands clean; g2 has no verdict at all and is NOT in ALLOW_UNGATED_CARDS -> dropped; g3
  # has a QA FAIL -> dropped (never overridable); g4 has a QA PASS but designates "qa, cybersec"
  # with no cybersec verdict -> dropped (designated gates do not AGREE); g5 has no verdict either,
  # but IS named in ALLOW_UNGATED_CARDS -> lands, and (M1) gets its OWN "UNGATED LANDING" comment,
  # naming only g5, never g2/g3/g4/g1.
  cat >"$LBTMP/stub-dashboard-gates.py" <<'EOS'
import http.server, json, os, re, socketserver, sys
KANBAN_LIST = json.load(open(os.environ["STUB_KANBAN_LIST_FILE"]))
COMMENTS = json.load(open(os.environ["STUB_COMMENTS_FILE"]))
LOG_FILE = os.environ.get("STUB_POST_LOG", "")
class H(http.server.BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def do_GET(self):
        if self.path == "/api/kanban":
            self._json(KANBAN_LIST); return
        m = re.match(r"^/api/kanban/([^/]+)/comments$", self.path)
        if m:
            self._json(COMMENTS.get(m.group(1), [])); return
        self._json([], 404)
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        body = self.rfile.read(length) if length else b""
        if LOG_FILE:
            with open(LOG_FILE, "a") as f:
                f.write(self.path + "\t" + body.decode(errors="replace") + "\n")
        self.send_response(200); self.end_headers()
    def log_message(self, *a):
        pass
with socketserver.TCPServer(("127.0.0.1", 0), H) as httpd:
    print(httpd.server_address[1]); sys.stdout.flush()
    httpd.serve_forever()
EOS
  n=$((n+1))
  MAIN="$(_lb_mkmain caseG)"
  _lb_mkcard g1 g1.txt g1
  _lb_mkcard g2 g2.txt g2
  _lb_mkcard g3 g3.txt g3
  _lb_mkcard g4 g4.txt g4
  _lb_mkcard g5 g5.txt g5
  g_sha1="$(git -C "$MAIN" rev-parse card/g1)"
  g_sha3="$(git -C "$MAIN" rev-parse card/g3)"
  g_sha4="$(git -C "$MAIN" rev-parse card/g4)"
  python3 -c '
import json, sys
print(json.dumps([
  {"id": "g1", "description": "Gate: qa"},
  {"id": "g2", "description": "Gate: qa"},
  {"id": "g3", "description": "Gate: qa"},
  {"id": "g4", "description": "Gate: qa, cybersec"},
  {"id": "g5", "description": "Gate: qa"},
]))' >"$LBTMP/caseG-kanban.json"
  python3 -c '
import json, sys
sha1, sha3, sha4 = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
  "g1": [{"author": "qa", "content": f"QA PASS\nGate-SHA: {sha1}"}],
  "g2": [],
  "g3": [{"author": "qa", "content": f"QA FAIL\nGate-SHA: {sha3}"}],
  "g4": [{"author": "qa", "content": f"QA PASS\nGate-SHA: {sha4}"}],
  "g5": [],
}))' "$g_sha1" "$g_sha3" "$g_sha4" >"$LBTMP/caseG-comments.json"
  : >"$LBTMP/caseG-post-log"
  : >"$LBTMP/caseG-gate-port"
  STUB_KANBAN_LIST_FILE="$LBTMP/caseG-kanban.json" STUB_COMMENTS_FILE="$LBTMP/caseG-comments.json" \
    STUB_POST_LOG="$LBTMP/caseG-post-log" python3 "$LBTMP/stub-dashboard-gates.py" \
    >"$LBTMP/caseG-gate-port" 2>/dev/null &
  gate_stub_pid=$!
  for _i in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$LBTMP/caseG-gate-port" ] && break
    sleep 0.2
  done
  gate_stub_port="$(cat "$LBTMP/caseG-gate-port" 2>/dev/null)"
  echo dummy >"$LBTMP/caseG-token"
  export STUB_COUNTER_FILE="$LBTMP/caseG-count"
  TEST_CMD="$LBTMP/stub-ok.sh"
  ALLOW_UNGATED_CARDS="g5"
  GATE_CHECK_API="http://127.0.0.1:${gate_stub_port}" GATE_CHECK_TOKEN_FILE="$LBTMP/caseG-token" \
    KANBAN_COMMENT_API="http://127.0.0.1:${gate_stub_port}" KANBAN_COMMENT_TOKEN_FILE="$LBTMP/caseG-token" \
    land_batch 0 "g1:fixture" "g2:fixture" "g3:fixture" "g4:fixture" "g5:fixture" \
    >"$LBTMP/out-g.txt" 2>&1
  out_g="$(cat "$LBTMP/out-g.txt")"
  kill "$gate_stub_pid" 2>/dev/null; wait "$gate_stub_pid" 2>/dev/null
  g_ungated_log="$(grep -c 'UNGATED LANDING' "$LBTMP/caseG-post-log" 2>/dev/null || echo 0)"
  g_ungated_for_g5="$(grep -c '^/api/kanban/g5/comments.*UNGATED LANDING' "$LBTMP/caseG-post-log" 2>/dev/null || echo 0)"
  if git -C "$MAIN" merge-base --is-ancestor "card/g1" "origin/develop" \
     && git -C "$MAIN" merge-base --is-ancestor "card/g5" "origin/develop" \
     && ! git -C "$MAIN" merge-base --is-ancestor "card/g2" "origin/develop" 2>/dev/null \
     && ! git -C "$MAIN" merge-base --is-ancestor "card/g3" "origin/develop" 2>/dev/null \
     && ! git -C "$MAIN" merge-base --is-ancestor "card/g4" "origin/develop" 2>/dev/null \
     && printf '%s' "$out_g" | grep -q "dropping g2 -- no passing gate verdict" \
     && printf '%s' "$out_g" | grep -q "dropping g3 -- FAILING gate verdict" \
     && printf '%s' "$out_g" | grep -q "dropping g4 -- designated gates do not AGREE" \
     && [ "$g_ungated_log" = "1" ] && [ "$g_ungated_for_g5" = "1" ]; then
    echo "  ok   case G (M2): real gate stub, no blanket tolerance -- g1 (AGREE) and g5 (scoped --allow-ungated-cards) land, g2 (no verdict)/g3 (FAILING)/g4 (designated gates disagree) are genuinely dropped, exactly one UNGATED LANDING note posted and it names g5"
  else
    echo "  FAIL case G: g_ungated_log=$g_ungated_log g_ungated_for_g5=$g_ungated_for_g5; output:"; echo "$out_g" | sed 's/^/    /'; fail=1
  fi

  # --- case K (P1, CYBERED NO-GO 30643): the exact scenario cybersec2 reproduced live through the
  # real CLI -- card f1 gated PASS at an OLD sha, the combined run goes RED, the builder commits
  # MORE WORK on card/f1 DURING that window (new tip, no verdict for it), the batch falls back.
  # land_one's own gate-check must REFUSE f1 at the new tip, not just log that a check ran.
  #
  # Case C's H1 pin only counts "skipped (report mode)" lines -- that string is land_one's
  # board-unreadable fallback, printed because CARD_BRANCH_MODE is never 1 when a selftest case
  # calls land_batch() directly (only the real `--batch` CLI dispatch block sets it). In report
  # mode a MISSING verdict never refuses (only a FAILING one does, unconditionally) -- so case C's
  # pin proves the gate-check function was ENTERED, not that it can actually stop a bad landing.
  # Entering through `bash "$0" --batch ...` (not a direct land_batch() call, unlike every other
  # case here) sets CARD_BRANCH_MODE=1 exactly as production does, so this case also closes the
  # "selftest never exercises the --batch dispatch block itself" gap (the CARD_BRANCH_MODE=1 line
  # at that dispatch site had zero coverage before this).
  n=$((n+1))
  MAIN="$(_lb_mkmain caseK)"
  mkdir -p "$MAIN/store"
  _lb_mkcard k1 k1.txt hello
  _lb_mkcard k2 k2.txt world
  k1_sha_old="$(git -C "$MAIN" rev-parse card/k1)"
  k2_sha="$(git -C "$MAIN" rev-parse card/k2)"
  python3 -c '
import json
print(json.dumps([{"id": "k1", "description": "Gate: qa"}, {"id": "k2", "description": "Gate: qa"}]))' \
    >"$LBTMP/caseK-kanban.json"
  python3 -c '
import json, sys
sha1, sha2 = sys.argv[1], sys.argv[2]
print(json.dumps({
  "k1": [{"author": "qa", "content": f"QA PASS\nGate-SHA: {sha1}"}],
  "k2": [{"author": "qa", "content": f"QA PASS\nGate-SHA: {sha2}"}],
}))' "$k1_sha_old" "$k2_sha" >"$LBTMP/caseK-comments.json"
  : >"$LBTMP/caseK-post-log"
  : >"$LBTMP/caseK-gate-port"
  STUB_KANBAN_LIST_FILE="$LBTMP/caseK-kanban.json" STUB_COMMENTS_FILE="$LBTMP/caseK-comments.json" \
    STUB_POST_LOG="$LBTMP/caseK-post-log" python3 "$LBTMP/stub-dashboard-gates.py" \
    >"$LBTMP/caseK-gate-port" 2>/dev/null &
  k_gate_pid=$!
  for _i in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$LBTMP/caseK-gate-port" ] && break
    sleep 0.2
  done
  k_gate_port="$(cat "$LBTMP/caseK-gate-port" 2>/dev/null)"
  echo dummy >"$LBTMP/caseK-token"
  # The late commit: on the FIRST (red) fleet-test call only, add a new commit to card/k1 in a
  # throwaway worktree, simulating a builder pushing more work during the red window -- card/k2
  # gets no such commit, so its gated sha never moves.
  cat >"$LBTMP/stub-first-red-k.sh" <<EOF
#!/usr/bin/env bash
n=\$(( \$(cat "\$STUB_COUNTER_FILE" 2>/dev/null || echo 0) + 1 ))
echo "\$n" >"\$STUB_COUNTER_FILE"
if [ "\$n" -eq 1 ]; then
  git -C "$MAIN" worktree add -q "$LBTMP/caseK-late-wt" card/k1 2>/dev/null
  echo late >"$LBTMP/caseK-late-wt/k1-late.txt"
  git -C "$LBTMP/caseK-late-wt" add k1-late.txt
  git -C "$LBTMP/caseK-late-wt" -c user.email=t@t -c user.name=t commit -q -m "k1 late commit (simulated race)"
  git -C "$MAIN" worktree remove -q --force "$LBTMP/caseK-late-wt" 2>/dev/null
  echo "FAIL in cross-card.test.ts"
  exit 1
fi
exit 0
EOF
  chmod +x "$LBTMP/stub-first-red-k.sh"
  export STUB_COUNTER_FILE="$LBTMP/caseK-count"
  MARVEEN_LAND_TEST="$LBTMP/stub-first-red-k.sh" MARVEEN_MAIN="$MAIN" \
    GATE_CHECK_API="http://127.0.0.1:${k_gate_port}" GATE_CHECK_TOKEN_FILE="$LBTMP/caseK-token" \
    KANBAN_COMMENT_API="http://127.0.0.1:${k_gate_port}" KANBAN_COMMENT_TOKEN_FILE="$LBTMP/caseK-token" \
    bash "$0" --batch "k1:fixture,k2:fixture" >"$LBTMP/out-k.txt" 2>&1
  out_k="$(cat "$LBTMP/out-k.txt")"
  kill "$k_gate_pid" 2>/dev/null; wait "$k_gate_pid" 2>/dev/null
  git -C "$MAIN" fetch -q origin develop 2>/dev/null
  if git -C "$MAIN" merge-base --is-ancestor "card/k2" "origin/develop" \
     && ! git -C "$MAIN" merge-base --is-ancestor "card/k1" "origin/develop" 2>/dev/null \
     && printf '%s' "$out_k" | grep -q "REFUSED -- card k1 has no passing gate verdict"; then
    echo "  ok   case K (P1): bash \"\$0\" --batch (real CLI dispatch, not a direct land_batch() call) + a real gate stub -- a late commit landing on card/k1 DURING the red combined run is REFUSED by the fallback at its new tip, not just report-mode-logged; k2 (no late commit) lands"
  else
    echo "  FAIL case K: k1 landed=$(git -C "$MAIN" merge-base --is-ancestor "card/k1" "origin/develop" 2>/dev/null && echo yes || echo no), k2 landed=$(git -C "$MAIN" merge-base --is-ancestor "card/k2" "origin/develop" 2>/dev/null && echo yes || echo no); output:"; echo "$out_k" | sed 's/^/    /'; fail=1
  fi

  # --- case L (P5, CYBERED NO-GO 30643): ALLOW_UNGATED_CARDS is comma-fenced
  # (`,$ALLOW_UNGATED_CARDS,` against `*",$card,"*`, line ~2034) so a listed id can never tolerate
  # an UNLISTED card merely because one string contains the other -- l1 is NOT named, only l10 is,
  # and a naive substring match (`*"$card"*` with no comma fencing) would wrongly match "l1" inside
  # "l10" and tolerate it. l1 carries no gate verdict at all, so this is the only thing standing
  # between it and an ungated landing.
  n=$((n+1))
  MAIN="$(_lb_mkmain caseL)"
  _lb_mkcard l1 l1.txt hello
  export STUB_COUNTER_FILE="$LBTMP/caseL-count"
  TEST_CMD="$LBTMP/stub-ok.sh"
  ALLOW_UNGATED_CARDS="l10"
  land_batch 0 "l1:fixture" >"$LBTMP/out-l1.txt" 2>&1
  out_l1="$(cat "$LBTMP/out-l1.txt")"
  if ! git -C "$MAIN" merge-base --is-ancestor "card/l1" "origin/develop" 2>/dev/null \
     && printf '%s' "$out_l1" | grep -q "no passing gate verdict"; then
    l5a_ok=1
  else
    l5a_ok=0
  fi

  # Second half of P5: a bare `--allow-ungated` on the real `--batch` CLI dispatch must `die 2`
  # before land_batch ever runs, not just be silently ignored -- entered through `bash "$0"
  # --batch ...` (not a direct land_batch() call) so the die site itself (line ~3078) is exercised.
  MAIN2="$(_lb_mkmain caseL2)"
  mkdir -p "$MAIN2/store"
  _lb_mkcard l2 l2.txt hello
  out_l2="$(MARVEEN_MAIN="$MAIN2" bash "$0" --batch "l2:fixture" --allow-ungated 2>&1)"
  rc_l2=$?
  if [ "$rc_l2" = "2" ] && printf '%s' "$out_l2" | grep -q "does not accept --allow-ungated"; then
    l5b_ok=1
  else
    l5b_ok=0
  fi

  if [ "$l5a_ok" = "1" ] && [ "$l5b_ok" = "1" ]; then
    echo "  ok   case L (P5): ALLOW_UNGATED_CARDS is comma-fenced -- l1 (unlisted) is refused even though it is a literal substring of the listed \"l10\"; and bash \"\$0\" --batch ... --allow-ungated dies (rc 2) before land_batch runs, not just a silently-ignored flag"
  else
    echo "  FAIL case L: l5a_ok=$l5a_ok (l1 landed=$(git -C "$MAIN" merge-base --is-ancestor "card/l1" "origin/develop" 2>/dev/null && echo yes || echo no)), l5b_ok=$l5b_ok (rc_l2=$rc_l2); out_l1:"; echo "$out_l1" | sed 's/^/    /'; echo "  out_l2:"; echo "$out_l2" | sed 's/^/    /'; fail=1
  fi

  # --- case M (P2, CYBERED NO-GO 30643): the batch's own `git push origin HEAD:$DEFAULT_BRANCH`
  # loses the race -- another agent's landing reaches origin/develop during THIS batch's merge+test
  # window, after the combined merge was built but before the push, so the push is a genuine
  # non-fast-forward rejection (not a pre-existing already-landed card, which case D covers). The
  # TEST_CMD stub stands in for fleet-test and, on its way to a green result, pushes a concurrent
  # commit straight to origin/develop from a side worktree -- exactly where a real fleet-test's
  # multi-minute runtime leaves the race window open. land_batch must detect the rejected push,
  # abandon the batch push (not retry blindly), and fall back to land_with_retry one card at a
  # time, which re-merges onto the NEW tip itself -- both m1 and m2 must still land, and the
  # concurrent commit must still be the tip's ancestor, not overwritten.
  n=$((n+1))
  MAIN="$(_lb_mkmain caseM)"
  _lb_mkcard m1 m1.txt hello
  _lb_mkcard m2 m2.txt world
  export STUB_COUNTER_FILE="$LBTMP/caseM-count"
  cat >"$LBTMP/stub-race-m.sh" <<EOF
#!/usr/bin/env bash
[ -d "$LBTMP/caseM-race-wt" ] || git -C "$MAIN" worktree add -q "$LBTMP/caseM-race-wt" origin/develop
git -C "$LBTMP/caseM-race-wt" fetch -q origin develop
git -C "$LBTMP/caseM-race-wt" checkout -q origin/develop
echo race >"$LBTMP/caseM-race-wt/race.txt"
git -C "$LBTMP/caseM-race-wt" add race.txt
git -C "$LBTMP/caseM-race-wt" -c user.email=t@t -c user.name=t commit -q -m "concurrent landing during batch window (simulated lost race)"
git -C "$LBTMP/caseM-race-wt" push -q origin HEAD:develop
exit 0
EOF
  chmod +x "$LBTMP/stub-race-m.sh"
  TEST_CMD="$LBTMP/stub-race-m.sh"
  ALLOW_UNGATED_CARDS="m1,m2"
  land_batch 0 "m1:fixture" "m2:fixture" >"$LBTMP/out-m.txt" 2>&1
  out_m="$(cat "$LBTMP/out-m.txt")"
  git -C "$MAIN" fetch -q origin develop 2>/dev/null
  m_race_log="$(git -C "$MAIN" log --oneline origin/develop 2>/dev/null)"
  if printf '%s' "$out_m" | grep -qi "lost a race\|lost the push race\|lost push race" \
     && git -C "$MAIN" merge-base --is-ancestor "card/m1" "origin/develop" 2>/dev/null \
     && git -C "$MAIN" merge-base --is-ancestor "card/m2" "origin/develop" 2>/dev/null \
     && printf '%s' "$m_race_log" | grep -q "concurrent landing during batch window"; then
    echo "  ok   case M (P2): batch push lost the race (non-fast-forward against a concurrent landing) -- abandoned, not retried blind, fell back to land_with_retry one card at a time, which re-merged onto the new tip; both m1 and m2 landed, concurrent commit still an ancestor"
  else
    echo "  FAIL case M: m1 landed=$(git -C "$MAIN" merge-base --is-ancestor "card/m1" "origin/develop" 2>/dev/null && echo yes || echo no), m2 landed=$(git -C "$MAIN" merge-base --is-ancestor "card/m2" "origin/develop" 2>/dev/null && echo yes || echo no); origin/develop log:"; echo "$m_race_log" | sed 's/^/    /'; echo "  output:"; echo "$out_m" | sed 's/^/    /'; fail=1
  fi

  # --- case E: --batch is the ONLY entry point -- its absence leaves land_one/land_with_retry's
  # own code path untouched (flag off = byte-identical to today, per the design). Proven by the
  # EXISTING --selftest-land-lock-release cases above still passing unmodified -- restated here as
  # an explicit assertion so this file's own grep-pin does not silently rot if that changes.
  n=$((n+1))
  if declare -F land_one >/dev/null 2>&1 && declare -F land_with_retry >/dev/null 2>&1 && declare -F land_batch >/dev/null 2>&1; then
    echo "  ok   case E: land_one, land_with_retry and land_batch are all distinct, separately-callable functions"
  else
    echo "  FAIL case E: expected land_one, land_with_retry and land_batch to all be defined"; fail=1
  fi

  echo
  if [ "$fail" -eq 0 ]; then echo "selftest-land-batch: $n case(s), PASS"; exit 0
  else echo "selftest-land-batch: $n case(s), FAIL"; exit 1
  fi
fi

# M4 (WhiteHat2 NO-GO 30647) test harness only: case J (inside --selftest-land-batch-inner) needs
# to send a real signal to a land_batch run and see that IT, not some subshell layer, catches it.
# Backgrounding `land_batch ... &` from inside the inner test would run it in a forked SUBSHELL of
# that process -- the exact "$$ preserved, caller's real PPID is the subshell's own pid" mismatch
# QA FAIL 30639 already found for this file's OWN selftest capture (fixed there by not using
# command substitution at all). Backgrounding cannot avoid the fork, so this hook makes land_batch
# the TOP of a genuinely separate `bash "$0" ...` process instead -- same shape as a real
# `marveen-land.sh --batch` invocation, where $$ really is that process's own pid throughout.
if [ "${1:-}" = "--selftest-land-batch-case-j-run" ]; then
  MAIN="$2"
  TEST_CMD="$3"
  ALLOW_UNGATED_CARDS="$4"
  export STUB_COUNTER_FILE="$5"
  LAND_CARD=""; ALLOW_STACKED=""; ALLOW_ARCHIVE=0; CARD_ALLOW_UNGATED=0
  land_batch 0 "j1:fixture"
  exit $?
fi

DRY=0; LAND_CARD=""; ALLOW_STACKED=""; ALLOW_ARCHIVE=0; ALLOW_UNGATED_CARDS=""
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
      # card 78339a8a: wired into --card mode too, same meaning as the agent-target mode's
      # --allow-stacked -- the operator names the foreign card(s) they are knowingly taking on.
      # Before this, the only way through a stacked-commit refusal here was the kill switch
      # LANDING_DOWNWARD_CHECK=off, which disables the ENTIRE downward check, not just the
      # named card (backend3 msg 17594).
      --allow-stacked) shift; [ $# -gt 0 ] || die 2 "--allow-stacked needs a card id list"; ALLOW_STACKED="$1" ;;
      --allow-stacked=*) ALLOW_STACKED="${1#--allow-stacked=}" ;;
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

# Card 6ec8e9d8 (MikroB GO, msg 18291/comment 30593): `marveen-land.sh --batch <id1>:<agent1>,<id2>:<agent2>,...`
# -- behind this explicit flag ONLY (no env-var auto-trigger, per the design comment: a batch never
# silently forms). Absence of --batch is byte-identical to today: land_one/land_with_retry are
# untouched, every other TARGET takes the exact same code path it always has.
if [ "$TARGET" = "--batch" ]; then
  BATCH_SPEC="${1:-}"
  [ -n "$BATCH_SPEC" ] || die 2 "--batch needs a <card>:<agent>[,<card>:<agent>...] list"
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      # M1 (WhiteHat2 NO-GO 30647): a bare --allow-ungated used to set the SAME global land_one's
      # single-card path reads, tolerating EVERY card in the batch silently. --batch refuses it
      # outright rather than keep a flag that lies about its own scope -- the caller names the
      # specific survivor(s) instead.
      --allow-ungated) die 2 "--batch does not accept --allow-ungated (that would tolerate every card in the batch silently) -- use --allow-ungated-cards <id>[,<id>...] to name the specific survivor(s)" ;;
      --allow-ungated-cards) shift; [ $# -gt 0 ] || die 2 "--allow-ungated-cards needs a card id list"; ALLOW_UNGATED_CARDS="$1" ;;
      --allow-ungated-cards=*) ALLOW_UNGATED_CARDS="${1#--allow-ungated-cards=}" ;;
      --allow-ungated-reason) shift; [ $# -gt 0 ] || die 2 "--allow-ungated-reason needs text"; CARD_ALLOW_UNGATED_REASON="$1" ;;
      --allow-ungated-reason=*) CARD_ALLOW_UNGATED_REASON="${1#--allow-ungated-reason=}" ;;
      --allow-stacked) shift; [ $# -gt 0 ] || die 2 "--allow-stacked needs a card id list"; ALLOW_STACKED="$1" ;;
      --allow-stacked=*) ALLOW_STACKED="${1#--allow-stacked=}" ;;
      *) die 2 "unknown option: $1" ;;
    esac
    shift
  done
  CARD_BRANCH_MODE=1
  IFS=',' read -r -a BATCH_ITEMS <<<"$BATCH_SPEC"
  [ "${#BATCH_ITEMS[@]}" -ge 1 ] || die 2 "--batch item list is empty"
  land_batch "$DRY" "${BATCH_ITEMS[@]}"
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

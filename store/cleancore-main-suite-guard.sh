#!/usr/bin/env bash
# cleancore-main-suite-guard.sh -- notice when the SHARED LOCAL main goes red (card ec44220b).
#
# THE GAP THIS CLOSES. CI runs on push to origin/main. But the fleet does not commit to origin --
# every agent commits into ONE shared local checkout of `main`, and nothing runs the apps/api suite
# there. So local main can sit red for hours (it did) until someone happens to run the right file,
# and the eventual landing merge then carries a break nobody attributed. This is not a CI gap and
# not a bypass: it is a branch no CI was ever pointed at.
#
# WHAT IT MEASURES, AND WHAT IT DELIBERATELY DOES NOT.
#   - The COMMITTED tip of local main, in a separate worktree. Never the shared working tree: that
#     holds a dozen agents' uncommitted WIP and untracked files, so a run there tells you about
#     work in flight, not about what landed. (The same distinction that makes `git checkout-index`
#     the honest way to verify a commit.)
#   - Only apps/api. That is the suite the card is about and the one the landing merge keeps
#     breaking; widening it later is a one-line change to SUITE.
#
# WHY IT IS CHEAP DESPITE A SLOW SUITE. The full apps/api run takes MINUTES on this machine, so a
# fixed-interval full run would burn a core all day for nothing. Instead the guard is keyed on the
# HEAD SHA: if nothing new was committed since the last run it exits in well under a second. The
# cost therefore tracks commit activity, not wall-clock.
#
# REPORTS ONLY TRANSITIONS. A repo with a known-red baseline that shouts every run gets muted, and
# a muted guard is not a guard. It speaks when the failure count RISES (or green -> red), names the
# commit range that can be responsible, and otherwise stays quiet.
#
# Usage:
#   store/cleancore-main-suite-guard.sh            # the scheduled path: silent unless it regressed
#   store/cleancore-main-suite-guard.sh --force    # run even if HEAD is unchanged
#   store/cleancore-main-suite-guard.sh --status   # print the recorded baseline and exit
#
# Output contract:
#   STATE:unchanged | STATE:measured | STATE:busy
#   RESULT:OK | RESULT:REGRESSION | RESULT:IMPROVED | RESULT:SETUP-FAILED
# Exit: 0 measured or skipped | 1 regression | 3 setup failed | 2 bad usage
#
# WHO CONSUMES THIS (corrected -- card 6d46c7d3, Cybered F1). This block used to say "for the
# scheduled task that reads it", and no such task exists. What is actually true:
#   - A REGRESSION alerts ITSELF, from inside this script, via POST /api/messages. That path does
#     not depend on anything reading the log.
#   - Cron appends stdout to store/cleancore-main-suite-guard.log, and NOTHING reads that file. So
#     RESULT:SETUP-FAILED -- the guard announcing it could not measure -- currently goes to a file
#     nobody opens. That is the remaining hole; MikroB is adding the heartbeat that reads it.
# Stated plainly because a header that claims a consumer it does not have is how a guard looks
# wired while being unwatched.
set -uo pipefail

REPO="${CC_REPO:-/mnt/h/LM_Studio_Workdir/CleanCore}"
TREE="${CC_MAIN_GUARD_TREE:-/home/neon/cc-mainguard}"
STATE="${CC_MAIN_GUARD_STATE:-/home/neon/marveen/store/cleancore-main-suite-state.json}"
# Overridable for the same reason REPO/TREE/STATE are (a selftest must never touch the live
# equivalent) -- and this one was MISSED once already. A REGRESSION fixture run through
# gate-dispatch-check-selftest-shaped mutation testing during this card's own gate posted real
# alerts to the real mikrob: "from":"fullstack" (this script cannot self-identify, see below), a
# repro path into a temp sandbox that no longer existed, and commit numbers from a throwaway git
# repo -- indistinguishable from a genuine finding until investigated. Every other side-effecting
# path in this script (REPO/TREE/STATE/LOCK) was already made overridable; this one alerts a human
# and was not, which is the worse direction to leave un-isolatable.
DASH="${CC_MAIN_GUARD_DASH:-http://localhost:3420}"
SUITE="${CC_MAIN_GUARD_SUITE:-apps/api}"
BRANCH="${CC_MAIN_GUARD_BRANCH:-main}"

die() { echo "RESULT:SETUP-FAILED"; echo "cleancore-main-suite-guard: $1" >&2; exit 3; }

# A worktree under /tmp is not equivalent: the fleet has already measured suites silently SKIPPING
# there because guards refuse /tmp-rooted paths (see store/fleet-test.sh). A green run in the wrong
# place is worse than no run, so refuse rather than quietly measure less.
case "$TREE" in
  /tmp/*|/var/tmp/*|/dev/shm/*) die "CC_MAIN_GUARD_TREE is under a temp dir ($TREE); suites can silently skip there" ;;
esac

FORCE=0
case "${1:-}" in
  --force) FORCE=1 ;;
  --status) [ -f "$STATE" ] && cat "$STATE" || echo '{}'; exit 0 ;;
  "") ;;
  *) echo "usage: $0 [--force|--status]" >&2; exit 2 ;;
esac

# ONE RUN AT A TIME. Added the moment this went on cron at */15 (card ec44220b): the full apps/api
# suite is 8.1 minutes MEASURED on a quiet machine, and the fleet does not keep the machine quiet.
# A run that overruns 15 minutes would meet the next tick, and the damage is not merely two suites
# competing for CPU -- both instances drive the SAME worktree, so the second one's
# `checkout --detach` + `reset --hard` + `clean -fd` yanks files out from under the first one's
# vitest. That manufactures failures that no commit caused, writes them to the shared state file,
# and sends a REGRESSION alert naming innocent commits. A guard that cries wolf is worse than no
# guard, so a second instance exits immediately and silently instead.
LOCK="${CC_MAIN_GUARD_LOCK:-/home/neon/marveen/store/.cleancore-main-suite-guard.lock}"
#
# NO flock, NO RUN (card 6d46c7d3, Cybersec SEC-1 on 6821012). This used to be
# `if command -v flock; then ... fi` with no else, so on a host without flock the whole block was
# skipped and the script carried on exactly as if it had taken the lock -- silently, which is the
# one thing this guard is not allowed to be. The protection was tied to the tool being present
# rather than to the tool working. Latent today (flock is on this machine, measured), but a
# narrowed PATH under cron or a different host is all it takes.
# Refusing is the right failure here rather than a mkdir fallback: a mkdir lock is not released
# when the holder dies, so a killed run would block every later tick until someone noticed -- the
# same silent stop, just delayed.
command -v flock >/dev/null 2>&1 \
  || die "flock is not on PATH -- refusing to run without mutual exclusion (two runs share one worktree and would corrupt each other's measurement)"
exec 9>"$LOCK" || die "cannot open the lock file at $LOCK"
if ! flock -n 9; then
  echo "STATE:busy"   # a previous run is still measuring; the next tick will pick it up
  exit 0
fi

[ -d "$REPO/.git" ] || die "no CleanCore checkout at $REPO"
HEAD="$(git -C "$REPO" rev-parse "$BRANCH" 2>/dev/null)" || die "cannot resolve $BRANCH in $REPO"

prev_sha=""; prev_fails=""
if [ -f "$STATE" ]; then
  prev_sha="$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$STATE" | head -1)"
  prev_fails="$(sed -n 's/.*"fails"[[:space:]]*:[[:space:]]*\([0-9-]*\).*/\1/p' "$STATE" | head -1)"
  # A CORRUPT state file must not quietly become "no baseline" (card 6d46c7d3, Cybersec on the
  # ec44220b GO). The comparison below is a numeric `-gt`; on a non-numeric value bash errors to
  # STDERR and the test evaluates false, so the run would print RESULT:OK and the caller -- which
  # reads only the RESULT: lines -- would be told everything is fine while the alarm was off.
  # Fail LOUDLY instead: a guard whose memory is unreadable knows nothing, and must say so.
  #
  # KEY PRESENT vs VALUE PARSED, and my first attempt got this wrong. The extractor captures
  # `[0-9-]*`, so a corrupted `"fails":"twenty-one"` yields the EMPTY string -- indistinguishable
  # from a file that never had the key, which is treated as "no baseline" and passes silently. The
  # exact failure Cybersec described, reproduced by my own test. So ask both questions: does the key
  # exist, and did a value come out of it?
  # This script only ever writes BOTH keys, so a file that exists and lacks either one is damaged --
  # including a truncated one whose `sha` survived. That case looked benign in testing (the run just
  # says STATE:unchanged) and is the worst of the three: the sha matches, nothing measures, and the
  # baseline silently disappears at the next commit. No state file at all is fine and means "first
  # run"; a PARTIAL one never is.
  for key in fails sha; do
    val="$prev_fails"; [ "$key" = sha ] && val="$prev_sha"
    [ -n "$val" ] || die "state file $STATE is missing or could not parse \"$key\" -- corrupt (we always write both); delete it to re-baseline rather than let it decay silently"
  done
  if [ -n "$prev_fails" ] && ! printf '%s' "$prev_fails" | grep -Eq '^-?[0-9]+$'; then
    die "state file $STATE has a non-numeric \"fails\" ($prev_fails) -- refusing to compare against it"
  fi
  if [ -n "$prev_sha" ] && ! printf '%s' "$prev_sha" | grep -Eq '^[0-9a-f]{7,40}$'; then
    die "state file $STATE has a malformed \"sha\" ($prev_sha) -- refusing to compare against it"
  fi
fi

if [ "$FORCE" -eq 0 ] && [ "$HEAD" = "$prev_sha" ]; then
  echo "STATE:unchanged"
  exit 0
fi

# Disposable mirror of the committed tip. Reset rather than pull: anything left from a previous run
# is noise we want gone before measuring.
#
# THE DESTRUCTIVE BRANCH ONLY EVER RUNS ON A TREE THIS SCRIPT CREATED (card 6d46c7d3, Cybersec).
# `reset --hard` + `clean -fdq` on $TREE is exactly the pair that erases an agent's uncommitted work,
# $TREE is overridable from the environment, and its default sits in `/home/neon/cc-*` -- the fleet's
# own worktree naming convention, where LIVE agent worktrees live. The repo hook that bans
# `git clean -f` is PreToolUse, so it never sees a cron-launched script. A typo or an inherited
# CC_MAIN_GUARD_TREE would therefore be unopposed. The marker makes ownership a precondition rather
# than a convention: no marker, no destruction.
MARKER="$TREE/.cleancore-main-suite-guard"
if [ ! -e "$TREE/.git" ]; then
  git -C "$REPO" worktree add --detach "$TREE" "$HEAD" >/dev/null 2>&1 \
    || die "could not create the guard worktree at $TREE"
  printf 'Created by store/cleancore-main-suite-guard.sh (card ec44220b). Disposable: this script\nresets and cleans this tree on every run. Do not put work here.\n' >"$MARKER"
elif [ ! -f "$MARKER" ]; then
  die "$TREE is a git tree but carries no $(basename "$MARKER") marker -- refusing to reset/clean a tree this guard did not create. If it really is the guard's own, create the marker by hand; if it is someone's worktree, point CC_MAIN_GUARD_TREE elsewhere."
else
  git -C "$TREE" checkout --detach "$HEAD" >/dev/null 2>&1 || die "could not move $TREE to $HEAD"
  git -C "$TREE" reset --hard "$HEAD" >/dev/null 2>&1
  git -C "$TREE" clean -fdq -e node_modules -e '*/node_modules' -e "$(basename "$MARKER")" >/dev/null 2>&1
fi

# pnpm resolves per package, so a single root symlink is NOT enough -- vitest fails to resolve its
# own plugins from a package dir that has no node_modules, which reads like "the guard is broken"
# rather than "the copy is incomplete". Link the root and every package dir the real checkout has.
[ -e "$TREE/node_modules" ] || ln -s "$REPO/node_modules" "$TREE/node_modules" 2>/dev/null \
  || die "could not link the root node_modules into $TREE"
while IFS= read -r nm; do
  rel="${nm#"$REPO"/}"
  [ -e "$TREE/$rel" ] || ln -s "$nm" "$TREE/$rel" 2>/dev/null
done < <(find "$REPO/apps" "$REPO/packages" -maxdepth 3 -name node_modules -not -path '*/node_modules/*' 2>/dev/null)

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
( cd "$TREE" && ./node_modules/.bin/vitest run "$SUITE" ) >"$log" 2>&1
summary="$(grep -E '^[[:space:]]*Tests[[:space:]]' "$log" | tail -1)"
[ -n "$summary" ] || { sed -n '$p' "$log" >&2; die "the suite produced no 'Tests' summary (see the tail above)"; }

# An INFRASTRUCTURE failure must never be reported as a code regression (card 6d46c7d3, Cybersec's
# closing note). The guard symlinks the shared node_modules, so it also shares vite's cache dir with
# whatever else is running vitest at that moment; a torn cache surfaces as ERR_MODULE_NOT_FOUND in
# otherwise fine files. That would arrive as "failures rose, here are the commits" and point at
# innocent work. These strings mean the harness broke, not the tree.
#
# SCOPED TO THE FAILED-SUITES BLOCK, not the whole log (card 6d46c7d3, Cybered NO-GO on 6821012).
# The first version grepped the entire vitest output, and vitest prints the names of PASSING tests
# too. So one well-meant test name containing "Cannot find package" made a fully green run report
# SETUP-FAILED: the baseline froze, and a real regression arriving in the same run raised no alert.
# The card exists to stop this guard going quiet unnoticed; that line reintroduced it by another
# door. Zero such names exist in the corpus today, so it was latent -- and trivial to trigger.
#
# The region is chosen from MEASURED output shape, not guessed. A module-resolution error fails the
# SUITE at collect time, and vitest reports it under `Failed Suites` as
# `Error: Failed to load url ...`, with the summary reading `Tests  no tests`. Test names never
# appear in that block -- they are listed under `Failed Tests`, which is where the scan now stops.
# Measured both ways: real failure -> 1 hit inside the block, poisoned-but-green run -> 0 hits.
suite_errors="$(awk '/Failed Suites/{f=1;next} f && (/Failed Tests/ || /^[[:space:]]*Test Files/){f=0} f' "$log")"
if printf '%s\n' "$suite_errors" | grep -qE 'ERR_MODULE_NOT_FOUND|Failed to load url|Cannot find package'; then
  printf '%s\n' "$suite_errors" | grep -m1 -E 'ERR_MODULE_NOT_FOUND|Failed to load url|Cannot find package' >&2
  die "the run hit a module-resolution error (shared vite cache or a mid-install node_modules), not a code failure -- not reporting a regression from it"
fi

# A run that collected NOTHING measured nothing. `Tests  no tests` still satisfies the summary check
# above, and the failure count parses as 0 -- so without this the guard would record a clean
# baseline for a suite that never executed. Same family as the two findings above: the quiet way for
# this guard to stop guarding.
case "$summary" in
  *"no tests"*) die "the suite collected no tests at all -- nothing was measured, refusing to record a baseline" ;;
esac

fails="$(printf '%s' "$summary" | sed -n 's/.*[^0-9]\([0-9][0-9]*\) failed.*/\1/p')"
[ -n "$fails" ] || fails=0

# ATOMIC (card 6d46c7d3): write beside the target and rename. A plain `>` truncates first, so a run
# killed mid-write -- a reboot, an OOM, the 15-minute tick overlapping a slow machine -- leaves a
# half-written file. The next run then reads a corrupt baseline, and the validation above turns that
# into a loud failure rather than a wrong verdict; rename removes the window entirely.
printf '{"sha":"%s","fails":%s,"suite":"%s","summary":"%s"}\n' \
  "$HEAD" "$fails" "$SUITE" "$(printf '%s' "$summary" | tr -d '"' | sed 's/^[[:space:]]*//')" \
  >"$STATE.tmp.$$" \
  && mv -f "$STATE.tmp.$$" "$STATE" \
  || die "could not write the state file at $STATE"
echo "STATE:measured"
echo "  $BRANCH @ ${HEAD:0:8} -- ${summary# }"

# First ever run has no baseline: record it, do not cry regression over a number nobody set.
if [ -z "$prev_fails" ]; then
  echo "RESULT:OK (baseline recorded, no previous measurement to compare)"
  exit 0
fi

if [ "$fails" -gt "$prev_fails" ]; then
  suspects="$(git -C "$REPO" log --oneline "${prev_sha}..${HEAD}" 2>/dev/null)"
  echo "RESULT:REGRESSION"
  echo "  apps/api failures rose ${prev_fails} -> ${fails} on the SHARED LOCAL $BRANCH."
  echo "  Commits since the last measured state (${prev_sha:0:8}), newest first:"
  printf '%s\n' "$suspects" | sed 's/^/    /'
  echo "  Reproduce exactly what this measured:"
  echo "    cd $TREE && ./node_modules/.bin/vitest run $SUITE"

  # Tell the fleet through the message API, never by writing into a tmux pane. A cron-driven pane
  # write races the dashboard's in-process send lock and can interleave with a live prompt -- the
  # defect class cards 7560bb6a / 9cfed589 exist for. /api/messages goes through the same
  # serialised path the dashboard itself uses.
  tok="/home/neon/marveen/store/.dashboard-token"
  if [ -r "$tok" ]; then
    # Self-identify as the CRON GUARD in the TEXT. The API only accepts a registered fleet agent as
    # `from`, so the sender must stay 'fullstack' until someone registers a guard agent -- and a
    # machine alert wearing a person's name has already cost one investigation (msg 9164). The
    # prefix is the cheap half of card 6d46c7d3 finding 3a; the real fix needs an agent id.
    body="$(printf '[cleancore-main-suite-guard / cron -- automatikus, nem kezi jelzes]\nA megosztott lokalis %s PIROSABB lett: apps/api bukasok %s -> %s (%s).\nGyanusitottak (a legutobbi meres, %s ota):\n%s\nRepro: cd %s && ./node_modules/.bin/vitest run %s' \
      "$BRANCH" "$prev_fails" "$fails" "${HEAD:0:8}" "${prev_sha:0:8}" "$suspects" "$TREE" "$SUITE" \
      | python3 -c 'import json,sys; print(json.dumps({"from":"fullstack","to":"mikrob","content":sys.stdin.read()}))')"
    printf 'Authorization: Bearer %s\n' "$(cat "$tok")" \
      | curl -H @- -s -m 15 -X POST "$DASH/api/messages" \
        -H 'Content-Type: application/json' --data-binary "$body" >/dev/null 2>&1 \
      || echo "  (note: could not reach the message API -- the finding is only in this output)"
  fi
  exit 1
fi

[ "$fails" -lt "$prev_fails" ] && echo "RESULT:IMPROVED (${prev_fails} -> ${fails})" && exit 0
echo "RESULT:OK (${fails} failing, unchanged)"
exit 0

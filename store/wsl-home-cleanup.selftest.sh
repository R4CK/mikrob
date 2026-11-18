#!/usr/bin/env bash
# Selftest for wsl-home-cleanup.sh (card bc1e7ef2).
#
# A COUNT, not a bare "PASS" (card 711a7e57/0ebeff55's harness convention) -- a selftest that prints
# PASS having run zero cases is indistinguishable from one that works.
#
# Everything here runs against a THROWAWAY fake $HOME_DIR and two throwaway git repos acting as
# $MARVEEN_MAIN/$CLEANCORE_MAIN, never against the real /home/neon -- this script never touches a
# live worktree or the real dashboard.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

fail=0
passed=0
ok()  { echo "  ok: $1"; passed=$((passed + 1)); }
bad() { echo "  FAIL: $1"; fail=$((fail + 1)); }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/wsl-home-cleanup-selftest-XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

FAKE_HOME="$tmp/home"
FAKE_MAIN="$tmp/main-repo"
FAKE_CC="$tmp/cc-repo"
mkdir -p "$FAKE_HOME"

# A tiny real repo acting as MARVEEN_MAIN, with worktrees registered the same way the real one would
# have them: one TOP-LEVEL worktree (the dir IS the worktree) and one NESTED worktree (lives under a
# container dir that is itself not a worktree) -- the exact distinction the HAS_ACTIVE_CHILD fix cares
# about (a container dir must be protected unconditionally; a worktree that IS a top-level dir must
# NOT be, it needs the ordinary owner/live-process/card-reference checks).
(
  set -e
  git init -q -b main "$FAKE_MAIN"
  cd "$FAKE_MAIN"
  git config user.email s@s; git config user.name s
  echo base > f; git add -A; git commit -qm base
  git branch top-worktree-branch
  git worktree add -q "$FAKE_HOME/top-worktree" top-worktree-branch
  mkdir -p "$FAKE_HOME/gate-worktrees"
  git branch nested-worktree-branch
  git worktree add -q "$FAKE_HOME/gate-worktrees/nested-worktree" nested-worktree-branch
) >/dev/null 2>&1 || { echo "selftest: FAIL -- could not build the throwaway MARVEEN_MAIN repo"; exit 1; }

export MARVEEN_MAIN="$FAKE_MAIN"
export CLEANCORE_MAIN="$FAKE_CC" # deliberately missing -- load_worktrees must no-op, not error
export WSL_HOME_CLEANUP_HOME="$FAKE_HOME"
export WSL_HOME_CLEANUP_TOKEN_FILE="$tmp/no-such-token" # dashboard unreachable by default
. "$HERE/wsl-home-cleanup.sh"

# --- load_worktrees: NESTED vs TOP-LEVEL ------------------------------------------------------
load_worktrees "$MARVEEN_MAIN"
load_worktrees "$CLEANCORE_MAIN"

[ "${WORKTREE_OWNER[$FAKE_HOME/top-worktree]:-}" = "$FAKE_MAIN" ] \
  && ok "load_worktrees records the top-level worktree's owner" \
  || bad "top-level worktree owner not recorded"

[ "${HAS_ACTIVE_CHILD[$FAKE_HOME/top-worktree]:-0}" = 0 ] \
  && ok "a worktree that IS a top-level dir does NOT get HAS_ACTIVE_CHILD (the bug this session fixed)" \
  || bad "top-level worktree wrongly marked HAS_ACTIVE_CHILD -- would unconditionally protect it even when stale"

[ "${HAS_ACTIVE_CHILD[$FAKE_HOME/gate-worktrees]:-0}" = 1 ] \
  && ok "a container dir holding a NESTED worktree gets HAS_ACTIVE_CHILD" \
  || bad "container dir for a nested worktree must be protected, was not"

[ -z "${WORKTREE_OWNER[$FAKE_HOME/gate-worktrees]:-}" ] \
  && ok "the container dir itself is not registered as a worktree (only its child is)" \
  || bad "container dir should not itself be in WORKTREE_OWNER"

# --- classify(): B1 fix -- an UNREGISTERED dir with an open fd into it classifies ACTIVE --------
# QA's own reproduction (WhiteHat NO-GO 16566 on the first F1 fix): a process whose cwd is outside
# the candidate dir, but which holds an open file descriptor pointing into it (a `tail -f`/
# log-writer redirected there from elsewhere), was invisible as long as the live-process check only
# ran inside the registered-worktree branch -- an UNREGISTERED, DISPOSABLE-pattern-matching, old dir
# skipped it entirely. This calls classify() (the actual dispatch, not the bare function) so it
# exercises the real --apply decision path, per MikroB's instruction (16567).
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
fdtest_dir="$FAKE_HOME/qa-gate-openfile"
mkdir -p "$fdtest_dir"
: > "$fdtest_dir/live.log"
touch -d '2 days ago' "$fdtest_dir" # old enough to be DISPOSABLE if the live check did not protect it
# cwd is $tmp (NOT $fdtest_dir) -- the exact shape QA measured: cwd elsewhere, fd into the target.
( cd "$tmp" && exec tail -f "$fdtest_dir/live.log" >/dev/null 2>&1 ) &
fdtest_pid=$!
# Wait for tail's OWN fd into live.log specifically (B1' speedup fix, card bc1e7ef2 round 3):
# "ls /proc/<pid>/fd is non-empty" is trivially true from fork onward (fd 0/1/2 always exist), so
# it never actually waited for tail to exec and open live.log -- the race was always latent here,
# just masked by the OLD has_live_process_under()'s own per-link readlink-fork loop (8.2s for a
# ~2600-fd /proc on this box), which gave the race enough time to resolve by accident. The new
# single-readlink-call scan (0.14s) removed that accidental delay and exposed it for real.
for _ in $(seq 1 30); do
  readlink -f /proc/"$fdtest_pid"/fd/* 2>/dev/null | grep -qF "$fdtest_dir/live.log" && break
  sleep 0.2
done
[ "$(classify qa-gate-openfile "$fdtest_dir")" = ACTIVE ] \
  && ok "classify(): B1 fix -- an UNREGISTERED dir with an open fd into it classifies ACTIVE, not DISPOSABLE (QA's repro)" \
  || bad "classify(): B1 regression -- unregistered dir with a live fd classified something other than ACTIVE"
kill "$fdtest_pid" 2>/dev/null
wait "$fdtest_pid" 2>/dev/null

# --- classify(): B1 fix -- an UNREGISTERED dir with a live process cwd under it classifies ACTIVE
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
cwdtest_dir="$FAKE_HOME/qa-cwd-live"
mkdir -p "$cwdtest_dir"
touch -d '2 days ago' "$cwdtest_dir"
( cd "$cwdtest_dir" && exec sleep 15 ) &
cwdtest_pid=$!
for _ in $(seq 1 30); do
  [ "$(readlink -f "/proc/$cwdtest_pid/cwd" 2>/dev/null)" = "$cwdtest_dir" ] && break
  sleep 0.2
done
[ "$(classify qa-cwd-live "$cwdtest_dir")" = ACTIVE ] \
  && ok "classify(): B1 fix -- an UNREGISTERED dir with a live process cwd under it classifies ACTIVE" \
  || bad "classify(): B1 regression -- unregistered dir with a live cwd process classified something other than ACTIVE"
kill "$cwdtest_pid" 2>/dev/null
wait "$cwdtest_pid" 2>/dev/null

# --- classify(): B2 fix -- a deep, recently-written file keeps an old-topped dir out of DISPOSABLE
# WhiteHat NO-GO 16566: age used to be the top dir's own mtime, which a deep edit does not change.
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
deep_dir="$FAKE_HOME/qa-gate-deep"
mkdir -p "$deep_dir/sub/sub2"
touch -d '2 days ago' "$deep_dir" "$deep_dir/sub"
echo recent > "$deep_dir/sub/sub2/just-written" # mtime = now, deep inside, top mtime untouched
[ "$(classify qa-gate-deep "$deep_dir")" = UNKNOWN ] \
  && ok "classify(): B2 fix -- a deep, recently-written file keeps an old-topped dir out of DISPOSABLE" \
  || bad "classify(): B2 regression -- old top mtime with a fresh deep file was wrongly DISPOSABLE"

# --- classify(): KEEP always wins, before anything else is even looked at ---------------------
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0; OPEN_CARD_IDS_FILE=""
[ "$(classify marveen /anything/not/real)" = KEEP ] \
  && ok "a KEEP_NAMES entry classifies KEEP regardless of path validity" \
  || bad "KEEP_NAMES entry did not classify KEEP"

# --- classify(): HAS_ACTIVE_CHILD short-circuits to ACTIVE even if the name matches DISPOSABLE --
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
HAS_ACTIVE_CHILD["$FAKE_HOME/qa-gate-foo"]=1
[ "$(classify qa-gate-foo "$FAKE_HOME/qa-gate-foo")" = ACTIVE ] \
  && ok "HAS_ACTIVE_CHILD forces ACTIVE even when the name matches a disposable pattern" \
  || bad "HAS_ACTIVE_CHILD did not protect a disposable-looking container"

# --- classify(): registered worktree, live process under it -> ACTIVE -------------------------
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
WORKTREE_OWNER["$FAKE_HOME/qa-gate-live"]="$FAKE_MAIN"
has_live_process_under() { [ "$1" = "$FAKE_HOME/qa-gate-live" ]; } # stub: pretend a process is there
[ "$(classify qa-gate-live "$FAKE_HOME/qa-gate-live")" = ACTIVE ] \
  && ok "a registered worktree with a live process cwd classifies ACTIVE" \
  || bad "live-process-backed registered worktree did not classify ACTIVE"

# --- classify(): registered worktree, no live process, dashboard DOWN -> fail-open ACTIVE -----
has_live_process_under() { return 1; }
DASHBOARD_UP=0
[ "$(classify qa-gate-live "$FAKE_HOME/qa-gate-live")" = ACTIVE ] \
  && ok "registered worktree with dashboard unreachable fails OPEN to ACTIVE, never guessed DISPOSABLE" \
  || bad "fail-open to ACTIVE did not happen with dashboard down"

# --- classify(): registered worktree, no live process, dashboard UP, referenced by open card ---
DASHBOARD_UP=1
OPEN_CARD_IDS_FILE="$tmp/open-cards.txt"
printf 'abc12345\n' > "$OPEN_CARD_IDS_FILE"
WORKTREE_OWNER["$FAKE_HOME/card-abc12345-worktree"]="$FAKE_MAIN"
[ "$(classify card-abc12345-worktree "$FAKE_HOME/card-abc12345-worktree")" = ACTIVE ] \
  && ok "a registered worktree whose name contains an open card id classifies ACTIVE" \
  || bad "card-id-referenced registered worktree did not classify ACTIVE"

# --- classify(): registered worktree, no live process, dashboard UP, NOT referenced, name looks
# disposable and old -> DISPOSABLE (the throwaway land/gate worktrees this card exists to clean up)
WORKTREE_OWNER["$FAKE_HOME/qa-gate-stale"]="$FAKE_MAIN"
mkdir -p "$FAKE_HOME/qa-gate-stale"
touch -d '2 days ago' "$FAKE_HOME/qa-gate-stale"
[ "$(classify qa-gate-stale "$FAKE_HOME/qa-gate-stale")" = DISPOSABLE ] \
  && ok "a registered-but-idle, name-matching, old worktree classifies DISPOSABLE (card's own motivating case)" \
  || bad "idle name-matching old registered worktree did not classify DISPOSABLE"

# --- classify(): same, but NOT yet old enough -> UNKNOWN, never DISPOSABLE --------------------
mkdir -p "$FAKE_HOME/qa-gate-fresh"
touch "$FAKE_HOME/qa-gate-fresh"
unset 'WORKTREE_OWNER[$FAKE_HOME/qa-gate-fresh]'
[ "$(classify qa-gate-fresh "$FAKE_HOME/qa-gate-fresh")" = UNKNOWN ] \
  && ok "a fresh (< MIN_AGE_HOURS) name-matching dir classifies UNKNOWN, not DISPOSABLE" \
  || bad "fresh name-matching dir was wrongly classified DISPOSABLE"

# --- classify(): a plain dir, no match anywhere -> UNKNOWN (never auto-removed) ----------------
mkdir -p "$FAKE_HOME/some-random-project"
[ "$(classify some-random-project "$FAKE_HOME/some-random-project")" = UNKNOWN ] \
  && ok "a non-matching, unregistered dir classifies UNKNOWN" \
  || bad "non-matching dir did not classify UNKNOWN"

# --- remove_entry(): registered worktree, clean -> proper git worktree remove -----------------
# B1' (RedHat NO-GO 16676) made remove_entry() re-check age fresh at its own start (see below) --
# backdate every file so this freshly-created worktree does not trip that re-check by accident;
# that re-check has its own dedicated tests further down.
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
find "$FAKE_HOME/top-worktree" -exec touch -d '2 days ago' {} +
WORKTREE_OWNER["$FAKE_HOME/top-worktree"]="$FAKE_MAIN"
remove_entry "$FAKE_HOME/top-worktree" >/dev/null 2>&1
if [ ! -d "$FAKE_HOME/top-worktree" ] && ! git -C "$FAKE_MAIN" worktree list | grep -q top-worktree; then
  ok "remove_entry removes a clean registered worktree via 'git worktree remove', deregistering it"
else
  bad "remove_entry did not properly remove the clean registered worktree"
fi

# --- remove_entry(): registered worktree, DIRTY -> refused, left in place ---------------------
echo dirty >> "$FAKE_HOME/gate-worktrees/nested-worktree/f"
WORKTREE_OWNER["$FAKE_HOME/gate-worktrees/nested-worktree"]="$FAKE_MAIN"
if remove_entry "$FAKE_HOME/gate-worktrees/nested-worktree" >/dev/null 2>&1; then
  bad "remove_entry must refuse a dirty registered worktree, it did not"
else
  [ -d "$FAKE_HOME/gate-worktrees/nested-worktree" ] \
    && ok "remove_entry refuses and leaves a dirty registered worktree untouched" \
    || bad "dirty registered worktree was removed despite uncommitted changes"
fi

# --- remove_entry(): B3 fix -- clean registered worktree, HEAD unreachable from any ref -> refused
# WhiteHat NO-GO 16566: a clean, registered worktree can be on a detached HEAD that no branch/
# remote/tag points to; `git worktree remove --force` would turn that commit into a dangling
# object (recoverable only until the next `git gc`). `git status --porcelain` does not catch this.
git -C "$FAKE_MAIN" worktree add -q --detach "$FAKE_HOME/qa-detached-worktree" >/dev/null 2>&1
(
  cd "$FAKE_HOME/qa-detached-worktree" || exit 1
  echo change > f
  git add -A
  git commit -qm "dangling commit, not on any branch"
) >/dev/null 2>&1
WORKTREE_OWNER["$FAKE_HOME/qa-detached-worktree"]="$FAKE_MAIN"
if remove_entry "$FAKE_HOME/qa-detached-worktree" >/dev/null 2>&1; then
  bad "remove_entry must refuse a clean worktree with an unreachable HEAD commit, it did not"
else
  [ -d "$FAKE_HOME/qa-detached-worktree" ] \
    && ok "remove_entry refuses a clean registered worktree whose HEAD commit is unreachable from any branch/remote/tag (B3 fix)" \
    || bad "remove_entry removed the worktree despite the unreachable-HEAD guard"
fi

# --- remove_entry(): plain non-git dir -> rm -rf -----------------------------------------------
mkdir -p "$FAKE_HOME/plain-disposable-dir"
touch -d '2 days ago' "$FAKE_HOME/plain-disposable-dir" # old enough to pass the B1' age re-check
remove_entry "$FAKE_HOME/plain-disposable-dir" >/dev/null 2>&1
[ ! -d "$FAKE_HOME/plain-disposable-dir" ] \
  && ok "remove_entry rm -rf's a plain non-git disposable dir" \
  || bad "plain non-git dir was not removed"

# --- remove_entry(): B1' fix (RedHat NO-GO 16676), live-process axis -- classify DISPOSABLE,
# THEN a process starts with its cwd under the dir BEFORE remove_entry runs; remove_entry must
# re-check fresh (not trust the classify-time snapshot) and skip, leaving the dir in place.
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
toctou_dir="$FAKE_HOME/qa-toctou-race"
mkdir -p "$toctou_dir"
touch -d '2 days ago' "$toctou_dir"
[ "$(classify qa-toctou-race "$toctou_dir")" = DISPOSABLE ] \
  || bad "setup: qa-toctou-race did not classify DISPOSABLE before the race"
( cd "$toctou_dir" && exec sleep 15 ) &
toctou_pid=$!
# Generous retry window (CPU-contention-tolerant, root CLAUDE.md rule 17): this box runs the
# fleet's shared test slots, and a loaded machine can take longer than the pre-existing B1 tests'
# fixed 10x0.2s window to even schedule the forked `sleep`'s /proc/<pid>/cwd into place.
for _ in $(seq 1 60); do
  [ "$(readlink -f "/proc/$toctou_pid/cwd" 2>/dev/null)" = "$toctou_dir" ] && break
  sleep 0.2
done
if remove_entry "$toctou_dir" >/dev/null 2>&1; then
  bad "remove_entry must refuse a dir that gained a live process after classification, it did not (B1' regression)"
else
  [ -d "$toctou_dir" ] \
    && ok "remove_entry re-checks fresh and skips a dir that gained a live process after classification (B1' fix)" \
    || bad "B1' TOCTOU: dir was removed despite a live process starting after classification"
fi
kill "$toctou_pid" 2>/dev/null
wait "$toctou_pid" 2>/dev/null

# --- remove_entry(): B1' fix, age axis -- classify DISPOSABLE, THEN a file is written inside
# before remove_entry runs; remove_entry must re-check age fresh and skip.
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
age_race_dir="$FAKE_HOME/qa-toctou-age"
mkdir -p "$age_race_dir"
touch -d '2 days ago' "$age_race_dir"
[ "$(classify qa-toctou-age "$age_race_dir")" = DISPOSABLE ] \
  || bad "setup: qa-toctou-age did not classify DISPOSABLE before the race"
echo written-after-classify > "$age_race_dir/just-now"
if remove_entry "$age_race_dir" >/dev/null 2>&1; then
  bad "remove_entry must refuse a dir modified after classification, it did not (B1' age-axis regression)"
else
  [ -d "$age_race_dir" ] \
    && ok "remove_entry re-checks age fresh and skips a dir modified after classification (B1' age-axis fix)" \
    || bad "B1' TOCTOU (age): dir was removed despite being modified after classification"
fi

# --- remove_entry(): N5 fix (RedHat NO-GO 16676, non-blocking) -- a LOCKED registered worktree
# must report failure (the remove step's own exit code), not prune's unrelated success -----------
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
git -C "$FAKE_MAIN" branch qa-locked-branch >/dev/null 2>&1
git -C "$FAKE_MAIN" worktree add -q "$FAKE_HOME/qa-locked-worktree" qa-locked-branch >/dev/null 2>&1
find "$FAKE_HOME/qa-locked-worktree" -exec touch -d '2 days ago' {} +
git -C "$FAKE_MAIN" worktree lock "$FAKE_HOME/qa-locked-worktree" >/dev/null 2>&1
WORKTREE_OWNER["$FAKE_HOME/qa-locked-worktree"]="$FAKE_MAIN"
if remove_entry "$FAKE_HOME/qa-locked-worktree" >/dev/null 2>&1; then
  bad "remove_entry must report failure for a locked registered worktree, it did not (N5 regression)"
else
  [ -d "$FAKE_HOME/qa-locked-worktree" ] \
    && ok "remove_entry reports failure (not prune's exit code) for a locked registered worktree (N5 fix)" \
    || bad "N5: locked worktree directory is gone despite the lock"
fi
git -C "$FAKE_MAIN" worktree unlock "$FAKE_HOME/qa-locked-worktree" >/dev/null 2>&1

# --- would_skip_removal() / main() dry-run: N4 fix (RedHat NO-GO 16676, non-blocking) -- a
# DISPOSABLE, registered, DIRTY worktree must not be counted in "would remove N of M" -----------
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
n4_dir="$FAKE_HOME/qa-n4-dirty-disposable"
git -C "$FAKE_MAIN" branch qa-n4-branch >/dev/null 2>&1
git -C "$FAKE_MAIN" worktree add -q "$n4_dir" qa-n4-branch >/dev/null 2>&1
find "$n4_dir" -exec touch -d '2 days ago' {} +
echo dirty >> "$n4_dir/f"
WORKTREE_OWNER["$n4_dir"]="$FAKE_MAIN"
reason="$(would_skip_removal "$n4_dir")"
[ -n "$reason" ] \
  && ok "would_skip_removal() flags a dirty registered worktree with a reason (N4 fix)" \
  || bad "would_skip_removal() did not flag the dirty registered worktree"

# --- main(): dry-run never removes anything, even with matching old DISPOSABLE dirs ------------
rm -rf "$FAKE_HOME"; mkdir -p "$FAKE_HOME"
mkdir -p "$FAKE_HOME/marveen-test-selftest"
touch -d '2 days ago' "$FAKE_HOME/marveen-test-selftest"
out="$(main --dry-run 2>&1)"
if [ -d "$FAKE_HOME/marveen-test-selftest" ] && printf '%s' "$out" | grep -q 'DISPOSABLE.*marveen-test-selftest'; then
  ok "main --dry-run reports a DISPOSABLE entry but removes nothing"
else
  bad "main --dry-run either removed something or failed to report the DISPOSABLE entry"
fi

# --- main(): --apply WITHOUT --yes refuses, removes nothing ------------------------------------
main --apply >/dev/null 2>&1
rc=$?
[ "$rc" = 2 ] && [ -d "$FAKE_HOME/marveen-test-selftest" ] \
  && ok "main --apply without --yes refuses (exit 2) and removes nothing" \
  || bad "main --apply without --yes should refuse with exit 2 and touch nothing (rc=$rc)"

# --- main(): --apply --yes actually removes the DISPOSABLE entry -------------------------------
main --apply --yes >/dev/null 2>&1
[ ! -d "$FAKE_HOME/marveen-test-selftest" ] \
  && ok "main --apply --yes removes the DISPOSABLE entry" \
  || bad "main --apply --yes did not remove the DISPOSABLE entry"

# --- path_under_targets(): N2 fix (RedHat LOW 16849) -- an EMPTY scan result fails CLOSED (treated
# as a live reference present), not OPEN toward "nothing is live" -----------------------------
if path_under_targets "$FAKE_HOME/anything" ""; then
  ok "path_under_targets(): an empty scan result fails CLOSED, treated as found (N2 fix)"
else
  bad "path_under_targets(): empty scan wrongly treated as 'nothing live' -- fail-open regression (N2)"
fi

# --- remove_entry(): N3 fix (RedHat LOW 16849) -- an UNREGISTERED, clean git clone whose HEAD is
# unreachable from any branch/remote/tag must be refused too (mirrors the registered-worktree B3
# guard; closes the matching 16676 N1 gap that was open on this branch) -------------------------
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
n3_dir="$FAKE_HOME/qa-n3-unregistered-detached"
git clone -q "$FAKE_MAIN" "$n3_dir" >/dev/null 2>&1
(
  cd "$n3_dir" || exit 1
  git config user.email s@s; git config user.name s
  git checkout -q --detach >/dev/null 2>&1
  echo change > f
  git add -A
  git commit -qm "dangling commit in an UNREGISTERED clone" >/dev/null 2>&1
) >/dev/null 2>&1
find "$n3_dir" -exec touch -d '2 days ago' {} +
if remove_entry "$n3_dir" >/dev/null 2>&1; then
  bad "remove_entry must refuse an unregistered clone with an unreachable HEAD, it did not (N3 regression)"
else
  [ -d "$n3_dir" ] \
    && ok "remove_entry refuses an UNREGISTERED clean clone whose HEAD is unreachable from any ref (N3 fix)" \
    || bad "N3: unregistered detached-HEAD clone was removed despite the new guard"
fi

# --- remove_entry(): N1 fix (RedHat LOW 16849) -- the fresh live-process/age re-check now runs
# AFTER the git status/rev-list checks (LAST, immediately before the destructive call), not before
# them, shrinking the TOCTOU window to the last check's own runtime instead of two git commands
# plus the check. Shim `git` to be slow (2s) and start a process cwd'd into the worktree WHILE the
# slow git status/rev-list calls are still running -- pre-fix, the live-process re-check would
# already be done (and stale) by the time the process starts; post-fix, it still catches it.
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
SLOWGIT_DELAY=0
git() { sleep "$SLOWGIT_DELAY"; command git "$@"; }
n1_dir="$FAKE_HOME/qa-n1-slowgit"
git -C "$FAKE_MAIN" branch qa-n1-branch >/dev/null 2>&1
git -C "$FAKE_MAIN" worktree add -q "$n1_dir" qa-n1-branch >/dev/null 2>&1
find "$n1_dir" -exec touch -d '2 days ago' {} +
WORKTREE_OWNER["$n1_dir"]="$FAKE_MAIN"
SLOWGIT_DELAY=2
( sleep 0.5; cd "$n1_dir" && exec sleep 10 ) &
n1_race_pid=$!
if remove_entry "$n1_dir" >/dev/null 2>&1; then
  bad "remove_entry must refuse when a process starts cwd'd into the worktree during the (slow) git checks, it did not (N1 regression)"
else
  [ -d "$n1_dir" ] \
    && ok "remove_entry's fresh re-check (reordered to run last) still catches a process that starts mid-git-check (N1 fix)" \
    || bad "N1: worktree removed despite a live process that started during the git status/rev-list calls"
fi
SLOWGIT_DELAY=0
unset -f git
kill "$n1_race_pid" 2>/dev/null
wait "$n1_race_pid" 2>/dev/null

# --- remove_entry(): R10 mutation pin (RedHat LOW 16849, N4) -- the fresh age re-check must convert
# MIN_AGE_HOURS to MINUTES ($((MIN_AGE_HOURS * 60))); a mutant treating MIN_AGE_HOURS as already-
# minutes would miss a file modified 45 minutes ago under a nominal 1-hour window ----------------
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
old_min_age_hours="$MIN_AGE_HOURS"
MIN_AGE_HOURS=1
r10_dir="$FAKE_HOME/qa-r10-age-unit"
mkdir -p "$r10_dir"
touch -d '2 days ago' "$r10_dir"
touch -d '45 minutes ago' "$r10_dir/recent-ish"
if remove_entry "$r10_dir" >/dev/null 2>&1; then
  bad "remove_entry must SKIP a file modified 45 minutes ago under MIN_AGE_HOURS=1 (R10: hours-as-minutes unit mutant)"
else
  [ -d "$r10_dir" ] \
    && ok "remove_entry's age re-check correctly converts MIN_AGE_HOURS to minutes (R10 pin)" \
    || bad "R10: dir removed despite a 45-minute-old file under a 1-hour re-check window"
fi
MIN_AGE_HOURS="$old_min_age_hours"

# has_live_process_under() was permanently stubbed by the two classify() isolation tests above
# ("pretend a process is there" / "return 1") and never restored -- harmless for those tests
# (they call classify() directly, dashboard-gated paths), but it would silently blind every test
# below that actually needs the real check. Restore the original implementation (verbatim from
# wsl-home-cleanup.sh) before relying on it again.
has_live_process_under() {
  if [ "$LIVE_PROC_TARGETS_PRIMED" = 1 ]; then
    path_under_targets "$1" "$LIVE_PROC_TARGETS"
    return $?
  fi
  path_under_targets "$1" "$(scan_live_proc_targets)"
}

# --- main(): R11 + R9 mutation pins (RedHat LOW 16849, N4) -- run through main()'s REAL /proc
# priming (not a manual classify() call) with both a live-fd-holding candidate (must report ACTIVE,
# never DISPOSABLE -- R11: a mutant priming an empty scan would blind the whole classification loop)
# and a comparable non-live candidate (must still report DISPOSABLE -- proves the loop isn't just
# fail-closing EVERYTHING, which would otherwise mask the R11 mutant after the N2 fix above). Also
# checks the "remove N of M" line actually reflects a would_skip_removal-excluded dirty worktree
# (R9: a mutant that bypasses the helper's verdict in the count would promise more than it removes).
rm -rf "$FAKE_HOME"; mkdir -p "$FAKE_HOME"
r11_live_dir="$FAKE_HOME/qa-gate-r11live"
mkdir -p "$r11_live_dir"
: > "$r11_live_dir/live.log"
touch -d '2 days ago' "$r11_live_dir"
( cd "$tmp" && exec tail -f "$r11_live_dir/live.log" >/dev/null 2>&1 ) &
r11_pid=$!
for _ in $(seq 1 30); do
  readlink -f /proc/"$r11_pid"/fd/* 2>/dev/null | grep -qF "$r11_live_dir/live.log" && break
  sleep 0.2
done
r11_dead_dir="$FAKE_HOME/qa-gate-r11dead"
mkdir -p "$r11_dead_dir"
touch -d '2 days ago' "$r11_dead_dir"
r9_dirty_dir="$FAKE_HOME/qa-gate-r9dirty"
git -C "$FAKE_MAIN" branch qa-r9-branch >/dev/null 2>&1
git -C "$FAKE_MAIN" worktree add -q "$r9_dirty_dir" qa-r9-branch >/dev/null 2>&1
find "$r9_dirty_dir" -exec touch -d '2 days ago' {} +
echo dirty >> "$r9_dirty_dir/f"
touch -d '2 days ago' "$r9_dirty_dir/f" # dirty but not "recently modified" for the age check
# dashboard_reachable() is unreachable in this fixture by design (bad token file) -- a registered
# worktree would otherwise fail OPEN to ACTIVE unconditionally (never reaching the DISPOSABLE
# pattern/age check at all), which would make the R9 wiring untestable here. Fake it reachable
# for this one main() call only, restored right after.
dashboard_reachable() { return 0; }
main_out="$(main --dry-run 2>&1)"
dashboard_reachable() { [ -f "$DASHBOARD_TOKEN_FILE" ] || return 1
  printf 'Authorization: Bearer %s\n' "$(cat "$DASHBOARD_TOKEN_FILE")" \
    | curl -s -H @- -o /dev/null -w '%{http_code}' --max-time 3 "$DASHBOARD_URL/api/kanban" 2>/dev/null \
    | grep -q '^200$'; }
if printf '%s\n' "$main_out" | grep -q "^ACTIVE.*qa-gate-r11live$"; then
  ok "main() dry-run: a live-fd candidate classifies ACTIVE through the real priming path (R11 pin)"
else
  bad "R11: main()'s real priming path did not report ACTIVE for the live-fd candidate"
fi
if printf '%s\n' "$main_out" | grep -q "^DISPOSABLE.*qa-gate-r11dead$"; then
  ok "main() dry-run: a comparable non-live candidate still classifies DISPOSABLE (control for the R11 pin -- not just fail-closing everything)"
else
  bad "R11 control: a non-live, old, name-matching candidate did not classify DISPOSABLE -- priming may be fail-closing everything, masking the real bug"
fi
if printf '%s\n' "$main_out" | grep -qE 'remove [0-9]+ of the [0-9]+ DISPOSABLE'; then
  removed_n="$(printf '%s\n' "$main_out" | grep -oE 'remove [0-9]+ of' | grep -oE '[0-9]+')"
  total_m="$(printf '%s\n' "$main_out" | grep -oE 'of the [0-9]+ DISPOSABLE' | grep -oE '[0-9]+')"
  [ -n "$removed_n" ] && [ -n "$total_m" ] && [ "$removed_n" -lt "$total_m" ] \
    && ok "main() dry-run: 'remove N of M' excludes the dirty registered worktree from N, not just from the per-line report (R9 pin)" \
    || bad "R9: 'remove N of M' counted the dirty registered worktree as removable -- the helper's verdict isn't reaching the summary line"
else
  bad "R9: main() dry-run did not print a 'remove N of M DISPOSABLE' summary line to check"
fi
kill "$r11_pid" 2>/dev/null
wait "$r11_pid" 2>/dev/null

echo "selftest: $passed passed, $fail failed"
[ "$fail" = 0 ] || exit 1

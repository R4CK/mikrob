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

# --- MIN_AGE_HOURS positive-integer guard (Cybered GO 33187 on 09ed7ef6, card 8cb1e168) --------
# 0/-5/1.5/empty must refuse to run (non-zero exit, nothing classified as removable); a normal
# value still works. Separate throwaway candidate so this block doesn't depend on fixture state
# left behind by the R11/R9 block above.
# Cybered NO-GO 33289: the first guard (`''|*[!0-9]*|0`) missed two spellings of the same hole --
# a leading-zero zero ("00"/"000", numerically zero but matches none of those three alternatives)
# and a value whose minute count overflows bash's 64-bit arithmetic (2^63 and above, which wraps
# silently instead of erroring). "010" is added too: not itself a hole, but it was silently read
# as octal 8 under the old code instead of refused -- the fixed regex refuses it (leading zero).
rm -rf "$FAKE_HOME"; mkdir -p "$FAKE_HOME"
minage_dir="$FAKE_HOME/qa-gate-minage-fresh"
mkdir -p "$minage_dir"
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
old_min_age_hours="$MIN_AGE_HOURS"
for bad_value in 0 -5 1.5 "" 00 010 9223372036854775807; do
  MIN_AGE_HOURS="$bad_value"
  out="$(main --dry-run 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    ok "MIN_AGE_HOURS='$bad_value': main() refuses to run (rc=$rc)"
  else
    bad "MIN_AGE_HOURS='$bad_value': main() exited 0, expected a refusal" "$out"
  fi
  if printf '%s\n' "$out" | grep -q "DISPOSABLE\|summary:"; then
    bad "MIN_AGE_HOURS='$bad_value': classification output was printed despite the refusal" "$out"
  else
    ok "MIN_AGE_HOURS='$bad_value': nothing was classified as removable (refused before classifying)"
  fi
done

# 9-DIGIT CEILING BOUNDARY PIN (card e2425f05, scope extension comment 33299, Cybered GO 33297 on
# 8cb1e168): the guard regex is ^[1-9][0-9]{0,8}$ -- at most 9 digits total. The bad_value loop
# above never tests a value AT the digit-count boundary, so a {0,9} or {0,7} mutant (one digit
# too many or too few allowed) survives it. 999999999 (exactly 9 digits) must be ACCEPTED;
# 1000000000 (10 digits) must be REFUSED.
MIN_AGE_HOURS=999999999
out="$(main --dry-run 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then
  ok "MIN_AGE_HOURS=999999999 (9 digits, the ceiling): main() runs, not refused"
else
  bad "MIN_AGE_HOURS=999999999 (9 digits, the ceiling) was refused (rc=$rc), expected to run" "$out"
fi

MIN_AGE_HOURS=1000000000
out="$(main --dry-run 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then
  ok "MIN_AGE_HOURS=1000000000 (10 digits, one over the ceiling): main() refuses to run (rc=$rc)"
else
  bad "MIN_AGE_HOURS=1000000000 (10 digits, one over the ceiling) exited 0, expected a refusal" "$out"
fi

MIN_AGE_HOURS="$old_min_age_hours"
touch -d '1 hour ago' "$minage_dir"
normal_out="$(main --dry-run 2>&1)"; normal_rc=$?
if [ "$normal_rc" -eq 0 ]; then
  ok "MIN_AGE_HOURS='$old_min_age_hours' (normal value): main() still runs (rc=0)"
else
  bad "a normal MIN_AGE_HOURS value stopped main() from running (rc=$normal_rc)" "$normal_out"
fi

# --- C1 (RedHat MEDIUM, Cybered gate on 0116755a @ e3ac5b1a6, card 89e8cb90) -- a git that dies
# SILENTLY (non-zero rc, empty output -- the rc 137/127/1 OOM-kill/missing-binary/generic-error
# shape) must be treated as "found a problem" (SKIP), not as "nothing to report" (proceed). Shim
# `git` to fail exactly the named subcommand with the given rc and no output, everything else
# passes through to the real git so the worktree/clone setup around it still works.
GIT_FAIL_CMD=""
GIT_FAIL_RC=0
git() {
  if [ -n "$GIT_FAIL_CMD" ]; then
    local a
    for a in "$@"; do
      [ "$a" = "$GIT_FAIL_CMD" ] && { echo -n ""; return "$GIT_FAIL_RC"; }
    done
  fi
  command git "$@"
}

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
git -C "$FAKE_MAIN" branch qa-c1a-branch >/dev/null 2>&1
command git -C "$FAKE_MAIN" worktree add -q "$FAKE_HOME/qa-c1a-status137" qa-c1a-branch >/dev/null 2>&1
find "$FAKE_HOME/qa-c1a-status137" -exec touch -d '2 days ago' {} +
WORKTREE_OWNER["$FAKE_HOME/qa-c1a-status137"]="$FAKE_MAIN"
GIT_FAIL_CMD=status; GIT_FAIL_RC=137
if remove_entry "$FAKE_HOME/qa-c1a-status137" >/dev/null 2>&1; then
  bad "C1a: remove_entry must SKIP a registered worktree whose git status dies silently (rc=137), it did not"
else
  [ -d "$FAKE_HOME/qa-c1a-status137" ] \
    && ok "remove_entry SKIPs a registered worktree when git status dies silently, rc=137 (C1a fix)" \
    || bad "C1a: worktree removed despite git status failing silently with rc=137"
fi

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
git -C "$FAKE_MAIN" branch qa-c1b-branch >/dev/null 2>&1
command git -C "$FAKE_MAIN" worktree add -q "$FAKE_HOME/qa-c1b-revlist127" qa-c1b-branch >/dev/null 2>&1
find "$FAKE_HOME/qa-c1b-revlist127" -exec touch -d '2 days ago' {} +
WORKTREE_OWNER["$FAKE_HOME/qa-c1b-revlist127"]="$FAKE_MAIN"
GIT_FAIL_CMD=rev-list; GIT_FAIL_RC=127
if remove_entry "$FAKE_HOME/qa-c1b-revlist127" >/dev/null 2>&1; then
  bad "C1b: remove_entry must SKIP a registered worktree whose git rev-list dies silently (rc=127), it did not"
else
  [ -d "$FAKE_HOME/qa-c1b-revlist127" ] \
    && ok "remove_entry SKIPs a registered worktree when git rev-list dies silently, rc=127 (C1b fix)" \
    || bad "C1b: worktree removed despite git rev-list failing silently with rc=127"
fi

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
c1c_dir="$FAKE_HOME/qa-c1c-status1"
command git clone -q "$FAKE_MAIN" "$c1c_dir" >/dev/null 2>&1
find "$c1c_dir" -exec touch -d '2 days ago' {} +
GIT_FAIL_CMD=status; GIT_FAIL_RC=1
if remove_entry "$c1c_dir" >/dev/null 2>&1; then
  bad "C1c: remove_entry must SKIP an unregistered clone whose git status dies silently (rc=1), it did not"
else
  [ -d "$c1c_dir" ] \
    && ok "remove_entry SKIPs an unregistered clone when git status dies silently, rc=1 (C1c fix)" \
    || bad "C1c: unregistered clone removed despite git status failing silently with rc=1"
fi
GIT_FAIL_CMD=""; GIT_FAIL_RC=0
unset -f git

# --- C2 (RedHat LOW, same gate, card 89e8cb90) -- three mutants that survived because nothing
# called would_skip_removal()/remove_entry() along the path they guard -----------------------

# C2a: would_skip_removal()'s report-side guard for an UNREGISTERED clone with an unreachable HEAD
# (N3's report-side addition) -- only remove_entry's matching enforcement-side guard had a test.
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
c2a_dir="$FAKE_HOME/qa-c2a-unregistered-detached"
git clone -q "$FAKE_MAIN" "$c2a_dir" >/dev/null 2>&1
(
  cd "$c2a_dir" || exit 1
  git config user.email s@s; git config user.name s
  git checkout -q --detach >/dev/null 2>&1
  echo change > f
  git add -A
  git commit -qm "dangling commit in an UNREGISTERED clone (C2a)"
) >/dev/null 2>&1
reason="$(would_skip_removal "$c2a_dir")"
[ -n "$reason" ] \
  && ok "would_skip_removal() flags an unregistered clone with an unreachable HEAD (C2a pin, N3 report-side)" \
  || bad "C2a: would_skip_removal() silently passed an unregistered unreachable-HEAD clone"

# C2b: would_skip_removal()'s report-side guard for a REGISTERED worktree with an unreachable HEAD
# (mirrors remove_entry's own B3 enforcement guard, which already had a test; the report side did not).
git -C "$FAKE_MAIN" worktree add -q --detach "$FAKE_HOME/qa-c2b-detached-worktree" >/dev/null 2>&1
(
  cd "$FAKE_HOME/qa-c2b-detached-worktree" || exit 1
  echo change > f
  git add -A
  git commit -qm "dangling commit, not on any branch (C2b)"
) >/dev/null 2>&1
WORKTREE_OWNER["$FAKE_HOME/qa-c2b-detached-worktree"]="$FAKE_MAIN"
reason="$(would_skip_removal "$FAKE_HOME/qa-c2b-detached-worktree")"
[ -n "$reason" ] \
  && ok "would_skip_removal() flags a registered worktree with an unreachable HEAD (C2b pin, B3 report-side)" \
  || bad "C2b: would_skip_removal() silently passed a registered unreachable-HEAD worktree"

# C2c: --no-optional-locks must actually reach the status call, not just sit in a comment.
# Logs the argv of every git invocation that mentions "status" while the shim is active.
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
argv_log="$tmp/git-argv.log"
: > "$argv_log"
git() {
  local a
  for a in "$@"; do
    [ "$a" = "status" ] && printf '%s\n' "$*" >> "$argv_log"
  done
  command git "$@"
}
git -C "$FAKE_MAIN" branch qa-c2c-branch >/dev/null 2>&1
command git -C "$FAKE_MAIN" worktree add -q "$FAKE_HOME/qa-c2c-locks-pin" qa-c2c-branch >/dev/null 2>&1
find "$FAKE_HOME/qa-c2c-locks-pin" -exec touch -d '2 days ago' {} +
WORKTREE_OWNER["$FAKE_HOME/qa-c2c-locks-pin"]="$FAKE_MAIN"
remove_entry "$FAKE_HOME/qa-c2c-locks-pin" >/dev/null 2>&1
unset -f git
if grep -q -- '--no-optional-locks' "$argv_log"; then
  ok "remove_entry's status check passes --no-optional-locks through to git (C2c pin)"
else
  bad "C2c: --no-optional-locks missing from the status call's argv"
fi

# --- CONDITION 1 (Cybered GO 32903 on 3bcdc0a6c, card 09ed7ef6) -- a `find -mmin` age re-check
# that dies SILENTLY (non-zero rc, empty output) must be treated as "found a recent file" (fail
# closed: UNKNOWN/SKIP), not as "nothing recent" (proceed). Shim `find` to fail exactly the -mmin
# invocation with the given rc and no output; everything else (the fixture setup's own `find
# ... -exec touch` calls) passes through to the real find. -----------------------------------
FIND_FAIL_RC=0
find() {
  if [ "$FIND_FAIL_RC" != 0 ]; then
    local a
    for a in "$@"; do
      [ "$a" = "-mmin" ] && return "$FIND_FAIL_RC"
    done
  fi
  command find "$@"
}

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
c1find_dir="$FAKE_HOME/qa-gate-c1find-classify"
mkdir -p "$c1find_dir"
find "$c1find_dir" -exec touch -d '2 days ago' {} + # real find, not yet failing
FIND_FAIL_RC=137
if [ "$(classify qa-gate-c1find-classify "$c1find_dir")" = UNKNOWN ]; then
  ok "classify() treats a silently-failing find (-mmin, rc=137) as UNKNOWN, not DISPOSABLE (CONDITION 1 fix)"
else
  bad "CONDITION 1: classify() reported DISPOSABLE for a dir whose age re-check failed silently"
fi
FIND_FAIL_RC=0

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
git -C "$FAKE_MAIN" branch qa-c1find-reg-branch >/dev/null 2>&1
command git -C "$FAKE_MAIN" worktree add -q "$FAKE_HOME/qa-c1find-reg" qa-c1find-reg-branch >/dev/null 2>&1
find "$FAKE_HOME/qa-c1find-reg" -exec touch -d '2 days ago' {} +
WORKTREE_OWNER["$FAKE_HOME/qa-c1find-reg"]="$FAKE_MAIN"
FIND_FAIL_RC=127
if remove_entry "$FAKE_HOME/qa-c1find-reg" >/dev/null 2>&1; then
  bad "CONDITION 1: remove_entry must SKIP a registered worktree whose age re-check find dies silently (rc=127), it did not"
else
  [ -d "$FAKE_HOME/qa-c1find-reg" ] \
    && ok "remove_entry SKIPs a registered worktree when the age re-check find dies silently, rc=127 (CONDITION 1 fix)" \
    || bad "CONDITION 1: registered worktree removed despite its age re-check find failing silently with rc=127"
fi
FIND_FAIL_RC=0

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
c1find_unreg="$FAKE_HOME/qa-c1find-unreg"
mkdir -p "$c1find_unreg"
find "$c1find_unreg" -exec touch -d '2 days ago' {} +
FIND_FAIL_RC=1
if remove_entry "$c1find_unreg" >/dev/null 2>&1; then
  bad "CONDITION 1: remove_entry must SKIP an unregistered plain dir whose age re-check find dies silently (rc=1), it did not"
else
  [ -d "$c1find_unreg" ] \
    && ok "remove_entry SKIPs an unregistered plain dir when the age re-check find dies silently, rc=1 (CONDITION 1 fix)" \
    || bad "CONDITION 1: unregistered dir removed despite its age re-check find failing silently with rc=1"
fi
FIND_FAIL_RC=0
unset -f find

# --- CONDITION 2 (LOW, Cybered GO 32903 on 3bcdc0a6c, card 09ed7ef6) -- 5 of the 8
# git_dirty_or_failed call sites had no mutant-killing test (would_skip_removal's 4 sites, plus
# remove_entry's unregistered-clone rev-list site); add one case per remaining site. -------------
GIT_FAIL_CMD=""
GIT_FAIL_RC=0
git() {
  if [ -n "$GIT_FAIL_CMD" ]; then
    local a
    for a in "$@"; do
      [ "$a" = "$GIT_FAIL_CMD" ] && { echo -n ""; return "$GIT_FAIL_RC"; }
    done
  fi
  command git "$@"
}

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
git -C "$FAKE_MAIN" branch qa-wsr-g1-branch >/dev/null 2>&1
command git -C "$FAKE_MAIN" worktree add -q "$FAKE_HOME/qa-wsr-g1-reg-status" qa-wsr-g1-branch >/dev/null 2>&1
WORKTREE_OWNER["$FAKE_HOME/qa-wsr-g1-reg-status"]="$FAKE_MAIN"
GIT_FAIL_CMD=status; GIT_FAIL_RC=137
reason="$(would_skip_removal "$FAKE_HOME/qa-wsr-g1-reg-status")"
[ -n "$reason" ] \
  && ok "would_skip_removal() flags a registered worktree when git status dies silently, rc=137 (CONDITION 2 fix)" \
  || bad "CONDITION 2: would_skip_removal() silently passed a registered worktree whose git status died (rc=137)"

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
git -C "$FAKE_MAIN" branch qa-wsr-g2-branch >/dev/null 2>&1
command git -C "$FAKE_MAIN" worktree add -q "$FAKE_HOME/qa-wsr-g2-reg-revlist" qa-wsr-g2-branch >/dev/null 2>&1
WORKTREE_OWNER["$FAKE_HOME/qa-wsr-g2-reg-revlist"]="$FAKE_MAIN"
GIT_FAIL_CMD=rev-list; GIT_FAIL_RC=127
reason="$(would_skip_removal "$FAKE_HOME/qa-wsr-g2-reg-revlist")"
[ -n "$reason" ] \
  && ok "would_skip_removal() flags a registered worktree when git rev-list dies silently, rc=127 (CONDITION 2 fix)" \
  || bad "CONDITION 2: would_skip_removal() silently passed a registered worktree whose git rev-list died (rc=127)"

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
wsr_g3_dir="$FAKE_HOME/qa-wsr-g3-unreg-status"
command git clone -q "$FAKE_MAIN" "$wsr_g3_dir" >/dev/null 2>&1
GIT_FAIL_CMD=status; GIT_FAIL_RC=1
reason="$(would_skip_removal "$wsr_g3_dir")"
[ -n "$reason" ] \
  && ok "would_skip_removal() flags an unregistered clone when git status dies silently, rc=1 (CONDITION 2 fix)" \
  || bad "CONDITION 2: would_skip_removal() silently passed an unregistered clone whose git status died (rc=1)"

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
wsr_g4_dir="$FAKE_HOME/qa-wsr-g4-unreg-revlist"
command git clone -q "$FAKE_MAIN" "$wsr_g4_dir" >/dev/null 2>&1
GIT_FAIL_CMD=rev-list; GIT_FAIL_RC=137
reason="$(would_skip_removal "$wsr_g4_dir")"
[ -n "$reason" ] \
  && ok "would_skip_removal() flags an unregistered clone when git rev-list dies silently, rc=137 (CONDITION 2 fix)" \
  || bad "CONDITION 2: would_skip_removal() silently passed an unregistered clone whose git rev-list died (rc=137)"

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
re_g5_dir="$FAKE_HOME/qa-re-g5-unreg-revlist"
command git clone -q "$FAKE_MAIN" "$re_g5_dir" >/dev/null 2>&1
find "$re_g5_dir" -exec touch -d '2 days ago' {} +
GIT_FAIL_CMD=rev-list; GIT_FAIL_RC=127
if remove_entry "$re_g5_dir" >/dev/null 2>&1; then
  bad "CONDITION 2: remove_entry must SKIP an unregistered clone whose git rev-list dies silently (rc=127), it did not"
else
  [ -d "$re_g5_dir" ] \
    && ok "remove_entry SKIPs an unregistered clone when git rev-list dies silently, rc=127 (CONDITION 2 fix)" \
    || bad "CONDITION 2: unregistered clone removed despite git rev-list failing silently with rc=127"
fi
GIT_FAIL_CMD=""; GIT_FAIL_RC=0
unset -f git

# --- CONDITION 2 (LOW), --no-optional-locks pin -- 3 of the 4 sites that pass the flag had no
# test proving the flag actually reaches git's argv (only remove_entry's registered-worktree site
# was pinned, by C2c above). ----------------------------------------------------------------------
pin_no_optional_locks() {
  local label="$1" dir="$2" fn="$3"
  local safe_label="${label//\//_}"
  local argv_log="$tmp/git-argv-$safe_label.log"
  : > "$argv_log"
  git() {
    local a
    for a in "$@"; do
      [ "$a" = "status" ] && printf '%s\n' "$*" >> "$argv_log"
    done
    command git "$@"
  }
  "$fn" "$dir" >/dev/null 2>&1
  unset -f git
  if grep -q -- '--no-optional-locks' "$argv_log"; then
    ok "$label: --no-optional-locks reaches git's status argv (CONDITION 2 pin)"
  else
    bad "$label: --no-optional-locks missing from the status call's argv"
  fi
}

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
git -C "$FAKE_MAIN" branch qa-locks1-branch >/dev/null 2>&1
command git -C "$FAKE_MAIN" worktree add -q "$FAKE_HOME/qa-locks1-wsr-reg" qa-locks1-branch >/dev/null 2>&1
WORKTREE_OWNER["$FAKE_HOME/qa-locks1-wsr-reg"]="$FAKE_MAIN"
pin_no_optional_locks "would_skip_removal/registered" "$FAKE_HOME/qa-locks1-wsr-reg" would_skip_removal

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
locks2_dir="$FAKE_HOME/qa-locks2-wsr-unreg"
command git clone -q "$FAKE_MAIN" "$locks2_dir" >/dev/null 2>&1
pin_no_optional_locks "would_skip_removal/unregistered" "$locks2_dir" would_skip_removal

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
locks3_dir="$FAKE_HOME/qa-locks3-re-unreg"
command git clone -q "$FAKE_MAIN" "$locks3_dir" >/dev/null 2>&1
find "$locks3_dir" -exec touch -d '2 days ago' {} +
pin_no_optional_locks "remove_entry/unregistered" "$locks3_dir" remove_entry

# --- ORPHAN regression cases (CYBERSEC NO-GO 39669 HIGH-1 / QA FAIL 39674, card 9918f78d) ------
# Pins the exact 4 old-kept -> new-removed regressions CYBERSEC's probe found, now that ORPHAN is
# a refinement of the DISPOSABLE name+age gate instead of a bypass that ran before it.
make_dangling_worktree() {
  # $1 = dir to create, $2 = gitdir target to point at (created or not, caller's choice)
  mkdir -p "$1"
  echo "gitdir: $2" > "$1/.git"
}

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
rm -rf "$FAKE_HOME"; mkdir -p "$FAKE_HOME"

# Case 1 (cc-fresh): DISPOSABLE name, dangling gitdir, edited JUST NOW -- must stay UNKNOWN, the
# age gate alone must keep it out of ORPHAN (and out of DISPOSABLE too).
case1_dir="$FAKE_HOME/cc-fresh"
make_dangling_worktree "$case1_dir" "$tmp/nonexistent-gitdir-1/worktrees/cc-fresh"
[ "$(classify cc-fresh "$case1_dir")" = UNKNOWN ] \
  && ok "ORPHAN regression 1/4: a DISPOSABLE-named, freshly-edited dangling-gitdir dir stays UNKNOWN (age gate still applies)" \
  || bad "ORPHAN regression 1/4: freshly-edited dangling-gitdir dir did not stay UNKNOWN (CYBERSEC cc-fresh row)"

# Case 2 (unknownname-proj): name matches no DISPOSABLE pattern, dangling gitdir, edited just now
# -- must stay UNKNOWN, the name gate alone must keep it out of ORPHAN.
case2_dir="$FAKE_HOME/unknownname-proj"
make_dangling_worktree "$case2_dir" "$tmp/nonexistent-gitdir-2/worktrees/unknownname-proj"
[ "$(classify unknownname-proj "$case2_dir")" = UNKNOWN ] \
  && ok "ORPHAN regression 2/4: a non-matching-name dangling-gitdir dir stays UNKNOWN (name gate still applies)" \
  || bad "ORPHAN regression 2/4: non-matching-name dangling-gitdir dir did not stay UNKNOWN (CYBERSEC unknownname-proj row)"

# Case 3 (cc-oldorphan): DISPOSABLE name, 3 days old, dangling gitdir whose PARENT is reachable --
# now correctly classifies ORPHAN (an improvement over the old DISPOSABLE-but-always-SKIPped
# behaviour, safe because it still goes through the same fresh re-check tail as DISPOSABLE).
case3_dir="$FAKE_HOME/cc-oldorphan"
mkdir -p "$tmp/reachable-repo/worktrees"
make_dangling_worktree "$case3_dir" "$tmp/reachable-repo/worktrees/cc-oldorphan"
find "$case3_dir" -exec touch -d '3 days ago' {} +
touch -d '3 days ago' "$case3_dir"
[ "$(classify cc-oldorphan "$case3_dir")" = ORPHAN ] \
  && ok "ORPHAN regression 3/4: an old DISPOSABLE-named dangling-gitdir dir with a reachable gitdir parent IS classified ORPHAN" \
  || bad "ORPHAN regression 3/4: old dangling-gitdir dir with reachable parent did not classify ORPHAN (CYBERSEC cc-oldorphan row)"
if remove_orphan_entry "$case3_dir" >/dev/null 2>&1 && [ ! -d "$case3_dir" ]; then
  ok "ORPHAN regression 3/4b: remove_orphan_entry() actually removes a genuinely dead, old, idle orphan"
else
  bad "ORPHAN regression 3/4b: remove_orphan_entry() did not remove a dead/old/idle orphan it should have"
fi

# Case 4 (unmounted-mopsion): DISPOSABLE name, old, BUT the gitdir's own PARENT directory does not
# exist either (fix-direction c: indistinguishable from an unmounted filesystem) -- must stay
# DISPOSABLE (ordinary guard-gated removal path), never upgrade to ORPHAN.
case4_dir="$FAKE_HOME/cc-unmounted"
make_dangling_worktree "$case4_dir" "$tmp/totally-unreachable-mount/worktrees/cc-unmounted"
find "$case4_dir" -exec touch -d '3 days ago' {} +
touch -d '3 days ago' "$case4_dir"
[ "$(classify cc-unmounted "$case4_dir")" = DISPOSABLE ] \
  && ok "ORPHAN regression 4/4: a dangling gitdir whose PARENT is also unreachable stays DISPOSABLE, never upgrades to ORPHAN" \
  || bad "ORPHAN regression 4/4: unreachable-parent gitdir wrongly upgraded away from DISPOSABLE (CYBERSEC unmounted-mopsion row)"

# Case 5: live-cwd-in-orphan TOCTOU -- classify ORPHAN at a point when nothing is live, THEN a
# process starts cwd'd into it, THEN remove_orphan_entry() must still catch it via its own fresh
# re-check (mirrors remove_entry()'s N1 pattern, now exercised for the orphan removal path too).
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
case5_dir="$FAKE_HOME/cc-orphan-toctou"
mkdir -p "$tmp/reachable-repo2/worktrees"
make_dangling_worktree "$case5_dir" "$tmp/reachable-repo2/worktrees/cc-orphan-toctou"
find "$case5_dir" -exec touch -d '3 days ago' {} +
touch -d '3 days ago' "$case5_dir"
[ "$(classify cc-orphan-toctou "$case5_dir")" = ORPHAN ] \
  || bad "ORPHAN regression 5/5: setup failed -- cc-orphan-toctou did not classify ORPHAN before the race"
( cd "$tmp" && exec sleep 10 ) &
case5_pid=$!
( cd "$case5_dir" && exec sleep 10 ) &
case5_live_pid=$!
for _ in $(seq 1 30); do
  readlink -f /proc/"$case5_live_pid"/cwd 2>/dev/null | grep -qF "$case5_dir" && break
  sleep 0.2
done
if remove_orphan_entry "$case5_dir" >/dev/null 2>&1; then
  bad "ORPHAN regression 5/5: remove_orphan_entry() must SKIP when a live process has cwd under it, it did not"
else
  [ -d "$case5_dir" ] \
    && ok "ORPHAN regression 5/5: remove_orphan_entry()'s fresh live-process re-check catches a TOCTOU race" \
    || bad "ORPHAN regression 5/5: orphan dir removed despite a live process cwd'd into it"
fi
kill "$case5_pid" "$case5_live_pid" 2>/dev/null
wait "$case5_pid" "$case5_live_pid" 2>/dev/null

# --- QA2 FAIL 39673: generated-content-only dirt no longer blocks removal, real dirt still does -
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
genonly_dir="$FAKE_HOME/qa-gen-only"
git -C "$FAKE_MAIN" branch qa-gen-only-branch >/dev/null 2>&1
git -C "$FAKE_MAIN" worktree add -q "$genonly_dir" qa-gen-only-branch >/dev/null 2>&1
mkdir -p "$genonly_dir/node_modules/.pnpm" "$genonly_dir/dist"
: > "$genonly_dir/node_modules/.pnpm/marker"
: > "$genonly_dir/dist/bundle.js"
find "$genonly_dir" -exec touch -d '2 days ago' {} +
WORKTREE_OWNER["$genonly_dir"]="$FAKE_MAIN"
reason="$(would_skip_removal "$genonly_dir")"
[ -z "$reason" ] \
  && ok "QA2 fix: generated-content-only dirt (node_modules/, dist/) does not block would_skip_removal()" \
  || bad "QA2 regression: generated-content-only dirt still flagged as a skip reason: $reason"

HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
realdirt_dir="$FAKE_HOME/qa-real-dirt"
git -C "$FAKE_MAIN" branch qa-real-dirt-branch >/dev/null 2>&1
git -C "$FAKE_MAIN" worktree add -q "$realdirt_dir" qa-real-dirt-branch >/dev/null 2>&1
mkdir -p "$realdirt_dir/node_modules"
: > "$realdirt_dir/node_modules/marker"
echo "real uncommitted change" > "$realdirt_dir/f"
find "$realdirt_dir" -exec touch -d '2 days ago' {} +
WORKTREE_OWNER["$realdirt_dir"]="$FAKE_MAIN"
reason="$(would_skip_removal "$realdirt_dir")"
[ -n "$reason" ] \
  && ok "QA2 fix control: real dirt mixed with generated-content dirt is STILL flagged (not over-widened)" \
  || bad "QA2 regression: real uncommitted change alongside generated content was wrongly treated as clean"

# --- MikroB round-2 request (card 9918f78d): the generated-content exception matches by PATH
# only -- it must not accidentally cover a TRACKED file that happens to live under one of those
# paths (an unusual but real shape: a vendored/patched file deliberately committed inside
# node_modules/) when that file is actually modified. A tracked, modified file's porcelain line
# (" M path") carries real, protected work exactly like any other tracked change -- it must stay
# fail-closed, never be waved through just because its path matches node_modules/.
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
trackedmod_dir="$FAKE_HOME/qa-tracked-modified-under-generated"
git -C "$FAKE_MAIN" branch qa-trackedmod-branch >/dev/null 2>&1
git -C "$FAKE_MAIN" worktree add -q "$trackedmod_dir" qa-trackedmod-branch >/dev/null 2>&1
mkdir -p "$trackedmod_dir/node_modules"
echo "vendored, committed on purpose" > "$trackedmod_dir/node_modules/patched-vendor-file.js"
git -C "$trackedmod_dir" add node_modules/patched-vendor-file.js >/dev/null 2>&1
git -C "$trackedmod_dir" -c user.email=t@t -c user.name=t commit -q -m "commit a tracked file under node_modules/ on purpose"
echo "modified after commit" > "$trackedmod_dir/node_modules/patched-vendor-file.js"
find "$trackedmod_dir" -exec touch -d '2 days ago' {} + 2>/dev/null
WORKTREE_OWNER["$trackedmod_dir"]="$FAKE_MAIN"
reason="$(would_skip_removal "$trackedmod_dir")"
[ -n "$reason" ] \
  && ok "MikroB r2: a TRACKED file modified under node_modules/ still blocks removal (fail-closed)" \
  || bad "MikroB r2 regression: a tracked, modified file under node_modules/ was wrongly treated as generated-only-safe"

# --- MikroB round-2 request, second half: an untracked SOURCE file sitting NEXT TO the generated
# dirs (not under any of them) must still block removal -- the generated-content exception must
# never widen to cover real, non-generated untracked work just because it shares a worktree with
# node_modules/dist/build/.next clutter.
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=(); DASHBOARD_UP=0
untracked_sibling_dir="$FAKE_HOME/qa-untracked-sibling-source"
git -C "$FAKE_MAIN" branch qa-untracked-sibling-branch >/dev/null 2>&1
git -C "$FAKE_MAIN" worktree add -q "$untracked_sibling_dir" qa-untracked-sibling-branch >/dev/null 2>&1
mkdir -p "$untracked_sibling_dir/node_modules/.pnpm" "$untracked_sibling_dir/dist"
: > "$untracked_sibling_dir/node_modules/.pnpm/marker"
: > "$untracked_sibling_dir/dist/bundle.js"
echo "new, uncommitted source file" > "$untracked_sibling_dir/new-feature.ts"
find "$untracked_sibling_dir" -exec touch -d '2 days ago' {} + 2>/dev/null
WORKTREE_OWNER["$untracked_sibling_dir"]="$FAKE_MAIN"
reason="$(would_skip_removal "$untracked_sibling_dir")"
[ -n "$reason" ] \
  && ok "MikroB r2: an untracked source file next to generated dirs still blocks removal (fail-closed)" \
  || bad "MikroB r2 regression: an untracked, non-generated source file was wrongly treated as generated-only-safe"

echo "selftest: $passed passed, $fail failed"
[ "$fail" = 0 ] || exit 1

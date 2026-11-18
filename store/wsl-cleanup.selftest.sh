#!/usr/bin/env bash
# Self-test for store/wsl-cleanup.sh's live-pid guard on throwaway land/test worktrees
# (card 7f3e8ac6).
#
# Run: bash store/wsl-cleanup.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# THE DEFECT: sweep_throwaway_worktrees() decided whether to remove a throwaway worktree from
# mtime age (>= MIN_AGE_MIN) and `git status --porcelain` being clean, nothing else. A land/test
# run can legitimately run past MIN_AGE_MIN (measured live: card 22835648 ran 1h38m) without
# touching the worktree's own top-level mtime the whole time, so a clean, old worktree whose
# owning process is STILL running could be force-removed mid-run. The fix extracts the PID
# encoded in the worktree's own name (marveen-land.sh's "<prefix>-<name>-$$" convention) and
# skips removal when that PID is a live process.
#
# HERMETIC-ISH: uses a throwaway git repo as MARVEEN_MAIN, but the worktree PATHS themselves are
# real, disposable directories under /home/neon/marveen-land-<name>-<pid> (cleaned up in the
# trap) -- unavoidable because wsl-cleanup.sh's pattern for this sweep is an absolute literal
# prefix (/home/neon/marveen-land-...), not derived from $MARVEEN_MAIN. CLEANCORE_MAIN points at
# a plain (non-git) temp dir so the sibling cc-land sweep is a no-op and touches nothing.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/wsl-cleanup.sh"

pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
MARVEEN_MAIN_TEST="$TMP/main"
CLEANCORE_MAIN_TEST="$TMP/no-git-here"
mkdir -p "$MARVEEN_MAIN_TEST" "$CLEANCORE_MAIN_TEST"

git init -q "$MARVEEN_MAIN_TEST"
git -C "$MARVEEN_MAIN_TEST" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

LIVE_DIR=""
DEAD_DIR=""
LIVE_PID=""
DEAD_PID=""
SLEEP_PID=""

cleanup() {
  [ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null
  for d in "$LIVE_DIR" "$DEAD_DIR"; do
    [ -n "$d" ] && [ -d "$d" ] && git -C "$MARVEEN_MAIN_TEST" worktree remove --force "$d" 2>/dev/null
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

# A real, still-running process: a background sleep. Its PID is genuinely alive for the whole
# test (killed in the trap above).
sleep 60 &
SLEEP_PID=$!
LIVE_PID="$SLEEP_PID"

# A real, already-exited process: start it and wait for it, so its PID is confirmed dead (not
# just "probably" -- `wait` only returns after the process has actually exited).
( exit 0 ) &
DEAD_PID=$!
wait "$DEAD_PID" 2>/dev/null

LIVE_DIR="/home/neon/marveen-land-selftestlive-${LIVE_PID}"
DEAD_DIR="/home/neon/marveen-land-selftestdead-${DEAD_PID}"
rm -rf "$LIVE_DIR" "$DEAD_DIR"

git -C "$MARVEEN_MAIN_TEST" worktree add -q --detach "$LIVE_DIR" HEAD
git -C "$MARVEEN_MAIN_TEST" worktree add -q --detach "$DEAD_DIR" HEAD

# Backdate both well past MIN_AGE_MIN so age alone would qualify both for removal.
PAST=$(( $(date +%s) - 130 * 60 ))
touch -d "@$PAST" "$LIVE_DIR" "$DEAD_DIR"

OUT="$(MARVEEN_MAIN="$MARVEEN_MAIN_TEST" CLEANCORE_MAIN="$CLEANCORE_MAIN_TEST" \
       WSL_CLEANUP_MIN_AGE_MIN=120 bash "$RUN" --dry-run 2>&1)"

# --- Case 1: clean, >2h old worktree whose owning PID is ALIVE must NOT be removed ----------
if echo "$OUT" | grep -qF "SKIP (owning pid $LIVE_PID still alive): $LIVE_DIR"; then
  ok "live-pid worktree is skipped with the expected message"
else
  bad "live-pid worktree was not skipped as expected" "$OUT"
fi
if echo "$OUT" | grep -qF "worktree remove --force $LIVE_DIR"; then
  bad "live-pid worktree was (dry-run) removed -- must never happen" "$OUT"
else
  ok "live-pid worktree was not passed to 'git worktree remove'"
fi

# --- Case 2: same shape but the owning PID is DEAD -- must still be removed ------------------
if echo "$OUT" | grep -qF "worktree remove --force $DEAD_DIR"; then
  ok "dead-pid worktree is still removed (dry-run)"
else
  bad "dead-pid worktree was NOT removed, expected it to be" "$OUT"
fi
if echo "$OUT" | grep -qF "SKIP (owning pid $DEAD_PID still alive): $DEAD_DIR"; then
  bad "dead-pid worktree was incorrectly reported as having a live owning pid" "$OUT"
else
  ok "dead-pid worktree was not skipped for a live-pid reason"
fi
# Remove DEAD_DIR for real now (it was only ever dry-run'd above) -- left registered, it would
# keep reappearing in every later sweep in this file and pollute their counts/output.
git -C "$MARVEEN_MAIN_TEST" worktree remove --force "$DEAD_DIR" 2>/dev/null
DEAD_DIR=""

# --- section-1 guard pins (Cybered LOW, card c9c1f159, comment 32973 condition 3: these four
# worktree-sweep mutants left the ORIGINAL suite green) ---------------------------------------

# AGE guard pin: a clean, dead-pid worktree that is BRAND NEW (not backdated) must not be removed.
( exit 0 ) &
AGE_PID=$!
wait "$AGE_PID" 2>/dev/null
AGE_DIR="/home/neon/marveen-land-selftestage-${AGE_PID}"
rm -rf "$AGE_DIR"
git -C "$MARVEEN_MAIN_TEST" worktree add -q --detach "$AGE_DIR" HEAD
out="$(MARVEEN_MAIN="$MARVEEN_MAIN_TEST" CLEANCORE_MAIN="$CLEANCORE_MAIN_TEST" \
       WSL_CLEANUP_MIN_AGE_MIN=120 bash "$RUN" --dry-run 2>&1)"
if echo "$out" | grep -qF "worktree remove --force $AGE_DIR"; then
  bad "AGE guard (section 1): a brand-new worktree was (dry-run) removed -- age guard not enforced" "$out"
else
  ok "AGE guard (section 1): a brand-new, not-yet-old worktree is not removed"
fi
git -C "$MARVEEN_MAIN_TEST" worktree remove --force "$AGE_DIR" 2>/dev/null

# NAME-PATTERN guard pin: a clean, dead-pid, old worktree whose NAME does not match the throwaway
# pattern (it is missing the literal "-land-" segment) must never be touched, however old/clean.
( exit 0 ) &
NP_PID=$!
wait "$NP_PID" 2>/dev/null
NP_DIR="/home/neon/marveen-NOTTHROWAWAY-${NP_PID}"
rm -rf "$NP_DIR"
git -C "$MARVEEN_MAIN_TEST" worktree add -q --detach "$NP_DIR" HEAD
PAST=$(( $(date +%s) - 130 * 60 ))
touch -d "@$PAST" "$NP_DIR"
out="$(MARVEEN_MAIN="$MARVEEN_MAIN_TEST" CLEANCORE_MAIN="$CLEANCORE_MAIN_TEST" \
       WSL_CLEANUP_MIN_AGE_MIN=120 bash "$RUN" --dry-run 2>&1)"
if echo "$out" | grep -qF "$NP_DIR"; then
  bad "NAME-PATTERN guard (section 1): a non-matching-name worktree was mentioned/removed -- name-pattern guard not enforced" "$out"
else
  ok "NAME-PATTERN guard (section 1): a worktree whose name doesn't match the throwaway pattern is never touched"
fi
git -C "$MARVEEN_MAIN_TEST" worktree remove --force "$NP_DIR" 2>/dev/null

# STAT-fallback guard pin: if `stat` fails for one worktree, the `|| echo "$now"` fallback treats
# its mtime as NOW (age 0), so it must NOT be removed even though it is actually old and clean.
( exit 0 ) &
STATFAIL_PID=$!
wait "$STATFAIL_PID" 2>/dev/null
STATFAIL_DIR="/home/neon/marveen-land-selfteststatfail-${STATFAIL_PID}"
rm -rf "$STATFAIL_DIR"
git -C "$MARVEEN_MAIN_TEST" worktree add -q --detach "$STATFAIL_DIR" HEAD
PAST=$(( $(date +%s) - 130 * 60 ))
touch -d "@$PAST" "$STATFAIL_DIR"
stat() {
  local a
  for a in "$@"; do
    [ "$a" = "$STATFAIL_DIR" ] && return 1
  done
  command stat "$@"
}
export -f stat
export STATFAIL_DIR
out="$(MARVEEN_MAIN="$MARVEEN_MAIN_TEST" CLEANCORE_MAIN="$CLEANCORE_MAIN_TEST" \
       WSL_CLEANUP_MIN_AGE_MIN=120 bash "$RUN" --dry-run 2>&1)"
unset -f stat
if echo "$out" | grep -qF "worktree remove --force $STATFAIL_DIR"; then
  bad "STAT-fallback guard (section 1): a worktree whose stat call fails was (dry-run) removed -- fallback-to-now not enforced" "$out"
else
  ok "STAT-fallback guard (section 1): a worktree whose stat call fails is treated as too new, not removed"
fi
git -C "$MARVEEN_MAIN_TEST" worktree remove --force "$STATFAIL_DIR" 2>/dev/null

# Counter-split pin: the aggregate "skipped (git rc): N" summary count, not just the per-entry
# SKIP line, must reflect a git-rc failure -- folding it back into skipped_dirty, or dropping the
# label, previously stayed green (Cybered condition 3).
( exit 0 ) &
RCCOUNT_PID=$!
wait "$RCCOUNT_PID" 2>/dev/null
RCCOUNT_DIR="/home/neon/marveen-land-selftestrccount-${RCCOUNT_PID}"
rm -rf "$RCCOUNT_DIR"
git -C "$MARVEEN_MAIN_TEST" worktree add -q --detach "$RCCOUNT_DIR" HEAD
PAST=$(( $(date +%s) - 130 * 60 ))
touch -d "@$PAST" "$RCCOUNT_DIR"
git() {
  local a is_status=0 is_target=0
  for a in "$@"; do
    [ "$a" = "status" ] && is_status=1
    [ "$a" = "$RCCOUNT_DIR" ] && is_target=1
  done
  [ "$is_status" = 1 ] && [ "$is_target" = 1 ] && { echo -n ""; return 137; }
  command git "$@"
}
export -f git
export RCCOUNT_DIR
out="$(MARVEEN_MAIN="$MARVEEN_MAIN_TEST" CLEANCORE_MAIN="$CLEANCORE_MAIN_TEST" \
       WSL_CLEANUP_MIN_AGE_MIN=120 bash "$RUN" --dry-run 2>&1)"
unset -f git
if echo "$out" | grep -qF "skipped (git rc): 1"; then
  ok "counter-split pin: the summary line's 'skipped (git rc)' count reflects the git-rc failure"
else
  bad "counter-split pin: summary line did not show 'skipped (git rc): 1' for a single git-rc failure" "$out"
fi
command git -C "$MARVEEN_MAIN_TEST" worktree remove --force "$RCCOUNT_DIR" 2>/dev/null

# --- C1 (card 6c41214a, same flaw/fix as 89e8cb90) -- a git that dies SILENTLY (non-zero rc,
# empty output -- the rc 1/127/137 generic-error/missing-binary/OOM-kill shape) must be treated
# as "found a problem" (SKIP), not as "nothing to report" (clean, proceed to remove). Shim `git`
# to fail exactly the `status` subcommand with the given rc and no output, everything else
# passes through to the real git so the worktree setup around it still works. Exported with
# `export -f` so the function is inherited by the `bash "$RUN"` subprocess below.
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
export -f git

run_c1_case() {
  local rc="$1" label="$2"
  # Trailing digits of the dir name are read as the owning PID (sweep_throwaway_worktrees'
  # live-pid guard, card 7f3e8ac6) -- must be a CONFIRMED-DEAD pid, not $$ (this script, alive),
  # or the live-pid guard skips the entry before the git-status guard under test ever runs.
  local c1_dead_pid
  ( exit 0 ) &
  c1_dead_pid=$!
  wait "$c1_dead_pid" 2>/dev/null
  local dir="/home/neon/marveen-land-c1${label}-${c1_dead_pid}"
  rm -rf "$dir"
  command git -C "$MARVEEN_MAIN_TEST" worktree add -q --detach "$dir" HEAD
  PAST=$(( $(date +%s) - 130 * 60 ))
  touch -d "@$PAST" "$dir"

  GIT_FAIL_CMD=status GIT_FAIL_RC="$rc"
  local out
  out="$(MARVEEN_MAIN="$MARVEEN_MAIN_TEST" CLEANCORE_MAIN="$CLEANCORE_MAIN_TEST" \
         WSL_CLEANUP_MIN_AGE_MIN=120 GIT_FAIL_CMD="$GIT_FAIL_CMD" GIT_FAIL_RC="$GIT_FAIL_RC" \
         bash "$RUN" --dry-run 2>&1)"
  GIT_FAIL_CMD=""; GIT_FAIL_RC=0

  if echo "$out" | grep -qF "SKIP (git rc=$rc): $dir"; then
    ok "C1$label: SKIPs when git status dies silently with rc=$rc"
  else
    bad "C1$label: expected 'SKIP (git rc=$rc)' for a git status that dies silently (rc=$rc)" "$out"
  fi
  if echo "$out" | grep -qF "worktree remove --force $dir"; then
    bad "C1$label: worktree was (dry-run) removed despite git status failing silently (rc=$rc)" "$out"
  else
    ok "C1$label: worktree was not passed to 'git worktree remove' (rc=$rc)"
  fi

  command git -C "$MARVEEN_MAIN_TEST" worktree remove --force "$dir" 2>/dev/null
}

run_c1_case 137 a
run_c1_case 127 b
run_c1_case 1 c

# --- section 3: /tmp sweep (card c9c1f159, Cybered GO 32928 on 6c41214a) --------------------
# Sandboxed via WSL_CLEANUP_TMP_DIR, never touches the real /tmp.
# `export`ed (657f12a3, Cybered GO 33173): the find()/stat() shims below reference $TMP3 from
# inside functions that get re-exercised in the CHILD `bash "$RUN"` process (export -f ships the
# function body as text, but not an unexported variable it reads) -- without this, $TMP3 expands
# empty in the child, the shim's path comparison never matches, and the simulated failure the
# case exists to test is never actually injected (the case then passes on the real, unmutated
# fail-closed behavior alone, not on the shim).
TMP3="$(mktemp -d -p /tmp)"
export TMP3
PAST3=$(( $(date +%s) - 3000 * 60 ))  # 3000m old, well past the 2880m (48h) default threshold

run_tmp_sweep() {
  WSL_CLEANUP_TMP_DIR="$TMP3" MARVEEN_MAIN="$MARVEEN_MAIN_TEST" CLEANCORE_MAIN="$CLEANCORE_MAIN_TEST" \
    bash "$RUN" --dry-run 2>&1
}

# Case 1 (MEDIUM fix itself): an old top-level dir holding a FRESH inner file must NOT be removed.
mkdir -p "$TMP3/old-dir-fresh-inner"
touch "$TMP3/old-dir-fresh-inner/fresh.txt"
touch -d "@$PAST3" "$TMP3/old-dir-fresh-inner"
out="$(run_tmp_sweep)"
if echo "$out" | grep -qF "rm -rf -- $TMP3/old-dir-fresh-inner"; then
  bad "MEDIUM: an old dir with a fresh inner file was (dry-run) removed -- must be skipped" "$out"
else
  ok "MEDIUM: an old dir with a fresh inner file is skipped"
fi
rm -rf "$TMP3/old-dir-fresh-inner"

# Case 2: an old top-level dir whose contents are ALSO all old must still be removed.
mkdir -p "$TMP3/old-dir-old-inner"
touch -d "@$PAST3" "$TMP3/old-dir-old-inner/old.txt" "$TMP3/old-dir-old-inner"
out="$(run_tmp_sweep)"
if echo "$out" | grep -qF "rm -rf -- $TMP3/old-dir-old-inner"; then
  ok "an old dir whose contents are all old is still removed"
else
  bad "an old dir with no fresh inner content was NOT removed, expected it to be" "$out"
fi
rm -rf "$TMP3/old-dir-old-inner"

# Case 3: the inner freshness check itself FAILING (not just finding nothing) must fail closed --
# shim `find` to fail on this one path so the inner check errors, must still skip removal.
mkdir -p "$TMP3/old-dir-inner-find-fails"
touch -d "@$PAST3" "$TMP3/old-dir-inner-find-fails/old.txt" "$TMP3/old-dir-inner-find-fails"
find() {
  if [ "$1" = "$TMP3/old-dir-inner-find-fails" ]; then
    echo "find: simulated failure" >&2
    return 1
  fi
  command find "$@"
}
export -f find
out="$(run_tmp_sweep)"
unset -f find
if echo "$out" | grep -qF "rm -rf -- $TMP3/old-dir-inner-find-fails"; then
  bad "the inner-freshness find failing was (dry-run) removed -- must fail closed" "$out"
else
  ok "the inner-freshness check failing fails closed (not removed)"
fi
rm -rf "$TMP3/old-dir-inner-find-fails"

# Case 3b (Cybered LOW-MEDIUM, card c9c1f159, comment 32973 condition 2): the RC half of
# `[ -n "$out" ] || [ "$rc" -ne 0 ]` is unpinned by Case 3 above, because that shim's own stderr
# text makes $out non-empty, so the "non-zero rc but EMPTY output" (the real rc-137/127 shape a
# killed/missing find produces) branch never actually runs. Shim `find` to fail SILENTLY (no
# stdout, no stderr) so only the rc check can save this case.
mkdir -p "$TMP3/old-dir-inner-find-fails-silent"
touch -d "@$PAST3" "$TMP3/old-dir-inner-find-fails-silent/old.txt" "$TMP3/old-dir-inner-find-fails-silent"
find() {
  if [ "$1" = "$TMP3/old-dir-inner-find-fails-silent" ]; then
    return 137
  fi
  command find "$@"
}
export -f find
out="$(run_tmp_sweep)"
unset -f find
if echo "$out" | grep -qF "rm -rf -- $TMP3/old-dir-inner-find-fails-silent"; then
  bad "the inner-freshness find failing SILENTLY (rc=137, no output) was (dry-run) removed -- the RC half of the fail-closed guard is not enforced" "$out"
else
  ok "the inner-freshness check failing silently (rc-only, no output) still fails closed"
fi
rm -rf "$TMP3/old-dir-inner-find-fails-silent"

# --- section 3 guard pins (each turns red if its guard is removed) --------------------------
# AGE guard: a fresh plain FILE (not a dir) must not be removed. A fresh EMPTY dir would not
# distinguish this guard from the inner-freshness check (find reports the dir's own fresh mtime
# as "fresh content" too, via -print -quit on the start path itself) -- a file has no inner check
# to fall back on (see ISDIR note below), so only the AGE guard protects it.
touch "$TMP3/fresh-file"
out="$(run_tmp_sweep)"
if echo "$out" | grep -qF "rm -rf -- $TMP3/fresh-file"; then
  bad "AGE: a fresh plain file was (dry-run) removed -- age guard not enforced" "$out"
else
  ok "AGE guard: a fresh plain file is not removed"
fi
rm -rf "$TMP3/fresh-file"

# NAME-PATTERN guard: an old .X11-unix-named dir must never be removed, however old.
mkdir -p "$TMP3/.X11-unix"
touch -d "@$PAST3" "$TMP3/.X11-unix"
out="$(run_tmp_sweep)"
if echo "$out" | grep -qF "rm -rf -- $TMP3/.X11-unix"; then
  bad "NAME-PATTERN: an old .X11-unix dir was (dry-run) removed -- name-pattern guard not enforced" "$out"
else
  ok "NAME-PATTERN guard: an old .X11-unix dir is never removed"
fi
rm -rf "$TMP3/.X11-unix"

# NAME-PATTERN guard pin, .font-unix and .ICE-unix individually (Cybered GO 33173, card
# 657f12a3): the case pattern lists three names on one line -- only .X11-unix had its own case
# above, so a mutant dropping either of the other two from the pattern stayed green.
for dotdir in .font-unix .ICE-unix; do
  mkdir -p "$TMP3/$dotdir"
  touch -d "@$PAST3" "$TMP3/$dotdir"
  out="$(run_tmp_sweep)"
  if echo "$out" | grep -qF "rm -rf -- $TMP3/$dotdir"; then
    bad "NAME-PATTERN: an old $dotdir dir was (dry-run) removed -- name-pattern guard not enforced" "$out"
  else
    ok "NAME-PATTERN guard: an old $dotdir dir is never removed"
  fi
  rm -rf "$TMP3/$dotdir"
done

# ISDIR guard (DOCUMENTED, not pinned -- equivalent mutant for a plain file): the `[ -d "$entry" ]`
# check before the inner-freshness call is EQUIVALENT to omitting it, for a regular file that
# already passed the AGE guard above. `find <file> -mmin -X -print -quit` evaluates the SAME
# file the outer `stat` already checked, against the SAME threshold, and an old file can never
# satisfy "-mmin -X" (fresher than X) -- so with or without the isdir short-circuit, an old file
# is removed and a fresh one never reaches this line (the AGE guard already skipped it). Measured
# by hand: removing the `[ -d ... ] &&` left every selftest case (including the new AGE-guard
# fresh-file case above) green. Kept as an explicit, cheap guard anyway -- it prevents `find`'s
# own symlink-following default from ever being asked to decide what a non-directory entry's
# "inside" means -- but this file-based fixture cannot distinguish its presence from its absence,
# so it is not force-pinned with a fixture that would just assert a tautology.
touch -d "@$PAST3" "$TMP3/old-plain-file"
out="$(run_tmp_sweep)"
if echo "$out" | grep -qF "rm -rf -- $TMP3/old-plain-file"; then
  ok "an old plain file is removed (ISDIR guard does not block ordinary files)"
else
  bad "an old plain file was NOT removed, expected it to be" "$out"
fi
rm -rf "$TMP3/old-plain-file"

# STAT guard: an entry that vanishes between enumeration and stat (TOCTOU) must be skipped, not
# treated as infinitely old. Shim `stat` to fail on one specific path.
mkdir -p "$TMP3/vanishing-dir"
touch -d "@$PAST3" "$TMP3/vanishing-dir"
stat() {
  local a
  for a in "$@"; do
    [ "$a" = "$TMP3/vanishing-dir" ] && return 1
  done
  command stat "$@"
}
export -f stat
out="$(run_tmp_sweep)"
unset -f stat
if echo "$out" | grep -qF "rm -rf -- $TMP3/vanishing-dir"; then
  bad "STAT: an entry whose stat call fails was (dry-run) removed -- stat guard not enforced" "$out"
else
  ok "STAT guard: an entry whose stat call fails is skipped, not removed"
fi
rm -rf "$TMP3/vanishing-dir"

# Removed-counter pin, failed rm (Cybered GO 33173, card 657f12a3): "removed" was incremented
# unconditionally even when the actual rm failed, making the summary line claim a cleanup that
# did not happen. Shim `rm` to fail for one specific old, otherwise-removable entry; assert it
# survives, is counted under "skipped (rm failed)", and "removed" stays 0. Direct `source` +
# call (not run_tmp_sweep's --dry-run wrapper) since this needs the REAL run_argv rm call path,
# not the dry-run printf stand-in.
TMP5="$(mktemp -d -p /tmp)"
PAST5=$(( $(date +%s) - 3000 * 60 ))
mkdir -p "$TMP5/rm-fails"
touch -d "@$PAST5" "$TMP5/rm-fails"
RMFAIL_OUT="$(mktemp)"
(
  rm() {
    local a
    for a in "$@"; do
      [ "$a" = "$TMP5/rm-fails" ] && return 1
    done
    command rm "$@"
  }
  WSL_CLEANUP_TMP_DIR="$TMP5"
  export WSL_CLEANUP_TMP_DIR
  # shellcheck source=./wsl-cleanup.sh
  source "$RUN"
  sweep_tmp
) >"$RMFAIL_OUT" 2>&1
if [ -e "$TMP5/rm-fails" ]; then
  ok "removed counter: an entry whose rm fails is still present afterward"
else
  bad "removed counter: an entry whose rm fails was actually removed -- shim did not intercept" "$(cat "$RMFAIL_OUT")"
fi
if grep -qF "skipped (rm failed): 1" "$RMFAIL_OUT"; then
  ok "removed counter: a failed rm is counted under 'skipped (rm failed)', not folded into 'removed'"
else
  bad "removed counter: 'skipped (rm failed): 1' not found in summary for a failed rm" "$(cat "$RMFAIL_OUT")"
fi
if grep -qF "removed 0" "$RMFAIL_OUT"; then
  ok "removed counter: 'removed' count stays 0 when the only candidate's rm failed"
else
  bad "removed counter: 'removed' count was not 0 despite the only candidate's rm failing" "$(cat "$RMFAIL_OUT")"
fi
rm -rf "$TMP5" "$RMFAIL_OUT" 2>/dev/null

# LOG-LINE FORGERY pin, failed-rm message (card e2425f05, Cybered GO 33287 on 657f12a3): `say`
# is plain `echo "wsl-cleanup: $*"` -- a newline embedded in an attacker-reachable /tmp entry name
# would print as a literal line break, letting a crafted name forge what looks like a second,
# unrelated log line. The fix formats the name with `%q` before logging it. Same rm-shim pattern
# as the counter pin above, but the failing entry's name itself contains a newline.
TMP6="$(mktemp -d -p /tmp)"
PAST6=$(( $(date +%s) - 3000 * 60 ))
NEWLINE_RM_NAME="rm-fails-"$'\n'"FORGED-LINE"
mkdir -p -- "$TMP6/$NEWLINE_RM_NAME"
touch -d "@$PAST6" "$TMP6/$NEWLINE_RM_NAME"
RMFAIL_NL_OUT="$(mktemp)"
(
  rm() {
    local a
    for a in "$@"; do
      case "$a" in
        "$TMP6"/*) return 1 ;;
      esac
    done
    command rm "$@"
  }
  WSL_CLEANUP_TMP_DIR="$TMP6"
  export WSL_CLEANUP_TMP_DIR
  # shellcheck source=./wsl-cleanup.sh
  source "$RUN"
  sweep_tmp
) >"$RMFAIL_NL_OUT" 2>&1
# Without %q, echo prints the entry's literal embedded newline as a REAL line break, so
# "FORGED-LINE" lands on its own physical line with no "rm failed for" prefix on that same line
# (the prefix stays on the PRECEDING line) -- two lines total, one of them unprefixed. With %q,
# the newline is escaped into a printable sequence, so the whole name -- including "FORGED-LINE"
# -- stays on the SAME single, prefixed line as "rm failed for". Checking line count alone (as an
# earlier version of this test did) does not discriminate: grep -c "rm failed for" is 1 either
# way, since only the first physical line ever contains that substring. The real signal is
# whether "FORGED-LINE" ever appears on a line that does NOT also carry the "rm failed for" lead-in.
FORGED_LINE_COUNT="$(grep -cF 'FORGED-LINE' "$RMFAIL_NL_OUT")"
FORGED_LINE_WITH_PREFIX_COUNT="$(grep -F 'FORGED-LINE' "$RMFAIL_NL_OUT" | grep -cF 'rm failed for')"
if [ "$FORGED_LINE_COUNT" = "1" ] && [ "$FORGED_LINE_WITH_PREFIX_COUNT" = "1" ]; then
  ok "LOG-LINE FORGERY: the newline-containing name's rm-failed message stays one prefixed line, no split-off standalone line"
else
  bad "LOG-LINE FORGERY: 'FORGED-LINE' appeared $FORGED_LINE_COUNT time(s), $FORGED_LINE_WITH_PREFIX_COUNT with the 'rm failed for' prefix on the same line (want 1/1)" "$(cat "$RMFAIL_NL_OUT")"
fi
rm -rf "$TMP6" "$RMFAIL_NL_OUT" 2>/dev/null

rm -rf "$TMP3"

# --- SECURITY (Cybered NO-GO, card c9c1f159, comment 32973): run()'s eval let a quote-injection
# /tmp entry name run an injected command, and a newline inside a name split one entry into a
# second, bogus RELATIVE-path entry that reached rm -rf. Fixed by run_argv() (no eval, "$@"
# straight to exec) plus NUL-delimited iteration (-print0 / read -r -d ''). These assertions are
# REAL (DRY_RUN=0), not dry-run, since the whole point is proving nothing gets executed/escaped --
# `source`ing wsl-cleanup.sh (instead of `bash "$RUN"`) reaches sweep_tmp() directly without ever
# running sections 1/2/4 (no package-cache purge, no sudo section touches the real machine).
TMP4="$(mktemp -d -p /tmp)"
PAST4=$(( $(date +%s) - 3000 * 60 ))

# Case A: quote-injection name. The exact shape Cybered measured: a name that, once eval'd inside
# a single-quoted `rm -rf '...'` string, closes the quote early and chains an injected command.
QUOTE_NAME="x';touch PWNED;echo '"
mkdir -p -- "$TMP4/$QUOTE_NAME"
touch -d "@$PAST4" "$TMP4/$QUOTE_NAME/old.txt" "$TMP4/$QUOTE_NAME"
PWNED_CWD="$(mktemp -d -p /tmp)"
rm -f "$PWNED_CWD/PWNED" "$TMP4/PWNED" 2>/dev/null

(
  cd "$PWNED_CWD" || exit 1
  WSL_CLEANUP_TMP_DIR="$TMP4"
  export WSL_CLEANUP_TMP_DIR
  # shellcheck source=./wsl-cleanup.sh
  source "$RUN"
  sweep_tmp
) >/dev/null 2>&1

if [ -e "$PWNED_CWD/PWNED" ] || [ -e "$TMP4/PWNED" ]; then
  bad "SECURITY: quote-injection name executed an injected command (PWNED file created)" "checked $PWNED_CWD/PWNED and $TMP4/PWNED"
else
  ok "SECURITY: quote-injection name does not inject a command (no PWNED file anywhere)"
fi
if [ -e "$TMP4/$QUOTE_NAME" ]; then
  bad "SECURITY: quote-injection-named entry was NOT actually removed (real run, DRY_RUN=0)" ""
else
  ok "SECURITY: quote-injection-named entry is still correctly removed for real"
fi
rm -rf "$PWNED_CWD" "$TMP4/$QUOTE_NAME" 2>/dev/null

# Case B: a name containing an embedded newline. Under newline-delimited iteration, `find`'s own
# line-based output and the name's internal newline are indistinguishable, so the single entry
# splits into two reads -- the second one a bogus fragment resolved RELATIVE to the script's cwd.
# Proof: a decoy file with that exact fragment's name, aged old, sitting in the cwd the sweep
# runs from -- the fixed (NUL-delimited) code must never look at it.
NEWLINE_NAME=$'crafted\nbogus'
mkdir -p -- "$TMP4/$NEWLINE_NAME"
touch -d "@$PAST4" "$TMP4/$NEWLINE_NAME"
DECOY_CWD="$(mktemp -d -p /tmp)"
touch -d "@$PAST4" "$DECOY_CWD/bogus"

(
  cd "$DECOY_CWD" || exit 1
  WSL_CLEANUP_TMP_DIR="$TMP4"
  export WSL_CLEANUP_TMP_DIR
  # shellcheck source=./wsl-cleanup.sh
  source "$RUN"
  sweep_tmp
) >/dev/null 2>&1

if [ -e "$DECOY_CWD/bogus" ]; then
  ok "SECURITY: newline-name split fragment never touches a same-named file in the script's cwd"
else
  bad "SECURITY: a decoy file named after the newline-split fragment was removed from the cwd" ""
fi
if [ -e "$TMP4/$NEWLINE_NAME" ]; then
  bad "SECURITY: the newline-named entry itself was NOT removed (real run, DRY_RUN=0)" ""
else
  ok "SECURITY: the newline-named entry (as ONE atomic name) is still correctly removed"
fi
rm -rf "$DECOY_CWD" "$TMP4/$NEWLINE_NAME" 2>/dev/null

# SANITY guard pin (Cybered LOW, card c9c1f159, comment 32973 condition 4): WSL_CLEANUP_TMP_DIR
# pointed OUTSIDE /tmp must refuse, not sweep. A disposable dir under $HOME holding an old,
# otherwise-removable entry must survive because the sweep refuses to run at all.
NOT_TMP_DIR="$HOME/wsl-cleanup-selftest-nottmp-$$"
rm -rf "$NOT_TMP_DIR"
mkdir -p "$NOT_TMP_DIR/old-entry"
touch -d "@$PAST4" "$NOT_TMP_DIR/old-entry"
SANITY_OUT="$(mktemp)"
(
  WSL_CLEANUP_TMP_DIR="$NOT_TMP_DIR"
  export WSL_CLEANUP_TMP_DIR
  # shellcheck source=./wsl-cleanup.sh
  source "$RUN"
  sweep_tmp
) >"$SANITY_OUT" 2>&1
if grep -qF "REFUSING /tmp sweep" "$SANITY_OUT"; then
  ok "SANITY guard: WSL_CLEANUP_TMP_DIR outside /tmp is refused with a clear message"
else
  bad "SANITY guard: WSL_CLEANUP_TMP_DIR outside /tmp was NOT refused" "$(cat "$SANITY_OUT")"
fi
if [ -e "$NOT_TMP_DIR/old-entry" ]; then
  ok "SANITY guard: the entry under the outside-/tmp dir survives (sweep refused, nothing touched)"
else
  bad "SANITY guard: an entry outside /tmp was removed despite the sanity guard" ""
fi
rm -rf "$NOT_TMP_DIR" "$SANITY_OUT" 2>/dev/null

# SANITY guard pin, traversal escape (Cybered GO 33173, card 657f12a3): the OLD check was purely
# LEXICAL ("$WSL_CLEANUP_TMP_DIR" matched against /tmp/* as a string) -- a value that textually
# starts with "/tmp/" but contains enough ".." segments to resolve OUTSIDE /tmp entirely passed
# the guard, even though the directory it actually sweeps is not under /tmp at all. Build exactly
# that shape: a real dir under /tmp, plus the RELATIVE path from it to a real dir under $HOME
# (which is necessarily "../.../<home>/..." -- that relative path IS the traversal string), then
# point WSL_CLEANUP_TMP_DIR at the concatenation so it reads as "/tmp/<sub>/../.../<home-dir>".
TRAVERSAL_OUTER="$HOME/wsl-cleanup-selftest-traversal-$$"
rm -rf "$TRAVERSAL_OUTER"
mkdir -p "$TRAVERSAL_OUTER"
touch -d "@$PAST4" "$TRAVERSAL_OUTER"
# VACUOUS-PIN FIX (card e2425f05, Cybered GO 33287 on 657f12a3): $TRAVERSAL_OUTER itself is the
# resolved SWEEP ROOT (realpath of the traversal path lands exactly on it), never an rm -rf
# candidate itself (the sweep only enumerates mindepth 1 -maxdepth 1 ENTRIES under its root, it
# never removes the root). Checking "$TRAVERSAL_OUTER" survives is therefore vacuous -- it would
# survive even with the guard fully disabled. Put a real, old entry INSIDE it and assert on that.
TRAVERSAL_ENTRY="$TRAVERSAL_OUTER/old-entry"
mkdir -p "$TRAVERSAL_ENTRY"
touch -d "@$PAST4" "$TRAVERSAL_ENTRY"
TRAVERSAL_SUB="$(mktemp -d -p /tmp)"
TRAVERSAL_REL="$(realpath --relative-to="$TRAVERSAL_SUB" "$TRAVERSAL_OUTER")"
TRAVERSAL_PATH="$TRAVERSAL_SUB/$TRAVERSAL_REL"
case "$TRAVERSAL_PATH" in
  /tmp/*) ;;
  *) bad "traversal fixture setup: constructed path '$TRAVERSAL_PATH' does not even start with /tmp/ -- fixture is wrong, not the guard" "" ;;
esac
TRAVERSAL_OUT="$(mktemp)"
(
  WSL_CLEANUP_TMP_DIR="$TRAVERSAL_PATH"
  export WSL_CLEANUP_TMP_DIR
  # shellcheck source=./wsl-cleanup.sh
  source "$RUN"
  sweep_tmp
) >"$TRAVERSAL_OUT" 2>&1
if grep -qF "REFUSING /tmp sweep" "$TRAVERSAL_OUT"; then
  ok "SANITY guard (traversal): a /tmp/-prefixed path that resolves outside /tmp is refused"
else
  bad "SANITY guard (traversal): a /tmp/-prefixed path resolving outside /tmp was NOT refused" "$(cat "$TRAVERSAL_OUT")"
fi
if [ -e "$TRAVERSAL_ENTRY" ]; then
  ok "SANITY guard (traversal): the real outside entry the traversal would have swept survives"
else
  bad "SANITY guard (traversal): the real outside entry was removed despite the sanity guard" ""
fi
rm -rf "$TRAVERSAL_SUB" "$TRAVERSAL_OUTER" "$TRAVERSAL_OUT" 2>/dev/null

# SANITY guard pin, prefix loosening (Cybered GO 33173, card 657f12a3): "/tmpfoo" shares the
# literal "/tmp" prefix but is a sibling, not a subdirectory -- must still be refused. Previously
# unpinned (no case asserted it), even though the existing case pattern already rejected it.
LOOSE_OUT="$(mktemp)"
(
  WSL_CLEANUP_TMP_DIR="/tmpfoo"
  export WSL_CLEANUP_TMP_DIR
  # shellcheck source=./wsl-cleanup.sh
  source "$RUN"
  sweep_tmp
) >"$LOOSE_OUT" 2>&1
if grep -qF "REFUSING /tmp sweep" "$LOOSE_OUT"; then
  ok "SANITY guard (prefix): '/tmpfoo' (shares the /tmp prefix, not a subdir) is refused"
else
  bad "SANITY guard (prefix): '/tmpfoo' was NOT refused" "$(cat "$LOOSE_OUT")"
fi
rm -rf "$LOOSE_OUT" 2>/dev/null

# SANITY guard pin, bare /tmp (card e2425f05, Cybered GO 33287 on 657f12a3): the exact literal
# "/tmp" (no trailing slash, no subpath) must be ACCEPTED -- it is the real-world default and the
# case pattern's own "/tmp" branch, but it had no dedicated case asserting it is not refused.
BARE_OUT="$(mktemp)"
(
  WSL_CLEANUP_TMP_DIR="/tmp"
  export WSL_CLEANUP_TMP_DIR
  # shellcheck source=./wsl-cleanup.sh
  source "$RUN"
  sweep_tmp
) >"$BARE_OUT" 2>&1
if grep -qF "REFUSING /tmp sweep" "$BARE_OUT"; then
  bad "SANITY guard (bare /tmp): the literal '/tmp' was refused" "$(cat "$BARE_OUT")"
else
  ok "SANITY guard (bare /tmp): the literal '/tmp' is accepted, not refused"
fi
rm -rf "$BARE_OUT" 2>/dev/null

# SANITY guard pin, sweep uses the RESOLVED path (card e2425f05, Cybered GO 33287 on 657f12a3):
# `WSL_CLEANUP_TMP_DIR="$resolved"` reassigns the variable AFTER the guard so the find/rm loop
# below enumerates the resolved path, not the raw string -- unpinned until now. Point the raw
# value at a NON-canonical form (a real /tmp subdir plus a trailing "/.") that resolves to the
# same directory, and confirm an old entry placed directly in the real (resolved) directory is
# still swept -- if the loop used the raw string as-is, `find "<dir>/."` still lists the same
# entries on Linux, so this alone would not discriminate; the real risk this pins is a raw value
# that STRINGS differently from its resolution (here: trailing "/."), proving the loop runs
# against $resolved and not a stale/unresolved copy of the original variable.
RESOLVED_SWEEP_DIR="$(mktemp -d -p /tmp)"
RESOLVED_ENTRY="$RESOLVED_SWEEP_DIR/old-entry"
mkdir -p "$RESOLVED_ENTRY"
touch -d "@$PAST4" "$RESOLVED_ENTRY"
RESOLVED_OUT="$(mktemp)"
(
  WSL_CLEANUP_TMP_DIR="$RESOLVED_SWEEP_DIR/."
  export WSL_CLEANUP_TMP_DIR
  # shellcheck source=./wsl-cleanup.sh
  source "$RUN"
  sweep_tmp
) >"$RESOLVED_OUT" 2>&1
if [ -e "$RESOLVED_ENTRY" ]; then
  bad "SANITY guard (resolved-path sweep): an old entry under the resolved dir was NOT swept via a '/.'-suffixed raw value" "$(cat "$RESOLVED_OUT")"
else
  ok "SANITY guard (resolved-path sweep): an old entry under the resolved dir is swept via a '/.'-suffixed raw value"
fi
rm -rf "$RESOLVED_SWEEP_DIR" "$RESOLVED_OUT" 2>/dev/null

# FAIL-CLOSED ON REALPATH FAILURE (card e2425f05, Cybered GO 33287 on 657f12a3): a realpath
# failure (rc 1/127/137/139 -- missing binary, killed, OOM) used to fall back to the RAW,
# unresolved value, which is exactly the lexical string the sanity guard exists to stop trusting.
# Shim `realpath` to fail with each of the measured exit codes and confirm the sweep REFUSES
# rather than falling through to the raw (here: traversal-shaped) value.
for REALPATH_RC in 1 127 137 139; do
  REALPATH_FAIL_OUTER="$HOME/wsl-cleanup-selftest-realpath-fail-$$-$REALPATH_RC"
  rm -rf "$REALPATH_FAIL_OUTER"
  mkdir -p "$REALPATH_FAIL_OUTER"
  REALPATH_FAIL_ENTRY="$REALPATH_FAIL_OUTER/old-entry"
  mkdir -p "$REALPATH_FAIL_ENTRY"
  touch -d "@$PAST4" "$REALPATH_FAIL_ENTRY"
  REALPATH_FAIL_SUB="$(mktemp -d -p /tmp)"
  REALPATH_FAIL_REL="$(realpath --relative-to="$REALPATH_FAIL_SUB" "$REALPATH_FAIL_OUTER")"
  REALPATH_FAIL_PATH="$REALPATH_FAIL_SUB/$REALPATH_FAIL_REL"
  REALPATH_FAIL_OUT="$(mktemp)"
  (
    realpath() { return "$REALPATH_RC"; }
    WSL_CLEANUP_TMP_DIR="$REALPATH_FAIL_PATH"
    export WSL_CLEANUP_TMP_DIR
    # shellcheck source=./wsl-cleanup.sh
    source "$RUN"
    sweep_tmp
  ) >"$REALPATH_FAIL_OUT" 2>&1
  if grep -qF "REFUSING /tmp sweep" "$REALPATH_FAIL_OUT" && [ -e "$REALPATH_FAIL_ENTRY" ]; then
    ok "FAIL-CLOSED: realpath failing with rc=$REALPATH_RC refuses the sweep, real entry survives"
  else
    bad "FAIL-CLOSED: realpath failing with rc=$REALPATH_RC did NOT refuse the sweep / entry did not survive" "$(cat "$REALPATH_FAIL_OUT")"
  fi
  rm -rf "$REALPATH_FAIL_SUB" "$REALPATH_FAIL_OUTER" "$REALPATH_FAIL_OUT" 2>/dev/null
done

rm -rf "$TMP4"

echo
echo "wsl-cleanup.selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

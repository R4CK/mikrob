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
if echo "$OUT" | grep -qF "worktree remove --force '$LIVE_DIR'"; then
  bad "live-pid worktree was (dry-run) removed -- must never happen" "$OUT"
else
  ok "live-pid worktree was not passed to 'git worktree remove'"
fi

# --- Case 2: same shape but the owning PID is DEAD -- must still be removed ------------------
if echo "$OUT" | grep -qF "worktree remove --force '$DEAD_DIR'"; then
  ok "dead-pid worktree is still removed (dry-run)"
else
  bad "dead-pid worktree was NOT removed, expected it to be" "$OUT"
fi
if echo "$OUT" | grep -qF "SKIP (owning pid $DEAD_PID still alive): $DEAD_DIR"; then
  bad "dead-pid worktree was incorrectly reported as having a live owning pid" "$OUT"
else
  ok "dead-pid worktree was not skipped for a live-pid reason"
fi

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
  if echo "$out" | grep -qF "worktree remove --force '$dir'"; then
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
TMP3="$(mktemp -d)"
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
if echo "$out" | grep -qF "rm -rf '$TMP3/old-dir-fresh-inner'"; then
  bad "MEDIUM: an old dir with a fresh inner file was (dry-run) removed -- must be skipped" "$out"
else
  ok "MEDIUM: an old dir with a fresh inner file is skipped"
fi
rm -rf "$TMP3/old-dir-fresh-inner"

# Case 2: an old top-level dir whose contents are ALSO all old must still be removed.
mkdir -p "$TMP3/old-dir-old-inner"
touch -d "@$PAST3" "$TMP3/old-dir-old-inner/old.txt" "$TMP3/old-dir-old-inner"
out="$(run_tmp_sweep)"
if echo "$out" | grep -qF "rm -rf '$TMP3/old-dir-old-inner'"; then
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
if echo "$out" | grep -qF "rm -rf '$TMP3/old-dir-inner-find-fails'"; then
  bad "the inner-freshness find failing was (dry-run) removed -- must fail closed" "$out"
else
  ok "the inner-freshness check failing fails closed (not removed)"
fi
rm -rf "$TMP3/old-dir-inner-find-fails"

# --- section 3 guard pins (each turns red if its guard is removed) --------------------------
# AGE guard: a fresh plain FILE (not a dir) must not be removed. A fresh EMPTY dir would not
# distinguish this guard from the inner-freshness check (find reports the dir's own fresh mtime
# as "fresh content" too, via -print -quit on the start path itself) -- a file has no inner check
# to fall back on (see ISDIR note below), so only the AGE guard protects it.
touch "$TMP3/fresh-file"
out="$(run_tmp_sweep)"
if echo "$out" | grep -qF "rm -rf '$TMP3/fresh-file'"; then
  bad "AGE: a fresh plain file was (dry-run) removed -- age guard not enforced" "$out"
else
  ok "AGE guard: a fresh plain file is not removed"
fi
rm -rf "$TMP3/fresh-file"

# NAME-PATTERN guard: an old .X11-unix-named dir must never be removed, however old.
mkdir -p "$TMP3/.X11-unix"
touch -d "@$PAST3" "$TMP3/.X11-unix"
out="$(run_tmp_sweep)"
if echo "$out" | grep -qF "rm -rf '$TMP3/.X11-unix'"; then
  bad "NAME-PATTERN: an old .X11-unix dir was (dry-run) removed -- name-pattern guard not enforced" "$out"
else
  ok "NAME-PATTERN guard: an old .X11-unix dir is never removed"
fi
rm -rf "$TMP3/.X11-unix"

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
if echo "$out" | grep -qF "rm -rf '$TMP3/old-plain-file'"; then
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
if echo "$out" | grep -qF "rm -rf '$TMP3/vanishing-dir'"; then
  bad "STAT: an entry whose stat call fails was (dry-run) removed -- stat guard not enforced" "$out"
else
  ok "STAT guard: an entry whose stat call fails is skipped, not removed"
fi
rm -rf "$TMP3/vanishing-dir"

rm -rf "$TMP3"

echo
echo "wsl-cleanup.selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

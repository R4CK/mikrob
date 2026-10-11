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
HAS_ACTIVE_CHILD=(); WORKTREE_OWNER=()
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

# --- remove_entry(): plain non-git dir -> rm -rf -----------------------------------------------
mkdir -p "$FAKE_HOME/plain-disposable-dir"
remove_entry "$FAKE_HOME/plain-disposable-dir" >/dev/null 2>&1
[ ! -d "$FAKE_HOME/plain-disposable-dir" ] \
  && ok "remove_entry rm -rf's a plain non-git disposable dir" \
  || bad "plain non-git dir was not removed"

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

echo "selftest: $passed passed, $fail failed"
[ "$fail" = 0 ] || exit 1

#!/usr/bin/env bash
# test-tmp-sweep.sh -- hourly, prefix-filtered /tmp cleanup for leaked test scratch dirs (card
# a4a6a5e5).
#
# INCIDENT 2026-10-11 ~21:25: /tmp (12G tmpfs) hit 100%, every agent's Bash call failed with
# ENOSPC; a backend3 fleet-test run alone had 282 test files fail on "mktemp: No space left".
# Measured (du --max-depth=1 /tmp): 247684 entries total. Biggest offenders: voice-broken-/
# voice-scope-/voice-empty- (3x140 dirs, ~12MB each, 5.2G -- a REAL `python3 -m venv` per test,
# card a4a6a5e5's companion fix in install-voice-venv-gate.test.ts stops the growth, this script
# clears what already exists and anything that slips through next time), 142362
# marveen-test-llm-state-* (card 4c5c540c's per-worker state dir, DELIBERATELY not cleaned on
# process exit -- see that file's own comment -- so it needs an age-based outside sweep instead
# of an in-process one), 9921 shared-mem-inject-*, 9872 shared-mem-fixture-*, and dozens more
# (prov-*, kartya-*, gate-sha-*, tailscale-step-*, ...).
#
# WHY "KNOWN PREFIX", NOT A BLANKET /tmp SWEEP. wsl-cleanup.sh already has a broad-brush /tmp step
# (any entry older than 48h) -- that is a human-gated, infrequent sweep (store/wsl-cleanup.sh
# header, Peti-approval convention for the destructive --apply path per root CLAUDE.md rule 22).
# This script is meant to run HOURLY, unattended, so it is narrower on purpose: it only ever
# removes an entry whose name starts with a prefix this repo's OWN test source actually declares
# via mkdtempSync(join(tmpdir(), 'PREFIX-')) -- never a hand-typed guess, which would either miss
# new leaks or (worse) go stale and start matching something unrelated. The prefix list is
# DERIVED from source each run (see extract_known_prefixes below), so a new test file that leaks
# is covered automatically, and a path this repo never declared is never a candidate no matter
# how old it is.
#
# WHY AGE, NOT JUST PREFIX. A prefix match alone would delete a dir an ACTIVE test is still
# writing into. mtime is the signal: a running test keeps touching its own directory (or the
# files inside it, which bumps the directory's own mtime via create/rename), so its age stays
# under MIN_AGE_MIN for the whole run. $FLEET_TEST_LOCK_WAIT (fleet-test.sh) caps a single run at
# 900s = 15 minutes; MIN_AGE_MIN defaults well past that.
#
# Usage: test-tmp-sweep.sh [--dry-run]
# Env (test hooks, used by test-tmp-sweep.selftest.sh): TEST_TMP_SWEEP_MIN_AGE_MIN,
# TEST_TMP_SWEEP_SRC (fake test-source tree), TEST_TMP_SWEEP_TARGET_DIR (fake sweep target,
# instead of the real /tmp).
set -uo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

MIN_AGE_MIN="${TEST_TMP_SWEEP_MIN_AGE_MIN:-60}"
SRC_ROOT="${TEST_TMP_SWEEP_SRC:-/home/neon/marveen/src}"
TARGET_DIR="${TEST_TMP_SWEEP_TARGET_DIR:-/tmp}"

say() { echo "test-tmp-sweep: $*"; }
run() { if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }

# Pull every literal prefix passed to mkdtempSync(join(tmpdir(), 'PREFIX')) (single or double
# quoted) out of the test source. This is the ONLY source of truth for "known" -- nothing here is
# hand-maintained, so the list can never drift behind what the suite actually creates.
extract_known_prefixes() {
  [ -d "$SRC_ROOT" ] || return 0
  grep -rhoE "mkdtempSync\([[:space:]]*join\([^,]+,[[:space:]]*['\"][^'\"]+['\"]" "$SRC_ROOT" 2>/dev/null \
    | grep -oE "['\"][^'\"]+['\"]$" \
    | tr -d "'\"" \
    | sort -u
}

# Build ONE alternation regex from the prefix list, so matching is a single linear `grep -E` pass
# over the candidate names rather than one `find` scan per prefix (357+ prefixes x a /tmp with a
# quarter-million entries is what made the naive per-prefix version time out).
mapfile -t prefixes < <(extract_known_prefixes)
prefix_count=${#prefixes[@]}
if [ "$prefix_count" -eq 0 ]; then
  say "no known prefixes found under $SRC_ROOT -- nothing to do"
  exit 0
fi
escaped=()
for p in "${prefixes[@]}"; do
  escaped+=("^$(printf '%s' "$p" | sed -E 's/[.[\*^$()+?{}|\\]/\\&/g')")
done
prefix_regex="$(printf '%s\n' "${escaped[@]}" | paste -sd'|')"

removed=0
checked=0
# ONE find, newest-mtime-filtered already (so an active run's dir, touched seconds ago, never
# reaches this list), THEN filtered down to known prefixes in one grep pass.
while read -r name; do
  [ -n "$name" ] || continue
  entry="$TARGET_DIR/$name"
  [ -e "$entry" ] || continue
  checked=$((checked + 1))
  say "removing: $entry"
  run "rm -rf '$entry'"
  removed=$((removed + 1))
done < <(find "$TARGET_DIR" -mindepth 1 -maxdepth 1 -mmin "+$MIN_AGE_MIN" -printf '%f\n' 2>/dev/null | grep -E "$prefix_regex")

say "done, $prefix_count known prefix(es), $removed/$checked entrie(s) removed (age > ${MIN_AGE_MIN}m)"

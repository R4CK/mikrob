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
# files inside it), so its age stays under MIN_AGE_MIN for the whole run. $FLEET_TEST_LOCK_WAIT
# (fleet-test.sh) caps a single run at 900s = 15 minutes; MIN_AGE_MIN defaults well past that.
#
# CYBERED NO-GO on 6e71b5f5 (comment 17221, B5) fixed here:
#
# B5 (HIGH, availability + B3 re-check invalidation): has_live_process() iterated all of /proc,
# forking a readlink per fd -- measured at 38s per candidate (280 procs, 11119 fds), 2807
# candidates on the real /tmp = ~30 hours per run, no lock => hourly instances would pile up.
# Also the original is_fresh_inside() ran BEFORE the long live-scan, so a file written during the
# scan (measured L5) could still be deleted. Fixed: (1) one /proc snapshot per sweep run (find
# -printf '%l\n' into a temp file, candidates grep'd via awk); (2) flock -n exits immediately if
# another instance is already running; (3) is_fresh_inside() runs again right before rm.
#
# CYBERSEC NO-GO on 877766dc (comment 17088) + QA2 FAIL (comment 17090), both fixed here:
#
# B1 (HIGH): the removal path was `run() { eval "$@"; }` feeding a single-quoted path built from
# the untrusted /tmp entry NAME -- a name containing a quote broke out of the eval and ran
# arbitrary shell. Fixed: no eval anywhere; removal is a plain `rm -rf -- "$entry"` on a shell
# variable, never a string handed to eval.
# B2 (HIGH): `find -printf '%f\n' | ... | read -r name` split a NAME CONTAINING A NEWLINE into two
# "entries", and the second fragment could coincide with a live, unrelated directory's name,
# deleting it even though it was never actually a sweep candidate. Fixed: NUL-delimited throughout
# (`-printf '%f\0'`, `grep -z`, `read -r -d ''`), so an embedded newline stays inside one record.
# B3 (HIGH/MEDIUM): age was checked on the TOP directory's own mtime only, so a deep write (a file
# several levels inside the scratch dir) never bumped it and an actively-written tree could still
# be swept. Fixed: `is_fresh_inside` re-checks the WHOLE subtree immediately before deletion (any
# file or dir under the entry touched within MIN_AGE_MIN aborts that removal), plus an owner check
# (`owned_by_us`, never touch an entry we do not own) and a live-process check (`has_live_process`,
# skip if any process's cwd or an open fd resolves inside the entry).
# B4 (MEDIUM): the prefix list had no minimum length or shape, so short, generic fragments (run-,
# env-, bcn-, inst- -- all <=5 chars) could collide with unrelated /tmp tooling. Fixed: a prefix
# must be >=6 chars and a candidate name must fully match `^PREFIX[A-Za-z0-9]{6}$` -- Node's own
# mkdtempSync suffix length, measured directly (`node -e "mkdtempSync(...)"`, 5 samples, all
# exactly 6 chars) -- plus an explicit exclude list for known non-repo tooling prefixes.
# QA2 (base-mismatch, comment 17090): extract_known_prefixes() matched ANY first argument to
# join(), not just tmpdir()/os.tmpdir() -- so `mkdtempSync(join(SCRATCH_BASE, 'run-'))` (a
# NON-/tmp base in fleet-test-relative-tree-is-root.test.ts) leaked the generic "run-" prefix into
# the /tmp sweep list, where it could match a totally unrelated systemd/runc-style /tmp artifact
# (reproduced live: "run-notATest-systemd-artifact-12345" was flagged for removal). Fixed: the
# extractor now requires the join() base to be literally `tmpdir()` or `os.tmpdir()` -- the one
# guarantee the header comment already claimed.
#
# Usage: test-tmp-sweep.sh [--dry-run]
# Env (test hooks, used by test-tmp-sweep.selftest.sh): TEST_TMP_SWEEP_MIN_AGE_MIN,
# TEST_TMP_SWEEP_SRC (fake test-source tree), TEST_TMP_SWEEP_TARGET_DIR (fake sweep target,
# instead of the real /tmp).
set -uo pipefail

# B5: flock -n -- a second instance exits immediately rather than piling up behind the first.
LOCK_FILE="${TEST_TMP_SWEEP_LOCKFILE:-/tmp/test-tmp-sweep.lock}"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "test-tmp-sweep: another instance is already running (lock: $LOCK_FILE) -- exiting"
  exit 0
fi

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

MIN_AGE_MIN="${TEST_TMP_SWEEP_MIN_AGE_MIN:-60}"
SRC_ROOT="${TEST_TMP_SWEEP_SRC:-/home/neon/marveen/src}"
TARGET_DIR="${TEST_TMP_SWEEP_TARGET_DIR:-/tmp}"
MIN_PREFIX_LEN=6
# Known non-repo tooling prefixes that could otherwise collide with a short/generic derived
# prefix (B4). Not exhaustive -- defense in depth on top of the length/shape requirement below,
# not the primary control.
EXCLUDE_PREFIXES='^(claude-|tmux-|systemd-|\.X11)'

say() { echo "test-tmp-sweep: $*"; }

# B5: one /proc snapshot per run -- collect all live cwd+fd symlink targets into a temp file
# once, then check candidates with awk (O(snapshot)) instead of re-forking readlink per pid*fd.
LIVE_SNAPSHOT=""
_cleanup_snapshot() { [ -z "$LIVE_SNAPSHOT" ] || rm -f "$LIVE_SNAPSHOT"; }
trap _cleanup_snapshot EXIT

init_live_proc_snapshot() {
  LIVE_SNAPSHOT="$(mktemp)"
  find /proc/[0-9]*/cwd /proc/[0-9]*/fd -printf '%l\n' 2>/dev/null \
    | sort -u > "$LIVE_SNAPSHOT"
}

# Pull every literal prefix passed to mkdtempSync(join(tmpdir(), 'PREFIX')) or
# mkdtempSync(join(os.tmpdir(), 'PREFIX')) (single or double quoted) out of the test source. The
# base MUST be tmpdir()/os.tmpdir() literally (QA2 comment 17090) -- a call whose first join()
# argument is some other variable (a non-/tmp scratch base) is not a /tmp leak and must not
# contribute a prefix to this list, no matter how innocuous the prefix text looks on its own.
extract_known_prefixes() {
  [ -d "$SRC_ROOT" ] || return 0
  grep -rhoE "mkdtempSync\([[:space:]]*join\([[:space:]]*(os\.)?tmpdir\([[:space:]]*\)[[:space:]]*,[[:space:]]*['\"][^'\"]+['\"]" "$SRC_ROOT" 2>/dev/null \
    | grep -oE "['\"][^'\"]+['\"]$" \
    | tr -d "'\"" \
    | awk -v minlen="$MIN_PREFIX_LEN" 'length($0) >= minlen' \
    | grep -vE "$EXCLUDE_PREFIXES" \
    | sort -u
}

# Build ONE alternation regex from the prefix list, so matching is a single linear `grep -E` pass
# over the candidate names rather than one `find` scan per prefix (357+ prefixes x a /tmp with a
# quarter-million entries is what made the naive per-prefix version time out). Each alternative
# requires prefix + exactly the 6-char mkdtemp suffix (measured, see header) -- a bare prefix with
# no suffix, or a different suffix length, is not a real mkdtemp directory and must not match.
mapfile -t prefixes < <(extract_known_prefixes)
prefix_count=${#prefixes[@]}
if [ "$prefix_count" -eq 0 ]; then
  say "no known prefixes found under $SRC_ROOT -- nothing to do"
  exit 0
fi
escaped=()
for p in "${prefixes[@]}"; do
  escaped+=("^$(printf '%s' "$p" | sed -E 's/[.[\*^$()+?{}|\\]/\\&/g')[A-Za-z0-9]{6}\$")
done
prefix_regex="$(printf '%s\n' "${escaped[@]}" | paste -sd'|')"

# B3: any file or directory under $1 (including itself) touched more recently than MIN_AGE_MIN
# protects the WHOLE tree, not just the top directory -- a deep write never bumps the parent's own
# mtime, so checking only the top entry let an actively-written tree slip through.
is_fresh_inside() {
  [ -n "$(find "$1" -mmin "-$MIN_AGE_MIN" -print -quit 2>/dev/null)" ]
}

owned_by_us() {
  [ "$(stat -c %U -- "$1" 2>/dev/null)" = "$(id -un)" ]
}

# B5: snapshot-based live-process check -- O(snapshot) per candidate via awk, not O(pids*fds).
# Best-effort: documented limitation (N1 from comment 17221): a path-based socket held open by a
# process whose cwd is '/' (not inside the entry) is not caught; that is acceptable for this
# sweep's use-case (test scratch dirs, not server sockets).
#
# B6 (MEDIUM, fixed here): the original awk|grep -q pipe under set -o pipefail silently
# fails when a live process holds 25+ distinct fds inside the tree: grep -q exits after the
# first match, awk gets SIGPIPE on the next write, the pipeline exits 141, and the caller
# reads that as "no live process" -- fail-open, the tree is deleted. Fix: awk sets its own
# exit status ({found=1;exit} / END{exit !found}), no pipe, no SIGPIPE.
has_live_process() {
  [ -n "$LIVE_SNAPSHOT" ] && [ -f "$LIVE_SNAPSHOT" ] || return 1
  local target
  target="$(readlink -f -- "$1" 2>/dev/null)" || return 1
  [ -n "$target" ] || return 1
  # match: snapshot line IS $target, OR starts with $target/ (a path inside the tree).
  # No pipe to grep -q: under pipefail, awk SIGPIPE on grep's early exit = 141 = fail-open.
  awk -v t="$target" \
    'index($0,t)==1 && (length($0)==length(t) || substr($0,length(t)+1,1)=="/") {found=1; exit} END{exit !found}' \
    "$LIVE_SNAPSHOT"
}

removed=0
checked=0
skipped_fresh=0
skipped_owner=0
skipped_live=0
# B5: build the /proc snapshot ONCE before the removal loop, so has_live_process() is O(snapshot)
# per candidate rather than O(pids*fds).
init_live_proc_snapshot
# ONE find, NUL-delimited throughout (B2), newest-mtime-filtered already (so an active run's dir,
# touched seconds ago, never reaches this list), THEN filtered down to known prefixes in one grep
# pass. The age/owner/live-process checks below are re-verified per candidate, right before
# removal, since the find-time filter is only a cheap first pass.
while IFS= read -r -d '' name; do
  [ -n "$name" ] || continue
  entry="$TARGET_DIR/$name"
  [ -e "$entry" ] || continue
  checked=$((checked + 1))
  if is_fresh_inside "$entry"; then
    skipped_fresh=$((skipped_fresh + 1))
    continue
  fi
  if ! owned_by_us "$entry"; then
    skipped_owner=$((skipped_owner + 1))
    continue
  fi
  if has_live_process "$entry"; then
    skipped_live=$((skipped_live + 1))
    continue
  fi
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry-run] rm -rf -- %q\n' "$entry"
  else
    # B5/L5: re-check freshness right before rm -- a file written DURING the live-process scan
    # (which now runs once upfront) could have made the tree fresh after the first check above.
    if is_fresh_inside "$entry"; then
      skipped_fresh=$((skipped_fresh + 1))
      continue
    fi
    say "removing: $entry"
    rm -rf -- "$entry"
  fi
  removed=$((removed + 1))
done < <(find "$TARGET_DIR" -mindepth 1 -maxdepth 1 -mmin "+$MIN_AGE_MIN" -printf '%f\0' 2>/dev/null | grep -zE "$prefix_regex")

say "done, $prefix_count known prefix(es), $removed/$checked entrie(s) removed (age > ${MIN_AGE_MIN}m; skipped: $skipped_fresh deep-fresh, $skipped_owner not-ours, $skipped_live live-process)"

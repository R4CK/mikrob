#!/usr/bin/env bash
# watched-repos-record-review.sh -- record a manual watched-repo review close-out
# (card 726dca6b) without hand-editing the moving sha/date fields into the tracked
# store/watched-repos.json.
#
# WHY: a manual review close-out used to write last_sha + last_checked_upstream_sha +
# last_checked_at directly into watched-repos.json alongside the note -- a tracked-file
# edit on every single review, which left the shared main clone permanently dirty and
# blocked its fast-forward (exactly the class of bug card 197947ae already fixed for the
# automated daily sync, but not for this manual path). This script writes the moving
# fields into the gitignored store/watched-repos-state.json instead; only the note
# (an append-only, git-blameable due-diligence log, kept tracked on purpose) touches the
# registry file.
#
# This script does NOT commit or land anything. Per the fleet's worktree discipline, run
# it inside your OWN marveen worktree, commit the resulting note-only registry diff
# there, and land via store/marveen-land.sh -- never against the shared main clone
# directly.
#
# Usage:
#   store/watched-repos-record-review.sh <name> \
#     --sha <new-last-sha> [--upstream-sha <full-sha>] \
#     [--note-append "<dated review sentence>"] \
#     [--registry <path>] [--state <path>]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="$HERE/watched-repos.json"
STATE="${WATCHED_REPOS_STATE_JSON:-$HERE/watched-repos-state.json}"

name="${1:-}"; shift || true
[[ -n "$name" ]] || { echo "usage: $0 <name> --sha <sha> [--upstream-sha <sha>] [--note-append <text>] [--registry <path>] [--state <path>]" >&2; exit 1; }

sha=""; upstream_sha=""; note_append=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha) sha="$2"; shift 2 ;;
    --upstream-sha) upstream_sha="$2"; shift 2 ;;
    --note-append) note_append="$2"; shift 2 ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --state) STATE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[[ -n "$sha" ]] || { echo "--sha is required" >&2; exit 1; }
# Card ffca678d (RedHat LOW): this is the manual-review write path into watched-repos-state.json,
# the SAME file src/web/routes/integrated-repos.ts reads last_sha from and hands to git argv
# (vendoredDate / rev-list / log range) -- an unvalidated --sha here is the injection's actual
# origin. Fail loudly (not silently): a human/CLI caller should see the rejection immediately,
# not have it swallowed three hops downstream.
HEX_SHA_RE='^[0-9a-f]{7,40}$'
[[ "$sha" =~ $HEX_SHA_RE ]] || { echo "invalid --sha '$sha': must match $HEX_SHA_RE" >&2; exit 1; }
[[ -z "$upstream_sha" || "$upstream_sha" =~ $HEX_SHA_RE ]] || { echo "invalid --upstream-sha '$upstream_sha': must match $HEX_SHA_RE" >&2; exit 1; }

# Card 9710bdfd (WhiteHat2 follow-up to eedb2871 L2): this used to read-modify-write
# $STATE with no lock and no atomic rename, and silently reset a corrupt state file to {}
# instead of refusing -- the exact bug class eedb2871 already fixed for
# git-repo-watcher.sh/pipx-version-check.sh's shared writer, and card 9710bdfd just fixed for
# external-repos-sync.sh's write_back. Same fix here: this script shares the SAME state file
# and lock file as those two, a tempfile + os.replace atomic write, and FAIL CLOSED on a state
# file that fails to parse as JSON.
#
# Card 9710bdfd GO follow-up L1 (CYBERED comment 19618): this state write used to run SECOND,
# after the registry note-append already landed -- a corrupt state file (or any other failure
# in this step) aborted the script, but the note was already written. Retrying after fixing the
# state file re-ran the WHOLE script and appended the same note a second time. Fixed by running
# the state write FIRST (including a read-only check here that the registry entry exists at
# all, since that used to be the registry step's job) -- any failure in this step, including a
# bad name, now aborts before the registry note is ever touched.
set +e
state_out="$( (
  flock -x -w 10 200 || { echo "lock timeout waiting for $STATE.lock"; exit 1; }
  python3 - "$STATE" "$name" "$sha" "$upstream_sha" "$REGISTRY" <<'PY'
import json, os, sys, time
from datetime import date

state_path, name, sha, upstream_sha, registry_path = sys.argv[1:6]

with open(registry_path, encoding="utf-8") as f:
    registry = json.load(f)
if not any(e.get("name") == name for e in registry):
    sys.exit(f"no registry entry named {name!r} in {registry_path}")

if os.path.exists(state_path):
    with open(state_path, encoding="utf-8") as f:
        raw = f.read()
    if raw.strip():
        try:
            state = json.loads(raw)
        except json.JSONDecodeError as e:
            print("corrupt state file, refusing to overwrite: " + str(e))
            sys.exit(1)
    else:
        state = {}
else:
    state = {}

# Test-only hook (card 9710bdfd, QA2 FAIL 19491 finding 1): see the matching comment in
# external-repos-sync.sh's write_back() -- same env var, same reasoning, shared state file.
_sleep_s = os.environ.get("WATCHED_STATE_TEST_SLEEP_S")
if _sleep_s:
    time.sleep(float(_sleep_s))

record = {"last_sha": sha, "last_checked_at": date.today().isoformat()}
if upstream_sha:
    record["last_checked_upstream_sha"] = upstream_sha
state[name] = record

# Card 9710bdfd GO follow-up, file-mode finding (CYBERED comment 19618): os.replace() swaps in
# whatever mode the freshly-created tmp file got from the CALLER'S umask, not the target's prior
# mode -- measured turning a 0600 state file into 0644 under umask 022. Preserve the existing
# mode (default 0600 for a brand-new state file, since it can carry local clone paths) so a
# loose caller umask can no longer loosen it on every single review.
try:
    _mode = os.stat(state_path).st_mode & 0o777
except FileNotFoundError:
    _mode = 0o600

tmp_path = state_path + ".tmp"
with open(tmp_path, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.chmod(tmp_path, _mode)
# Test-only hook (card 9710bdfd GO follow-up R3): pins the atomic swap itself. The sleep runs
# AFTER the fully-written tmp file is ready and BEFORE the rename -- $STATE/$REGISTRY stays
# byte-identical to its pre-write content for the whole delay, no matter how long it is. A
# concurrent lock-free reader (the real-world case: dashboard-settings.ts, integrated-repos.ts)
# must never observe anything but the old-complete or new-complete file.
_pre_replace_sleep_s = os.environ.get("WATCHED_STATE_TEST_PRE_REPLACE_SLEEP_S")
if _pre_replace_sleep_s:
    time.sleep(float(_pre_replace_sleep_s))
os.replace(tmp_path, state_path)
PY
) 200>"$STATE.lock" 2>&1 )"
state_rc=$?
set -e
if [[ $state_rc -ne 0 ]]; then
  echo "$state_out" >&2
  exit "$state_rc"
fi

# WhiteHat (cybersec) F2 LOW on card 9710bdfd (gate comment 19504): this registry write was the
# ONE remaining read-modify-write in this script with no lock and no atomic rename -- measured
# losing 8/12 concurrent --note-append calls' notes. Different file (watched-repos.json, the
# TRACKED registry) from the state file above, so a dedicated $REGISTRY.lock, not the shared
# $STATE.lock -- a note-append and a state write never need to exclude each other. Runs SECOND
# (see the L1 comment above the state-write block): the registry entry's existence was already
# confirmed by the state-write step, so a bad name never reaches this far.
set +e
registry_out="$( (
  flock -x -w 10 200 || { echo "lock timeout waiting for $REGISTRY.lock"; exit 1; }
  python3 - "$REGISTRY" "$name" "$note_append" <<'PY'
import json
import os
import sys
import time

registry_path, name, note_append = sys.argv[1:4]

with open(registry_path, encoding="utf-8") as f:
    registry = json.load(f)

entry = next((e for e in registry if e.get("name") == name), None)
if entry is None:
    sys.exit(f"no registry entry named {name!r} in {registry_path}")

if note_append:
    existing = entry.get("note", "")
    entry["note"] = f"{existing} | {note_append}" if existing else note_append
    # Test-only hook (same reasoning as the state-write hooks): forces deterministic overlap for
    # the concurrency regression test instead of relying on OS-scheduling luck.
    _sleep_s = os.environ.get("WATCHED_REGISTRY_TEST_SLEEP_S")
    if _sleep_s:
        time.sleep(float(_sleep_s))
    tmp_path = registry_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(registry, f, indent=2, ensure_ascii=False)
        f.write("\n")
    # Test-only hook (card 9710bdfd GO follow-up R3), same reasoning as the state-write twin above.
    _pre_replace_sleep_s = os.environ.get("WATCHED_REGISTRY_TEST_PRE_REPLACE_SLEEP_S")
    if _pre_replace_sleep_s:
        time.sleep(float(_pre_replace_sleep_s))
    os.replace(tmp_path, registry_path)
PY
) 200>"$REGISTRY.lock" 2>&1 )"
reg_rc=$?
set -e
if [[ $reg_rc -ne 0 ]]; then
  echo "$registry_out" >&2
  exit "$reg_rc"
fi

echo "recorded review for '$name': state -> $STATE$([[ -n "$note_append" ]] && echo ", note appended -> $REGISTRY")"

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

set +e
registry_out="$(python3 - "$REGISTRY" "$name" "$note_append" <<'PY'
import json
import sys

registry_path, name, note_append = sys.argv[1:4]

with open(registry_path, encoding="utf-8") as f:
    registry = json.load(f)

entry = next((e for e in registry if e.get("name") == name), None)
if entry is None:
    sys.exit(f"no registry entry named {name!r} in {registry_path}")

if note_append:
    existing = entry.get("note", "")
    entry["note"] = f"{existing} | {note_append}" if existing else note_append
    with open(registry_path, "w", encoding="utf-8") as f:
        json.dump(registry, f, indent=2, ensure_ascii=False)
        f.write("\n")
PY
)"
reg_rc=$?
set -e
if [[ $reg_rc -ne 0 ]]; then
  echo "$registry_out" >&2
  exit "$reg_rc"
fi

# Card 9710bdfd (WhiteHat2 follow-up to eedb2871 L2): this used to read-modify-write
# $STATE with no lock and no atomic rename, and silently reset a corrupt state file to {}
# instead of refusing -- the exact bug class eedb2871 already fixed for
# git-repo-watcher.sh/pipx-version-check.sh's shared writer, and card 9710bdfd just fixed for
# external-repos-sync.sh's write_back. Same fix here: this script shares the SAME state file
# and lock file as those two, a tempfile + os.replace atomic write, and FAIL CLOSED on a state
# file that fails to parse as JSON.
set +e
state_out="$( (
  flock -x -w 10 200 || { echo "lock timeout waiting for $STATE.lock"; exit 1; }
  python3 - "$STATE" "$name" "$sha" "$upstream_sha" <<'PY'
import json, os, sys
from datetime import date

state_path, name, sha, upstream_sha = sys.argv[1:5]

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

record = {"last_sha": sha, "last_checked_at": date.today().isoformat()}
if upstream_sha:
    record["last_checked_upstream_sha"] = upstream_sha
state[name] = record

tmp_path = state_path + ".tmp"
with open(tmp_path, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp_path, state_path)
PY
) 200>"$STATE.lock" 2>&1 )"
state_rc=$?
set -e
if [[ $state_rc -ne 0 ]]; then
  echo "$state_out" >&2
  exit "$state_rc"
fi

echo "recorded review for '$name': state -> $STATE$([[ -n "$note_append" ]] && echo ", note appended -> $REGISTRY")"

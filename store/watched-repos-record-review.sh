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

python3 - "$REGISTRY" "$STATE" "$name" "$sha" "$upstream_sha" "$note_append" <<'PY'
import json
import sys
from datetime import date

registry_path, state_path, name, sha, upstream_sha, note_append = sys.argv[1:7]

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

try:
    with open(state_path, encoding="utf-8") as f:
        state = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    state = {}

record = {"last_sha": sha, "last_checked_at": date.today().isoformat()}
if upstream_sha:
    record["last_checked_upstream_sha"] = upstream_sha
state[name] = record

with open(state_path, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

echo "recorded review for '$name': state -> $STATE$([[ -n "$note_append" ]] && echo ", note appended -> $REGISTRY")"

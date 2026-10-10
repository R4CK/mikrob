#!/usr/bin/env bash
# skill-archive-restore.sh -- MANUAL, documented reverse copy: store/skill-archive/<name>/ -> a live
# ~/.claude/skills/<name> location (card 59cfcb21, MikroB decision condition 2: restore is never
# automatic, only a deliberate human-invoked step). Use only for disaster recovery -- the live
# global copy was lost, corrupted, or overwritten.
#
# Refuses to run without --yes (no accidental restore from a script someone else calls), and
# refuses to overwrite an existing --to directory unless --force is also given, so a restore can
# never silently clobber a live copy an agent may have hand-patched mid-session (CLAUDE.md,
# "Skill patch (runtime javitas)").
#
# Usage:
#   store/skill-archive-restore.sh <skill-name> --yes [--to <path>] [--force]
set -euo pipefail

SKILL="${1:?usage: skill-archive-restore.sh <skill-name> --yes [--to <path>] [--force]}"
shift || true
TO="$HOME/.claude/skills/$SKILL"
YES=0
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to) TO="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    --force) FORCE=1; shift ;;
    *) echo "skill-archive-restore: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

if [ "$YES" -ne 1 ]; then
  echo "skill-archive-restore: refusing without --yes -- this is a manual, deliberate restore, never an automated one" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/store/skill-archive/$SKILL"

[ -d "$SRC" ] || { echo "skill-archive-restore: no archive copy for $SKILL at $SRC" >&2; exit 1; }
if [ -e "$TO" ] && [ "$FORCE" -ne 1 ]; then
  echo "skill-archive-restore: $TO already exists -- refusing to overwrite without --force (it may hold live, hand-patched content)" >&2
  exit 1
fi

rm -rf "$TO"
cp -r "$SRC" "$TO"
echo "skill-archive-restore: $SKILL restored $SRC -> $TO"

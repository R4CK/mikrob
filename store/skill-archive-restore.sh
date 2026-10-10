#!/usr/bin/env bash
# skill-archive-restore.sh -- MANUAL, documented reverse copy: ~/.claude/skill-archive/<name>/ (a
# SEPARATE, remote-less local git repo outside this checkout -- card 59cfcb21 F1 fix) -> a live
# ~/.claude/skills/<name> location (MikroB decision condition 2: restore is never automatic, only a
# deliberate human-invoked step). Use only for disaster recovery -- the live global copy was lost,
# corrupted, or overwritten.
#
# Refuses to run without --yes (no accidental restore from a script someone else calls), and
# refuses to overwrite an existing --to directory unless --force is also given, so a restore can
# never silently clobber a live copy an agent may have hand-patched mid-session (CLAUDE.md,
# "Skill patch (runtime javitas)").
#
# F2 fix (Cybersec MEDIUM, komment 14381): the skill name and --to path are no longer trusted
# verbatim -- name must match ^[A-Za-z0-9._-]+$, and --to must resolve (realpath) to a path
# physically inside ~/.claude/skills, so an arbitrary --to can never write outside the live skills
# directory.
#
# Usage:
#   store/skill-archive-restore.sh <skill-name> --yes [--to <path>] [--force]
set -euo pipefail

SKILL="${1:?usage: skill-archive-restore.sh <skill-name> --yes [--to <path>] [--force]}"
shift || true

SKILLS_HOME="$HOME/.claude/skills"
TO="$SKILLS_HOME/$SKILL"
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

if ! [[ "$SKILL" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "skill-archive-restore: refusing skill name '$SKILL' -- must match ^[A-Za-z0-9._-]+\$ (no '/', no '..')" >&2
  exit 2
fi

# A dot-prefixed name -- ".git" above all -- would make SRC below resolve to the archive's own
# control directory, copying its internals (incl. the fact that it IS a git repo) into the live,
# publicly-shipped ~/.claude/skills tree (card 59cfcb21 F-LOW, utomunka kartya 0fb92c16, item 1).
if [[ "$SKILL" == .* ]]; then
  echo "skill-archive-restore: refusing dot-prefixed skill name '$SKILL' -- it could collide with the archive's own .git or other hidden entries" >&2
  exit 2
fi

if [ "$YES" -ne 1 ]; then
  echo "skill-archive-restore: refusing without --yes -- this is a manual, deliberate restore, never an automated one" >&2
  exit 2
fi

ARCHIVE_ROOT="$HOME/.claude/skill-archive"
SRC="$ARCHIVE_ROOT/$SKILL"
[ -d "$SRC" ] || { echo "skill-archive-restore: no archive copy for $SKILL at $SRC" >&2; exit 1; }

REAL_SKILLS_HOME="$(mkdir -p "$SKILLS_HOME" && cd "$SKILLS_HOME" && pwd -P)"
TO_PARENT="$(dirname "$TO")"
mkdir -p "$TO_PARENT"
REAL_TO_PARENT="$(cd "$TO_PARENT" && pwd -P)"
REAL_TO="$REAL_TO_PARENT/$(basename "$TO")"
case "$REAL_TO" in
  "$REAL_SKILLS_HOME"/*) ;;
  *)
    echo "skill-archive-restore: refusing --to '$TO' -- it resolves to '$REAL_TO', which is not inside $REAL_SKILLS_HOME" >&2
    exit 2
    ;;
esac

if [ -e "$REAL_TO" ] && [ "$FORCE" -ne 1 ]; then
  echo "skill-archive-restore: $REAL_TO already exists -- refusing to overwrite without --force (it may hold live, hand-patched content)" >&2
  exit 1
fi

rm -rf "$REAL_TO"
cp -r "$SRC" "$REAL_TO"
echo "skill-archive-restore: $SKILL restored $SRC -> $REAL_TO"

#!/usr/bin/env bash
# skill-archive-sync.sh -- one-time, ONE-WAY copy of a global skill with no tracked copy anywhere
# (not in seed-skills/, not in seed-fleet-agents/) into a SEPARATE, remote-less local git repo at
# ~/.claude/skill-archive/<name>/ (card 59cfcb21, F1 fix per MikroB komment 14386).
#
# WHY HERE AND NOT store/skill-archive/: the first version tracked the archive inside THIS repo.
# Cybersec (komment 14381, F1 HIGH) measured that this repo's origin is a PUBLIC GitHub remote, so
# the archive -- including loki-mode-derived, BSL 1.1 content -- shipped to a public fork the
# moment it landed on develop (raw.githubusercontent.com served it, sha256 verified). The legal
# ruling on that content (card c2c98b0d, feltetel 1) requires it to stay an internal, UNPUBLISHED
# fleet tool. A directory OUTSIDE this repo, in a git repo with no `origin` remote, is version
# controlled and auditable (git diff/log) without ever being pushed anywhere -- it can only leave
# this machine by a deliberate, separate act, not by this repo's normal landing flow.
#
# ONE-WAY: this script only ever copies live -> archive. It never writes back to ~/.claude/skills.
# Restoring the other direction is a separate, manual, documented step: skill-archive-restore.sh.
#
# F2 fix (Cybersec MEDIUM, komment 14381): the skill name and --from path are no longer trusted
# verbatim. The name must match ^[A-Za-z0-9._-]+$ (no "/", no ".."), so it can never point the
# destination outside the archive root. --from must resolve (realpath) to a path physically inside
# ~/.claude/skills -- an arbitrary --from (e.g. a whole HOME directory, to smuggle credentials in)
# is refused before any copy happens.
#
# Usage:
#   store/skill-archive-sync.sh <skill-name> [--from <path>]   # default --from ~/.claude/skills/<name>
set -euo pipefail

SKILL="${1:?usage: skill-archive-sync.sh <skill-name> [--from <path>]}"
shift || true

SKILLS_HOME="$HOME/.claude/skills"
FROM="$SKILLS_HOME/$SKILL"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    *) echo "skill-archive-sync: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

if ! [[ "$SKILL" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "skill-archive-sync: refusing skill name '$SKILL' -- must match ^[A-Za-z0-9._-]+\$ (no '/', no '..')" >&2
  exit 2
fi

# A dot-prefixed name -- ".git" above all -- collides with the ARCHIVE'S OWN control directory
# or other hidden files at $ARCHIVE_ROOT/$SKILL. Measured: a SKILL of ".git" makes DEST below
# resolve to $ARCHIVE_ROOT/.git, and `rm -rf "$DEST"` then deletes the archive's entire git
# history (card 59cfcb21 F-LOW, utomunka kartya 0fb92c16, item 1).
if [[ "$SKILL" == .* ]]; then
  echo "skill-archive-sync: refusing dot-prefixed skill name '$SKILL' -- it could collide with the archive's own .git or other hidden entries" >&2
  exit 2
fi

[ -d "$FROM" ] || { echo "skill-archive-sync: source not found: $FROM" >&2; exit 1; }

REAL_FROM="$(cd "$FROM" && pwd -P)"
REAL_SKILLS_HOME="$(mkdir -p "$SKILLS_HOME" && cd "$SKILLS_HOME" && pwd -P)"
case "$REAL_FROM" in
  "$REAL_SKILLS_HOME"/*|"$REAL_SKILLS_HOME") ;;
  *)
    echo "skill-archive-sync: refusing --from '$FROM' -- it resolves to '$REAL_FROM', which is not inside $REAL_SKILLS_HOME" >&2
    exit 2
    ;;
esac

ARCHIVE_ROOT="$HOME/.claude/skill-archive"
mkdir -p "$ARCHIVE_ROOT"
if [ ! -d "$ARCHIVE_ROOT/.git" ]; then
  git -C "$ARCHIVE_ROOT" init -q
  git -C "$ARCHIVE_ROOT" config user.name "skill-archive-sync"
  git -C "$ARCHIVE_ROOT" config user.email "skill-archive-sync@local"
  echo "skill-archive-sync: initialized a new local git repo at $ARCHIVE_ROOT (no remote -- never pushed anywhere)"
fi

# The remote-less promise (card 59cfcb21 F1) was never actually enforced -- nothing stopped a
# later `git remote add` from turning this into a pushable repo. Refuse to operate if one shows up.
if git -C "$ARCHIVE_ROOT" remote 2>/dev/null | grep -q .; then
  echo "skill-archive-sync: refusing -- $ARCHIVE_ROOT has a git remote configured, but this archive must stay local-only (card 59cfcb21 F1)" >&2
  exit 2
fi

DEST="$ARCHIVE_ROOT/$SKILL"
rm -rf "$DEST"
cp -r "$REAL_FROM" "$DEST"

git -C "$ARCHIVE_ROOT" add -A -- "$SKILL"
if git -C "$ARCHIVE_ROOT" diff --cached --quiet -- "$SKILL"; then
  echo "skill-archive-sync: $SKILL copied $REAL_FROM -> $DEST (no content change, nothing to commit)"
else
  git -C "$ARCHIVE_ROOT" commit -q -m "sync: $SKILL from $REAL_FROM" -- "$SKILL"
  echo "skill-archive-sync: $SKILL copied $REAL_FROM -> $DEST and committed in $ARCHIVE_ROOT"
fi

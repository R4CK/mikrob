#!/usr/bin/env bash
# skill-archive-sync.sh -- one-time, ONE-WAY copy of a global skill with no tracked copy anywhere
# (not in seed-skills/, not in seed-fleet-agents/) into store/skill-archive/<name>/ (card 59cfcb21).
#
# WHY: evidence-gated-delivery and 28 others (QA+Cybersec finding, card 453d64cc) lived only under
# ~/.claude/skills -- no git, so a disk fault or overwrite could not be recovered, and no delta was
# auditable except by line-arithmetic. seed-skills/ is the wrong home: it propagates to every fresh
# install, and loki-mode-derived content (BSL 1.1) must not spread that way. store/skill-archive/ is
# tracked but NOT read by any installer (store/skill-archive-no-propagation.selftest.sh enforces
# this structurally).
#
# ONE-WAY: this script only ever copies live -> archive. It never writes back to ~/.claude/skills.
# Restoring the other direction is a separate, manual, documented step: skill-archive-restore.sh.
#
# This is a thin cp wrapper, not a drift-watcher: run it once per skill, then `git add` + commit the
# result yourself -- the commit is what makes the copy auditable (git diff shows the exact delta),
# which is the gap MikroB's decision (comment 14256) called out.
#
# Usage:
#   store/skill-archive-sync.sh <skill-name> [--from <path>]   # default --from ~/.claude/skills/<name>
set -euo pipefail

SKILL="${1:?usage: skill-archive-sync.sh <skill-name> [--from <path>]}"
shift || true
FROM="$HOME/.claude/skills/$SKILL"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    *) echo "skill-archive-sync: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEST="$ROOT/store/skill-archive/$SKILL"

[ -d "$FROM" ] || { echo "skill-archive-sync: source not found: $FROM" >&2; exit 1; }

mkdir -p "$ROOT/store/skill-archive"
rm -rf "$DEST"
cp -r "$FROM" "$DEST"
echo "skill-archive-sync: $SKILL copied $FROM -> $DEST"
echo "skill-archive-sync: now commit it -- git add store/skill-archive/$SKILL && git commit"

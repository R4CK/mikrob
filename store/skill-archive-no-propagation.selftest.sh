#!/usr/bin/env bash
# skill-archive-no-propagation.selftest.sh -- structural guard (card 59cfcb21; hardened per Cybersec
# F4 + MikroB fix instruction, komment 14386). A literal `grep -q "skill-archive"` is evadable
# (string concatenation, a generic wildcard copy, or a silently-skipped renamed file all defeat a
# plain substring match -- Cybersec NO-GO, komment 14381, F4). The archive itself no longer lives
# inside this repo at all (card 59cfcb21 F1 fix): it moved to ~/.claude/skill-archive, a SEPARATE,
# remote-less local git repo outside the tracked tree. This guard checks the installer's ACTUAL
# skill/agent-source bindings instead of a single substring:
#   (a) every `*_DIR="$INSTALL_DIR/<name>"` / `*_DIR="${VAR:-$ROOT/<name>}"` binding -- the real
#       directories these scripts iterate over or copy from -- has its <name> on a fixed allowlist.
#       A future edit that starts iterating an unlisted directory (store/skill-archive or anything
#       else) is caught even if it never spells the archive's name.
#   (b) no installer does a GENERIC whole-directory copy of store/ or ~/.claude/ -- that would
#       silently sweep in any future stray directory, named or not.
#   (c) belt-and-braces: a literal "skill-archive" reference anywhere in the file still fails, in
#       case a future edit hardcodes a restore/debug call that was never meant to ship.
#
# Run this after editing install-linux.sh, install-macos.sh, install-lang.sh, update.sh, or
# store/agent-skill-drift-sync.sh -- a FAIL means one of those files started reading an unlisted
# directory and must be reverted before landing.
#
# Exit: 0 on PASS, 1 on FAIL.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

FILES=(
  "$ROOT/install-linux.sh"
  "$ROOT/install-macos.sh"
  "$ROOT/install-lang.sh"
  "$ROOT/update.sh"
  "$ROOT/store/agent-skill-drift-sync.sh"
)

# The only directory NAMES an installer/drift-sync may ever bind as a skill/agent-copy source (or
# its matching destination, e.g. FLEET_DIR="$INSTALL_DIR/agents"). Anything else is a FAIL.
ALLOWED_SOURCES=(seed-skills seed-fleet-agents seed-agents seed-scheduled-tasks seed-config agents)

fail=0
checked=0
for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  checked=$((checked+1))

  # (a) actual directory bindings: VAR="$INSTALL_DIR/<name>" or VAR="${OTHER:-$ROOT/<name>}" --
  # the WHOLE assigned value must be exactly INSTALL_DIR/ROOT plus one bare path segment, so a
  # comment or unrelated string elsewhere in the file can't match this.
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    allowed=0
    for a in "${ALLOWED_SOURCES[@]}"; do
      [ "$name" = "$a" ] && allowed=1 && break
    done
    if [ "$allowed" -ne 1 ]; then
      echo "FAIL: $f binds an unlisted skill/agent directory '$name' -- only ${ALLOWED_SOURCES[*]} are allowed; store/skill-archive (or any external archive path) must never be an installer source" >&2
      fail=1
    fi
  done < <(grep -oE '^[A-Z_]+_DIR="\$(INSTALL_DIR|ROOT)/[A-Za-z0-9_.-]+"|^[A-Z_]+_DIR="\$\{[A-Z_]+:-\$(INSTALL_DIR|ROOT)/[A-Za-z0-9_.-]+\}"' "$f" \
        | grep -oE '\$(INSTALL_DIR|ROOT)/[A-Za-z0-9_.-]+' | sed -E 's#^\$(INSTALL_DIR|ROOT)/##' | sort -u)

  # (b) generic whole-directory copy of store/ or ~/.claude/ -- would silently sweep in anything
  # dropped there later, named or not.
  if grep -qE '(cp -[a-zA-Z]*|rsync -[a-zA-Z]*)[[:space:]]+"?\$(INSTALL_DIR|ROOT)/store/?"?\*' "$f" \
     || grep -qE '(cp -[a-zA-Z]*|rsync -[a-zA-Z]*)[[:space:]]+"?\$HOME/\.claude/?"?\*' "$f"; then
    echo "FAIL: $f does a generic whole-directory copy of store/ or ~/.claude/ -- this would silently propagate any directory dropped there, named or not" >&2
    fail=1
  fi

  # (c) belt-and-braces literal check.
  if grep -qi "skill-archive" "$f"; then
    echo "FAIL: $f references skill-archive by name -- installers/update.sh/drift-sync must never read the archive" >&2
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "skill-archive-no-propagation: PASS -- no installer/update.sh/drift-sync binds an unlisted source dir, does a generic store//~/.claude/ wildcard copy, or references skill-archive by name"
  # store-selftests-all-run.test.ts style ("vendored-skill-integrity style" OK_SHAPES entry): a
  # non-vacuous count line so the auto-discovery harness can tell "ran and found nothing wrong"
  # apart from "found and ran zero files".
  echo "selftest: ${checked} checks, 0 failed"
else
  exit 1
fi

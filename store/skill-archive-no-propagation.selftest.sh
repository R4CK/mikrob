#!/usr/bin/env bash
# skill-archive-no-propagation.selftest.sh -- structural guard (card 59cfcb21, MikroB decision
# condition 3): no installer, update.sh, or the agent-skill-drift-sync tool may ever read
# store/skill-archive/. That directory exists ONLY so a global skill with no seed-skills/ or
# seed-fleet-agents/ copy can survive a disk fault or overwrite -- the moment any installer reads
# it, it becomes a second seed-skills/ and inherits the exact licensing problem (loki-mode-derived,
# BSL 1.1 content; see card 453d64cc) this archive was built to avoid spreading to fresh installs.
#
# Run this after editing install-linux.sh, install-macos.sh, install-lang.sh, update.sh, or
# store/agent-skill-drift-sync.sh -- a FAIL means one of those files started reading the archive
# and must be reverted before landing.
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

fail=0
checked=0
for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  checked=$((checked+1))
  if grep -q "skill-archive" "$f"; then
    echo "FAIL: $f references skill-archive -- installers/update.sh/drift-sync must never read store/skill-archive/" >&2
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "skill-archive-no-propagation: PASS -- no installer/update.sh/drift-sync references store/skill-archive/"
  # store-selftests-all-run.test.ts style ("vendored-skill-integrity style" OK_SHAPES entry): a
  # non-vacuous count line so the auto-discovery harness can tell "ran and found nothing wrong"
  # apart from "found and ran zero files".
  echo "selftest: ${checked} checks, 0 failed"
else
  exit 1
fi

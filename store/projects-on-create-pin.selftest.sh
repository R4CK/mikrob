#!/usr/bin/env bash
# projects-on-create-pin.selftest.sh -- LOW-1 (card c16cd98e, F6.2 follow-up from CYBERED NO-GO
# 38923 + GO 38955). worktree-on-create.sh's on_create hook is safe TODAY only because every
# committed store/projects/*.json sets on_create_script to null -- nothing else pinned that. This
# pin fails the moment any committed config turns a real hook on, until F-2 (interrupted-hook
# recovery), F-3 (concurrent-reuse race) and F-4 (stderr-noise silent skip) are fixed AND re-gated
# (this card, or a stated successor). Remove/relax this pin only as part of that re-gate, not
# before.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
n=0

for cfg in "$HERE"/projects/*.json; do
  [ -f "$cfg" ] || continue
  n=$((n + 1))
  on_create="$(python3 -I -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
print(data.get("on_create_script") or "")
' "$cfg" 2>/dev/null)"
  if [ -z "$on_create" ]; then
    echo "  ok   $(basename "$cfg"): on_create_script is null/absent"
  else
    echo "  FAIL $(basename "$cfg") sets on_create_script=$on_create -- refused until F-2/F-3/F-4 (card c16cd98e or a stated successor) are fixed AND re-gated; see worktree-on-create.sh's header"
    fail=1
  fi
done

# Non-vacuity (guards-that-pin-behaviour skill): a walker that silently finds zero files looks
# exactly like a clean tree. If the glob ever matches nothing, say so loudly instead of passing.
if [ "$n" -eq 0 ]; then
  echo "  FAIL no store/projects/*.json files found -- the pin asserted nothing (non-vacuity check)"
  fail=1
fi

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

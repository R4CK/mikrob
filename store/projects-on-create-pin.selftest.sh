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

check_config() {
  local cfg="$1"
  on_create="$(python3 -I -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
print(data.get("on_create_script") or "")
' "$cfg" 2>/dev/null)"
  rc=$?
  # F-3(b) fix (CYBERSEC NO-GO 39444, mutant MQ): a committed config that cannot even be parsed
  # used to come back as an EMPTY on_create (stderr discarded, exit status ignored) and the caller
  # read that as "null, ok" -- the exact silent-skip shape F-4 fixes in the real hook runner,
  # reintroduced here in the pin that is supposed to guard it. Refuse, never treat as null.
  [ "$rc" -eq 0 ] && [ -z "$on_create" ]
}

for cfg in "$HERE"/projects/*.json; do
  [ -f "$cfg" ] || continue
  n=$((n + 1))
  if check_config "$cfg"; then
    echo "  ok   $(basename "$cfg"): on_create_script is null/absent"
  elif [ "$rc" -ne 0 ]; then
    echo "  FAIL $(basename "$cfg") could not be parsed (rc=$rc) -- an unreadable/malformed committed config is refused, not treated as null"
    fail=1
  else
    echo "  FAIL $(basename "$cfg") sets on_create_script=$on_create -- refused until F-2/F-3/F-4 (card c16cd98e or a stated successor) are fixed AND re-gated; see worktree-on-create.sh's header"
    fail=1
  fi
done

n=$((n + 1))
# F-3(b) mutation pin: a malformed (unparseable) config must fail check_config(), never be
# silently read as null. The fixture file lives in a throwaway mktemp sandbox, NEVER inside
# $HERE/projects (the real store/projects/ this pin scans) -- that directory is the shared
# checkout every other vitest worker also reads, and this card's own
# selftests-do-not-mutate-the-shared-tree.test.ts exists precisely to catch a selftest writing
# into it transiently. check_config() takes any path, so the fixture does not need to sit where
# the real scan looks.
MUT_DIR="$(mktemp -d)"
trap 'rm -rf "$MUT_DIR"' EXIT
MUT="$MUT_DIR/zz-selftest-malformed.json"
printf '{not valid json' > "$MUT"
if check_config "$MUT"; then
  echo "  FAIL a malformed config file was read as null/absent instead of being refused"; fail=1
elif [ "$rc" -ne 0 ]; then
  echo "  ok   a malformed/unparseable config file fails the pin instead of silently passing as null"
else
  echo "  FAIL malformed config failed for the wrong reason (on_create_script was non-empty, not a parse error)"; fail=1
fi
rm -rf "$MUT_DIR"
trap - EXIT

# Non-vacuity (guards-that-pin-behaviour skill): a walker that silently finds zero files looks
# exactly like a clean tree. If the glob ever matches nothing, say so loudly instead of passing.
if [ "$n" -eq 0 ]; then
  echo "  FAIL no store/projects/*.json files found -- the pin asserted nothing (non-vacuity check)"
  fail=1
fi

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

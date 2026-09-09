#!/usr/bin/env bash
# Self-test for store/delta-review-diff.sh (card c266ec74).
#
# Run:  bash store/delta-review-diff.selftest.sh
# Exit: 0 = all pass, 1 = at least one case wrong.
#
# The case that matters: a change under store/ (not src/) must show up. That is exactly what a
# `-- src/`-scoped diff would have hidden on efaf8926's delta-review.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/delta-review-diff.sh"
fail=0
n=0

t() { # $1 = label, $2 = got, $3 = want
  n=$((n + 1))
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1 -> got [$2] want [$3]"
    fail=1
  fi
}

echo "delta-review-diff.sh selftest"

tmp="$(mktemp -d)"
(
  cd "$tmp" || exit 1
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
  git init -q .
  mkdir -p src store
  echo one >src/a.ts
  git add src/a.ts
  git commit -q -m 'base'
  echo two >src/a.ts
  echo stowaway >store/side-script.sh
  git add -A
  git commit -q -m 'fix + stowaway'
) >/dev/null 2>&1

OLD="$(git -C "$tmp" rev-list --max-parents=0 HEAD 2>/dev/null || git -C "$tmp" log --format=%H | tail -1)"
NEW="$(git -C "$tmp" rev-parse HEAD)"

out="$(bash "$SCRIPT" "$OLD" "$NEW" "$tmp")"
t "reports the src/ change" "$(printf '%s\n' "$out" | grep -c '^src/a.ts$')" "1"
t "ALSO reports the store/ stowaway (this is the whole point -- no pathspec)" \
  "$(printf '%s\n' "$out" | grep -c '^store/side-script.sh$')" "1"
t "reports exactly two changed files, nothing more, nothing filtered" \
  "$(printf '%s\n' "$out" | grep -c .)" "2"

t "bad old sha refuses with exit 2" "$(bash "$SCRIPT" deadbeef "$NEW" "$tmp" >/dev/null 2>&1; echo $?)" "2"
t "missing args refuse with exit 2" "$(bash "$SCRIPT" "$OLD" >/dev/null 2>&1; echo $?)" "2"

rm -rf "$tmp"

echo "selftest: $n case(s), $([ "$fail" = 0 ] && echo PASS || echo FAIL)"
exit "$fail"

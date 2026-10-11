#!/usr/bin/env bash
# Self-test for agent-worktree-marveen.sh's --card mode (card cd3e577b, F1 of the b8ac0ef1
# "software factory" phase). Runs the REAL script end to end against a throwaway repo -- same
# fixture shape as the other *-land*.selftest.sh scripts in this directory.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/agent-worktree-marveen.sh"
fail=0
n=0

WORK="$(mktemp -d)"
MAIN="$WORK/main"
ROOT="$WORK/worktrees"
git init -q -b develop "$MAIN"
git -C "$MAIN" config user.email s@s
git -C "$MAIN" config user.name s
echo base > "$MAIN/notes.txt"
git -C "$MAIN" add "$MAIN/notes.txt"
git -C "$MAIN" commit -qm base

ORIGIN="$WORK/origin.git"
git init -q --bare -b develop "$ORIGIN"
git -C "$MAIN" remote add origin "$ORIGIN"
git -C "$MAIN" push -q origin develop
git -C "$MAIN" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop

run() { MARVEEN_MAIN="$MAIN" MARVEEN_WORKTREES="$ROOT" bash "$SCRIPT" "$@"; }

n=$((n + 1))
if out="$(run backend --card deadbeef12 2>&1)" && [ -e "$ROOT/card/deadbeef12/.git" ]; then
  echo "  ok   --card creates a per-card worktree under card/<id>, not under the agent's name"
else
  echo "  FAIL --card should create $ROOT/card/deadbeef12 -> $out"; fail=1
fi

n=$((n + 1))
branch="$(git -C "$ROOT/card/deadbeef12" rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$branch" = "card/deadbeef12" ]; then
  echo "  ok   the per-card worktree sits on branch card/<id>"
else
  echo "  FAIL expected branch card/deadbeef12, got '$branch'"; fail=1
fi

n=$((n + 1))
if [ "$(run backend --card deadbeef12 --path)" = "$ROOT/card/deadbeef12" ]; then
  echo "  ok   --card --path prints the card worktree path and exits without touching git"
else
  echo "  FAIL --card --path printed something unexpected"; fail=1
fi

n=$((n + 1))
if out="$(run backend --card BADID 2>&1)"; rc=$?; [ "$rc" = 2 ] && printf '%s' "$out" | grep -q "card id must be hex"; then
  echo "  ok   a non-hex card id is refused (exit 2), not silently accepted as a path component"
else
  echo "  FAIL a bad card id should be refused -> rc=$rc: $out"; fail=1
fi

n=$((n + 1))
if out="$(run backend --card ab 2>&1)"; rc=$?; [ "$rc" = 2 ] && printf '%s' "$out" | grep -q "too short"; then
  echo "  ok   a too-short card id is refused (exit 2)"
else
  echo "  FAIL a too-short card id should be refused -> rc=$rc: $out"; fail=1
fi

n=$((n + 1))
if out="$(run backend 2>&1)" && [ -e "$ROOT/backend/.git" ]; then
  branch2="$(git -C "$ROOT/backend" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$branch2" = "agent/backend/work" ]; then
    echo "  ok   without --card, the existing per-agent worktree/branch behaviour is unchanged"
  else
    echo "  FAIL expected agent/backend/work, got '$branch2'"; fail=1
  fi
else
  echo "  FAIL plain agent mode should still create $ROOT/backend -> $out"; fail=1
fi

n=$((n + 1))
if [ -L "$ROOT/card/deadbeef12/node_modules" ]; then
  echo "  ok   a card worktree's node_modules is a symlink (real-deps has no --card mode yet)"
else
  echo "  FAIL expected node_modules to be a symlink in the card worktree"; fail=1
fi

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

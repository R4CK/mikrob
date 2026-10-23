#!/usr/bin/env bash
# Self-test for overlap-signal-check.sh (card ca72e5d4). Throwaway repo, same fixture shape as the
# other *.selftest.sh scripts in this directory (see agent-worktree-marveen.selftest.sh).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/overlap-signal-check.sh"
fail=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
MAIN="$WORK/main"
ROOT="$WORK/worktrees"

git init -q -b develop "$MAIN"
git -C "$MAIN" config user.email s@s
git -C "$MAIN" config user.name s
mkdir -p "$MAIN/src"
cat > "$MAIN/src/foo.py" <<'PY'
def helper(x):
    return x + 1


def other(y):
    return y - 1
PY
mkdir -p "$MAIN/store"
cp "$HERE/agent-worktree-marveen.sh" "$MAIN/store/agent-worktree-marveen.sh"
git -C "$MAIN" add src/foo.py store/agent-worktree-marveen.sh
git -C "$MAIN" commit -qm base

ORIGIN="$WORK/origin.git"
git init -q --bare -b develop "$ORIGIN"
git -C "$MAIN" remote add origin "$ORIGIN"
git -C "$MAIN" push -q origin develop
git -C "$MAIN" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop

# agent/backend/work -- touches helper() (SAME function alice will touch below)
git -C "$MAIN" checkout -qb agent/backend/work develop
sed -i 's/return x + 1/return x + 2/' "$MAIN/src/foo.py"
git -C "$MAIN" commit -qam 'backend: bump helper'
git -C "$MAIN" push -q origin agent/backend/work

# agent/carol/work -- touches other() only (DIFFERENT function, same file -- no false positive)
git -C "$MAIN" checkout -qb agent/carol/work develop
sed -i 's/return y - 1/return y - 2/' "$MAIN/src/foo.py"
git -C "$MAIN" commit -qam 'carol: bump other'
git -C "$MAIN" push -q origin agent/carol/work

# card/deadbeef12 -- touches helper() too, to prove card-branch resolution
git -C "$MAIN" checkout -qb card/deadbeef12 develop
sed -i 's/return x + 1/return x + 3/' "$MAIN/src/foo.py"
git -C "$MAIN" commit -qam 'card deadbeef12: bump helper'
git -C "$MAIN" push -q origin card/deadbeef12

# agent/old/work -- touches helper() too, but gets LANDED (merged into develop) -- must be silent
git -C "$MAIN" checkout -qb agent/old/work develop
sed -i 's/return x + 1/return x + 9/' "$MAIN/src/foo.py"
git -C "$MAIN" commit -qam 'old: bump helper (landed)'
git -C "$MAIN" checkout -q develop
git -C "$MAIN" merge -q --no-ff agent/old/work -m 'merge: agent/old/work'
git -C "$MAIN" push -q origin develop

git -C "$MAIN" checkout -q develop

# alice is OUR agent under test: a worktree on agent/alice/work, committed change touching helper()
# -- same function as backend and card/deadbeef12, different line than either.
mkdir -p "$ROOT"
git -C "$MAIN" worktree add -q "$ROOT/alice" -b agent/alice/work origin/develop
sed -i 's/return x + [0-9]*/return x + 100/' "$ROOT/alice/src/foo.py"
git -C "$ROOT/alice" commit -qam 'alice: bump helper'

run() { MARVEEN_MAIN="$MAIN" MARVEEN_WORKTREES="$ROOT" bash "$SCRIPT" "$@"; }

out="$(run alice 2>&1)"

n=1
echo "$out" | grep -q 'OVERLAP file=src/foo.py symbol="def helper(x):" other_branch=agent/backend/work' \
  && echo "  ok   same-function overlap against agent/backend/work reported" \
  || { echo "  FAIL expected an OVERLAP line for agent/backend/work -- got:"; echo "$out"; fail=1; }

n=$((n+1))
echo "$out" | grep -q 'other_card=deadbeef12' \
  && echo "  ok   a card/<id> branch resolves to other_card=<id>, not other_agent" \
  || { echo "  FAIL expected other_card=deadbeef12 -- got:"; echo "$out"; fail=1; }

n=$((n+1))
if echo "$out" | grep -qE 'other_branch=agent/carol/work|other_agent=carol'; then
  echo "  FAIL carol only touched a DIFFERENT function in the same file -- must not be reported"
  echo "$out"
  fail=1
else
  echo "  ok   carol (different function, same file) is NOT reported -- no false positive on file-level overlap alone"
fi

n=$((n+1))
if echo "$out" | grep -qE 'old\b'; then
  echo "  FAIL agent/old/work is already LANDED (merged into develop) -- must be silent"
  echo "$out"
  fail=1
else
  echo "  ok   a landed (merged) branch is never reported"
fi

n=$((n+1))
off_out="$(OVERLAP_SIGNAL=off run alice 2>&1)"
if echo "$off_out" | grep -q 'OVERLAP_SIGNAL=off' && ! echo "$off_out" | grep -q 'OVERLAP file='; then
  echo "  ok   OVERLAP_SIGNAL=off is a clean no-op (the switch)"
else
  echo "  FAIL OVERLAP_SIGNAL=off should skip entirely -- got:"; echo "$off_out"; fail=1
fi

n=$((n+1))
clean="$(run backend 2>&1)"
if echo "$clean" | grep -q 'no worktree for backend, skipped'; then
  echo "  ok   an agent with no worktree checked out yet skips cleanly instead of erroring"
else
  echo "  FAIL backend has no worktree under this ROOT -- expected a clean skip -- got:"; echo "$clean"; fail=1
fi

[ "$fail" = 0 ] || exit 1
echo "selftest: PASS"

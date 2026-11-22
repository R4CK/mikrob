#!/usr/bin/env bash
# Self-test for agent-worktree-deps.sh's --card mode (card cf678d23, F4.2.2 of the dc185b52
# per-card-worktree phase). Runs the REAL script end to end against a throwaway repo -- same
# fixture shape as agent-worktree-marveen.selftest.sh.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/agent-worktree-deps.sh"
WT_SCRIPT="$HERE/agent-worktree-marveen.sh"
fail=0
n=0

WORK="$(mktemp -d)"
MAIN="$WORK/main"
ROOT="$WORK/worktrees"
git init -q -b develop "$MAIN"
git -C "$MAIN" config user.email s@s
git -C "$MAIN" config user.name s
echo base > "$MAIN/notes.txt"
mkdir -p "$MAIN/node_modules/some-pkg"
echo pkg > "$MAIN/node_modules/some-pkg/index.js"
# agent-worktree-marveen.sh's MARVEEN_WORKTREE_REAL_DEPS=1 path shells out to
# "$MAIN/store/agent-worktree-deps.sh" -- the fixture needs a copy there too, not just at $HERE.
mkdir -p "$MAIN/store"
cp "$SCRIPT" "$MAIN/store/agent-worktree-deps.sh"
git -C "$MAIN" add notes.txt
git -C "$MAIN" commit -qm base

ORIGIN="$WORK/origin.git"
git init -q --bare -b develop "$ORIGIN"
git -C "$MAIN" remote add origin "$ORIGIN"
git -C "$MAIN" push -q origin develop
git -C "$MAIN" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop

run() { MARVEEN_MAIN="$MAIN" MARVEEN_WORKTREES="$ROOT" bash "$SCRIPT" "$@"; }
mktree() { MARVEEN_MAIN="$MAIN" MARVEEN_WORKTREES="$ROOT" bash "$WT_SCRIPT" "$@" >/dev/null; }

# --- agent mode (pin the pre-existing behaviour before touching the file) ---

mktree deps-agent
n=$((n + 1))
if [ -L "$ROOT/deps-agent/node_modules" ]; then
  echo "  ok   a freshly-created agent worktree starts with a symlinked node_modules"
else
  echo "  FAIL expected a symlink at $ROOT/deps-agent/node_modules"; fail=1
fi

n=$((n + 1))
if out="$(run deps-agent --check 2>&1)"; rc=$?; [ "$rc" = 4 ] && printf '%s' "$out" | grep -q "SYMLINK"; then
  echo "  ok   --check on a symlink reports SYMLINK and exits 4"
else
  echo "  FAIL -- rc=$rc out=$out"; fail=1
fi

n=$((n + 1))
if out="$(run deps-agent 2>&1)"; rc=$?; [ "$rc" = 0 ] && [ -d "$ROOT/deps-agent/node_modules" ] && [ ! -L "$ROOT/deps-agent/node_modules" ]; then
  echo "  ok   apply on an agent worktree replaces the symlink with a real directory"
else
  echo "  FAIL -- rc=$rc out=$out"; fail=1
fi

n=$((n + 1))
if [ ! -L "$ROOT/deps-agent/node_modules" ] && [ -f "$ROOT/deps-agent/node_modules/some-pkg/index.js" ]; then
  echo "  ok   the real directory's content was actually copied from \$MAIN"
else
  echo "  FAIL expected a real (non-symlink) node_modules with some-pkg/index.js copied"; fail=1
fi

n=$((n + 1))
if out="$(run deps-agent --check 2>&1)"; rc=$?; [ "$rc" = 0 ] && printf '%s' "$out" | grep -q "REAL directory"; then
  echo "  ok   --check on a real directory reports REAL and exits 0"
else
  echo "  FAIL -- rc=$rc out=$out"; fail=1
fi

# readlink -f, not `cd .. && pwd`: bash's cd builtin resolves ".." LOGICALLY by default (it does
# NOT follow a symlink to compute the physical parent), so it would pass even while node_modules
# was still a symlink and would never have caught the 9dc0fba8 class (`rm -rf ../src`, which the
# KERNEL resolves physically). readlink -f matches what the kernel actually does.
n=$((n + 1))
physical="$(readlink -f "$ROOT/deps-agent/node_modules/..")"
if [ "$physical" = "$ROOT/deps-agent" ]; then
  echo "  ok   '..' physically resolves inside the agent worktree, not into \$MAIN"
else
  echo "  FAIL '..' escaped the agent worktree -> landed in $physical"; fail=1
fi

# --- --card mode (the new part this card adds) ---

n=$((n + 1))
if out="$(run --card 2>&1)"; rc=$?; [ "$rc" = 2 ] && printf '%s' "$out" | grep -q "needs a card id"; then
  echo "  ok   --card with no id is refused (exit 2)"
else
  echo "  FAIL -- rc=$rc out=$out"; fail=1
fi

n=$((n + 1))
if out="$(run --card BADID 2>&1)"; rc=$?; [ "$rc" = 2 ] && printf '%s' "$out" | grep -q "must be hex"; then
  echo "  ok   a non-hex card id is refused (exit 2)"
else
  echo "  FAIL -- rc=$rc out=$out"; fail=1
fi

n=$((n + 1))
if out="$(run --card deadbeef12 2>&1)"; rc=$?; [ "$rc" = 3 ] && printf '%s' "$out" | grep -q "no worktree at"; then
  echo "  ok   --card on a card with no worktree yet is refused (exit 3), names the bootstrap command"
else
  echo "  FAIL -- rc=$rc out=$out"; fail=1
fi

mktree fullstack --card deadbeef12
n=$((n + 1))
if [ -L "$ROOT/card/deadbeef12/node_modules" ]; then
  echo "  ok   a freshly-created card worktree still starts with a symlinked node_modules"
else
  echo "  FAIL expected a symlink at $ROOT/card/deadbeef12/node_modules"; fail=1
fi

n=$((n + 1))
if out="$(run --card deadbeef12 --check 2>&1)"; rc=$?; [ "$rc" = 4 ] && printf '%s' "$out" | grep -q "SYMLINK"; then
  echo "  ok   --card --check on a symlink reports SYMLINK and exits 4"
else
  echo "  FAIL -- rc=$rc out=$out"; fail=1
fi

n=$((n + 1))
if out="$(run --card deadbeef12 2>&1)"; rc=$?; [ "$rc" = 0 ] && [ -d "$ROOT/card/deadbeef12/node_modules" ] && [ ! -L "$ROOT/card/deadbeef12/node_modules" ]; then
  echo "  ok   apply on a CARD worktree replaces the symlink with a real directory"
else
  echo "  FAIL -- rc=$rc out=$out"; fail=1
fi

n=$((n + 1))
if [ ! -L "$ROOT/card/deadbeef12/node_modules" ] && [ -f "$ROOT/card/deadbeef12/node_modules/some-pkg/index.js" ]; then
  echo "  ok   the card worktree's real directory content was copied from \$MAIN too"
else
  echo "  FAIL expected a real (non-symlink) node_modules with some-pkg/index.js copied"; fail=1
fi

n=$((n + 1))
if out="$(run --card deadbeef12 --check 2>&1)"; rc=$?; [ "$rc" = 0 ] && printf '%s' "$out" | grep -q "REAL directory"; then
  echo "  ok   --card --check on a real directory reports REAL and exits 0"
else
  echo "  FAIL -- rc=$rc out=$out"; fail=1
fi

n=$((n + 1))
cardphysical="$(readlink -f "$ROOT/card/deadbeef12/node_modules/..")"
if [ "$cardphysical" = "$ROOT/card/deadbeef12" ]; then
  echo "  ok   '..' physically resolves inside the CARD worktree, not into \$MAIN"
else
  echo "  FAIL '..' escaped the card worktree -> landed in $cardphysical"; fail=1
fi

n=$((n + 1))
if out="$(run --card deadbeef12 2>&1)"; rc=$?; [ "$rc" = 0 ] && printf '%s' "$out" | grep -q "already a real directory"; then
  echo "  ok   apply is idempotent on an already-real card worktree (no second copy attempted)"
else
  echo "  FAIL -- rc=$rc out=$out"; fail=1
fi

# --- agent-worktree-marveen.sh wiring: MARVEEN_WORKTREE_REAL_DEPS=1 now also applies to --card ---

run_wt() { MARVEEN_MAIN="$MAIN" MARVEEN_WORKTREES="$ROOT" MARVEEN_WORKTREE_REAL_DEPS=1 bash "$WT_SCRIPT" "$@"; }

n=$((n + 1))
if out="$(run_wt fullstack --card cafed00d12 2>&1)" && [ -d "$ROOT/card/cafed00d12/node_modules" ] && [ ! -L "$ROOT/card/cafed00d12/node_modules" ]; then
  echo "  ok   MARVEEN_WORKTREE_REAL_DEPS=1 gives a BRAND-NEW --card worktree a real node_modules directly"
else
  echo "  FAIL -- out=$out"; fail=1
fi

rm -rf "$WORK"

echo
if [ "$fail" = 0 ]; then
  echo "selftest: $n case(s), PASS"
  exit 0
else
  echo "selftest: $n case(s), FAIL present"
  exit 1
fi

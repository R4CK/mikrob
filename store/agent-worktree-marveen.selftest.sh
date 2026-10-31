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

# RedHat NO-GO 16276, B2a: picking up a card worktree for an agent that has an unlanded commit
# sitting on its own agent/<agent>/work branch must SAY SO (plan-grilling's own mitigation, never
# implemented until now) -- never block, never touch that branch.
git -C "$MAIN" worktree add -q -b agent/zz/work "$WORK/zz-work" develop >/dev/null
echo orphan > "$WORK/zz-work/orphan.txt"
git -C "$WORK/zz-work" add orphan.txt
git -C "$WORK/zz-work" -c user.email=s@s -c user.name=s commit -qm "card 77777777: orphan work"
git -C "$MAIN" worktree remove --force "$WORK/zz-work" >/dev/null

n=$((n + 1))
if out="$(run zz --card cafebabe12 2>&1)" && printf '%s' "$out" | grep -q "agent/zz/work has unlanded commit"; then
  echo "  ok   --card on an agent with an unlanded agent/<agent>/work commit warns about it"
else
  echo "  FAIL expected an unlanded-commit warning -> $out"; fail=1
fi

n=$((n + 1))
if out="$(run zz --card cafebabe12 2>&1)" && ! git -C "$MAIN" log --oneline agent/zz/work -1 | grep -q "77777777.*squash\|amend"; then
  branch3="$(git -C "$MAIN" rev-parse --abbrev-ref agent/zz/work 2>/dev/null)"
  if [ "$branch3" = "agent/zz/work" ] && git -C "$MAIN" log -1 --format=%s agent/zz/work | grep -q "77777777"; then
    echo "  ok   the warning never touches/rewrites agent/<agent>/work itself"
  else
    echo "  FAIL agent/zz/work should be untouched -> $branch3"; fail=1
  fi
else
  echo "  FAIL could not re-verify agent/zz/work -> $out"; fail=1
fi

n=$((n + 1))
if out="$(run backend --card deadbeef12 2>&1)" && ! printf '%s' "$out" | grep -q "unlanded commit"; then
  echo "  ok   no spurious warning for an agent whose agent/<agent>/work has nothing unlanded"
else
  echo "  FAIL backend has no unlanded work, should not warn -> $out"; fail=1
fi

# card 3adca529, F2 (QA FAIL 27188 + WhiteHat M1, msg 15982): zero automated coverage existed for
# the identity-isolation block itself -- both gate members mutated it OUT by hand and the OLD
# selftest kept passing. This case pins it: the fixture MAIN's shared [user] is s@s (set above), so
# WITHOUT the three identity lines, both agents' commits would author as "s" -- this case goes RED
# if those lines are removed.
n=$((n + 1))
run alice >/dev/null
run bob >/dev/null
echo a > "$ROOT/alice/a.txt"; git -C "$ROOT/alice" add a.txt
git -C "$ROOT/alice" commit -qm "alice's commit"
echo b > "$ROOT/bob/b.txt"; git -C "$ROOT/bob" add b.txt
git -C "$ROOT/bob" commit -qm "bob's commit"
alice_author="$(git -C "$ROOT/alice" log -1 --format='%an <%ae>')"
bob_author="$(git -C "$ROOT/bob" log -1 --format='%an <%ae>')"
if [ "$alice_author" = "alice <alice@marveen.local>" ] && [ "$bob_author" = "bob <bob@marveen.local>" ]; then
  echo "  ok   two worktrees' own commits author as their own agent, not the shared [user]=s"
else
  echo "  FAIL expected alice/bob identities, got alice=[$alice_author] bob=[$bob_author]"; fail=1
fi

n=$((n + 1))
# An unscoped write in ONE tree must not leak into the OTHER, and -- measured live, stronger than
# the card's own wording assumed -- it does not even change the WRITER's own tree once that tree
# has a --worktree override: config.worktree takes precedence over the shared .git/config for a
# key either side sets. The write still lands in the SHARED config (verified below), which is
# exactly the residual exposure for any NOT-yet-converged worktree -- the root of WhiteHat/QA's F1.
# If the mutant removes the identity lines, both agents fall back to the fixture's shared "s" and
# this case's first assertion fails exactly like the previous one.
git -C "$ROOT/bob" config user.name intruder
echo c > "$ROOT/bob/c.txt"; git -C "$ROOT/bob" add c.txt
git -C "$ROOT/bob" commit -qm "bob's second commit, after an unscoped write in his own tree"
echo d > "$ROOT/alice/d.txt"; git -C "$ROOT/alice" add d.txt
git -C "$ROOT/alice" commit -qm "alice's second commit"
alice_author2="$(git -C "$ROOT/alice" log -1 --format='%an')"
bob_author2="$(git -C "$ROOT/bob" log -1 --format='%an')"
main_shared_name="$(git -C "$MAIN" config user.name)"
if [ "$alice_author2" = "alice" ] && [ "$bob_author2" = "bob" ] && [ "$main_shared_name" = "intruder" ]; then
  echo "  ok   bob's unscoped write stays confined to the SHARED config; both converged trees keep their own identity"
else
  echo "  FAIL expected alice=alice bob=bob shared=intruder, got alice=[$alice_author2] bob=[$bob_author2] shared=[$main_shared_name]"; fail=1
fi

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

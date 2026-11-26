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
# card 20f2b522 (F4.2): --card must be IDEMPOTENT -- a second pickup of the same card reuses the
# existing worktree/branch instead of erroring or creating a duplicate.
reuse_out="$(run backend --card deadbeef12 2>&1)"
reuse_rc=$?
reuse_branch="$(git -C "$ROOT/card/deadbeef12" rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$reuse_rc" = 0 ] && printf '%s' "$reuse_out" | grep -q "worktree already present" && [ "$reuse_branch" = "card/deadbeef12" ]; then
  echo "  ok   a second --card pickup of the same card reuses the existing worktree, no error"
else
  echo "  FAIL expected a clean reuse -> rc=$reuse_rc out=$reuse_out branch=$reuse_branch"; fail=1
fi

n=$((n + 1))
# card 20f2b522 (F4.2), strengthened by 018c85d3 (L1, RedHat Cybersec GO 28254 on Gate-SHA
# 7c04bbd73): if the target path is occupied by something that is NOT a git worktree (e.g. a
# leftover plain directory), the script must refuse loudly (exit 3, the SPECIFIC "could not create
# the worktree" message, not just any nonzero rc) and leave the occupying content as ITS ONLY
# content -- never `rm -rf` it to make room, and never leave any half-created git state (.git file,
# extra files) behind in it either. The weaker version of this case (rc != 0 + the sentinel file
# merely still present) is satisfied by a mutant that swallows the `git worktree add` error and
# returns some OTHER nonzero code, or that leaves a stray `.git` file in the occupant dir.
mkdir -p "$ROOT/card/baadf00d12"
echo "not a worktree, do not delete me" > "$ROOT/card/baadf00d12/sentinel.txt"
rollback_out="$(run backend --card baadf00d12 2>&1)"
rollback_rc=$?
occupant_listing="$(ls -A "$ROOT/card/baadf00d12")"
if [ "$rollback_rc" = 3 ] \
  && printf '%s' "$rollback_out" | grep -q "could not create the worktree" \
  && [ "$occupant_listing" = "sentinel.txt" ]; then
  echo "  ok   an occupied non-worktree path is refused with exit 3, the specific message, occupant holds only the sentinel"
else
  echo "  FAIL expected exit 3 + specific message + sentinel-only occupant -> rc=$rollback_rc listing='$occupant_listing' out=$rollback_out"; fail=1
fi

n=$((n + 1))
# card abd4970c (F4.2.1): `git worktree add -b card/<id> ...` can create the BRANCH successfully
# and still fail the worktree-population step right after (exactly the fixture above -- the
# target path is occupied) -- a failed create must leave NO branch behind for the next attempt
# to silently inherit.
if ! git -C "$MAIN" show-ref --verify --quiet "refs/heads/card/baadf00d12"; then
  echo "  ok   a failed --card create leaves no dangling branch behind"
else
  echo "  FAIL a failed --card create left refs/heads/card/baadf00d12 dangling"; fail=1
fi

n=$((n + 1))
# CONTROL, discriminating: the legitimate survivor case (a branch that already existed BEFORE
# this call, from a worktree that was removed with `git worktree remove` but whose branch
# survived) must NEVER be deleted by the new rollback -- only a branch THIS call just created.
git -C "$MAIN" worktree add -q -b card/abcdef1912 "$ROOT/card/abcdef1912" develop >/dev/null
git -C "$MAIN" worktree remove --force "$ROOT/card/abcdef1912" >/dev/null
if git -C "$MAIN" show-ref --verify --quiet "refs/heads/card/abcdef1912"; then
  survivor_out="$(run backend --card abcdef1912 2>&1)"
  survivor_rc=$?
  if [ "$survivor_rc" = 0 ] && git -C "$MAIN" show-ref --verify --quiet "refs/heads/card/abcdef1912"; then
    echo "  ok   a pre-existing survivor branch is reused via the fallback, never rolled back"
  else
    echo "  FAIL survivor branch should be reused, not deleted -> rc=$survivor_rc out=$survivor_out"; fail=1
  fi
else
  echo "  FAIL setup did not produce a survivor branch to test against"; fail=1
fi

n=$((n + 1))
# card 018c85d3 (L2, same gate): a leftover survivor branch (reused via the fallback above) can be
# BEHIND the current origin/develop tip -- advance develop with a new commit the survivor branch
# never saw, then re-pick-up the survivor and confirm the reattach now warns about the stale base.
# A mutant that drops the fallback entirely, or that ignores a `git fetch` failure, would both
# survive a weaker assertion that only checks "the worktree still gets created" -- this checks the
# WARNING text specifically.
git -C "$MAIN" worktree add -q -b card/51a1e099 "$ROOT/card/51a1e099" develop >/dev/null
git -C "$MAIN" worktree remove --force "$ROOT/card/51a1e099" >/dev/null
# Advance origin/develop through a SEPARATE clone, not MAIN -- `git push` from MAIN itself would
# update MAIN's own remote-tracking ref as a side effect of the push, making the script's own
# `git fetch` call a no-op in this fixture and the mutant unfalsifiable. Through a separate clone,
# MAIN's local origin/develop stays genuinely stale until the script's fetch actually runs.
OTHER="$WORK/other-clone"
git clone -q "$ORIGIN" "$OTHER"
git -C "$OTHER" config user.email s@s
git -C "$OTHER" config user.name s
echo "advance develop" > "$OTHER/advance.txt"
git -C "$OTHER" add advance.txt
git -C "$OTHER" commit -qm "advance develop past 51a1e099's base"
git -C "$OTHER" push -q origin develop
stale_out="$(run backend --card 51a1e099 2>&1)"
stale_rc=$?
if [ "$stale_rc" = 0 ] && printf '%s' "$stale_out" | grep -q "WARNING: card/51a1e099 is behind origin/develop"; then
  echo "  ok   reattaching a survivor branch behind the current origin tip warns explicitly"
else
  echo "  FAIL expected a stale-base WARNING -> rc=$stale_rc out=$stale_out"; fail=1
fi

n=$((n + 1))
# CONTROL for the case above: a survivor branch that is NOT behind (created from the CURRENT
# origin/develop tip) must NOT warn -- otherwise the check would be blanket-firing on every reuse,
# not actually discriminating stale from fresh. Branched from origin/develop, not MAIN's own local
# develop -- the stale-case run() above only fetched (updating origin/develop), it never fast-
# forwarded MAIN's local develop branch itself, so local develop is ITSELF stale at this point.
git -C "$MAIN" fetch -q origin develop
git -C "$MAIN" worktree add -q -b card/f2e50088 "$ROOT/card/f2e50088" origin/develop >/dev/null
git -C "$MAIN" worktree remove --force "$ROOT/card/f2e50088" >/dev/null
fresh_out="$(run backend --card f2e50088 2>&1)"
fresh_rc=$?
if [ "$fresh_rc" = 0 ] && ! printf '%s' "$fresh_out" | grep -q "WARNING:"; then
  echo "  ok   reattaching a survivor branch that is NOT behind origin/develop does not warn"
else
  echo "  FAIL unexpected warning (or failure) for a non-stale survivor -> rc=$fresh_rc out=$fresh_out"; fail=1
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
  echo "  ok   a card worktree's node_modules stays a symlink without MARVEEN_WORKTREE_REAL_DEPS=1 (same opt-in default as agent mode; see agent-worktree-deps.selftest.sh for the --card real-deps path)"
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

# F6.2 (card 60e5a40e): project_worktree_on_create wiring, exercised through the REAL script
# (not just worktree-on-create.sh standalone -- see that file's own selftest for the library's
# isolated cases). The project is always "marveen" per the script's hardcoded call, so these
# configure $MAIN/store/projects/marveen.json directly.
mkdir -p "$MAIN/store/projects"
cp "$HERE/project-config-schema.py" "$MAIN/store/project-config-schema.py"

n=$((n + 1))
hook_log="$WORK/hook-calls.log"
cat > "$MAIN/good-hook.sh" <<EOF
#!/usr/bin/env bash
echo "\$1" >> "$hook_log"
EOF
chmod +x "$MAIN/good-hook.sh"
printf '{"repo": "%s", "base_branch": "develop", "land_script": "notes.txt", "on_create_script": "good-hook.sh"}\n' "$MAIN" > "$MAIN/store/projects/marveen.json"
run hookagent --card ab12cd34ef >/dev/null
hook_calls_after_create="$(wc -l < "$hook_log" 2>/dev/null || echo 0)"
run hookagent --card ab12cd34ef >/dev/null  # reuse -- must NOT fire the hook again
hook_calls_after_reuse="$(wc -l < "$hook_log" 2>/dev/null || echo 0)"
if [ "$hook_calls_after_create" = "1" ] && [ "$hook_calls_after_reuse" = "1" ]; then
  echo "  ok   through the real script, on_create fires once on creation and not again on reuse"
else
  echo "  FAIL expected 1 call after create and 1 after reuse, got $hook_calls_after_create then $hook_calls_after_reuse"; fail=1
fi

n=$((n + 1))
cat > "$MAIN/bad-hook.sh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$MAIN/bad-hook.sh"
printf '{"repo": "%s", "base_branch": "develop", "land_script": "notes.txt", "on_create_script": "bad-hook.sh"}\n' "$MAIN" > "$MAIN/store/projects/marveen.json"
bad_out="$(run backend --card fedc543210 2>&1)"
bad_rc=$?
if [ "$bad_rc" = 3 ] \
  && printf '%s' "$bad_out" | grep -q "on_create hook failed" \
  && [ ! -e "$ROOT/card/fedc543210" ] \
  && ! git -C "$MAIN" show-ref --verify --quiet "refs/heads/card/fedc543210"; then
  echo "  ok   through the real script, a failing on_create exits 3 and removes the half-made worktree + branch"
else
  echo "  FAIL expected exit 3 + removed worktree/branch -> rc=$bad_rc out=$bad_out"; fail=1
fi

# Restore a harmless config (null hook) so it cannot leak into whatever runs after this file in
# the same process -- not required for this file's own exit code, but keeps the fixture tidy.
printf '{"repo": "%s", "base_branch": "develop", "land_script": "notes.txt", "on_create_script": null}\n' "$MAIN" > "$MAIN/store/projects/marveen.json"

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

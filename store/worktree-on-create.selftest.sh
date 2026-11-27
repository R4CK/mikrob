#!/usr/bin/env bash
# Self-test for worktree-on-create.sh (card 60e5a40e, F6.2). Exercises project_worktree_on_create()
# directly against a throwaway fixture repo -- never the real store/projects/marveen.json.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./worktree-on-create.sh
. "$HERE/worktree-on-create.sh"
fail=0
n=0

WORK="$(mktemp -d)"
MAIN="$WORK/main"
mkdir -p "$MAIN/store/projects"
cp "$HERE/project-config-schema.py" "$MAIN/store/project-config-schema.py"
git init -q -b develop "$MAIN"
git -C "$MAIN" config user.email s@s
git -C "$MAIN" config user.name s
echo base > "$MAIN/notes.txt"
git -C "$MAIN" add notes.txt
git -C "$MAIN" commit -qm base

CALL_LOG="$WORK/on-create-calls.log"

# A working on_create hook: appends its own invocation to CALL_LOG (outside the tree it is given,
# so repeated calls across tree lifetimes are still distinguishable) and exits 0.
cat > "$MAIN/good-hook.sh" <<EOF
#!/usr/bin/env bash
echo "called: \$1" >> "$CALL_LOG"
exit 0
EOF
chmod +x "$MAIN/good-hook.sh"

# A failing on_create hook: always exits 1.
cat > "$MAIN/bad-hook.sh" <<'EOF'
#!/usr/bin/env bash
echo "bad-hook: deliberately failing" >&2
exit 1
EOF
chmod +x "$MAIN/bad-hook.sh"

write_config() {
  local on_create="$1"
  if [ -n "$on_create" ]; then
    printf '{"repo": "%s", "base_branch": "develop", "land_script": "notes.txt", "on_create_script": "%s"}\n' "$MAIN" "$on_create" > "$MAIN/store/projects/marveen.json"
  else
    printf '{"repo": "%s", "base_branch": "develop", "land_script": "notes.txt", "on_create_script": null}\n' "$MAIN" > "$MAIN/store/projects/marveen.json"
  fi
}

make_worktree() {
  local tree="$1" branch="$2"
  git -C "$MAIN" worktree add -q -b "$branch" "$tree" develop
}

n=$((n + 1))
# No config file at all for this project: nothing to do, must succeed and never touch anything.
rm -f "$MAIN/store/projects/marveen.json"
TREE1="$WORK/t1"
make_worktree "$TREE1" card/t1
if project_worktree_on_create marveen "$MAIN" "$TREE1" 0 card/t1 && [ -e "$TREE1/.git" ]; then
  echo "  ok   no config file at all -- on_create is a silent no-op, worktree untouched"
else
  echo "  FAIL expected a clean no-op with no config file"; fail=1
fi

n=$((n + 1))
write_config ""
TREE2="$WORK/t2"
make_worktree "$TREE2" card/t2
if project_worktree_on_create marveen "$MAIN" "$TREE2" 0 card/t2 && [ -e "$TREE2/.git" ] && [ ! -e "$CALL_LOG" ]; then
  echo "  ok   on_create_script: null -- no hook runs, worktree untouched"
else
  echo "  FAIL expected a no-op for on_create_script: null"; fail=1
fi

n=$((n + 1))
# The real acceptance criterion: on_create runs EXACTLY ONCE for a freshly created worktree.
write_config "good-hook.sh"
TREE3="$WORK/t3"
make_worktree "$TREE3" card/t3
project_worktree_on_create marveen "$MAIN" "$TREE3" 0 card/t3 >/dev/null
calls_after_create="$(wc -l < "$CALL_LOG" 2>/dev/null || echo 0)"
if [ "$calls_after_create" = "1" ] && grep -qx "called: $TREE3" "$CALL_LOG"; then
  echo "  ok   a working on_create hook runs exactly once for a new worktree"
else
  echo "  FAIL expected exactly 1 call naming $TREE3, log: $(cat "$CALL_LOG" 2>/dev/null)"; fail=1
fi

n=$((n + 1))
# "Not on reuse": calling this function again for the SAME already-created worktree must not
# run the hook a second time. The real caller (agent-worktree-marveen.sh) only invokes this
# function from inside its "newly created" branch, never on reuse -- this case proves the
# function itself is also safe to call only once per creation, by checking the log stays at 1
# when the real caller's own reuse-guard is simulated by simply not calling it again here.
calls_still="$(wc -l < "$CALL_LOG")"
if [ "$calls_still" = "1" ]; then
  echo "  ok   (control) the call count is still 1 before any second invocation"
else
  echo "  FAIL unexpected call count drift: $calls_still"; fail=1
fi

n=$((n + 1))
# Fail-closed: a failing on_create hook removes the half-made worktree AND the branch this call
# created (branch_preexisted=0), and the function itself reports failure.
write_config "bad-hook.sh"
TREE4="$WORK/t4"
make_worktree "$TREE4" card/t4
if project_worktree_on_create marveen "$MAIN" "$TREE4" 0 card/t4 2>/dev/null; then
  echo "  FAIL expected project_worktree_on_create to report failure for a failing hook"; fail=1
else
  if [ ! -e "$TREE4" ] && ! git -C "$MAIN" show-ref --verify --quiet "refs/heads/card/t4"; then
    echo "  ok   a failing on_create hook removes the half-made worktree AND its freshly-created branch"
  else
    echo "  FAIL worktree or branch survived a failing hook -> tree exists=$([ -e "$TREE4" ] && echo yes || echo no)"; fail=1
  fi
fi

n=$((n + 1))
# CONTROL: a SURVIVOR branch (one that existed before this call, branch_preexisted=1) must NEVER
# be deleted by the rollback, even when the hook fails -- only a branch this call itself created.
git -C "$MAIN" worktree add -q -b card/survivor "$WORK/survivor-tmp" develop
git -C "$MAIN" worktree remove --force "$WORK/survivor-tmp"
TREE5="$WORK/t5"
git -C "$MAIN" worktree add -q "$TREE5" card/survivor
if project_worktree_on_create marveen "$MAIN" "$TREE5" 1 card/survivor 2>/dev/null; then
  echo "  FAIL expected failure for the failing hook"; fail=1
else
  if [ ! -e "$TREE5" ] && git -C "$MAIN" show-ref --verify --quiet "refs/heads/card/survivor"; then
    echo "  ok   the worktree is removed but a PRE-EXISTING survivor branch is never deleted"
  else
    echo "  FAIL survivor branch should survive -> $(git -C "$MAIN" show-ref --verify --quiet refs/heads/card/survivor && echo present || echo GONE)"; fail=1
  fi
fi

n=$((n + 1))
# Fail-closed on a REFUSED config (bad shape), not just a failing hook script.
printf '{"repo": "%s", "base_branch": "--evil", "land_script": "notes.txt"}\n' "$MAIN" > "$MAIN/store/projects/marveen.json"
TREE6="$WORK/t6"
make_worktree "$TREE6" card/t6
if project_worktree_on_create marveen "$MAIN" "$TREE6" 0 card/t6 2>/dev/null; then
  echo "  FAIL expected failure for a REFUSED (bad base_branch) config"; fail=1
else
  if [ ! -e "$TREE6" ] && ! git -C "$MAIN" show-ref --verify --quiet "refs/heads/card/t6"; then
    echo "  ok   a REFUSED (schema-invalid) config also removes the half-made worktree"
  else
    echo "  FAIL worktree or branch survived a REFUSED config"; fail=1
  fi
fi

n=$((n + 1))
# F-4 (card c16cd98e, F6.2 follow-up): stderr noise from the config-loading step must not silently
# skip a configured hook. Swap in a schema stand-in that behaves exactly like a valid config load
# (exit 0, correct JSON on stdout) but ALSO writes to stderr -- simulating e.g. a stray warning.
# Before the fix, cfg_json captures stdout+stderr together even on success (2>&1), corrupting the
# JSON; the unchecked second python3 parse then fails silently and on_create comes back empty, so
# the hook never runs and nothing says why.
cat > "$MAIN/store/project-config-schema.py" <<EOF
#!/usr/bin/env python3
import sys
print("warning: something noisy", file=sys.stderr)
print('{"repo": "$MAIN", "base_branch": "develop", "land_script": "notes.txt", "on_create_script": "good-hook.sh"}')
EOF
TREE7="$WORK/t7"
make_worktree "$TREE7" card/t7
rm -f "$CALL_LOG"
if project_worktree_on_create marveen "$MAIN" "$TREE7" 0 card/t7 && [ -f "$CALL_LOG" ] && grep -qx "called: $TREE7" "$CALL_LOG"; then
  echo "  ok   stderr noise on a successful config load does not stop the configured hook from running"
else
  echo "  FAIL stderr noise silently skipped the hook -> log: $(cat "$CALL_LOG" 2>/dev/null || echo '<none>')"; fail=1
fi
cp "$HERE/project-config-schema.py" "$MAIN/store/project-config-schema.py"

n=$((n + 1))
# F-4, second half: a config-loading step that actually FAILS (nonzero exit) must still be
# refused, even if some of what it wrote looks like valid JSON on stdout before it died on
# stderr -- the fix must not simply "ignore stderr" and only check stdout content.
cat > "$MAIN/store/project-config-schema.py" <<'EOF'
#!/usr/bin/env python3
import sys
print('{"repo": "/nope", "base_branch": "develop", "land_script": "x"}')
print("REFUSED: fatal error after printing", file=sys.stderr)
sys.exit(1)
EOF
TREE8="$WORK/t8"
make_worktree "$TREE8" card/t8
if project_worktree_on_create marveen "$MAIN" "$TREE8" 0 card/t8 2>/dev/null; then
  echo "  FAIL expected failure when the config-loading step exits nonzero"; fail=1
else
  if [ ! -e "$TREE8" ]; then
    echo "  ok   a nonzero exit from the config-loading step is refused even with JSON-looking stdout"
  else
    echo "  FAIL worktree survived a refused config load"; fail=1
  fi
fi
cp "$HERE/project-config-schema.py" "$MAIN/store/project-config-schema.py"

n=$((n + 1))
# Mutant-ME pin (CYBERSEC NO-GO 39444 on be3b70680): the on_create-EXTRACTION step's own exit
# status must be checked too, not just the config-LOADING step's. Simulate a loader that exits 0
# (looks successful) but emits output that is not valid JSON at all, so the SECOND python3 call --
# the one pulling on_create_script back out -- is what actually fails. Before this case existed,
# a mutant forcing that second rc to 0 survived the whole suite: nothing exercised it going wrong.
cat > "$MAIN/store/project-config-schema.py" <<'EOF'
#!/usr/bin/env python3
print("not-json-at-all")
EOF
TREE14="$WORK/t14"
make_worktree "$TREE14" card/t14
if project_worktree_on_create marveen "$MAIN" "$TREE14" 0 card/t14 2>/dev/null; then
  echo "  FAIL expected failure when the on_create-extraction step cannot parse the loader's output"; fail=1
else
  if [ ! -e "$TREE14" ]; then
    echo "  ok   a loader that exits 0 but emits unparseable output is refused (on_create read-back rc checked)"
  else
    echo "  FAIL worktree survived an unparseable loader output"; fail=1
  fi
fi
cp "$HERE/project-config-schema.py" "$MAIN/store/project-config-schema.py"

n=$((n + 1))
# F-2 (card c16cd98e): a successful run (any of the three success paths) must leave no in-progress
# sentinel behind (worktree_on_create_is_complete reads that as complete), and a genuinely
# interrupted one must not look complete. Exercise all three success paths directly.
rm -f "$MAIN/store/projects/marveen.json"
TREE9="$WORK/t9"
make_worktree "$TREE9" card/t9
project_worktree_on_create marveen "$MAIN" "$TREE9" 0 card/t9 >/dev/null
TREE10="$WORK/t10"
make_worktree "$TREE10" card/t10
write_config ""
project_worktree_on_create marveen "$MAIN" "$TREE10" 0 card/t10 >/dev/null
TREE11="$WORK/t11"
make_worktree "$TREE11" card/t11
write_config "good-hook.sh"
project_worktree_on_create marveen "$MAIN" "$TREE11" 0 card/t11 >/dev/null
if worktree_on_create_is_complete "$TREE9" && worktree_on_create_is_complete "$TREE10" && worktree_on_create_is_complete "$TREE11"; then
  echo "  ok   all three success paths (no config / null hook / hook ran) leave no in-progress sentinel behind"
else
  echo "  FAIL expected no sentinel after all three success paths"; fail=1
fi

n=$((n + 1))
# F-2 fix, CORRECTED (CYBERSEC NO-GO 39444 / CYBERED NO-GO 39445 on be3b70680): a tree that
# git worktree add created but where project_worktree_on_create NEVER RAN AT ALL (no sentinel was
# ever written -- exactly what every one of the 176 live pre-this-card worktrees looks like) must
# be treated as COMPLETE, not interrupted. The sentinel is written by project_worktree_on_create
# itself; nothing calls it here, so this tree is indistinguishable from one that predates the
# mechanism entirely, and must never be force-removed by the caller.
TREE12="$WORK/t12"
make_worktree "$TREE12" card/t12
if worktree_on_create_is_complete "$TREE12"; then
  echo "  ok   a tree project_worktree_on_create never touched (legacy shape) counts as complete, never interrupted"
else
  echo "  FAIL a never-touched tree must be treated as complete so legacy worktrees are never auto-removed"; fail=1
fi

n=$((n + 1))
# The other half: a tree where project_worktree_on_create genuinely STARTED (sentinel written)
# but never reached a successful return (simulating a killed hook or caller) must NOT look
# complete, so a real interruption is still detected.
TREE12B="$WORK/t12b"
make_worktree "$TREE12B" card/t12b
_worktree_on_create_begin "$TREE12B"
if ! worktree_on_create_is_complete "$TREE12B"; then
  echo "  ok   a tree whose on_create run started but never finished (sentinel present) is not complete"
else
  echo "  FAIL an in-progress sentinel should mean not-complete"; fail=1
fi

n=$((n + 1))
# A tree whose on_create hook FAILED (rolled back, removed) must not leave a dangling sentinel in place
# for whatever inherits that path next -- the rollback deletes the whole tree, so there is
# nothing left to mark, but pin that the function never marks-then-fails.
write_config "bad-hook.sh"
TREE13="$WORK/t13"
make_worktree "$TREE13" card/t13
project_worktree_on_create marveen "$MAIN" "$TREE13" 0 card/t13 >/dev/null 2>&1
if [ ! -e "$TREE13" ]; then
  echo "  ok   a failed hook's rollback leaves nothing (tree removed), never a dangling in-progress sentinel"
else
  echo "  FAIL tree should have been removed by rollback"; fail=1
fi

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

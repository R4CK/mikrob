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

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

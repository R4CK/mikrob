#!/usr/bin/env bash
# Self-test for store/agent-worktree.sh's per-entry node_modules linking (card 80d3a2af).
#
# Run: bash store/agent-worktree.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# THE DEFECT: each package dir's node_modules was symlinked WHOLE into $MAIN. pnpm writes
# @cleancore/<pkg> workspace entries as RELATIVE symlinks (../../../../packages/<pkg>), which resolve
# from where the link FILE lives on disk -- so with the whole directory living in $MAIN, every
# @cleancore/* import resolved to $MAIN/packages/<pkg> no matter which worktree ran the test, silently
# testing the SHARED clone's code instead of the worktree's own. Measured live on
# apps/api/src/pg-proof-photo-worm-marker.test.ts.
#
# HERMETIC: CLEANCORE_MAIN and CLEANCORE_WORKTREES both point at throwaway dirs under a mktemp -d --
# no real CleanCore clone or worktree is touched.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/agent-worktree.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

MAIN="$TMP/main"
WORKTREES="$TMP/worktrees"
run() { CLEANCORE_MAIN="$MAIN" CLEANCORE_WORKTREES="$WORKTREES" bash "$RUN" "$@"; }

# --- build a fake CleanCore MAIN clone -------------------------------------------------------------
mkdir -p "$MAIN/apps/api" "$MAIN/packages/foo"
git init -q "$MAIN"
git -C "$MAIN" -c user.email=t@t -c user.name=t checkout -q -b main 2>/dev/null || true

cat > "$MAIN/package.json" <<'EOF'
{"name":"cleancore","private":true}
EOF
cat > "$MAIN/packages/foo/package.json" <<'EOF'
{"name":"@cleancore/foo"}
EOF
echo "module.exports = 'from-main'" > "$MAIN/packages/foo/index.js"
cat > "$MAIN/apps/api/package.json" <<'EOF'
{"name":"@cleancore/api"}
EOF

# apps/api/node_modules: one workspace entry (relative symlink, exactly pnpm's shape) + one external.
mkdir -p "$MAIN/apps/api/node_modules/@cleancore"
ln -s ../../../../packages/foo "$MAIN/apps/api/node_modules/@cleancore/foo"
mkdir -p "$MAIN/apps/api/node_modules/some-external-dep"
echo "external-marker" > "$MAIN/apps/api/node_modules/some-external-dep/marker.txt"

# root node_modules: external only, matching the real repo's layout.
mkdir -p "$MAIN/node_modules/root-external-dep"
echo "root-external-marker" > "$MAIN/node_modules/root-external-dep/marker.txt"

# node_modules is never git-tracked in the real repo -- only add the source files, or
# `git worktree add` would check the fixture's fake node_modules out of the INDEX directly and the
# function under test would never run on them (its -e pre-check would see them already present).
git -C "$MAIN" add package.json apps/api/package.json packages/foo/package.json packages/foo/index.js
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -q -m seed

# agent-worktree.sh fetches+branches off origin/main -- give the fake MAIN clone a real origin.
BARE="$TMP/origin.git"
git init -q --bare "$BARE"
git -C "$MAIN" remote add origin "$BARE"
git -C "$MAIN" push -q origin main

# --- 1. basic creation still works ------------------------------------------------------------------
out="$(run testagent 2>&1)"; rc=$?
TREE="$WORKTREES/testagent"
[[ $rc -eq 0 ]] && ok "worktree creation exits 0" || bad "creation failed (rc=$rc)" "$out"
[ -e "$TREE/.git" ] && ok "the created tree is a real git worktree" || bad "no .git in the created tree"

# --- 2. THE CORE FIX: apps/api/node_modules is a REAL directory, not a whole-dir symlink ------------
[ -L "$TREE/apps/api/node_modules" ] && bad "apps/api/node_modules is still a whole-directory symlink into \$MAIN" \
  || ok "apps/api/node_modules is a real directory (not a whole-dir symlink)"

# --- 3. a workspace (@cleancore/*) entry resolves into the WORKTREE'S OWN packages/, not \$MAIN's ----
link_target="$(readlink -f "$TREE/apps/api/node_modules/@cleancore/foo" 2>/dev/null)"
own_pkg="$(readlink -f "$TREE/packages/foo" 2>/dev/null)"
main_pkg="$(readlink -f "$MAIN/packages/foo" 2>/dev/null)"
if [ "$link_target" = "$own_pkg" ] && [ "$link_target" != "$main_pkg" ]; then
  ok "apps/api/node_modules/@cleancore/foo resolves to the worktree's OWN packages/foo"
else
  bad "the workspace entry does not resolve to the worktree's own copy" \
    "link=$link_target own=$own_pkg main=$main_pkg"
fi

# --- 4. CONTENT PROOF: editing the worktree's OWN packages/foo is visible through node_modules -------
# This is the case that was silently invisible before the fix (pg-proof-photo-worm-marker.test.ts).
echo "module.exports = 'from-worktree'" > "$TREE/packages/foo/index.js"
seen="$(cat "$TREE/apps/api/node_modules/@cleancore/foo/index.js" 2>/dev/null)"
[ "$seen" = "module.exports = 'from-worktree'" ] \
  && ok "editing the worktree's own package is visible through its node_modules import path" \
  || bad "node_modules/@cleancore/foo still shows \$MAIN's content, not the worktree's edit" "$seen"

# --- 5. an EXTERNAL entry still points at \$MAIN -- no duplication, no reinstall ----------------------
ext_target="$(readlink -f "$TREE/apps/api/node_modules/some-external-dep" 2>/dev/null)"
main_ext="$(readlink -f "$MAIN/apps/api/node_modules/some-external-dep" 2>/dev/null)"
[ "$ext_target" = "$main_ext" ] \
  && ok "an external (non-workspace) entry still resolves to \$MAIN, shared, not duplicated" \
  || bad "an external entry was duplicated or misrouted instead of pointing at \$MAIN" "$ext_target vs $main_ext"

# --- 6. root node_modules gets the same per-entry treatment (symmetry with per-package dirs) --------
[ -L "$TREE/node_modules" ] && bad "root node_modules is still a whole-directory symlink" \
  || ok "root node_modules is a real directory too"
root_ext="$(readlink -f "$TREE/node_modules/root-external-dep" 2>/dev/null)"
main_root_ext="$(readlink -f "$MAIN/node_modules/root-external-dep" 2>/dev/null)"
[ "$root_ext" = "$main_root_ext" ] && ok "root node_modules external entry still points at \$MAIN" \
  || bad "root node_modules external entry misrouted" "$root_ext vs $main_root_ext"

# --- 7. MIGRATION: an existing OLD-style whole-dir symlink (a pre-fix worktree) gets healed -----------
git -C "$MAIN" worktree add -q "$WORKTREES/legacy-agent" -b agent/legacy-agent/work origin/main
rm -rf "$WORKTREES/legacy-agent/apps/api/node_modules"
ln -s "$MAIN/apps/api/node_modules" "$WORKTREES/legacy-agent/apps/api/node_modules"
[ -L "$WORKTREES/legacy-agent/apps/api/node_modules" ] || bad "test setup failed: legacy symlink not created" ""
run legacy-agent >/dev/null 2>&1
if [ -L "$WORKTREES/legacy-agent/apps/api/node_modules" ]; then
  bad "a pre-existing legacy worktree was NOT migrated off the whole-dir symlink"
else
  ok "a pre-existing legacy whole-dir symlink is migrated to the per-entry layout on the next run"
  legacy_link="$(readlink -f "$WORKTREES/legacy-agent/apps/api/node_modules/@cleancore/foo" 2>/dev/null)"
  legacy_own="$(readlink -f "$WORKTREES/legacy-agent/packages/foo" 2>/dev/null)"
  [ "$legacy_link" = "$legacy_own" ] && ok "the migrated legacy worktree now resolves @cleancore/foo to its own copy" \
    || bad "the migrated legacy worktree still resolves elsewhere" "$legacy_link vs $legacy_own"
fi

# --- 8. IDEMPOTENT RE-RUN: running twice does not error, and a NEW external dep is picked up ----------
mkdir -p "$MAIN/apps/api/node_modules/newly-added-dep"
echo "new" > "$MAIN/apps/api/node_modules/newly-added-dep/marker.txt"
out="$(run testagent 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && ok "a second run is idempotent (exit 0)" || bad "second run failed (rc=$rc)" "$out"
[ -e "$TREE/apps/api/node_modules/newly-added-dep/marker.txt" ] \
  && ok "a dependency added to \$MAIN after creation is picked up on top-up" \
  || bad "the newly-added dependency was not linked on top-up"
# ...and the earlier fix (own-copy resolution, external-dep sharing) is still intact after the re-run.
still_seen="$(cat "$TREE/apps/api/node_modules/@cleancore/foo/index.js" 2>/dev/null)"
[ "$still_seen" = "module.exports = 'from-worktree'" ] \
  && ok "the worktree's own package content is still visible after an idempotent re-run" \
  || bad "the idempotent re-run reverted the worktree back to \$MAIN's content" "$still_seen"

# --- 9. a workspace entry with NO matching package under \$MAIN falls back instead of crashing --------
mkdir -p "$MAIN/apps/api/node_modules/@cleancore"
ln -sfn ../../../../packages/gone "$MAIN/apps/api/node_modules/@cleancore/gone"
out="$(run testagent 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && ok "an unresolvable workspace entry does not crash the run" || bad "run crashed on an unresolvable workspace entry (rc=$rc)" "$out"
# -L, not -e: the fallback link is created, but its target ($MAIN's own dangling packages/gone
# symlink) does not exist either -- that is the pre-existing state in $MAIN, not this script's job to
# fix. What matters here is that the entry is not silently dropped.
[ -L "$TREE/apps/api/node_modules/@cleancore/gone" ] \
  && ok "the unresolvable entry falls back to a link (not silently dropped)" \
  || bad "the unresolvable entry vanished instead of falling back"

echo
echo "agent-worktree.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]

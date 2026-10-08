#!/usr/bin/env bash
# Self-test for store/agent-worktree-mopsi.sh (card 7feb477b).
#
# WHAT THIS DOES AND DOES NOT COVER. agent-worktree-mopsi.sh is a THIN WRAPPER: its only job is to
# export CLEANCORE_MAIN/CLEANCORE_WORKTREES pointed at the Mopsi clone/worktree root and exec
# agent-worktree.sh. The underlying script's own logic (per-entry node_modules linking, hooks
# isolation, worktree creation) is ALREADY hermetically selftested by agent-worktree.selftest.sh --
# re-proving that here would duplicate, not add, coverage. This file proves only the wrapper's own
# job: that env var overrides and defaults resolve to the right Mopsi paths and are actually passed
# through (not read, not forwarded).
#
# Run: bash store/agent-worktree-mopsi.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/agent-worktree-mopsi.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

# --- defaults, unset env: --path exits before agent-worktree.sh ever needs a real clone to exist ---
out="$(env -u MOPSI_MAIN -u MOPSI_WORKTREES -u CLEANCORE_MAIN -u CLEANCORE_WORKTREES bash "$RUN" backend3 --path 2>&1)"
if [ "$out" = "/mnt/h/LM_Studio_Workdir/Mopsi-worktrees/backend3" ]; then
  ok "default MOPSI_WORKTREES resolves to the documented path"
else
  bad "default MOPSI_WORKTREES path" "got [$out]"
fi

# --- override: a throwaway root, proving the override reaches agent-worktree.sh ---------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
out="$(env -u CLEANCORE_MAIN -u CLEANCORE_WORKTREES \
  MOPSI_MAIN="$TMP/main" MOPSI_WORKTREES="$TMP/worktrees" bash "$RUN" backend3 --path 2>&1)"
if [ "$out" = "$TMP/worktrees/backend3" ]; then
  ok "MOPSI_WORKTREES override reaches agent-worktree.sh as CLEANCORE_WORKTREES"
else
  bad "MOPSI_WORKTREES override" "got [$out]"
fi

# --- a pre-set CLEANCORE_MAIN/CLEANCORE_WORKTREES is OVERWRITTEN by the wrapper, not merely
# defaulted-if-unset -- the wrapper is Mopsi-specific and must not silently inherit a caller's
# mopsion-pointed env from an earlier `export` in the same shell session. ---------------------------
out="$(CLEANCORE_MAIN=/should/not/survive CLEANCORE_WORKTREES=/should/not/survive \
  MOPSI_MAIN="$TMP/main" MOPSI_WORKTREES="$TMP/worktrees" bash "$RUN" backend3 --path 2>&1)"
if [ "$out" = "$TMP/worktrees/backend3" ]; then
  ok "wrapper overwrites a stale CLEANCORE_* already set in the caller's environment"
else
  bad "stale CLEANCORE_* override" "got [$out]"
fi

echo
echo "agent-worktree-mopsi.selftest: $pass ok, $fail failed"
[ "$fail" -eq 0 ]

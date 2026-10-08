#!/usr/bin/env bash
# Self-test for store/mopsi-gate-worktree.sh (card 7feb477b).
#
# WHAT THIS DOES AND DOES NOT COVER. mopsi-gate-worktree.sh is a THIN WRAPPER: its only job is to
# export CLEANCORE_MAIN (and, if set, CC_GATE_ROOT) and exec mopsion-gate-worktree.sh. The
# underlying script's own collision/ownership/removal logic is ALREADY hermetically selftested by
# mopsion-gate-worktree.selftest.sh -- re-proving that here would duplicate, not add, coverage.
# This file proves only the wrapper's own job: env var delegation to the right Mopsi clone/root,
# with a REAL (throwaway) worktree created and removed, so the delegation is proven end to end
# rather than merely echoed back like the --path-only check would give.
#
# HERMETIC: MOPSI_MAIN and MOPSI_GATE_ROOT both point at throwaway temp dirs -- no real Mopsi
# clone or gate worktree is touched.
#
# Run: bash store/mopsi-gate-worktree.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/mopsi-gate-worktree.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git init -q "$TMP/main" 2>/dev/null
git -C "$TMP/main" config user.email s@s; git -C "$TMP/main" config user.name s
echo hi > "$TMP/main/f.txt"
git -C "$TMP/main" add f.txt
git -C "$TMP/main" commit -q -m base
SHA="$(git -C "$TMP/main" rev-parse HEAD)"

# --- --path resolves under MOPSI_GATE_ROOT, not the wrapped script's own default ($HOME) ----------
out="$(env -u CLEANCORE_MAIN -u CC_GATE_ROOT \
  MOPSI_MAIN="$TMP/main" MOPSI_GATE_ROOT="$TMP/gates" \
  bash "$RUN" --agent selftest --path cardx "$SHA" 2>&1)"
want="$TMP/gates/cc-gate-cardx-selftest-${SHA:0:7}"
if [ "$out" = "$want" ]; then
  ok "MOPSI_GATE_ROOT override reaches mopsion-gate-worktree.sh as CC_GATE_ROOT"
else
  bad "MOPSI_GATE_ROOT override" "got [$out] want [$want]"
fi

# --- a real (throwaway) create + remove round-trip, proving MOPSI_MAIN actually reaches the
# clone the worktree is built FROM, not just the path computation -------------------------------
create_out="$(env -u CLEANCORE_MAIN -u CC_GATE_ROOT \
  MOPSI_MAIN="$TMP/main" MOPSI_GATE_ROOT="$TMP/gates" \
  bash "$RUN" --agent selftest cardx "$SHA" 2>&1)"
if [ -d "$want/.git" ] || [ -f "$want/.git" ]; then
  ok "a real worktree was created at the MOPSI_GATE_ROOT-derived path"
else
  bad "worktree creation" "$create_out"
fi
if [ -f "$want/f.txt" ] && [ "$(cat "$want/f.txt" 2>/dev/null)" = "hi" ]; then
  ok "the worktree checked out MOPSI_MAIN's own commit, not some other repo"
else
  bad "worktree content" "f.txt missing or wrong content under $want"
fi

remove_out="$(env -u CLEANCORE_MAIN -u CC_GATE_ROOT \
  MOPSI_MAIN="$TMP/main" MOPSI_GATE_ROOT="$TMP/gates" \
  bash "$RUN" --agent selftest --remove "$want" 2>&1)"
if [ ! -e "$want" ]; then
  ok "--remove tore down the worktree created under MOPSI_GATE_ROOT"
else
  bad "worktree removal" "$remove_out"
fi

# --- unset MOPSI_GATE_ROOT falls back to the wrapped script's own default (CC_GATE_ROOT unset ->
# $HOME), proving the wrapper does not force a Mopsi-specific root when the operator did not ask
# for one ------------------------------------------------------------------------------------------
out="$(env -u CLEANCORE_MAIN -u CC_GATE_ROOT -u MOPSI_GATE_ROOT \
  MOPSI_MAIN="$TMP/main" bash "$RUN" --agent selftest --path cardy "$SHA" 2>&1)"
want_default="$HOME/cc-gate-cardy-selftest-${SHA:0:7}"
if [ "$out" = "$want_default" ]; then
  ok "unset MOPSI_GATE_ROOT falls back to the wrapped script's own \$HOME default"
else
  bad "default gate root fallback" "got [$out] want [$want_default]"
fi

echo
echo "mopsi-gate-worktree.selftest: $pass ok, $fail failed"
[ "$fail" -eq 0 ]

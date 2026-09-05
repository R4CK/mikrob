#!/usr/bin/env bash
# Self-test for store/cc-gate-worktree.sh's COLLISION and OWNERSHIP rules (card a7da80d6).
#
# Run: bash store/cc-gate-worktree.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# THE DEFECT: the worktree path was card+sha only, so two gates reviewing the same card at the same
# sha -- the normal case, since QA and Cybersec/Cybered gate together -- got the SAME directory, and
# `--remove` by whichever finished first killed every process whose cwd was inside and deleted the
# tree. The victim saw no error: just a suite that stopped and a checkout that was gone.
#
# HERMETIC: CLEANCORE_MAIN points at a throwaway git repo and CC_GATE_ROOT at a temp dir, so no real
# worktree, process or clone is touched. The one case that must not be faked is the kill: it uses a
# REAL sleeping process with its cwd inside the target, because "the refusal happens BEFORE the kill
# loop" is an ordering claim, and only a live process can prove ordering.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/cc-gate-worktree.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
HOLDER=""
cleanup() { [ -n "$HOLDER" ] && kill -9 "$HOLDER" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

# A throwaway "main clone" with one commit, so rev-parse --short resolves.
git init -q "$TMP/main" 2>/dev/null
git -C "$TMP/main" -c user.email=t@t -c user.name=t commit -q --allow-empty -m seed 2>/dev/null
SHA="$(git -C "$TMP/main" rev-parse HEAD)"
SHORT="$(git -C "$TMP/main" rev-parse --short HEAD)"
mkdir -p "$TMP/gates"
run() { CLEANCORE_MAIN="$TMP/main" CC_GATE_ROOT="$TMP/gates" bash "$RUN" "$@"; }

# --- 1. the agent is REQUIRED -------------------------------------------------------------------
out="$(run --path card1 "$SHA" 2>&1)"; rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q 'agent name is REQUIRED'; then
  ok "no agent -> exit 2, and the message names the fix"
else
  bad "a missing agent was not refused (rc=$rc)" "$out"
fi

# --- 2. TWO GATES ON THE SAME CARD+SHA GET DIFFERENT PATHS -- the whole card -------------------
a="$(run --agent qa --path card1 "$SHA" 2>&1)"
b="$(run --agent cybered --path card1 "$SHA" 2>&1)"
if [ -n "$a" ] && [ "$a" != "$b" ]; then
  ok "same card + same sha, two agents -> two different worktrees ($(basename "$a") vs $(basename "$b"))"
else
  bad "two gates still collide on one path" "qa=$a cybered=$b"
fi
# ...and the same agent asking twice gets the SAME path, or "create or top up" would break.
[ "$a" = "$(run --agent qa --path card1 "$SHA" 2>&1)" ] \
  && ok "the same agent gets a STABLE path (idempotent create/top-up still works)" \
  || bad "the path is not stable for one agent"
# The agent must actually be IN the path -- otherwise case 2 could pass by accident.
echo "$a" | grep -q -- "-qa-$SHORT" && ok "the agent segment is in the path, between card and sha" \
  || bad "the path does not carry the agent segment" "$a"

# --- 3. CC_GATE_AGENT works too, so a gate can set it once per session --------------------------
env_path="$(CLEANCORE_MAIN="$TMP/main" CC_GATE_ROOT="$TMP/gates" CC_GATE_AGENT=qa bash "$RUN" --path card1 "$SHA" 2>&1)"
[ "$env_path" = "$a" ] && ok "CC_GATE_AGENT is equivalent to --agent" || bad "env var path differs" "$env_path vs $a"

# --- 4. THE ORDERING CLAIM: a foreign tree is refused BEFORE anything is killed -----------------
victim="$TMP/gates/cc-gate-card1-cybered-$SHORT"
mkdir -p "$victim"
( cd "$victim" && exec sleep 300 ) & HOLDER=$!
sleep 0.5
out="$(run --agent qa --remove "$victim" 2>&1)"; rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q "not qa's worktree"; then
  ok "removing a PEER's worktree is refused (exit 2)"
else
  bad "a peer's worktree was not refused (rc=$rc)" "$out"
fi
kill -0 "$HOLDER" 2>/dev/null && ok "the peer's running process is STILL ALIVE -- the refusal precedes the kill" \
  || bad "the peer's process was killed despite the refusal"
[ -d "$victim" ] && ok "the peer's worktree still exists" || bad "the peer's worktree was deleted"

# --- 5. your OWN tree is still removable, and its strays still get stopped ----------------------
# The kill loop is a WANTED feature (orphan vite holding a port); this proves the fix narrowed it to
# your own tree rather than disabling it.
mine="$TMP/gates/cc-gate-card1-qa-$SHORT"
mkdir -p "$mine"
( cd "$mine" && exec sleep 300 ) & own=$!
sleep 0.5
out="$(run --agent qa --remove "$mine" 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && ok "your own worktree is removed (exit 0)" || bad "own removal failed (rc=$rc)" "$out"
sleep 0.3
kill -0 "$own" 2>/dev/null && { bad "your own stray was NOT stopped -- the cleanup feature was lost"; kill -9 "$own" 2>/dev/null; } \
  || ok "your own stray process IS still stopped -- the orphan-vite cleanup survives"
[ -d "$mine" ] && bad "own worktree still present" || ok "your own worktree is gone"

# --- 6. --force is the deliberate escape hatch, and it is NOT the default -----------------------
other="$TMP/gates/cc-gate-card1-cybered-$SHORT"
run --agent qa --force --remove "$other" >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 ]] && ok "--force removes a foreign tree deliberately" || bad "--force did not work (rc=$rc)"

echo
echo "cc-gate-worktree.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]

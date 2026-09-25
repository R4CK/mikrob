#!/usr/bin/env bash
# Self-test for the off/warn/enforce Suite-SHA evidence gate wired into mopsion-land.sh (card
# 08eb6402, MikroB plan-grilling verdict 6011/3748). Runs the REAL mopsion-land.sh end to end
# against a minimal scratch repo (--skip-typecheck/--skip-bundle/--allow-ungated keep the fixture
# to what this specific gate needs, the same proportionate-fixture choice
# landing-gate-verdict-check.selftest.sh's own land_case already made for the gate one door over).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAND="$HERE/mopsion-land.sh"
fail=0
n=0

WORK="$(mktemp -d)"
MAIN="$WORK/main"
git init -q -b main "$MAIN"
git -C "$MAIN" config user.email s@s
git -C "$MAIN" config user.name s
echo base > "$MAIN/notes.txt"
git -C "$MAIN" add "$MAIN/notes.txt"
git -C "$MAIN" commit -qm base

ORIGIN="$WORK/origin.git"
git init -q --bare -b main "$ORIGIN"
git -C "$MAIN" remote add origin "$ORIGIN"
git -C "$MAIN" push -q origin main

git -C "$MAIN" checkout -q -b work-branch
echo "work change" >> "$MAIN/notes.txt"
git -C "$MAIN" add "$MAIN/notes.txt"
git -C "$MAIN" commit -qm "the gated work"
SHA="$(git -C "$MAIN" rev-parse work-branch)"
git -C "$MAIN" checkout -q main

MODE_FILE="$WORK/mode.json"
STORE="$WORK/evidence.jsonl"
WARN_LOG="$WORK/warn.log"

land() { # $1 = card
  CLEANCORE_MAIN="$MAIN" GATE_CHECK_TOKEN_FILE=/nonexistent/token \
    MOPSION_SUITE_EVIDENCE_MODE_FILE="$MODE_FILE" \
    SUITE_EVIDENCE_STORE="$STORE" \
    MOPSION_SUITE_EVIDENCE_WARN_LOG="$WARN_LOG" \
    bash "$LAND" "$1" "$SHA" --dry-run --allow-ungated --skip-typecheck --skip-bundle
}

case_() { # $1 label, $2 mode, $3 card, $4 expected exit code, $5 grep pattern expected in output
  n=$((n + 1))
  echo "{\"mode\":\"$2\"}" > "$MODE_FILE"
  local out rc
  out="$(land "$3" 2>&1)"
  rc=$?
  if [ "$rc" = "$4" ] && printf '%s' "$out" | grep -q "$5"; then
    echo "  ok   $1"
  else
    echo "  FAIL $1 -> expected rc=$4 and /$5/, got rc=$rc:"
    printf '%s\n' "$out" | tail -5 | sed 's/^/       /'
    fail=1
  fi
}

echo "mopsion-suite-evidence-gate selftest"

case_ "off mode: no evidence, no check at all, proceeds" \
  "off" "card-off" 0 "DRY-RUN: not pushing"
n=$((n + 1))
if [ -s "$WARN_LOG" ]; then
  echo "  FAIL off mode must not touch the warn log"; fail=1
else
  echo "  ok   off mode never writes to the warn/gap log"
fi

case_ "warn mode: no evidence -> PROCEEDS anyway (never blocks)" \
  "warn" "card-warn" 0 "DRY-RUN: not pushing"
n=$((n + 1))
if grep -q "card-warn" "$WARN_LOG"; then
  echo "  ok   warn mode logged the gap for later measurement"
else
  echo "  FAIL warn mode did not log the gap"; fail=1
fi

case_ "enforce mode: no evidence -> REFUSES (exit 3), names the fix" \
  "enforce" "card-enforce-missing" 3 "no full-suite evidence covers this merge's tree"

# Discover the tree hash the merge ACTUALLY produces, so the fixture evidence record matches it.
# mopsion-land.sh's own throwaway worktree is removed on exit, so re-derive the tree the same way
# it builds it: a --no-ff merge of work-branch into origin/main is deterministic given identical
# parents/content.
TMP_MERGE_WT="$WORK/tree-check"
git -C "$MAIN" worktree add --detach -q "$TMP_MERGE_WT" origin/main
git -C "$TMP_MERGE_WT" merge --no-ff -q -m "merge: check" "$SHA"
TREE="$(git -C "$TMP_MERGE_WT" rev-parse HEAD^{tree})"
git -C "$MAIN" worktree remove --force "$TMP_MERGE_WT" >/dev/null 2>&1

printf 'setup\n Test Files  1 passed (1)\n      Tests  5 passed (5)\n' > "$WORK/fake.log"
SUITE_EVIDENCE_STORE="$STORE" python3 "$HERE/suite-evidence-record.py" record \
  --sha "$SHA" --tree "$TREE" --agent selftest \
  --main-log "$WORK/fake.log" --main-status 0 \
  --store "$STORE" --log-dir "$WORK/logs" >/dev/null

case_ "enforce mode: matching PASS evidence for this tree -> PROCEEDS" \
  "enforce" "card-enforce-present" 0 "suite-evidence: PRESENT"

# An ANOMALY record (no summary line -- the incomplete/birpc shape) must refuse in enforce mode
# exactly like MISSING does -- an anomaly is never read as a pass.
printf 'no summary here at all\n' > "$WORK/anomaly.log"
git -C "$MAIN" checkout -q -b work-branch-2 main
echo "second work change" >> "$MAIN/notes.txt"
git -C "$MAIN" add "$MAIN/notes.txt"
git -C "$MAIN" commit -qm "second gated work"
SHA2="$(git -C "$MAIN" rev-parse work-branch-2)"
git -C "$MAIN" checkout -q main
TMP_MERGE_WT2="$WORK/tree-check-2"
git -C "$MAIN" worktree add --detach -q "$TMP_MERGE_WT2" origin/main
git -C "$TMP_MERGE_WT2" merge --no-ff -q -m "merge: check2" "$SHA2"
TREE2="$(git -C "$TMP_MERGE_WT2" rev-parse HEAD^{tree})"
git -C "$MAIN" worktree remove --force "$TMP_MERGE_WT2" >/dev/null 2>&1
SUITE_EVIDENCE_STORE="$STORE" python3 "$HERE/suite-evidence-record.py" record \
  --sha "$SHA2" --tree "$TREE2" --agent selftest \
  --main-log "$WORK/anomaly.log" --main-status 137 \
  --store "$STORE" --log-dir "$WORK/logs" >/dev/null

n=$((n + 1))
echo '{"mode":"enforce"}' > "$MODE_FILE"
out="$(CLEANCORE_MAIN="$MAIN" GATE_CHECK_TOKEN_FILE=/nonexistent/token \
  MOPSION_SUITE_EVIDENCE_MODE_FILE="$MODE_FILE" SUITE_EVIDENCE_STORE="$STORE" \
  MOPSION_SUITE_EVIDENCE_WARN_LOG="$WARN_LOG" \
  bash "$LAND" card-enforce-anomaly "$SHA2" --dry-run --allow-ungated --skip-typecheck --skip-bundle 2>&1)"
rc=$?
if [ "$rc" = 3 ] && printf '%s' "$out" | grep -q "ANOMALY"; then
  echo "  ok   enforce mode: an ANOMALY record refuses too (never read as a pass)"
else
  echo "  FAIL expected rc=3 and ANOMALY in output, got rc=$rc: $(printf '%s' "$out" | tail -3)"
  fail=1
fi

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

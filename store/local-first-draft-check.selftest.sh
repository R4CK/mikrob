#!/usr/bin/env bash
# Self-test for local-first-draft-check.sh (card d57d8a01, Peti Telegram 10951): the shared helper
# every local-first entry point reads as its FIRST step, and a mutation-pinning sweep across all
# seven real callers -- the card's own explicit acceptance test ("a kapcsolo minden belepesi
# pontot leallit").
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
n=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. the helper function itself ---------------------------------------------------------------

n=$((n + 1))
if (
  . "$HERE/local-first-draft-check.sh"
  LOCAL_FIRST_DRAFT_FLAG_FILE="$WORK/no-such-file.json"
  local_first_draft_enabled
); then
  echo "  ok   absent flag file = ENABLED (plan-grilling point 2: absence = ON)"
else
  echo "  FAIL absent flag file should be enabled"; fail=1
fi

n=$((n + 1))
echo '{"enabled": false}' > "$WORK/off.json"
if ! (
  . "$HERE/local-first-draft-check.sh"
  LOCAL_FIRST_DRAFT_FLAG_FILE="$WORK/off.json"
  local_first_draft_enabled
); then
  echo "  ok   {\"enabled\": false} in the flag file = DISABLED"
else
  echo "  FAIL enabled:false in the file should disable"; fail=1
fi

n=$((n + 1))
echo '{"enabled": true, "note": "x"}' > "$WORK/on.json"
if (
  . "$HERE/local-first-draft-check.sh"
  LOCAL_FIRST_DRAFT_FLAG_FILE="$WORK/on.json"
  local_first_draft_enabled
); then
  echo "  ok   {\"enabled\": true} in the flag file = ENABLED"
else
  echo "  FAIL enabled:true in the file should enable"; fail=1
fi

n=$((n + 1))
if ! (
  . "$HERE/local-first-draft-check.sh"
  LOCAL_FIRST_DRAFT_FLAG_FILE="$WORK/on.json"
  LOCAL_FIRST_DRAFT=off
  local_first_draft_enabled
); then
  echo "  ok   LOCAL_FIRST_DRAFT=off env var wins over an enabled file"
else
  echo "  FAIL env var off should win over the file"; fail=1
fi

n=$((n + 1))
echo 'not json' > "$WORK/bad.json"
if (
  . "$HERE/local-first-draft-check.sh"
  LOCAL_FIRST_DRAFT_FLAG_FILE="$WORK/bad.json"
  local_first_draft_enabled
); then
  echo "  ok   unparseable flag file fails OPEN (enabled) -- a config hiccup never silently blocks everything"
else
  echo "  FAIL an unparseable file should fail open (enabled)"; fail=1
fi

# --- 2. MUTATION-PINNING: every real entry point actually calls the shared helper -----------------
# card d57d8a01's own acceptance test: "a kapcsolo minden belepesi pontot leallit (mutans-pirosito
# teszt)". Each assertion below runs the REAL script with LOCAL_FIRST_DRAFT=off and checks it takes
# the local-first-draft-off exit, WITHOUT needing ollama/a GPU/a model up -- proving the switch is
# consulted before any of that, not just documented as being consulted.

n=$((n + 1))
out="$(CARD_BUILD_ROUTE_INSTALLED=/bin/true LOCAL_FIRST_DRAFT=off bash "$HERE/card-build-route.sh" --text "write a trivial helper" 2>&1)"
if [ "$out" = "ONLINE" ]; then
  echo "  ok   card-build-route.sh --text: LOCAL_FIRST_DRAFT=off -> ONLINE, no model call needed"
else
  echo "  FAIL card-build-route.sh ignored the switch -> $out"; fail=1
fi

n=$((n + 1))
out="$(LOCAL_FIRST_DRAFT=off bash "$HERE/offload-dispatch.sh" deadbeef00 2>&1)"
rc=$?
if [ "$rc" = 0 ] && printf '%s' "$out" | grep -q "local-first-draft is OFF"; then
  echo "  ok   offload-dispatch.sh: LOCAL_FIRST_DRAFT=off -> SKIPPED before any lock/API call"
else
  echo "  FAIL offload-dispatch.sh ignored the switch -> rc=$rc: $out"; fail=1
fi

n=$((n + 1))
out="$(LOCAL_FIRST_DRAFT=off bash "$HERE/route-classify.sh" "write a trivial helper" 2>&1)"
if [ "$out" = "UNKNOWN" ]; then
  echo "  ok   route-classify.sh: LOCAL_FIRST_DRAFT=off -> UNKNOWN (its own abstain answer), no model call"
else
  echo "  FAIL route-classify.sh ignored the switch -> $out"; fail=1
fi

n=$((n + 1))
out="$(LOCAL_FIRST_DRAFT=off bash "$HERE/i18n-draft.sh" --messages-dir /tmp --lang de 2>&1)"
rc=$?
if [ "$rc" = 3 ] && printf '%s' "$out" | grep -q "local-first-draft is OFF"; then
  echo "  ok   i18n-draft.sh: LOCAL_FIRST_DRAFT=off -> exit 3 before touching any locale file"
else
  echo "  FAIL i18n-draft.sh ignored the switch -> rc=$rc: $out"; fail=1
fi

n=$((n + 1))
out="$(LOCAL_FIRST_DRAFT=off bash "$HERE/local-llm.sh" "hello" 2>&1)"
rc=$?
if [ "$rc" = 9 ] && printf '%s' "$out" | grep -q "local-first-draft is OFF"; then
  echo "  ok   local-llm.sh (generate): LOCAL_FIRST_DRAFT=off -> exit 9, no ollama call needed"
else
  echo "  FAIL local-llm.sh ignored the switch -> rc=$rc: $out"; fail=1
fi

n=$((n + 1))
out="$(LOCAL_FIRST_DRAFT=off bash "$HERE/local-llm-rag.sh" --agent test "hello" 2>&1)"
rc=$?
if [ "$rc" = 9 ] && printf '%s' "$out" | grep -q "local-first-draft is OFF"; then
  echo "  ok   local-llm-rag.sh: LOCAL_FIRST_DRAFT=off -> ROUTE=online + advisory skip, no model call"
else
  echo "  FAIL local-llm-rag.sh ignored the switch -> rc=$rc: $out"; fail=1
fi

# Points --repo at this selftest's OWN containing repo (whatever checkout/worktree/TEST_TREE copy
# it is running from), never the shared live /home/neon/marveen -- that was the first version, and
# under fleet-test.sh's full-suite concurrency (hundreds of other test files, other agents' live
# git activity) a `gate-pretriage.sh --explain` pointed at the shared, mutable live checkout can
# transiently race (index.lock, a concurrent fetch/checkout) for a reason that has nothing to do
# with this switch. The repo this file itself lives in already has the `HEAD~1` gate-pretriage.sh
# needs as its default BASE (a real git history, not a bare init), so there is nothing to skip.
REPO_ROOT="$(cd "$HERE/.." && pwd)"
n=$((n + 1))
out="$(LOCAL_FIRST_DRAFT=off bash "$HERE/gate-pretriage.sh" --repo "$REPO_ROOT" --explain 2>&1)"
if printf '%s' "$out" | grep -q "local model not asked -- local-first-draft is OFF"; then
  echo "  ok   gate-pretriage.sh --explain: LOCAL_FIRST_DRAFT=off -> advisory summary skipped, no model call"
else
  echo "  FAIL gate-pretriage.sh ignored the switch -> $out"; fail=1
fi

# Control proving the mutation above is real: reverting local-first-draft-check.sh's own body to
# "always enabled" must turn every assertion above RED. Exercised directly on the helper function,
# isolated from the 7 callers (one mutation, one place, same shape as the brace-group fd test in
# marveen-land.sh --selftest).
MUTANT_HELPER="$WORK/local-first-draft-check-mutant.sh"
sed 's/\[ "\$value" != "off" \]/true/' "$HERE/local-first-draft-check.sh" > "$MUTANT_HELPER"
n=$((n + 1))
if diff -q "$HERE/local-first-draft-check.sh" "$MUTANT_HELPER" >/dev/null; then
  echo "  FAIL mutation did not apply -- the sed pattern no longer matches the live source"; fail=1
else
  if (
    . "$MUTANT_HELPER"
    LOCAL_FIRST_DRAFT_FLAG_FILE="$WORK/off.json"
    LOCAL_FIRST_DRAFT=off
    local_first_draft_enabled
  ); then
    echo "  ok   MUTATION CAUGHT: a helper that always reports enabled would let the switch do nothing"
  else
    echo "  FAIL the mutant should have reported enabled regardless of the switch"; fail=1
  fi
fi

# "A kapcsolo nem inditja el az ollamat magatol" (the switch never starts ollama itself) is proven
# at the API layer, not here: src/__tests__/local-llm-first-draft-switch.test.ts mocks
# node:child_process and asserts spawn/execFile is never called while the POST handler runs. This
# helper only ever READS the flag file; it has no write path and nothing to spawn, so there is
# nothing additional to pin at the shell level.

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

#!/usr/bin/env bash
# Self-test for the per-task model routing added to local-llm.sh (card baf1b1b0).
#
# Run: bash store/local-llm-model-routing.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# Does NOT require a real second model to be pulled: routing correctness is proven by pointing the
# routing config at a deliberately-nonexistent model name and checking that local-llm.sh's own
# "model not pulled" error names THAT model -- proof the override reached MODEL before the generate
# call, without needing a live GPU round-trip on the routed model itself.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/local-llm.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

TMPCFG="$(mktemp)"
FAKE_MODEL="nonexistent-routing-selftest-model:latest"
cat > "$TMPCFG" <<JSON
{"overrides": {"board-reconcile": "$FAKE_MODEL"}}
JSON

# --- 0. parses -------------------------------------------------------------------------------
if bash -n "$SCRIPT" 2>/dev/null; then ok "local-llm.sh parses (bash -n)"; else bad "parses" ""; fi

run() { # $1 = extra env (space-separated VAR=val), rest = args to local-llm.sh
  local envs="$1"; shift
  env $envs bash "$SCRIPT" "$@" 2>&1
}

# --- 1. a --task with a routing-config override picks that model, not the plain default -------
# HERMETIC SINCE card 89f4c28d. This used to swap `$HERE/local-llm-model-routing.json` out and back
# -- the file the running fleet actually reads -- with a cleanup trap to restore it. The trap does
# not survive SIGKILL, and the suite that runs this executes during landings, which do get killed:
# one killed run would have left 18 agents routing through a config naming a nonexistent model.
# local-llm.sh now honours LOCAL_LLM_MODEL_ROUTING_FILE, so every case below points at a temp file
# and the live config is never opened, let alone written. That is what made wiring this safe.
ENVCFG="LOCAL_LLM_MODEL_ROUTING_FILE=$TMPCFG"
cleanup() { rm -f "$TMPCFG"; }
trap cleanup EXIT

out="$(run "$ENVCFG" --task board-reconcile "id=x1 status=waiting" --caller selftest)"
if echo "$out" | grep -q "$FAKE_MODEL"; then
  ok "routed --task uses the overridden model (error names '$FAKE_MODEL')"
else
  bad "routed --task uses the overridden model" "$out"
fi

# --- 2. a --task with NO routing entry falls back to the plain default (not the fake model) ----
out="$(run "$ENVCFG" --task code "add two numbers" --caller selftest)"
if echo "$out" | grep -q "$FAKE_MODEL"; then
  bad "un-routed --task stays on the default model" "unexpectedly used $FAKE_MODEL: $out"
else
  ok "un-routed --task stays on the default model (not '$FAKE_MODEL')"
fi

# --- 3. an explicit --model always wins over a routing entry, even for a routed --task ---------
out="$(run "$ENVCFG" --model explicit-override-model:latest --task board-reconcile "id=x1" --caller selftest)"
if echo "$out" | grep -q "$FAKE_MODEL"; then
  bad "explicit --model overrides routing" "routing leaked through: $out"
elif echo "$out" | grep -q "explicit-override-model"; then
  ok "explicit --model overrides routing"
else
  bad "explicit --model overrides routing" "$out"
fi

# --- 4. a missing/unreadable routing config fails OPEN to the plain default, not fatally -------
# Point at a path that does not exist rather than deleting anything: the case is "no config", and
# it must be reachable without a delete that could ever name a real file.
out="$(run "LOCAL_LLM_MODEL_ROUTING_FILE=$TMPCFG.absent" --task code "add two numbers" --caller selftest)"
# WHAT "FAILS OPEN" MEANS HERE, narrowed (card 89f4c28d). This used to also treat "no model
# configured" as a failure, which conflates two unrelated conditions: a missing ROUTING config (what
# this case is about) and an empty MODEL STATE DIR (a different thing entirely). Wiring the selftest
# into the suite surfaced it immediately -- src/__tests__/setup/isolate-local-llm-state.ts points
# LOCAL_LLM_STATE_DIR at a fresh temp dir for every vitest run, exactly so tests cannot touch the
# fleet's LLM state, so inside the suite "no model configured" is the CORRECT answer and the case
# failed on it. That is the defect an unrun control hides: it was never wrong until it ran.
#
# So: a crash is a Traceback, and routing must not leak the fake model when its config is absent.
# Both are about routing; neither depends on whether a model happens to be pulled.
if echo "$out" | grep -qi "Traceback"; then
  bad "missing routing config fails open (no crash)" "$out"
elif echo "$out" | grep -q "$FAKE_MODEL"; then
  bad "missing routing config still routed to the override" "$out"
else
  ok "missing routing config fails open (no crash, no stale route)"
fi

echo
echo "local-llm-model-routing.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]

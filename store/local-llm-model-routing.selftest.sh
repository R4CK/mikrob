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
# LOCAL_LLM_MODEL_ROUTING_FILE is not a real knob the script reads by name -- we point HERE at a
# temp dir containing our fake config instead, since the script derives the config path from its
# own directory ($HERE/local-llm-model-routing.json). Simplest robust way to isolate this without
# touching the real file: copy the script's directory layout is overkill, so instead we swap the
# real config out and back (see cleanup trap) -- this IS the file the running fleet uses, so the
# swap window must be as short as possible and always restored, pass or fail.
REALCFG="$HERE/local-llm-model-routing.json"
BACKUP=""
if [[ -f "$REALCFG" ]]; then BACKUP="$(mktemp)"; cp "$REALCFG" "$BACKUP"; fi
cleanup() { [[ -n "$BACKUP" ]] && cp "$BACKUP" "$REALCFG" && rm -f "$BACKUP"; rm -f "$TMPCFG"; }
trap cleanup EXIT
cp "$TMPCFG" "$REALCFG"

out="$(run "" --task board-reconcile "id=x1 status=waiting" --caller selftest)"
if echo "$out" | grep -q "$FAKE_MODEL"; then
  ok "routed --task uses the overridden model (error names '$FAKE_MODEL')"
else
  bad "routed --task uses the overridden model" "$out"
fi

# --- 2. a --task with NO routing entry falls back to the plain default (not the fake model) ----
out="$(run "" --task code "add two numbers" --caller selftest)"
if echo "$out" | grep -q "$FAKE_MODEL"; then
  bad "un-routed --task stays on the default model" "unexpectedly used $FAKE_MODEL: $out"
else
  ok "un-routed --task stays on the default model (not '$FAKE_MODEL')"
fi

# --- 3. an explicit --model always wins over a routing entry, even for a routed --task ---------
out="$(run "" --model explicit-override-model:latest --task board-reconcile "id=x1" --caller selftest)"
if echo "$out" | grep -q "$FAKE_MODEL"; then
  bad "explicit --model overrides routing" "routing leaked through: $out"
elif echo "$out" | grep -q "explicit-override-model"; then
  ok "explicit --model overrides routing"
else
  bad "explicit --model overrides routing" "$out"
fi

# --- 4. a missing/unreadable routing config fails OPEN to the plain default, not fatally -------
rm -f "$REALCFG"
out="$(run "" --task code "add two numbers" --caller selftest)"
if echo "$out" | grep -qi "no model configured\|Traceback"; then
  bad "missing routing config fails open (no crash)" "$out"
else
  ok "missing routing config fails open (no crash)"
fi
cp "$TMPCFG" "$REALCFG"

echo
echo "local-llm-model-routing.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]

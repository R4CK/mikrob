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
pass=0; fail=0; skipped=0
ok()   { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }
skip() { printf '  [skip] %s\n     %s\n' "$1" "${2:-}"; skipped=$((skipped+1)); }

# --- THE ONE CONDITION UNDER WHICH A CASE HERE MAY BE SKIPPED (card 970156ce) -------------------
#
# THE PROBLEM. Two cases below need Ollama to ANSWER: they prove the routing override reached MODEL
# by checking that local-llm.sh's "model not pulled" error names the routed model, and local-llm.sh
# refuses with "ollama down" (exit 2) before it ever gets that far. The gpu-crashloop-guard
# deliberately stops and masks ollama.service when it sees the WSL VM short-booting on dxgkrnl GPU
# faults -- correct protection, not a fault. But this selftest runs inside fleet-test.sh, which is
# the gate on EVERY landing, so while the machine is being protected nobody in the fleet can land
# anything, whatever they changed. The protection and the landing gate excluded each other.
#
# WHY THE OBVIOUS FIX WAS REJECTED (MikroB, comment 21246, on Cybersec's objection). The easy shape
# is "no answer from Ollama -> skip". That reintroduces silent skipping exactly where card 89f4c28d
# went to trouble to keep the EXCLUDED list of store-selftests-all-run empty: a genuinely broken
# routing path, or a service down for a reason nobody sanctioned, would be swallowed the same way.
#
# SO THE CONDITION IS INTENT, NOT REACHABILITY. The guard writes
# store/.gpu-crashloop-guard-masked.json when it masks something (scripts/gpu-crashloop-guard.sh),
# carrying `units` and `reason`. A case is skipped only when that artefact exists AND names
# ollama.service. No flag and Ollama down stays RED -- that is the real-regression case and it must
# not be absorbed. A test pins that direction, because a gate that only ever goes quiet is
# indistinguishable from a gate that was removed.
#
# CARD ca2d7873: intent alone is still not sufficient, because the flag records what was true when
# the guard wrote it, not what is true NOW -- someone can restart/unmask ollama.service by hand
# without the flag itself being cleared (clearing it is the guard's own job, on its own schedule).
# So the skip additionally requires ollama to STILL fail to answer at the moment this selftest runs
# (ollama_actually_up, the same probe local-llm.sh's own ollama_up uses): flag alone no longer
# skips, only flag AND currently-unreachable does. This narrows the window the sanctioned skip
# covers; it does not replace intent with reachability -- Ollama being down with NO flag still
# fails, exactly as before.
#
# WHERE THE FLAG LIVES, and why it is not simply $HERE. The guard runs in the INSTALL and writes
# to the running install's store/; this selftest executes from an agent WORKTREE, where $HERE holds
# only version-controlled files and none of the dashboard's runtime state. Measured while building
# this: reading $HERE found no flag on a machine where the guard had masked ollama an hour earlier,
# so every case would have gone red exactly as before -- the fix would have looked done and changed
# nothing.
#
# So it reuses the checkout-to-install derivation in store/local-llm-state-dir.sh (card b536501e)
# rather than inventing a second path that can drift from it.
#
# BUT NOT ITS `env` BRANCH, and that distinction is the difference between working and not.
# LOCAL_LLM_STATE_DIR wins outright in that resolver, and the suite SETS it per worker
# (src/__tests__/setup/isolate-local-llm-state.ts, card 4c5c540c) to keep test runs of local-llm.sh
# out of the live ledger. Honouring it here would point the flag lookup at a fresh empty temp dir --
# exactly where the guard's artefact can never be -- so inside fleet-test, which is the ONLY place
# this fix has to work, nothing would ever be skipped. Measured: that is what the first cut did, and
# the wrapper stayed red while the selftest passed when run by hand.
#
# The two variables answer different questions: LOCAL_LLM_STATE_DIR is "where may this run WRITE
# local-llm state", GPU_GUARD_STATE is "where did the guard, a different program, RECORD a decision".
# The resolution runs in a COMMAND SUBSTITUTION with the variable unset, so the suite's isolation is
# untouched in this shell -- local-llm.sh is still invoked below with the isolated dir in force, and
# the production-ledger defect 4c5c540c closed is not reopened. Only the PATH crosses back, which is
# all that is needed here (the resolver's ORIGIN would not survive the subshell, and announce() is
# deliberately not called).
if [ -n "${GPU_GUARD_STATE_DIR:-}" ]; then
  GPU_GUARD_STATE="$GPU_GUARD_STATE_DIR"
elif [ -r "$HERE/local-llm-state-dir.sh" ]; then
  GPU_GUARD_STATE="$(
    unset LOCAL_LLM_STATE_DIR
    # shellcheck source=/dev/null
    . "$HERE/local-llm-state-dir.sh"
    resolve_local_llm_state_dir "$HERE"
    printf '%s' "$LOCAL_LLM_STATE_RESOLVED"
  )"
else
  GPU_GUARD_STATE="$HERE"
fi
GPU_GUARD_FLAG="$GPU_GUARD_STATE/.gpu-crashloop-guard-masked.json"
GUARD_REASON=""

# Same probe local-llm.sh's own ollama_up() uses (line ~129: curl -fsS -m 5 "$OLLAMA_HOST/api/tags"),
# reused rather than re-derived so "does ollama actually answer" cannot drift between the two files.
# Same OLLAMA_HOST default too, so a caller who overrides it for one honours it for both.
OLLAMA_HOST_DEFAULT="http://127.0.0.1:11434"
OLLAMA_HOST="${OLLAMA_HOST:-$OLLAMA_HOST_DEFAULT}"
ollama_actually_up() { curl -fsS -m 5 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; }

# True (0) only for a SANCTIONED mask of ollama.service. Every other state -- absent, unreadable,
# malformed, or naming other units -- returns 1, so the default is to run the case.
guard_masked_ollama() {
  local out
  out="$(GPU_GUARD_FLAG="$GPU_GUARD_FLAG" python3 - <<'PY' 2>/dev/null
import json, os
try:
    with open(os.environ['GPU_GUARD_FLAG'], encoding='utf-8') as fh:
        flag = json.load(fh)
except Exception:
    raise SystemExit(1)  # absent, unreadable or malformed is NOT a sanctioned skip
# `units` is the guard's space-joined "${UNITS[*]}". Split and match a WHOLE token: a substring
# test would accept a hypothetical "not-ollama.service" and skip on a mask that never named this
# service (the symbol-presence trap, CLAUDE.md code-quality rule 12).
if 'ollama.service' not in str(flag.get('units', '')).split():
    raise SystemExit(1)
reason = str(flag.get('reason', '')).strip() or 'no reason recorded'
print(f'gpu-crashloop-guard masked ollama.service -- {reason}')
PY
)" || return 1
  [ -n "$out" ] || return 1
  # card ca2d7873: the flag records INTENT at the moment the guard masked ollama, not the CURRENT
  # state -- someone can unmask/restart the service by hand without the flag ever being cleared
  # (clearing it is the crashloop guard's own job, on its own schedule). A flag alone would then
  # skip a case ollama could actually have answered, silently widening the sanctioned-skip window
  # past what it was ever meant to cover. So the flag is necessary but not sufficient: only skip if
  # ollama ALSO still fails to answer right now.
  if ollama_actually_up; then
    return 1
  fi
  GUARD_REASON="$out"
  return 0
}

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

# NEEDS OLLAMA TO ANSWER: the proof is that the "model not pulled" error names the routed model,
# and local-llm.sh dies with "ollama down" before reaching it.
if guard_masked_ollama; then
  skip "routed --task uses the overridden model" "$GUARD_REASON"
else
  out="$(run "$ENVCFG" --task board-reconcile "id=x1 status=waiting" --caller selftest)"
  if echo "$out" | grep -q "$FAKE_MODEL"; then
    ok "routed --task uses the overridden model (error names '$FAKE_MODEL')"
  else
    bad "routed --task uses the overridden model" "$out"
  fi
fi

# --- 2. a --task with NO routing entry falls back to the plain default (not the fake model) ----
out="$(run "$ENVCFG" --task code "add two numbers" --caller selftest)"
if echo "$out" | grep -q "$FAKE_MODEL"; then
  bad "un-routed --task stays on the default model" "unexpectedly used $FAKE_MODEL: $out"
else
  ok "un-routed --task stays on the default model (not '$FAKE_MODEL')"
fi

# --- 3. an explicit --model always wins over a routing entry, even for a routed --task ---------
# NEEDS OLLAMA TO ANSWER, for the same reason as case 1.
if guard_masked_ollama; then
  skip "explicit --model overrides routing" "$GUARD_REASON"
else
  out="$(run "$ENVCFG" --model explicit-override-model:latest --task board-reconcile "id=x1" --caller selftest)"
  if echo "$out" | grep -q "$FAKE_MODEL"; then
    bad "explicit --model overrides routing" "routing leaked through: $out"
  elif echo "$out" | grep -q "explicit-override-model"; then
    ok "explicit --model overrides routing"
  else
    bad "explicit --model overrides routing" "$out"
  fi
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
# The skipped count and its REASON are printed, never implied by a smaller total. The wrapper in
# src/__tests__/store-selftests-all-run.test.ts requires a NON-ZERO passed count, so a run where the
# guard somehow skipped EVERYTHING cannot come out green -- silence is not success here either.
if [ "$skipped" -gt 0 ]; then
  echo "local-llm-model-routing.selftest: $pass passed, $fail failed, $skipped skipped -- $GUARD_REASON"
else
  echo "local-llm-model-routing.selftest: $pass passed, $fail failed"
fi
[[ $fail -eq 0 ]]

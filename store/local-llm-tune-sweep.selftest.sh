#!/usr/bin/env bash
# Self-test for local-llm-tune-sweep.sh (card d747d772, alfeladat 711b696f / lepes 73b72fa5).
#
# Run:  bash store/local-llm-tune-sweep.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# Everything here runs in --dry-run against a SCRATCH unit file (OLLAMA_UNIT override) -- no real
# systemctl call, no real ollama restart, no GPU/model needed. What IS real: every unit-file write and
# the snapshot/restore trap, including under a genuine mid-sweep SIGTERM -- the exact safety net
# plan-grilling (14327 point 5) required the generalized tool to keep.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/local-llm-tune-sweep.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

SB="$(mktemp -d)"
cleanup() { rm -rf "$SB"; }
trap cleanup EXIT

ORIG_UNIT='[Unit]
Description=Ollama Service

[Service]
ExecStart=/usr/local/bin/ollama serve
Environment=SOME_OTHER=1

[Install]
WantedBy=default.target'

new_unit() { printf '%s' "$ORIG_UNIT" > "$SB/ollama.service"; }

# --- 0. parses --------------------------------------------------------------------------------
if bash -n "$SCRIPT" 2>/dev/null; then ok "local-llm-tune-sweep.sh parses (bash -n)"; else bad "parses" ""; fi

# --- 1. no flock on PATH -> refuses loudly ------------------------------------------------------
mkdir -p "$SB/binmask"
for b in bash cat python3 sleep printf rm dirname basename tr grep; do
  p="$(command -v "$b" 2>/dev/null)" && ln -sf "$p" "$SB/binmask/$b"
done
new_unit
out1="$(PATH="$SB/binmask" OLLAMA_UNIT="$SB/ollama.service" bash "$SCRIPT" --dry-run 2>&1)"
case "$out1" in
  *"flock is required"*) ok "no flock on PATH -> refuses loudly" ;;
  *) bad "no flock on PATH -> refuses loudly" "got: $out1" ;;
esac

# --- 2. bogus --configs-file -> rejected before touching the unit at all -------------------------
new_unit
echo 'not json' > "$SB/bad-configs.json"
out2="$(OLLAMA_UNIT="$SB/ollama.service" LOCAL_LLM_GPU_LOCK_PATH="$SB/gpu.lock" \
  bash "$SCRIPT" --configs-file "$SB/bad-configs.json" --dry-run 2>&1)"
rc2=$?
if [[ "$rc2" -ne 0 ]] && [[ "$out2" == *"not a valid"* ]]; then
  ok "invalid --configs-file rejected with a clear message"
else
  bad "invalid --configs-file rejected" "rc=$rc2 out=$out2"
fi
diff -q "$SB/ollama.service" <(printf '%s' "$ORIG_UNIT") >/dev/null \
  && ok "unit untouched after a rejected --configs-file" \
  || bad "unit untouched after a rejected --configs-file" "$(cat "$SB/ollama.service")"

# --- 3. dry-run over the DEFAULT configs: exits 0, and the unit is back to its original content
# byte-for-byte afterwards (the actual safety net, on a clean completion) ------------------------
new_unit
out3="$(OLLAMA_UNIT="$SB/ollama.service" LOCAL_LLM_GPU_LOCK_PATH="$SB/gpu.lock" bash "$SCRIPT" --dry-run 2>&1)"
rc3=$?
[[ "$rc3" -eq 0 ]] && ok "clean dry-run over all default configs exits 0" || bad "clean dry-run exits 0" "rc=$rc3: $out3"
for cfg in baseline flash-q8 flash-q4 flash-q8-parallel1; do
  [[ "$out3" == *"config: $cfg"* ]] || bad "default configs include '$cfg'" "$out3"
done
[[ "$(echo "$out3" | grep -c '^--- config:')" -eq 4 ]] && ok "default config set has 4 entries (more than the old fixed pair)" \
  || bad "default config set has 4 entries" "$out3"
if diff -q "$SB/ollama.service" <(printf '%s' "$ORIG_UNIT") >/dev/null; then
  ok "unit restored byte-for-byte after a clean sweep"
else
  bad "unit restored byte-for-byte after a clean sweep" "$(diff "$SB/ollama.service" <(printf '%s' "$ORIG_UNIT"))"
fi

# --- 4. a candidate's unit content actually reflects its own env during the sweep (proves the
# per-config write is real, not a no-op) -- run a single non-default config and inspect mid-flight
# via a slow pause, from a second process, while the sweep is still on it. ------------------------
new_unit
cat > "$SB/one-config.json" <<'JSON'
[{"name": "solo", "env": {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_CONTEXT_LENGTH": "8192"}}]
JSON
OLLAMA_UNIT="$SB/ollama.service" LOCAL_LLM_GPU_LOCK_PATH="$SB/gpu-solo.lock" \
  LOCAL_LLM_SWEEP_DRY_PAUSE=1.5 \
  bash "$SCRIPT" --configs-file "$SB/one-config.json" --dry-run > "$SB/solo.log" 2>&1 &
solo_pid=$!
sleep 0.5
mid_content="$(cat "$SB/ollama.service")"
wait "$solo_pid"
case "$mid_content" in
  *"OLLAMA_CONTEXT_LENGTH=8192"*) ok "unit is genuinely rewritten to the candidate's env mid-sweep" ;;
  *) bad "unit rewritten to candidate's env mid-sweep" "got: $mid_content" ;;
esac
diff -q "$SB/ollama.service" <(printf '%s' "$ORIG_UNIT") >/dev/null \
  && ok "and still restored afterwards" || bad "restored after solo config" ""

# --- 5. GENUINE mid-sweep SIGTERM (kill -TERM, not a clean finish) -> the trap still restores the
# original unit content. This is the plan-grilling-required guarantee: the host must never be left
# on a scratch config no matter how the sweep ends. --------------------------------------------------
new_unit
OLLAMA_UNIT="$SB/ollama.service" LOCAL_LLM_GPU_LOCK_PATH="$SB/gpu-kill.lock" \
  LOCAL_LLM_SWEEP_DRY_PAUSE=2 \
  bash "$SCRIPT" --dry-run > "$SB/kill.log" 2>&1 &
kill_pid=$!
# Wait for the SECOND config to actually start (proves the kill lands mid-sweep, not before the
# first candidate write or after the whole thing already finished).
for _i in $(seq 1 100); do
  grep -q '^--- config: flash-q8 ---$' "$SB/kill.log" 2>/dev/null && break
  sleep 0.05
done
grep -q '^--- config: flash-q8 ---$' "$SB/kill.log" 2>/dev/null \
  || bad "reached the 2nd config before killing (test precondition)" "$(cat "$SB/kill.log")"
grep -q '^--- config: flash-q8-parallel1 ---$' "$SB/kill.log" 2>/dev/null \
  && bad "killed BEFORE the sweep reached the end (test precondition)" "sweep already finished -- pause too short"
kill -TERM "$kill_pid" 2>/dev/null
wait "$kill_pid" 2>/dev/null
sleep 0.3
if diff -q "$SB/ollama.service" <(printf '%s' "$ORIG_UNIT") >/dev/null; then
  ok "mid-sweep SIGTERM still restores the original unit content (trap fired)"
else
  bad "mid-sweep SIGTERM restores original unit content" "got: $(cat "$SB/ollama.service")"
fi

echo
if [[ $fail -gt 0 ]]; then echo "$fail FAILED, $pass passed"; exit 1; fi
echo "All $pass checks pass."

#!/usr/bin/env bash
# Self-test for store/gemini-local-subtask.sh (card a020247b). No real GPU, no real Ollama, no
# bwrap jail needed -- every dependency is a fake file or a tiny local HTTP stub.
#
# Card 19ef0eca (WhiteHat2 finding, komment 20244): the kill-switch and GPU-gate mirror paths are
# no longer env-overridable in the script (they are the gate decision itself). LOG/OLLAMA_HOST/
# TIMEOUT remain plain env overrides (mechanical config, unaffected by that card).
#
# Card b30ad7e6 (RedHat F1-F3 on 19ef0eca's edc5bd86 GO): the two mirror paths are now a LITERAL
# jail path (/run/gemini-local-subtask-gate), not derived from $HOME at all, so a scratch HOME can
# no longer redirect the gate lookup. Since that literal path is a real host path outside any jail,
# this selftest cannot write fixtures there directly (no permission, and it would collide with
# other parallel runs) -- fixture injection goes through a per-test SED COPY of the script that
# substitutes the literal GATE_JAIL_DIR constant for a sandboxed directory (something only this test
# harness can do, operating on the script source outside any jail; a bad-faith agy running inside
# the jail has no access to do the same to the real, ro-bound deployed copy).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/gemini-local-subtask.sh"
TD="$(mktemp -d)"
trap 'rm -rf "$TD"; [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null; wait 2>/dev/null' EXIT

fails=()
n=0

# A tiny stub Ollama server: /api/generate always returns a fixed, recognizable response, and
# never echoes the request body anywhere (so a test can assert the prompt never leaks into logs
# without the stub itself being the thing that would leak it).
cat > "$TD/stub-ollama.py" <<'PYEOF'
import sys, json
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        self.rfile.read(length)
        body = json.dumps({"response": "MOCKED-LOCAL-RESPONSE"}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass

port = int(sys.argv[1])
HTTPServer(('127.0.0.1', port), H).serve_forever()
PYEOF
PORT=$((20000 + RANDOM % 10000))
python3 "$TD/stub-ollama.py" "$PORT" &
SRV_PID=$!
for _ in $(seq 1 30); do
  curl -fsS -m1 "http://127.0.0.1:$PORT/api/generate" -d '{}' >/dev/null 2>&1 && break
  sleep 0.1
done

run() {  # $1 = stdin text, remaining = env KEY=VALUE pairs already exported by caller
  printf '%s' "$1"
}

# Card a020247b F1/F2 delta-gate (WhiteHat2 NO-GO 19540): the GPU gate is now a host-written
# {"admit":bool,"reason":str,"at":epoch} mirror file, not a fake vram-guard-check.sh binary.
# $1 = target path to write, $2 = admit(true/false), $3 = reason, $4 = age in seconds (default 0)
write_gate_mirror() {
  local at
  at=$(python3 -c "import time; print(time.time() - ${4:-0})")
  printf '{"admit": %s, "reason": "%s", "at": %s}\n' "$2" "$3" "$at" > "$1"
}

# card b30ad7e6: fixture injection for the kill-switch/GPU-gate mirrors now goes through a sed-
# copied script whose literal GATE_JAIL_DIR constant points at a per-test sandbox dir, instead of
# a sandbox $HOME -- the real script no longer derives that path from $HOME at all.
# SCRIPT_COPY is the path test cases should invoke instead of $SCRIPT. HOME is also sandboxed
# (kept, for the log file under $SUBTASK_DIR and for case 11 below) but no longer carries the gate.
base_env() {
  HOME="$TD/home-$n-$RANDOM"
  mkdir -p "$HOME"
  GATE_DIR="$TD/gate-$n-$RANDOM"
  mkdir -p "$GATE_DIR"
  KILLSWITCH_FILE="$GATE_DIR/killswitch-mirror.json"
  GPU_GATE_FILE="$GATE_DIR/gpu-gate-mirror.json"
  write_gate_mirror "$GPU_GATE_FILE" true ok 0
  SCRIPT_COPY="$TD/script-$n-$RANDOM.sh"
  sed "s#/run/gemini-local-subtask-gate#$GATE_DIR#" "$SCRIPT" > "$SCRIPT_COPY"
  GEMINI_LOCAL_SUBTASK_LOG="$TD/calls-$n.log"
  GEMINI_LOCAL_SUBTASK_OLLAMA_HOST="http://127.0.0.1:$PORT"
  GEMINI_LOCAL_SUBTASK_TIMEOUT=5
  unset GEMINI_LOCAL_SUBTASK_KILLSWITCH GEMINI_LOCAL_SUBTASK_GPU_GATE \
    GEMINI_LOCAL_SUBTASK_GPU_GATE_STALE_S SUBTASK_DIR GPU_GATE_STALE_S
  export HOME GEMINI_LOCAL_SUBTASK_LOG GEMINI_LOCAL_SUBTASK_OLLAMA_HOST GEMINI_LOCAL_SUBTASK_TIMEOUT
}

case_eq() {  # $1 = label, $2 = expected, $3 = actual
  n=$((n + 1))
  if [ "$2" != "$3" ]; then
    fails+=("$1: expected [$2], got [$3]")
  fi
}

# 1. Kill-switch missing -> proceeds (same convention as local-first-draft-check.sh: absence = ON)
base_env
out="$(echo 'hello' | bash "$SCRIPT_COPY" 2>"$TD/err1")"; rc=$?
case_eq "kill-switch-missing: exit 0" "0" "$rc"
case_eq "kill-switch-missing: response" "MOCKED-LOCAL-RESPONSE" "$out"

# 2. Kill-switch explicit enabled:true -> proceeds
base_env
echo '{"enabled":true}' > "$KILLSWITCH_FILE"
out="$(echo 'hello' | bash "$SCRIPT_COPY" 2>/dev/null)"; rc=$?
case_eq "kill-switch-true: exit 0" "0" "$rc"

# 3. Kill-switch explicit enabled:false -> refuses, never reaches the GPU gate or Ollama
base_env
echo '{"enabled":false}' > "$KILLSWITCH_FILE"
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out3" 2>"$TD/err3"; rc=$?
case_eq "kill-switch-false: exit 1" "1" "$rc"
grep -q 'killswitch-off' "$TD/err3" || fails+=("kill-switch-false: stderr missing killswitch-off reason")
grep -q $'\tkillswitch-off\t' "$GEMINI_LOCAL_SUBTASK_LOG" || fails+=("kill-switch-false: log missing killswitch-off row")

# 4. Kill-switch corrupt JSON -> treated as ON (same fail-open convention), proceeds
base_env
echo 'not json{{{' > "$KILLSWITCH_FILE"
out="$(echo 'hello' | bash "$SCRIPT_COPY" 2>/dev/null)"; rc=$?
case_eq "kill-switch-corrupt: exit 0" "0" "$rc"

# 5. Mirror reports HOLD -> script refuses, never calls Ollama (card a020247b F1)
base_env
write_gate_mirror "$GPU_GATE_FILE" false gpu-util-hold 0
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out5" 2>"$TD/err5"; rc=$?
case_eq "gpu-hold: exit 1" "1" "$rc"
grep -q 'gpu-util-hold' "$TD/err5" || fails+=("gpu-hold: stderr missing gpu-util-hold reason")
grep -q $'\tgpu-util-hold\t' "$GEMINI_LOCAL_SUBTASK_LOG" || fails+=("gpu-hold: log missing gpu-util-hold row")

# 6. Mirror reports ADMIT and is fresh -> proceeds to the real call
base_env
write_gate_mirror "$GPU_GATE_FILE" true ok 0
out="$(echo 'hello' | bash "$SCRIPT_COPY" 2>/dev/null)"; rc=$?
case_eq "gpu-admit: exit 0" "0" "$rc"
case_eq "gpu-admit: response" "MOCKED-LOCAL-RESPONSE" "$out"

# 6a. Mirror is ADMIT but STALE (older than the script's fixed 600s stale threshold) -> doubt ->
#     HOLD (card a020247b F1). GPU_GATE_STALE_S is no longer overridable (card 19ef0eca); 9999s
#     is well past the fixed 600s default either way.
base_env
write_gate_mirror "$GPU_GATE_FILE" true ok 9999
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out6a" 2>"$TD/err6a"; rc=$?
case_eq "gpu-stale: exit 1" "1" "$rc"
grep -q 'stale' "$GEMINI_LOCAL_SUBTASK_LOG" || fails+=("gpu-stale: log missing stale detail")

# 6b. Mirror file does not exist at all (fresh host, nothing has reported in yet) -> HOLD, not ADMIT
base_env
rm -f "$GPU_GATE_FILE"
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out6b" 2>"$TD/err6b"; rc=$?
case_eq "gpu-no-mirror: exit 1" "1" "$rc"
grep -q 'no-gate-mirror-yet' "$GEMINI_LOCAL_SUBTASK_LOG" || fails+=("gpu-no-mirror: log missing no-gate-mirror-yet detail")

# 6c. Mirror file is present but corrupt/unparseable -> doubt -> HOLD
base_env
echo 'not json{{{' > "$GPU_GATE_FILE"
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out6c" 2>"$TD/err6c"; rc=$?
case_eq "gpu-corrupt-mirror: exit 1" "1" "$rc"
grep -q 'unreadable' "$GEMINI_LOCAL_SUBTASK_LOG" || fails+=("gpu-corrupt-mirror: log missing unreadable detail")

# 6e. Forged GEMINI_LOCAL_SUBTASK_GPU_GATE env override must NOT be honored (card 19ef0eca,
#     WhiteHat2 finding on the 67a78f4c gate, komment 20244): a bad-faith agy fully controls the
#     environment of any child process it spawns, so if this script trusted an env-supplied
#     mirror path, forging {"admit":true} there (in the jail's own writable --tmpfs) would bypass
#     the real, host-written gate entirely -- WhiteHat2 measured exactly this working pre-fix.
#     The REAL (sandboxed) mirror says HOLD; a forged env var points at a separately-written
#     ADMIT file. Must still HOLD, proving the env var is ignored.
base_env
write_gate_mirror "$GPU_GATE_FILE" false gpu-util-hold 0
forged="$TD/forged-admit-$RANDOM.json"
write_gate_mirror "$forged" true ok 0
GEMINI_LOCAL_SUBTASK_GPU_GATE="$forged"
export GEMINI_LOCAL_SUBTASK_GPU_GATE
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out6e" 2>"$TD/err6e"; rc=$?
unset GEMINI_LOCAL_SUBTASK_GPU_GATE
case_eq "forged-gpu-gate-env-ignored: exit 1 (real HOLD wins over forged env ADMIT)" "1" "$rc"
grep -q 'gpu-util-hold' "$TD/err6e" || fails+=("forged-gpu-gate-env-ignored: stderr missing gpu-util-hold (env override still honored?)")

# 6f. Same class as 6e, for the kill-switch mirror: a forged GEMINI_LOCAL_SUBTASK_KILLSWITCH env
#     override pointing at an attacker-written enabled:true file must not override the real,
#     sandboxed enabled:false file.
base_env
echo '{"enabled":false}' > "$KILLSWITCH_FILE"
forged_ks="$TD/forged-killswitch-$RANDOM.json"
echo '{"enabled":true}' > "$forged_ks"
GEMINI_LOCAL_SUBTASK_KILLSWITCH="$forged_ks"
export GEMINI_LOCAL_SUBTASK_KILLSWITCH
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out6f" 2>"$TD/err6f"; rc=$?
unset GEMINI_LOCAL_SUBTASK_KILLSWITCH
case_eq "forged-killswitch-env-ignored: exit 1 (real OFF wins over forged env ON)" "1" "$rc"
grep -q 'killswitch-off' "$TD/err6f" || fails+=("forged-killswitch-env-ignored: stderr missing killswitch-off (env override still honored?)")

# 6d. A prompt over the kernel's ARG_MAX (card a020247b F4 regression pin, WhiteHat2 19540:
#     previously "python3 -c ... \"\$prompt\"" hit "Argument list too long" silently past ~128 KB).
#     200 KB, well past the measured failure point, must still reach Ollama via stdin and succeed.
base_env
big_prompt="$(python3 -c "print('x' * 200000)")"
out="$(printf '%s' "$big_prompt" | bash "$SCRIPT_COPY" 2>"$TD/err6d")"; rc=$?
case_eq "big-prompt: exit 0" "0" "$rc"
case_eq "big-prompt: response" "MOCKED-LOCAL-RESPONSE" "$out"

# 7. Empty prompt (blank stdin) -> refuses before ever touching Ollama
base_env
printf '' | bash "$SCRIPT_COPY" >"$TD/out7" 2>"$TD/err7"; rc=$?
case_eq "empty-prompt: exit 1" "1" "$rc"
grep -q 'empty-prompt' "$TD/err7" || fails+=("empty-prompt: stderr missing empty-prompt reason")

# 8. Ollama unreachable -> refuses with ollama-call-failed, does not hang past the timeout
base_env
GEMINI_LOCAL_SUBTASK_OLLAMA_HOST="http://127.0.0.1:1"
GEMINI_LOCAL_SUBTASK_TIMEOUT=2
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out8" 2>"$TD/err8"; rc=$?
case_eq "ollama-down: exit 1" "1" "$rc"
grep -q 'ollama-call-failed' "$TD/err8" || fails+=("ollama-down: stderr missing ollama-call-failed reason")

# 9. The log NEVER contains the prompt text, across every case run above (information-disclosure
#    pin: a secret-shaped or card-identifying prompt must not end up sitting in a file the jailed
#    process itself can read back later).
base_env
SECRET_MARKER="SuperSecretPromptMarker12345"
echo "$SECRET_MARKER" | bash "$SCRIPT_COPY" >/dev/null 2>/dev/null
if grep -q "$SECRET_MARKER" "$GEMINI_LOCAL_SUBTASK_LOG" 2>/dev/null; then
  fails+=("log-no-prompt-leak: the prompt text appeared in the call log")
fi

# 10. No filename parameter exists: passing extra argv is ignored (the script never reads argv
#     for the prompt), proving a caller cannot smuggle a file path in as an argument.
base_env
out="$(echo 'hello' | bash "$SCRIPT_COPY" "/etc/passwd" "--mappa" "/home/neon/marveen" 2>/dev/null)"; rc=$?
case_eq "argv-ignored: exit 0" "0" "$rc"
case_eq "argv-ignored: response" "MOCKED-LOCAL-RESPONSE" "$out"

# 11. Card b30ad7e6 F1: a scratch (attacker-controlled) HOME, with FORGED admit/enabled gate files
#     planted at the OLD vulnerable location ($HOME/.gemini-local-subtask/gate/*.json), must NOT
#     override the real gate decision. The real (sandboxed) GATE_DIR says HOLD; the forged files
#     under the scratch HOME say ADMIT/enabled. Must still HOLD -- proving $HOME has no influence
#     on the gate lookup any more. (Mutation check: reverting the GATE_JAIL_DIR fix back to deriving
#     from $HOME/$SUBTASK_DIR makes this case pass the forged files through instead -> exit 0.)
base_env
write_gate_mirror "$GPU_GATE_FILE" false gpu-util-hold 0
scratch_gate="$HOME/.gemini-local-subtask/gate"
mkdir -p "$scratch_gate"
echo '{"enabled":true}' > "$scratch_gate/killswitch-mirror.json"
write_gate_mirror "$scratch_gate/gpu-gate-mirror.json" true ok 0
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out11" 2>"$TD/err11"; rc=$?
case_eq "scratch-home-forged-gate-ignored: exit 1 (real HOLD wins over forged \$HOME gate)" "1" "$rc"
grep -q 'gpu-util-hold' "$TD/err11" || fails+=("scratch-home-forged-gate-ignored: stderr missing gpu-util-hold (scratch HOME still honored?)")

# 12. Card b30ad7e6 F2: an env var named GPU_GATE_STALE_S must have ZERO effect -- the script's
#     stale threshold is a fixed 600s constant, never env-overridable. A mirror aged 700s (past the
#     real 600s, but well under the forged 999999s) must still be rejected as stale.
#     (Mutation check: if the script read GPU_GATE_STALE_S from the environment, this case flips to
#     exit 0, because 700s would be "fresh" under a 999999s threshold.)
base_env
GPU_GATE_STALE_S=999999
export GPU_GATE_STALE_S
write_gate_mirror "$GPU_GATE_FILE" true ok 700
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out12" 2>"$TD/err12"; rc=$?
unset GPU_GATE_STALE_S
case_eq "gpu-stale-s-env-ignored: exit 1 (fixed 600s wins over forged env 999999s)" "1" "$rc"
grep -q 'stale' "$GEMINI_LOCAL_SUBTASK_LOG" \
  || fails+=("gpu-stale-s-env-ignored: log missing stale detail (env override still honored?)")

# 13. Card b30ad7e6 F3: an env var named SUBTASK_DIR must have ZERO effect on the gate lookup. A
#     forged SUBTASK_DIR pointing at an attacker-written ADMIT/enabled pair must not override the
#     real (sandboxed) GATE_DIR, which says HOLD.
#     (Mutation check: if the script derived the gate paths from a SUBTASK_DIR env var instead of
#     the literal GATE_JAIL_DIR constant, this case flips to exit 0.)
base_env
write_gate_mirror "$GPU_GATE_FILE" false gpu-util-hold 0
forged_subtask_dir="$TD/forged-subtask-dir-$RANDOM"
mkdir -p "$forged_subtask_dir/gate"
echo '{"enabled":true}' > "$forged_subtask_dir/gate/killswitch-mirror.json"
write_gate_mirror "$forged_subtask_dir/gate/gpu-gate-mirror.json" true ok 0
SUBTASK_DIR="$forged_subtask_dir"
export SUBTASK_DIR
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out13" 2>"$TD/err13"; rc=$?
unset SUBTASK_DIR
case_eq "subtask-dir-env-ignored: exit 1 (real HOLD wins over forged SUBTASK_DIR env)" "1" "$rc"
grep -q 'gpu-util-hold' "$TD/err13" || fails+=("subtask-dir-env-ignored: stderr missing gpu-util-hold (SUBTASK_DIR env still honored?)")

# 14-16. Card 0f01b9cf (WhiteHat LOW on b30ad7e6's gate @ba2c419b, komment 20428): cases 12/13 only
#     pin NAMED, DIFFERENT env vars (GPU_GATE_STALE_S, SUBTASK_DIR) against the gate lookup -- they
#     never set an env var sharing the SCRIPT'S OWN internal variable names (GATE_JAIL_DIR,
#     KILL_SWITCH_MIRROR, GPU_GATE_MIRROR). Today this is not a live bug: the script assigns these
#     unconditionally (`GATE_JAIL_DIR="/run/..."`, not `"${GATE_JAIL_DIR:-/run/...}"`), so an
#     inherited env var of the same name is immediately overwritten -- but no case caught a future
#     regression that made the assignment conditional. (Mutation check: switching any of the three
#     assignments in gemini-local-subtask.sh to `"${VAR:-default}"` flips exactly the matching case
#     below to exit 0, because the forged file the env var points at would then be read instead of
#     the real one.)
base_env
write_gate_mirror "$GPU_GATE_FILE" false gpu-util-hold 0
forged_gate_jail_dir="$TD/forged-gate-jail-dir-$RANDOM"
mkdir -p "$forged_gate_jail_dir"
echo '{"enabled":true}' > "$forged_gate_jail_dir/killswitch-mirror.json"
write_gate_mirror "$forged_gate_jail_dir/gpu-gate-mirror.json" true ok 0
GATE_JAIL_DIR="$forged_gate_jail_dir"
export GATE_JAIL_DIR
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out14" 2>"$TD/err14"; rc=$?
unset GATE_JAIL_DIR
case_eq "gate-jail-dir-env-ignored: exit 1 (real HOLD wins over forged GATE_JAIL_DIR env)" "1" "$rc"
grep -q 'gpu-util-hold' "$TD/err14" || fails+=("gate-jail-dir-env-ignored: stderr missing gpu-util-hold (GATE_JAIL_DIR env still honored?)")

base_env
write_gate_mirror "$GPU_GATE_FILE" true ok 0
echo '{"enabled":false}' > "$KILLSWITCH_FILE"
forged_kill_switch="$TD/forged-killswitch-$RANDOM.json"
echo '{"enabled":true}' > "$forged_kill_switch"
KILL_SWITCH_MIRROR="$forged_kill_switch"
export KILL_SWITCH_MIRROR
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out15" 2>"$TD/err15"; rc=$?
unset KILL_SWITCH_MIRROR
case_eq "kill-switch-mirror-env-ignored: exit 1 (real killswitch-off wins over forged KILL_SWITCH_MIRROR env)" "1" "$rc"
grep -q 'killswitch-off' "$TD/err15" || fails+=("kill-switch-mirror-env-ignored: stderr missing killswitch-off (KILL_SWITCH_MIRROR env still honored?)")

base_env
write_gate_mirror "$GPU_GATE_FILE" false gpu-util-hold 0
forged_gpu_gate="$TD/forged-gpu-gate-$RANDOM.json"
write_gate_mirror "$forged_gpu_gate" true ok 0
GPU_GATE_MIRROR="$forged_gpu_gate"
export GPU_GATE_MIRROR
echo 'hello' | bash "$SCRIPT_COPY" >"$TD/out16" 2>"$TD/err16"; rc=$?
unset GPU_GATE_MIRROR
case_eq "gpu-gate-mirror-env-ignored: exit 1 (real gpu-util-hold wins over forged GPU_GATE_MIRROR env)" "1" "$rc"
grep -q 'gpu-util-hold' "$TD/err16" || fails+=("gpu-gate-mirror-env-ignored: stderr missing gpu-util-hold (GPU_GATE_MIRROR env still honored?)")

for f in "${fails[@]}"; do
  echo "FAIL gemini-local-subtask: $f"
done
echo "selftest: $n passed, ${#fails[@]} failed"
exit "${#fails[@]}"

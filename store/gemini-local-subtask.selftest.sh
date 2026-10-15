#!/usr/bin/env bash
# Self-test for store/gemini-local-subtask.sh (card a020247b). No real GPU, no real Ollama, no
# bwrap jail needed -- every dependency is a fake file or a tiny local HTTP stub, all pointed at
# via the script's env overrides (production never sets these; the jail bind-mounts the real
# files at the fixed /opt/gemini-local-subtask/* paths instead).
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
gate_mirror() {  # $1 = admit(true/false), $2 = reason, $3 = age in seconds before "now" (default 0)
  local f="$TD/gate-mirror-$RANDOM.json"
  local at
  at=$(python3 -c "import time; print(time.time() - ${3:-0})")
  printf '{"admit": %s, "reason": "%s", "at": %s}\n' "$1" "$2" "$at" > "$f"
  echo "$f"
}

base_env() {
  GEMINI_LOCAL_SUBTASK_KILLSWITCH="$TD/no-such-killswitch.json"
  GEMINI_LOCAL_SUBTASK_GPU_GATE="$(gate_mirror true ok 0)"
  GEMINI_LOCAL_SUBTASK_GPU_GATE_STALE_S=600
  GEMINI_LOCAL_SUBTASK_LOG="$TD/calls-$n.log"
  GEMINI_LOCAL_SUBTASK_OLLAMA_HOST="http://127.0.0.1:$PORT"
  GEMINI_LOCAL_SUBTASK_TIMEOUT=5
  export GEMINI_LOCAL_SUBTASK_KILLSWITCH GEMINI_LOCAL_SUBTASK_GPU_GATE \
    GEMINI_LOCAL_SUBTASK_GPU_GATE_STALE_S \
    GEMINI_LOCAL_SUBTASK_LOG GEMINI_LOCAL_SUBTASK_OLLAMA_HOST GEMINI_LOCAL_SUBTASK_TIMEOUT
}

case_eq() {  # $1 = label, $2 = expected, $3 = actual
  n=$((n + 1))
  if [ "$2" != "$3" ]; then
    fails+=("$1: expected [$2], got [$3]")
  fi
}

# 1. Kill-switch missing -> proceeds (same convention as local-first-draft-check.sh: absence = ON)
base_env
out="$(echo 'hello' | bash "$SCRIPT" 2>"$TD/err1")"; rc=$?
case_eq "kill-switch-missing: exit 0" "0" "$rc"
case_eq "kill-switch-missing: response" "MOCKED-LOCAL-RESPONSE" "$out"

# 2. Kill-switch explicit enabled:true -> proceeds
base_env
echo '{"enabled":true}' > "$GEMINI_LOCAL_SUBTASK_KILLSWITCH"
out="$(echo 'hello' | bash "$SCRIPT" 2>/dev/null)"; rc=$?
case_eq "kill-switch-true: exit 0" "0" "$rc"

# 3. Kill-switch explicit enabled:false -> refuses, never reaches the GPU gate or Ollama
base_env
echo '{"enabled":false}' > "$GEMINI_LOCAL_SUBTASK_KILLSWITCH"
echo 'hello' | bash "$SCRIPT" >"$TD/out3" 2>"$TD/err3"; rc=$?
case_eq "kill-switch-false: exit 1" "1" "$rc"
grep -q 'killswitch-off' "$TD/err3" || fails+=("kill-switch-false: stderr missing killswitch-off reason")
grep -q $'\tkillswitch-off\t' "$GEMINI_LOCAL_SUBTASK_LOG" || fails+=("kill-switch-false: log missing killswitch-off row")

# 4. Kill-switch corrupt JSON -> treated as ON (same fail-open convention), proceeds
base_env
echo 'not json{{{' > "$GEMINI_LOCAL_SUBTASK_KILLSWITCH"
out="$(echo 'hello' | bash "$SCRIPT" 2>/dev/null)"; rc=$?
case_eq "kill-switch-corrupt: exit 0" "0" "$rc"

# 5. Mirror reports HOLD -> script refuses, never calls Ollama (card a020247b F1)
base_env
GEMINI_LOCAL_SUBTASK_GPU_GATE="$(gate_mirror false gpu-util-hold 0)"
echo 'hello' | bash "$SCRIPT" >"$TD/out5" 2>"$TD/err5"; rc=$?
case_eq "gpu-hold: exit 1" "1" "$rc"
grep -q 'gpu-util-hold' "$TD/err5" || fails+=("gpu-hold: stderr missing gpu-util-hold reason")
grep -q $'\tgpu-util-hold\t' "$GEMINI_LOCAL_SUBTASK_LOG" || fails+=("gpu-hold: log missing gpu-util-hold row")

# 6. Mirror reports ADMIT and is fresh -> proceeds to the real call
base_env
GEMINI_LOCAL_SUBTASK_GPU_GATE="$(gate_mirror true ok 0)"
out="$(echo 'hello' | bash "$SCRIPT" 2>/dev/null)"; rc=$?
case_eq "gpu-admit: exit 0" "0" "$rc"
case_eq "gpu-admit: response" "MOCKED-LOCAL-RESPONSE" "$out"

# 6a. Mirror is ADMIT but STALE (older than the stale threshold) -> doubt -> HOLD (card a020247b F1)
base_env
GEMINI_LOCAL_SUBTASK_GPU_GATE="$(gate_mirror true ok 9999)"
GEMINI_LOCAL_SUBTASK_GPU_GATE_STALE_S=600
echo 'hello' | bash "$SCRIPT" >"$TD/out6a" 2>"$TD/err6a"; rc=$?
case_eq "gpu-stale: exit 1" "1" "$rc"
grep -q 'stale' "$GEMINI_LOCAL_SUBTASK_LOG" || fails+=("gpu-stale: log missing stale detail")

# 6b. Mirror file does not exist at all (fresh host, nothing has reported in yet) -> HOLD, not ADMIT
base_env
GEMINI_LOCAL_SUBTASK_GPU_GATE="$TD/no-such-mirror-$RANDOM.json"
echo 'hello' | bash "$SCRIPT" >"$TD/out6b" 2>"$TD/err6b"; rc=$?
case_eq "gpu-no-mirror: exit 1" "1" "$rc"
grep -q 'no-gate-mirror-yet' "$GEMINI_LOCAL_SUBTASK_LOG" || fails+=("gpu-no-mirror: log missing no-gate-mirror-yet detail")

# 6c. Mirror file is present but corrupt/unparseable -> doubt -> HOLD
base_env
GEMINI_LOCAL_SUBTASK_GPU_GATE="$TD/corrupt-mirror-$RANDOM.json"
echo 'not json{{{' > "$GEMINI_LOCAL_SUBTASK_GPU_GATE"
echo 'hello' | bash "$SCRIPT" >"$TD/out6c" 2>"$TD/err6c"; rc=$?
case_eq "gpu-corrupt-mirror: exit 1" "1" "$rc"
grep -q 'unreadable' "$GEMINI_LOCAL_SUBTASK_LOG" || fails+=("gpu-corrupt-mirror: log missing unreadable detail")

# 6d. A prompt over the kernel's ARG_MAX (card a020247b F4 regression pin, WhiteHat2 19540:
#     previously "python3 -c ... \"\$prompt\"" hit "Argument list too long" silently past ~128 KB).
#     200 KB, well past the measured failure point, must still reach Ollama via stdin and succeed.
base_env
big_prompt="$(python3 -c "print('x' * 200000)")"
out="$(printf '%s' "$big_prompt" | bash "$SCRIPT" 2>"$TD/err6d")"; rc=$?
case_eq "big-prompt: exit 0" "0" "$rc"
case_eq "big-prompt: response" "MOCKED-LOCAL-RESPONSE" "$out"

# 7. Empty prompt (blank stdin) -> refuses before ever touching Ollama
base_env
printf '' | bash "$SCRIPT" >"$TD/out7" 2>"$TD/err7"; rc=$?
case_eq "empty-prompt: exit 1" "1" "$rc"
grep -q 'empty-prompt' "$TD/err7" || fails+=("empty-prompt: stderr missing empty-prompt reason")

# 8. Ollama unreachable -> refuses with ollama-call-failed, does not hang past the timeout
base_env
GEMINI_LOCAL_SUBTASK_OLLAMA_HOST="http://127.0.0.1:1"
GEMINI_LOCAL_SUBTASK_TIMEOUT=2
echo 'hello' | bash "$SCRIPT" >"$TD/out8" 2>"$TD/err8"; rc=$?
case_eq "ollama-down: exit 1" "1" "$rc"
grep -q 'ollama-call-failed' "$TD/err8" || fails+=("ollama-down: stderr missing ollama-call-failed reason")

# 9. The log NEVER contains the prompt text, across every case run above (information-disclosure
#    pin: a secret-shaped or card-identifying prompt must not end up sitting in a file the jailed
#    process itself can read back later).
base_env
SECRET_MARKER="SuperSecretPromptMarker12345"
echo "$SECRET_MARKER" | bash "$SCRIPT" >/dev/null 2>/dev/null
if grep -q "$SECRET_MARKER" "$GEMINI_LOCAL_SUBTASK_LOG" 2>/dev/null; then
  fails+=("log-no-prompt-leak: the prompt text appeared in the call log")
fi

# 10. No filename parameter exists: passing extra argv is ignored (the script never reads argv
#     for the prompt), proving a caller cannot smuggle a file path in as an argument.
base_env
out="$(echo 'hello' | bash "$SCRIPT" "/etc/passwd" "--mappa" "/home/neon/marveen" 2>/dev/null)"; rc=$?
case_eq "argv-ignored: exit 0" "0" "$rc"
case_eq "argv-ignored: response" "MOCKED-LOCAL-RESPONSE" "$out"

for f in "${fails[@]}"; do
  echo "FAIL gemini-local-subtask: $f"
done
echo "selftest: $n passed, ${#fails[@]} failed"
exit "${#fails[@]}"

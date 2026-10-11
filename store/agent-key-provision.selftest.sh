#!/usr/bin/env bash
# Regression test for store/agent-key-provision.sh.
#
# Card 9655494c QA FAIL (16667): the script used to pass DASH_USER/DASH_PASS as python3 argv,
# visible to any local process via /proc/<pid>/cmdline. Fix (16670): the login payload is built
# from stdin, never argv.
#
# Card 9655494c RedHat NO-GO (16825), F1-B2 + F1-B3: the argv-only harness below missed two
# whole classes of leak. F1-B3: it shimmed ONLY python3, so a regression that puts the password
# into curl's own argv (S2), exports it to the environment (S3), or drops the defensive `unset`
# (S4) sailed through "selftest: PASS" every time. F1-B2: the script left LOGIN_PAYLOAD/
# MINT_PAYLOAD/RESPONSE behind in $TMPDIR on any error exit (only COOKIE_JAR was trapped) -- this
# file now also asserts the scratch dir is empty after both a connection failure and a
# write-failure exit.
set -euo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SELF_DIR/agent-key-provision.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REAL_PYTHON3="$(command -v python3)"
REAL_CURL="$(command -v curl)"
SHIM_DIR="$WORK/shim"
mkdir -p "$SHIM_DIR"
CAPTURE_ARGV="$WORK/argv.log"
CAPTURE_STDIN="$WORK/stdin.log"
CAPTURE_ENV="$WORK/env.log"
: > "$CAPTURE_ARGV"
: > "$CAPTURE_STDIN"
: > "$CAPTURE_ENV"

# Shims capture BOTH argv and the full environment of every python3/curl invocation the script
# makes, then forward unchanged to the real binary -- the script under test must behave exactly
# as it would with no shim present.
cat > "$SHIM_DIR/python3" <<SHIM
#!/usr/bin/env bash
set -euo pipefail
STDIN_CONTENT="\$(cat)"
{ printf 'ARGV python3:'; printf ' %q' "\$@"; printf '\n'; } >> "$CAPTURE_ARGV"
printf '%s' "\$STDIN_CONTENT" >> "$CAPTURE_STDIN"
{ printf 'ENV python3:\n'; env; printf '\n'; } >> "$CAPTURE_ENV"
printf '%s' "\$STDIN_CONTENT" | exec "$REAL_PYTHON3" "\$@"
SHIM
chmod +x "$SHIM_DIR/python3"

cat > "$SHIM_DIR/curl" <<SHIM
#!/usr/bin/env bash
set -euo pipefail
{ printf 'ARGV curl:'; printf ' %q' "\$@"; printf '\n'; } >> "$CAPTURE_ARGV"
{ printf 'ENV curl:\n'; env; printf '\n'; } >> "$CAPTURE_ENV"
exec "$REAL_CURL" "\$@"
SHIM
chmod +x "$SHIM_DIR/curl"

AGENTS_ROOT="$WORK/agents"
mkdir -p "$AGENTS_ROOT/testagent"

run_one() { # $1 = script path, $2 (optional) = extra TMPDIR to use for the run
  local script="$1"
  local run_tmpdir="${2:-$WORK/scratch-$$}"
  mkdir -p "$run_tmpdir"
  : > "$CAPTURE_ARGV"
  : > "$CAPTURE_STDIN"
  : > "$CAPTURE_ENV"
  # DASHBOARD_URL deliberately unreachable (connection refused) -- we only need the script to run
  # far enough to build the login payload; the login call itself is expected to fail fast.
  set +e
  PATH="$SHIM_DIR:$PATH" AGENTS_ROOT="$AGENTS_ROOT" MARVEEN_AGENTS_ROOT="$AGENTS_ROOT" \
    DASHBOARD_URL="http://127.0.0.1:1" TMPDIR="$run_tmpdir" \
    bash "$script" testagent <<<'marker-user
MARKER-PASSWORD-7f3a9c' >/dev/null 2>&1
  set -e
}

run_one "$SCRIPT"
if grep -q 'MARKER-PASSWORD-7f3a9c' "$CAPTURE_ARGV" || grep -q 'marker-user' "$CAPTURE_ARGV"; then
  echo "FAIL: credential leaked into argv (python3 or curl): $(cat "$CAPTURE_ARGV")" >&2
  exit 1
fi
if grep -q 'MARKER-PASSWORD-7f3a9c' "$CAPTURE_ENV"; then
  echo "FAIL: credential leaked into a child process environment" >&2
  exit 1
fi
if ! grep -q 'MARKER-PASSWORD-7f3a9c' "$CAPTURE_STDIN"; then
  echo "FAIL: credential never reached python3 via stdin either -- payload wasn't built at all" >&2
  exit 1
fi
echo "ok   fixed script: credential not in argv (python3 or curl) or env, present on stdin"

if grep -nE 'python3[^#]*"\$DASH_(USER|PASS)"' "$SCRIPT"; then
  echo "FAIL: old-style credential-as-argv pattern found in $SCRIPT" >&2
  exit 1
fi
echo "ok   static regression guard: the old argv-passing shape must not reappear"

if ! grep -q 'unset DASH_PASS' "$SCRIPT"; then
  echo "FAIL: the defensive 'unset DASH_PASS' line is missing (F1-B3/S4)" >&2
  exit 1
fi
echo "ok   static regression guard: 'unset DASH_PASS' is present"

# F1-B2: the scratch dir the script itself creates (via mktemp -d under TMPDIR) must be gone
# after ANY exit path -- including a failure that happens before the script's own happy-path
# cleanup would run. A connection failure (the scenario above, DASHBOARD_URL unreachable) is one
# such path; confirm the sandbox TMPDIR we gave it is left with nothing in it.
RUN_TMPDIR="$WORK/scenario-unreachable"
mkdir -p "$RUN_TMPDIR"
run_one "$SCRIPT" "$RUN_TMPDIR"
LEFTOVER="$(find "$RUN_TMPDIR" -mindepth 1 2>/dev/null | wc -l)"
if [ "$LEFTOVER" != "0" ]; then
  echo "FAIL: TMPDIR not empty after a connection-failure exit ($LEFTOVER leftover entries)" >&2
  find "$RUN_TMPDIR" -mindepth 1 >&2
  exit 1
fi
echo "ok   F1-B2: TMPDIR empty after a dashboard-unreachable exit"

# Second F1-B2 scenario: login and mint both SUCCEED (a tiny fake dashboard), but writing the key
# file fails (the agent directory is read-only) -- the raw agent key, which only ever exists in
# the mint RESPONSE file, must not survive in TMPDIR either.
cat > "$WORK/fake-dashboard.py" <<'PYEOF'
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        self.rfile.read(n)
        if self.path == '/api/auth/login':
            self.send_response(200)
            self.send_header('Set-Cookie', 'session=fake')
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        elif self.path == '/api/auth/agent-keys':
            self.send_response(201)
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "key": "RAW-AGENT-KEY-SHOULD-NOT-PERSIST"}).encode())
        else:
            self.send_response(404); self.end_headers()
port = int(sys.argv[1])
http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()
PYEOF
PORT=$((20000 + RANDOM % 20000))
"$REAL_PYTHON3" "$WORK/fake-dashboard.py" "$PORT" &
FAKE_PID=$!
sleep 0.3

READONLY_AGENT_DIR="$WORK/readonly-agents"
mkdir -p "$READONLY_AGENT_DIR/testagent"
chmod 500 "$READONLY_AGENT_DIR/testagent"
RUN_TMPDIR2="$WORK/scenario-unwritable"
mkdir -p "$RUN_TMPDIR2"
set +e
AGENTS_ROOT="$READONLY_AGENT_DIR" MARVEEN_AGENTS_ROOT="$READONLY_AGENT_DIR" \
  DASHBOARD_URL="http://127.0.0.1:$PORT" TMPDIR="$RUN_TMPDIR2" \
  bash "$SCRIPT" testagent <<<'marker-user
MARKER-PASSWORD-7f3a9c' >/dev/null 2>&1
MINT_EXIT=$?
set -e
kill "$FAKE_PID" 2>/dev/null || true
wait "$FAKE_PID" 2>/dev/null || true
chmod 700 "$READONLY_AGENT_DIR/testagent"

if [ "$MINT_EXIT" = "0" ]; then
  echo "FAIL: expected the mint to fail when the agent directory is read-only, it exited 0" >&2
  exit 1
fi
LEFTOVER2="$(find "$RUN_TMPDIR2" -mindepth 1 2>/dev/null | wc -l)"
if [ "$LEFTOVER2" != "0" ]; then
  echo "FAIL: TMPDIR not empty after a key-file-unwritable exit ($LEFTOVER2 leftover entries)" >&2
  find "$RUN_TMPDIR2" -mindepth 1 >&2
  exit 1
fi
echo "ok   F1-B2: TMPDIR empty after a key-file-unwritable exit (raw key did not persist)"

# F1-B3 mutation checks: revert the fix piece by piece and confirm THIS harness (now shimming
# curl too, and scanning env) actually catches each regression RedHat measured as a silent pass.
MUTANT="$WORK/agent-key-provision-mutant.sh"

mutate() { # $1 = python label for the assertion, $2 = from, $3 = to
  python3 - "$SCRIPT" "$MUTANT" "$2" "$3" <<'PYEOF'
import sys
src = open(sys.argv[1]).read()
frm, to = sys.argv[3], sys.argv[4]
assert frm in src, f"text to replace not found verbatim -- selftest out of sync with script: {frm!r}"
open(sys.argv[2], 'w').write(src.replace(frm, to, 1))
PYEOF
}

# S1 (pre-existing): credentials passed as python3 argv instead of over stdin.
mutate S1 \
"printf '%s\n%s\n' \"\$DASH_USER\" \"\$DASH_PASS\" | python3 -c \"
import json, sys
user = sys.stdin.readline().rstrip('\n')
password = sys.stdin.readline().rstrip('\n')
json.dump({'username': user, 'password': password}, open(sys.argv[1], 'w'))
\" \"\$LOGIN_PAYLOAD\"" \
"python3 -c \"import json,sys; json.dump({'username': sys.argv[1], 'password': sys.argv[2]}, open(sys.argv[3], 'w'))\" \"\$DASH_USER\" \"\$DASH_PASS\" \"\$LOGIN_PAYLOAD\""
run_one "$MUTANT"
if ! grep -q 'MARKER-PASSWORD-7f3a9c' "$CAPTURE_ARGV"; then
  echo "FAIL: S1 mutant (credential as python3 argv) did not trip the argv check" >&2
  exit 1
fi
echo "ok   mutation S1: credential-as-python3-argv regression is caught"

# S2 (RedHat 16825 F1-B3): the login payload read from a file (--data-binary "@$LOGIN_PAYLOAD")
# is replaced with the payload inlined as a literal curl argument -- the exact shape the old,
# python3-only shim could never see.
mutate S2 \
'--data-binary "@$LOGIN_PAYLOAD")"' \
'--data-binary "$(cat "$LOGIN_PAYLOAD")")"'
run_one "$MUTANT"
if ! grep -q 'MARKER-PASSWORD-7f3a9c' "$CAPTURE_ARGV"; then
  echo "FAIL: S2 mutant (credential inlined into curl argv) did not trip the argv check" >&2
  exit 1
fi
echo "ok   mutation S2: credential-as-curl-argv regression is caught"

# S3 (RedHat 16825 F1-B3): DASH_PASS is exported, so every child process (curl, python3) inherits
# it in its environment.
mutate S3 'unset DASH_PASS' 'export DASH_PASS'
run_one "$MUTANT"
if ! grep -q 'MARKER-PASSWORD-7f3a9c' "$CAPTURE_ENV"; then
  echo "FAIL: S3 mutant (export DASH_PASS) did not trip the env check" >&2
  exit 1
fi
echo "ok   mutation S3: DASH_PASS-exported-to-environment regression is caught"

# S4 (RedHat 16825 F1-B3): the defensive unset is simply deleted.
mutate S4 'unset DASH_PASS' '# the clearing line was removed by this mutant'
if grep -q 'unset DASH_PASS' "$MUTANT"; then
  echo "FAIL: S4 mutant still contains 'unset DASH_PASS' -- mutation didn't take" >&2
  exit 1
fi
echo "ok   mutation S4: static guard above would reject a script missing the unset (verified by construction)"

echo "selftest: PASS"

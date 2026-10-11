#!/usr/bin/env bash
# Regression test for card 9655494c QA FAIL (16667): store/agent-key-provision.sh used to pass
# DASH_USER/DASH_PASS as python3 argv, visible to any local process via /proc/<pid>/cmdline.
# Fix (16670): the login payload is now built from stdin, never argv.
#
# This test intercepts the real python3 invocation via a PATH shim that logs the exact argv (and
# forwards stdin unchanged to the real interpreter), then asserts the credentials never appear in
# that argv log while they DO appear on stdin (proving the data still actually flows).
set -euo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SELF_DIR/agent-key-provision.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REAL_PYTHON3="$(command -v python3)"
SHIM_DIR="$WORK/shim"
mkdir -p "$SHIM_DIR"
CAPTURE_ARGV="$WORK/argv.log"
CAPTURE_STDIN="$WORK/stdin.log"
: > "$CAPTURE_ARGV"
: > "$CAPTURE_STDIN"

cat > "$SHIM_DIR/python3" <<SHIM
#!/usr/bin/env bash
set -euo pipefail
STDIN_CONTENT="\$(cat)"
{ printf 'ARGV:'; printf ' %q' "\$@"; printf '\n'; } >> "$CAPTURE_ARGV"
printf '%s' "\$STDIN_CONTENT" >> "$CAPTURE_STDIN"
printf '%s' "\$STDIN_CONTENT" | exec "$REAL_PYTHON3" "\$@"
SHIM
chmod +x "$SHIM_DIR/python3"

AGENTS_ROOT="$WORK/agents"
mkdir -p "$AGENTS_ROOT/testagent"

run_one() {
  local script="$1"
  : > "$CAPTURE_ARGV"
  : > "$CAPTURE_STDIN"
  # DASHBOARD_URL deliberately unreachable (connection refused) -- we only need the script to run
  # far enough to build the login payload; the login call itself is expected to fail fast.
  set +e
  PATH="$SHIM_DIR:$PATH" AGENTS_ROOT="$AGENTS_ROOT" MARVEEN_AGENTS_ROOT="$AGENTS_ROOT" \
    DASHBOARD_URL="http://127.0.0.1:1" \
    bash "$script" testagent <<<'marker-user
MARKER-PASSWORD-7f3a9c' >/dev/null 2>&1
  set -e
}

run_one "$SCRIPT"
if grep -q 'MARKER-PASSWORD-7f3a9c' "$CAPTURE_ARGV" || grep -q 'marker-user' "$CAPTURE_ARGV"; then
  echo "FAIL: credential leaked into python3 argv (CAPTURE_ARGV): $(cat "$CAPTURE_ARGV")" >&2
  exit 1
fi
if ! grep -q 'MARKER-PASSWORD-7f3a9c' "$CAPTURE_STDIN"; then
  echo "FAIL: credential never reached python3 via stdin either -- payload wasn't built at all" >&2
  exit 1
fi
echo "ok   fixed script: credential not in python3 argv, present on stdin"

if grep -nE 'python3[^#]*"\$DASH_(USER|PASS)"' "$SCRIPT"; then
  echo "FAIL: old-style credential-as-argv pattern found in $SCRIPT" >&2
  exit 1
fi
echo "ok   static regression guard: the old argv-passing shape must not reappear"


MUTANT="$WORK/agent-key-provision-mutant.sh"
python3 - "$SCRIPT" "$MUTANT" <<'PYEOF'
import sys
src = open(sys.argv[1]).read()
fixed_block = (
    "printf '%s\\n%s\\n' \"$DASH_USER\" \"$DASH_PASS\" | python3 -c \"\n"
    "import json, sys\n"
    "user = sys.stdin.readline().rstrip('\\n')\n"
    "password = sys.stdin.readline().rstrip('\\n')\n"
    "json.dump({'username': user, 'password': password}, open(sys.argv[1], 'w'))\n"
    "\" \"$LOGIN_PAYLOAD\""
)
mutant_block = (
    "python3 -c \"import json,sys; "
    "json.dump({'username': sys.argv[1], 'password': sys.argv[2]}, open(sys.argv[3], 'w'))\" "
    "\"$DASH_USER\" \"$DASH_PASS\" \"$LOGIN_PAYLOAD\""
)
assert fixed_block in src, "fixed_block not found verbatim -- selftest out of sync with script"
open(sys.argv[2], 'w').write(src.replace(fixed_block, mutant_block))
PYEOF
run_one "$MUTANT"
if ! grep -q 'MARKER-PASSWORD-7f3a9c' "$CAPTURE_ARGV"; then
  echo "FAIL: mutant (pre-fix shape) did not trip the argv check -- test 1 is not actually testing anything" >&2
  exit 1
fi
echo "ok   mutation check: reverting the fix makes the argv check fail (test actually catches the bug)"

echo "selftest: PASS"

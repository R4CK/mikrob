#!/usr/bin/env bash
# Regression test for card ca1b763c WhiteHat N1 HIGH (komment 23023): the bwrap process itself
# becomes pid 1 of the sandbox's pid namespace, and /proc/1/environ is readable from inside. An
# `env -i` wrapped only around the exec'd node process leaves bwrap's OWN process -- pid 1 --
# running with the wrapper's full, unstripped caller environment, so a sandboxed engine reading
# /proc/1/environ sees everything the inner env -i was supposed to hide, even though the process
# the wrapper actually execs (pid 2) looks correctly minimal.
#
# This builds a one-line-diff PROBE copy of the real script (swapping only the final
# `node "$REA_SCRIPT" mcp "$@"` line for a command that dumps /proc/1/environ and
# /proc/self/environ), verifies the diff really is exactly that one line (so the probe is
# exercising the real BIND_ARGS/env logic, not a separately-maintained copy that could drift),
# then runs it with known canary/secret-shaped names in the CALLER's environment and asserts
# neither pid sees them.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REAL="$SCRIPT_DIR/rea-bwrap-sandbox.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
PASS=0

check() {
  local desc="$1" ok="$2"
  if [ "$ok" = "1" ]; then
    echo "ok   $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL $desc"
    FAIL=$((FAIL + 1))
  fi
}

# The final exec target is always the real script's LAST line (checked below, rather than
# matched by a sed pattern -- a sed replacement string treats \0/\n specially, which turned a
# previous version of this probe into mangled garbage instead of a clean one-line swap).
LAST_LINE="$(tail -n 1 "$REAL")"
PROBE="$WORK/rea-bwrap-sandbox-probe.sh"
head -n -1 "$REAL" > "$PROBE"
printf '  sh -c %s\n' \
  "'echo ---PID1---; tr \"\\0\" \"\\n\" < /proc/1/environ; echo ---SELF---; tr \"\\0\" \"\\n\" < /proc/self/environ'" \
  >> "$PROBE"
chmod +x "$PROBE"

check "the real script's last line is still the expected node exec (so the probe swap below is valid)" \
  "$([ "$LAST_LINE" = '  node "$REA_SCRIPT" "${REA_ARGS[@]}"' ] && echo 1 || echo 0)"
DIFF_LINES="$(diff "$REAL" "$PROBE" | grep -c '^[<>]' || true)"
check "the probe copy differs from the real script by exactly one line (the final exec target)" \
  "$([ "$DIFF_LINES" = "2" ] && echo 1 || echo 0)"

OUT="$(
  env -i \
    FAKE_CANARY_TOKEN="should-not-leak-$$" \
    SSH_AUTH_SOCK="/tmp/fake-ssh-agent.sock" \
    CLAUDE_CODE_MESSAGING_TOKEN="fake-messaging-token" \
    GPG_AGENT_INFO="fake-gpg-agent-info" \
    HOME="$HOME" \
    PATH="/usr/bin:/bin" \
    JAVA_HOME="/usr" \
    GHIDRA_INSTALL_DIR="/usr" \
    REA_JADX_MCP_JAR="/usr/bin/true" \
    REA_KUNA_COMMAND="/usr/bin/true" \
    bash "$PROBE" 2>&1
)" || true

PID1_SECTION="$(printf '%s\n' "$OUT" | sed -n '/---PID1---/,/---SELF---/p')"
SELF_SECTION="$(printf '%s\n' "$OUT" | sed -n '/---SELF---/,$p')"

for leak in FAKE_CANARY_TOKEN SSH_AUTH_SOCK CLAUDE_CODE_MESSAGING_TOKEN GPG_AGENT_INFO; do
  check "pid 1 (bwrap init) environ does not leak $leak" \
    "$(printf '%s' "$PID1_SECTION" | grep -q "^${leak}=" && echo 0 || echo 1)"
  check "pid 2 (the exec'd process) environ does not leak $leak" \
    "$(printf '%s' "$SELF_SECTION" | grep -q "^${leak}=" && echo 0 || echo 1)"
done

for allowed in HOME PATH JAVA_HOME GHIDRA_INSTALL_DIR REA_JADX_MCP_JAR REA_KUNA_COMMAND; do
  check "pid 1 environ carries the allowed $allowed" \
    "$(printf '%s' "$PID1_SECTION" | grep -q "^${allowed}=" && echo 1 || echo 0)"
done

if [ "$FAIL" -eq 0 ]; then
  echo "selftest: $PASS passed, 0 failed"
  exit 0
else
  echo "selftest: $PASS passed, $FAIL failed"
  exit 1
fi

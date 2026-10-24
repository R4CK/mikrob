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
  "$([ "$LAST_LINE" = '  "$NODE_BIN" "$REA_SCRIPT" "${REA_ARGS[@]}"' ] && echo 1 || echo 0)"
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

# Regression test for RedHat NO-GO (card ca1b763c, komment 23049): the registered PATH's first
# element is $JAVA_HOME/bin, a directory owned by the SAME user (neon) running the wrapper and
# every engine -- a binary planted there named bwrap/env/node would run instead of the real one
# if the wrapper looked them up via a bare-name PATH search. Plant fake, sentinel-writing
# bwrap/env/node in a throwaway dir, put it FIRST in PATH (exactly the threat shape), and confirm
# the real wrapper never executes them.
HIJACK_DIR="$WORK/hijack-bin"
mkdir -p "$HIJACK_DIR"
SENTINEL="$WORK/hijacked"
for fake in bwrap env node; do
  cat > "$HIJACK_DIR/$fake" <<EOF
#!/usr/bin/env bash
echo "$fake" >> "$SENTINEL"
exit 1
EOF
  chmod +x "$HIJACK_DIR/$fake"
done
env -i \
  HOME="$HOME" \
  PATH="$HIJACK_DIR:/usr/bin:/bin" \
  JAVA_HOME="/usr" \
  GHIDRA_INSTALL_DIR="/usr" \
  REA_JADX_MCP_JAR="/usr/bin/true" \
  REA_KUNA_COMMAND="/usr/bin/true" \
  bash "$REAL" doctor >/dev/null 2>&1 || true
check "a bwrap/env/node planted first in PATH is never executed (resolved via trusted absolute path instead)" \
  "$([ ! -f "$SENTINEL" ] && echo 1 || echo 0)"

# Regression tests for card 9518b377 (ca1b763c N2 follow-up): configurable network egress
# (default-closed) and the sample-submission bind (restricted to elemzo's own directory).
BASE_ENV=(
  HOME="$HOME"
  PATH="/usr/bin:/bin"
  JAVA_HOME="/usr"
  GHIDRA_INSTALL_DIR="/usr"
  REA_JADX_MCP_JAR="/usr/bin/true"
  REA_KUNA_COMMAND="/usr/bin/true"
)

# /sys isn't bound into the sandbox at all, so /sys/class/net is unusable as a signal either
# way -- use /proc/net/dev (under the bound --proc) instead: a fresh, unshared netns shows
# only an empty/idle "lo", while sharing the host's netns shows the host's real interfaces
# (eth0, tailscale0, ...) with nonzero traffic counters too.
NET_PROBE="$WORK/net-probe.sh"
head -n -1 "$REAL" > "$NET_PROBE"
printf '  sh -c %s\n' "'cat /proc/net/dev'" >> "$NET_PROBE"
chmod +x "$NET_PROBE"

NET_OUT_DEFAULT="$(env -i "${BASE_ENV[@]}" bash "$NET_PROBE" 2>&1)" || true
check "default (REA_NET_ALLOW unset) sees only its own empty lo, no host interface (fail-closed)" \
  "$([ "$(printf '%s' "$NET_OUT_DEFAULT" | grep -cE '^\s*(lo|eth0|tailscale0):')" = "1" ] && echo 1 || echo 0)"

NET_OUT_ALLOWED="$(env -i "${BASE_ENV[@]}" REA_NET_ALLOW=1 bash "$NET_PROBE" 2>&1)" || true
check "REA_NET_ALLOW=1 shares the host network namespace (host's eth0 visible)" \
  "$(printf '%s' "$NET_OUT_ALLOWED" | grep -qE '^\s*eth0:' && echo 1 || echo 0)"

ELEMZO_ROOT="/home/neon/marveen/agents/elemzo"
check "REA_SAMPLE_DIR outside elemzo's own directory is refused" \
  "$(env -i "${BASE_ENV[@]}" REA_SAMPLE_DIR="/home/neon/marveen/store" bash "$REAL" doctor >/dev/null 2>&1; [ $? -eq 1 ] && echo 1 || echo 0)"
check "REA_SAMPLE_DIR pointing at elemzo's .claude-config is refused" \
  "$(env -i "${BASE_ENV[@]}" REA_SAMPLE_DIR="$ELEMZO_ROOT/.claude-config" bash "$REAL" doctor >/dev/null 2>&1; [ $? -eq 1 ] && echo 1 || echo 0)"
check "REA_SAMPLE_DIR under elemzo's own directory but nonexistent is refused" \
  "$(env -i "${BASE_ENV[@]}" REA_SAMPLE_DIR="$ELEMZO_ROOT/does-not-exist-9518b377" bash "$REAL" doctor >/dev/null 2>&1; [ $? -eq 1 ] && echo 1 || echo 0)"

SAMPLE_DIR="$ELEMZO_ROOT/selftest-samples-9518b377"
mkdir -p "$SAMPLE_DIR"
echo marker > "$SAMPLE_DIR/marker.txt"
SAMPLE_PROBE="$WORK/sample-probe.sh"
head -n -1 "$REAL" > "$SAMPLE_PROBE"
printf '  sh -c %s\n' \
  "'cat $SAMPLE_DIR/marker.txt 2>&1 || echo SAMPLE_NOT_VISIBLE'" \
  >> "$SAMPLE_PROBE"
chmod +x "$SAMPLE_PROBE"
SAMPLE_OUT="$(env -i "${BASE_ENV[@]}" REA_SAMPLE_DIR="$SAMPLE_DIR" bash "$SAMPLE_PROBE" 2>&1)" || true
check "a valid REA_SAMPLE_DIR under elemzo's directory is read-bindable inside the sandbox" \
  "$(printf '%s' "$SAMPLE_OUT" | grep -q "^marker$" && echo 1 || echo 0)"
rm -rf "$SAMPLE_DIR"

# Regression test for the RW cache scope narrowing: only the known engine subdirs are
# writable inside $HOME/.cache/rea, everything else in that tree is read-only.
CACHE_PROBE="$WORK/cache-probe.sh"
head -n -1 "$REAL" > "$CACHE_PROBE"
printf '  sh -c %s\n' \
  "'echo x > \$HOME/.cache/rea/kuna/selftest-9518b377.tmp 2>&1 && echo KUNA_WRITABLE; echo y > \$HOME/.cache/rea/unexpected-subdir-9518b377.tmp 2>&1 || echo UNEXPECTED_RO'" \
  >> "$CACHE_PROBE"
chmod +x "$CACHE_PROBE"
CACHE_OUT="$(env -i "${BASE_ENV[@]}" bash "$CACHE_PROBE" 2>&1)" || true
check "the known kuna cache subdir stays writable" \
  "$(printf '%s' "$CACHE_OUT" | grep -q "KUNA_WRITABLE" && echo 1 || echo 0)"
check "an unlisted subdir of ~/.cache/rea is read-only (narrowed from the previous whole-tree RW bind)" \
  "$(printf '%s' "$CACHE_OUT" | grep -q "UNEXPECTED_RO" && echo 1 || echo 0)"
rm -f "$HOME/.cache/rea/kuna/selftest-9518b377.tmp"

if [ "$FAIL" -eq 0 ]; then
  echo "selftest: $PASS passed, 0 failed"
  exit 0
else
  echo "selftest: $PASS passed, $FAIL failed"
  exit 1
fi

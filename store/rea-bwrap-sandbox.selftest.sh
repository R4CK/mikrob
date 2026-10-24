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
SAMPLES_ROOT="$ELEMZO_ROOT/samples"
mkdir -p "$SAMPLES_ROOT"
check "REA_SAMPLE_DIR outside the dedicated samples/ allowlist directory is refused (WhiteHat F3, komment 23921)" \
  "$(env -i "${BASE_ENV[@]}" REA_SAMPLE_DIR="/home/neon/marveen/store" bash "$REAL" doctor >/dev/null 2>&1; [ $? -eq 1 ] && echo 1 || echo 0)"
check "REA_SAMPLE_DIR pointing at elemzo's .claude-config (not under samples/) is refused" \
  "$(env -i "${BASE_ENV[@]}" REA_SAMPLE_DIR="$ELEMZO_ROOT/.claude-config" bash "$REAL" doctor >/dev/null 2>&1; [ $? -eq 1 ] && echo 1 || echo 0)"
check "REA_SAMPLE_DIR pointing at elemzo's readable .claude/ (not under samples/) is refused -- the denylist this replaces would NOT have caught this" \
  "$(env -i "${BASE_ENV[@]}" REA_SAMPLE_DIR="$ELEMZO_ROOT/.claude" bash "$REAL" doctor >/dev/null 2>&1; [ $? -eq 1 ] && echo 1 || echo 0)"
check "REA_SAMPLE_DIR under samples/ but nonexistent is refused" \
  "$(env -i "${BASE_ENV[@]}" REA_SAMPLE_DIR="$SAMPLES_ROOT/does-not-exist-9518b377" bash "$REAL" doctor >/dev/null 2>&1; [ $? -eq 1 ] && echo 1 || echo 0)"

# Regression test for WhiteHat F1 (komment 23921, PoC C3-equivalent): a fake `readlink` planted
# first in PATH used to be able to fool the sample-dir check into resolving an out-of-scope
# path as if it were inside the allowlist. With the script's own PATH now pinned to
# /usr/bin:/bin (F1 fix), the planted readlink is never consulted -- the real one runs, and an
# out-of-scope REA_SAMPLE_DIR is still refused even with the hijack directory first in PATH.
FAKE_READLINK_DIR="$WORK/hijack-readlink"
mkdir -p "$FAKE_READLINK_DIR"
cat > "$FAKE_READLINK_DIR/readlink" <<EOF
#!/usr/bin/env bash
echo "$SAMPLES_ROOT/fooled-by-hijacked-readlink"
EOF
chmod +x "$FAKE_READLINK_DIR/readlink"
env -i \
  HOME="$HOME" PATH="$FAKE_READLINK_DIR:/usr/bin:/bin" \
  JAVA_HOME="/usr" GHIDRA_INSTALL_DIR="/usr" \
  REA_JADX_MCP_JAR="/usr/bin/true" REA_KUNA_COMMAND="/usr/bin/true" \
  REA_SAMPLE_DIR="/home/neon/marveen/store" \
  bash "$REAL" doctor >/dev/null 2>&1 && RC_HIJACKED_READLINK=0 || RC_HIJACKED_READLINK=$?
check "a hijacked readlink planted first in PATH cannot fool the REA_SAMPLE_DIR allowlist (rc=1, fail-closed)" \
  "$([ "$RC_HIJACKED_READLINK" -eq 1 ] && echo 1 || echo 0)"

# Extended hijack coverage (WhiteHat F1, komment 23921): the previous hijack test only planted
# fake bwrap/env/node. readlink/sha256sum/sed/sort/cut/dirname/mkdir/find/grep are also called
# by this script and were equally hijackable via the registered PATH before the F1 fix pinned
# the script's own PATH to /usr/bin:/bin.
HIJACK_DIR2="$WORK/hijack-bin-2"
mkdir -p "$HIJACK_DIR2"
SENTINEL2="$WORK/hijacked2"
for fake in bwrap env node readlink sha256sum sed sort cut dirname mkdir find grep; do
  cat > "$HIJACK_DIR2/$fake" <<EOF
#!/usr/bin/env bash
echo "$fake" >> "$SENTINEL2"
exit 1
EOF
  chmod +x "$HIJACK_DIR2/$fake"
done
HIJACK_SAMPLE_DIR="$SAMPLES_ROOT/selftest-hijack-9518b377"
mkdir -p "$HIJACK_SAMPLE_DIR"
env -i \
  HOME="$HOME" PATH="$HIJACK_DIR2:/usr/bin:/bin" \
  JAVA_HOME="/usr" GHIDRA_INSTALL_DIR="/usr" \
  REA_JADX_MCP_JAR="/usr/bin/true" REA_KUNA_COMMAND="/usr/bin/true" \
  REA_SAMPLE_DIR="$HIJACK_SAMPLE_DIR" \
  bash "$REAL" doctor >/dev/null 2>&1 || true
check "none of bwrap/env/node/readlink/sha256sum/sed/sort/cut/dirname/mkdir/find/grep planted first in PATH are ever executed" \
  "$([ ! -f "$SENTINEL2" ] && echo 1 || echo 0)"
rm -rf "$HIJACK_SAMPLE_DIR"

SAMPLE_DIR="$SAMPLES_ROOT/selftest-samples-9518b377"
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

# Regression test for WhiteHat F2 (komment 23921): the integrity pin must cover the WHOLE
# package tree, not just scripts/rea.mjs -- a tampered dist/** file must be caught. Copy the
# real cached rea-agents package into an isolated fake $HOME (so this never touches the real,
# shared npx cache), confirm the unmodified copy passes the hash check (it may still fail
# LATER for unrelated reasons -- module resolution against an isolated fake HOME -- that is not
# what this test is checking), then tamper one dist file in the COPY and confirm it is refused
# with a hash-mismatch message before node ever runs.
REAL_PKG_DIR="$(dirname "$(find "$HOME/.npm/_npx" -maxdepth 4 -path '*/node_modules/rea-agents/package.json' -exec grep -l '"version": "6.7.0"' {} \; 2>/dev/null | head -1)" 2>/dev/null)"
if [ -n "$REAL_PKG_DIR" ] && [ -d "$REAL_PKG_DIR" ]; then
  FAKE_HOME="$WORK/fakehome-f2"
  mkdir -p "$FAKE_HOME/.npm/_npx/testhash/node_modules"
  cp -r "$REAL_PKG_DIR" "$FAKE_HOME/.npm/_npx/testhash/node_modules/rea-agents"
  F2_UNMODIFIED_ERR="$(env -i HOME="$FAKE_HOME" PATH=/usr/bin:/bin JAVA_HOME=/usr GHIDRA_INSTALL_DIR=/usr REA_JADX_MCP_JAR=/usr/bin/true REA_KUNA_COMMAND=/usr/bin/true bash "$REAL" doctor 2>&1)" || true
  check "an unmodified copy of the real package tree passes the manifest-hash check (no mismatch message)" \
    "$(printf '%s' "$F2_UNMODIFIED_ERR" | grep -q "package-tree hash mismatch" && echo 0 || echo 1)"
  echo "// tampered-by-selftest-9518b377" >> "$FAKE_HOME/.npm/_npx/testhash/node_modules/rea-agents/dist/mcp/main.js"
  F2_TAMPERED_OUT="$(env -i HOME="$FAKE_HOME" PATH=/usr/bin:/bin JAVA_HOME=/usr GHIDRA_INSTALL_DIR=/usr REA_JADX_MCP_JAR=/usr/bin/true REA_KUNA_COMMAND=/usr/bin/true bash "$REAL" doctor 2>&1)" && F2_TAMPERED_RC=0 || F2_TAMPERED_RC=$?
  check "tampering a single dist/** file (not just the entrypoint) is caught: refused with rc=1 and a hash-mismatch message" \
    "$([ "$F2_TAMPERED_RC" -eq 1 ] && printf '%s' "$F2_TAMPERED_OUT" | grep -q "package-tree hash mismatch" && echo 1 || echo 0)"
  rm -rf "$FAKE_HOME"
else
  check "F2 package-tree tamper test (skipped: no cached rea-agents@6.7.0 found to copy from -- not a pass/fail of the pin itself)" "1"
fi

if [ "$FAIL" -eq 0 ]; then
  echo "selftest: $PASS passed, 0 failed"
  exit 0
else
  echo "selftest: $PASS passed, $FAIL failed"
  exit 1
fi

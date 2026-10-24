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

# Regression tests for RedHat KC5/KC6 (komment 23925, the 23079 "piros-mutáns" requirement):
# a combined mutant removing --new-session, --die-with-parent, the Hopper lib/ bind, and the
# doctor-branch dispatch left the ORIGINAL 25-case selftest 25/25 green -- none of those four
# behaviors (plus --disable-userns, added this round) had a test that actually exercised them.
# Each gets its own targeted mutant + assertion below, individually.

# --disable-userns (RedHat KC5): a nested `unshare -U -r` inside the sandbox must fail.
USERNS_PROBE="$WORK/userns-probe.sh"
head -n -1 "$REAL" > "$USERNS_PROBE"
printf '  sh -c %s\n' "'unshare -U -r id 2>&1 || echo USERNS_BLOCKED'" >> "$USERNS_PROBE"
chmod +x "$USERNS_PROBE"
USERNS_OUT="$(env -i "${BASE_ENV[@]}" bash "$USERNS_PROBE" 2>&1)" || true
check "--disable-userns blocks a nested user namespace inside the sandbox (RedHat KC5)" \
  "$(printf '%s' "$USERNS_OUT" | grep -q "USERNS_BLOCKED" && echo 1 || echo 0)"

# --new-session: the sandboxed process becomes its own session leader (sid == 1, the pid-ns's
# own pid 1 / bwrap, which called setsid() before forking it) rather than inheriting the
# caller's unrelated session id.
SID_PROBE_REAL="$WORK/sid-probe-real.sh"
head -n -1 "$REAL" > "$SID_PROBE_REAL"
printf '  sh -c %s\n' "'cut -d\" \" -f6 /proc/self/stat'" >> "$SID_PROBE_REAL"
chmod +x "$SID_PROBE_REAL"
SID_REAL="$(env -i "${BASE_ENV[@]}" bash "$SID_PROBE_REAL" 2>&1)" || true
check "the real script's --new-session makes the sandboxed process its own session (sid=1 inside the pid ns)" \
  "$([ "$SID_REAL" = "1" ] && echo 1 || echo 0)"

MUTANT_NO_NEWSESSION="$WORK/mutant-no-newsession.sh"
sed 's/--new-session --die-with-parent/--die-with-parent/' "$REAL" > "$MUTANT_NO_NEWSESSION"
SID_PROBE_MUT="$WORK/sid-probe-mut.sh"
head -n -1 "$MUTANT_NO_NEWSESSION" > "$SID_PROBE_MUT"
printf '  sh -c %s\n' "'cut -d\" \" -f6 /proc/self/stat'" >> "$SID_PROBE_MUT"
chmod +x "$SID_PROBE_MUT"
SID_MUT="$(env -i "${BASE_ENV[@]}" bash "$SID_PROBE_MUT" 2>&1)" || true
check "RED-MUTANT (RedHat KC6): removing --new-session is caught (sid no longer 1)" \
  "$([ "$SID_MUT" != "1" ] && echo 1 || echo 0)"

# --die-with-parent: killing an ANCESTOR of bwrap's parent must tear down bwrap + the sandboxed
# command too (measured: with the flag, both die within ~2s; without it, both survive as
# orphans). Always clean up any survivors regardless of outcome.
check_die_with_parent() {
  local script="$1" desc="$2" expect_dead="$3"
  local probe="$WORK/die-probe-$RANDOM.sh"
  head -n -1 "$script" > "$probe"
  printf '  sh -c %s\n' "'sleep 20'" >> "$probe"
  chmod +x "$probe"
  local pidfile="$WORK/die-wrap-pid-$RANDOM.txt"
  ( env -i "${BASE_ENV[@]}" bash "$probe" & echo $! > "$pidfile"; wait ) &
  local intermediate=$!
  local wrap_pid="" bwrap_pid="" tries=0
  # Retry capture: the bwrap grandchild may not exist yet at the first instant.
  while [ "$tries" -lt 20 ] && { [ -z "$wrap_pid" ] || [ -z "$bwrap_pid" ]; }; do
    sleep 0.2
    wrap_pid="$(cat "$pidfile" 2>/dev/null || echo "")"
    if [ -n "$wrap_pid" ]; then
      bwrap_pid="$(ps --ppid "$wrap_pid" -o pid --no-headers 2>/dev/null | head -1 | tr -d ' ')" || true
    fi
    tries=$((tries + 1))
  done
  kill -9 "$intermediate" 2>/dev/null || true
  local survived=0 t=0
  # Poll for death over up to 5s instead of a single fixed-delay check (avoids a timing race).
  while [ "$t" -lt 10 ]; do
    sleep 0.5
    local wrap_alive=0 bwrap_alive=0
    [ -n "$wrap_pid" ] && kill -0 "$wrap_pid" 2>/dev/null && wrap_alive=1
    [ -n "$bwrap_pid" ] && kill -0 "$bwrap_pid" 2>/dev/null && bwrap_alive=1
    if [ "$wrap_alive" = "0" ] && [ "$bwrap_alive" = "0" ]; then
      break
    fi
    t=$((t + 1))
  done
  if { [ -n "$wrap_pid" ] && kill -0 "$wrap_pid" 2>/dev/null; } || { [ -n "$bwrap_pid" ] && kill -0 "$bwrap_pid" 2>/dev/null; }; then
    survived=1
  fi
  [ -n "$wrap_pid" ] && { kill -9 "$wrap_pid" 2>/dev/null || true; }
  [ -n "$bwrap_pid" ] && { kill -9 "$bwrap_pid" 2>/dev/null || true; }
  pkill -9 -f "$probe" 2>/dev/null || true
  if [ "$expect_dead" = "1" ]; then
    check "$desc" "$([ "$survived" = "0" ] && echo 1 || echo 0)"
  else
    check "$desc" "$([ "$survived" = "1" ] && echo 1 || echo 0)"
  fi
}
check_die_with_parent "$REAL" "the real script's --die-with-parent tears down bwrap + the sandboxed process when an ancestor dies" "1"
MUTANT_NO_DIE="$WORK/mutant-no-die.sh"
sed 's/--new-session --die-with-parent/--new-session/' "$REAL" > "$MUTANT_NO_DIE"
check_die_with_parent "$MUTANT_NO_DIE" "RED-MUTANT (RedHat KC6): removing --die-with-parent is caught (bwrap+child survive the ancestor's death as orphans)" "0"

# doctor-branch dispatch (QA F2, card ca1b763c komment 23032): "doctor" as the first argument
# must reach rea's top-level per-engine health report (has a "scope_checks" array), not the MCP
# protocol self-check ("mcp doctor", a different, unrelated shape).
DOCTOR_OUT_REAL="$(env -i "${BASE_ENV[@]}" bash "$REAL" doctor --json 2>/dev/null)" || true
check "the real script's doctor-branch reaches the top-level per-engine health report (has scope_checks)" \
  "$(printf '%s' "$DOCTOR_OUT_REAL" | python3 -c "import json,sys
try:
    print(1 if 'scope_checks' in json.load(sys.stdin) else 0)
except Exception:
    print(0)" 2>/dev/null || echo 0)"
MUTANT_NO_DOCTOR="$WORK/mutant-no-doctor.sh"
sed 's/if \[ "\${1:-}" = "doctor" \]; then/if false; then/' "$REAL" > "$MUTANT_NO_DOCTOR"
DOCTOR_OUT_MUT="$(env -i "${BASE_ENV[@]}" bash "$MUTANT_NO_DOCTOR" doctor --json 2>/dev/null)" || true
check "RED-MUTANT (RedHat KC6): disabling the doctor-branch is caught (falls back to the unrelated mcp-doctor shape, no scope_checks)" \
  "$(printf '%s' "$DOCTOR_OUT_MUT" | python3 -c "import json,sys
try:
    print(0 if 'scope_checks' in json.load(sys.stdin) else 1)
except Exception:
    print(1)" 2>/dev/null || echo 0)"

# Hopper lib/ bind (QA F1 BLOCKER, card ca1b763c komment 23032): needs the REAL registered
# HOPPER_LAUNCHER_PATH to exercise (the generic BASE_ENV doesn't configure Hopper at all) --
# skip gracefully, not a false pass/fail, if this host has no Hopper registration.
ELEMZO_JSON="/home/neon/marveen/agents/elemzo/.claude-config/.claude.json"
REAL_ENV_LINES=""
if [ -f "$ELEMZO_JSON" ]; then
  REAL_ENV_LINES="$(python3 -c "
import json
d=json.load(open('$ELEMZO_JSON'))
env=d.get('mcpServers',{}).get('rea',{}).get('env',{})
for k,v in env.items():
    print(f'{k}={v}')
" 2>/dev/null)" || true
fi
if [ -n "$REAL_ENV_LINES" ] && printf '%s' "$REAL_ENV_LINES" | grep -q '^HOPPER_LAUNCHER_PATH='; then
  REAL_ENV_ARGS=()
  while IFS='=' read -r rk rv; do
    [ -n "$rk" ] || continue
    REAL_ENV_ARGS+=("$rk=$rv")
  done <<< "$REAL_ENV_LINES"
  hopper_ok() {
    python3 -c "import json,sys
try:
    d=json.load(sys.stdin)
    print(1 if any(c.get('name')=='hopper' and c.get('ok') for c in d.get('scope_checks', [])) else 0)
except Exception:
    print(0)" 2>/dev/null || echo 0
  }
  HOPPER_DOCTOR_REAL="$(env -i "${REAL_ENV_ARGS[@]}" bash "$REAL" doctor --json 2>/dev/null)" || true
  check "the real script's Hopper lib/ bind keeps the hopper doctor check healthy" \
    "$(printf '%s' "$HOPPER_DOCTOR_REAL" | hopper_ok)"
  MUTANT_NO_HOPPERLIB="$WORK/mutant-no-hopperlib.sh"
  sed '/HOPPER_LIB_DIR="\$(dirname/,/^  fi$/d' "$REAL" > "$MUTANT_NO_HOPPERLIB"
  HOPPER_DOCTOR_MUT="$(env -i "${REAL_ENV_ARGS[@]}" bash "$MUTANT_NO_HOPPERLIB" doctor --json 2>/dev/null)" || true
  check "RED-MUTANT (RedHat KC6): removing the Hopper lib/ bind is caught (hopper doctor check goes false)" \
    "$([ "$(printf '%s' "$HOPPER_DOCTOR_MUT" | hopper_ok)" = "0" ] && echo 1 || echo 0)"
else
  check "Hopper lib-bind mutant test (skipped: no HOPPER_LAUNCHER_PATH registered on this host -- not a pass/fail of the bind itself)" "1"
fi

if [ "$FAIL" -eq 0 ]; then
  echo "selftest: $PASS passed, 0 failed"
  exit 0
else
  echo "selftest: $PASS passed, $FAIL failed"
  exit 1
fi

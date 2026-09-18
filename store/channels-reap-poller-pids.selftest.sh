#!/usr/bin/env bash
# Selftest for scripts/channels.sh's _reap_poller_pids() (card fd2b2c4a).
#
# Run: bash store/channels-reap-poller-pids.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# WHY THIS EXISTS. Both orphan-reap passes in channels.sh used to trust an env-var needle alone
# to decide what to SIGKILL. Because the shared fleet tmux server (and everything forked from it --
# the main claude process, every sub-agent's claude, every MCP child) inherits this script's
# exported *_STATE_DIR, the needle matched 142 live processes on 2026-09-18 for ONE real orphan
# poller, and killing that set took the whole fleet down on two service restarts that morning
# (09:04:08, 09:10:04 -- store/channels-respawn.log). _reap_poller_pids is the narrowing filter:
# a candidate is only reaped if ITS OWN argv (read from /proc/<pid>/cmdline, not the mixed
# argv+env `ps eww` line the caller used to build the candidate list) is the poller's own
# invocation shape (`<interpreter> server.ts`).
#
# HERMETIC ON PURPOSE, Linux only (like the function itself, which reads /proc). Each case is a
# REAL short-lived process with a controlled argv -- not a mocked /proc, which cannot be faked
# without root. `bash <literal-relpath>` is used to get argv[1] to be an exact literal string with
# no path resolution getting in the way (an absolute path would never equal "server.ts").
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHANNELS_SH="$HERE/../scripts/channels.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

# Pull the function verbatim out of the real file and load ONLY that -- sourcing channels.sh
# wholesale would run its top-level side effects (kill tmux sessions, spawn claude, ...).
FN="$(sed -n '/^_reap_poller_pids() {/,/^}/p' "$CHANNELS_SH")"
if [ -z "$FN" ]; then
  bad "extracted _reap_poller_pids() from scripts/channels.sh" "sed found nothing -- did the function get renamed or removed?"
  echo; echo "channels-reap-poller-pids.selftest: $pass passed, $fail failed"; exit 1
fi
eval "$FN"

TMP="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$TMP"' EXIT

# A real "server.ts"-shaped candidate: argv = ("bash", "server.ts"), matching the live poller's
# own shape (`/home/neon/.bun/bin/bun server.ts`) at the position _reap_poller_pids reads.
mkdir -p "$TMP/poller1" "$TMP/poller2"
printf '#!/usr/bin/env bash\nsleep 30\n' > "$TMP/poller1/server.ts"
cp "$TMP/poller1/server.ts" "$TMP/poller2/server.ts"
( cd "$TMP/poller1" && exec bash server.ts ) & POLLER1=$!
( cd "$TMP/poller2" && exec bash server.ts ) & POLLER2=$!

# Non-poller candidates that would have matched the OLD env-only needle (they carry the fleet's
# real env var if this test happens to run inside a channel session too) but must NOT be reaped:
# a 2-arg process whose second arg is anything other than "server.ts".
( exec sleep 30 ) & NOTPOLLER_SLEEP=$!             # argv = ("sleep", "30")
( exec bash -c 'sleep 30' notserver.ts ) & NOTPOLLER_ARG=$!  # argv[1] = "-c", not "server.ts"

sleep 0.2  # let all five actually reach their exec before /proc is read

# --- 1. a mix of poller and non-poller candidates: only the poller pids come back -------------
out="$(_reap_poller_pids "$NOTPOLLER_SLEEP" "$POLLER1" "$NOTPOLLER_ARG" "$POLLER2" | sort -n)"
want="$(printf '%s\n%s\n' "$POLLER1" "$POLLER2" | sort -n)"
if [ "$out" = "$want" ]; then
  ok "returns exactly the server.ts-shaped candidates, in a mixed batch"
else
  bad "mixed batch" "got: [$out] want: [$want]"
fi

# --- 2. no candidates at all: no output, no error ----------------------------------------------
out="$(_reap_poller_pids)"
[ -z "$out" ] && ok "empty candidate list produces no output" || bad "empty candidate list" "got: [$out]"

# --- 3. a candidate PID that no longer exists: skipped, not a crash ----------------------------
# A real reap races against processes exiting on their own between the ps snapshot and the check.
DEAD_PID=$(( $$ + 90000 ))  # not guaranteed unused, but astronomically unlikely to collide
out="$(_reap_poller_pids "$DEAD_PID" 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
  ok "a nonexistent pid is skipped, not a crash"
else
  bad "nonexistent pid" "rc=$rc out=[$out]"
fi

# --- 4. the tmux-server / claude false-positive this bug actually hit: real 09-18 shape --------
# argv = ("tmux", "new-session", "-d", ...) and argv = ("claude", "--dangerously-skip-permissions",
# ...) -- neither has "server.ts" as its second token, which is exactly why the env needle alone
# used to catch them and this filter does not.
( exec bash -c 'sleep 30' "new-session" ) & FAKE_TMUX=$!   # argv[1] = "new-session"
( exec bash -c 'sleep 30' "--dangerously-skip-permissions" ) & FAKE_CLAUDE=$!
sleep 0.2
out="$(_reap_poller_pids "$FAKE_TMUX" "$FAKE_CLAUDE")"
[ -z "$out" ] && ok "tmux-server-shaped and claude-shaped candidates are never reaped" \
              || bad "tmux/claude false positive" "got: [$out]"

echo
echo "channels-reap-poller-pids.selftest: $pass passed, $fail failed"
[ "$fail" -eq 0 ]

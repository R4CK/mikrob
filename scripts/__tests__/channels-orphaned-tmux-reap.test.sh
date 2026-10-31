#!/bin/bash
# Contract test for reap_orphaned_tmux_servers() in scripts/channels.sh (D4902522).
#
# Incident 2026-10-31: mikrob-channels.service restarted. The OLD tmux server
# (pid 900) stayed alive, still holding the main session plus both interactive
# worker sessions, but its socket's directory entry was gone by the time the
# new channels.sh ran `tmux new-session` -- so tmux silently started a SECOND
# server on a fresh socket at the same path. The dashboard then auto-started a
# full second agent set on it: two live agent sets on one host, both reading
# the same inbox.
#
# This test reproduces the structural shape on a SCRATCH tmux socket directory
# (TMUX_TMPDIR), never touching the real /tmp/tmux-<uid>/ or any live unit:
#   1. start a real tmux server A, holding a session named like the real one;
#   2. unlink its socket's directory entry -- the exact state measured for pid
#      900: process alive, kill -0 succeeds, but /proc/net/unix (what `ss
#      -xlp`/`fuser` read) keeps showing the server's ORIGINAL bind path even
#      though that path's directory entry is gone, so path-string tools alone
#      cannot tell "still bound here" from "used to be bound here";
#   3. start a real tmux server B on the now-empty socket path, same session
#      name (a different server is a different namespace -- no conflict);
#   4. run channels.sh's reap pass against the scratch TMUX_TMPDIR;
#   5. assert server A is dead and server B is untouched.
#
# SESSION_NAME below matches what channels.sh itself resolves to when no .env
# is present (SESSION="${MAIN_AGENT_ID:-marveen}-channels") -- true of this
# worktree, which carries no .env; CHANNELS_BIN can point elsewhere but must
# then also have no .env; see the SETUP FAILED message if that assumption
# stops holding.
#
# Run: bash scripts/__tests__/channels-orphaned-tmux-reap.test.sh

set -u

# This test (and channels.sh itself, for the same reason -- see its "unset
# TMUX" near the real launch) must not inherit $TMUX: when set, tmux's CLI
# addresses the CALLER's own server/socket instead of TMUX_TMPDIR, so a test
# run from inside a tmux pane would silently operate on the real, live server.
unset TMUX

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CHANNELS="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"
SESSION_NAME="marveen-channels"

command -v tmux >/dev/null 2>&1 || { echo "SKIP: no tmux on PATH"; exit 0; }
if [ -f "$(dirname "$CHANNELS")/../.env" ]; then
  echo "SKIP: $(dirname "$CHANNELS")/../.env exists -- SESSION_NAME assumption (no .env -> marveen-channels) does not hold here"
  exit 0
fi

TMPD="$(mktemp -d)"
PIDA=""; PIDB=""; PIDC=""; PIDD=""; PIDE=""; PIDF=""; PIDG=""
cleanup() {
  for p in "$PIDA" "$PIDB" "$PIDC" "$PIDD" "$PIDE" "$PIDF" "$PIDG"; do
    [ -n "$p" ] && kill -KILL "$p" 2>/dev/null
  done
  rm -rf "$TMPD" "${TMPD2:-}"
}
trap cleanup EXIT

SOCKDIR="$TMPD/tmux-$(id -u)"
DEFAULT_SOCK="$SOCKDIR/default"

TMUX_TMPDIR="$TMPD" tmux new-session -d -s "$SESSION_NAME" 'sleep 60'
PIDA="$(TMUX_TMPDIR="$TMPD" tmux display-message -p '#{pid}' 2>/dev/null)"
if [ -z "$PIDA" ]; then
  echo "SETUP FAILED: could not identify server A's pid -- aborting"
  exit 1
fi

# Orphan server A: remove the socket's directory entry while the process stays
# alive (this is exactly what the incident measured for pid 900).
rm -f "$DEFAULT_SOCK"
if kill -0 "$PIDA" 2>/dev/null; then
  pass "server A survives socket-file removal (matches the incident's pid 900)"
else
  fail "server A survives socket-file removal" "alive" "dead"
fi

TMUX_TMPDIR="$TMPD" tmux new-session -d -s "$SESSION_NAME" 'sleep 60'
PIDB="$(TMUX_TMPDIR="$TMPD" tmux display-message -p '#{pid}' 2>/dev/null)"
if [ -z "$PIDB" ] || [ "$PIDB" = "$PIDA" ]; then
  echo "SETUP FAILED: server B did not come up as a distinct, reachable server (pidA=$PIDA pidB=$PIDB) -- aborting"
  exit 1
fi
pass "server B is a distinct, reachable server (pidA=$PIDA pidB=$PIDB)"

# --- the discriminating check: run the real seam ---
TMUX_TMPDIR="$TMPD" bash "$CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1

if kill -0 "$PIDA" 2>/dev/null; then
  fail "orphaned server A is killed by the reap pass" "dead" "alive"
else
  pass "orphaned server A is killed by the reap pass"
fi

if kill -0 "$PIDB" 2>/dev/null; then
  pass "live server B is left untouched"
else
  fail "live server B is left untouched" "alive" "dead"
fi

# --- KC2 (RedHat 27363): orphan whose FIRST session is not $SESSION_NAME must
# still be reaped -- detection is by SOCKET now, not by cmdline session name.
# This is the live fleet's own boot order (dashboard starts the agent session
# first, mikrob-channels is added to the same server later).
PIDC=""
rm -f "$DEFAULT_SOCK"
TMUX_TMPDIR="$TMPD" tmux new-session -d -s "other-session-not-$SESSION_NAME" 'sleep 60'
PIDC="$(TMUX_TMPDIR="$TMPD" tmux display-message -p '#{pid}' 2>/dev/null)"
if [ -z "$PIDC" ]; then
  echo "SETUP FAILED: could not start server C -- aborting KC2 case"
else
  rm -f "$DEFAULT_SOCK"  # orphan C: its first/only session is NOT $SESSION_NAME
  TMUX_TMPDIR="$TMPD" tmux new-session -d -s "$SESSION_NAME" 'sleep 60'
  PIDD="$(TMUX_TMPDIR="$TMPD" tmux display-message -p '#{pid}' 2>/dev/null)"
  TMUX_TMPDIR="$TMPD" bash "$CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1
  if kill -0 "$PIDC" 2>/dev/null; then
    fail "KC2: orphan whose first session differs from \$SESSION is still reaped" "dead" "alive"
    kill -KILL "$PIDC" 2>/dev/null
  else
    pass "KC2: orphan whose first session differs from \$SESSION is still reaped"
  fi
  [ -n "$PIDD" ] && kill -0 "$PIDD" 2>/dev/null && pass "KC2: the live replacement server is untouched"
  [ -n "$PIDD" ] && { kill -KILL "$PIDD" 2>/dev/null; }
fi

# --- KC3 (RedHat 27363): a healthy server bound to a DIFFERENT socket (same
# session name, different TMUX_TMPDIR) must never be touched -- kill scope is
# the socket path, not the session name.
TMPD2="$(mktemp -d)"
TMUX_TMPDIR="$TMPD2" tmux new-session -d -s "$SESSION_NAME" 'sleep 60'
PIDE="$(TMUX_TMPDIR="$TMPD2" tmux display-message -p '#{pid}' 2>/dev/null)"
if [ -z "$PIDE" ]; then
  echo "SETUP FAILED: could not start server E in a second socket dir -- aborting KC3 case"
else
  TMUX_TMPDIR="$TMPD" bash "$CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1
  if kill -0 "$PIDE" 2>/dev/null; then
    pass "KC3: a same-named server in a different socket dir is left untouched"
  else
    fail "KC3: a same-named server in a different socket dir is left untouched" "alive" "dead"
  fi
  kill -KILL "$PIDE" 2>/dev/null
fi
rm -rf "$TMPD2"

# --- KC6 (RedHat 27363): a SIGSTOPped orphan must still die -- TERM alone is
# queued but never delivered to a stopped process; reap must CONT then KILL.
rm -f "$DEFAULT_SOCK"
TMUX_TMPDIR="$TMPD" tmux new-session -d -s "$SESSION_NAME" 'sleep 60'
PIDF="$(TMUX_TMPDIR="$TMPD" tmux display-message -p '#{pid}' 2>/dev/null)"
if [ -z "$PIDF" ]; then
  echo "SETUP FAILED: could not start server F -- aborting KC6 case"
else
  rm -f "$DEFAULT_SOCK"  # orphan F
  kill -STOP "$PIDF" 2>/dev/null
  TMUX_TMPDIR="$TMPD" tmux new-session -d -s "$SESSION_NAME" 'sleep 60'
  PIDG="$(TMUX_TMPDIR="$TMPD" tmux display-message -p '#{pid}' 2>/dev/null)"
  CHANNELS_REAP_KILL_WAIT_S=1 TMUX_TMPDIR="$TMPD" bash "$CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1
  if kill -0 "$PIDF" 2>/dev/null; then
    fail "KC6: a SIGSTOPped orphan is still reaped (CONT then KILL)" "dead" "alive"
    kill -KILL "$PIDF" 2>/dev/null
  else
    pass "KC6: a SIGSTOPped orphan is still reaped (CONT then KILL)"
  fi
  [ -n "$PIDG" ] && kill -KILL "$PIDG" 2>/dev/null
fi

# --- Hermetic filter test (QA 27361): detection must be exercisable with ZERO
# real process interaction, so a test of a BROKEN/mutated filter can never
# act on a real pid regardless of what it matches. CHANNELS_REAP_PROC_ROOT /
# CHANNELS_REAP_NET_UNIX point detection at a synthetic tree; the recorder
# replaces every kill with a file append.
FAKE_PROC="$TMPD/fakeproc"
mkdir -p "$FAKE_PROC/9001/fd" "$FAKE_PROC/9002/fd"
printf 'tmux: server\n' > "$FAKE_PROC/9001/comm"
printf 'tmux: server\n' > "$FAKE_PROC/9002/comm"
ln -s "socket:[111]" "$FAKE_PROC/9001/fd/3"
ln -s "socket:[222]" "$FAKE_PROC/9002/fd/3"
mkdir -p "$TMPD/tmux-$(id -u)"
FAKE_TARGET="$TMPD/tmux-$(id -u)/default"
FAKE_NET_UNIX="$TMPD/fake-net-unix"
{
  echo "Num       RefCount Protocol Flags    Type St Inode Path"
  printf '0: 00000002 00000000 00010000 0001 01 111 %s\n' "$FAKE_TARGET"
  printf '0: 00000002 00000000 00010000 0001 01 222 %s\n' "$TMPD/tmux-$(id -u)/other"
} > "$FAKE_NET_UNIX"
RECORDER="$TMPD/recorder.txt"
: > "$RECORDER"
CHANNELS_REAP_PROC_ROOT="$FAKE_PROC" CHANNELS_REAP_NET_UNIX="$FAKE_NET_UNIX" \
  CHANNELS_REAP_KILL_RECORDER="$RECORDER" TMUX_TMPDIR="$TMPD" \
  bash "$CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1
GOT="$(cat "$RECORDER" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
if [ "$GOT" = "9001" ]; then
  pass "hermetic: only the pid bound to the target socket is recorded (zero real kill)"
else
  fail "hermetic: only the pid bound to the target socket is recorded (zero real kill)" "9001" "$GOT"
fi

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]

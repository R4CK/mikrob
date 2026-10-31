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
PIDA=""; PIDB=""
cleanup() {
  [ -n "$PIDA" ] && kill -KILL "$PIDA" 2>/dev/null
  [ -n "$PIDB" ] && kill -KILL "$PIDB" 2>/dev/null
  rm -rf "$TMPD"
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

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]

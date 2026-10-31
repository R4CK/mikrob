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
PIDH=""; PIDI=""; PIDJ=""; PIDK=""; PIDL=""; PIDM=""; PIDN=""
cleanup() {
  for p in "$PIDA" "$PIDB" "$PIDC" "$PIDD" "$PIDE" "$PIDF" "$PIDG" \
           "$PIDH" "$PIDI" "$PIDJ" "$PIDK" "$PIDL" "$PIDM" "$PIDN"; do
    [ -n "$p" ] && kill -KILL "$p" 2>/dev/null
  done
  rm -rf "$TMPD" "${TMPD2:-}" "${TMPD3:-}" "${TMPD4_REAL:-}" "${TMPD4_LINK:-}" "${TMPD5:-}" "${TMPD6:-}"
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
# CHANNELS_REAP_KILL_ALLOWLIST (749d4125 follow-up 4): every real-kill
# invocation below is scoped to exactly the pids this test itself spawned,
# so a mutated/widened match can never reach a real, foreign tmux server.
CHANNELS_REAP_KILL_ALLOWLIST="$PIDA $PIDB" TMUX_TMPDIR="$TMPD" bash "$CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1

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
  CHANNELS_REAP_KILL_ALLOWLIST="$PIDC $PIDD" TMUX_TMPDIR="$TMPD" bash "$CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1
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
  # No real orphan lives in $TMPD at this point, so the allowlist blocks
  # everything (a placeholder that can never match a numeric pid).
  CHANNELS_REAP_KILL_ALLOWLIST="NONE" TMUX_TMPDIR="$TMPD" bash "$CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1
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
  CHANNELS_REAP_KILL_ALLOWLIST="$PIDF $PIDG" CHANNELS_REAP_KILL_WAIT_S=1 TMUX_TMPDIR="$TMPD" bash "$CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1
  if kill -0 "$PIDF" 2>/dev/null; then
    fail "KC6: a SIGSTOPped orphan is still reaped (CONT then KILL)" "dead" "alive"
    kill -KILL "$PIDF" 2>/dev/null
  else
    pass "KC6: a SIGSTOPped orphan is still reaped (CONT then KILL)"
  fi
  [ -n "$PIDG" ] && kill -KILL "$PIDG" 2>/dev/null
fi
# A SIGKILLed tmux server never gets to unlink() its own socket file, so
# $DEFAULT_SOCK can still exist on disk here even though PIDG is dead. The
# hermetic test below points its FAKE_TARGET at this exact path; a leftover
# stale socket there would make reap_orphaned_tmux_servers()'s fail-closed
# check (749d4125 follow-up 1: abort when the default socket exists but
# can't be queried) trip on this REAL file before ever consulting the
# synthetic FAKE_PROC/FAKE_NET_UNIX data, aborting the whole reap pass.
rm -f "$DEFAULT_SOCK"

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

# --- KC7 (749d4125 follow-up 1a): display-message yields empty -> the whole
# reap pass must abort, leaving the live default-socket server untouched.
# A stub tmux_bin answers display-message with nothing (simulating any cause
# of an unqueryable-but-live server) while the REAL socket file still exists
# (so the fail-closed "$target_path exists but can't be queried" branch is
# the one exercised, not "no socket at all").
PIDH=""
STUB_TMUX="$TMPD/stub-tmux-empty.sh"
cat > "$STUB_TMUX" <<'STUB'
#!/bin/bash
for a in "$@"; do
  if [ "$a" = "display-message" ]; then
    exit 0  # prints nothing -- simulates an unreachable/unqueryable server
  fi
done
exec tmux "$@"
STUB
chmod +x "$STUB_TMUX"
rm -f "$DEFAULT_SOCK"
TMUX_TMPDIR="$TMPD" tmux new-session -d -s "$SESSION_NAME" 'sleep 60'
PIDH="$(TMUX_TMPDIR="$TMPD" tmux display-message -p '#{pid}' 2>/dev/null)"
if [ -z "$PIDH" ]; then
  echo "SETUP FAILED: could not start server H -- aborting KC7 case"
else
  CHANNELS_REAP_KILL_ALLOWLIST="$PIDH" CHANNELS_REAP_TMUX_BIN="$STUB_TMUX" TMUX_TMPDIR="$TMPD" \
    bash "$CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1
  if kill -0 "$PIDH" 2>/dev/null; then
    pass "KC7: empty display-message aborts the reap, live default-socket server (private socket) untouched"
  else
    fail "KC7: empty display-message aborts the reap, live default-socket server (private socket) untouched" "alive" "dead"
  fi
  kill -KILL "$PIDH" 2>/dev/null
fi
rm -f "$STUB_TMUX"

# --- KC8 (749d4125 follow-up 1b): the CALLER's inherited $TMUX pointing at a
# totally different, real server must not deflect the query away from
# $target_path -- the live default-socket server must still be recognized
# as live (via the `-S "$target_path"` pin + `env -u TMUX`) and left alone.
PIDI=""; PIDJ=""
TMPD3="$(mktemp -d)"
rm -f "$DEFAULT_SOCK"
TMUX_TMPDIR="$TMPD" tmux new-session -d -s "$SESSION_NAME" 'sleep 60'
PIDI="$(TMUX_TMPDIR="$TMPD" tmux display-message -p '#{pid}' 2>/dev/null)"
TMUX_TMPDIR="$TMPD3" tmux new-session -d -s "other-server" 'sleep 60'
PIDJ="$(TMUX_TMPDIR="$TMPD3" tmux display-message -p '#{pid}' 2>/dev/null)"
if [ -z "$PIDI" ] || [ -z "$PIDJ" ]; then
  echo "SETUP FAILED: could not start server I and/or J -- aborting KC8 case"
else
  BOGUS_TMUX="$TMPD3/tmux-$(id -u)/default,$PIDJ,0"
  CHANNELS_REAP_KILL_ALLOWLIST="$PIDI $PIDJ" TMUX="$BOGUS_TMUX" TMUX_TMPDIR="$TMPD" \
    bash "$CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1
  if kill -0 "$PIDI" 2>/dev/null; then
    pass "KC8: a caller \$TMUX pointing at another real server does not deflect the query -- default-socket server untouched"
  else
    fail "KC8: a caller \$TMUX pointing at another real server does not deflect the query" "alive" "dead"
  fi
  kill -KILL "$PIDI" 2>/dev/null
  kill -KILL "$PIDJ" 2>/dev/null
fi
rm -rf "$TMPD3"

# --- KC9 (749d4125 follow-up 3): /proc/net/unix always reports a server's
# CANONICAL bind path (the kernel resolves symlinks for d_path, regardless
# of how TMUX_TMPDIR was spelled at bind time -- measured directly). So the
# real mismatch risk is the REAP's own target_path: if the reap pass itself
# is invoked with a symlinked TMUX_TMPDIR, its target_path is the literal,
# unresolved symlink string, which must still be canonicalized to match the
# orphan's canonical bound_path (_reap_canon_path).
PIDK=""; PIDL=""
TMPD4_REAL="$(mktemp -d)"
TMPD4_LINK="$(mktemp -u)"
ln -s "$TMPD4_REAL" "$TMPD4_LINK"
SOCKDIR4="$TMPD4_REAL/tmux-$(id -u)"
DEFAULT_SOCK4="$SOCKDIR4/default"
TMUX_TMPDIR="$TMPD4_REAL" tmux new-session -d -s "$SESSION_NAME" 'sleep 60'
PIDK="$(TMUX_TMPDIR="$TMPD4_REAL" tmux display-message -p '#{pid}' 2>/dev/null)"
if [ -z "$PIDK" ]; then
  echo "SETUP FAILED: could not start server K -- aborting KC9 case"
else
  rm -f "$DEFAULT_SOCK4"  # orphan K
  TMUX_TMPDIR="$TMPD4_REAL" tmux new-session -d -s "$SESSION_NAME" 'sleep 60'
  PIDL="$(TMUX_TMPDIR="$TMPD4_REAL" tmux display-message -p '#{pid}' 2>/dev/null)"
  # The reap pass itself is invoked via the SYMLINKED TMUX_TMPDIR -- its
  # internal target_path is therefore the unresolved symlink string, while
  # both K's and L's bound paths (from /proc/net/unix) are canonical.
  CHANNELS_REAP_KILL_ALLOWLIST="$PIDK $PIDL" TMUX_TMPDIR="$TMPD4_LINK" \
    bash "$CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1
  if kill -0 "$PIDK" 2>/dev/null; then
    fail "KC9: a symlinked TMUX_TMPDIR is canonicalized, orphan K is still reaped" "dead" "alive"
    kill -KILL "$PIDK" 2>/dev/null
  else
    pass "KC9: a symlinked TMUX_TMPDIR is canonicalized, orphan K is still reaped"
  fi
  [ -n "$PIDL" ] && kill -0 "$PIDL" 2>/dev/null && pass "KC9: the live replacement server L is untouched"
  [ -n "$PIDL" ] && kill -KILL "$PIDL" 2>/dev/null
fi
rm -f "$TMPD4_LINK"
rm -rf "$TMPD4_REAL"

# --- KC10 (749d4125 follow-up 4): even a MUTANT that widens the match (every
# tmux server I own, regardless of bound socket) must still be unable to
# signal a pid outside CHANNELS_REAP_KILL_ALLOWLIST -- the test safety net
# holds independently of whether the detection logic itself is correct.
PIDM=""  # "foreign" server: must never be touched, bound to an unrelated socket
MUTANT_CHANNELS="$TMPD/channels-mutant.sh"
sed 's/\[ "\$bound_path_canon" = "\$target_path_canon" \] || continue.*/true # MUTANT: widened match (749d4125 follow-up 4)/' \
  "$CHANNELS" > "$MUTANT_CHANNELS"
if ! grep -q 'MUTANT: widened match' "$MUTANT_CHANNELS"; then
  echo "SETUP FAILED: mutant sed substitution did not apply -- aborting KC10 case"
else
  TMPD5="$(mktemp -d)"
  TMUX_TMPDIR="$TMPD5" tmux new-session -d -s "foreign-server" 'sleep 60'
  PIDM="$(TMUX_TMPDIR="$TMPD5" tmux display-message -p '#{pid}' 2>/dev/null)"
  rm -f "$DEFAULT_SOCK"
  if [ -z "$PIDM" ]; then
    echo "SETUP FAILED: could not start foreign server M -- aborting KC10 case"
  else
    # Allowlist intentionally excludes PIDM: it represents a real, unrelated
    # tmux server (the production shape) that the widened match would now
    # also pick up via /proc, since it is owned by the same uid and its
    # comm is "tmux: server" too.
    CHANNELS_REAP_KILL_ALLOWLIST="NONE" TMUX_TMPDIR="$TMPD" \
      bash "$MUTANT_CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1
    if kill -0 "$PIDM" 2>/dev/null; then
      pass "KC10: mutant widened match still kills nothing foreign (allowlist holds)"
    else
      fail "KC10: mutant widened match still kills nothing foreign (allowlist holds)" "alive" "dead"
    fi
    kill -KILL "$PIDM" 2>/dev/null
  fi
  rm -rf "$TMPD5"
fi
rm -f "$MUTANT_CHANNELS"

# --- KC11 (749d4125 MikroB follow-up, comment 27655): TMUX_TMPDIR unset with
# no CHANNELS_REAP_LIVE=1 opt-in must refuse to touch the default socket dir
# AT ALL, before even resolving/calling the tmux binary -- this is the exact
# ad hoc invocation shape that killed the live mikrob-channels tmux server on
# 2026-10-31 19:42:45. A stub tmux_bin drops a sentinel the instant it is
# invoked; with the guard working, the sentinel must never appear. This never
# dereferences whatever the real /tmp/tmux-<uid>/default socket on the test
# host currently holds (the stub never connects to it), so it is safe
# regardless of host state -- `mkdir -p` only ensures the real default
# socket DIRECTORY exists (harmless; tmux creates the same thing on first
# use) so the case is deterministic across hosts that have never run tmux.
mkdir -p "/tmp/tmux-$(id -u)"
TMPD6="$(mktemp -d)"
SENTINEL6="$TMPD6/tmux-bin-invoked"
STUB_TMUX6="$TMPD6/stub-tmux-sentinel.sh"
cat > "$STUB_TMUX6" <<STUB
#!/bin/bash
: > "$SENTINEL6"
exit 0
STUB
chmod +x "$STUB_TMUX6"
env -u TMUX_TMPDIR CHANNELS_REAP_TMUX_BIN="$STUB_TMUX6" \
  bash "$CHANNELS" --reap-orphaned-tmux-servers >/dev/null 2>&1
if [ -e "$SENTINEL6" ]; then
  fail "KC11: TMUX_TMPDIR unset + no CHANNELS_REAP_LIVE opt-in refuses to touch the default socket dir" "tmux_bin never invoked" "tmux_bin invoked"
else
  pass "KC11: TMUX_TMPDIR unset + no CHANNELS_REAP_LIVE opt-in refuses to touch the default socket dir"
fi
rm -rf "$TMPD6"
# KC12 (opt-in restores prior behaviour) is intentionally NOT tested against
# the real default socket dir -- doing so would require spawning/reaping on
# the box's actual live tmux-1000 socket, exactly what this card's own
# constraint forbids (test only against private sockets, never the default
# socket). The opt-in path (CHANNELS_REAP_LIVE=1) is otherwise a one-line
# bypass of the guard above; every other case in this file (KC2/KC3/KC6-10)
# already proves the unchanged scratch-TMUX_TMPDIR behaviour still holds.

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]

#!/usr/bin/env bash
# Isolated harness for the start.sh / stop.sh contract (cards ca38deac, 206ab192).
#
# WHY THIS EXISTS. The claim worth testing is "a SECOND start.sh does not launch a second
# instance". On WSL two autostart hooks reach start.sh on the same boot (the wsl.conf [boot]
# command and a Windows ONLOGON task), and the loser used to start a second channels.sh polling
# the SAME bot token -- incoming messages split between two pollers, with no error anywhere.
# That failure is silent by construction, so it has to be tested, not reasoned about.
#
# Testing it on the LIVE install would stop and restart the real dashboard and channels -- which
# includes the session of whoever is running this. So everything below happens in a throwaway
# INSTALL_DIR with stub daemons. Nothing here touches the live install, binds a port, or starts a
# tmux session.
#
# THREE THINGS MAKE THE ISOLATION REAL, and each one is a trap if skipped:
#
#   1. INSTALL_DIR is derived by start.sh from its OWN location (`dirname $0/..`), so a copy of the
#      scripts into a scratch tree gets its own store/ and its own pidfiles for free. This is what
#      makes the whole approach viable.
#
#   2. THE SLUG MUST BE UNIQUE. start.sh reads MAIN_AGENT_ID from .env into $SLUG and (in the
#      version being adopted) runs `systemctl cat "${SLUG}-dashboard.service"`. With the real slug
#      that command FINDS THE LIVE UNIT and the next line tries to START it -- a scratch test would
#      reach straight into production. The scratch .env therefore carries a slug that matches no
#      unit on this box. This is the single most dangerous detail here and the least obvious.
#
#   3. THE SYSTEMD BRANCH HAS TO BE FORCED OFF. Measured on this host: `pidof systemd` succeeds AND
#      `systemctl --user status` succeeds, so start.sh takes the systemd branch and never reaches
#      the direct-launch path -- which is exactly the path carrying the idempotency logic. A naive
#      harness would therefore pass while testing nothing. A `pidof` stub that exits 1 puts the
#      script on the WSL/container branch, which is the branch this test is about.
#
# The systemd branch itself stays out of scope: verifying it needs the real units on the real box,
# and that is a deliberate live step for the owner, not something to simulate.
#
# Usage:  bash store/start-idempotency-harness.sh [path/to/repo]
# Exit:   0 all assertions hold | 1 an assertion failed | 2 setup failed
set -u

SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/start-harness-XXXXXX")" || exit 2
SLUG_TEST="harnessstub$$"
fail=0
pass=0

cleanup() {
  # Kill only what we started, and only by OUR scratch pidfiles.
  for f in "$SCRATCH/install/store/dashboard.pid" "$SCRATCH/install/store/channels.pid"; do
    [ -f "$f" ] || continue
    p="$(cat "$f" 2>/dev/null)"
    case "$p" in ''|*[!0-9]*) continue ;; esac
    kill "$p" 2>/dev/null || true
  done
  # Belt and braces: anything still alive that carries our unique scratch path.
  pkill -f "$SCRATCH" 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

t() { # t <name> <got> <want>
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1"
  else fail=$((fail+1)); echo "  FAIL $1: got [$2] want [$3]"; fi
}

# --- build the scratch install -------------------------------------------------
I="$SCRATCH/install"
mkdir -p "$I/scripts" "$I/store" "$I/dist" "$SCRATCH/bin" || exit 2

for f in start.sh stop.sh; do
  [ -f "$SRC/scripts/$f" ] || { echo "setup: $SRC/scripts/$f missing" >&2; exit 2; }
  cp "$SRC/scripts/$f" "$I/scripts/$f" || exit 2
done
# start.sh sources these; stubs keep the scratch tree independent of the real repo layout.
printf '_t() { echo "$1"; }\n' > "$I/install-lang.sh"
printf 'hu\n' > "$I/.lang"
printf 'MAIN_AGENT_ID=%s\nBOT_NAME=harness\n' "$SLUG_TEST" > "$I/.env"
# boot-hook-prune runs unconditionally near the top; a no-op keeps it from touching anything.
mkdir -p "$I/scripts"
printf 'import sys\nsys.exit(0)\n' > "$I/scripts/boot-hook-prune.py"

# Stub daemons: they only sleep. No port, no tmux, no state.
printf 'setTimeout(function(){}, 3600000)\n' > "$I/dist/index.js"
# NOT `exec sleep`: exec REPLACES the process image, so the cmdline becomes a bare "sleep 3600"
# with no scratch path in it, and the pgrep-based counter below silently stops seeing this daemon.
# Measured the hard way -- the first run of this harness undercounted by exactly one, which made a
# reproduced duplicate look smaller than it was. Staying in bash keeps "<scratch>/scripts/channels.sh"
# in the cmdline, which is what the counter matches on.
printf '#!/usr/bin/env bash\nwhile :; do sleep 3600; done\n' > "$I/scripts/channels.sh"
chmod +x "$I/scripts/channels.sh" "$I/scripts/start.sh" "$I/scripts/stop.sh"

# Trap 3: force the WSL/container branch (see the header).
printf '#!/usr/bin/env bash\nexit 1\n' > "$SCRATCH/bin/pidof"
chmod +x "$SCRATCH/bin/pidof"

run_start() { PATH="$SCRATCH/bin:$PATH" bash "$I/scripts/start.sh" >>"$SCRATCH/start.log" 2>&1; }
run_stop()  { PATH="$SCRATCH/bin:$PATH" bash "$I/scripts/stop.sh"  >>"$SCRATCH/stop.log"  2>&1; }

# How many stub daemons are actually alive under OUR scratch tree.
live_count() { pgrep -f "$SCRATCH" 2>/dev/null | wc -l | tr -d ' '; }
pid_alive() { # $1 pidfile
  [ -f "$1" ] || return 1
  local p; p="$(cat "$1" 2>/dev/null)"
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$p" 2>/dev/null
}

echo "start.sh/stop.sh idempotency harness"
echo "  scratch: $SCRATCH"
echo "  slug:    $SLUG_TEST (matches no unit on this box -- see trap 2)"

# --- A: a first start brings both up ------------------------------------------
run_start
sleep 1
t "first start: dashboard pidfile names a LIVE process" "$(pid_alive "$I/store/dashboard.pid" && echo yes || echo no)" "yes"
t "first start: channels pidfile names a LIVE process"  "$(pid_alive "$I/store/channels.pid"  && echo yes || echo no)" "yes"
after_first="$(live_count)"

# --- B: THE CLAIM -- a second start must not launch anything else -------------
# This is the assertion the card exists for. Against a start.sh WITHOUT the idempotency
# guard it fails, and that failure is the reproduction of the WSL double-poller bug.
run_start
sleep 1
after_second="$(live_count)"
t "second start launches NO additional process (the WSL double-poller bug)" "$after_second" "$after_first"

# --- C: stop removes the pidfiles only once the processes are really gone -----
run_stop
sleep 1
t "after stop: dashboard pidfile is gone"        "$([ -f "$I/store/dashboard.pid" ] && echo present || echo gone)" "gone"
t "after stop: channels pidfile is gone"         "$([ -f "$I/store/channels.pid" ]  && echo present || echo gone)" "gone"
t "after stop: no stub daemon of ours is alive"  "$(live_count)" "0"

echo "harness: $((pass+fail)) assertion(s), $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1

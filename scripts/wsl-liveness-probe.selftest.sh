#!/usr/bin/env bash
# wsl-liveness-probe.selftest.sh -- controls for wsl-liveness-probe.sh (card 58badae1 F2).
# Fixture curl/tmux/ps binaries, never touches the live dashboard/tmux session.
# Usage: scripts/wsl-liveness-probe.selftest.sh (exit 0 = PASS).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/wsl-liveness-probe.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

check() { case "$3" in *"$2"*) echo "  ok   $1" ;; *) echo "  FAIL $1 -> needle '$2' not in '$3'"; fail=1 ;; esac; }
check_absent() { case "$3" in *"$2"*) echo "  FAIL $1 -> needle '$2' unexpectedly present"; fail=1 ;; *) echo "  ok   $1" ;; esac; }

mkdir -p "$TMP/store"

write_curl() { # $1 = http code to return
  cat > "$TMP/curl.sh" <<EOF
#!/usr/bin/env bash
echo -n "$1"
EOF
  chmod +x "$TMP/curl.sh"
}

# $1 = "healthy_session" or "no_session" or "no_poller"
write_tmux_ps() {
  case "$1" in
    healthy_session)
      cat > "$TMP/tmux.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  list-panes) echo "4242" ;;
esac
EOF
      cat > "$TMP/ps.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -o) echo "4242" ;; # ppid of the poller IS the pane pid (one hop, descends immediately)
  -axo) echo "  9999 node /home/x/.claude/plugins/telegram/poller.js" ;;
esac
EOF
      ;;
    no_session)
      cat > "$TMP/tmux.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 1 ;;
esac
EOF
      cat > "$TMP/ps.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
      ;;
    no_poller)
      cat > "$TMP/tmux.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  list-panes) echo "4242" ;;
esac
EOF
      cat > "$TMP/ps.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  -axo) echo "" ;;
esac
EOF
      ;;
  esac
  chmod +x "$TMP/tmux.sh" "$TMP/ps.sh"
}

common_env() {
  export WSL_LIVENESS_PROBE_CURL_BIN="$TMP/curl.sh"
  export WSL_LIVENESS_PROBE_TMUX_BIN="$TMP/tmux.sh"
  export WSL_LIVENESS_PROBE_PS_BIN="$TMP/ps.sh"
  export WSL_LIVENESS_PROBE_SESSION="fullstack-channels"
}
common_env

echo "wsl-liveness-probe controls"

# --- 1. dashboard 200 + fresh keepalive -> OK -------------------------------
write_curl 200
write_tmux_ps no_session   # irrelevant, keepalive path should short-circuit
touch "$TMP/store/.channel-keepalive"
HOME_DIR_OVERRIDE="$TMP"
( cd "$TMP" && cat > .env <<EOF
DASHBOARD_PORT=3420
EOF
  mkdir -p scripts
  cp "$BIN" scripts/wsl-liveness-probe.sh
  OUT="$(bash scripts/wsl-liveness-probe.sh 2>&1)"; RC=$?
  echo "$OUT" > "$TMP/out1.txt"
  echo "$RC" > "$TMP/rc1.txt"
)
check "fresh-keepalive: OK output" "OK" "$(cat "$TMP/out1.txt")"
[ "$(cat "$TMP/rc1.txt")" = "0" ] && echo "  ok   fresh-keepalive: exit 0" || { echo "  FAIL fresh-keepalive: exit $(cat "$TMP/rc1.txt")"; fail=1; }

# --- 2. dashboard 200 + STALE keepalive + NO live poller -> UNHEALTHY -------
write_curl 200
write_tmux_ps no_poller
( cd "$TMP" && touch -d '1 hour ago' store/.channel-keepalive
  OUT="$(bash scripts/wsl-liveness-probe.sh 2>&1)"; RC=$?
  echo "$OUT" > "$TMP/out2.txt"; echo "$RC" > "$TMP/rc2.txt"
)
check "stale-no-poller: UNHEALTHY output" "UNHEALTHY" "$(cat "$TMP/out2.txt")"
[ "$(cat "$TMP/rc2.txt")" = "1" ] && echo "  ok   stale-no-poller: exit 1" || { echo "  FAIL stale-no-poller: exit $(cat "$TMP/rc2.txt")"; fail=1; }

# --- 3. dashboard 200 + STALE keepalive + a LIVE poller under the session ---
#        (quiet-but-healthy; F2's fix) -> OK, not a false UNHEALTHY -----------
write_curl 200
write_tmux_ps healthy_session
( cd "$TMP"
  OUT="$(bash scripts/wsl-liveness-probe.sh 2>&1)"; RC=$?
  echo "$OUT" > "$TMP/out3.txt"; echo "$RC" > "$TMP/rc3.txt"
)
check "stale-but-alive: OK output" "OK" "$(cat "$TMP/out3.txt")"
check "stale-but-alive: mentions process-tree confirmation" "process tree" "$(cat "$TMP/out3.txt")"
[ "$(cat "$TMP/rc3.txt")" = "0" ] && echo "  ok   stale-but-alive: exit 0" || { echo "  FAIL stale-but-alive: exit $(cat "$TMP/rc3.txt")"; fail=1; }

# --- 4b. keepalive file MISSING + no live poller -> still OK, not UNHEALTHY
#         (card 58badae1 incident fix: UNKNOWN channel state != unhealthy) ---
write_curl 200
write_tmux_ps no_poller
( cd "$TMP" && rm -f store/.channel-keepalive
  OUT="$(bash scripts/wsl-liveness-probe.sh 2>&1)"; RC=$?
  echo "$OUT" > "$TMP/out4b.txt"; echo "$RC" > "$TMP/rc4b.txt"
)
check "missing-keepalive: OK output" "OK" "$(cat "$TMP/out4b.txt")"
check "missing-keepalive: UNKNOWN noted" "UNKNOWN" "$(cat "$TMP/out4b.txt")"
[ "$(cat "$TMP/rc4b.txt")" = "0" ] && echo "  ok   missing-keepalive: exit 0" || { echo "  FAIL missing-keepalive: exit $(cat "$TMP/rc4b.txt")"; fail=1; }

# --- 4c. dashboard DOWN + keepalive file MISSING -> UNHEALTHY line must show
#         keepalive_state=missing and age=n/a, NEVER an epoch-sized number
#         (regression pin for the live incident: keepalive_age=1791828061s,
#         computed from a stat-failure fallback of 0) ------------------------
write_curl 000
write_tmux_ps no_poller
( cd "$TMP" && rm -f store/.channel-keepalive
  OUT="$(bash scripts/wsl-liveness-probe.sh 2>&1)"; RC=$?
  echo "$OUT" > "$TMP/out4c.txt"; echo "$RC" > "$TMP/rc4c.txt"
)
check "down+missing: keepalive_state=missing" "keepalive_state=missing" "$(cat "$TMP/out4c.txt")"
check "down+missing: age reported as n/a" "keepalive_age=n/as" "$(cat "$TMP/out4c.txt")"
check_absent "down+missing: no epoch-sized age (regression pin)" "keepalive_age=17" "$(cat "$TMP/out4c.txt")"
[ "$(cat "$TMP/rc4c.txt")" = "1" ] && echo "  ok   down+missing: exit 1" || { echo "  FAIL down+missing: exit $(cat "$TMP/rc4c.txt")"; fail=1; }

# --- 4. dashboard DOWN (non-200), regardless of channel state -> UNHEALTHY --
write_curl 000
write_tmux_ps healthy_session
( cd "$TMP"
  OUT="$(bash scripts/wsl-liveness-probe.sh 2>&1)"; RC=$?
  echo "$OUT" > "$TMP/out4.txt"; echo "$RC" > "$TMP/rc4.txt"
)
check "dashboard-down: UNHEALTHY output" "UNHEALTHY" "$(cat "$TMP/out4.txt")"
[ "$(cat "$TMP/rc4.txt")" = "1" ] && echo "  ok   dashboard-down: exit 1" || { echo "  FAIL dashboard-down: exit $(cat "$TMP/rc4.txt")"; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo "PASS"
  exit 0
else
  echo "FAIL"
  exit 1
fi

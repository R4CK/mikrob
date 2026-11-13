#!/bin/bash
# Card 313c8a71 F1 (WhiteHat2 CYBERSEC GO 28868 + QA2 FAIL 28906, Gate-SHA f921f7fb9): the
# --selftest-refuse-alert hook (watchdog-config-isolation.test.sh cases 51-52) proves
# maybe_alert_for_refuse_reason() itself works, but does NOT prove the REAL main restart loop
# actually calls it at its own call site (watchdog.sh line ~523). QA2 measured directly: commenting
# out that one real call still leaves watchdog-config-isolation.test.sh's full 62-case suite green,
# because none of those cases ever runs the main loop, only the self-test hooks.
#
# This drives the REAL main loop (watchdog.sh with no args) through a fake `tmux`/`ps` PATH shim,
# so the mutation QA2 named turns THIS test red while leaving every other suite untouched.
#
# Run: bash scripts/__tests__/watchdog-main-loop-refuse-alert.test.sh
set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WATCHDOG="${WATCHDOG_BIN:-$REPO_DIR/scripts/watchdog.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FIXTURE_INSTALL="$TMP/install"
mkdir -p "$FIXTURE_INSTALL/scripts/lib" "$FIXTURE_INSTALL/store" "$FIXTURE_INSTALL/agents/undecidable-agent/.claude-config" \
  "$FIXTURE_INSTALL/agents/undecidable-agent/.claude/channels/telegram" "$FIXTURE_INSTALL/logs"
cp "$WATCHDOG" "$FIXTURE_INSTALL/scripts/watchdog.sh"
cp "$REPO_DIR/scripts/lib/oauth_token_file_check.py" "$FIXTURE_INSTALL/scripts/lib/oauth_token_file_check.py"
WD="$FIXTURE_INSTALL/scripts/watchdog.sh"

AGENT="$FIXTURE_INSTALL/agents/undecidable-agent"
printf 'test agent\n' > "$AGENT/CLAUDE.md"
printf 'test agent\n' > "$AGENT/SOUL.md"
printf '{"model": "claude-sonnet-5", "authMode": "shared"}' > "$AGENT/agent-config.json"
printf 'TELEGRAM_BOT_TOKEN=fake-token-not-real\n' > "$AGENT/.claude/channels/telegram/.env"
echo "sk-test-fixture-token" > "$FIXTURE_INSTALL/store/.claude-oauth-token"

# NEEDS_FLEET_OAUTH_MJS points at a script file that does not exist -- the SAME shape as case 43/44
# (node's module loader fails, exit 1, no stdout sentinel) -- undecidable, must REFUSE.
BROKEN_INSTALL="$TMP/broken-install/scripts"
mkdir -p "$BROKEN_INSTALL"
# deliberately NOT creating needs-fleet-oauth.mjs here.

# --- fake PATH: tmux (has-session false for our agent, true for the main session so that branch
# is skipped entirely) and ps (reports a dashboard PID so the dashboard-restart branch is skipped,
# and a `claude` binary stand-in so this never depends on what is actually installed) ------------
#
# Cybersec NO-GO 28997 N2 (card 313c8a71 round 7): watchdog.sh:364 rebuilds PATH itself --
# `export PATH="$HOME/.local/bin:/opt/homebrew/bin:...:/usr/bin:/bin:$PATH"` -- putting several
# REAL system dirs AHEAD of whatever PATH this test passed in. On a host where those real dirs
# hold a real tmux/ps/npm, the fakes below are silently shadowed and this test accidentally
# "works" only because the host's OWN live dashboard/session happen to match what the fakes would
# have said (measured: on this host, the real `ps` finds the real marveen dashboard process, so
# npm was never reached at all -- not because the fake ps was consulted). $HOME/.local/bin is
# FIRST in that list and is under our control via HOME, so every fake goes there instead of a
# bare $TMP/fakebin -- this is what actually wins the precedence race, not PATH prepending alone.
FAKEBIN="$TMP/fixture-home/.local/bin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/tmux" <<'EOF'
#!/bin/bash
if [ "$1" = "has-session" ]; then
  for a in "$@"; do
    case "$a" in
      *marveen-channels*) exit 0 ;;   # pretend the main session is already up -- skip that branch
      *undecidable-agent*) exit 1 ;;  # our fixture agent is NOT running -- proceed to restart logic
    esac
  done
  exit 1
fi
exit 0
EOF
chmod +x "$FAKEBIN/tmux"
cat > "$FAKEBIN/ps" <<'EOF'
#!/bin/bash
echo "fakeuser     1     0  0 00:00 ?        00:00:00 node dist/index.js"
EOF
chmod +x "$FAKEBIN/ps"
cat > "$FAKEBIN/claude" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$FAKEBIN/claude"

# Cybersec NO-GO 28997 N2 (card 313c8a71 round 7): the real main loop's dashboard-restart branch
# (watchdog.sh ~line 436, `cd $INSTALL_DIR && nohup npm start`) is reached whenever the `ps` shim
# does not resolve a dashboard PID in this run's shape, and the fixture install has no package.json,
# so a real `npm` on PATH walks UP to the nearest ancestor's package.json and can run arbitrary
# host scripts outside the fixture entirely. Stub `npm` in FAKEBIN too, like tmux/ps/claude, so no
# real npm (or its canary target) ever runs.
cat > "$FAKEBIN/npm" <<'EOF'
#!/bin/bash
echo "NPM_CANARY_FIRED: $*" >> "$FIXTURE_NPM_CANARY_LOG"
exit 0
EOF
chmod +x "$FAKEBIN/npm"
export FIXTURE_NPM_CANARY_LOG="$TMP/npm-canary.log"
FIXTURE_HOME="$TMP/fixture-home"

# A second fixture HOME, used ONLY for the forced dashboard-down case below: its .local/bin/ps
# never matches "node dist/index.js", so DASHBOARD_PID resolves empty and the dashboard-restart
# branch (watchdog.sh's `cd $INSTALL_DIR && nohup npm start`) is GUARANTEED to run, instead of
# relying on the normal ps shim happening to skip it. A host-style "ancestor package.json" canary
# sits at $TMP/package.json (one level above $FIXTURE_INSTALL, same relative position npm's own
# upward-walk would find if it ever ran for real) with a start script that touches a marker --
# this reproduces Cybersec's own repro shape (28997 N2) safely inside $TMP, cleaned up by the trap.
FIXTURE_HOME_NO_DASHBOARD="$TMP/fixture-home-no-dashboard"
mkdir -p "$FIXTURE_HOME_NO_DASHBOARD/.local/bin"
cp "$FAKEBIN/tmux" "$FAKEBIN/claude" "$FAKEBIN/npm" "$FIXTURE_HOME_NO_DASHBOARD/.local/bin/"
cat > "$FIXTURE_HOME_NO_DASHBOARD/.local/bin/ps" <<'EOF'
#!/bin/bash
echo "fakeuser     1     0  0 00:00 ?        00:00:00 some-other-process"
EOF
chmod +x "$FIXTURE_HOME_NO_DASHBOARD/.local/bin/ps"
HOST_CANARY="$TMP/host-canary-fired"
cat > "$TMP/package.json" <<EOF
{"scripts": {"start": "touch $HOST_CANARY"}}
EOF

echo "watchdog main-loop REFUSE-alert wiring:"

run_main_loop() {
  # $1 = watchdog.sh to run (real or mutant)
  HOME="$FIXTURE_HOME" \
    PATH="$FAKEBIN:$PATH" \
    NEEDS_FLEET_OAUTH_MJS="$BROKEN_INSTALL/needs-fleet-oauth.mjs" \
    WATCHDOG_ALERT_DRYRUN=1 \
    bash "$1" 2>&1
  # INSTALL_DIR is derived from the script's OWN location (dirname "$0"/..), so running the copy
  # inside $FIXTURE_INSTALL/scripts/ makes it resolve to $FIXTURE_INSTALL automatically -- no env
  # override needed for INSTALL_DIR itself. HOME is overridden because watchdog.sh:364 rebuilds
  # PATH itself with $HOME/.local/bin first -- see the FAKEBIN comment above.
}

# 1) BLOCKING: the real, unmodified watchdog.sh -- the undecidable agent must be refused AND the
#    owner alert must fire, driven through the ACTUAL main loop, not the --selftest-refuse-alert
#    hook.
rm -f "$FIXTURE_INSTALL/logs/watchdog.log" "$FIXTURE_INSTALL/store/.watchdog-fleet-oauth-undecidable-alert"
out="$(run_main_loop "$WD")"
case "$out" in
  *"ALERT_DRYRUN:"*"undecidable"*) pass "real main loop: undecidable verdict alerts the owner" ;;
  *) fail "real main loop: undecidable verdict alerts the owner" "$out" ;;
esac

# 2) MUTATION PROOF (the actual gap QA2 named): remove the real call site (the SECOND occurrence
#    of maybe_alert_for_refuse_reason in the file -- the first is inside the --selftest-refuse-alert
#    hook, which this test never invokes) and confirm THIS test goes red.
#    Cybersec F1 (card 46194693, round 5): the mutant MUST live at the SAME depth as $WD, inside
#    $FIXTURE_INSTALL/scripts/, not loose at $TMP's own top. INSTALL_DIR is "$(dirname "$0")/..",
#    so a mutant copy sitting directly in $TMP (one directory too shallow) resolves INSTALL_DIR to
#    $TMP's PARENT -- /tmp itself on a typical mktemp -d layout -- and the real script then tries
#    real actions (npm start, scripts/channels.sh) against the real filesystem's /tmp, with side
#    effects outside the fixture and a vacuous case (an unmutated copy at that same wrong location
#    fails the same way, so the case proves nothing about the mutation).
MUTANT="$FIXTURE_INSTALL/scripts/watchdog-mutant.sh"
python3 - "$WD" "$MUTANT" <<'PY'
import sys
src_path, dst_path = sys.argv[1], sys.argv[2]
with open(src_path) as f:
    lines = f.readlines()
seen = 0
for i, line in enumerate(lines):
    if 'maybe_alert_for_refuse_reason "$REFUSE_REASON"' in line:
        seen += 1
        if seen == 2:  # the real main-loop call site, not the --selftest-refuse-alert hook's
            lines[i] = '      : # MUTANT: ' + line.lstrip()
            break
with open(dst_path, 'w') as f:
    f.writelines(lines)
PY
chmod +x "$MUTANT"
if diff -q "$WD" "$MUTANT" > /dev/null 2>&1; then
  fail "mutant script actually differs from the original" "sed/python substitution did not match"
else
  pass "mutant script differs from the original (the substitution matched the real call site)"
fi

# Cybersec NO-GO 28997 N1 (card 313c8a71 round 7): case 1 above fires the alert, which writes the
# cooldown sentinel $FIXTURE_INSTALL/store/.watchdog-fleet-oauth-undecidable-alert
# (WATCHDOG_ALERT_COOLDOWN_SEC default 3600, watchdog.sh:19-20). Clearing only watchdog.log before
# the mutant run left the sentinel in place, so the mutant run below was silent REGARDLESS of the
# mutation (still inside cooldown) -- vacuous. Clear the sentinel too.
rm -f "$FIXTURE_INSTALL/logs/watchdog.log" "$FIXTURE_INSTALL/store/.watchdog-fleet-oauth-undecidable-alert"
out="$(run_main_loop "$MUTANT")"
case "$out" in
  *"ALERT_DRYRUN"*) fail "mutant (real call site removed) is caught: it still alerted" "$out" ;;
  *) pass "mutant (real call site removed) is caught: no alert without the real call site" ;;
esac

# 3) DISCRIMINATION PROOF for case 2 (closes N1 for real, not just by construction): the SAME
#    sentinel-clear-then-run must FAIL (alert still fires) against the UNMODIFIED script, or the
#    case above cannot tell "real call site removed" apart from "cooldown suppressed it anyway".
rm -f "$FIXTURE_INSTALL/logs/watchdog.log" "$FIXTURE_INSTALL/store/.watchdog-fleet-oauth-undecidable-alert"
out="$(run_main_loop "$WD")"
case "$out" in
  *"ALERT_DRYRUN:"*"undecidable"*) pass "control: the unmodified script still alerts with the sentinel cleared (case 2 is discriminating, not vacuous)" ;;
  *) fail "control: the unmodified script still alerts with the sentinel cleared" "$out" ;;
esac

# 4) Cybersec NO-GO 28997 N2 (card 313c8a71 round 7): force the dashboard-restart branch to run
#    (ps shim reports no dashboard PID) and show the npm stub intercepts it -- no real npm ever
#    walks up to the host-style ancestor package.json's canary.
rm -f "$FIXTURE_INSTALL/logs/watchdog.log" "$FIXTURE_INSTALL/store/.watchdog-fleet-oauth-undecidable-alert" \
  "$FIXTURE_NPM_CANARY_LOG" "$HOST_CANARY"
out="$(HOME="$FIXTURE_HOME_NO_DASHBOARD" PATH="$FAKEBIN:$PATH" NEEDS_FLEET_OAUTH_MJS="$BROKEN_INSTALL/needs-fleet-oauth.mjs" WATCHDOG_ALERT_DRYRUN=1 bash "$WD" 2>&1)"
if [ -f "$HOST_CANARY" ]; then
  fail "forced dashboard-down: npm stub intercepts before any real ancestor package.json runs" "host canary WAS touched: $HOST_CANARY exists"
elif [ -s "$FIXTURE_NPM_CANARY_LOG" ] && grep -q 'start' "$FIXTURE_NPM_CANARY_LOG"; then
  pass "forced dashboard-down: dashboard-restart branch reached npm, stub caught it, no host canary fired"
else
  fail "forced dashboard-down: expected the stubbed npm to be invoked with 'start'" "canary log: $(cat "$FIXTURE_NPM_CANARY_LOG" 2>/dev/null || echo '<empty>')"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "watchdog-main-loop-refuse-alert: all $PASS cases pass."
  exit 0
else
  echo "watchdog-main-loop-refuse-alert: $PASS passed, $FAIL FAILED."
  exit 1
fi

#!/bin/bash
# Contract tests for scripts/watchdog.sh launch-env isolation parity.
#
# Regression origin: the dashboard launches every sub-agent with a per-agent
# CLAUDE_CONFIG_DIR (agent-process.ts provisions <agent>/.claude-config, gated
# on store/.claude-oauth-token), and channel-watchdog.sh rebuilds the same
# CFG_ENV on its respawn path -- but this watchdog's tmux launch dropped both.
# The FIRST auto-recovery therefore silently moved an agent back onto the
# shared ~/.claude, reintroducing the plugin-slot collisions isolation exists
# to prevent (a live fleet measured 9 agents de-isolated this way).
#
# Driven through `watchdog.sh --launch-env <dir>`, which prints the prefix and
# exits before touching tmux, the dashboard API or the log -- so these run
# from fixtures with no live agent and no real token.
# Run: bash scripts/__tests__/watchdog-config-isolation.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so the suite can be pointed at a deliberately-broken copy to
# confirm it actually fails on the bug.
WATCHDOG="${WATCHDOG_BIN:-$REPO_DIR/scripts/watchdog.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The watchdog resolves store/.claude-oauth-token relative to its own
# INSTALL_DIR; run it from a fixture install so the token file is ours.
FIXTURE_INSTALL="$TMP/install"
mkdir -p "$FIXTURE_INSTALL/scripts" "$FIXTURE_INSTALL/store" "$FIXTURE_INSTALL/agents"
cp "$WATCHDOG" "$FIXTURE_INSTALL/scripts/watchdog.sh"
WD="$FIXTURE_INSTALL/scripts/watchdog.sh"

AGENT_ISO="$FIXTURE_INSTALL/agents/iso-agent"
AGENT_PLAIN="$FIXTURE_INSTALL/agents/plain-agent"
mkdir -p "$AGENT_ISO/.claude-config" "$AGENT_PLAIN"

echo "watchdog launch-env isolation contract:"

# 1) No fleet token at all -> no isolation, even with a provisioned dir
#    (matches agent-process.ts gating: no token -> intended shared mode).
OUT="$(bash "$WD" --launch-env "$AGENT_ISO")"
case "$OUT" in
  isolation=no) pass "no token file -> no isolation" ;;
  *) fail "no token file -> no isolation" "$OUT" ;;
esac

# 2) Empty token file -> still no isolation (gate is -s, not -f).
: > "$FIXTURE_INSTALL/store/.claude-oauth-token"
OUT="$(bash "$WD" --launch-env "$AGENT_ISO")"
case "$OUT" in
  isolation=no) pass "empty token file -> no isolation" ;;
  *) fail "empty token file -> no isolation" "$OUT" ;;
esac

# 3) Token present + provisioned dir -> isolation prefix with both exports.
echo "sk-test-fixture-token" > "$FIXTURE_INSTALL/store/.claude-oauth-token"
OUT="$(bash "$WD" --launch-env "$AGENT_ISO")"
case "$OUT" in
  "isolation=yes prefix="*CLAUDE_CONFIG_DIR*CLAUDE_CODE_OAUTH_TOKEN*)
    pass "token + .claude-config -> isolation prefix" ;;
  *) fail "token + .claude-config -> isolation prefix" "$OUT" ;;
esac

# 4) The literal token must NOT appear in the prefix: it is read inside the
#    pane via \$(cat ...), so it never lands in the command string or ps.
case "$OUT" in
  *sk-test-fixture-token*) fail "literal token kept out of the prefix" "$OUT" ;;
  *'$(cat '*) pass "literal token kept out of the prefix (read via \$(cat))" ;;
  *) fail "literal token kept out of the prefix" "$OUT" ;;
esac

# 5) Token present but the agent has no .claude-config -> no isolation
#    (unprovisioned agents keep their current behaviour).
OUT="$(bash "$WD" --launch-env "$AGENT_PLAIN")"
case "$OUT" in
  isolation=no) pass "no .claude-config dir -> no isolation" ;;
  *) fail "no .claude-config dir -> no isolation" "$OUT" ;;
esac

# --- oauthTokenFile (card 006b506b WhiteHat F5): a second launch site that
# must respect the per-agent own-token field, fail-closed, instead of silently
# exporting the fleet token whenever the field is present but unusable. ---

AGENT_OWN="$FIXTURE_INSTALL/agents/own-token-agent"
mkdir -p "$AGENT_OWN/.claude-config"
OWN_TOKEN_FILE="$TMP/own-agent.token"
FAKE_SETUP_TOKEN="sk-ant-oat-fake"

write_own_config() {
  printf '{"oauthTokenFile": "%s"}\n' "$OWN_TOKEN_FILE" > "$AGENT_OWN/agent-config.json"
}
write_own_config

# 6) Valid own token file (0600, sk-ant-oat prefix, agent isolated) -> own
#    file's path in the prefix, NOT the fleet token's path -- even though the
#    fleet token file from test 3 is populated and non-empty.
printf '%s' "$FAKE_SETUP_TOKEN" > "$OWN_TOKEN_FILE"
chmod 600 "$OWN_TOKEN_FILE"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=yes prefix="*"$OWN_TOKEN_FILE"*)
    pass "oauthTokenFile valid -> own file in the prefix" ;;
  *) fail "oauthTokenFile valid -> own file in the prefix" "$OUT" ;;
esac
case "$OUT" in
  *".claude-oauth-token"*) fail "oauthTokenFile valid -> fleet token path NOT in the prefix" "$OUT" ;;
  *) pass "oauthTokenFile valid -> fleet token path NOT in the prefix" ;;
esac

# 7) Own token file missing -> refuse, NEVER fall back to the fleet token
#    (the fleet token is populated and would otherwise be available).
rm -f "$OWN_TOKEN_FILE"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=missing-or-symlink") pass "oauthTokenFile missing file -> refuse, no fleet fallback" ;;
  *) fail "oauthTokenFile missing file -> refuse, no fleet fallback" "$OUT" ;;
esac

# 8) Own token file present but mode wider than 0600 -> refuse.
printf '%s' "$FAKE_SETUP_TOKEN" > "$OWN_TOKEN_FILE"
chmod 644 "$OWN_TOKEN_FILE"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=mode-not-0600") pass "oauthTokenFile mode 644 -> refuse" ;;
  *) fail "oauthTokenFile mode 644 -> refuse" "$OUT" ;;
esac
chmod 600 "$OWN_TOKEN_FILE"

# 9) Own token file present, right mode, but content doesn't look like a
#    setup token -> refuse.
printf 'not-a-real-token-value' > "$OWN_TOKEN_FILE"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=not-a-setup-token") pass "oauthTokenFile bad content -> refuse" ;;
  *) fail "oauthTokenFile bad content -> refuse" "$OUT" ;;
esac

# 10) Own token file points at the fleet token file itself -> refuse (an
#     agent with its own field must not just re-point at the shared file).
printf '%s' "$FAKE_SETUP_TOKEN" > "$OWN_TOKEN_FILE"
printf '{"oauthTokenFile": "%s"}\n' "$FIXTURE_INSTALL/store/.claude-oauth-token" > "$AGENT_OWN/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=is-fleet-token-file") pass "oauthTokenFile == fleet token file -> refuse" ;;
  *) fail "oauthTokenFile == fleet token file -> refuse" "$OUT" ;;
esac
write_own_config

# 11) Field present but the agent has no .claude-config dir -> refuse
#     (cannot isolate), not a silent fleet fallback.
rm -rf "$AGENT_OWN/.claude-config"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=not-isolated") pass "oauthTokenFile set, no .claude-config -> refuse" ;;
  *) fail "oauthTokenFile set, no .claude-config -> refuse" "$OUT" ;;
esac

# 12) MUTATION PIN: an agent with NO oauthTokenFile field is completely
#     unaffected by all of the above (same as AGENT_ISO in test 3).
OUT="$(bash "$WD" --launch-env "$AGENT_ISO")"
case "$OUT" in
  "isolation=yes prefix="*CLAUDE_CONFIG_DIR*CLAUDE_CODE_OAUTH_TOKEN*)
    pass "no oauthTokenFile field -> unaffected, still fleet-token isolation" ;;
  *) fail "no oauthTokenFile field -> unaffected, still fleet-token isolation" "$OUT" ;;
esac

echo "watchdog-config-isolation: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

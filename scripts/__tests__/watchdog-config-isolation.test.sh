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
mkdir -p "$FIXTURE_INSTALL/scripts/lib" "$FIXTURE_INSTALL/store" "$FIXTURE_INSTALL/agents"
cp "$WATCHDOG" "$FIXTURE_INSTALL/scripts/watchdog.sh"
# Card bc32d233: agent_launch_env's config-level resolution moved into this sibling script
# (scripts/lib/oauth_token_file_check.py), relative to watchdog.sh's own INSTALL_DIR -- the fixture
# install must carry it too, same as the watchdog script itself.
cp "$REPO_DIR/scripts/lib/oauth_token_file_check.py" "$FIXTURE_INSTALL/scripts/lib/oauth_token_file_check.py"
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

# --- card bc32d233 (006b506b Cybersec delta-GO ea46eecf, G1-G4): the config-level resolution's
# own fail-closed behaviour (G1), the two content checks missing from the file-level checks (G2,
# fleet-token copy + bad characters), and the shell-injection class the old f-string interpolation
# opened (G3) -- see oauth_token_file_check.py and agent_launch_env's own comments for the full
# reasoning. Baseline restored first: test 11 above removed AGENT_OWN's .claude-config dir. ---
mkdir -p "$AGENT_OWN/.claude-config"
write_own_config
printf '%s' "$FAKE_SETUP_TOKEN" > "$OWN_TOKEN_FILE"
chmod 600 "$OWN_TOKEN_FILE"

# 13) G1: agent-config.json is a DIRECTORY, not a file -> refuse at the config level, never a
#     silent "unset" -> fleet-token fallback (the bug: `except Exception: print('')` caught this
#     and every other read failure the same way).
rm -f "$AGENT_OWN/agent-config.json"
mkdir -p "$AGENT_OWN/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=config-unreadable") pass "G1: config path is a directory -> refuse, no fleet fallback" ;;
  *) fail "G1: config path is a directory -> refuse, no fleet fallback" "$OUT" ;;
esac
rm -rf "$AGENT_OWN/agent-config.json"

# 14) G1: config truncated mid-key-name (a crash/non-atomic write cut if off WHILE writing the key)
#     still REFUSEs -- the truncated tail is a prefix of "oauthTokenFile", so a config that never
#     mentioned the field at all could not produce this text.
printf '{"oauthTok' > "$AGENT_OWN/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=config-unparseable") pass "G1: config truncated mid-key-name -> refuse" ;;
  *) fail "G1: config truncated mid-key-name -> refuse" "$OUT" ;;
esac

# 15) G1: field value is a number, not a string -> refuse (not silently unset).
printf '{"oauthTokenFile": 42}' > "$AGENT_OWN/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=not-a-string") pass "G1: field value is a number -> refuse" ;;
  *) fail "G1: field value is a number -> refuse" "$OUT" ;;
esac

# 16) G1: field value is an empty string after trim -> refuse (blank).
printf '{"oauthTokenFile": "   "}' > "$AGENT_OWN/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=blank") pass "G1: field value is blank -> refuse" ;;
  *) fail "G1: field value is blank -> refuse" "$OUT" ;;
esac

# 17) G1: path contains a '..' segment -> refuse (path-parent-traversal), same as the TS reference.
printf '{"oauthTokenFile": "/tmp/../etc/foo"}' > "$AGENT_OWN/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=path-parent-traversal") pass "G1: path with '..' segment -> refuse" ;;
  *) fail "G1: path with '..' segment -> refuse" "$OUT" ;;
esac
write_own_config

# 18) G2: own token file content is a byte-identical COPY of the fleet token (different inode, same
#     bytes) -> refuse. The old bash mirror only checked `-ef` (same inode/same file), which a copy
#     is not, so this is a genuinely new check, not a re-measurement of test 10's same-FILE case.
#     The fleet token here is given the setup-token shape too (same precedence as the TS reference:
#     checkOauthTokenFile's bad-prefix check runs BEFORE its same-as-fleet-token check), so this
#     test actually reaches the content-equality check instead of failing on the prefix first.
printf '%s' "$FAKE_SETUP_TOKEN" > "$FIXTURE_INSTALL/store/.claude-oauth-token"
cp "$FIXTURE_INSTALL/store/.claude-oauth-token" "$OWN_TOKEN_FILE"
chmod 600 "$OWN_TOKEN_FILE"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=same-as-fleet-token") pass "G2: own file is a byte-identical COPY of the fleet token -> refuse" ;;
  *) fail "G2: own file is a byte-identical COPY of the fleet token -> refuse" "$OUT" ;;
esac
echo "sk-test-fixture-token" > "$FIXTURE_INSTALL/store/.claude-oauth-token" # restore for later tests

# 19) G2: own token content contains a space after the setup-token prefix -- the old bash mirror
#     only checked the first 20 bytes for the prefix and never looked past it.
printf '%s with a space' "$FAKE_SETUP_TOKEN" > "$OWN_TOKEN_FILE"
chmod 600 "$OWN_TOKEN_FILE"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=content-bad-characters") pass "G2: token content has a space -> refuse" ;;
  *) fail "G2: token content has a space -> refuse" "$OUT" ;;
esac
printf '%s' "$FAKE_SETUP_TOKEN" > "$OWN_TOKEN_FILE"
chmod 600 "$OWN_TOKEN_FILE"

# 20) G3 regression guard: an agent directory whose NAME contains a single quote must not let the
#     quote escape the quoted shell argument the old f-string-interpolated `python3 -c "..."`
#     built (the surviving mutant: a quote in the path broke OUT of the quoted command). AGENT_DIR
#     now reaches the check script as argv, never interpolated into Python source, so this must
#     resolve normally (SET, own file in the prefix), not crash and not silently fall back to the
#     fleet token.
AGENT_QUOTE="$FIXTURE_INSTALL/agents/quote's-agent"
mkdir -p "$AGENT_QUOTE/.claude-config"
QUOTE_TOKEN_FILE="$TMP/quote-agent.token"
printf '%s' "$FAKE_SETUP_TOKEN" > "$QUOTE_TOKEN_FILE"
chmod 600 "$QUOTE_TOKEN_FILE"
printf '{"oauthTokenFile": "%s"}\n' "$QUOTE_TOKEN_FILE" > "$AGENT_QUOTE/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_QUOTE")"
case "$OUT" in
  "isolation=yes prefix="*"$QUOTE_TOKEN_FILE"*)
    pass "G3: agent dir name with a single quote -> resolves normally, no shell escape" ;;
  *) fail "G3: agent dir name with a single quote -> resolves normally, no shell escape" "$OUT" ;;
esac

# 21) QA FAIL follow-up (card bc32d233, 2026-10-10): a truly EMPTY, whitespace-only, or
#     NUL-containing config file (a realistic crash-mid-non-atomic-write result) named neither
#     KEY_QUOTED nor a truncated key tail, so it fell through json.loads' except-branch to ""
#     (unset) -> the FLEET token -- the G1 fail-open class, on whole-file instead of field-level
#     corruption. Three sub-cases, each must refuse at the config level, never fleet-fallback.
rm -f "$AGENT_OWN/agent-config.json"
: > "$AGENT_OWN/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=config-unreadable") pass "21a: empty (0-byte) config -> refuse, no fleet fallback" ;;
  *) fail "21a: empty (0-byte) config -> refuse, no fleet fallback" "$OUT" ;;
esac

printf '   \n  ' > "$AGENT_OWN/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=config-unreadable") pass "21b: whitespace-only config -> refuse, no fleet fallback" ;;
  *) fail "21b: whitespace-only config -> refuse, no fleet fallback" "$OUT" ;;
esac

printf '{"foo":1}\x00{"bar":2}' > "$AGENT_OWN/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=config-unreadable") pass "21c: NUL-containing config (key not named) -> refuse, no fleet fallback" ;;
  *) fail "21c: NUL-containing config (key not named) -> refuse, no fleet fallback" "$OUT" ;;
esac
rm -rf "$AGENT_OWN/agent-config.json"
write_own_config

echo "watchdog-config-isolation: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

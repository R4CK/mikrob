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
# Card 3ae2411d round 2: needs-fleet-oauth.mjs resolves the compiled dist relative to its OWN
# location (scripts/needs-fleet-oauth.mjs -> ../dist), which the fixture install does not carry.
# Point watchdog.sh at the real repo's copy instead of copying it in -- the script takes the
# target agent dir as an argv, so pointing at the real file works identically for a fixture dir.
export NEEDS_FLEET_OAUTH_MJS="$REPO_DIR/scripts/needs-fleet-oauth.mjs"
# Card 3ae2411d F4: same reasoning, for the provider-env script that fills in what the
# UNSET-field fallback used to leave empty for a BYO/customProvider agent.
export WATCHDOG_PROVIDER_ENV_MJS="$REPO_DIR/scripts/watchdog-provider-env.mjs"

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

# 22) RedHat NO-GO 14838 / QA2 FAIL 14840 (card bc32d233 delta-gate, 2026-10-10): the checker
#     itself failing to run, crashing, or emitting anything other than exactly UNSET/SET:*/
#     REFUSE:* used to fall through agent_launch_env's case silently to the unconditional
#     fleet-token fallback -- G1's fail-open class at the PROCESS level, not the config-content
#     level. All four must refuse, never fleet-fallback.
write_own_config  # own-token-agent has a normal, valid config for all four sub-cases below

# 22a) checker binary missing entirely.
OUT="$(OAUTH_TOKEN_FILE_CHECK_PY="$TMP/does-not-exist.py" bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=checker-failed") pass "22a: checker script missing -> refuse, no fleet fallback" ;;
  *) fail "22a: checker script missing -> refuse, no fleet fallback" "$OUT" ;;
esac

# 22b) checker crashes (raises, non-zero exit, nothing on stdout).
CRASHING_CHECKER="$TMP/crashing-check.py"
printf '%s\n' '#!/usr/bin/env python3' 'raise RuntimeError("simulated crash")' > "$CRASHING_CHECKER"
OUT="$(OAUTH_TOKEN_FILE_CHECK_PY="$CRASHING_CHECKER" bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=checker-failed") pass "22b: checker crashes -> refuse, no fleet fallback" ;;
  *) fail "22b: checker crashes -> refuse, no fleet fallback" "$OUT" ;;
esac

# 22c) checker exits 0 but prints nothing (empty stdout) -- the exact scenario QA2 measured
#      (14840): "" must never again be read as the legitimate UNSET sentinel.
EMPTY_CHECKER="$TMP/empty-check.py"
printf '%s\n' '#!/usr/bin/env python3' 'pass' > "$EMPTY_CHECKER"
OUT="$(OAUTH_TOKEN_FILE_CHECK_PY="$EMPTY_CHECKER" bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=checker-failed") pass "22c: checker exits 0 with empty stdout -> refuse, no fleet fallback" ;;
  *) fail "22c: checker exits 0 with empty stdout -> refuse, no fleet fallback" "$OUT" ;;
esac

# 22d) checker prints more than one line (contract violation) -- must not be mistaken for a
#      literal "UNSET" or "SET:*"/"REFUSE:*" match.
MULTILINE_CHECKER="$TMP/multiline-check.py"
printf '%s\n' '#!/usr/bin/env python3' 'print("UNSET")' 'print("extra garbage line")' > "$MULTILINE_CHECKER"
OUT="$(OAUTH_TOKEN_FILE_CHECK_PY="$MULTILINE_CHECKER" bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=checker-failed") pass "22d: checker prints more than one line -> refuse, no fleet fallback" ;;
  *) fail "22d: checker prints more than one line -> refuse, no fleet fallback" "$OUT" ;;
esac

# 23) RedHat NO-GO 14838 point 2 (card bc32d233): a config file with invalid UTF-8 bytes used to
#     crash the REAL checker with an uncaught UnicodeDecodeError (OSError is the only caught
#     exception type) -- empty stdout, non-zero exit, same fail-open fleet-fallback path as #22.
#     Uses the REAL checker (no override), so this also proves the Python-side errors="replace"
#     fix specifically. Asserting the EXACT reason (not just "isolation=refuse*") matters: the
#     __main__ belt-and-suspenders try/except (also added this delta) would catch the same
#     UnicodeDecodeError and print "REFUSE:checker-failed" even WITHOUT the errors="replace" fix,
#     which would make this test pass on the mutated code too and defeat its own purpose. With
#     the real fix, decoding succeeds (replacement chars), json.loads succeeds, and resolution
#     proceeds normally to the next real check (the garbled value is not an absolute path).
printf '{"oauthTokenFile": "\xff\xfe-invalid-utf8"}' > "$AGENT_OWN/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_OWN")"
case "$OUT" in
  "isolation=refuse reason=not-absolute") pass "23: invalid UTF-8 bytes in config naming the key -> decoded (not crashed), refused on the garbled value" ;;
  *) fail "23: invalid UTF-8 bytes in config naming the key -> decoded (not crashed), refused on the garbled value" "$OUT" ;;
esac
rm -rf "$AGENT_OWN/agent-config.json"
write_own_config

# --- card 3ae2411d (RedHat GO 617d136d, comment 16008): the UNSET-field fallback (no
# oauthTokenFile configured at all) must honor the SAME predicate as needsFleetOauthFor
# (src/web/agent-process.ts) -- a BYO/customProvider agent, an own_team agent, or an agent on a
# non-claude model must never get the fleet's CLAUDE_CODE_OAUTH_TOKEN exported on a
# watchdog-triggered restart either. These agents have NO oauthTokenFile field (that branch is
# already covered above); this is the OTHER branch, the one this card's bug lived in. ---

AGENT_BYO="$FIXTURE_INSTALL/agents/byo-agent"
mkdir -p "$AGENT_BYO/.claude-config"

# 24) BLOCKING (this card's repro): customProvider set, no oauthTokenFile field -> no isolation
#     (the fleet token must NOT be exported). Before this fix, this fell straight to the
#     unconditional fallback and printed "isolation=yes" with the fleet token in the prefix.
#     "my-ollama-endpoint" is not a registered customProvider, so watchdog-provider-env.mjs's own
#     getCustomProviderOrThrow throws (exit 2) -- card 313c8a71's own F1 fix on ac0bf02d's WhiteHat
#     GO 28831: a non-zero exit from that script now REFUSES the restart rather than restarting
#     with no credentials (the fleet token is still never exported, same as before).
printf '{"customProvider": "my-ollama-endpoint"}' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=refuse reason=provider-env-unavailable") pass "24: customProvider set, no oauthTokenFile -> refuse (no credentials available), no fleet-token export" ;;
  *) fail "24: customProvider set, no oauthTokenFile -> refuse (no credentials available), no fleet-token export" "$OUT" ;;
esac

# 25) authMode 'own_team' (agent authenticates via its own /login credential) -> no isolation,
#     same exclusion as needsFleetOauthFor's isOwnTeam branch.
printf '{"authMode": "own_team"}' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  isolation=no) pass "25: authMode own_team -> no fleet-token export" ;;
  *) fail "25: authMode own_team -> no fleet-token export" "$OUT" ;;
esac

# 26) authMode 'api' (agent authenticates via its own ANTHROPIC_API_KEY) -> no isolation.
printf '{"authMode": "api"}' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  isolation=no) pass "26: authMode api -> no fleet-token export" ;;
  *) fail "26: authMode api -> no fleet-token export" "$OUT" ;;
esac

# 27) Explicit non-claude model, no customProvider -> never the fleet token (isClaude is false
#     either way). Card 3ae2411d F4: this used to print "isolation=no" (nothing at all); now it
#     gets its OWN provider env (ANTHROPIC_BASE_URL/ANTHROPIC_MODEL for deepseek), never the fleet
#     token -- the fix this card's F4 asked for, not a regression of this case.
printf '{"model": "deepseek-chat"}' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=yes prefix="*"ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic"*"ANTHROPIC_MODEL='deepseek-chat'"*)
    pass "27: non-claude model, no customProvider -> own provider env, no fleet token" ;;
  *) fail "27: non-claude model, no customProvider -> own provider env, no fleet token" "$OUT" ;;
esac
case "$OUT" in
  *"CLAUDE_CODE_OAUTH_TOKEN"*) fail "27: fleet token NOT exported for a BYO model" "$OUT" ;;
  *) pass "27: fleet token NOT exported for a BYO model" ;;
esac

# 28) MUTATION PIN: an explicit claude model, authMode 'shared' (the default), no customProvider
#     -> STILL gets isolation (this fix must not regress the common case).
printf '{"model": "claude-sonnet-5", "authMode": "shared"}' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=yes prefix="*CLAUDE_CONFIG_DIR*CLAUDE_CODE_OAUTH_TOKEN*)
    pass "28: claude model, authMode shared, no customProvider -> still isolated/fleet-token" ;;
  *) fail "28: claude model, authMode shared, no customProvider -> still isolated/fleet-token" "$OUT" ;;
esac

# 29) MUTATION PIN: no agent-config.json at all (AGENT_ISO, re-checked here after the BYO cases
#     above) -> unaffected, same as test 3/12 -- this fix must not touch the no-config default.
rm -f "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_ISO")"
case "$OUT" in
  "isolation=yes prefix="*CLAUDE_CONFIG_DIR*CLAUDE_CODE_OAUTH_TOKEN*)
    pass "29: no agent-config.json at all -> still unaffected, fleet-token isolation" ;;
  *) fail "29: no agent-config.json at all -> still unaffected, fleet-token isolation" "$OUT" ;;
esac

# --- card 3ae2411d round 2 (MikroB msg_id:16839, WhiteHat2 F1): the retired Python predicate
# read the raw `model` string instead of resolving it the way agent-process.ts does -- a model
# ALIAS decided differently here than on the dashboard launch path. These two pin the fix. ---

# 30) BLOCKING (round 2 repro): model alias "sonnet" resolves (via MODEL_ALIASES) to the real
#     model id "claude-sonnet-5" -- isClaude must be TRUE, same as agent-process.ts's own
#     resolveModelId call. The retired predicate read "sonnet".startswith("claude-") directly
#     (False) and refused the token a plain fleet agent on this alias actually needs.
printf '{"model": "sonnet", "authMode": "shared"}' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=yes prefix="*CLAUDE_CONFIG_DIR*CLAUDE_CODE_OAUTH_TOKEN*)
    pass "30: model alias 'sonnet' resolves to claude- -> fleet-token export" ;;
  *) fail "30: model alias 'sonnet' resolves to claude- -> fleet-token export" "$OUT" ;;
esac

# 31) customProvider set TOGETHER WITH an explicit claude- model string (WhiteHat2 F1): the
#     customProvider must still win -- isClaude is false regardless of the model string, same as
#     isClaudeAgent's own contract (`!customProviderId && model.startsWith('claude-')`).
#     "my-litellm-proxy" is unregistered too, so this is the same refuse path as case 24.
printf '{"customProvider": "my-litellm-proxy", "model": "claude-sonnet-5"}' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=refuse reason=provider-env-unavailable") pass "31: customProvider + claude- model string -> customProvider still wins, refuse (unregistered)" ;;
  *) fail "31: customProvider + claude- model string -> customProvider still wins, refuse (unregistered)" "$OUT" ;;
esac
rm -f "$AGENT_BYO/agent-config.json"

# --- card 3ae2411d F4 (WhiteHat2 GO on a879697c0/a1ebf6bca): a BYO/customProvider agent restarted
# by the watchdog used to come up as plain Claude with NO credentials of its own -- the fleet-
# token leak was fixed (tests 24-27, 31 above), but nothing replaced it. These pin the actual fix:
# the restarted agent gets its OWN provider env, single source with the dashboard start path. ---

# 32) BLOCKING (this follow-up's own repro): an openrouter-shaped model (contains '/') with no
#     customProvider -> own provider env (ANTHROPIC_BASE_URL=https://openrouter.ai/api), never the
#     fleet token.
printf '{"model": "meta-llama/llama-3.1-8b"}' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=yes prefix="*"ANTHROPIC_BASE_URL=https://openrouter.ai/api"*)
    pass "32: openrouter-shaped model -> own provider env" ;;
  *) fail "32: openrouter-shaped model -> own provider env" "$OUT" ;;
esac
case "$OUT" in
  *"CLAUDE_CODE_OAUTH_TOKEN"*) fail "32: fleet token NOT exported for an openrouter model" "$OUT" ;;
  *) pass "32: fleet token NOT exported for an openrouter model" ;;
esac
rm -f "$AGENT_BYO/agent-config.json"

# 33) authMode 'own_team' or plain shared/claude still get NO provider env from this new branch
#     (their credentials are the own-setup-token / fleet-token paths above this function, not
#     resolveProviderEnv's job) -- mutation pin so a too-eager rewrite of the new branch does not
#     start emitting a provider env for the common case.
printf '{"authMode": "own_team"}' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  isolation=no) pass "33: authMode own_team -> still no provider env (unaffected by F4)" ;;
  *) fail "33: authMode own_team -> still no provider env (unaffected by F4)" "$OUT" ;;
esac
rm -f "$AGENT_BYO/agent-config.json"

# 34) customProvider pointing at an UNREGISTERED id -> fail-closed REFUSE (no export, no restart),
#     never a partial/guessed export and never a silent restart-with-nothing -- same posture as the
#     dashboard start path's own throw (agent-process.ts: "customProvider: agent NOT started
#     (fail-closed)"). Card 313c8a71 (MikroB decision on WhiteHat GO 28831 F1): restart-with-
#     nothing was the actual gap -- this agent now does not restart at all until the provider is
#     registered or removed from its config.
printf '{"customProvider": "definitely-not-a-registered-provider-fixture"}' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=refuse reason=provider-env-unavailable") pass "34: unregistered customProvider -> fail-closed REFUSE (no export, no restart)" ;;
  *) fail "34: unregistered customProvider -> fail-closed REFUSE (no export, no restart)" "$OUT" ;;
esac
rm -f "$AGENT_BYO/agent-config.json"

# 35) MUTATION PIN: needs-fleet-oauth.mjs still wins when the agent DOES need the fleet token but
#     the fleet token file/isolated config happen to be unusable (card af5bf43b's own class of
#     "needed but unusable" case, re-checked here so F4's new branch cannot be reached for an
#     agent that actually needs fleet oauth) -- a claude/shared agent with NO .claude-config dir
#     gets no export at all, not a provider env guess.
printf '{"model": "claude-sonnet-5", "authMode": "shared"}' > "$AGENT_PLAIN/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_PLAIN")"
case "$OUT" in
  isolation=no) pass "35: claude/shared agent with no .claude-config -> still no export (not F4's branch)" ;;
  *) fail "35: claude/shared agent with no .claude-config -> still no export (not F4's branch)" "$OUT" ;;
esac
rm -f "$AGENT_PLAIN/agent-config.json"

# --- card 313c8a71 F2/F3 (WhiteHat2, comment 28768): the mjs's fail-closed catch (exit 2) was
# never exercised by this suite, and nothing distinguished "undecidable" (dist/node missing) from
# the ordinary "not needed" case -- a restart silently stripped the fleet token from EVERY agent
# that needed it, with zero log trace. These pin both the fail-closed behavior itself and the new
# distinct log line. ---

printf '{"model": "claude-sonnet-5", "authMode": "shared"}' > "$AGENT_BYO/agent-config.json"

# 36) BLOCKING (F2 repro): needs-fleet-oauth.mjs's own project root has no dist/ -- the dynamic
#     import throws inside its try block, caught, exit 2. Must still be fail-closed, never a
#     guessed/fallback export, proving the catch is pinned, not just "whatever happens". Card
#     313c8a71 scope extension (MikroB msg_id:16938, explicit: do not decide this silently): an
#     undecidable fleet-oauth verdict now REFUSES the restart outright for THIS plain-claude agent
#     too, rather than falling through to the (here, unrelated and still-working) provider-env
#     branch and restarting it anyway without knowing if it needed the fleet token.
BROKEN_INSTALL="$TMP/broken-install"
mkdir -p "$BROKEN_INSTALL/scripts"
cp "$REPO_DIR/scripts/needs-fleet-oauth.mjs" "$BROKEN_INSTALL/scripts/needs-fleet-oauth.mjs"
# deliberately NO dist/ under $BROKEN_INSTALL -- projectRoot resolves to dirname(this script)/.. ,
# i.e. $BROKEN_INSTALL, which has no dist at all.
OUT="$(NEEDS_FLEET_OAUTH_MJS="$BROKEN_INSTALL/scripts/needs-fleet-oauth.mjs" bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=refuse reason=fleet-oauth-undecidable") pass "36: missing dist -> mjs exits 2, refuse (fleet-oauth undecidable)" ;;
  *) fail "36: missing dist -> mjs exits 2, refuse (fleet-oauth undecidable)" "$OUT" ;;
esac

# 37) F3: the SAME missing-dist restart must leave a named, grep-able UNDECIDABLE log line --
#     not silence. Driven through the actual restart-loop entrypoint would need a live tmux/API
#     fixture this suite does not have; agent_launch_env itself (called identically by both entry
#     points) already writes the line, so this checks the REAL log file the --launch-env run above
#     just wrote to.
if grep -q "UNDECIDABLE" "$FIXTURE_INSTALL/logs/watchdog.log" 2>/dev/null; then
  pass "37: missing dist -> UNDECIDABLE log line written (F3)"
else
  fail "37: missing dist -> UNDECIDABLE log line written (F3)" "$(cat "$FIXTURE_INSTALL/logs/watchdog.log" 2>/dev/null)"
fi

# 38) F3: NODE_BIN itself unavailable is the SAME "undecidable" bucket (rc=127), not silently
#     folded into "not needed" -- a fleet-oauth-needing agent restarted with no node on PATH used
#     to just lose its token with nothing logged. A bogus (non-empty) NODE_BIN is used rather than
#     an empty one: watchdog.sh's own `${NODE_BIN:-$(command -v node)}` fallback treats EMPTY the
#     same as UNSET and would silently rediscover the real node, defeating the point of this probe.
#     Node being unavailable makes the FLEET-OAUTH decision itself undecidable (reached first) --
#     refuses right there, same reason as case 36.
rm -f "$FIXTURE_INSTALL/logs/watchdog.log"
OUT="$(NODE_BIN="/nonexistent/no-such-node-binary-xyz" bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=refuse reason=fleet-oauth-undecidable") pass "38: node unavailable -> refuse (fleet-oauth undecidable)" ;;
  *) fail "38: node unavailable -> refuse (fleet-oauth undecidable)" "$OUT" ;;
esac
if grep -q "UNDECIDABLE" "$FIXTURE_INSTALL/logs/watchdog.log" 2>/dev/null; then
  pass "38: node unavailable -> UNDECIDABLE log line written (F3)"
else
  fail "38: node unavailable -> UNDECIDABLE log line written (F3)" "$(cat "$FIXTURE_INSTALL/logs/watchdog.log" 2>/dev/null)"
fi

# 39) MUTATION PIN: the ordinary "not needed" case (BYO model, real dist, real node) must NOT log
#     UNDECIDABLE -- a too-eager rewrite of the branch split must not treat every non-export as
#     undecidable.
rm -f "$FIXTURE_INSTALL/logs/watchdog.log"
printf '{"model": "deepseek-chat"}' > "$AGENT_BYO/agent-config.json"
bash "$WD" --launch-env "$AGENT_BYO" > /dev/null
if grep -q "UNDECIDABLE" "$FIXTURE_INSTALL/logs/watchdog.log" 2>/dev/null; then
  fail "39: ordinary not-needed case must NOT log UNDECIDABLE" "$(cat "$FIXTURE_INSTALL/logs/watchdog.log")"
else
  pass "39: ordinary not-needed case does not log UNDECIDABLE"
fi
rm -f "$AGENT_BYO/agent-config.json" "$FIXTURE_INSTALL/logs/watchdog.log"

# --- card 313c8a71 scope extension (MikroB decision on ac0bf02d's own WhiteHat GO 28831 F1/F2):
# "fails closed" in watchdog-provider-env.mjs used to mean "exports nothing", not "does not
# restart" -- a BYO agent whose provider env could not be built was restarted anyway, silently, on
# whatever default login the shared ~/.claude holds. These pin the dist-missing case for THIS
# script specifically (cases 24/31/34/38 above already pin the registered-provider and node-missing
# shapes via the real repo script). ---

# 40) BLOCKING: watchdog-provider-env.mjs's own project root has no dist/ -- same shape as case 36
#     for needs-fleet-oauth.mjs, but for the script this scope extension actually targets. A BYO
#     config (deepseek) is used so FLEET_OAUTH_NEEDED is false and this branch is reached at all.
BROKEN_PROVIDER_INSTALL="$TMP/broken-provider-install"
mkdir -p "$BROKEN_PROVIDER_INSTALL/scripts"
cp "$REPO_DIR/scripts/watchdog-provider-env.mjs" "$BROKEN_PROVIDER_INSTALL/scripts/watchdog-provider-env.mjs"
printf '{"model": "deepseek-chat"}' > "$AGENT_BYO/agent-config.json"
OUT="$(WATCHDOG_PROVIDER_ENV_MJS="$BROKEN_PROVIDER_INSTALL/scripts/watchdog-provider-env.mjs" bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=refuse reason=provider-env-unavailable") pass "40: watchdog-provider-env missing dist -> refuse (no export, no restart)" ;;
  *) fail "40: watchdog-provider-env missing dist -> refuse (no export, no restart)" "$OUT" ;;
esac

# 41) same run must leave a named, grep-able log line distinct from the fleet-oauth one (37/38).
if grep -q "watchdog-provider-env UNAVAILABLE" "$FIXTURE_INSTALL/logs/watchdog.log" 2>/dev/null; then
  pass "41: watchdog-provider-env missing dist -> named log line written"
else
  fail "41: watchdog-provider-env missing dist -> named log line written" "$(cat "$FIXTURE_INSTALL/logs/watchdog.log" 2>/dev/null)"
fi

# 42) MUTATION PIN: authMode own_team genuinely has NOTHING to export here (its credentials are
#     its own /login, exit 0 with empty output BY DESIGN) -- this must still restart normally
#     (isolation=no), never REFUSE, or a too-eager "any empty output is a failure" rewrite would
#     wrongly block every own_team agent from ever restarting.
rm -f "$FIXTURE_INSTALL/logs/watchdog.log"
printf '{"authMode": "own_team"}' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  isolation=no) pass "42: authMode own_team -> legitimate empty output still restarts normally (no refuse)" ;;
  *) fail "42: authMode own_team -> legitimate empty output still restarts normally (no refuse)" "$OUT" ;;
esac
rm -f "$AGENT_BYO/agent-config.json" "$FIXTURE_INSTALL/logs/watchdog.log"

# --- card 313c8a71, round 3 (WhiteHat2 CYBERSEC GO 28868 + QA2 FAIL 28874): F1 (dead alert, needs
# the main loop -- NOT testable via --launch-env, see watchdog-main-loop-alert.test.sh instead),
# F2 (a missing/syntax-broken needs-fleet-oauth.mjs collides with "not needed"), F3 (a present-
# but-corrupt agent-config.json restarted WITH the fleet token). These pin F2 and F3. ---

printf '{"model": "claude-sonnet-5", "authMode": "shared"}' > "$AGENT_BYO/agent-config.json"

# 43) BLOCKING (F2 repro): needs-fleet-oauth.mjs DELETED entirely (not just its dist) -- node's own
#     module loader fails with exit 1, the SAME code the script's real "not needed" decision uses.
#     Before this round, this silently restarted the agent WITHOUT the fleet token (identical to a
#     real BYO decision). Now: the missing stdout sentinel makes this undecidable -> refuse.
MISSING_MJS_INSTALL="$TMP/missing-mjs-install"
mkdir -p "$MISSING_MJS_INSTALL/scripts"
# deliberately do NOT create scripts/needs-fleet-oauth.mjs here
OUT="$(NEEDS_FLEET_OAUTH_MJS="$MISSING_MJS_INSTALL/scripts/needs-fleet-oauth.mjs" bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=refuse reason=fleet-oauth-undecidable") pass "43: needs-fleet-oauth.mjs missing entirely -> refuse (undecidable), not silent not-needed" ;;
  *) fail "43: needs-fleet-oauth.mjs missing entirely -> refuse (undecidable), not silent not-needed" "$OUT" ;;
esac

# 44) BLOCKING (F2 repro, the other half): a SYNTAX-BROKEN needs-fleet-oauth.mjs -- node's loader
#     fails before the script's own try/catch (and its stdout sentinel) ever runs. Same exit code
#     (1) as a real "not needed", same fix: the missing sentinel makes it undecidable -> refuse.
BROKEN_SYNTAX_INSTALL="$TMP/broken-syntax-install"
mkdir -p "$BROKEN_SYNTAX_INSTALL/scripts"
printf 'this is not valid node syntax ][[' > "$BROKEN_SYNTAX_INSTALL/scripts/needs-fleet-oauth.mjs"
OUT="$(NEEDS_FLEET_OAUTH_MJS="$BROKEN_SYNTAX_INSTALL/scripts/needs-fleet-oauth.mjs" bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=refuse reason=fleet-oauth-undecidable") pass "44: needs-fleet-oauth.mjs syntax-broken -> refuse (undecidable), not silent not-needed" ;;
  *) fail "44: needs-fleet-oauth.mjs syntax-broken -> refuse (undecidable), not silent not-needed" "$OUT" ;;
esac

# 45) MUTATION PIN: the REAL script, unmodified, on the SAME plain-claude fixture, still decides
#     normally (fleet-token export) -- cases 43/44 must not have broken the ordinary path.
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=yes prefix="*CLAUDE_CONFIG_DIR*CLAUDE_CODE_OAUTH_TOKEN*)
    pass "45: real needs-fleet-oauth.mjs, same fixture -> still a normal fleet-token decision" ;;
  *) fail "45: real needs-fleet-oauth.mjs, same fixture -> still a normal fleet-token decision" "$OUT" ;;
esac

# 46) BLOCKING (F3 repro, needs-fleet-oauth.mjs side): a PRESENT but non-JSON agent-config.json.
#     Before this round, readConfig's catch defaulted this to {} -- which resolves to the claude-
#     install default, so the agent restarted WITH the fleet token despite its config naming a
#     customProvider that never got read. Now: readConfig throws, exit 2, refuse.
printf 'this is not json at all' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=refuse reason=fleet-oauth-undecidable") pass "46: non-JSON agent-config.json -> refuse (undecidable), not a silent {} default" ;;
  *) fail "46: non-JSON agent-config.json -> refuse (undecidable), not a silent {} default" "$OUT" ;;
esac

# 47) F3 repro: a JSON ARRAY (valid JSON, wrong shape) -- same silent-{}-default bug, same fix.
printf '[1,2,3]' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=refuse reason=fleet-oauth-undecidable") pass "47: agent-config.json is a JSON array -> refuse (undecidable)" ;;
  *) fail "47: agent-config.json is a JSON array -> refuse (undecidable)" "$OUT" ;;
esac

# 48) F3 repro: a UTF-8 BOM prefix with a customProvider -- the exact shape WhiteHat2 named.
printf '\xef\xbb\xbf{"customProvider": "my-byo-endpoint"}' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=refuse reason=fleet-oauth-undecidable") pass "48: agent-config.json has a UTF-8 BOM -> refuse (undecidable)" ;;
  *) fail "48: agent-config.json has a UTF-8 BOM -> refuse (undecidable)" "$OUT" ;;
esac

# 49) F3 repro: TRUNCATED JSON (mid-write crash shape) with a customProvider.
printf '{"customProvider": "my-byo-endp' > "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=refuse reason=fleet-oauth-undecidable") pass "49: truncated agent-config.json -> refuse (undecidable)" ;;
  *) fail "49: truncated agent-config.json -> refuse (undecidable)" "$OUT" ;;
esac

# 50) MUTATION PIN: a genuinely MISSING agent-config.json (not present-but-corrupt) must still
#     default to {} and decide normally -- round 3's fix must not turn a legitimate "no config
#     yet" first-write state into a refusal.
rm -f "$AGENT_BYO/agent-config.json"
OUT="$(bash "$WD" --launch-env "$AGENT_BYO")"
case "$OUT" in
  "isolation=yes prefix="*CLAUDE_CONFIG_DIR*CLAUDE_CODE_OAUTH_TOKEN*)
    pass "50: no agent-config.json at all (missing, not corrupt) -> still a normal default decision" ;;
  *) fail "50: no agent-config.json at all (missing, not corrupt) -> still a normal default decision" "$OUT" ;;
esac

# 51) BLOCKING (F1 repro): the owner alert must actually fire on an undecidable fleet-oauth
#     verdict. --selftest-refuse-alert drives the EXACT case/alert logic the main restart loop
#     runs on $ISO_ENV (maybe_alert_for_refuse_reason), without needing a live tmux session, the
#     dashboard or any channel setup -- --launch-env alone cannot reach this code at all, which is
#     exactly how the dead-code bug went unnoticed through 51 passing cases.
printf '{"model": "claude-sonnet-5", "authMode": "shared"}' > "$AGENT_BYO/agent-config.json"
rm -f "$FIXTURE_INSTALL/store/.watchdog-fleet-oauth-undecidable-alert"
OUT="$(WATCHDOG_ALERT_DRYRUN=1 NEEDS_FLEET_OAUTH_MJS="$MISSING_MJS_INSTALL/scripts/needs-fleet-oauth.mjs" bash "$WD" --selftest-refuse-alert "$AGENT_BYO")"
case "$OUT" in
  *"ALERT_DRYRUN:"*"undecidable"*) pass "51: undecidable fleet-oauth verdict -> owner alert actually fires" ;;
  *) fail "51: undecidable fleet-oauth verdict -> owner alert actually fires" "$OUT" ;;
esac
case "$OUT" in
  *"refused reason=fleet-oauth-undecidable"*) pass "51: same run also reports the refuse reason" ;;
  *) fail "51: same run also reports the refuse reason" "$OUT" ;;
esac

# 52) MUTATION PIN: a REFUSE reason unrelated to the undecidable causes (oauthTokenFile's own
#     reasons, e.g. mode-not-0600) must NOT page the owner -- only fleet-oauth-undecidable and
#     provider-env-unavailable are alert-worthy.
AGENT_OWN_ALERT="$FIXTURE_INSTALL/agents/own-token-alert-agent"
mkdir -p "$AGENT_OWN_ALERT/.claude-config"
OWN_ALERT_TOKEN_FILE="$TMP/own-alert-agent.token"
printf '%s' "sk-ant-oat-fake" > "$OWN_ALERT_TOKEN_FILE"
chmod 644 "$OWN_ALERT_TOKEN_FILE" # wrong mode -> REFUSE:mode-not-0600, not an undecidable cause
printf '{"oauthTokenFile": "%s"}\n' "$OWN_ALERT_TOKEN_FILE" > "$AGENT_OWN_ALERT/agent-config.json"
rm -f "$FIXTURE_INSTALL/store/.watchdog-fleet-oauth-undecidable-alert"
OUT="$(WATCHDOG_ALERT_DRYRUN=1 bash "$WD" --selftest-refuse-alert "$AGENT_OWN_ALERT")"
case "$OUT" in
  *"ALERT_DRYRUN"*) fail "52: an unrelated REFUSE reason (mode-not-0600) must NOT alert the owner" "$OUT" ;;
  "refused reason=mode-not-0600") pass "52: an unrelated REFUSE reason (mode-not-0600) does not alert the owner" ;;
  *) fail "52: an unrelated REFUSE reason (mode-not-0600) does not alert the owner" "$OUT" ;;
esac
rm -f "$AGENT_BYO/agent-config.json" "$FIXTURE_INSTALL/store/.watchdog-fleet-oauth-undecidable-alert"

echo "watchdog-config-isolation: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

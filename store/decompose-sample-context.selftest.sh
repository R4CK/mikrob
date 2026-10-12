#!/usr/bin/env bash
# decompose-sample-context.selftest.sh -- unit tests for decompose-sample-context.sh/.py (card
# d39fc5e7, requirement 1). Builds a tiny throwaway fixture repo on disk (no network, no real
# marveen/mopsion checkout touched) and asserts the sample-finding behaviour for each of the four
# decompose types, plus the "no sample -> nothing, exit 1" miss path the dispatch wiring relies on
# to skip drafting entirely.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./decompose-sample-context.sh
. "$HERE/decompose-sample-context.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

PASS=0
FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    echo "FAIL: $desc"
    echo "  want: $want"
    echo "  got:  $got"
  fi
}

REPO="$TMPDIR/repo"
mkdir -p "$REPO/src"
git -C "$REPO" init -q 2>/dev/null
git -C "$REPO" config user.email "test@test" 2>/dev/null
git -C "$REPO" config user.name "Test" 2>/dev/null

# --- test-scaffold: a sibling *.test.ts exists next to the named file -------------------------
cat > "$REPO/src/parseWindow.ts" <<'EOF'
export function parseWindow() { return { start: 0, end: 24 } }
EOF
cat > "$REPO/src/parseWindow.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { parseWindow } from './parseWindow'
describe('parseWindow', () => {
  it('returns the default window', () => { expect(parseWindow()).toEqual({ start: 0, end: 24 }) })
})
EOF
git -C "$REPO" add . 2>/dev/null
git -C "$REPO" commit -qm "init" 2>/dev/null
out="$(decompose_sample_context test-scaffold "Write a unit test for src/parseWindow.ts covering the default branch." "$REPO")"
rc=$?
check "test-scaffold: found sibling test file" "$rc" "0"
check "test-scaffold: sample names the real sibling file" "$(printf '%s' "$out" | head -1)" "SAMPLE FILE (src/parseWindow.test.ts, real existing file from this repo -- match its style, do not invent a different framework/shape):"

# --- test-scaffold: no target file named at all -> NO-SAMPLE, exit 1 --------------------------
out2="$(decompose_sample_context test-scaffold "Write the unit test scaffolding this card names." "$REPO")"
rc2=$?
check "test-scaffold: no file token in the text -> no sample, empty stdout" "$out2" ""
check "test-scaffold: no file token in the text -> exit 1" "$rc2" "1"

# --- test-scaffold: file named but no sibling test anywhere -> NO-SAMPLE ----------------------
mkdir -p "$REPO/src/lonely"
cat > "$REPO/src/lonely/noTests.ts" <<'EOF'
export function noTests() { return true }
EOF
git -C "$REPO" add . 2>/dev/null && git -C "$REPO" commit -qm "add lonely" 2>/dev/null
out3="$(decompose_sample_context test-scaffold "Write a unit test for src/lonely/noTests.ts." "$REPO")"
rc3=$?
check "test-scaffold: target exists but has no test sibling -> no sample" "$out3" ""
check "test-scaffold: target exists but has no test sibling -> exit 1" "$rc3" "1"

# --- type-def: a sibling file in the same dir declares an interface ---------------------------
mkdir -p "$REPO/src/types"
cat > "$REPO/src/types/widget.ts" <<'EOF'
export interface Widget {
  id: string
  label: string
}
EOF
git -C "$REPO" add . 2>/dev/null && git -C "$REPO" commit -qm "add types" 2>/dev/null
out4="$(decompose_sample_context type-def "Draft the TypeScript type for src/types/widget.ts." "$REPO")"
rc4="$?"
check "type-def: found the file with an interface declaration" "$rc4" "0"
check "type-def: sample names the real file" "$(printf '%s' "$out4" | head -1)" "SAMPLE FILE (src/types/widget.ts, real existing file from this repo -- match its style, do not invent a different framework/shape):"

# --- i18n-keys: a locales/*.json sibling exists -------------------------------------------------
mkdir -p "$REPO/src/locales"
cat > "$REPO/src/locales/en.json" <<'EOF'
{"greeting": "Hello"}
EOF
git -C "$REPO" add . 2>/dev/null && git -C "$REPO" commit -qm "add locales" 2>/dev/null
out5="$(decompose_sample_context i18n-keys "Draft the i18n keys for src/locales/en.json." "$REPO")"
rc5="$?"
check "i18n-keys: found a locale json" "$rc5" "0"

# --- i18n-keys: nothing locale-shaped anywhere in the repo -> NO-SAMPLE ------------------------
EMPTYREPO="$TMPDIR/empty-repo"
mkdir -p "$EMPTYREPO"
git -C "$EMPTYREPO" init -q 2>/dev/null
git -C "$EMPTYREPO" config user.email "test@test" 2>/dev/null
git -C "$EMPTYREPO" config user.name "Test" 2>/dev/null
out6="$(decompose_sample_context i18n-keys "Draft the i18n keys this card names." "$EMPTYREPO")"
rc6="$?"
check "i18n-keys: empty repo -> no sample" "$out6" ""
check "i18n-keys: empty repo -> exit 1" "$rc6" "1"

# --- doc-update: README.md exists at repo root --------------------------------------------------
cat > "$REPO/README.md" <<'EOF'
# Repo

## Egyedi fork-fejlesztések (amiért külön fork)

- **Example feature**: does the example thing.
EOF
git -C "$REPO" add . 2>/dev/null && git -C "$REPO" commit -qm "add readme" 2>/dev/null
out7="$(decompose_sample_context doc-update "Draft the README fork-development entry for this card." "$REPO")"
rc7="$?"
check "doc-update: found README.md" "$rc7" "0"
check "doc-update: excerpt is scoped to the fork-fejlesztesek section" "$(printf '%s' "$out7" | grep -c 'Example feature')" "1"

# --- doc-update: no README at all -> NO-SAMPLE ---------------------------------------------------
out8="$(decompose_sample_context doc-update "Draft the README entry." "$EMPTYREPO")"
rc8="$?"
check "doc-update: no README -> no sample" "$out8" ""
check "doc-update: no README -> exit 1" "$rc8" "1"

# --- unknown repo path -> NO-SAMPLE, no crash -----------------------------------------------------
out9="$(decompose_sample_context test-scaffold "Write a unit test for src/parseWindow.ts." "/no/such/repo")"
rc9="$?"
check "unreadable repo -> no sample, no crash" "$out9" ""
check "unreadable repo -> exit 1" "$rc9" "1"

# --- MUTATION: prefer a path-shaped token over a bare word (a real path beats a prose word) -----
mkdir -p "$REPO/src/other"
cat > "$REPO/src/other/parseWindow.test.ts" <<'EOF'
import { describe } from 'vitest'
describe('decoy', () => {})
EOF
git -C "$REPO" add "$REPO/src/other/parseWindow.test.ts" 2>/dev/null || true
out10="$(decompose_sample_context test-scaffold "config.json describes src/parseWindow.ts, write its test." "$REPO")"
rc10="$?"
check "mutation: a path-shaped token (src/parseWindow.ts) wins over a bare-named file (config.json)" "$rc10" "0"
check "mutation: the ORIGINAL parseWindow.test.ts is picked, not the decoy under src/other" "$(printf '%s' "$out10" | head -1)" "SAMPLE FILE (src/parseWindow.test.ts, real existing file from this repo -- match its style, do not invent a different framework/shape):"

# =============================================================================
# SECURITY TESTS (B1 fix, card d39fc5e7 WhiteHat re-gate)
# These tests all call the Python script directly so they exercise _safe_path,
# _is_tracked, and _strip_secret_lines.
# Convention: _red tests verify the BROKEN path returns nothing/exit-1 before
# the fix; since the fix is already applied they are written as "should block".
# =============================================================================

SECREPO="$TMPDIR/secrepo"
mkdir -p "$SECREPO/src" "$SECREPO/locales"
git -C "$SECREPO" init -q 2>/dev/null
git -C "$SECREPO" config user.email "test@test" 2>/dev/null
git -C "$SECREPO" config user.name "Test" 2>/dev/null

cat > "$SECREPO/src/util.ts" <<'EOF'
export function hello() { return "hi" }
EOF
cat > "$SECREPO/src/util.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { hello } from './util'
describe('hello', () => { it('returns hi', () => { expect(hello()).toBe("hi") }) })
EOF
cat > "$SECREPO/locales/en.json" <<'EOF'
{ "greeting": "Hello" }
EOF
cat > "$SECREPO/README.md" <<'EOF'
# Sec Repo
## Egyedi fork-fejlesztések (amiért külön fork)
- **SecTest**: test fixture.
EOF
git -C "$SECREPO" add . 2>/dev/null
git -C "$SECREPO" commit -qm "init" 2>/dev/null

# B1.1: path traversal via ../../ in the card text should NOT resolve outside the repo
OUTSIDE="$TMPDIR/outside.ts"
echo "export const SUPER_SECRET = 'abc'" > "$OUTSIDE"
out_b1_traversal="$(echo '{"type":"test-scaffold","text":"see ../../outside.ts","repo":"'"$SECREPO"'"}' \
  | python3 "$HERE/decompose-sample-context.py")"
rc_b1_traversal=$?
check "B1.1: path traversal (../../outside.ts) -> no sample" "$out_b1_traversal" ""
check "B1.1: path traversal -> exit 1" "$rc_b1_traversal" "1"

# B1.2: dotfile (.secrets.json) in locales should NOT be returned by i18n-keys finder
cat > "$SECREPO/locales/.secrets.json" <<'EOF'
{ "apiKey": "super-secret-value-that-should-never-reach-llm" }
EOF
out_b1_dotfile="$(echo '{"type":"i18n-keys","text":"add i18n key","repo":"'"$SECREPO"'"}' \
  | python3 "$HERE/decompose-sample-context.py")"
check "B1.2: dotfile (.secrets.json) is never returned as i18n sample" \
  "$(printf '%s' "$out_b1_dotfile" | grep -c 'secrets.json')" "0"
# and the legitimate en.json IS found
check "B1.2: non-dotfile en.json IS returned" \
  "$(printf '%s' "$out_b1_dotfile" | grep -c 'en.json')" "1"

# B1.3: symlink pointing outside the repo should NOT be followed
SYMLINK_TARGET="$TMPDIR/outside_cred.ts"
echo "const dbPassword = 'hunter2_real_secret_value'" > "$SYMLINK_TARGET"
ln -sf "$SYMLINK_TARGET" "$SECREPO/src/cred_link.ts" 2>/dev/null
git -C "$SECREPO" add "$SECREPO/src/cred_link.ts" 2>/dev/null
git -C "$SECREPO" commit -qm "add symlink" 2>/dev/null || true
out_b1_symlink="$(echo '{"type":"test-scaffold","text":"write test for src/cred_link.ts","repo":"'"$SECREPO"'"}' \
  | python3 "$HERE/decompose-sample-context.py")"
check "B1.3: symlink escaping repo -> no sample" "$out_b1_symlink" ""

# B1.4: untracked file should NOT be returned even if it exists on disk
cat > "$SECREPO/src/untracked_secret.ts" <<'EOF'
export const internalToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.untracked_secret"
EOF
out_b1_untracked="$(echo '{"type":"test-scaffold","text":"write test for src/untracked_secret.ts","repo":"'"$SECREPO"'"}' \
  | python3 "$HERE/decompose-sample-context.py")"
check "B1.4: untracked file -> no sample" "$out_b1_untracked" ""

# F2: secret-shaped content in a tracked file should be stripped from the excerpt.
# Three fixture shapes: JS assignment, JSON key-value, and a comment with a key=value.
# The test searches for the FIXTURE VALUE itself (not 'sk-proj' which was never present),
# so it goes red when the filter is removed -- mutation-testable (B3 fix, card d39fc5e7).
cat > "$SECREPO/src/config.ts" <<'EOF'
export const APP_NAME = "MyApp"
const apiKey = "zzzfixture-not-a-real-key-value-xxxxxxxxxxxxxxxx"
export const VERSION = "1.0.0"
export type AppConfig = { name: string; version: string }
EOF
cat > "$SECREPO/src/config.json" <<'EOF'
{
  "appName": "MyApp",
  "apiKey": "zzzfixture-json-key-value-xxxxxxxxxxxxxxxxxxxxxxxx",
  "version": "1.0.0"
}
EOF
git -C "$SECREPO" add "$SECREPO/src/config.ts" "$SECREPO/src/config.json" 2>/dev/null
git -C "$SECREPO" commit -qm "add config with secret" 2>/dev/null
out_f2="$(echo '{"type":"type-def","text":"add type for src/config.ts","repo":"'"$SECREPO"'"}' \
  | python3 "$HERE/decompose-sample-context.py")"
# The fixture VALUES must not appear in the excerpt (the filter must have removed the lines)
check "F2: JS assignment secret-shaped line is stripped from excerpt" \
  "$(printf '%s' "$out_f2" | grep -c 'zzzfixture-not-a-real-key-value-xxxxxxxxxxxxxxxx')" "0"
check "F2: non-secret lines survive in excerpt" \
  "$(printf '%s' "$out_f2" | grep -c 'APP_NAME')" "1"
# JSON-alak: the i18n-keys finder returns .json files
out_f2_json="$(echo '{"type":"i18n-keys","text":"update i18n keys in src/config.json","repo":"'"$SECREPO"'"}' \
  | python3 "$HERE/decompose-sample-context.py")"
check "F2: JSON-form key: value secret-shaped line is stripped from excerpt" \
  "$(printf '%s' "$out_f2_json" | grep -c 'zzzfixture-json-key-value-xxxxxxxxxxxxxxxxxxxxxxxx')" "0"
check "F2: non-secret JSON key survives (appName is not a secret shape)" \
  "$(printf '%s' "$out_f2_json" | grep -c 'appName')" "1"

# Mutation-pin for B1.2: if we re-enable dotfiles the test must go red
# (verified by inspection: without the "if f.startswith('.'): continue" guard,
# .secrets.json would appear first in sorted() and grep would return 1, not 0)

echo
echo "decompose-sample-context.selftest: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]

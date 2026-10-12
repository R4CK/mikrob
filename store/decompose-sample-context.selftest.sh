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
out4="$(decompose_sample_context type-def "Draft the TypeScript type for src/types/widget.ts." "$REPO")"
rc4="$?"
check "type-def: found the file with an interface declaration" "$rc4" "0"
check "type-def: sample names the real file" "$(printf '%s' "$out4" | head -1)" "SAMPLE FILE (src/types/widget.ts, real existing file from this repo -- match its style, do not invent a different framework/shape):"

# --- i18n-keys: a locales/*.json sibling exists -------------------------------------------------
mkdir -p "$REPO/src/locales"
cat > "$REPO/src/locales/en.json" <<'EOF'
{"greeting": "Hello"}
EOF
out5="$(decompose_sample_context i18n-keys "Draft the i18n keys for src/locales/en.json." "$REPO")"
rc5="$?"
check "i18n-keys: found a locale json" "$rc5" "0"

# --- i18n-keys: nothing locale-shaped anywhere in the repo -> NO-SAMPLE ------------------------
EMPTYREPO="$TMPDIR/empty-repo"
mkdir -p "$EMPTYREPO"
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
out10="$(decompose_sample_context test-scaffold "config.json describes src/parseWindow.ts, write its test." "$REPO")"
rc10="$?"
check "mutation: a path-shaped token (src/parseWindow.ts) wins over a bare-named file (config.json)" "$rc10" "0"
check "mutation: the ORIGINAL parseWindow.test.ts is picked, not the decoy under src/other" "$(printf '%s' "$out10" | head -1)" "SAMPLE FILE (src/parseWindow.test.ts, real existing file from this repo -- match its style, do not invent a different framework/shape):"

echo
echo "decompose-sample-context.selftest: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]

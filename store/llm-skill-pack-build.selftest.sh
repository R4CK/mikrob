#!/usr/bin/env bash
# llm-skill-pack-build.selftest.sh -- proves:
#  1) --check passes against the live packs (built from the live map)
#  2) editing a source file and rebuilding changes the pack sha (card 2746165b Kesz-ha #3)
#  3) a source path outside the allowed roots is refused (QA FAIL 31746, M1/path-containment)
#  4) a secret-shaped string in a source is refused, nothing written (QA FAIL 31746, M2/secret-scan)
#  5) a markdown link's URL is stripped, its anchor text kept (card 2746165b delta: a source's
#     attribution link's numeric tweet ID matched freellm-call.sh's PII cc_number pattern live)
# Uses a throwaway temp map + temp skill copy -- never touches the real ~/.claude/skills tree.
# LLM_SKILL_PACK_EXTRA_ROOT lets this fixture's temp dir pass containment without touching the
# real global skills dir; no production call site ever sets that env var.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BUILD_PY="$ROOT/store/llm-skill-pack-build.py"

fail() { echo "SELFTEST FAIL: $1" >&2; exit 1; }

echo "[1/5] --check against the live map/packs"
python3 -I "$BUILD_PY" --check || fail "live --check did not pass (run the build first)"
echo "  ok"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
export LLM_SKILL_PACK_EXTRA_ROOT="$TMP_DIR"

echo "[2/5] edit-and-rebuild changes the pack sha"

TMP_SKILL="$TMP_DIR/FAKE_SKILL.md"
cat > "$TMP_SKILL" <<'EOF'
---
name: fake-skill
description: selftest fixture
---
# Fake Skill

## Pitfalls
- version one of the pitfall text
EOF

TMP_MAP="$TMP_DIR/map.json"
python3 -I - "$TMP_SKILL" "$TMP_MAP" <<'PY'
import json, sys
skill_path, map_path = sys.argv[1], sys.argv[2]
cfg = {
    "token_cap": 1500,
    "chars_per_token": 4,
    "rule_keywords": ["core principle"],
    "pitfall_keywords": ["pitfall"],
    "types": {
        "fake-type": {"sources": [{"path": skill_path, "mode": "sections"}]}
    },
}
with open(map_path, "w") as f:
    json.dump(cfg, f)
PY

OUT_DIR="$TMP_DIR/packs"
python3 -I "$BUILD_PY" --map "$TMP_MAP" --out-dir "$OUT_DIR" > "$TMP_DIR/build1.log"
SHA1="$(grep -o 'pack=fake-type@[0-9a-f]*' "$TMP_DIR/build1.log" | cut -d@ -f2)"
[ -n "$SHA1" ] || fail "no sha parsed from first build"

# edit the source
sed -i 's/version one/version two/' "$TMP_SKILL"

python3 -I "$BUILD_PY" --map "$TMP_MAP" --out-dir "$OUT_DIR" > "$TMP_DIR/build2.log"
SHA2="$(grep -o 'pack=fake-type@[0-9a-f]*' "$TMP_DIR/build2.log" | cut -d@ -f2)"
[ -n "$SHA2" ] || fail "no sha parsed from second build"

[ "$SHA1" != "$SHA2" ] || fail "sha did not change after editing the source skill ($SHA1 == $SHA2)"
echo "  ok (sha $SHA1 -> $SHA2)"

echo "[3/5] a source path outside every allowed root is refused"
OUTSIDE_FILE="/tmp/llm-skill-pack-selftest-outside-$$.txt"
echo "should never be read" > "$OUTSIDE_FILE"
trap 'rm -f "$OUTSIDE_FILE"; rm -rf "$TMP_DIR"' EXIT
ESCAPE_MAP="$TMP_DIR/escape-map.json"
python3 -I - "$OUTSIDE_FILE" "$ESCAPE_MAP" <<'PY'
import json, sys
outside_path, map_path = sys.argv[1], sys.argv[2]
cfg = {
    "token_cap": 1500, "chars_per_token": 4,
    "rule_keywords": ["x"], "pitfall_keywords": ["x"],
    "types": {"escape-type": {"sources": [{"path": outside_path, "mode": "all"}]}},
}
json.dump(cfg, open(map_path, "w"))
PY
ESCAPE_OUT="$TMP_DIR/escape-out"
if python3 -I "$BUILD_PY" --map "$ESCAPE_MAP" --out-dir "$ESCAPE_OUT" > "$TMP_DIR/escape.log" 2>"$TMP_DIR/escape.err"; then
  fail "build of an out-of-root source path succeeded (should have been refused, exit 3)"
fi
grep -q "outside every allowed root" "$TMP_DIR/escape.err" || fail "refusal message did not name the containment check"
[ ! -e "$ESCAPE_OUT/escape-type.txt" ] || fail "a pack file was written despite the refusal"
echo "  ok (refused, no pack file written)"

echo "[4/5] a secret-shaped string in a source is refused, nothing written"
# Built by concatenation, not as a literal in this file, so a static secret-shape scan of THIS
# script does not flag its own test fixture -- it is still a real AWS-access-key-id SHAPE once
# assembled, which is exactly what the build script's own scan below must catch.
FAKE_AWS_KEY="AKIA$(printf 'ABCDEFGHIJKLMNOP')"
SECRET_SKILL="$TMP_DIR/secret-fixture.md"
{
  echo "# Secret Fixture"
  echo
  echo "## Pitfalls"
  echo "- reminder: $FAKE_AWS_KEY looks like a real AWS access key id shape"
} > "$SECRET_SKILL"
SECRET_MAP="$TMP_DIR/secret-map.json"
python3 -I - "$SECRET_SKILL" "$SECRET_MAP" <<'PY'
import json, sys
skill_path, map_path = sys.argv[1], sys.argv[2]
cfg = {
    "token_cap": 1500, "chars_per_token": 4,
    "rule_keywords": ["x"], "pitfall_keywords": ["pitfall"],
    "types": {"secret-type": {"sources": [{"path": skill_path, "mode": "sections"}]}},
}
json.dump(cfg, open(map_path, "w"))
PY
SECRET_OUT="$TMP_DIR/secret-out"
if python3 -I "$BUILD_PY" --map "$SECRET_MAP" --out-dir "$SECRET_OUT" > "$TMP_DIR/secret.log" 2>"$TMP_DIR/secret.err"; then
  fail "build of a secret-shaped source succeeded (should have been refused, exit 3)"
fi
grep -q "matched secret pattern" "$TMP_DIR/secret.err" || fail "refusal message did not name the secret-pattern check"
[ ! -e "$SECRET_OUT/secret-type.txt" ] || fail "a pack file was written despite the secret match"
echo "  ok (refused, no pack file written)"

echo "[5/5] a markdown link's URL is stripped, its anchor text kept"
LINK_SKILL="$TMP_DIR/link-fixture.md"
cat > "$LINK_SKILL" <<'EOF'
---
name: link-fixture
description: selftest fixture
---
# Link Fixture

## Pitfalls
- derived from [an attribution link](https://x.com/someone/status/2015883857489522876) text
EOF
LINK_MAP="$TMP_DIR/link-map.json"
python3 -I - "$LINK_SKILL" "$LINK_MAP" <<'PY'
import json, sys
skill_path, map_path = sys.argv[1], sys.argv[2]
cfg = {
    "token_cap": 1500, "chars_per_token": 4,
    "rule_keywords": ["x"], "pitfall_keywords": ["pitfall"],
    "types": {"link-type": {"sources": [{"path": skill_path, "mode": "sections"}]}},
}
json.dump(cfg, open(map_path, "w"))
PY
LINK_OUT="$TMP_DIR/link-out"
python3 -I "$BUILD_PY" --map "$LINK_MAP" --out-dir "$LINK_OUT" > "$TMP_DIR/link.log" || fail "build of a markdown-link source was refused unexpectedly"
grep -q "an attribution link" "$LINK_OUT/link-type.txt" || fail "anchor text was not kept"
grep -q "x.com" "$LINK_OUT/link-type.txt" && fail "the link URL was not stripped"
echo "  ok (anchor kept, URL stripped)"

echo "SELFTEST OK"

#!/usr/bin/env bash
# llm-skill-pack-build.selftest.sh -- proves:
#  1) --check passes against the live packs (built from the live map)
#  2) editing a source file and rebuilding changes the pack sha (card 2746165b Kesz-ha #3)
# Uses a throwaway temp map + temp skill copy -- never touches the real ~/.claude/skills tree.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BUILD_PY="$ROOT/store/llm-skill-pack-build.py"

fail() { echo "SELFTEST FAIL: $1" >&2; exit 1; }

echo "[1/2] --check against the live map/packs"
python3 -I "$BUILD_PY" --check || fail "live --check did not pass (run the build first)"
echo "  ok"

echo "[2/2] edit-and-rebuild changes the pack sha"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

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

echo "SELFTEST OK"

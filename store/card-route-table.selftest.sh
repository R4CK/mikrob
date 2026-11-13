#!/usr/bin/env bash
# card-route-table.selftest.sh -- selftest for card-route-table.sh (card cdde2666).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/card-route-table.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

pass=0
fail=0
check() { # $1 = label, $2 = expected, $3 = actual
  if [[ "$2" == "$3" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1 -- expected [$2] got [$3]"
  fi
}

# 1. Known type returns its own chain.
cat > "$TMPDIR/table.json" <<'JSON'
{"default": ["freellm", "local", "online"], "types": {"test-scaffold": ["local", "online"]}}
JSON
out="$(CARD_ROUTE_TABLE_FILE="$TMPDIR/table.json" bash "$SCRIPT" --type test-scaffold)"
check "known type uses its own chain" "local,online" "$out"

# 2. Unknown type falls back to "default".
out="$(CARD_ROUTE_TABLE_FILE="$TMPDIR/table.json" bash "$SCRIPT" --type unknown-type)"
check "unknown type falls back to default" "freellm,local,online" "$out"

# 3. Missing file falls back to the hardcoded fallback chain.
out="$(CARD_ROUTE_TABLE_FILE="$TMPDIR/does-not-exist.json" bash "$SCRIPT" --type test-scaffold)"
check "missing file falls back" "freellm,local,online" "$out"

# 4. Malformed JSON falls back, does not error.
printf 'not json at all' > "$TMPDIR/bad.json"
out="$(CARD_ROUTE_TABLE_FILE="$TMPDIR/bad.json" bash "$SCRIPT" --type test-scaffold)"
rc=$?
check "malformed JSON falls back" "freellm,local,online" "$out"
check "malformed JSON exits 0" "0" "$rc"

# 5. "default" present but not a list -> hardcoded fallback.
cat > "$TMPDIR/bad-default.json" <<'JSON'
{"default": "not-a-list", "types": {}}
JSON
out="$(CARD_ROUTE_TABLE_FILE="$TMPDIR/bad-default.json" bash "$SCRIPT" --type test-scaffold)"
check "non-list default falls back" "freellm,local,online" "$out"

# 6. No --type argument -> usage error, exit 2.
bash "$SCRIPT" >/dev/null 2>&1
check "missing --type exits 2" "2" "$?"

# 7. The real shipped table answers all 4 fragment types with the verdict's named chain order.
for t in test-scaffold i18n-keys doc-update type-def; do
  out="$(bash "$SCRIPT" --type "$t")"
  check "shipped table: $t" "freellm,local,online" "$out"
done

echo "card-route-table.selftest: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]

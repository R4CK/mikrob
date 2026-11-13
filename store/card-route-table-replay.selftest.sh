#!/usr/bin/env bash
# card-route-table-replay.selftest.sh -- selftest for card-route-table-replay.sh (card cdde2666).
# Uses CARD_ROUTE_REPLAY_CARD_JSON_CMD to stub the dashboard fetch: no live API, no network.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/card-route-table-replay.sh"
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

# Stub fetcher: prints canned card JSON for a handful of ids. Mirrors the real
# /api/kanban/<id> response shape (id/title/description/labels), nothing more.
cat > "$TMPDIR/fake-fetch.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  a1b2c3d4)  printf '{"id":"a1b2c3d4","title":"billing cleanup","description":"stripe checkout webhook fix","labels":[]}' ;;
  c1ea2000)  printf '{"id":"c1ea2000","title":"readme typo fix","description":"fix a typo in the readme","labels":[]}' ;;
  7a99e100) printf '{"id":"7a99e100","title":"neutral title","description":"neutral text","labels":[{"name":"@sec"}]}' ;;
  f00dfeed)   printf '' ;;
  *)          printf '' ;;
esac
EOF
chmod +x "$TMPDIR/fake-fetch.sh"

# Case 1: no log file at all -- nothing to replay, exit 0, no violations.
rm -f "$TMPDIR/nope.log"
out="$(CARD_ROUTE_REPLAY_CARD_JSON_CMD="$TMPDIR/fake-fetch.sh" bash "$SCRIPT" "$TMPDIR/nope.log" 2>&1)"; rc=$?
check "missing log: exits 0" "0" "$rc"

# Case 2: a sensitive-reason line whose card is genuinely sensitive by content -- no violation.
cat > "$TMPDIR/log1.log" <<'EOF'
2026-11-13 00:00:00	a1b2c3d4	ONLINE	deterministic-money	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(CARD_ROUTE_REPLAY_CARD_JSON_CMD="$TMPDIR/fake-fetch.sh" bash "$SCRIPT" "$TMPDIR/log1.log" 2>&1)"; rc=$?
check "genuinely sensitive card: exit 0 (no violation)" "0" "$rc"
check "genuinely sensitive card: checked=1 violations=0" "1" "$(printf '%s\n' "$out" | grep -oP 'checked=\K[0-9]+')"
check "genuinely sensitive card: violations=0 reported" "0" "$(printf '%s\n' "$out" | grep -oP 'violations=\K[0-9]+')"

# Case 3: a sensitive-reason line whose card text is CLEAN by content -- a real violation
# (exactly the gap this check exists to catch).
cat > "$TMPDIR/log2.log" <<'EOF'
2026-11-13 00:00:00	c1ea2000	ONLINE	deterministic-sec-label	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(CARD_ROUTE_REPLAY_CARD_JSON_CMD="$TMPDIR/fake-fetch.sh" bash "$SCRIPT" "$TMPDIR/log2.log" 2>&1)"; rc=$?
check "content-clean card flagged sensitive by card-build-route: exit 1 (violation)" "1" "$rc"
check "content-clean card: 1 violation reported" "1" "$(printf '%s\n' "$out" | grep -oP 'violations=\K[0-9]+')"

# Case 4: a sensitive-reason line whose card is clean in title/desc but carries a sensitive
# LABEL -- gemini-agy-category-check.py's label check must also be exercised, no violation.
cat > "$TMPDIR/log3.log" <<'EOF'
2026-11-13 00:00:00	7a99e100	ONLINE	deterministic-auth-tenant-scope	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(CARD_ROUTE_REPLAY_CARD_JSON_CMD="$TMPDIR/fake-fetch.sh" bash "$SCRIPT" "$TMPDIR/log3.log" 2>&1)"; rc=$?
check "sensitive-tagged card (clean prose): exit 0 (label check catches it, no violation)" "0" "$rc"

# Case 5: a NON-sensitive-reason line (e.g. deterministic-multi-decision -- a difficulty signal,
# not a content-sensitivity one) is excluded entirely -- checked stays 0.
cat > "$TMPDIR/log4.log" <<'EOF'
2026-11-13 00:00:00	a1b2c3d4	ONLINE	deterministic-multi-decision	calls=0	chars=40	dispatcher=-	decompose=-
2026-11-13 00:00:00	a1b2c3d4	ONLINE	vram-hold	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(CARD_ROUTE_REPLAY_CARD_JSON_CMD="$TMPDIR/fake-fetch.sh" bash "$SCRIPT" "$TMPDIR/log4.log" 2>&1)"; rc=$?
check "difficulty/capacity reasons excluded: checked=0" "0" "$(printf '%s\n' "$out" | grep -oP 'checked=\K[0-9]+')"
check "difficulty/capacity reasons excluded: exit 0" "0" "$rc"

# Case 6: duplicate card ids across multiple sensitive lines are deduplicated (checked once).
cat > "$TMPDIR/log5.log" <<'EOF'
2026-11-13 00:00:00	a1b2c3d4	ONLINE	deterministic-money	calls=0	chars=40	dispatcher=-	decompose=-
2026-11-13 00:01:00	a1b2c3d4	ONLINE	deterministic-sec-label	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(CARD_ROUTE_REPLAY_CARD_JSON_CMD="$TMPDIR/fake-fetch.sh" bash "$SCRIPT" "$TMPDIR/log5.log" 2>&1)"
check "duplicate card id across lines: checked=1 (deduped)" "1" "$(printf '%s\n' "$out" | grep -oP 'checked=\K[0-9]+')"

# Case 7: an unreadable card (empty fetch result) is skipped, not counted as checked or a
# violation -- "cannot fetch" must never silently pass as "clean", but it also must not be
# reported as a false violation when the card simply no longer exists.
cat > "$TMPDIR/log6.log" <<'EOF'
2026-11-13 00:00:00	f00dfeed	ONLINE	deterministic-money	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(CARD_ROUTE_REPLAY_CARD_JSON_CMD="$TMPDIR/fake-fetch.sh" bash "$SCRIPT" "$TMPDIR/log6.log" 2>&1)"; rc=$?
check "unreadable card: skipped, not checked, no violation, exit 0" "0 1 0" \
  "$(printf '%s\n' "$out" | grep -oP 'checked=\K[0-9]+') $(printf '%s\n' "$out" | grep -oP 'skipped=\K[0-9]+') $rc"

echo
echo "card-route-table-replay.selftest: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]

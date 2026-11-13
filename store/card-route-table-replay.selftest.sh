#!/usr/bin/env bash
# card-route-table-replay.selftest.sh -- selftest for card-route-table-replay.sh (card cdde2666).
# Uses CARD_ROUTE_REPLAY_CARD_JSON_CMD / CARD_ROUTE_REPLAY_CARD_LABELS_CMD to stub the dashboard
# fetch: no live API, no network, no token needed. The CHECKER is the REAL offload-dispatch.sh in
# this directory (--check-freellm-blocked is a pure text/tag classifier, no network call of its
# own -- the same production entry point --test-capacity-route already uses for gate parity), so
# these cases exercise the real gate decision, not a reimplementation of it.
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

# Stub card fetcher. Every card carries project=mikrob (the real gate's project allowlist, card
# ALLOWED_PROJECTS={"mikrob"} -- without it everything is blocked regardless of content, which
# would make the violation case below untestable).
cat > "$TMPDIR/fake-fetch.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  a1b2c3d4) printf '{"id":"a1b2c3d4","project":"mikrob","title":"billing cleanup","description":"stripe checkout webhook fix"}' ;;
  c1ea2000) printf '{"id":"c1ea2000","project":"mikrob","title":"readme typo fix","description":"fix a typo in the readme"}' ;;
  7a99e100) printf '{"id":"7a99e100","project":"mikrob","title":"neutral title","description":"neutral text"}' ;;
  beef4011)  printf 'HTTP_401' ;;
  f00dfeed) printf 'HTTP_404' ;;
  *)        printf '' ;;
esac
EOF
chmod +x "$TMPDIR/fake-fetch.sh"

# Stub labels fetcher: only 7a99e100 (sensitive tag) and cafe0001 (positive-marker card) carry a
# label; everything else has none.
cat > "$TMPDIR/fake-labels.sh" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  7a99e100)  printf '[{"name":"@sec"}]' ;;
  cafe0001) printf '[{"name":"@gemini-ok"}]' ;;
  *)         printf '[]' ;;
esac
EOF
chmod +x "$TMPDIR/fake-labels.sh"

# cafe0001's card JSON (clean content, needs the gemini-ok label from fake-labels.sh above to
# ever reach ALLOWED_RC -- see the marker-gate note in the "violation" case below).
sed -i '/\*)        printf/i\  cafe0001) printf '"'"'{"id":"cafe0001","project":"mikrob","title":"readme typo fix","description":"fix a typo in the readme"}'"'"' ;;' "$TMPDIR/fake-fetch.sh"

run() { # $1 = log file path
  CARD_ROUTE_REPLAY_CARD_JSON_CMD="$TMPDIR/fake-fetch.sh" \
  CARD_ROUTE_REPLAY_CARD_LABELS_CMD="$TMPDIR/fake-labels.sh" \
  bash "$SCRIPT" "$1" 2>&1
}

# Case 1: no log file at all -- nothing to replay, exit 0.
rm -f "$TMPDIR/nope.log"
out="$(run "$TMPDIR/nope.log")"; rc=$?
check "missing log: exits 0" "0" "$rc"

# Case 2: a sensitive-reason line whose card is genuinely sensitive by content (SENS_RE "billing")
# -- the real gate blocks it, no violation.
cat > "$TMPDIR/log1.log" <<'EOF'
2026-11-13 00:00:00	a1b2c3d4	ONLINE	deterministic-money	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(run "$TMPDIR/log1.log")"; rc=$?
check "genuinely sensitive card: exit 0 (no violation)" "0" "$rc"
check "genuinely sensitive card: checked=1" "1" "$(printf '%s\n' "$out" | grep -oP 'checked=\K[0-9]+')"
check "genuinely sensitive card: violations=0" "0" "$(printf '%s\n' "$out" | grep -oP 'violations=\K[0-9]+')"

# Case 3: a card the real gate ALLOWS (clean content + the gemini-ok marker the gate's own
# require_marker check demands by default) but card-build-route.sh logged as sensitive -- a real
# violation, exactly the gap this check exists to catch.
cat > "$TMPDIR/log2.log" <<'EOF'
2026-11-13 00:00:00	cafe0001	ONLINE	deterministic-sec-label	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(run "$TMPDIR/log2.log")"; rc=$?
check "content-clean+marked card flagged sensitive by card-build-route: exit 1 (violation)" "1" "$rc"
check "content-clean+marked card: 1 violation" "1" "$(printf '%s\n' "$out" | grep -oP 'violations=\K[0-9]+')"

# Case 3b: the SAME clean content WITHOUT the gemini-ok marker is blocked by the gate's own
# default-deny marker requirement -- no violation. Proves the marker gate is live in this replay,
# not bypassed.
cat > "$TMPDIR/log2b.log" <<'EOF'
2026-11-13 00:00:00	c1ea2000	ONLINE	deterministic-sec-label	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(run "$TMPDIR/log2b.log")"; rc=$?
check "content-clean card WITHOUT marker: exit 0 (blocked by default-deny, no violation)" "0" "$rc"

# Case 4: a sensitive-reason line whose card is clean in title/desc but carries a sensitive LABEL
# (exact BLOCKED_TAGS entry "sec") -- the tag check also blocks it, no violation.
cat > "$TMPDIR/log3.log" <<'EOF'
2026-11-13 00:00:00	7a99e100	ONLINE	deterministic-auth-tenant-scope	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(run "$TMPDIR/log3.log")"; rc=$?
check "sensitive-tagged card (clean prose): exit 0 (tag check catches it, no violation)" "0" "$rc"

# Case 5: a NON-sensitive-reason line (e.g. deterministic-multi-decision -- a difficulty signal,
# not a content-sensitivity one) is excluded entirely -- checked stays 0.
cat > "$TMPDIR/log4.log" <<'EOF'
2026-11-13 00:00:00	a1b2c3d4	ONLINE	deterministic-multi-decision	calls=0	chars=40	dispatcher=-	decompose=-
2026-11-13 00:00:00	a1b2c3d4	ONLINE	vram-hold	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(run "$TMPDIR/log4.log")"; rc=$?
check "difficulty/capacity reasons excluded: checked=0" "0" "$(printf '%s\n' "$out" | grep -oP 'checked=\K[0-9]+')"
check "difficulty/capacity reasons excluded: exit 0" "0" "$rc"

# Case 6: duplicate card ids across multiple sensitive lines are deduplicated (checked once).
cat > "$TMPDIR/log5.log" <<'EOF'
2026-11-13 00:00:00	a1b2c3d4	ONLINE	deterministic-money	calls=0	chars=40	dispatcher=-	decompose=-
2026-11-13 00:01:00	a1b2c3d4	ONLINE	deterministic-sec-label	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(run "$TMPDIR/log5.log")"
check "duplicate card id across lines: checked=1 (deduped)" "1" "$(printf '%s\n' "$out" | grep -oP 'checked=\K[0-9]+')"

# Case 7 (behaviour CHANGED from the pre-fix version, Cybered 29789 F-A / Cybersec 29776 F-B): an
# unreadable card (404) is skipped, not counted as checked or a violation, but now a skip is no
# longer silently swallowed into exit 0 -- it forces the run non-zero, because "could not verify"
# must never look identical to "verified, clean" on the exit code.
cat > "$TMPDIR/log6.log" <<'EOF'
2026-11-13 00:00:00	f00dfeed	ONLINE	deterministic-money	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(run "$TMPDIR/log6.log")"; rc=$?
check "unreadable (404) card: skipped, not checked, no violation, exit 1" "0 1 0 1" \
  "$(printf '%s\n' "$out" | grep -oP 'checked=\K[0-9]+') $(printf '%s\n' "$out" | grep -oP 'skipped=\K[0-9]+') $(printf '%s\n' "$out" | grep -oP 'violations=\K[0-9]+') $rc"

# Case 8 (the exact bug Cybered 29789 F-A and Cybersec 29776 F-B reproduced): a 401 Unauthorized
# fetch must be counted as an ERROR and force a non-zero exit, never as a silently-passing "checked".
cat > "$TMPDIR/log7.log" <<'EOF'
2026-11-13 00:00:00	beef4011	ONLINE	deterministic-money	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(run "$TMPDIR/log7.log")"; rc=$?
check "401 fetch: not counted as checked" "0" "$(printf '%s\n' "$out" | grep -oP 'checked=\K[0-9]+')"
check "401 fetch: counted as an error" "1" "$(printf '%s\n' "$out" | grep -oP 'errors=\K[0-9]+')"
check "401 fetch: exit 1 (never a silent pass)" "1" "$rc"

# Case 9: a missing checker script is a hard, immediate failure, before any card is fetched.
cat > "$TMPDIR/log8.log" <<'EOF'
2026-11-13 00:00:00	a1b2c3d4	ONLINE	deterministic-money	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(CARD_ROUTE_REPLAY_CARD_JSON_CMD="$TMPDIR/fake-fetch.sh" \
       CARD_ROUTE_REPLAY_CARD_LABELS_CMD="$TMPDIR/fake-labels.sh" \
       CARD_ROUTE_REPLAY_CHECKER="$TMPDIR/does-not-exist.sh" \
       bash "$SCRIPT" "$TMPDIR/log8.log" 2>&1)"; rc=$?
check "missing checker: exit 1" "1" "$rc"

# Case 10: no token file and no CARD_JSON_CMD override (the live, authenticated path) -- a run
# with nothing to authenticate with must refuse to start, not silently fetch nothing and report
# zero violations (the exact shape of the original bug: no store/.dashboard-token next to a
# detached worktree copy of this script).
cat > "$TMPDIR/log9.log" <<'EOF'
2026-11-13 00:00:00	a1b2c3d4	ONLINE	deterministic-money	calls=0	chars=40	dispatcher=-	decompose=-
EOF
out="$(CARD_ROUTE_REPLAY_TOKEN_FILE="$TMPDIR/no-such-token" bash "$SCRIPT" "$TMPDIR/log9.log" 2>&1)"; rc=$?
check "no token file, live path: exit 1 (FATAL, refuses to run unauthenticated)" "1" "$rc"

echo
echo "card-route-table-replay.selftest: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]

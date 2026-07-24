#!/bin/bash
# Contract tests for token-health-guard.sh (card RELIA-B). Hermetic: a stub `curl`
# on PATH records its argv + stdin and returns canned getMe responses, so nothing
# touches the network or the real host. CYBERSEC-CRITICAL: proves the bot token
# NEVER reaches curl's argv / the logs / the status file (only the stdin config).
# Run: bash scripts/__tests__/token-health-guard.test.sh
set -u

GUARD="$(cd "$(dirname "$0")/.." && pwd)/token-health-guard.sh"
SECRET='SEKRIT-123456:ABCdef_ghIJK'   # fake but Telegram-token-shaped

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

setup() {
  WORK="$(mktemp -d)"
  STORE="$WORK/store"; mkdir -p "$STORE"
  ENVF="$WORK/telegram.env"; printf 'TELEGRAM_BOT_TOKEN="%s"\n' "$SECRET" >"$ENVF"
  BIN="$WORK/bin"; mkdir -p "$BIN"
  ARGV_LOG="$WORK/curl-argv.log"; STDIN_LOG="$WORK/curl-stdin.log"; SEND_FLAG="$WORK/sendmsg.flag"
  cat >"$BIN/curl" <<'STUB'
#!/bin/bash
# stub curl: record argv + stdin, accept sendMessage, emit canned getMe.
printf '%s\n' "$*" >>"$STUB_ARGV_LOG"
cfg="$(cat)"
printf '%s\n' "$cfg" >>"$STUB_STDIN_LOG"
if grep -q 'sendMessage' <<<"$cfg"; then : >"$STUB_SEND_FLAG"; exit 0; fi
case "${STUB_GETME_MODE:-ok}" in
  ok)      printf '{"ok":true,"result":{"id":1,"username":"bot"}}\n200\n' ;;
  invalid) printf '{"ok":false,"error_code":401,"description":"Unauthorized"}\n401\n' ;;
  error)   exit 1 ;;
esac
STUB
  chmod +x "$BIN/curl"
}
teardown() { rm -rf "$WORK"; }
run_guard() {
  local mode="${1:-ok}"
  PATH="$BIN:$PATH" MARVEEN_STORE="$STORE" TELEGRAM_ENV="$ENVF" \
    MARVEEN_ALERT_CHAT_ID="42" TOKEN_HEALTH_COOLDOWN="${2:-3600}" \
    STUB_ARGV_LOG="$ARGV_LOG" STUB_STDIN_LOG="$STDIN_LOG" STUB_SEND_FLAG="$SEND_FLAG" \
    STUB_GETME_MODE="$mode" bash "$GUARD" 2>&1
}

# 1. healthy token
setup; out="$(run_guard ok)"
grep -q '^OK ' "$STORE/.token-health-status" && pass "valid: status OK" || fail "valid: status not OK"
grep -qi 'healthy' <<<"$out" && pass "valid: logs healthy" || fail "valid: no healthy log"
[ ! -f "$SEND_FLAG" ] && pass "valid: no alert sent" || fail "valid: unexpected alert"
teardown

# 2. revoked/invalid token
setup; out="$(run_guard invalid)"
grep -q '^INVALID ' "$STORE/.token-health-status" && pass "invalid: status INVALID" || fail "invalid: status not INVALID"
[ -f "$SEND_FLAG" ] && pass "invalid: alert sent" || fail "invalid: no alert"
grep -q 'sendMessage' "$STDIN_LOG" && pass "invalid: sendMessage URL via stdin config" || fail "invalid: no sendMessage config"
teardown

# 3. transient network error -> no false alarm
setup; out="$(run_guard error)"
grep -q '^ERROR ' "$STORE/.token-health-status" && pass "error: status ERROR" || fail "error: status not ERROR"
[ ! -f "$SEND_FLAG" ] && pass "error: no alert on transient" || fail "error: unexpected alert"
teardown

# 4. NO-LEAK (Cybersec-critical): token never in log / status / curl argv
setup; out="$(run_guard invalid)"
grep -q "$SECRET" <<<"$out"                    && fail "no-leak: token in LOG"       || pass "no-leak: token NOT in log"
grep -q "$SECRET" "$STORE/.token-health-status" && fail "no-leak: token in STATUS"    || pass "no-leak: token NOT in status"
grep -q "$SECRET" "$ARGV_LOG"                  && fail "no-leak: token in curl ARGV"  || pass "no-leak: token NOT in curl argv"
# sanity: the token DID reach curl via the stdin config (proves the probe ran, off-argv)
grep -q "$SECRET" "$STDIN_LOG"                 && pass "no-leak: token only via stdin config" || fail "no-leak: token never sent (probe broken?)"
teardown

# 5. dedup: a second invalid within the cooldown does not re-alert
setup
run_guard invalid >/dev/null
rm -f "$SEND_FLAG"
run_guard invalid >/dev/null
[ ! -f "$SEND_FLAG" ] && pass "dedup: second invalid suppressed (cooldown)" || fail "dedup: alert repeated within cooldown"
teardown

echo "----"
echo "token-health-guard: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]

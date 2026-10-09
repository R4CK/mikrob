#!/bin/bash
# Dedicated behavioural tests for scripts/lib/owner-chat.sh's resolve_owner_chat_id.
#
# Card a55315be, QA FAIL (comment 13699) on WhiteHat L1 (comment 13668, originally raised
# against 3026a591): the access.json fallback carries THREE anti-leak properties, but only one
# (2+ DM entries -> refuse) was pinned by a test (scripts/__tests__/limit-monitor-signals.test.sh
# "(f) CHATID0"). The other two -- a sub-agent's inherited <PROVIDER>_STATE_DIR is ignored, and a
# group/channel-only allowFrom never resolves -- held true in the CODE but a mutation that broke
# either one left every existing test green (QA's own measurement). resolve_owner_chat_id now has
# TWO consumers (notify.sh, limit-monitor.sh): this file tests the shared resolver directly, once,
# so both consumers are covered by the same guard instead of duplicating it per caller.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../lib/owner-chat.sh
. "$HERE/../lib/owner-chat.sh"
BASE="$(mktemp -d)"
trap 'rm -rf "$BASE"' EXIT
FAILED=0
pass(){ echo "  PASS  $*"; }
fail(){ echo "  FAIL  $*"; FAILED=1; }

# A main install: $1/.env (ALLOWED_CHAT_ID=0, the placeholder) and the
# install-scoped channel state dir at $1/.claude/channels/telegram/.
new_install() {
  local d="$BASE/$1"
  mkdir -p "$d/.claude/channels/telegram"
  printf 'ALLOWED_CHAT_ID=0\n' > "$d/.env"
  printf 'TELEGRAM_BOT_TOKEN=unused\n' > "$d/.claude/channels/telegram/.env"
  echo "$d"
}

echo "(a) baseline control: a single DM entry in the MAIN install resolves"
MAIN="$(new_install main_ctrl)"
printf '{"allowFrom":["111111"]}\n' > "$MAIN/.claude/channels/telegram/access.json"
out="$(resolve_owner_chat_id "$MAIN/.env" telegram 2>/dev/null)"
if [ "$out" = "111111" ]; then pass "resolves the main install's single DM entry"
else fail "expected 111111, got: $out"; fi

echo "(b) M2: an inherited TELEGRAM_STATE_DIR pointing elsewhere must NOT be honoured"
MAIN="$(new_install main_statedir)"
printf '{"allowFrom":["111111"]}\n' > "$MAIN/.claude/channels/telegram/access.json"
OTHER="$BASE/other_agent_channel"
mkdir -p "$OTHER"
printf '{"allowFrom":["222222"]}\n' > "$OTHER/access.json"
out="$(env TELEGRAM_STATE_DIR="$OTHER" bash -c '. "'"$HERE"'/../lib/owner-chat.sh"; resolve_owner_chat_id "'"$MAIN"'/.env" telegram' 2>/dev/null)"
if [ "$out" = "111111" ]; then
  pass "resolves the MAIN install's entry (111111), ignoring TELEGRAM_STATE_DIR's 222222"
else
  fail "TELEGRAM_STATE_DIR leaked into the resolution -- expected 111111, got: $out"
fi

echo "(c) M4: a group/channel-only allowFrom (\"-\"-prefixed id) never resolves"
MAIN="$(new_install main_grouponly)"
printf '{"allowFrom":["-1001234567890"]}\n' > "$MAIN/.claude/channels/telegram/access.json"
out="$(resolve_owner_chat_id "$MAIN/.env" telegram 2>"$BASE/grouponly.err")"
status=$?
if [ -z "$out" ] && [ "$status" != 0 ]; then
  pass "a group-only access.json does not resolve (empty stdout, non-zero exit)"
else
  fail "a group id was used as the owner chat -- stdout: '$out' status: $status"
fi
if grep -q "no DM entry" "$BASE/grouponly.err" 2>/dev/null; then
  pass "and the reason names the actual cause (no DM entry)"
else
  fail "expected a 'no DM entry' reason, got: $(cat "$BASE/grouponly.err" 2>/dev/null)"
fi

echo "(d) CONTROL: a group entry ALONGSIDE one real DM entry still resolves to the DM, never the group"
MAIN="$(new_install main_mixed)"
printf '{"allowFrom":["-1009999999","333333"]}\n' > "$MAIN/.claude/channels/telegram/access.json"
out="$(resolve_owner_chat_id "$MAIN/.env" telegram 2>/dev/null)"
if [ "$out" = "333333" ]; then
  pass "resolves the single real DM entry, the group entry is not counted as usable"
else
  fail "expected 333333, got: $out"
fi

echo ""
if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$FAILED"

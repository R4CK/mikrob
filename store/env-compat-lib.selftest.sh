#!/usr/bin/env bash
# Selftest for store/env-compat-lib.sh (card 22835648, Rename 1/3).
# Run: bash store/env-compat-lib.selftest.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./env-compat-lib.sh
. "$HERE/env-compat-lib.sh"

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

unset MY_NEW_VAR MY_OLD_VAR 2>/dev/null

# 1) new name wins, even with the old also set.
MY_NEW_VAR="new-value"
MY_OLD_VAR="old-value"
out="$(env_compat_get MY_NEW_VAR MY_OLD_VAR default)"
[ "$out" = "new-value" ] && pass "new var wins over old" || fail "new var wins over old" "$out"

# 2) only the old is set -> its value is used, and a warning is printed to stderr.
unset MY_NEW_VAR
out="$(env_compat_get MY_NEW_VAR MY_OLD_VAR default 2>/dev/null)"
[ "$out" = "old-value" ] && pass "old var used when new is unset" || fail "old var used when new is unset" "$out"
warn="$(env_compat_get MY_NEW_VAR MY_OLD_VAR default 2>&1 1>/dev/null)"
case "$warn" in
  *"MY_OLD_VAR is deprecated"*) pass "a warning line names the deprecated var" ;;
  *) fail "a warning line names the deprecated var" "$warn" ;;
esac

# 3) the warning fires on EVERY call that falls back -- no cross-call de-dup (see this file's own
#    header for why: de-dup would need state that survives this function's own subshell-per-call
#    command-substitution calling shape, which a normal one-call-per-variable script never needs).
w1="$(env_compat_get MY_NEW_VAR MY_OLD_VAR default 2>&1 1>/dev/null)"
w2="$(env_compat_get MY_NEW_VAR MY_OLD_VAR default 2>&1 1>/dev/null)"
if [ -n "$w1" ] && [ -n "$w2" ]; then
  pass "the warning fires on every fallback call (no silent cross-call de-dup)"
else
  fail "the warning fires on every fallback call (no silent cross-call de-dup)" "w1=[$w1] w2=[$w2]"
fi

# 4) neither set -> the given default.
unset MY_NEW_VAR MY_OLD_VAR
out="$(env_compat_get MY_NEW_VAR MY_OLD_VAR default)"
[ "$out" = "default" ] && pass "default used when neither is set" || fail "default used when neither is set" "$out"

# 5) neither set, no default given -> empty string, not an error (set -u safe).
out="$(env_compat_get MY_NEW_VAR MY_OLD_VAR)"
[ "$out" = "" ] && pass "empty string when neither is set and no default given" || fail "empty string when neither is set and no default given" "$out"

# 6) empty-string new var (set but blank) is treated as UNSET, falls through to old/default --
#    same convention as every other ${VAR:-...} read in this codebase (card bc32d233's own
#    "UNSET never means empty string" note is about a DIFFERENT sentinel; here blank genuinely
#    means "nothing configured", matching how an empty env var behaves everywhere else).
MY_NEW_VAR=""
MY_OLD_VAR="old-value"
out="$(env_compat_get MY_NEW_VAR MY_OLD_VAR default)"
[ "$out" = "old-value" ] && pass "an empty (blank) new var falls through to old, same as unset" || fail "an empty (blank) new var falls through to old, same as unset" "$out"
unset MY_NEW_VAR MY_OLD_VAR

echo
if [ "$FAIL" -eq 0 ]; then
  echo "env-compat-lib selftest: all $PASS cases pass."
  exit 0
else
  echo "env-compat-lib selftest: $PASS passed, $FAIL FAILED."
  exit 1
fi

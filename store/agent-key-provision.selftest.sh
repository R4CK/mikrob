#!/usr/bin/env bash
# Regression test for store/agent-key-provision.sh.
#
# Card 9655494c F1-B1 (RedHat NO-GO 17005, MikroB decision 17006): the script no longer talks HTTP
# at all -- it delegates to the local `dashboard-user` CLI (`npm run --prefix <main> dashboard-user
# -- agent-key:mint/:revoke`), which writes straight to the database. The whole login/cookie/
# scratch-dir class of risk the OLD selftest covered (F1-B2: a scratch dir leaking credentials on
# an error exit; F1-B3: curl/python3 argv/env leaks) no longer applies, because there is no login
# step and no HTTP payload left to leak -- this file replaces those cases with the ones that are
# now actually reachable: the invocation shape sent to `npm`, the key file's content/mode, and
# fail-closed behavior (no partial key file) when the CLI call itself fails.
set -euo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SELF_DIR/agent-key-provision.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; FAIL=1; }

AGENTS_ROOT="$WORK/agents"
MAIN_DIR="$WORK/main"
mkdir -p "$AGENTS_ROOT/backend" "$MAIN_DIR/.git"
CAPTURE_ARGV="$WORK/npm-argv.log"
NPM_EXIT_FILE="$WORK/npm-exit"
NPM_STDOUT_FILE="$WORK/npm-stdout"
: > "$CAPTURE_ARGV"
echo 0 > "$NPM_EXIT_FILE"
echo "mocked-raw-key-value" > "$NPM_STDOUT_FILE"

SHIM_DIR="$WORK/shim"
mkdir -p "$SHIM_DIR"
# The shim stands in for `npm`: it logs its full argv (so the test can assert the exact
# subcommand/flags the script sent), then exits with the configured code and stdout -- it never
# touches a real database, so this is a pure contract test on agent-key-provision.sh itself.
cat > "$SHIM_DIR/npm" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
{ printf 'ARGV:'; printf ' %q' "$@"; printf '\n'; } >> "__CAPTURE_ARGV__"
cat "__NPM_STDOUT_FILE__"
exit "$(cat "__NPM_EXIT_FILE__")"
SHIM
sed -i "s#__CAPTURE_ARGV__#$CAPTURE_ARGV#; s#__NPM_STDOUT_FILE__#$NPM_STDOUT_FILE#; s#__NPM_EXIT_FILE__#$NPM_EXIT_FILE#" "$SHIM_DIR/npm"
chmod +x "$SHIM_DIR/npm"

run() {
  : > "$CAPTURE_ARGV"
  echo 0 > "$NPM_EXIT_FILE"
  PATH="$SHIM_DIR:$PATH" MARVEEN_MAIN="$MAIN_DIR" MARVEEN_AGENTS_ROOT="$AGENTS_ROOT" \
    bash "$SCRIPT" "$@"
}

# --- mint: happy path ---
echo "mint-secret-abc" > "$NPM_STDOUT_FILE"
OUT="$(run backend)"
echo "$OUT" | grep -q "minted agent:backend" && pass "mint: success message printed" || fail "mint: success message missing"
[ "$(cat "$AGENTS_ROOT/backend/.dashboard-agent-key")" = "mint-secret-abc" ] && pass "mint: key file holds exactly the CLI's stdout" || fail "mint: key file content wrong"
[ "$(stat -c '%a' "$AGENTS_ROOT/backend/.dashboard-agent-key")" = "600" ] && pass "mint: key file is 0600" || fail "mint: key file mode wrong"
grep -q "agent-key:mint backend\$" "$CAPTURE_ARGV" && pass "mint: invoked agent-key:mint with no --rotate" || fail "mint: wrong invocation shape"
echo "$OUT" | grep -q "mint-secret-abc" && fail "mint: the raw key leaked into this script's own stdout" || pass "mint: the raw key never reaches this script's own stdout"

# --- mint --rotate: flag forwarded ---
echo "rotated-secret-def" > "$NPM_STDOUT_FILE"
run backend --rotate > /dev/null
grep -q "agent-key:mint backend --rotate\$" "$CAPTURE_ARGV" && pass "rotate: --rotate flag forwarded to the CLI" || fail "rotate: flag not forwarded"
[ "$(cat "$AGENTS_ROOT/backend/.dashboard-agent-key")" = "rotated-secret-def" ] && pass "rotate: key file updated to the new key" || fail "rotate: key file not updated"

# --- revoke: happy path ---
run backend --revoke > /dev/null
grep -q "agent-key:revoke backend\$" "$CAPTURE_ARGV" && pass "revoke: invoked agent-key:revoke" || fail "revoke: wrong invocation"
[ ! -e "$AGENTS_ROOT/backend/.dashboard-agent-key" ] && pass "revoke: local key file removed" || fail "revoke: local key file still present"

# --- fail-closed: CLI mint failure leaves no key file ---
rm -f "$AGENTS_ROOT/backend/.dashboard-agent-key"
echo 1 > "$NPM_EXIT_FILE"
echo "" > "$NPM_STDOUT_FILE"
if PATH="$SHIM_DIR:$PATH" MARVEEN_MAIN="$MAIN_DIR" MARVEEN_AGENTS_ROOT="$AGENTS_ROOT" \
    bash "$SCRIPT" backend > /dev/null 2>&1; then
  fail "mint-failure: script exited 0 despite the CLI failing"
else
  pass "mint-failure: script exits non-zero when the CLI call fails"
fi
[ ! -e "$AGENTS_ROOT/backend/.dashboard-agent-key" ] && pass "mint-failure: no key file created on failure" || fail "mint-failure: a key file was created despite the CLI failing"

# --- fail-closed: CLI revoke failure (exit code surfaces, no crash) ---
echo 1 > "$NPM_EXIT_FILE"
if PATH="$SHIM_DIR:$PATH" MARVEEN_MAIN="$MAIN_DIR" MARVEEN_AGENTS_ROOT="$AGENTS_ROOT" \
    bash "$SCRIPT" backend --revoke > /dev/null 2>&1; then
  fail "revoke-failure: script exited 0 despite the CLI failing"
else
  pass "revoke-failure: script exits non-zero when the CLI call fails"
fi
echo 0 > "$NPM_EXIT_FILE"

# --- validation: bad agent id, missing agent dir, unknown flag, missing MARVEEN_MAIN ---
if PATH="$SHIM_DIR:$PATH" MARVEEN_MAIN="$MAIN_DIR" MARVEEN_AGENTS_ROOT="$AGENTS_ROOT" \
    bash "$SCRIPT" "Not_Valid" > /dev/null 2>&1; then
  fail "validation: an invalid agent id was accepted"
else
  pass "validation: an invalid agent id is rejected"
fi

if PATH="$SHIM_DIR:$PATH" MARVEEN_MAIN="$MAIN_DIR" MARVEEN_AGENTS_ROOT="$AGENTS_ROOT" \
    bash "$SCRIPT" "no-such-agent-xyz" > /dev/null 2>&1; then
  fail "validation: a nonexistent agent directory was accepted"
else
  pass "validation: a nonexistent agent directory is rejected"
fi

if PATH="$SHIM_DIR:$PATH" MARVEEN_MAIN="$MAIN_DIR" MARVEEN_AGENTS_ROOT="$AGENTS_ROOT" \
    bash "$SCRIPT" backend --nope > /dev/null 2>&1; then
  fail "validation: an unknown flag was accepted"
else
  pass "validation: an unknown flag is rejected"
fi

if PATH="$SHIM_DIR:$PATH" MARVEEN_MAIN="$WORK/no-such-main-dir" MARVEEN_AGENTS_ROOT="$AGENTS_ROOT" \
    bash "$SCRIPT" backend > /dev/null 2>&1; then
  fail "validation: a nonexistent MARVEEN_MAIN was accepted"
else
  pass "validation: a nonexistent MARVEEN_MAIN is rejected"
fi

# --- N1 (prior review's gap): nothing anywhere ever writes the raw key except the final key
# file -- no copy in this script's own stdout/stderr across the whole happy-path run.
echo "canary-secret-ghi" > "$NPM_STDOUT_FILE"
FULL_OUT="$(PATH="$SHIM_DIR:$PATH" MARVEEN_MAIN="$MAIN_DIR" MARVEEN_AGENTS_ROOT="$AGENTS_ROOT" bash "$SCRIPT" backend 2>&1)"
if echo "$FULL_OUT" | grep -q "canary-secret-ghi"; then
  fail "N1: the raw key appeared in the script's combined stdout+stderr"
else
  pass "N1: the raw key never appears in the script's combined stdout+stderr"
fi

[ "$FAIL" -eq 0 ] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }

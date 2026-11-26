#!/usr/bin/env bash
# Round 3 of card 0aba66b8 (MikroB msg 25287, following CYBERSEC NO-GO 8c291307 F-3): a per-call-
# site pin against the "header-drop mutant" -- code that KEEPS the stdin/process-substitution
# SHAPE (so it looks fixed, and store/token-header-no-tempfile-scan.py's static shape-scan sees
# nothing wrong) but silently stops actually sending the real credential. F-3 measured this: two
# of the converted scripts' OWN existing selftests (fleet-concurrency-checks.selftest.sh,
# mopsion-preland.selftest.sh) still pass under a dropped header, because they assert on behaviour/
# output, never on what curl's -H argument actually carried.
#
# The companion gap F-3 also names -- a full-file REVERT back to the old mktemp-without-trap
# pattern -- is NOT this file's job: store/token-header-no-tempfile-scan.py (case 4 of
# token-header-no-tempfile.selftest.sh) already catches that structurally for every file under
# store/ and scripts/, because a revert reintroduces the exact shape that scan flags. Verified by
# planting a reverted copy of a converted file into a scratch dir and confirming the scan flags it
# (see that selftest's own case 4 and its mutation control).
#
# Mechanism: `curl` is overridden to a shell FUNCTION for the duration of each site's real,
# sed-extracted source. The override never makes a network call -- it just looks at every `@...`
# argument (covers `-H @-` stdin, `-H @<(...)` process substitution, since bash has already
# resolved the substitution to a real /dev/fd path by the time curl sees it, and `-H @/some/file`)
# and copies whatever is readable there into a capture file. The test then asserts the real fake
# credential string landed in that capture file. A function-call override cannot intercept a
# command that execs `curl` directly without going through this shell's function table -- that is
# why the local-llm.sh gateway site (its curl call is wrapped in `flock ... curl ...`, and flock
# execs its argument, bypassing shell functions entirely) is NOT covered here and is called out as
# a stated gap instead of a silently-skipped one.
set -uo pipefail

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SELF_DIR/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
SITES_RUN=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; FAIL=1; }

# run_capture CAPTURE_FILE BODY -- runs BODY in a subshell with curl() overridden as above,
# writing whatever reached any "@..." curl argument into CAPTURE_FILE. No command substitution
# here on purpose: capture_for used to be invoked as `x="$(capture_for ...)"`, which forks a
# subshell for the WHOLE function and silently discarded this function's SITES_RUN increment
# back when that counter lived in here (caught the first time this ran: "sites checked: 0").
run_capture() {
  local capture="$1" body="$2"
  : > "$capture"
  (
    curl() {
      local args=("$@") i=0 a p
      while [ "$i" -lt "${#args[@]}" ]; do
        a="${args[$i]}"
        case "$a" in
          @-) cat >> "$capture" 2>/dev/null ;;
          @*) p="${a#@}"; [ -r "$p" ] && cat "$p" >> "$capture" 2>/dev/null ;;
        esac
        i=$((i + 1))
      done
      echo 200
      return 0
    }
    eval "$body"
  ) >/dev/null 2>&1
}

# check_site NAME BODY NEEDLE -- PASSes iff NEEDLE appears verbatim in whatever reached curl.
check_site() {
  local name="$1" body="$2" needle="$3"
  SITES_RUN=$((SITES_RUN + 1))
  local capture="$WORK/capture.$SITES_RUN"
  run_capture "$capture" "$body"
  if grep -qF "$needle" "$capture" 2>/dev/null; then
    pass "$name: credential reaches curl"
  else
    fail "$name: credential did NOT reach curl (a header-drop mutant would survive here)"
  fi
}

# --- Mutation control: proves the mechanism actually detects a dropped header ------------------
# (deliberately NOT via check_site: a "found" result here would be the bug, so the pass/fail sense
# is inverted and kept out of the per-site helper above).
SITES_RUN=$((SITES_RUN + 1))
CONTROL_CAPTURE="$WORK/capture.$SITES_RUN"
run_capture "$CONTROL_CAPTURE" 'curl -s -H @- "http://127.0.0.1:9/x" </dev/null'
if grep -qF "Authorization: Bearer" "$CONTROL_CAPTURE" 2>/dev/null; then
  fail "control: a curl call with an empty stdin header still produced a captured Authorization line -- the detection mechanism itself is broken"
else
  pass "control: dropping the header (empty stdin, same -H @- shape) leaves nothing in the capture -- the mechanism actually detects a drop"
fi

# --- Original 11 call sites (card 0aba66b8 round 1) ----------------------------------------------
check_site "fleet-concurrency-checks.sh _curl_get" "
TOKEN_FILE=\"$WORK/tok-fcc\"; printf '%s' 'FCCFAKE1' > \"\$TOKEN_FILE\"
DASH=\"http://127.0.0.1:9\"
$(sed -n '/^_curl_get() {/,/^}/p' "$REPO_ROOT/store/fleet-concurrency-checks.sh")
_curl_get /x
" "Authorization: Bearer FCCFAKE1"

check_site "gate-dispatch-check.sh _curl_get" "
TOKEN_FILE=\"$WORK/tok-gdc\"; printf '%s' 'GDCFAKE1' > \"\$TOKEN_FILE\"
DASH=\"http://127.0.0.1:9\"
$(sed -n '/^_curl_get() {/,/^}/p' "$REPO_ROOT/store/gate-dispatch-check.sh")
_curl_get /x
" "Authorization: Bearer GDCFAKE1"

check_site "redispatch-guard.sh _curl_get" "
TOKEN_FILE=\"$WORK/tok-rg1\"; printf '%s' 'RGFAKE1' > \"\$TOKEN_FILE\"
DASH=\"http://127.0.0.1:9\"
$(sed -n '/^_curl_get() {/,/^}/p' "$REPO_ROOT/store/redispatch-guard.sh")
_curl_get /x
" "Authorization: Bearer RGFAKE1"

check_site "redispatch-guard.sh _record_incident" "
TOKEN_FILE=\"$WORK/tok-rg2\"; printf '%s' 'RGFAKE2' > \"\$TOKEN_FILE\"
DASH=\"http://127.0.0.1:9\"
REDISPATCH_GUARD_LOG=1
$(sed -n '/^now_ts() {/,/^}/p' "$REPO_ROOT/store/redispatch-guard.sh")
$(sed -n '96,127p' "$REPO_ROOT/store/redispatch-guard.sh")
_record_incident C1 agent1 ALLOW 0
" "Authorization: Bearer RGFAKE2"

check_site "redispatch-guard.sh _record_sibling_handover" "
TOKEN_FILE=\"$WORK/tok-rg3\"; printf '%s' 'RGFAKE3' > \"\$TOKEN_FILE\"
DASH=\"http://127.0.0.1:9\"
REDISPATCH_GUARD_LOG=1
$(sed -n '/^now_ts() {/,/^}/p' "$REPO_ROOT/store/redispatch-guard.sh")
$(sed -n '137,159p' "$REPO_ROOT/store/redispatch-guard.sh")
_record_sibling_handover C1 agent1 agent2 0
" "Authorization: Bearer RGFAKE3"

check_site "gemini-agy-call.sh card-content fetch" "
DASHBOARD_TOKEN_FILE=\"$WORK/tok-ga1\"; printf '%s' 'GAFAKE1' > \"\$DASHBOARD_TOKEN_FILE\"
DASHBOARD_URL=\"http://127.0.0.1:9\"
kartya=C1
$(sed -n '130,133p' "$REPO_ROOT/store/gemini-agy-call.sh")
" "Authorization: Bearer GAFAKE1"

check_site "gemini-agy-call.sh daily-log notify" "
DASHBOARD_TOKEN_FILE=\"$WORK/tok-ga2\"; printf '%s' 'GAFAKE2' > \"\$DASHBOARD_TOKEN_FILE\"
DASHBOARD_URL=\"http://127.0.0.1:9\"
hivo=agent1 kartya=C1 MODEL=m feladattipus=t sent_count=0 HOURLY_LIMIT=10 rc=0 t0=0 t1=0
call_status=ok duration_s=0.1
$(sed -n '250,261p' "$REPO_ROOT/store/gemini-agy-call.sh")
" "Authorization: Bearer GAFAKE2"

check_site "mopsion-preland.sh pending_all GET" "
TOKEN_FILE=\"$WORK/tok-mp1\"; printf '%s' 'MPFAKE1' > \"\$TOKEN_FILE\"
API=\"http://127.0.0.1:9\"
$(sed -n '144,146p' "$REPO_ROOT/store/mopsion-preland.sh")
" "Authorization: Bearer MPFAKE1"

check_site "mopsion-preland.sh per-card comments GET" "
TOKEN_FILE=\"$WORK/tok-mp2\"; printf '%s' 'MPFAKE2' > \"\$TOKEN_FILE\"
API=\"http://127.0.0.1:9\"
card=C1
$(sed -n '164,166p' "$REPO_ROOT/store/mopsion-preland.sh")
" "Authorization: Bearer MPFAKE2"

check_site "pre-dispatch-check.sh try_oauth_usage" "
CLAUDE_OAUTH_TOKEN=PDFAKE1
WEEKLY_STATE=\"$WORK/weekly-state.json\"
$(sed -n '/^try_oauth_usage() {/,/^}/p' "$REPO_ROOT/store/pre-dispatch-check.sh")
try_oauth_usage
" "Authorization: Bearer PDFAKE1"

check_site "fleet-test.sh fleet_test_notify_finish" "
FLEET_TEST_NOTIFY_TOKEN_FILE=\"$WORK/tok-ft1\"; printf '%s' 'FTFAKE1' > \"\$FLEET_TEST_NOTIFY_TOKEN_FILE\"
FLEET_TEST_LOG_DIR=\"$WORK/ft-logs\"; mkdir -p \"\$FLEET_TEST_LOG_DIR\"
SUMMARY_CHAR_CAP=2000
WEB_PORT=9
echo 'Tests  3 passed' > \"$WORK/src.log\"
$(sed -n '/^fleet_test_safe_summary() {/,/^}/p' "$REPO_ROOT/store/fleet-test.sh")
$(sed -n '/^fleet_test_notify_finish() {/,/^}/p' "$REPO_ROOT/store/fleet-test.sh")
fleet_test_notify_finish agent1 0 \"$WORK/src.log\"
" "Authorization: Bearer FTFAKE1"

# --- Round 2 + round 3 call sites (this card's own fix rounds) -----------------------------------
check_site "scripts/doctor.sh Dashboard API block" "
mkdir -p \"$WORK/doc/store\"; printf '%s' 'DOCFAKE1' > \"$WORK/doc/store/.dashboard-token\"
cd \"$WORK/doc\"
WEB_PORT=9
$(sed -n '266,267p' "$REPO_ROOT/scripts/doctor.sh")
" "Authorization: Bearer DOCFAKE1"

check_site "scripts/channels.sh trigger-1 guard alert" "
INSTALL_DIR=\"$WORK/ch1\"; mkdir -p \"\$INSTALL_DIR/store\"
printf '%s' 'CHFAKE1' > \"\$INSTALL_DIR/store/.dashboard-token\"
MAIN_AGENT_ID=marveen
$(sed -n '/^_guard_sender() {/,/^}/p' "$REPO_ROOT/scripts/channels.sh")
$(sed -n '1380,1395p' "$REPO_ROOT/scripts/channels.sh")
" "Authorization: Bearer CHFAKE1"

check_site "scripts/channels.sh trigger-2 guard alert" "
INSTALL_DIR=\"$WORK/ch2\"; mkdir -p \"\$INSTALL_DIR/store\"
printf '%s' 'CHFAKE2' > \"\$INSTALL_DIR/store/.dashboard-token\"
MAIN_AGENT_ID=marveen
$(sed -n '/^_guard_sender() {/,/^}/p' "$REPO_ROOT/scripts/channels.sh")
$(sed -n '1409,1419p' "$REPO_ROOT/scripts/channels.sh")
" "Authorization: Bearer CHFAKE2"

check_site "store/git-object-integrity-monitor.sh corruption alert" "
ROOT=\"$WORK/git1\"; mkdir -p \"\$ROOT/store\"
printf '%s' 'GITFAKE1' > \"\$ROOT/store/.dashboard-token\"
SCAN_ROOT=/x BAD_REPOS=1 DETAIL=d WEB_PORT=9
log() { :; }
$(sed -n '332,353p' "$REPO_ROOT/store/git-object-integrity-monitor.sh")
" "Authorization: Bearer GITFAKE1"

check_site "store/gemini-offload-call.sh VALIDATE_ONLY probe" "
API_KEY=GEMFAKE1
GEMINI_API_BASE=\"http://127.0.0.1:9\"
VALIDATE_ONLY=1
$(sed -n '340,343p' "$REPO_ROOT/store/gemini-offload-call.sh")
" "x-goog-api-key: GEMFAKE1"

echo "-- STATED GAP (not a silent skip): store/local-llm.sh's gateway curl call is wrapped in" \
     "'flock -w ... \"\$GPU_LOCK\" curl ...'. flock execs its argument via execvp, which never" \
     "consults this shell's function table, so a curl() override (the mechanism every check_site" \
     "above relies on) cannot intercept it. Verified by code reading only (grep -n GATEWAY_AUTH_HDR" \
     "store/local-llm.sh showing zero remaining references, and the -H @<(printf ...) line itself)," \
     "not by this harness. A real network-capturing listener would be needed to pin this site" \
     "dynamically; out of scope for this round."

echo "sites checked: $SITES_RUN"
[ "$FAIL" -eq 0 ] && echo "selftest: PASS"
exit "$FAIL"

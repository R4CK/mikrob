#!/usr/bin/env bash
# gpu-driver-silent-install-trigger.selftest.sh -- controls for the WSL-side gate+trigger
# (card 8b588834, GPU-driver figyelo (C)).
#
# Nothing here touches a real dashboard, a real Windows host, or the real on-disk
# gpu-driver-state.json -- every external dependency is overridden to a fake under $TMP.
#
# THE ASYMMETRY THAT MATTERS: a false "proceed" fires schtasks (which runs an admin-level
# install and ends in a full-fleet `wsl --shutdown`); a false "no-op" just delays a driver
# update by one cycle. So every negative case below asserts schtasks was NOT called, and only
# the single positive case asserts that it WAS, with no other arguments.
#
# Usage: gpu-driver-silent-install-trigger.selftest.sh   (exit 0 = PASS, 1 = FAIL)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/gpu-driver-silent-install-trigger.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

check() { # $1 label, $2 expected, $3 actual
  if [ "$3" = "$2" ]; then echo "  ok   $1 -> $3"
  else echo "  FAIL $1 -> got '$3', expected '$2'"; fail=1; fi
}

echo "token-fixture" > "$TMP/token"

NOW="$(date -u +%s)"

# Fake curl: routes on the trailing path+query in the URL argument (the last arg), returns a
# canned JSON body. CURL_FIXTURE_APPROVALS / CURL_FIXTURE_INPROGRESS are files this test
# (re)writes per-case; CURL_CALL_LOG records every invocation for inspection.
FAKE_CURL="$TMP/fake-curl.sh"
cat > "$FAKE_CURL" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$CURL_CALL_LOG"
url="${@: -1}"
case "$url" in
  *"/api/approvals"*) cat "$CURL_FIXTURE_APPROVALS" ;;
  *"/api/kanban"*)    cat "$CURL_FIXTURE_INPROGRESS" ;;
  *) echo "{}" ;;
esac
EOF
chmod +x "$FAKE_CURL"

# Fake schtasks: just records invocation + args, exits 0.
FAKE_SCHTASKS="$TMP/fake-schtasks.sh"
cat > "$FAKE_SCHTASKS" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$SCHTASKS_CALL_LOG"
exit "${FAKE_SCHTASKS_EXIT:-0}"
EOF
chmod +x "$FAKE_SCHTASKS"

# Fake gpu-driver-check.sh: only --compare is used by the trigger script.
FAKE_CHECK="$TMP/fake-check.sh"
cat > "$FAKE_CHECK" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "--compare" ]; then
  A="$2" B="$3" python3 -c '
import os
def parts(v):
    return [int(p) for p in v.split(".")]
a, b = parts(os.environ["A"]), parts(os.environ["B"])
n = max(len(a), len(b))
a += [0]*(n-len(a)); b += [0]*(n-len(b))
print("gt" if a>b else ("lt" if a<b else "eq"))
'
fi
EOF
chmod +x "$FAKE_CHECK"

# Fake wsl-interop-resolve.sh: prints nothing (no WSL host here, same as the real script's own
# fail-closed "nothing worked" path) -- deterministic regardless of what this test host has.
FAKE_INTEROP="$TMP/fake-interop.sh"
printf '#!/usr/bin/env bash\ntrue\n' > "$FAKE_INTEROP"
chmod +x "$FAKE_INTEROP"

run() { # sets RC, CURL_CALLS, SCHTASKS_CALLS, STATE_CONTENT
  : > "$TMP/curl-calls.txt"
  : > "$TMP/schtasks-calls.txt"
  RC=0
  GPU_DRIVER_INSTALL_CURL_BIN="$FAKE_CURL" \
  CURL_CALL_LOG="$TMP/curl-calls.txt" \
  CURL_FIXTURE_APPROVALS="$APPROVALS_FIXTURE" \
  CURL_FIXTURE_INPROGRESS="$INPROGRESS_FIXTURE" \
  GPU_DRIVER_INSTALL_SCHTASKS_BIN="$FAKE_SCHTASKS" \
  SCHTASKS_CALL_LOG="$TMP/schtasks-calls.txt" \
  FAKE_SCHTASKS_EXIT="${FAKE_SCHTASKS_EXIT:-0}" \
  GPU_DRIVER_INSTALL_CHECK_BIN="$FAKE_CHECK" \
  GPU_DRIVER_INSTALL_WSL_INTEROP_RESOLVE="$FAKE_INTEROP" \
  GPU_DRIVER_INSTALL_TOKEN_FILE="$TMP/token" \
  GPU_DRIVER_INSTALL_API="http://fake" \
  GPU_DRIVER_INSTALL_APPROVAL_CATEGORY="gpu-driver-silent-install" \
  GPU_DRIVER_INSTALL_APPROVAL_WINDOW_S=3600 \
  GPU_DRIVER_INSTALL_STATE="$TMP/trigger-state.json" \
  GPU_DRIVER_INSTALL_DRIVER_STATE="$DRIVER_STATE_FIXTURE" \
  GPU_DRIVER_SILENT_INSTALL="${FLAG:-on}" \
    bash "$BIN" >"$TMP/stdout.txt" 2>&1 || RC=$?
  CURL_CALLS="$(cat "$TMP/curl-calls.txt")"
  SCHTASKS_CALLS="$(cat "$TMP/schtasks-calls.txt")"
  STATE_CONTENT="$(cat "$TMP/trigger-state.json" 2>/dev/null)"
}

write_fixtures() { # $1 approvals-json $2 inprogress-json $3 driver-state-json
  APPROVALS_FIXTURE="$TMP/approvals.json"; printf '%s' "$1" > "$APPROVALS_FIXTURE"
  INPROGRESS_FIXTURE="$TMP/inprogress.json"; printf '%s' "$2" > "$INPROGRESS_FIXTURE"
  DRIVER_STATE_FIXTURE="$TMP/driver-state.json"; printf '%s' "$3" > "$DRIVER_STATE_FIXTURE"
}

FRESH_APPROVED='[{"id":"appr-1","status":"approved","resolved_at":'"$NOW"'}]'
EMPTY_INPROGRESS='[]'
BUSY_INPROGRESS='[{"id":"cardx","status":"in_progress"}]'
NEWER_AVAILABLE='{"installedHost":"617.42","available":"620.10"}'
NOT_NEWER='{"installedHost":"620.10","available":"620.10"}'

echo "gpu-driver-silent-install-trigger controls"

# --- 1. Flag off -> no-op, no curl, no schtasks. --------------------------------------------
write_fixtures "$FRESH_APPROVED" "$EMPTY_INPROGRESS" "$NEWER_AVAILABLE"
FLAG=off run
check "flag off: exit 0"           "0" "$RC"
check "flag off: no curl calls"    ""  "$CURL_CALLS"
check "flag off: no schtasks call" ""  "$SCHTASKS_CALLS"
FLAG=on

# --- 2. No approval at all -> no-op, no schtasks. -------------------------------------------
write_fixtures '[]' "$EMPTY_INPROGRESS" "$NEWER_AVAILABLE"
run
check "no approval: exit 0"           "0" "$RC"
check "no approval: no schtasks call" ""  "$SCHTASKS_CALLS"

# --- 3. Approval exists but NOT approved (pending) -> no-op, no schtasks. -------------------
write_fixtures '[{"id":"appr-2","status":"pending","resolved_at":null}]' "$EMPTY_INPROGRESS" "$NEWER_AVAILABLE"
run
check "pending approval: no schtasks call" "" "$SCHTASKS_CALLS"

# --- 4. Approval approved but STALE (older than the window) -> no-op, no schtasks. ----------
write_fixtures '[{"id":"appr-3","status":"approved","resolved_at":1}]' "$EMPTY_INPROGRESS" "$NEWER_AVAILABLE"
run
check "stale approval: no schtasks call" "" "$SCHTASKS_CALLS"

# --- 5. Fresh approval, but board is BUSY (in_progress card exists) -> no-op, no schtasks. ---
write_fixtures "$FRESH_APPROVED" "$BUSY_INPROGRESS" "$NEWER_AVAILABLE"
run
check "board busy: exit 0"           "0" "$RC"
check "board busy: no schtasks call" ""  "$SCHTASKS_CALLS"

# --- 6. Fresh approval, board idle, but available is NOT newer -> no-op, no schtasks. --------
write_fixtures "$FRESH_APPROVED" "$EMPTY_INPROGRESS" "$NOT_NEWER"
run
check "not newer: exit 0"           "0" "$RC"
check "not newer: no schtasks call" ""  "$SCHTASKS_CALLS"

# --- 7. POSITIVE: every precondition holds -> schtasks called with ONLY /run /TN <name>. ----
write_fixtures "$FRESH_APPROVED" "$EMPTY_INPROGRESS" "$NEWER_AVAILABLE"
run
check "positive: exit 0"            "0" "$RC"
check "positive: schtasks call, no extra params" "/run /TN MikroB-GPU-Driver-Install" "$SCHTASKS_CALLS"
check "positive: approval recorded as used" "appr-1" "$(python3 -c "import json; print(json.load(open('$TMP/trigger-state.json')).get('lastTriggeredApprovalId'))" 2>/dev/null)"
check "positive: approval recorded in usedApprovalIds set" "['appr-1']" "$(python3 -c "import json; print(json.load(open('$TMP/trigger-state.json')).get('usedApprovalIds'))" 2>/dev/null)"

# --- 8. REPLAY GUARD: same approval, run again -> no-op, no second schtasks call. ------------
run
check "replay guard: exit 0"           "0" "$RC"
check "replay guard: no second schtasks call" "" "$SCHTASKS_CALLS"

# --- 9. Missing dashboard token -> FAIL-CLOSED (exit 1), no schtasks. ------------------------
write_fixtures "$FRESH_APPROVED" "$EMPTY_INPROGRESS" "$NEWER_AVAILABLE"
: > "$TMP/curl-calls.txt"; : > "$TMP/schtasks-calls.txt"
RC=0
GPU_DRIVER_INSTALL_CURL_BIN="$FAKE_CURL" CURL_CALL_LOG="$TMP/curl-calls.txt" \
CURL_FIXTURE_APPROVALS="$APPROVALS_FIXTURE" CURL_FIXTURE_INPROGRESS="$INPROGRESS_FIXTURE" \
GPU_DRIVER_INSTALL_SCHTASKS_BIN="$FAKE_SCHTASKS" SCHTASKS_CALL_LOG="$TMP/schtasks-calls.txt" \
GPU_DRIVER_INSTALL_CHECK_BIN="$FAKE_CHECK" GPU_DRIVER_INSTALL_WSL_INTEROP_RESOLVE="$FAKE_INTEROP" \
GPU_DRIVER_INSTALL_TOKEN_FILE="$TMP/does-not-exist" \
GPU_DRIVER_INSTALL_API="http://fake" GPU_DRIVER_INSTALL_STATE="$TMP/trigger-state2.json" \
GPU_DRIVER_INSTALL_DRIVER_STATE="$DRIVER_STATE_FIXTURE" GPU_DRIVER_SILENT_INSTALL=on \
  bash "$BIN" >/dev/null 2>&1 || RC=$?
check "no token: exit 1 (fail-closed)" "1" "$RC"
check "no token: no schtasks call" "" "$(cat "$TMP/schtasks-calls.txt")"

# --- 10. schtasks itself fails (non-zero exit) -> trigger reports exit 2, state NOT recorded. -
# A FRESH, not-yet-used approval id is required here -- appr-1 was already consumed by case 7/8's
# replay guard, and reusing it would make this case a no-op for the wrong reason (test 8's bug class).
write_fixtures '[{"id":"appr-10","status":"approved","resolved_at":'"$NOW"'}]' "$EMPTY_INPROGRESS" "$NEWER_AVAILABLE"
FAKE_SCHTASKS_EXIT=1 run
check "schtasks failure: exit 2" "2" "$RC"
# State must stay UNCHANGED (still appr-1 from case 7) -- a failed schtasks call must never mark
# appr-10 as used, or a legitimate retry after fixing the task would be silently skipped.
check "schtasks failure: state unchanged (appr-10 NOT recorded)" "appr-1" \
  "$(python3 -c "import json; print(json.load(open('$TMP/trigger-state.json')).get('lastTriggeredApprovalId'))" 2>/dev/null)"
FAKE_SCHTASKS_EXIT=0

# --- 11. F2 regression: TWO distinct fresh approvals both fire across two runs, and once a
# SECOND id is recorded, the state must still remember every EARLIER one too (not just the
# latest) -- this is the exact "last-used-only forgets an earlier id" shape the bug report
# described. Continues on the same $TMP/trigger-state.json used by cases 7-10 above, which
# already has appr-1 recorded -- that is part of what this case checks (appr-1 must survive).
write_fixtures '[{"id":"appr-11a","status":"approved","resolved_at":'"$NOW"'}]' "$EMPTY_INPROGRESS" "$NEWER_AVAILABLE"
run
check "F2 two-approvals (1st): schtasks fired" "/run /TN MikroB-GPU-Driver-Install" "$SCHTASKS_CALLS"
write_fixtures '[{"id":"appr-11b","status":"approved","resolved_at":'"$NOW"'},{"id":"appr-11a","status":"approved","resolved_at":'"$NOW"'}]' "$EMPTY_INPROGRESS" "$NEWER_AVAILABLE"
run
check "F2 two-approvals (2nd, appr-11a already used): schtasks fired for appr-11b" \
  "/run /TN MikroB-GPU-Driver-Install" "$SCHTASKS_CALLS"
USED_SET="$(python3 -c "import json; print(sorted(json.load(open('$TMP/trigger-state.json')).get('usedApprovalIds',[])))" 2>/dev/null)"
check "F2: every used id remembered, not just the latest" "['appr-1', 'appr-11a', 'appr-11b']" "$USED_SET"
# A third run with NO new approval must now be a no-op for every old id (not just the last one).
run
check "F2: no previously-used id refires" "" "$SCHTASKS_CALLS"

# --- 12. LOCK: a held lock makes a concurrent invocation a clean no-op, no schtasks call. ------
# Fresh, never-before-seen approval id -- the ONLY reason this must not fire is the held lock,
# not the replay guard (which would also independently block a reused id, confounding the case).
write_fixtures '[{"id":"appr-12","status":"approved","resolved_at":'"$NOW"'}]' "$EMPTY_INPROGRESS" "$NEWER_AVAILABLE"
LOCK12="$TMP/trigger-state12.json.lock"
exec {HELD_LOCK_FD}>"$LOCK12"
flock -n "$HELD_LOCK_FD" || echo "  FAIL could not pre-acquire test lock"
GPU_DRIVER_INSTALL_LOCK_FILE="$LOCK12" run
check "lock held: exit 0"            "0" "$RC"
check "lock held: no schtasks call"  ""  "$SCHTASKS_CALLS"
exec {HELD_LOCK_FD}>&-

if [ "$fail" -eq 0 ]; then
  echo "selftest: PASS"
  exit 0
else
  echo "selftest: FAIL"
  exit 1
fi

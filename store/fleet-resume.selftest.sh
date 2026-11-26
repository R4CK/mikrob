#!/usr/bin/env bash
# Selftest for fleet-resume.sh (card f22cf4f4). Hermetic: every external dependency (systemctl,
# local-llm-installed.sh, vram-guard-check.sh, wsl-home-cleanup.sh, agent-cap-check.sh,
# load-guard-read.sh, the dashboard API) is replaced with a stub via the script's own env seams,
# so this never touches the real host, the real network, or the real fleet.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/fleet-resume.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

t() {
  local desc="$1" expected_mode="$2" haystack="$3" needle="$4"
  if [ "$expected_mode" = "contains" ]; then
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
      PASS=$((PASS + 1))
    else
      FAIL=$((FAIL + 1)); echo "FAIL: $desc -- expected to find: $needle"
    fi
  else
    if ! printf '%s' "$haystack" | grep -qF -- "$needle"; then
      PASS=$((PASS + 1))
    else
      FAIL=$((FAIL + 1)); echo "FAIL: $desc -- expected NOT to find: $needle"
    fi
  fi
}

mk_stub() {
  # mk_stub <path> <body-lines...> -- writes an executable stub script.
  local path="$1"; shift
  printf '#!/usr/bin/env bash\n%s\n' "$*" > "$path"
  chmod +x "$path"
}

# A fully-neutral baseline environment: nothing to resume, no real calls. Individual tests override
# only what they need, so each case's intent stays visible at the call site.
base_env() {
  mkdir -p "$TMP/agents/foo" "$TMP/agents/bar"
  : > "$TMP/agents/foo/HANDOFF.md"       # empty -- must NOT be flagged
  printf 'resume card X here\n' > "$TMP/agents/bar/HANDOFF.md"  # non-empty -- candidate

  mk_stub "$TMP/installed.sh" 'echo installed; exit 0'
  mk_stub "$TMP/vram.sh" 'echo "ADMIT ok 1/1 MiB"; exit 0'
  mk_stub "$TMP/cleanup.sh" 'echo "KEEP /home/neon/nothing"; exit 0'
  mk_stub "$TMP/agentcap.sh" 'echo "ADMIT 1/5"; exit 0'
  mk_stub "$TMP/loadread.sh" 'echo "{\"loadavg1\":0.1}"; exit 0'
  mk_stub "$TMP/systemctl.sh" '
case "$2" in
  is-active) echo active; exit 0 ;;
  start) exit 0 ;;
esac
'

  export FLEET_RESUME_INSTALLED_CHECK="$TMP/installed.sh"
  export FLEET_RESUME_VRAM_GUARD="$TMP/vram.sh"
  export FLEET_RESUME_CLEANUP_SCRIPT="$TMP/cleanup.sh"
  export FLEET_RESUME_AGENT_CAP_CHECK="$TMP/agentcap.sh"
  export FLEET_RESUME_LOAD_GUARD_READ="$TMP/loadread.sh"
  export FLEET_RESUME_SYSTEMCTL_BIN="$TMP/systemctl.sh"
  export FLEET_RESUME_AGENTS_DIR="$TMP/agents"
  export FLEET_RESUME_AGENTS_JSON='[{"name":"foo","running":true},{"name":"bar","running":true},{"name":"baz","running":false}]'
  export FLEET_RESUME_NOW=1700000000

  # Card 12d91d4b: every stub above does instant, trivial work -- but under heavy host contention
  # (several concurrent fleet-test.sh/vitest runs, measured: DevO's land queue, msgs 19798/19913)
  # the FORK/EXEC of that stub, not the work itself, can take longer than fleet-resume.sh's own
  # hardcoded per-call timeouts (10s/5s/15s). None of the tests below are testing THOSE timeouts
  # firing -- only test 8 deliberately tests a timeout bound, via FLEET_RESUME_CLEANUP_TIMEOUT,
  # which stays separate and tight. Widening the others removes that false-negative source without
  # touching what any test asserts (same pattern CLEANUP_TIMEOUT already uses).
  export FLEET_RESUME_INSTALLED_TIMEOUT=60
  export FLEET_RESUME_ACTIVE_CHECK_TIMEOUT=60
  export FLEET_RESUME_START_TIMEOUT=60
  export FLEET_RESUME_VRAM_TIMEOUT=60
  export FLEET_RESUME_LOAD_READ_TIMEOUT=60
  export FLEET_RESUME_AGENT_CAP_TIMEOUT=60
}

# ---- 1. masked ollama: never calls start, even with --apply ----
base_env
mk_stub "$TMP/installed.sh" 'echo "not-installed: ollama.service masked"; exit 1'
mk_stub "$TMP/systemctl.sh" 'echo "systemctl.sh: should not be called for a masked unit" >&2; exit 9'
OUT="$(bash "$SCRIPT" --apply 2>&1)"
t "masked unit is reported and respected" contains "$OUT" "MASKED"
t "masked unit never reaches systemctl" not "$OUT" "should not be called"

# ---- 2. not installed at all (no mask, just absent) -- no start attempt ----
base_env
mk_stub "$TMP/installed.sh" 'echo "not-installed: no ollama binary"; exit 1'
mk_stub "$TMP/systemctl.sh" 'echo "systemctl.sh: should not be called" >&2; exit 9'
OUT="$(bash "$SCRIPT" --apply 2>&1)"
t "not-installed host is reported" contains "$OUT" "nothing to resume here"
t "not-installed host never reaches systemctl" not "$OUT" "should not be called"

# ---- 3. installed, unmasked, already active -- no action, no error ----
base_env
OUT="$(bash "$SCRIPT" 2>&1)"
t "already-active ollama needs no action" contains "$OUT" "already active"

# ---- 4. installed, unmasked, inactive, DRY-RUN -- plans but does not start ----
base_env
mk_stub "$TMP/systemctl.sh" '
case "$2" in
  is-active) echo inactive; exit 3 ;;
  start) echo "STARTED-MARKER" >>"'"$TMP"'/start-calls.log"; exit 0 ;;
esac
'
OUT="$(bash "$SCRIPT" 2>&1)"
t "dry-run reports the planned start" contains "$OUT" "would run: systemctl"
[ -f "$TMP/start-calls.log" ] && { FAIL=$((FAIL + 1)); echo "FAIL: dry-run must not actually start ollama"; } || PASS=$((PASS + 1))

# ---- 5. installed, unmasked, inactive, --apply -- actually starts it ----
base_env
mk_stub "$TMP/systemctl.sh" '
case "$2" in
  is-active) echo inactive; exit 3 ;;
  start) echo "STARTED-MARKER" >>"'"$TMP"'/start-calls.log"; exit 0 ;;
esac
'
OUT="$(bash "$SCRIPT" --apply 2>&1)"
t "apply mode reports it started ollama" contains "$OUT" "-> started"
[ -f "$TMP/start-calls.log" ] && PASS=$((PASS + 1)) || { FAIL=$((FAIL + 1)); echo "FAIL: --apply must actually start ollama when safe"; }

# ---- 6. Z2 (card 39253062): a GPU-gate HOLD must stop an --apply start, not just report it ----
base_env
mk_stub "$TMP/vram.sh" 'echo "HOLD hard 5800/6144 MiB (94%)"; exit 1'
mk_stub "$TMP/systemctl.sh" '
case "$2" in
  is-active) echo inactive; exit 3 ;;
  start) echo "STARTED-MARKER" >>"'"$TMP"'/start-calls-z2.log"; exit 0 ;;
esac
'
OUT="$(bash "$SCRIPT" --apply 2>&1)"
t "GPU-gate HOLD is reported as the reason the start was skipped" contains "$OUT" "SKIPPED"
t "GPU-gate HOLD reason text reaches the report" contains "$OUT" "HOLD hard"
[ -f "$TMP/start-calls-z2.log" ] && { FAIL=$((FAIL + 1)); echo "FAIL: ollama must NOT be started while the GPU gate reports HOLD"; } || PASS=$((PASS + 1))

# ---- 7. Z2 positive control: an ADMIT verdict still lets --apply start it ----
base_env
mk_stub "$TMP/vram.sh" 'echo "ADMIT ok 100/6144 MiB (2%)"; exit 0'
mk_stub "$TMP/systemctl.sh" '
case "$2" in
  is-active) echo inactive; exit 3 ;;
  start) echo "STARTED-MARKER" >>"'"$TMP"'/start-calls-z2b.log"; exit 0 ;;
esac
'
OUT="$(bash "$SCRIPT" --apply 2>&1)"
t "ADMIT verdict still reports the start" contains "$OUT" "-> started"
[ -f "$TMP/start-calls-z2b.log" ] && PASS=$((PASS + 1)) || { FAIL=$((FAIL + 1)); echo "FAIL: --apply must still start ollama when the GPU gate ADMITs"; }

# ---- 8. HANDOFF.md candidates: only a RUNNING agent with a NON-EMPTY HANDOFF.md is listed ----
base_env
OUT="$(bash "$SCRIPT" 2>&1)"
t "running agent with non-empty HANDOFF.md is listed" contains "$OUT" "bar: running"
t "running agent with EMPTY HANDOFF.md is not listed" not "$OUT" "foo: running"
t "non-running agent is never listed even with a HANDOFF.md" not "$OUT" "baz:"
# Z1/Z5 (card 39253062, RedHat f22cf4f4 comment 19990): the HANDOFF.md body is data for MikroB to
# read, not something this report should echo (prompt-injection surface, see the script's own
# section-C comment). Pin that its CONTENT, not just its path, never reaches stdout -- a mutant that
# `cat`s the file instead of naming it survived unnoticed before this line existed.
t "HANDOFF.md content itself never leaks into the report (Z5: data, not instructions)" not "$OUT" "resume card X here"

# ---- 9. section B never deletes anything, regardless of --apply ----
# Z1 (card 39253062): the old assertion grepped the HUMAN-READABLE OUTPUT for the literal substring
# "--apply --yes" -- which the stub below never echoes regardless of what args it is actually called
# with, so it stayed green on every mutant RedHat tried (--apply --yes, --yes --apply, any other arg
# at all). The real invariant is on the CALL ITSELF: log cleanup.sh's actual argv to a file (same
# pattern as the start-calls.log check in case 5/8) and assert it is empty -- this matches the
# production contract (CLEANUP_SCRIPT is invoked with zero arguments, store/fleet-resume.sh:131) and
# turns red for ANY argument the mutated call might add, not just the two named forms.
base_env
CLEANUP_ARGV_LOG="$TMP/cleanup-argv.log"
mk_stub "$TMP/cleanup.sh" "echo \"DISPOSABLE /home/neon/something-stale\"; printf '%s' \"\$*\" > \"$CLEANUP_ARGV_LOG\"; exit 0"
OUT="$(bash "$SCRIPT" --apply 2>&1)"
t "disposable worktrees are surfaced" contains "$OUT" "DISPOSABLE"
if [ -s "$CLEANUP_ARGV_LOG" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: cleanup.sh must be called with ZERO args (rule 22: --apply/--yes needs Peti's approval every time); got: $(cat "$CLEANUP_ARGV_LOG")"
else
  PASS=$((PASS + 1))
fi

# ---- 10. a slow cleanup script is bounded, not hung forever ----
# Card 12d91d4b: this used to assert END-START <= 10, a wall-clock bound that fails under heavy
# host contention for reasons that have nothing to do with whether the timeout fired (fork/exec
# latency for the OTHER stubs in the same run, see base_env above). The real invariant -- that
# cleanup.sh was KILLED before its 5s sleep completed, not merely outrun -- is fully captured by
# the stub's own completion marker ("too slow", printed only AFTER the sleep) being absent. That
# is a behavioural check, true regardless of how long the surrounding host noise makes the whole
# run take.
base_env
mk_stub "$TMP/cleanup.sh" 'sleep 5; echo "too slow"; exit 0'
export FLEET_RESUME_CLEANUP_TIMEOUT=1
OUT="$(timeout 20 bash "$SCRIPT" 2>&1)"
t "slow cleanup script is reported as timed out, not silently hung" contains "$OUT" "did not finish within"
t "cleanup was killed before its sleep finished, not merely outrun by the rest of the script" not "$OUT" "too slow"
unset FLEET_RESUME_CLEANUP_TIMEOUT

# ---- 11. missing tool dependency degrades to a skip line, never a crash ----
base_env
export FLEET_RESUME_VRAM_GUARD="$TMP/does-not-exist.sh"
OUT="$(bash "$SCRIPT" 2>&1)"
t "missing vram guard reports skipped, not a crash" contains "$OUT" "missing, skipped"
unset FLEET_RESUME_VRAM_GUARD

# ---- 12. Z3 (card 39253062, RedHat f22cf4f4 19990): the Authorization-header temp file for the
# /api/agents call must not survive a SIGTERM mid-request. A fake slow `curl` on PATH gives a window
# to signal the script while the temp file exists; a dedicated TMPDIR lets us look for leftovers
# without guessing mktemp's random name. Reproduced against the pre-fix script before writing this:
# the file survived there, confirming the test actually distinguishes old from new behaviour.
base_env
unset FLEET_RESUME_AGENTS_JSON
SIGTERM_TMPDIR="$TMP/sigterm-tmpdir"; mkdir -p "$SIGTERM_TMPDIR"
mkdir -p "$TMP/binoverride"
mk_stub "$TMP/binoverride/curl" 'sleep 3; echo "[]"'
printf 'faketoken\n' > "$TMP/fake-token"
export FLEET_RESUME_TOKEN_FILE="$TMP/fake-token"
TMPDIR="$SIGTERM_TMPDIR" PATH="$TMP/binoverride:$PATH" bash "$SCRIPT" >/dev/null 2>&1 &
RESUME_PID=$!
sleep 1
kill -TERM "$RESUME_PID" 2>/dev/null
wait "$RESUME_PID" 2>/dev/null
LEFTOVER="$(find "$SIGTERM_TMPDIR" -type f 2>/dev/null)"
if [ -z "$LEFTOVER" ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1)); echo "FAIL: Authorization-header temp file survived SIGTERM: $LEFTOVER"
fi
unset FLEET_RESUME_TOKEN_FILE

echo
echo "fleet-resume.selftest: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

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

# ---- 6. HANDOFF.md candidates: only a RUNNING agent with a NON-EMPTY HANDOFF.md is listed ----
base_env
OUT="$(bash "$SCRIPT" 2>&1)"
t "running agent with non-empty HANDOFF.md is listed" contains "$OUT" "bar: running"
t "running agent with EMPTY HANDOFF.md is not listed" not "$OUT" "foo: running"
t "non-running agent is never listed even with a HANDOFF.md" not "$OUT" "baz:"

# ---- 7. section B never deletes anything, regardless of --apply ----
base_env
mk_stub "$TMP/cleanup.sh" 'echo "DISPOSABLE /home/neon/something-stale"; exit 0'
OUT="$(bash "$SCRIPT" --apply 2>&1)"
t "disposable worktrees are surfaced" contains "$OUT" "DISPOSABLE"
t "cleanup is never invoked with --apply/--yes" not "$OUT" "--apply --yes"

# ---- 8. a slow cleanup script is bounded, not hung forever ----
base_env
mk_stub "$TMP/cleanup.sh" 'sleep 5; echo "too slow"; exit 0'
export FLEET_RESUME_CLEANUP_TIMEOUT=1
START=$(date +%s)
OUT="$(timeout 20 bash "$SCRIPT" 2>&1)"
END=$(date +%s)
t "slow cleanup script is reported as timed out, not silently hung" contains "$OUT" "did not finish within"
if [ $((END - START)) -le 10 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: cleanup timeout was not honoured (took $((END - START))s)"; fi
unset FLEET_RESUME_CLEANUP_TIMEOUT

# ---- 9. missing tool dependency degrades to a skip line, never a crash ----
base_env
export FLEET_RESUME_VRAM_GUARD="$TMP/does-not-exist.sh"
OUT="$(bash "$SCRIPT" 2>&1)"
t "missing vram guard reports skipped, not a crash" contains "$OUT" "missing, skipped"

echo
echo "fleet-resume.selftest.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

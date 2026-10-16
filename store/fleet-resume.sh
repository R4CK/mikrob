#!/usr/bin/env bash
# fleet-resume.sh -- idempotent fleet-state assessment after a WSL/host restart (card f22cf4f4).
#
# WHY. Peti's 2026-09-29 Dream Engine request: after the kernel-update restart that same morning,
# resuming the fleet by hand needed four separate checks (Ollama + GPU, the gpu-crashloop mask,
# fresh-session agents that lost their in-flight card context, and the load-guard/agent-cap
# picture) -- each one quick alone, but easy to forget one under the other noise of "the fleet is
# back up, carry on". This script runs all four every time, the same way, and only ever performs
# ONE reversible action (starting ollama.service) -- everything else is a report for a human/MikroB
# to act on. Idempotent: running it twice when nothing changed prints the same "already fine" lines
# both times and does nothing the second time either.
#
# NOT DONE HERE (by design, see the card): no live rollback, the MikroB/dashboard service is never
# touched, no worktree is deleted (wsl-home-cleanup.sh's own --apply --yes needs Peti's approval
# every time, rule 22), and no other agent is started/stopped (that is folyamatos-munka-orchestrator/
# MikroB's call, rule 7) -- this script only SURFACES the mismatch for a human/MikroB to act on.
#
# Usage: fleet-resume.sh [--apply]
#   (default) dry-run: reports everything, plans the one state-changing step without doing it.
#   --apply:   also starts ollama.service if it is unmasked and not already active.
#
# Exit: always 0 (a report tool; a sub-check failing is reported inline, not escalated to a
# nonzero exit that would make a caller treat "fleet is fine, nothing to resume" as an error).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- test seams (same convention as vram-guard-check.sh / agent-cap-check.sh: env override,
# empty/default = the real thing) ----
TOKEN_FILE="${FLEET_RESUME_TOKEN_FILE:-$SCRIPT_DIR/.dashboard-token}"
AGENTS_URL="${FLEET_RESUME_AGENTS_URL:-http://localhost:3420/api/agents}"
AGENTS_DIR="${FLEET_RESUME_AGENTS_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/agents}"
INSTALLED_CHECK="${FLEET_RESUME_INSTALLED_CHECK:-$SCRIPT_DIR/local-llm-installed.sh}"
VRAM_GUARD="${FLEET_RESUME_VRAM_GUARD:-$SCRIPT_DIR/vram-guard-check.sh}"
CLEANUP_SCRIPT="${FLEET_RESUME_CLEANUP_SCRIPT:-$SCRIPT_DIR/wsl-home-cleanup.sh}"
AGENT_CAP_CHECK="${FLEET_RESUME_AGENT_CAP_CHECK:-$SCRIPT_DIR/agent-cap-check.sh}"
CLEANUP_TIMEOUT="${FLEET_RESUME_CLEANUP_TIMEOUT:-120}"
LOAD_GUARD_READ="${FLEET_RESUME_LOAD_GUARD_READ:-$SCRIPT_DIR/load-guard-read.sh}"
SYSTEMCTL_BIN="${FLEET_RESUME_SYSTEMCTL_BIN:-systemctl}"
OLLAMA_UNIT="${FLEET_RESUME_OLLAMA_UNIT:-ollama.service}"
AGENTS_JSON="${FLEET_RESUME_AGENTS_JSON:-}"   # test seam: pre-fetched /api/agents body
NOW="${FLEET_RESUME_NOW:-}"

APPLY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=true; shift ;;
    *) echo "fleet-resume.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$NOW" ] || NOW=$(date +%s)

MODE_LABEL="DRY-RUN"
[ "$APPLY" = true ] && MODE_LABEL="APPLY"
echo "== fleet-resume.sh ($MODE_LABEL) @ $NOW =="

# =================================================================================================
# A. Ollama + GPU, respecting the gpu-crashloop-guard mask.
# =================================================================================================
echo
echo "-- A. Ollama / GPU --"

if [ -x "$INSTALLED_CHECK" ]; then
  INSTALLED_OUT="$(timeout 10 "$INSTALLED_CHECK" 2>&1)"
  INSTALLED_RC=$?
else
  INSTALLED_OUT="not-installed: $INSTALLED_CHECK missing or not executable"
  INSTALLED_RC=1
fi
echo "  local-llm-installed.sh: $INSTALLED_OUT"

if printf '%s' "$INSTALLED_OUT" | grep -q "masked"; then
  echo "  ollama.service is MASKED (gpu-crashloop-guard) -- respecting the mask, NOT starting it."
elif [ "$INSTALLED_RC" -ne 0 ]; then
  echo "  ollama not usable on this host for another reason -- nothing to resume here."
else
  ACTIVE="$(timeout 5 "$SYSTEMCTL_BIN" --user is-active "$OLLAMA_UNIT" 2>/dev/null || true)"
  if [ "$ACTIVE" = "active" ]; then
    echo "  ollama.service already active -- nothing to do."
  elif [ "$APPLY" = true ]; then
    if START_ERR="$(timeout 10 "$SYSTEMCTL_BIN" --user start "$OLLAMA_UNIT" 2>&1)"; then
      echo "  ollama.service was '$ACTIVE' -> started."
    else
      echo "  ollama.service start FAILED (was '$ACTIVE'): $START_ERR"
    fi
  else
    echo "  ollama.service is '$ACTIVE' -- would run: systemctl --user start $OLLAMA_UNIT (dry-run; re-run with --apply)"
  fi
fi

if [ -x "$VRAM_GUARD" ]; then
  VRAM_OUT="$(timeout 15 "$VRAM_GUARD" 2>&1)" || true
  echo "  GPU gate (read-only): $VRAM_OUT"
else
  echo "  GPU gate: $VRAM_GUARD missing, skipped"
fi

# =================================================================================================
# B. Interrupted landing queue.
#
# The suite-run semaphore (fleet-test.sh/mopsion-suite-run.sh) uses flock on a file descriptor --
# the kernel releases it the instant the holding process dies, so a kernel-caused restart cannot
# leave it stuck (see those scripts' own header comments). Running background tasks are swept by
# the dashboard's OWN startup code (sweepOrphanedBackgroundTasks in background-tasks.ts) the moment
# it comes back up, which happens before this script can even reach the API. What a crash CAN leave
# behind is a disposable, eldobható land/gate worktree from a run that never reached cleanup --
# wsl-home-cleanup.sh already classifies exactly that (KEEP/ACTIVE/DISPOSABLE/UNKNOWN); this script
# never deletes (rule 22: --apply --yes needs Peti's approval every time), it only surfaces the
# dry-run report so a human/MikroB can decide.
# =================================================================================================
echo
echo "-- B. Interrupted landing queue --"
if [ -x "$CLEANUP_SCRIPT" ]; then
  echo "  (flock-based suite locks and bg-task rows self-heal on process death / dashboard restart --"
  echo "   nothing to resume there. Stale disposable land/gate worktrees, if any, below. Never deleted here.)"
  # Measured on this host: a full scan over the shared /home/neon worktree population takes well
  # over 90s (hundreds of entries) -- bounded so a slow scan cannot turn an idempotent resume check
  # into a hang. A timeout here is a missed report, not a wrong one: nothing destructive runs either way.
  if ! timeout "$CLEANUP_TIMEOUT" "$CLEANUP_SCRIPT" 2>&1 | sed 's/^/  /'; then
    echo "  (wsl-home-cleanup.sh did not finish within ${CLEANUP_TIMEOUT}s -- run it separately for the full report)"
  fi
else
  echo "  $CLEANUP_SCRIPT missing, skipped"
fi

# =================================================================================================
# C. Fresh-session agents that may need re-dispatch, per their own HANDOFF.md.
#
# Report-only: actually sending a resume-nudge is left to MikroB (rule 7/11: dispatch and
# agent-start/stop ownership is the orchestrator's, not DevO's -- an unsolicited nudge from here
# could double-dispatch a card the agent is already quietly resuming on its own, per rule 11
# self-advance). This only lists the candidates and where their handoff lives.
# =================================================================================================
echo
echo "-- C. Fresh-session agents (HANDOFF.md candidates for MikroB to re-dispatch) --"
if [ -n "$AGENTS_JSON" ]; then
  AGENTS_BODY="$AGENTS_JSON"
elif [ -r "$TOKEN_FILE" ]; then
  AUTH_HDR_FILE="$(mktemp)"; chmod 600 "$AUTH_HDR_FILE"
  printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$AUTH_HDR_FILE"
  AGENTS_BODY="$(curl -s --max-time 5 -H @"$AUTH_HDR_FILE" "$AGENTS_URL" 2>/dev/null || true)"
  rm -f "$AUTH_HDR_FILE"
else
  AGENTS_BODY=""
fi

if [ -z "$AGENTS_BODY" ]; then
  echo "  could not read $AGENTS_URL (no token or request failed) -- skipped"
else
  RUNNING_NAMES="$(printf '%s' "$AGENTS_BODY" | python3 -c '
import json, sys
try:
    agents = json.load(sys.stdin)
except Exception:
    agents = []
for a in agents:
    if a.get("running"):
        print(a.get("name", ""))
' 2>/dev/null)"
  FOUND=0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    HANDOFF="$AGENTS_DIR/$name/HANDOFF.md"
    if [ -s "$HANDOFF" ]; then
      FOUND=$((FOUND + 1))
      echo "  $name: running, has $HANDOFF -- check whether it needs re-dispatch onto its own card."
    fi
  done <<<"$RUNNING_NAMES"
  [ "$FOUND" -eq 0 ] && echo "  none -- no running agent has a non-empty HANDOFF.md."
fi

# =================================================================================================
# D. Parked/running agent count vs. load-guard and the agent-cap, for visibility.
#
# Report-only (same ownership reason as section C): this never starts or stops a role-agent.
# =================================================================================================
echo
echo "-- D. load-guard / agent-cap snapshot --"
if [ -x "$LOAD_GUARD_READ" ]; then
  echo "  load: $(timeout 5 "$LOAD_GUARD_READ" 2>&1)"
else
  echo "  load: $LOAD_GUARD_READ missing, skipped"
fi
if [ -x "$AGENT_CAP_CHECK" ]; then
  echo "  agent-cap: $(timeout 10 "$AGENT_CAP_CHECK" 2>&1)"
else
  echo "  agent-cap: $AGENT_CAP_CHECK missing, skipped"
fi

exit 0

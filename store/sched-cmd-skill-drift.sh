#!/usr/bin/env bash
# Command-type runner for `agent-skill-drift-sync-heartbeat` (card 53fffd74). Runs the sync (safe
# under --apply by design); the routine verdict ALERT:no stays silent at zero tokens. Anything else,
# including a crash with no verdict line, is sent to MikroB, whose task prompt says how to report it.
set -uo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
out="$(bash "$S/agent-skill-drift-sync.sh" --apply --telegram 2>&1)"; rc=$?
last="$(printf '%s\n' "$out" | tail -1)"
case "$last" in
  ALERT:no*) exit 0 ;;
esac
bash "$S/sched-wake-mikrob.sh" agent-skill-drift-sync-heartbeat "rc=$rc. Kovesd a feladat SKILL.md ALERT:yes utmutatasat (Telegram Petinek). Kimenet vege:
$(printf '%s\n' "$out" | tail -40)"

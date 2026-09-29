#!/usr/bin/env bash
# Shared helper for command-type scheduled tasks (card 53fffd74): deliver a non-routine result to
# MikroB as an inter-agent message, so the LLM is woken only when there is something to act on.
# Usage: sched-wake-mikrob.sh <task-name> <text>   (text is sent verbatim, JSON-encoded by python)
set -uo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
task="$1"; text="$2"
payload="$(TASK="$task" TEXT="$text" python3 -c 'import json,os; print(json.dumps({"from":"mikrob","to":"mikrob","content":"[SCHED-ALERT "+os.environ["TASK"]+"] "+os.environ["TEXT"]}))')"
printf 'Authorization: Bearer %s\n' "$(cat "$S/.dashboard-token")" \
  | curl -sf -H @- -X POST http://localhost:3420/api/messages -H 'Content-Type: application/json' --data-binary "$payload" >/dev/null

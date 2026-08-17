#!/usr/bin/env bash
# local-llm-submit.sh -- general, card-independent async task-submit entry point for the
# local-LLM work queue (card 28c92213, Peti request 2026-08-16: "any task, not just kanban
# cards, should be submittable to the local LLM").
#
# WHY THIS EXISTS DESPITE local-llm-rag.sh ALREADY EXISTING: local-llm-rag.sh (and
# local-llm.sh underneath it) is SYNCHRONOUS -- the caller blocks 15-70s on the model. That is
# the fleet's default path for a bounded, in-the-moment sub-task (see the local-llm-offload
# skill). This script is the ASYNC alternative for the queue that already exists
# (src/local-llm-queue.ts, card defcc189) and is already drained by local-llm-worker.sh + the
# local-llm-worker-poke scheduled task -- but had NO safe CLI entry point of its own: the only
# way to reach `POST /api/local-llm/queue` before this script was a hand-rolled curl call, which
# is exactly the kind of thing that leaks the Bearer token into argv if done carelessly (see
# gate-ops-scripts-token-in-argv).
#
# THIS DOES NOT REPLACE offload-dispatch.sh. offload-dispatch.sh is MikroB's DISPATCH-TIME hook:
# it runs ONCE, automatically, the moment a kanban card is handed to an agent, and drafts the
# card's own mechanical sub-parts. This script is for ANY OTHER TIME an agent (or MikroB) wants
# to hand an ARBITRARY prompt to the local LLM -- mid-task, not tied to a dispatch event, with or
# without a card_id. The two can both fire for the same card without being a correctness bug:
# each queue row is independent and the worst case of an overlap is a little redundant GPU work,
# not wrong output (the `source` field on each row already distinguishes 'dispatch-offload' from
# an agent's own submission, so this is inspectable via /api/local-llm/queue/list if it ever
# becomes a real problem in practice).
#
# SECURITY-CATEGORY ROUTING IS UNCHANGED (card 28c92213 alfeladat 3): this script only ENQUEUES --
# it does not decide what the local model is trusted to run. The worker (local-llm-worker.sh)
# and the router underneath it (routeTask --auto) still apply the same category-based
# online/local decision as every other entry point; a security-decision-shaped prompt still goes
# online regardless of which script submitted it.
#
# USAGE:
#   local-llm-submit.sh --agent <name> [--card-id <id>] [--task-type <t>] [--template <t>]
#                        [--context <c>] [--priority low|normal|high|urgent] [--source <s>]
#                        "<prompt>"
#   echo "<prompt>" | local-llm-submit.sh --agent <name>          # prompt on stdin
#
# OUTPUT: the enqueued row's numeric id (and nothing else) on success, so it composes in scripts
# (`ID=$(local-llm-submit.sh ...)`). Human-readable status/template info goes to stderr.
# Poll the result later with local-llm-poll.sh <id>.
#
# Exit codes: 0 ok | 4 bad usage | 6 dashboard unreachable/token missing | 7 API rejected the call
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH_API="http://127.0.0.1:${WEB_PORT:-3420}/api/local-llm/queue"
TOKEN_FILE="${LOCAL_LLM_DASH_TOKEN_FILE:-$HERE/.dashboard-token}"

AGENT=""
CARD_ID=""
TASK_TYPE=""
TEMPLATE=""
CONTEXT=""
PRIORITY="normal"
SOURCE="agent"
PROMPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)     AGENT="$2"; shift 2 ;;
    --card-id)   CARD_ID="$2"; shift 2 ;;
    --task-type) TASK_TYPE="$2"; shift 2 ;;
    --template)  TEMPLATE="$2"; shift 2 ;;
    --context)   CONTEXT="$2"; shift 2 ;;
    --priority)  PRIORITY="$2"; shift 2 ;;
    --source)    SOURCE="$2"; shift 2 ;;
    --) shift; PROMPT="$*"; break ;;
    *) PROMPT="$1"; shift ;;
  esac
done

if [[ -z "$PROMPT" && ! -t 0 ]]; then
  PROMPT="$(cat)"
fi

if [[ -z "$AGENT" || -z "${PROMPT// }" ]]; then
  echo "usage: local-llm-submit.sh --agent <name> [--card-id <id>] [--task-type <t>] [--template <t>] [--context <c>] [--priority low|normal|high|urgent] [--source <s>] \"<prompt>\"" >&2
  exit 4
fi

if [[ ! -r "$TOKEN_FILE" ]]; then
  echo "local-llm-submit: dashboard token not readable ($TOKEN_FILE) -- is the dashboard set up?" >&2
  exit 6
fi

# 0600 temp header file, never the token on the curl command line (same pattern as
# local-llm.sh's own queue self-registration and every other store/*.sh caller).
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
trap 'rm -f "$hdr_file"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE" 2>/dev/null)" > "$hdr_file"

BODY="$(AGENT="$AGENT" CARD_ID="$CARD_ID" TASK_TYPE="$TASK_TYPE" TEMPLATE="$TEMPLATE" \
        CONTEXT="$CONTEXT" PRIORITY="$PRIORITY" SOURCE="$SOURCE" PROMPT="$PROMPT" python3 -c '
import json, os
def opt(k):
    v = os.environ.get(k, "")
    return v if v else None
print(json.dumps({
    "agent": os.environ["AGENT"],
    "prompt": os.environ["PROMPT"],
    "card_id": opt("CARD_ID"),
    "task_type": opt("TASK_TYPE"),
    "template": opt("TEMPLATE"),
    "context": opt("CONTEXT"),
    "priority": os.environ.get("PRIORITY") or "normal",
    "source": os.environ.get("SOURCE") or "agent",
}))
')"

RESP="$(curl -fsS -m 10 -X POST "$DASH_API" \
  -H "@$hdr_file" -H "Content-Type: application/json" \
  --data-binary "$BODY" 2>/dev/null || true)"

if [[ -z "$RESP" ]]; then
  echo "local-llm-submit: dashboard unreachable or request failed" >&2
  exit 6
fi

ID="$(printf '%s' "$RESP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("id") or "")
except Exception: pass' 2>/dev/null || true)"

if [[ -z "$ID" ]]; then
  echo "local-llm-submit: API rejected the call: $RESP" >&2
  exit 7
fi

printf '%s' "$RESP" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(f"queued id={d.get(\"id\")} status={d.get(\"status\")} template={d.get(\"template\")}", file=sys.stderr)
except Exception:
    pass' 2>/dev/null || true

echo "$ID"

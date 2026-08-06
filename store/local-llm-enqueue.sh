#!/usr/bin/env bash
# local-llm-enqueue.sh -- hand a sub-task to the local 7B WITHOUT waiting for it (card defcc189).
#
# This is the non-blocking counterpart to local-llm.sh / local-llm-rag.sh. Those run the model in
# your process and you wait 15-70s for the answer. This one inserts a queue row and returns an id
# immediately, so you keep working online while the GPU chews on the sub-task in parallel. Pick the
# result up later with local-llm-queue-result.sh.
#
# WHEN TO USE WHICH:
#   need the answer to continue right now   -> local-llm-rag.sh (synchronous, unchanged)
#   can carry on and collect it later       -> THIS
#
# The draft is still DRAFT-ONLY: you review and integrate it, and the gate re-checks. Nothing the
# local model writes ships unverified.
#
# NO SECRETS IN ARGV: the token is passed to curl via a 0600 header FILE (-H @file), never on the
# command line -- see the header-file block below for why reading it from a file is not sufficient.
# The PROMPT is passed on stdin or as one argument; it is sent as a JSON body, never interpolated
# into a shell command.
#
# Usage:
#   local-llm-enqueue.sh --agent backend --prompt "write a zod schema for ..."
#   echo "long prompt" | local-llm-enqueue.sh --agent backend
#   local-llm-enqueue.sh --agent qa --card 1a2b3c4d --task test-scaffold --priority high --prompt "..."
#
# Prints the queue id on stdout (nothing else), so it is safe to capture:
#   ID=$(store/local-llm-enqueue.sh --agent backend --prompt "...")
#
# Exit: 0 ok | 2 bad usage | 3 API unreachable
set -uo pipefail

ROOT="/home/neon/marveen"
API="http://127.0.0.1:${WEB_PORT:-3420}/api"
TOKEN_FILE="$ROOT/store/.dashboard-token"

die() { echo "local-llm-enqueue.sh: $2" >&2; exit "$1"; }

AGENT=""; PROMPT=""; CARD=""; TASK=""; PRIORITY="normal"; SOURCE="agent"; CONTEXT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --agent)    AGENT="${2:-}"; shift 2 ;;
    --prompt)   PROMPT="${2:-}"; shift 2 ;;
    --card)     CARD="${2:-}"; shift 2 ;;
    --task)     TASK="${2:-}"; shift 2 ;;
    --priority) PRIORITY="${2:-}"; shift 2 ;;
    --source)   SOURCE="${2:-}"; shift 2 ;;
    --context)  CONTEXT="${2:-}"; shift 2 ;;
    -h|--help)  sed -n '2,30p' "$0"; exit 0 ;;
    *)          die 2 "unknown argument '$1' (see --help)" ;;
  esac
done

[ -n "$AGENT" ] || die 2 "--agent is required"
# No prompt argument -> read stdin, so a long/multi-line prompt never has to fit in argv.
if [ -z "$PROMPT" ]; then
  [ -t 0 ] && die 2 "no prompt (pass --prompt or pipe via stdin)"
  PROMPT="$(cat)"
fi
[ -n "${PROMPT// }" ] || die 2 "empty prompt"
[ -r "$TOKEN_FILE" ] || die 3 "dashboard token unreadable ($TOKEN_FILE)"

# SECURITY (card defcc189, Cybersec NO-GO on bf6fe53): the Authorization header goes through a 0600
# temp file read with curl's `-H @file`, NEVER on the curl argv. `-H "Bearer $(cat token)"` is
# expanded by the shell BEFORE exec, so the token itself lands in /proc/<pid>/cmdline (world-readable
# here: no hidepid) and in `ps` -- any local user could scrape it during the call window, even one
# who cannot read the 0600 token file. Same pattern as store/weekly-usage-probe.sh.
HDR_FILE="$(mktemp)"
trap 'rm -f "$HDR_FILE"' EXIT
chmod 600 "$HDR_FILE"
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$HDR_FILE"


# Build the JSON in python, never by string-concatenation: the prompt is arbitrary text and would
# otherwise break the payload (quotes/newlines) or, worse, be interpolated by the shell.
BODY=$(AGENT="$AGENT" PROMPT="$PROMPT" CARD="$CARD" TASK="$TASK" PRIORITY="$PRIORITY" SOURCE="$SOURCE" CONTEXT="$CONTEXT" python3 -c '
import json, os
d = {"agent": os.environ["AGENT"], "prompt": os.environ["PROMPT"], "priority": os.environ["PRIORITY"], "source": os.environ["SOURCE"]}
if os.environ.get("CARD"):    d["card_id"] = os.environ["CARD"]
if os.environ.get("TASK"):    d["template"] = os.environ["TASK"]
if os.environ.get("CONTEXT"): d["context"] = os.environ["CONTEXT"]
print(json.dumps(d))
') || die 2 "could not build request body"

# -f is deliberately NOT used: on a 4xx it would discard the body, and the body is where the API
# says WHAT was wrong (bad template name, missing agent). Distinguish "rejected" from "unreachable"
# instead of blaming the network for a validation error.
HTTP=$(printf '%s' "$BODY" | curl -sS -o /tmp/llmq-resp.$$ -w '%{http_code}' -X POST "$API/local-llm/queue" \
  -H "@$HDR_FILE" \
  -H 'Content-Type: application/json' \
  --data-binary @- 2>/dev/null)
RC=$?
RESP=$(cat /tmp/llmq-resp.$$ 2>/dev/null); rm -f /tmp/llmq-resp.$$
[ $RC -eq 0 ] || die 3 "dashboard API unreachable at $API (is the service running?)"
case "$HTTP" in
  2*) : ;;
  401|403) die 3 "rejected by the dashboard API (HTTP $HTTP): the token in $TOKEN_FILE is not accepted" ;;
  *)  ERRMSG=$(printf '%s' "$RESP" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("error","(no message)"))
except Exception: print("(unparseable response)")' 2>/dev/null)
      die 2 "the queue rejected this request (HTTP $HTTP): $ERRMSG" ;;
esac

printf '%s' "$RESP" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if "id" not in d:
    sys.stderr.write("local-llm-enqueue.sh: " + str(d.get("error", "no id in response")) + "\n")
    sys.exit(1)
print(d["id"])
'

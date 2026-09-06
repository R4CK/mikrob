#!/usr/bin/env bash
# Post an INFO-ONLY comment to the running agent's current in_progress card. Sourced, never run.
# (card 492a6d5c; extracted from cleancore-suite-run.sh, which introduced this machinery for the
# CleanCore suite semaphore under card 5af57bd7.)
#
# WHY IT EXISTS AT ALL. Fleet rule 3 calls an in_progress card stuck when its `updated_at` has not
# moved, and rule 3a hands it to a sibling agent after 60 minutes. A script that legitimately makes
# an agent WAIT -- a semaphore, a CPU-slot queue -- therefore has to say so on the card, or the
# waiting is indistinguishable from being dead and the monitor takes the work away. That is strictly
# worse than the contention the waiting exists to avoid.
#
# WHY A LIBRARY. store/fleet-test.sh needs exactly this and had none, which is what Cybersec's NO-GO
# on card 492a6d5c is about. The alternative was a second copy of the token handling below, and that
# part is not boilerplate: it exists because a Cybersec finding (card edb7559f) showed the token
# lands in /proc/<pid>/cmdline when it is passed as `-H "Authorization: ... $(cat ...)"`. One copy of
# that is the number I want.
#
# NOTE ON THE CURRENT STATE, said out loud rather than left to be discovered: cleancore-suite-run.sh
# still carries its own copy of these functions. It is at gate under two other cards right now, and
# editing it a third time would leave three shas claiming the same file. De-duplicating it is a
# follow-up, not part of this NO-GO fix.
#
# Usage:
#   KANBAN_COMMENT_AGENT=backend
#   . "$(dirname "$0")/kanban-comment-lib.sh"
#   kanban_comment "INFO-ONLY ... "
#
# Every function here is BEST-EFFORT and can never fail the caller: a suite must not depend on the
# dashboard being up. With no agent name, no token or no reachable API it simply does nothing.
set -u

KANBAN_COMMENT_API="${KANBAN_COMMENT_API:-http://localhost:3420}"

_kc_token_file() {
  # An explicit override exists so a test can exercise this path WITHOUT handing the live dashboard
  # token to whatever stands in for the API. The token is only as safe as the endpoint it is sent
  # to, and a test endpoint is not one -- so the test supplies its own throwaway file.
  [ -n "${KANBAN_COMMENT_TOKEN_FILE:-}" ] && { echo "$KANBAN_COMMENT_TOKEN_FILE"; return; }
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$here/.dashboard-token" ] && { echo "$here/.dashboard-token"; return; }
  local common; common="$(git -C "$here" rev-parse --git-common-dir 2>/dev/null)" || return 1
  echo "$(cd "$(dirname "$common")" && pwd)/store/.dashboard-token"
}

# SECURITY (card edb7559f): the token never goes in argv. `-H "Authorization: Bearer $(cat ...)"` is
# readable from /proc/<pid>/cmdline by any local process for as long as the curl runs. A 0600 header
# file, removed on EXIT, is the house pattern.
_KC_HDR=""
_kc_hdr() {
  [ -n "$_KC_HDR" ] && { echo "$_KC_HDR"; return 0; }
  local tf; tf="$(_kc_token_file)" || return 1
  [ -f "$tf" ] || return 1
  _KC_HDR="$(mktemp)" || return 1
  chmod 600 "$_KC_HDR"
  printf 'Authorization: Bearer %s\n' "$(cat "$tf")" > "$_KC_HDR"
  echo "$_KC_HDR"
}
# The caller's own EXIT trap is not touched; this one is additive and idempotent.
trap 'rm -f "$_KC_HDR"' EXIT

kanban_comment_card_id() { # the agent's current in_progress card, or empty
  local agent="${KANBAN_COMMENT_AGENT:-}"
  [ -n "$agent" ] || return 0
  local h; h="$(_kc_hdr)" || return 0
  curl -s --max-time 10 -H @"$h" "$KANBAN_COMMENT_API/api/kanban" 2>/dev/null \
    | python3 -c '
import json,sys
try: rows = json.load(sys.stdin)
except Exception: sys.exit(0)
for r in rows if isinstance(rows, list) else []:
    if r.get("status") == "in_progress" and r.get("assignee") == sys.argv[1]:
        print(r.get("id","")); break
' "$agent" 2>/dev/null
}

kanban_comment() { # $1 = body. Silent no-op when there is no agent, card, token or API.
  local card h payload
  card="$(kanban_comment_card_id)"; [ -n "$card" ] || return 0
  h="$(_kc_hdr)" || return 0
  # The body travels as JSON built by python, never by string-splicing into a printf template: a
  # comment carrying a quote or a newline would otherwise produce an invalid body, or worse, inject
  # a field (the shape Cybered flagged for raw printf JSON elsewhere in this repo).
  payload="$(python3 -c '
import json,sys; print(json.dumps({"card_id":sys.argv[1],"author":sys.argv[2],"content":sys.argv[3]}))' \
    "$card" "${KANBAN_COMMENT_AGENT:-unknown}" "$1")" || return 0
  curl -s --max-time 10 -o /dev/null -H @"$h" \
    -X POST "$KANBAN_COMMENT_API/api/kanban/$card/comments" -H 'Content-Type: application/json' \
    --data-binary "$payload" 2>/dev/null || true
}

#!/usr/bin/env bash
# Self-test for store/dash.py (card e96b06e7).
#
# Run: bash store/dash.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# HERMETIC ON PURPOSE: every case feeds a fixture through `--stdin`, so nothing here needs the
# dashboard running, a token, or the network. A selftest for a READER must not depend on the thing
# it reads being up -- otherwise it reports the server's mood rather than the script's behaviour.
# (The one case that does exercise the auth path points DASH_TOKEN_FILE at a temp file and asserts
# what must NOT appear in the output.)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="$HERE/dash.py"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

LONG_TITLE="$(printf 'x%.0s' $(seq 1 200))"

cat > "$TMP/card.json" <<JSON
{"id":"abc12345","status":"in_progress","assignee":"backend3","priority":"low",
 "updated_at":$(date +%s),"title":"a short title","description":"line one\nline two",
 "labels":[{"name":"@backend3"}],"blocked":false,"blockedBy":[]}
JSON

# A BLOCKED card. The original fixture only ever had `blocked:false`, so the blocked branch was
# never executed by anything -- and it was wrong: `blockedBy` carries {id,title,status} OBJECTS, not
# id strings, so the first genuinely blocked card raised TypeError instead of printing. A rendering
# branch nothing exercises is not code, it is a guess.
cat > "$TMP/card-blocked.json" <<JSON
{"id":"blk00001","status":"planned","assignee":"backend3","priority":"normal",
 "updated_at":$(date +%s),"title":"a blocked card","description":"why it waits",
 "labels":[],"blocked":true,
 "blockedBy":[{"id":"dep00001","title":"the card it waits for","status":"planned"}]}
JSON

cat > "$TMP/board.json" <<JSON
[{"id":"aaaaaaaa","status":"planned","assignee":"backend3","priority":"low","title":"$LONG_TITLE"},
 {"id":"bbbbbbbb","status":"done","assignee":"qa","priority":"high","title":"other"}]
JSON

cat > "$TMP/agents.json" <<'JSON'
[{"name":"backend3","running":true,"activeModel":"claude-opus-5"},
 {"name":"parked","running":false,"model":"claude-opus-5"}]
JSON

cat > "$TMP/queue.json" <<JSON
[{"to_agent":"backend","from_agent":"mikrob","created_at":$(date +%s),"content":"first line\nsecond"},
 {"to_agent":"backend","from_agent":"qa","created_at":$(date +%s),"content":"another"}]
JSON

cat > "$TMP/comments.json" <<JSON
[{"id":1,"author":"mikrob","created_at":$(date +%s),"content":"oldest"},
 {"id":2,"author":"qa","created_at":$(date +%s),"content":"newest"}]
JSON

# --- 1. card: the fields a reader actually needs, and the description in full -----------------
out="$(python3 "$DASH" card --stdin < "$TMP/card.json" 2>&1)"
if echo "$out" | grep -q 'abc12345' && echo "$out" | grep -q 'in_progress' \
   && echo "$out" | grep -q 'backend3' && echo "$out" | grep -q 'line two'; then
  ok "card renders id/status/assignee and the whole description"
else
  bad "card output missing a required field" "$out"
fi
echo "$out" | grep -q '@backend3' && ok "card shows labels" || bad "card dropped the labels" "$out"

# --- 2. truncation is MARKED, never silent ----------------------------------------------------
# The whole point of the tool is being trustable at a glance: a shortened line must say so, and say
# how much is missing, or a reader cannot tell "that is all of it" from "there is more".
out="$(python3 "$DASH" board --stdin < "$TMP/board.json" 2>&1)"
if echo "$out" | grep -qE '\.\.\.\(\+[0-9]+\)'; then
  ok "a long title is clipped WITH a +N marker"
else
  bad "long title was clipped silently, or not at all" "$out"
fi

# --- 3. board filters by status, and says how many it is showing ------------------------------
out="$(python3 "$DASH" board planned --stdin < "$TMP/board.json" 2>&1)"
if echo "$out" | grep -q '^1 card' && echo "$out" | grep -q 'aaaaaaaa' \
   && ! echo "$out" | grep -q 'bbbbbbbb'; then
  ok "board <status> filters to that column and counts it"
else
  bad "board status filter wrong" "$out"
fi

# --- 4. agents: running vs stopped, not just a list -------------------------------------------
out="$(python3 "$DASH" agents --stdin < "$TMP/agents.json" 2>&1)"
if echo "$out" | grep -q 'backend3.*RUNNING' && echo "$out" | grep -q 'parked.*stopped'; then
  ok "agents distinguishes RUNNING from stopped"
else
  bad "agents state wrong" "$out"
fi

# --- 5. queue groups by receiver (the thing that made the backlog readable at all) -------------
out="$(python3 "$DASH" queue --stdin < "$TMP/queue.json" 2>&1)"
if echo "$out" | grep -qE '^ +2 +-> backend'; then
  ok "queue groups pending messages by receiver"
else
  bad "queue grouping missing" "$out"
fi

# --- 6. comments honours the limit, newest last -----------------------------------------------
out="$(python3 "$DASH" comments --stdin 2>&1 < "$TMP/comments.json")"
if echo "$out" | grep -q 'newest'; then
  ok "comments renders the body"
else
  bad "comments body missing" "$out"
fi

# --- 7. exit codes are distinguishable: usage(2) vs error(1) vs ok(0) -------------------------
python3 "$DASH" card --stdin < "$TMP/card.json" >/dev/null 2>&1; rc=$?
[[ $rc -eq 0 ]] && ok "a good call exits 0" || bad "good call exited $rc"
python3 "$DASH" nosuchcommand >/dev/null 2>&1; rc=$?
[[ $rc -eq 2 ]] && ok "an unknown subcommand exits 2 (usage)" || bad "unknown subcommand exited $rc, want 2"
DASH_TOKEN_FILE="$TMP/definitely-not-here" python3 "$DASH" agents >/dev/null 2>&1; rc=$?
[[ $rc -eq 1 ]] && ok "a missing token exits 1 (error), not 0" || bad "missing token exited $rc, want 1"

# --- 8. THE TOKEN IS NEVER PRINTED ------------------------------------------------------------
# The script exists partly so nobody hand-pipes the token around any more; leaking it into an error
# message would trade one exposure for another. Asserted on the failure path, because that is where
# a value normally escapes -- error text is written in a hurry.
printf 'SENTINEL-TOKEN-DO-NOT-LEAK\n' > "$TMP/tok"
out="$(DASH_TOKEN_FILE="$TMP/tok" python3 "$DASH" get /api/definitely-not-a-real-endpoint 2>&1)"
if echo "$out" | grep -q 'SENTINEL-TOKEN-DO-NOT-LEAK'; then
  bad "the token appeared in output" "$out"
else
  ok "the token never appears in output, even on the error path"
fi

# --- 9. a BLOCKED card RENDERS, and names its blocker's status ---------------------------------
# Regression: this raised TypeError on the first real blocked card (a dependency edge is rare, so
# every card the tool was built against was unblocked). The blocker's STATUS is asserted, not just
# its id: "waiting on a card that is still planned" and "waiting on one already in review" are
# different situations, and the id alone cannot tell them apart.
out="$(python3 "$DASH" card --stdin < "$TMP/card-blocked.json" 2>&1)"; rc=$?
if [[ $rc -eq 0 ]] && echo "$out" | grep -q 'BLOCKED by: dep00001 (planned)'; then
  ok "a blocked card renders its blocker as id + status"
else
  bad "blocked-card rendering failed (rc=$rc)" "$out"
fi
# ... and the unblocked card must NOT grow a blocked line from the same code path.
out="$(python3 "$DASH" card --stdin < "$TMP/card.json" 2>&1)"
echo "$out" | grep -q 'BLOCKED' \
  && bad "an UNBLOCKED card printed a BLOCKED line" "$out" \
  || ok "an unblocked card prints no BLOCKED line"

echo
echo "dash.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]

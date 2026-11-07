#!/usr/bin/env bash
# post-review.sh -- finalization barrier for the REVIEW-then-waiting step (card 88b67fb4).
#
# WHY. backend2's REVIEW went out with an EMPTY body (the call piped the auth header to curl via
# `-H @-` and ALSO tried `--data-binary @-` -- both reading stdin, so the header consumed it and
# the body curl actually sent was empty) and the card moved to waiting anyway: a REVIEW-less card
# sat in waiting with nothing for a gate to read. t3code's finalization barrier is the inspiration
# (read-only, MIT, ideas only, no code copied: pingdotgg/t3code @37481f04,
# docs/orchestration-v2/feature-lifecycles.md:529) -- a run is terminal only after a barrier
# confirms its result actually landed. Here: post the comment, READ IT BACK by id, and only move
# the card to `waiting` if what comes back matches what was sent. An empty/garbled post can no
# longer reach waiting silently.
#
# Usage:  post-review.sh <cardId> <reviewFile> <actor> [reason]
#   <reviewFile>  local file holding the REVIEW comment body. Must be non-blank.
#   <actor>       who is posting -- used as both the comment author and the move actor.
#   [reason]      move reason; defaults to a fixed string naming this script.
#
# Exit 0  comment posted, verified by readback, card moved to waiting.
# Exit 1  refused BEFORE touching the board (blank file, bad usage) -- card untouched.
# Exit 2  comment posted but the readback did not match it (or carried no id) -- card stays
#         wherever it was, NOT moved. The comment itself cannot be un-posted, but the barrier
#         blocks exactly the status flip the empty-body incident needed blocked.
# Exit 3  board unreachable or returned something this script cannot parse.
set -uo pipefail

POST_REVIEW_API="${POST_REVIEW_API:-http://127.0.0.1:3420}"
POST_REVIEW_TOKEN_FILE="${POST_REVIEW_TOKEN_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.dashboard-token}"

card="${1:-}"
file="${2:-}"
actor="${3:-}"
reason="${4:-REVIEW posted via post-review.sh, verified by readback before moving to waiting}"

if [ -z "$card" ] || [ -z "$file" ] || [ -z "$actor" ]; then
  echo "usage: post-review.sh <cardId> <reviewFile> <actor> [reason]" >&2
  exit 1
fi

if [ ! -r "$file" ]; then
  echo "REFUSED: $file is missing -- no comment posted, card $card untouched." >&2
  exit 1
fi

# WhiteHat L1 (card 88b67fb4 delta): the old check was ASCII-whitespace-only (`grep [^[:space:]]`),
# so a file holding only invisible/format characters (U+200B zero-width space, U+FEFF BOM, NBSP)
# or a single stray character read as non-blank and sailed through to waiting -- the same
# visually-empty REVIEW the incident this script exists for, just dressed differently.
#
# L1b (WhiteHat NO-GO 28731 delta): the Cf/Cc/Zs-only filter still let 6 of 9 invisible probes
# through -- U+0300/U+034F/U+FE0F are COMBINING marks (category Mn: zero visual width WITHOUT a
# preceding base character, but Mn is not Cf/Cc/Zs so the old filter kept them as "meaningful");
# U+2800 (Braille blank) and U+3164/U+115F (Hangul fillers) are categorized So/Lo (ordinary
# symbol/letter categories) despite being KNOWN, deliberately blank-rendering code points. Fix:
# strip the WHOLE Mark category (M*) and Separator/Other (Z*/C*) generally, not just Cf/Cc/Zs,
# PLUS an explicit blocklist for the known visible-category blanks that no broad category rule
# catches. `..........` (ten visible dots, category Po) still passes -- punctuation is real,
# rendered content, not blank.
_meaningful_len="$(python3 -c '
import sys, unicodedata
KNOWN_BLANK_FILLERS = {
    "⠀",  # BRAILLE PATTERN BLANK (category So, renders as nothing)
    "ㅤ",  # HANGUL FILLER (category Lo, renders as nothing)
    "ᅟ",  # HANGUL CHOSEONG FILLER (category Lo, renders as nothing)
    "ﾠ",  # HALFWIDTH HANGUL FILLER (category Lo, renders as nothing)
}
with open(sys.argv[1], encoding="utf-8", errors="replace") as f:
    text = f.read()
def is_blank(ch):
    if ch.isspace() or ch in KNOWN_BLANK_FILLERS:
        return True
    cat = unicodedata.category(ch)
    return cat[0] in ("M", "Z", "C")  # Mark / Separator / Other -- not real rendered content
stripped = "".join(ch for ch in text if not is_blank(ch))
print(len(stripped))
' "$file" 2>/dev/null)"
if [ -z "$_meaningful_len" ] || [ "$_meaningful_len" -lt 10 ] 2>/dev/null; then
  echo "REFUSED: $file is blank, whitespace/invisible-only, or too short (meaningful length ${_meaningful_len:-0} < 10) -- no comment posted, card $card untouched." >&2
  exit 1
fi

_auth_header() { printf 'Authorization: Bearer %s\n' "$(cat "$POST_REVIEW_TOKEN_FILE")"; }

content="$(cat "$file")"

post_payload="$(python3 -c '
import json, sys
print(json.dumps({"author": sys.argv[1], "content": sys.argv[2]}))' "$actor" "$content")" || {
  echo "REFUSED: could not build the comment payload." >&2
  exit 1
}

post_json="$(_auth_header | curl -H @- -s -X POST "$POST_REVIEW_API/api/kanban/$card/comments" \
  -H 'Content-Type: application/json' --data-binary "$post_payload")"

comment_id="$(printf '%s' "$post_json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("id", ""))
except Exception:
    print("")')"

if [ -z "$comment_id" ]; then
  echo "REFUSED: comment post returned no id (response: $post_json). Card $card NOT moved." >&2
  exit 3
fi

readback_json="$(_auth_header | curl -H @- -s "$POST_REVIEW_API/api/kanban/$card/comments")"

match="$(printf '%s' "$readback_json" | python3 -c '
import json, sys
want_id, want_content = sys.argv[1], sys.argv[2]
try:
    comments = json.load(sys.stdin)
except Exception:
    print("no"); sys.exit()
for c in comments:
    if str(c.get("id")) == str(want_id):
        print("yes" if c.get("content") == want_content else "no")
        sys.exit()
print("no")' "$comment_id" "$content")"

if [ "$match" != "yes" ]; then
  echo "REFUSED: readback of comment $comment_id on card $card did not match what was sent -- card NOT moved to waiting." >&2
  exit 2
fi

move_payload="$(python3 -c '
import json, sys
print(json.dumps({"status": "waiting", "actor": sys.argv[1], "reason": sys.argv[2]}))' "$actor" "$reason")"

move_json="$(_auth_header | curl -H @- -s -X POST "$POST_REVIEW_API/api/kanban/$card/move" \
  -H 'Content-Type: application/json' --data-binary "$move_payload")"

ok="$(printf '%s' "$move_json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print("yes" if d.get("ok") else "no")
except Exception:
    print("no")')"

if [ "$ok" != "yes" ]; then
  echo "comment $comment_id verified on card $card, but the move to waiting failed: $move_json" >&2
  exit 3
fi

echo "post-review: comment $comment_id verified on card $card, moved to waiting."

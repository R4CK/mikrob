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
# GATE-SHA VALIDATION (card 2a15eb5f, 88b67fb4 S1 follow-up). WhiteHat S1 (comment 28612): this
# script used to exit 0 and move the card to waiting no matter what the `Gate-SHA:` line said --
# a nonexistent sha, an unlanded sha, another card's id mistaken for a sha, or a body with no
# Gate-SHA line at all all sailed through (45a45700's REVIEW named the wrong merge, ed13f8548,
# and only QA caught it afterwards). Now, before posting:
#   - no `Gate-SHA:` line at all                -> REFUSE (exit 1), unless rule 4e's explicit
#                                                   `Gate-SHA: n/a (config-only)` is present.
#   - the value has no sha and isn't `n/a ...`  -> REFUSE (exit 1).
#   - a named sha does not exist as a commit in either clone (includes a kanban card id
#     mistaken for a sha -- same shape, never a commit) -> REFUSE (exit 1).
#   - a named sha exists but is not yet an ancestor of its repo's landed branch (unlanded)
#     -> WARNING only (card-mode gate REVIEWs legitimately name a commit before it lands).
#   - a named sha's diff touches none of the files any other commit mentioning this card id
#     ever touched -> WARNING only (weak signal, not proof of a wrong sha).
# Lookup is by gate-sha-repo.sh (cat-file -e against both clones), not by declaration.
#
# Exit 0  comment posted, verified by readback, card moved to waiting.
# Exit 1  refused BEFORE touching the board (blank file, bad usage, failed Gate-SHA validation)
#         -- card untouched.
# Exit 2  comment posted but the readback did not match it (or carried no id) -- card stays
#         wherever it was, NOT moved. The comment itself cannot be un-posted, but the barrier
#         blocks exactly the status flip the empty-body incident needed blocked.
# Exit 3  board unreachable or returned something this script cannot parse.
set -uo pipefail

POST_REVIEW_API="${POST_REVIEW_API:-http://127.0.0.1:3420}"
POST_REVIEW_TOKEN_FILE="${POST_REVIEW_TOKEN_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.dashboard-token}"
GATE_SHA_REPO_SCRIPT="${GATE_SHA_REPO_SCRIPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gate-sha-repo.sh}"

# Which branch counts as "landed" for a repo gate-sha-repo.sh names.
_landed_branch_for() {
  case "$1" in
    marveen) echo "origin/develop" ;;
    cleancore) echo "origin/main" ;;
    *) echo "" ;;
  esac
}

# Validates the `Gate-SHA:` line in $1 (the review body) for card $2. Prints REFUSED/WARNING
# lines to stderr. Returns 1 on anything that must block the post, 0 otherwise (including when
# only warnings were printed).
validate_gate_sha() {
  local content="$1" card="$2" line value
  line="$(printf '%s\n' "$content" | grep -m1 '^[[:space:]]*Gate-SHA:')"
  if [ -z "$line" ]; then
    echo "REFUSED: no 'Gate-SHA:' line found in the review body (rule 4b/4e) -- card $card untouched." >&2
    return 1
  fi
  value="$(printf '%s' "$line" | sed -E 's/^[[:space:]]*Gate-SHA:[[:space:]]*//')"
  case "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" in
    n/a*) return 0 ;;  # explicit config-only per rule 4e -- nothing to validate
  esac
  local shas; shas="$(printf '%s' "$value" | grep -oE '[0-9a-fA-F]{7,40}' || true)"
  if [ -z "$shas" ]; then
    echo "REFUSED: Gate-SHA line has no sha and no 'n/a' marker ('$value') -- card $card untouched." >&2
    return 1
  fi
  local sha repo rc branch repo_path card_files diff_files overlap
  for sha in $shas; do
    repo="$("$GATE_SHA_REPO_SCRIPT" "$sha" 2>/dev/null)"; rc=$?
    if [ "$rc" -eq 4 ]; then
      echo "REFUSED: Gate-SHA $sha is a kanban CARD ID, not a commit ($repo) -- card $card untouched." >&2
      return 1
    fi
    if [ "$rc" -ne 0 ]; then
      echo "REFUSED: Gate-SHA $sha does not exist as a commit in any known repo -- card $card untouched." >&2
      return 1
    fi
    branch="$(_landed_branch_for "$repo")"
    repo_path="$("$GATE_SHA_REPO_SCRIPT" "$sha" --path 2>/dev/null)"
    [ -n "$branch" ] && [ -n "$repo_path" ] || continue
    if ! git -C "$repo_path" merge-base --is-ancestor "$sha" "$branch" 2>/dev/null; then
      echo "WARNING: Gate-SHA $sha ($repo) is not yet an ancestor of $branch -- unlanded. Card-mode gate REVIEWs may legitimately name this; verify by hand." >&2
    fi
    card_files="$(git -C "$repo_path" log --all --grep="$card" --name-only --pretty=format: 2>/dev/null | sed '/^$/d' | sort -u)"
    if [ -n "$card_files" ]; then
      diff_files="$(git -C "$repo_path" show --name-only --pretty=format: "$sha" 2>/dev/null | sed '/^$/d' | sort -u)"
      overlap="$(comm -12 <(printf '%s\n' "$card_files") <(printf '%s\n' "$diff_files"))"
      if [ -z "$overlap" ]; then
        echo "WARNING: Gate-SHA $sha ($repo) touches none of the files any other commit mentioning card $card ever touched -- possibly the wrong sha." >&2
      fi
    fi
  done
  return 0
}

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
    # Card 9d1ee327 (CYBERSEC NO-GO 28823 LOW item 4): three more blank-rendering code points
    # that still passed the old filter -- none are Mark/Separator/Other, so the broad category
    # rule in is_blank() below never caught them either.
    "ᅠ",  # HANGUL JUNGSEONG FILLER (category Lo, renders as nothing, same family as above)
    "￼",  # OBJECT REPLACEMENT CHARACTER (category So, placeholder for an embedded object --
               # renders as nothing/an invisible anchor, not visible text)
    "\U0001D159",  # MUSICAL SYMBOL NULL NOTEHEAD (category So, a deliberately blank glyph)
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

validate_gate_sha "$content" "$card" || exit 1

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

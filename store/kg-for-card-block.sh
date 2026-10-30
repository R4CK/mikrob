#!/usr/bin/env bash
# MT-07 (card 1a350f22, MikroB decision comment 26148): one shared helper that builds the framed,
# escaped, KG_INJECT_MAX_CHARS-capped "Megoldás-tár" block for a kanban card. Both
# store/self-advance-pickup.sh (automated self-advance) and MikroB's own manual dispatch messages
# call this SAME script, so the injection-framing logic (EK-MT-9) is implemented and tested once.
#
# BEHIND KG_INJECT_ENABLED, DEFAULT OFF: reads the flag FIRST, before any network call. Off means
# this script prints nothing and exits 0 -- the caller's own output stays byte-identical to the
# pre-MT-07 state (EK-MT-7). This follows the existing shell convention (store/kg-check-landing.sh
# reads KG_ENABLED the same way, straight off the process environment, not through settings-store).
#
# FAIL SILENT-CLOSED: any error (missing token, unreachable API, malformed JSON, empty package)
# prints NOTHING and exits 0. A broken KG lookup must never block whatever is calling this script
# (card pickup, a dispatch message) -- same posture as every other best-effort hook in this fleet
# (e.g. scripts/hooks/memory-lookup-nudge.py's own stated contract).
#
# FRAMING (EK-MT-9): the block is built ENTIRELY in memory, with marker balance verified, before
# ANYTHING is printed -- never streamed/printed incrementally. Any text inside a node's own
# title/body/why that looks like it is trying to close the frame is escaped first, so an
# adversarial snippet (a prior REVIEW comment, say) cannot inject instructions as if they came
# from this block's own wrapper, nor terminate the frame early.
set -euo pipefail

usage() {
  echo "usage: kg-for-card-block.sh <cardId>" >&2
  exit 2
}

[ $# -eq 1 ] || usage
CARD_ID="$1"

# Card id shape guard, same pattern as kg-search.sh's input checks -- refuse anything that is not
# plausibly a kanban card id rather than feeding an unchecked string into a URL path segment.
if ! printf '%s' "$CARD_ID" | grep -Eq '^[0-9a-zA-Z_-]{1,64}$'; then
  exit 0
fi

# KG_INJECT_ENABLED gate -- FIRST, before anything else. Off (the default, unset counts as off)
# means exit now: no HTTP call, no token read, no output.
if [ "${KG_INJECT_ENABLED:-off}" != "on" ]; then
  exit 0
fi

KG_API="${KG_FOR_CARD_API:-http://localhost:3420}"
if ! [[ "$KG_API" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$ ]]; then
  exit 0
fi

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="$HERE/.dashboard-token"
[ -f "$TOKEN_FILE" ] || exit 0

RESPONSE="$(printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" \
  | curl -s -H @- --max-time 5 "$KG_API/api/kg/for-card/$(printf '%s' "$CARD_ID" | python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=""))')" 2>/dev/null)" || exit 0
[ -n "$RESPONSE" ] || exit 0

MAX_CHARS="${KG_INJECT_MAX_CHARS:-3000}"

# The actual framing/escaping logic lives in a SEPARATE .py file (kg-for-card-block-render.py),
# not an inline heredoc: a heredoc attached to a command's own stdin REPLACES whatever is piped
# into that command, so `printf '%s' "$RESPONSE" | python3 - <<'EOF' ... EOF` would make the
# heredoc itself the script source and leave nothing on stdin for the script's own
# sys.stdin.read() to see -- $RESPONSE would never actually reach the renderer. A separate file
# removes the conflict entirely.
printf '%s' "$RESPONSE" | KG_FOR_CARD_MAX_CHARS="$MAX_CHARS" python3 -I "$HERE/kg-for-card-block-render.py" 2>/dev/null || exit 0

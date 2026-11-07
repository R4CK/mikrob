#!/usr/bin/env bash
# MT-07 (card 1a350f22, MikroB decision comment 26148): one shared helper that builds the framed,
# escaped, KG_INJECT_MAX_CHARS-capped "Megoldás-tár" block for a kanban card. Both
# store/self-advance-pickup.sh (automated self-advance) and MikroB's own manual dispatch messages
# call this SAME script, so the injection-framing logic (EK-MT-9) is implemented and tested once.
#
# BEHIND KG_INJECT_ENABLED, DEFAULT ON (card 70973ca7, Peti döntés 2026-11-07, Telegram 13239,
# matching the KG_INJECT_ENABLED registry default): reads the flag FIRST, before any network call
# that would fetch the actual for-card package. An explicit process-env value (set, even to an
# empty string) is a fast, zero-network override in EITHER direction -- off means this script
# prints nothing and exits 0, the caller's own output stays byte-identical to the pre-MT-07/no-KG
# state (EK-MT-7). WhiteHat NO-GO 28859 (card 6dfae8e7), F2: when NOTHING is set locally (the normal
# case -- nothing exports KG_INJECT_ENABLED before calling this script), the registry's effective
# KG_INJECT_ENABLED value IS now consulted via one GET /api/settings call -- previously the
# Settings-page toggle for this key did nothing at all, because no code anywhere read it.
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

# KG_INJECT_ENABLED gate -- FIRST, before anything else.
#
# WhiteHat NO-GO 28859 (card 6dfae8e7), F1: the old check only matched the exact strings "off"/"0"
# -- every other off-spelling (false/no/n/OFF/Off/disabled/empty/padded) fell through to the
# default and still printed the block. Fixed with the SAME allowlist the registry/route already use
# for KG_ENABLED (src/web/routes/kg.ts's TRUE_VALUES): trim + lowercase, and only 1/true/on count as
# on -- everything else (any spelling of off/false/no/0/disabled, or garbage) is off. This is an
# allowlist, not a blocklist, so it cannot be bypassed by a spelling nobody thought to list.
_kg_inject_is_on() {
  local v
  v="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  case "$v" in
    1|true|on) return 0 ;;
    *) return 1 ;;
  esac
}

KG_API="${KG_FOR_CARD_API:-http://localhost:3420}"
if ! [[ "$KG_API" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$ ]]; then
  exit 0
fi

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="$HERE/.dashboard-token"
[ -f "$TOKEN_FILE" ] || exit 0

# An explicit process-env value (set/unset is distinguished with the bash ${VAR+x} test, not
# ${VAR:-}, because an explicit empty string must still be read as "explicitly off" by the
# allowlist above, not treated as unset) is a fast, zero-network override in EITHER direction --
# the existing shell convention (kg-check-landing.sh reads KG_ENABLED the same way). Only when
# NOTHING is set locally do we fall through to the platform setting (next block): this is F2, the
# previously-missing reader for the KG_INJECT_ENABLED registry key, so the Settings-page toggle
# actually does something instead of being silently ignored.
if [ "${KG_INJECT_ENABLED+set}" = "set" ]; then
  _kg_inject_is_on "$KG_INJECT_ENABLED" || exit 0
else
  SETTINGS_RESPONSE="$(printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" \
    | curl -s -H @- --max-time 5 "$KG_API/api/settings" 2>/dev/null)" || SETTINGS_RESPONSE=""
  # Fail-silent-closed (same posture as every other error path in this script): if the setting
  # can't be read at all, treat injection as off rather than guessing it's on.
  EFFECTIVE_INJECT="$(printf '%s' "$SETTINGS_RESPONSE" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    for s in data.get("settings", []):
        if s.get("key") == "KG_INJECT_ENABLED":
            print(s.get("value", ""))
            break
except Exception:
    pass
' 2>/dev/null)"
  [ -n "$EFFECTIVE_INJECT" ] || exit 0
  _kg_inject_is_on "$EFFECTIVE_INJECT" || exit 0
fi

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

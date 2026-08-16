#!/usr/bin/env bash
# Sourceable: sets SESSION_LIMIT_RX from the canonical store/session-limit-pattern.json
# (card 115c21e7). `source` this instead of hand-copying the phrase alternation -- the JSON file
# has the provenance for every fragment. Usage:
#
#   . "$(dirname "${BASH_SOURCE[0]}")/session-limit-pattern.sh"
#   grep -qiE "$SESSION_LIMIT_RX" <<<"$pane"
#
# Exits (via `return 1` if sourced, `exit 1` if run directly) if the JSON is missing or python3
# cannot parse it -- fail LOUD here rather than silently handing every caller an empty pattern that
# would never match a real limit banner again.
_slp_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_LIMIT_PATTERN_JSON="${SESSION_LIMIT_PATTERN_JSON:-$_slp_dir/session-limit-pattern.json}"
SESSION_LIMIT_RX="$(python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
print("|".join(data["fragments"]))
' "$SESSION_LIMIT_PATTERN_JSON" 2>/dev/null)"
if [ -z "$SESSION_LIMIT_RX" ]; then
  echo "session-limit-pattern.sh: could not read fragments from $SESSION_LIMIT_PATTERN_JSON" >&2
  return 1 2>/dev/null || exit 1
fi
unset _slp_dir

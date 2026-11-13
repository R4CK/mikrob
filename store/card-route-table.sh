#!/usr/bin/env bash
# card-route-table.sh -- lookup helper for the F3 routing-table layer (card cdde2666, MikroB
# plan-grilling verdict comments 29500/29506). THIS CARD'S SCOPE IS SHADOW-LOGGING ONLY: this
# script answers "what chain WOULD a non-sensitive mechanical fragment of this type use", it does
# not call anything and does not decide what actually happens -- offload-dispatch.sh's
# card_route_shadow_log() is the only caller, and only logs the answer beside the legacy decision.
#
# Fail-safe direction: missing file, malformed JSON, or an unknown type all fall through to the
# "default" chain rather than erroring, because a lookup failure here can never be allowed to
# block a dispatch that doesn't even consult this file in legacy mode.
#
# Usage: card-route-table.sh --type <fragmentType>
# Prints the chain as a comma-separated list (e.g. "freellm,local,online"). Exit 0 always.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TABLE="${CARD_ROUTE_TABLE_FILE:-$HERE/card-route-table.json}"
FALLBACK="freellm,local,online"

if [[ "${1:-}" != "--type" ]]; then
  echo "usage: card-route-table.sh --type <fragmentType>" >&2
  exit 2
fi
TYPE="${2:-}"

python3 -c '
import json, sys
path, t, fallback = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
except Exception:
    print(fallback)
    raise SystemExit
if not isinstance(d, dict):
    print(fallback)
    raise SystemExit
types = d.get("types") if isinstance(d.get("types"), dict) else {}
chain = types.get(t)
if not isinstance(chain, list) or not chain:
    chain = d.get("default")
if not isinstance(chain, list) or not chain:
    print(fallback)
    raise SystemExit
print(",".join(str(x) for x in chain))
' "$TABLE" "$TYPE" "$FALLBACK"
exit 0

#!/usr/bin/env bash
# MT-04 (card 34c2d2a2): CLI wrapper around GET /api/kg/search and GET /api/kg/for-card/:id.
#
# BEHIND KG_ENABLED, DEFAULT OFF: the route itself answers 404 (kg_disabled) when the setting is
# off, same posture as every other MT-* entry point (kg-check-landing.sh, kg-backfill.sh) -- this
# script does not duplicate that check, it just surfaces the route's own answer.
#
# Token handling follows the CLAUDE.md house pattern (printf | curl -H @-): the dashboard token
# never goes into curl's argv (readable from /proc/<pid>/cmdline for as long as the process runs)
# and never touches disk at all -- it is piped straight into curl's stdin.
#
# WhiteHat NO-GO F1 MEDIUM (card 34c2d2a2, comment 24103): the earlier version wrote the token into
# a 0600 mktemp header file, "removed on EXIT" via a trap -- but the file was created inside
# `H="$(_hdr)"`, a command-substitution SUBSHELL, so `_HDR` was only ever set in that subshell; the
# parent's EXIT trap always saw `_HDR=""` and ran `rm -f ""`, leaking one token-bearing /tmp file
# per CLI invocation. Switching to the pipe pattern removes the temp file (and the trap) entirely,
# so there is nothing left to leak.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  kg-search.sh search --q <text> [--project <name|*|a,b>] [--card-id <id>] [--path <p>]...
                       [--k <n>] [--types <t,t,...>] [--strict] [--json]
  kg-search.sh for-card <cardId> [--k <n>] [--json]

Env:
  KG_SEARCH_API   dashboard base URL (default http://localhost:3420)
EOF
  exit 2
}

KG_SEARCH_API="${KG_SEARCH_API:-http://localhost:3420}"

# WhiteHat NO-GO F3 LOW (card 34c2d2a2, comment 24103): KG_SEARCH_API went straight into the
# request URL with the Bearer token attached, unchecked -- only http(s)://localhost or 127.0.0.1
# (with an optional port) is accepted, so an attacker-controlled env cannot redirect the token.
if ! [[ "$KG_SEARCH_API" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$ ]]; then
  echo "kg-search: KG_SEARCH_API must be http(s)://localhost[:port] or http(s)://127.0.0.1[:port], got: $KG_SEARCH_API" >&2
  exit 1
fi

_token_file() {
  local here; here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$here/.dashboard-token" ] && { echo "$here/.dashboard-token"; return 0; }
  return 1
}

TOKEN_FILE="$(_token_file)" || { echo "kg-search: no dashboard token file found" >&2; exit 1; }

# No temp file, no trap -- the token goes straight from the protected store/ file into curl's
# stdin via -H @-, the same pattern the root/backend CLAUDE.md prescribes for POSTs.
_curl_get() {
  printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" | curl -s --max-time 15 -H @- "$1"
}

_urlencode() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$1"; }

_pretty() {
  # --json (raw) or the default human summary, via python3 so the script has no jq dependency.
  if [ "$WANT_JSON" = "1" ]; then
    cat
    return 0
  fi
  python3 -c '
import json, sys
data = json.load(sys.stdin)
if "error" in data and "results" not in data and "solutions" not in data:
    print("error:", data["error"]); sys.exit(1)
if "results" in data:
    meta = data.get("meta", {})
    print(f"scope={meta.get(\"scope\")} hits={meta.get(\"hits\")} relaxed={meta.get(\"relaxed\")} strict={meta.get(\"strict\")}")
    for r in data["results"]:
        print(f"- [{r[\"type\"]}] {r[\"id\"]} (score={r[\"score\"]:.3f}, status={r[\"status\"]}) {r[\"title\"]}")
        print(f"    why: {r[\"why\"]}")
else:
    meta = data.get("meta", {})
    print(f"card={data.get(\"card_id\")} scope={meta.get(\"scope\")} chars={meta.get(\"chars\")} truncated={meta.get(\"truncated\")}")
    for key in ("solutions", "known_pitfalls", "decisions"):
        rows = data.get(key, [])
        print(f"{key} ({len(rows)}):")
        for r in rows:
            print(f"  - {r[\"card_id\"]} {r.get(\"verdict\") or \"\"} why={r[\"why\"]}")
    cross = data.get("cross_project_refs", [])
    if cross:
        print(f"cross_project_refs ({len(cross)}):")
        for r in cross:
            print(f"  - {r[\"card_id\"]} ({r[\"error_class\"]})")
'
}

cmd="${1:-}"
[ -n "$cmd" ] || usage
shift

WANT_JSON=0

case "$cmd" in
  search)
    Q="" PROJECT="" CARD_ID="" K="" TYPES="" STRICT=0
    PATHS=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --q) Q="$2"; shift 2 ;;
        --project) PROJECT="$2"; shift 2 ;;
        --card-id) CARD_ID="$2"; shift 2 ;;
        --path) PATHS+=("$2"); shift 2 ;;
        --k) K="$2"; shift 2 ;;
        --types) TYPES="$2"; shift 2 ;;
        --strict) STRICT=1; shift ;;
        --json) WANT_JSON=1; shift ;;
        *) usage ;;
      esac
    done
    [ -n "$Q" ] || [ "${#PATHS[@]}" -gt 0 ] || usage
    # WhiteHat NO-GO F3 LOW: --k was passed through unvalidated into the query string ("3&project=*"
    # would inject extra params); require plain digits.
    [ -z "$K" ] || [[ "$K" =~ ^[0-9]+$ ]] || { echo "kg-search: --k must be a positive integer" >&2; exit 2; }
    QS="strict=$([ "$STRICT" = 1 ] && echo 1 || echo 0)"
    [ -n "$Q" ] && QS="$QS&q=$(_urlencode "$Q")"
    [ -n "$PROJECT" ] && QS="$QS&project=$(_urlencode "$PROJECT")"
    [ -n "$CARD_ID" ] && QS="$QS&card_id=$(_urlencode "$CARD_ID")"
    [ -n "$K" ] && QS="$QS&k=$K"
    # WhiteHat NO-GO F5 LOW: the route reads repeated `types=` params (getAll), not a single
    # comma-joined value -- split so multiple --types values actually reach the route as multiple
    # types, instead of always 400 invalid_types.
    if [ -n "$TYPES" ]; then
      IFS=',' read -r -a _types_arr <<< "$TYPES"
      for t in "${_types_arr[@]}"; do
        QS="$QS&types=$(_urlencode "$t")"
      done
    fi
    for p in "${PATHS[@]+"${PATHS[@]}"}"; do
      QS="$QS&path=$(_urlencode "$p")"
    done
    _curl_get "$KG_SEARCH_API/api/kg/search?$QS" | _pretty
    ;;
  for-card)
    CARD="${1:-}"
    [ -n "$CARD" ] || usage
    shift
    K=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --k) K="$2"; shift 2 ;;
        --json) WANT_JSON=1; shift ;;
        *) usage ;;
      esac
    done
    [ -z "$K" ] || [[ "$K" =~ ^[0-9]+$ ]] || { echo "kg-search: --k must be a positive integer" >&2; exit 2; }
    QS=""
    [ -n "$K" ] && QS="?k=$K"
    # WhiteHat NO-GO F3 LOW: an unencoded CARD let `for-card '../../search?project=*'` reach a
    # different endpoint with the token attached.
    _curl_get "$KG_SEARCH_API/api/kg/for-card/$(_urlencode "$CARD")$QS" | _pretty
    ;;
  *) usage ;;
esac

#!/usr/bin/env bash
# MT-04 (card 34c2d2a2): CLI wrapper around GET /api/kg/search and GET /api/kg/for-card/:id.
#
# BEHIND KG_ENABLED, DEFAULT OFF: the route itself answers 404 (kg_disabled) when the setting is
# off, same posture as every other MT-* entry point (kg-check-landing.sh, kg-backfill.sh) -- this
# script does not duplicate that check, it just surfaces the route's own answer.
#
# Token handling follows kanban-comment-lib.sh's house pattern: the dashboard token never goes into
# curl's argv (readable from /proc/<pid>/cmdline for as long as the process runs) -- it goes into a
# 0600 header file, removed on EXIT.
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

_token_file() {
  local here; here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$here/.dashboard-token" ] && { echo "$here/.dashboard-token"; return 0; }
  return 1
}

_HDR=""
_hdr() {
  [ -n "$_HDR" ] && { echo "$_HDR"; return 0; }
  local tf; tf="$(_token_file)" || { echo "kg-search: no dashboard token file found" >&2; return 1; }
  _HDR="$(mktemp)"
  chmod 600 "$_HDR"
  printf 'Authorization: Bearer %s\n' "$(cat "$tf")" > "$_HDR"
  echo "$_HDR"
}
trap 'rm -f "$_HDR"' EXIT

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
    H="$(_hdr)"
    QS="strict=$([ "$STRICT" = 1 ] && echo 1 || echo 0)"
    [ -n "$Q" ] && QS="$QS&q=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$Q")"
    [ -n "$PROJECT" ] && QS="$QS&project=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$PROJECT")"
    [ -n "$CARD_ID" ] && QS="$QS&card_id=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$CARD_ID")"
    [ -n "$K" ] && QS="$QS&k=$K"
    [ -n "$TYPES" ] && QS="$QS&types=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$TYPES")"
    for p in "${PATHS[@]+"${PATHS[@]}"}"; do
      QS="$QS&path=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$p")"
    done
    curl -s --max-time 15 -H @"$H" "$KG_SEARCH_API/api/kg/search?$QS" | _pretty
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
    H="$(_hdr)"
    QS=""
    [ -n "$K" ] && QS="?k=$K"
    curl -s --max-time 15 -H @"$H" "$KG_SEARCH_API/api/kg/for-card/$CARD$QS" | _pretty
    ;;
  *) usage ;;
esac

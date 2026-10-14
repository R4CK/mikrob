#!/usr/bin/env bash
# pipx-version-check.sh -- PyPI version-drift check for pipx-adopted watched repos (card eedb2871).
#
# git-repo-watcher.sh only watches git CLONES (store/watched-repos.json entries with a "local"
# .git checkout). A pipx adoption (code-review-graph, graphify) has no checkout at all -- it is
# pinned to a PyPI package version instead -- so nothing ever checked these two entries. Measured
# on store/watched-repos-state.json before this script existed: both stuck at last_checked_at
# 2026-08-26, 7+ weeks stale, while every git-watched entry was at worst a few days old.
#
# Same posture as git-repo-watcher.sh's "code" branch: detect + flag, NEVER auto-bump. A version
# bump is a reviewed due-diligence decision (licence/CVE/changelog), made by hand via
# store/watched-repos-record-review.sh -- this script only stamps that the entry was LOOKED AT
# today, which is the actual freshness the card's success criterion asks for
# (/api/integrated-repos: every row's lastCheckedAt within 24h).
#
# Config: store/watched-repos.json entries with "adoption": "pipx".
# State: the SAME gitignored store/watched-repos-state.json external-repos-sync.sh and
# git-repo-watcher.sh both write to -- src/web/routes/integrated-repos.ts already merges
# last_checked_at in from there, so no reporting-side change was needed.
#
# Output (parsed the same way as git-repo-watcher.sh):
#   NOCHANGE:<name> @ <pinned_version>
#   DRIFT:<name>:<pinned_version>..<latest_version> FLAGGED-review-before-bump
#   ERROR:<reason>:<name>
#   final:  SUMMARY:checked=<n>:drift=<n>
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${PIPX_VERSION_CHECK_REGISTRY_JSON:-$HERE/watched-repos.json}"
STATE="${WATCHED_REPOS_STATE_JSON:-$HERE/watched-repos-state.json}"
# Selftest hook: a directory of <name>.json files shaped like PyPI's own `GET /pypi/<name>/json`
# response, used INSTEAD of a live network call when set -- same posture as
# ollama-boot-restore.sh's OLLAMA_RESTORE_*_OVERRIDE test hooks (a selftest never touches the
# real network).
PYPI_OVERRIDE_DIR="${PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR:-}"
CURL_TIMEOUT_S="${PIPX_VERSION_CHECK_TIMEOUT_S:-10}"

[[ -f "$CFG" ]] || { echo "SUMMARY:checked=0:drift=0 (no config $CFG)"; exit 0; }

checked=0; drift=0

mapfile -t ROWS < <(python3 -c '
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception as e: print("ERRCFG\t"+str(e)); sys.exit(0)
def safe(s):
    return str(s).replace("\t"," ").replace("\n"," ").replace("\r"," ")
for r in (d if isinstance(d,list) else []):
    if str(r.get("adoption","")) != "pipx": continue
    print("\t".join([safe(r.get("name","")), safe(r.get("pinned_version",""))]))
' "$CFG")

# Prints the latest version on stdout, exits nonzero (prints nothing) on any failure -- a
# malformed override fixture or an unreachable PyPI must never be read as "no drift".
fetch_latest_version() {
  local name="$1" raw
  if [[ -n "$PYPI_OVERRIDE_DIR" ]]; then
    [[ -f "$PYPI_OVERRIDE_DIR/$name.json" ]] || return 1
    raw="$(cat "$PYPI_OVERRIDE_DIR/$name.json" 2>/dev/null)" || return 1
  else
    raw="$(curl -fsSL --max-time "$CURL_TIMEOUT_S" "https://pypi.org/pypi/$name/json" 2>/dev/null)" || return 1
  fi
  python3 -c '
import json, sys
try:
    v = json.loads(sys.argv[1]).get("info", {}).get("version", "")
except Exception:
    sys.exit(1)
if not v:
    sys.exit(1)
print(v)
' "$raw"
}

write_back() { # $1=name $2=latest_version
  python3 - "$STATE" "$1" "$2" <<'PY'
import json, sys
from datetime import date

state_path, name, latest = sys.argv[1:4]
try:
    with open(state_path, encoding="utf-8") as f:
        state = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    state = {}
entry = state.get(name, {})
entry["last_checked_at"] = date.today().isoformat()
entry["pypi_latest_version"] = latest
state[name] = entry
with open(state_path, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
}

for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r name pinned <<<"$row"
  [[ "$name" == "ERRCFG" ]] && { echo "ERROR:config-parse"; continue; }
  [[ -z "$name" ]] && continue
  if [[ -z "$pinned" ]]; then echo "ERROR:badconfig:$name (no pinned_version recorded)"; continue; fi

  latest="$(fetch_latest_version "$name")" || { echo "ERROR:fetch:$name"; continue; }
  checked=$((checked+1))
  write_back "$name" "$latest"
  if [[ "$latest" == "$pinned" ]]; then
    echo "NOCHANGE:$name @ $pinned"
  else
    echo "DRIFT:$name:${pinned}..${latest} FLAGGED-review-before-bump"
    drift=$((drift+1))
  fi
done

echo "SUMMARY:checked=$checked:drift=$drift"

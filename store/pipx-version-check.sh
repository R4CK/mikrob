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

# Card eedb2871 live-run follow-up: the registry's "name" is a display/local name, not
# necessarily the PyPI distribution name -- measured on the real registry, "graphify" is pinned
# via pipx under the distribution "graphifyy" (per existing memory notes on its version bumps),
# so querying PyPI for "graphify" 404s forever and that row would never get a fresh stamp even
# with the wiring fixed. Optional "pypi_name" overrides the PyPI lookup only; the state-file key
# (and what /api/integrated-repos merges by) stays "name" so nothing downstream needs to change.
#
# Field order is name, pypi_name, pinned (pinned LAST) on purpose: with IFS set to only tab (a
# whitespace character), bash's `read` squeezes consecutive delimiters and strips a trailing
# empty field -- fine when the empty field is last, but an empty MIDDLE field silently shifts
# every field after it one slot to the left. pypi_name always falls back to a non-empty value
# (name), so pinned -- the one field that is legitimately sometimes empty (ERROR:badconfig
# below) -- is the only candidate, and it must stay last to avoid that shift.
mapfile -t ROWS < <(python3 -c '
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception as e: print("ERRCFG\t"+str(e)); sys.exit(0)
def safe(s):
    return str(s).replace("\t"," ").replace("\n"," ").replace("\r"," ")
for r in (d if isinstance(d,list) else []):
    if str(r.get("adoption","")) != "pipx": continue
    name = safe(r.get("name",""))
    pypi_name = safe(r.get("pypi_name","")) or name
    print("\t".join([name, pypi_name, safe(r.get("pinned_version",""))]))
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
  # Card eedb2871 L1 (WhiteHat2 gate, comment 19039): `latest` used to go straight from the PyPI
  # response into the state file and the DRIFT line with no validation at all. Measured: a
  # crafted "version" string injects extra fake output lines (parsed line-by-line downstream,
  # same contract as git-repo-watcher.sh's own header) or lands verbatim in the state file/kanban
  # card text (an indirect prompt-injection path). PyPI itself validates uploads against PEP 440,
  # so real exploitability is low, but the fix is one line: require the same conservative
  # allowlist + length cap git-repo-watcher.sh already uses for branch/sha -- anything else is
  # treated exactly like an unreachable PyPI (ERROR:fetch, no stamp), never silently accepted.
  # Measured on the live registry: graphifyy's PyPI response is 442KB -- passing it as an argv
  # string hit Linux's per-argument length cap (~128KB, MAX_ARG_STRLEN) and failed with "Argument
  # list too long" even though the system's own ARG_MAX (2MB here) was nowhere near exceeded.
  # Piped over stdin instead, which has no such per-string cap.
  printf '%s' "$raw" | python3 -c '
import json, re, sys
try:
    v = json.load(sys.stdin).get("info", {}).get("version", "")
except Exception:
    sys.exit(1)
if not isinstance(v, str) or not v:
    sys.exit(1)
if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z.+!_-]{0,63}", v):
    sys.exit(1)
print(v)
'
}

# Card eedb2871 L2 (WhiteHat2 gate, comment 19039): read-modify-write below used to be neither
# locked nor atomic, and silently treated a corrupt state file as "empty" before writing that
# empty state straight back -- measured: 8 concurrent writers across 25 rounds lost a pin in 15
# of them (worst round: 0/40 survived). Shares one flock'd lock file with git-repo-watcher.sh
# (same STATE path), writes through a tempfile + os.replace (atomic rename), and FAILS CLOSED
# (nonzero exit, no write at all) on a state file that fails to parse as JSON.
write_back() { # $1=name $2=latest_version
  local name="$1" latest="$2" out rc
  out="$( (
    flock -x -w 10 200 || { echo "lock timeout waiting for $STATE.lock"; exit 1; }
    python3 - "$STATE" "$name" "$latest" <<'PY'
import json, os, sys
from datetime import date

state_path, name, latest = sys.argv[1:4]
if os.path.exists(state_path):
    with open(state_path, encoding="utf-8") as f:
        raw = f.read()
    if raw.strip():
        try:
            state = json.loads(raw)
        except json.JSONDecodeError as e:
            print("corrupt state file, refusing to overwrite: " + str(e))
            sys.exit(1)
    else:
        state = {}
else:
    state = {}
entry = state.get(name, {})
entry["last_checked_at"] = date.today().isoformat()
entry["pypi_latest_version"] = latest
state[name] = entry
tmp_path = state_path + ".tmp"
with open(tmp_path, "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp_path, state_path)
PY
  ) 200>"$STATE.lock" 2>&1 )"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    local safe_out
    safe_out="$(printf '%s' "$out" | tr -cd '[:print:]' | cut -c1-200)"
    echo "ERROR:statewrite:$name ($safe_out)"
  fi
}

for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r name pypi_name pinned <<<"$row"
  [[ "$name" == "ERRCFG" ]] && { echo "ERROR:config-parse"; continue; }
  [[ -z "$name" ]] && continue
  if [[ -z "$pinned" ]]; then echo "ERROR:badconfig:$name (no pinned_version recorded)"; continue; fi

  latest="$(fetch_latest_version "$pypi_name")" || { echo "ERROR:fetch:$name"; continue; }
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

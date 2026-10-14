#!/usr/bin/env bash
# pipx-version-check.selftest.sh -- controls for pipx-version-check.sh (card eedb2871). Fully
# sandboxed: its own throwaway registry/state/override-dir per case, never touches the real
# store/watched-repos.json, store/watched-repos-state.json, or the real network.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/pipx-version-check.sh"
SB="$(mktemp -d)"
trap 'rm -rf "$SB"' EXIT
fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1 -> got '$3', expected '$2'"; fail=1; fi; }

echo "pipx-version-check.sh selftest (card eedb2871)"

# --- Case 1: pinned == latest -> NOCHANGE, state still stamped with today's date ----------------
C1="$SB/case1"; mkdir -p "$C1/override"
cat > "$C1/registry.json" <<'JSON'
[{"name": "widget-a", "adoption": "pipx", "pinned_version": "1.2.3"}]
JSON
echo '{"info": {"version": "1.2.3"}}' > "$C1/override/widget-a.json"
out="$(PIPX_VERSION_CHECK_REGISTRY_JSON="$C1/registry.json" WATCHED_REPOS_STATE_JSON="$C1/state.json" \
  PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR="$C1/override" bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q "^NOCHANGE:widget-a @ 1.2.3$"; then echo "  ok   matching version reports NOCHANGE"
else echo "  FAIL matching version did not report NOCHANGE: $out"; fail=1; fi
if echo "$out" | grep -q "^SUMMARY:checked=1:drift=0$"; then echo "  ok   summary counts the one checked, zero drift"
else echo "  FAIL wrong summary: $out"; fail=1; fi
last_checked="$(python3 -c "import json; print(json.load(open('$C1/state.json'))['widget-a']['last_checked_at'])")"
today="$(date +%Y-%m-%d)"
chk "NOCHANGE still stamps last_checked_at with today" "$today" "$last_checked"

# --- Case 2: pinned != latest -> DRIFT, flagged, never auto-bumps the registry file --------------
C2="$SB/case2"; mkdir -p "$C2/override"
cat > "$C2/registry.json" <<'JSON'
[{"name": "widget-b", "adoption": "pipx", "pinned_version": "0.9.1"}]
JSON
echo '{"info": {"version": "0.9.2"}}' > "$C2/override/widget-b.json"
registry_before="$(cat "$C2/registry.json")"
out="$(PIPX_VERSION_CHECK_REGISTRY_JSON="$C2/registry.json" WATCHED_REPOS_STATE_JSON="$C2/state.json" \
  PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR="$C2/override" bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q "^DRIFT:widget-b:0.9.1..0.9.2 FLAGGED-review-before-bump$"; then
  echo "  ok   version drift reports DRIFT, flagged for review"
else
  echo "  FAIL version drift did not report DRIFT: $out"; fail=1
fi
if echo "$out" | grep -q "^SUMMARY:checked=1:drift=1$"; then echo "  ok   summary counts the drift"
else echo "  FAIL wrong summary: $out"; fail=1; fi
registry_after="$(cat "$C2/registry.json")"
chk "DRIFT NEVER auto-bumps the registry's pinned_version" "$registry_before" "$registry_after"
latest_in_state="$(python3 -c "import json; print(json.load(open('$C2/state.json'))['widget-b']['pypi_latest_version'])")"
chk "state records the latest PyPI version it saw" "0.9.2" "$latest_in_state"

# --- Case 3: fetch failure (no override fixture = simulated unreachable PyPI) -> ERROR, no stamp -
C3="$SB/case3"; mkdir -p "$C3/override"
cat > "$C3/registry.json" <<'JSON'
[{"name": "widget-c", "adoption": "pipx", "pinned_version": "2.0.0"}]
JSON
# Deliberately NO widget-c.json fixture in the override dir.
out="$(PIPX_VERSION_CHECK_REGISTRY_JSON="$C3/registry.json" WATCHED_REPOS_STATE_JSON="$C3/state.json" \
  PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR="$C3/override" bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q "^ERROR:fetch:widget-c$"; then echo "  ok   unreachable PyPI reports ERROR:fetch, not a silent NOCHANGE"
else echo "  FAIL unreachable PyPI did not report ERROR:fetch: $out"; fail=1; fi
if echo "$out" | grep -q "^SUMMARY:checked=0:drift=0$"; then echo "  ok   a failed fetch does not count as checked"
else echo "  FAIL wrong summary on fetch failure: $out"; fail=1; fi
if [ -f "$C3/state.json" ]; then echo "  FAIL a failed fetch must not create/stamp a state entry"; fail=1
else echo "  ok   a failed fetch never touches the state file"; fi

# --- Case 4: malformed PyPI response (no "version" key) -> ERROR, never read as a false match ----
C4="$SB/case4"; mkdir -p "$C4/override"
cat > "$C4/registry.json" <<'JSON'
[{"name": "widget-d", "adoption": "pipx", "pinned_version": "1.0.0"}]
JSON
echo '{"info": {}}' > "$C4/override/widget-d.json"
out="$(PIPX_VERSION_CHECK_REGISTRY_JSON="$C4/registry.json" WATCHED_REPOS_STATE_JSON="$C4/state.json" \
  PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR="$C4/override" bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q "^ERROR:fetch:widget-d$"; then echo "  ok   a response with no version is ERROR, not a silent NOCHANGE"
else echo "  FAIL malformed response was not reported as ERROR: $out"; fail=1; fi

# --- Case 5: no pinned_version recorded at all -> ERROR:badconfig, never compared against "" -----
C5="$SB/case5"; mkdir -p "$C5/override"
cat > "$C5/registry.json" <<'JSON'
[{"name": "widget-e", "adoption": "pipx"}]
JSON
echo '{"info": {"version": "3.0.0"}}' > "$C5/override/widget-e.json"
out="$(PIPX_VERSION_CHECK_REGISTRY_JSON="$C5/registry.json" WATCHED_REPOS_STATE_JSON="$C5/state.json" \
  PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR="$C5/override" bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q "^ERROR:badconfig:widget-e"; then echo "  ok   a missing pinned_version is ERROR:badconfig, not treated as drift"
else echo "  FAIL missing pinned_version was not reported as ERROR:badconfig: $out"; fail=1; fi

# --- Case 6: non-pipx entries in the same registry are ignored entirely -------------------------
C6="$SB/case6"; mkdir -p "$C6/override"
cat > "$C6/registry.json" <<'JSON'
[
  {"name": "widget-f", "adoption": "pipx", "pinned_version": "1.0.0"},
  {"name": "some-git-clone", "adoption": "vendored", "pinned_version": "9.9.9"}
]
JSON
echo '{"info": {"version": "1.0.0"}}' > "$C6/override/widget-f.json"
out="$(PIPX_VERSION_CHECK_REGISTRY_JSON="$C6/registry.json" WATCHED_REPOS_STATE_JSON="$C6/state.json" \
  PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR="$C6/override" bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q "some-git-clone"; then echo "  FAIL a non-pipx entry was touched: $out"; fail=1
else echo "  ok   non-pipx registry entries are never touched"; fi
if echo "$out" | grep -q "^SUMMARY:checked=1:drift=0$"; then echo "  ok   only the one pipx entry counts toward the summary"
else echo "  FAIL wrong summary when a non-pipx entry is present: $out"; fail=1; fi

[ $fail -eq 0 ] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }

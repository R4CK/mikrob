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

# --- Case 6b: "pypi_name" overrides the PyPI lookup name, state is still keyed by "name" --------
# (discovered on the live registry: "graphify" is the local/display name, the real PyPI
# distribution is "graphifyy" -- without this override that row fetches 404 forever and never
# gets a fresh stamp, exactly the bug this card exists to close.)
C6B="$SB/case6b"; mkdir -p "$C6B/override"
cat > "$C6B/registry.json" <<'JSON'
[{"name": "widget-local", "adoption": "pipx", "pinned_version": "1.0.0", "pypi_name": "widget-real-dist"}]
JSON
echo '{"info": {"version": "1.0.0"}}' > "$C6B/override/widget-real-dist.json"
out="$(PIPX_VERSION_CHECK_REGISTRY_JSON="$C6B/registry.json" WATCHED_REPOS_STATE_JSON="$C6B/state.json" \
  PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR="$C6B/override" bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q "^NOCHANGE:widget-local @ 1.0.0$"; then echo "  ok   pypi_name overrides the PyPI lookup, output is still keyed by the local name"
else echo "  FAIL pypi_name override was not honored: $out"; fail=1; fi
if [ -f "$C6B/state.json" ] && python3 -c "import json,sys; sys.exit(0 if 'widget-local' in json.load(open('$C6B/state.json')) else 1)"; then
  echo "  ok   state file is keyed by the local name, not the pypi_name"
else echo "  FAIL state file was not keyed by the local name: $(cat "$C6B/state.json" 2>/dev/null)"; fail=1; fi

# --- Case 7: injected/garbage PyPI version string -> ERROR, never stamped (WhiteHat2 L1) --------
C7="$SB/case7"; mkdir -p "$C7/override"
cat > "$C7/registry.json" <<'JSON'
[{"name": "widget-g", "adoption": "pipx", "pinned_version": "1.0.0"}]
JSON
echo '{"info": {"version": "9.9.9\nNOCHANGE:code-review-graph @ 1.0.0\nSUMMARY:checked=99:drift=0"}}' > "$C7/override/widget-g.json"
out="$(PIPX_VERSION_CHECK_REGISTRY_JSON="$C7/registry.json" WATCHED_REPOS_STATE_JSON="$C7/state.json" \
  PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR="$C7/override" bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q "^ERROR:fetch:widget-g$"; then echo "  ok   a version string carrying embedded fake output lines is ERROR:fetch, never parsed as real"
else echo "  FAIL injected version string was not rejected: $out"; fail=1; fi
if [ -f "$C7/state.json" ]; then echo "  FAIL a rejected (invalid-shaped) version must not create/stamp a state entry"; fail=1
else echo "  ok   a rejected version never touches the state file"; fi

# --- Case 8: a version string over the length cap -> ERROR, never stamped (WhiteHat2 L1) --------
C8="$SB/case8"; mkdir -p "$C8/override"
cat > "$C8/registry.json" <<'JSON'
[{"name": "widget-h", "adoption": "pipx", "pinned_version": "1.0.0"}]
JSON
long_version="$(python3 -c "print('9'*100)")"
python3 -c "import json,sys; json.dump({'info':{'version':sys.argv[1]}}, open('$C8/override/widget-h.json','w'))" "$long_version"
out="$(PIPX_VERSION_CHECK_REGISTRY_JSON="$C8/registry.json" WATCHED_REPOS_STATE_JSON="$C8/state.json" \
  PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR="$C8/override" bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q "^ERROR:fetch:widget-h$"; then echo "  ok   an over-length version string is ERROR:fetch, not accepted"
else echo "  FAIL over-length version string was not rejected: $out"; fail=1; fi

# --- Case 9: a corrupt existing state file -> FAIL CLOSED, never silently reset to {} (WhiteHat2 L2) --
C9="$SB/case9"; mkdir -p "$C9/override"
cat > "$C9/registry.json" <<'JSON'
[{"name": "widget-i", "adoption": "pipx", "pinned_version": "1.0.0"}]
JSON
echo '{"info": {"version": "1.0.0"}}' > "$C9/override/widget-i.json"
printf '{ this is not valid json' > "$C9/state.json"
corrupt_before="$(cat "$C9/state.json")"
out="$(PIPX_VERSION_CHECK_REGISTRY_JSON="$C9/registry.json" WATCHED_REPOS_STATE_JSON="$C9/state.json" \
  PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR="$C9/override" bash "$SCRIPT" 2>&1)"
if echo "$out" | grep -q "^ERROR:statewrite:widget-i"; then echo "  ok   a corrupt state file is reported as ERROR:statewrite, not silently papered over"
else echo "  FAIL corrupt state file was not reported: $out"; fail=1; fi
corrupt_after="$(cat "$C9/state.json")"
chk "a corrupt state file is left UNTOUCHED (never reset to {}) on write failure" "$corrupt_before" "$corrupt_after"

# --- Case 9b: a large PyPI response (over bash's per-argv-string cap) must still parse -----------
# Measured live: graphifyy's real PyPI JSON response is 442KB -- passing it as a single argv
# string hit Linux's ~128KB per-argument cap ("Argument list too long") even though the raw PyPI
# response was perfectly valid. A padded "releases" blob is a realistic stand-in (PyPI responses
# legitimately grow this large for packages with many historical releases).
C9B="$SB/case9b"; mkdir -p "$C9B/override"
python3 -c "
import json
padding = {f'v0.{i}.0': [{'filename': f'pkg-0.{i}.0.tar.gz', 'url': 'https://example.invalid/x'}] for i in range(3000)}
json.dump({'info': {'version': '1.0.0'}, 'releases': padding}, open('$C9B/override/widget-big.json', 'w'))
"
big_size="$(wc -c < "$C9B/override/widget-big.json")"
cat > "$C9B/registry.json" <<'JSON'
[{"name": "widget-big", "adoption": "pipx", "pinned_version": "1.0.0"}]
JSON
out="$(PIPX_VERSION_CHECK_REGISTRY_JSON="$C9B/registry.json" WATCHED_REPOS_STATE_JSON="$C9B/state.json" \
  PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR="$C9B/override" bash "$SCRIPT" 2>&1)"
if [ "$big_size" -gt 131072 ]; then echo "  ok   fixture is over the 128KB per-argv-string cap ($big_size bytes)"
else echo "  FAIL fixture is not actually large enough to exercise the cap: $big_size bytes"; fail=1; fi
if echo "$out" | grep -q "^NOCHANGE:widget-big @ 1.0.0$"; then echo "  ok   a response well over bash's per-argv-string cap still parses correctly"
else echo "  FAIL large PyPI response was not parsed: $out"; fail=1; fi

# --- Case 10: concurrent writers to the same state file must not lose each other's pins (WhiteHat2 L2) --
C10="$SB/case10"; mkdir -p "$C10/override"
python3 -c "
import json
entries = [{'name': f'widget-c{i}', 'adoption': 'pipx', 'pinned_version': '1.0.0'} for i in range(8)]
json.dump(entries, open('$C10/registry.json', 'w'))
"
for i in $(seq 0 7); do echo '{"info": {"version": "1.0.0"}}' > "$C10/override/widget-c$i.json"; done
pids=()
for i in $(seq 0 7); do
  (
    for _round in 1 2 3; do
      PIPX_VERSION_CHECK_REGISTRY_JSON="$C10/registry.json" WATCHED_REPOS_STATE_JSON="$C10/state.json" \
        PIPX_VERSION_CHECK_PYPI_OVERRIDE_DIR="$C10/override" bash "$SCRIPT" >/dev/null 2>&1
    done
  ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
survivors="$(python3 -c "import json; print(len(json.load(open('$C10/state.json'))))")"
chk "8 concurrent writers (3 rounds each) all keep their pin -- none lost under the flock" "8" "$survivors"

[ $fail -eq 0 ] && { echo "selftest: PASS"; exit 0; } || { echo "selftest: FAIL"; exit 1; }

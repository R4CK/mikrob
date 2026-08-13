#!/usr/bin/env bash
# weekly-threshold-watch.sh -- detect when Peti edits the weekly stop thresholds
# (store/weekly-threshold-config.json: newDevStop/testStop) so MikroB notices a
# manual dashboard change instead of only reading the derived active/newDevStopActive
# booleans in weekly-hard-stop.json (Peti 2026-08-13: raised both thresholds and
# MikroB never surfaced it because nothing diffed the raw values).
#
# Output (last line, machine-readable):
#   UNCHANGED
#   CHANGED:<old_newDevStop>->[new_newDevStop]:<old_testStop>->[new_testStop]
#
# Idempotent: always rewrites the snapshot to the current config after printing,
# so a caller that fires many times per hour never re-alerts on the same change.
set -euo pipefail

STORE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${STORE}/weekly-threshold-config.json"
SNAPSHOT="${STORE}/.weekly-threshold-last-seen.json"

[ -f "$CONFIG" ] || { echo "UNCHANGED"; exit 0; }

cur_newdev="$(python3 -c 'import json;print(json.load(open("'"$CONFIG"'")).get("newDevStop"))' 2>/dev/null || echo '')"
cur_test="$(python3 -c 'import json;print(json.load(open("'"$CONFIG"'")).get("testStop"))' 2>/dev/null || echo '')"

if [ ! -f "$SNAPSHOT" ]; then
  # First run: seed silently, no alert (nothing to compare against yet).
  printf '{"newDevStop": %s, "testStop": %s}\n' "${cur_newdev:-null}" "${cur_test:-null}" > "$SNAPSHOT"
  echo "UNCHANGED"
  exit 0
fi

prev_newdev="$(python3 -c 'import json;print(json.load(open("'"$SNAPSHOT"'")).get("newDevStop"))' 2>/dev/null || echo '')"
prev_test="$(python3 -c 'import json;print(json.load(open("'"$SNAPSHOT"'")).get("testStop"))' 2>/dev/null || echo '')"

printf '{"newDevStop": %s, "testStop": %s}\n' "${cur_newdev:-null}" "${cur_test:-null}" > "$SNAPSHOT"

if [ "$prev_newdev" = "$cur_newdev" ] && [ "$prev_test" = "$cur_test" ]; then
  echo "UNCHANGED"
else
  echo "CHANGED:${prev_newdev}->${cur_newdev}:${prev_test}->${cur_test}"
fi

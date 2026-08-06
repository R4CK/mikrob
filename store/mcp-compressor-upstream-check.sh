#!/usr/bin/env bash
# mcp-compressor-upstream-check.sh -- watch @atlassian/mcp-compressor for a new
# upstream release (the crate-fix Peti's OPCIO-C waits on / re-gate trigger).
#
# Card b92c10d4: the wiring is blocked while the native build pulls 8 OSV-flagged
# Rust crates. When upstream ships a version > the last-seen one, we want to know
# so Cybersec can re-run the OSV scan + reachability gate.
#
# Output first line contract (for the scheduled task to parse):
#   SAME <version>            -> no change, stay silent
#   NEW <old> -> <new>        -> upstream released a new version; notify + re-gate
#   ERROR <reason>            -> transient (npm/network); stay silent, retry next run
#
# No secrets. Version-controlled per the ops-scripts rule (store/*.sh exception).
set -uo pipefail

PKG="@atlassian/mcp-compressor"
STATE="/home/neon/marveen/store/mcp-compressor-watch-state.json"
BASELINE_DEFAULT="0.31.7"   # last-audited version at card reshape (2026-07-31)

# last-seen version: from state file, else baseline
if [[ -f "$STATE" ]]; then
  LAST=$(python3 -c "import json;print(json.load(open('$STATE')).get('last_version','$BASELINE_DEFAULT'))" 2>/dev/null || echo "$BASELINE_DEFAULT")
else
  LAST="$BASELINE_DEFAULT"
fi

LATEST=$(npm view "$PKG" version 2>/dev/null | tr -d '[:space:]')
if [[ -z "$LATEST" ]]; then
  echo "ERROR npm-view-failed"
  exit 0
fi

if [[ "$LATEST" == "$LAST" ]]; then
  echo "SAME $LATEST"
  exit 0
fi

# newer (or at least different) version seen -> record it and flag once
cat > "$STATE" <<EOF
{"pkg":"$PKG","last_version":"$LATEST","previous_version":"$LAST","flagged":true}
EOF
echo "NEW $LAST -> $LATEST"
echo "detail: run OSV scan on the new tree + Cybersec reachability re-gate (card b92c10d4)"
exit 0

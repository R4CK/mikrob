#!/usr/bin/env bash
# gpu-driver-available-parse.sh -- validated extraction of the "available" NVIDIA driver version
# from NVIDIA's AjaxDriverService JSON response (card 9482a764, GPU-driver figyelo A2 -- predecessor
# to 8b588834 (c)3).
#
# This script NEVER makes the network call itself. gpu-driver-check.sh's own header already says
# that fetch belongs to quarantine-reader, invoked by the daily scheduled-task prompt, never to an
# unattended script with direct network access -- this script only parses/validates JSON that was
# ALREADY fetched, and on a validated match calls gpu-driver-check.sh --set-available, the one seam
# the daily prompt and gpu-driver-check.sh already share.
#
# Response shape and query parameters (GitHub-first, GPL-3.0, ElPumpo/TinyNvidiaUpdateChecker,
# Handlers/OldMetadataHandler.cs GetDriversFromNvidiaAjax, verified by fetching the actual source):
#   https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php
#     ?func=DriverManualLookup&pfid=<product>&osID=<os>&dch=1&numberOfResults=10&languageCode=1078
#   { "Success": 1, "IDS": [ { "downloadInfo": { "Version": "...", "IsCRD": 0|1, ... } }, ... ] }
# newest-first per the API's own ordering (the upstream tool relies on this, does not re-sort);
# IsCRD distinguishes Game Ready (0) from Studio/CRD (1) results.
#
# This host's product/OS IDs (GTX 1660 Ti desktop / Windows 11), from the same upstream's
# gpu-data.json / os-data.json: pfid=892, osID=135.
#
# Usage:
#   gpu-driver-available-parse.sh --driver-type grd|crd [<json-file>]   (reads stdin if no file)
# Exit 0 and calls --set-available on a validated match. Exit 1, NO state change, on anything else
# (fail-closed, same contract gpu-driver-check.sh itself already uses for installedHost/installedWsl).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_BIN="${GPU_DRIVER_AVAILABLE_CHECK_BIN:-$HERE/gpu-driver-check.sh}"

DRIVER_TYPE=""
JSON_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --driver-type) DRIVER_TYPE="${2:-}"; shift 2 ;;
    *) JSON_FILE="$1"; shift ;;
  esac
done

case "$DRIVER_TYPE" in
  grd) WANT_IS_CRD=0 ;;
  crd) WANT_IS_CRD=1 ;;
  *) echo "usage: $0 --driver-type grd|crd [<json-file>]" >&2; exit 2 ;;
esac

if [ -n "$JSON_FILE" ]; then
  JSON="$(cat "$JSON_FILE" 2>/dev/null)" || { echo "gpu-driver-available-parse: cannot read $JSON_FILE" >&2; exit 1; }
else
  JSON="$(cat)"
fi

VERSION="$(WANT_IS_CRD="$WANT_IS_CRD" python3 -c '
import json, os, sys

try:
    data = json.loads(sys.stdin.read())
except Exception as e:
    print(f"ERR json parse failed: {e}", file=sys.stderr)
    sys.exit(1)

if not isinstance(data, dict) or not data.get("Success") or not isinstance(data.get("IDS"), list):
    print("ERR no Success/IDS in response", file=sys.stderr)
    sys.exit(1)

want = int(os.environ["WANT_IS_CRD"])
for entry in data["IDS"]:
    info = entry.get("downloadInfo") if isinstance(entry, dict) else None
    if not isinstance(info, dict):
        continue
    if int(info.get("IsCRD", -1)) == want:
        v = (info.get("Version") or "").strip()
        if v:
            print(v)
            sys.exit(0)
        break

print("ERR no matching IsCRD entry with a non-empty Version", file=sys.stderr)
sys.exit(1)
' <<<"$JSON")" || { echo "gpu-driver-available-parse: no validated version extracted, state NOT changed" >&2; exit 1; }

# Same dotted-numeric format guard as gpu-driver-check.sh's installedHost/installedWsl (card
# e3846ccc) -- an unexpected response shape must not write garbage into available.
if ! [[ "$VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  echo "gpu-driver-available-parse: extracted value '$VERSION' is not dotted-numeric, state NOT changed" >&2
  exit 1
fi

"$CHECK_BIN" --set-available "$VERSION"

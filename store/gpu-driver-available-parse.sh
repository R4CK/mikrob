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
#
# WhiteHat2 N1-N3 (9482a764 gate, komment 17641, kötelező előfeltétel a 8b588834 (C) silent install
# előtt): N1 value-bound (segment <= 9999, all-zero rejected), N2 Success="0" as a truthy string,
# N3 pick the largest matching version, not the first one encountered -- all fixed in the parser
# below. N1's other half (deterministic, non-LLM-reconstructed fetch) is a daily scheduled-task
# prompt / quarantine-reader invocation concern outside this repo's scope -- flagged to MikroB,
# not fixed here (this script never fetches, see above).
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
import json, os, sys, re

try:
    data = json.loads(sys.stdin.read())
except Exception as e:
    print(f"ERR json parse failed: {e}", file=sys.stderr)
    sys.exit(1)

# WhiteHat2 N2 (9482a764 gate, komment 17641): "Success" can arrive as the STRING "0" (the
# upstream API is JSON but some observed responses stringify this field) -- Python truthiness
# makes a non-empty string truthy regardless of its content, so the old `not data.get("Success")`
# let a literal "Success":"0" response through as if it were success. Compare the numeric value,
# not the Python truthiness of whatever type it arrived as; anything that is not parseable as a
# non-zero number is treated as failure.
success_raw = data.get("Success")
try:
    success_ok = int(str(success_raw).strip()) != 0
except (ValueError, TypeError):
    success_ok = False

if not isinstance(data, dict) or not success_ok or not isinstance(data.get("IDS"), list):
    print("ERR no Success/IDS in response", file=sys.stderr)
    sys.exit(1)

# WhiteHat2 N1 (value-bound) + N3 (largest-wins): collect every entry matching the requested
# IsCRD, validate each Version as dotted-numeric with sane-sized segments BEFORE comparing, and
# pick the numerically LARGEST one -- not the first one encountered. The newest-first ordering
# the API is observed to return (see the script header) was never a documented contract, only an
# observed convention; N3 measured that relying on it is exactly the kind of "ami benne van, nem
# ami hianyzik" gap this finding was about. A segment above 9999 (e.g. "99999999999.1") or an
# all-zero version ("0", "0.0.0") is rejected here rather than reaching --set-available as a
# plausible-looking value.
want = int(os.environ["WANT_IS_CRD"])
SEG_RE = re.compile(r"^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$")

def version_key(v):
    return tuple(int(p) for p in v.split("."))

best = None
best_key = None
for entry in data["IDS"]:
    info = entry.get("downloadInfo") if isinstance(entry, dict) else None
    if not isinstance(info, dict):
        continue
    try:
        is_crd = int(info.get("IsCRD", -1))
    except (ValueError, TypeError):
        continue
    if is_crd != want:
        continue
    v = (info.get("Version") or "").strip()
    if not v or not SEG_RE.match(v):
        continue
    key = version_key(v)
    if all(seg == 0 for seg in key):
        continue
    if best_key is None or key > best_key:
        best, best_key = v, key

if best is None:
    print("ERR no matching IsCRD entry with a valid, non-zero, bounded Version", file=sys.stderr)
    sys.exit(1)

print(best)
' <<<"$JSON")" || { echo "gpu-driver-available-parse: no validated version extracted, state NOT changed" >&2; exit 1; }

# Same dotted-numeric format guard as gpu-driver-check.sh's installedHost/installedWsl (card
# e3846ccc) -- an unexpected response shape must not write garbage into available. The Python
# side above already enforced the tighter (bounded, non-zero) shape; this is the final seam-level
# backstop, kept so the two validators cannot silently drift apart.
if ! [[ "$VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  echo "gpu-driver-available-parse: extracted value '$VERSION' is not dotted-numeric, state NOT changed" >&2
  exit 1
fi

"$CHECK_BIN" --set-available "$VERSION"

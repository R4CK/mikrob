#!/usr/bin/env bash
# MT-12 (card f21b4469): thin entry point for kg-measure-weekly.py, matching the fleet's other
# store/*.sh wrappers around a *.py worker (e.g. llm-catalog.py). Runs the python worker with -I
# (isolated mode, per this session's own "untrusted downloaded code" rule -- this script reads no
# downloaded data, but -I costs nothing and keeps the pattern uniform).
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 -I "$HERE/kg-measure-weekly.py" "$@"

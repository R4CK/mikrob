#!/usr/bin/env bash
# decompose-sample-context.sh -- bash entry point for decompose-sample-context.py (card d39fc5e7,
# requirement 1). Thin wrapper only: the file-finding logic lives in the .py sibling where it is
# unit-testable without a shell; this file exists so offload-dispatch.sh can `source` a single
# function and so a human/CI can call the same thing from the shell.
#
# Usage:
#   decompose_sample_context <type> <text> <repo>    # bash function, after sourcing this file
#   decompose-sample-context.sh --test-sample <type> <text> <repo>   # same thing, from the CLI
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

decompose_sample_context() {
  # $1 = type (test-scaffold|type-def|i18n-keys|doc-update)   $2 = text (title+description)
  # $3 = repo root. Prints the sample block on a hit, nothing on a miss; returns 0/1 to match.
  local type="$1" text="$2" repo="$3"
  python3 -c 'import json,sys; print(json.dumps({"type":sys.argv[1],"text":sys.argv[2],"repo":sys.argv[3]}))' \
      "$type" "$text" "$repo" \
    | python3 "$HERE/decompose-sample-context.py"
}

if [[ "${1:-}" == "--test-sample" ]]; then
  shift
  decompose_sample_context "${1:-}" "${2:-}" "${3:-}"
  exit $?
fi

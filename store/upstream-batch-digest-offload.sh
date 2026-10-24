#!/usr/bin/env bash
# upstream-batch-digest-offload.sh -- the ONE entry point for the "upstream-batch-digest" local-
# llm category's Gemini heavy-path fallback (card efe4aa40, MikroB decision komment 23269 point 2).
#
# Scope decision, stated explicitly (do not re-litigate without re-reading efe4aa40/23267/23269):
#   - merge-conflict-explain does NOT get a Gemini fallback at all (point 1 of the same decision --
#     its whole value comes from the real conflict-block content, which can never leave this
#     machine). A local failure on that category falls back to the EXISTING convention: the
#     responsible online agent just writes it, no script change needed, nothing to build.
#   - upstream-batch-digest MAY use the Gemini fallback, but ONLY commit hash+subject text --
#     --stat/filelist/diff must NEVER leave this filter. This script enforces that BEFORE the
#     local attempt (not only before Gemini), via upstream-batch-digest-filter.sh.
#   - is_gemini_blocked() (offload-dispatch.sh) is NOT reused here. That gate's allowlist (project
#     == "mikrob", an explicit "gemini-ok" card label) is inherently shaped around a REAL kanban
#     leaf that MikroB/a gate already reviewed -- a bare CLI call has no card, no project, no
#     label to check, and forcing fixed values through it to satisfy its syntax would be gate
#     theater, not a gate. Instead, THIS script requires its OWN explicit, per-call opt-in
#     (--confirm-gemini-ok, required, not a default), mirroring the "positive marker required"
#     principle (card c23ea72f) at the call-site level instead of the card level. Defense in
#     depth beyond the hash+subject filter: gemini-offload-call.sh's own secret-shaped-token
#     redaction still runs unconditionally on whatever text this script hands it.
#
# USAGE:
#   git log --stat <range> | upstream-batch-digest-offload.sh --caller <agent> --confirm-gemini-ok
#
# Exit codes: 0 ok (stdout = the digest input text, output, or filtered commit list on dry-run) |
#   1 filter rejected the input (nothing safe to send) | 2 local attempt failed and no Gemini
#   fallback was available (flag off, budget capped, or --confirm-gemini-ok missing) | 3 both the
#   local attempt and the Gemini fallback failed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Env-overridable (selftest-only pattern, matches gemini-heavy-gate.sh's GEMINI_HEAVY_FLAG/
# HEAVY_HOURLY_LOCK): lets a selftest point these at stub scripts instead of the real
# local-llm.sh/gemini-offload-call.sh. Production calls never set these, so they resolve here.
FILTER="${UBD_FILTER:-$HERE/upstream-batch-digest-filter.sh}"
LOCAL_LLM="${UBD_LOCAL_LLM:-$HERE/local-llm.sh}"
GEMINI_OFFLOAD="${UBD_GEMINI_OFFLOAD:-$HERE/gemini-offload-call.sh}"

CALLER=""
CONFIRM_GEMINI_OK=0
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --caller) CALLER="$2"; shift 2 ;;
    --confirm-gemini-ok) CONFIRM_GEMINI_OK=1; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[[ -n "$CALLER" ]] || { echo "upstream-batch-digest-offload: --caller is required" >&2; exit 2; }

# shellcheck source=/dev/null
. "$HERE/gemini-heavy-gate.sh"

# 1. FILTER FIRST, before the local attempt (MikroB decision point 2) -- same filtered text goes
#    to local AND to the Gemini fallback, so there is no second, unfiltered copy anywhere.
RAW="$(cat)"
FILTERED="$(printf '%s' "$RAW" | bash "$FILTER")" || exit 1

# 2. LOCAL ATTEMPT.
if OUT="$(printf '%s' "$FILTERED" | "$LOCAL_LLM" --task upstream-batch-digest --caller "$CALLER" 2>/dev/null)"; then
  printf '%s\n' "$OUT"
  exit 0
fi
echo "upstream-batch-digest-offload: local attempt failed, considering Gemini fallback" >&2

# 3. GEMINI FALLBACK -- gated by the f0b3b674 heavy flag + the shared hourly budget (reused,
#    unmodified) AND this script's own explicit per-call opt-in (see the scope decision above).
if [[ "$CONFIRM_GEMINI_OK" != "1" ]]; then
  echo "upstream-batch-digest-offload: no Gemini fallback (--confirm-gemini-ok not given)" >&2
  exit 2
fi
if ! gemini_heavy_second_opinion_enabled; then
  echo "upstream-batch-digest-offload: no Gemini fallback (heavy second-opinion flag is off)" >&2
  exit 2
fi
SLOT_ID="upstream-batch-digest:$(date -u +%Y%m%dT%H%M%SZ)"
if ! reserve_heavy_gemini_slot "$SLOT_ID"; then
  echo "upstream-batch-digest-offload: no Gemini fallback (hourly budget capped)" >&2
  exit 2
fi
if OUT="$(printf '%s' "$FILTERED" | bash "$GEMINI_OFFLOAD" 2>/dev/null)" && [[ -n "${OUT// }" ]]; then
  printf '%s\n' "$OUT"
  exit 0
fi
echo "upstream-batch-digest-offload: Gemini fallback also failed" >&2
exit 3

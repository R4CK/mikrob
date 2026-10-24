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
#   - CONTENT GATE (card d886e9c2, MikroB decision komment 23556 point (a), RedHat GO 23683): the
#     --confirm-gemini-ok flag alone is a caller-controlled switch, not a gate -- any caller just
#     passes it (RedHat Y2, komment 23553). Since there is no kanban leaf here to feed
#     is_gemini_blocked's project/tags allowlist, this script instead reuses that SAME function's
#     content-gate step (sensitive-keyword vocabulary) via offload-dispatch.sh's existing
#     "--check-blocked PROJECT TAGS TITLE DESC" exposure (card 23a14c4b) -- project="mikrob" (this
#     IS the fleet's own repo), tags="gemini-ok" (this call-site's OWN --confirm-gemini-ok IS the
#     deliberate positive marker the tag check requires, card c23ea72f -- there is no kanban leaf
#     to tag instead), title empty, desc=the FILTERED commit text (the exact text that would
#     reach Gemini, so the sensitive-keyword content gate runs for real). This is checked IN
#     ADDITION to --confirm-gemini-ok, which stays required (USAGE unchanged) -- the switch alone
#     no longer opens the path by itself.
#     Defense in depth beyond the hash+subject filter: gemini-offload-call.sh's own secret-shaped-
#     token redaction still runs unconditionally on whatever text this script hands it.
#
# USAGE:
#   git log --stat <range> | upstream-batch-digest-offload.sh --caller <agent> --confirm-gemini-ok
#
# HASH LENGTH (MikroB decision komment 23556, RedHat 23553 non-blocking Y3): use SHORT hashes
# (git log --format='%h %s' or --abbrev-commit), not the full 40-char SHA-1 from a plain
# `git log --stat`. gemini-offload-call.sh's own secret-shaped-token redactor rejects any 32+
# char contiguous hex run (hex32 pattern) -- a full 40-char hash always fails the Gemini call,
# turning every fallback attempt into case 3 (both local and Gemini failed) for no reason.
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
# WhiteHat MEDIUM (card 7b5cf804, d886e9c2 GO @ a7742f46): the content gate below is the one
# thing standing between a sensitive commit and Gemini -- it must NOT be overridable from the
# caller's environment. No test (selftest or otherwise) ever sets UBD_OFFLOAD_DISPATCH, so the
# seam bought nothing and only gave a caller a way to point it at a script that always exits 42.
OFFLOAD_DISPATCH="$HERE/offload-dispatch.sh"

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
#    unmodified) AND this script's own explicit per-call opt-in (see the scope decision above)
#    AND the is_gemini_blocked content gate (card d886e9c2, see the comment block above).
if [[ "$CONFIRM_GEMINI_OK" != "1" ]]; then
  echo "upstream-batch-digest-offload: no Gemini fallback (--confirm-gemini-ok not given)" >&2
  exit 2
fi
# CONTENT GATE (card d886e9c2): the switch above is caller-controlled and not sufficient by
# itself. Reuse is_gemini_blocked's own content-gate vocabulary via offload-dispatch.sh's
# "--check-blocked" exposure, run on the FILTERED commit text (the exact text that would reach
# Gemini) -- its own convention is exit 42 == allowed, anything else (including a crashed/missing
# interpreter) == blocked, fail-closed.
# WhiteHat MEDIUM (card 7b5cf804): BASH_ENV/ENV, if inherited from the caller's environment,
# would be sourced by this `bash <scriptfile>` invocation BEFORE offload-dispatch.sh's own code
# runs -- a caller-supplied file there could just `exit 42` and skip the real check entirely.
# Strip both so the gate call always runs the real logic, regardless of caller environment.
CHECK_RC=0
env -u BASH_ENV -u ENV bash "$OFFLOAD_DISPATCH" --check-blocked mikrob "gemini-ok" "" "$FILTERED" >/dev/null 2>&1 || CHECK_RC=$?
if [[ "$CHECK_RC" != 42 ]]; then
  echo "upstream-batch-digest-offload: no Gemini fallback (content gate blocked)" >&2
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
# RedHat NO-GO K2 (komment 23553, bb1f9f6f delta-gate): sending $FILTERED bare gives Gemini a
# commit list with NO instruction -- not a digest request, just raw upstream subject lines it is
# free to interpret however it wants, and the local-llm-skills template's FLAGS requirement (flag
# security/auth/secrets/env/CI/dependency commits) never reaches this path at all. Build the SAME
# prompt the local attempt already used (system line + user template with {{INPUT}} substituted,
# same escaping rule as local-llm.sh) and send THAT to Gemini instead of the bare filtered text.
TEMPLATE="$HERE/local-llm-skills/upstream-batch-digest.txt"
GEMINI_SYS="$(awk '/^---$/{exit} {print}' "$TEMPLATE")"
GEMINI_USER_TPL="$(awk 'f{print} /^---$/{f=1}' "$TEMPLATE")"
GEMINI_ESCAPED_INPUT="${FILTERED//\\/\\\\}"
GEMINI_USER="${GEMINI_USER_TPL//\{\{INPUT\}\}/${GEMINI_ESCAPED_INPUT//&/\\&}}"
GEMINI_PROMPT="$GEMINI_SYS
$GEMINI_USER"
if OUT="$(printf '%s' "$GEMINI_PROMPT" | bash "$GEMINI_OFFLOAD" 2>/dev/null)" && [[ -n "${OUT// }" ]]; then
  printf '%s\n' "$OUT"
  exit 0
fi
echo "upstream-batch-digest-offload: Gemini fallback also failed" >&2
exit 3

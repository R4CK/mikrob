#!/usr/bin/env bash
# suite_sha_check -- does the card's Suite-SHA evidence still cover the tree about to be pushed?
#
# WHY (card 08eb6402, the 777f69b1 incident). 2026-09-12: 777f69b1 landed 55/56 on
# apps/api/src/superadmin-router.test.ts while origin/main immediately before it was 56/56 --
# green baseline, red branch, and mopsion-land.sh never noticed because in source it runs zero
# vitest/suite-run calls (only typecheck + format + bundle + seam, see this file's header). The
# QA PASS on that sha re-verified a different, previously-flagged finding, not a fresh full suite.
#
# THE FIX IS EVIDENCE-BASED, NOT EXECUTION-BASED (MikroB, card 08eb6402 comment 5934). Running the
# ~70-minute full suite inline at every landing was explicitly rejected -- it would serialise
# landings against the 2-slot semaphore (rule 17). So a gate that already ran the full suite on
# the sha it reviewed records `Suite-SHA: <sha> <result>` in its verdict comment (rule 4b's
# `Gate-SHA:` sibling), and this file asks store/suite-sha-check.py whether that evidence is still
# content-equivalent to the MERGE RESULT about to be pushed -- a git diff, not a suite run.
#
# SAME SHAPE AS landing-gate-verdict-check.sh next door, ONE call later in the pipeline: that file
# asks "does a verdict exist for the GATED sha" before the merge even starts; this one asks "does
# a FULL-SUITE verdict still describe the MERGE RESULT" right before the push, because the merge
# result does not exist until then.
#
# FAIL-CLOSED ON AN UNREADABLE BOARD, same stance as the gate-verdict check: "I could not check"
# must never read as "checked and fine".

SUITE_SHA_CHECK_API="${SUITE_SHA_CHECK_API:-http://127.0.0.1:3420}"
SUITE_SHA_CHECK_TOKEN_FILE="${SUITE_SHA_CHECK_TOKEN_FILE:-/home/neon/marveen/store/.dashboard-token}"

# EXIT CODES, mirroring gate_verdict_check's contract on purpose (card 171c9f42's lesson: a caller
# that treats every non-zero the same reopens the hole a distinct code exists to close):
#   0  PRESENT     -- evidence covers the merge result, proceed
#   1  MISSING / UNRESOLVED -- no usable evidence, or it could not be checked -- overridable by an
#      explicit, named flag (mode=refuse only; report mode never blocks, same as the sibling check)
#   2  STALE       -- evidence exists but the merge result has moved past what it covers -- NEVER
#      overridden by the ordinary flag, same relationship --allow-ungated has to a FAILING verdict
suite_sha_check() {
  local card="$1" merge_sha="$2" mode="${3:-refuse}"
  local strict=1
  [ "$mode" = "refuse" ] || strict=0

  if [ ! -r "$SUITE_SHA_CHECK_TOKEN_FILE" ]; then
    if [ "$strict" -eq 1 ]; then
      echo "REFUSED: cannot read $SUITE_SHA_CHECK_TOKEN_FILE, so the Suite-SHA evidence on card" >&2
      echo "         $card is unverifiable. Fails CLOSED on purpose. Override with" >&2
      echo "         --allow-stale-suite." >&2
      return 1
    fi
    echo "  suite-sha-check: board unreadable, skipped (report mode)"
    return 0
  fi

  local body
  body="$(printf 'Authorization: Bearer %s\n' "$(cat "$SUITE_SHA_CHECK_TOKEN_FILE")" \
    | curl -sS -m 20 -H @- "$SUITE_SHA_CHECK_API/api/kanban/$card/comments" 2>/dev/null)" || body=""

  local verdict checker
  checker="$(dirname "${BASH_SOURCE[0]}")/suite-sha-check.py"
  verdict="$(printf '%s' "$body" | python3 "$checker" "$merge_sha" 2>/dev/null)" || verdict="UNRESOLVED|-|parser failed"
  [ -n "$verdict" ] || verdict="UNRESOLVED|-|empty response from the board"

  local kind="${verdict%%|*}" detail="${verdict#*|}"
  case "$kind" in
  PRESENT)
    say_or_echo "  suite-sha-check: card $card carries full-suite evidence covering $merge_sha -- $detail"
    return 0
    ;;
  STALE)
    echo "REFUSED: card $card's Suite-SHA evidence no longer covers the merge result ($merge_sha)." >&2
    echo "         $detail" >&2
    echo "         The tree moved past what the full suite actually tested. Re-run the full suite" >&2
    echo "         (or ask the gate to) and re-verdict before landing. Never overridden by" >&2
    echo "         --allow-stale-suite -- this is confirmed drift, not merely absent evidence." >&2
    return 2
    ;;
  esac

  if [ "$strict" -eq 0 ]; then
    say_or_echo "  suite-sha-check: $detail (report only)"
    return 0
  fi
  if [ "$kind" = "UNRESOLVED" ]; then
    echo "REFUSED: could not verify the Suite-SHA evidence for card $card -- $detail" >&2
    echo "         Fails CLOSED: an unreadable/unresolvable result cannot tell covered from not." >&2
    echo "         Override with --allow-stale-suite once you have checked by hand." >&2
    return 1
  fi
  # kind == MISSING
  echo "REFUSED: card $card has no full-suite evidence (no Suite-SHA line on any verdict) for" >&2
  echo "         this landing. This is the 777f69b1 shape: a targeted-test PASS treated as proof" >&2
  echo "         the whole tree is green." >&2
  echo "         Run the full suite (store/mopsion-suite-run.sh) or ask the gate to, have it record" >&2
  echo "         a Suite-SHA line, and re-land. If this is deliberately ungated (docs-only, own" >&2
  echo "         infra with no suite-relevant change), re-run with --allow-stale-suite, which says" >&2
  echo "         so in the open instead of leaving it implied." >&2
  return 1
}

# The landers define say(); a bare source in a selftest may not.
say_or_echo() { if declare -F say >/dev/null 2>&1; then say "$*"; else echo "$*"; fi; }

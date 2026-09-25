#!/usr/bin/env bash
# mopsion-preland.sh -- the SINGLE callable entry point for the two-phase landing design (card
# 08eb6402, MikroB plan-grilling verdict 6011 + msg 3748): prepare a merge commit, suite-test it in
# the background (never inside a landing window), and record machine evidence for it -- so the
# actual landing (mopsion-land.sh) only ever has to check a tree hash, never run a 70-minute suite
# itself.
#
# Usage:  mopsion-preland.sh <cardId> <gated-sha>     one card
#         mopsion-preland.sh --pending                every waiting card whose designated gates
#                                                      AGREE, not yet landed, no fresh evidence
#
# Output, ONE machine-readable line per card:
#   READY|<card>|<sha>|<tree>|pass=P fail=F skip=K   fresh evidence already covers this tree
#   RUNNING|<card>                                    another preland for this card is already
#                                                      in flight (per-card lock held elsewhere)
#   ANOMALY|<card>|<sha>|<tree>|<why>                 suite ran but hit the birpc flake or an
#                                                      incomplete run -- needs a re-run, not a verdict
#   FAILED|<card>|<sha>|<tree>|pass=P fail=F skip=K   suite ran and genuinely failed
#   FAILED|<card>|-|-|<reason>                        could not even prepare (merge/tsc/seam/format
#                                                      refused, or no usable gate verdict yet)
#
# WHY MOPSION-PRELAND CALLS MOPSION-LAND --prepare-only RATHER THAN REBUILDING THE MERGE: the merge
# + seam + tsc + format validation in mopsion-land.sh is ~700 lines of already-measured logic
# (cards 7336c383/36d559e5/dfff9b37/3bfb133e among others). Suite-testing a merge that would be
# REFUSED anyway for an unrelated reason is wasted 70 minutes, so --prepare-only reuses every one of
# those checks and only skips the push.
#
# IDEMPOTENT ON THE MERGE'S TREE HASH (MikroB's explicit requirement): if suite-evidence-record.py
# already holds a non-anomalous record for the prepared tree, the suite never runs twice for the
# same content, no matter how many times --pending or a direct call revisits the card.
#
# SCHEDULING IS DELIBERATELY NOT HERE. This script is the ONE callable entry point; something else
# (MikroB's own gate-reconciler wiring, per msg 3748) decides WHEN to call --pending. This file
# never creates a scheduled task, never touches a cron/heartbeat prompt, and is safe to invoke by
# hand at any time.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/mopsion}"
LAND="${PRELAND_LAND_SCRIPT:-$HERE/mopsion-land.sh}"
EVIDENCE="$HERE/suite-evidence-record.py"
LOCK_DIR="${PRELAND_LOCK_DIR:-$HERE}"
API="${PRELAND_API:-http://127.0.0.1:3420}"
TOKEN_FILE="${PRELAND_TOKEN_FILE:-$HERE/.dashboard-token}"

usage() { echo "usage: mopsion-preland.sh <cardId> <gated-sha>  |  mopsion-preland.sh --pending" >&2; exit 2; }

# --- per-card lock: two callers must never prepare+suite the same card at once ------------------
# flock ON A FILE DESCRIPTOR (same reason mopsion-suite-run.sh's own slot semaphore uses it, see
# that file's header): the kernel drops the lock when the holder dies, so a killed preland cannot
# leave the card permanently RUNNING.
with_card_lock() { # $1 = card, $2.. = command to run under the lock, or nothing held -> prints RUNNING
  local card="$1"; shift
  local lockfile="$LOCK_DIR/.preland-$card.lock"
  exec {LOCKFD}>"$lockfile" || { echo "FAILED|$card|-|-|could not open lock file $lockfile"; return 1; }
  if ! flock -n "$LOCKFD"; then
    echo "RUNNING|$card"
    return 0
  fi
  "$@"
  local rc=$?
  flock -u "$LOCKFD" 2>/dev/null
  return $rc
}

preland_one() { # $1 = card, $2 = gated sha
  local card="$1" sha="$2"

  local prep_out prep_rc
  prep_out="$(bash "$LAND" "$card" "$sha" --prepare-only 2>&1)"
  prep_rc=$?
  local prepared
  prepared="$(printf '%s\n' "$prep_out" | grep -m1 '^PREPARED|')"
  if [ -z "$prepared" ]; then
    local reason
    reason="$(printf '%s\n' "$prep_out" | grep -m1 '^REFUSED:' || printf '%s\n' "$prep_out" | tail -1)"
    echo "FAILED|$card|-|-|prepare refused (rc=$prep_rc): ${reason:-no output}"
    return 1
  fi
  local prep_sha prep_tree
  prep_sha="$(printf '%s' "$prepared" | cut -d'|' -f2)"
  prep_tree="$(printf '%s' "$prepared" | cut -d'|' -f3)"

  # IDEMPOTENCY: a fresh (non-anomalous) record for this exact tree means the suite already
  # covered this content -- do not run it again just because the caller asked again.
  local existing
  existing="$(python3 "$EVIDENCE" lookup --tree "$prep_tree" 2>/dev/null)"
  case "$existing" in
    PRESENT\|*)
      echo "READY|$card|$prep_sha|$prep_tree|$(printf '%s' "$existing" | cut -d'|' -f3)"
      return 0
      ;;
    FAILED\|*)
      echo "FAILED|$card|$prep_sha|$prep_tree|$(printf '%s' "$existing" | cut -d'|' -f3)"
      return 1
      ;;
    # ANOMALY or MISSING both fall through to an actual run below -- an anomalous result is
    # explicitly "needs a re-run", not a verdict either way (card 08eb6402 point 4).
  esac

  # Suite-test the PREPARED commit specifically, never any agent's own worktree HEAD.
  local tmp_wt
  tmp_wt="$(mktemp -d "${TMPDIR:-/tmp}/mopsion-preland-$card-XXXXXX")"
  if ! git -C "$MAIN" worktree add --detach -q "$tmp_wt" "$prep_sha" 2>/dev/null; then
    rmdir "$tmp_wt" 2>/dev/null
    echo "FAILED|$card|$prep_sha|$prep_tree|could not create a worktree for the prepared commit"
    return 1
  fi
  bash "$HERE/mopsion-suite-run.sh" --worktree "$tmp_wt" "preland-$card" >/dev/null 2>&1
  git -C "$MAIN" worktree remove --force "$tmp_wt" >/dev/null 2>&1

  local result
  result="$(python3 "$EVIDENCE" lookup --tree "$prep_tree" 2>/dev/null)"
  case "$result" in
    PRESENT\|*)
      echo "READY|$card|$prep_sha|$prep_tree|$(printf '%s' "$result" | cut -d'|' -f3)"
      return 0
      ;;
    FAILED\|*)
      echo "FAILED|$card|$prep_sha|$prep_tree|$(printf '%s' "$result" | cut -d'|' -f3)"
      return 1
      ;;
    ANOMALY\|*)
      echo "ANOMALY|$card|$prep_sha|$prep_tree|$(printf '%s' "$result" | cut -d'|' -f2-)"
      return 1
      ;;
    *)
      echo "ANOMALY|$card|$prep_sha|$prep_tree|the suite ran but left no usable evidence record"
      return 1
      ;;
  esac
}

# --- --pending: every waiting card whose designated gates AGREE ---------------------------------
pending_all() {
  if [ ! -r "$TOKEN_FILE" ]; then
    echo "FAILED|-|-|-|cannot read $TOKEN_FILE, board unreadable" >&2
    return 1
  fi
  local hdr
  hdr="$(mktemp)"
  printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$hdr"
  local cards_json
  cards_json="$(curl -sS -m 20 -H @"$hdr" "$API/api/kanban?status=waiting" 2>/dev/null)"
  local ids
  ids="$(printf '%s' "$cards_json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = []
if not isinstance(d, list):
    d = []
for c in d:
    proj = (c.get("project") or "")
    title = (c.get("title") or "")
    if proj.lower() in ("cleancore", "mopsion") or "[cleancore]" in title.lower() or "[mopsion]" in title.lower():
        print(c["id"])
' 2>/dev/null)"
  local card
  for card in $ids; do
    local comments_json verdict
    comments_json="$(curl -sS -m 20 -H @"$hdr" "$API/api/kanban/$card/comments" 2>/dev/null)"
    verdict="$(printf '%s' "$comments_json" | python3 "$HERE/gate-closure-check.py" 2>/dev/null)"
    case "$verdict" in
      AGREE\|*)
        local sha
        sha="$(printf '%s' "$verdict" | cut -d'|' -f2)"
        with_card_lock "$card" preland_one "$card" "$sha"
        ;;
      *) ;; # not AGREE (or no verdict, or DISAGREE/STALE/etc.) -- not this script's job to decide
    esac
  done
  rm -f "$hdr"
}

case "${1:-}" in
  --pending) pending_all ;;
  "") usage ;;
  *)
    CARD="${1:-}"; SHA="${2:-}"
    [ -n "$CARD" ] && [ -n "$SHA" ] || usage
    with_card_lock "$CARD" preland_one "$CARD" "$SHA"
    ;;
esac

#!/usr/bin/env bash
# unlazy-stop-hook-cutover.sh -- the explicit, EXPLICIT-STEP-AFTER-LAND live cutover for card
# 9ed32347 (unlazy Stop hook hash-pin wrapper), and its own tested rollback (CYBERED NO-GO 39489
# F-6: "no committed or tested rollback" on the first attempt).
#
# --apply REFUSES unless the wrapper file is already in place, executable, and passes its own pin
# check against the live skill (CYBERED NO-GO 39499 F-4): wiring settings.json to an absolute path
# this script never checks for is exactly the incident class that bounced this card once already
# (msg 25615 -- settings rewired before the wrapper existed in the live checkout, every agent's
# Stop hook broken). --rollback has no such precondition (it only removes a reference to the
# wrapper, it never requires the wrapper to be in a working state).
#
# RULE THIS SCRIPT EXISTS TO FOLLOW (MikroB decision 39490, msg 25618/25620, 2026-11-27): no live
# settings.json / hook change happens before a card's gates pass AND it lands. The first attempt
# at this card rewired 15 live settings.json files BEFORE store/unlazy-stop-hook-verified.sh
# existed in the live checkout, breaking every fleet agent's Stop hook until caught (self-reported,
# msg 25615) and then rolled back entirely (msg 25620/comment 39491). This script is the live step
# that runs ONLY after the card has landed -- never bundled into the card's own commit, and never
# run by an agent without being told to.
#
# Covers EVERY settings layer carrying this Stop hook, including the one the first attempt missed
# (CYBERED F-5): penzugy's agents/penzugy/.claude-config/settings.json, which merges with its
# agents/penzugy/.claude/settings.json and was still on the old direct exec after the v1 rewire.
#
# Usage:
#   unlazy-stop-hook-cutover.sh --dry-run            (default if no mode given -- shows the diff, changes nothing)
#   unlazy-stop-hook-cutover.sh --apply               (old direct exec -> wrapper, backs up first)
#   unlazy-stop-hook-cutover.sh --rollback            (wrapper -> old direct exec, backs up first)
#   unlazy-stop-hook-cutover.sh --apply --root <dir>  (test seam: operate under <dir> instead of
#                                                       the real paths below -- see the .selftest.sh)
#
# Exit: 0 ok | 1 a file failed JSON-validation after the edit (nothing is left half-applied: this
#             script edits a WORKING COPY per file and only overwrites the real path once that
#             copy validates) | 2 bad usage
set -uo pipefail

MODE=""
ROOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  MODE="dry-run"; shift ;;
    --apply)    MODE="apply"; shift ;;
    --rollback) MODE="rollback"; shift ;;
    --root)     ROOT="$2"; shift 2 ;;
    *) echo "unlazy-stop-hook-cutover: unknown arg '$1'" >&2; exit 2 ;;
  esac
done
MODE="${MODE:-dry-run}"

OLD_CMD="'/usr/bin/node' '/home/neon/.claude/skills/unlazy/scripts/stop-hook.mjs' --unlazy"
NEW_CMD="'/usr/bin/bash' '/home/neon/marveen/store/unlazy-stop-hook-verified.sh' --unlazy"

# All 16 layers carrying this Stop hook (CYBERED's grep, extended: the 15 from the card's own
# Kész-ha 1 grep PLUS penzugy's separate .claude-config layer, F-5).
agents=(backend backend2 cybered cybersec fron-ted fron-teddy fullstack jogasz marketing penzugy qa qa2 teszter videooo)
FILES=()
for a in "${agents[@]}"; do
  FILES+=("${ROOT}/home/neon/marveen/agents/$a/.claude/settings.json")
done
FILES+=("${ROOT}/home/neon/.claude/settings.json")
FILES+=("${ROOT}/home/neon/marveen/agents/penzugy/.claude-config/settings.json")

BACKUP_DIR="${ROOT}/home/neon/.claude/unlazy-stop-hook-cutover-backups/$(date +%Y%m%d-%H%M%S)-$MODE"
WRAPPER_PATH="${ROOT}/home/neon/marveen/store/unlazy-stop-hook-verified.sh"

echo "mode: $MODE"
echo "backup dir (apply/rollback only): $BACKUP_DIR"
echo ""

# F-4: --apply must refuse unless the wrapper is already in place, executable, and its OWN pin
# check currently passes against the live skill -- never wire settings.json to a path that is
# missing, non-executable, or would immediately block every Stop of every agent.
if [[ "$MODE" == "apply" ]]; then
  if [[ ! -f "$WRAPPER_PATH" ]]; then
    echo "REFUSING apply: wrapper not found at $WRAPPER_PATH -- wiring settings to a path that does not exist repeats the msg 25615 incident" >&2
    exit 1
  fi
  if [[ ! -x "$WRAPPER_PATH" ]]; then
    echo "REFUSING apply: wrapper at $WRAPPER_PATH exists but is not executable" >&2
    exit 1
  fi
  precheck_out="$(printf '{"cwd":"/tmp"}' | bash "$WRAPPER_PATH" --unlazy 2>/dev/null)"
  precheck_rc=$?
  if [[ "$precheck_rc" != "0" ]] || printf '%s' "$precheck_out" | grep -q "unlazy-stop-hook-verified:"; then
    echo "REFUSING apply: wrapper at $WRAPPER_PATH did not pass its own pin check (rc=$precheck_rc out=$precheck_out) -- fix the pin mismatch or re-vendor before wiring settings to it" >&2
    exit 1
  fi
  echo "precondition ok: $WRAPPER_PATH exists, is executable, and passed its own pin check"
  echo ""
fi

from_cmd="$OLD_CMD"; to_cmd="$NEW_CMD"
[[ "$MODE" == "rollback" ]] && { from_cmd="$NEW_CMD"; to_cmd="$OLD_CMD"; }

fail=0
changed=0
for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "SKIP (not found): $f"
    continue
  fi
  if ! grep -qF "$from_cmd" "$f"; then
    if grep -qF "$to_cmd" "$f"; then
      echo "already-$MODE: $f"
    else
      echo "NEITHER command found, leaving untouched: $f"
    fi
    continue
  fi
  n_from="$(grep -oF "$from_cmd" "$f" | wc -l)"
  if [[ "$n_from" != "1" ]]; then
    echo "REFUSING $f: expected exactly 1 occurrence of the source command, found $n_from"
    fail=1
    continue
  fi

  if [[ "$MODE" == "dry-run" ]]; then
    echo "would change: $f"
    changed=$((changed + 1))
    continue
  fi

  mkdir -p "$BACKUP_DIR"
  backup_name="$(printf '%s' "$f" | tr '/' '_').bak"
  cp "$f" "$BACKUP_DIR/$backup_name"

  # mktemp IN THE SAME DIRECTORY as $f, not the system temp dir: `mv` across filesystems silently
  # falls back to copy+delete (no longer atomic, reintroducing the half-written-file risk the
  # rename was meant to close). Same directory guarantees same filesystem.
  work="$(mktemp "$(dirname "$f")/.unlazy-cutover.XXXXXX")"
  python3 -c "
import sys
p = sys.argv[1]
src = sys.argv[2]
dst = sys.argv[3]
with open(p) as fh:
    text = fh.read()
assert text.count(src) == 1, 'expected exactly one occurrence'
text = text.replace(src, dst)
sys.stdout.write(text)
" "$f" "$from_cmd" "$to_cmd" > "$work"

  if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$work" >/dev/null 2>&1; then
    echo "FAIL: $f -- edited copy is not valid JSON, NOT applying (original untouched, backup at $BACKUP_DIR/$backup_name)"
    rm -f "$work"
    fail=1
    continue
  fi

  # preserve the original file's mode -- mktemp always creates 0600, which happens to match
  # every live settings.json today, but nothing here should depend on that coincidence.
  chmod --reference="$f" "$work" 2>/dev/null || true
  # mv (same filesystem, atomic rename) instead of cp+rm: a reader can never observe a
  # half-written $f (CYBERED 39499, LOW).
  mv "$work" "$f"
  echo "$MODE done: $f (backup: $BACKUP_DIR/$backup_name)"
  changed=$((changed + 1))
done

echo ""
echo "summary: mode=$MODE changed=$changed fail=$fail"
[[ "$fail" == "0" ]] && exit 0 || exit 1

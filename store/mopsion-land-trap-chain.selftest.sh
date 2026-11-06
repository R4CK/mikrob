#!/usr/bin/env bash
# Self-test for the EXIT-trap chain in mopsion-land.sh (card 88b67fb4 delta, WhiteHat M1).
#
# WHY A SEPARATE FILE. The bug was never in land-run-journal.sh or land-run-stale-check.sh -- both
# passed their own selftests 3/3 before this finding. It was in mopsion-land.sh's SHELL WIRING:
# `trap cleanup EXIT` was registered a second time further down the script, and bash keeps only
# ONE handler per signal, so the second registration silently replaced the first and the journal's
# `finish` call never ran for any landing that got as far as creating the worktree -- i.e. every
# healthy run. A selftest confined to land-run-journal.sh/land-run-stale-check.sh can never catch
# this class of bug, because the bug is not in what those scripts do, it is in whether mopsion-
# land.sh's own trap registration actually CALLS them.
#
# HOW THIS AVOIDS DRIFT. Re-implementing the trap/cleanup block here in prose would test a copy,
# not the real code -- exactly the "selftest never called the real path" trap this card's own
# history (see the comments throughout mopsion-land.sh about MUT-NORETRY etc.) warns about
# repeatedly. Instead this EXTRACTS the literal, currently-committed lines from mopsion-land.sh
# (between the two sed anchors below) and `eval`s them in a tiny harness with MAIN/WT/CARD
# stubbed -- so a future edit that reintroduces a second `trap ... EXIT` downstream, or otherwise
# breaks the chain, breaks THIS test too, without anyone needing to remember to update it.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAND_SCRIPT="$HERE/mopsion-land.sh"
fail=0

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export LAND_RUN_JOURNAL_FILE="$WORK/land-runs.jsonl"

ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; fail=1; }

TRAP_BLOCK="$(sed -n '/^_LAND_RUN_JOURNAL="\$(dirname "\$0")\/land-run-journal\.sh"$/,/^trap cleanup EXIT$/p' "$LAND_SCRIPT")"
[ -n "$TRAP_BLOCK" ] || { echo "FATAL: could not extract the trap block from $LAND_SCRIPT -- anchors moved" >&2; exit 1; }
case "$TRAP_BLOCK" in
  *"trap cleanup EXIT"*) : ;;
  *) echo "FATAL: extracted block does not end in 'trap cleanup EXIT'" >&2; exit 1 ;;
esac
# Exactly one `trap ... EXIT` in the extracted block -- the regression this test exists to catch
# is a SECOND one further down in mopsion-land.sh replacing this one; it must not sneak back into
# the block between these two anchors either.
trap_count="$(printf '%s\n' "$TRAP_BLOCK" | grep -c '^trap .* EXIT$')"
[ "$trap_count" -eq 1 ] || bad "extracted block registers $trap_count EXIT traps, expected exactly 1"

# Case A: the extracted block runs, WT gets set (simulating "worktree created"), then the process
# exits 0 normally -- the journal must show a `finished` line, result ok.
out_a="$(bash -c '
MAIN="/tmp/does-not-need-to-exist-for-this-test"
CARD="cardA"
LANDED_BY="backend"
'"$TRAP_BLOCK"'
WT="'"$WORK"'/fake-wt-a"
mkdir -p "$WT"
echo "$_LAND_RUN_ID"
exit 0
' "$LAND_SCRIPT")"
rid_a="$(printf '%s\n' "$out_a" | tail -n1)"
if [ -z "$rid_a" ]; then
  bad "case A printed no run_id"
else
  if grep -q "\"run_id\": *\"$rid_a\".*\"event\": *\"finished\"\|\"event\": *\"finished\".*$rid_a" "$LAND_RUN_JOURNAL_FILE" 2>/dev/null \
     || python3 -c '
import json, sys
rid = sys.argv[2]
found = False
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("run_id") == rid and rec.get("event") == "finished" and rec.get("result") == "ok":
            found = True
sys.exit(0 if found else 1)
' "$LAND_RUN_JOURNAL_FILE" "$rid_a"; then
    ok "case A (clean exit 0, after \$WT is set): journal has a finished/ok line -- trap chain fired"
  else
    bad "case A: no finished/ok line for run_id=$rid_a -- the EXIT trap did not run the journal finish"
  fi
fi

# Case B: an EARLY exit (simulating die() before the worktree is ever created, so $WT is never
# set) must still produce a `finished` line -- the journal side of the barrier must not depend on
# reaching the worktree step.
out_b="$(bash -c '
MAIN="/tmp/does-not-need-to-exist-for-this-test"
CARD="cardB"
LANDED_BY="backend"
'"$TRAP_BLOCK"'
echo "$_LAND_RUN_ID"
exit 3
' "$LAND_SCRIPT" || true)"
rid_b="$(printf '%s\n' "$out_b" | tail -n1)"
if [ -z "$rid_b" ]; then
  bad "case B printed no run_id"
else
  if python3 -c '
import json, sys
rid = sys.argv[2]
found = False
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("run_id") == rid and rec.get("event") == "finished" and rec.get("exit_code") == "3":
            found = True
sys.exit(0 if found else 1)
' "$LAND_RUN_JOURNAL_FILE" "$rid_b"; then
    ok "case B (early exit 3, \$WT never set): journal has a finished/exit_code=3 line"
  else
    bad "case B: no finished line (exit_code=3) for run_id=$rid_b -- an early die() would read as STALE forever"
  fi
fi

echo "mopsion-land.sh trap-chain selftest done"
[ "$fail" -eq 0 ] && echo "selftest: PASS" || echo "selftest: FAIL"
exit "$fail"

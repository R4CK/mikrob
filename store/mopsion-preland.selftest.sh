#!/usr/bin/env bash
# Self-test for mopsion-preland.sh (card 08eb6402, MikroB plan-grilling verdict 6011/3748).
#
# Isolates the ORCHESTRATION this file owns (per-card lock, idempotency-by-tree-hash, worktree
# lifecycle for the suite run, output-line shape) from mopsion-land.sh's own merge/tsc/seam/format
# logic, which already has 85 cases in its OWN --selftest -- re-testing that here would duplicate
# coverage without adding confidence. A stub `PRELAND_LAND_SCRIPT` stands in for it, driven by the
# card id so each case controls exactly what "prepare" returns.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/mopsion-preland.sh"
fail=0
n=0

WORK="$(mktemp -d)"
MAIN="$WORK/main-clone"
git init -q -b main "$MAIN"
git -C "$MAIN" config user.email s@s
git -C "$MAIN" config user.name s
echo base > "$MAIN/a.txt"
git -C "$MAIN" add a.txt
git -C "$MAIN" commit -qm base
BASE_SHA="$(git -C "$MAIN" rev-parse HEAD)"

# A commit that will stand in for "the prepared merge result" -- content differs from BASE, so it
# has its own real tree hash the worktree-add step can actually check out.
git -C "$MAIN" checkout -q -b prepped
echo prepared > "$MAIN/a.txt"
git -C "$MAIN" commit -qam prepared
PREPPED_SHA="$(git -C "$MAIN" rev-parse HEAD)"
PREPPED_TREE="$(git -C "$MAIN" rev-parse HEAD^{tree})"
git -C "$MAIN" checkout -q main

# A stub node_modules/vitest so a REAL suite-run leg can complete inside the worktree-add checkout.
mkdir -p "$MAIN/node_modules/.bin"
cat > "$MAIN/node_modules/.bin/vitest" <<'PYEOF'
#!/usr/bin/env bash
echo " Test Files  1 passed (1)"
echo "      Tests  5 passed (5)"
exit 0
PYEOF
chmod +x "$MAIN/node_modules/.bin/vitest"
# The checked-out worktree needs the SAME node_modules -- worktree-add does not copy untracked
# files, so this is committed (deliberately, this is a scratch fixture repo, not a real one).
git -C "$MAIN" add -f node_modules/.bin/vitest
git -C "$MAIN" commit -qm "fixture vitest"
git -C "$MAIN" checkout -q prepped
git -C "$MAIN" merge -q main -m merge-vitest-in
PREPPED_SHA="$(git -C "$MAIN" rev-parse HEAD)"
PREPPED_TREE="$(git -C "$MAIN" rev-parse HEAD^{tree})"
git -C "$MAIN" checkout -q main

# The stub prepare script: PREPARED|<sha>|<tree> for "prepped-*" cards, a refusal for anything else.
STUB_LAND="$WORK/stub-land.sh"
cat > "$STUB_LAND" <<STUBEOF
#!/usr/bin/env bash
card="\$1"
case "\$card" in
  prepped-*) echo "PREPARED|$PREPPED_SHA|$PREPPED_TREE" ;;
  *) echo "REFUSED: fake refusal for \$card" >&2; exit 4 ;;
esac
STUBEOF
chmod +x "$STUB_LAND"

EVSTORE="$WORK/evidence.jsonl"
EVLOGS="$WORK/evidence-logs"

run_preland() { # $@ = args
  env PRELAND_LAND_SCRIPT="$STUB_LAND" CLEANCORE_MAIN="$MAIN" \
      SUITE_EVIDENCE_STORE="$EVSTORE" SUITE_EVIDENCE_LOG_DIR="$EVLOGS" \
      CLEANCORE_SUITE_LOCK_PREFIX="$WORK/.slot" CLEANCORE_SUITE_API="http://127.0.0.1:9" \
      PRELAND_LOCK_DIR="$WORK" \
      bash "$TOOL" "$@"
}

case_() { # $1 label, $2 expected-prefix, $@ rest = preland args -- prints the raw output on stdout,
          # the ok/FAIL line on stderr, so a caller can capture $(...) and still see progress.
  n=$((n + 1))
  local label="$1" expect="$2"; shift 2
  local out
  out="$(run_preland "$@")"
  local kind="${out%%|*}"
  if [ "$kind" = "$expect" ]; then
    echo "  ok   $label" >&2
  else
    echo "  FAIL $label -> expected $expect, got: $out" >&2
    fail=1
  fi
  printf '%s' "$out"
}

echo "mopsion-preland selftest"

o1="$(case_ "a prepare refusal (bad merge) reports FAILED with no sha/tree" FAILED prep-fails-1 abc123)"

# mopsion-suite-run.sh always runs TWO legs (main + api-e2e, card cae9fb67) against the same fixture
# vitest, so 5 passed per leg sums to 10 -- expected, not a fixture bug.
o2="$(case_ "a valid prepare + real suite run reports READY with real counts" READY prepped-ok-1 abc123)"
n=$((n + 1))
if printf '%s' "$o2" | grep -q "pass=10 fail=0"; then
  echo "  ok   ...and the counts are the REAL ones from the fixture vitest (5+5 across both legs)"
else
  echo "  FAIL counts not as expected: $o2"; fail=1
fi

n=$((n + 1))
o3="$(case_ "the SAME card+sha again is IDEMPOTENT -- no second suite run, still READY" READY prepped-ok-1 abc123)"
if printf '%s' "$o3" | grep -q "pass=10 fail=0"; then
  echo "  ok   ...and the evidence store still shows exactly one record for that tree"
  n=$((n + 1))
  count="$(grep -c "\"tree\": \"$PREPPED_TREE\"" "$EVSTORE" 2>/dev/null || echo 0)"
  if [ "$count" = "1" ]; then
    echo "  ok   exactly one evidence record exists for the tree (no duplicate suite run)"
  else
    echo "  FAIL expected exactly 1 evidence record, found $count"; fail=1
  fi
fi

# --- the per-card lock: a lock already held must answer RUNNING, not double-execute -------------
n=$((n + 1))
LOCKED_CARD="locked-card-1"
exec {HOLDFD}>"$WORK/.preland-$LOCKED_CARD.lock"
flock "$HOLDFD"
out="$(run_preland "$LOCKED_CARD" abc123)"
flock -u "$HOLDFD"
if [ "$out" = "RUNNING|$LOCKED_CARD" ]; then
  echo "  ok   a card whose lock is already held answers RUNNING, does not re-enter"
else
  echo "  FAIL expected RUNNING|$LOCKED_CARD, got: $out"; fail=1
fi

# --- usage / bad invocation -----------------------------------------------------------------
n=$((n + 1))
if run_preland >/dev/null 2>&1; then
  echo "  FAIL no arguments at all must be a usage error"; fail=1
else
  echo "  ok   no arguments at all is a usage error (exit non-zero)"
fi

n=$((n + 1))
if run_preland onlyonearg >/dev/null 2>&1; then
  echo "  FAIL a card with no sha argument must be a usage error"; fail=1
else
  echo "  ok   a card with no sha argument is a usage error"
fi

rm -rf "$WORK"

echo ""
echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

#!/usr/bin/env bash
# kg-import-mt10.selftest.sh -- card 01b10349: proves kg-import-mt10.sh's flock is a real
# single-flight guard (same shape as kg-capture-worker.selftest.sh's G2 proof) AND that it never
# goes through the local-llm INSTALLED gate (no call to local-llm-installed.sh, unlike
# kg-backfill.sh) -- this importer is pure DB-to-DB and must run with no GPU/model present.
# Does not touch the real knowledge-graph.db or claudeclaw.db: npx is stubbed in a scratch PATH.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cp "$HERE/kg-import-mt10.sh" "$TMPDIR/kg-import-mt10.sh"
chmod +x "$TMPDIR/kg-import-mt10.sh"

mkdir -p "$TMPDIR/fakebin" "$TMPDIR/fakemain/scripts"
RUN_MARKER="$TMPDIR/ran.count"
cat > "$TMPDIR/fakebin/npx" <<EOF
#!/usr/bin/env bash
echo "1" >> "$RUN_MARKER"
sleep 1
EOF
chmod +x "$TMPDIR/fakebin/npx"
touch "$TMPDIR/fakemain/scripts/kg-import-mt10.ts"

PASS=0
FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    echo "FAIL: $desc"
    echo "  want: $want"
    echo "  got:  $got"
  fi
}

export PATH="$TMPDIR/fakebin:$PATH"
export MARVEEN_MAIN="$TMPDIR/fakemain"

# --- case 1: two concurrent invocations -- exactly one proceeds into npx, the other exits 0
# immediately with the skip message. ------------------------------------------------------------
LOCK_A="$TMPDIR/case1.lock"
out1="$TMPDIR/out1.log"
out2="$TMPDIR/out2.log"
KG_IMPORT_MT10_LOCK="$LOCK_A" bash "$TMPDIR/kg-import-mt10.sh" > "$out1" 2>&1 &
pid1=$!
sleep 0.2
KG_IMPORT_MT10_LOCK="$LOCK_A" bash "$TMPDIR/kg-import-mt10.sh" > "$out2" 2>&1
rc2=$?
wait "$pid1"
rc1=$?

check "case1: first run exits 0" "$rc1" "0"
check "case1: second (blocked) run also exits 0 (skip, not a failure)" "$rc2" "0"
check "case1: second run never entered npx" "$(grep -c "skipping" "$out2")" "1"
check "case1: npx ran exactly once, not twice" "$(cat "$RUN_MARKER" 2>/dev/null | wc -l | tr -d ' ')" "1"

# --- case 2: sequential runs (lock released between them) both proceed -------------------------
: > "$RUN_MARKER"
LOCK_B="$TMPDIR/case2.lock"
KG_IMPORT_MT10_LOCK="$LOCK_B" bash "$TMPDIR/kg-import-mt10.sh" > /dev/null 2>&1
KG_IMPORT_MT10_LOCK="$LOCK_B" bash "$TMPDIR/kg-import-mt10.sh" > /dev/null 2>&1
check "case2: two SEQUENTIAL runs (lock released between them) both proceed" \
  "$(cat "$RUN_MARKER" | wc -l | tr -d ' ')" "2"

# --- CONTROL: different lock files -> no contention -> both proceed ----------------------------
: > "$RUN_MARKER"
KG_IMPORT_MT10_LOCK="$TMPDIR/control-a.lock" bash "$TMPDIR/kg-import-mt10.sh" > "$TMPDIR/ctrl1.log" 2>&1 &
pidc1=$!
sleep 0.2
KG_IMPORT_MT10_LOCK="$TMPDIR/control-b.lock" bash "$TMPDIR/kg-import-mt10.sh" > "$TMPDIR/ctrl2.log" 2>&1
wait "$pidc1"
check "CONTROL: different lock files -> no contention -> npx ran twice" \
  "$(cat "$RUN_MARKER" | wc -l | tr -d ' ')" "2"

# --- case 3: no local-llm-installed.sh gate -- unlike kg-backfill.sh, this script must NOT even
# reference local-llm-installed.sh, since it has no LLM dependency. -----------------------------
check "case3: script does not call local-llm-installed.sh (no LLM gate)" \
  "$(grep -c "local-llm-installed" "$HERE/kg-import-mt10.sh")" "0"

echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]

#!/usr/bin/env bash
# kg-import-mt10.selftest.sh -- card 01b10349: proves kg-import-mt10.sh's flock is a real
# single-flight guard (same shape as kg-capture-worker.selftest.sh's G2 proof) AND that it never
# goes through the local-llm INSTALLED gate (no call to local-llm-installed.sh, unlike
# kg-backfill.sh) -- this importer is pure DB-to-DB and must run with no GPU/model present.
# Does not touch the real knowledge-graph.db or claudeclaw.db: the wrapper's own tsx resolution
# (CYBERED F-1, NO-GO 39527) is stubbed via a fake MARVEEN_MAIN/node_modules/.bin/tsx, never npx.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cp "$HERE/kg-import-mt10.sh" "$TMPDIR/kg-import-mt10.sh"
chmod +x "$TMPDIR/kg-import-mt10.sh"

mkdir -p "$TMPDIR/fakebin" "$TMPDIR/fakemain/scripts" "$TMPDIR/fakemain/node_modules/.bin"
RUN_MARKER="$TMPDIR/ran.count"
cat > "$TMPDIR/fakemain/node_modules/.bin/tsx" <<EOF
#!/usr/bin/env bash
echo "1" >> "$RUN_MARKER"
sleep 1
EOF
chmod +x "$TMPDIR/fakemain/node_modules/.bin/tsx"
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

# --- case 1: two concurrent invocations -- exactly one proceeds into tsx, the other exits 0
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
check "case1: second run never entered tsx" "$(grep -c "skipping" "$out2")" "1"
check "case1: tsx ran exactly once, not twice" "$(cat "$RUN_MARKER" 2>/dev/null | wc -l | tr -d ' ')" "1"

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
check "CONTROL: different lock files -> no contention -> tsx ran twice" \
  "$(cat "$RUN_MARKER" | wc -l | tr -d ' ')" "2"

# --- case 3: no local-llm-installed.sh gate -- unlike kg-backfill.sh, this script must NOT even
# reference local-llm-installed.sh, since it has no LLM dependency. -----------------------------
check "case3: script does not call local-llm-installed.sh (no LLM gate)" \
  "$(grep -c "local-llm-installed" "$HERE/kg-import-mt10.sh")" "0"

# --- case 4 (CYBERED F-1, 39527): no local node_modules/.bin/tsx -> fail loudly, never npx ------
MAIN_NO_TSX="$TMPDIR/fakemain-no-tsx"
mkdir -p "$MAIN_NO_TSX/scripts"
touch "$MAIN_NO_TSX/scripts/kg-import-mt10.ts"
NPX_MARKER="$TMPDIR/npx-ran.count"
mkdir -p "$TMPDIR/fakebin-npx-trap"
cat > "$TMPDIR/fakebin-npx-trap/npx" <<EOF
#!/usr/bin/env bash
echo "1" >> "$NPX_MARKER"
EOF
chmod +x "$TMPDIR/fakebin-npx-trap/npx"
LOCK_C="$TMPDIR/case4.lock"
out4="$TMPDIR/out4.log"
PATH="$TMPDIR/fakebin-npx-trap:$PATH" MARVEEN_MAIN="$MAIN_NO_TSX" \
  KG_IMPORT_MT10_LOCK="$LOCK_C" bash "$TMPDIR/kg-import-mt10.sh" > "$out4" 2>&1
rc4=$?
check "case4: missing local tsx -> non-zero exit" "$rc4" "1"
check "case4: missing local tsx -> never fetched npx" "$([[ -f "$NPX_MARKER" ]] && echo yes || echo no)" "no"
check "case4: missing local tsx -> loud error message" "$(grep -c "node_modules/.bin/tsx" "$out4")" "1"

# --- case 5: local node_modules/.bin/tsx present (the default fakemain above) -> run it
# directly, never npx -----------------------------------------------------------------------
: > "$RUN_MARKER"
LOCK_D="$TMPDIR/case5.lock"
KG_IMPORT_MT10_LOCK="$LOCK_D" bash "$TMPDIR/kg-import-mt10.sh" > "$TMPDIR/out5.log" 2>&1
rc5=$?
check "case5: local tsx present -> exits 0" "$rc5" "0"
check "case5: local tsx present -> ran the local binary" "$(cat "$RUN_MARKER" 2>/dev/null | wc -l | tr -d ' ')" "1"

# --- case 6 (mutant pin): "npx ... tsx" must never appear in the script ------------------------
check "case6: script never spells npx tsx (no registry fallback)" \
  "$(grep -c "npx.*tsx" "$HERE/kg-import-mt10.sh")" "0"

echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]

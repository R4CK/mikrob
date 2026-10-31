#!/usr/bin/env bash
# graphify-fortran-guard.selftest.sh -- card b7540305 (F-1 cheap compensating control): proves
# `store/graphify.sh build <repo>` refuses a tree carrying an uppercase-F Fortran file, instead of
# reaching the pinned graphify binary's vulnerable Fortran #include extractor (GHSA-pcc4-rvhr-2pr8).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/graphify.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
declare -a FAILED=()
check() { if [ "$1" = "$2" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); FAILED+=("$3: expected [$2] got [$1]"); fi; }

# A fake, always-exec-OK graphify binary so the guard itself is isolated from the real pinned
# install (and from needing bwrap/network); if the guard lets a call through, this records it.
FAKE_BIN="$TMP/fake-graphify"
cat > "$FAKE_BIN" << 'EOF'
#!/usr/bin/env bash
echo "graphify called: $*" >> "$GRAPHIFY_CALL_LOG"
echo "graphify 0.9.67"
exit 0
EOF
chmod +x "$FAKE_BIN"
export GRAPHIFY_BIN="$FAKE_BIN"
export GRAPHIFY_CALL_LOG="$TMP/calls.log"
touch "$GRAPHIFY_CALL_LOG"

# --- case 1: a clean repo (no Fortran at all) builds fine, guard does not false-positive --------
CLEAN="$TMP/clean-repo"
mkdir -p "$CLEAN"
echo 'print("hi")' > "$CLEAN/main.py"
: > "$GRAPHIFY_CALL_LOG"
bash "$SCRIPT" build "$CLEAN" > "$TMP/out1" 2>&1
RC1=$?
check "$RC1" "0" "clean repo: build exits 0"
CALLED1=$(grep -c "graphify called" "$GRAPHIFY_CALL_LOG")
check "$CALLED1" "1" "clean repo: the real build path was actually reached"

# --- case 2: lowercase .f90 (free-form, not preprocessed) is NOT blocked -------------------------
LOWER="$TMP/lower-repo"
mkdir -p "$LOWER"
echo '! lowercase fortran, not the vulnerable preprocessed path' > "$LOWER/mod.f90"
: > "$GRAPHIFY_CALL_LOG"
bash "$SCRIPT" build "$LOWER" > "$TMP/out2" 2>&1
RC2=$?
check "$RC2" "0" "lowercase .f90: build is not blocked (not the CVE's file class)"

# --- case 3: an uppercase .F file is refused, real binary never reached -------------------------
UPPER="$TMP/upper-repo"
mkdir -p "$UPPER"
echo '! fixed-form, preprocessed' > "$UPPER/legacy.F"
: > "$GRAPHIFY_CALL_LOG"
bash "$SCRIPT" build "$UPPER" > "$TMP/out3" 2>&1
RC3=$?
check "$RC3" "7" "uppercase .F: build refused with the dedicated exit code"
CALLED3=$(grep -c "graphify called" "$GRAPHIFY_CALL_LOG")
check "$CALLED3" "0" "uppercase .F: the real build path was NEVER reached"
grep -q "GHSA-pcc4" "$TMP/out3"
check "$?" "0" "uppercase .F: error message names the CVE"

# --- case 4: an uppercase .F90 file nested in a subdirectory is also caught ----------------------
NESTED="$TMP/nested-repo"
mkdir -p "$NESTED/src/vendor"
echo '! nested' > "$NESTED/src/vendor/physics.F90"
: > "$GRAPHIFY_CALL_LOG"
bash "$SCRIPT" build "$NESTED" > "$TMP/out4" 2>&1
RC4=$?
check "$RC4" "7" "nested uppercase .F90: build refused"
CALLED4=$(grep -c "graphify called" "$GRAPHIFY_CALL_LOG")
check "$CALLED4" "0" "nested uppercase .F90: the real build path was never reached"

echo
echo "selftest: $((PASS+FAIL)) case(s), PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'FAILED: %s\n' "${FAILED[@]}"
  exit 1
fi

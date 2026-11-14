#!/usr/bin/env bash
# Self-test for store/tmp-inode-guard.sh (card b1813ab2).
#
# Run: bash store/tmp-inode-guard.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# HERMETIC: TMP_GUARD_ROOT points every case at its own sandbox dir, never the real
# /tmp -- other agents' live processes are writing real /tmp/tmp.* dirs concurrently,
# and this script's job is `rm -rf` on exactly that pattern.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/tmp-inode-guard.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

run() { TMP_GUARD_ROOT="$SANDBOX" TMP_GUARD_ALERT_DRYRUN=1 bash "$RUN"; }

# --- 1. an old, untouched tmp.* dir is removed ----------------------------------------------------
mkdir -p "$SANDBOX/tmp.old"
touch -d '3 hours ago' "$SANDBOX/tmp.old"
find "$SANDBOX/tmp.old" -exec touch -d '3 hours ago' {} \;
run
if [ ! -e "$SANDBOX/tmp.old" ]; then
  ok "an old untouched dir is removed"
else
  bad "tmp.old survived the sweep"
fi

# --- 2. a dir with a FRESH file inside is kept, even if the dir itself is old (Cybersec LOW-2,
# 31235): creating a NEW file inside a dir refreshes the DIR's own mtime too (a directory-entry
# side effect), so the old ordering (age the dir, then create the file) made this vacuous against
# a `find -maxdepth 0` (dir-only) mutant -- that mutant also saw a fresh dir and passed by
# accident. Creating the file FIRST and THEN aging the dir's own mtime means only the file stays
# fresh, so only a RECURSIVE walk of the dir's contents can see it.
mkdir -p "$SANDBOX/tmp.active"
echo x > "$SANDBOX/tmp.active/still-writing"
touch -d '3 hours ago' "$SANDBOX/tmp.active"
run
if [ -d "$SANDBOX/tmp.active" ]; then
  ok "a dir with a fresh file inside is kept (dir's own mtime is old, only the file is fresh)"
else
  bad "tmp.active was removed despite a fresh file inside"
fi
rm -rf "$SANDBOX/tmp.active"

# --- 2b. same shape, nested two levels deep, APPENDED to (not created) -- appending to an
# EXISTING file never touches any parent directory's mtime, which is the realistic "a long test
# is still writing its log" case the script's own header comment describes.
mkdir -p "$SANDBOX/tmp.deep/a/b"
echo "old line" > "$SANDBOX/tmp.deep/a/b/log"
find "$SANDBOX/tmp.deep" -exec touch -d '5 hours ago' {} \;
touch -d '5 hours ago' "$SANDBOX/tmp.deep"
echo "new line" >> "$SANDBOX/tmp.deep/a/b/log"
run
if [ -d "$SANDBOX/tmp.deep" ]; then
  ok "appending to a nested, existing file keeps the whole dir chain"
else
  bad "tmp.deep was removed despite a just-appended nested file"
fi
rm -rf "$SANDBOX/tmp.deep"

# --- 3. a dir owned by another uid is kept, even if old ---------------------------------------------
# No real second uid is available in this sandbox (no root/sudo here), so the ownership check
# itself is exercised by stubbing `stat` on PATH for exactly this one case -- the repo's own
# convention for uid conditions that cannot be created for real (see store/*.selftest.sh stubs).
mkdir -p "$SANDBOX/tmp.otheruid"
touch -d '3 hours ago' "$SANDBOX/tmp.otheruid"
STUBDIR="$(mktemp -d)"
cat > "$STUBDIR/stat" <<'STUB'
#!/usr/bin/env bash
# Reports a foreign uid for the one dir this case cares about, real stat otherwise.
for a in "$@"; do
  case "$a" in
    *tmp.otheruid) echo 999999; exit 0 ;;
  esac
done
exec /usr/bin/stat "$@"
STUB
chmod +x "$STUBDIR/stat"
PATH="$STUBDIR:$PATH" run
if [ -d "$SANDBOX/tmp.otheruid" ]; then
  ok "a dir owned by another uid is kept"
else
  bad "tmp.otheruid was removed despite belonging to another uid"
fi
rm -rf "$STUBDIR" "$SANDBOX/tmp.otheruid"

# --- 4. nothing outside ROOT/tmp.* is touched -------------------------------------------------------
mkdir -p "$SANDBOX/not-tmp-prefixed"
touch -d '3 hours ago' "$SANDBOX/not-tmp-prefixed"
echo keep > "$SANDBOX/sibling-file"
touch -d '3 hours ago' "$SANDBOX/sibling-file"
run
if [ -d "$SANDBOX/not-tmp-prefixed" ] && [ -f "$SANDBOX/sibling-file" ]; then
  ok "a dir/file not matching tmp.* is left alone"
else
  bad "something outside the tmp.* glob was removed"
fi
rm -rf "$SANDBOX/not-tmp-prefixed" "$SANDBOX/sibling-file"

# --- 5. the marveen-land.sh selftest-leak case (caseA marker) uses the SHORT window -----------------
mkdir -p "$SANDBOX/tmp.leak/caseA"
touch -d '15 minutes ago' "$SANDBOX/tmp.leak"
find "$SANDBOX/tmp.leak" -exec touch -d '15 minutes ago' {} \;
run
if [ ! -e "$SANDBOX/tmp.leak" ]; then
  ok "a selftest-leak dir (caseA marker) is removed after the short LEAK_AGE_MIN window"
else
  bad "tmp.leak survived past the short leak window"
fi

# --- 5b. Cybersec LOW-1 (31235): the LOWER bound of each default window was unpinned -- a mutant
# shrinking the default (120->5, 10->1) still passed 8/8, because every other case used ages far
# outside either value. These pin the defaults from the inside.
mkdir -p "$SANDBOX/tmp.midage"
touch -d '60 minutes ago' "$SANDBOX/tmp.midage"
find "$SANDBOX/tmp.midage" -exec touch -d '60 minutes ago' {} \;
run
if [ -d "$SANDBOX/tmp.midage" ]; then
  ok "a 60-minute-old plain dir is kept (pins the general window near its real 120-min default)"
else
  bad "tmp.midage (60 min old) was removed -- the general window shrank below 60"
fi
rm -rf "$SANDBOX/tmp.midage"

mkdir -p "$SANDBOX/tmp.midleak/caseA"
touch -d '5 minutes ago' "$SANDBOX/tmp.midleak"
find "$SANDBOX/tmp.midleak" -exec touch -d '5 minutes ago' {} \;
run
if [ -d "$SANDBOX/tmp.midleak" ]; then
  ok "a 5-minute-old caseA dir is kept (pins the leak window near its real 10-min default)"
else
  bad "tmp.midleak (5 min old) was removed -- the leak window shrank below 5"
fi
rm -rf "$SANDBOX/tmp.midleak"

# --- 5c. Cybersec LOW-3 (31235): a garbage/zero/negative age env must fall back to the built-in
# default, not silently delete something fresh. Without validation, `find -mmin -abc` errors,
# stderr is discarded, the empty output reads as "nothing fresh", and a dir holding a file
# written THIS SECOND gets rm -rf'd.
mkdir -p "$SANDBOX/tmp.freshcfg"
touch -d '3 hours ago' "$SANDBOX/tmp.freshcfg"
echo x > "$SANDBOX/tmp.freshcfg/just-written"
TMP_GUARD_ROOT="$SANDBOX" TMP_GUARD_ALERT_DRYRUN=1 TMP_GUARD_MAX_AGE_MIN=abc bash "$RUN" >/dev/null
if [ -d "$SANDBOX/tmp.freshcfg" ]; then
  ok "a non-numeric TMP_GUARD_MAX_AGE_MIN falls back to the default, fresh content survives"
else
  bad "a fresh dir was deleted because TMP_GUARD_MAX_AGE_MIN=abc was accepted"
fi
rm -rf "$SANDBOX/tmp.freshcfg"

mkdir -p "$SANDBOX/tmp.zerocfg"
touch -d '3 hours ago' "$SANDBOX/tmp.zerocfg"
echo x > "$SANDBOX/tmp.zerocfg/just-written"
TMP_GUARD_ROOT="$SANDBOX" TMP_GUARD_ALERT_DRYRUN=1 TMP_GUARD_MAX_AGE_MIN=0 TMP_GUARD_LEAK_AGE_MIN=-5 \
  bash "$RUN" >/dev/null
if [ -d "$SANDBOX/tmp.zerocfg" ]; then
  ok "TMP_GUARD_MAX_AGE_MIN=0 / TMP_GUARD_LEAK_AGE_MIN=-5 fall back to the defaults too"
else
  bad "a fresh dir was deleted with a 0/negative age window"
fi
rm -rf "$SANDBOX/tmp.zerocfg"

# A `find` failure for a reason OTHER than the age argument (permissions, odd filesystem) must
# also fail closed: stub `find` on PATH to always error, confirm nothing gets removed.
FINDSTUB="$(mktemp -d)"
cat > "$FINDSTUB/find" <<'STUB'
#!/usr/bin/env bash
echo "find: stubbed failure" >&2
exit 2
STUB
chmod +x "$FINDSTUB/find"
mkdir -p "$SANDBOX/tmp.findfail"
touch -d '3 hours ago' "$SANDBOX/tmp.findfail"
PATH="$FINDSTUB:$PATH" run
if [ -d "$SANDBOX/tmp.findfail" ]; then
  ok "a find failure fails CLOSED -- the dir is kept, not removed"
else
  bad "a find failure still let the dir be removed"
fi
rm -rf "$FINDSTUB" "$SANDBOX/tmp.findfail"

# --- 6. the ALERT line fires at/above the threshold, and dispatches to MikroB -----------------------
# A real inode-% reading is not controllable from a unit test, so ALERT_PCT is driven to 0 --
# "always alert" -- which exercises the exact same branch a real >=80% reading would take.
WAKEDIR="$(mktemp -d)"
cat > "$WAKEDIR/sched-wake-mikrob.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\0%s\n' "$1" "$2" >> "$WAKE_CAPTURE"
STUB
chmod +x "$WAKEDIR/sched-wake-mikrob.sh"
WAKE_CAPTURE="$SANDBOX/wake-capture.txt"
: > "$WAKE_CAPTURE"
cp "$RUN" "$WAKEDIR/tmp-inode-guard.sh"
out="$(TMP_GUARD_ROOT="$SANDBOX" TMP_GUARD_ALERT_PCT=0 WAKE_CAPTURE="$WAKE_CAPTURE" bash "$WAKEDIR/tmp-inode-guard.sh")"
if echo "$out" | grep -q 'ALERT:'; then
  ok "ALERT_PCT=0 forces the ALERT line"
else
  bad "no ALERT line at ALERT_PCT=0" "$out"
fi
if grep -q 'tmp-inode-guard' "$WAKE_CAPTURE" 2>/dev/null; then
  ok "the ALERT reaches MikroB via sched-wake-mikrob.sh"
else
  bad "sched-wake-mikrob.sh was not called on ALERT" "$(cat "$WAKE_CAPTURE" 2>/dev/null)"
fi
rm -rf "$WAKEDIR"

# --- 7. TMP_GUARD_ALERT_DRYRUN suppresses the MikroB dispatch (used by every case above) -------------
WAKEDIR="$(mktemp -d)"
cat > "$WAKEDIR/sched-wake-mikrob.sh" <<'STUB'
#!/usr/bin/env bash
echo "SHOULD NOT HAVE RUN" >> "$WAKE_CAPTURE"
STUB
chmod +x "$WAKEDIR/sched-wake-mikrob.sh"
WAKE_CAPTURE="$SANDBOX/wake-capture-dryrun.txt"
: > "$WAKE_CAPTURE"
cp "$RUN" "$WAKEDIR/tmp-inode-guard.sh"
TMP_GUARD_ROOT="$SANDBOX" TMP_GUARD_ALERT_PCT=0 TMP_GUARD_ALERT_DRYRUN=1 WAKE_CAPTURE="$WAKE_CAPTURE" \
  bash "$WAKEDIR/tmp-inode-guard.sh" >/dev/null
if [ ! -s "$WAKE_CAPTURE" ]; then
  ok "TMP_GUARD_ALERT_DRYRUN=1 suppresses the MikroB dispatch"
else
  bad "dry-run still dispatched to MikroB" "$(cat "$WAKE_CAPTURE")"
fi
rm -rf "$WAKEDIR"

echo
echo "tmp-inode-guard.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]

#!/usr/bin/env bash
# Self-test for scripts/install-tmp-inode-guard-cron.sh (card b1813ab2, Cybersec LOW-4, 31235).
#
# Run: bash scripts/install-tmp-inode-guard-cron.selftest.sh
# Exit: 0 = all pass, 1 = a failure.
#
# HERMETIC: `crontab` is stubbed on PATH for every case; the real host crontab is never read
# or written.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/install-tmp-inode-guard-cron.sh"
pass=0; fail=0
ok()  { printf '  [ok ] %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  [FAIL] %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

# The installer resolves GUARD as "$INSTALL_DIR/store/tmp-inode-guard.sh" where INSTALL_DIR is
# its own script's parent's parent -- so it needs a real sandbox tree to run against, not just
# a copy of itself.
mkdir -p "$SANDBOX/root/store" "$SANDBOX/root/scripts"
cp "$RUN" "$SANDBOX/root/scripts/install-tmp-inode-guard-cron.sh"
: > "$SANDBOX/root/store/tmp-inode-guard.sh"
INSTALLER="$SANDBOX/root/scripts/install-tmp-inode-guard-cron.sh"
GUARD_PATH="$SANDBOX/root/store/tmp-inode-guard.sh"

mkstub() { # mkstub <dir> <behavior-script-body>
  mkdir -p "$1"
  cat > "$1/crontab" <<EOF
#!/usr/bin/env bash
$2
EOF
  chmod +x "$1/crontab"
}

# --- 1. fresh install: no existing crontab, -l reports the real "no crontab" error -----------------
STUB="$(mktemp -d)"
mkstub "$STUB" '
if [ "${1:-}" = "-l" ]; then
  echo "crontab: no crontab for testuser" >&2
  exit 1
fi
cat > "'"$SANDBOX"'/written-1.txt"
'
: > "$SANDBOX/written-1.txt"
out="$(PATH="$STUB:$PATH" bash "$INSTALLER" 2>&1)"
rc=$?
if [ "$rc" = 0 ] && grep -qF "$GUARD_PATH" "$SANDBOX/written-1.txt"; then
  ok "fresh install (no crontab yet) writes the guard line"
else
  bad "fresh install did not write the guard line (rc=$rc)" "$out / $(cat "$SANDBOX/written-1.txt")"
fi
rm -rf "$STUB"

# --- 2. idempotent re-run: the line is already there, crontab is never rewritten --------------------
STUB="$(mktemp -d)"
mkstub "$STUB" '
if [ "${1:-}" = "-l" ]; then
  printf "%s\n" "*/5 * * * * /bin/bash '"$GUARD_PATH"' >> '"$GUARD_PATH"'.log 2>&1"
  exit 0
fi
echo "SHOULD NOT BE CALLED" >> "'"$SANDBOX"'/written-2-unexpected.txt"
'
out="$(PATH="$STUB:$PATH" bash "$INSTALLER" 2>&1)"
if echo "$out" | grep -q "already installed" && [ ! -e "$SANDBOX/written-2-unexpected.txt" ]; then
  ok "an already-installed line is not rewritten"
else
  bad "re-run did not detect the existing line" "$out"
fi
rm -rf "$STUB"

# --- 3. a COMMENTED-OUT line is not mistaken for an active install (Cybersec LOW-4) ------------------
STUB="$(mktemp -d)"
mkstub "$STUB" '
if [ "${1:-}" = "-l" ]; then
  printf "%s\n" "# */5 * * * * /bin/bash '"$GUARD_PATH"' >> '"$GUARD_PATH"'.log 2>&1"
  exit 0
fi
cat > "'"$SANDBOX"'/written-3.txt"
'
out="$(PATH="$STUB:$PATH" bash "$INSTALLER" 2>&1)"
if [ -e "$SANDBOX/written-3.txt" ] && grep -qF "$GUARD_PATH" "$SANDBOX/written-3.txt" \
   && grep -q "^# " "$SANDBOX/written-3.txt"; then
  ok "a commented-out line is treated as not-installed; the active line is added alongside it"
else
  bad "a commented-out line was mistaken for an active install" "$out / $(cat "$SANDBOX/written-3.txt" 2>/dev/null)"
fi
rm -rf "$STUB"

# --- 4. a TRANSIENT 'crontab -l' failure aborts instead of replacing the whole crontab ---------------
STUB="$(mktemp -d)"
mkstub "$STUB" '
if [ "${1:-}" = "-l" ]; then
  echo "crontab: temporary failure, try again" >&2
  exit 1
fi
echo "SHOULD NOT BE CALLED" >> "'"$SANDBOX"'/written-4-unexpected.txt"
'
out="$(PATH="$STUB:$PATH" bash "$INSTALLER" 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] && [ ! -e "$SANDBOX/written-4-unexpected.txt" ]; then
  ok "a transient 'crontab -l' failure aborts without touching the crontab"
else
  bad "a transient failure still let the crontab be overwritten (rc=$rc)" "$out"
fi
rm -rf "$STUB"

# --- 5. an unrelated existing line is preserved alongside the new one --------------------------------
STUB="$(mktemp -d)"
mkstub "$STUB" '
if [ "${1:-}" = "-l" ]; then
  printf "%s\n" "0 3 * * * /usr/bin/some-other-job.sh"
  exit 0
fi
cat > "'"$SANDBOX"'/written-5.txt"
'
out="$(PATH="$STUB:$PATH" bash "$INSTALLER" 2>&1)"
if grep -qF "some-other-job.sh" "$SANDBOX/written-5.txt" 2>/dev/null \
   && grep -qF "$GUARD_PATH" "$SANDBOX/written-5.txt" 2>/dev/null; then
  ok "an unrelated existing crontab line survives the install"
else
  bad "an unrelated existing line was lost" "$out / $(cat "$SANDBOX/written-5.txt" 2>/dev/null)"
fi
rm -rf "$STUB"

echo
echo "install-tmp-inode-guard-cron.selftest: $pass passed, $fail failed"
[[ $fail -eq 0 ]]

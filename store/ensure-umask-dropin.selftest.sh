#!/usr/bin/env bash
# Self-test for ensure-umask-dropin.sh (card fcf3a73a). Runs entirely against a throwaway unit
# directory -- it never touches the live systemd config, which is the point: a script that edits the
# fleet's service configuration should be exercisable without doing so.
#
# Card 54765aa6: that promise used to be false for ONE call. SYSTEMD_USER_DIR redirects where the
# unit files are read/written, but the script's daemon-reload call never consulted it -- every run
# below that changed a drop-in (lines now marked REAL-RELOAD-WOULD-FIRE) ran the REAL
# `systemctl --user daemon-reload` against this host's live systemd --user instance. With every
# fleet agent running this same selftest inside its own fleet-test.sh, that is several real reloads
# per agent per suite run, concentrated in the same few minutes. SYSTEMCTL_BIN closes it the same way
# SYSTEMD_USER_DIR already closes the unit-file side: a stub that logs instead of a real binary.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/ensure-umask-dropin.sh"
fail=0; n=0
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

chk() { n=$((n + 1)); if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1 -> expected '$3', got '$2'"; fail=1; fi; }

FAKE_SYSTEMCTL="$T/fake-systemctl"
FAKE_SYSTEMCTL_LOG="$T/fake-systemctl.log"
cat > "$FAKE_SYSTEMCTL" <<'EOF'
#!/bin/bash
echo "$*" >> "$FAKE_SYSTEMCTL_LOG"
exit 0
EOF
chmod +x "$FAKE_SYSTEMCTL"
export FAKE_SYSTEMCTL_LOG
export SYSTEMCTL_BIN="$FAKE_SYSTEMCTL"

U="$T/u"; mkdir -p "$U"
touch "$U/mikrob-channels.service" "$U/mikrob-dashboard.service"

out="$(SYSTEMD_USER_DIR="$U" bash "$S" 2>&1)"; rc=$?
# REAL-RELOAD-WOULD-FIRE: this run writes both drop-ins for the first time (changed=2), so the
# unpatched script ran a real daemon-reload here.
n=$((n + 1)); if [ -f "$FAKE_SYSTEMCTL_LOG" ] && grep -qx -- '--user daemon-reload' "$FAKE_SYSTEMCTL_LOG"; then
  echo "  ok   the first run's daemon-reload went through the stub, not the real systemctl"
else
  echo "  FAIL the first run's daemon-reload did not reach the stub -- check SYSTEMCTL_BIN wiring"; fail=1
fi
chk 'a first run succeeds' "$rc" 0
chk 'it writes the channels drop-in' "$(cat "$U/mikrob-channels.service.d/umask.conf")" "$(printf '[Service]\nUMask=0077')"
chk 'it writes the dashboard drop-in' "$(cat "$U/mikrob-dashboard.service.d/umask.conf")" "$(printf '[Service]\nUMask=0077')"
n=$((n + 1)); case "$out" in *"next restart"*) echo "  ok   it says the change is inert until a restart";; *) echo "  FAIL missing the restart caveat"; fail=1;; esac

# IDEMPOTENCE, and it is not a formality: the first version compared a $(cat) against a variable
# ending in a newline, so it never matched and rewrote the file every single run while reporting
# success. A boot-path script that rewrites config on every logon is not idempotent, whatever it says.
out2="$(SYSTEMD_USER_DIR="$U" bash "$S" 2>&1)"
n=$((n + 1)); case "$out2" in *"already at UMask=0077"*) echo "  ok   a second run reports 'already at', it does not rewrite";; *) echo "  FAIL second run did not detect the existing drop-in"; fail=1;; esac
n=$((n + 1)); case "$out2" in *"daemon-reload"*) echo "  FAIL it reloaded systemd with nothing to change"; fail=1;; *) echo "  ok   ...and it does not reload systemd for nothing";; esac
chk 'the no-op run did not call the stub either (still just 1 line)' "$(wc -l < "$FAKE_SYSTEMCTL_LOG")" 1

# A drop-in someone edited by hand is REASSERTED -- that is the whole reason this runs at boot.
# REAL-RELOAD-WOULD-FIRE: this changes content again, so the unpatched script reloaded here too.
printf '[Service]\nUMask=0022\n' > "$U/mikrob-channels.service.d/umask.conf"
SYSTEMD_USER_DIR="$U" bash "$S" >/dev/null 2>&1
chk 'a drifted drop-in is corrected back' "$(cat "$U/mikrob-channels.service.d/umask.conf")" "$(printf '[Service]\nUMask=0077')"
chk 'the drift-correction reload also went through the stub (2 lines now)' "$(wc -l < "$FAKE_SYSTEMCTL_LOG")" 2

# Absent units must be a benign skip, never a failure or a stray directory: this script also runs on
# a host that has only some of the fleet installed.
U2="$T/u2"; mkdir -p "$U2"
SYSTEMD_USER_DIR="$U2" bash "$S" >/dev/null 2>&1; rc2=$?
chk 'no units at all -> exit 3, nothing to configure' "$rc2" 3
chk '...and it creates no drop-in directory for a unit that does not exist' "$(ls "$U2" | wc -l)" 0

# The value is overridable without editing the script, so a host that needs 0027 is a env var away.
U3="$T/u3"; mkdir -p "$U3"; touch "$U3/mikrob-channels.service"
FLEET_UMASK=0027 SYSTEMD_USER_DIR="$U3" bash "$S" >/dev/null 2>&1
chk 'FLEET_UMASK overrides the default' "$(cat "$U3/mikrob-channels.service.d/umask.conf")" "$(printf '[Service]\nUMask=0027')"
chk 'the override run also went through the stub (3 lines now)' "$(wc -l < "$FAKE_SYSTEMCTL_LOG")" 3

# Mutation pin (card 54765aa6): the real binary name must never reappear as a literal bareword
# call -- only as the quoted "$SYSTEMCTL_BIN" variable. Revert the source fix and this goes red,
# the same way the dirty-tree checks elsewhere in this suite are source-pinned, not just behavioural.
n=$((n + 1))
if grep -qE '^\s*systemctl\s+--user\s+daemon-reload' "$S"; then
  echo "  FAIL a literal 'systemctl --user daemon-reload' bareword call reappeared in $S -- it must go through \$SYSTEMCTL_BIN"
  fail=1
else
  echo "  ok   no literal systemctl bareword call in the source -- the real binary is only reachable via \$SYSTEMCTL_BIN"
fi

echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

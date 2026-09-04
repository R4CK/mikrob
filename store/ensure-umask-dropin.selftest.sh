#!/usr/bin/env bash
# Self-test for ensure-umask-dropin.sh (card fcf3a73a). Runs entirely against a throwaway unit
# directory -- it never touches the live systemd config, which is the point: a script that edits the
# fleet's service configuration should be exercisable without doing so.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/ensure-umask-dropin.sh"
fail=0; n=0
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

chk() { n=$((n + 1)); if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1 -> expected '$3', got '$2'"; fail=1; fi; }

U="$T/u"; mkdir -p "$U"
touch "$U/mikrob-channels.service" "$U/mikrob-dashboard.service"

out="$(SYSTEMD_USER_DIR="$U" bash "$S" 2>&1)"; rc=$?
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

# A drop-in someone edited by hand is REASSERTED -- that is the whole reason this runs at boot.
printf '[Service]\nUMask=0022\n' > "$U/mikrob-channels.service.d/umask.conf"
SYSTEMD_USER_DIR="$U" bash "$S" >/dev/null 2>&1
chk 'a drifted drop-in is corrected back' "$(cat "$U/mikrob-channels.service.d/umask.conf")" "$(printf '[Service]\nUMask=0077')"

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

echo "selftest: $n case(s), $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail

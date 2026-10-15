#!/bin/bash
# Contract tests for the stuck-modal guard's macOS INSTALLATION (MODELCONFIRM1005).
# Run: bash scripts/__tests__/stuck-modal-guard-install.test.sh
#
# Bug being locked out (measured 2026-10-05 on the Mac mini): the guard only
# ever shipped as a systemd timer, so on macOS nothing ran it. After a /model the
# CLI's "Switch model?" dialog held the main session for half an hour, every
# inbound Telegram message queued behind it, and launchctl had no job of any
# modal guard. Three contracts, as for the keepalive probe:
#   1. the installer writes a valid launchd unit (every 60 s + at load) and
#      touches launchctl only with --load,
#   2. install-macos.sh runs it for new installs,
#   3. update.sh installs it on Macs that are ALREADY installed, once.
#
# Hermetic: HOME is a throwaway dir and launchctl / uname are stubs.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (missing '$3')" ;; esac; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
INSTALLER="$REPO/scripts/install-stuck-modal-guard.sh"

# ---------------------------------------------------------------------------
echo "1. install-stuck-modal-guard.sh"

mkdir -p "$TMP/home" "$TMP/bin"
cat > "$TMP/bin/launchctl" <<EOF
#!/bin/bash
echo "\$*" >> "$TMP/launchctl.calls"
exit 0
EOF
chmod +x "$TMP/bin/launchctl"
: > "$TMP/launchctl.calls"

PLIST="$TMP/home/Library/LaunchAgents/com.marveen.stuck-modal-guard.plist"
PATH="$TMP/bin:$PATH" HOME="$TMP/home" bash "$INSTALLER" >/dev/null 2>&1
assert_eq "the plist is written" "yes" "$([ -f "$PLIST" ] && echo yes || echo no)"
P="$(cat "$PLIST" 2>/dev/null)"
assert_contains "label" "$P" "<string>com.marveen.stuck-modal-guard</string>"
assert_contains "runs the guard of THIS install" "$P" "<string>$REPO/scripts/stuck-modal-guard.sh</string>"
assert_contains "every 60 s, like the systemd timer" "$P" "<key>StartInterval</key>
  <integer>60</integer>"
assert_contains "and once at load" "$P" "<key>RunAtLoad</key>
  <true/>"
assert_contains "Homebrew on PATH (tmux and the claude CLI live there)" "$P" "/opt/homebrew/bin"
assert_eq "without --load launchctl is never touched" "0" "$(wc -c < "$TMP/launchctl.calls" | tr -d ' ')"
if command -v plutil >/dev/null 2>&1; then
  assert_eq "plutil accepts the plist" "0" "$(plutil -lint "$PLIST" >/dev/null 2>&1; echo $?)"
fi
FIRST="$(cat "$PLIST")"
PATH="$TMP/bin:$PATH" HOME="$TMP/home" bash "$INSTALLER" >/dev/null 2>&1
assert_eq "a second run writes the same plist" "$FIRST" "$(cat "$PLIST")"
PATH="$TMP/bin:$PATH" HOME="$TMP/home" bash "$INSTALLER" --load >/dev/null 2>&1
assert_contains "--load loads it" "$(cat "$TMP/launchctl.calls")" "load $PLIST"

# ---------------------------------------------------------------------------
echo
echo "2. install-macos.sh"
assert_contains "new installs run the installer with --load" "$(cat "$REPO/install-macos.sh")" \
  '"$INSTALL_DIR/scripts/install-stuck-modal-guard.sh" --load'

# ---------------------------------------------------------------------------
# NOT ADOPTED (card d7e1d611/Koteg 14 -- see update.sh's own comment above
# run_unit_maintenance): install_stuck_modal_guard_launchd is a live-install launchd-maintenance
# function in the same deferred cluster as install_main_inbox_observer_unit /
# install_keepalive_probe_launchd (card c2aeefa5/ef6a8031) -- none of the four install themselves
# on an existing host without being asked. This section pins the ABSENCE, not a round-trip, so a
# future merge re-adding the call is caught the same way install-macos-no-keepalive-leak.test.ts
# catches install-macos.sh's sibling leak.
echo
echo "3. update.sh install_stuck_modal_guard_launchd (not adopted -- pinning its absence)"

assert_eq "install_stuck_modal_guard_launchd is not defined in update.sh" "" \
  "$(awk '/^install_stuck_modal_guard_launchd\(\) \{/,/^\}$/' "$REPO/update.sh")"
assert_eq "run_unit_maintenance never calls it" "" \
  "$(awk '/^run_unit_maintenance\(\) \{/,/^\}$/' "$REPO/update.sh" | grep -o install_stuck_modal_guard_launchd || true)"
echo
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."

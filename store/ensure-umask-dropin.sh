#!/usr/bin/env bash
# Make the fleet's services create files PRIVATE by default (card fcf3a73a).
#
# THE INCIDENT (Cybersec lynis finding, card 02b2a499): the channel `.env` had drifted to 0664 --
# world-readable, holding a bot token. `chmod 600` fixed that one file; the ROOT CAUSE is the live
# umask. Measured on this box: 0002, so every newly created file is 0664 and every directory 0775.
# The next log, dump, scratch file or .env is born world-readable again, and the next lynis run finds
# a different instance of the same thing.
#
# WHY A DROP-IN, and not an edit to the unit files. The units in ~/.config/systemd/user/ are NOT in
# the repo, so an edit there is exactly the unversioned local change the root CLAUDE.md update-safety
# rule forbids: lost on a fresh install, invisible to review, and gone the next time the installer
# rewrites a unit. A drop-in is the mechanism systemd provides for precisely this -- it survives unit
# regeneration, and this script (which IS versioned) can re-assert it idempotently at every boot.
#
# WHY IT REACHES THE AGENTS. Every agent is a pane in ONE shared tmux server, and that server is
# started by mikrob-channels.service -- checked on the live box: an agent's process ancestry runs
# claude -> tmux server (pid 762) -> systemd --user. A umask is inherited across fork/exec, so the
# server's umask is every agent's umask. Covering the units that can start it covers the fleet.
#
# 0077, not 0027: every process here runs as the same single user (`neon`), nothing on this box reads
# these files as another uid (checked: no container bind-mounts a fleet path, store/ is neon:neon), so
# there is no group that needs the read and no reason to leave one.
#
# IT DOES NOT RESTART ANYTHING. A umask is inherited at process start, so this takes effect on the
# next restart of each unit -- deliberately left to MikroB, who decides when the channel and the
# dashboard may bounce.
set -uo pipefail

UMASK_VALUE="${FLEET_UMASK:-0077}"
UNIT_DIR="${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
# The units that either write fleet files themselves or can start the shared tmux server.
UNITS=(mikrob-channels.service mikrob-dashboard.service)

changed=0
missing=0
for unit in "${UNITS[@]}"; do
  if [ ! -f "$UNIT_DIR/$unit" ]; then
    echo "  umask-dropin: $unit not installed here -- skipped"
    missing=$((missing + 1))
    continue
  fi
  d="$UNIT_DIR/$unit.d"
  f="$d/umask.conf"
  want="[Service]
UMask=$UMASK_VALUE
"
  # BOTH sides through $( ), which strips trailing newlines identically. Comparing a $(cat) against
  # a variable that ends in "\n" never matches, so the first version rewrote the file on every run
  # and called itself idempotent -- caught by its own second-run check, which is why that check
  # exists rather than being assumed.
  if [ -f "$f" ] && [ "$(cat "$f")" = "$(printf '%s' "$want")" ]; then
    echo "  umask-dropin: $unit already at UMask=$UMASK_VALUE"
    continue
  fi
  mkdir -p "$d"
  printf '%s' "$want" > "$f"
  echo "  umask-dropin: $unit -> UMask=$UMASK_VALUE (takes effect on its next restart)"
  changed=$((changed + 1))
done

if [ "$changed" -gt 0 ]; then
  systemctl --user daemon-reload 2>/dev/null \
    && echo "  umask-dropin: daemon-reload done" \
    || echo "  umask-dropin: daemon-reload FAILED -- run it by hand before the next restart"
fi

[ "$missing" -eq "${#UNITS[@]}" ] && exit 3   # nothing to configure here (fresh box / other host)
exit 0

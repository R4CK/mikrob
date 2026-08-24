#!/bin/bash
# Install store/cleancore-main-suite-guard.sh as a systemd --user timer (card 0dadd1e9).
#
# WHY THIS FILE EXISTS AT ALL. The guard script was version-controlled; the thing that RAN it was
# not. Measured on 2026-08-24: the guard's log stops at 2026-08-23 21:30 and nothing on this host
# invokes it any more -- the user crontab is empty, no systemd unit carries its name, and none of
# the dashboard's 45 scheduled tasks references it. So the detector for "did main go red" had been
# switched off for a day, on top of the seven days it spent measuring a frozen ref, and nothing
# announced either. An automation whose scheduler half lives only on the host disappears silently;
# this script is that half, in the repo, idempotent, and re-run by scripts/startup.sh.
#
# Same shape as scripts/install-guard-timers.sh deliberately (rendered units, enable --now,
# never hard-fail the caller) -- one pattern for "a repo script that must keep running".
#
# HOURLY, not every 15 minutes (MikroB, msg 19921). The apps/api suite is ~8.1 minutes on a quiet
# machine and this box is measurably not always quiet; it is a DETECTOR, not a blocking gate, so
# reliability is worth more than freshness. The guard's own flock makes an overlapping tick a
# silent no-op anyway.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# POINT THE UNIT AT THE CANONICAL CHECKOUT, NEVER AT AN AGENT WORKTREE. Every fleet agent edits this
# repo in its own linked worktree, so running this installer from one would render a permanent host
# unit whose ExecStart lives in a per-agent directory -- which can be reset, rebased, or removed
# under a running timer. `--git-common-dir` names the shared .git even from a linked worktree, and
# its parent is the real install. Said out loud below rather than silently corrected.
if COMMON_GIT="$(git -C "$INSTALL_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
  CANONICAL="$(cd "$(dirname "$COMMON_GIT")" && pwd)"
  if [ "$CANONICAL" != "$INSTALL_DIR" ]; then
    echo "note: run from a linked worktree ($INSTALL_DIR); the unit will point at the canonical checkout $CANONICAL"
    INSTALL_DIR="$CANONICAL"
  fi
fi

UNIT_DIR="$HOME/.config/systemd/user"
STORE="$INSTALL_DIR/store"
GUARD="$STORE/cleancore-main-suite-guard.sh"

[ -f "$GUARD" ] || { echo "install-cleancore-suite-guard-timer: no guard at $GUARD" >&2; exit 1; }

# `|| true`: under `set -e` + `pipefail` a missing .env (it is gitignored, so a fresh checkout or a
# worktree has none) would otherwise abort the installer on a line whose whole purpose is a default.
MAIN_AGENT_ID="${MAIN_AGENT_ID:-$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)}"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"

PATH_ENV="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
NAME="${MAIN_AGENT_ID}-cleancore-suite-guard"
mkdir -p "$UNIT_DIR"

# STDERR GOES TO THE SAME LOG AS STDOUT, on purpose. `die` writes its reason to stderr and only the
# bare "RESULT:SETUP-FAILED" to stdout, so under the old cron the WHY of every refusal was thrown
# away -- the half of the output that says what broke.
cat > "$UNIT_DIR/$NAME.service" <<EOF
[Unit]
Description=CleanCore main-suite guard (notice when origin/main goes red)
After=${MAIN_AGENT_ID}-dashboard.service

[Service]
Type=oneshot
ExecStart=$GUARD
Environment=PATH=$PATH_ENV
Environment=HOME=$HOME
Environment=TZ=Europe/Budapest
StandardOutput=append:$STORE/cleancore-main-suite-guard.log
StandardError=append:$STORE/cleancore-main-suite-guard.log
EOF

# Persistent=true so a tick missed while the box was off runs once after boot instead of waiting a
# full hour -- the point of the guard is that a red main is noticed, not that it is noticed at :00.
cat > "$UNIT_DIR/$NAME.timer" <<EOF
[Unit]
Description=Run the CleanCore main-suite guard hourly

[Timer]
OnCalendar=hourly
AccuracySec=1min
RandomizedDelaySec=2min
Persistent=true

[Install]
WantedBy=timers.target
EOF

echo "Rendered $NAME.{service,timer} into $UNIT_DIR"

# Enable only if a working user systemd is present. On a fresh headless/WSL install `systemctl
# --user` may not be up yet; the unit files are on disk either way and startup.sh re-runs this.
# Never hard-fail the caller.
if pidof systemd >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
  systemctl --user enable --now "$NAME.timer" || echo "  warn: could not enable $NAME.timer"
  systemctl --user list-timers "$NAME.timer" --all --no-pager || true
else
  echo "user systemd not available now -- unit rendered; startup.sh will enable it on next start."
fi

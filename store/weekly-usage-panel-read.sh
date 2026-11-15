#!/usr/bin/env bash
# weekly-usage-panel-read.sh -- MikroB auto-reader for the weekly Claude limit %.
#
# WHY: /usage renders the "Current week (all models)" bar ONLY in a Max-subscription
# session. The fleet + spare panels auth via CLAUDE_CODE_OAUTH_TOKEN (Claude API billing)
# and do NOT show the weekly bar. So a DEDICATED tmux panel (mikrob-usage-probe) is
# logged in interactively with Peti's Max account (one-time `claude /login`, 2026-07-25).
# This script drives THAT panel: sends /usage, captures, parses the weekly % + reset,
# and POSTs it to the dashboard widget (/api/costs/weekly).
#
# Peti decision 2026-07-25 (option b): dedicated /usage panel, MikroB-orchestrated
# (role-agents are governance-blocked from send-keys to other panels; MikroB is not).
#
# SECURITY (Cybersec lesson gate-ops-scripts-token-in-argv): the dashboard bearer token
# is passed to curl via a 0600 @headerfile, NEVER in argv (/proc/<pid>/cmdline is
# world-readable). The header file is unlinked on EXIT.
#
# FAIL-SAFE: if the panel is missing, /usage does not render the weekly bar, or the
# parse yields nothing, the script exits non-zero and does NOT POST -- the last good
# snapshot (or the manual fallback) is preserved, never overwritten with garbage.
#
# Ops-script rule: version-controlled + pushed; token read at runtime, never embedded.
set -euo pipefail

PANE="mikrob-usage-probe"
STORE="/home/neon/marveen/store"
DASH="http://localhost:3420"
TOKEN_FILE="${STORE}/.dashboard-token"

# ISOLATED credential store (see weekly-usage-relogin.sh): the probe owns its own
# credentials.json + refresh-token lineage so shared-credential rotation can't evict it.
PROBE_CONFIG_DIR="/home/neon/.claude-usage-probe"

# PANEL SIZE (card 8fbc5273). capture-pane only sees the VISIBLE area, and since Claude Code
# v2.1.282 /usage prints extra blocks (session cost/duration, plugin skill-listing footprint)
# above the weekly bar, so on tmux's default 80x24 the "Current week (all models)" line falls
# off-screen and every read FAILs. A tmux session does not survive a reboot, and revive_pane
# (like weekly-usage-relogin.sh's ensure_pane) used to recreate it WITHOUT a size -> 80x24
# again after every boot (measured 2026-09-25 23:00 -> 09-26 06:50: 455 minutes of FAIL).
PANE_COLS=200
PANE_ROWS=60

hdr_file=""
cleanup() { [ -n "$hdr_file" ] && rm -f "$hdr_file" 2>/dev/null || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# PENDING-RELOGIN MARKER (card f3343af0, hardened in a QA FAIL follow-up): see
# weekly-usage-relogin.sh for why this exists. If a relogin is in flight the panel is sitting on a
# /login dialog, not a shell prompt -- sending "/usage" there types into the dialog and kills the
# login (measured 2026-10-14, "Login interrupted" twice). Checked FIRST, before any tmux call, so
# a pending relogin never gets a stray keystroke from this script.
#
# QA FAIL (2026-11-15): a bare fresh-mtime check in an env-overridable path could be PLANTED by any
# process able to write a file (store/ is shared-trust) -- no owner/perm check, no tie to a live
# relogin, so a rewritten timestamp suppressed every read indefinitely. Fixed: the path is fixed in
# production (the env override below only takes effect under WU_RELOGIN_TEST_MODE=1, set by tests
# only); the marker must be a REGULAR file (not a symlink), owned by the current user, mode 0600,
# and its first line must be the PID of a process that is both alive and whose /proc cmdline names
# this exact script -- a marker that fails ANY of these is treated as not-pending, same as if the
# file did not exist, regardless of how fresh its timestamp looks. The TTL freshness check is kept
# as a second, independent requirement (belt-and-suspenders): the holder process self-expires the
# marker after the same TTL anyway, so this can never be stricter than that in practice.
if [ "${WU_RELOGIN_TEST_MODE:-0}" = "1" ]; then
  PENDING_MARKER="${WU_RELOGIN_PENDING_MARKER:-${STORE}/.weekly-usage-relogin-pending}"
  PENDING_TTL_SEC="${WU_RELOGIN_PENDING_TTL_SEC:-1800}"
else
  PENDING_MARKER="${STORE}/.weekly-usage-relogin-pending"
  PENDING_TTL_SEC=1800
fi
pending_marker_valid() {
  [ -f "$PENDING_MARKER" ] || return 1
  [ -h "$PENDING_MARKER" ] && return 1   # a symlink is never trusted, whatever it points to
  local owner_uid mode marker_pid marker_ts now_ts
  owner_uid="$(stat -c '%u' "$PENDING_MARKER" 2>/dev/null || echo -1)"
  [ "$owner_uid" = "$(id -u)" ] || return 1
  mode="$(stat -c '%a' "$PENDING_MARKER" 2>/dev/null || echo '')"
  [ "$mode" = "600" ] || return 1
  marker_pid="$(sed -n '1p' "$PENDING_MARKER" 2>/dev/null)"
  marker_ts="$(sed -n '2p' "$PENDING_MARKER" 2>/dev/null)"
  [ -n "$marker_pid" ] && [ "$marker_pid" -gt 0 ] 2>/dev/null || return 1
  [ -n "$marker_ts" ] && [ "$marker_ts" -gt 0 ] 2>/dev/null || return 1
  now_ts="$(date +%s)"
  [ $((now_ts - marker_ts)) -lt "$PENDING_TTL_SEC" ] || return 1
  kill -0 "$marker_pid" 2>/dev/null || return 1
  tr '\0' '\n' < "/proc/$marker_pid/cmdline" 2>/dev/null | grep -q 'weekly-usage-relogin\.sh' || return 1
  return 0
}
# SKIP-STREAK ESCALATION (Cybersec MEDIUM-1, card f3343af0): the marker's OWN freshness check
# above can be kept green forever by a same-user process that replants a fresh epoch every
# <30 min with no real relogin in flight (measured: `--hold-marker` rerun directly, or a decoy
# process exec'd under the script's own name) -- the TTL alone cannot tell that apart from a
# genuinely slow, still-pending relogin, because the decoy controls the very timestamp the TTL
# check reads. So track OUR OWN first-observed time, in a file the marker's owner cannot touch
# (we write it, they never do), and once a marker has been honored continuously for >= 2x the
# TTL, stop honoring it and fall through to the normal flow -- which raises the normal failure/
# alert path instead of silently skipping forever. A single legitimate relogin never reaches
# this (the holder self-expires its own marker at 1x TTL); only a marker kept artificially fresh
# past that point does.
# Cybersec MEDIUM-3 (card f3343af0 delta-gate): under test mode this path must be EXPLICITLY
# supplied by the caller -- never silently fall back to the live production file the way
# PENDING_MARKER above does. A test that sets WU_RELOGIN_TEST_MODE=1 without also setting
# WU_RELOGIN_SKIP_STREAK_FILE would otherwise read/write the REAL store/.weekly-usage-relogin-
# skip-streak, and a stale streak left there makes the first tick of a genuine relogin escalate
# immediately and type into the login dialog it is meant to protect.
if [ "${WU_RELOGIN_TEST_MODE:-0}" = "1" ]; then
  SKIP_STREAK_FILE="${WU_RELOGIN_SKIP_STREAK_FILE:?WU_RELOGIN_SKIP_STREAK_FILE must be set under WU_RELOGIN_TEST_MODE=1 -- refusing to touch the live streak file}"
else
  SKIP_STREAK_FILE="${STORE}/.weekly-usage-relogin-skip-streak"
fi
if pending_marker_valid; then
  now_ts="$(date +%s)"
  streak_start="$(cat "$SKIP_STREAK_FILE" 2>/dev/null || true)"
  if ! [ "$streak_start" -gt 0 ] 2>/dev/null; then
    streak_start="$now_ts"
    ( umask 177; printf '%s\n' "$streak_start" > "$SKIP_STREAK_FILE" ) 2>/dev/null || true
  fi
  if [ $((now_ts - streak_start)) -ge $((2 * PENDING_TTL_SEC)) ]; then
    echo "ESCALATE: relogin marker has been honored for >= 2x the TTL (${PENDING_TTL_SEC}s) without clearing -- treating as stuck or artificially kept fresh, no longer skipping." >&2
    rm -f "$SKIP_STREAK_FILE" 2>/dev/null || true
  else
    echo "SKIP: relogin pending"
    exit 0
  fi
else
  rm -f "$SKIP_STREAK_FILE" 2>/dev/null || true
fi

# REBOOT-SURVIVABILITY (2026-07-31): a tmux session does NOT survive a machine reboot.
# The isolated .credentials.json (with a ~month-long refresh token) DOES. So on reboot the
# creds are still valid but the PANEL is gone -- and the old behaviour ("fail -> escalate to
# Peti /login") made Peti do a full browser OAuth for NOTHING, because merely RE-STARTING the
# panel makes claude silently refresh the access token via the still-valid refresh token.
# Fix: auto-revive the panel from the isolated config dir before failing. Peti is only asked
# to /login when the refresh token itself is dead (~monthly), which the relogin flow handles.
revive_pane() {
  echo "revive: panel '$PANE' dead, recreating from isolated config (refresh-token auto-renew, no Peti login)..." >&2
  # 700, matching ~/.claude: the dir holds .credentials.json (card 90424157 F2).
  mkdir -p -m 700 "$PROBE_CONFIG_DIR" 2>/dev/null || true
  chmod 700 "$PROBE_CONFIG_DIR" 2>/dev/null || true
  # tmux itself refusing to create the pane is not an auth signal either way -- UNKNOWN (card
  # 90424157 F1), not EXPIRED (rc 1 is reserved for a POSITIVELY confirmed dead refresh token).
  tmux new-session -d -s "$PANE" -x "$PANE_COLS" -y "$PANE_ROWS" -c /home/neon 2>/dev/null || return 2
  sleep 1
  # env option flags (-u) MUST precede VAR=VALUE assignments (else env treats the assignment
  # as end-of-options). Isolated config dir pins the probe to its own credential lineage.
  # TELEGRAM_STATE_DIR is inherited from the tmux global env (set by mikrob-channels); left in
  # place, the probe's telegram plugin polls with MikroB's bot token and knocks MikroB's own
  # plugin offline (409 conflict). Measured 2026-09-27 07:4x after a post-reboot revive.
  tmux send-keys -t "$PANE" \
    "env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u TELEGRAM_STATE_DIR CLAUDE_CONFIG_DIR=$PROBE_CONFIG_DIR claude" Enter 2>/dev/null
  sleep 12
  # Trust-folder prompt, if shown (first launch in this cwd for the isolated config).
  #
  # BUG FIXED 2026-09-17 (live-diagnosed by MikroB after Peti reported repeated relogin
  # requests within the same hour): this is an arrow-selected menu with "No, exit"
  # PRE-HIGHLIGHTED, not a numbered list -- sending '1' does nothing, and the unconditional
  # bare Enter that followed then confirmed "No, exit", which quits claude back to a plain
  # bash prompt. The poll loop below never sees the ready-banner (it's sitting at bash, not
  # claude), times out at 90s, and reports a false "refresh token likely expired" --
  # escalating to Peti for a manual browser login that was never actually needed. Confirmed
  # live: capture-pane showed the trust menu in scrollback with a bash prompt (and a failed
  # literal "/login" typed into bash) below it. weekly-usage-relogin.sh's ensure_pane already
  # has the correct sequence (Down selects "Yes, I trust this folder", not a digit) -- mirrored
  # here instead of reinventing it.
  local cap; cap="$(tmux capture-pane -t "$PANE" -p 2>/dev/null || true)"
  if printf '%s' "$cap" | grep -qiE 'trust this folder'; then
    tmux send-keys -t "$PANE" Down 2>/dev/null; sleep 1
    tmux send-keys -t "$PANE" Enter 2>/dev/null; sleep 8
  fi
  # Logged in via refresh token when the welcome/prompt is up and no /login screen shows.
  #
  # POLL instead of a single check (card e1d71490). Measured 2026-08-16/17: both relogin
  # failures landed on the FIRST heartbeat tick after a genuine Windows/WSL FULL shutdown
  # (journalctl boot list: 7+ hours off overnight), never after a plain in-session restart
  # -- and only 17 days into a refresh token the 2026-07-31 fix assumed would live to
  # ~Aug 27, too early for a real TTL expiry to explain it. System clock was correctly
  # RTC-set at boot (ruled out via dmesg/timedatectl), so the remaining, testable
  # explanation is a COLD full-VM boot leaving network/DNS not yet ready inside the
  # original fixed ~25s budget, since the fix was only ever tested against a tmux-kill in
  # an already-running, network-warm WSL. This keeps trying for up to 90s before
  # concluding the token itself is dead; a genuinely dead token still falls back to the
  # Peti browser-OAuth flow, just up to ~65s later.
  # DETECTION-STRING DRIFT (2026-08-19): the original pattern (Welcome back / manual mode on /
  # for shortcuts) was written against an older Claude Code CLI banner. v2.1.235 no longer prints
  # any of those -- the ready prompt shows "Claude Max" (subscription tier) and "auto mode on"
  # instead. The old pattern never matched, so every revive silently SUCCEEDED (verified live: the
  # pane was authed and prompt-ready within seconds) but this loop still ran the full 90s and
  # reported a false "refresh token likely expired", escalating to Peti for a needless manual
  # login every single boot. Fix: match on the subscription-tier banner line (Claude Max/Pro/Team/
  # Enterprise), which only renders after a real subscription auth, plus a loose "mode on" for the
  # auto/manual toggle text -- alongside the original strings so an older CLI still matches too.
  local waited=25
  cap="$(tmux capture-pane -t "$PANE" -p 2>/dev/null || true)"
  while ! printf '%s' "$cap" | grep -qiE 'Welcome back|manual mode on|for shortcuts|Claude (Max|Pro|Team|Enterprise)|mode on'; do
    if [ "$waited" -ge 90 ]; then
      # THREE STATES, NOT TWO (card 90424157 F1). A plain timeout here used to be reported as
      # "refresh token likely expired" -- a CONCLUSION the timeout alone does not support. Four
      # documented false-expired cases (cold-boot network delay 08-16/17, CLI banner drift 08-19,
      # wrong key on the trust prompt 09-17, and the 09-16 case) all took THIS exact path with no
      # real auth failure, each one paging Peti for a needless browser OAuth (consent-phishing
      # habituation risk). A timeout alone is "I could not confirm either way", not "expired".
      #
      # POSITIVE expiry check instead of inferring it from absence: the Claude Code CLI only
      # documents the dead-refresh-token signal as REQUEST-TIME text (`/status`'s "Login" row
      # reading "Expired - log in again", per code.claude.com/docs/en/authentication.md) -- it is
      # not a startup banner, which is exactly why the ready-banner wait above can never see it.
      # So actively ask: send /status and look for that row before concluding anything.
      tmux send-keys -t "$PANE" '/status' Enter 2>/dev/null
      sleep 5
      local status_cap; status_cap="$(tmux capture-pane -t "$PANE" -p 2>/dev/null || true)"
      if printf '%s' "$status_cap" | grep -qiE 'Expired.{0,3}log in again'; then
        echo "revive: panel up, /status confirms login expired after ${waited}s -> Peti /login needed." >&2
        return 1
      fi
      echo "revive: panel up but not confirmed authed after ${waited}s, and /status did not confirm expiry either -- UNKNOWN, not expired. Check the panel manually." >&2
      return 2
    fi
    sleep 10; waited=$((waited + 10))
    cap="$(tmux capture-pane -t "$PANE" -p 2>/dev/null || true)"
  done
  echo "revive: panel back up, Max-authed via refresh token (no Peti login needed, ${waited}s)." >&2
  return 0
}

# 1) Panel must exist (dedicated Max-authed /usage panel). Auto-revive after reboot before failing.
if ! tmux has-session -t "$PANE" 2>/dev/null; then
  revive_rc=0
  revive_pane || revive_rc=$?
  if [ "$revive_rc" -eq 1 ]; then
    # EXPIRED (confirmed via /status, card 90424157 F1): real relogin is needed.
    fail "EXPIRED: panel '$PANE' /status confirms login expired -- claude /login Max needed. Manual fallback stays."
  elif [ "$revive_rc" -ne 0 ]; then
    # UNKNOWN (rc 2, or anything else revive_pane might return): could not confirm either way --
    # NOT a confirmed expiry, so callers must not auto-relogin/page Peti on this alone.
    fail "UNKNOWN: panel '$PANE' revive did not confirm auth either way -- check the panel manually before assuming expiry."
  fi
fi

# 2) Drive /usage in the dedicated panel, then capture.
#    Re-assert the size on EVERY read, not only at creation: the panel may have been created by
#    another path (weekly-usage-relogin.sh, a manual `tmux new-session`) at the 80x24 default.
tmux resize-window -t "$PANE" -x "$PANE_COLS" -y "$PANE_ROWS" 2>/dev/null || true
tmux send-keys -t "$PANE" '/usage' Enter 2>/dev/null || fail "send-keys /usage failed"
sleep 6
snap="$(tmux capture-pane -t "$PANE" -p 2>/dev/null || true)"
# Leave the panel clean for the next read.
tmux send-keys -t "$PANE" Escape 2>/dev/null || true

[ -n "$snap" ] || fail "empty capture"

# 3) Parse ALL /usage sections (card a91c6039): Current session, Current week (all models),
#    Current week (Fable), plus the +50% weekly promo. The parse is a PURE, unit-tested helper
#    (store/weekly-usage-parse.sh) so it can be verified against sample captures without tmux.
#    The weekly (all models) bar is REQUIRED (canonical, drives the stop rule); wu_body returns
#    non-zero (fail-closed) if it is absent, so we never POST a garbage/partial snapshot.
# shellcheck source=weekly-usage-parse.sh
. "${STORE}/weekly-usage-parse.sh"

note="auto-read a dedikalt /usage panelbol (mikrob-usage-probe, Max-auth)"
body="$(wu_body "$snap" "$note")" || fail "weekly % not found in /usage (panel not Max-authed, or format changed)"
pct="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pct"])')"
reset="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("resetAt") or "")')"

# 3b) Feed the LIVE % into pre-dispatch-check.sh (card [threshold-live-wiring]). Before this,
# this script's live read only reached the dashboard gauge (/api/costs/weekly) -- a completely
# separate store from pre-dispatch-check.sh's own weekly-usage.json, which nothing ever kept
# fresh (its 'set-weekly' subcommand was manual-screenshot-only). Without this, the newDevStop/
# testStop thresholds the dashboard sliders save are never actually compared against a live
# number: the orchestrator's dispatch-gate checks a flag file that no one refreshes. This call
# both updates weekly-usage.json AND (by running the full check) recomputes+writes
# weekly-hard-stop.json, so the flag file the orchestrator reads is never more than one probe
# cycle (30 min) stale. Best-effort: a failure here must not fail the dashboard-widget POST.
bash "${STORE}/pre-dispatch-check.sh" set-weekly "$pct" "$reset" >/dev/null 2>&1 || true
bash "${STORE}/pre-dispatch-check.sh" >/dev/null 2>&1 || true

# 3c) Feed the fresh weekly % into the auto-aggressiveness ramp (card 346d3933). The ramp raises the
# local-LLM offload aggressiveness as the weekly % approaches newDevStop, UNLESS Peti has set the
# slider manually (source:'manual' wins). Logic + persistence live in src/costops/weekly-threshold.ts;
# this compiled CLI is the thin applier. Best-effort: a failure here must not fail the widget POST.
node "${STORE}/../dist/costops/apply-offload-ramp.js" >/dev/null 2>&1 || true

# 4) POST to the widget. Token via 0600 @headerfile (NEVER argv).
hdr_file="$(mktemp)"; chmod 600 "$hdr_file"
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$hdr_file"

http_code="$(curl -s -o /tmp/.wupr-out.$$ -w '%{http_code}' --max-time 15 \
  -X POST "${DASH}/api/costs/weekly" \
  -H @"$hdr_file" -H 'Content-Type: application/json' \
  --data "$body" || true)"

if [ "$http_code" = "200" ]; then
  echo "OK: weekly ${pct}% (reset: ${reset:-n/a}) written to widget."
  rm -f /tmp/.wupr-out.$$ 2>/dev/null || true
  exit 0
else
  echo "FAIL: POST /api/costs/weekly -> HTTP ${http_code}" >&2
  cat /tmp/.wupr-out.$$ 2>/dev/null >&2 || true
  rm -f /tmp/.wupr-out.$$ 2>/dev/null || true
  exit 1
fi

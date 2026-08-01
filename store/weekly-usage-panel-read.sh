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

hdr_file=""
cleanup() { [ -n "$hdr_file" ] && rm -f "$hdr_file" 2>/dev/null || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# REBOOT-SURVIVABILITY (2026-07-31): a tmux session does NOT survive a machine reboot.
# The isolated .credentials.json (with a ~month-long refresh token) DOES. So on reboot the
# creds are still valid but the PANEL is gone -- and the old behaviour ("fail -> escalate to
# Peti /login") made Peti do a full browser OAuth for NOTHING, because merely RE-STARTING the
# panel makes claude silently refresh the access token via the still-valid refresh token.
# Fix: auto-revive the panel from the isolated config dir before failing. Peti is only asked
# to /login when the refresh token itself is dead (~monthly), which the relogin flow handles.
revive_pane() {
  echo "revive: panel '$PANE' dead, recreating from isolated config (refresh-token auto-renew, no Peti login)..." >&2
  tmux new-session -d -s "$PANE" -c /home/neon 2>/dev/null || return 1
  sleep 1
  # env option flags (-u) MUST precede VAR=VALUE assignments (else env treats the assignment
  # as end-of-options). Isolated config dir pins the probe to its own credential lineage.
  tmux send-keys -t "$PANE" \
    "env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR=$PROBE_CONFIG_DIR claude" Enter 2>/dev/null
  sleep 12
  # Trust-folder prompt, if shown (first launch in this cwd for the isolated config).
  local cap; cap="$(tmux capture-pane -t "$PANE" -p 2>/dev/null || true)"
  if printf '%s' "$cap" | grep -qiE 'trust this folder'; then
    tmux send-keys -t "$PANE" '1' 2>/dev/null; sleep 1
    tmux send-keys -t "$PANE" Enter 2>/dev/null; sleep 8
  fi
  tmux send-keys -t "$PANE" Enter 2>/dev/null; sleep 4
  # Logged in via refresh token when the welcome/prompt is up and no /login screen shows.
  cap="$(tmux capture-pane -t "$PANE" -p 2>/dev/null || true)"
  if printf '%s' "$cap" | grep -qiE 'Welcome back|manual mode on|for shortcuts'; then
    echo "revive: panel back up, Max-authed via refresh token (no Peti login needed)." >&2
    return 0
  fi
  echo "revive: panel up but not authed (refresh token likely expired) -> Peti /login needed." >&2
  return 1
}

# 1) Panel must exist (dedicated Max-authed /usage panel). Auto-revive after reboot before failing.
if ! tmux has-session -t "$PANE" 2>/dev/null; then
  revive_pane || fail "panel '$PANE' not running and refresh-token revive failed (needs claude /login Max). Manual fallback stays."
fi

# 2) Drive /usage in the dedicated panel, then capture.
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

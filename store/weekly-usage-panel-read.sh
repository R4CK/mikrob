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

hdr_file=""
cleanup() { [ -n "$hdr_file" ] && rm -f "$hdr_file" 2>/dev/null || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1) Panel must exist (dedicated Max-authed /usage panel).
tmux has-session -t "$PANE" 2>/dev/null || fail "panel '$PANE' not running (needs one-time claude /login Max). Manual fallback stays."

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

#!/usr/bin/env bash
# weekly-usage-relogin.sh -- MikroB helper for the auto-relogin flow (card a91c6039).
#
# WHY: the dedicated /usage panel (mikrob-usage-probe) is logged into Peti's Max account
# interactively. If that session logs out (token expiry, restart), weekly-usage-panel-read.sh
# FAILs and the widget stops auto-updating. Re-login needs a browser OAuth step only Peti can
# do. This helper drives `claude /login` in the panel and CAPTURES the OAuth URL so MikroB can
# relay it to Peti; Peti authorizes in the browser and sends the code back; MikroB pastes it
# (paste step: this script with `--paste <code>`).
#
# USAGE:
#   weekly-usage-relogin.sh              # start /login, print the OAuth URL (for MikroB->Peti)
#   weekly-usage-relogin.sh --paste CODE # paste the code Peti returned into the panel
#
# Idempotent-ish: if the panel is already Max-authed, `--check` reports OK and does nothing.
set -uo pipefail

PANE="mikrob-usage-probe"
MODE="${1:-start}"

ensure_pane() {
  tmux has-session -t "$PANE" 2>/dev/null && return 0
  # Recreate the panel with a clean interactive claude (subscription login, no API token env).
  tmux new-session -d -s "$PANE" -c /home/neon 2>/dev/null || return 1
  sleep 1
  tmux send-keys -t "$PANE" 'env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY claude' Enter 2>/dev/null
  sleep 10
  # Trust-folder prompt, if shown.
  tmux send-keys -t "$PANE" '1' 2>/dev/null; sleep 1; tmux send-keys -t "$PANE" Enter 2>/dev/null
  sleep 6
}

case "$MODE" in
  --check)
    # Max-authed if /usage shows the weekly bar. Reuse the reader's success as the signal.
    if bash /home/neon/marveen/store/weekly-usage-panel-read.sh >/dev/null 2>&1; then
      echo "OK: panel Max-authed (weekly bar readable)."; exit 0
    else
      echo "RELOGIN-NEEDED: panel not Max-authed."; exit 8
    fi
    ;;
  --paste)
    CODE="${2:-}"
    [ -n "$CODE" ] || { echo "FAIL: --paste needs the code" >&2; exit 2; }
    tmux has-session -t "$PANE" 2>/dev/null || { echo "FAIL: panel gone" >&2; exit 1; }
    tmux send-keys -t "$PANE" "$CODE" 2>/dev/null; sleep 1
    tmux send-keys -t "$PANE" Enter 2>/dev/null; sleep 8
    if tmux capture-pane -t "$PANE" -p 2>/dev/null | grep -qiE 'Login successful|Welcome back'; then
      tmux send-keys -t "$PANE" Enter 2>/dev/null; sleep 2
      echo "OK: login successful, panel Max-authed."
      exit 0
    fi
    echo "FAIL: login did not confirm; capture:" >&2
    tmux capture-pane -t "$PANE" -p 2>/dev/null | grep -v '^$' | tail -6 >&2
    exit 1
    ;;
  start)
    ensure_pane || { echo "FAIL: cannot ensure panel" >&2; exit 1; }
    # Kick /login and select the subscription (Max) option (menu default = option 1).
    tmux send-keys -t "$PANE" '/login' Enter 2>/dev/null; sleep 6
    # If the 3-way method menu is up, Enter selects the highlighted first item (subscription).
    tmux send-keys -t "$PANE" Enter 2>/dev/null; sleep 8
    URL="$(tmux capture-pane -t "$PANE" -p 2>/dev/null | grep -oE 'https://claude\.(com|ai)/[^ ]*oauth[^ ]*' | head -n1)"
    if [ -n "$URL" ]; then
      echo "OAUTH_URL: $URL"
      exit 0
    fi
    echo "FAIL: no OAuth URL captured; panel state:" >&2
    tmux capture-pane -t "$PANE" -p 2>/dev/null | grep -v '^$' | tail -8 >&2
    exit 1
    ;;
  *)
    echo "usage: $0 [start|--check|--paste CODE]" >&2; exit 2 ;;
esac

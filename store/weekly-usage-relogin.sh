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

# ISOLATED credential store (frequent-logout root cause, 2026-07-30): the probe is an
# interactive Max login. If it shared the global ~/.claude/.credentials.json, every fleet
# agent restart / model-fallback / Peti login elsewhere rewrites that one file and Max
# rotates the token -> the probe gets evicted -> repeated /login. A dedicated CLAUDE_CONFIG_DIR
# gives the probe its OWN credentials.json + refresh-token lineage, so one login sticks.
PROBE_CONFIG_DIR="/home/neon/.claude-usage-probe"

ensure_pane() {
  tmux has-session -t "$PANE" 2>/dev/null && return 0
  mkdir -p "$PROBE_CONFIG_DIR" 2>/dev/null || true
  # Recreate the panel with a clean interactive claude (subscription login, no API token env),
  # pinned to the ISOLATED config dir so shared-credential contention can't log it out.
  tmux new-session -d -s "$PANE" -c /home/neon 2>/dev/null || return 1
  sleep 1
  # NOTE: env option flags (-u) MUST precede VAR=VALUE assignments, else env treats the
  # assignment as the end of options and the following -u becomes the command (env error).
  tmux send-keys -t "$PANE" "env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR=$PROBE_CONFIG_DIR claude" Enter 2>/dev/null
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
    # Widen the window BEFORE /login prints the URL. tmux does NOT reflow existing scrollback,
    # so resizing after the URL is printed leaves it wrapped/truncated (the &state= param spills
    # to the next line and a naive head -n1 drops it -> "Missing state parameter" on the login
    # page). Wide window = the whole URL lands on one logical line.
    tmux resize-window -t "$PANE" -x 500 2>/dev/null || true; sleep 1
    # Kick /login and select the subscription (Max) option (menu default = option 1).
    tmux send-keys -t "$PANE" '/login' Enter 2>/dev/null; sleep 6
    # If the 3-way method menu is up, Enter selects the highlighted first item (subscription).
    tmux send-keys -t "$PANE" Enter 2>/dev/null; sleep 8
    # Capture with -J (join wrapped lines) and, as a belt-and-suspenders, stitch any &state=
    # continuation line back onto the oauth line.
    URL="$(tmux capture-pane -t "$PANE" -p -J 2>/dev/null | python3 -c '
import sys, re
lines=[l.rstrip("\n") for l in sys.stdin]
url=""
for i,l in enumerate(lines):
    m=re.search(r"https://claude\.(?:com|ai)/\S*oauth\S*", l)
    if m:
        url=m.group(0)
        # stitch trailing continuation fragments (e.g. a wrapped &state=...) with no spaces
        for nxt in lines[i+1:i+3]:
            s=nxt.strip()
            if s and " " not in s and re.match(r"^[&%A-Za-z0-9_=.+-]+$", s):
                url+=s
            else:
                break
        break
print(url)
' 2>/dev/null)"
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

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
#   weekly-usage-relogin.sh                    # start /login, print the OAuth URL (MikroB->Peti)
#   printf %s "$CODE" | weekly-usage-relogin.sh --paste        # code on STDIN  (preferred)
#   weekly-usage-relogin.sh --paste-file /path/to/code         # code from a 0600 file
#
# THE CODE NEVER GOES ON THE COMMAND LINE (card e5411be1, Cybersec finding on a91c6039). argv is
# world-readable via /proc/<pid>/cmdline for the life of the process, and a shell also records it in
# history -- so `--paste <code>` briefly published a live one-time OAuth code to every local user.
# It is LOW severity (single-use code, short TTL, rare manual step), but the fix is cheap and the
# class is the same as the token-in-argv finding c9ce4254, so it is closed for consistency.
#
# Idempotent-ish: if the panel is already Max-authed, `--check` reports OK and does nothing.
set -uo pipefail

# Overridable so a test can NEVER address the live probe pane. Learned the hard way: a test that
# exercised the code-intake path found the real `mikrob-usage-probe` session alive and pasted its
# fixture text into Peti's logged-in Claude session. Harmless here, but a test must not be able to
# reach production state by default.
PANE="${USAGE_PROBE_PANE:-mikrob-usage-probe}"
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

# --- OAuth-code redaction for pane dumps (card b5746e1e) --------------------------------------
# The --paste failure branch prints the panel's last lines so a failed login is diagnosable. But the
# code was JUST typed into that panel, so those lines contain it -- and that output goes to stderr,
# i.e. into MikroB's transcript and logs. That is a MORE durable exposure than the original argv leak
# (e5411be1): argv lives for the length of one process, a transcript lives until someone prunes it.
#
# The dump still has diagnostic value (it shows WHY the login failed); the code inside it has none --
# we already know what we sent. So the dump is kept and the code is removed from it.
#
# Two layers, because exact matching alone is not enough:
#   1. exact replacement of the code we sent -- provable, and the primary mechanism;
#   2. a generic mask for any remaining long token, for the case where the terminal broke the code
#      across a boundary or inserted a character, so an exact match would silently miss it.
# Capture uses -J (join wrapped lines, same as the start branch) so a wrapped code is ONE token and
# layer 1 actually matches.
redact_code() { # stdin -> stdout, with $CODE and long tokens masked
  CODE="${CODE:-}" python3 -c '
import os, re, sys
code = os.environ.get("CODE", "")
text = sys.stdin.read()
if code:
    text = text.replace(code, "***REDACTED***")
# Anything still looking like a credential (24+ chars of the OAuth alphabet) is masked too. Ordinary
# failure text does not contain unbroken 24-char tokens; a secret is worth more than that diagnostic.
text = re.sub(r"[A-Za-z0-9_-]{24,}", "***REDACTED***", text)
sys.stdout.write(text)
'
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
  --paste|--paste-file)
    # Read the code WITHOUT ever placing it in argv.
    #   --paste            -> stdin (the caller pipes it; nothing lands on a command line at all)
    #   --paste-file PATH  -> a file that MUST be 0600 and owned by us; anything looser is refused
    #                         rather than read, because a world-readable code file is the same leak
    #                         in a different place.
    if [ "$MODE" = "--paste-file" ]; then
      CODE_FILE="${2:-}"
      [ -n "$CODE_FILE" ] || { echo "FAIL: --paste-file needs a path" >&2; exit 2; }
      [ -f "$CODE_FILE" ] || { echo "FAIL: no such file: $CODE_FILE" >&2; exit 2; }
      PERM=$(stat -c '%a' "$CODE_FILE" 2>/dev/null || stat -f '%Lp' "$CODE_FILE" 2>/dev/null || echo '?')
      if [ "$PERM" != "600" ]; then
        echo "FAIL: $CODE_FILE must be mode 0600 (is $PERM) -- refusing to read a loosely-permissioned code file" >&2
        exit 2
      fi
      CODE=$(cat "$CODE_FILE")
    else
      # Refuse an argv code outright instead of silently accepting it: a caller still using the old
      # `--paste <code>` form must be told, not quietly kept on the leaking path.
      if [ -n "${2:-}" ]; then
        echo "FAIL: the code must NOT be passed as an argument (it leaks via /proc/<pid>/cmdline)." >&2
        echo "      Use:  printf %s \"\$CODE\" | $0 --paste     (or --paste-file <0600-file>)" >&2
        exit 2
      fi
      [ ! -t 0 ] || { echo "FAIL: --paste reads the code from STDIN; pipe it in." >&2; exit 2; }
      CODE=$(cat)
    fi
    # Strip a trailing newline/CR that a pipe or editor adds; the panel expects the bare code.
    CODE=$(printf %s "$CODE" | tr -d '\r\n')
    [ -n "$CODE" ] || { echo "FAIL: empty code" >&2; exit 2; }
    tmux has-session -t "$PANE" 2>/dev/null || { echo "FAIL: panel gone" >&2; exit 1; }
    tmux send-keys -t "$PANE" "$CODE" 2>/dev/null; sleep 1
    tmux send-keys -t "$PANE" Enter 2>/dev/null; sleep 8
    if tmux capture-pane -t "$PANE" -p 2>/dev/null | grep -qiE 'Login successful|Welcome back'; then
      tmux send-keys -t "$PANE" Enter 2>/dev/null; sleep 2
      echo "OK: login successful, panel Max-authed."
      exit 0
    fi
    echo "FAIL: login did not confirm; capture (OAuth code redacted):" >&2
    # -J so a wrapped code is one token and the exact redaction below can match it.
    tmux capture-pane -t "$PANE" -p -J 2>/dev/null | grep -v '^$' | tail -6 | redact_code >&2
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
  --redact-stdin)
    # Test/diagnostic seam: pipe text in, get the SAME redaction the --paste failure dump applies.
    # Exposed so the redaction is directly testable -- the failure branch itself needs a live panel,
    # and an untested redaction is exactly the kind of thing that silently stops redacting.
    redact_code
    ;;
  *)
    echo "usage: $0 [start|--check|--paste (code on stdin)|--paste-file <0600-file>]" >&2; exit 2 ;;
esac

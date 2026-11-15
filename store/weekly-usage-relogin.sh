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

# PENDING-RELOGIN MARKER (card f3343af0, hardened in a QA FAIL follow-up): weekly-usage-panel-read.sh
# types "/usage" into this same panel on a timer. While a relogin is in flight the panel sits on a
# waiting /login dialog instead of a shell prompt, so that keystroke lands on the dialog -- measured
# 2026-10-14, two login flows in a row died with "Login interrupted" because the reader's /usage text
# was typed into the dialog.
#
# QA FAIL (2026-11-15): the first version gated SKIP on nothing but a fresh mtime in an
# env-overridable path -- any process able to write ANY file (store/ is shared-trust, every agent can)
# could plant a marker and suppress every weekly-usage read indefinitely by rewriting the timestamp
# every <30 min, with no tie to a real relogin. Fixed: the marker path is fixed in production (the env
# override below only takes effect under WU_RELOGIN_TEST_MODE=1, set by tests only); the marker is
# written mode 0600 via umask (no separate chmod window) and carries the PID of the process actually
# holding the relogin open, not just a timestamp; weekly-usage-panel-read.sh additionally verifies
# ownership, mode, and that the PID is alive AND its cmdline names this script before honoring it.
if [ "${WU_RELOGIN_TEST_MODE:-0}" = "1" ]; then
  PENDING_MARKER="${WU_RELOGIN_PENDING_MARKER:-/home/neon/marveen/store/.weekly-usage-relogin-pending}"
  PENDING_TTL_SEC="${WU_RELOGIN_PENDING_TTL_SEC:-1800}"
else
  PENDING_MARKER="/home/neon/marveen/store/.weekly-usage-relogin-pending"
  PENDING_TTL_SEC=1800
fi

# Writes the marker atomically at 0600 (umask, not a post-hoc chmod -- no window where the file is
# briefly world-readable) with OUR OWN pid (line 1) and the start epoch (line 2). Called only from
# inside --hold-marker, whose process is the one meant to stay alive for the pending window.
write_pending_marker() {
  ( umask 177; printf '%s\n%s\n' "$$" "$(date +%s)" > "$PENDING_MARKER" ) 2>/dev/null || true
}

ensure_pane() {
  tmux has-session -t "$PANE" 2>/dev/null && return 0
  # 700, matching ~/.claude: the dir holds .credentials.json (card 90424157 F2).
  mkdir -p -m 700 "$PROBE_CONFIG_DIR" 2>/dev/null || true
  chmod 700 "$PROBE_CONFIG_DIR" 2>/dev/null || true
  # Recreate the panel with a clean interactive claude (subscription login, no API token env),
  # pinned to the ISOLATED config dir so shared-credential contention can't log it out.
  tmux new-session -d -s "$PANE" -x 200 -y 60 -c /home/neon 2>/dev/null || return 1
  sleep 1
  # NOTE: env option flags (-u) MUST precede VAR=VALUE assignments, else env treats the
  # assignment as the end of options and the following -u becomes the command (env error).
  tmux send-keys -t "$PANE" "env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u TELEGRAM_STATE_DIR CLAUDE_CONFIG_DIR=$PROBE_CONFIG_DIR claude" Enter 2>/dev/null
  sleep 10
  # Trust-folder prompt, if shown: it's an arrow-selected menu with "No, exit" pre-highlighted,
  # not a numbered list -- sending '1' does nothing and a bare Enter confirms "No, exit", which
  # drops the pane back to a bash prompt (measured 2026-09-05). Down selects "Yes, I trust this
  # folder" before confirming.
  tmux send-keys -t "$PANE" Down 2>/dev/null; sleep 1; tmux send-keys -t "$PANE" Enter 2>/dev/null
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
    # Layer 1: the exact code we sent -- provable, and the primary mechanism.
    text = text.replace(code, "***REDACTED***")
    # Layer 1b (card 4f352199): the SAME code with arbitrary whitespace between its characters. A
    # terminal that wrapped the code inserts a newline (and often padding) INSIDE it, which breaks
    # both the exact match above and the 24-char run below -- each half can be shorter than 24. This
    # cannot over-mask: it only ever matches the exact character sequence we actually sent.
    if len(code) >= 8:
        spaced = r"\s*".join(re.escape(ch) for ch in code)
        text = re.sub(spaced, "***REDACTED***", text)
# Layer 2a (card 163576a0; ORDER FIXED after the Cybersec NO-GO on 0d38dc6): the TUI breaks long
# lines ITSELF -- newline plus indent -- when it renders a long user message, and `capture-pane -J`
# only rejoins what the TERMINAL wrapped. So a code can arrive here already split, and the halves can
# each be shorter than the threshold of the generic sweep.
#
# THIS RUNS BEFORE THE GENERIC SWEEP, and that ordering is the whole fix. When it ran after, a split
# with one half >= 24 was partly masked by layer 2 first; the de-wrapped view then contained
# "***REDACTED***" instead of a 24+ run, no candidate matched, and the OTHER half survived to stderr.
# Measured by Cybersec on a 44-char code: split 24 left a 20-char tail, 26 left 18, 30 left 14, 36
# left 8. Only the short-short case was covered -- which is the rarer one on a wide terminal, and
# exactly what the first round of tests happened to exercise.
#
# The fix is a DE-WRAP pre-pass, not a lower threshold: dropping to ~12 would start masking ordinary
# diagnostic words and make the dump useless, which is how a redaction quietly gets turned off.
# Candidates are found in a de-wrapped VIEW, then masked in the ORIGINAL with whitespace tolerated
# between characters (same shape as layer 1b), so the dump keeps its line structure.
#
# Join ONLY an INDENTED continuation (newline followed by at least one space/tab) -- that is what the
# TUI produces when it wraps. Gluing every newline would also fuse the start of the NEXT line onto the
# token and mask an innocent word after it ("Try" ended up inside the run while building this).
#
# Trailing whitespace BEFORE the break is eaten too (card 2788552a, Cybered): tmux capture-pane
# routinely leaves a space at the end of a wrapped line, and without the leading [ \t]* the join did
# not happen at all -- the token stayed in two readable halves. Ordinary indented diagnostic text is
# still untouched, because joining it produces no 24-char run.
#
# KNOWN AND DELIBERATE: a wrap with NO indent on the continuation line is not joined, so this layer
# does not see it. Said out loud so a future TUI change that stops indenting is noticed rather than
# silently carrying the gap.
dewrapped = re.sub(r"[ \t]*\n[ \t]+", "", text)
for cand in sorted(set(re.findall(r"[A-Za-z0-9_-]{24,}", dewrapped)), key=len, reverse=True):
    # A candidate that also appears contiguously is left to the generic sweep below.
    if cand in text:
        continue
    spaced = r"\s*".join(re.escape(ch) for ch in cand)
    text = re.sub(spaced, "***REDACTED***", text)
# Layer 2b: anything still looking like a credential (24+ chars of the OAuth alphabet). Ordinary
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
      rm -f "$PENDING_MARKER" 2>/dev/null || true
      echo "OK: login successful, panel Max-authed."
      exit 0
    fi
    echo "FAIL: login did not confirm; capture (OAuth code redacted):" >&2
    # -J so a wrapped code is one token and the exact redaction below can match it.
    tmux capture-pane -t "$PANE" -p -J 2>/dev/null | grep -v '^$' | tail -6 | redact_code >&2
    exit 1
    ;;
  start)
    # Mark the relogin as pending BEFORE anything touches the panel, so a reader tick that lands
    # between this line and the first send-keys below still sees it and skips (vs. a window where
    # the marker only appears after the panel is already mid-dialog).
    #
    # The marker's pid must stay alive for the WHOLE pending window (until --paste or the TTL), but
    # this `start` invocation itself only runs for ~15-25s (the sleeps below) and then returns --
    # Peti's actual OAuth click-and-paste can take minutes. So a detached --hold-marker child (own
    # session via setsid, survives this invocation's exit) is what the marker's pid names; it writes
    # the marker itself, holds for up to PENDING_TTL_SEC, then self-expires. A FIFO handshake (not a
    # sleep/poll) blocks this invocation only until the child confirms the marker is actually on
    # disk, so the "written before the panel is touched" guarantee still holds exactly.
    #
    # BOUNDED (Cybersec MEDIUM-2, card f3343af0): the read used to have no timeout -- if the
    # holder child died before signalling (measured by simulating a no-op `setsid`), this `start`
    # invocation blocked FOREVER on the FIFO read. FAIL CLOSED on timeout: no confirmed marker
    # means we do not know the pending-state actually landed, so the panel must NOT be touched as
    # if it did -- a failed `start` the operator can re-run is strictly better than the stray
    # keystroke into a live login dialog this whole mechanism exists to prevent.
    # The FIFO lives inside its OWN mktemp -d, never a bare mktemp -u path in /tmp root (MikroB
    # finding, card f3343af0): two leaked at 14:12/14:18 when `start` was killed between mkfifo and
    # the old rm -f, and kg-search.selftest.sh's `grep /tmp/tmp.*` blocked forever on the leaked
    # FIFO, timing out store-selftests-all-run and refusing 3 unrelated lands. A directory can be
    # removed with a trap that fires on EXIT/INT/TERM (SIGKILL still leaks, but that is outside any
    # trap's reach); a bare file has no such parent to clean it up by.
    _wu_fifo_timeout="${WU_RELOGIN_FIFO_TIMEOUT_SEC:-10}"
    _wu_fifo_dir="$(mktemp -d)"
    trap 'rm -rf "$_wu_fifo_dir" 2>/dev/null || true' EXIT INT TERM
    _wu_fifo="$_wu_fifo_dir/fifo"
    mkfifo "$_wu_fifo" 2>/dev/null || true
    WU_RELOGIN_HOLD_SIGNAL_FIFO="$_wu_fifo" setsid bash "$0" --hold-marker >/dev/null 2>&1 </dev/null &
    _wu_hold_pid=$!
    disown 2>/dev/null || true
    # `read -t` alone does NOT bound this: the blocking part is the FIFO's open() itself (it waits
    # for a writer to open the other end), which happens as part of the `< fifo` redirection
    # BEFORE `read` ever starts running, so its own -t never gets a chance to apply. Measured
    # directly: a bare `read -t 1 < fifo` with no writer still blocked past a 3s outer timeout.
    # `timeout` wraps the WHOLE redirection+read in a child process it can kill by signal,
    # interrupting the blocked open() -- confirmed this actually unblocks it (rc 124 at ~2s).
    _wu_handshake_ok=0
    if [ -p "$_wu_fifo" ] && timeout "$_wu_fifo_timeout" bash -c 'read -r _ < "$1"' _ "$_wu_fifo" 2>/dev/null; then
      _wu_handshake_ok=1
    fi
    rm -rf "$_wu_fifo_dir" 2>/dev/null || true
    if [ "$_wu_handshake_ok" -ne 1 ]; then
      kill "$_wu_hold_pid" 2>/dev/null || true
      echo "FAIL: pending-marker handshake did not confirm within ${_wu_fifo_timeout}s -- not touching the panel." >&2
      exit 1
    fi
    ensure_pane || { echo "FAIL: cannot ensure panel" >&2; exit 1; }
    # Widen the window BEFORE /login prints the URL. tmux does NOT reflow existing scrollback,
    # so resizing after the URL is printed leaves it wrapped/truncated (the &state= param spills
    # to the next line and a naive head -n1 drops it -> "Missing state parameter" on the login
    # page). Wide window = the whole URL lands on one logical line.
    tmux resize-window -t "$PANE" -x 500 -y 60 2>/dev/null || true; sleep 1
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
    # Card 201a8de7 (Cybersec): this dump ALSO goes through the redaction. The original reasoning --
    # "no code has been typed yet on the start branch" -- only holds for the FIRST run. ensure_pane
    # returns immediately for an existing session and never clears it, so the realistic sequence is:
    # start -> paste -> login fails -> the operator runs start AGAIN in the same panel, which still
    # shows the code they just pasted. That re-run is not an independent event: you re-run start
    # BECAUSE something already broke, and that was precisely the branch printing unredacted output
    # into MikroB's transcript. -J joins wrapped lines so a code split across the panel width is one
    # token and the exact-match layer can see it.
    tmux capture-pane -t "$PANE" -p -J 2>/dev/null | grep -v '^$' | tail -8 | redact_code >&2
    exit 1
    ;;
  --hold-marker)
    # Internal, not part of the public usage line: a detached child `start` backgrounds to hold the
    # pending marker alive for the actual duration of a relogin. Writes the marker with ITS OWN pid
    # (the long-lived one the reader's liveness check verifies), signals the parent `start` over the
    # handshake FIFO that the write landed, then sleeps up to PENDING_TTL_SEC and self-expires --
    # only removing a marker that still names this same pid, so it never clobbers a NEWER holder's
    # marker from a second relogin started after a wedged first one timed out.
    #
    # REFUSE UNLESS INVOKED BY `start` (Cybersec MEDIUM-1, card f3343af0): a bare
    # `bash weekly-usage-relogin.sh --hold-marker &` used to write a perfectly valid marker with
    # NO relogin in flight at all -- rerun every <30 min, it suppressed every weekly-usage read
    # indefinitely. Checking the handshake FIFO `start` already sets up cannot AUTHENTICATE the
    # caller (same-user trust zone -- the env var is forgeable by anything running as this user),
    # but it does close the one-line direct-invocation path, the realistic careless/accidental
    # case. The deliberate same-user decoy (a process that fakes its own cmdline to pass the
    # reader's match) is closed on the READER side instead, by the SKIP-streak escalation in
    # weekly-usage-panel-read.sh -- this check cannot see that case and does not claim to.
    if [ -z "${WU_RELOGIN_HOLD_SIGNAL_FIFO:-}" ] || [ ! -p "${WU_RELOGIN_HOLD_SIGNAL_FIFO:-}" ]; then
      echo "FAIL: --hold-marker must be invoked by 'start' (missing/invalid handshake FIFO)." >&2
      exit 1
    fi
    write_pending_marker
    # Newline-terminated (card f3343af0, MEDIUM-2 follow-up): bash's `read` returns non-zero if it
    # hits EOF before seeing the delimiter, even when it DID read the byte -- a bare `printf x`
    # (no newline) made every handshake register as a read FAILURE once the parent side started
    # checking read's exit status (it used to be swallowed by `|| true`). Measured directly:
    # `printf x` -> read exit 1 despite the data arriving; `printf 'x\n'` -> read exit 0.
    printf 'x\n' > "$WU_RELOGIN_HOLD_SIGNAL_FIFO" 2>/dev/null || true
    # Hold until our own marker is gone (cleared by a successful --paste) or the TTL elapses --
    # checked against REAL wall-clock time (date) on every iteration, not one long sleep, so this
    # self-expires correctly even when `sleep` is PATH-shimmed to a no-op for OTHER delays in this
    # script (a real test need, not just defensiveness -- see weekly-usage-relogin-pending-marker.test.ts).
    _wu_start_ts="$(sed -n '2p' "$PENDING_MARKER" 2>/dev/null || echo 0)"
    while [ -f "$PENDING_MARKER" ]; do
      _wu_now="$(date +%s)"
      [ $((_wu_now - _wu_start_ts)) -lt "$PENDING_TTL_SEC" ] || break
      sleep 1 2>/dev/null || true
    done
    if [ -f "$PENDING_MARKER" ] && [ "$(sed -n '1p' "$PENDING_MARKER" 2>/dev/null)" = "$$" ]; then
      rm -f "$PENDING_MARKER" 2>/dev/null || true
    fi
    exit 0
    ;;
  --redact-stdin)
    # Test/diagnostic seam: pipe text in, get the SAME redaction the --paste failure dump applies.
    # Exposed so the redaction is directly testable -- the failure branch itself needs a live panel,
    # and an untested redaction is exactly the kind of thing that silently stops redacting.
    redact_code
    ;;
  --debug-marker-path)
    # Test-only seam, zero side effects: prints the RESOLVED marker path so a test can prove the
    # env override is ignored outside WU_RELOGIN_TEST_MODE=1 without ever touching the real
    # production marker file (card f3343af0 QA FAIL follow-up).
    printf '%s\n' "$PENDING_MARKER"
    exit 0
    ;;
  *)
    echo "usage: $0 [start|--check|--paste (code on stdin)|--paste-file <0600-file>]" >&2; exit 2 ;;
esac

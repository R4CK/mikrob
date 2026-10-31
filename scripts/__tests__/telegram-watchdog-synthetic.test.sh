#!/bin/bash
# Contract tests for the synthetic-line detection + ledger logging ported from
# upstream #2269 into telegram_progress_watchdog.py and telegram_progress_clear.py
# (card c6abbcf5).
#
# Locks three things the un-ported hooks got wrong:
#  (1) a CLI-written session-limit/API-error line in the transcript must NOT be
#      delivered to the owner as if it were the agent's real answer -- the
#      placeholder is edited into a "late answer" outage notice instead, and no
#      ledger row is written.
#  (2) a different CLI-written line ("No response requested.") is simply no
#      answer at all -- falls to the existing generic-error path, never the
#      outage line.
#  (3) a real send (by either hook) writes exactly one outbound row into the
#      conversation ledger, under the chat's agent id, with the watchdog/clear
#      prefix -- and a synthetic-outage edit writes NONE.
#  (4) the watchdog's 15-minute blunt backstop does not fire on a round that is
#      still open and actively writing transcript lines (round_activity).
#
# Fully hermetic: HOME/MARVEEN_ROOT/LEDGER_DB_PATH are pinned to a temp tree,
# Bot API traffic goes to a local stub via TELEGRAM_API_BASE.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WATCHDOG="$INSTALL_DIR/scripts/hooks/telegram_progress_watchdog.py"
CLEAR_HOOK="$INSTALL_DIR/scripts/hooks/telegram_progress_clear.py"

TMP="$(mktemp -d)"
trap 'kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

# --- Local Bot API stub -----------------------------------------------------
REQLOG="$TMP/requests.log"; PORTFILE="$TMP/port"
cat > "$TMP/stub.py" <<'PYEOF'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
reqlog = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8") if n else ""
        method = self.path.rsplit("/", 1)[-1]
        with open(reqlog, "a", encoding="utf-8") as f:
            f.write(f"{method} {body}\n")
        out = {"ok": True, "result": {"message_id": 9001}}
        payload = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload))); self.end_headers()
        self.wfile.write(payload)
srv = HTTPServer(("127.0.0.1", 0), H)
with open(sys.argv[2], "w") as f: f.write(str(srv.server_address[1]))
srv.serve_forever()
PYEOF
python3 "$TMP/stub.py" "$REQLOG" "$PORTFILE" &
STUB_PID=$!
for _ in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
PORT="$(cat "$PORTFILE" 2>/dev/null)"
[ -z "$PORT" ] && { echo "FATAL: stub did not start"; exit 1; }
API_BASE="http://127.0.0.1:$PORT"

CHAT="10000000001"

# --- Ledger: a sandboxed schema-matching sqlite DB, to assert outbound rows -
LEDGER_DB="$TMP/claudeclaw.db"
python3 - "$LEDGER_DB" <<'PYEOF'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("""
CREATE TABLE conversation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  message_id TEXT,
  text TEXT,
  ts TEXT,
  created_at INTEGER NOT NULL,
  attachment_kind TEXT,
  attachment_file_id TEXT,
  reply_to_message_id TEXT,
  source TEXT,
  UNIQUE(agent_id, chat_id, direction, message_id)
)
""")
con.commit()
PYEOF
ledger_rows() { # agent_id -> count of outbound rows for that agent, any chat
    python3 - "$LEDGER_DB" "$1" <<'PYEOF'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
print(con.execute("SELECT count(*) FROM conversation_log WHERE agent_id=? AND direction='out'",
                   (sys.argv[2],)).fetchone()[0])
PYEOF
}
# The watchdog loads ledger_lib strictly from FLEET_ROOT/scripts/hooks (no
# __file__ fallback, unlike the clear hook) -- mirror that layout under the
# fake MARVEEN_ROOT so its _ledger_lib() actually finds the real module.
mkdir -p "$TMP/root/scripts/hooks"
cp "$INSTALL_DIR/scripts/hooks/ledger_lib.py" "$TMP/root/scripts/hooks/ledger_lib.py"

ledger_text_like() { # pattern -> yes/no
    python3 - "$LEDGER_DB" "$1" <<'PYEOF'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
rows = con.execute("SELECT text FROM conversation_log WHERE direction='out'").fetchall()
print("yes" if any(sys.argv[2] in (r[0] or "") for r in rows) else "no")
PYEOF
}

# --- Watchdog state builder --------------------------------------------------
# kind = outage_limit   -> model "<synthetic>", text is a session-limit line
# kind = outage_apierr  -> isApiErrorMessage true
# kind = none_line      -> model "<synthetic>", text "No response requested."
# kind = real_apierr    -> real model, text happens to START with "API error"
make_case() { # name kind age_seconds
    local name="$1" kind="$2" age="$3"
    local pdir="$TMP/root/agents/$name/.claude/channels/telegram/progress"
    local sdir="$TMP/root/agents/$name/.claude/channels/telegram"
    mkdir -p "$pdir"
    printf 'TELEGRAM_BOT_TOKEN=TESTTOKEN\n' > "$sdir/.env"
    local tr="$sdir/transcript.jsonl"
    case "$kind" in
      outage_limit)
        printf '%s\n' '{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"You'"'"'ve hit your session limit · resets 12am (UTC)"}]}}' > "$tr" ;;
      outage_apierr)
        printf '%s\n' '{"type":"assistant","isApiErrorMessage":true,"message":{"role":"assistant","content":[{"type":"text","text":"API error: overloaded"}]}}' > "$tr" ;;
      none_line)
        printf '%s\n' '{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"No response requested."}]}}' > "$tr" ;;
      real_apierr)
        printf '%s\n' '{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"API error handling is now retried automatically."}]}}' > "$tr" ;;
    esac
    printf '[{"chat_id":"%s","message_id":555,"transcript_path":"%s"}]\n' "$CHAT" "$tr" \
        > "$pdir/SID.json"
    python3 - "$pdir/SID.json" "$age" <<'PY'
import os, sys, time
os.utime(sys.argv[1], (time.time()-int(sys.argv[2]),)*2)
PY
    echo "$pdir"
}
pend_exists() { [ -f "$1/SID.json" ] && echo yes || echo no; }
count() { grep -c "^$1 " "$REQLOG" 2>/dev/null; }
body_has() { grep -q "$1" "$REQLOG" && echo yes || echo no; }
run_wd() { # force_up wedged_up_sec
    : > "$REQLOG"
    HOME="$TMP" MARVEEN_ROOT="$TMP/root" TELEGRAM_API_BASE="$API_BASE" LEDGER_DB_PATH="$LEDGER_DB" \
      TELEGRAM_WATCHDOG_FORCE_AGENT_UP="$1" TELEGRAM_WATCHDOG_WEDGED_UP_SEC="$2" \
      python3 "$WATCHDOG"
}

echo "telegram-watchdog-synthetic tests (#2269 port, card c6abbcf5)"
echo "=============================================================="

echo ""
echo "(a) Synthetic session-limit line (model <synthetic>): outage edit only"
: > "$LEDGER_DB.touch" 2>/dev/null
PA="$(make_case wa_sl outage_limit 1000)"
run_wd 1 1
assert_eq "no sendMessage (never deliver the CLI's own limit line as an answer)" "0" "$(count sendMessage)"
assert_eq "no deleteMessage (placeholder is edited, not dropped)" "0" "$(count deleteMessage)"
assert_eq "exactly one editMessageText (outage notice)" "1" "$(count editMessageText)"
assert_eq "outage text used, not the generic wedged error" "yes" "$(body_has '\\u23f3')"
assert_eq "state file removed after handling" "no" "$(pend_exists "$PA")"
assert_eq "no ledger row for a synthetic-outage (no real send happened)" "0" "$(ledger_rows wa_sl)"

echo ""
echo "(b) Synthetic session-limit via isApiErrorMessage flag: same outage path"
PB="$(make_case wb_ae outage_apierr 1000)"
run_wd 1 1
assert_eq "no sendMessage" "0" "$(count sendMessage)"
assert_eq "one outage edit" "1" "$(count editMessageText)"
assert_eq "no ledger row" "0" "$(ledger_rows wb_ae)"

echo ""
echo "(c) A different CLI-written line (no outage flag): no answer at all"
PC="$(make_case wc_none none_line 1000)"
run_wd 1 1
assert_eq "no sendMessage (nothing to deliver)" "0" "$(count sendMessage)"
assert_eq "falls back to the GENERIC wedged error, not the outage notice" "1" "$(count editMessageText)"
assert_eq "generic error text used" "yes" "$(body_has "Valami elakadt")"
assert_eq "outage text NOT used" "no" "$(body_has '\\u23f3')"

echo ""
echo "(d) Real answer from a real model that merely starts with 'API error': no false positive"
PD="$(make_case wd_real real_apierr 1000)"
run_wd 1 1
assert_eq "delivered as a real answer (one sendMessage)" "1" "$(count sendMessage)"
assert_eq "delivers the real text" "yes" "$(body_has "API error handling is now retried automatically")"
assert_eq "placeholder dropped (deleteMessage)" "1" "$(count deleteMessage)"
assert_eq "exactly one ledger row for the real send" "1" "$(ledger_rows wd_real)"
assert_eq "ledger text carries the watchdog prefix" "yes" "$(ledger_text_like "[telegram-progress-watchdog]")"

echo ""
echo "(e) round_activity: a long-open round that is still writing is NOT wedged"
# Timestamped transcript: an opening prompt anchors the round, then a tool-use
# line written inside WEDGED_SEC of "now" -- the round is still active even
# though its age (from the marker mtime) is past the 900s blunt backstop.
PE_NAME=we_active
PE_PDIR="$TMP/root/agents/$PE_NAME/.claude/channels/telegram/progress"
PE_SDIR="$TMP/root/agents/$PE_NAME/.claude/channels/telegram"
mkdir -p "$PE_PDIR"
printf 'TELEGRAM_BOT_TOKEN=TESTTOKEN\n' > "$PE_SDIR/.env"
TR_E="$PE_SDIR/transcript.jsonl"
python3 - "$TR_E" <<'PY'
import datetime, json, sys, time
tr = sys.argv[1]
now = time.time()
age = 1000  # > DEFAULT_WEDGED_SEC (900)
t0 = now - age
def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
ev = [
    {"type": "user", "timestamp": iso(t0),
     "message": {"role": "user", "content": "hosszu feladat"}},
    # A tool-use line written only 30s ago: the round is still open and active.
    {"type": "assistant", "timestamp": iso(now - 30),
     "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "tuX", "name": "Bash"}]}},
]
with open(tr, "w") as f:
    for e in ev:
        f.write(json.dumps(e) + "\n")
PY
printf '[{"chat_id":"%s","message_id":555,"transcript_path":"%s"}]\n' "$CHAT" "$TR_E" \
    > "$PE_PDIR/SID.json"
python3 - "$PE_PDIR/SID.json" 1000 <<'PY'
import os, sys, time
os.utime(sys.argv[1], (time.time()-int(sys.argv[2]),)*2)
PY
run_wd 1 1
assert_eq "backstop does NOT fire on a round still actively writing" "0" "$(count sendMessage)"
assert_eq "no generic-error edit either" "0" "$(count editMessageText)"
assert_eq "placeholder preserved (round still open)" "yes" "$(pend_exists "$PE_PDIR")"

echo ""
echo "(f) Stop hook (telegram_progress_clear.py) fallback: synthetic outage, no ledger"
SD_F="$TMP/clear_f"
mkdir -p "$SD_F/progress"
printf 'TELEGRAM_BOT_TOKEN=TESTTOKEN\n' > "$SD_F/.env"
printf '[{"chat_id": "%s", "message_id": 555}]\n' "$CHAT" > "$SD_F/progress/CSID.json"
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"You'"'"'ve hit your usage limit"}]}}' \
    > "$SD_F/transcript.jsonl"
: > "$REQLOG"
printf '{"session_id":"CSID","transcript_path":"%s","stop_hook_active":true}' "$SD_F/transcript.jsonl" \
    | TELEGRAM_STATE_DIR="$SD_F" LEDGER_DB_PATH="$LEDGER_DB" MARVEEN_ROOT="$INSTALL_DIR" TELEGRAM_API_BASE="$API_BASE" python3 "$CLEAR_HOOK" > /dev/null
assert_eq "clear hook: no sendMessage for a synthetic line" "0" "$(count sendMessage)"
assert_eq "clear hook: one outage edit" "1" "$(count editMessageText)"

echo ""
echo "(g) Stop hook fallback: real answer -> sent once, one ledger row"
SD_G="$TMP/clear_g"
mkdir -p "$SD_G/progress"
printf 'TELEGRAM_BOT_TOKEN=TESTTOKEN\n' > "$SD_G/.env"
printf '[{"chat_id": "%s", "message_id": 555}]\n' "$CHAT" > "$SD_G/progress/CSID2.json"
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"REAL_STOP_HOOK_ANSWER"}]}}' \
    > "$SD_G/transcript.jsonl"
: > "$REQLOG"
printf '{"session_id":"CSID2","transcript_path":"%s","stop_hook_active":true}' "$SD_G/transcript.jsonl" \
    | TELEGRAM_STATE_DIR="$SD_G" LEDGER_DB_PATH="$LEDGER_DB" MARVEEN_ROOT="$INSTALL_DIR" TELEGRAM_API_BASE="$API_BASE" python3 "$CLEAR_HOOK" > /dev/null
assert_eq "clear hook: one real sendMessage" "1" "$(count sendMessage)"
assert_eq "clear hook: ledger row for the real send carries its prefix" "yes" "$(ledger_text_like "[telegram-progress-clear, fallback] REAL_STOP_HOOK_ANSWER")"

# ---------------------------------------------------------------------------
echo ""
echo "=============================================================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."

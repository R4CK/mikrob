#!/usr/bin/env python3
"""Selftest for telegram_fallback_send.py's outbox mode (card ea3e7316).

Covers: outbox_idempotency_key determinism, try_outbox_enqueue's success/failure shape, and
main() end-to-end against a real local HTTP capture server standing in for both the dashboard
(/api/telegram/outbox) and the Telegram Bot API (whichever path main() actually calls tells us
which route it took -- that IS the assertion, not a side detail).

Exit 0 = all pass. Exit 1 = one or more failures (printed to stderr).
"""
import hashlib
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telegram_fallback_send as tfs  # noqa: E402

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "telegram_fallback_send.py")

FAILURES = []
CHECKS = 0


def check(label, got, want):
    global CHECKS
    CHECKS += 1
    if got != want:
        FAILURES.append(f"FAIL [{label}]: got {got!r}, want {want!r}")


# ---------------------------------------------------------------------------
# outbox_idempotency_key: deterministic, and sensitive to every input it takes.
# ---------------------------------------------------------------------------
k1 = tfs.outbox_idempotency_key("sid-a", "123", "hello")
k2 = tfs.outbox_idempotency_key("sid-a", "123", "hello")
check("idempotency key is deterministic for identical input", k1, k2)
check("idempotency key changes with sid", k1 != tfs.outbox_idempotency_key("sid-b", "123", "hello"), True)
check("idempotency key changes with chat_id", k1 != tfs.outbox_idempotency_key("sid-a", "456", "hello"), True)
check("idempotency key changes with text", k1 != tfs.outbox_idempotency_key("sid-a", "123", "bye"), True)
check("idempotency key is a 64-char lowercase hex sha256", k1, hashlib.sha256(b"sid-a:123:hello").hexdigest())


# ---------------------------------------------------------------------------
# Local capture server standing in for the dashboard + the Bot API, routed by path.
# ---------------------------------------------------------------------------
class _Handler(http.server.BaseHTTPRequestHandler):
    requests = []
    outbox_status = 200

    def log_message(self, *a):
        pass

    def _record(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        _Handler.requests.append({"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body})

    def do_POST(self):
        self._record()
        if self.path == "/api/telegram/outbox":
            status = _Handler.outbox_status
            payload = json.dumps({"id": 1, "status": "pending"}).encode() if status == 200 else b'{"error":"nope"}'
        else:
            # Bot API sendMessage path: /bot<token>/sendMessage
            status = 200
            payload = json.dumps({"ok": True, "result": {"message_id": 42}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def _start_server():
    _Handler.requests = []
    _Handler.outbox_status = 200
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_port


def _outbox_posts():
    return [r for r in _Handler.requests if r["method"] == "POST" and r["path"] == "/api/telegram/outbox"]


def _send_message_posts():
    return [r for r in _Handler.requests if r["method"] == "POST" and "/sendMessage" in r["path"]]


def _state_dir_with_token(tmp, bot_token="BOTTOK:xyz"):
    sd = os.path.join(tmp, "state")
    os.makedirs(sd, exist_ok=True)
    with open(os.path.join(sd, ".env"), "w", encoding="utf-8") as f:
        f.write(f"TELEGRAM_BOT_TOKEN={bot_token}\n")
    return sd


def _run_main(tmp, chat_id, text, api_base, outbox_api, env_extra=None, bot_token="BOTTOK:xyz"):
    sd = _state_dir_with_token(tmp, bot_token)
    dash_token_file = os.path.join(tmp, "dashboard-token")
    with open(dash_token_file, "w", encoding="utf-8") as f:
        f.write("dash-secret-token\n")
    env = dict(os.environ)
    env["TELEGRAM_API_BASE"] = api_base
    env["TELEGRAM_OUTBOX_API"] = outbox_api
    env["TELEGRAM_OUTBOX_TOKEN_FILE"] = dash_token_file
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        [sys.executable, SCRIPT, chat_id, text, "--state-dir", sd, "--sid", "selftest-sid"],
        env=env, capture_output=True, text=True, timeout=15,
    )
    return proc


server, port = _start_server()
base = f"http://127.0.0.1:{port}"
try:
    # --- try_outbox_enqueue direct: success ---
    with tempfile.TemporaryDirectory() as tmp:
        sd = _state_dir_with_token(tmp)
        dash_token_file = os.path.join(tmp, "dashboard-token")
        with open(dash_token_file, "w", encoding="utf-8") as f:
            f.write("dash-secret-token\n")
        os.environ["TELEGRAM_OUTBOX_API"] = base
        os.environ["TELEGRAM_OUTBOX_TOKEN_FILE"] = dash_token_file
        try:
            ok = tfs.try_outbox_enqueue(sd, "sid1", "999", "hi there")
        finally:
            del os.environ["TELEGRAM_OUTBOX_API"]
            del os.environ["TELEGRAM_OUTBOX_TOKEN_FILE"]
        check("try_outbox_enqueue returns True on a 200 response", ok, True)
        posts = _outbox_posts()
        check("try_outbox_enqueue POSTed exactly one request to the outbox endpoint", len(posts), 1)
        sent_body = json.loads(posts[0]["body"].decode("utf-8"))
        check("outbox POST body carries chat_id/text/idempotency_key only (no token)",
              sorted(sent_body.keys()), ["chat_id", "idempotency_key", "text"])
        check("outbox POST auth header carries the DASHBOARD token, never the bot token",
              posts[0]["headers"].get("Authorization"), "Bearer dash-secret-token")
        _Handler.requests.clear()

    # --- try_outbox_enqueue: missing dashboard token file -> False, no network call made ---
    with tempfile.TemporaryDirectory() as tmp:
        sd = _state_dir_with_token(tmp)
        os.environ["TELEGRAM_OUTBOX_API"] = base
        os.environ["TELEGRAM_OUTBOX_TOKEN_FILE"] = os.path.join(tmp, "does-not-exist")
        try:
            ok = tfs.try_outbox_enqueue(sd, "sid1", "999", "hi there")
        finally:
            del os.environ["TELEGRAM_OUTBOX_API"]
            del os.environ["TELEGRAM_OUTBOX_TOKEN_FILE"]
        check("try_outbox_enqueue returns False when no dashboard token file exists", ok, False)
        check("no request reached the server when the token file is missing", len(_Handler.requests), 0)
        _Handler.requests.clear()

    # ---------------------------------------------------------------------
    # main() end-to-end, outbox mode ON, dashboard reachable -> enqueues, never calls the
    # Bot API's sendMessage at all, exits 0.
    # ---------------------------------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        proc = _run_main(tmp, "555", "outbox message", api_base=base, outbox_api=base,
                          env_extra={"MIKROB_TG_OUTBOX": "1"})
        check("outbox mode ON + dashboard reachable: exit 0", proc.returncode, 0)
        check("outbox mode ON: enqueued via /api/telegram/outbox", len(_outbox_posts()), 1)
        check("outbox mode ON: never calls the Bot API sendMessage", len(_send_message_posts()), 0)
        out = json.loads(proc.stdout.strip())
        check("outbox mode ON: stdout reports outbox:true", out.get("outbox"), True)
        _Handler.requests.clear()

    # ---------------------------------------------------------------------
    # main() end-to-end, outbox mode OFF (flag unset) -> goes straight to the direct
    # sendMessage path, exactly as before this card -- zero behaviour change by default.
    # ---------------------------------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        proc = _run_main(tmp, "555", "direct message", api_base=base, outbox_api=base)
        check("outbox mode OFF (default): exit 0", proc.returncode, 0)
        check("outbox mode OFF: never POSTs to the outbox endpoint", len(_outbox_posts()), 0)
        check("outbox mode OFF: delivers via the direct Bot API sendMessage path", len(_send_message_posts()), 1)
        _Handler.requests.clear()

    # ---------------------------------------------------------------------
    # main() end-to-end, outbox mode ON but the outbox endpoint fails (503/disabled
    # downstream, or dashboard unreachable) -> falls through to the direct send path,
    # never silently drops the message.
    # ---------------------------------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        _Handler.outbox_status = 503
        try:
            proc = _run_main(tmp, "555", "fallback message", api_base=base, outbox_api=base,
                              env_extra={"MIKROB_TG_OUTBOX": "1"})
        finally:
            _Handler.outbox_status = 200
        check("outbox endpoint failing: exit 0 (fell through, still delivered)", proc.returncode, 0)
        check("outbox endpoint failing: the outbox POST was attempted", len(_outbox_posts()), 1)
        check("outbox endpoint failing: delivery still happened via the direct path", len(_send_message_posts()), 1)
        _Handler.requests.clear()

    # ---------------------------------------------------------------------
    # main() end-to-end, outbox mode ON, UNREACHABLE dashboard (nothing listening) ->
    # also falls through cleanly, same guarantee as the 503 case above.
    # ---------------------------------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        proc = _run_main(tmp, "555", "unreachable dashboard", api_base=base,
                          outbox_api="http://127.0.0.1:1", env_extra={"MIKROB_TG_OUTBOX": "1"})
        check("unreachable dashboard: exit 0 (fell through, still delivered)", proc.returncode, 0)
        check("unreachable dashboard: delivery still happened via the direct path", len(_send_message_posts()), 1)
        _Handler.requests.clear()

    # ---------------------------------------------------------------------
    # No duplicate send on retry: the SAME (sid, chat_id, text) called twice via main()
    # produces two outbox POSTs (the dashboard's own UNIQUE idempotency_key constraint is what
    # actually dedups storage-side -- src/db.ts's enqueueTelegramOutbox test covers that), but
    # BOTH calls here must carry the IDENTICAL idempotency_key, which is the half of the
    # contract this script owns.
    # ---------------------------------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        sd = _state_dir_with_token(tmp)
        dash_token_file = os.path.join(tmp, "dashboard-token")
        with open(dash_token_file, "w", encoding="utf-8") as f:
            f.write("dash-secret-token\n")
        env = dict(os.environ)
        env["TELEGRAM_OUTBOX_API"] = base
        env["TELEGRAM_OUTBOX_TOKEN_FILE"] = dash_token_file
        env["MIKROB_TG_OUTBOX"] = "1"
        subprocess.run([sys.executable, SCRIPT, "777", "retry me", "--state-dir", sd, "--sid", "same-sid"],
                       env=env, capture_output=True, text=True, timeout=15)
        subprocess.run([sys.executable, SCRIPT, "777", "retry me", "--state-dir", sd, "--sid", "same-sid"],
                       env=env, capture_output=True, text=True, timeout=15)
        posts = _outbox_posts()
        check("retry: two calls produce two POSTs", len(posts), 2)
        keys = [json.loads(p["body"].decode("utf-8"))["idempotency_key"] for p in posts]
        check("retry: both carry the SAME idempotency_key (dedup is possible downstream)", keys[0], keys[1])
        _Handler.requests.clear()
finally:
    server.shutdown()

if FAILURES:
    print(f"{len(FAILURES)}/{CHECKS} checks failed:", file=sys.stderr)
    for f in FAILURES:
        print(f"  {f}", file=sys.stderr)
    sys.exit(1)

print(f"{CHECKS}/{CHECKS} checks passed (telegram_fallback_send.selftest.py)")
sys.exit(0)

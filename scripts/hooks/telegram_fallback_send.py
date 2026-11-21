#!/usr/bin/env python3
"""
Telegram Bot API fallback SENDER (agent-invoked CLI, not a harness hook).

When the in-session Telegram MCP `reply` tool is dropped mid-turn ("MCP servers
have disconnected: plugin:telegram:telegram"), the agent must still reach the
user. The telegram-botapi-fallback skill used to `curl` sendMessage directly --
but a raw send does NOT clear the "✍️ Dolgozom rajta…" placeholder (only the
reply TOOL's PostToolUse hook does that). So the Stop hook, seeing a still-
pending placeholder, delivered the agent's final answer a SECOND time at turn
end -> the user got the message twice.

This helper closes that gap by making a manual fallback behave EXACTLY like the
reply tool: it sends the message AND then clears the placeholder for that chat
(deleteMessage + trim the session's pending list), mirroring
telegram_progress_reply_clear.py. With the placeholder gone, the Stop hook's
enforce path finds nothing pending -> no duplicate, no "you never replied" nudge,
no restart needed.

Usage:
    telegram_fallback_send.py <chat_id> <text> [--sid SID] [--state-dir DIR]

Exit code:
    0  message delivered (placeholder cleared best-effort)
    2  delivery FAILED (Bot API not ok / unreachable) -> caller should escalate
       (per the skill: fall through to email). Nothing was cleared.

Resolution mirrors the plugin/hooks: state dir from --state-dir else
TELEGRAM_STATE_DIR else ~/.claude/channels/telegram; token from <state_dir>/.env
(TELEGRAM_BOT_TOKEN=); session id from --sid else CLAUDE_CODE_SESSION_ID else
"default". Bot API base from TELEGRAM_API_BASE (default https://api.telegram.org)
so tests can point it at a local stub.

OUTBOX MODE (card ea3e7316, MIKROB_TG_OUTBOX=1): when set, this script never
reads the Bot API token to DELIVER the message -- it POSTs {chat_id, text,
idempotency_key} to the dashboard's durable outbox (/api/telegram/outbox)
instead, authenticated with the dashboard's OWN Bearer token (store/.dashboard-
token, the same one every other dashboard API call uses), and exits 0 as soon
as the message is durably enqueued (the dashboard's own drain loop delivers
it, surviving this process -- or the whole tmux server -- dying right after).
The Bot API token itself is still read, exactly as before, if (and only if)
there is a progress placeholder to clear for this chat -- a narrower, unrelated,
pre-existing use (see clear_placeholder), not part of delivering this message.
By default idempotency_key is a fresh random nonce PER INVOCATION (combined
with sid/chat_id/text), so two separately-triggered sends -- even an
identical, legitimately-repeated message, e.g. a scheduled task's daily
"nothing to report" -- are never silently collapsed into one (CYBERED NO-GO
35157 B2: the old sha(sid, chat, text)-only key, with sid defaulting to
"default" outside a Claude session, deduped a genuine repeat as if it were a
retry -- 200 "sent", nothing queued, exit 0 ok:true, and the second message
never went out). A caller that DOES want retry semantics (re-running this
exact call because the first run's outcome was unknown) passes
--idempotency-key with its OWN stable key, reused across its own retries;
nothing in this script invents that stability on the caller's behalf. If the
outbox call fails for ANY reason (dashboard down, flag mis-set downstream,
network error), this falls through to the normal direct-send path below --
outbox mode never makes delivery LESS reliable than before, only more so.
"""
import sys
import os
import json
import hashlib
import secrets
import urllib.error
import urllib.request

MAX_LEN = 4000  # Telegram hard limit is 4096; match the Stop hook's trim.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
def outbox_api():
    # Function, not a module constant (matches api_base()'s own convention below):
    # read fresh each call, so an env override set after import -- as every test here does --
    # actually takes effect.
    return os.environ.get("TELEGRAM_OUTBOX_API", "http://localhost:3420")


def outbox_token_file():
    return os.environ.get("TELEGRAM_OUTBOX_TOKEN_FILE") or os.path.join(ROOT, "store", ".dashboard-token")


def outbox_idempotency_key(sid, chat_id, text, nonce=None):
    """`nonce` defaults to a fresh random value, so by default every call is its
    own key regardless of how similar sid/chat_id/text are to a past call --
    see the OUTBOX MODE docstring (CYBERED NO-GO 35157 B2). Pass a caller-owned
    stable `nonce` to get retry-dedup semantics instead."""
    raw = "%s:%s:%s:%s" % (sid, chat_id, text, nonce if nonce is not None else secrets.token_hex(16))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def try_outbox_enqueue(sd, sid, chat_id, text, idempotency_key=None):
    """Best-effort: True if the message is durably enqueued, False for any
    reason at all (caller falls through to a direct send either way).
    `idempotency_key`, when given, is used VERBATIM (caller-supplied, see
    --idempotency-key); otherwise a fresh one is derived with a random nonce."""
    try:
        with open(outbox_token_file(), encoding="utf-8") as f:
            dash_token = f.read().strip()
    except Exception:
        return False
    if not dash_token:
        return False
    payload = {
        "chat_id": str(chat_id),
        "text": text[:MAX_LEN],
        "idempotency_key": idempotency_key or outbox_idempotency_key(sid, chat_id, text[:MAX_LEN]),
    }
    req = urllib.request.Request(
        outbox_api().rstrip("/") + "/api/telegram/outbox",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + dash_token},
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            if resp.status != 200:
                return False
            json.loads(resp.read().decode("utf-8") or "{}")
    except Exception as e:
        log(sd, "[fallback-send] outbox enqueue failed, falling back to direct send: %s" % e)
        return False
    return True


def api_base():
    return os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")


def state_dir(cli_dir=None):
    # #915: cli arg, then env override, then install-scoped once migrated,
    # then the legacy shared path.
    d = cli_dir or os.environ.get("TELEGRAM_STATE_DIR")
    if d:
        return d
    _root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    _inst = os.path.join(_root, ".claude", "channels", "telegram")
    if os.path.isfile(os.path.join(_inst, ".env")):
        return _inst
    return os.path.expanduser("~/.claude/channels/telegram")


def session_id(cli_sid=None):
    return cli_sid or os.environ.get("CLAUDE_CODE_SESSION_ID") or "default"


def log(sd, msg):
    try:
        os.makedirs(os.path.join(sd, "progress"), exist_ok=True)
        with open(os.path.join(sd, "progress", "debug.log"), "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def token(sd):
    try:
        for line in open(os.path.join(sd, ".env"), encoding="utf-8"):
            line = line.strip()
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    except Exception:
        return None
    return None


def api(tok, method, payload):
    url = f"{api_base()}/bot{tok}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def clear_placeholder(sd, sid, chat_id):
    """Delete this session's pending placeholder(s) for `chat_id` and trim the
    pending list -- the exact bookkeeping telegram_progress_reply_clear.py does
    when the reply tool fires, so the Stop hook won't re-deliver. Best-effort:
    any failure is logged, never raised (the message is already out).

    Reads the Bot API token ONLY if there is actually a placeholder to delete
    (the common case has none) -- card ea3e7316's outbox-mode caller never
    reads the token for the message it is delivering, and this keeps that true
    for its placeholder cleanup too, not just for the send itself."""
    path = os.path.join(sd, "progress", f"{sid}.json")
    try:
        pend = json.load(open(path))
    except Exception:
        return  # nothing pending for this session (e.g. not a placeholder turn)
    keep, drop = [], []
    for p in pend:
        (drop if str(p.get("chat_id")) == str(chat_id) else keep).append(p)
    if not drop:
        return
    tok = token(sd)
    if not tok:
        log(sd, "[fallback-send] placeholder pending but no token to clear it with")
        return
    for p in drop:
        try:
            api(tok, "deleteMessage",
                {"chat_id": p.get("chat_id"), "message_id": p.get("message_id")})
        except Exception as e:
            log(sd, f"[fallback-send] placeholder delete failed: {e}")
    try:
        if keep:
            json.dump(keep, open(path, "w"))
        else:
            os.remove(path)
    except Exception as e:
        log(sd, f"[fallback-send] pend trim failed: {e}")


def parse_args(argv):
    pos, sid, sdir, idem_key = [], None, None, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--sid" and i + 1 < len(argv):
            sid = argv[i + 1]; i += 2; continue
        if a == "--state-dir" and i + 1 < len(argv):
            sdir = argv[i + 1]; i += 2; continue
        if a == "--idempotency-key" and i + 1 < len(argv):
            idem_key = argv[i + 1]; i += 2; continue
        pos.append(a); i += 1
    return pos, sid, sdir, idem_key


def main():
    pos, cli_sid, cli_dir, cli_idem_key = parse_args(sys.argv[1:])
    if len(pos) < 2:
        sys.stderr.write("usage: telegram_fallback_send.py <chat_id> <text> "
                         "[--sid SID] [--state-dir DIR] [--idempotency-key KEY]\n")
        sys.exit(2)
    chat_id, text = pos[0], pos[1]
    sd = state_dir(cli_dir)
    sid = session_id(cli_sid)

    if os.environ.get("MIKROB_TG_OUTBOX") == "1" and try_outbox_enqueue(sd, sid, chat_id, text, cli_idem_key):
        clear_placeholder(sd, sid, chat_id)
        log(sd, f"[fallback-send] enqueued via durable outbox chat={chat_id} sid={sid}")
        print(json.dumps({"ok": True, "outbox": True}, ensure_ascii=False))
        sys.exit(0)

    tok = token(sd)
    if not tok:
        sys.stderr.write("telegram_fallback_send: no TELEGRAM_BOT_TOKEN in "
                         f"{os.path.join(sd, '.env')}\n")
        sys.exit(2)

    try:
        resp = api(tok, "sendMessage", {"chat_id": chat_id, "text": text[:MAX_LEN]})
    except Exception as e:
        sys.stderr.write(f"telegram_fallback_send: sendMessage failed: {e}\n")
        sys.exit(2)

    if not (isinstance(resp, dict) and resp.get("ok")):
        sys.stderr.write(f"telegram_fallback_send: Bot API not ok: {resp}\n")
        sys.exit(2)

    # Delivered -> mirror the reply tool: clear the placeholder so the Stop hook
    # does not re-deliver the same answer.
    clear_placeholder(sd, sid, chat_id)
    mid = (resp.get("result") or {}).get("message_id")
    log(sd, f"[fallback-send] delivered chat={chat_id} message_id={mid} "
            f"(placeholder cleared) sid={sid}")
    # Echo the API result so the agent can record the message_id.
    print(json.dumps(resp, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()

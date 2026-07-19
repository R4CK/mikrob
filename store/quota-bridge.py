#!/usr/bin/env python3
"""
quota-bridge.py -- degraded-mode Telegram responder for when MikroB (the Claude
session) is quota-blocked and cannot answer.

WHY: MikroB runs ON Claude. When the 5h usage limit is hit, MikroB's session is
stuck on the limit modal and cannot respond on Telegram -- the channel goes deaf
until reset. This bridge is an INDEPENDENT process (systemd user service) that,
ONLY during such an outage, answers Peti with the local Ornith-9B model + a
memory-RAG context, then hands the channel back the moment MikroB recovers.

DESIGN (matches the telegram plugin's own single-consumer protocol):
- Telegram allows exactly ONE getUpdates consumer per bot token; ownership is the
  `bot.pid` lock file. The plugin kills the previous holder on startup. So:
    * Normal:   plugin's `bun server.ts` holds bot.pid, bridge is DORMANT (never
                touches Telegram) -> zero conflict with MikroB.
    * Outage:   bridge SIGTERMs the stuck holder, writes its own pid, takes over
                getUpdates, answers with the local model.
    * Recovery: quota-resume restarts MikroB's session; its fresh server.ts kills
                the bridge's poller (bot.pid protocol) and reclaims the channel.
      The bridge also self-relinquishes as soon as it sees MikroB healthy again.

OUTAGE SIGNAL: the mikrob-channels tmux pane showing the usage-limit banner
(same regex as src/model-fallback.ts), confirmed over 2 consecutive checks to
avoid transient false positives. Weekly-limit-stop is NOT an outage (MikroB is
alive then) and is deliberately ignored here.

No secrets are hardcoded: the bot token is read from the telegram channel .env,
the dashboard token from store/.dashboard-token, both at call time.
"""
import json, os, re, subprocess, sys, time, urllib.request, urllib.parse, urllib.error, signal

HOME = os.path.expanduser("~")
MARVEEN = "/home/neon/marveen"
STORE = f"{MARVEEN}/store"
TG_DIR = f"{HOME}/.claude/channels/telegram"
TG_ENV = f"{TG_DIR}/.env"
ACCESS_JSON = f"{TG_DIR}/access.json"
BOT_PID_FILE = f"{TG_DIR}/bot.pid"
STATE_FILE = f"{STORE}/quota-bridge-state.json"
LOCAL_LLM = f"{STORE}/local-llm.sh"
# Single local model (Peti 2026-07-19: one LLM only, coding-focused). Also used by
# Ghost for degraded comms. Read from the shared config so a model swap is one place.
def _read_model():
    try:
        with open(f"{STORE}/local-llm-model") as f:
            return f.read().strip() or "qwen2.5-coder:7b-instruct-q4_K_M"
    except OSError:
        return "qwen2.5-coder:7b-instruct-q4_K_M"
QUALITY_MODEL = _read_model()
DASH = "http://localhost:3420"
DASH_TOKEN_FILE = f"{STORE}/.dashboard-token"
MIKROB_PANE = "mikrob-channels"
PETI_CHAT_ID = "7929620734"
HEARTBEAT_FILE = f"{STORE}/mikrob-alive.heartbeat"
HEARTBEAT_STALE_SEC = 720   # 12 min: MikroB runs scheduled tasks every few min; a
                            # frozen (quota-stuck) session stops touching this file.

LIMIT_RE = re.compile(
    r"(usage limit reached|reached your usage limit|hit (?:your|the) usage limit"
    r"|usage limit (?:will )?reset|limit will reset at|\d+-hour limit reached)", re.I)

POLL_HEALTHY_SEC = 45      # how often to check MikroB health when things are fine
GETUPDATES_TIMEOUT = 25    # long-poll seconds during outage
CONFIRM_CHECKS = 2         # consecutive banner sightings before declaring outage


def log(msg):
    sys.stderr.write(f"[quota-bridge {time.strftime('%H:%M:%S')}] {msg}\n"); sys.stderr.flush()


def read_token():
    with open(TG_ENV) as f:
        for line in f:
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("TELEGRAM_BOT_TOKEN not found in telegram .env")


def read_dash_token():
    try:
        with open(DASH_TOKEN_FILE) as f:
            return f.read().strip()
    except OSError:
        return None


def allowed_chats():
    ids = {PETI_CHAT_ID}
    try:
        with open(ACCESS_JSON) as f:
            a = json.load(f)
        ids.update(str(x) for x in a.get("allowFrom", []))
    except OSError:
        pass
    return ids


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"phase": "healthy", "offset": 0, "banner_streak": 0, "notified_outage": False}


def save_state(s):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
    os.replace(tmp, STATE_FILE)


def tg_api(token, method, params=None, timeout=35):
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = urllib.parse.urlencode(params or {}).encode()
    req = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"ok": False, "error_code": e.code, "description": str(e)}
    except Exception as e:
        return {"ok": False, "description": str(e)}


def send(token, chat_id, text):
    # Telegram hard cap 4096; keep margin
    for i in range(0, len(text), 3900):
        tg_api(token, "sendMessage", {"chat_id": chat_id, "text": text[i:i+3900]})


def mikrob_banner_present():
    """True if the mikrob-channels pane currently shows a usage-limit banner."""
    try:
        out = subprocess.run(
            ["tmux", "capture-pane", "-t", MIKROB_PANE, "-p", "-S", "-40"],
            capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return False
    return bool(LIMIT_RE.search(out))


def mikrob_heartbeat_stale():
    """True if MikroB has not touched its heartbeat recently (genuinely frozen)."""
    try:
        age = time.time() - os.path.getmtime(HEARTBEAT_FILE)
    except OSError:
        return True   # no heartbeat file yet -> treat as unknown/stale
    return age > HEARTBEAT_STALE_SEC


def mikrob_down():
    """MikroB is DOWN only if it shows the limit banner AND its heartbeat is stale.
    Requiring BOTH avoids the stale-modal trap: a stuck-but-old modal while MikroB
    is actually alive keeps a FRESH heartbeat, so the bridge stays dormant."""
    return mikrob_banner_present() and mikrob_heartbeat_stale()


def kill_pid_holder():
    """SIGTERM whoever currently holds the getUpdates slot (plugin's bun poller)."""
    try:
        with open(BOT_PID_FILE) as f:
            pid = int(f.read().strip())
        if pid > 1 and pid != os.getpid():
            os.kill(pid, signal.SIGTERM)
            log(f"SIGTERM sent to stale getUpdates holder pid={pid}")
            time.sleep(2)
    except (OSError, ValueError):
        pass
    try:
        with open(BOT_PID_FILE, "w") as f:
            f.write(str(os.getpid()))
    except OSError:
        pass


def rag_context(query, limit=5):
    """Pull relevant memories from the dashboard (stays up during a Claude outage)."""
    tok = read_dash_token()
    if not tok:
        return ""

    def fetch(qstr):
        url = f"{DASH}/api/memories?agent=mikrob"
        if qstr:
            url += "&q=" + urllib.parse.quote(qstr)
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.load(r)
        except Exception:
            return []
        return data if isinstance(data, list) else data.get("memories", data.get("data", []))

    # keyword search on cleaned tokens; fall back to recent memories if nothing matches
    words = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 3]
    mems = fetch(" ".join(words[:12])) if words else []
    if not mems:
        mems = fetch("")
    lines = []
    for m in mems[:limit]:
        c = (m.get("content") or "").strip().replace("\n", " ")
        if c:
            lines.append(f"- {c[:300]}")
    return "\n".join(lines)


def strip_thinking(text):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S | re.I)
    # Ornith often emits reasoning with only a CLOSING </think> (no opening tag);
    # keep everything after the last </think>.
    low = text.lower()
    if "</think>" in low:
        text = text[low.rfind("</think>") + len("</think>"):]
    # Or a "Thinking Process:" block then the answer; keep the tail.
    if "Thinking Process:" in text:
        parts = re.split(r"\n\s*\n", text.split("Thinking Process:", 1)[1])
        text = parts[-1] if len(parts) > 1 else text.replace("Thinking Process:", "")
    return text.strip()


def ask_local(query):
    ctx = rag_context(query)
    system = (
        "/no_think\n"
        "You are MikroB Ghost, the local emergency backup of MikroB. The real MikroB "
        "(running on Claude) has hit its usage limit and cannot answer, so you -- a local "
        "9B model -- are temporarily standing in. Answer concisely in Hungarian (proper "
        "accents). Be honest that you are Ghost (the local backup) and cannot do real "
        "orchestration, coding, or gates; you can give status, basic answers, and relay "
        "that the real MikroB returns after the quota reset and will re-check everything. "
        "Do NOT invent facts. Answer directly, no reasoning steps.\n\n"
        f"Relevant memory context about Peti/the project:\n{ctx or '(none retrieved)'}"
    )
    try:
        out = subprocess.run(
            [LOCAL_LLM, "--model", QUALITY_MODEL, "--system", system, query],
            capture_output=True, text=True, timeout=180)
        ans = strip_thinking(out.stdout.strip())
        return ans or "Vészmódban vagyok (lokális modell), de üres választ kaptam. A valódi MikroB a kvóta-reset után visszatér."
    except Exception as e:
        log(f"local model error: {e}")
        return "Vészmódban vagyok, de a lokális modell épp nem elérhető. A valódi MikroB a kvóta-reset után visszatér."


def outage_loop(token, state):
    """Own getUpdates and answer with the local model until MikroB recovers."""
    chats = allowed_chats()
    if not state.get("notified_outage"):
        send(token, PETI_CHAT_ID,
             "👻 MikroB Ghost jelentkezik. A valódi MikroB elérte a Claude kvótát és nem "
             "tud válaszolni, ezért ÁTÁLLTAM vészmódba: egy lokális modell (Qwen2.5-Coder-7B) "
             "válaszol korlátozottan, a memóriád releváns kontextusával. A valódi MikroB a "
             "kvóta-reset után automatikusan visszaveszi a vonalat, és MINDENT ellenőriz, "
             "amit Ghost módban csináltam.")
        state["notified_outage"] = True
        save_state(state)
    while True:
        # recovery check: MikroB alive again (banner gone or heartbeat fresh) -> hand back
        if not mikrob_down():
            log("MikroB recovered -> relinquishing channel")
            send(token, PETI_CHAT_ID,
                 "✅ A valódi MikroB visszatért (kvóta feloldva), MikroB Ghost visszavonul. "
                 "Most átnézem, amit Ghost módban megoldottunk, és a normál gate-eken átvezetem.")
            state["phase"] = "healthy"; state["banner_streak"] = 0; state["notified_outage"] = False
            save_state(state)
            return
        res = tg_api(token, "getUpdates",
                     {"offset": state["offset"], "timeout": GETUPDATES_TIMEOUT,
                      "allowed_updates": json.dumps(["message"])},
                     timeout=GETUPDATES_TIMEOUT + 10)
        if not res.get("ok"):
            if res.get("error_code") == 409:
                log("409 conflict -> re-claiming getUpdates slot"); kill_pid_holder(); time.sleep(2)
            else:
                time.sleep(3)
            continue
        for upd in res.get("result", []):
            state["offset"] = upd["update_id"] + 1
            msg = upd.get("message") or {}
            chat_id = str((msg.get("chat") or {}).get("id", ""))
            text = msg.get("text") or msg.get("caption") or ""
            if chat_id in chats and text.strip():
                log(f"answering degraded msg from {chat_id}: {text[:60]!r}")
                ans = ask_local(text)
                send(token, chat_id, f"👻 MikroB Ghost (lokális Qwen2.5-Coder-7B):\n{ans}")
        save_state(state)


def main():
    force = "--force-outage" in sys.argv
    test = "--test" in sys.argv
    token = read_token()

    if test:
        q = "Mi a helyzet a projekttel? Mikor jossz vissza?"
        print("RAG context:\n", rag_context(q), "\n---\nLocal answer:\n", ask_local(q))
        return

    state = load_state()
    log(f"quota-bridge started (phase={state['phase']})")
    while True:
        if force or mikrob_down():
            state["banner_streak"] = state.get("banner_streak", 0) + 1
            if state["banner_streak"] >= CONFIRM_CHECKS or force:
                if state["phase"] != "outage":
                    log("OUTAGE confirmed -> taking over channel")
                    state["phase"] = "outage"; save_state(state)
                    kill_pid_holder()
                outage_loop(token, state)   # returns when recovered
                if force:
                    return
            else:
                save_state(state); time.sleep(POLL_HEALTHY_SEC)
        else:
            if state.get("banner_streak"):
                state["banner_streak"] = 0; save_state(state)
            time.sleep(POLL_HEALTHY_SEC)


if __name__ == "__main__":
    main()

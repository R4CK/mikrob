#!/usr/bin/env python3
"""EMAILKAPU901 PR2: the email_send level becomes a real switch on the main agent.

Branches proven (Marveen msgs 17900/17936):
  - level 1: the send is DENIED outright.
  - level 2: denied without approval; ALLOWED against an approved, matching,
    in-window approval; the SAME send a SECOND time is denied again (one-shot
    consumption -- the feature's built-in mutation control); an expired window
    denies; a pending approval denies with its id.
  - level 3: allowed.
  - four-field anchor: an approval for the SAME subject+body but a DIFFERENT
    recipient does NOT authorize the send.
  - FAIL-CLOSED, proven separately from the happy path: missing approvals DB,
    missing/corrupt autonomy-config, unreadable letter ($VAR body), and a
    recipient that cannot be extracted all DENY (exit 2, never 1).
  - HOOKDEPLOAD1008: a dependency that does not load (email_extract.py,
    outgoing-copy-gate.py) or a malformed EMAIL_APPROVAL_WINDOW_S DENIES the
    send with exit 2 (never 1), measured on a disposable copy of the hooks.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import re
import hashlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import tokenize
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
GATE = os.path.join(HOOKS, "email-approval-gate.py")
WINDOW = 1800
# Same portability constraint as the gate: this file drives the gate through
# the HOST's python3, so its own fixtures must not need SQLite 3.38 either.
NOW_S = "CAST(strftime('%s','now') AS INTEGER)"

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_store(td, level=2, max_level=None, config="ok"):
    store = os.path.join(td, "store")
    os.makedirs(store, exist_ok=True)
    cfg_path = os.path.join(store, "autonomy-config.json")
    if config == "ok":
        cat = {"key": "email_send", "label": "Email", "level": level, "locked": False}
        if max_level is not None:
            cat["maxLevel"] = max_level
        with open(cfg_path, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "categories": [cat]}, fh)
    elif config == "corrupt":
        with open(cfg_path, "w", encoding="utf-8") as fh:
            fh.write("{not json")
    # config == "missing": write nothing
    db_path = os.path.join(store, "claudeclaw.db")
    con = sqlite3.connect(db_path)
    con.execute("""
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, category TEXT NOT NULL,
        action_description TEXT NOT NULL, action_payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        timeout_at INTEGER, telegram_message_id INTEGER,
        requested_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
        resolved_at INTEGER, resolved_by TEXT,
        content_hash TEXT, consumed_at INTEGER)""")
    con.commit()
    con.close()
    return store


def write_standing(store, value):
    """value: a Python object dumped as JSON, or a raw string written verbatim
    (for the corrupt-file case)."""
    path = os.path.join(store, "email-standing-recipients.json")
    with open(path, "w", encoding="utf-8") as fh:
        if isinstance(value, str):
            fh.write(value)
        else:
            json.dump(value, fh)
    return path


def make_daily_log_stub(received):
    """A minimal /api/daily-log endpoint. Records (parsed body, Authorization)
    so the test can assert WHAT reached the owner's log, not merely that
    something did."""
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 -- BaseHTTPRequestHandler's contract
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n).decode("utf-8")
            try:
                body = json.loads(raw)
            except Exception:
                body = {"_unparseable": raw}
            received.append((body, self.headers.get("Authorization")))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

        def log_message(self, *a):  # keep the test output clean
            pass
    return Handler


def run_gate(store, payload, extra_env=None, gate=GATE):
    env = dict(os.environ,
               EMAIL_APPROVAL_GATE_STORE=store,
               EMAIL_APPROVAL_WINDOW_S=str(WINDOW),
               OUTGOING_COPY_GATE_RULES=os.path.join(store, "no-rules.json"))
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run([sys.executable, gate], input=json.dumps(payload).encode(),
                          capture_output=True, env=env)
    return proc.returncode, proc.stdout.decode(), proc.stderr.decode()


def mcp_send(to="a@b.hu", cc=None, subject="Teszt tárgy", body="Kedves Ügyfelünk! Törzs."):
    ti = {"to": [to], "subject": subject, "body": body}
    if cc:
        ti["cc"] = [cc]
    return {"tool_name": "mcp__server-gmail-autoauth-mcp__send_email", "tool_input": ti}


def approve(store, anchor, resolved_ago=0, status="approved", consumed=None):
    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
    con.execute(
        "INSERT INTO approvals (id, agent_id, category, action_description, status,"
        " requested_at, resolved_at, resolved_by, content_hash, consumed_at)"
        " VALUES (hex(randomblob(6)), 'marveen', 'email_send', 'Email teszt', ?,"
        f" {NOW_S}-?-60, CASE WHEN ?='pending' THEN NULL ELSE {NOW_S}-? END,"
        " 'szabi', ?, ?)",
        (status, resolved_ago, status, resolved_ago, anchor, consumed))
    con.commit()
    con.close()


def activate_standing(store, addr, status="approved", resolved_ago=0):
    """Az elesites: egy MAR LEZART email_standing_recipient sor a cimre.
    A `resolved_ago` a sorrendhez kell (az utolso dontes nyer)."""
    anchor = hashlib.sha256(addr.strip().lower().encode("utf-8")).hexdigest()
    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
    con.execute(
        "INSERT INTO approvals (id, agent_id, category, action_description, status,"
        " requested_at, resolved_at, resolved_by, content_hash, consumed_at)"
        " VALUES (hex(randomblob(6)), 'marveen', 'email_standing_recipient',"
        f" 'Allando cimzett elesitese', ?, {NOW_S}-?-60,"
        f" CASE WHEN ?='pending' THEN NULL ELSE {NOW_S}-? END, 'szabi', ?, NULL)",
        (status, resolved_ago, status, resolved_ago, anchor))
    con.commit()
    con.close()
    return anchor


def anchor_from_stderr(err):
    m = re.search(r"\b([0-9a-f]{64})\b", err)
    return m.group(1) if m else None


with tempfile.TemporaryDirectory() as td:
    # --- scope: what the gate must NOT touch --------------------------------
    store = make_store(os.path.join(td, "s0"), level=1)
    code, _, _ = run_gate(store, {"tool_name": "Bash", "tool_input": {"command": "ls -la"}})
    check("non-send Bash passes untouched even at level 1", code == 0, f"exit={code}")
    code, _, _ = run_gate(store, {"tool_name": "Read", "tool_input": {"file_path": "/x"}})
    check("non-email tool passes untouched", code == 0, f"exit={code}")

    # --- level 1: hard deny --------------------------------------------------
    code, _, err = run_gate(store, mcp_send())
    check("level 1: MCP send DENIED", code == 2 and "szint 1" in err, f"exit={code}")
    code, _, err = run_gate(store, {"tool_name": "mcp__x__manage_email",
                                    "tool_input": {"action": "send", "to": ["a@b.hu"], "body": "x"}})
    check("level 1: manage_email DENIED too (2026-08-10 bypass class)", code == 2, f"exit={code}")

    # --- level 3: allow ------------------------------------------------------
    store = make_store(os.path.join(td, "s3"), level=3)
    code, _, _ = run_gate(store, mcp_send())
    check("level 3: MCP send allowed", code == 0, f"exit={code}")

    # --- level 2: the approval loop -----------------------------------------
    store = make_store(os.path.join(td, "s2"), level=2)
    payload = mcp_send()
    code, _, err = run_gate(store, payload)
    anchor = anchor_from_stderr(err)
    check("level 2 without approval: DENIED and the deny carries the sha256 anchor",
          code == 2 and "NINCS jovahagyas" in err and anchor is not None, f"exit={code} err={err[:150]!r}")
    check("deny message is actionable (POST /api/approvals + resend instructions)",
          "api/approvals" in err and "content_hash" in err and "a@b.hu" in err)

    approve(store, anchor)
    code, out, _ = run_gate(store, payload)
    check("level 2 with approved+matching+in-window approval: ALLOWED",
          code == 0 and "felhasznalva" in out, f"exit={code} out={out[:120]!r}")

    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
    consumed = con.execute("SELECT consumed_at FROM approvals WHERE content_hash=?", (anchor,)).fetchone()[0]
    con.close()
    check("the allow CONSUMED the approval (consumed_at set in the DB)", consumed is not None)

    code, _, err = run_gate(store, payload)
    check("the SAME send a SECOND time: DENIED (one-shot)",
          code == 2 and "FEL LETT HASZNALVA" in err, f"exit={code}")

    # window expiry: a different letter, approved too long ago
    payload_b = mcp_send(subject="Masik tárgy")
    _, _, err = run_gate(store, payload_b)
    anchor_b = anchor_from_stderr(err)
    approve(store, anchor_b, resolved_ago=WINDOW + 60)
    code, _, err = run_gate(store, payload_b)
    check("approval outside the time window: DENIED as expired",
          code == 2 and "IDOABLAKA lejart" in err, f"exit={code} err={err[:150]!r}")

    # pending approval names itself
    payload_c = mcp_send(subject="Harmadik tárgy")
    _, _, err = run_gate(store, payload_c)
    anchor_c = anchor_from_stderr(err)
    approve(store, anchor_c, status="pending")
    code, _, err = run_gate(store, payload_c)
    check("pending approval: DENIED with 'meg fuggoben'",
          code == 2 and "FUGGOBEN" in err, f"exit={code}")

    # --- the four-field anchor: recipient is part of the identity ------------
    payload_d = mcp_send(subject="Negyedik tárgy", body="Ugyanaz a törzs.")
    _, _, err = run_gate(store, payload_d)
    approve(store, anchor_from_stderr(err))
    hijacked = mcp_send(to="evil@x.hu", subject="Negyedik tárgy", body="Ugyanaz a törzs.")
    code, _, err = run_gate(store, hijacked)
    check("approved subject+body to a DIFFERENT recipient: DENIED (anchor covers to)",
          code == 2 and "NINCS jovahagyas" in err, f"exit={code}")
    cc_flip = mcp_send(cc="cc@x.hu", subject="Negyedik tárgy", body="Ugyanaz a törzs.")
    code, _, _ = run_gate(store, cc_flip)
    check("same letter with an ADDED cc: DENIED (anchor covers cc)", code == 2)

    # --- maxLevel clamps -----------------------------------------------------
    store = make_store(os.path.join(td, "sclamp"), level=3, max_level=2)
    code, _, err = run_gate(store, mcp_send())
    check("level 3 clamped by maxLevel 2: behaves as level 2 (deny w/o approval)",
          code == 2 and "level 2" in err, f"exit={code}")

    # --- Bash path end-to-end at level 2 ------------------------------------
    store = make_store(os.path.join(td, "sbash"), level=2)
    bash_payload = {"tool_name": "Bash", "tool_input": {
        "command": 'sendmail --to a@b.hu --subject "Bash tárgy" --body "Bash törzs."'}}
    code, _, err = run_gate(store, bash_payload)
    b_anchor = anchor_from_stderr(err)
    check("level 2 Bash send without approval: DENIED with anchor",
          code == 2 and b_anchor is not None, f"exit={code} err={err[:150]!r}")
    approve(store, b_anchor)
    code, _, _ = run_gate(store, bash_payload)
    check("level 2 Bash send with approval: ALLOWED", code == 0, f"exit={code}")

    # --- FIFOTIMEOUT924: a FIFO as the body must FAIL FAST, never hang past the
    # hook's timeout (card 0dab76a3, Cybered C1 HIGH on 087e4418). A timed-out
    # PreToolUse hook does NOT block the tool call (Claude Code's own docs), so
    # a body-file read that blocks on a FIFO with no writer is a gate bypass,
    # not merely a slow test. Each shape here is run with an explicit short
    # subprocess timeout well under the hook's real 10s budget: if the fix
    # regresses, this FAILS FAST with a clear message instead of silently
    # eating the wrapper's 120s budget.
    def run_gate_fast(store, payload, timeout_s=3):
        env = dict(os.environ, EMAIL_APPROVAL_GATE_STORE=store,
                   EMAIL_APPROVAL_WINDOW_S=str(WINDOW),
                   OUTGOING_COPY_GATE_RULES=os.path.join(store, "no-rules.json"))
        t0 = time.monotonic()
        try:
            proc = subprocess.run([sys.executable, GATE], input=json.dumps(payload).encode(),
                                  capture_output=True, env=env, timeout=timeout_s)
        except subprocess.TimeoutExpired:
            return (None, time.monotonic() - t0, "", "")
        return (proc.returncode, time.monotonic() - t0, proc.stdout.decode(), proc.stderr.decode())

    store = make_store(os.path.join(td, "sfifo"), level=2)
    fifo_dir = os.path.join(td, "fifo-bodies")
    os.makedirs(fifo_dir, exist_ok=True)

    def mkfifo_at(name):
        path = os.path.join(fifo_dir, name)
        os.mkfifo(path)  # no writer ever opens it -- that is the point
        return path

    # The 4 GATEBINVAK916 shapes RedHat measured, plus the pre-existing `<` redirect.
    fifo_cases = [
        ("curl -d @fifo", lambda p: f'curl -s https://api.resend.com/emails -H "X-Dummy: 1" -d @{p}'),
        ("curl -F body=<fifo", lambda p: f'curl -s https://api.resend.com/emails -F body=<{p}'),
        ("wget --post-file=fifo", lambda p: f'wget -q https://api.resend.com/emails --post-file={p}'),
        ("curl -T fifo", lambda p: f'curl -s -T {p} https://api.resend.com/emails'),
        ("sendmail < fifo (pre-existing shape)", lambda p: f'sendmail a@b.hu < {p}'),
    ]
    for label, build_cmd in fifo_cases:
        fifo_path = mkfifo_at(f"{abs(hash(label))}.fifo")
        code, elapsed, _, err = run_gate_fast(store, {"tool_name": "Bash", "tool_input": {"command": build_cmd(fifo_path)}})
        check(f"FIFO body ({label}): denied fast, not hung past the real 10s hook timeout",
              code == 2 and elapsed < 3, f"exit={code} elapsed={elapsed:.2f}s err={err[:150]!r}")

    # TOCTOU924 (card 14256aac, Cybersec NO-GO F2 on e8b479d0, MikroB decision): a FILE
    # body is NEVER anchored by this gate any more, regular file or not -- the hook reads
    # it at approval time, the actual send reads it again later, and a file swapped in
    # between would be approved under one letter's anchor while a different one goes out.
    # So a REGULAR @file body must be denied as unreadable (no anchor to even approve),
    # same as a FIFO -- and no approval can ever make it ALLOWED, only an inline --body can.
    ok_path = os.path.join(fifo_dir, "ok.txt")
    with open(ok_path, "w", encoding="utf-8") as fh:
        fh.write('{"subject": "regular file body", "text": "Rendes level."}')
    # --to is on the command line (collect_bash_recipients reads it there, not from
    # the JSON body) -- the body file supplies subject+text, same as RedHat's repro.
    ok_payload = {"tool_name": "Bash", "tool_input": {
        "command": f'curl -s https://api.resend.com/emails --to a@b.hu -d @{ok_path}'}}
    code, elapsed, _, err = run_gate_fast(store, ok_payload)
    check("a regular @file body is denied as UNREADABLE too (no anchor given) -- not merely 'needs approval'",
          code == 2 and anchor_from_stderr(err) is None and "fajlbol jon" in err and elapsed < 3,
          f"exit={code} elapsed={elapsed:.2f}s err={err[:200]!r}")

    # Even an approval recorded against the file's OWN content (what an attacker could get
    # approved by first putting the clean letter in the file, then swapping it before the
    # send) does not help: there is no anchor path through a file body at all, approved or
    # not. Uses the gate's own content_anchor() (imported directly, not reimplemented here)
    # so the anchor is the real one, not a guessed format.
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location("email_approval_gate_anchor_helper", GATE)
    _gate_mod = _ilu.module_from_spec(_spec)
    import sys as _sys
    _sys.modules[_spec.name] = _gate_mod
    _spec.loader.exec_module(_gate_mod)
    fake_anchor = _gate_mod.content_anchor({"to": ["a@b.hu"], "cc": [], "bcc": [],
                                            "text": "regular file body\nRendes level."})
    approve(store, fake_anchor)
    code, elapsed, _, _ = run_gate_fast(store, ok_payload)
    check("...and pre-approving the file's own content anchor still does not allow it through",
          code == 2 and elapsed < 3, f"exit={code} elapsed={elapsed:.2f}s")

    # Positive control: a DIFFERENT letter (distinct content, so its anchor cannot collide
    # with the fake_anchor approved above) sent inline (--body, not a file) still goes
    # through the normal approval loop -- the fix narrows the file-body path, not the gate.
    # sendmail, not curl: curl has no real --to/--subject/--body flags, so a curl command
    # built that way is not recognised as a send at all (is_send_invocation needs either a
    # real mail-vendor invocation or a data flag) -- the SAME shape as the already-proven
    # bash_payload case above, just distinct content.
    inline_payload = {"tool_name": "Bash", "tool_input": {
        "command": 'sendmail --to a@b.hu --subject "inline control letter" --body "Ez egy mas level."'}}
    code, elapsed, _, err = run_gate_fast(store, inline_payload)
    inline_anchor = anchor_from_stderr(err)
    check("control: the same letter sent INLINE still gets a real anchor and is denied-pending-approval",
          code == 2 and inline_anchor is not None, f"exit={code} err={err[:200]!r}")
    approve(store, inline_anchor)
    code, elapsed, _, _ = run_gate_fast(store, inline_payload)
    check("control: ...and ALLOWED once approved, proving the gate itself still works end-to-end",
          code == 0 and elapsed < 3, f"exit={code} elapsed={elapsed:.2f}s")

    # --- FAIL-CLOSED, each branch separately --------------------------------
    store = make_store(os.path.join(td, "sf1"), level=2)
    os.remove(os.path.join(store, "claudeclaw.db"))
    code, _, err = run_gate(store, mcp_send())
    check("fail-closed: approvals DB missing -> DENIED (undecidable != allowed)",
          code == 2 and "nem-eldontheto" in err, f"exit={code}")

    store = make_store(os.path.join(td, "sf2"), config="missing")
    code, _, err = run_gate(store, mcp_send())
    check("fail-closed: autonomy-config missing -> level 2 path, DENIED w/o approval",
          code == 2 and "fail-closed" in err, f"exit={code}")

    store = make_store(os.path.join(td, "sf3"), config="corrupt")
    code, _, err = run_gate(store, mcp_send())
    check("fail-closed: autonomy-config corrupt -> level 2 path, DENIED",
          code == 2, f"exit={code}")

    store = make_store(os.path.join(td, "sf4"), level=2)
    code, _, err = run_gate(store, {"tool_name": "Bash", "tool_input": {
        "command": 'sendmail --to a@b.hu --body "$LETTER"'}})
    check("fail-closed: $VAR body at level 2 -> DENIED as unanchorable",
          code == 2 and "horgonyozhato" in err, f"exit={code}")

    code, _, err = run_gate(store, {"tool_name": "mcp__x__send_email",
                                    "tool_input": {"subject": "t", "body": "b"}})
    check("fail-closed: no extractable recipient -> DENIED",
          code == 2 and "cimzett" in err, f"exit={code}")

    code, _, err = run_gate(store, {"tool_name": "mcp__x__send_email", "tool_input": "not-a-dict"})
    check("fail-closed: non-dict tool_input -> DENIED (exit 2, never 1)",
          code == 2, f"exit={code}")

    # Marveen's #1149 review: this gate AUTHORIZES, so unlike the copy gate it
    # must fail closed on an unparseable payload too -- the docstring and the
    # code now state the same contract.
    env = dict(os.environ, EMAIL_APPROVAL_GATE_STORE=store,
               OUTGOING_COPY_GATE_RULES=os.path.join(store, "no-rules.json"))
    proc = subprocess.run([sys.executable, GATE], input=b"this is not json",
                          capture_output=True, env=env)
    check("fail-closed: unparseable stdin -> DENIED (exit 2, never 0/1)",
          proc.returncode == 2, f"exit={proc.returncode}")

    # --- EMAILBCCHORGONY903: bcc is part of the anchor -----------------------
    # The gap this pins closed: with a to+cc+text anchor, an approved letter
    # could be re-sent with an ADDED bcc -- identical hash, the approval was
    # consumed, and a recipient nobody approved got the letter. Both send
    # paths are covered, plus the backward-compat golden below.
    store = make_store(os.path.join(td, "bcc-mcp"))
    _, _, err = run_gate(store, mcp_send())          # harvest the letter's anchor
    bccless_anchor = anchor_from_stderr(err)
    approve(store, bccless_anchor)
    bcc_payload = mcp_send()
    bcc_payload["tool_input"]["bcc"] = ["rejtett@idegen.example"]
    code, _, _ = run_gate(store, bcc_payload)
    check("bcc/MCP: approved bcc-less letter re-sent WITH bcc -> DENIED",
          code == 2, f"exit={code}")
    code, _, _ = run_gate(store, mcp_send())
    check("bcc/MCP: the bcc-less letter itself still sends on that approval",
          code == 0, f"exit={code}")

    store = make_store(os.path.join(td, "bcc-bash"))
    bash_cmd = ('python3 scripts/send.py --to "a@b.hu" --subject "Teszt tárgy" '
                '--body "Kedves Ügyfelünk! Törzs."')
    _, _, err = run_gate(store, {"tool_name": "Bash", "tool_input": {"command": bash_cmd}})
    approve(store, anchor_from_stderr(err))
    code, _, _ = run_gate(store, {"tool_name": "Bash",
                                  "tool_input": {"command": bash_cmd + ' --bcc "rejtett@idegen.example"'}})
    check("bcc/Bash: approved bcc-less command re-sent WITH --bcc -> DENIED",
          code == 2, f"exit={code}")
    code, _, _ = run_gate(store, {"tool_name": "Bash", "tool_input": {"command": bash_cmd}})
    check("bcc/Bash: the bcc-less command itself still sends on that approval",
          code == 0, f"exit={code}")

    # --- card e4eb72c9: attachments are part of the anchor ------------------
    # The gap: an approved letter (to/cc/bcc/text matched) could be re-sent
    # with ANY local file attached, because the anchor never covered the
    # attachments field at all. Fixed the same conditional way as bcc.
    # Each variant gets its OWN store+approval so a check cannot pass merely
    # because the one-shot approval was already consumed by an earlier call
    # in this block -- the approval below stays UNCONSUMED while the wrong
    # variant is tried, so a DENY here can only come from the anchor itself.
    store = make_store(os.path.join(td, "att-mcp"))
    attachment_payload = mcp_send(subject="Melleklet")
    attachment_payload["tool_input"]["attachments"] = [{"filename": "a.txt", "content": "QQ=="}]
    _, _, err = run_gate(store, attachment_payload)
    att_anchor = anchor_from_stderr(err)
    approve(store, att_anchor)

    swapped = mcp_send(subject="Melleklet")
    swapped["tool_input"]["attachments"] = [{"filename": "a.txt", "content": "Qg=="}]
    code, _, _ = run_gate(store, swapped)
    check("attachments/MCP: SAME letter but a DIFFERENT attachment content -> DENIED "
          "(approval for the ORIGINAL attachment is still unconsumed)",
          code == 2, f"exit={code}")

    no_attachment = mcp_send(subject="Melleklet")
    code, _, _ = run_gate(store, no_attachment)
    check("attachments/MCP: SAME letter with the attachment REMOVED -> DENIED "
          "(anchor covers attachments; approval still unconsumed)",
          code == 2, f"exit={code}")

    code, _, _ = run_gate(store, attachment_payload)
    check("attachments/MCP: the ORIGINAL approved letter with its exact attachment still sends",
          code == 0, f"exit={code}")

    # F3 (WhiteHat2, card e4eb72c9 go-live condition on a2cb71f1, TOCTOU
    # closure): a file-path attachment is now REJECTED fail-closed rather than
    # read-and-hashed -- a second read of the same path after approval would
    # be a TOCTOU window (approve bytes-A, swap to bytes-B, resend still
    # anchors because the hash is recomputed from whatever is on disk NOW).
    # Absolute-path attachments must therefore never reach an approvable
    # anchor at all; only strict base64 content can be approved and sent.
    store_path = make_store(os.path.join(td, "att-path"))
    att_dir = os.path.join(td, "att-files")
    os.makedirs(att_dir, exist_ok=True)
    att_path = os.path.join(att_dir, "report.pdf")
    with open(att_path, "wb") as fh:
        fh.write(b"version-1")
    path_payload = mcp_send(subject="Fajl-melleklet")
    path_payload["tool_input"]["attachments"] = [{"filename": "report.pdf", "content": att_path}]
    code, _, err = run_gate(store_path, path_payload)
    check("attachments/path: absolute-path attachment is DENIED fail-closed, no anchor to approve (F3 TOCTOU closure)",
          code == 2 and anchor_from_stderr(err) is None, f"exit={code} err={err[:200]!r}")

    with open(att_path, "wb") as fh:
        fh.write(b"version-2-swapped")
    code, _, err = run_gate(store_path, path_payload)
    check("attachments/path: still DENIED after swapping the file's bytes (no TOCTOU window left to exploit)",
          code == 2 and anchor_from_stderr(err) is None, f"exit={code} err={err[:200]!r}")

    # An unreadable attachment file fails closed, same as every other
    # unreadable-letter branch (no anchor to even approve).
    store_bad = make_store(os.path.join(td, "att-missing"))
    bad_payload = mcp_send(subject="Hianyzo melleklet")
    bad_payload["tool_input"]["attachments"] = [
        {"filename": "gone.pdf", "content": os.path.join(att_dir, "does-not-exist.pdf")}]
    code, _, err = run_gate(store_bad, bad_payload)
    check("attachments/path: unreadable attachment file -> DENIED, unreadable (no anchor)",
          code == 2 and anchor_from_stderr(err) is None, f"exit={code} err={err[:200]!r}")

    # Backward-compat golden: an attachment-less anchor stays byte-identical
    # to the pre-attachments value -- open approvals recorded before this fix
    # must still match the letters they approved.
    _, _, err = run_gate(store, mcp_send())
    check("attachments/golden: an attachment-less anchor is unchanged by this fix",
          anchor_from_stderr(err) == bccless_anchor, f"got {anchor_from_stderr(err)!r}")

    # --- card a2cb71f1 H1 (RedHat NO-GO, komment 20438): inlineImages are part of the anchor ---
    # The gap: an approved send_email letter could be re-sent with a DIFFERENT inlineImages
    # payload, because the anchor never covered that field at all (content_anchor only read
    # to/cc/bcc/text/attachments). Fixed the same conditional way as attachments/bcc.
    store = make_store(os.path.join(td, "img-mcp"))
    image_payload = mcp_send(subject="Inline kep")
    image_payload["tool_input"]["inlineImages"] = [{"cid": "img1", "content": "QQ==", "filename": "a.png"}]
    _, _, err = run_gate(store, image_payload)
    img_anchor = anchor_from_stderr(err)
    approve(store, img_anchor)

    swapped_img = mcp_send(subject="Inline kep")
    swapped_img["tool_input"]["inlineImages"] = [{"cid": "img1", "content": "Qg==", "filename": "a.png"}]
    code, _, _ = run_gate(store, swapped_img)
    check("inlineImages/MCP: SAME letter but a DIFFERENT inline image content -> DENIED "
          "(approval for the ORIGINAL image is still unconsumed)",
          code == 2, f"exit={code}")

    no_image = mcp_send(subject="Inline kep")
    code, _, _ = run_gate(store, no_image)
    check("inlineImages/MCP: SAME letter with the inline image REMOVED -> DENIED "
          "(anchor covers inlineImages; approval still unconsumed)",
          code == 2, f"exit={code}")

    code, _, _ = run_gate(store, image_payload)
    check("inlineImages/MCP: the ORIGINAL approved letter with its exact inline image still sends",
          code == 0, f"exit={code}")

    # H1 reproduction: a `path`-shaped inlineImages entry is REJECTED fail-closed, never
    # read-and-hashed -- same TOCTOU rationale as the attachments F3 closure. Before this fix,
    # the field was not read AT ALL, so this payload would have anchored identically to the
    # path-less letter above and sent on that approval.
    store_path = make_store(os.path.join(td, "img-path"))
    img_path_payload = mcp_send(subject="Fajl-kep")
    img_path_payload["tool_input"]["inlineImages"] = [{"cid": "img1", "path": "/etc/passwd"}]
    code, _, err = run_gate(store_path, img_path_payload)
    check("inlineImages/path: a `path` entry is DENIED fail-closed, no anchor to approve (H1 TOCTOU closure)",
          code == 2 and anchor_from_stderr(err) is None, f"exit={code} err={err[:200]!r}")

    # Backward-compat golden: an inline-image-less anchor stays byte-identical to the
    # pre-inlineImages value -- open approvals recorded before this fix must still match.
    _, _, err = run_gate(store, mcp_send())
    check("inlineImages/golden: an inlineImages-less anchor is unchanged by this fix",
          anchor_from_stderr(err) == bccless_anchor, f"got {anchor_from_stderr(err)!r}")

    # Backward-compat golden: the bcc-less canon is BYTE-STABLE across the bcc
    # fix (bcc joins the hash ONLY when non-empty), so approvals recorded
    # before the change stay valid for the letters they approved. If this hash
    # ever changes, EVERY open approval silently invalidates -- that must be a
    # loud, deliberate decision failing here, never a side effect.
    check("bcc/golden: bcc-less anchor is byte-stable across the bcc fix",
          bccless_anchor == "de87bdb699dcab419b68811bb57b6fab44b34e2fe16bff11cf90b2a5848f82ec",
          f"got {bccless_anchor}")

    # EMAILHTMLHORGONY929 (upstream Köteg 17, 0e681c83..9845015f) was NOT ported: it
    # read and hashed a --html/--attach FILE at hook time on the Bash path, the same
    # TOCTOU exposure WhiteHat2's F2 finding (card e4eb72c9) already closed for Bash
    # --attach -- the real send reads the same path again in a later process, so the
    # file (or a symlink) is swappable in between the two reads. See the matching note
    # in scripts/hooks/email_extract.py and DECISIONS.md, Köteg 17 merge entry.

    # MANAGEOP904: manage_email is a MULTIPLEXER, not a send tool. Scoping the
    # gate on the tool NAME alone denied `operation=search` and
    # `operation=draft` at level 1 -- measured on a live install 2026-09-04,
    # where the draft-only workflow needs exactly those two. The level exists to
    # stop the SEND, so reading and drafting must pass and sending must not.
    store1 = make_store(td, level=1)

    def manage(op=None, **extra):
        ti = {"to": ["a@b.hu"], "subject": "T", "body": "Torzs."}
        if op is not None:
            ti["operation"] = op
        ti.update(extra)
        return {"tool_name": "mcp__google-workspace__manage_email", "tool_input": ti}

    for op in ("search", "read", "draft", "label", "list", "archive"):
        code, _, _ = run_gate(store1, manage(op))
        check(f"manage_email operation={op} passes at level 1 (not a send)", code == 0,
              f"exit={code}")
    for op in ("send", "reply", "reply_all", "replyAll", "forward", "SEND"):
        code, _, _ = run_gate(store1, manage(op))
        check(f"manage_email operation={op} is DENIED at level 1 (it is a send)",
              code == 2, f"exit={code}")
    # Fail-closed on doubt: no operation, or one we cannot read, counts as send.
    code, _, _ = run_gate(store1, manage(None))
    check("manage_email without an operation is DENIED (fail-closed)", code == 2,
          f"exit={code}")
    code, _, _ = run_gate(store1, {"tool_name": "mcp__google-workspace__manage_email",
                                   "tool_input": {"operation": 42}})
    check("manage_email with a non-string operation is DENIED (fail-closed)", code == 2,
          f"exit={code}")
    # MANAGEDRAFT905: a send OPERATION carrying an explicit draft:true is a
    # DRAFT, not a send -- `{"operation":"reply","draft":true}` is the only way
    # to write a threaded draft with this tool, and the sibling gate
    # (email-send-gate.mjs) lets exactly that shape through. Without this the
    # draft-only workflow was blocked at level 1 by its own guard.
    for op in ("send", "reply", "reply_all", "replyAll", "forward"):
        for flag in (True, "true"):
            code, _, _ = run_gate(store1, manage(op, draft=flag))
            check(f"manage_email operation={op} draft={flag!r} passes at level 1 (a draft is not a send)",
                  code == 0, f"exit={code}")
    # Fail-closed stays: anything but an explicit true is still a send.
    for flag in (False, "false", "yes", 1, None, "", "True "):
        code, _, _ = run_gate(store1, manage("reply", draft=flag))
        check(f"manage_email operation=reply draft={flag!r} is DENIED (not an explicit draft)",
              code == 2, f"exit={code}")
    # Control: the draft exemption is scoped to the multiplexer, not to the
    # dedicated send tool -- a draft flag must not buy send_email a pass.
    code, _, _ = run_gate(store1, {"tool_name": "mcp__x__send_email",
                                   "tool_input": {"to": ["a@b.hu"], "subject": "T",
                                                  "body": "Torzs.", "draft": True}})
    check("control: send_email with draft:true is still DENIED at level 1", code == 2,
          f"exit={code}")

    # Control: send_email has no operations and must stay gated unconditionally,
    # otherwise the scoping above could quietly exempt the real send tool too.
    code, _, _ = run_gate(store1, mcp_send())
    check("control: send_email is still DENIED at level 1", code == 2, f"exit={code}")
    # Control: the scoping is about the OPERATION, not about level 1 letting
    # things through -- at level 3 the same send passes, which proves the deny
    # above came from the level and not from a broken payload.
    cfg1 = os.path.join(store1, "autonomy-config.json")
    with open(cfg1, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "categories": [
            {"key": "email_send", "label": "Email", "level": 3, "locked": False}]}, fh)
    code, _, _ = run_gate(store1, manage("send"))
    check("control: manage_email operation=send passes at level 3", code == 0,
          f"exit={code}")

    # --- GMAILCONNECTOR914: the claude.ai Gmail connector -------------------
    # No send_email, no manage_email in the name: the gate exited 0 on every
    # connector send, so an unapproved send_message was never denied.
    def connector(tool, **ti):
        return {"tool_name": f"mcp__claude_ai_Gmail__{tool}", "tool_input": ti}
    store_l1 = make_store(os.path.join(td, "sconn1"), level=1)  # store1 was raised to level 3 above
    code, _, err = run_gate(store_l1, connector("send_message", to=["a@b.hu"], subject="T", body="x"))
    check("connector send_message is DENIED at level 1", code == 2 and "szint 1" in err, f"exit={code}")
    code, _, _ = run_gate(store_l1, connector("search_threads", q="x"))
    check("connector search_threads is a read: passes at level 1", code == 0, f"exit={code}")
    code, _, _ = run_gate(store_l1, connector("create_draft", to=["a@b.hu"], body="x"))
    check("connector create_draft is not a send: passes at level 1", code == 0, f"exit={code}")
    store_c = make_store(os.path.join(td, "sconn"), level=2)
    payload = connector("reply", messageId="msg-42", body="Kedves Ügyfelünk! Válasz.")
    code, _, err = run_gate(store_c, payload)
    anchor = anchor_from_stderr(err)
    check("connector reply at level 2 without approval: DENIED, anchored on messageId (no `to` field)",
          code == 2 and anchor is not None and "messageId:msg-42" in err, f"exit={code} err={err[:200]!r}")
    approve(store_c, anchor)
    code, out, _ = run_gate(store_c, payload)
    check("connector reply with a matching approval: ALLOWED", code == 0 and "felhasznalva" in out,
          f"exit={code} out={out[:120]!r}")
    code, _, err = run_gate(store_c, connector("reply", messageId="msg-43", body="Kedves Ügyfelünk! Válasz."))
    check("the same approval does not cover a reply to ANOTHER message", code == 2, f"exit={code}")

    # --- Card 498d53c1 (Cybersec MEDIUM on a4164e95): gmail__/resend__ deny-by-default ---
    # A tool-NAME list drifts -- send_draft (create_draft + send_draft pair) and the
    # hyphenated resend__send-email both slipped past name-list checks before this
    # existed. Only search_*/get_*/list_*/read_*/create_draft is explicitly out of
    # scope for the level-gate; everything else on either server is in scope now.
    code, _, err = run_gate(store_l1, connector("send_draft", draftId="d1"))
    check("connector send_draft: in scope, DENIED at level 1", code == 2 and "szint 1" in err, f"exit={code}")

    def resend(tool, **ti):
        return {"tool_name": f"mcp__resend__{tool}", "tool_input": ti}
    code, _, err = run_gate(store_l1, resend("send-email", to="a@b.hu", subject="T", text="x"))
    check("resend send-email: in scope, DENIED at level 1", code == 2 and "szint 1" in err, f"exit={code}")
    code, _, _ = run_gate(store_l1, resend("get-email", id="e1"))
    check("resend get-email is a read: passes at level 1 (out of scope)", code == 0, f"exit={code}")
    code, _, err = run_gate(store_l1, resend("create-domain", name="x.hu"))
    check("resend create-domain: not on the safe list, in scope, DENIED at level 1",
          code == 2 and "szint 1" in err, f"exit={code}")

    # --- Card 45b33b2b (Cybersec GO on 498d53c1 @4b341e4d, msg 6240, REGRESSION) ---
    # The server-name match required no hyphen before "gmail"/"resend" and no suffix after it --
    # google-gmail__ / gmail-mcp__ skipped deny-by-default ENTIRELY. Canary below.
    def hyphenated(server, tool, **ti):
        return {"tool_name": f"mcp__{server}__{tool}", "tool_input": ti}
    for server in ("google-gmail", "gmail-mcp"):
        code, _, err = run_gate(store_l1, hyphenated(server, "send_message", to=["a@b.hu"], body="x"))
        check(f"{server}: send_message reaches deny-by-default, DENIED at level 1",
              code == 2 and "szint 1" in err, f"exit={code}")
        code, _, _ = run_gate(store_l1, hyphenated(server, "search_threads", q="x"))
        check(f"{server}: search_threads is a read, passes at level 1 (out of scope)", code == 0, f"exit={code}")
    # "draft" as a VERB prefix (draft_email) is safe -- distinct from send_draft/update_draft.
    code, _, _ = run_gate(store_l1, connector("draft_email", to=["a@b.hu"], body="x"))
    check("connector draft_email (verb prefix) is not a send: passes at level 1", code == 0, f"exit={code}")

    # --- Card bf7a7335 (Cybersec GO on 45b33b2b @bee4940b, msg 6253, LOW) ---
    # The safe-prefix match only looked at the name up to its FIRST separator, so a name that
    # STARTS with a safe verb but later names send/reply/forward slipped through unaudited.
    code, _, err = run_gate(store_l1, connector("draft_and_send", to=["a@b.hu"], body="x"))
    check("connector draft_and_send (safe-prefix bypass): DENIED at level 1",
          code == 2 and "szint 1" in err, f"exit={code}")
    code, _, err = run_gate(store_l1, connector("read_then_forward", messageId="m1"))
    check("connector read_then_forward (safe-prefix bypass): DENIED at level 1",
          code == 2 and "szint 1" in err, f"exit={code}")
    code, _, err = run_gate(store_l1, resend("search-and-send-email", to="a@b.hu"))
    check("resend search-and-send-email (safe-prefix bypass): DENIED at level 1",
          code == 2 and "szint 1" in err, f"exit={code}")
    # --- EMAILALLANDOCIMZETT926: allando cimzett-lista, CSAK level 2-n --------
    # A funkcio egyetlen dolga, hogy EGY cimre jovahagyas nelkul lehessen kuldeni,
    # ugy, hogy minden mas cimzett a regi uton maradjon. Ezert minden teszt parban
    # all: ami atmegy a listas cimre, annak TILOS lennie egy masikra.
    store = make_store(os.path.join(td, "sl1"), level=2)
    write_standing(store, {"recipients": ["dani@pelda.hu"]})
    activate_standing(store, "dani@pelda.hu")
    code, out, err = run_gate(store, mcp_send(to="dani@pelda.hu"))
    check("standing: a listan levo cimre level 2-n jovahagyas NELKUL mehet",
          code == 0 and "allando cimzett" in out, f"exit={code} out={out[:120]!r}")
    code, _, err = run_gate(store, mcp_send(to="idegen@pelda.hu"))
    check("standing: a listan NEM szereplo cimre tovabbra is jovahagyas kell",
          code == 2 and "NINCS jovahagyas" in err, f"exit={code}")

    # A ketto egyutt a lenyeg: a lista NEM a level helyettesitoje.
    store1 = make_store(os.path.join(td, "sl2"), level=1)
    write_standing(store1, {"recipients": ["dani@pelda.hu"]})
    activate_standing(store1, "dani@pelda.hu")   # TELJESEN eles cim -- a level 1 igy is tilt
    code, _, err = run_gate(store1, mcp_send(to="dani@pelda.hu"))
    check("standing: level 1 HARD DENY marad, a lista nem nyit hatso ajtot",
          code == 2 and "szint 1" in err, f"exit={code} err={err[:120]!r}")

    # cc/bcc: a lista egy cimzettre szol, nem egy levelre
    code, _, err = run_gate(store, mcp_send(to="dani@pelda.hu", cc="idegen@pelda.hu"))
    check("standing: cc-vel NEM mehet at (a lista egy cimzettre szol)",
          code == 2, f"exit={code}")
    payload = mcp_send(to="dani@pelda.hu")
    payload["tool_input"]["bcc"] = ["idegen@pelda.hu"]
    code, _, err = run_gate(store, payload)
    check("standing: bcc-vel sem mehet at", code == 2, f"exit={code}")

    # A kritikus el: az extractor NEM bontja a cimzettet, egy string tobb cimet vihet.
    code, _, err = run_gate(store, mcp_send(to="dani@pelda.hu, idegen@pelda.hu"))
    check("standing: vesszovel osszefuzott ket cim EGY to-mezoben sem megy at",
          code == 2, f"exit={code}")
    code, out, _ = run_gate(store, mcp_send(to="Nemeth Daniel <dani@pelda.hu>"))
    check("standing: a 'Nev <cim>' alak felismerese (ugyanaz a cim)",
          code == 0 and "allando cimzett" in out, f"exit={code}")
    code, out, _ = run_gate(store, mcp_send(to="DANI@Pelda.HU"))
    check("standing: a cim-egyezes kis-nagybetu fuggetlen",
          code == 0, f"exit={code}")

    # fail-closed: romlott lista nem ad jogot, DE lathatova teszi magat
    store2 = make_store(os.path.join(td, "sl3"), level=2)
    write_standing(store2, "{not json")
    code, _, err = run_gate(store2, mcp_send(to="dani@pelda.hu"))
    check("standing: romlott lista -> nincs jog (fail-closed), es a deny MEGMONDJA",
          code == 2 and "nem olvashato" in err, f"exit={code} err={err[:160]!r}")
    write_standing(store2, {"recipients": "dani@pelda.hu"})
    code, _, err = run_gate(store2, mcp_send(to="dani@pelda.hu"))
    check("standing: rossz alaku lista (string lista helyett) -> nincs jog, es lathato",
          code == 2 and "alakja nem lista" in err, f"exit={code}")

    # hianyzo fajl = a normal allapot, nem hiba: csendben a regi ut. "Extra zaj"
    # = a lista HIBA-jegyzete (romlott/rossz alaku); annak nincs mit jeleznie,
    # ha a fajl egyszeruen nincs.
    store3 = make_store(os.path.join(td, "sl4"), level=2)
    code, _, err = run_gate(store3, mcp_send(to="dani@pelda.hu"))
    check("standing: lista-fajl nelkul minden marad a regiben, extra zaj nelkul",
          code == 2 and "NINCS jovahagyas" in err
          and "nem olvashato" not in err and "alakja nem lista" not in err,
          f"exit={code}")

    # --- BIRALOI KERES 1: a deny NE tanitsa meg a kiskaput -------------------
    # A tiltas korabban SZO SZERINT leirta, hogy a cim felvehetó a
    # email-standing-recipients.json fajlba, es onnantol jovahagyas nelkul mehet
    # ra level. Csakhogy azt a fajlt AZ AGENS IS irja: a store/ ala ir nap mint
    # nap. Vagyis a kapu sajat tiltasa volt a megkerules hasznalati utmutatoja.
    # A jogot tovabbra is a gazda adja, de az UTAT a tiltas nem mondja meg.
    code, _, err = run_gate(store3, mcp_send(to="dani@pelda.hu"))
    check("keres1: a deny NEM nevezi meg a lista-fajlt",
          "email-standing-recipients" not in err and ".json" not in err,
          f"err={err[-400:]!r}")
    check("keres1: a deny a GAZDAHOZ kuldi az agenst, nem a fajlhoz",
          "KERD TOLE" in err and "MAGAD NE vegezd el" in err,
          f"err={err[-400:]!r}")
    # Kontroll: a regi, tanito mondat tenylegesen eltunt -- kulonben a ket
    # fenti allitas akkor is zold lenne, ha csak a fajlnevet vettem volna ki.
    check("keres1 kontroll: a 'felveheti a cimet ... fajlba' mondat nincs tobbe",
          "felveheti a cimet" not in err, f"err={err[-400:]!r}")

    # --- BIRALOI KERES 2: a jovahagyas nelkuli kuldes hagyjon nyomot ---------
    # Ez az EGYETLEN ut, amin emberi dontes nelkul megy ki level, ezert a nyom
    # nem mellektermek, hanem a jog feltetele.
    store4 = make_store(os.path.join(td, "sl5"), level=2)
    write_standing(store4, {"recipients": ["dani@pelda.hu"]})
    activate_standing(store4, "dani@pelda.hu")
    log_path = os.path.join(store4, "email-standing-sends.log")
    code, out, _ = run_gate(store4, mcp_send(to="dani@pelda.hu", subject="Napi jelentes"))
    log_text = open(log_path, encoding="utf-8").read() if os.path.exists(log_path) else ""
    check("keres2: a listas kuldes sort ir a helyi naploba",
          code == 0 and "dani@pelda.hu" in log_text, f"exit={code} log={log_text!r}")
    check("keres2: a naplosor idobelyeges (offsettel, nem UTC)",
          re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4} ", log_text or "x") is not None,
          f"log={log_text[:80]!r}")
    check("keres2: a naplosor megmondja, hogy a gazdat NEM sikerult ertesiteni",
          "NEM MENT KI" in log_text, f"log={log_text!r}")
    check("keres2: a systemMessage sem allitja, hogy a gazda latta",
          "NEM sikerult ertesiteni" in out, f"out={out[:300]!r}")

    # A ket kuldes ket sor: a naplo append-only, nem felulir.
    run_gate(store4, mcp_send(to="dani@pelda.hu", subject="Masodik"))
    after = open(log_path, encoding="utf-8").read() if os.path.exists(log_path) else ""
    check("keres2: a naplo append-only (ket kuldes = ket sor)",
          len([l for l in after.splitlines() if l.strip()]) == 2, f"log={after!r}")

    # Es a kritikus el: ha a nyom NEM irhato, a jog sem all.
    store5 = make_store(os.path.join(td, "sl6"), level=2)
    write_standing(store5, {"recipients": ["dani@pelda.hu"]})
    activate_standing(store5, "dani@pelda.hu")
    blocked_log = os.path.join(store5, "email-standing-sends.log")
    os.mkdir(blocked_log)  # egy KONYVTAR ugyanazon a neven -> az append OSError
    code, _, err = run_gate(store5, mcp_send(to="dani@pelda.hu"))
    check("keres2: rogzithetetlen kuldes -> fail-closed TILTVA, nem csendes atengedes",
          code == 2 and "nem rogzitheto" in err, f"exit={code} err={err[:300]!r}")

    # A gazda-ertesites ELMEGY, ha a dashboard el: stub szerver a napi naplora.
    store6 = make_store(os.path.join(td, "sl7"), level=2)
    write_standing(store6, {"recipients": ["dani@pelda.hu"]})
    activate_standing(store6, "dani@pelda.hu")
    with open(os.path.join(store6, ".dashboard-token"), "w", encoding="utf-8") as fh:
        fh.write("teszt-token")
    received = []
    srv = HTTPServer(("127.0.0.1", 0), make_daily_log_stub(received))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        code, out, _ = run_gate(store6, mcp_send(to="dani@pelda.hu", subject="Elo dashboard"),
                                extra_env={"WEB_PORT": str(srv.server_port),
                                           "MAIN_AGENT_ID": "teszt-agens"})
    finally:
        srv.shutdown()
    check("keres2: elo dashboardnal a kuldes a GAZDA napi naplojaba kerul",
          code == 0 and len(received) == 1, f"exit={code} received={len(received)}")
    if received:
        body, auth = received[0]
        check("keres2: a napi naplo bejegyzes a fo agens neveben, Bearer tokennel megy",
              body.get("agent_id") == "teszt-agens" and auth == "Bearer teszt-token",
              f"body={body!r} auth={auth!r}")
        check("keres2: a bejegyzes megnevezi a cimzettet es hogy jovahagyas NELKUL ment",
              "dani@pelda.hu" in body.get("content", "")
              and "JOVAHAGYAS NELKUL" in body.get("content", ""),
              f"content={body.get('content')!r}")
    check("keres2: es ilyenkor a systemMessage sem beszel elmaradt ertesitesrol",
          "NEM sikerult" not in out, f"out={out[:300]!r}")

    # --- BIRALOI KERES 3: a felveteltol meg nem eles a cim -----------------
    # A lelke: a lista JAVASLAT, az elesites DONTES. Aki a fajlt irja, attol meg
    # nem adhatja meg maganak a jogot. Ezert minden eset PARBAN all: ami atmegy
    # az eles cimre, annak TILOS lennie ugyanarra a cimre elesites nelkul.
    store7 = make_store(os.path.join(td, "sl8"), level=2)
    write_standing(store7, {"recipients": ["dani@pelda.hu"]})
    code, _, err = run_gate(store7, mcp_send(to="dani@pelda.hu"))
    check("keres3: listan van, de NINCS elesitve -> nem megy at",
          code == 2 and "NINCS ELESITVE" in err, f"exit={code} err={err[:200]!r}")
    check("keres3: a deny kimondja, hogy a felvetel nem elesites",
          "A felvetel javaslat, az elesites dontes" in err, f"err={err[:400]!r}")
    check("keres3: a deny a GAZDA dontesehez kuldi, es tiltja az onjovahagyast",
          "A dontes a gazdae" in err and "NE hagyd jova" in err, f"err={err[:400]!r}")
    check("keres3: a deny megadja a cim-horgonyt, hogy az elesites KERHETO legyen",
          "email_standing_recipient" in err and anchor_from_stderr(err) is not None,
          f"err={err[:400]!r}")
    # ugyanaz a store, ugyanaz a cim, EGYETLEN kulonbseg: a gazda dontese
    activate_standing(store7, "dani@pelda.hu")
    code, out, _ = run_gate(store7, mcp_send(to="dani@pelda.hu"))
    check("keres3: elesites UTAN ugyanaz a level atmegy",
          code == 0 and "allando cimzett" in out, f"exit={code} out={out[:150]!r}")

    # A horgony a NORMALIZALT cimre szol: egy elesites fedi az alakvaltozatokat.
    code, out, _ = run_gate(store7, mcp_send(to="Nemeth Daniel <DANI@Pelda.HU>"))
    check("keres3: egy elesites fedi a 'Nev <CIM>' es a kis-nagybetus alakot is",
          code == 0, f"exit={code}")

    # Az elesites NEM egyszer-hasznalatos es NEM jar le -- kulonben csak egy
    # level-enkenti jovahagyas lenne mas neven.
    code2, _, _ = run_gate(store7, mcp_send(to="dani@pelda.hu", subject="Masodik level"))
    check("keres3: az elesites NEM fogy el (masodik kuldes is atmegy)",
          code2 == 0, f"exit={code2}")
    store8 = make_store(os.path.join(td, "sl9"), level=2)
    write_standing(store8, {"recipients": ["dani@pelda.hu"]})
    activate_standing(store8, "dani@pelda.hu", resolved_ago=100000)  # >> WINDOW
    code, _, _ = run_gate(store8, mcp_send(to="dani@pelda.hu"))
    check("keres3: az elesites NEM jar le a level-ablakkal",
          code == 0, f"exit={code}")

    # Fuggoben levo keres MEG NEM jog.
    store9 = make_store(os.path.join(td, "sl10"), level=2)
    write_standing(store9, {"recipients": ["dani@pelda.hu"]})
    activate_standing(store9, "dani@pelda.hu", status="pending")
    code, _, err = run_gate(store9, mcp_send(to="dani@pelda.hu"))
    check("keres3: FUGGOBEN levo elesites meg nem jog, es a deny ezt mondja",
          code == 2 and "FUGGOBEN" in err, f"exit={code} err={err[:200]!r}")

    # Visszavonas: a gazda UTOLSO dontese nyer, a fajl erintese nelkul.
    store10 = make_store(os.path.join(td, "sl11"), level=2)
    write_standing(store10, {"recipients": ["dani@pelda.hu"]})
    activate_standing(store10, "dani@pelda.hu", status="approved", resolved_ago=600)
    code, _, _ = run_gate(store10, mcp_send(to="dani@pelda.hu"))
    check("keres3 kontroll: a regebbi jovahagyas onmagaban meg jog",
          code == 0, f"exit={code}")
    activate_standing(store10, "dani@pelda.hu", status="rejected", resolved_ago=0)
    code, _, err = run_gate(store10, mcp_send(to="dani@pelda.hu"))
    check("keres3: kesobbi elutasitas VISSZAVONJA a jogot (a fajl valtozatlan)",
          code == 2 and "rejected" in err, f"exit={code} err={err[:200]!r}")

    # Es forditva, hogy ne csak a 'barmi rossz sor tilt' legyen igaz.
    store11 = make_store(os.path.join(td, "sl12"), level=2)
    write_standing(store11, {"recipients": ["dani@pelda.hu"]})
    activate_standing(store11, "dani@pelda.hu", status="rejected", resolved_ago=600)
    activate_standing(store11, "dani@pelda.hu", status="approved", resolved_ago=0)
    code, _, _ = run_gate(store11, mcp_send(to="dani@pelda.hu"))
    check("keres3: ujboli jovahagyas UTAN megint jog (az utolso dontes nyer)",
          code == 0, f"exit={code}")

    # Egy MASIK cim elesitese nem elesiti ezt.
    store12 = make_store(os.path.join(td, "sl13"), level=2)
    write_standing(store12, {"recipients": ["dani@pelda.hu", "masik@pelda.hu"]})
    activate_standing(store12, "masik@pelda.hu")
    code, _, err = run_gate(store12, mcp_send(to="dani@pelda.hu"))
    check("keres3: MAS cim elesitese nem elesiti ezt a cimet",
          code == 2 and "NINCS ELESITVE" in err, f"exit={code}")
    code, _, _ = run_gate(store12, mcp_send(to="masik@pelda.hu"))
    check("keres3 kontroll: az elesitett masik cim ugyanabban a store-ban atmegy",
          code == 0, f"exit={code}")

    # Fail-closed: ha az elesites nem ellenorizheto, a jog sem all.
    store13 = make_store(os.path.join(td, "sl14"), level=2)
    write_standing(store13, {"recipients": ["dani@pelda.hu"]})
    activate_standing(store13, "dani@pelda.hu")
    os.remove(os.path.join(store13, "claudeclaw.db"))
    code, _, err = run_gate(store13, mcp_send(to="dani@pelda.hu"))
    check("keres3: ellenorizhetetlen elesites -> fail-closed TILTVA",
          code == 2 and "elesitese nem ellenorizheto" in err, f"exit={code} err={err[:200]!r}")

    # kontroll: a matcher tud is talalni -- kulonben a fenti tiltasok
    # akkor is atmennenek, ha a funkcio egyaltalan nem letezne
    code, out, _ = run_gate(store, mcp_send(to="dani@pelda.hu"))
    check("kontroll: a pozitiv ag ugyanabban a store-ban tovabbra is atmegy",
          code == 0, f"exit={code}")

    # SQLite-version portability, kept as a STATIC check on purpose. The
    # behavioural cases above only catch the bad call on a host whose sqlite is
    # older than 3.38 -- on CI (newer) they stay green while the live install
    # denies every approved letter. So assert the function is absent from the
    # source, which fails on every host once it is reintroduced. Measured
    # 2026-09-02: host python sqlite3 3.37.2, gate raised OperationalError,
    # and the fail-closed deny read as "no approval" rather than a version
    # fault. The 'unixepoch' MODIFIER (date(x,'unixepoch')) is ancient and
    # fine -- only the bare function call is banned.
    #
    # COMMENTS ARE STRIPPED before matching, and the pattern is assembled from
    # fragments: otherwise this file's own prose (and the pattern itself) would
    # register as a violation and the check would fail for a reason that has
    # nothing to do with any SQL. Strings are KEPT -- that is where the SQL is.
    banned = re.compile(r"(?<!')\b" + "unix" + r"epoch\s*\(")

    def code_without_comments(path):
        with open(path, "rb") as fh:
            return "".join(t.string for t in tokenize.tokenize(fh.readline)
                           if t.type != tokenize.COMMENT)

    hook_srcs = [os.path.join(HOOKS, f) for f in sorted(os.listdir(HOOKS)) if f.endswith(".py")]
    offenders = [os.path.basename(p) for p in hook_srcs + [os.path.abspath(__file__)]
                 if banned.search(code_without_comments(p))]
    check("portability: no bare SQLite unixepoch function call (needs 3.38+) in the hooks",
          not offenders, f"offenders={offenders}")
    # Control: the check can actually fail. Without this, a broken matcher
    # would report a clean tree forever and read exactly like a passing gate.
    check("control: the same matcher DOES flag the old expression",
          bool(banned.search("SELECT unix" + "epoch()-60")))
    check("control: the host's own sqlite3 really executes the replacement expression",
          sqlite3.connect(":memory:").execute(f"SELECT {NOW_S}").fetchone()[0] > 1_700_000_000)

# --- HOOKDEPLOAD1008: a dependency that does not load DENIES (exit 2), never exit 1 ---
# The extractor used to be imported at MODULE level, outside the __main__ net:
# a broken email_extract.py (a conflicted stash pop leaves exactly such a
# marker line) made the gate exit 1, which PreToolUse treats as NON-blocking,
# so the letter went out unchecked. Every case runs on a disposable copy of
# scripts/hooks + scripts/lib, never on the repo's own files, and the intact
# copy is first shown to decide exactly like the real gate: otherwise a broken
# copy's verdict could be the copy's own fault.
CONFLICT_LINE = "<" * 7 + " Updated upstream\n"  # assembled, so this file holds no marker line


def copy_hook_tree(dst):
    """The gate's disposable copy: scripts/hooks + scripts/lib under dst."""
    skip = shutil.ignore_patterns("__pycache__")
    shutil.copytree(HOOKS, os.path.join(dst, "scripts", "hooks"), ignore=skip)
    shutil.copytree(os.path.join(os.path.dirname(HOOKS), "lib"),
                    os.path.join(dst, "scripts", "lib"), ignore=skip)
    return os.path.join(dst, "scripts", "hooks", "email-approval-gate.py")


def break_module(gate_copy, name):
    with open(os.path.join(os.path.dirname(gate_copy), name), "a", encoding="utf-8") as fh:
        fh.write(CONFLICT_LINE)


LS = {"tool_name": "Bash", "tool_input": {"command": "ls -la"}}
BASH_SEND = {"tool_name": "Bash", "tool_input": {
    "command": 'sendmail --to a@b.hu --subject "Bash tárgy" --body "Bash törzs."'}}

with tempfile.TemporaryDirectory() as td:
    store = make_store(os.path.join(td, "dep"), level=2)
    intact = copy_hook_tree(os.path.join(td, "intact"))
    for label, payload in (("MCP send", mcp_send()), ("Bash send", BASH_SEND), ("non-send Bash", LS)):
        real, copy = run_gate(store, payload), run_gate(store, payload, gate=intact)
        check(f"HOOKDEPLOAD1008 control: the intact copy decides like the real gate ({label})",
              (copy[0], copy[2]) == (real[0], real[2]),
              f"real={real[0]} copy={copy[0]} err={copy[2][:200]!r}")

    broken = copy_hook_tree(os.path.join(td, "broken-extract"))
    break_module(broken, "email_extract.py")
    for label, payload in (("MCP send", mcp_send()), ("Bash send", BASH_SEND)):
        code, _, err = run_gate(store, payload, gate=broken)
        check(f"HOOKDEPLOAD1008: broken email_extract.py -> {label} DENIED, exit 2 (1 would send unchecked)",
              code == 2 and "email_extract.py" in err and "nem toltheto be" in err,
              f"exit={code} err={err[:200]!r}")
    code, _, err = run_gate(store, LS, gate=broken)
    check("HOOKDEPLOAD1008: broken email_extract.py -> a non-send Bash still passes (the extractor is not needed)",
          code == 0, f"exit={code} err={err[:200]!r}")
    # Levels 1 and 3 never read the letter, so they decide as before. At level
    # 3 the send itself is still stopped by the copy gate: its guarded import
    # turns a missing or broken extractor into a deny (the missing-module case
    # is email-extract-parity.test.py, section 3).
    for level, want in ((1, 2), (3, 0)):
        code, _, err = run_gate(make_store(os.path.join(td, f"dep-l{level}"), level=level),
                                mcp_send(), gate=broken)
        check(f"HOOKDEPLOAD1008: broken email_extract.py -> level {level} decides as before (exit {want})",
              code == want, f"exit={code} err={err[:200]!r}")

    broken = copy_hook_tree(os.path.join(td, "broken-classifier"))
    break_module(broken, "outgoing-copy-gate.py")
    code, _, err = run_gate(store, LS, gate=broken)
    check("HOOKDEPLOAD1008: broken outgoing-copy-gate.py -> Bash DENIED, exit 2, naming the file",
          code == 2 and "outgoing-copy-gate.py" in err and "nem toltheto be" in err,
          f"exit={code} err={err[:200]!r}")
    real, copy = run_gate(store, mcp_send()), run_gate(store, mcp_send(), gate=broken)
    check("HOOKDEPLOAD1008: broken outgoing-copy-gate.py -> an MCP send is decided as before (no classifier needed)",
          (copy[0], copy[2]) == (real[0], real[2]), f"real={real[0]} copy={copy[0]} err={copy[2][:200]!r}")

    bad_window = {"EMAIL_APPROVAL_WINDOW_S": "abc"}
    code, _, err = run_gate(store, mcp_send(), extra_env=bad_window)
    check("HOOKDEPLOAD1008: malformed EMAIL_APPROVAL_WINDOW_S -> send DENIED, exit 2, naming the variable",
          code == 2 and "EMAIL_APPROVAL_WINDOW_S" in err, f"exit={code} err={err[:200]!r}")
    code, _, err = run_gate(store, LS, extra_env=bad_window)
    check("HOOKDEPLOAD1008: malformed EMAIL_APPROVAL_WINDOW_S -> a non-send Bash still passes",
          code == 0, f"exit={code} err={err[:200]!r}")

print("\nMAILCCGATE1016: the owner's copy is a gate at every level")
OWNER = "owner@example.com"


def owner_store(root, level, value=OWNER):
    """A store whose install root (its parent) has a .env with MAIL_OWNER_CC."""
    store = make_store(root, level=level)
    if value is not None:
        with open(os.path.join(root, ".env"), "w", encoding="utf-8") as fh:
            fh.write(f"MAIL_OWNER_CC={value}\n")
    return store


with tempfile.TemporaryDirectory() as td:
    for lvl in (2, 3):
        store = owner_store(os.path.join(td, f"l{lvl}"), lvl)
        code, _, err = run_gate(store, mcp_send())
        check(f"level {lvl}: send_email without the owner in to/cc/bcc -> DENIED, naming the address",
              code == 2 and OWNER in err and "cc" in err, f"exit={code} err={err[:200]!r}")
    store = owner_store(os.path.join(td, "l3b"), 3)
    code, _, err = run_gate(store, mcp_send(cc=OWNER))
    check("level 3: the owner in cc -> allowed", code == 0, f"exit={code} err={err[:200]!r}")
    code, _, err = run_gate(store, mcp_send(cc="Owner Name <OWNER@Example.com>"))
    check("level 3: the owner in cc as a display-name form, other case -> allowed", code == 0, f"exit={code} err={err[:200]!r}")
    code, _, err = run_gate(store, mcp_send(to=OWNER))
    check("level 3: the owner as the recipient (to) -> allowed", code == 0, f"exit={code} err={err[:200]!r}")
    bcc = mcp_send()
    bcc["tool_input"]["bcc"] = [OWNER]
    code, _, err = run_gate(store, bcc)
    check("level 3: the owner in bcc -> allowed", code == 0, f"exit={code} err={err[:200]!r}")
    code, _, err = run_gate(store, mcp_send(cc="other@example.org"))
    check("level 3: a cc that is not the owner -> DENIED", code == 2, f"exit={code} err={err[:200]!r}")
    code, _, err = run_gate(store, mcp_send(cc="xowner@example.com"))
    check("level 3: an address that only CONTAINS the owner's -> DENIED", code == 2, f"exit={code} err={err[:200]!r}")
    mixed = owner_store(os.path.join(td, "mixed"), 3, value="Owner@Example.COM")
    code, _, err = run_gate(mixed, mcp_send(cc=OWNER))
    check("level 3: a mixed-case MAIL_OWNER_CC still matches the owner in cc -> allowed", code == 0, f"exit={code} err={err[:200]!r}")
    off = owner_store(os.path.join(td, "off"), 3, value=None)
    code, _, err = run_gate(off, mcp_send())
    check("level 3: no MAIL_OWNER_CC in the install .env -> the check is off, allowed", code == 0, f"exit={code} err={err[:200]!r}")
    empty = owner_store(os.path.join(td, "empty"), 3, value="")
    code, _, err = run_gate(empty, mcp_send())
    check("level 3: MAIL_OWNER_CC empty in the install .env -> off, allowed", code == 0, f"exit={code} err={err[:200]!r}")
    code, _, err = run_gate(store, mcp_send(), extra_env={"MAIL_OWNER_CC": ""})
    check("an EMPTY MAIL_OWNER_CC in the process env does NOT switch the gate off (.env only)",
          code == 2, f"exit={code} err={err[:200]!r}")
    code, _, err = run_gate(off, mcp_send(), extra_env={"MAIL_OWNER_CC": OWNER})
    check("a MAIL_OWNER_CC in the process env alone does not switch it on either (.env only)",
          code == 0, f"exit={code} err={err[:200]!r}")
    reply = {"tool_name": "mcp__claude_ai_Gmail__reply", "tool_input": {"messageId": "m1", "body": "y"}}
    code, _, err = run_gate(store, reply)
    check("a messageId-addressed reply (no recipient field) -> DENIED, and the message points to send_email with the owner in cc",
          code == 2 and "send_email" in err and "messageId" in err and OWNER in err, f"exit={code} err={err[:300]!r}")
    draft = {"tool_name": "mcp__server-gmail-autoauth-mcp__draft_email",
             "tool_input": {"to": ["a@b.hu"], "subject": "x", "body": "y"}}
    code, _, err = run_gate(store, draft)
    check("a draft without the owner -> DENIED (send_draft can only be checked here)",
          code == 2 and "piszkozat" in err, f"exit={code} err={err[:200]!r}")
    draft["tool_input"]["cc"] = [OWNER]
    code, _, err = run_gate(store, draft)
    check("a draft with the owner in cc -> allowed", code == 0, f"exit={code} err={err[:200]!r}")
    l1 = owner_store(os.path.join(td, "l1"), 1)
    code, _, err = run_gate(l1, draft)
    check("level 1: a draft with the owner in cc is still not a send -> allowed", code == 0, f"exit={code} err={err[:200]!r}")
    mdraft = {"tool_name": "mcp__x__manage_email",
              "tool_input": {"operation": "reply", "draft": True, "body": "y"}}
    code, _, err = run_gate(store, mdraft)
    check("manage_email reply draft without the owner -> DENIED", code == 2, f"exit={code} err={err[:200]!r}")
    msearch = {"tool_name": "mcp__x__manage_email", "tool_input": {"operation": "search", "query": "x"}}
    code, _, err = run_gate(store, msearch)
    check("manage_email search -> not checked, allowed", code == 0, f"exit={code} err={err[:200]!r}")
    upd = {"tool_name": "mcp__claude_ai_Gmail__update_draft", "tool_input": {"draftId": "d1", "body": "y"}}
    code, _, err = run_gate(store, upd)
    check("update_draft (only the changed fields) -> not checked, allowed", code == 0, f"exit={code} err={err[:200]!r}")
    msend = {"tool_name": "mcp__x__manage_email",
             "tool_input": {"operation": "send", "to": "a@b.hu", "cc": OWNER, "subject": "x", "body": "y"}}
    code, _, err = run_gate(store, msend)
    check("level 3: manage_email send with the owner in cc (string field) -> allowed", code == 0, f"exit={code} err={err[:200]!r}")
    msend["tool_input"].pop("cc")
    code, _, err = run_gate(store, msend)
    check("level 3: manage_email send without the owner -> DENIED", code == 2, f"exit={code} err={err[:200]!r}")
    conn = {"tool_name": "mcp__claude_ai_Gmail__send_message",
            "tool_input": {"to": "a@b.hu, " + OWNER, "subject": "x", "body": "y"}}
    code, _, err = run_gate(store, conn)
    check("level 3: connector send with the owner in a comma-separated to -> allowed", code == 0, f"exit={code} err={err[:200]!r}")
    LSX = {"tool_name": "Bash", "tool_input": {"command": "ls -la"}}
    code, _, err = run_gate(store, LSX)
    check("a non-send Bash -> not checked, allowed", code == 0, f"exit={code} err={err[:200]!r}")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All email-approval-gate tests passed.")

#!/usr/bin/env python3
"""Card 1b4c566e: full-union adoption of the three outbound-text gates left out
of the ee7bc2ba upstream merge (Cybersec NO-GO @ 26f2b4f2) as dead code:
  - GATEHTTP924 (http_channel_gate): community (marveen.io) + Discord REST curl sends.
  - INTERAGENTHOMOGLIF923 (inter_agent_homoglyph_gate): homoglyph-only check on
    curl .../api/messages (the fleet's inter-agent channel).
  - GATEBINVAK916: curl's @file/-F/-T file-body shapes in collect_bash_body
    (previously only the `<` redirect was read; these equivalent file-body
    flags silently audited nothing while returning exit 0).

What is pinned here, and why each case earns its place:
  - a SEND to a covered HTTP target is audited (em dash -> 2, clean -> 0);
    a READ (GET) passes untouched;
  - Telegram Bot API is DELIBERATELY NOT a target of http_channel_gate (see the
    decision comment above its definition in outgoing-copy-gate.py): that
    channel already has its own, deliberately fail-OPEN gate here
    (telegram_bash_gate, GATETG816). main()'s if/elif/else dispatch means the
    two gates can never run on the same call (no run-order collision, CYBERSEC
    comment 39236 corrected an earlier wrong claim that one existed); the real
    reason is that telegram_bash_gate is opt-in and OFF by default, and while
    off a Telegram send should stay fully unaudited by design, not get
    audited fail-closed by http_channel_gate instead;
  - /api/messages (inter-agent) gets ONLY the homoglyph check, not the full
    copy audit (accent-free fleet traffic would false-positive constantly);
  - inter-agent failure direction is the OPPOSITE of the email/HTTP-channel
    branches: an unreadable body PASSES (loudly), because silencing the
    fleet's own coordination channel costs more than a missed homoglyph scan;
  - GATEBINVAK916's file-body forms are READ and audited here (not refused
    like email_extract.py's PR2 approval gate), because this gate only
    audits text at call time -- it never anchors an approval on what it
    reads, so it carries none of that gate's TOCTOU exposure.

Every CASE below is run through the real PreToolUse entrypoint (main(), via
subprocess), so it also proves the gate is actually WIRED, not merely defined
-- each positive case here was exit 0 (unaudited) before this card.

KNOWN, PRE-EXISTING LIMITATION (not introduced or fixed by this card): the
shared mixed_script_words() tokenizer (UWORD = r"[^\\W\\d_]+") excludes digits
from a "word", so a homoglyph substituted into a digit-containing identifier
(e.g. a hex card id like "1b4c566<CYRILLIC O>") sits in its OWN single-script
word and is never flagged, even though upstream's own motivating example is
exactly "a card id, agent name or file path". A homoglyph in a letters-only
identifier (an agent name, a path segment) IS caught (see the positive case
below). Filed as an observation for the gate dispatch, not fixed here: this
card adopts the upstream wiring as-is, it does not redesign the shared
tokenizer other call sites in this file already depend on.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import shlex
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")

BAD = "Szia, ez egy teszt — gondolatjellel."
GOOD = "Szia, ez egy rendes mondat, gondolatjel nélkül."


def run_gate(cmd: str):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    proc = subprocess.run([sys.executable, GATE], input=payload.encode(), capture_output=True)
    return proc.returncode, proc.stderr.decode("utf-8", "replace")


MIO = "https://api.marveen.io/agent/v1"

tmp = tempfile.mkdtemp(prefix="cgunion-")
bad_file = os.path.join(tmp, "bad.txt")
good_file = os.path.join(tmp, "good.txt")
with open(bad_file, "w", encoding="utf-8") as fh:
    fh.write(BAD)
with open(good_file, "w", encoding="utf-8") as fh:
    fh.write(GOOD)
bad_json_file = os.path.join(tmp, "bad.json")
with open(bad_json_file, "w", encoding="utf-8") as fh:
    json.dump({"content": BAD}, fh, ensure_ascii=False)

CASES = [
    # --- GATEHTTP924: community API (marveen.io) --------------------------
    ("community comment, inline -d, em dash BLOCKS",
     f"curl -s -X POST {MIO}/feed/posts/abc/comments -d "
     + shlex.quote(json.dumps({"content": BAD}, ensure_ascii=False)), 2),
    ("community comment, inline -d, clean passes",
     f"curl -s -X POST {MIO}/feed/posts/abc/comments -d "
     + shlex.quote(json.dumps({"content": GOOD}, ensure_ascii=False)), 0),
    ("community comment via @file, em dash BLOCKS",
     f"curl -s -X POST {MIO}/feed/posts/abc/comments --data-binary @{bad_json_file}", 2),
    ("community feed READ passes untouched (GET, no body)",
     f"curl -s -H 'Authorization: Bearer K' '{MIO}/feed?limit=10'", 0),
    ("community bare POST without a body passes (nothing of ours is sent)",
     f"curl -s -X POST {MIO}/feed/posts/abc/comments", 0),
    ("community body from $(...) is unreadable -> BLOCKS (fail-closed, same direction as email)",
     f'curl -s -X POST {MIO}/feed/posts -d "{{\\"content\\":\\"$(cat x)\\"}}"', 2),
    # --- GATEHTTP924: Discord REST -----------------------------------------
    ("Discord REST message, em dash BLOCKS",
     "curl -s -X POST https://discord.com/api/v10/channels/1/messages -H 'Authorization: Bot X' -d "
     + shlex.quote(json.dumps({"content": BAD}, ensure_ascii=False)), 2),
    ("Discord REST message, clean passes",
     "curl -s -X POST https://discord.com/api/v10/channels/1/messages -d "
     + shlex.quote(json.dumps({"content": GOOD}, ensure_ascii=False)), 0),
    ("Discord REST history READ passes",
     "curl -s https://discord.com/api/v10/channels/1/messages?limit=5", 0),
    # --- Telegram Bot API deliberately OUT of http_channel_gate's scope ---
    ("Telegram Bot API send is NOT caught by http_channel_gate (exit 0): "
     "the fail-open telegram_bash_gate owns this channel, and it is OFF by default here "
     "(no --telegram-bash / env flag in this call), which is itself the pinned decision",
     f"curl -s https://api.telegram.org/botXYZ/sendMessage -d chat_id=1 -d text="
     + shlex.quote(BAD), 0),
    # --- scope boundary: inter-agent stays OUT of the full copy audit -----
    ("inter-agent /api/messages with an em dash does NOT trip the full audit (homoglyph-only gate)",
     "curl -s -X POST http://localhost:3420/api/messages -d "
     + shlex.quote(json.dumps({"from": "a", "to": "b", "content": BAD}, ensure_ascii=False)), 0),
    ("an unrelated POST is not a channel send and not an inter-agent send",
     f"curl -s -X POST https://example.com/api/items -d "
     + shlex.quote(json.dumps({"content": BAD}, ensure_ascii=False)), 0),
    # --- INTERAGENTHOMOGLIF923 ----------------------------------------------
    ("inter-agent message with a Cyrillic letter in a letters-only word BLOCKS (homoglyph)",
     "curl -s -X POST http://localhost:3420/api/messages -d "
     + shlex.quote(json.dumps({"content": f"lasd mikr{chr(0x43e)}b"}, ensure_ascii=False)), 2),
    ("inter-agent message, clean ASCII, passes",
     "curl -s -X POST http://localhost:3420/api/messages -d "
     + shlex.quote(json.dumps({"content": "lasd mikrob, kartya 1b4c566e"}, ensure_ascii=False)), 0),
    ("inter-agent message, pure foreign-language quote passes (not a MIXED word)",
     "curl -s -X POST http://localhost:3420/api/messages -d "
     + shlex.quote(json.dumps({"content": "Idezet oroszul: Идёт дождь"}, ensure_ascii=False)), 0),
    ("inter-agent GET (queue read) passes, nothing sent",
     "curl -s http://localhost:3420/api/messages", 0),
    ("inter-agent body from $(...) is UNREADABLE -> PASSES loudly (opposite failure "
     "direction from email/HTTP-channel: silencing the fleet's own channel costs more)",
     'curl -s -X POST http://localhost:3420/api/messages -d "{\\"content\\":\\"$(cat x)\\"}"', 0),
]

failed = []
for name, cmd, want in CASES:
    got, _stderr = run_gate(cmd)
    ok = got == want
    if not ok:
        failed.append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: exit={got} want={want}")

# --- GATEBINVAK916: curl @file forms in collect_bash_body (email branch) ---
# These go through the SEND detector (is_send_invocation), not http_channel_gate
# -- resend.com is a recognised mail vendor, so this exercises collect_bash_body's
# new file-body branch directly, on the SAME fail-open/closed contract the email
# path already has elsewhere in this file.
ATFILE_CASES = [
    ("curl -d @file (resend), em dash in the file BLOCKS",
     f"curl -s https://api.resend.com/emails -H X -d @{bad_file}", 2),
    ("curl -d @file (resend), clean file passes",
     f"curl -s https://api.resend.com/emails -H X -d @{good_file}", 0),
    ("curl --data @file (resend), em dash BLOCKS",
     f"curl -s https://api.resend.com/emails --data @{bad_file}", 2),
    ("curl --data-binary @file (resend), em dash BLOCKS",
     f"curl -s https://api.resend.com/emails --data-binary @{bad_file}", 2),
    ("curl --json @file (resend), em dash BLOCKS",
     f"curl -s https://api.resend.com/emails --json @{bad_file}", 2),
    ("curl --data-urlencode name@file (resend), em dash BLOCKS",
     f"curl -s https://api.resend.com/emails --data-urlencode body@{bad_file}", 2),
    ("curl -F name=@file (resend), em dash BLOCKS",
     f"curl -s https://api.resend.com/emails -F body=@{bad_file}", 2),
    ("curl -F name=<file (resend), em dash BLOCKS",
     f"curl -s https://api.resend.com/emails -F body=<{bad_file}", 2),
    ("curl -T/--upload-file (resend), em dash BLOCKS",
     f"curl -s https://api.resend.com/emails -T {bad_file}", 2),
    ("wget --post-file (resend), em dash BLOCKS",
     f"wget https://api.resend.com/emails --post-file={bad_file}", 2),
    ("wget --body-file (resend), em dash BLOCKS",
     f"wget https://api.resend.com/emails --body-file={bad_file}", 2),
    ("curl -d @- with a quoted heredoc still reads the heredoc, not the @- marker",
     "curl -s https://api.resend.com/emails -d @- <<'JSON'\n" + GOOD + "\nJSON", 0),
    ("curl -d @- with NO heredoc is unreadable -> BLOCKS (fail-closed, no silent pass); "
     "SHOULD-fix pin (CYBERSEC comment 39236, point 2): assert the specific stdin-without-"
     "heredoc reason, not just the exit code, so a mutant that turns THIS branch into a "
     "silent pass cannot hide behind some other unrelated block",
     "curl -s https://api.resend.com/emails -d @-", 2, "stdin-rol jon"),
    ("curl -d @$MISSING (unresolved shell var in the path) is unreadable -> BLOCKS; "
     "SHOULD-fix pin: assert the specific unresolved-path reason",
     "curl -s https://api.resend.com/emails -d @$MISSING/body.txt", 2, "fel nem oldhato utvonalrol"),
    ("curl -d @/nonexistent (missing file) is unreadable -> BLOCKS; "
     "SHOULD-fix pin: assert the specific unreadable-file reason",
     "curl -s https://api.resend.com/emails -d @/nonexistent/path/body.txt", 2, "nem olvashato"),
    ("-F name=<file keeps working as a normal shell redirect reader AND is matched "
     "a second time by the dedicated file-body regex -- the double read is harmless, "
     "both append the same text",
     f"curl -s https://api.resend.com/emails -F body=<{good_file}", 0),
    ("CONTROL (CYBERSEC F-1, card 1b4c566e gate 184f8fa42): a plain `--body=<file` shell "
     "redirect, unrelated to curl -F, still BLOCKS on an em-dash file. A widened lookbehind "
     "that excludes '=' (i.e. putting back (?<![<=])<(?!<)) makes this pass silently -- that "
     "exact mutant must turn this case red.",
     f"python3 scripts/support-mail/send.py --to a@b.hu --body=<{bad_file}", 2),
]
for case in ATFILE_CASES:
    name, cmd, want = case[0], case[1], case[2]
    want_substr = case[3] if len(case) > 3 else None
    got, stderr = run_gate(cmd)
    ok = got == want and (want_substr is None or want_substr in stderr)
    if not ok:
        failed.append(name)
    detail = f"exit={got} want={want}"
    if want_substr is not None:
        substr_status = "found" if want_substr in stderr else f"MISSING:{want_substr!r}"
        detail += f" substr={substr_status}"
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All outgoing-copy-gate outbound-union tests passed.")

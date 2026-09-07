#!/usr/bin/env python3
"""CLCOPYGATEHIANY902: a MISSING rules file is not the same as a BROKEN one.

DEVIATION FROM THE ORIGINAL TG 14442 POLICY (card 4f15966e, backend,
2026-09-07): this file originally pinned an EMAIL-fail-open policy for a
missing/empty rules file. GATEPERSIST816(2) later narrowed that, on purpose,
for the email branch specifically: "az EMAIL ut a hianyzo nev-szabalyra
FAIL-CLOSED... pont a vevo fele a legdragabb a rossz nev" -- a postponable
send is not worth the risk of an unchecked name reaching a customer. The
TELEGRAM branch is explicitly UNCHANGED ("A telegram-ag fail-open marad") --
it is the supervisory channel, where silence is the more expensive failure.
MikroB confirmed (2026-09-07): keep the gate's current fail-closed email
behavior, fix this test to match it. Empirically verified against the actual
gate (outgoing-copy-gate.py) before writing these assertions, not guessed:

  EMAIL + missing/invalid rules -> BLOCKED (exit 2), loud stderr naming why;
  EMAIL + valid-but-empty rules -> passes SILENTLY (an empty pattern list is
                                    a determined, valid ruleset, not a broken
                                    one -- nothing to warn about);
  EMAIL + valid with patterns   -> the name check still enforces (regression
                                    guard on the thing the gate is for);
  TELEGRAM + missing rules      -> unchanged fail-open with its own loud
                                    systemMessage (the supervisory channel).

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def run_gate(rules_path, payload):
    proc = subprocess.run(
        [sys.executable, GATE], input=json.dumps(payload).encode(),
        capture_output=True,
        env=dict(os.environ, OUTGOING_COPY_GATE_RULES=rules_path),
    )
    return proc.returncode, proc.stdout.decode(), proc.stderr.decode()


# A letter that passes every copy check: flawless accents, no em dash, no
# double-hyphen prose, no mixed script.
CLEAN_MAIL = {
    "tool_name": "mcp__server-gmail-autoauth-mcp__send_email",
    "tool_input": {"to": ["a@b.hu"], "subject": "Rendben",
                   "body": "Kedves Ügyfelünk! Köszönjük a levelét, minden rendben van."},
}

with tempfile.TemporaryDirectory() as td:
    missing = os.path.join(td, "nincs-ilyen.json")

    # --- missing: EMAIL fail-closed (GATEPERSIST816(2)) -------------------
    code, out, err = run_gate(missing, CLEAN_MAIL)
    check("missing rules: the email is BLOCKED (exit 2)",
          code == 2, f"exit={code} out={out[:150]!r}")
    check("missing rules: the block is LOUD (stderr names the absent check)",
          "TILTVA" in err and "fail-closed" in err, f"err={err[:200]!r}")

    # --- valid but empty: an empty pattern list is a determined ruleset,
    # not a broken one -- passes SILENTLY, nothing to warn about -----------
    empty = os.path.join(td, "empty.json")
    with open(empty, "w") as fh:
        json.dump({"bad_name_patterns": []}, fh)
    code, out, err = run_gate(empty, CLEAN_MAIL)
    check("valid-empty rules: email goes OUT silently (no warning needed)",
          code == 0 and out == "" and err == "", f"exit={code} out={out[:160]!r} err={err[:160]!r}")

    # --- invalid variants: CLOSED (the negative control) ------------------
    # Message text is NOT uniform across these (empirically verified, not
    # guessed): not-json/top-level-not-dict route through the generic "file
    # missing/unreadable/malformed" message; a bad regex gets its own
    # "nem forditható" reason. "wrong-schema" (a STRING instead of a list for
    # bad_name_patterns) does NOT hit that path at all -- Python iterates a
    # string character-by-character, so it silently becomes a one-letter
    # pattern set and blocks via a coincidental name-audit match, not real
    # schema validation. That is a separate, pre-existing gap in the gate
    # (worth its own follow-up card) -- out of scope for this merge-landing
    # fix, so pinned here as what it actually does rather than what it should.
    # Every variant still ends up exit 2 (email stays blocked either way),
    # which is the property this negative control exists to protect.
    invalid_cases = [
        ("not-json", "{ez nem json"),
        ("wrong-schema (patterns not a list -- blocks via accidental char-iteration, not validation)",
         json.dumps({"bad_name_patterns": "Szota"})),
        ("uncompilable regex", json.dumps({"bad_name_patterns": ["[unclosed"]})),
        ("top-level not a dict", json.dumps(["Szota"])),
    ]
    for label, content in invalid_cases:
        bad = os.path.join(td, "bad.json")
        with open(bad, "w") as fh:
            fh.write(content)
        code, _, err = run_gate(bad, CLEAN_MAIL)
        check(f"invalid rules ({label}): email stays BLOCKED (exit 2)",
              code == 2, f"exit={code} err={err[:150]!r}")

    # --- valid with patterns: the check still enforces --------------------
    good = os.path.join(td, "good.json")
    with open(good, "w") as fh:
        json.dump({"bad_name_patterns": [r"Szóta"], "correction": "Helyesen: Szota."}, fh)
    bad_name_mail = {
        "tool_name": "mcp__server-gmail-autoauth-mcp__send_email",
        "tool_input": {"to": ["a@b.hu"], "subject": "Rendben",
                       "body": "Kedves Szóta Úr! Köszönjük a levelét, minden rendben van."},
    }
    code, _, err = run_gate(good, bad_name_mail)
    check("valid rules: a bad name is still BLOCKED (the gate still gates)",
          code == 2 and "HELYTELEN NEV" in err, f"exit={code} err={err[:150]!r}")
    code, out, _ = run_gate(good, CLEAN_MAIL)
    check("valid rules: a clean letter passes WITHOUT the missing-rules warning",
          code == 0 and "systemMessage" not in out, f"exit={code} out={out[:120]!r}")

    # --- telegram branch: unchanged fail-open on missing ------------------
    # No chat_id in the fixture: collect_telegram_body() reads only
    # text/caption/message, and a numeric chat_id trips the secret-gate's
    # "telegram update dump" detector (a false positive here, but the gate's
    # pattern must not be loosened for one test file).
    tg = {"tool_name": "mcp__plugin_telegram_telegram__reply",
          "tool_input": {"text": "Rendben, köszönöm szépen."}}
    code, out, _ = run_gate(missing, tg)
    check("telegram + missing rules: still fail-open with its own warning",
          code == 0 and "systemMessage" in out, f"exit={code}")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All rules-policy tests passed.")

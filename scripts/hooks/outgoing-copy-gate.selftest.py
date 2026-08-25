#!/usr/bin/env python3
"""Self-test for outgoing-copy-gate.py (card 3ec64c96).

Covers the two measured bugs:
  1. A missing/malformed name-rules file must still fail-closed on a REAL send, but a
     PRESENT, VALID file that deliberately declares zero bad-name patterns must not.
  2. The send-detector must not arm on prose that merely mentions an email vendor's domain (a
     kanban/inter-agent message, not an actual HTTP call). Fixed by adopting upstream's own
     `is_send_invocation()` (KAPUHATOKOR822) wholesale rather than shipping a narrower
     fork-local patch -- upstream had independently solved this exact class of false positive.

Each case runs the hook as a real subprocess (a fresh Python process per case, since
BAD_NAME is computed at module-import time from the OUTGOING_COPY_GATE_RULES env var), so
this exercises the actual CLI contract, not an in-process re-implementation of its logic.

Run:  python3 scripts/hooks/outgoing-copy-gate.selftest.py
Exit: 0 = all pass, 1 = at least one case wrong.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

GATE = Path(__file__).with_name("outgoing-copy-gate.py")

BLOCK = "block"
ALLOW = "allow"


def verdict(cmd, rules_path=None):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    env = dict(os.environ)
    if rules_path is not None:
        env["OUTGOING_COPY_GATE_RULES"] = str(rules_path)
    else:
        # Point at a definitely-nonexistent path rather than inheriting whatever the real
        # machine happens to have at store/outgoing-copy-gate-rules.json -- a case that
        # wants "file missing" must not accidentally see a real local file.
        env["OUTGOING_COPY_GATE_RULES"] = "/nonexistent/outgoing-copy-gate-rules.json"
    p = subprocess.run(
        [sys.executable, str(GATE)], input=payload, capture_output=True, text=True, env=env
    )
    return (BLOCK if p.returncode == 2 else ALLOW), (p.stderr or "").strip()


_rules_counter = [0]


def write_rules(tmpdir, content):
    # Unique filename per call -- three fixtures sharing one path in the same tmpdir would let
    # a later write silently overwrite an earlier one's file, which is exactly what happened in
    # an earlier draft of this test (all three named "rules.json") and made every case read the
    # LAST-written fixture regardless of which variable the test thought it was passing.
    _rules_counter[0] += 1
    p = Path(tmpdir) / f"rules-{_rules_counter[0]}.json"
    p.write_text(json.dumps(content), encoding="utf-8")
    return p


CLEAN_HU = "Szia, köszönöm a türelmet, hamarosan küldöm a fájlt."
BROKEN_HU = "Szia, koszonom a turelmet, hamarosan kuldom a fajlt."  # accents stripped

REAL_SEND = (
    'curl -s -X POST https://api.resend.com/emails '
    '-H "Authorization: Bearer $KEY" '
    '--to client@example.com '
    '--body "{body}"'
)
# The exact shape of the measured false positive: an inter-agent kanban-comment POST to the
# fleet's OWN dashboard API, whose JSON payload has an unrelated "to" ROUTING field and whose
# "content" text merely DESCRIBES a test requirement mentioning the vendor's domain in prose.
KANBAN_MESSAGE_FP = (
    'curl -s -X POST http://localhost:3420/api/messages '
    '-H "Content-Type: application/json" '
    '-d \'{"from":"mikrob","to":"backend2","content":"valodi api.resend.com kuldes '
    'tovabbra is fennakadjon (regressziosteszt-kovetelmenykent)"}\''
)


def main():
    failures = []

    def case(label, cmd, expected, rules_path=None):
        got, stderr = verdict(cmd, rules_path)
        ok = got == expected
        print(f"{'OK  ' if ok else 'FAIL'} {expected:5s} <- {got:5s}  {label}")
        if not ok:
            failures.append((label, expected, got, stderr))

    with tempfile.TemporaryDirectory() as tmp:
        empty_rules = write_rules(tmp, {"bad_name_patterns": [], "correction": ""})
        named_rules = write_rules(
            tmp, {"bad_name_patterns": ["Kovacz"], "correction": "helyesen: Kovács"}
        )
        malformed_rules = write_rules(tmp, {"correction": "no bad_name_patterns key at all"})

        # --- Bug 1: rules-file sentinel -----------------------------------------------
        case(
            "missing rules file + real send -> fail-closed BLOCK (unchanged intent)",
            REAL_SEND.format(body=CLEAN_HU),
            BLOCK,
            rules_path=None,
        )
        case(
            "malformed rules file (no bad_name_patterns key) -> still fail-closed BLOCK",
            REAL_SEND.format(body=CLEAN_HU),
            BLOCK,
            rules_path=malformed_rules,
        )
        case(
            "PRESENT, VALID, EMPTY bad_name_patterns -> real send with clean copy now ALLOWs",
            REAL_SEND.format(body=CLEAN_HU),
            ALLOW,
            rules_path=empty_rules,
        )
        case(
            "empty-patterns file does not disable the OTHER checks -- broken accents still BLOCK",
            REAL_SEND.format(body=BROKEN_HU),
            BLOCK,
            rules_path=empty_rules,
        )
        case(
            "a real bad-name pattern still fires with a populated rules file",
            REAL_SEND.format(body="Szia Kovacz Bela, koszonom."),
            BLOCK,
            rules_path=named_rules,
        )
        case(
            "the same body WITHOUT the bad name passes with the same populated rules file",
            REAL_SEND.format(body=CLEAN_HU),
            ALLOW,
            rules_path=named_rules,
        )

        # --- Bug 2: SEND_CMD URL-anchoring ----------------------------------------------
        case(
            "093a9914-shape: a kanban message describing a test requirement in prose -> ALLOW",
            KANBAN_MESSAGE_FP,
            ALLOW,
            rules_path=empty_rules,
        )
        case(
            "a REAL resend.com send with broken accents is still caught (URL-anchored, not lost)",
            REAL_SEND.format(body=BROKEN_HU),
            BLOCK,
            rules_path=empty_rules,
        )
        case(
            "a REAL resend.com send with clean accents still passes",
            REAL_SEND.format(body=CLEAN_HU),
            ALLOW,
            rules_path=empty_rules,
        )
        case(
            "bare domain with NO scheme still catches, via upstream's is_send_invocation "
            "(closes the gap this fork's own first-draft URL-anchoring patch would have left)",
            'curl -s api.resend.com/emails -d \'{"to":"x@y.com"}\' --body "' + BROKEN_HU + '"',
            BLOCK,
            rules_path=empty_rules,
        )
        case(
            "other send alternatives still work through is_send_invocation",
            'support-mail/send.py --to test@example.com --body "' + BROKEN_HU + '"',
            BLOCK,
            rules_path=empty_rules,
        )
        case(
            "the sendmail alternative still works through is_send_invocation",
            'sendmail -t --to test@example.com <<\'EOF\'\n' + BROKEN_HU + '\nEOF',
            BLOCK,
            rules_path=empty_rules,
        )
        case(
            "prose mentioning send.py by name (no --to) is still not a send -- no recipient arg",
            'echo "a send.py szkriptet meg kell javitani"',
            ALLOW,
            rules_path=empty_rules,
        )

    if failures:
        print(f"\n{len(failures)} FAILED")
        for label, expected, got, stderr in failures:
            print(f"  {label}: expected {expected}, got {got}\n    stderr: {stderr[:300]}")
        sys.exit(1)

    print("\nAll cases passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()

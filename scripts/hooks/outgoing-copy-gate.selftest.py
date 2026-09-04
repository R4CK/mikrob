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
    return raw_verdict({"tool_name": "Bash", "tool_input": {"command": cmd}}, rules_path)


def raw_verdict(payload_obj, rules_path=None):
    """Run the gate on an ARBITRARY payload, not just a Bash command.

    Needed for the fail-closed net (card 630d9864): the payload shapes that used to crash the
    hook are malformed ones -- a tool_input that is not a dict -- which the Bash-shaped helper
    above cannot express.
    """
    payload = json.dumps(payload_obj)
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

        # --- RESENDGATE826: method-aware resend-target verdict (round 10, card fbb36b41) ---
        case(
            "RESENDGATE826: read-only GET domain-verification query passes (no body, safe method)",
            'curl -s -X GET https://api.resend.com/domains -H "Authorization: Bearer $KEY"',
            ALLOW,
            rules_path=empty_rules,
        )
        case(
            "RESENDGATE826: GET explicitly forced but a body flag is still present -> send, BLOCK",
            "curl -s -X GET https://api.resend.com/domains -d 'foo=bar'",
            BLOCK,
            rules_path=empty_rules,
        )
        case(
            "RESENDGATE826: undecidable method (shell variable) stays fail-closed BLOCK",
            'curl -s -X $METHOD https://api.resend.com/domains',
            BLOCK,
            rules_path=empty_rules,
        )
        case(
            "RESENDGATE826: implicit POST via -d with no -X is still a send, BLOCK",
            'curl -s https://api.resend.com/emails -d \'{"to":"x@y.com"}\'',
            BLOCK,
            rules_path=empty_rules,
        )

        # --- DIGIT-HYPHEN SUFFIX: numeric Hungarian suffix is not a prose word (round 10) ---
        case(
            "DIGIT-HYPHEN SUFFIX: '429-es'/'403-as' do not false-positive as unaccented words",
            REAL_SEND.format(
                body="Szia, 429-es vagy 403-as hibát kaptunk, köszönöm a türelmet."
            ),
            ALLOW,
            rules_path=empty_rules,
        )
        case(
            "DIGIT-HYPHEN SUFFIX does not mask a REAL accent error elsewhere in the same body",
            REAL_SEND.format(body="Szia, 429-es hiba volt, koszonom a turelmet."),
            BLOCK,
            rules_path=empty_rules,
        )

        # --- Cybersec round 11 NO-GO: two REAL bypasses in the round-10 fixes ---
        case(
            "RESENDGATE826 r11: -G + --data-urlencode is a real send (query-string exfil trick), BLOCK",
            "curl -s -G https://api.resend.com/emails "
            "--data-urlencode 'to=client@example.com' --data-urlencode 'subject=hi'",
            BLOCK,
            rules_path=empty_rules,
        )
        case(
            "RESENDGATE826 r11: -G alone (no body) is still a legitimate read, ALLOW",
            "curl -s -G https://api.resend.com/domains -H \"Authorization: Bearer $KEY\"",
            ALLOW,
            rules_path=empty_rules,
        )
        case(
            "DIGIT-HYPHEN SUFFIX r11: a multi-letter REAL word glued after digit-hyphen is still caught",
            REAL_SEND.format(body="A dokumentum 5-keszen van, kuldheted."),
            BLOCK,
            rules_path=empty_rules,
        )
        case(
            "DIGIT-HYPHEN SUFFIX r11: second reproduction, same shape, still caught",
            REAL_SEND.format(body="Az uzenet 1-keszen elment mar."),
            BLOCK,
            rules_path=empty_rules,
        )

        # --- Fail-closed net on the __main__ wrapper (B-wave, card 630d9864) -------------
        # Upstream's wrapper, recorded in the conflict map as "a candidate for future adoption,
        # not yet taken", and MEASURED before adopting: a payload whose tool_input is not a dict
        # made collect_mcp_body() raise AttributeError, python exited 1, and PreToolUse treats 1
        # as NON-blocking -- so a malformed call walked straight past the gate. Note what the
        # verdict helper reports: exit 1 reads as ALLOW here, which is precisely the point.
        def raw_case(label, payload_obj, expected, rules_path=None):
            got, stderr = raw_verdict(payload_obj, rules_path)
            ok = got == expected
            print(f"{'OK  ' if ok else 'FAIL'} {expected:5s} <- {got:5s}  {label}")
            if not ok:
                failures.append((label, expected, got, stderr))

        raw_case(
            "FAIL-CLOSED NET: non-dict tool_input on the email path -> BLOCK (was exit 1 = unchecked send)",
            {"tool_name": "send_email", "tool_input": "not-a-dict"},
            BLOCK,
            rules_path=empty_rules,
        )
        raw_case(
            "FAIL-CLOSED NET: a NUMBER as tool_input crashes the same way -> BLOCK",
            {"tool_name": "send_email", "tool_input": 42},
            BLOCK,
            rules_path=empty_rules,
        )
        # The net must NOT reach the Telegram branch: telegram_gate() is fail-OPEN by design,
        # because Telegram is the owner's only supervision channel and silencing it costs more
        # than a slipped accent. It catches its own errors and exits 0 before the net can see them.
        raw_case(
            "FAIL-OPEN PRESERVED: the same malformed payload on the TELEGRAM path still passes",
            {"tool_name": "mcp__telegram__reply", "tool_input": "not-a-dict"},
            ALLOW,
            rules_path=empty_rules,
        )
        raw_case(
            "the net does not over-block: a well-formed clean email still passes",
            {
                "tool_name": "send_email",
                "tool_input": {"body": "Szia, köszönöm a türelmet, hamarosan küldöm a fájlt."},
            },
            ALLOW,
            rules_path=empty_rules,
        )
        raw_case(
            "the net does not mask a real finding: a well-formed email with broken accents still BLOCKs",
            {
                "tool_name": "send_email",
                "tool_input": {"body": "Szia, koszonom a turelmet, hamarosan kuldom a fajlt."},
            },
            BLOCK,
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

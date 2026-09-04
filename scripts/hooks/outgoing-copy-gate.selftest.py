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


def verdict(cmd, rules_path=None, env_extra=None):
    return raw_verdict(
        {"tool_name": "Bash", "tool_input": {"command": cmd}}, rules_path, env_extra
    )


def raw_verdict(payload_obj, rules_path=None, env_extra=None):
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
    # Card 74181db2: the telegram-in-Bash branch is behind an env kill-switch, so a case
    # has to be able to set it. Cleared by DEFAULT rather than merely left alone -- the
    # real machine may have it exported, and a case asserting "off" must measure off.
    env.pop("OUTGOING_COPY_GATE_TELEGRAM_BASH", None)
    env.update(env_extra or {})
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

    def case(label, cmd, expected, rules_path=None, env_extra=None):
        got, stderr = verdict(cmd, rules_path, env_extra)
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

        # --- Telegram sent from Bash, behind the kill-switch (card 74181db2) -----------
        # A role agent has no `telegram__reply` tool (all 15 launch with the plugin false and
        # without --channels), so the gate's tool-name branch is dead code for them. Their one
        # route is the raw Bot API call `telegram-reply-fallback` documents -- and nothing ran
        # on it. These cases pin BOTH halves: that the switch really is off by default, and
        # that with it on the audit is the same one the MCP path gets.
        ON = {"OUTGOING_COPY_GATE_TELEGRAM_BASH": "on"}
        TG_SEND = 'curl -s -X POST https://api.telegram.org/botPLACEHOLDER/sendMessage -d chat_id=1 '

        # THE DEFAULT IS THE LOAD-BEARING CASE. Wiring this hook costs a python start on every
        # Bash call of every role agent (measured median 23.5 ms), so an unset variable must
        # mean OFF -- the inverse of the `<GUARD>=off` convention the other guards use.
        case(
            "SWITCH DEFAULT OFF: broken accents in a Bot API send pass untouched",
            TG_SEND + f'-d "text={BROKEN_HU}"',
            ALLOW,
            rules_path=empty_rules,
        )
        case(
            "switch on: the SAME send now blocks on the stripped accents",
            TG_SEND + f'-d "text={BROKEN_HU}"',
            BLOCK,
            rules_path=empty_rules,
            env_extra=ON,
        )
        case(
            "switch on: clean Hungarian passes -- the gate is not a blanket refusal",
            TG_SEND + f'-d "text={CLEAN_HU}"',
            ALLOW,
            rules_path=empty_rules,
            env_extra=ON,
        )
        case(
            "switch on: an em dash blocks (standing rule, never goes out)",
            TG_SEND + '--data-urlencode "text=A jelentés kész \u2014 küldöm."',
            BLOCK,
            rules_path=empty_rules,
            env_extra=ON,
        )
        case(
            "switch on: a JSON body is read too, not only form fields",
            # chat_id stays a FORM field here on purpose: the repo's secret-gate reads a
            # literal chat_id+text JSON object as a captured channel dump and blocks the
            # commit. Rewording the fixture is the right answer (the alternative, allowlisting
            # the path, would stop scanning this file for real secrets forever), and it costs
            # the test nothing -- the JSON branch under test only looks for the "text" key.
            TG_SEND + f'-H "Content-Type: application/json" -d \'{{"text":"{BROKEN_HU}"}}\'',
            BLOCK,
            rules_path=empty_rules,
            env_extra=ON,
        )
        case(
            "switch on: a photo CAPTION is audited like message text",
            'curl https://api.telegram.org/bot1/sendPhoto -F photo=@/tmp/a.png '
            f'-F "caption={BROKEN_HU}"',
            BLOCK,
            rules_path=empty_rules,
            env_extra=ON,
        )
        # --- and the three ways it must NOT fire ---------------------------------------
        case(
            "switch on: a photo with NO caption has nothing to audit",
            'curl https://api.telegram.org/bot1/sendPhoto -F photo=@/tmp/a.png',
            ALLOW,
            rules_path=empty_rules,
            env_extra=ON,
        )
        case(
            "switch on: MENTIONING the host is not sending -- both halves are required",
            'grep -rn api.telegram.org /home/neon/marveen/store',
            ALLOW,
            rules_path=empty_rules,
            env_extra=ON,
        )
        case(
            "switch on: a READ method (getUpdates) is not a send",
            'curl -s https://api.telegram.org/bot1/getUpdates',
            ALLOW,
            rules_path=empty_rules,
            env_extra=ON,
        )
        # THE CASE THAT ACTUALLY PINS THE METHOD REQUIREMENT. The one above does not: with the
        # method check removed it still passes, because a bare getUpdates carries no text to
        # audit either way -- found by mutating, and a finding about the test, not the code.
        # This one carries a `text=` field that WOULD be audited (its accents are stripped), so
        # dropping the method half turns it from allow into block.
        case(
            "switch on: a non-send method is not a send EVEN with an auditable text field",
            f'curl -s https://api.telegram.org/bot1/getUpdates -d "text={BROKEN_HU}"',
            ALLOW,
            rules_path=empty_rules,
            env_extra=ON,
        )
        # FAIL-OPEN, and deliberately unlike the email path. Email refuses what it cannot
        # inspect because a letter can wait; Telegram is the owner's only supervision channel,
        # so blocking a report because its text sits in a variable trades a spelling rule for a
        # lost message. The refusal is announced via systemMessage rather than silent.
        case(
            "switch on: an UNREADABLE body ($VAR) passes -- fail-OPEN, like the MCP telegram path",
            TG_SEND + '-d "text=$MSG"',
            ALLOW,
            rules_path=empty_rules,
            env_extra=ON,
        )
        # THE OVER-FIRE CASE, and it is here because the first version of this change FAILED it.
        # The telegram detector needs only the host plus a send method ANYWHERE in the command,
        # which an email whose BODY quotes that URL satisfies. With the telegram branch checked
        # first, its fail-OPEN verdict hijacked the email path's fail-CLOSED one: measured at
        # exit 0 (sent unchecked) on a resend.com call with stripped accents. Email is now
        # tested first, so anything that looks like both is handled as the email it is.
        case(
            "an EMAIL whose body merely MENTIONS the Bot API url is still audited as email",
            REAL_SEND.format(
                body="Kesz a jelentes, reszletek a https://api.telegram.org/bot1/sendMessage vegponton"
            ),
            BLOCK,
            rules_path=empty_rules,
            env_extra=ON,
        )
        # The email path must be untouched by all of the above: same command shape, different
        # host, and it still fails CLOSED on an unreadable body.
        case(
            "the EMAIL path keeps its fail-CLOSED behaviour on an unreadable body",
            REAL_SEND.format(body="$(cat /tmp/letter.txt)"),
            BLOCK,
            rules_path=empty_rules,
        )

        def raw_case(label, payload_obj, expected, rules_path=None, env_extra=None):
            got, stderr = raw_verdict(payload_obj, rules_path, env_extra)
            ok = got == expected
            print(f"{'OK  ' if ok else 'FAIL'} {expected:5s} <- {got:5s}  {label}")
            if not ok:
                failures.append((label, expected, got, stderr))

        # --- ONE TYPO'D PATTERN MUST NOT KILL THE HOOK (card 0c66be37) ------------------
        # Cybersec MEDIUM-2, reproduced here before fixing: `re.compile` sat OUTSIDE the try, and
        # `BAD_NAME = load_bad_name()` runs at MODULE IMPORT -- so one bad pattern did not degrade
        # the name check, it killed the whole hook before it inspected anything. Exit 1 with empty
        # stdout, and Claude Code blocks on exit 2 ONLY: every outgoing send passed unchecked,
        # fleet-wide, silently. Note the helper reads exit 1 as ALLOW, which is exactly the point.
        broken_pat_rules = write_rules(
            tmp, {"bad_name_patterns": ["Kovacz", "(?<n>x)"], "correction": "helyesen: Kovacs"}
        )
        case(
            "a non-compiling pattern degrades the NAME CHECK, not the whole hook (email: fail-CLOSED)",
            REAL_SEND.format(body=CLEAN_HU),
            BLOCK,
            rules_path=broken_pat_rules,
        )
        # ...and the control itself still works when the patterns are fine. Without this the case
        # above would pass over a hook that blocks everything for any reason at all.
        case(
            "...and a VALID rules file still lets a clean letter through",
            REAL_SEND.format(body=CLEAN_HU),
            ALLOW,
            rules_path=named_rules,
        )
        raw_case(
            "the same bad pattern on the TELEGRAM path stays fail-OPEN (supervision channel)",
            {"tool_name": "mcp__plugin_telegram_telegram__reply", "tool_input": {"text": CLEAN_HU}},
            ALLOW,
            rules_path=broken_pat_rules,
        )

        # THE MESSAGE MUST NAME THE RIGHT CAUSE. Both failures end in the same refusal, so the
        # exit code alone cannot tell them apart -- and the only wording used to be "a fajl
        # hianyzik/ures", which for a bad pattern sends the reader hunting for a file that is
        # present, readable and valid JSON. A wrong explanation is worse than none: it stops the
        # next person looking.
        def msg_says(label, rules_path, must_have, must_not_have):
            _got, stderr = verdict(REAL_SEND.format(body=CLEAN_HU), rules_path)
            ok = (must_have in stderr) and (must_not_have not in stderr)
            print(f"{'OK  ' if ok else 'FAIL'} {'msg':5s} <- {'msg':5s}  {label}")
            if not ok:
                failures.append((label, f"contains {must_have!r}, not {must_not_have!r}", stderr[:160], stderr))

        msg_says("a BAD PATTERN is reported as a bad pattern, not as a missing file",
                 broken_pat_rules, "nem forditható", "hianyzik")
        msg_says("...and a genuinely MISSING file is still reported as missing",
                 "/nonexistent/outgoing-copy-gate-rules.json", "hianyzik", "nem forditható")

        # --- A PATTERN CAN COMPILE AND STILL HANG (same card, the other door) ------------
        # Measured before the budget: `zzz(a+)+$` against a body carrying `zzz` + 40 `a`s left the
        # hook STILL RUNNING after 25 seconds. Registered with `timeout: 10`, Claude Code kills it,
        # the exit code is not 2, and the send goes out unchecked -- byte-identical to the compile
        # crash. The validator cannot catch it either: its ReDoS check is PROBE-based, so a pattern
        # anchored behind a rare prefix passes validation and is slow only on real traffic.
        slow_pat_rules = write_rules(
            tmp, {"bad_name_patterns": ["Kovacz", "zzz(a+)+$"], "correction": "helyesen: Kovacs"}
        )
        SLOW_BODY = "Szia, koszonom a turelmet. zzz" + ("a" * 40) + "X"
        case(
            "a catastrophically backtracking pattern is BOUNDED, and email fails CLOSED",
            REAL_SEND.format(body=SLOW_BODY),
            BLOCK,
            rules_path=slow_pat_rules,
            env_extra={"OUTGOING_COPY_GATE_NAME_BUDGET": "1"},
        )
        raw_case(
            "...and the same timeout on TELEGRAM stays fail-OPEN rather than silencing the channel",
            {"tool_name": "mcp__plugin_telegram_telegram__reply", "tool_input": {"text": SLOW_BODY}},
            ALLOW,
            rules_path=slow_pat_rules,
            env_extra={"OUTGOING_COPY_GATE_NAME_BUDGET": "1"},
        )

        # --- NOTHING READ AT IMPORT MAY KILL THE HOOK (card 0c66be37, Cybersec NO-GO) ----
        # This battery exists because I introduced the SAME defect class twice in the same commit.
        # The card was "one typo'd pattern must not kill the hook"; my fix then added
        # `NAME_MATCH_BUDGET_S = float(os.environ.get(...))` at MODULE level, so `BUDGET=abc` raised
        # ValueError at import -- exit 1, zero stdout, the whole hook silently absent on every
        # agent. Measured before fixing: `2` -> exit 2, `abc` / empty / a single space -> exit 1.
        #
        # So this is not another one-off patch: it enumerates EVERY environment knob the module
        # reads while importing, with values chosen to break a naive parse, and asserts the hook
        # still reaches a verdict. Exit 1 reads as ALLOW here, which is exactly what makes the
        # failure invisible in production and visible in this table.
        def reaches_a_verdict(label, env_extra=None, rules_path=None):
            """Assert the hook RAN. Exit 0 and 2 are verdicts; exit 1 is the module dying.

            The BLOCK/ALLOW helper cannot express this -- it maps every non-2 code to ALLOW, which
            is exactly why the production failure was invisible: a hook that never started looks
            like a hook that looked and had no objection.
            """
            nonlocal failures
            payload = json.dumps({"tool_name": "Bash", "tool_input": {
                "command": REAL_SEND.format(body=CLEAN_HU)}})
            env = dict(os.environ)
            env.pop("OUTGOING_COPY_GATE_TELEGRAM_BASH", None)
            env["OUTGOING_COPY_GATE_RULES"] = str(rules_path if rules_path is not None else named_rules)
            env.update(env_extra or {})
            p = subprocess.run([sys.executable, str(GATE)], input=payload,
                               capture_output=True, text=True, env=env)
            ok = p.returncode in (0, 2)
            print(f"{'OK  ' if ok else 'FAIL'} {'ran':5s} <- {'exit%d' % p.returncode:5s}  {label}")
            if not ok:
                failures.append((label, "exit 0 or 2 (a verdict)", f"exit {p.returncode}", p.stderr))

        for value in ["abc", "", " ", "-1", "0", "nan", "inf", "1e400", "2.5", "off", "true", "[]"]:
            reaches_a_verdict(f"import survives OUTGOING_COPY_GATE_NAME_BUDGET={value!r}",
                              env_extra={"OUTGOING_COPY_GATE_NAME_BUDGET": value})
        # A HOSTILE VALUE MUST NOT SILENTLY DISABLE THE BUDGET, only fall back to the default.
        # Found by mutating: with `except ValueError: return 0.0` (or with non-positive values
        # meaning "no timer"), every case above still passed -- they only prove the module IMPORTS,
        # not that the protection survived. So the docstring's claim, that a typo can cost
        # protection nowhere, was an unmeasured assertion. This is the case that measures it: a
        # catastrophic pattern with a garbage budget must still be BOUNDED, not hang.
        case(
            "a garbage budget falls back to the default -- it does NOT turn the timer off",
            REAL_SEND.format(body=SLOW_BODY),
            BLOCK,
            rules_path=slow_pat_rules,
            env_extra={"OUTGOING_COPY_GATE_NAME_BUDGET": "abc"},
        )
        case(
            "...and neither does a NEGATIVE one (disabling has to be said, with `off`)",
            REAL_SEND.format(body=SLOW_BODY),
            BLOCK,
            rules_path=slow_pat_rules,
            env_extra={"OUTGOING_COPY_GATE_NAME_BUDGET": "-1"},
        )

        # The other import-time knob. It feeds a PATH resolution rather than a number, so the
        # failure shape differs -- but a hook that dies reading it is just as absent.
        for value in ["", " ", "/nonexistent/deep/path.json", "relative.json"]:
            reaches_a_verdict(f"import survives OUTGOING_COPY_GATE_RULES={value!r}", rules_path=value)

        # --- Fail-closed net on the __main__ wrapper (B-wave, card 630d9864) -------------
        # Upstream's wrapper, recorded in the conflict map as "a candidate for future adoption,
        # not yet taken", and MEASURED before adopting: a payload whose tool_input is not a dict
        # made collect_mcp_body() raise AttributeError, python exited 1, and PreToolUse treats 1
        # as NON-blocking -- so a malformed call walked straight past the gate. Note what the
        # verdict helper reports: exit 1 reads as ALLOW here, which is precisely the point.
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

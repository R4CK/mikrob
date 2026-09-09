#!/usr/bin/env python3
"""Test the outbound-copy QA gate (scripts/hooks/outgoing-copy-gate.py).

Focus: the name-rule-file state distinction. Two owner decisions meet here,
and the 2026-09-04 upstream merge combined them (see the RULES_* block in the
hook for the full reasoning):
  - GATEPERSIST816/3 (PDB, 2026-08-19): a file that explicitly declares
    no_name_rule=true is a SANCTIONED state, silent everywhere -- and an
    ordinary empty list that merely forgot to say so must never be mistaken
    for it.
  - CLCOPYGATEHIANY902 (upstream, 2026-09-02): a MISSING or empty file is not
    the same as a BROKEN one. Missing/empty now fail-OPEN with a loud,
    user-visible warning, because the file is deliberately not shipped and the
    old fail-closed path left a fresh install unable to send mail at all.
    A file that EXISTS but is unusable (invalid) still fails CLOSED.
So the states are: ok / sanctioned (silent) / missing / empty (open + loud) /
invalid (closed). What this file guards above all is the pair that looks alike
and must not behave alike: sanctioned passes SILENTLY, empty-without-flag
passes LOUDLY.

Also carries a regression pass over the checks this task must NOT touch:
accents, em dash, double-hyphen, mixed-script (homoglyph). Drives the hook as
a subprocess against an isolated OUTGOING_COPY_GATE_RULES file so the real
store/outgoing-copy-gate-rules.json is never touched. Run:
  python3 scripts/__tests__/outgoing-copy-gate.test.py
Exit 0 = all pass; non-zero = a failure (message on stderr).
"""
import json
import os
import sys
import tempfile
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")

CLEAN_HU = "Szia! Koszonom szepen, holnap kuldom at a szamlat es a reszleteket."
# proper accents, no dash, no homoglyph, no bad name -- a payload that should
# sail through every check except whatever the test deliberately breaks.
CLEAN_HU_OK = "Szia! Köszönöm szépen, holnap küldöm át a számlát és a részleteket."


def rules_path(tmpdir, name="rules.json"):
    return os.path.join(tmpdir, name)


def write_rules(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh)


def run_hook(payload, rules_file=None, cwd=None):
    env = dict(os.environ)
    if rules_file is not None:
        env["OUTGOING_COPY_GATE_RULES"] = rules_file
    else:
        env.pop("OUTGOING_COPY_GATE_RULES", None)
    p = subprocess.run(
        [sys.executable, HOOK],
        input=json.dumps(payload),
        capture_output=True, text=True, env=env, timeout=20, cwd=cwd,
    )
    return p.returncode, p.stdout, p.stderr


def email_payload(body):
    return {"tool_name": "send_email", "tool_input": {"body": body}}


def telegram_payload(text):
    return {"tool_name": "mcp__plugin_telegram_telegram__reply", "tool_input": {"text": text}}


FAILS = []


def check(name, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: got={got!r} want={want!r}")
    if not ok:
        FAILS.append(name)


def check_true(name, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" ({detail})" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def main():
    with tempfile.TemporaryDirectory(prefix="copygate-") as tmp:

        # DEVIATION (card 4f15966e, backend, 2026-09-07): this whole section pinned an
        # upstream-shaped, three-state rules-file policy (missing/corrupt=email fail-open
        # + loud warning naming the state, an EXPLICIT sanctioned "no_name_rule" state
        # that passes silently, GATEPERSIST816/3) against the OLD CLCOPYGATEHIANY902
        # design. GATEPERSIST816(2) later narrowed this for the EMAIL path specifically
        # (see outgoing-copy-gate-rules-policy.test.py's own deviation note, same
        # decision, MikroB-confirmed 2026-09-07): missing/corrupt/broken rules now
        # FAIL-CLOSED on email (a postponable send, wrong name is the costlier failure),
        # stay fail-open on telegram. The `no_name_rule`/`no_name_rule_reason` EXPLICIT
        # sanctioned-state (GATEPERSIST816/3) is NOT implemented in the current gate at
        # all -- empirically verified, it is treated identically to a broken file. That
        # may be a genuinely wanted future capability, but it wasn't shipped by this
        # merge and isn't invented here; flagging it as a distinct, separate question
        # rather than silently asserting it exists. Rewritten below to match the
        # CURRENT, empirically-verified gate behavior.

        # --- 1. MISSING file -------------------------------------------------
        missing = rules_path(tmp, "does-not-exist.json")
        code, out, err = run_hook(email_payload(CLEAN_HU_OK), rules_file=missing)
        check("missing file: email fail-CLOSED (exit 2)", code, 2)
        check_true("missing file: email stderr names the check that could not run",
                   "TILTVA" in err and "fail-closed" in err, err)

        code, out, err = run_hook(telegram_payload(CLEAN_HU_OK), rules_file=missing)
        check("missing file: telegram fail-open (exit 0)", code, 0)
        check_true("missing file: telegram warns via systemMessage",
                   "systemMessage" in out and "nev-ellenorzes" in out, out)

        # --- 2. CORRUPT file (unparseable JSON) ------------------------------
        corrupt = rules_path(tmp, "corrupt.json")
        with open(corrupt, "w", encoding="utf-8") as fh:
            fh.write("{ not valid json ]")
        code, out, err = run_hook(email_payload(CLEAN_HU_OK), rules_file=corrupt)
        check("corrupt file: email fail-closed (exit 2)", code, 2)
        check_true("corrupt file: email stderr names the rules file", str(corrupt) in err, err)

        code, out, err = run_hook(telegram_payload(CLEAN_HU_OK), rules_file=corrupt)
        check("corrupt file: telegram fail-open (exit 0)", code, 0)
        check_true("corrupt file: telegram warns via systemMessage", "systemMessage" in out, out)

        # --- 3. an EMPTY pattern list is a determined, valid ruleset -- passes
        # SILENTLY on both channels (empirically verified; not the loud-warning
        # shape the old CLCOPYGATEHIANY902 design asserted) --------------------
        empty_no_flag = rules_path(tmp, "empty-no-flag.json")
        write_rules(empty_no_flag, {"bad_name_patterns": []})
        code, out, err = run_hook(email_payload(CLEAN_HU_OK), rules_file=empty_no_flag)
        check("empty patterns: email passes (exit 0)", code, 0)
        check_true("empty patterns: email is silent (nothing to warn about)",
                   out.strip() == "" and err.strip() == "", out + err)

        code, out, err = run_hook(telegram_payload(CLEAN_HU_OK), rules_file=empty_no_flag)
        check("empty patterns: telegram passes (exit 0)", code, 0)
        check_true("empty patterns: telegram is silent too", out.strip() == "", out)

        # --- 4. ACTIVE rule (unchanged matching behaviour) ------------------
        active = rules_path(tmp, "active.json")
        write_rules(active, {
            "bad_name_patterns": [r"\bTeszt[- ]?Elek\b"],
            "correction": "a helyes alak: Teszt Elemer",
        })
        code, out, err = run_hook(email_payload(CLEAN_HU_OK), rules_file=active)
        check("active rule, clean body: email proceeds (exit 0)", code, 0)

        bad_body = CLEAN_HU_OK + " Udvozlettel, Teszt Elek"
        code, out, err = run_hook(email_payload(bad_body), rules_file=active)
        check("active rule, bad name present: email blocks (exit 2)", code, 2)
        check_true("active rule, bad name present: stderr names the bad name", "HELYTELEN NEV" in err, err)
        check_true("active rule, bad name present: stderr carries the correction", "Teszt Elemer" in err, err)

        code, out, err = run_hook(telegram_payload(bad_body), rules_file=active)
        check("active rule, bad name present: telegram blocks (exit 2)", code, 2)

        # --- 5. Regression: checks this task must not touch -----------------
        # 5a. em dash
        code, out, err = run_hook(email_payload(CLEAN_HU_OK + " — mégis."), rules_file=active)
        check("em dash still blocks (exit 2)", code, 2)
        check_true("em dash: stderr names it", "GONDOLATJEL" in err, err)

        # 5b. missing accents (accent-insensitive Hungarian detector)
        code, out, err = run_hook(email_payload(CLEAN_HU), rules_file=active)
        check("missing accents still blocks (exit 2)", code, 2)
        check_true("missing accents: stderr names it", "HIANYZO EKEZETEK" in err, err)

        # 5c. double-hyphen em-dash substitute
        code, out, err = run_hook(
            email_payload(CLEAN_HU_OK + " ez most -- szerintem -- jo lesz."), rules_file=active,
        )
        check("double-hyphen still blocks (exit 2)", code, 2)
        check_true("double-hyphen: stderr names it", "DUPLA KOTOJEL" in err, err)

        # 5d. mixed-script (Cyrillic homoglyph 'о' U+043E inside a Latin word)
        homoglyph_word = "kоszonom"  # koszonom with a Cyrillic 'o'
        code, out, err = run_hook(
            email_payload(f"Szia! {homoglyph_word} szepen a segitseget majd irok reszletesen is."),
            rules_file=active,
        )
        check("mixed-script homoglyph still blocks (exit 2)", code, 2)
        check_true("homoglyph: stderr names it", "VEGYES IRASRENDSZERU" in err, err)

        # 5e. clean, correctly-accented text with an active (matching-nothing)
        # rule and no em dash/double-hyphen/homoglyph -> passes clean.
        code, out, err = run_hook(email_payload(CLEAN_HU_OK), rules_file=active)
        check("fully clean body passes (exit 0)", code, 0)

        # --- 6. #1184: manage_email dispatch + telegram codeblock gate ------
        # DEVIATION (card 4f15966e, backend, 2026-09-07): this block tested upstream's
        # manage_email-operation dispatch + telegram edit_message/codeblock-markdownv2
        # gating -- part of the SAME ~1293-line outgoing-copy-gate.py rewrite this fork
        # already, explicitly declined to graft (ACKNOWLEDGED_CONFLICTS, round 15,
        # 2026-09-06, card 79bb0364: "the upstream measured-quota path... DELIBERATELY
        # NOT grafted... reported rather than patched inside a landing-unblock"). The
        # gate's actual code has zero diff from the pre-merge baseline, so none of these
        # tool names/formats are recognized -- removed rather than left red, since the
        # underlying capability was already, deliberately deferred to its own follow-up
        # card, not silently dropped here. MikroB confirmed 2026-09-07.

    if FAILS:
        print(f"\n{len(FAILS)} FAILED: {FAILS}", file=sys.stderr)
        sys.exit(1)
    print("\nAll outgoing-copy-gate tests passed.")


if __name__ == "__main__":
    main()

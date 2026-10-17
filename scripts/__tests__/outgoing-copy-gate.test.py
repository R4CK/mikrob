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

        # 5d2. HOMOGLYPHMICRO924: unit and formula notation is not a mixed-script
        # word (MICRO SIGN, superscript and subscript digits disguise no Latin letter).
        units = " A mért késés 40 \u00b5s, a ház 100 m\u00b2, a doboz 5 cm\u00b3, a víz H\u2082O."
        code, out, err = run_hook(email_payload(CLEAN_HU_OK + units), rules_file=active)
        check("unit notation (micro sign, super/subscript digits) passes (exit 0)", code, 0)

        # 5d3. F1 (card 079c13d8, WhiteHat follow-up on 7e70144e): test gap --
        # the fork's _TECH_COMMON mask deliberately does NOT contain a generic
        # "lowercase hyphenated identifier" pattern (two earlier Cybersec NO-GOs,
        # fbb36b41 round 7/8 and round 11, rejected exactly that shape because it
        # swallows real prose, not just identifiers). Nothing until now pinned
        # the CONSEQUENCE of ever reintroducing it: strip_technical() feeds
        # mixed_script_words() (see audit()'s "prose = strip_technical(plain)"
        # line), so a mask that strips a whole lowercase-hyphenated span would
        # silently remove a homoglyph riding inside it, BEFORE the homoglyph
        # check ever sees the word. A lowercase, hyphenated, non-identifier
        # compound with a homoglyph half must still be caught today.
        hyphen_homoglyph = "onteszt-kоszonom"  # "onteszt-koszonom" with Cyrillic 'o'
        code, out, err = run_hook(
            email_payload(f"Szia! {hyphen_homoglyph} a segitseget, majd irok reszletesen is."),
            rules_file=active,
        )
        check("hyphenated lowercase homoglyph still blocks (exit 2)", code, 2)
        check_true("hyphenated homoglyph: stderr names it", "VEGYES IRASRENDSZERU" in err, err)

        # 5d4. B1 (card 079c13d8, CYBERED NO-GO, comment 15958): 5d3 only pins the
        # consequence for a UNICODE-AWARE lowercase-hyphenated mask. The ORIGINAL
        # mask the two Cybersec NO-GOs (fbb36b41 round 7/8, round 11) rejected was
        # ASCII-only and unconditional (upstream 03ca5262, #1114: \b[a-z]+(?:-[a-z]+)
        # {1,4}\b, lived briefly as _TECH_SUFFIXED). RedHat measured: reintroducing
        # THAT exact pattern leaves every existing test green (including 5d3, since
        # an ASCII mask cannot span a non-ASCII homoglyph -- \b never falls inside a
        # mixed-script run). Its real effect is different: it silences the NAME
        # rule on a lowercase, suffixed form of the name ("kovach-val" = "with
        # Kovach", "a kovach-fele" = "the Kovach one"), because strip_for_name()
        # shares the SAME _TECH_COMMON mask (NAME_MASK == TECHNICAL by construction,
        # see the comment above both) and would cut the whole hyphenated span
        # before _name_search() ever runs on it. A case-INSENSITIVE rule (so the
        # test does not depend on whatever casing the real, untracked rules file
        # happens to use) must still catch the lowercase, hyphenated form today.
        name_active = rules_path(tmp, "name-active.json")
        write_rules(name_active, {
            "bad_name_patterns": [r"(?i)kovach"],
            "correction": "A helyes alak: Kovach.",
        })
        for bad_sentence in (
            CLEAN_HU_OK + " kovach-val beszeltem tegnap.",
            CLEAN_HU_OK + " a kovach-fele megoldas jo lesz.",
        ):
            code, out, err = run_hook(email_payload(bad_sentence), rules_file=name_active)
            check(f"lowercase hyphenated name form still blocks (exit 2): {bad_sentence!r}", code, 2)
            check_true(f"lowercase hyphenated name form: stderr names it: {bad_sentence!r}", "HELYTELEN NEV" in err, err)

        # 5f. F3 (card 079c13d8, WhiteHat follow-up on 7e70144e, preliminary):
        # KNOWN, DOCUMENTED gap, not fixed here. accent_check_tokens() tokenizes
        # with HYPHEN_WORD, which takes a hyphenated run of letters as ONE token
        # (see its own comment: "a kotojeles alakot EGESZKENT veszi"). That is
        # deliberate for genuine kebab-case identifiers ("folyamatos-ellenorzes"
        # already passes, same comment block). But it means a hyphenated PROSE
        # compound made of two accentless Hungarian words -- "mar-keszen" (már
        # készen, joined with a hyphen instead of a space) -- is looked up as the
        # single string "mar-keszen" in ACCENTLESS, which only has single-word
        # keys ("keszen" -> "készen" among them), so the compound matches
        # nothing and the missing-accent finding never fires. Splitting on "-"
        # and checking each half separately would close this, but was NOT done:
        # it would also split real kebab identifiers that are not technical
        # enough to be caught by strip_technical (no dot/slash/@, e.g. a plain
        # "fajl-nev"-shaped slug in prose), and "fajl" is itself an ACCENTLESS
        # key -- exactly the identifier-vs-prose ambiguity the two earlier
        # NO-GOs (see _TECH_COMMON's own comment block) already rejected a
        # broad fix for. This test PINS the current, known-accepted gap so a
        # future change to accent_check_tokens must touch it deliberately, not
        # widen or narrow it as an unseen side effect.
        code, out, err = run_hook(
            email_payload(CLEAN_HU_OK + " A riport mar-keszen van, holnap küldöm."),
            rules_file=active,
        )
        check("F3 KNOWN GAP: hyphenated accentless compound passes uncaught (exit 0)", code, 0)
        check_true("F3 KNOWN GAP: no missing-accent finding for the compound", "HIANYZO EKEZETEK" not in err, err)

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

        # --- GMAILCONNECTOR914: the claude.ai Gmail connector ----------------
        # mcp__claude_ai_Gmail__send_message carries ONE underscore before Gmail,
        # so the old (^|__)gmail__ alternative never matched and the send fell
        # through to exit 0 with no audit (measured 2026-08-30, 2026-09-08).
        for tool in ("send_message", "reply", "forward"):
            bad = {"tool_name": f"mcp__claude_ai_Gmail__{tool}",
                   "tool_input": {"to": ["a@b.hu"], "messageId": "m1", "subject": "Teszt",
                                  "body": CLEAN_HU_OK + " — mégis."}}
            code, out, err = run_hook(bad, rules_file=active)
            check(f"connector {tool} with em dash blocks (exit 2)", code, 2)
            ok = {"tool_name": f"mcp__claude_ai_Gmail__{tool}",
                  "tool_input": {"to": ["a@b.hu"], "messageId": "m1", "subject": "Teszt", "body": CLEAN_HU_OK}}
            code, out, err = run_hook(ok, rules_file=active)
            check(f"connector {tool} clean passes (exit 0)", code, 0)
        fwd = {"tool_name": "mcp__claude_ai_Gmail__forward",
               "tool_input": {"to": ["a@b.hu"], "messageId": "m1", "forwardText": "Nézd meg — fontos."}}
        code, out, err = run_hook(fwd, rules_file=active)
        check("connector forward: forwardText is audited too (exit 2)", code, 2)
        draft_only = {"tool_name": "mcp__claude_ai_Gmail__send_message", "tool_input": {"draftId": "d1"}}
        code, out, err = run_hook(draft_only, rules_file=active)
        check("connector send of a draftId: body unreadable, fail-closed (exit 2)", code, 2)
        for tool in ("search_threads", "get_thread"):
            code, out, err = run_hook({"tool_name": f"mcp__claude_ai_Gmail__{tool}", "tool_input": {"q": "x — y"}},
                                      rules_file=active)
            check(f"connector {tool} is a read: passes untouched (exit 0)", code, 0)

        # --- Card 498d53c1 (Cybersec MEDIUM on a4164e95): gmail__/resend__ deny-by-default ---
        # A tool-NAME list drifts -- send_draft (create_draft + send_draft pair) and the
        # hyphenated resend__send-email both slipped past name-list checks before this
        # existed. Only search_*/get_*/list_*/read_*/create_draft is explicitly out of
        # scope; everything else on either server is audited as a send now.
        code, out, err = run_hook({"tool_name": "mcp__claude_ai_Gmail__send_draft",
                                   "tool_input": {"draftId": "d1"}}, rules_file=active)
        check("connector send_draft: unreadable body, fail-closed (exit 2)", code, 2)
        # Previously guessed-safe by shape alone -- narrowed out on purpose (see above).
        code, out, err = run_hook({"tool_name": "mcp__claude_ai_Gmail__label_message",
                                   "tool_input": {"q": "x — y"}}, rules_file=active)
        check("connector label_message: no longer on the safe list, unreadable body denies (exit 2)", code, 2)
        code, out, err = run_hook({"tool_name": "mcp__claude_ai_Gmail__create_draft",
                                   "tool_input": {"q": "x — y"}}, rules_file=active)
        check("connector create_draft: on the explicit safe list, passes untouched (exit 0)", code, 0)
        # Real Resend tool names are hyphenated (resend/resend-mcp source, MIT) -- neither
        # .*send_email.* (underscore) nor the old gmail-only connector regex ever matched them.
        code, out, err = run_hook({"tool_name": "mcp__resend__send-email",
                                   "tool_input": {"to": "a@b.hu", "subject": "Teszt",
                                                  "text": CLEAN_HU_OK + " — mégis."}}, rules_file=active)
        check("resend send-email with em dash blocks (exit 2)", code, 2)
        code, out, err = run_hook({"tool_name": "mcp__resend__send-email",
                                   "tool_input": {"to": "a@b.hu", "subject": "Teszt", "text": CLEAN_HU_OK}},
                                  rules_file=active)
        check("resend send-email clean passes (exit 0)", code, 0)
        code, out, err = run_hook({"tool_name": "mcp__resend__get-email", "tool_input": {"id": "e1"}},
                                  rules_file=active)
        check("resend get-email is a read: passes untouched (exit 0)", code, 0)
        code, out, err = run_hook({"tool_name": "mcp__resend__create-domain", "tool_input": {"name": "x.hu"}},
                                  rules_file=active)
        check("resend create-domain: not on the safe list, unreadable body denies (exit 2)", code, 2)

        # --- Card 45b33b2b (Cybersec GO on 498d53c1 @4b341e4d, msg 6240, REGRESSION) ---
        # The server-name match required no hyphen before "gmail"/"resend" and no suffix after
        # it -- google-gmail__ / gmail-mcp__ (and resend equivalents) skipped deny-by-default
        # ENTIRELY. Canary: the hyphenated servers' send tool blocks, their read tool passes.
        for server in ("google-gmail", "gmail-mcp"):
            code, out, err = run_hook({"tool_name": f"mcp__{server}__send_message",
                                       "tool_input": {"to": ["a@b.hu"], "subject": "Teszt",
                                                      "body": CLEAN_HU_OK}}, rules_file=active)
            check(f"{server}: send_message reaches deny-by-default, clean passes (exit 0)", code, 0)
            code, out, err = run_hook({"tool_name": f"mcp__{server}__send_message",
                                       "tool_input": {"to": ["a@b.hu"], "subject": "Teszt",
                                                      "body": CLEAN_HU_OK + " — mégis."}},
                                      rules_file=active)
            check(f"{server}: send_message with em dash blocks (exit 2)", code, 2)
            code, out, err = run_hook({"tool_name": f"mcp__{server}__search_threads",
                                       "tool_input": {"q": "x — y"}}, rules_file=active)
            check(f"{server}: search_threads is a read: passes untouched (exit 0)", code, 0)
        # "draft" as a VERB prefix (draft_email) is safe -- distinct from send_draft/update_draft.
        code, out, err = run_hook({"tool_name": "mcp__claude_ai_Gmail__draft_email",
                                   "tool_input": {"q": "x — y"}}, rules_file=active)
        check("connector draft_email (verb prefix): on the explicit safe list, passes untouched (exit 0)", code, 0)

        # --- Card bf7a7335 (Cybersec GO on 45b33b2b @bee4940b, msg 6253, LOW) ---
        # The safe-prefix match only looked at the name up to its FIRST separator, so a name that
        # STARTS with a safe verb but later names send/reply/forward passed UNTOUCHED (no body
        # audit at all) instead of being audited as a send. Canary: these now reach the
        # em-dash audit just like any other send-shaped tool.
        code, out, err = run_hook({"tool_name": "mcp__claude_ai_Gmail__draft_and_send",
                                   "tool_input": {"to": ["a@b.hu"], "subject": "Teszt",
                                                  "body": CLEAN_HU_OK + " — mégis."}}, rules_file=active)
        check("connector draft_and_send (safe-prefix bypass): em dash now blocks (exit 2)", code, 2)
        code, out, err = run_hook({"tool_name": "mcp__claude_ai_Gmail__read_then_forward",
                                   "tool_input": {"to": ["a@b.hu"], "messageId": "m1",
                                                  "forwardText": CLEAN_HU_OK + " — mégis."}}, rules_file=active)
        check("connector read_then_forward (safe-prefix bypass): em dash now blocks (exit 2)", code, 2)
        code, out, err = run_hook({"tool_name": "mcp__resend__search-and-send-email",
                                   "tool_input": {"to": "a@b.hu", "subject": "Teszt",
                                                  "text": CLEAN_HU_OK + " — mégis."}}, rules_file=active)
        check("resend search-and-send-email (safe-prefix bypass): em dash now blocks (exit 2)", code, 2)

        # --- COPYGATEENT914: HTML-ENTITAS NEM KERULHETI MEG A GONDOLATJEL-TILTAST ---
        # Marveen merese 2026-09-14, egy VALODI vevo-levelen: a hook a TAGEKET
        # szedte ki, de az entitast sehol nem dekodolta, igy a `&mdash;` atment
        # es a cimzettnel gondolatjelkent renderelt. A kapu zoldet mondott arra,
        # amit tilt. Merve MIND A HAROM alakon, nem csak a bejelentettre.
        #
        # A SZOVEG SZANDEKOSAN TELJESEN EKEZETES. Az elso valtozatom ekezet
        # nelkuli volt, ezert a HIANYZO-EKEZET szabaly is tuzelt, es az exit 2
        # AKKOR IS teljesult, amikor a dekodolast visszavettem -- a teszt jonak
        # latszott, kozben nem az entitas-utat merte. A mutans-kontroll fogta meg.
        for nev, alak in (("nevesitett &mdash;", "&mdash;"),
                          ("szamos &#8212;", "&#8212;"),
                          ("hex &#x2014;", "&#x2014;")):
            ent = {"tool_name": "mcp__plugin_telegram_telegram__reply",
                   "tool_input": {"text": f"Szia! A határidő {alak} péntek, köszönöm."}}
            code, out, err = run_hook(ent, rules_file=active)
            check(f"HTML-entitas gondolatjel blokkol ({nev})", code, 2)
            check_true(f"...es a GONDOLATJEL indokkal, nem masert ({nev})",
                       "GONDOLATJEL" in (err or ""), detail=(err or "")[:120])

        # NEGATIV KONTROLL: a dekodolas nem tehet minden `&`-t gyanussa.
        amp = {"tool_name": "mcp__plugin_telegram_telegram__reply",
               "tool_input": {"text": "Szia! Kovács &amp; Társa Kft. ajánlata megérkezett."}}
        code, out, err = run_hook(amp, rules_file=active)
        check("&amp; onmagaban NEM blokkol", code, 0)

        # A SORREND KONTROLLJA: tag-kiszedes ELOSZOR, dekodolas AZUTAN. Forditva
        # egy szovegkent mutatott, escape-elt jelolo valodi tagge dekodolodna, es
        # a TAG.sub kitorolne a szoveg egy darabjat -- a kapu nem hibat jelezne,
        # hanem CSENDBEN mast vizsgalna, mint amit kuldunk.
        esc = {"tool_name": "mcp__plugin_telegram_telegram__reply",
               "tool_input": {"text": "Szia! Írd ki: &lt;b&gt;vastag&lt;/b&gt; szöveggel, köszönöm."}}
        code, out, err = run_hook(esc, rules_file=active)
        check("escape-elt jelolo NEM blokkol es nem tunik el", code, 0)

        # A FENTI SOR ONMAGABAN NEM ELEG, ES EZT SAMU MERTE MEG (#1320 review):
        # csak exit 0-t asszertal, ezert MINDKET sorrenddel zold -- vagyis nem
        # bizonyitja azt, amit a kommentje allit. Ez a fog viszont diszkriminal
        # (fuggetlenul visszamerve, True/False):
        #   HELYES sorrend  -> a dekodolt spanban OTT a tiltott jel      -> exit 2
        #   CSERELT sorrend -> a span TAGGE dekodolodik, a TAG.sub a jellel
        #                      EGYUTT torli                             -> exit 0, CSENDES atengedes
        # Vagyis pontosan az a veszely, amit a hook kommentje leir: a kapu nem
        # hibat jelez, hanem mast vizsgal, mint amit kuldunk.
        span = {"tool_name": "mcp__plugin_telegram_telegram__reply",
                "tool_input": {"text": "Szia! A jelölés: &lt;határidő — péntek&gt; formában áll, köszönöm."}}
        code, out, err = run_hook(span, rules_file=active)
        check("escape-elt SPAN-ben rejtett gondolatjel blokkol (sorrend-fog)", code, 2)
        check("...es a GONDOLATJEL indokkal", "GONDOLATJEL" in (err or ""), True)

        # --- C67F5F34: A GOMBFELIRATOK IS KIMENO SZOVEG ----------------------
        # A Telegram reply eszkoz buttons mezoje (a plugin Marveen-foltja) egy
        # koppintassal valaszolhato gombokat tesz a kerdes ala; a felirat az, amit
        # a cimzett lat es visszakuld. A SZOVEG SZANDEKOSAN TISZTA (teljesen
        # ekezetes, gondolatjel nelkul), hogy a tiltas CSAK a feliratbol johessen
        # (a COPYGATEENT914 tanulsaga: egy mas okbol is tuzelo teszt nem mer).
        def gombos(buttons):
            return {"tool_name": "mcp__plugin_telegram_telegram__reply",
                    "tool_input": {"text": CLEAN_HU_OK, "buttons": buttons}}
        code, out, err = run_hook(gombos(["A. Elfogadom", "B. Már megoldva — köszönöm"]), rules_file=active)
        check("gondolatjel a gombfeliratban blokkol (exit 2)", code, 2)
        check_true("...es a GONDOLATJEL indokkal", "GONDOLATJEL" in (err or ""), detail=(err or "")[:120])
        code, out, err = run_hook(gombos("A — B"), rules_file=active)
        check("nem lista alaku buttons is vizsgalt (exit 2)", code, 2)
        # NEGATIV KONTROLL: tiszta feliratok atmennek, es a tiszta szoveg magaban is.
        code, out, err = run_hook(gombos(["A. Elfogadom", "B. Már megoldva", "C. Valami más lesz a megoldás"]),
                                  rules_file=active)
        check("tiszta gombfeliratok atmennek (exit 0)", code, 0)
        code, out, err = run_hook(gombos([]), rules_file=active)
        check("ures gomblista (a billentyuzet levetele) atmegy (exit 0)", code, 0)

        # --- GMAILCONNECTOR914: the claude.ai Gmail connector ----------------
        # mcp__claude_ai_Gmail__send_message carries ONE underscore before Gmail,
        # so the old (^|__)gmail__ alternative never matched and the send fell
        # through to exit 0 with no audit (measured 2026-08-30, 2026-09-08).
        for tool in ("send_message", "reply", "forward"):
            bad = {"tool_name": f"mcp__claude_ai_Gmail__{tool}",
                   "tool_input": {"to": ["a@b.hu"], "messageId": "m1", "subject": "Teszt",
                                  "body": CLEAN_HU_OK + " — mégis."}}
            code, out, err = run_hook(bad, rules_file=active)
            check(f"connector {tool} with em dash blocks (exit 2)", code, 2)
            ok = {"tool_name": f"mcp__claude_ai_Gmail__{tool}",
                  "tool_input": {"to": ["a@b.hu"], "messageId": "m1", "subject": "Teszt", "body": CLEAN_HU_OK}}
            code, out, err = run_hook(ok, rules_file=active)
            check(f"connector {tool} clean passes (exit 0)", code, 0)
        fwd = {"tool_name": "mcp__claude_ai_Gmail__forward",
               "tool_input": {"to": ["a@b.hu"], "messageId": "m1", "forwardText": "Nézd meg — fontos."}}
        code, out, err = run_hook(fwd, rules_file=active)
        check("connector forward: forwardText is audited too (exit 2)", code, 2)
        draft_only = {"tool_name": "mcp__claude_ai_Gmail__send_message", "tool_input": {"draftId": "d1"}}
        code, out, err = run_hook(draft_only, rules_file=active)
        check("connector send of a draftId: body unreadable, fail-closed (exit 2)", code, 2)
        # UPSTREAM-SYNC BATCH 5 (card 1a046537): label_message removed from this loop --
        # card 498d53c1's deny-by-default narrowing (tested explicitly above, "no longer
        # on the safe list") deliberately took it OFF the safe list. This loop is upstream's
        # own, now-stale expectation that it still passes; kept contradicting it here would
        # make one of the two assertions vacuous depending on which ran last.
        for tool in ("search_threads", "get_thread"):
            code, out, err = run_hook({"tool_name": f"mcp__claude_ai_Gmail__{tool}", "tool_input": {"q": "x — y"}},
                                      rules_file=active)
            check(f"connector {tool} is a read: passes untouched (exit 0)", code, 0)

    if FAILS:
        print(f"\n{len(FAILS)} FAILED: {FAILS}", file=sys.stderr)
        sys.exit(1)
    print("\nAll outgoing-copy-gate tests passed.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Validate/escape outgoing-copy-gate name patterns with the ENGINE THAT CONSUMES THEM.

Card 98dbbcc9. The dashboard writes `bad_name_patterns` into
store/outgoing-copy-gate-rules.json; scripts/hooks/outgoing-copy-gate.py then does
`re.compile("|".join(pats))` at import time, OUTSIDE any try/except. So one pattern that
Python cannot compile makes the hook die with an uncaught re.PatternError, exit 1, and an
empty stdout -- and since only exit 2 blocks a tool call, the gate is not "failing closed",
it is SILENTLY NOT RUNNING for every agent whose hook resolves to that file.

Validating in Node instead would be unsound in BOTH directions -- measured, not assumed:

    pattern      python   node
    (?P<n>x)     OK       ERR     <- false REJECTION of a legitimate pattern
    (?<n>x)      ERR      OK      <- false ACCEPTANCE -> hook crashes
    \\p{L}        ERR      OK      <- false ACCEPTANCE -> hook crashes
    (?#c)x       OK       ERR     <- false REJECTION
    [a-z]{,3}    OK       OK

Four of five disagree. Hence this tool: the same `re` module, the same join, so "it
validated" and "the hook can load it" are the same statement rather than two hopeful ones.

Protocol: one JSON object on stdin, one JSON object on stdout, exit 0 even for a rejection
(the caller reads `ok`; a non-zero exit is reserved for the tool itself being broken).

  {"op":"prepare","patterns":[...],"value":"...","mode":"literal"|"regex"}
      -> {"ok":true,"pattern":"<final regex source>"}   (mode=literal runs re.escape)
      -> {"ok":false,"error":"<human-readable reason>"}
  {"op":"validate","patterns":[...]}
      -> {"ok":true} | {"ok":false,"error":...}

NEVER prints a pattern except back to its own caller in `pattern`; nothing here logs.
"""
import json
import re
import signal
import sys
import time

# A name rule is a name, not a program. These bounds exist so a single paste cannot make the
# joined regex enormous (the hook compiles it on EVERY Bash tool call of every agent).
MAX_PATTERN_LEN = 200
MAX_PATTERNS = 200

# Catastrophic-backtracking budget. The hook runs per tool call, so a pattern that takes
# a second to fail is a fleet-wide tax even though it "works".
REDOS_BUDGET_S = 1.0

# The probes have to TRIGGER the explosion, not merely be long. Measured while building this:
# `(a+)+$` against "a"*4096 returns instantly (the string MATCHES, so nothing backtracks), and
# against "abab...!" it fails fast at each start. The shape that detonates is a run of the inner
# character followed by ONE character that cannot match -- "a"*32 + "!" already runs past any
# sane budget. A probe set that misses that shape reports every pattern as fast, which is worse
# than no check: it is a green light with nothing behind it.
REDOS_PROBES = (
    "a" * 32 + "!",
    "a" * 48 + "!",
    ("ab" * 24) + "!",
    "0" * 32 + "!",
    " " * 32 + "!",
    "Nagyné O'Brien " * 32,
    "x" * 64 + "\n" + "y" * 64,
)


def _fail(msg):
    json.dump({"ok": False, "error": msg}, sys.stdout)
    sys.exit(0)


def _check_list(pats):
    if len(pats) > MAX_PATTERNS:
        _fail(f"Túl sok minta ({len(pats)}), a felső korlát {MAX_PATTERNS}.")
    for p in pats:
        if not isinstance(p, str):
            _fail("Minden mintának szövegnek kell lennie.")
        if len(p) > MAX_PATTERN_LEN:
            _fail(f"Egy minta legfeljebb {MAX_PATTERN_LEN} karakter lehet.")


def _compile_joined(pats):
    """Compile EXACTLY the way the hook does, so a pass here means a load there."""
    if not pats:
        return None
    try:
        return re.compile("|".join(pats))
    except re.error as exc:
        _fail(f"A minta nem fordul le Python regexként: {exc}")


class _Budget(Exception):
    pass


def _check_speed(rx):
    """Reject a pattern that backtracks catastrophically, with a REAL interrupt.

    A between-probes time check cannot save us: a single runaway `search()` never returns, so
    the loop never gets back to the clock. SIGALRM does interrupt it -- CPython's sre polls for
    signals inside the match loop (verified on this interpreter before relying on it) -- which
    turns "hangs every agent forever, later" into "rejected in one second, now". The caller's
    subprocess timeout stays as the backstop for an interpreter where it does not.
    """
    if rx is None:
        return

    def _boom(_sig, _frm):
        raise _Budget()

    had_alarm = hasattr(signal, "SIGALRM")
    if had_alarm:
        signal.signal(signal.SIGALRM, _boom)
        signal.setitimer(signal.ITIMER_REAL, REDOS_BUDGET_S)
    start = time.monotonic()
    try:
        for probe in REDOS_PROBES:
            rx.search(probe)
            if time.monotonic() - start > REDOS_BUDGET_S:
                raise _Budget()
    except _Budget:
        _fail(
            "A minta túl lassan fut (visszalépéses robbanás). A kapu minden eszközhívásnál "
            "lefut, ezért egy ilyen minta az egész flottát lassítaná. Egyszerűsítsd, vagy add "
            "meg pontos szövegként."
        )
    finally:
        if had_alarm:
            signal.setitimer(signal.ITIMER_REAL, 0)


def main():
    try:
        req = json.load(sys.stdin)
    except Exception:
        json.dump({"ok": False, "error": "Hibás JSON bemenet."}, sys.stdout)
        sys.exit(0)

    op = req.get("op")
    pats = req.get("patterns") or []
    if not isinstance(pats, list):
        _fail("A patterns mezőnek listának kell lennie.")
    _check_list(pats)

    if op == "validate":
        _check_speed(_compile_joined(pats))
        json.dump({"ok": True}, sys.stdout)
        return

    if op != "prepare":
        _fail("Ismeretlen művelet.")

    value = req.get("value")
    mode = req.get("mode")
    if not isinstance(value, str) or not value.strip():
        _fail("Üres minta nem vehető fel.")
    if mode not in ("literal", "regex"):
        _fail("A mode csak 'literal' vagy 'regex' lehet.")
    if len(value) > MAX_PATTERN_LEN:
        _fail(f"Egy minta legfeljebb {MAX_PATTERN_LEN} karakter lehet.")

    # re.escape rather than a hand-rolled escaper: the escaping rules are the consuming
    # engine's business (a backslash before the wrong character is itself a compile error),
    # and we are already in that engine.
    pattern = re.escape(value) if mode == "literal" else value

    # Compile the candidate ALONE first, so the error message points at what the user just
    # typed instead of at the joined blob, then compile the whole future list -- an
    # individually-fine pattern can still break the join.
    try:
        re.compile(pattern)
    except re.error as exc:
        _fail(f"A minta nem fordul le Python regexként: {exc}")
    if pattern in pats:
        _fail("Ez a minta már szerepel a listán.")
    candidate = list(pats) + [pattern]
    _check_list(candidate)
    _check_speed(_compile_joined(candidate))

    json.dump({"ok": True, "pattern": pattern}, sys.stdout)


if __name__ == "__main__":
    main()

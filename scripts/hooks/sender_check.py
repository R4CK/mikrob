#!/usr/bin/env python3
"""The outgoing-copy CONTENT check a sender runs on the exact text it is about to deliver.

SCOPED PORT (card 5dd0842a, Koteg 25): upstream's sender_check.py also wires an
email_send approval-level gate (email-approval-gate.py) and an opt-in recipient
ledger (recipient_ledger.py) into a single check(letter) entry point, for its own
mail senders (support-mail/send.py, graph-mail.ts). Neither of those is ported
here -- the Python-side recipient ledger does not exist in this fork (the
Node-side scripts/recipient-ledger.mjs equivalent is an explicit NOT ADOPTED,
see src/fork-upstream/acknowledged-conflicts.ts), and the email-approval-level
plumbing is its own, separately decided surface. Only what scripts/uptime-monitor.py
(this same Koteg's own new script) actually calls is ported: the outgoing-copy
CONTENT check (_copy_check) and the Refused exception, against this fork's own
outgoing-copy-gate.py (unchanged, already present). A future card porting the
full upstream sender_check.py (for an email sender) should fold this in, not
duplicate it.
"""
import os

_HERE = os.path.dirname(os.path.abspath(__file__))


class Refused(Exception):
    """The caller must not deliver; the message says why."""


COPY_RULES_ENV = "OUTGOING_COPY_GATE_RULES"


def _copy_gate():
    """outgoing-copy-gate.py as a module, its name rules read from THIS
    project's store: a test-only rules override in the environment is not honoured."""
    import importlib.util
    saved = os.environ.pop(COPY_RULES_ENV, None)
    try:
        spec = importlib.util.spec_from_file_location(
            "outgoing_copy_gate_sender_check", os.path.join(_HERE, "outgoing-copy-gate.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        if saved is not None:
            os.environ[COPY_RULES_ENV] = saved
    return mod


def _copy_check(text):
    """Return a warning line or None; raise Refused when the text may not go out.

    BAD_NAME_STATE == STATE_BROKEN with a set BROKEN_REASON means the rules file is PRESENT
    but a pattern in it does not compile -- the operator wrote something broken, refuse so it
    gets fixed. A broken_reason of None means the file is simply missing/unreadable (never
    configured) -- same as STATE_EMPTY, fail-open with a warning, not a refusal: a Telegram
    alert must not go permanently dark just because nobody has written a name-rules file yet
    (the hook's OWN email-vs-Telegram split draws exactly this line upstream)."""
    try:
        gate = _copy_gate()
        if gate.BAD_NAME_STATE == gate.STATE_BROKEN and gate.BROKEN_REASON:
            raise Refused("KIMENO-SZOVEG ELLENORZES: a NEV-SZABALY nem fut "
                          f"({gate._LOCAL_RULES}): {gate.BROKEN_REASON}. "
                          "Javitsd a fajlt, aztan kuldd ujra.")
        if not str(text or "").strip():
            raise Refused("KIMENO-SZOVEG ELLENORZES: ures szoveg, nincs mit kikuldeni.")
        problems = gate.audit(text)
    except Refused:
        raise
    except BaseException as exc:  # noqa: BLE001 -- deliberate fail-closed net
        raise Refused(f"KIMENO-SZOVEG ELLENORZES: belso hiba ({exc!r}); fail-closed, egy "
                      "vizsgalhatatlan szoveg nem mehet ki.")
    if problems:
        raise Refused("KIMENO-SZOVEG ELLENORZES: a szoveg nem mehet ki igy.\n"
                      + "\n".join(f"  - {p}" for p in problems)
                      + "\nJavitsd a szoveget es kuldd ujra.")
    if gate.BAD_NAME_STATE != gate.STATE_ACTIVE:
        return ("KIMENO-SZOVEG ELLENORZES: FIGYELEM, a NEV-SZABALY fajl "
                + ("URES" if gate.BAD_NAME_STATE == gate.STATE_EMPTY else "HIANYZIK VAGY NEM OLVASHATO")
                + f" ({gate._LOCAL_RULES}), ez a szoveg a nev-ellenorzes NELKUL megy.")
    return None

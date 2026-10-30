#!/usr/bin/env python3
"""gemini-agy-category-check.py -- server-side forbidden-category signal detector for the Gemini
agy wrapper's category gate (card 09117e0a F1, WhiteHat finding on 64788453 CYBERSEC GO komment
18210: the gate only trusted the CALLER's declared --kategoria, so a security/auth/finance/mopsion
card mislabelled 'safe' by a buggy or malicious caller went straight through to the external
helper).

Reads the kanban card JSON (the exact /api/kanban/<id> response shape) on stdin, normalizes the
title+description (NFKD-fold accents away, casefold, ASCII-encode) and runs the SAME stem regex
store/offload-dispatch.sh's SENS_RE already uses for its own sensitive-content gate (proven through
several WhiteHat/RedHat hardening rounds on that script) plus a mopsion/cleancore stem SENS_RE does
not carry (that gate only needs it as an exact TAG, this one needs it in free text too, since a
caller could write "mopsion kod" straight into the description). Labels are checked separately with
exact per-token matching against the fleet's BLOCKED_TAGS vocabulary (labels are short, controlled
strings -- tag-exact-match is the right tool there, stem-matching free text is the right tool for
title/description; offload-dispatch.sh makes the same split for the same reason).

This is deliberately proportionate: it reuses SENS_RE's stem coverage rather than inventing a
weaker new one, and does not port offload-dispatch.sh's homoglyph TABLE (mapping specific known
homoglyphs back to their ASCII letter) -- that hardening defends a materially different, larger
threat surface (routing untrusted-looking content to a local, less-trusted model); here the threat
is a caller's plain-text mismatch against its own declared "safe". It DOES, however, carry
offload-dispatch.sh's fail-closed GUARANTEE (CYBERED NO-GO 25494, card c5f2d6c9): norm()'s final
.encode("ascii", "ignore") silently DROPS any letter it cannot map, so an unmapped non-ASCII
letter (Greek omicron in "mopsion", Cyrillic in "token:", ...) vanished instead of blocking --
the stem/label checks below never saw it. has_unmapped_letter() runs on the RAW text before norm()
erases the evidence, and fails closed (exit 2, "cannot verify") the same way an invalid-JSON card
already does.

Prints the first matched category name (security|auth|finance|mopsion) on stdout, or nothing if
clean. Exit 0 = parsed fine (stdout is authoritative; empty stdout = no signal found). Exit 2 = the
input was not valid card JSON (unreadable/empty/malformed), or the title/description carries an
unmapped non-ASCII letter -- the caller MUST treat this as "cannot verify" and fail closed, not as
"no signal found".
"""
import json
import re
import sys
import unicodedata

# Mirrors store/offload-dispatch.sh SENS_RE (title/description stem gate) plus mopsion/cleancore,
# which that script only needs as an exact TAG (BLOCKED_TAGS) because mopsion work is dispatched
# with a controlled project/tag, not free text -- here the card's own prose is in scope too.
STEM_CATEGORY = [
    (re.compile(r"\b(biztons|security|superadmin|gdpr|privacy|kulcs|kripto|crypto|pii|legal|jogi"
                r"|cybersec|hacker|exploit|pentest|inject|sqli|xss|permission|access"
                r"|szemelyes|hozzaferes|titok|secret|token|jelszo|password|jogosult)", re.I),
     "security"),
    (re.compile(r"\b(auth|authz|rbac|tenant)", re.I), "auth"),
    (re.compile(r"\b(penz|penzugy|fizet|szamla|afa|payroll|berszamfejtes|billing|payment|fin)", re.I),
     "finance"),
    (re.compile(r"\b(mopsion|cleancore)", re.I), "mopsion"),
]

# Labels are short, controlled strings (kanban label vocabulary): exact per-token match, same as
# offload-dispatch.sh's BLOCKED_TAGS, not stem-matching (a label literally named "resection" must
# not false-positive the way free text could tolerate).
BLOCKED_LABEL_TOKENS = {
    "mopsion": "mopsion", "cleancore": "mopsion",
    "sec": "security", "security": "security", "biztonsag": "security", "cybersec": "security",
    "pii": "security", "gdpr": "security", "privacy": "security", "secret": "security",
    "crypto": "security", "superadmin": "security",
    "auth": "auth", "authz": "auth", "rbac": "auth", "tenant": "auth",
    "penz": "finance", "penzugy": "finance", "finance": "finance", "billing": "finance",
    "payment": "finance", "fin": "finance",
}


def norm(s: str) -> str:
    decomposed = unicodedata.normalize("NFKD", s)
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return stripped.casefold().encode("ascii", "ignore").decode()


# CYBERED NO-GO 25494 (card c5f2d6c9), mirrors offload-dispatch.sh's has_unmapped_letter() fix
# (card e87e7520): after NFKD decomposition, an accented Hungarian letter decomposes into a plain
# ASCII base letter + a COMBINING MARK (category Mn), so ordinary Hungarian text is unaffected.
# A homoglyph/foreign-script letter (Greek, Cyrillic, Armenian, ...) has no such decomposition and
# survives as a non-ASCII character of category L* (Lu/Ll/Lo/...) -- that is the fail-closed
# signal norm()'s later .encode("ascii", "ignore") would otherwise silently erase.
#
# RedHat LOW (card a2db9d8f, req 2): a letter can also be spelled with a SYMBOL codepoint rather
# than a Letter one -- regional indicator symbols ("REGIONAL INDICATOR SYMBOL LETTER M") and
# circled/squared Latin letters ("NEGATIVE SQUARED LATIN CAPITAL LETTER M") are Unicode category
# So, not L*, so the L*-only check above missed them entirely, and norm()'s ascii-ignore encode
# erases them the same way it erases an unmapped script letter. Unicode names it right in the
# name itself: every one of these per-letter symbol codepoints has "LETTER" in its name (checked
# against the actual Unicode database, not assumed); a whole-word symbol like "SQUARED OK" does
# not, and is correctly left alone (it is not spelling a letter-by-letter homoglyph).
def has_unmapped_letter(s: str) -> bool:
    decomposed = unicodedata.normalize("NFKD", s)
    for ch in decomposed:
        if ord(ch) <= 127:
            continue
        cat = unicodedata.category(ch)
        if cat.startswith("L"):
            return True
        if cat == "So" and "LETTER" in unicodedata.name(ch, ""):
            return True
    return False


def label_tokens_of(text: str):
    return [t for t in re.split(r"[^a-z0-9]+", norm(text)) if t]


def main() -> int:
    raw = sys.stdin.read()
    # N3-javitas (card 09117e0a, RedHat NO-GO komment 18498): a hivo most a kert kartya-ID-t
    # ADJA ide argvban. Egy dashboard-hibatest (404 "Kartya nem talalhato", 401 "Unauthorized",
    # 500) ERVENYES JSON-objektum, de nincs benne sem "id", sem "title" -- korabban ez
    # "nincs jel" -> exit 0 -> a deklart 'safe' kategoria atment, pedig a kartya tartalmat
    # SOHA nem is lattuk. Most: ha a hivo megadta a kartya-ID-t, a valasznak PONTOSAN arra a
    # kartyara kell vonatkoznia (card.id == expected_id) ES kell lennie nem-ures cimnek --
    # kulonben "nem tudjuk ellenorizni", nem "nincs jel".
    expected_id = sys.argv[1] if len(sys.argv) > 1 else None
    try:
        card = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return 2
    if not isinstance(card, dict):
        return 2

    title_raw = card.get("title")
    if expected_id is not None:
        if card.get("id") != expected_id:
            return 2
        if not isinstance(title_raw, str) or not title_raw.strip():
            return 2

    desc_raw = card.get("description")
    # Must run on the RAW text, before norm() silently ascii-drops the evidence (see
    # has_unmapped_letter() docstring / CYBERED NO-GO 25494).
    if has_unmapped_letter(str(title_raw or "")) or has_unmapped_letter(str(desc_raw or "")):
        return 2  # cannot verify -- fail closed (unmapped homoglyph/script letter)

    title_n = norm(str(title_raw or ""))
    desc_n = norm(str(desc_raw or ""))
    for rx, cat in STEM_CATEGORY:
        if rx.search(title_n) or rx.search(desc_n):
            print(cat)
            return 0

    # Title-bracket tags ("[SEC]", "[MikroB][SEC][HIGH] ..."): the fleet convention writes these
    # as a short, controlled bracket segment, not free prose -- "sec" alone is deliberately NOT a
    # STEM_CATEGORY stem above (it would match "section"/"second" in real prose), so bracket
    # segments get the same exact-token BLOCKED_LABEL_TOKENS check the labels array gets below.
    bracket_segments = re.split(r"[\[\](){}]", title_n)
    for seg in bracket_segments:
        for tok in label_tokens_of(seg):
            cat = BLOCKED_LABEL_TOKENS.get(tok)
            if cat:
                print(cat)
                return 0

    for lab in card.get("labels") or []:
        # RedHat L1 (card a2db9d8f, req 3, msg 15488): label_tokens_of() routes through norm(),
        # whose final .encode("ascii", "ignore") silently drops an unmapped homoglyph/symbol
        # letter the same way it would in title/description -- a label like "m<omicron>psion"
        # became the clean token "mpsion" instead of failing closed. Same guarantee as above,
        # checked on the RAW label text before norm() erases the evidence.
        if has_unmapped_letter(str(lab)):
            return 2  # cannot verify -- fail closed (unmapped homoglyph/script letter in a label)
        for tok in label_tokens_of(str(lab)):
            cat = BLOCKED_LABEL_TOKENS.get(tok)
            if cat:
                print(cat)
                return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())

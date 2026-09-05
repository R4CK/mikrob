#!/usr/bin/env python3
"""PreToolUse gate on the MAIN agent's outbound email: Hungarian copy QA.

Why this exists (Szabi, 2026-08-10 12:57): a licence-delivery email went out to a
client with every accent stripped ("Szia Balint, itt van a Marveen licenckulcsod
es a telepito"). It was the second accent incident that day -- the first was a
client-facing spreadsheet the same morning. Szabi asked for a gate that inspects
outgoing copy BEFORE the send and rejects it if something is wrong.

Note the seam this fills. `scripts/email-send-gate.mjs` already gates outbound
email, but it gates SUB-AGENTS (it is wired by writeAgentSettingsFromProfile()
guarded by `name !== MAIN_AGENT_ID`) and it is a hard deny, not a content check.
Nothing at all ran on the main agent's own sends -- and the main agent is the one
that actually writes to customers.

What it checks, all three from standing owner rules in CLAUDE.md:
  1. Hungarian text that is missing its accents (the incident above).
  2. Em dash (U+2014) -- forbidden in every deliverable.
  3. Owner-specific NAME rules (misspelled surnames etc.) -- loaded from an
     untracked local rules file (GATEPERSIST816), never hardcoded here.

FAIL-CLOSED ON AN UNREADABLE BODY. If the call looks like a send but the body
cannot be recovered (e.g. `send.py ... < $SP/body.txt`, where $SP is a shell
variable this hook cannot resolve), the gate BLOCKS. A send whose content cannot
be inspected defeats the point of the gate, so "I could not read it" must not
mean "let it through". The block message says how to make it inspectable.

Contract: PreToolUse. Reads the hook payload on stdin, exit 0 = allow,
exit 2 = block (stderr goes back to the model).
"""
import json
import os
import re
import sys
import threading
import time

# ADOPTED FROM UPSTREAM VERBATIM (card 3ec64c96, 2026-08-25): upstream independently built
# this exact same class of fix (KAPUHATOKOR822, its own four-false-positive incident,
# measured 2026-08-22) -- a position-aware, shlex-tokenized send detector, more thorough than
# this fork's own first-draft URL-anchoring patch (which this replaces). Per the fleet's own
# GitHub-first/do-not-reinvent rule, applied here to its OWN upstream parent: adopt rather than
# maintain a narrower fork-local duplicate. The fork's SEPARATE load_bad_name() sentinel fix
# (same card, further below) is untouched by upstream and kept as-is.
# --- what counts as an email send -------------------------------------------
# KAPUHATOKOR822 (2026-08-22, NEGY hamis pozitiv egy delutanon, HAROM
# muvelet-tipuson: inter-agent uzenet, sqlite-iras, fajl-OLVASAS): a korabbi
# szures a TELJES parancs-stringben kereste a kuldes-mintakat, igy egy
# inter-agent curl JSON-torzse ('"to":' a boritekban + 'send.py' a szoveg
# TARTALMABAN), egy hirlevel-szoveget iro sqlite-parancs vagy a send-script
# puszta elolvasasa is kuldesnek latszott. A kapu levelnek olvasta azt, ami
# uzenet A RENDSZERROL -- es pont arrol a temarol nemitotta volna el a
# flottat, amirol a legfontosabb beszelni (Iris tetje: egy valodi incidenst
# nem lehetne jelenteni rola).
#
# A szures ezert PARANCS-POZICIORA megy, nem tartalomra: elobb kivagjuk a
# heredoc-torzseket es az idezett stringeket (a tartalom igy nem tud parancs-
# nak latszani), majd pipeline/szekvencia-szegmensenkent a MEGHIVOTT programot
# nezzuk. Kuldes az, ahol a kuldo program fut:
#   - sendmail / msmtp / swaks a program-pozicioban (ezek csak kuldeni tudnak);
#   - send.py TENYLEGES futtatasa (python vagy kozvetlen ut) --to cimzettel a
#     SAJAT szegmenseben (a --help/olvasas igy nem trigger);
#   - graph-mail futtatasa `send` alparanccsal;
#   - curl/wget, amelynek IDEZETLEN URL-tokenje az api.resend.com-ra mutat
#     (a -d payloadban idezett elofordulas nem szamit -- az tartalom).
# MASODIK KOR (Marveen adverzarialis merese, msg 14282): az elso valtozat a
# quoted stringeket VAKON vagta ki, ezert ket hamis negativot nyitott -- az
# IDEZOJELES URL a curl sajat argumentum-helyen (a curl SZOKASOS irasmodja!)
# es a burkolo hejj `-c` string-argumentuma atment. A gyoker: az idezojel a
# TARTALOM ellen jo hatar, de nem mondja meg, hogy a token URL- vagy
# PROGRAM-POZICIOBAN all-e. Ezert a kivagas helyett QUOTE-TUDATOS tokenizalas
# fut (shlex): az idezett token EGY tokenkent, poziciojaval egyutt erkezik --
# a curl idezojeles URL-argumentuma igy vizsgalhato, mikozben egy -d payload
# belsejeben emlitett domain tovabbra is csak tartalom (az URL-minta a token
# ELEJERE horgonyzott). A wrapper hejj (`sh -c "..."`) string-argumentuma
# rekurzivan elemzodik.
# A heredoc-kivagas SORREND-FUGGETLEN (Marveen 3. kore, msg 14286): a
# hatarolo utani SOR-MARADEK (pl. atiranyitas: <<EOF > fajl) a parancs
# resze es MEGMARAD -- csak a torzs esik ki. Enelkul (a) forditott
# sorrendnel a torzs parancsnak latszott (FP), (b) a bevezeto sor
# eldobasa a heredoc-taplalt VALODI kuldot vesztette volna el (FN).
_HEREDOC = re.compile(r"(<<-?\s*'?(\w+)'?[^\n]*)\n.*?\n\2(?=\s|$)", re.S)
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*=")
_SENDER_PROG = re.compile(r"^(sendmail|msmtp|swaks)$", re.I)
_SENDPY = re.compile(r"^send\.py$", re.I)
_PYTHON = re.compile(r"^python3?$", re.I)
# A ket kapu (ez + scripts/email-send-gate.mjs) SZANDEKOSAN azonos
# felismeres-szemantikat visel, es ezt kozos eset-lista orzi
# (send-invocation-cases.json + konformancia-teszt): a divergencia
# teszt-hibakent jelenjen meg, ne incidenskent (Marveen, msg 14289).
_NODEISH = re.compile(r"^(node|tsx|ts-node|deno|bun|npx)$", re.I)
_GRAPHMAIL = re.compile(r"^graph-mail(\.ts|\.js)?$", re.I)
_WRAPPER_SHELL = re.compile(r"^(sh|bash|zsh|dash)$", re.I)
_CURLISH = re.compile(r"^(curl|wget|http)$", re.I)
# Interpreter kod-string argumentum (python -c / node -e): az interpreternek
# atadott kod MUVELET, nem tartalom -- a kod-szintu kuldes-hivasokra szurunk.
#
# KIMONDOTT HATAR (Marveen, msg 14298): tetszoleges interpreter-kod statikus
# elemzese eldonthetetlen -- ez a kapu a VELETLEN kuldest fogja meg, nem egy
# elszant kikerulot. A lenti exec-heurisztika a NAIV alakokat fedi (a kod
# process-inditast ES kuldo-programnevet egyutt tartalmaz); ennel tobbet nem
# allit, es nem is allithat.
_CODE_SEND = re.compile(
    r"\bsmtplib\b|SMTP\s*\(|\bsendMail\s*\(|\bsendEmail\b|\bmail\.send\b", re.I
)
_CODE_EXECISH = re.compile(
    r"\bsubprocess\b|os\.system|\bpopen\b|child_process|\bexec[A-Za-z]*\s*\(|\bspawn[A-Za-z]*\s*\(",
    re.I,
)
_CODE_SENDER_LIT = re.compile(r"sendmail|msmtp|swaks|send\.py", re.I)


def _code_string_sends(code: str) -> bool:
    if _CODE_SEND.search(code):
        return True
    return bool(_CODE_EXECISH.search(code) and _CODE_SENDER_LIT.search(code))
# Token-ELEJERE horgonyzott cel-minta: egy URL-argumentum vagy csupasz
# domain/utvonal illik ra; egy JSON-payload ('{...api.resend.com...}') nem.
_RESEND_TARGET = re.compile(r"^(https?://)?([^/@\s]*\.)?api\.resend\.com(/|$|\s|$)", re.I)

# RESENDGATE826: a resend-celu curl/wget csak akkor KULDES, ha a METODUS az.
# A korabbi minta metodus-vak volt, es egy read-only GET /domains (nincs torzs,
# nincs cimzett) ugyanugy fail-closed elutasitast kapott -- pont egy domain-
# verifikacios MERES akadt el rajta. A szukites iranya szigoru: a metodust
# FELISMERNI kell (explicit -X/--request/--method, vagy implicit POST a
# torzs-flagekbol); ha nem allapithato meg (valtozo, config-fajl, csonka flag),
# marad a fail-closed. Egy "nincs felismerheto torzs -> atmegy" szabaly a
# kaput utne ki, ezert ILYEN AG NINCS.
_CURL_BODY_OPTS = {
    "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
    "--data-ascii", "-F", "--form", "--form-string", "--json",
    "-T", "--upload-file",
    # wget torzs-flagek
    "--post-data", "--post-file", "--body-data", "--body-file",
}
_SAFE_METHODS = {"GET", "HEAD"}


def _curl_resend_verdict(rest):
    """'read' | 'send' | 'unknown' -- unknown a hivo oldalon fail-closed.

    Cybersec NO-GO (fbb36b41 round 11): a korabbi valtozat a -G/--get flag jelenletet a
    has_body jelzes FELULBIRALASAKENT kezelte -- de a `curl -G -d ...` egy dokumentalt
    curl-trukk, ami a -d/--data-urlencode altal adott adatot query-string parameterkent
    csatolja az URL-hez es GET-kent kuldi: a tartalom (cimzett/targy/torzs) EKKOR IS
    eljut a celhoz, csak a HTTP-metodus mas. A -G ezert MAR NEM tud egy torzs-kuldest
    olvassa-kent aluminositani -- a torzs-jelenlet onmagaban donto, fuggetlenul a
    metodustol.
    """
    method = None
    has_body = False
    i, n = 0, len(rest)
    while i < n:
        t = rest[i]
        if t in ("-X", "--request", "--method"):
            if i + 1 >= n or not rest[i + 1].isalpha():
                return "unknown"  # csonka vagy valtozo ($METHOD) -- nem dontheto
            method = rest[i + 1].upper()
            i += 2
            continue
        if t.startswith("--request=") or t.startswith("--method="):
            m = t.split("=", 1)[1]
            if not m.isalpha():
                return "unknown"
            method = m.upper()
            i += 1
            continue
        if t in ("-K", "--config"):
            return "unknown"  # a config-fajl rejtett metodust/torzset hordozhat
        if t in _CURL_BODY_OPTS or any(
            t.startswith(o + "=") for o in _CURL_BODY_OPTS if o.startswith("--")
        ):
            has_body = True
            i += 1
            continue
        if t.startswith("-") and not t.startswith("--") and len(t) > 1:
            # egy-kotojeles cluster (-sS, -sX POST, -sd '{}'): a betuk kotegelve
            letters = t[1:]
            if "X" in letters:
                after = letters.split("X", 1)[1]
                if after:
                    if not after.isalpha():
                        return "unknown"
                    method = after.upper()
                else:
                    if i + 1 >= n or not rest[i + 1].isalpha():
                        return "unknown"
                    method = rest[i + 1].upper()
                    i += 1
            elif "d" in letters or "F" in letters or "T" in letters:
                has_body = True
            elif "K" in letters:
                return "unknown"
            i += 1
            continue
        i += 1
    if method is not None and method not in _SAFE_METHODS:
        return "send"
    if has_body:
        # torzs jelen van, akar POST-kent kuldve, akar -G altal query-stringgé alakitva --
        # mindket alakban tartalom megy a celhoz, tehat kuldeskent kezeljuk
        return "send"
    return "read"

# A tovabbi kuldes-jellegu literalok, amikre a parse-hiba eseten (es CSAK
# akkor) konzervativan visszaesunk -- lasd is_send_invocation vegen.
_FALLBACK_LITERALS = re.compile(
    r"send\.py|api\.resend\.com|\bsendmail\b|\bmsmtp\b|\bswaks\b"
    r"|\bsmtplib\b|\bsendMail\s*\(", re.I
)


def _basename(tok: str) -> str:
    return tok.rsplit("/", 1)[-1]


def _mask_subshell_markers(cmd: str) -> str:
    """Idezojelen KIVULI ujsor/`$(`/backtick -> `;` szeparator, hogy a shlex
    szegmens-hatarkent lassa; idezojelen BELUL a szoveg erintetlen (tartalom)."""
    out = []
    q = None  # None | "'" | '"'
    i, n = 0, len(cmd)
    while i < n:
        ch = cmd[i]
        if q:
            if ch == "\\" and q == '"' and i + 1 < n:
                out.append(cmd[i:i + 2]); i += 2; continue
            if ch == q:
                q = None
            out.append(ch); i += 1; continue
        if ch in "'\"":
            q = ch; out.append(ch); i += 1; continue
        if ch == "\\" and i + 1 < n:
            out.append(cmd[i:i + 2]); i += 2; continue
        if ch == "\n" or ch == "`":
            out.append(";"); i += 1; continue
        if ch == "$" and i + 1 < n and cmd[i + 1] == "(":
            out.append(";"); i += 2; continue
        out.append(ch); i += 1
    return "".join(out)


def _segments_tokens(cmd: str):
    """[[token, ...], ...] szegmensenkent -- quote-tudatosan, poziciot orizve."""
    import shlex
    lex = shlex.shlex(_mask_subshell_markers(_HEREDOC.sub(r"\1", cmd)),
                      posix=True, punctuation_chars="();|&")
    lex.whitespace_split = True
    segments, cur = [], []
    for tok in lex:
        if tok in ("|", "||", "&", "&&", ";", "(", ")", ";;", "|&"):
            if cur:
                segments.append(cur)
            cur = []
        else:
            cur.append(tok)
    if cur:
        segments.append(cur)
    return segments


def _segment_is_send(toks, depth: int) -> bool:
    while toks and _ENV_ASSIGN.match(toks[0]):
        toks = toks[1:]
    if not toks:
        return False
    prog = _basename(toks[0])
    rest = toks[1:]
    if _SENDER_PROG.match(prog):
        return True
    # burkolo hejj: a -c string-argumentum maga is parancs -- rekurzio
    if _WRAPPER_SHELL.match(prog) and depth < 3:
        for i, t in enumerate(rest):
            if t == "-c" and i + 1 < len(rest):
                if is_send_invocation(rest[i + 1], _depth=depth + 1):
                    return True
    # interpreter kod-string: python -c / node -e / --eval, ami kuldest hiv
    if _PYTHON.match(prog) or _NODEISH.match(prog):
        for i, t in enumerate(rest):
            if t in ("-c", "-e", "--eval") and i + 1 < len(rest) and _code_string_sends(rest[i + 1]):
                return True
    # send.py futtatasa (kozvetlenul, vagy python/runner utan) --to cimzettel
    candidates = [prog] + (
        [_basename(rest[0])] if rest and (_PYTHON.match(prog) or _NODEISH.match(prog)) else []
    )
    if any(_SENDPY.match(c) for c in candidates) and any(
        t == "--to" or t.startswith("--to=") for t in rest
    ):
        return True
    # graph-mail kimeno alparanccsal (tsx/node runner utan is)
    if any(_GRAPHMAIL.match(_basename(t)) for t in toks) and "send" in rest:
        return True
    # curl/wget: a cel-token akkor is muvelet, ha idezojelben allt -- a
    # horgonyzott minta valasztja el a payload-belseji emlitestol.
    # RESENDGATE826: csak a TENYLEGES kuldes (POST/PUT/... vagy torzs) akad
    # fenn; a read-only GET/HEAD lekerdezes atmegy; a nem-donthato metodus
    # tovabbra is fail-closed.
    if _CURLISH.match(prog) and any(_RESEND_TARGET.match(t) for t in rest):
        return _curl_resend_verdict(rest) != "read"
    return False


def is_send_invocation(cmd: str, _depth: int = 0) -> bool:
    try:
        segments = _segments_tokens(cmd)
    except ValueError:
        # Parse-hiba (pl. lezaratlan idezojel): nem tudunk poziciot mondani.
        # Konzervativ visszaeses: csak akkor auditalunk, ha eros kuldes-literal
        # all a szovegben -- igy egy fura, de valodi kuldes nem csuszik at
        # neman, a tipikus belso parancsok viszont nem kapnak hamis pozitivot.
        return bool(_FALLBACK_LITERALS.search(cmd))
    return any(_segment_is_send(toks, _depth) for toks in segments)
# --- Hungarian detection (accent-insensitive markers) -----------------------
# These fire on both the correct and the stripped spelling, so a transliterated
# mail is still recognised as Hungarian -- that is the whole point.
HU_MARKERS = [
    "hogy", "nem", "vagy", "amit", "ami", "mert", "ezt", "ez a", "van", "lesz",
    "kell", "tehat", "tehát", "koszonom", "köszönöm", "szia", "sziasztok",
    "kerlek", "kérlek", "csatolva", "udvozlettel", "üdvözlettel", "levelet",
    "level", "kuldom", "küldöm", "jelezz", "irj", "írj", "mar", "már", "csak",
]

# Accentless spellings of frequent Hungarian words -> the correct form. Every
# entry is a word that CANNOT be spelled without its accent, so a hit inside
# Hungarian text is an error, not a style choice.
ACCENTLESS = {
    "es": "és", "tehat": "tehát", "koszonom": "köszönöm", "koszi": "köszi",
    "koszonjuk": "köszönjük", "kerlek": "kérlek", "kerem": "kérem",
    "kerjuk": "kérjük", "kerdes": "kérdés", "kerdesem": "kérdésem",
    "valasz": "válasz", "valaszt": "választ", "valaszol": "válaszol",
    # "levelet" NEM tartozik ide (2026-08-11, hamis pozitiv eles levelen):
    # a szotar invarianca az, hogy minden bejegyzes olyan szo, amit ekezet
    # NELKUL nem lehet leirni. A "levelet" (levél -> levelet) pont ilyen helyes
    # alak, ezert onmagara mutato bejegyzeskent allt itt, es minden korrekt
    # magyar levelet megblokkolt "levelet -> levelet" javaslattal. A "levelét"
    # (birtokos) ekezetlen alakja EGYBEESIK vele, tehat szabalykent nem is
    # eldontheto -- ezt a kapu nem tudja megfogni, es nem is szabad neki.
    "level": "levél", "levelre": "levélre",
    "elore": "előre", "elott": "előtt", "utan": "után", "kozott": "között",
    "kesz": "kész", "keszult": "készült", "keszen": "készen",
    "ervenyes": "érvényes", "ervenytelen": "érvénytelen",
    "telepito": "telepítő", "telepites": "telepítés", "telepiteni": "telepíteni",
    "ujra": "újra", "uj": "új", "ujat": "újat", "igy": "így", "ugy": "úgy",
    "tobb": "több", "tobbi": "többi", "kulon": "külön", "kuldom": "küldöm",
    "kuldtem": "küldtem", "kuldes": "küldés", "kuldunk": "küldünk",
    "fajl": "fájl", "fajlt": "fájlt", "fajlok": "fájlok",
    "hatarido": "határidő", "hataridot": "határidőt",
    "lehetoseg": "lehetőség", "lehetoseget": "lehetőséget",
    "szukseges": "szükséges", "szuksege": "szüksége",
    "mukodik": "működik", "mukodes": "működés", "muszaki": "műszaki",
    "beallitas": "beállítás", "beallitani": "beállítani",
    "elofizetes": "előfizetés", "elofizetest": "előfizetést",
    "szamla": "számla", "szamlat": "számlát", "szamlazas": "számlázás",
    "arajanlat": "árajánlat", "ar": "ár", "arak": "árak",
    "ora": "óra", "orakor": "órakor", "ev": "év", "evi": "évi",
    "honap": "hónap", "het": "hét", "hetfo": "hétfő", "csutortok": "csütörtök",
    "pentek": "péntek", "januar": "január", "februar": "február",
    "marcius": "március", "aprilis": "április", "majus": "május",
    "junius": "június", "julius": "július", "oktober": "október",
    "ket": "két", "harom": "három", "negy": "négy", "ot": "öt",
    "szivesen": "szívesen", "erteket": "értéket", "ertem": "értem",
    "jol": "jól", "rovid": "rövid", "hosszu": "hosszú", "biztonsagos": "biztonságos",
    # "megnyitni" ugyanaz a hibaosztaly, mint a fenti "levelet": onmagara mutato
    # bejegyzes egy olyan szonal, ami ekezet nelkul is helyes. Kiveve 2026-08-11,
    # MIELOTT eles levelen elsult volna.
    "eleresi": "elérési", "elerheto": "elérhető",
    "sajat": "saját", "tovabbi": "további", "tovabb": "tovább",
    "figyelmeztetes": "figyelmeztetés", "ellenorizd": "ellenőrizd",
    "ellenorzes": "ellenőrzés", "reszletek": "részletek", "resz": "rész",
    "vegen": "végén", "vegre": "végre", "elinditja": "elindítja",
    "inditas": "indítás", "masold": "másold", "masolat": "másolat",
    "gepre": "gépre", "gep": "gép", "gepen": "gépen",
    "ervenyesites": "érvényesítés", "aktivalas": "aktiválás",
    "hozzajarulas": "hozzájárulás", "elofordul": "előfordul",
    # +48 bejegyzes 2026-08-13 (EKEZETLISTA812, Szabi GO: "Vedd"). A jeloltek a
    # sajat magyar szovegeinkbol jottek (69 fajl, 60 gyakori ekezetes szo, amit a
    # lista addig nem fogott); a szures KET lepcsos volt: lokalis modell (Muse
    # Glimmer 30B) itelete + sajat felulvizsgalat. SZANDEKOSAN KIMARADT, mert az
    # ekezetlen alak onmagaban is letezo magyar szo: mar (marni), meg (igekoto),
    # kor (eletkor/korszak), fonok (fonni), var (a seb varja), kod (kod ES kod),
    # hozza, meres, lepes, szamlazz, jon, tovabbra. Az "all" -> "áll" TUDATOS
    # kivetel: nem magyar szo, de gyakori ANGOL szo; a kapu csak magyarnak mert
    # szovegen fut, ezert Szabi vallalta a kockazatot.
    "elso": "első", "ezert": "ezért", "valodi": "valódi",
    "nelkul": "nélkül", "miert": "miért", "utana": "utána",
    "kovetkezo": "következő", "szekcio": "szekció", "tenyleg": "tényleg",
    "videot": "videót", "video": "videó", "azert": "azért",
    "hivas": "hívás", "szam": "szám", "szoveg": "szöveg",
    "mas": "más", "kulso": "külső", "dontes": "döntés",
    "letezik": "létezik", "kozvetlenul": "közvetlenül", "felhasznalo": "felhasználó",
    "nema": "néma", "verzio": "verzió", "erdemes": "érdemes",
    "irja": "írja", "mostantol": "mostantól", "latszik": "látszik",
    "szoval": "szóval", "kozos": "közös", "netto": "nettó",
    "cim": "cím", "futo": "futó", "javitas": "javítás",
    "kockazat": "kockázat", "ebbol": "ebből", "mindket": "mindkét",
    "eleg": "elég", "regi": "régi", "kulonbozo": "különböző",
    "kezzel": "kézzel", "peldaul": "például", "izolalt": "izolált",
    "kozben": "közben", "udvozlettel": "üdvözlettel", "oket": "őket",
    "afa": "áfa", "allapot": "állapot", "all": "áll",
}

# GATEHOMOGLIF816 (2026-08-16, Marveen merese): 33 cirill homoglifa ult a
# memoria-sorokban es kartya-cimekben -- olvasva lathatatlan, de a grep/FTS
# nema nulla-talalatot ad, ami hianyzo emleknek latszik, nem serult adatnak.
# A szabaly a VEGYES SZORA vonatkozik (egy szon belul latin ES nem-latin betu),
# nem a cirill puszta jelenletere -- egy szandekosan idegen nyelvu idezet
# tiszta nem-latin szavai atmennek. Unicode-tudatos tokenizalas kell: a WORD
# regex latin-only, egy homoglifas szot darabokra vagna.
UWORD = re.compile(r"[^\W\d_]+", re.UNICODE)


def _char_script(ch: str) -> str:
    import unicodedata
    try:
        return unicodedata.name(ch).split(" ")[0]
    except ValueError:
        return "UNKNOWN"


def mixed_script_words(text: str):
    """Return [(word, bad_char, bad_char_name), ...] for words mixing LATIN
    with any other script. Pure non-Latin words (foreign quotes) pass."""
    import unicodedata
    out = []
    for word in UWORD.findall(text):
        scripts = {_char_script(ch) for ch in word}
        if "LATIN" in scripts and len(scripts) > 1:
            bad = next(ch for ch in word if _char_script(ch) != "LATIN")
            try:
                bad_name = unicodedata.name(bad)
            except ValueError:
                bad_name = "UNKNOWN"
            out.append((word, bad, f"{bad_name} (U+{ord(bad):04X})"))
    return out


EM_DASH = "—"

# GATEPERSIST816: owner-specific NAME rules load from an UNTRACKED local file,
# not from this (public-repo) script. The generic checks (accents, em dash,
# double hyphen, mixed-script) are universal Hungarian-copy QA and ship in the
# repo; a personal-name rule names a private third party, and that must not be
# published as a side effect of persisting the gate. A missing rules file is
# NOT silent: every run appends a loud line to the gate log, because a
# protection whose absence is invisible only protects until someone touches
# the tree. File shape: {"bad_name_patterns": ["<python-regex>", ...]}
# WHERE the rules file lives -- card 934dc104, and this is the whole point of that card.
# The default USED to be resolved relative to THIS SCRIPT, and the fleet has 12 checkouts of
# the script (one per agent worktree) but exactly ONE rules file (the main clone's; it is
# gitignored AND 0600, so it never travels to a worktree and never will). Same gate, opposite
# posture, decided by who happened to call it: from the main root the name check passed
# silently, from any worktree the email path died fail-closed on a config it could never
# receive. Two agents measuring the same question got opposite, both-correct answers.
#
# Resolution order, and each step earns its place:
#   1. OUTGOING_COPY_GATE_RULES  -- unchanged escape hatch, still wins.
#   2. THIS checkout's own store/ file IF IT EXISTS -- so nothing that works today changes,
#      and a deliberate per-checkout override stays possible.
#   3. the MAIN clone's store/ file -- what a worktree now gets, instead of a dead path.
#   4. this checkout's path anyway -- so a genuinely absent file is still named sanely in
#      the error message.
_RULES_BASENAME = "outgoing-copy-gate-rules.json"


def _main_clone_root(checkout):
    """Main clone root for a git WORKTREE checkout, or "" when this is not one.

    A worktree's `.git` is a FILE holding `gitdir: <main>/.git/worktrees/<name>`; the main
    clone's root is the parent of that `.git` directory. Parsed by hand rather than shelling
    out to `git rev-parse --git-common-dir`, deliberately: this module is imported on EVERY
    Bash tool call of every agent, so a subprocess per call is a real cost for what is one
    small file read. Returns "" on anything unexpected -- an unreadable pointer must degrade
    to the old script-relative answer, never raise inside a hook.
    """
    try:
        with open(os.path.join(checkout, ".git"), encoding="utf-8") as fh:
            head = fh.read(4096)
    except OSError:
        return ""  # a DIRECTORY (main clone) or absent -- nothing to redirect to
    if not head.startswith("gitdir:"):
        return ""
    gitdir = head.split(":", 1)[1].strip()
    marker = os.sep + "worktrees" + os.sep
    idx = gitdir.find(marker)
    if idx < 0:
        return ""
    common = gitdir[:idx]  # <main>/.git
    if os.path.basename(common) != ".git":
        return ""
    return os.path.dirname(common)


def resolve_rules_path(script_dir, env_value=None):
    """Rules-file path that does NOT depend on which checkout invoked the gate."""
    if env_value:
        return env_value
    checkout = os.path.dirname(os.path.dirname(script_dir))  # <checkout>/scripts/hooks -> <checkout>
    local = os.path.join(checkout, "store", _RULES_BASENAME)
    if os.path.exists(local):
        return local
    main_root = _main_clone_root(checkout)
    if main_root:
        shared = os.path.join(main_root, "store", _RULES_BASENAME)
        if os.path.exists(shared):
            return shared
    return local


_LOCAL_RULES = resolve_rules_path(
    os.path.dirname(os.path.abspath(__file__)),
    os.environ.get("OUTGOING_COPY_GATE_RULES"),
)


class _NoBadNamePatterns:
    """Sentinel returned by load_bad_name() when the rules file is PRESENT and VALID but
    declares zero patterns (card 3ec64c96): a deliberate "nothing known yet" configuration,
    distinct from `None` (file missing/unreadable/malformed -- the check apparatus itself is
    broken). `is None` at every call site still means "broken", so this sentinel must never
    equal None while still behaving like "nothing to flag" wherever it is used as a matcher.
    """

    def search(self, _text):
        return None


NO_BAD_NAME_PATTERNS = _NoBadNamePatterns()


def load_bad_name():
    try:
        with open(_LOCAL_RULES, encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError:
        return _log_missing_rules()
    except Exception:
        return _log_missing_rules()
    # The key itself must be PRESENT -- a file missing this key entirely is malformed (someone
    # wrote the wrong shape), not a deliberate "zero patterns" declaration, so it still fails
    # closed like a missing file. Only an EXPLICIT `"bad_name_patterns": []` counts as intentional.
    if "bad_name_patterns" not in data:
        return _log_missing_rules()
    pats = data.get("bad_name_patterns") or []
    if pats:
        # THE COMPILE MUST BE INSIDE A try (card 0c66be37, Cybersec MEDIUM-2 on 98dbbcc9's GO).
        # It was outside, and `BAD_NAME = load_bad_name()` runs at MODULE IMPORT -- so ONE typo'd
        # pattern did not degrade the name check, it killed the ENTIRE hook before it inspected
        # anything. Measured with the real hook: rules ["Kovacs"] -> exit 2 (blocks a broken-accent
        # mail); rules ["Kovacs", "(?<n>x)"] -> exit 1, zero bytes of stdout. Claude Code blocks on
        # exit 2 ONLY, so exit 1 means every outgoing send passes unchecked, fleet-wide, with
        # nothing anywhere to say the control stopped running. A crashing hook does not fail
        # closed; it stops running.
        #
        # Falling back to STATE_BROKEN keeps the ALREADY-MODELLED consequences: the email path is
        # fail-closed on `BAD_NAME is None` (refuses and names the rules file), the Telegram path
        # fail-open with a systemMessage. Both are visible. That is the whole difference between a
        # degraded control and an invisible one.
        try:
            return re.compile("|".join(pats))
        except re.error as exc:
            # NOT _log_missing_rules(): that writes "FAJL HIANYZIK/URES", which would be false here
            # and would send whoever reads the log looking for a file that is present and readable.
            # A wrong explanation is worse than a missing one -- it stops the next reader looking.
            return _log_broken_pattern(exc)
    return NO_BAD_NAME_PATTERNS


# WHY the name check is down, when it is. Set by the loader, read by the two places that TELL
# somebody about it. Without this, a bad pattern produced the missing-file wording -- and an
# operator would go looking for a file that is present, readable and valid JSON (card 0c66be37).
BROKEN_REASON = None


def _log_broken_pattern(exc):
    """The rules file is present and parses, but a PATTERN in it does not compile.

    Returns None (STATE_BROKEN) like the missing-file path, because the consequence is the same --
    the name check cannot run -- but says which of the two it was, and names the offending pattern
    so the fix is one edit rather than a hunt through the list."""
    global BROKEN_REASON
    BROKEN_REASON = f"egy nev-minta nem forditható ({exc})"
    try:
        log_path = os.path.join(os.path.dirname(_LOCAL_RULES), "outgoing-copy-gate.log")
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(f"outgoing-copy-gate: HIBAS NEV-MINTA a szabalyfajlban ({_LOCAL_RULES}): "
                     f"{exc} -- a nev-ellenorzes NEM fut, amig a minta javitva nincs. "
                     "A fajl letezik es olvashato; egy minta nem forditható.\n")
    except OSError:
        pass
    return None


def _log_missing_rules():
    try:
        log_path = os.path.join(os.path.dirname(_LOCAL_RULES), "outgoing-copy-gate.log")
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(f"outgoing-copy-gate: NEV-SZABALY FAJL HIANYZIK/URES ({_LOCAL_RULES}) -- "
                     "a nev-ellenorzes NEM fut; potold a store/outgoing-copy-gate-rules.json-t.\n")
    except OSError:
        pass
    return None


def _name_correction() -> str:
    try:
        with open(_LOCAL_RULES, encoding="utf-8") as fh:
            corr = json.load(fh).get("correction") or ""
        return (" " + corr) if corr else ""
    except Exception:
        return ""


# THREE states, and until card 934dc104 only TWO of them were ever visible. load_bad_name()
# already distinguished them (card 3ec64c96 added the sentinel), but every call site asks
# `is None`, so "deliberately zero patterns" and "healthy with patterns" ran the same silent
# branch: a name filter with nothing to match on looked exactly like a working one.
STATE_ACTIVE = "active"    # file present, valid, >=1 pattern -- the check really checks
STATE_EMPTY = "empty"      # file present, valid, ZERO patterns -- deliberate, but inert
STATE_BROKEN = "broken"    # missing / unreadable / malformed -- the apparatus itself is down


def bad_name_state(value):
    """Classify what load_bad_name() returned. Pure, so the three states are assertable."""
    if value is None:
        return STATE_BROKEN
    if value is NO_BAD_NAME_PATTERNS:
        return STATE_EMPTY
    return STATE_ACTIVE


_EMPTY_WARN_STAMP = ".outgoing-copy-gate-empty-warned"
_EMPTY_WARN_INTERVAL_S = 6 * 3600


def _log_empty_rules(now=None, interval=_EMPTY_WARN_INTERVAL_S):
    """One visible line for the DELIBERATELY-EMPTY state. Returns True if it wrote.

    RATE-LIMITED by a stamp file, and that is not premature caution: this module is imported
    on every Bash tool call, and the unconditional missing-file line is precisely what grew
    store/outgoing-copy-gate.log to 2 MB before the sentinel landed. A signal that costs a
    log line per shell command gets the gate switched off, which protects nothing.

    Deliberately NOT a per-send systemMessage: that would fire on every single outgoing
    Telegram message of the busiest channel in the fleet. The on-demand, checkout-independent
    readout is `outgoing-copy-gate.py --status`; this line is the passive breadcrumb.
    """
    store_dir = os.path.dirname(_LOCAL_RULES)
    stamp = os.path.join(store_dir, _EMPTY_WARN_STAMP)
    now = time.time() if now is None else now
    try:
        if now - os.path.getmtime(stamp) < interval:
            return False
    except OSError:
        pass  # no stamp yet (or unreadable) -- treat as due
    try:
        with open(os.path.join(store_dir, "outgoing-copy-gate.log"), "a", encoding="utf-8") as fh:
            fh.write(f"outgoing-copy-gate: NEV-SZABALY SZANDEKOSAN URES ({_LOCAL_RULES}, "
                     "bad_name_patterns: 0) -- a fajl ep, de a nev-ellenorzesnek NINCS mire "
                     "illeszkednie; a tobbi ellenorzes (ekezet, em dash, homoglifa) fut. "
                     "Posztura-kiiras: scripts/hooks/outgoing-copy-gate.py --status\n")
        with open(stamp, "w", encoding="utf-8") as fh:
            fh.write("")
    except OSError:
        return False
    return True


BAD_NAME = load_bad_name()
BAD_NAME_STATE = bad_name_state(BAD_NAME)
if BAD_NAME_STATE == STATE_EMPTY:
    _log_empty_rules()
ACCENTED = set("áéíóöőúüűÁÉÍÓÖŐÚÜŰ")
TAG = re.compile(r"<[^>]+>")

# GATEKOTOJEL817 + GATEHYPH816 (2026-08-19 este, ket hamis pozitiv elo
# gazda-beszelgetesben, ot perc alatt): a kapu nem tett kulonbseget PROZA es
# AZONOSITO kozott. (1) `Drive-ot` -- az idegen tulajdonnevhez a magyar
# toldalek kotojellel kapcsolodik (ez a HELYES iras), de a betu-only WORD
# tokenizalo a kotojelnel vagott, es a maradek `ot` darabot onallo magyar
# szonak nezte (ot -> öt). (2) `Video atalakitas` -- egy Drive-mappa NEVE a
# szovegben: mondatkozi nagybetus szo, azonosito, nem proza. A javitas a
# TOKENIZALAS, nem a szotar (szo-kivetel a valodi hibakat is atengedne):
#   - kotojeles alaknal a TELJES szoalak vizsgalando (a `drive-ot` egeszkent
#     nincs a szotarban -> atmegy; az onallo `ot` prozaban tovabbra is bukik);
#   - a MONDATKOZI nagybetus szo azonosito/tulajdonnev -> kimarad; mondat
#     elejen (. ! ? : ujsor vagy lista-jel utan) a nagybetu normal proza,
#     ott tovabbra is vizsgaljuk.
#
# Cybersec elo reprodukalt bypass-a (2026-08-26, fbb36b41 gate, GATEKOTOJEL817
# regresszio): a fenti "mondatkozi nagybetus szo = azonosito" szabaly TUL TAG
# volt -- BARMELY nagybetuvel kezdodo, mondat kozepen allo magyar szot kimart,
# nem csak a valodi azonositokat. `audit('Sziasztok, a Keszen allo Uzenet mar
# elment, minden Kerdes megoldva.')` -> [] volt, pedig harom valodi ekezet-
# hiba van benne (Keszen/Uzenet/Kerdes mind a szotarban). Javitas: a kihagyas
# MOSTANTOL csak akkor jar, ha a kisbetus alak SZEREPEL az IDENTIFIER_ALLOWLIST-
# ben (ismert, korabban valodi hamis-pozitivkent jelentkezett azonosito/
# tulajdonnev) -- nem minden nagybetus mondatkozi szora. Uj azonosito csak
# szandekos bovitessel kerulhet ide, nem automatikusan.
#
# Cybersec masodik korulasa (2026-08-26, ugyanaz a gate, round 8): a "video"
# bejegyzes MAGA IS szerepelt az ACCENTLESS szotarban (video -> videó) -- egy
# szo nem lehet EGYSZERRE "mindig javitando magyar szo" ES "azonositokent
# kihagyando", ez ugyanaz a hibaosztaly szukebb korben. `audit('...uj Video
# amit kertetek...')` nem kapta el, pedig valodi hiba. KIVETEL: "video" innen
# torolve (a Drive-mappa NEVKENT hivatkozott "Video atalakitas" forma mostantol
# ismet elakad -- ez SZANDEKOSAN a biztonsagosabb irany: egy hamis-pozitiv
# azonosito-hivatkozas emberi felulvizsgalatot igenyel, egy csendben atengedett
# valodi ekezethiba nem javithato utolag). STRUKTURALIS VEDELEM: az assert
# lent megakadalyozza, hogy ez a hibaosztaly egy jovobeli bovitessel csendben
# visszaterjen -- ha valaki ACCENTLESS-ben mar szereplo szot venne fel ide,
# a modul betoltese azonnal elszall, nem egy elo reprodukcio talalja meg.
IDENTIFIER_ALLOWLIST = {"drive"}
_overlap = IDENTIFIER_ALLOWLIST & set(ACCENTLESS)
assert not _overlap, (
    f"outgoing-copy-gate: IDENTIFIER_ALLOWLIST es ACCENTLESS metszik egymast ({_overlap}) -- "
    "egy szo nem lehet egyszerre 'mindig javitando' es 'azonositokent kihagyando' "
    "(Cybersec lelet, fbb36b41 round 8)."
)
del _overlap
HYPHEN_WORD = re.compile(r"[a-záéíóöőúüűA-ZÁÉÍÓÖŐÚÜŰ]+(?:-[a-záéíóöőúüűA-ZÁÉÍÓÖŐÚÜŰ]+)*")

# DIGIT-HYPHEN SUFFIX allowlist (Cybersec NO-GO, fbb36b41 round 11): a bevezeto valtozat
# a szamjegy-kotojel elotag utani szot FELTETEL NELKUL kihagyta -- de a HYPHEN_WORD
# tetszoleges hosszu/alaku szot illeszt ott, nem csak a szandekolt rovid szamnevi
# toldalekot. `5-keszen` -> a 'keszen' (valodi ekezethiba) NEM jelent meg a talalatok
# kozott. Ugyanaz a hibaosztaly, mint az IDENTIFIER_ALLOWLIST-nel fentebb (round 7/8):
# a kihagyas MOSTANTOL csak egy zart, ismert-rovid szamnevi-toldalek halmazra vonatkozik,
# nem tetszoleges digit-kotojel-utani szora.
DIGIT_HYPHEN_SUFFIX_ALLOWLIST = {"es", "as", "os", "ös"}
assert all(len(w) <= 3 for w in DIGIT_HYPHEN_SUFFIX_ALLOWLIST), (
    "outgoing-copy-gate: DIGIT_HYPHEN_SUFFIX_ALLOWLIST csak rovid szamnevi toldalekot "
    "tartalmazhat (Cybersec lelet, fbb36b41 round 11) -- egy hosszabb bejegyzes ujra "
    "kinyitna a bejelentett bypasst."
)


def _at_sentence_start(text: str, idx: int) -> bool:
    i = idx - 1
    while i >= 0 and text[i] in " \t\"'([{":
        i -= 1
    if i < 0:
        return True
    ch = text[i]
    if ch in ".!?:\n":
        return True
    if ch in "-*•":
        j = i - 1
        while j >= 0 and text[j] in " \t":
            j -= 1
        return j < 0 or text[j] == "\n"
    return False


def accent_check_tokens(prose: str):
    """(lowercase alak, kezdo-pozicio) parok az ekezet-vizsgalathoz."""
    out = []
    for m in HYPHEN_WORD.finditer(prose):
        tok = m.group(0)
        # DIGIT-HYPHEN SUFFIX (429-es, 403-as, 2026-os, 3420-as). A HYPHEN_WORD
        # csak betuket enged a kotojel korul, ezert egy szamhoz tapadt magyar
        # toldalek onallo szonak latszik -- es az "es" ekezet-nelkuli "és"-kent
        # olvasodna. Ezek nem mondatbeli szavak, nincs ekezetuk.
        # (2026-08-21: a kapu blokkolt egy helyes "429-es vagy 403-as" uzenetet.
        # A GATEKOTOJEL817 a betu-kotojel-betu alakot fedte, ezt nem.)
        # Round 11 szukites: csak a DIGIT_HYPHEN_SUFFIX_ALLOWLIST-ben szereplo rovid
        # toldalek marad ki, nem barmilyen szamjegy-kotojel utani szo (lasd fent).
        if (m.start() >= 2 and prose[m.start() - 1] == "-" and prose[m.start() - 2].isdigit()
                and tok.lower() in DIGIT_HYPHEN_SUFFIX_ALLOWLIST):
            continue
        if ("-" not in tok and tok[0].isupper() and not _at_sentence_start(prose, m.start())
                and tok.lower() in IDENTIFIER_ALLOWLIST):
            continue
        out.append((tok.lower(), m.start()))
    return out


def _hit_context(prose: str, pos: int, length: int) -> str:
    """A talalat elotti/utani 3-3 szo + karakter-pozicio (GATEHYPH816 (B):
    elo beszelgetes kozben ne kelljen greppelni, melyik szorol van szo)."""
    before = prose[:pos].split()[-3:]
    token = prose[pos:pos + length]
    after = prose[pos + length:].split()[:3]
    frag = " ".join(before + [token] + after)
    return f'"...{frag}..." @{pos}'


# Technikai tokenek maszkolasa AZ EKEZET-ELLENORZES ELOTT. Merve 2026-08-13, a
# +48-as bovites negativ kontrolljan: egy HIBATLANUL ekezetezett eles level
# fennakadt a `video_view` esemenynevben levo "video"-n. A szobonto az aláhúzást
# hataroljelnek veszi, tehat minden snake_case azonosito, fajlnev, URL-slug es
# domain beszallit egy "magyar szot", ami ott ekezet nelkul HELYES. Ugyanaz az
# osztaly, mint a 2026-08-11-i `level` fajlnev-talalat. A javitas nem a szotarbol
# vesz ki (az elrontana a valodi talalatokat is), hanem a technikai regiokat
# vagja ki a vizsgalt szovegbol. A gondolatjel- es nev-ellenorzes NEM ezen fut.
TECHNICAL = re.compile(
    r"""https?://\S+                # URL
      | [\w.+-]+@[\w-]+\.[\w.]+     # email
      | `[^`]*`                     # kod-span
      | \b\w+(?:_\w+)+\b            # snake_case azonosito
      | \b\w+\.[A-Za-z]{2,10}\b     # fajlnev / domain (video.mp4, marveen.io)
      | \b[\w-]*/[\w/-]+            # utvonal / slug
    """,
    re.X,
)


def strip_technical(text: str) -> str:
    return TECHNICAL.sub(" ", text)


def is_hungarian(text: str) -> bool:
    low = text.lower()
    return sum(1 for m in HU_MARKERS if m in low) >= 3


# GATETG816 (2026-08-16, Marveen merese): az is_hungarian() funkcionalis szavakra
# szur, ezert a TOMOR, tenykozol, felsorolasos magyar uzenet (pont a fo agens
# Telegram-stilusa) nem eri el a 3 markert, es az ekezet-vizsgalat el sem indul --
# a mai napindito elso bekezdese ekezetlenul atment. A nyelv-detektor ezert nem
# EGYEDULI kapu tobbe: egyetlen olyan szotar-talalat, ami magyarul ekezet nelkul
# NEM letezik ES angol/technikai szokent sem ertelmezheto, onmagaban eleg ok a
# vizsgalatra. Az alabbi kizaras CSAK a triggerre vonatkozik: ha a szoveg mas
# uton magyarnak bizonyult, ezek a talalatok is jelentesre kerulnek -- de egyedul
# nem ranthatnak be egy angol szoveget az auditba ("the all-new level editor").
AMBIGUOUS_TRIGGER = {
    "es", "ar", "arak", "ev", "evi", "ot", "uj", "ujat", "het", "ora", "mas",
    "all", "level", "video", "netto",
}


def accentless_evidence(words):
    return {w for w in words if w in ACCENTLESS and w not in AMBIGUOUS_TRIGGER}


def collect_bash_body(cmd: str):
    """Return (text, unreadable_reason). text is '' when nothing was recovered."""
    parts = []
    for m in re.finditer(r"--(?:body|subject)[= ]+(\"([^\"]*)\"|'([^']*)'|(\S+))", cmd):
        val = m.group(2) or m.group(3) or m.group(4) or ""
        # A shell-expanded --body ($(cat f), `cat f`, $VAR) reaches this hook
        # UNEXPANDED: what we would audit is the literal command text, not the
        # letter. That is worse than useless -- it fires on words that happen to
        # sit in the PATH while the real copy goes uninspected. Measured
        # 2026-08-11 on a live customer letter: `--body "$(cat .../hidli_zaro_
        # level.txt)"` blocked on "level" from the FILENAME, and the letter
        # itself was never read. Same fail-closed rule as the `<` branch below.
        if re.search(r"\$\(|`|\$\{?\w", val):
            return ("\n".join(parts),
                    "a --body shell-behelyettesitest tartalmaz, amit a hook nem old fel "
                    f"({val[:60]}...) -- igy a parancs szoveget vizsgalnam, nem a levelet")
        parts.append(val)
    # heredoc payloads sit inline in the command string
    for m in re.finditer(r"<<-?\s*'?(\w+)'?\n(.*?)\n\1", cmd, re.S):
        parts.append(m.group(2))
    # A single `<` only. Without the lookarounds a heredoc (`<<'EOF'`) matches
    # here and the quoted delimiter is taken for a filename -- caught by the
    # first live probe of this gate, which blocked with "'EOF': No such file".
    redirect = re.search(r"(?<!<)<(?!<)\s*([^\s|;&<>]+)", cmd)
    if redirect:
        raw = redirect.group(1)
        path = os.path.expandvars(os.path.expanduser(raw))
        if "$" in path:
            return ("\n".join(parts), f"a torzs egy fel nem oldhato utvonalrol jon ({raw})")
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                parts.append(fh.read())
        except OSError as exc:
            return ("\n".join(parts), f"a torzs-fajl nem olvashato ({path}: {exc})")
    if not parts and re.search(r"\|\s*(python3?|node|tsx)?[^|]*send", cmd):
        return ("", "a torzs egy pipe-bol jon, a hook nem latja")
    return ("\n".join(parts), None)


def collect_mcp_body(tool_input: dict):
    fields = ("body", "text", "html", "htmlBody", "message", "subject", "content")
    got = [str(tool_input[f]) for f in fields if tool_input.get(f)]
    return "\n".join(got)


# --- Telegram reply (GATETG816) ---------------------------------------------
# The reply tool sends MarkdownV2, where every special char arrives escaped
# (\. \( \) \-). Those backslashes sit inside the prose the audit reads, and
# they can split technical tokens or glue fragments in ways the email path
# never sees. Un-escape (backslash before a non-word char) BEFORE auditing --
# this is analysis-only, the outgoing payload is untouched.
MDV2_ESCAPE = re.compile(r"\\([^\w\s])")


def collect_telegram_body(tool_input: dict) -> str:
    fields = ("text", "caption", "message")
    got = [str(tool_input[f]) for f in fields if tool_input.get(f)]
    return MDV2_ESCAPE.sub(r"\1", "\n".join(got))


# --- Telegram sent from a Bash command (card 74181db2) -----------------------
#
# WHY THIS EXISTS AT ALL. The gate's telegram branch matches on the TOOL NAME
# (`telegram.*__reply$`), and a role agent never has that tool: all 15 launch with
# `telegram@claude-plugins-official: false` and without `--channels`
# (agent-worker.ts:458, measured on the running processes). So for them that branch
# is dead code. The route they DO have is the one `telegram-reply-fallback` documents
# for exactly the case where the MCP tool is absent: a raw Bot API call over curl,
# from Bash. Nothing ran on it -- the Bash branch is the EMAIL detector, and
# `collect_telegram_body` only ever read an MCP tool-input.
#
# DEFAULT OFF, AND THAT IS THE POINT (MikroB's decision, card comment 19349). Turning
# this on costs a python start on EVERY Bash call of EVERY role agent -- measured on
# this host at median 23.5 ms (15 samples, loadavg 9.14) for an IRRELEVANT command,
# which is the common case. So the switch is opt-in at BOTH layers: the scaffold does
# not even wire the hook unless it is set (zero cost when off, not merely a fast exit),
# and the gate itself re-checks it here, so an already-wired agent stops enforcing the
# moment the variable goes away -- without regenerating anything.
TELEGRAM_BASH_ENV = "OUTGOING_COPY_GATE_TELEGRAM_BASH"
# The wired command carries the decision as argv, because an environment variable cannot
# reach here: agent panels are started with `tmux new-session` on an ALREADY-RUNNING tmux
# server, and such a session inherits the SERVER's startup environment, not the caller's
# (only names listed in tmux `update-environment` refresh, and this one is not among them).
# So the process that decides to wire the gate writes the decision into the command it
# writes, and this process reads it from there. The env var stays as a second route for
# a manual run and for the tests.
TELEGRAM_BASH_FLAG = "--telegram-bash"


def telegram_bash_enabled(env=None, argv=None) -> bool:
    """Opt-in, and deliberately the INVERSE of the `<GUARD>=off` convention the other
    hooks use. Those default to protecting; this one changes the cost profile of every
    Bash call in the fleet, so an unset variable must mean OFF -- a typo in the name can
    then only leave us where we already are, never silently switch 14 agents on.

    Reads argv FIRST (see TELEGRAM_BASH_FLAG): that is the only channel that actually
    reaches an agent panel, so an env-only check would make the switch unreachable -- wired
    into 14 agents, paying a python start on every Bash call, and enforcing nothing."""
    args = sys.argv[1:] if argv is None else argv
    if TELEGRAM_BASH_FLAG in args:
        return True
    raw = (env if env is not None else os.environ).get(TELEGRAM_BASH_ENV, "")
    return str(raw).strip().lower() in ("1", "on", "true", "yes")


# A Bot API send: the host AND a sending method. Both halves are required -- a bare
# mention of api.telegram.org (a comment, a doc edit, a grep for it) is not a send, and
# `sendMessage` on its own is an ordinary English word pair in prose.
_TG_HOST_RX = re.compile(r"api\.telegram\.org", re.I)
_TG_METHOD_RX = re.compile(
    r"/(sendMessage|sendPhoto|sendDocument|sendVoice|sendAudio|sendVideo|"
    r"sendAnimation|sendMediaGroup|editMessageText)\b",
    re.I,
)


def is_telegram_bash_send(cmd: str) -> bool:
    return bool(_TG_HOST_RX.search(cmd) and _TG_METHOD_RX.search(cmd))


# `text=` / `caption=` as a form field (-d, --data, --data-urlencode, -F), quoted or not.
_TG_FIELD_RX = re.compile(
    r"""(?:^|\s)(?:-d|--data(?:-raw|-urlencode|-binary)?|-F|--form)\s+"""
    r"""(?:"(?:text|caption)=([^"]*)"|'(?:text|caption)=([^']*)'|(?:text|caption)=(\S+))""",
    re.I,
)
# The same two fields inside a JSON body.
_TG_JSON_RX = re.compile(r'"(?:text|caption)"\s*:\s*"((?:\\.|[^"\\])*)"', re.I)
# Anything the shell would expand before curl ever sees it. We hold the UNEXPANDED
# command text, so auditing this would audit the script, not the message.
_TG_UNRESOLVED_RX = re.compile(r"\$\(|`|\$\{?\w")


# Methods where the Bot API makes the text field MANDATORY. For these an empty extraction
# is not "nothing to audit" (a captionless photo), it is a FAILED extraction -- see F3.
_TG_TEXT_REQUIRED_RX = re.compile(r"/(sendMessage|editMessageText)\b", re.I)
# A body handed to curl from a file or stdin (`-d @payload.json`, `--data @-`). The text is
# simply not in the command, so there is nothing to read and saying so is the honest answer.
_TG_FILE_BODY_RX = re.compile(
    r"(?:^|\s)(?:-d|--data(?:-raw|-urlencode|-binary)?|-F|--form)\s+@(\S+)")


def _single_quoted_spans(cmd: str):
    """Character ranges that sit inside '...'.

    Bash substitutes NOTHING inside single quotes -- not `$VAR`, not `$(...)`, not a
    backtick -- so text quoted that way is literal and perfectly readable. Treating it as
    a substitution is what made the gate stand aside on roughly one message in seven
    (measured: 189 of 1478 fleet messages carry a backtick, and our own style rules ask
    for backticked identifiers). Inside "..." the shell DOES substitute, so those spans
    are not literal and are skipped here on purpose.

    Same discipline, opposite direction, as the cd-chain-guard lesson: a guard that reads
    shell has to honour quote semantics, and only '...' is literal.
    """
    spans = []
    i, n = 0, len(cmd)
    while i < n:
        ch = cmd[i]
        if ch == "'":
            j = cmd.find("'", i + 1)
            if j == -1:  # unterminated: treat the remainder as quoted
                spans.append((i + 1, n))
                break
            spans.append((i + 1, j))
            i = j + 1
        elif ch == '"':
            j = i + 1
            while j < n:
                if cmd[j] == "\\":
                    j += 2
                    continue
                if cmd[j] == '"':
                    break
                j += 1
            i = j + 1
        else:
            i += 1
    return spans


def _in_single_quotes(pos: int, spans) -> bool:
    return any(a <= pos < b for a, b in spans)


def collect_telegram_bash_body(cmd: str):
    """Return (text, unreadable_reason) for a Bot API send written in Bash.

    Same recovery discipline as `collect_bash_body`, and the same refusal to guess: a
    body that arrives through `$(cat ...)`, a backtick or a variable is reported as
    unreadable rather than audited, because what we hold is the command, not the message
    (the measured 2026-08-11 email case, where a filename supplied the finding and the
    letter went unread, is the same shape)."""
    parts = []
    sq_spans = _single_quoted_spans(cmd)
    for m in _TG_FIELD_RX.finditer(cmd):
        dq, sq, bare = m.group(1), m.group(2), m.group(3)
        val = dq if dq is not None else (sq if sq is not None else (bare or ""))
        # Only ask about substitution where the shell would actually perform one. The
        # single-quoted group is literal by definition, so a backtick or a `$` in it is
        # just a character in the message (F2).
        if sq is None and _TG_UNRESOLVED_RX.search(val):
            return ("\n".join(parts),
                    f"a Telegram-szoveg shell-behelyettesitest tartalmaz ({val[:60]}...)")
        parts.append(val)
    for m in _TG_JSON_RX.finditer(cmd):
        val = m.group(1)
        # The JSON body is usually written as -d '{...}', i.e. inside single quotes, so the
        # same rule applies -- but the regex cannot see its own delimiter, so the position
        # is checked against the command's quoting instead.
        if not _in_single_quotes(m.start(1), sq_spans) and _TG_UNRESOLVED_RX.search(val):
            return ("\n".join(parts),
                    f"a Telegram-szoveg shell-behelyettesitest tartalmaz ({val[:60]}...)")
        # JSON string escapes only; the MarkdownV2 unescape happens in the caller, once.
        parts.append(val.replace('\\n', '\n').replace('\\"', '"').replace('\\\\', '\\'))
    return ("\n".join(parts), None)


def telegram_bash_gate(cmd: str) -> None:
    """Audit a Bot API send written in Bash. FAIL-OPEN, exactly like `telegram_gate`.

    The reasoning is that branch's, unchanged and deliberately not re-litigated here:
    Telegram is the owner's ONLY supervision channel, so a gate that silences it costs
    more than a slipped accent. That applies to an UNREADABLE body too -- which is where
    this differs from the email path on purpose. Email refuses what it cannot inspect
    because a letter can wait; blocking a supervision message because its text sits in a
    shell variable would trade a spelling rule for a lost report. The refusal is loud
    (a systemMessage the session actually sees) rather than silent, so the hole is
    visible instead of merely permitted. A FOUND problem still blocks."""
    try:
        text, unreadable = collect_telegram_bash_body(cmd)
        if unreadable:
            print(json.dumps({"systemMessage":
                "outgoing-copy-gate (Telegram/Bash): a szoveget NEM tudtam megvizsgalni -- "
                f"{unreadable}. Atengedem (a felugyeleti csatorna nemitasa dragabb), de a "
                "helyesirast ezen a kuldesen SEMMI nem ellenorizte. Ha ellenorizve akarod, "
                "add at a szoveget literalkent (-d \"text=...\")."}))
            sys.exit(0)
        if not text.strip():
            # An empty extraction means two very different things depending on the method.
            # For sendPhoto/sendDocument there may genuinely be no caption. For sendMessage
            # and editMessageText the Bot API REQUIRES the text field, so empty means the
            # extraction failed -- typically a body handed over as `-d @payload.json` or on
            # stdin, which is not in the command at all. That belongs on the loud path, not
            # on a silent exit that looks identical to an irrelevant command (F3).
            if _TG_TEXT_REQUIRED_RX.search(cmd):
                at = _TG_FILE_BODY_RX.search(cmd)
                why = (f"a torzs fajlbol/stdinbol jon ({at.group(1)[:40]}), tehat a szoveg "
                       "nincs benne a parancsban") if at else (
                       "a metodus kotelezove teszi a szoveget, de nem tudtam kinyerni")
                print(json.dumps({"systemMessage":
                    "outgoing-copy-gate (Telegram/Bash): a szoveget NEM tudtam megvizsgalni -- "
                    f"{why}. Atengedem (a felugyeleti csatorna nemitasa dragabb), de a "
                    "helyesirast ezen a kuldesen SEMMI nem ellenorizte. Ha ellenorizve akarod, "
                    "add at a szoveget literalkent (-d \"text=...\")."}))
            sys.exit(0)  # a photo/document send with no caption: nothing to audit
        problems = audit(MDV2_ESCAPE.sub(r"\1", text))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- deliberate blanket: fail-open path
        warn = f"outgoing-copy-gate: TELEGRAM/BASH-ag belso hiba, FAIL-OPEN atengedes: {exc!r}\n"
        sys.stderr.write(warn)
        sys.exit(0)
    if problems:
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU (Telegram, Bash): TILTVA, az uzenet nem mehet ki igy.\n\n"
            + "\n".join(f"  - {p}" for p in problems)
            + "\n\nJavitsd a szoveget es kuldd ujra.\n"
        )
        sys.exit(2)
    sys.exit(0)


def telegram_gate(tool_input: dict) -> None:
    """Audit a Telegram reply. FAIL-OPEN on any internal error (exit 0 + loud
    log): email is deferrable, but Telegram is the owner's ONLY supervision
    channel -- a gate crash that silences it costs more than a slipped accent.
    A FOUND problem still blocks (exit 2): that is the gate's whole point."""
    try:
        text = collect_telegram_body(tool_input)
        if not text.strip():
            sys.exit(0)  # files-only reply or empty text: nothing to audit
        problems = audit(text)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- deliberate blanket: fail-open path
        warn = f"outgoing-copy-gate: TELEGRAM-ag belso hiba, FAIL-OPEN atengedes: {exc!r}\n"
        sys.stderr.write(warn)
        try:
            log_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
                os.path.abspath(__file__)))), "store", "outgoing-copy-gate.log")
            with open(log_path, "a", encoding="utf-8") as fh:
                fh.write(warn)
        except OSError:
            pass
        sys.exit(0)
    if problems:
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU (Telegram): TILTVA, az uzenet nem mehet ki igy.\n\n"
            + "\n".join(f"  - {p}" for p in problems)
            + "\n\nJavitsd a szoveget es kuldd ujra (a MarkdownV2 escape-eket a kapu "
              "az ellenorzes elott feloldja, azok nem szamitanak hibanak).\n"
        )
        sys.exit(2)
    # GATEPERSIST816(2): a hianyzo nev-szabaly a telegram-agon fail-open marad,
    # de a figyelmeztetes ODA megy, ahol a session tenyleg latja -- a hook
    # stdout systemMessage mezoje a futo sessionben jelenik meg, nem egy
    # logfajlban, amit senki nem olvas.
    if BAD_NAME is None:
        print(json.dumps({"systemMessage":
            "outgoing-copy-gate: a nev-ellenorzes NEM fut a kimeno uzeneteken -- "
            f"{BROKEN_REASON or 'a szabalyfajl hianyzik, olvashatatlan vagy rossz alaku'} "
            f"({_LOCAL_RULES}). Javitsd a store/outgoing-copy-gate-rules.json-t."}))
    sys.exit(0)


# --- match-time budget on the name patterns (card 0c66be37) -------------------------------------
#
# THE SECOND DOOR INTO THE SAME ROOM. Guarding the COMPILE stops a typo from killing the hook, but a
# pattern can compile perfectly and then backtrack catastrophically at MATCH time. Measured on this
# host with a pattern the card names -- `zzz(a+)+$` against a body containing `zzz` + 40 `a`s -- the
# hook was STILL RUNNING after 25 seconds. In production it is registered with `timeout: 10`, so
# Claude Code kills it, the exit code is not 2, and the send goes out UNCHECKED with nothing to say
# the control stopped. Byte-identical outcome to the compile crash, reached from the other side, and
# the card asks for the hook-side runtime protection to cover it.
#
# The validator cannot close this alone: its ReDoS check is PROBE-based (a handful of fixed strings
# against the joint regex), so a pattern anchored behind a rare prefix passes validation and is slow
# only on real traffic. That is the card's own LOW, and it is why the budget lives HERE, where the
# actual text is.
#
# A timeout deliberately RAISES rather than returning "no match". The two existing nets then do the
# right thing per path, with no new state to model: the email path's fail-closed wrapper turns it
# into exit 2, and telegram_gate's documented fail-open turns it into exit 0 plus a loud warning.
# Returning None would have been the one wrong answer -- a silent "the name is fine".
NAME_MATCH_BUDGET_DEFAULT_S = 2.0


def _read_name_budget(raw):
    """Parse the budget, and NEVER raise doing it (Cybersec NO-GO on my own fix, card 0c66be37).

    I wrote this line as a bare `float(os.environ.get(...))` at module level -- in the very commit
    that moved a compile INTO a try for exactly this reason. `BUDGET=abc` (or an empty value, or a
    space) raised ValueError at IMPORT, exit 1, zero stdout: the whole hook silently absent on every
    agent. Same defect class, same file, same commit. Measured before fixing: `2` -> exit 2,
    `abc` / `` / ` ` -> exit 1.

    A NON-POSITIVE or unparseable value falls back to the default rather than disabling the timer.
    Disabling has to be SAID, with the literal `off`, because a typo must cost protection nowhere:
    if `-1` or `nonsense` silently meant "no budget", the knob would be a way to switch a control
    off by accident, which is how this class keeps happening.
    """
    if raw is None:
        return NAME_MATCH_BUDGET_DEFAULT_S
    text = str(raw).strip().lower()
    if text == "off":
        return 0.0
    try:
        value = float(text)
    except (TypeError, ValueError):
        return NAME_MATCH_BUDGET_DEFAULT_S
    if not (value > 0) or value != value or value == float("inf"):
        return NAME_MATCH_BUDGET_DEFAULT_S
    return value


NAME_MATCH_BUDGET_S = _read_name_budget(os.environ.get("OUTGOING_COPY_GATE_NAME_BUDGET"))


class NamePatternTimeout(Exception):
    pass


def _name_search(plain):
    """Run the bad-name patterns against `plain` under a wall-clock budget."""
    if not BAD_NAME:
        return None
    # setitimer is POSIX and main-thread only. Where it is unavailable the search still runs, just
    # unbudgeted -- the pre-existing behaviour, and better than refusing to check at all. Stated
    # rather than implied, because "there is a timeout" would otherwise be false on those hosts.
    try:
        import signal
        have_timer = hasattr(signal, "setitimer") and threading.current_thread() is threading.main_thread()
    except Exception:  # noqa: BLE001
        have_timer = False
    if not have_timer or NAME_MATCH_BUDGET_S <= 0:
        return BAD_NAME.search(plain)

    def _fire(_signum, _frame):
        raise NamePatternTimeout(
            f"a nev-minta illesztese tullepte a {NAME_MATCH_BUDGET_S:g}s koltsegkeretet "
            "(valoszinuleg katasztrofalis visszalepes egy mintaban)"
        )

    prev = signal.signal(signal.SIGALRM, _fire)
    signal.setitimer(signal.ITIMER_REAL, NAME_MATCH_BUDGET_S)
    try:
        return BAD_NAME.search(plain)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prev)


def audit(text: str):
    """Return a list of human-readable problems."""
    plain = TAG.sub(" ", text)
    problems = []
    if EM_DASH in plain:
        problems.append(
            f"GONDOLATJEL (em dash, U+2014) {plain.count(EM_DASH)} helyen -- allo szabaly, soha nem mehet ki."
        )
    bad = _name_search(plain)
    if bad:
        problems.append(
            f"HELYTELEN NEV: {bad.group(0)!r} -- a lokal nev-szabaly (store/outgoing-copy-gate-rules.json) szerint helytelen alak; a helyes irast a szabaly-fajl correction mezoje adja." + _name_correction()
        )
    prose = strip_technical(plain)
    # DUPLA KOTOJEL gondolatjel-potlokent (Szabi 2. eszrevetele, 2026-08-16): a
    # " -- " prozaban ugyanugy zavaro, mint a tiltott em dash. A PROZAN merjuk
    # (strip_technical utan), igy a kodreszletek/parancsok --flag alakjai nem
    # erintettek -- azok amugy sem " -- " alakuak (nincs szokoz a kotojelek
    # utan), de a technikai regiok kivagasa a biztos hatar.
    dh = prose.count(" -- ")
    if dh:
        problems.append(
            f"DUPLA KOTOJEL gondolatjel-potlokent {dh} helyen (' -- ') -- Szabi jelzese: "
            "ugyanugy zavaro, mint az em dash. Ird at kotojel nelkul: kettospont, zarojel, vagy uj mondat."
        )
    # 4. ellenorzes (GATEHOMOGLIF816): vegyes irasrendszeru szo. SZANDEKOSAN
    # NEM magyar-kapuzott (elteres Marveen specjetol, ervvel): az FP-vedelem
    # maga a VEGYES-szo szabaly -- egy legitim idegen idezet szavai TISZTA
    # nem-latin betusek, sosem vegyesek. A magyar-kapu itt semmit nem vedene,
    # viszont lyukat utne: egy 2-markeres, hibatlanul ekezetes magyar szoveg
    # homoglifaja atcsuszna (merve: a 'kerlek+koszonom' paros keves a
    # nyelv-detektorhoz). A konkret szot ES karaktert nevezzuk meg, mert a
    # hiba szemre lathatatlan -- enelkul a javitas talalgatas lenne.
    mixed = mixed_script_words(prose)
    if mixed:
        shown = "; ".join(f"{w!r} -- benne {name}" for w, _c, name in mixed[:5])
        more = f" (+{len(mixed) - 5} tovabbi)" if len(mixed) > 5 else ""
        problems.append(
            f"VEGYES IRASRENDSZERU SZO (homoglifa), {len(mixed)} db: {shown}{more}. "
            "Latin szoba keveredett nem-latin betu: olvasva lathatatlan, de a keresest/grepet neman eltori."
        )
    tok_pos = accent_check_tokens(prose)
    words = [w for w, _ in tok_pos]
    if is_hungarian(plain) or accentless_evidence(words):
        hits = sorted({w for w in words if w in ACCENTLESS})
        # Az aranyot is a prozan merjuk: a technikai tokenekben nincs ekezet, tehat
        # egy kodban gazdag, egyebkent helyes level aranyat lefele huznak.
        letters = sum(1 for ch in prose if ch.isalpha())
        acc = sum(1 for ch in prose if ch in ACCENTED)
        ratio = (acc / letters) if letters else 0.0
        if hits:
            first_pos = {}
            for w, p in tok_pos:
                if w in ACCENTLESS and w not in first_pos:
                    first_pos[w] = p
            shown = ", ".join(
                f"{h} -> {ACCENTLESS[h]} ({_hit_context(prose, first_pos[h], len(h))})"
                for h in hits[:12]
            )
            more = f" (+{len(hits) - 12} tovabbi)" if len(hits) > 12 else ""
            problems.append(f"HIANYZO EKEZETEK, {len(hits)} szo: {shown}{more}")
        elif letters > 200 and ratio < 0.01:
            problems.append(
                f"MAGYAR SZOVEG GYAKORLATILAG EKEZET NELKUL (ekezet-arany {ratio:.3%}, {letters} betun). "
                "A szolistam nem talalt konkret talalatot, de az arany onmagaban gepi atirasra utal -- olvasd vissza."
            )
    return problems


def _pattern_count():
    """How MANY name patterns are configured. The count only -- never the patterns.

    GATEPERSIST816: the rules file is 0600 and names a private third party. A posture
    report has to be safe to paste into a card or a chat, so this is the one number it
    is allowed to know about the contents.
    """
    try:
        with open(_LOCAL_RULES, encoding="utf-8") as fh:
            return len(json.load(fh).get("bad_name_patterns") or [])
    except Exception:
        return 0


def status_report():
    """The gate's own posture, in words, from wherever it is invoked (card 934dc104).

    The finding that opened that card was not a broken check -- it was that nobody could
    ANSWER the question. Two agents measured the same gate from two checkouts and got
    opposite, both-correct answers, because the answer depended on the caller. This prints
    the answer, and prints WHICH file it read, so the next person does not have to infer it.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    checkout = os.path.dirname(os.path.dirname(script_dir))
    main_root = _main_clone_root(checkout)
    if main_root:
        where = u"worktree (%s), fő klón: %s" % (checkout, main_root)
    else:
        where = u"fő klón (%s)" % checkout
    if os.environ.get("OUTGOING_COPY_GATE_RULES"):
        where += u" [OUTGOING_COPY_GATE_RULES felülírja az útvonalat]"
    verdict = {
        STATE_ACTIVE: u"ACTIVE -- %d minta betöltve, a névellenőrzés valóban ellenőriz" % _pattern_count(),
        STATE_EMPTY: u"EMPTY -- a fájl ép, de NULLA minta van benne: a névellenőrzés "
                     u"szándékosan hatástalan (a többi ellenőrzés fut)",
        STATE_BROKEN: u"BROKEN -- a fájl hiányzik, olvashatatlan vagy rossz alakú: "
                      u"a névellenőrzés nem tud lefutni",
    }[BAD_NAME_STATE]
    email = u"TILT (fail-closed)" if BAD_NAME_STATE == STATE_BROKEN else u"átenged"
    telegram = (u"átenged + systemMessage figyelmeztetés" if BAD_NAME_STATE == STATE_BROKEN
                else u"átenged")
    return u"\n".join([
        u"outgoing-copy-gate posztúra",
        u"  hívó checkout : " + where,
        u"  szabályfájl   : " + _LOCAL_RULES,
        u"  létezik       : " + (u"igen" if os.path.exists(_LOCAL_RULES) else u"NEM"),
        u"  állapot       : " + verdict,
        u"  email-ág      : " + email,
        u"  telegram-ág   : " + telegram,
        u"  megjegyzés    : a minták TARTALMÁT ez a kiírás soha nem mutatja "
        u"(a fájl 0600, magánszemély nevét tartalmazza).",
    ])


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # unparseable payload must not wedge the session

    tool = str(payload.get("tool_name") or "")
    tool_input = payload.get("tool_input") or {}

    if re.search(r"telegram.*__reply$", tool, re.I):
        telegram_gate(tool_input)  # exits; never falls through
    if re.search(r"send_email", tool, re.I):
        text, unreadable = collect_mcp_body(tool_input), None
    elif tool == "Bash":
        cmd = str(tool_input.get("command") or "")
        # Card 74181db2: a Bot API send written in Bash is the ONLY Telegram route a role
        # agent has (see telegram_bash_gate).
        #
        # THE EMAIL DETECTOR RUNS FIRST, and the order is load-bearing rather than tidy. I
        # wrote it the other way round first, on the reasoning that the two are disjoint --
        # `is_send_invocation` looks for mail vendors, a Bot API call names none. They are not
        # disjoint on the CONTENT: an email whose body merely MENTIONS
        # `api.telegram.org/.../sendMessage` satisfies this detector, and since the telegram
        # branch is fail-OPEN while the email branch is fail-CLOSED, that hijacked the stricter
        # path with the looser one. Measured before fixing: a resend.com send with stripped
        # Hungarian accents and that URL in its prose exited 0 (unchecked) instead of 2.
        #
        # Email first makes the failure direction safe: a Telegram send names no mail vendor,
        # so it still reaches the branch below; and anything that looks like BOTH is treated as
        # the email it is, on the fail-closed path.
        if is_send_invocation(cmd):
            text, unreadable = collect_bash_body(cmd)
        elif telegram_bash_enabled() and is_telegram_bash_send(cmd):
            telegram_bash_gate(cmd)  # exits; never falls through
        else:
            sys.exit(0)
    else:
        sys.exit(0)

    if unreadable or not text.strip():
        reason = unreadable or "a hook nem talalt vizsgalhato szoveget a hivasban"
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA, mert a levelet nem tudtam megvizsgalni.\n"
            f"Ok: {reason}.\n\n"
            "Ez szandekosan fail-closed: egy vizsgalhatatlan kuldes pont a kaput utne ki.\n"
            "Tedd vizsgalhatova, aztan kuldd ujra -- ABSZOLUT utvonalu stdin-atiranyitas "
            "(< /teljes/ut/body.txt, shell-valtozo NELKUL), vagy --body-ban atadott szoveg.\n"
        )
        sys.exit(2)

    # GATEPERSIST816(2): az EMAIL ut a hianyzo nev-szabalyra FAIL-CLOSED. A
    # level halaszthato, es pont a vevo fele a legdragabb a rossz nev -- egy
    # csendben lealit nev-ellenorzes mellett kuldeni rosszabb, mint megvarni a
    # szabaly-fajl potlasat. (A telegram-ag fail-open marad systemMessage
    # figyelmeztetessel: az a felugyeleti csatorna, ott a nemulas a dragabb.)
    if BAD_NAME is None:
        # Card 0c66be37: say WHICH of the two broke. "hianyzik/ures" was the only wording, and a
        # bad pattern now reaches here too -- sending the reader after a file that is present and
        # valid. The consequence is identical (the check cannot run); the fix is not.
        why = BROKEN_REASON or "a fajl hianyzik, olvashatatlan vagy rossz alaku"
        sys.stderr.write(
            f"KIMENO-SZOVEG KAPU: TILTVA -- a nev-ellenorzes nem tud lefutni: {why} "
            f"({_LOCAL_RULES}).\n"
            "Email fail-closed: javitsd a store/outgoing-copy-gate-rules.json-t "
            "(bad_name_patterns + correction), aztan kuldd ujra.\n"
        )
        sys.exit(2)

    problems = audit(text)
    if problems:
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA, a levél nem mehet ki így.\n\n"
            + "\n".join(f"  - {p}" for p in problems)
            + "\n\nJavitsd a szoveget es kuldd ujra. Ekezetes magyar szoveg a vevo fele "
              "nem stiluskerdes: Szabi 2026-08-10-en ket kulon esetben kerte szamon.\n"
        )
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    # --status is a READ-ONLY posture readout. PreToolUse DOES pass argv now (the wired
    # command carries TELEGRAM_BASH_FLAG), so this checks argv[1] for --status specifically
    # rather than merely for the presence of arguments -- `... outgoing-copy-gate.py
    # --telegram-bash` must take the gate path, not print a report and exit 0.
    if len(sys.argv) > 1 and sys.argv[1] == "--status":
        print(status_report())
        sys.exit(0)
    # Upstream's fail-closed net, adopted on card 630d9864 (B-wave). It was recorded as "a
    # candidate for future adoption, not yet taken" and it is the one genuinely open item in this
    # file -- MEASURED before adopting: a payload whose tool_input is not a dict (e.g. a bare
    # string) made collect_mcp_body() raise AttributeError, python exited 1, and PreToolUse treats
    # 1 as NON-blocking, so the send ran UNCHECKED. That is the exact inverse of this gate's
    # fail-closed contract, reached by a malformed call rather than by any decision.
    #
    # It sits AFTER the --status branch on purpose: --status is a human-invoked read-only readout,
    # never a hook path, and answering a status question with a "TILTVA" send-refusal would be a
    # lie about what failed.
    #
    # The telegram path never reaches this net: telegram_gate() catches its own errors and exits 0
    # (fail-open BY DESIGN -- Telegram is the owner's only supervision channel, so silence there
    # costs more than a slipped accent). Verified in this fork, not assumed from upstream's
    # comment. So this only ever catches the email/Bash send paths, where blocking is the safe
    # failure mode.
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- deliberate blanket: fail-closed net
        sys.stderr.write(
            "KIMENO-SZOVEG KAPU: TILTVA, belso hiba a vizsgalat kozben "
            f"({exc!r}).\n"
            "Fail-closed: egy vizsgalhatatlan kuldes pont a kaput utne ki. "
            "Tedd vizsgalhatova a hivast, aztan kuldd ujra.\n"
        )
        sys.exit(2)

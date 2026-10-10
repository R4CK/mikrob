#!/usr/bin/env python3
"""SMS kuldes a SeeMe (LINK Mobility) atjaron, BEEPITETT jovahagyas-kapuval.

>>> EZ SZANKCIONALT UT, NEM KIKENYSZERITETT KAPU. OLVASD EL, MIELOTT AZT HISZED,
    HOGY EZ A SZKRIPT MAGA A VEDELEM. <<<
Ez a fajl EGY HELYES modja annak, hogy egy fleet-agens SeeMe-n keresztul SMS-t
kuldjon -- NEM az EGYETLEN technikai ut. Egy agens ezutan is irhat nyers HTTP GET-et
a `https://seeme.hu/gateway`-re, es SEMMI nem allitja meg gepileg: a kredencialis
(store/seeme-gateway.env) olvashato annak, aki idaig eljut, es a SeeMe API maga nem
ismeri az `external_message` fogalmat. UGYANEZ A HIANY ALL FENN AZ `sms-send.py`
TESTVERENEL IS (sms-gate.app), es ott korabban nem lett kimondva -- itt potoljuk.
A kapu erteke tehat NEM az, hogy a rossz ut lehetetlen, hanem hogy VAN helyes ut, es
ha valaki azt hasznalja, a jovahagyas es a naplo garantalt. (marveen am#19092, kartya
`adbabf7f`, 1. kikotes.)

MIERT KuLoN FAJL, ES NEM AZ `sms-send.py` BoVITESE: az `sms-send.py` az sms-gate.app
(sajat, fizikai Android-telefon atjaro) API-jat beszeli (Basic auth, POST, JSON body,
opcionalis vegpontok-kozotti AES-titkositas). A SeeMe egy MASIK, felhos szolgaltato,
MAS API-alakkal (GET, kulcs a query-stringben, nincs kliens-oldali titkositasi
lehetoseg) -- ket kulonbozo protokoll egy fajlba eroltetese tobb elagazast adna, mint
ket olvashato fajl. A KoVETKEZo negy bekezdes minden atvett vedelmi elemet EGYENKENT
indokol -- ez a masodik kikotes (ne masold vakon).

ATVETT ELEMEK, ES MIERT (ellenorizve a sajat testverenel, nem feltetelezve):
  1. STDIN-rol jovo szoveg, nem argumentumkent. UGYANAZ A KOCKAZAT: a magyar szoveg
     idezojelet tartalmaz, arg-modban a shell szettori.
  2. Belso/kulso osztalyozas + default-deny lista. UGYANAZ AZ ELV (a `external_message`
     kategoria level=1 ES maxLevel=1, locked -- SOHA nem autonom), DE A LISTA MAGA
     KuLoN FAJL, MERT NEM oRoKoLHETo VALTOZATLANUL -- lasd store/seeme-internal-numbers.json
     sajat fejleceben, miert (a ket sms-gate.app-os bejegyzesbol csak EGY vonatkozik ide).
  3. `external_message` approval, EGYSZER-HASZNALATOS, IDoKORLATOS, a pontos
     cimzett+szoveg parhoz hash-sel kotve (779b9660, fd10c70b WhiteHat F1 utan --
     korabban a leirasban SZOVEGESEN kellett szerepelnie a cimzett szamanak, ez
     reszsztring-hamisithato volt). VALTOZATLANUL atvett ELV: ugyanaz a
     kormanyzasi tabla (approvals), ugyanaz a kategoria, a governance-nak nincs
     koze ahhoz, MELYIK gateway viszi tovabb az uzenetet -- csak a lekerdezes
     MODJA (kozvetlen SQLite, nem HTTP) kovet egy masik, mar meglevo fleet-
     mintat (scripts/hooks/email-approval-gate.py, EMAILKAPU901 PR2).
  4. NINCS UJRAKuLDES (retry). VALTOZATLANUL atvett: egy kimeno SMS nem idempotens
     FUGGETLENuL attol, melyik gateway kuldi -- egy nema halozati hiba utani "biztos
     ami biztos" ujraprobalkozas itt is ket SMS-t jelenthet.
  5. Naplo egy sima fajlba (store/seeme-send.log). VALTOZATLANUL atvett: retry nelkul
     a nyom az EGYETLEN mod annak eldontesere utolag, mi tortent.
  6. Hosszkorlat (1600 karakter) vak kuldes ellen. VALTOZATLANUL atvett: ugyanaz a
     sanity-check, ha valaki veletlenul egy tobbezer karakteres szoveget csovezetne be.

TUDATOSAN NEM ATVETT ELEMEK, ES MIERT:
  - KLIENS-OLDALI TITKOSITAS (sms_crypto.py): az sms-gate.app tamogatja, mert egy
    HARMADIK FEL FELHOJEN at egy FIZIKAI telefonra jut el az uzenet, es a szolgaltato
    sajat specifikacioja szerint be lehet kotni vegpontok kozotti titkositast. A SeeMe
    API-nak NINCS ilyen funkcioja -- egy sima GET query-stringben viszi a szoveget,
    ES a Cirmi CRM SAJAT, MAR ELESBEN FUTo kodja (`src/lib/sms.ts`) IS igy kuld, ma is,
    minden ugyfelnek meno automatikus SMS-nel. Ha itt titkositast probalnank epiteni, a
    SeeMe oldal nem tudna dekodolni -- ez nem hianyossag, hanem MAS PROTOKOLL.
  - EGYEDI USER-AGENT Cloudflare-blokk ellen: az sms-gate.app-nal EZT MERVE talaltak meg
    (403 "error code: 1010" alapertelmezett urllib UA-val). A `seeme.hu/gateway`-re ez
    NINCS MERVE -- sem megerositve, sem cafolva. Ala teszek egy sajat, azonosithato
    User-Agentet ELoVIGYAZATOSSAGBOL (olcso, artalmatlan), DE HA EZ MEGIS ELoALL, NE
    ISMETELD A SMS-GATE.APP DIAGNoZISAT VAKON -- merd le UJRA erre a hostra.

HASZNALAT:
  printf '%s' "A szoveg" | python3 scripts/sms/seeme-send.py --to 36301234567 [--approval <uuid>]
  printf '%s' "A szoveg" | python3 scripts/sms/seeme-send.py --to 36305552860 --dry-run

  --dry-run    : a cimzett-alakot, az osztalyozast es a KAPUT ellenorzi, kiirja, van-e
                 credentials -- de NEM kuld, credentials nelkul is lefut, ES NEM
                 hasznalja fel (consume) az approval-t (lasd lent).
  --approval   : kulso cimzettnel KOTELEZO, UUID alak. 779b9660 (fd10c70b WhiteHat
                 F1) ota a jovahagyas az approvals adatbazisban KOTVE van a pontos
                 cimzett+szoveg parhoz (content_hash = sha256(cimzett+"\n"+szoveg)),
                 EGYSZER-HASZNALATOS (atomikus consumed_at, ugyanaz a mechanizmus,
                 mint scripts/hooks/email-approval-gate.py-ban, EMAILKAPU901 PR2) es
                 IDoKORLATOS (az approval dontesetol -- resolved_at -- SEEME_APPROVAL_WINDOW_S
                 masodpercig friss, alapertelmezetten 1800 = 30 perc, ugyanaz az
                 ablak, mint az email-kapunal). A leiras szoveges cimzett-egyezese
                 (korabbi, reszsztring-alapu ellenorzes) EZZEL MEGSZuNT: a hash-kotes
                 strukturalisan kizarja, hogy egy johavagyas mas cimzettre vagy mas
                 szovegre ervenyes legyen, tehat nincs mit a leirasbol kiolvasni.
  --reference  : sajat azonosito a SeeMe fele (opcionalis, alapertelmezetten
                 `fleet-adhoc-<unix-ido>`). Csak `[A-Za-z0-9._-]` (max 64 karakter) --
                 lasd F3 lejjebb.

CREDENTIALS: store/seeme-gateway.env (0600), sorai:
  SEEME_API_KEY=...
  SEEME_SENDER=...              # a felado-azonosito, pl. 36305555091
  SEEME_BASE=https://seeme.hu/gateway   # opcionalis, alapertelmezett ugyanez
BELSO SZAMOK: store/seeme-internal-numbers.json -> {"internal": ["36305552860", ...]}
  Ami ITT nincs benne, az KULSO, es approval-kotelesse valik. Default-deny.
  A SZAMFORMATUM ITT ES A KULDESNEL IS: '+' NELKuLI nemzetkozi alak (36...), ahogy a
  SeeMe API varja -- lasd kaszap-crm/src/lib/sms.ts normalizeHungarianMobile().

JoVAHAGYAS KERESE (kulso cimzettnel, a hash-sel):
  HASH=$(printf '%s\n%s' "<cimzett, pl. 36301234567>" "<a pontos szoveg>" | sha256sum | cut -d' ' -f1)
  printf 'Authorization: Bearer %s\n' "$(cat store/.dashboard-token)" | curl -H @- -s \
    -X POST http://localhost:3420/api/approvals -H 'Content-Type: application/json' \
    -d "{\"agent_id\":\"<a te neved>\",\"category\":\"external_message\",\"content_hash\":\"$HASH\",
         \"action_description\":\"SMS a 36301234567 szamra (SeeMe). Szoveg: <a pontos szoveg szo szerint>. Indok: <...>\"}"
  A kuldeskor megadott --to es a STDIN-rol jovo szoveg MUSZAJ bajtra pontosan egyezzen
  azzal, amire a hash keszult -- a legkisebb elteres (nagybetu, szokoz, uj sor) mas
  hash-t ad, es az approval nem fog illeszkedni (F1 pontosan ezt zarja ki).
  A `action_description`-nek SZO SZERINT tartalmazni KELL a normalizalt (36...) cimzettet
  ES a pontos kuldendo szoveget (CYBERED C1, msg 14141): a hash onmagaban nem lathato a
  johavagyonak, csak ez a szoveg -- ha a leiras nem egyezik azzal, ami tenylegesen elmegy,
  a kuldes elutasitva, FUGGETLENUL attol, hogy a hash matematikailag egyezik-e.
"""
import argparse, hashlib, json, os, re, sqlite3, sys, time, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENV_FILE = os.path.join(ROOT, "store", "seeme-gateway.env")
# INTERNAL_FILE es DASH_TOKEN_FILE felulirhato env-valtozoval -- KIZAROLAG a
# hermetikus teszt (seeme-send.test.sh) miatt, ami egy fris checkoutban (CI,
# uj worktree) SOSEM latja a valodi store/ tartalmat (gitignore-olt). Alapertelmezett
# viselkedes valtozatlan: eles hasznalatnal egyik env-valtozo sincs beallitva, tehat
# a ROOT-hoz kepesti utvonal marad ervenyben. Mert eset: script-tests-runner.test.ts
# a CI-n PIROSAT adott (`osztalyozas` mindig KULSO -- "a fajl NEM LETEZIK"), mert a
# +36305552860 teszt-szam csak az EN sajat, nem-committolt store/seeme-internal-
# numbers.json-omban szerepelt -- egy fris checkout ezt sosem latja.
INTERNAL_FILE = os.environ.get("SEEME_INTERNAL_FILE") or os.path.join(ROOT, "store", "seeme-internal-numbers.json")
LOG_FILE = os.path.join(ROOT, "store", "seeme-send.log")
# 779b9660 (fd10c70b WhiteHat F1): approval verification moved from an HTTP round
# trip to the same direct-SQLite, atomic-consume pattern as
# scripts/hooks/email-approval-gate.py (EMAILKAPU901 PR2) -- that file already
# carries the reviewed one-shot-consumption design for this exact table, so this
# reuses it rather than inventing a second one. SEEME_DB_PATH is override-only,
# same reason as SEEME_INTERNAL_FILE above: a fresh checkout's store/ never has
# the real DB.
DB_PATH = os.environ.get("SEEME_DB_PATH") or os.path.join(ROOT, "store", "claudeclaw.db")
APPROVAL_WINDOW_S = int(os.environ.get("SEEME_APPROVAL_WINDOW_S", "1800"))
DEFAULT_BASE = "https://seeme.hu/gateway"
# Elovigyazatossagbol, NEM mert protekcio -- lasd a fejlecet.
USER_AGENT = "kaszap-jobs-seeme-gateway/1.0 (+marveen)"

# A SeeMe a magyar mobilszamot NEMZETKoZI ALAKBAN, '+' NELKuL varja: 36301234567.
# Ez SZANDEKOSAN MAS mintat hasznal, mint az sms-send.py E.164 (+...) ellenorzese --
# a ket gateway MAS vezetekes formatumot var, es ezt NEM eltus rossz iranyba tenne.
HU_MOBILE = re.compile(r"^36(20|30|31|50|70)\d{7}$")


def die(msg, code=1):
    print(f"FAIL: {msg}", file=sys.stderr)
    raise SystemExit(code)


def normalize_number(raw):
    """+36/06/36 barmely alakot 36XXXXXXXXX-re hoz, vagy None, ha nem magyar mobil."""
    digits = re.sub(r"[^\d]", "", raw)
    if raw.strip().startswith("+"):
        pass  # a '+' mar a digits-bol kiesett, digits maga a szam orszaghivoval
    if digits.startswith("00"):
        digits = digits[2:]
    elif digits.startswith("06"):
        digits = "36" + digits[2:]
    if not digits.startswith("36"):
        return None
    return digits if HU_MOBILE.match(digits) else None


def read_env():
    if not os.path.exists(ENV_FILE):
        die(f"nincs credentials-fajl: {ENV_FILE}\n"
            f"      A vaultban 'seeme SMS Gateway API kulcs' neven all a kulcs -- oda kell.")
    env = {}
    with open(ENV_FILE, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    for k in ("SEEME_API_KEY", "SEEME_SENDER"):
        if not env.get(k):
            die(f"a {k} hianyzik vagy ures a {ENV_FILE}-ben")
    return env


def load_internal():
    """A belso szamok listaja EBBEN a normalizalt (36...) alakban.
    HIANYZO FAJL = NINCS belso szam, tehat MINDEN cimzett kulsonek szamit -- szandekos,
    ugyanaz az indok, mint az sms-send.py-nal: a hianyzo allowlist ne nyisson kaput."""
    if not os.path.exists(INTERNAL_FILE):
        return set(), "a fajl NEM LETEZIK -> minden cimzett kulsonek szamit"
    try:
        d = json.load(open(INTERNAL_FILE, encoding="utf-8"))
    except Exception as exc:
        die(f"a {INTERNAL_FILE} nem olvashato ({exc}) -- ilyenkor NEM tippelek, megallok")
    nums = {str(x).strip() for x in d.get("internal", [])}
    return nums, f"{len(nums)} belso szam betoltve"


APPROVAL_ID_RE = re.compile(r"^[0-9a-fA-F-]{8,64}\Z")
# 779b9660 (fd10c70b WhiteHat F3): a newline/tab in --reference used to land
# verbatim in the tab-separated log line, forging an extra, indistinguishable
# row. Restricting the charset makes that structurally impossible.
# \Z, not $ (CYBERED C2, msg 14141): Python's $ also matches just before a
# trailing \n, so "abc\n" satisfied the old pattern and split the log line in
# two on write. \Z matches only the absolute end of the string.
REFERENCE_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}\Z")


def approval_content_hash(to_number, text):
    """The anchor an approval must carry to authorize sending exactly THIS
    (recipient, text) pair -- see the module docstring for how to request one."""
    return hashlib.sha256(f"{to_number}\n{text}".encode("utf-8")).hexdigest()


def _description_binds(description, to_number, text):
    """CYBERED C1 (msg 14141, komment 14141): the hash alone binds nothing a
    HUMAN ever sees -- the REQUESTING agent computes it, and the owner's
    Telegram approval text (buildOwnerApprovalText) shows only
    action_description. A compromised/prompt-injected requester could set
    content_hash for (evil_number, evil_text) while writing an innocuous
    description, and the owner would approve something they never read.
    Requiring the description to contain the normalized recipient AND the
    exact outgoing text, verbatim, restores that binding: whatever the owner
    approved is provably what they saw."""
    if description is None:
        return False
    return to_number in description and text in description


def _diagnose_approval(row, anchor, to_number, text):
    """row is (id, status, content_hash, consumed_at, resolved_at,
    action_description) or None. Dies with a specific reason; never returns on
    failure."""
    if not row:
        die("nincs ilyen approval 'external_message' kategoriaban -- ellenorizd az --approval azonositot")
    _id, status, content_hash, consumed_at, resolved_at, action_description = row
    if status != "approved":
        die(f"az approval statusza '{status}', nem 'approved' -- NEM kuldok.\n"
            f"      (pending eseten VARJ, ne kuldj; a level-1 kategoria sosem lesz autonom)")
    if consumed_at is not None:
        die("ez a johavagyas MAR FELHASZNALT (egyszer-hasznalatos) -- kerj uj johavagyast "
            "a kuldendo cimzett+szoveg parra")
    if content_hash != anchor:
        die("az approval content_hash-ja NEM egyezik a kuldendo cimzett+szoveg sha256-javal -- "
            "a johavagyas MAS cimzettre vagy MAS szovegre szol (lasd a modul fejleceben, "
            "hogyan kell a hash-t keszitni)")
    if resolved_at is None or resolved_at < time.time() - APPROVAL_WINDOW_S:
        die(f"az approval dontese tul regi (az elfogadhato ablak {APPROVAL_WINDOW_S} masodperc "
            f"a dontestol) -- kerj uj johavagyast")
    if not _description_binds(action_description, to_number, text):
        die("az approval leirasa NEM tartalmazza szo szerint a cimzettet ES a pontos kuldendo "
            "szoveget -- a johavagyo csak azt lathatta jovahagyottnak, amit a leirasban "
            "tenylegesen elolvasott (CYBERED C1): ird bele a leirasba a normalizalt cimzettet "
            "es a szo szerinti szoveget, aztan kerj uj johavagyast")


def _fetch_approval_row(con, approval_id):
    return con.execute(
        "SELECT id, status, content_hash, consumed_at, resolved_at, action_description FROM approvals"
        " WHERE id=? AND category='external_message'",
        (approval_id,),
    ).fetchone()


def verify_approval(approval_id, anchor, to_number, text):
    """Read-only check, safe to call from --dry-run: dies if the approval would
    not authorize this exact (recipient, text) pair, otherwise returns quietly.
    Does NOT consume -- see consume_approval for the real-send path."""
    if not os.path.exists(DB_PATH):
        die(f"az approvals adatbazis hianyzik ({DB_PATH}) -- a kapu ZARVA marad")
    con = sqlite3.connect(DB_PATH, timeout=5)
    try:
        con.execute("PRAGMA busy_timeout=5000")
        row = _fetch_approval_row(con, approval_id)
    finally:
        con.close()
    _diagnose_approval(row, anchor, to_number, text)


def consume_approval(approval_id, anchor, to_number, text):
    """Atomic one-shot consume, same pattern as
    scripts/hooks/email-approval-gate.py find_and_consume. ONLY call this on the
    path that actually attempts a send -- never from --dry-run, which must stay
    side-effect-free."""
    con = sqlite3.connect(DB_PATH, timeout=5)
    try:
        con.execute("PRAGMA busy_timeout=5000")
        row = _fetch_approval_row(con, approval_id)
        _diagnose_approval(row, anchor, to_number, text)
        cur = con.execute(
            "UPDATE approvals SET consumed_at=CAST(strftime('%s','now') AS INTEGER)"
            " WHERE id=? AND consumed_at IS NULL",
            (approval_id,),
        )
        con.commit()
        if cur.rowcount == 0:
            die("verseny: egy masik folyamat kozben mar felhasznalta ezt a johavagyast")
    finally:
        con.close()


def log(line):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line.rstrip() + "\n")
    except Exception as exc:
        print(f"FIGYELEM: a naplo-iras nem sikerult ({exc})", file=sys.stderr)


def logsafe(value):
    """779b9660 F3: a tab-separated log line field must never itself contain a
    tab or newline -- --reference is now charset-validated so it cannot, but the
    SeeMe RESPONSE body is untrusted network content and could, so every
    response-derived field passed to log() goes through this first."""
    return str(value).replace("\t", " ").replace("\n", " ").replace("\r", " ")


def seeme_response_ok(payload):
    """779b9660 (fd10c70b WhiteHat F2): extracted to a pure, unit-testable
    function on purpose -- the bug (HTTP 200 {"error":...} with no "code" key
    counting as success) lived in an inline boolean that no test could reach
    without a live/fake gateway. Success is EXPLICIT only: code=="0" or
    result=="OK"; anything else -- including a missing code -- is a failure."""
    return str(payload.get("code", "")) == "0" or payload.get("result") == "OK"


def is_usable_response_shape(payload):
    """CYBERED C3 (msg 14141): a syntactically valid JSON body that is not a
    dict (null, [], "ok", 1) used to reach payload.get() and raise
    AttributeError AFTER the send attempt, leaving no log line at all for an
    SMS that may already have gone out. Extracted to a pure, unit-testable
    function on purpose, same reason as seeme_response_ok (F2)."""
    return isinstance(payload, dict)


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--to", required=True, help="cimzett, magyar mobil, barmilyen szokasos alakban")
    ap.add_argument("--approval", default=None, help="approval UUID (kulso cimzettnel KOTELEZO)")
    ap.add_argument("--reference", default=None, help="sajat azonosito a SeeMe fele")
    ap.add_argument("--dry-run", action="store_true", help="mindent ellenoriz, de nem kuld")
    args = ap.parse_args()

    to = normalize_number(args.to)
    if not to:
        die(f"a cimzett nem magyar mobilszam ertelmezheto ({args.to!r}) -- "
            f"vart alak: 36301234567 (barmilyen bemeneti formabol normalizalva)")

    if sys.stdin.isatty():
        die("a szoveg STDIN-rol jon, nem argumentumkent.\n"
            "      pl.: printf '%s' \"A szoveg\" | python3 scripts/sms/seeme-send.py --to 3630...")
    text = sys.stdin.read()
    if not text.strip():
        die("ures a szoveg (STDIN)")
    if len(text) > 1600:
        die(f"a szoveg {len(text)} karakter -- 1600 folott nem kuldok el vakon, ossze kell vonni")

    # A KAPU ELoBB FUT, MINT A TITOK BETOLTESE -- ugyanaz a ket ok, mint az sms-send.py-ban:
    # (1) default-deny: egy tiltott kuldes ne is erjen hozza a credentialshoz;
    # (2) a kapu igy TESZTELHETo credentials nelkul is.
    internal, internal_note = load_internal()
    is_internal = to in internal

    print(f"cimzett     : {to}")
    print(f"osztalyozas : {'BELSO' if is_internal else 'KULSO'}  ({internal_note})")
    print(f"hossz       : {len(text)} karakter")

    # CYBERED C2 (msg 14141): validated unconditionally, BEFORE the is_internal
    # branch -- previously this only ran on the external path, yet the raw
    # value still reached the log line's `approval=` field on the internal
    # path too, so a newline/tab there forged an indistinguishable extra row.
    if args.approval is not None and not APPROVAL_ID_RE.match(args.approval):
        die(f"az --approval ({args.approval!r}) nem UUID alaku -- nem probalom lekerdezni")

    anchor = approval_content_hash(to, text)
    if not is_internal:
        if not args.approval:
            die("KULSO cimzett, es nincs --approval.\n"
                "      Az `external_message` level=1 ES maxLevel=1 (locked), tehat ez SOHA nem\n"
                "      autonom. Elobb kerj jovahagyast a hash-sel kotve -- lasd a modul fejleceben\n"
                "      a 'JOVAHAGYAS KERESE' szakaszt.")
        verify_approval(args.approval, anchor, to, text)
        print(f"approval    : {args.approval} -> approved, friss, a cimzett+szoveg parhoz kotve")
    elif args.approval:
        print("approval    : megadva, de a cimzett BELSO -- nem kotelezo, nem is hasznalom kapunak")

    if args.reference is not None and not REFERENCE_RE.match(args.reference):
        die(f"a --reference ({args.reference!r}) csak [A-Za-z0-9._-] karaktereket tartalmazhat, "
            f"max 64 hosszan -- egy ujsor/tab hamis naplosort irhatna")

    if args.dry_run:
        creds = "megvan" if os.path.exists(ENV_FILE) else f"NINCS ({ENV_FILE})"
        print(f"credentials : {creds}")
        print("DRY-RUN: a kapu-ellenorzesek lefutottak, NEM kuldtem el, az approval-t NEM hasznaltam fel.")
        return

    if not is_internal:
        # Csak MOST, a tenyleges kuldesi probalkozas kuszoben fogy el az approval --
        # a fenti verify_approval meg nem consume-olt, hogy a dry-run side-effect-
        # mentes maradjon (lasd a fuggveny docstringjet).
        consume_approval(args.approval, anchor, to, text)

    env = read_env()
    base = env.get("SEEME_BASE") or DEFAULT_BASE
    reference = args.reference or f"fleet-adhoc-{int(time.time())}"

    params = {
        "key": env["SEEME_API_KEY"],
        "sender": env["SEEME_SENDER"],
        "number": to,
        "message": text,
        "reference": reference,
        "format": "json",
    }
    url = f"{base}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": USER_AGENT})

    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    try:
        # IDoKORLAT KOTELEZo, ugyanaz az indok, mint az sms-send.py-ban: egy
        # valaszolatlan atjaro ne fagyassza be a hivo folyamatot vegtelenul.
        with urllib.request.urlopen(req, timeout=20) as resp:
            code_http, body = resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:400]
        log(f"{stamp}\tFAIL\tHTTP {exc.code}\t{to}\treference={reference}\t{logsafe(body)}")
        die(f"HTTP {exc.code} -- NEM kuldtem el, es NEM probalom ujra.\n      valasz: {body}")
    except Exception as exc:
        # KETERTELMU AG: a kimeno kereslet UTAZOTT, de a valasz nem erkezett vissza
        # ertelmezhetoen. Ugyanaz a dontes, mint az sms-send.py-ban: NEM retry, ember dont.
        log(f"{stamp}\tKETERTELMU\t{exc}\t{to}\treference={reference}\t-")
        die(f"halozati hiba a kuldes kozben: {exc}\n"
            f"      KETERTELMU: nem tudom, kimen-e. NEM kuldok ujra (duplikatum-veszely).\n"
            f"      Ellenorizd a SeeMe portalon a `reference={reference}` alapjan, mielott "
            f"ujraprobalod.")

    try:
        payload = json.loads(body)
    except Exception:
        log(f"{stamp}\tFAIL\tnem-JSON\t{to}\treference={reference}\t{logsafe(body[:400])}")
        die(f"a valasz nem JSON (HTTP {code_http}): {body[:400]}")

    # CYBERED C3 (msg 14141): a non-dict JSON response (null/[]/"ok"/1) used to
    # hit payload.get() and raise AttributeError AFTER the send attempt -- the
    # SMS could already be gone, the approval already consumed, and this
    # crash left NO log line at all, same ambiguous-outcome class as the
    # network-error branch above, but silent.
    if not is_usable_response_shape(payload):
        log(f"{stamp}\tKETERTELMU\tvalasz-nem-objektum\t{to}\treference={reference}\t{logsafe(json.dumps(payload)[:400])}")
        die(f"a valasz JSON, de nem objektum (HTTP {code_http}): {json.dumps(payload)[:400]}\n"
            f"      KETERTELMU: nem tudom eldonteni, sikeres volt-e. NEM kuldok ujra "
            f"(duplikatum-veszely). Ellenorizd a SeeMe portalon a `reference={reference}` alapjan.")

    code = str(payload.get("code", ""))
    if not seeme_response_ok(payload):
        message = str(payload.get("message") or payload.get("error") or json.dumps(payload)[:200])
        log(f"{stamp}\tFAIL\tcode={logsafe(code)}\t{to}\treference={reference}\t{logsafe(message)}")
        die(f"a SeeMe elutasitotta (code={code or 'HIANYZIK'}): {message}")

    segments = payload.get("split")
    price = payload.get("price")
    log(f"{stamp}\tOK\t{to}\treference={reference}\trészek={segments}\tár={price}\tapproval={args.approval or '-'}\tlen={len(text)}")
    print(f"OK reference={reference} részek={segments} ár={price}")


if __name__ == "__main__":
    main()

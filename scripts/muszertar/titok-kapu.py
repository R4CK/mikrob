#!/usr/bin/env python3
"""titok-kapu.py -- commit-szintu titok-szuro (secret scanner).

Elv: a titkot ne a promptban tiltsuk, hanem gepi kapu fogja meg, mielott commitba
vagy kulso szolgaltatohoz kerul. A seged-hivo.py is ezt hivja a munkamappara.

FEGYELEM:
  - pozitiv kontroll: --onteszt szandekosan elhelyezett alkulcsokon meri, hogy LAT.
  - a titok SOHA nem kerul kepernyore/naplóba: csak fajl:sor + minta-nev + maszk.
  - a hamis pozitiv is hiba: a placeholder-felismero kihagyja a peldakat.

Hasznalat:
  titok-kapu.py --onteszt              onellenorzes (pozitiv + negativ kontroll)
  titok-kapu.py --staged               a commitra kesz valtozast nezi (pre-commit)
  titok-kapu.py --kovetett [repo]      a repo osszes kovetett fajljat
  titok-kapu.py FAJL...                megadott fajlokat

Kilepesi kod: 0 = tiszta, 1 = TALALAT (commit blokkolva), 2 = a muszer hibas.
"""
import base64, binascii, json, re, sys, os, subprocess, argparse, unicodedata
from pathlib import Path
from urllib.parse import quote as _urlquote

# --- minta-keszlet: (nev, regex, minimum-entropia-kell-e) -------------------
MINTAK = [
    # A \\b szohatar KOTELEZO: nelkule a "dont-ask-later-..." szoveg 'sk-later-...'
    # kulcsnak latszik (magyar/angol szohatar-csapda, eles talalat volt).
    ("anthropic-kulcs",   re.compile(r"\bsk-ant-api\d{2}-[A-Za-z0-9_\-]{24,}")),
    # F2 (card 09117e0a, Peti dontes komment 18309 pont 1): a flotta sajat OAuth-tokenje,
    # "sk-ant-oat01-..." alakban -- ugyanaz a hossz/karakterkeszlet mint az api-kulcsnak.
    ("anthropic-oauth",   re.compile(r"\bsk-ant-oat\d{2}-[A-Za-z0-9_\-]{24,}")),
    ("openai-kulcs",      re.compile(r"\bsk-(?:proj-[A-Za-z0-9_\-]{32,}|[A-Za-z0-9]{32,})")),
    ("github-token",      re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}")),
    ("github-pat",        re.compile(r"\bgithub_pat_[A-Za-z0-9_]{50,}")),
    ("google-api-kulcs",  re.compile(r"\bAIza[A-Za-z0-9_\-]{35}")),
    # F2 (card 09117e0a, Peti dontes komment 18309 pont 2): a Gemini/Google sajat OAuth
    # access- es refresh-tokenje MINTA alapjan is felismerheto (nem csak a live-ertek literal
    # egyezesevel lejjebb) -- ya29. es 1// a Google-dokumentalt prefix minden ilyen tokenre,
    # nem csak a mienkre. A hossz-minimum zarja ki a "1//2" Python egesz-osztas alakot.
    ("google-oauth-access",  re.compile(r"\bya29\.[A-Za-z0-9_\-]{20,}")),
    ("google-oauth-refresh", re.compile(r"\b1//[A-Za-z0-9_\-]{20,}")),
    ("slack-token",       re.compile(r"\bxox[baprs]-[0-9A-Za-z\-]{10,}")),
    ("aws-hozzaferes",    re.compile(r"\bAKIA[0-9A-Z]{16}")),
    ("netlify-pat",       re.compile(r"\bnfp_[A-Za-z0-9]{30,}")),
    ("stripe-eles-kulcs", re.compile(r"\bsk_live_[A-Za-z0-9]{20,}")),
    ("telegram-bot",      re.compile(r"\b\d{8,10}:AA[A-Za-z0-9_\-]{30,}")),
    ("privat-kulcs",      re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("jwt",               re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}")),
    ("db-uri-jelszoval",  re.compile(r"(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)://[^:/\s]+:[^@\s]{6,}@")),
    # F2 (card 09117e0a, Peti dontes komment 18309 pont 1): Bearer fejlec es
    # DB_PASSWORD=/<PREFIX>_SECRET=/<PREFIX>_TOKEN= hozzarendeles. A PREFIX nem lehet ures
    # (kizarja a bare "TOKEN=..."/"SECRET=..." idiomat, ami tul altalanos lenne), es a
    # PLACEHOLDER-ellenorzes (lejjebb) a talalat TELJES szovegen fut, tehat egy
    # "${VALTOZO}"/"<ide-jon>" ertek -- mint a meglevo NEGATIV kontroll
    # 'export GITHUB_TOKEN="${GH_PAT}"' -- tovabbra sem blokkol.
    ("bearer-fejlec",     re.compile(r"\bBearer\s+[A-Za-z0-9_\-\.]{20,}")),
    ("env-titok-hozzarendeles",
     re.compile(r"\b(?:DB_PASSWORD|[A-Z][A-Z0-9]*_(?:SECRET|TOKEN))\s*=\s*\S{8,}")),
    # N5-javitas (card 09117e0a, RedHat NO-GO komment 18498): a fenti minta csak NAGYBETUS
    # elotagot ismer fel, es a Peti-fele listaban szereplo tovabbi alakok (kisbetus
    # db_password=, elotag nelkuli PASSWORD=, JSON "access_token": "..." kulcs) lefedetlenek
    # voltak. Ez a minta a password/secret/token SZOT magat vizsgalja (kis/nagybetu-fuggetlen),
    # mind '=' hozzarendelesben, mind JSON "kulcs": "ertek" alakban.
    ("jelszo-titok-hozzarendeles",
     re.compile(r'(?i)\b(?:db_password|password|client_secret|access_token|refresh_token)'
                r'\s*(?:=\s*\S{8,}|"?\s*:\s*"[^"]{8,}")')),
    # Google OAuth client-secret a dokumentalt "GOCSPX-" elotaggal (sajat minta a JSON-kulcs-
    # formatumtol fuggetlenul is felismeri).
    ("google-client-secret", re.compile(r"\bGOCSPX-[A-Za-z0-9_\-]{20,}")),
]

# a talalat NEM titok, ha ezek barmelyike benne van (pelda / helykitolto)
PLACEHOLDER = re.compile(
    r"PELDA|EXAMPLE|SAMPLE|DUMMY|PLACEHOLDER|REDACTED|CHANGEME|YOUR[_-]|MY[_-]KEY|"
    r"<[^>]*>|\.\.\.|xxxx|XXXX|abc123|TODO|FIXME|\$\{|\{\{",
    re.IGNORECASE)

# ezeket a fajlokat sosem nezzuk (binaris / build / sajat onteszt)
KIHAGY_UT = re.compile(r"(^|/)(node_modules|dist|\.next|vendor|\.git)/|"
                       r"\.(png|jpg|jpeg|gif|webp|pdf|zip|gz|woff2?|ttf|ico|mp4|db)$")


def jwt_szerep(jwt: str):
    """A JWT payloadjabol kiolvassa a 'role'-t. A Supabase anon kulcs kliensbe szant
    (publikus), a service_role viszont valodi titok. A kettot nem szabad osszemosni."""
    import base64, json
    try:
        pl = jwt.split(".")[1]
        pl += "=" * (-len(pl) % 4)
        d = json.loads(base64.urlsafe_b64decode(pl))
        return str(d.get("role") or d.get("typ") or "")
    except Exception:
        return ""

# ezek a JWT-szerepek kliensbe szantak: jelentjuk, de NEM blokkoljuk a commitot
PUBLIKUS_JWT_SZEREP = {"anon", "public"}

def maszk(s: str) -> str:
    """A talalat helyett ennyi kerul kepernyore. A titok sosem."""
    return f"{s[:4]}...[{len(s)} karakter]"

# Tudatos, LATHATO kivetel: a sorra irt jelolo kihagyja azt a szkennelesbol.
# Miert sor-szintu es nem fajl-szintu: a muszer sajat onteszt-adatai valodi
# kulcs-alaku sztringek (mashogy nem lennenek pozitiv kontrollok), es eppen ezert
# blokkoltak a SAJAT commitjukat. A fajl kizarasa tul tag lett volna:
# igy csak a megjelolt SOR marad ki, es a jelolo ott all a diffben, ahol barki latja.
# A --no-verify nema kikeruleshez kepest ez lathato dontes.
KIVETEL_SOR = re.compile(r"TITOK-KAPU-KIVETEL")

# F2 (card 09117e0a, Peti dontes komment 18309 pont 2): a legerosebb ellenorzes a homokozo
# AKTUALIS token-fajljabol kiolvasott ertekek szo szerinti egyezese a kimenetben, nem csak
# minta -- ez fogja meg azt is, ha a token NEM a dokumentalt ya29./1// alakban jelenik meg
# (pl. egy jovobeli Google-formatumvaltas), es a SAJAT dashboard-tokenunket, amire nincs
# altalanos minta (64 veletlen hex karakter ugyanugy nez ki, mint egy sha256 -- lasd lejjebb).
# Minden hivasnal FRISSEN olvasva (nem cache-elve): a token rotal, egy regi ertek hamis
# negativot adna.
def _marveen_root(root_override: str = None) -> str:
    """A valodi flotta-gyoker, KIZAROLAG a fajl sajat helyebol szamolva. `root_override` csak a
    SAJAT --onteszt kodjanak explicit parametere (M1-javitas, card 09117e0a, RedHat NO-GO 2.
    kor, komment 18611) -- SOHA nem env-bol: a korabbi MARVEEN_ROOT env-felulirast a folyamatfa
    felett allo, a kapu altal nem irt barmely folyamat beallithatta, es azzal a kategoria-kapu
    helyett egy masik gyokeret (igy masik dashboard-token-fajlt) adhatott at a VALODI
    run_gate()/CLI utnak is -- nema bypass."""
    return root_override or str(Path(__file__).resolve().parents[2])


class TitokKapuHiba(Exception):
    """A gepi kapu SAJAT muszere serult (nem az ellenorzott kod hianyossaga) -- fail-closed:
    a hivo ezt hibaval (exit 2) allja meg, nem csendes 'nincs talalat'-tal."""


def elo_titkok(dash_override: str = None, oauth_override: str = None, root: str = None,
                fail_closed: bool = True):
    """[(nev, ertek)] a flotta sajat, MOST elo titkaira.

    M1-javitas (card 09117e0a, RedHat NO-GO 2. kor, komment 18611): a korabbi
    TITOK_KAPU_TESZT_MODE/TITOK_KAPU_DASHBOARD_TOKEN_FILE/TITOK_KAPU_AGY_OAUTH_FILE/MARVEEN_ROOT
    env-valtozok mind a HIVO altal beallithatok voltak akkor is, amikor a titok-kapu a VALODI
    gate-folyamatban (run_gate, --staged, --kovetett, fajl-argumentum) futott: egy a folyamatfa
    felett allo, a kapu altal nem irt env csendben masik dashboard-token-fajlra vagy masik
    gyokerre iranyithatta a live-titok-egyezest, es azzal a valodi tokent sosem vetette ossze
    semmivel. Most `dash_override`/`oauth_override`/`root` KIZAROLAG explicit fuggveny-
    parameterek, amiket a folyamaton BELUL csak a sajat --onteszt kodja ad at kezzel (lasd
    elo_titkok_onteszt/elo_titkok_fail_closed_onteszt) -- a VALODI run_gate()/CLI ut (es a
    normal onteszt() POZITIV/NEGATIV kore is) semmit nem ad at, tehat mindig a VALODI,
    __file__-bol szamolt gyokeret es alapertelmezett fajlokat nezi, es az environmentnek erre
    SEMMI hatasa nincs.

    A dashboard-token fajl MINDIG letezik egy eles flotta-checkoutban (lasd a root CLAUDE.md
    -t) -- ha a feloldott ut nem olvashato ES `fail_closed` igaz, ez HIBA (TitokKapuHiba, a
    hivo exit 2-vel all meg), nem csendes kihagyas. Az agy OAuth-fajl viszont TOVABBRA IS
    csendben kimaradhat: nem minden gep futtatott meg 'agy'-t, ez normalis allapot, nem egy
    manipulalhato ellenorzesi pont."""
    out = []
    dash_path = dash_override or os.path.join(_marveen_root(root), "store", ".dashboard-token")
    try:
        v = open(dash_path, "r", encoding="utf-8").read().strip()
        if len(v) >= 16:
            out.append(("fleet-dashboard-token", v))
    except OSError as e:
        if fail_closed:
            raise TitokKapuHiba(
                f"a flotta sajat dashboard-token fajlja nem olvashato ({dash_path}): {e}"
            ) from e
    oauth_path = oauth_override or os.path.join(
        str(Path.home()), ".gemini", "antigravity-cli", "antigravity-oauth-token"
    )
    try:
        d = json.loads(open(oauth_path, "r", encoding="utf-8").read())
        tok = d.get("token") or {}
        for key in ("access_token", "refresh_token"):
            v = tok.get(key)
            if isinstance(v, str) and len(v) >= 16:
                out.append((f"agy-oauth-{key}-literal", v))
        idt = d.get("id_token")
        if isinstance(idt, str) and len(idt) >= 16:
            out.append(("agy-oauth-id_token-literal", idt))
    except (OSError, json.JSONDecodeError, AttributeError, TypeError):
        pass
    return out


def _b64_eltolt_alakok(raw: bytes, kodolo):
    """A base64/base64url alak MINDHAROM bajt-igazitasra (eltolasra), mert a titok a szovegben
    rendszerint egy ismeretlen hosszu elotag (pl. 'x'+token, 'Authorization: Bearer '+token)
    UTAN all, es a base64 3-bajtos csoportokban kodol -- egy eltolt token teljesen MAS
    karaktersorozatot ad, nem csak egy reszlet-eltolast (RedHat N2 a 09117e0a NO-GO-ban: a
    korabbi, kizarolag 0-eltolasos b64/hex egy nem-igazitott elotaggal mindig athagyhato volt).
    A feloldhatatlan szel-karaktereket (az ismeretlen szomszedos bajt(ok)tol fuggo b64-jegyeket)
    levagjuk mindket oldalon."""
    alakok = []
    for shift in (0, 1, 2):
        padded = b"\x00" * shift + raw
        enc = kodolo(padded).decode("ascii").rstrip("=")
        skip_head = -(-(shift * 8) // 6)  # ceil(shift*8/6): ennyi elso jegy fugg az ismeretlen elotagtol
        skip_tail = 1 if (shift + len(raw)) % 3 else 0  # az utolso csoport fugghet egy kovetkezo, ismeretlen bajttol
        veg = len(enc) - skip_tail if skip_tail else len(enc)
        alakok.append(enc[skip_head:veg])
    return alakok


def _kodolt_alakok(ertek: str):
    """A nyers ertek mellett a base64/base64url (mindharom bajt-igazitasra)/hex (kis- es
    nagybetus)/URL-kodolt (egyszeres es dupla) alakjait is adja. A sorban/szovegben levo
    whitespace/idezojel/+ zajra es a kis/nagybetu elteresre a HIVO (vizsgal_szoveg) egyseges,
    tomoritett-casefold-olt egesz-szoveg egyezessel vedekezik, nem itt.
    Minden alak legalabb 16 karakter -- rovidebb kodolt torzs tul sok veletlen egyezest adna."""
    alakok = [ertek]
    raw = ertek.encode("utf-8", "ignore")
    alakok += _b64_eltolt_alakok(raw, base64.b64encode)
    alakok += _b64_eltolt_alakok(raw, base64.urlsafe_b64encode)
    alakok.append(binascii.hexlify(raw).decode("ascii"))
    alakok.append(binascii.hexlify(raw).decode("ascii").upper())
    kodolt = _urlquote(ertek, safe="")
    alakok.append(kodolt)
    alakok.append(_urlquote(kodolt, safe=""))  # dupla URL-kodolas
    return [a for a in alakok if len(a) >= 16]


_ZAJ_RE = re.compile(r"[\s'\"+]+")
# F-D (card f6f67dff, WhiteHat2 + RedHat R2 delta, komment 19135 majd 19238): zero-width/invisible
# kodpontok egy token kozepebe ekelve atmennek a _ZAJ_RE-n (az \s nem illeszkedik rajuk), es
# szettorik a MINTAK regexeket, VALAMINT a live-titok egesz-szoveg egyezest is -- reszleges
# szivargas, nem talalat. Az elso kor egy ZART LISTA volt (7 explicit kodpont-tartomany) -- RedHat
# merte: 30 probalt lathatatlan kodpontbol 24 atment (bidi vezerlok, Hangul-toltok, egyeb Cf/Cc). A
# masodik kor KATEGORIA szerint szurt (Cf/Cc a strukturalis \n/\r/\t kivetelevel, Zl/Zp), PLUSZ egy
# explicit kiegeszito lista -- de RedHat (19238) ujra mert: a variation selectorok (VS1-16,
# U+FE00-FE0F, 15/15 atment; VS17-256, U+E0100-E01EF, 240/240 atment) es a kiosztatlan
# Default_Ignorable kodpontok (mongol szabad VS1-4 U+180B-180D/180F, U+2065, U+FFF0-FFF8,
# U+E0000, U+E0002-E001F, U+E0080-E00FF) nem Cf/Cc/Zl/Zp kategoriaju (a VS-ek Mn, a kiosztatlanok
# Cn), tehat a kategoria-szuro nem fogta meg oket. A javitas a teljes Unicode
# Default_Ignorable_Code_Point derivalt tulajdonsag lefedesere all at: a fenti tartomanyok MINDEGYIKE
# ebbe a derivalt halmazba esik (a Cf/Cc/Zl/Zp kategoriak is resze ennek, azokat a kategoria-szuro
# mar fedte). Tartomany-alapu, nem kategoria-alapu, mert a VS-ek es a kiosztatlan pontok kategoriaja
# (Mn illetve Cn) tul tag lenne altalanosan szurni (Mn=ekezet-kombinalo jel, pl. magyar szoveg NFD
# alakja; Cn=minden meg ki nem osztott kodpont, ami idovel kiosztott betuve valhat).
# R2c-javitas (RedHat 3. kor, komment 19300): az elozo kor a VS17-256 tartomanyt E01EF-nel zarta
# le, de a valodi Default_Ignorable_Code_Point halmaz a tag-sik vegeig (E0FFF) tart -- a kozbeeso
# 3600 kiosztatlan kodpont (E01F0-E0FFF) atment, es a valodi redaktoron (gemini-offload-call.sh)
# egy kulcs kozepere ekelve kiszivargott. A tartomany most E0FFF-ig zarodik.
_LATHATATLAN_TOVABBI = "ᅟᅠㅤﾠ͏឴឵᠎️"
_LATHATATLAN_STRUKTURALIS = frozenset("\n\r\t")
_DEFAULT_IGNORABLE_TARTOMANYOK = (
    (0x180B, 0x180D),  # mongol szabad variation selector 1-3
    (0x180F, 0x180F),  # mongol szabad variation selector 4
    (0x2065, 0x2065),  # kiosztatlan (Default_Ignorable)
    (0xFE00, 0xFE0F),  # variation selector 1-16
    (0xFFF0, 0xFFF8),  # kiosztatlan (Default_Ignorable)
    (0xE0000, 0xE0000),  # kiosztatlan (Default_Ignorable)
    (0xE0002, 0xE001F),  # kiosztatlan (Default_Ignorable)
    (0xE0080, 0xE00FF),  # kiosztatlan (Default_Ignorable)
    (0xE0100, 0xE0FFF),  # variation selector 17-256 (E0100-E01EF) + kiosztatlan tag-sik vege (E01F0-E0FFF)
)


def _default_ignorable(ch: str) -> bool:
    cp = ord(ch)
    for lo, hi in _DEFAULT_IGNORABLE_TARTOMANYOK:
        if lo <= cp <= hi:
            return True
    return False


def _lathatatlan_szuro(szoveg: str) -> str:
    kiment = []
    for ch in szoveg:
        if ch in _LATHATATLAN_STRUKTURALIS:
            kiment.append(ch)
            continue
        if ch in _LATHATATLAN_TOVABBI:
            continue
        if unicodedata.category(ch) in ("Cf", "Cc", "Zl", "Zp"):
            continue
        if _default_ignorable(ch):
            continue
        kiment.append(ch)
    return "".join(kiment)


def vizsgal_szoveg(szoveg: str, cimke: str, kivetel_aktiv: bool = True, fail_closed: bool = True,
                    dash_override: str = None, oauth_override: str = None, root: str = None):
    szoveg = _lathatatlan_szuro(szoveg)
    talalatok = []
    elo = elo_titkok(dash_override=dash_override, oauth_override=oauth_override, root=root,
                      fail_closed=fail_closed)
    elo_alakok = [(nev, forma) for nev, ertek in elo for forma in _kodolt_alakok(ertek)]
    sorok = szoveg.splitlines()
    aktiv_sorok = [s for s in sorok if not KIVETEL_SOR.search(s)] if kivetel_aktiv else sorok
    # F2-javitas (RedHat N2 a 09117e0a NO-GO-ban): a live-titok egyezes a TELJES (aktiv) szovegen
    # fut, whitespace/idezojel/'+' zajtol megtisztitva es casefold-olva -- korabban csak SORON
    # BELUL, whitespace-tomoritessel neztuk, es ez athagyhato volt sortoressel ('abc\ndef'),
    # idezojeles/osszefuzott alakkal ('abc' + 'def'), vagy puszta nagybetusitessel (a valodi
    # ertek mindig kisbetus hex, egy nagybetus masolat a regi pontos-egyezessel nem talalt ra).
    # A pontos sorszam ezert itt nem adhato meg (a talalat tobb sort/idezojelet athidalhat); 0
    # jelzi: "a teljes (aktiv) szovegben, nem egy konkret soron".
    egesz_tomoritve = _ZAJ_RE.sub("", "\n".join(aktiv_sorok)).casefold()
    for nev, forma in elo_alakok:
        if forma.casefold() in egesz_tomoritve:
            talalatok.append((cimke, 0, nev, maszk(forma), True))
    # A hosszu (minified) sort NEM hagyjuk ki: a beagyazott kulcs pont ott lapul, es a mintak
    # literalis elotaggal indulnak, igy egy 2 MB-os sor is linearis ido.
    for sorszam, sor in enumerate(sorok, 1):
        if kivetel_aktiv and KIVETEL_SOR.search(sor):
            continue
        for nev, rx in MINTAK:
            for m in rx.finditer(sor):
                nyers = m.group(0)
                # a placeholder-vizsgalat CSAK a talalatra megy, nem a teljes sorra: korabban
                # barmely <...> a soron (html tag, Array<string>) vagy egy TODO kimentette a
                # valodi kulcsot
                if PLACEHOLDER.search(nyers):
                    continue
                blokkol = True
                if nev == "jwt":
                    sz = jwt_szerep(nyers)
                    if sz in PUBLIKUS_JWT_SZEREP:
                        nev, blokkol = f"jwt-publikus({sz})", False
                talalatok.append((cimke, sorszam, nev, maszk(nyers), blokkol))
    return talalatok

def vizsgal_fajl(ut: str, kivetel_aktiv: bool = True):
    if KIHAGY_UT.search(ut):
        return []
    try:
        with open(ut, "r", encoding="utf-8", errors="strict") as f:
            return vizsgal_szoveg(f.read(), ut, kivetel_aktiv=kivetel_aktiv)
    except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError, PermissionError):
        return []   # binaris vagy olvashatatlan: nem a mi dolgunk

# --- onellenorzes ----------------------------------------------------------
# Az alabbi sztringek SZANDEKOSAN kulcs-alakuak (ez teszi oket pozitiv kontrolla),
# ezert viselik a TITOK-KAPU-KIVETEL jelolot -- kulonben a muszer sajat magat blokkolna.
POZITIV = [
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*30 + "9zQ\""),  # TITOK-KAPU-KIVETEL
    ("github-token",     "GH=ghp_" + "b"*36),  # TITOK-KAPU-KIVETEL
    ("google-api-kulcs", "AIza" + "C"*35),  # TITOK-KAPU-KIVETEL
    ("slack-token",      "xoxb-123456789012-abcdefghij"),  # TITOK-KAPU-KIVETEL
    ("aws-hozzaferes",   "AKIA" + "D"*16),  # TITOK-KAPU-KIVETEL
    ("privat-kulcs",     "-----BEGIN OPENSSH PRIVATE KEY-----"),  # TITOK-KAPU-KIVETEL
    ("telegram-bot",     "1234567890:AA" + "e"*33),  # TITOK-KAPU-KIVETEL
    ("db-uri-jelszoval", "postgresql://felh:S3cretJelszo9@db.local:5432/app"),  # TITOK-KAPU-KIVETEL
    ("stripe-eles-kulcs","sk_live_" + "f"*24),  # TITOK-KAPU-KIVETEL
    ("netlify-pat",      "nfp_" + "g"*36),  # TITOK-KAPU-KIVETEL
    ("jwt",              "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.QWERTYuiop12345"),  # TITOK-KAPU-KIVETEL
    # tag / Array<...> / TODO ugyanazon a soron NEM menti ki a kulcsot
    ("anthropic-kulcs",  "<script>const k=\"sk-ant-api03-" + "A"*30 + "9zQ\"</script>"),  # TITOK-KAPU-KIVETEL
    ("anthropic-kulcs",  "<svg><text>sk-ant-api03-" + "A"*30 + "9zQ</text></svg>"),  # TITOK-KAPU-KIVETEL
    ("github-token",     "const a: Array<string> = [\"ghp_" + "b"*36 + "\"]"),  # TITOK-KAPU-KIVETEL
    ("stripe-eles-kulcs","k = 'sk_live_" + "f"*24 + "'  # TODO rotate"),  # TITOK-KAPU-KIVETEL
    ("anthropic-kulcs",  "x"*4400 + "\"sk-ant-api03-" + "A"*30 + "9zQ\""),  # TITOK-KAPU-KIVETEL
    ("jwt",              "SUPA_SERVICE=eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.eyJpc3MiOiAiZGVtby1wcm9qZWN0IiwgInJvbGUiOiAic2VydmljZV9yb2xlIiwgImlhdCI6IDE1MDAwMDAwMDB9.qr7oatmR0FKhX5-21D_Iw39Zszsc5j1dwkDFit4U1oo"),  # TITOK-KAPU-KIVETEL
    # F2 (card 09117e0a) uj mintak
    ("anthropic-oauth",      "kulcs = \"sk-ant-oat01-" + "B"*30 + "8yP\""),  # TITOK-KAPU-KIVETEL
    ("google-oauth-access",  "token=\"ya29." + "C"*60 + "\""),  # TITOK-KAPU-KIVETEL
    ("google-oauth-refresh", "refresh_token=\"1//" + "09jD"*10 + "\""),  # TITOK-KAPU-KIVETEL
    ("bearer-fejlec",        "Authorization: Bearer " + "D"*40),  # TITOK-KAPU-KIVETEL
    ("env-titok-hozzarendeles", "DB_PASSWORD=S3cretRealPassw0rd!"),  # TITOK-KAPU-KIVETEL
    ("env-titok-hozzarendeles", "STRIPE_SECRET=" + "E"*20),  # TITOK-KAPU-KIVETEL
    # N5 (card 09117e0a) uj mintak: kisbetus db_password=, elotag nelkuli PASSWORD=,
    # client_secret (JSON kulcs ES GOCSPX- minta), JSON "access_token" kulcs.
    ("jelszo-titok-hozzarendeles", "db_password=S3cretRealPassw0rd!"),  # TITOK-KAPU-KIVETEL
    ("jelszo-titok-hozzarendeles", "PASSWORD=S3cretRealPassw0rd!"),  # TITOK-KAPU-KIVETEL
    ("jelszo-titok-hozzarendeles", "client_secret=" + "K"*24),  # TITOK-KAPU-KIVETEL
    ("jelszo-titok-hozzarendeles", '"access_token": "' + "L"*24 + '"'),  # TITOK-KAPU-KIVETEL
    ("google-client-secret", "GOCSPX-" + "M"*28),  # TITOK-KAPU-KIVETEL
    # F-D (card f6f67dff): zero-width space (U+200B) ekelve a kulcs kozepebe -- a normalizalas
    # elotti kod ezt nem ismerte volna fel.
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "​" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL
    # F-D delta (RedHat R2, komment 19135): a zart-lista verzio csak 6/30 probalt lathatatlan
    # kodpontot kapott el -- parameteres pin a kategoria-szures ALL harom agara: Cf (bidi
    # override U+202E), Cc (DEL vezerlokarakter U+007F), es a nem-Cf kiegeszito listara
    # (combining grapheme joiner U+034F, Hangul-toltő U+115F).
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "‮" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "\u007f" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "͏" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "ᅟ" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL
    # F-D delta2 (RedHat R2 reszleges, komment 19238): a kategoria-szures (Cf/Cc/Zl/Zp) nem fogta
    # meg a variation selectorokat (kategoria Mn, nem Cf) es a kiosztatlan Default_Ignorable
    # kodpontokat (kategoria Cn) -- parameteres pin a _DEFAULT_IGNORABLE_TARTOMANYOK MINDEGYIK
    # tartomanyara (egy-egy mintaval a tartomany elejebol), PLUSZ a VS16+VS1 kombinacio, PLUSZ a 7
    # korabban pin nelkuli, mar _LATHATATLAN_TOVABBI-ban levo kodpont (U+1160, U+3164, U+FFA0,
    # U+17B4, U+17B5, U+180E, U+FE0F).
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "᠋" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (mongol szabad VS1)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "⁥" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (kiosztatlan)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "︀" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (variation selector 1)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "￰" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (kiosztatlan)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "\U000e0000" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (kiosztatlan)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "\U000e0002" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (kiosztatlan)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "\U000e0080" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (kiosztatlan)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "\U000e0100" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (variation selector 17)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "️︀" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (VS16+VS1 kombinacio)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "ᅠ" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (Hangul-tolto, korabban pin nelkul)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "ㅤ" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (Hangul-tolto, korabban pin nelkul)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "ﾠ" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (Hangul-tolto, korabban pin nelkul)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "឴" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (khmer maganhangzo, korabban pin nelkul)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "឵" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (khmer maganhangzo, korabban pin nelkul)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "᠎" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (mongol elvalaszto, korabban pin nelkul)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "️" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (variation selector-16, korabban pin nelkul)
    # R2c (card f6f67dff, RedHat 3. kor, komment 19300): a _DEFAULT_IGNORABLE_TARTOMANYOK utolso
    # tartomanya E01EF-nel vegzodott, de a valodi Default_Ignorable_Code_Point halmaz E0FFF-ig tart
    # (3600 kiosztatlan kodpont, U+E01F0-E0FFF) -- ezek atmentek. Pin a tartomany VEGERE (E0FFF) es
    # a korabban leszivargott szakasz ELEJERE (E01F0).
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "\U000e01f0" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (kiosztatlan, korabban pin nelkul, LEAK)
    ("anthropic-kulcs",  "kulcs = \"sk-ant-api03-" + "A"*15 + "\U000e0fff" + "A"*15 + "9zQ\""),  # TITOK-KAPU-KIVETEL (kiosztatlan, tartomany vege, LEAK)
]
# kliensbe szant kulcs: a muszernek LATNIA kell, de NEM blokkolhatja a commitot
PUBLIKUS_MINTA = "SUPA_ANON=eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.eyJpc3MiOiAiZGVtby1wcm9qZWN0IiwgInJvbGUiOiAiYW5vbiIsICJpYXQiOiAxNTAwMDAwMDAwfQ.WvLorMePmqUDUR3a2oDuLtHGV6zaWQjXEpDNoia0xOM"  # TITOK-KAPU-KIVETEL
NEGATIV = [
    'ANTHROPIC_API_KEY=sk-ant-api03-PELDA1234567890abcdefghij',   # placeholder
    'TOKEN=$(cat store/.dashboard-token)',                         # helyes minta
    'export GITHUB_TOKEN="${GH_PAT}"',                             # valtozo
    'lasd a docs/api-referencia.md fajlt a Bearer tokenrol',
    'kulcs: <ide-jon-a-kulcs>',
    'password = "..."',
    'DATABASE_URL=postgresql://felh:<jelszo>@db.local:5432/app',   # placeholder a talalaton belul
    'AWS_KEY=AKIAIOSFODNN7EXAMPLE',                                # AWS doksi-pelda
    'https://stats.example.org/script.js',
    # F2 (card 09117e0a) uj negativ kontrollok
    'x = 1//2',                                                    # Python egesz-osztas, nem token
    'eredmeny = a // 2  # whole division',
    'lasd a Bearer tokenrol: docs/api-referencia.md',               # tul rovid "token" szo a Bearer utan
    'a0b1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5',  # 64 hex, de NEM a sajat tokenunk
    # F-D (card f6f67dff) negativ kontroll: zero-width karakter normal szovegben, nem token
    # kozepen -- a normalizalas nem csinalhat belole hamis talalatot.
    'ez egy​ norm​al mondat, semmi titkos benne',
]

def onteszt() -> int:
    hiba = 0
    # A POZITIV/NEGATIV korok es a kozvetlen vizsgal_szoveg()-hivasok ide lejjebb a MINTAK
    # regexeit vizsgaljak, nem a live-titok-egyezest -- ezert fail_closed=False: a kor hosttol
    # fuggetlenul, determinisztikusan fut (nem akad el, ha EZEN a gepen/worktree-ben nincs
    # valodi store/.dashboard-token). M1-javitas (card 09117e0a, RedHat NO-GO 2. kor): korabban
    # ezt egy env-alapu "teszt-mod" kapcsolo adta, amit a VALODI run_gate()/CLI ut hivoja is
    # beallithatott -- most ez pusztan a jelen fuggvenyen BELULI, kezzel atadott parameter,
    # a live uton semmi nem allithatja at. A hianyzo alapertelmezett fajl miatti fail-closed
    # HIBA-t (N4-javitas) kulon, dedikaltan elo_titkok_fail_closed_onteszt() teszteli.
    print("== POZITIV KONTROLL (a muszernek LATNIA kell) ==")
    for vart, minta in POZITIV:
        t = vizsgal_szoveg(minta, "<onteszt>", fail_closed=False)
        nevek = {x[2] for x in t}
        ok = vart in nevek
        print(f"  [{'OK ' if ok else 'BUKO'}] {vart:<18} -> {sorted(nevek) or 'NINCS TALALAT'}")
        if not ok: hiba += 1
    print("== SZETVALASZTAS (publikus kulcs: lat, de nem blokkol) ==")
    t = vizsgal_szoveg(PUBLIKUS_MINTA, "<onteszt>", fail_closed=False)
    lat = bool(t)
    nem_blokkol = all(not x[4] for x in t)
    print(f"  [{'OK ' if lat else 'BUKO'}] a publikus (anon) JWT-t megtalalja       -> {[x[2] for x in t] or 'NINCS'}")
    print(f"  [{'OK ' if (lat and nem_blokkol) else 'BUKO'}] es NEM blokkolja a commitot")
    if not (lat and nem_blokkol): hiba += 1
    t = vizsgal_szoveg("SUPA_SERVICE=" + [m for n,m in POZITIV if n=="jwt"][-1].split("=")[-1], "<onteszt>", fail_closed=False)
    blokkol = any(x[4] for x in t)
    print(f"  [{'OK ' if blokkol else 'BUKO'}] a service_role JWT-t viszont BLOKKOLJA -> {[x[2] for x in t] or 'NINCS'}")
    if not blokkol: hiba += 1
    print("== NEGATIV KONTROLL (a muszer NE szoljon) ==")
    for minta in NEGATIV:
        t = vizsgal_szoveg(minta, "<onteszt>", fail_closed=False)
        ok = not t
        print(f"  [{'OK ' if ok else 'BUKO'}] {minta[:52]:<52} -> {[x[2] for x in t] or 'tiszta'}")
        if not ok: hiba += 1
    print("== MASZK-ELLENORZES (a titok nem szivaroghat ki) ==")
    m = maszk("sk-ant-api03-" + "Z"*40)
    ok = "Z"*10 not in m and m.startswith("sk-a")
    print(f"  [{'OK ' if ok else 'BUKO'}] a maszkolt alak: {m}")
    if not ok: hiba += 1
    print("== N1-JAVITAS: a TITOK-KAPU-KIVETEL jelolo a fajl-argumentum (run_gate) agon NEM szamit ==")
    pelda = "kulcs = \"sk-ant-api03-" + "A"*30 + "9zQ\"  # TITOK-KAPU-KIVETEL"
    t_jelolt = vizsgal_szoveg(pelda, "<onteszt>", fail_closed=False)  # alapertek: --staged/--kovetett/onteszt mod
    t_fajl = vizsgal_szoveg(pelda, "<onteszt>", kivetel_aktiv=False, fail_closed=False)  # run_gate mod
    ok1 = not any(x[4] for x in t_jelolt)
    ok2 = any(x[4] for x in t_fajl)
    print(f"  [{'OK ' if ok1 else 'BUKO'}] --staged/--kovetett/onteszt agon a jelolo tovabbra is kimenti")
    print(f"  [{'OK ' if ok2 else 'BUKO'}] fajl-argumentum (run_gate) agon a jelolo NEM menti ki -> BLOKK")
    if not ok1: hiba += 1
    if not ok2: hiba += 1
    hiba += elo_titkok_onteszt()
    hiba += elo_titkok_fail_closed_onteszt()
    print(f"\nOSSZESEN: {hiba} bukas.")
    return 0 if hiba == 0 else 2


def elo_titkok_onteszt() -> int:
    """F2 (card 09117e0a, Peti dontes komment 18309 pont 2): a LIVE-titok literal-egyezes
    onellenorzese, SAJAT, HAMIS fixture-fajlokkal -- SOHA nem a valodi store/.dashboard-token-t
    vagy a valodi ~/.gemini oauth-tokent hasznalja, es host-fuggetlen (mukodik olyan gepen is,
    ahol ezek nem leteznek). M1-javitas (card 09117e0a, RedHat NO-GO 2. kor): a fixture-fajlokat
    kozvetlen fuggveny-parameterrel (dash_override/oauth_override) adja at vizsgal_szoveg()-nek,
    nem env-valtozoval -- igy ez a teszt magat a VALODI, parameter-alapu mechanizmust gyakorolja,
    nem egy kulon env-plumbingot."""
    import tempfile

    hiba = 0
    with tempfile.TemporaryDirectory() as td:
        dash_file = os.path.join(td, "fake-dashboard-token")
        fake_dash = "F" * 64  # nem a valodi token -- csak a hossz/alak miatt realisztikus
        with open(dash_file, "w") as f:
            f.write(fake_dash + "\n")

        oauth_file = os.path.join(td, "fake-oauth-token")
        fake_access = "ya29." + "G" * 60
        fake_refresh = "1//" + "H" * 40
        with open(oauth_file, "w") as f:
            json.dump({"token": {"access_token": fake_access, "refresh_token": fake_refresh},
                       "id_token": "I" * 30}, f)

        def vizsgal(szoveg: str):
            return vizsgal_szoveg(szoveg, "<onteszt>", dash_override=dash_file, oauth_override=oauth_file)

        print("== LIVE-TITOK LITERAL EGYEZES (sajat fixture, nem a valodi titok) ==")

        cases = [
            ("raw dashboard token egyezik",       fake_dash, True),
            ("raw access token egyezik",          fake_access, True),
            ("raw refresh token egyezik",         fake_refresh, True),
            ("base64-kodolt dashboard token",     base64.b64encode(fake_dash.encode()).decode(), True),
            ("hex-kodolt dashboard token",        binascii.hexlify(fake_dash.encode()).decode(), True),
            ("URL-kodolt access token",           _urlquote(fake_access, safe=""), True),
            # F2-javitas (RedHat N2): az eddiginel szelesebb, korabban at nem fogott alakok.
            ("nagybetus/kisbetus vegyes alak",    fake_dash.lower(), True),
            ("dashboard token sortoressel szetvagva (tobb soron)",
             fake_dash[:10] + "\n" + fake_dash[10:30] + "\n" + fake_dash[30:], True),
            ("dashboard token idezojellel/+ -szal szetvagva",
             f'"{fake_dash[:20]}" + "{fake_dash[20:]}"', True),
            ("base64 dashboard token NEM 3-bajt-hataron (1-bajt elotag)",
             base64.b64encode(("x" + fake_dash).encode()).decode(), True),
            ("base64 dashboard token NEM 3-bajt-hataron (2-bajt elotag)",
             base64.b64encode(("xy" + fake_dash).encode()).decode(), True),
            ("base64url access token eltolva",
             base64.urlsafe_b64encode(("xy" + fake_access).encode()).decode(), True),
            ("dupla URL-kodolt refresh token",
             _urlquote(_urlquote(fake_refresh, safe=""), safe=""), True),
            # F-D (card f6f67dff): zero-width space (U+200B) a raw token kozepebe ekelve.
            ("dashboard token zero-width karakterrel szetszabdalva",
             fake_dash[:30] + "​" + fake_dash[30:], True),
        ]
        for nev, szoveg, vart_blokkol in cases:
            t = vizsgal(szoveg)
            blokkol = any(x[4] for x in t)
            ok = blokkol == vart_blokkol
            print(f"  [{'OK ' if ok else 'BUKO'}] {nev:<34} -> {[x[2] for x in t] or 'NINCS'}")
            if not ok: hiba += 1

        # szokozzel szetszabdalt alak (ugyanazon a soron): a sor-szintu whitespace-tomorites
        # ujra egybeolvasztja a kodolatlan erteket
        szetszabdalt = fake_dash[:10] + " " + fake_dash[10:30] + " " + fake_dash[30:]
        t = vizsgal(szetszabdalt)
        ok = any(x[4] for x in t)
        print(f"  [{'OK ' if ok else 'BUKO'}] {'szokozzel szetszabdalt dashboard token':<34} -> {[x[2] for x in t] or 'NINCS'}")
        if not ok: hiba += 1

        # NEGATIV: egy MASIK, veletlen 64-hex ertek (nem a fixture tokenunk) nem blokkol --
        # ez bizonyitja, hogy a literal-egyezes NEM egy altalanos "64 hex" minta.
        mas_hex = "a1" * 32
        t = vizsgal(mas_hex)
        ok = not any(x[4] for x in t)
        print(f"  [{'OK ' if ok else 'BUKO'}] {'mas 64-hex ertek NEM blokkol (nem minta-alapu)':<34} -> {[x[2] for x in t] or 'tiszta'}")
        if not ok: hiba += 1
    return hiba


def elo_titkok_fail_closed_onteszt() -> int:
    """N4-javitas (card 09117e0a, RedHat NO-GO 1. kor, komment 18498) + M1-javitas (2. kor,
    komment 18611): (1) a RedHat altal pontosan megnevezett env-valtozok (a korabbi
    TITOK_KAPU_TESZT_MODE/TITOK_KAPU_DASHBOARD_TOKEN_FILE/TITOK_KAPU_AGY_OAUTH_FILE,
    MARVEEN_ROOT) MOST mar a kodban EGYALTALAN nem leteznek elo_titkok() belsejeben -- ez a
    teszt poszonozott ertekkel allitja be mindet, majd a VALODI hivasi alakot (parameter
    nelkul) futtatja, es igazolja, hogy a poszonozott fajlok tartalma SOHA nem jelenik meg a
    visszaadott titkok kozott; (2) a hianyzo ALAPERTELMEZETT dashboard-token fajl (eles
    futason ez mindig letezik, lasd a root CLAUDE.md-t) HIBAVAL (TitokKapuHiba) all meg, nem
    csendes kihagyassal -- most kozvetlenul a `root` parameterrel, env nelkul. Host-fuggetlen:
    nem tesz fel semmit a VALODI alapertelmezett fajl letezeserol/tartalmarol, csak azt, hogy a
    FAKE fixture-ertekek soha nem kerulnek elo."""
    import tempfile

    hiba = 0
    print("== M1-JAVITAS: a poszonozott env-valtozok nem erintik a valodi (parameter nelkuli) hivast ==")
    with tempfile.TemporaryDirectory() as td:
        poisoned_dash = os.path.join(td, "poisoned-dashboard-token")
        poisoned_val = "J" * 64
        with open(poisoned_dash, "w") as f:
            f.write(poisoned_val + "\n")
        poisoned_root = os.path.join(td, "poisoned-root")
        os.makedirs(os.path.join(poisoned_root, "store"), exist_ok=True)
        poisoned_root_val = "K" * 64
        with open(os.path.join(poisoned_root, "store", ".dashboard-token"), "w") as f:
            f.write(poisoned_root_val + "\n")

        poison = {
            "TITOK_KAPU_TESZT_MODE": "1",
            "TITOK_KAPU_DASHBOARD_TOKEN_FILE": poisoned_dash,
            "TITOK_KAPU_AGY_OAUTH_FILE": poisoned_dash,
            "MARVEEN_ROOT": poisoned_root,
        }
        elozo = {k: os.environ.get(k) for k in poison}
        os.environ.update(poison)
        try:
            # a VALODI hivasi alak: nulla parameter, pontosan ugy, ahogy vizsgal_szoveg() a
            # run_gate()/CLI utrol hivja.
            titkok = elo_titkok(fail_closed=False)
            erintett = {v for _, v in titkok}
            ok = poisoned_val not in erintett and poisoned_root_val not in erintett
        finally:
            for k, v in elozo.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        print(f"  [{'OK ' if ok else 'BUKO'}] a poszonozott env ({', '.join(poison)}) nem erinti a valodi hivast")
        if not ok: hiba += 1

    # (2) hianyzo alapertelmezett fajl: a `root` parameter kozvetlenul egy ures ideiglenes
    # gyokerre mutat, ahol nincs store/.dashboard-token -> HIBA, nem csendes kihagyas.
    print("== N4-JAVITAS: hianyzo alapertelmezett fajl -> HIBA (fail-closed), nem csendes kihagyas ==")
    with tempfile.TemporaryDirectory() as td2:
        raised = False
        try:
            elo_titkok(root=td2, fail_closed=True)
        except TitokKapuHiba:
            raised = True
        print(f"  [{'OK ' if raised else 'BUKO'}] hianyzo alapertelmezett dashboard-token fajl -> HIBA (fail-closed), nem csendes kihagyas")
        if not raised: hiba += 1
    return hiba

# --- fo ag -----------------------------------------------------------------
def main():
    p = argparse.ArgumentParser(add_help=True)
    p.add_argument("--onteszt", action="store_true")
    p.add_argument("--staged", action="store_true")
    p.add_argument("--kovetett", nargs="?", const=".", metavar="REPO")
    p.add_argument("fajlok", nargs="*")
    a = p.parse_args()

    if a.onteszt:
        return onteszt()

    talalatok = []
    try:
        if a.staged:
            r = subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"],
                               capture_output=True, text=True)
            utak = [u for u in r.stdout.splitlines() if u.strip()]
            for u in utak:
                b = subprocess.run(["git", "show", f":{u}"], capture_output=True, text=True)
                if b.returncode == 0 and not KIHAGY_UT.search(u):
                    talalatok += vizsgal_szoveg(b.stdout, u)
        elif a.kovetett:
            r = subprocess.run(["git", "-C", a.kovetett, "ls-files"], capture_output=True, text=True)
            if r.returncode != 0:
                print("HIBA: nem git-repo:", a.kovetett, file=sys.stderr); return 2
            utak = r.stdout.splitlines()
            print(f"(atvizsgalt kovetett fajl: {len(utak)})", file=sys.stderr)
            for u in utak:
                talalatok += vizsgal_fajl(os.path.join(a.kovetett, u))
        elif a.fajlok:
            # N1-javitas (RedHat NO-GO N4, komment 18498): ez az egyetlen ag, amit seged-hivo.py
            # run_gate()-je hiv (a homokozo fajljaira, mielott Geminire kerulnenek) -- a
            # TITOK-KAPU-KIVETEL jelolo itt NEM szamit, mert ez nem a sajat, atlathato onteszt-
            # fixturankra vagy egy commit-diffre fut, hanem egy KULSO, nem-ellenorzott
            # prompt/workdir tartalmara, ahol a jelolo sora maga is a bemenet resze (a flotta
            # sajat PUBLIKUS repojaban is olvashato, tehat egy tamado/hibas prompt szabadon
            # beirhatja). --staged/--kovetett tovabbra is tiszteli (a kivetel_aktiv alapertek).
            for u in a.fajlok:
                talalatok += vizsgal_fajl(u, kivetel_aktiv=False)
        else:
            p.print_help(); return 2
    except TitokKapuHiba as e:
        print(f"TITOK-KAPU HIBA: {e}", file=sys.stderr)
        return 2

    if not talalatok:
        return 0
    blokkolok = [t for t in talalatok if t[4]]
    jelzesek  = [t for t in talalatok if not t[4]]
    if jelzesek:
        print(f"TITOK-KAPU jelzes: {len(jelzesek)} kliensbe szant (publikus) kulcs. NEM blokkol.",
              file=sys.stderr)
        for ut, sor, nev, m, _ in jelzesek[:5]:
            print(f"  {ut}:{sor}  [{nev}]  {m}", file=sys.stderr)
        if len(jelzesek) > 5:
            print(f"  ... es meg {len(jelzesek)-5} hasonlo", file=sys.stderr)
    if not blokkolok:
        return 0
    print("TITOK-KAPU: BLOKK. Az alabbi helyeken titok-gyanus minta van.", file=sys.stderr)
    print("(a talalat tartalma szandekosan NEM kerul kiirasra)", file=sys.stderr)
    for ut, sor, nev, m, _ in blokkolok:
        print(f"  {ut}:{sor}  [{nev}]  {m}", file=sys.stderr)
    print("\nHa ez valodi titok: vedd ki a fajlbol, tedd kornyezeti valtozoba vagy a store/ ala.",
          file=sys.stderr)
    print("Ha ez pelda: tegyel bele PELDA/EXAMPLE jelolest, vagy hasznalj <helykitolto>-t.",
          file=sys.stderr)
    return 1

if __name__ == "__main__":
    sys.exit(main())

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
import base64, binascii, json, re, sys, os, subprocess, argparse
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
def _marveen_root() -> str:
    return os.environ.get("MARVEEN_ROOT", str(Path(__file__).resolve().parents[2]))


def elo_titkok():
    """[(nev, ertek)] a flotta sajat, MOST elo titkaira. Hianyzo fajl csendben kimarad --
    a hianya nem ennek a kapunak a dolga, es minden tobbi minta/regex tovabbra is fut."""
    out = []
    dash_path = os.environ.get(
        "TITOK_KAPU_DASHBOARD_TOKEN_FILE", os.path.join(_marveen_root(), "store", ".dashboard-token")
    )
    try:
        v = open(dash_path, "r", encoding="utf-8").read().strip()
        if len(v) >= 16:
            out.append(("fleet-dashboard-token", v))
    except OSError:
        pass
    oauth_path = os.environ.get(
        "TITOK_KAPU_AGY_OAUTH_FILE",
        os.path.join(str(Path.home()), ".gemini", "antigravity-cli", "antigravity-oauth-token"),
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


def _kodolt_alakok(ertek: str):
    """A nyers ertek mellett a base64/hex/URL-kodolt alakjait is adja, es egy olyan alakot a
    sorbol, amiben a kodolasra NEM, csak a sorban levo whitespace-re van szukseg: ha a titkot
    szokozzel/sortoressel szetszabdaltak, a sorbol a whitespace kivetele ujra egybeolvasztja.
    Minden alak legalabb 16 karakter -- rovidebb kodolt torzs tul sok veletlen egyezest adna."""
    alakok = [ertek]
    raw = ertek.encode("utf-8", "ignore")
    alakok.append(base64.b64encode(raw).decode("ascii"))
    alakok.append(base64.urlsafe_b64encode(raw).decode("ascii"))
    alakok.append(binascii.hexlify(raw).decode("ascii"))
    alakok.append(_urlquote(ertek, safe=""))
    return [a for a in alakok if len(a) >= 16]


_WHITESPACE_RE = re.compile(r"\s+")


def vizsgal_szoveg(szoveg: str, cimke: str):
    talalatok = []
    elo = elo_titkok()
    elo_alakok = [(nev, forma) for nev, ertek in elo for forma in _kodolt_alakok(ertek)]
    # A hosszu (minified) sort NEM hagyjuk ki: a beagyazott kulcs pont ott lapul, es a mintak
    # literalis elotaggal indulnak, igy egy 2 MB-os sor is linearis ido.
    for sorszam, sor in enumerate(szoveg.splitlines(), 1):
        if KIVETEL_SOR.search(sor):
            continue
        sor_tomoritve = _WHITESPACE_RE.sub("", sor)
        for nev, forma in elo_alakok:
            if forma in sor or forma in sor_tomoritve:
                talalatok.append((cimke, sorszam, nev, maszk(forma), True))
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

def vizsgal_fajl(ut: str):
    if KIHAGY_UT.search(ut):
        return []
    try:
        with open(ut, "r", encoding="utf-8", errors="strict") as f:
            return vizsgal_szoveg(f.read(), ut)
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
]

def onteszt() -> int:
    hiba = 0
    print("== POZITIV KONTROLL (a muszernek LATNIA kell) ==")
    for vart, minta in POZITIV:
        t = vizsgal_szoveg(minta, "<onteszt>")
        nevek = {x[2] for x in t}
        ok = vart in nevek
        print(f"  [{'OK ' if ok else 'BUKO'}] {vart:<18} -> {sorted(nevek) or 'NINCS TALALAT'}")
        if not ok: hiba += 1
    print("== SZETVALASZTAS (publikus kulcs: lat, de nem blokkol) ==")
    t = vizsgal_szoveg(PUBLIKUS_MINTA, "<onteszt>")
    lat = bool(t)
    nem_blokkol = all(not x[4] for x in t)
    print(f"  [{'OK ' if lat else 'BUKO'}] a publikus (anon) JWT-t megtalalja       -> {[x[2] for x in t] or 'NINCS'}")
    print(f"  [{'OK ' if (lat and nem_blokkol) else 'BUKO'}] es NEM blokkolja a commitot")
    if not (lat and nem_blokkol): hiba += 1
    t = vizsgal_szoveg("SUPA_SERVICE=" + [m for n,m in POZITIV if n=="jwt"][-1].split("=")[-1], "<onteszt>")
    blokkol = any(x[4] for x in t)
    print(f"  [{'OK ' if blokkol else 'BUKO'}] a service_role JWT-t viszont BLOKKOLJA -> {[x[2] for x in t] or 'NINCS'}")
    if not blokkol: hiba += 1
    print("== NEGATIV KONTROLL (a muszer NE szoljon) ==")
    for minta in NEGATIV:
        t = vizsgal_szoveg(minta, "<onteszt>")
        ok = not t
        print(f"  [{'OK ' if ok else 'BUKO'}] {minta[:52]:<52} -> {[x[2] for x in t] or 'tiszta'}")
        if not ok: hiba += 1
    print("== MASZK-ELLENORZES (a titok nem szivaroghat ki) ==")
    m = maszk("sk-ant-api03-" + "Z"*40)
    ok = "Z"*10 not in m and m.startswith("sk-a")
    print(f"  [{'OK ' if ok else 'BUKO'}] a maszkolt alak: {m}")
    if not ok: hiba += 1
    hiba += elo_titkok_onteszt()
    print(f"\nOSSZESEN: {hiba} bukas.")
    return 0 if hiba == 0 else 2


def elo_titkok_onteszt() -> int:
    """F2 (card 09117e0a, Peti dontes komment 18309 pont 2): a LIVE-titok literal-egyezes
    onellenorzese, SAJAT, HAMIS fixture-fajlokkal (env-override-dal) -- SOHA nem a valodi
    store/.dashboard-token-t vagy a valodi ~/.gemini oauth-tokent hasznalja, es host-fuggetlen
    (mukodik olyan gepen is, ahol ezek nem leteznek)."""
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

        os.environ["TITOK_KAPU_DASHBOARD_TOKEN_FILE"] = dash_file
        os.environ["TITOK_KAPU_AGY_OAUTH_FILE"] = oauth_file
        try:
            print("== LIVE-TITOK LITERAL EGYEZES (sajat fixture, nem a valodi titok) ==")

            cases = [
                ("raw dashboard token egyezik",       fake_dash, True),
                ("raw access token egyezik",          fake_access, True),
                ("raw refresh token egyezik",         fake_refresh, True),
                ("base64-kodolt dashboard token",     base64.b64encode(fake_dash.encode()).decode(), True),
                ("hex-kodolt dashboard token",        binascii.hexlify(fake_dash.encode()).decode(), True),
                ("URL-kodolt access token",           _urlquote(fake_access, safe=""), True),
            ]
            for nev, szoveg, vart_blokkol in cases:
                t = vizsgal_szoveg(szoveg, "<onteszt>")
                blokkol = any(x[4] for x in t)
                ok = blokkol == vart_blokkol
                print(f"  [{'OK ' if ok else 'BUKO'}] {nev:<34} -> {[x[2] for x in t] or 'NINCS'}")
                if not ok: hiba += 1

            # szokozzel szetszabdalt alak (ugyanazon a soron): a sor-szintu whitespace-tomorites
            # ujra egybeolvasztja a kodolatlan erteket
            szetszabdalt = fake_dash[:10] + " " + fake_dash[10:30] + " " + fake_dash[30:]
            t = vizsgal_szoveg(szetszabdalt, "<onteszt>")
            ok = any(x[4] for x in t)
            print(f"  [{'OK ' if ok else 'BUKO'}] {'szokozzel szetszabdalt dashboard token':<34} -> {[x[2] for x in t] or 'NINCS'}")
            if not ok: hiba += 1

            # NEGATIV: egy MASIK, veletlen 64-hex ertek (nem a fixture tokenunk) nem blokkol --
            # ez bizonyitja, hogy a literal-egyezes NEM egy altalanos "64 hex" minta.
            mas_hex = "a1" * 32
            t = vizsgal_szoveg(mas_hex, "<onteszt>")
            ok = not any(x[4] for x in t)
            print(f"  [{'OK ' if ok else 'BUKO'}] {'mas 64-hex ertek NEM blokkol (nem minta-alapu)':<34} -> {[x[2] for x in t] or 'tiszta'}")
            if not ok: hiba += 1
        finally:
            del os.environ["TITOK_KAPU_DASHBOARD_TOKEN_FILE"]
            del os.environ["TITOK_KAPU_AGY_OAUTH_FILE"]
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
        for u in a.fajlok:
            talalatok += vizsgal_fajl(u)
    else:
        p.print_help(); return 2

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

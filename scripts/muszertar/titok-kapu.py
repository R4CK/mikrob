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
import re, sys, os, subprocess, argparse

# --- minta-keszlet: (nev, regex, minimum-entropia-kell-e) -------------------
MINTAK = [
    # A \\b szohatar KOTELEZO: nelkule a "dont-ask-later-..." szoveg 'sk-later-...'
    # kulcsnak latszik (magyar/angol szohatar-csapda, eles talalat volt).
    ("anthropic-kulcs",   re.compile(r"\bsk-ant-api\d{2}-[A-Za-z0-9_\-]{24,}")),
    ("openai-kulcs",      re.compile(r"\bsk-(?:proj-[A-Za-z0-9_\-]{32,}|[A-Za-z0-9]{32,})")),
    ("github-token",      re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}")),
    ("github-pat",        re.compile(r"\bgithub_pat_[A-Za-z0-9_]{50,}")),
    ("google-api-kulcs",  re.compile(r"\bAIza[A-Za-z0-9_\-]{35}")),
    ("slack-token",       re.compile(r"\bxox[baprs]-[0-9A-Za-z\-]{10,}")),
    ("aws-hozzaferes",    re.compile(r"\bAKIA[0-9A-Z]{16}")),
    ("netlify-pat",       re.compile(r"\bnfp_[A-Za-z0-9]{30,}")),
    ("stripe-eles-kulcs", re.compile(r"\bsk_live_[A-Za-z0-9]{20,}")),
    ("telegram-bot",      re.compile(r"\b\d{8,10}:AA[A-Za-z0-9_\-]{30,}")),
    ("privat-kulcs",      re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("jwt",               re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}")),
    ("db-uri-jelszoval",  re.compile(r"(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)://[^:/\s]+:[^@\s]{6,}@")),
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

def vizsgal_szoveg(szoveg: str, cimke: str):
    talalatok = []
    # A hosszu (minified) sort NEM hagyjuk ki: a beagyazott kulcs pont ott lapul, es a mintak
    # literalis elotaggal indulnak, igy egy 2 MB-os sor is linearis ido.
    for sorszam, sor in enumerate(szoveg.splitlines(), 1):
        if KIVETEL_SOR.search(sor):
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
    print(f"\nOSSZESEN: {hiba} bukas.")
    return 0 if hiba == 0 else 2

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

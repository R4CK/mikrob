# Ingatlan

Peti személyes, csak-saját-használatú ingatlanpiac-követő projektje (kártya 61283865, epic 6c69851f).
Cél: két ingatlan.com térkép-keresés (Bp II. ker., ház + lakás, 50m2 felett, 120 MFt-ig) napi
lekérdezése, a hirdetések adatainak és ár-történetének tárolása, majd (később, 2-4/4 kártya) piaci
statisztika, trend-előrejelzés és egy lokális, Google OAuth-tal védett dashboard.

Minden adat ezen a könyvtáron BELÜL él (nincs külső DB/felhő) -- ld. `../.gitignore`:
`Ingatlan/data/`, `Ingatlan/*.db`, `Ingatlan/.env` stb. gitignore-olt, a kód (ez a könyvtár) tracked.

## Jogi/ToS figyelem

Csak személyes használatra. Nincs republikálás, nincs kereskedelmi felhasználás.

## ARCHITEKTÚRA-VÁLTÁS (Peti döntése, 2026-08-12, kártya 3f6bcc41)

Az eredeti terv (1/4 kártya: saját automatizált lekérdezés) helyett Peti úgy döntött, hogy NEM
kerüljük meg az ingatlan.com Cloudflare bot-védelmét. Helyette: egy böngésző-kiegészítő olvassa ki
a hirdetéseket Peti SAJÁT, valódi bejelentkezett böngészéséből, és egy lokális ingest-végpontnak
küldi el. Ez az AKTÍV adatgyűjtési út -- ld. "Állapot (1b/4)" lent.

Az 1/4 kártyában épült `src/robots.ts` + `src/http.ts` (saját kimenő lekérdezés réteg) +
`src/scraper.ts` + `src/run.ts` (fetch-orchestráció) emiatt VALÓSZÍNŰLEG feleslegessé válik --
nincs többé saját kimenő lekérdezés, amit respektálnia/ütemeznie kellene. NEM lettek törölve
(MikroB explicit kérése: jelezni, nem csendben törölni) -- a végleges döntést egy külön kártya
hozza meg. A `src/db.ts` (séma + ár-történet logika) VÁLTOZATLANUL érvényes és aktívan használt,
csak az adat forrása más (extension POST, nem saját fetch).

## Állapot (1b/4 kártya: böngésző-kiegészítő + lokális ingest-végpont)

**KÉSZ és tesztelt** (108 teszt összesen az Ingatlan-fán, `store/fleet-test.sh Ingatlan`):
- `src/ingest-validate.ts` -- Zero Trust bemenet-validáció minden mezőre (a payload egy
  harmadik-fél oldalon futó content-scriptből jön, még ha csak localhostra is megy); az url mezőt
  kifejezetten az `ingatlan.com` domain-re szorítja (védelem egy tetszőleges/rosszindulatú link
  becsempészése ellen).
- `src/ingest-token.ts` -- helyi, gitignore-olt, 0600 jogú token-fájl (`Ingatlan/data/.ingest-token`),
  első futáskor generálva, ugyanaz a minta mint a flotta `store/.dashboard-token`-je.
- `src/ingest-server.ts` -- a végpont KIZÁRÓLAG `127.0.0.1`-re köt (a bind-cím szándékosan NEM
  paraméterezhető env-ből -- ez egy biztonsági invariáns, nem kényelmi beállítás), Bearer-token
  auth az `/ingest` és `/debug` útvonalon (a `/health` nem igényel auth-ot), body-méret-korlát,
  és a `Ingatlan/src/db.ts` MÁR KÉSZ `recordSighting()`-jét hívja újrahasznosítva.
- `src/run-ingest.ts` -- composition root (`npm run ingatlan:ingest`), kiírja a tokent induláskor.
- `extension/` -- Manifest V3 böngésző-kiegészítő: `content-script.js` a két megadott
  ingatlan.com térkép-keresés oldalán fut, kiolvassa a hirdetés-listát, `background.js` (service
  worker) küldi tovább a lokális szervernek (a fetch a service workerből megy, NEM a
  content-scriptből, mert onnan a localhost-ra menő hívás CORS-t ütne -- a service worker
  `host_permissions`-e viszont felold ez alól), `options.html`/`.js` a token/port beállítására.
- `extension/parse-listing-text.js` -- a tényleges szöveg-feldolgozó (ár/terület/nm2-ár/állapot/
  építési év/cím regex-ek), külön modulba szervezve KIFEJEZETTEN azért, hogy tesztelhető legyen
  böngésző-API-k nélkül (`src/__tests__/parse-listing-text.test.ts`, 25 teszt).

**NEM VERIFIKÁLT a valós oldallal szemben** (lásd alább "Blokkolt" -- ugyanaz az ok, mint 1/4-nél:
Cloudflare + egress-allowlist miatt ez az ügynök nem tudta lekérni a valós HTML-t). A content
script DOM-heurisztikát használ (hirdetés-részletező linkek -> legközelebbi kártya-konténer, ami
tartalmaz árat ÉS területet), NEM valós szelektorok alapján. HA nulla hirdetést talál egy oldalon,
automatikusan küld egy debug-capture-t (URL + HTML-részlet) a `/api/ingatlan/debug` végpontnak --
ez zárja be a kört: Peti egy futtatással valós adatot ad, amiből a szelektorok EGY iterációban
pontosíthatók, nem újra kitalálva.

**Telepítés Petinek:**
1. `npm run ingatlan:ingest` -- elindítja a lokális szervert, kiírja a tokent a terminálra.
2. Chrome/Edge -> `chrome://extensions` -> Fejlesztői mód BE -> "Kicsomagolt kiegészítő betöltése"
   -> válaszd az `Ingatlan/extension/` mappát.
3. A kiegészítő ikonjára jobb klikk -> Beállítások (vagy `chrome://extensions` -> Részletek ->
   Kiegészítő beállításai) -> illeszd be az 1. lépésben kapott tokent -> Mentés.
4. Nyisd meg a két megadott ingatlan.com térkép-keresést valódi, bejelentkezett böngészőben --
   a kiegészítő automatikusan kiolvassa és elküldi a hirdetéseket. `npm run ingatlan:analyze`
   ezután valós adatot fog mutatni.

## Állapot (2/4 kártya: elemző réteg)

**KÉSZ és tesztelt** (28 teszt, `src/analysis/`): grouped (ház/lakás/összevont) átlag/medián/
min/max nm2-ár (`analysis/stats.ts`), median ±5%-os sávba eső hirdetések (ugyanott), és egy
lineáris trend-előrejelzés (`analysis/trend.ts`) -- napi medián-sorozat REKONSTRUÁLVA a
price_history-ból (egy hirdetés utolsó ismert ára "előre görgetve" azokra a napokra, amikor nem
volt ár-változás, mert `recordSighting` csak változásnál ír sort), majd OLS lineáris illesztés.
14 napnál kevesebb historikus napi mintánál `insufficient-data`-t ad vissza (a kártya explicit
kérése: "kezdetben csak keresztmetszeti statisztikat adjon"), nem erőltet trendet zajra.
`src/query.ts` a DB-olvasó adapter, `src/analysis/report.ts` az orchestráció (`analyzeMarket`),
`src/analyze.ts` egy CLI (`npm run ingatlan:analyze`) ami kiírja a jelentést. Jelenleg "nincs adat"-
ot ír minden csoportra, mert a DB üres (1/4 scraper blokkolva, ld. alább) -- ez a helyes, várt
viselkedés, nem hiba.

## Állapot (1/4 kártya: adattároló + scraper) -- ARCHITEKTÚRA-VÁLTÁS ÓTA VALÓSZÍNŰLEG HOLT KÓD

`src/db.ts` ÉRVÉNYES és aktívan használt (ld. fent). A `robots.ts`/`http.ts`/`scraper.ts`/`run.ts`
saját-lekérdezés réteg feleslegessé vált (ld. "ARCHITEKTÚRA-VÁLTÁS" fent) -- nincs törölve, döntésre
vár. A blokkoló-leírás lent történeti, nem aktuális teendő.

**KÉSZ és tesztelt** (nem függ a konkrét URL-ektől/oldal-struktúrától):
- `src/db.ts` -- SQLite séma (`listings`, `price_history`) + upsert/ár-történet logika: új hirdetés
  felvétele, meglévőnél CSAK ár-változásnál új `price_history` sor (nem felülírás).
- `src/robots.ts` -- általános robots.txt parser + útvonal-engedélyezés-ellenőrzés.
- `src/http.ts` -- rate-limitelt HTTP fetch réteg (User-Agent, min. időköz).
- `src/scraper.ts` -- a napi ciklus PURE orchestrációja (`runScrapeCycle`), a HTML-lekérés és a
  HTML-parse INJEKTÁLT port-ként megy bele -- így a teljes dedup/ár-történet-döntés logika
  tesztelhető és tesztelve van a valós parser nélkül is.

**BLOKKOLT, két okból (mindkettőt jeleztem MikroB-nak, üzenet id 12251, 2026-08-12):**
1. A kártya/epic leírásában NINCS a két konkrét ingatlan.com térkép-URL (csak szöveges kritérium:
   Bp II. ker, ház+lakás, 50m2+, 120 MFt-ig) -- ezek nélkül a keresés szűrőparamétereit (kerület-kód,
   ár-egység, típus-szűrő) nekem kellene kitalálnom, ami pont az a nem-verifikált feltételezés-osztály
   amit nem viszek bele egy adatgyűjtőbe.
2. Az egress-gate (`store/egress-allowlist.json`, jelenleg nem létezik) és a quarantine-reader
   sub-agent rögzített allowlistje sem engedi az `ingatlan.com` lekérését -- nem tudtam megnézni a
   valós keresési-eredmény oldal HTML/JSON struktúráját (van-e beágyazott JSON, mik a mezőnevek,
   hogyan lapozik). Ezt is jeleztem, de az allowlist bővítése operátor-döntés (biztonsági kapu),
   nem hoztam meg egyoldalúan.

**Hátra van, amint a blokkolók megoldódnak:**
- `src/scraper.ts`-ben a `parseSearchResultsHtml()` valódi implementációja (jelenleg explicit
  `NotImplementedError`-t dob, leírva miért) -- a valós oldal-struktúra ismerete kell hozzá.
- `src/run.ts`-ben a két valós URL behelyettesítése (jelenleg placeholder, hibát dob, ha nincs kitöltve).
- A napi ütemezés bekötése (scheduled-task vagy cron) -- ez a kártya explicit része, de a fenti kettő
  nélkül nincs mit ütemezni.

## Adatmodell

```sql
listings(
  id TEXT PRIMARY KEY,        -- ingatlan.com hirdetés-azonosító (az URL-ből)
  url TEXT NOT NULL,
  tipus TEXT NOT NULL,        -- 'haz' | 'lakas'
  allapot TEXT,
  epitesi_ev INTEGER,
  cim TEXT,
  alapterulet_m2 REAL,
  elso_eszlelt_at INTEGER NOT NULL   -- unix epoch, első észlelés
)

price_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  ar INTEGER NOT NULL,
  nm2_ar REAL NOT NULL,
  eszlelt_at INTEGER NOT NULL        -- unix epoch
)
```

Egy `price_history` sor csak akkor kerül be, ha az adott hirdetés eddig ismert legutóbbi ára
(vagy nm2-ára) ELTÉR az újonnan látott értéktől -- vagy ez az első észlelés. Ismétlődő azonos-árú
napi lekérdezés NEM hoz létre új sort (ld. `db.ts` `recordSightingIfChanged`, tesztelve).

## Futtatás

```bash
npm run ingatlan:ingest    # a lokális ingest-szerver (AKTÍV út -- ld. "Állapot (1b/4)" fent)
npm run ingatlan:analyze   # kiírja a piaci jelentést (2/4)
npm run ingatlan:typecheck # = tsc -p Ingatlan --noEmit
npm run ingatlan:run       # = tsx Ingatlan/src/run.ts -- a felülírt 1/4 saját-scraper, ld. fent
```

A saját-scraper úthoz (`ingatlan:run`) a két URL-t env változóban kellene megadni
(`INGATLAN_SEARCH_URL_HAZ`, `INGATLAN_SEARCH_URL_LAKAS`) -- de ez az út valószínűleg feleslegessé
vált, ld. "ARCHITEKTÚRA-VÁLTÁS" fent.

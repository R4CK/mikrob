# Ingatlan

Peti személyes, csak-saját-használatú ingatlanpiac-követő projektje (kártya 61283865, epic 6c69851f).
Cél: két ingatlan.com térkép-keresés (Bp II. ker., ház + lakás, 50m2 felett, 120 MFt-ig) napi
lekérdezése, a hirdetések adatainak és ár-történetének tárolása, majd (később, 2-4/4 kártya) piaci
statisztika, trend-előrejelzés és egy lokális, Google OAuth-tal védett dashboard.

Minden adat ezen a könyvtáron BELÜL él (nincs külső DB/felhő) -- ld. `../.gitignore`:
`Ingatlan/data/`, `Ingatlan/*.db`, `Ingatlan/.env` stb. gitignore-olt, a kód (ez a könyvtár) tracked.

## Jogi/ToS figyelem

Csak személyes használatra. Nincs republikálás, nincs kereskedelmi felhasználás. A scraper
`src/robots.ts`-ben respektálja a robots.txt-et (RFC 9309 szerint: leghosszabb egyező szabály nyer,
döntetlennél Allow), és `src/http.ts`-ben minimum-időközt (rate limit) tart a kérések között.

## Állapot (1/4 kártya: adattároló + scraper)

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

## Futtatás (a blokkolók megoldása után)

```bash
tsx Ingatlan/src/run.ts
```

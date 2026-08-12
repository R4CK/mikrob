# Ingatlan Elemző – IA & User Flow

Kártya: 9ca81f45 · Fron Ted · 2026-08-12

## Összefoglaló

Egyszemélyes lokális dashboard Budapest II. kerületi ingatlanpiac elemzéséhez.
Nincs komplex navigáció: 3 nézet, egyetlen gazdagép (`localhost`), Google OAuth kapu.

Prototípus artifact: https://claude.ai/code/artifact/490c36f1-5bba-4410-a322-c650fa57b929

---

## 1. Architektúra áttekintés

```
localhost:<PORT>
  └── / (redirect → /dashboard ha autentikált, különben /login)
      ├── /login            Google OAuth entry
      └── /dashboard        SPA shell
            ├── #piac        Piaci áttekintés (default tab)
            ├── #hirdetesek  Összes hirdetés táblázat
            └── #naplo       Scraper futási napló
```

A kártya `3d04350b` (webapp + OAuth) adja a szervert és a Google OAuth kaput;
ez a kártya (9ca81f45) csak a frontend-komponenseket és a UX-tervet adja.

---

## 2. Navigáció

### Top bar (rögzített)
| Elem | Tartalom |
|------|----------|
| Brand | 🏡 Ingatlan Elemző + BP II. ker. · 50m²+ / 120M felirat |
| Freshness | ● élő dot + "Frissítve: YYYY-MM-DD HH:MM" |
| Témaváltó | ☀️/🌙 toggle (light/dark) |
| User chip | Avatar + "Peti" + kijelentkezés |

### Oldalsáv (desktop: 200px fix; mobil: alsó tab bar)
| Nav item | Ikon | Jelvény |
|----------|------|---------|
| Piac | 📊 | — |
| Hirdetések | 🏘️ | aktív db szám |
| Napló | 📋 | — |

Aktív nav-item: bal oldali 3px arany sáv jelzi.

---

## 3. Nézetek

### 3.1 Piac (default)

**KPI strip** (4 cella, egyetlen kártyasor, nem boxolt):
1. Ház – Medián nm²-ár (M Ft) + Δ% előző hóhoz
2. Lakás – Medián nm²-ár (M Ft) + Δ%
3. Aktív hirdetések (db) + heti változás
4. Mediánsáv-egyezés (db, ±5% mediántól) → arany szín

**Grafikonok (2-col, 3:2 arány):**

*Bal – nm²-ár trend (Recharts LineChart):*
- X: 12 hónapos idősor (havi pont)
- Y: M Ft/m² skála
- 2 sor: Ház (lila `#9580ff`) + Lakás (égszínkék `#36caf5`)
- Terület-kitöltés 15% opacitással az ár alatt
- Utolsó pont kiemelve; hover tooltip mindkét értékkel

*Jobb – Ár-eloszlás (Recharts BarChart):*
- X: árcsoportok (< 50M, 50-70M, 70-90M, 90-110M, 110-120M)
- Y: hirdetések száma
- Csoportosított oszlop: Ház (lila) + Lakás (kék)
- Legfelső sarokban a szegmens összesítője

**Mediánsáv-kártyák (2-col):**
- Ház: `1,29 – 1,43 M Ft/m²` (±5%, medián: 1,36 M) + belüli db szám
- Lakás: `1,01 – 1,11 M Ft/m²` (±5%, medián: 1,06 M) + belüli db szám
- Arany (`#f0a500`) kiemelés a sávra

**Hirdetéstáblázat (előnézet, 8 sor + "Összes →" link):**
Oszlopok: Cím / Típus chip / Alapterület / Ár / nm²-ár / Δ ár / Mediánsáv pill
- Mediánsávon belüli sor: arany háttér-dimmel kiemelve
- Δ ár: zöld (csökkent) / piros (nőtt) jelzőszín
- Mediánsáv pill: "⬤ belül" (arany) · "↑ fölött" (narancs) · "↓ alatt" (szürke)

### 3.2 Hirdetések

Teljes táblázat (127 sor), szűrők: Mind / Ház / Lakás / ⬤ Mediánsávban.
CSV export gomb. Kattintható sor → részlet panel (árelőzmény-grafikon, ingatlan.com link).

### 3.3 Napló

Időrendi lista: minden scraper-futás státusza, időbélyeg, új hirdetések száma, hibaleírás.
Státusz: ● zöld (ok) · ● piros (hiba). Hiba esetén az üzenet bővíthető chevronnal.

---

## 4. Állapotok minden nézetre

| Állapot | Megjelenítés |
|---------|--------------|
| **Loading** | Loader overlay (arany spinner) kb. 1s; skeleton lehetséges implementációban |
| **Empty** | Ikon + "Még nincs adat" + "Azonnali frissítés indítása" gomb |
| **Error (scraper)** | ⚠️ + hibaüzenet + "Napló megtekintése" link |
| **Offline** | Toast: "Nincs kapcsolat a helyi API-val — ellenőrizd, fut-e a szerver" |
| **Adat (normál)** | Teljes dashboard; freshness dot: zöld ha < 26h, sárga 26-48h, piros > 48h |

---

## 5. Adatforma (12e508c4 analytics layertől várva)

```typescript
// API response contract (tervezett)
interface MarketSummary {
  haz_median_nm2:  number   // M HUF/m²
  lakas_median_nm2: number
  haz_avg_nm2:     number
  lakas_avg_nm2:   number
  haz_min_nm2:     number
  lakas_min_nm2:   number
  haz_max_nm2:     number
  lakas_max_nm2:   number
  aktiv_db:        number
  utolso_frissites: string  // ISO
  delta_haz_pct:   number   // havi változás %
  delta_lakas_pct: number
}

interface TrendPoint {
  datum:     string   // YYYY-MM
  haz_nm2:   number
  lakas_nm2: number
}

interface Listing {
  id:         string
  url:        string
  tipus:      'haz' | 'lakas'
  cim:        string
  alapterulet_m2: number
  ar:         number   // M HUF
  nm2_ar:     number   // M HUF/m²
  delta_pct:  number   // legutóbbi árváltozás %
  median_rel: 'belul' | 'folott' | 'alatt'
  ar_history: Array<{ datum: string; ar: number }>
  elso_eszlelt_at: string
}
```

---

## 6. Chart komponensek (Recharts, 10. szabály)

```bash
# Telepítés (npm)
npm install recharts
# Alternatív: chart.js + react-chartjs-2 (nagyobb bundle, több testreszabás)
# Döntés: Recharts (könnyebb React integráció, kisebb bundle, aktívan karbantartott)
```

Komponens-terv:
- `<TrendChart data={trendPoints} />` → `LineChart` + 2 `Line` + `Area` + `Tooltip`
- `<DistChart data={distData} />` → `BarChart` + 2 `Bar` (ház/lakás)
- `<PriceHistory data={listing.ar_history} />` → mini `LineChart` részletpanelben
- `<SparkLine prices={prices} />` → ultra-compact `LineChart` a táblázat sorokban

---

## 7. Dizájn tokenek

| Token | Érték | Szerep |
|-------|-------|--------|
| `--house` | `#9580ff` | Ház adat |
| `--apt` | `#36caf5` | Lakás adat |
| `--gold` | `#f0a500` | Mediánsáv, fő akció |
| `--bg` | `#0d1525` | Oldalháttér (dark) |
| `--surface` | `#152038` | Kártya háttér |
| `--text1` | `#dce8fa` | Elsődleges szöveg |
| `--text2` | `#7d96c4` | Másodlagos |
| `--good` | `#34d399` | Csökkent ár |
| `--warn` | `#f87171` | Nőtt ár |

Light mode: `--bg: #eef2fa`, `--surface: #ffffff` (teljes lista az artifaktban).

---

## 8. Reszponzivitás (13. szabály)

| Breakpoint | Változás |
|------------|----------|
| > 900px | Teljes layout: sidebar + 2-col charts |
| 680-900px | 1-col charts; KPI 2x2 grid |
| < 680px | Sidebar → alsó tab bar 56px; padding csökkentve |

Touch target minimum: 44px (nav items, filter chipek, KPI drill-down).

---

## 9. Referenciák

- [Real Estate Investment Dashboard](https://dribbble.com/shots/25980355) – KPI hierarchia + light/dark toggle
- [Real Estate Insights Dashboard](https://dribbble.com/shots/23506110) – bento panel bontás multi-metrikához
- [Modern Financial Dashboard UI](https://dribbble.com/shots/25351025) – sötét alap + arany kiemelés + idősoros

---

## 10. Gate

QA: flow-teljesség (minden állapot elérhető-e) + reszponzivitás (mobil + tablet + desktop).
Trust-boundary nincs ezen a kártyán (az OAuth a 3d04350b-n van).

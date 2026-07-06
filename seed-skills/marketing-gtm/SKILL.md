---
name: marketing-gtm
description: Positioning, messaging hierarchy, and go-to-market framework for a product or launch. Use for marketing strategy, GTM plans, landing copy, and channel selection (marketing agent's core skill).
---
# Marketing & Go-To-Market

## Mikor használd
Pozicionálás, üzenet, GTM terv, launch, landing copy, csatorna-stratégia. Alapozz előbb, taktikázz utána.

## Eljárás
1. **Pozicionálás + üzenet (előbb ezt):** építsd fel az üzenet-hierarchiát:
   - **Fő állítás:** egy mondat, mérhető EREDMÉNY (nem feature).
   - **Támasztó pontok:** 3 bullet, hogyan szállítod az eredményt.
   - **Bizonyíték:** metrika, testimonial, integráció, demo.
   - **Kockázat-fordítás:** trial, garancia, pilot.
2. **Eredményt adj el, ne feature-listát.** A vevő megoldást vesz, nem specifikációt.
3. **GTM pillérek:** Discovery (piac/kontextus), Personák & szegmentáció, Pozicionálás & üzenet, Ár, Place (hol vásárolnak), Promóció.
4. **Telített piac = fókusz:** szűk ék, egyedi mechanizmus köré pozicionálj, gyorsan bizonyíts értéket.
5. **2-3 csatorna előbb:** ne legyél mindenhol. Tesztelj világos aktiváció/retenció küszöbbel, és csak azt skálázd, ami működik.

## Kimenet
1. Egymondatos pozicionálás + cél-persona.
2. Üzenet-hierarchia (állítás / támasz / bizonyíték / kockázat-fordítás).
3. 2-3 prioritizált csatorna, mindegyikhez a kísérlet és a siker-küszöb.
4. A kért asset (copy, landing vázlat, launch szekvencia).

## Technikai akvizíciós csatorna (programmatic SEO)

Akkor vedd elő, ha a termék adott entitásokra (helyszín, iparág, feature, integráció) sok landing-oldalt igényel, és a cél organikus forgalom szerzés nulla extra hírdetési kiadás mellett.

### Programmatic SEO alaplogika
1. **Template + adat = oldal-tömeg.** Egy sablont + strukturált adatforrást (JSON/CSV/DB) kombináld: pl. `"{city} takarítócégek"` → 500 város = 500 egyedi URL.
2. **Entitás-ötletelés:** ki mit keres a célfunkcióval kapcsolatban? Dimenziókat (lokáció, use-case, integráció, iparág, konkurens-összehasonlítás) keresztezd.
3. **Tartalom-mélység küszöb:** Google csak akkor indexeli érdemben, ha az oldal tényleges, egyedi értéket ad (nem csak a kulcsszó cserélődik). Legalább 3 egyedi adatpont vagy CTA-specifikus blokk szükséges oldalonként.
4. **Belső linkelés:** a programmatic oldalak egy kategória-hub alá szerveződjenek; a hub-oldalt kézzel írt, mély tartalommal töltsd fel.
5. **Indexelés kontroll:** `sitemap.xml` + `robots.txt` + Search Console submit. Figyelj a *crawl budget*-re: ha az oldalak ~30%-a 404 vagy vékony tartalom, Google lassítja a kúszást.

### Technical SEO audit alaplépések
- **Core Web Vitals:** LCP < 2,5s; INP < 200ms; CLS < 0,1. Mérés: PageSpeed Insights + CrUX.
- **Indexelhetőség:** minden fontos URL `200 OK`, kanonikus tag helyes, nincs `noindex` véletlenül.
- **Mobile-first:** Google mobilból indexel. Teszteld a PWA-t mobilon is.
- **Belső linkelési mélység:** fontos oldalak legyenek 3 kattintáson belül a főoldalról.
- **Holt URL-ek:** 301-gyel irányítsd át az elavult slug-okat; ne adj `410`-et strukturált tartalomnak.

### Structured data / schema markup
- **Minimumok SaaS landing-hoz:** `Organization`, `WebSite` (+ `SearchAction`), `SoftwareApplication`.
- **Inspection/audit oldalaknál:** `HowTo` vagy `FAQPage` snippet jól konvertál.
- **Local/city landing:** `LocalBusiness` + `GeoCoordinates` ha releváns.
- **Implementálás:** JSON-LD a `<head>`-ben, minden oldaltípushoz külön template. Validálás: Google Rich Results Test.
- **Ne duplikáld:** ha a CMS már generál schema-t, ne add hozzá kétszer -- Google duplikátnak veszi.

### Siker-küszöb
Programmatic ághoz: 90 napra mérd a `(indexelt oldalak / feltöltött oldalak)` arányt. 40% alatt a tartalom-mélység vagy a technikai SEO a bottleneck.

## Buktatók
- Feature a benefit helyett = klasszikus hiba. Mindig az eredményt fogalmazd meg.
- "Legyünk mindenhol" -> szétaprózott budget, nincs tanulás. 2-3 motion előbb mester szinten.
- Hype, amit a termék nem fed le -> churn-gép. Maradj őszinte.

## Ellenőrzés
- A fő állítás egy mondat és mérhető.
- Minden csatornához van küszöb és kísérlet.
- Az üzenet kiállja a "na és?" tesztet (van bizonyíték).

## Források
- https://arisegtm.com/blog/go-to-market-strategy-for-startups
- https://asana.com/resources/go-to-market-gtm-strategy
- https://www.influencers-time.com/marketing-framework-for-startups-in-saturated-markets-2025-3/
- https://salesmotion.io/blog/go-to-market-strategy-framework

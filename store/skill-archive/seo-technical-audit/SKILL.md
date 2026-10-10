---
name: seo-technical-audit
description: Technikai + on-page SEO audit és AI-search (GEO/AEO) optimalizálás — Core Web Vitals, crawlability, schema markup, kulcsszó-intent, E-E-A-T, backlink-minőség. Use for SEO audit, ranking issues, "why aren't we showing up in Google/AI answers". Triggerek: "SEO", "keresőoptimalizálás", "Core Web Vitals", "schema markup", "miért nem rankolunk", "AI Overview", "backlink audit".
---
# SEO & Technical Audit (+ GEO/AEO)

## Mikor használd
SEO-audit igénylésekor, ranking-probléma diagnosztizálásakor, új oldal/feature SEO-checklistjekor, vagy amikor arról van szó, hogy a tartalom megjelenik-e AI-alapú válaszmotorokban (Google AI Overview, ChatGPT, Perplexity).

## Eljárás

### 1. Technikai SEO checklist
- [ ] **Crawlability:** robots.txt nem tiltja a fontos útvonalakat; nincs véletlen `noindex`.
- [ ] **XML sitemap** létezik, be van küldve Search Console-ba, csak indexelendő URL-eket tartalmaz.
- [ ] **Canonical tag** minden oldalon helyesen mutat (self-canonical, kivéve duplikált tartalomnál).
- [ ] **Core Web Vitals:** LCP < 2.5s, INP < 200ms, CLS < 0.1 (mobil és desktop is).
- [ ] **Mobile-first indexing:** a mobil verzió tartalmazza az ÖSSZES SEO-releváns tartalmat és structured data-t, nem csonkolt.
- [ ] **HTTPS + helyes redirect-lánc** (max 1 redirect, nincs redirect-hurok).
- [ ] **Structured data (schema.org):** Organization, Product/SoftwareApplication, FAQPage, BreadcrumbList -- validálva Rich Results Test-tel.

### 2. On-page SEO
- **Title tag:** egyedi, 50-60 karakter, elsődleges kulcsszó elöl, márkanév a végén.
- **Meta description:** 150-160 karakter, cselekvésre ösztönző, nem duplikált oldalak közt.
- **Heading-hierarchia:** egy H1/oldal, logikus H2/H3 struktúra a tartalom vázára épülve, nem stílus célra.
- **Kulcsszó-intent mapping:** minden céloldalhoz egyértelmű intent (informational / navigational / commercial / transactional) -- rossz intent-illesztés a leggyakoribb ok, amiért egy jól optimalizált oldal mégsem konvertál.
- **Belső linkelés:** minden fontos oldal legalább 2-3 belső linket kap releváns anchor text-tel.

### 3. Off-page & E-E-A-T
- **Backlink-minőség > mennyiség:** releváns domain, valós forgalom, nem link-farm. Toxikus backlink → disavow.
- **E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness):** szerzői attribúció, valós esettanulmány/adat a tartalomban, külső hivatkozás megbízható forrásra, cégadat/impresszum látható.

### 4. GEO/AEO -- AI-search optimalizálás (2026-os trend)
A hagyományos SEO mellett a tartalomnak AI-válaszmotorokban (Google AI Overview, ChatGPT, Perplexity) is meg kell jelennie:
- **Egyértelmű, kivonatolható válasz-blokkok:** kérdés-válasz formátum, rövid definíciós bekezdés a tartalom elején, mielőtt a mélyebb részletezés jönne.
- **Structured data kiemelt szerepe:** FAQPage és HowTo schema segíti az AI-kivonatolást.
- **Idézhető, konkrét adat/statisztika** a szövegben -- az AI-motorok szívesebben idéznek forrás-attribúciós, számszerű állítást, mint általános marketing-szöveget.
- **Frissesség:** dátumozott, rendszeresen frissített tartalom nagyobb eséllyel kerül be az AI-összefoglalókba.

### 5. Kulcsszó-kutatás gyors keretrendszer
1. Seed kulcsszó → intent-klaszterezés (mit keres a user ténylegesen).
2. Verseny-elemzés: ki rankol most az adott kulcsszóra, mennyire nehéz betörni.
3. Long-tail prioritás korai fázisban (kisebb verseny, magasabb konverziós szándék).

### 6. Riport-struktúra
```
1. Összefoglaló (3 mondat): mi a fő probléma, mi a fő lehetőség
2. Technikai audit eredmény (pass/fail checklist)
3. On-page hiányosságok, oldalanként
4. Kulcsszó-prioritás lista (top 10, intent + becsült nehézség)
5. GEO/AEO-készenlét
6. Következő 3 konkrét lépés
```

## Kimenet
1. Technikai audit checklist pass/fail státusszal.
2. On-page hiányosság-lista oldalanként, prioritizálva.
3. Kulcsszó-prioritás lista intent-tel.
4. GEO/AEO-készenlégi értékelés.
5. Konkrét, sorrendezett akcióterv.

## Buktatók
- Kulcsszó-sűrítés (keyword stuffing) helyett intent-illesztésre optimalizálj -- a modern algoritmus a relevanciát, nem az ismétlést jutalmazza.
- Core Web Vitals csak desktopon mérve -- mindig mérd mobilon is, a Google mobile-first index alapján rankol.
- Egy technikailag hibátlan oldal tartalom/E-E-A-T nélkül nem fog rankolni versenyzett kulcsszóra.
- GEO/AEO nem helyettesíti a hagyományos SEO-t -- kiegészíti, ugyanaz a technikai alap (crawlability, schema) mindkettőhöz kell.

## Ellenőrzés
- Minden technikai checklist-pont ellenőrizve (pass/fail, nem kihagyva).
- Kulcsszó-lista intent-tel és becsült nehézséggel készült.
- A riport tartalmaz konkrét, sorrendezett következő lépést, nem csak diagnózist.

## GitHub-first döntés (Peti szabály 2026-07-12)
Több karbantartott, nyílt SEO-skill-csomag létezik (pl. 25 sub-skill technikai/GEO/AEO/local SEO lefedéssel, 34 nyílt marketing-skill), de ezek nagy, több-agentes csomagok külső API-függőséggel (DataForSEO, Firecrawl) -- a jelenlegi igényhez (audit-checklist + framework) túlméretezettek, és a függőség-teher/license-vizsgálat meghaladná a feladat arányát. Döntés: **adapt** -- a bennük dokumentált checklist-struktúrát és GEO/AEO-keretrendszert vettem át saját megfogalmazásban, külső API-kötés nélkül. Ha később mélyebb (API-integrált) SEO-tooling indokolt, ezek a repók az elsődleges jelöltek.

## Források
- https://github.com/AgriciDaniel/claude-seo (technikai SEO, E-E-A-T, schema, GEO/AEO, backlink, local SEO keretrendszer)
- https://github.com/thatrebeccarae/claude-marketing (audit checklist, iparági benchmark struktúra)
- https://github.com/OpenClaudia/openclaudia-skills (34 nyílt marketing-skill: SEO, content, email, ads)

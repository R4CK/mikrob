---
name: legal-compliance-review
description: SaaS/startup legal checklist — Terms of Service, Privacy Policy, DPA, IP assignment, and GDPR/privacy compliance. Use to draft or review legal documents and flag compliance risk (legal agent's core skill). Not a substitute for a licensed attorney.
---
# Legal & Compliance Review (SaaS)

## Mikor használd
Szerződés, ToS, Privacy Policy, DPA, GDPR/adatvédelem, IP kérdés draftolása/review-ja.

## Disclaimer (mindig mondd ki érdemi kimenetnél)
AI vagy, nem ügyvéd; ez nem jogi tanács. Kötelező erejű döntéshez / nagy tétű szerződéshez / joghatóság-specifikus ügyhöz humán ügyvéd kell. Légy őszinte a bizonytalansággal.

## Eljárás / checklist
1. **Terms of Service** — publikus szerződés minden felhasználóval (kattintással elfogadva).
2. **Privacy Policy** — mit gyűjtesz, miért, milyen jogalapon, meddig tárolod, kivel osztod meg, milyen user-jogok, hogyan gyakorolhatók.
3. **DPA (Data Processing Agreement)** — GDPR/CCPA megköveteli, ha más nevében dolgozol fel személyes adatot; enterprise ügyfél aláírás előtt elvárja.
4. **IP assignment** — MINDEN contractor-szerződésben kell explicit IP-átruházási klauzula; a contractor munkája nem száll át automatikusan.
5. **GDPR posture:** privacy by design & by default; jogalap minden adatkezeléshez; 72 órás breach-notifikáció; bírság max. EUR 20M vagy a globális árbevétel 4%-a. Térképezd: milyen PII, hol, miért.
6. **US state laws:** CCPA/CPRA + 2025-ös új állami törvények szaporodnak -> a user TÉNYLEGES piacait nézd, ne feltételezz.

## Kimenet
1. Milyen dokumentum/ügy ez, mely jogszabályok érintettek.
2. Draft vagy red-line, sima nyelven, kockázatos klauzulák megjelölve.
3. Nyitott kérdések, amik humán ügyvédet vagy üzleti döntést igényelnek.

## KÖTELEZŐ lezárási protokoll (csapat-workflow)

**SOHA ne tedd done-ra a saját kártyádat.** A kész állapot kizárólag QA PASS + Cybersec GO után, MikroB zárja.

Helyes sorrend minden jogi feladat végén:
1. Kanban kártya: `waiting` státusz
2. REVIEW komment (`author=jogasz`) az összes érintett kártyán — tartalmazza:
   - Mit tartalmaz a dokumentum (szekciók, fájlútvonal, commit hash)
   - Mely nyelvek/joghatóságok kerültek bele
   - Milyen placeholder maradt ([CLEANCORE_...] stb.)
   - Pending ügyvédi felülvizsgálati pontok
3. Innen QA + Cybersec gate jön — ezek sign-off nélkül nem kerül done-ba semmi

**Buktatók (2025-07-01 eset):** Az 5 child kártyát (`c67d26a9` stb.) REVIEW komment nélkül tettem done-ra. MikroB visszanyitotta. Tanulság: a `done` gomb nem az enyém — még akkor sem, ha a tartalom elkészült és commitolva van.

## Per-joghatóság teljességi checklist (EU SaaS munkavállalói monitoring)

Minden lokalizált ToS + PP + DPA esetén ellenőrizd, hogy az alábbi joghatóság-specifikus klauzulák szerepelnek-e (vagy a tenant felelősségére vannak-e hárítva):

| Joghatóság | Kötelező elem | Hol kell megjelennie |
|---|---|---|
| **HU** | Mt. 11/A.§ munkáltató ellenőrzési jog; Mt. 9.§ tájékoztatás | ToS (tenant felelőssége) + PP |
| **DE** | BDSG §26 munkavállalói adatok; BetrVG §87(1)(6) Betriebsrat | ToS + DPA (AVV) |
| **PL** | Kodeks Pracy art. 22(2)-(3) 2-hetes értesítési kötelezettség | ToS + DPA (UPPD) |
| **IT** | Statuto Lav. Art. 4 INL-engedély vagy kollektív szerz. | ToS + DPA (kiemelten!) |
| **FR** | Code du Travail L.1121-1 arányosság; CSE art. L.2312-38 | ToS + DPA |
| **ES** | ET art. 20 bis + LOPDGDD előzetes értesítés | ToS + DPA |
| **Minden piac** | Sub-processor lista (Art. 28(2)); SCCs ha non-EEA; 72h breach | DPA Annex II + PP |

Ha bármelyik hiányzik: `[ÜGYVÉDI FELÜLVIZSGÁLAT: ...]` jelölőt kell elhelyezni a dokumentumban — ne hagyd jelöletlenül.

## EU AI Act readiness (AI-termékekre kötelező, 2025-től)

Az EU AI Act (2024/1689/EU) 2026-ban lép teljesen hatályba, de a tiltott AI-rendszerek és az általános célú AI (GPAI) szabályai már 2025-ben alkalmazandók. AI-terméket építő SaaS-nak most kell felkészülni.

### Kockázati kategóriák

| Kategória | Mi tartozik ide | Következmény |
|---|---|---|
| **Tiltott (Art. 5)** | Szociális pontozás, tudatalatti manipuláció, valós idejű biometrikus tömeges megfigyelés nyilvános helyen | Teljes tilalom — ne építs ilyet |
| **High-risk (Annex III)** | Munkaerő-menedzsment és -felügyelet (munkavállalók értékelése, elbocsátás-döntés, feladatkiosztás AI-alapon); kritikus infrastruktúra; oktatás; biometrikus azonosítás | Kötelező: conformity assessment, technikai dokumentáció, emberi felügyelet, kockázatkezelési rendszer, adatirányítás |
| **Korlátozott kockázat (Art. 50)** | Chatbot, deepfake, AI-generált tartalom | Átláthatósági kötelezettség: felhasználót tájékoztatni kell, hogy AI-val kommunikál |
| **Minimális kockázat** | Spam-szűrő, ajánlórendszer (nem high-risk kontextusban) | Nincs kötelező követelmény, de Code of Practice ajánlott |

### CleanCore-specifikus minősítés

A CleanCore munkavállalói jelenléti és monitoring funkciói (check-in/out, munkafotók, geofence) **potenciálisan high-risk** kategóriába eshetnek, ha:
- AI-alapú döntést hoz munkavállalói teljesítményről vagy feladatkiosztásról (Annex III, 4. pont)
- Biometrikus adatot dolgoz fel azonosítás céljából

Jelenlegi tervezés (rule-based geofence, nem AI-döntés) valószínűleg **NEM high-risk** — de dokumentálni kell ezt a pozíciót.

### Kötelező lépések high-risk AI esetén (Art. 9-15)

1. **Kockázatkezelési rendszer** (Art. 9) — dokumentált, folyamatos, a teljes életciklusra
2. **Adatirányítás** (Art. 10) — tréning/validációs adatok minősége, bias-értékelés
3. **Technikai dokumentáció** (Art. 11 + Annex IV) — architektúra, képességek, korlátok, teljesítőképesség
4. **Automatikus naplózás** (Art. 12) — az AI-rendszer döntéseinek auditálható naplója
5. **Átláthatóság a felhasználók felé** (Art. 13) — a természetes személy felhasználónak tudnia kell, hogy AI-rendszerrel kerül kapcsolatba
6. **Emberi felügyelet** (Art. 14) — a döntések felülbírálhatók, leállítható a rendszer
7. **Pontosság, robusztusság, kiberbiztonság** (Art. 15)
8. **Conformity assessment** (Art. 43) — önértékelés vagy harmadik fél (high-risk esetén)
9. **EU adatbázis-regisztráció** (Art. 49) — high-risk AI kötelezően regisztrálandó az EU AISA adatbázisban
10. **Szállítói lánc** — ha alapmodellt (pl. Claude API) használsz, az alapmodell-szolgáltató (Anthropic) GPAI-kötelezettségei + a te deployer-kötelezettségeid szétválasztandók

### Átláthatósági kötelezettség AI-generált tartalomhoz (Art. 50)

Ha a platform AI-generált szöveget, képet vagy ajánlást jelenít meg felhasználóknak:
- Jelölni kell, hogy az tartalom AI-generált
- Chatbot esetén: az első interakciónál közölni kell, hogy az érintett AI-val kommunikál
- Deepfake-re teljes tilalom (hacsak nem egyértelműen szatirikus/művészeti)

### Dokumentum-követelmények AI Act esetén

Az alábbi dokumentumokat kell elkészíteni/frissíteni:
- **ToS** — AI-rendszer alkalmazásának tájékoztatása; human oversight mechanizmus leírása
- **Privacy Policy** — ha AI személyes adatot dolgoz fel döntéshez, külön szakasz szükséges
- **AI System Card** (belső) — technikai leírás, kockázat-értékelés, tesztelési eredmények
- **Conformity Declaration** (ha high-risk) — az Art. 47 szerinti nyilatkozat

---

## Mélyebb GDPR audit-checklist (ToS/DPA scope-on túl)

A standard ToS/PP/DPA mellett az alábbi GDPR-kötelezettségek rendszeresen kimaradnak:

### Nyilvántartás és belső dokumentáció (Art. 30)

| Elem | Tartalom | Státusz-kérdés |
|---|---|---|
| RoPA (Records of Processing Activities) | Minden adatkezelési tevékenység: cél, jogalap, adatkategóriák, megőrzési idő, sub-processorok, transzfer | Van-e naprakész RoPA? Ki tartja karban? |
| LIA (Legitimate Interest Assessment) | Dokumentált érdekmérlegelési teszt minden Art. 6(1)(f) jogalapon alapuló kezeléshez | Megvan-e a geofence/monitoring LIA-ja? |
| DPIA (Art. 35) | Nagy kockázatú kezelésnél kötelező — munkavállalói monitoring ide tartozik | Elvégeztük-e? Ügyvéd látta-e? |

### Adatalany-jogok operatív megvalósítása (Art. 15-22)

- **Hozzáférési kérelem (SAR):** van-e 30 napon belüli válaszadási folyamat + felelős személy?
- **Törlési kérelem:** a per-tenant `DROP DATABASE` tényleg töröl minden adatot (backup is!)?
- **Adathordozhatóság:** géppel olvasható export (JSON/CSV) tényleg működik a termékben?
- **Tiltakozás jogos érdek ellen:** van-e mechanizmus az érintett tiltakozásának kezelésére?

### Breach management (Art. 33-34)

- **72 órás hatósági bejelentés:** ki a felelős? Van-e sablon? Tudja-e mindenki?
- **Breach register:** minden incidensről írásos nyilvántartás (akkor is, ha nem kell bejelenteni)
- **Érintetti értesítési küszöb:** "magas kockázat" meghatározva és dokumentálva?

### Gyermekek adatai (Art. 8, GDPR + nemzeti jog)

- Ha a platform elérhető 16 éven aluliaknak: szülői hozzájárulás szükséges
- CleanCore: platform B2B, brigádtagok felnőttek — de dokumentálni kell ezt a pozíciót

### Cookie és tracking (ePrivacy / TTDSG / Loi Informatique et Libertés)

- **Consent Management Platform (CMP):** szükséges-e? (Ha van analytics, remarketing, vagy harmadik féltől origin JS)
- **Cookie audit:** minden süti és tracking pixel listázva, jogalapja meghatározva
- **Nem-EU felhasználók:** CCPA/CPRA ha USA-s látogatók is vannak

### Adatvédelmi tisztviselő (DPO, Art. 37)

DPO kötelező ha: (a) közhatóság; (b) nagy léptékű, rendszeres és szisztematikus monitoring of individuals; (c) nagy léptékű különleges adatkategória kezelés. A munkavállalói monitoring SaaS-nál a (b) pont vizsgálandó — ha a tenantok összesített brigádjainak száma eléri a "nagy léptékűt", DPO-kinevezés szükségessé válhat.

### Transfer Impact Assessment (TIA, Schrems II kötelezettség)

SCCs-sel fedett non-EEA transzfernél (Stripe, Cloudflare) nem elég az SCC — TIA is szükséges:
- Az adott ország jogszabályai ténylegesen lehetővé teszik-e a harmadik félnek az adathoz való hozzáférést?
- Ha igen: milyen kiegészítő intézkedések szükségesek (titkosítás, minimalizálás)?
- TIA dokumentum = az SCC melléklete

---

## Buktatók
- Ne állíts jogi bizonyosságot bizonytalan ügyben. Jelöld a joghatóság-függő részeket.
- DPA hiánya enterprise dealt blokkolhat -> korán hozd elő.
- Contractor IP-klauzula kihagyása = a cég nem birtokolja a saját kódját/designját.
- **SOHA ne tedd done-ra a saját munkádat** — lásd Lezárási protokoll fent.
- IT piac a legkockázatosabb (Garante bírságok 2024-25, Statuto dei Lavoratori Art. 4).
- **AI Act:** rule-based rendszer ≠ AI-rendszer automatikusan — de dokumentálni kell, miért nem az.
- **TIA hiánya:** SCCs önmagában nem elég Schrems II után; TIA nélkül az EU transzfer sebezhető audit esetén.

## Ellenőrzés
- A disclaimer szerepel.
- Minden gyűjtött adat-típushoz van jogalap és cél.
- A kockázatos klauzulák explicit meg vannak jelölve.
- Per-joghatóság checklist lefuttatva (lásd fent).
- AI Act kockázati kategória meghatározva (high-risk / korlátozott / minimális).
- RoPA, LIA, DPIA státusza ismert.
- TIA megvan az összes non-EEA sub-processorhoz.
- REVIEW komment megírva a kártyán, státusz `waiting`.

## Források
- https://toslawyer.com/legal-checklist-for-u-s-saas-startups-tos-privacy-dpa-sla-and-more/
- https://promise.legal/startup-legal-guide/contracts/saas-agreements
- https://complydog.com/blog/gdpr-compliance-checklist-complete-guide-b2b-saas-companies
- https://sprinto.com/blog/gdpr-for-saas/

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
   - Milyen placeholder maradt ([PRODUCT_...] stb.)
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

### Platform-specifikus minősítés

A platform munkavállalói jelenléti és monitoring funkciói (check-in/out, munkafotók, geofence) **potenciálisan high-risk** kategóriába eshetnek, ha:
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
- A platform B2B, brigádtagok felnőttek — de dokumentálni kell ezt a pozíciót

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

## Magyar jogi specifikumok (HU)

### Polgári jog (Ptk. — 2013. évi V. törvény)

SaaS-szerződések jogi besorolása Ptk. alapján:
- **Megbízási szerz. (Ptk. 6:272.§):** ha az eredmény nem garantált, csak a gondos eljárás (tipikusan SaaS / platform-hozzáférés)
- **Vállalkozási szerz. (Ptk. 6:238.§):** ha meghatározott eredményt kell leszállítani (pl. custom fejlesztés)
- SaaS-nál vegyes innominat szerződés; a megbízási szabályok vonatkoznak analógiával

Kártérítési felelősség (Ptk. 6:522.§):
- B2B-ben a Ptk. alapján korlátozható a közvetett/elmaradt haszon miatti felelősség
- Szándékos károkozásra és élethez/testi épséghez kapcsolódó kárra NEM korlátozható
- Max. 12 havi díjra való korlátozás (ToS) a Ptk.-val összhangban, de explicit kell

Elévülés (Ptk. 6:22.§): általános 5 év; a ToS ne rövidítse (érvénytelen lehetne).

### Számlázás és NAV (Magyarország)

**Online Számla rendszer (NAV):**
- 2018. VII. 1. óta kötelező minden belföldi B2B számla valós idejű bejelentése ha ÁFA-tartalom > 500.000 Ft (2021. IV. 1. óta 0 Ft-tól minden számla)
- API-verzió: 3.0 (XSD-alapú XML séma, REST API)
- A platform mint számlázó szoftver: ha generál számlát, NAV Online Számla API-integrációt kell biztosítani
- Forrás: https://onlineszamla.nav.gov.hu

**ÁFA törvény (2007. évi CXXVII. törvény):**
- SaaS-szolgáltatás „elektronikusan nyújtott szolgáltatás" (B2B, fordított adózás EU-n belül)
- B2C EU-s vevőnek: OSS (One Stop Shop) rendszer; teljesítés helye a vevő országa
- Tárolt szoftver vs. letöltött szoftver ÁFA-kezelése eltér

**Elektronikus számla (e-számla):**
- Magyar jogban az e-számla hiteles elektronikus aláírással vagy EDI-csereprotokollal érvényes (ÁFA tv. 175-176.§)
- PDF önmagában csak akkor fogadott el, ha mindkét fél beleegyezik és sértetlensége biztosított

**Számviteli törvény (2000. évi C. tv.):**
- Bizonylatok megőrzése: minimum 8 év (szept. törvény, ÁFA-alap bizonylatok)
- SaaS-ügyfélnek fontos: a platformban tárolt/exportált pénzügyi adatok legalább 8 évig hozzáférhetők legyenek vagy exportálhatók

### Munkajogi vonatkozások (Mt. — 2012. évi I. törvény)

- **Mt. 11/A.§:** munkáltató ellenőrzési joga; előzetesen tájékoztatni kell a munkavállalókat
- **Mt. 9.§:** munkavállalók személyiségi jogai — csak arányos ellenőrzés engedélyezett
- **Mt. 293.§:** titoktartási kötelezettség (munkáltató és munkavállalói adatok)
- Geofence check-in: az Mt. 11/A.§ alapján a munkáltató jogszerűen alkalmazhatja, de a munkaszerződésben / belső szabályzatban rögzíteni kell, és a Mt. 9.§ arányossági teszt elvégezhető
- Belső szabályzat (munkáltatói utasítás): a munkáltató egyoldalúan vezetheti be (nincs HU-ban BetrVG-jellegű kötelező együttdöntési jog általánosan)

**NAIH (Nemzeti Adatvédelmi és Információszabadság Hatóság):** https://www.naih.hu

---

## Svájci jogi specifikumok (CH)

> **Fontos:** Svájc NEM EU-tagállam. A GDPR közvetlenül nem alkalmazandó — de ha svájci cég EU-s személyek adatát kezeli, a GDPR területen kívüli hatálya (Art. 3(2)) alkalmazhat. Belső svájci jog: nDSG.

### nDSG (Új Szövetségi Adatvédelmi Törvény)

**Hatályba lépett: 2023. szeptember 1.** — felváltotta a régi DSG-t.

Főbb különbségek GDPR-tól:
- **Nincs kötelező DPO** (adatvédelmi tisztviselő) — de Privacy Advisor kinevezése ajánlott (Art. 10 nDSG)
- **Nincs art. 28-típusú kötelező adatfeldolgozási szerz.** — de processing agreements elterjedtek és ajánlottak
- **Profiling és magas kockázatú profiling** (Art. 5 nDSG): ha automata egyéni döntés + különleges adatkategória = emberi felügyelet kötelező
- **Breach notification (Art. 24 nDSG):** kötelező az FDPIC értesítése „magas kockázat" esetén (48h belül); érintetti értesítés is
- **Adatalany jogok (Art. 23 nDSG):** Auskunftsrecht (hozzáférési jog), helyesbítés, törlés, adathordozhatóság
- **Jogalap (Art. 6 nDSG):** jóhiszeműség, arányosság, célhoz kötöttség — de nincs GDPR-azonos jogalap-lista (hozzájárulás + jogos érdek + szerződés elfogadott)
- **Bírságok:** max. CHF 250.000 (személyes felelősség, NEM szervezet!)
- **FDPIC (Eidgenössischer Datenschutz- und Öffentlichkeitsbeauftragter):** https://www.edoeb.admin.ch

Svájci PP/DPA sablon eltérő pontjai a GDPR-ostól:
- Hivatkozz nDSG-re, ne GDPR-ra (de megjelenítheted párhuzamosan ha EU-s adatokat is kezelsz)
- Breach notification: Art. 24 nDSG (nem Art. 33 GDPR)
- Felügyeleti hatóság: FDPIC (nem NAIH/BfDI/CNIL stb.)
- Adatalany jogok gyakorlása: Art. 23-26 nDSG

### OR (Obligationenrecht — Svájci Kötelmi Jog)

SaaS-szerz. besorolása OR szerint:
- **Auftrag (OR Art. 394ff):** megbízási típusú szerz. — ha gondos eljárás, nem eredmény; egy ilyen SaaS tipikusan ide esik
- **Werkvertrag (OR Art. 363ff):** ha meghatározott eredményt vállalsz (custom fejlesztés)
- **Innominatvertrag (nem nevesített):** vegyes SaaS mix, Auftrag analógiával
- **Mietvertrag (OR Art. 253ff):** szoftver hozzáférés mint „bérlet" — ritkán, de jogvitákban felmerülhet

Felelősség-korlátozás (OR Art. 100):
- Szándékos és súlyos gondatlanság kizárása TILOS (OR Art. 100 Abs. 1)
- Könnyű gondatlanság és közvetett kár korlátozható
- AGB (Általános Szerz. Feltételek) bevonása: OR Art. 1 — a másik félnek ismernie kell és elfogadnia; meglepő feltételek nem kötnek (Ungewöhnlichkeitsregel)

Fizetési késedelem (OR Art. 102):
- Svájcban kamat: 5% p.a. (OR Art. 104)
- B2B-ben megállapodhatnak magasabb kamatlábban

**Munkaszerz. (OR Art. 319ff) — munkavállalói monitoring:**
- OR Art. 328 (személyiségi jog védelme): munkáltató köteles tartózkodni a munkavállalók személyiségi jogainak megsértésétől
- ArGV3 (Verordnung 3 zum Arbeitsgesetz) Art. 26: TILOS olyan surveillance, aminek elsődleges célja a munkavállalók viselkedésének ellenőrzése
- Geofence check-in mint munkaidő-nyilvántartás: jogszerű, ha a cél dokumentált (biztonság, jelenlétkövető), nem elsősorban viselkedésellenőrzés

### QR-Rechnung (Svájci QR-Számla)

**Kötelező 2022. október 1. óta** — a korábbi BVR (befizetési szelvény) helyett.

Szabvány: SPS (Swiss Payments Standard), ISO 20022 alapú.

Kötelező elemek a QR-számlán:
- **QR-IBAN** (nem normál IBAN) — a bank adja ki
- Swiss QR-kód (pontosan meghatározott struktúra: számlatulajdonos, fizetési összeg, referencia szám, opcionális adatok)
- Szövegmezők max. karakterszáma kötött (pl. kedvezményezett neve ≤ 70 karakter)

A platform számára releváns ha:
- CH-s tenantoknak állít ki számlát: a számlán QR-IBAN + QR-kód szükséges
- Stripe Svájcba: a CH-s tenantok várhatják a svájci formátumú számlát
- Ha a platform számlat generál tenantoknak: opcionálisan beépíthető QR-Rechnung generátor (pl. swiss-qr-bill npm csomag)

Forrás: https://www.paymentstandards.ch / SIX Group

### e-Faktura (CH)

- Szövetségi közbeszerzés: e-számla kötelező (eCH-0108 szabvány, XML/UBL)
- Magánszektor B2B: NEM kötelező, de terjedőben (eBill platform, PostFinance)
- eBill: SIX Group + SwissSign, befogadó bank jóváhagyással; a platformhoz nem szükséges most

---

## EU-szintű szabályozók (SaaS-ra vonatkozó friss rendeletek)

### DSA — Digital Services Act (EU 2022/2065)

**Hatályos 2024. február 17. óta minden platformra.**

Kivel szemben alkalmazandó:
- **Hosting service** (Art. 2(f)(iii)): szerver-tároló, felhő, SaaS infrastruktúra — ha harmadik felek tartalmát tárolod
- A platform: valószínűleg hosting service (tenant adatokat tárol)
- **VLOP/VLOSE** (Very Large Online Platform/Search Engine, 45M+ EU-s felhasználó): NEM a platform

A platformra vonatkozó kötelezettségek (intermediary/hosting level):
- **Notice and action (Art. 16):** ha illegális tartalomra értesítést kapsz, reagálni kell (de B2B SaaS-ban szinte soha nem merül fel)
- **Transparency report (Art. 15):** ha 45M+ EU-s felhasználó — NEM vonatkozik a platformra
- **Terms of Service (Art. 14):** a ToS-ban le kell írni a tartalomra vonatkozó korlátozásokat és a szabálysértések kezelési mechanizmusát
- **No dark patterns (Art. 25):** az UX nem vezetheti félre a felhasználókat (engedélykezelés, opt-out nehézítése stb.)

Megjegyzés: B2B SaaS esetén a DSA kötelezettségek java nem alkalmazandó (a tenantok nem „végfelhasználók" DSA értelemben) — de az alapelveket érdemes követni.

### E-számlázás (EU-szintű + országonként)

**EU keretszabály: Directive 2014/55/EU** — közbeszerzési e-számla (EN 16931 szabvány, UBL/CII formátumok)

B2B kötelező e-számlázás ország szerint (a platform tenantjai szempontjából):

| Ország | Státusz | Részletek |
|---|---|---|
| **IT** | **Kötelező** (2019 óta) | FatturaPA XML, SDI átjárón keresztül; B2C is 2024-től; nincs kivétel |
| **DE** | **Kötelező** (2025-2027 ütemezés) | Wachstumschancengesetz: befogadási kötel. 2025. I. 1.; kiállítási kötel. 2026-2027; XRechnung / ZUGFeRD |
| **FR** | **Kötelező** (2026-2027) | Portail Public de la Facturation (PPF); sept. 2026-tól nagy vállalkozásoknak; e-reporting kötelezettség |
| **PL** | **Kötelező** (KSeF, 2025 után) | KSeF (Krajowy System e-Faktur) — kötelező bevezetés halasztva, várható 2025/2026 |
| **HU** | **NAV Online Számla** | Nem klasszikus e-számla, hanem valós idejű riportálás; e-számla opcionálisan fogadható |
| **ES** | **Kötelező** (Ley Crea y Crece, 2025+) | TicketBAI + Verifactu rendszerek; kis vállalatoknál 2025-2026 |
| **CH** | Nem kötelező (magánszektor) | Közbeszerzésben igen (eCH-0108); magánszektor: eBill önkéntes |

Platform-teendők:
- Ha a platform számlát generál tenantok nevében VAGY a tenantok a platformból exportálják a számláikat, az adott ország formátumát le kell fedni
- IT FatturaPA: prioritás (már most kötelező)
- DE XRechnung / ZUGFeRD: 2025-re előkészíteni
- FR PPF: 2026 előtt implementálni

### NIS2 Irányelv (EU 2022/2555)

**Hatályos 2024. október 18. óta** (tagállami implementáció eltérhet).

Alkalmazandó ha a platform:
- „Managed service provider" (MSP) / „managed security service provider" — ha IT-szolgáltatást nyújtasz tenantoknak üzemeltetési felelősséggel
- Tenantok kritikus szektorban működnek (kórháztakarítás, infrastruktúra)

Ha alkalmazandó:
- Kockázatkezelési intézkedések (Art. 21): titkosítás, hozzáférés-vezérlés, incidenskezelés
- Incidensbejelentés: 24h (early warning) + 72h (notification) + 1 hónap (final report) az illetékes hatóságnak
- Ellátási lánc biztonság: a te sub-processoraidat is auditálni kell (Art. 21(2)(d))

A platform valószínű besorolása: ha nem kritikus szektort szolgálsz ki kizárólag, a NIS2 közvetlen kötelezettség nem áll fenn — de a tenantok NIS2-alanyok lehetnek, és a DPA-ban elvárhatják a NIS2-kompatibilis TOMs-ot.

### DMA — Digital Markets Act (EU 2022/1925)

Nem alkalmazandó a platformra: csak „kapuőr" státuszú nagy platformokra (Google, Apple, Meta stb.). Dokumentálni sem szükséges.

---

## Buktatók
- Ne állíts jogi bizonyosságot bizonytalan ügyben. Jelöld a joghatóság-függő részeket.
- DPA hiánya enterprise dealt blokkolhat -> korán hozd elő.
- Contractor IP-klauzula kihagyása = a cég nem birtokolja a saját kódját/designját.
- **SOHA ne tedd done-ra a saját munkádat** — lásd Lezárási protokoll fent.
- IT piac a legkockázatosabb (Garante bírságok 2024-25, Statuto dei Lavoratori Art. 4).
- **AI Act:** rule-based rendszer ≠ AI-rendszer automatikusan — de dokumentálni kell, miért nem az.
- **TIA hiánya:** SCCs önmagában nem elég Schrems II után; TIA nélkül az EU transzfer sebezhető audit esetén.
- **HU NAV:** ha a platform számlát generál, NAV Online Számla API-integráció kötelező (v3.0 XSD).
- **CH nDSG:** bírság személyes felelősség (CHF 250k) — a GDPR szervezeti felelősségétől eltérő logika.
- **CH ArGV3 Art. 26:** geofence/monitoring CH-s tenantnak is OK ha dokumentált cél (jelenlétkövető), de „viselkedésellenőrzés" céljával tilos.
- **IT FatturaPA:** a platformból exportált adatokból a CH tenantok joggal várják a QR-IBAN-os számlát, az IT tenantok a FatturaPA XML-t.
- **DE 2025:** XRechnung/ZUGFeRD befogadási kötelezettség már 2025. I. 1-től; kiállítási kötelezettség jön — ne hagyd figyelmen kívül a DE tenantok export-igényét.

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

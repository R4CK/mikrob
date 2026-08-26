---
name: full-audit-checklist
description: >
  KÖTELEZŐ checklist teljes értékű audithoz. Trigger: "teljes értékű audit",
  "teljes audit", "auditáld végig", "full audit", vagy release/nagyobb
  mérföldkő előtti végigellenőrzés. Az audit CSAK akkor teljes értékű, ha az
  itt felsorolt MINDEN pont lefutott, dokumentálva, bizonyítékkal.
---

# Teljes értékű audit -- SZABÁLY (KÖTELEZŐ)

Részleges lefedettség = NEM teljes értékű audit; ilyet ne jelents késznek.

Alapelv: **semmi nem implicit**. Ami nincs a leltárban és nincs tesztelve, azt "töröttnek" tekintjük amíg az ellenkezője bizonyítva nincs. Minden állítás mögé forrás/bizonyíték kell (repro lépés, teszt-kimenet, screenshot, log). A puszta zöld teszt önmagában NEM bizonyíték (lásd a magic-link 151/151-zöld esetet, ami 2 MAJOR hibát rejtett).

### 1. Teljes funkció-leltár (frontend + backend)
- Térképezd fel és listázd KI MINDEN frontend elemet: minden oldal/route, komponens, **minden gomb**, link, űrlap, mező, menüpont, modal, drawer, toast, táblázat-akció, állapot (loading/empty/error/success). Minden gomb és minden funkció legyen a listán, azonosítóval.
- Térképezd fel és listázd KI MINDEN backend funkciót: minden modul, service, handler, use-case, háttérfeladat/cron, queue-fogyasztó, webhook.
- A leltár a lefedettség alapja: minden tétel mellé kerül a teszt-eredménye. Néma kihagyás TILOS -- ha valamit nem teszteltél, azt külön listázd "NEM tesztelt / miért".

### 2. Felhasználói folyamatok MINDEN RBAC szinten
- Sorold fel az ÖSSZES szerepkört/jogosultsági szintet (pl. anon, user, manager, admin, superadmin -- a tényleges enum alapján, nem fejből).
- Minden folyamathoz (end-to-end user journey) készíts **authz-mátrixot**: melyik szerep MIT tehet. Teszteld MINDKÉT irányt:
  - **Pozitív:** a jogosult szerep végig tudja csinálni a folyamatot (minden lépés, minden gomb).
  - **Negatív (fail-closed):** a NEM jogosult szerep BLOKKOLVA van -- UI-ban rejtve/tiltva ÉS a szerver is elutasítja (nem elég a UI-elrejtés; próbáld meg közvetlenül az API-t is). Vertikális és horizontális jogosultság-emelés (más tenant/más user adata) TILTOTT.

### 3. Superadmin folyamatok
- Azonosítsd és teszteld VÉGIG a superadmin/emelt-jogú folyamatokat: bejelentkezés (MFA/TOTP), tenant-kezelés, impersonáció, feature-flag/konfig, audit-napló, veszélyes műveletek (törlés, adat-export).
- Ellenőrizd: minden emelt művelet auditált (tamper-eviden), fail-closed, és nincs prod-ban DEV-only bypass. Az impersonáció ne szivárogtasson tenant-határon át.

### 4. Minden API tesztelve
- MINDEN végpontra: happy-path; input-validáció (hiányzó/rossz típus/határérték/injection); authz (2. pont); hibakezelés és helyes státuszkódok; idempotencia; rate-limit; pagináció; verziózás. Ellenőrizd a tenant-scope invariánst minden lekérdezésen (soha ne bízz a body tenantId-ban).

### 5. Adatbázis-műveletek tesztelve
- CRUD minden entitásra; constraint-ek és FK-k; tranzakció-atomicitás és rollback; egyediség/versenyhelyzet; migrációk fel/le és idempotencia; tenant-izoláció; indexek megléte a forró lekérdezéseken; származtatott értékek szerver-oldali újraszámítása (ne bízz a kliens által küldött összegben/hash-ben).

### 6. Optimalizálás (teljesítmény + skálázhatóság)
- Mérd és javítsd: lassú/N+1 lekérdezések, hiányzó indexek, felesleges re-render, túl nagy payload/bundle, cache-hiány, memóriaszivárgás, O(n^2) forrópontok (capeld). Adj előtte/utána számot (nem "gyorsabbnak tűnik").

### 7. Kiegészítő, hogy TELJES ÉRTÉKŰ legyen
- **Biztonság:** STRIDE + OWASP Top 10/ASVS végigvezetve (a Cybersec gate), nem csak a happy-path.
- **Adatintegritás / multi-tenant izoláció:** a tenant-scope invariáns bizonyítottan tartja magát (negatív kontroll).
- **Frontend edge-esetek:** loading/empty/error/offline/hosszú szöveg/kis képernyő állapotok.
- **Akadálymentesség (WCAG AA):** billentyű-navigáció, fókusz-csapda, kontraszt, aria.
- **i18n/l10n:** minden user-facing string kulcsból jön, nincs hardcode. **Teljes paritás MINDEN konfigurált nyelvre** (a projekt `SUPPORTED_LOCALES` listája, nem csak HU+EN): minden nyelvi fájlnak az összes kulcsot tartalmaznia kell, MINDEN namespace-ben. Az i18n-t **folyamatosan, minden fejlesztéssel együtt kell generálni** (Peti szabály 2026-07-12): új user-facing string ugyanabban a munkában bekerül mindegyik nyelvre. A paritás-guard/teszt az EN VALÓS top-level namespace-eiből származtasson (ne hardcode-olt namespace-allowlist), különben egy új namespace vakfoltként átcsúszik (lásd a `vertical.*` esetet: 5 nyelvből 20-20 kulcs hiányzott, mert a teszt allowlistje nem tartalmazta). A teljes nyelvi paritás a definition-of-done és a QA gate része.
- **Megfigyelhetőség:** kulcs-műveletek logolva/metrikázva, riasztás a kritikus hibákra, nincs titok a logban.
- **Resziliencia:** külső függőség kiesésének kezelése (timeout, retry, fail-closed), input-cap DoS ellen.
- **Regresszió / teszt-piramis:** unit + integrációs + e2e; a javítások mellé regressziós teszt kerül.
- **Titkok/konfig:** nincs hardcode secret, env-ből jön, prod/dev szétválasztva.
- **Dokumentáció:** a leltár + eredmények + talált hibák + repro reprodukálhatóan leírva (audit-riport).

### 8. Design ↔ flow ↔ funkció kapcsolat + user story-k (KÖTELEZŐ, Peti 2026-07-12)
Az audit CSAK akkor teljes értékű, ha MINDEN megépített funkcióra igazoltan teljesül:
- **Design a kivezetett végponton:** a funkciónak a kivezetett végpontján (UI-route / képernyő / gomb / endpoint felülete) VAN design-eleme -- nincs design nélküli, "csupasz" funkció. Ami funkció létezik, annak van megtervezett és megépített felülete (ha hiányzik a design, generálni kell -- lásd a funkció-vezérelt Stitch-generálást).
- **Design → flow → funkció lánc BE VAN KÖTVE:** a design-elem a valós user-flow-ban él, és a flow a VALÓS funkcióhoz/endpointhoz drótozva (a 9. flow-connectivity szabály szerint). A három (design, flow, funkció) kapcsolata explicit és ellenőrzött -- nincs dekoratív design, nincs be-nem-kötött flow, nincs felület nélküli funkció.
- **Működik + zöld teszt:** a funkció ténylegesen MŰKÖDIK (valós end-to-end, nem csak zöld unit), és a tesztjei SIKERESEK. A puszta zöld teszt önmagában nem elég bizonyíték (lásd a magic-link esetet) -- valós lefuttatás/repro kell.
- **User story-k -- MINIMUM 5 funkciónként:** minden funkcióhoz LEGALÁBB 5 teljesülő user story tartozik (szerep + cél + elfogadási kritérium formában). **Ha egy funkciónak nincs (elég) user story-ja, MEG KELL ÍRNI** a hiányzókat (a valós funkció + RBAC-szintek alapján, nem kitalálva). Minden user story végig-tesztelve: pozitív (jogosult szerep végigviszi) ÉS negatív (jogosulatlan blokkolva, fail-closed). A QA gate ezt is ellenőrzi: funkciónként ≥5 teljesülő, tesztelt user story, mindegyik designnal + flow-bekötéssel + zöld end-to-end teszttel; hiány = audit FAIL.

### Lefutás és sign-off
- Az auditot a megfelelő ügynökök végzik (leltár/optimalizálás: mérnöki + `codebase-auditor`/`performance-optimizer`; funkcionális teszt: `qa-engineer`; támadó teszt: `cybersecurity-redteam`), a saját munkáját senki nem ellenőrzi (a Munkavégzési szabályok 4. pontja).
- Kimenet: **audit-riport** a teljes leltárral és minden tétel PASS/FAIL/NEM-tesztelt státuszával, a talált hibák reprodukálható jegyzékével, és a javítási/optimalizálási kártyákkal a kanbanon. Teljes értékű audit CSAK akkor jelenthető késznek, ha a leltár 100%-a le van fedve (tesztelve vagy explicit indokkal kihagyva), és minden MAJOR/kritikus találatra van kártya.

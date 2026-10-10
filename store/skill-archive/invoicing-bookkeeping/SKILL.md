---
name: invoicing-bookkeeping
description: Operatív könyvelés — kiadás/bevétel/előfizetés követés, AP/AR aging, havi P&L, budget-vs-actual riasztás, HU (NAV Online Számla, ÁFA) és CH (QR-Rechnung) számlázási megfelelőség. Use for bookkeeping, invoice tracking, cash-flow visibility, monthly close. Triggerek: "könyvelés", "invoice tracking", "P&L", "kiadás követés", "budget riasztás", "NAV számla", "ÁFA", "cash flow".
---
# Invoicing & Bookkeeping (operatív pénzügy)

## Mikor használd
Kiadás/bevétel/előfizetés nyomon követésekor, havi zárás/P&L készítésekor, cash-flow láthatóság igényekor, vagy HU/CH számlázási megfelelőségi kérdésnél. A `finance-modeling` skill a stratégiai unit-economics/árazás réteg; ez a napi/havi operatív könyvelési réteg.

## Eljárás

### 1. Tranzakció-kategorizálás
Minden kiadást/bevételt kategorizálj konzisztens taxonómiával:
- **Kiadás:** infra/hosting, SaaS-előfizetés, marketing/ads, contractor/payroll, jogi/könyvelői díj, iroda/eszköz.
- **Bevétel:** MRR (előfizetés), one-time (setup/custom), refund (negatív tétel, ne rejtsd el).
- Előfizetések külön listán: szolgáltató, havi díj, megújulás dátuma, felmondási határidő -- az auto-renewal a leggyakoribb elfelejtett kiadás.

### 2. AP/AR (fizetendő/követelés) aging
| Sáv | Kiadás (AP) teendő | Bevétel (AR) teendő |
|---|---|---|
| 0-30 nap | Normál | Normál |
| 31-60 nap | Ellenőrizd, miért nincs kifizetve | Emlékeztető ügyfélnek |
| 61-90 nap | Eszkaláld | Második emlékeztető + kapcsolatfelvétel |
| 90+ nap | Vezetői döntés (fizessük/vitassuk) | Behajtási kockázat, jelöld a cash-flow riportban |

### 3. Havi P&L struktúra
```
Bevétel (MRR + one-time)
- Közvetlen költség (COGS: hosting, third-party API-díj, payment processing fee)
= Bruttó margin
- Opex (marketing, fejlesztés, admin/jogi/könyvelés, iroda)
= Nettó eredmény (havi burn vagy profit)
```
Havonta zárd, ne csak negyedévente -- 60-90 napos késés a `finance-modeling` NRR-figyelmeztetéssel analóg problémát okoz itt is.

### 4. Budget-vs-actual riasztási küszöb
- Kategóriánként **>15% eltérés** a tervezetthez képest → automatikus jelzés, ok-keresés.
- Előfizetés-duplikáció / nem használt licenc → havonta egyszer nézd át az aktív SaaS-előfizetés listát a tényleges használattal szemben.
- Cash-flow: ha a runway (lásd `finance-modeling`) 6 hónap alá csökken egy hónap alatt, azonnali jelzés, ne várj a következő zárásra.

### 5. HU adó- és számlázási megfelelőség (operatív szint)
- **NAV Online Számla:** minden belföldi B2B számlát valós időben be kell jelenteni (0 Ft ÁFA-tartalomtól is), API v3.0 (XSD/XML, REST). Ha a platform vagy a cég maga állít ki számlát, ellenőrizd az integráció élő állapotát.
- **Bizonylat-megőrzés:** minimum 8 év (Számviteli törvény).
- **E-számla érvényesség:** hiteles elektronikus aláírás vagy EDI kell; önmagában egy PDF csak kétoldalú beleegyezéssel és sértetlenség-biztosítással fogadható el.
- Részletes jogszabályi háttér és ÁFA-specifikumok: lásd `legal-compliance-review` "Magyar jogi specifikumok" szekció -- ne duplikáld, hivatkozz rá.

### 6. CH számlázási megfelelőség (operatív szint)
- **QR-Rechnung kötelező** 2022.10.01 óta (SPS/ISO 20022 szabvány) -- CH-s tenant/partner felé kiállított számlán QR-IBAN + Swiss QR-kód szükséges.
- Részletes jogi háttér: lásd `legal-compliance-review` "Svájci jogi specifikumok" szekció.

### 7. Havi zárás checklist
- [ ] Minden tranzakció kategorizálva.
- [ ] AP/AR aging frissítve, 60+ napos tételek jelölve.
- [ ] P&L generálva, előző hónaphoz és tervhez viszonyítva.
- [ ] Budget-eltérés >15% -- ok azonosítva.
- [ ] Aktív előfizetés-lista frissítve, nem használt licenc jelölve.
- [ ] Runway újraszámolva (lásd `finance-modeling`).

## Kimenet
1. Havi P&L a fenti struktúrában.
2. AP/AR aging táblázat, 60+ napos tételek kiemelve.
3. Budget-vs-actual eltérés-riport, >15% tételek indoklással.
4. Verdikt: egészséges cash-pozíció / figyelmeztető jel / azonnali beavatkozás kell.

## Buktatók
- Előfizetés-duplikáció (két aktív licenc ugyanarra a szolgáltatásra) észrevétlen marad, ha nincs havi review.
- Refund/credit elrejtése a bevétel-sorban torzítja a valós MRR-t -- mindig külön tételként mutasd.
- Negyedéves zárás (nem havi) 2-3 hónapos késést okoz egy cash-flow probléma észlelésében -- ugyanaz a hiba, mint az éves NRR nézése (lásd `finance-modeling`).
- HU/CH számlázási specifikumot ne duplikáld itt jogi mélységben -- hivatkozz a `legal-compliance-review`-ra, ez a skill az operatív checklist.

## Ellenőrzés
- P&L havi bontásban elkészült.
- AP/AR aging és a 60+ napos tételek jelölve vannak.
- Budget-eltérés >15% tételeknél ok van feltárva.
- HU/CH specifikus checklist-pont ellenőrizve, ha releváns tenant/tranzakció érintett.

## GitHub-first döntés (Peti szabály 2026-07-12)
Léteznek kész, nyílt forrású bookkeeping/invoice-organizer Claude-skillek (kiadás/számla kategorizálás, P&L riport, dashboard), de license-/karbantartottság-vizsgálat nélkül code-szintű integrációjuk kockázatos lenne (harmadik féltől futtatott script pénzügyi adaton). Döntés: **adapt** -- a domén-keretrendszert (kategorizálás, aging, P&L struktúra) adaptáltam, konkrét kódot nem vettem át.

## Források
- https://github.com/vpodugu/startup-bookkeeper (conversational bookkeeping: expense/invoice/subscription tracking, P&L, budget alerts)
- https://github.com/ComposioHQ/awesome-claude-skills/blob/master/invoice-organizer/SKILL.md (számla-kategorizálás mintázat)
- https://github.com/openaccountant/skills (44 nyílt pénzügyi skill: P&L, budgeting, tax prep)
- https://onlineszamla.nav.gov.hu (NAV Online Számla hivatalos dokumentáció)
- https://www.paymentstandards.ch (Swiss QR-bill hivatalos szabvány)

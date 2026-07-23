---
name: finance-modeling
description: SaaS unit-economics and cash modeling — CAC, LTV, payback, NRR, burn rate, runway, and pricing. Use for budgeting, pricing decisions, financial forecasts, and fundraising-readiness math (finance agent's core skill).
---
# Finance Modeling (SaaS unit economics)

## Mikor használd
Költségvetés, árazás, unit economics, burn/runway, forecast, fundraising-matek.

## Kulcs-metrikák
- **LTV:CAC** — cél ~**3:1**. <3:1 = nem hatékony akvizíció; >5:1 = lehet, hogy alulinvesztálsz a növekedésbe.
- **CAC payback** — SMB ~12-24 hónap, mid-market/enterprise ~18-36. Hosszabb payback előre-finanszírozza a customer value-t, terheli a cash-t.
- **NRR** — >100% a cél; **havonta** kövesd (60-90 nappal az éves szám előtt jelez bajt).
- **MRR/ARR, gross margin, churn** — a standard SaaS készlet.

## Cash
- **Gross burn** = teljes havi opex. **Net burn** = opex - bevétel (tényleges cash-veszteség).
- **Runway** = cash / net burn. MINDIG tudd, melyik hónapban fogy el.
- Tipikus net burn: seed ~$50-100K/hó; később több, ha a növekedés indokolja.

## Árazás

### Value-metric kiválasztás
A value-metric az, amiből a csomag ára nő, ahogy az ügyfél többet kap. Kritériumok:
- **Korrelál a kapott értékkel** — az ügyfél pontosan annyit fizet, amennyit kap (pl. seatek, API-hívások, rekordok száma).
- **Ügyfél számára is könnyen mérhető** — ha nem tudja ellenőrizni, bizalmi probléma lesz.
- **Egységköltséged nem nő arányosan** — te profitálsz a skálán.
- Rossz value-metric: fix díj, ha az érték nagyon eltér ügyfelenként. Jobb: usage-based vagy seat-based ha az érték arányos.

### Packaging / tiering framework (Jó--Jobb--Legjobb)
Három csomag a standard -- ne csinálj négyet, és ne csinálj egyet.
- **Jó** (belépő): a core use case, fejlesztéshez, kis csapatnak. Átjárót nyit, nem a nagy bevétel forrása.
- **Jobb** (fő célpont): a tipikus vásárló ide kell essen. Ez hordozza az ARR zömét. Értékarányos prémium a belépőhöz képest.
- **Legjobb** (enterprise / power user): többszörös érték (SSO, audit, SLA, dedikált CSM). Éves szerződés, procurement.
Anchoring: a legdrágább csomag látható ára a közepes csomag "jó deal"-nek tűnik mellette.

### Pricing-design alapelvek
- **Értékhez árazz, ne költség-plusz.** "Mennyibe kerül nekem?" irreleváns kérdés; "Mekkora értéket teremt az ügyfélnek?" a helyes alap.
- **Willingness-to-pay (WTP)** mérése: kvalitatív (ügyfélfelmérés, Van Westendorp 4 kérdés) + kvantitatív (conjoint, champion-challenger A/B). Early-stage: 5-10 ügyfélinterjú WTP kérdéssel elég.
- **Van Westendorp 4 kérdés:** (1) Mennyitől "túl drága"? (2) Mennyitől "drága, de még megfontolja"? (3) Mennyitől "olcsó" (megkérdőjelezi a minőséget)? (4) Mennyitől "annyira olcsó, hogy nem venné meg"? Az elfogadható sáv: (3) és (1) között.
- **Emeld az árat korábban, mint azt kényelmes.** Ha az első 10 ügyfélből senki nem mondott nemet az árra, valószínűleg alulárazol.
- Early-stage (<$1M ARR): negyedévente review, ~6 havonta igazítás. Magasabb stádiumban évente árazási audit.

## Eljárás / kimenet
1. A kérdést a releváns metriká(k)ra fordítsd.
2. Modell/számítás EXPLICIT feltételezésekkel (minden assumptiont mondj ki).
3. Verdikt: egészséges / kockázatos / változtatni kell + a konkrét meghúzandó kar.

## Buktatók
- Rejtett feltételezések -> hibás modell. Írj ki mindent.
- Csak éves NRR nézése -> 2-3 hónapot késel a churn-jelzéssel. Havonta.
- Hízelgő modell, ami eltakarja a runway-szakadékot, senkin nem segít. Korán hozd a kényelmetlen számot.

## Ellenőrzés
- Minden feltételezés ki van írva.
- LTV:CAC, payback, burn, runway szerepel, ahol releváns.
- Van egyértelmű verdikt és meghúzandó kar.

## Források
- https://www.fiscallion.io/blog/saas-unit-economics
- https://www.forecastr.co/blog/startup-burn-rate-runway-calculate
- https://www.saasfactor.co/blogs/the-2025-saas-pricing-playbook-how-to-choose-the-right-model
- https://www.re-cap.com/blog/kpi-metric-saas

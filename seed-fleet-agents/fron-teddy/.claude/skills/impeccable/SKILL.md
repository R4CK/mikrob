---
name: impeccable
description: Anti-AI-slop design guard for frontend work. Run the `impeccable` toolkit (pbakaus/impeccable) -- 59 deterministic detector rules + design commands (audit/critique/polish/animate/colorize/typeset) -- to catch and fix the tells of AI-generated UI (Inter everywhere, purple-blue gradients, cards-in-cards, low contrast) BEFORE a frontend card goes to REVIEW. Fron Ted + Fron Teddy base skill. Triggers on "impeccable", "AI slop", "make it not look AI-generated", "design audit", "polish the UI", "design critique", "ne nézzen ki AI-generáltnak", "design ellenőrzés".
---
# Impeccable -- anti-AI-slop design guard

Source: https://github.com/pbakaus/impeccable (Paul Bakaus, Apache-2.0). Model-agnostic design guidance for AI coding agents.

## Mikor használd
Minden Fron Ted / Fron Teddy frontend feladatnál, MIELŐTT a kártya `waiting+REVIEW`-ra megy. A célja: kiszűrni az "AI-slop" jeleket, amit minden azonos SaaS-template-en tanult modell reprodukál (Inter mindenre, purple->blue gradient, kártya kártyában, gyenge kontraszt, jellegtelen layout). Kiegészíti a `frontend-design-research`-öt (az a POZITÍV etalon-kutatás; ez a NEGATÍV anti-pattern szűrő) és a `ui-visual-design-styles`-t.

## Mit ad
- **59 determinisztikus detector szabály** -- API-kulcs NÉLKÜL fut, kódból/CSS-ből fogja meg az anti-patterneket (túlhasznált fontok, purple gradientek, túl mély nesting, kontraszt-hibák). Ez a gyors, olcsó, offline gate.
- **~23 `/impeccable <parancs>`** -- `init` (egyszeri: brand/audience/voice/paletta kontextus begyűjtés), `audit` (technikai: a11y, teljesítmény, reszponzivitás), `critique` (UX review), `polish` (design-system illesztés), `animate` / `colorize` / `typeset` (célzott finomítás).
- **Design-hook integráció** Claude Code-dal: szerkesztés közben felszínre hozza a findingokat.

## Eljárás
1. **Elérhetőség:** projekt-repóban `npx impeccable install` (egyszeri, integrálja a skillt) -> majd `npx impeccable <parancs>`. Ha nincs telepítve és a projekt nem engedi az új dev-dep-et: a detector-szabályokat manuálisan is alkalmazd (lásd checklist lent) -- a lényeg a szűrő, nem a csomag.
2. **Kontextus:** `impeccable init` (vagy kézzel: brand, célközönség, voice, szín-paletta) -- e nélkül a critique általánosít.
3. **Determinisztikus audit ELŐSZÖR:** futtasd a detector szabályokat a változott frontend fájlokon (`audit`). Ez az olcsó gate, API-kulcs nélkül. Minden találatot javíts.
4. **UX critique:** `critique` a nem-determinisztikus, ízlés-szintű review-hoz (hierarchia, ritmus, figyelemvezetés).
5. **Polish:** `polish` a design-system konzisztenciára a REVIEW előtt.
6. **REVIEW kommentbe:** írd be, hogy lefuttattad az impeccable auditot és tiszta (mely parancsok, hány finding, mit javítottál). A QA gate ezt is nézheti (13. reszponzív + design-flow szabály kiegészítése).

## Determinisztikus anti-slop checklist (ha a csomag nem fut, kézzel)
- **Font:** NE `Inter`/`Roboto`/`Arial`/system-font default mindenre. Egyedi, kontextushoz illő tipográfia (a `frontend-design-research`-ből hozott etalon szerint).
- **Szín:** NE purple->blue (`#6d28d9`->`#2563eb` féle) kliséklauzus gradient fehér/sötét háttéren. Kohéziv, brand-hez kötött paletta.
- **Nesting:** NE kártya-kártyában-kártyában. Lapítsd a felület-hierarchiát.
- **Kontraszt:** WCAG AA min (4.5:1 szöveg, 3:1 UI). Mérd, ne szemre.
- **Layout:** ne jellegtelen, kiszámítható rács -- legyen kontextus-specifikus karakter (lásd 3D/bento/aszimmetria a research-ből, teljesítmény-budget alatt).
- **Micro-interakció:** célzott, feedback-adó -- ne dekoratív, ne túlzás.

## Buktatók
- Az impeccable NEM helyettesíti a `frontend-design-research`-öt: az a POZITÍV etalon (mit építs), ez a NEGATÍV szűrő (mit ne). Mindkettő fut egy frontend kártyán.
- A determinisztikus szabályok gyorsak és ingyenesek -- ezeket MINDIG futtasd; az LLM-es critique drágább, azt a magasabb-tétű felületekre.
- Ne told rá nem-frontend feladatra (adapter, migráció, backend) -- Fron Ted/Fron Teddy scope.
- Supply-chain: `npx impeccable` új dev-dep -- a 10. GitHub-first szabály due diligence-e áll (licenc Apache-2.0 OK; verzió/karbantartottság ellenőrzés a telepítés előtt). Titok NEM megy a parancssorba.

## Ellenőrzés
- A változott frontend fájlokon lefutott az `audit` (determinisztikus) + `critique`, findingok javítva.
- A REVIEW komment tartalmazza az impeccable-futás eredményét.
- A UI nem mutatja a checklist egyik anti-patternjét sem.

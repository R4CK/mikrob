---
name: frontend-design-research
description: Research current web design on awwwards.com and dribbble.com and translate it into a modern, production-grade frontend implementation. Use before building any UI where look-and-feel matters (Fron Ted's core skill). Triggers on frontend/UI/design tasks, landing pages, redesigns.
---
# Frontend Design Research (awwwards + dribbble)

## Mikor használd
Bármilyen frontend/UI feladat ELŐTT, ahol a megjelenés számít: landing, dashboard, marketing oldal, komponens-redesign. A cél: ne a fejből emlékezett (elavult) mintát építsd, hanem a most nyerő megoldás modern adaptációját.

## Eljárás
1. **Brief tisztázás:** projekt vibe, célközönség, brand korlátok, meglévő stack és design tokenek.
2. **Kutatás (kötelező):**
   - awwwards.com — Sites of the Day, Honorable Mentions, design-trends oldal (a technikai/kreatív etalon).
   - dribbble.com — keress a témára (`website 2025`, komponens-típus, iparág); Behance a mélyebb case study-khoz.
   - WebSearch/WebFetch: `site:awwwards.com <téma>`, `site:dribbble.com <téma>`.
   - Gyűjts 2-4 konkrét referenciát, linkkel.
3. **Minta-kinyerés (nem pixel-másolás):** layout rendszer, motion, típus-skála, szín, térköz, kiemelt technika. Add meg mit viszel át mindegyikből.
4. **2025-ös trend-checklist (alkalmazd, ahol illik):**
   - Bento-grid / aszimmetrikus kártyarács (de tudd, hogy az "anti-bento" már jön).
   - Célzott mikro-interakciók (feedback, figyelemvezetés) — +~22% engagement, de ne vidd túlzásba.
   - Ízléses 3D hero (a featured oldalak ~28%-án), de teljesítmény-budget alatt (<2s).
   - AI-integrált és nosztalgikus esztétikák az élvonalban.
5. **Implementáció:** a projekt meglévő stackjével és tokenjeivel, legújabb életképes technikákkal. Loading/empty/error/edge state, responsive, accessible (billentyű + képernyőolvasó).
6. **Forrás-átláthatóság:** az eredményben listázd az awwwards/dribbble linkeket + 1 sor mit vettél át.

## Buktatók
- Ne másolj 1:1 — jogi és brand kockázat, és sosem illik tökéletesen. Adaptálj.
- A "legújabb megoldás" szabály CSAK frontend feladatra vonatkozik (Fron Ted scope-ja), másra ne told rá.
- Ne válts UI frameworköt külön kérés nélkül; a trendet a meglévő stacken belül valósítsd meg.
- 3D/animáció teljesítmény-budget nélkül = lassú oldal. Mérd a hero load-időt.

## Ellenőrzés
- Az eredmény tartalmaz 2-4 valós referencialinket awwwards/dribbble-ről.
- A UI minden state-et kezel és accessible.
- A megoldás a projekt stackjén fut, nem egy idegen frameworkön.

## Források
- https://www.awwwards.com/ , https://www.awwwards.com/sites/design-trends
- https://dribbble.com/search/website-2025 , https://dribbble.com/awwwards/tags/web_design_trends
- https://7kc.me/blog/web-design-trends-2025
- https://spotlightmediafargo.com/web-design-trends-best-examples-2025/

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
- **i18n-hardcode (VISSZATÉRŐ QA-FAIL, 2026-07-10-ig 4x buktatott):** MINDEN user-facing szöveget ÉS minden locale-függő formátumot i18n-locale-ból végy, SOHA ne hardcode-olj. Konkrét csapdák (mindegyik külön buktatott): (1) inline stringek státusz-chipekben/badge-ekben/label-eken (pl. `'Tárolt'`, `'Elszámolva'`) — helyette `t()` kulcs mind a locale-ban; (2) `toLocaleDateString('hu-HU', ...)` dátum-formátum; (3) `toLocaleString('hu-HU')` / `.toLocaleString('hu-HU')` szám-formátum (ezres-elválasztó!); (4) hardcode pénznem/`Intl.NumberFormat('hu-HU')`. Helyette MINDEN `toLocale*` / `Intl.*` hívásnak add át az aktuális `i18n.language`-et (vagy `undefined` = böngésző-locale), sose `'hu-HU'`/`'hu'` literált.
  - **KÖTELEZŐ pre-ship gate (ne bízz a szemedben, a HU-nézet MINDIG jól néz ki):** mielőtt `waiting+REVIEW`-ra tolod, futtasd a változott fájlokon: `grep -rnE "to(LocaleDateString|LocaleTimeString|LocaleString)|Intl\.(NumberFormat|DateTimeFormat)|'hu-HU'|\"hu-HU\"|'hu'" <fájlok>`. Ha BÁRMELYIK találat locale-t hardcode-ol → javítsd ELŐBB. A REVIEW kommentbe írd bele, hogy lefuttattad és tiszta. A nem-HU user töröttet lát, ezért ez mindig blokkoló bug.
  - **KÖTELEZŐ i18n key létezés gate (2026-07-16 után, common.forbidden típusú QA-FAIL elkerülésére):** MINDEN REVIEW komment előtt ellenőrizd, hogy minden `t('kulcs')` call mögött TÉNYLEG létezik a key a locale JSON-okban. Trükk: `grep -oP "t\\(['\"]([^'\"]+)['\"]\\)" <PageFile>.tsx | grep -oP "['\"][^'\"]+['\"]" | tr -d "'\"" | sort -u` -- a kapott key-eket egyenként ellenőrizd `grep -q '"<last-part>"' packages/i18n/messages/en.json`-nel. Ha egy key HIÁNYZIK → add hozzá mind a 7 locale-ba ELŐBB.
  - **date-interpolation antipattern (2026-07-17):** Ha egy i18n key `{date}` placeholder-t tartalmaz (pl. `"dueDate": "Due {date}"`), de a komponensben LABEL-ként akarod használni (a tényleges dátumot külön elemben jeleníted meg alatta), NE hívd `t('billing.invoice.dueDate', { date: '' })` -- az üres interpoláció "Due " szöveget ad (trailing space, törött). EHELYETT: hozz létre külön label-only kulcsot `dueDateLabel: "Due date"` (interpoláció nélkül) és azt használd a label-ként. Az eredeti key marad az inline "Due 2026-07-17" esetekre (pl. InvoiceList sorokban).

## Ellenőrzés
- Az eredmény tartalmaz 2-4 valós referencialinket awwwards/dribbble-ről.
- A UI minden state-et kezel és accessible.
- A megoldás a projekt stackjén fut, nem egy idegen frameworkön.

## Források
- https://www.awwwards.com/ , https://www.awwwards.com/sites/design-trends
- https://dribbble.com/search/website-2025 , https://dribbble.com/awwwards/tags/web_design_trends
- https://7kc.me/blog/web-design-trends-2025
- https://spotlightmediafargo.com/web-design-trends-best-examples-2025/

## BINDING: Stitch / design-tool generation (Peti 2026-07-24)
If a task names a **Stitch project** (or a Claude design tool / URL), generate the
design **ONLY in that project/tool** — NEVER a local HTML mockup or hand-authored
stand-in. A local file does not satisfy the deliverable; it's at most a prompt
reference. Stitch method: send the prompt, then simulate a **re-login** to Stitch,
and the generated screen appears in the project (the tool no longer returns the
screenshot inline on submit). If blocked by auth / no session, ESCALATE (don't
fall back to a local mockup). QA verifies the screens exist in the named project.
## Új források (2026-08, Peti bővítés)
A dribbble/awwwards MELLÉ, egyenrangú kutatási forrásként:
- https://21st.dev -- 12k+ közösségi React komponens/template/shadcn theme; AI-ready promptként másolható. Használat: design-minta referencia, kompozíciós konvenciók (shadcn/ui + Tailwind), interakció-trendek, gyors prototípus. NEM 1:1 másolás (jogi/brand kockázat) -- adaptálj.
- https://motionsites.ai/ -- motion/animált landing-galéria (kategorizált: SaaS/Agency/E-commerce/...). Használat: aktuális motion-trend, animált hero/háttér minták, a mögöttes AI-prompt reverse-engineeringje a brief-hez. Teljesítmény-budget alatt (<2s hero).
Anti-slop szűrő: minden frontend kártyán futtasd az `impeccable` skillt (pbakaus/impeccable, 59 determinisztikus detector) a REVIEW előtt -- ez a NEGATÍV szűrő az AI-slop jelekre (Inter mindenre, purple gradient, kártya-kártyában), amit ez a POZITÍV etalon-kutatás nem fog meg.

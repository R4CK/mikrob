---
name: qa-test-strategy
description: Test-pyramid-based QA strategy, regression discipline, and independent sign-off procedure for moving work to DONE. Use when testing/verifying a feature or deciding if work is shippable (QA agent's core skill). Enforces that the author never verifies their own work.
---
# QA Test Strategy & Sign-off

## Mikor használd
Kész (vagy közel kész) munka tesztelésekor és a "shippable?" döntésnél. A flotta szabálya: a feladat KÉSZÍTŐJE soha nem ellenőrizheti a sajátját — DONE-ba csak MikroB vagy a QA ügynök teheti, és csak NEM saját munkát.

## Eljárás
1. **Shift left:** vond be magad korán (követelmény, design), ne csak a végén.
2. **Acceptance criteria:** írd ki a feladat összes elvárását, pipáld egyenként.
3. **Test pyramid:**
   - Unit (legtöbb): egységek izoláltan.
   - Integration (közép): komponensek/szolgáltatások interakciói.
   - E2E (kevés): csak kritikus user flow-k és magas kockázatú utak.
4. **Regresszió:** minden változásnál smoke-test a kritikus utakra; minden megtalált bugra írj automata tesztet, hogy némán ne térhessen vissza. Teljes regresszió release candidate előtt.
5. **Futtasd, ne feltételezd:** a teszteket ténylegesen futtasd le (vagy nézd végig). Zöld pipa, amit nem láttál lefutni, nem bizonyíték.
6. **Verdikt:**
   - PASS -> mozgasd DONE-ba (`/api/kanban/<id>/move` status=done) + eredmény-komment.
   - FAIL -> vissza in_progress-re precíz, reprodukálható bug-jelentéssel (lépések / elvárt / tényleges).

## Buktatók
- SOHA ne hagyd jóvá a saját munkádat. Ha te készítetted, más (MikroB) ellenőrzi.
- "Valószínűleg működik" nem verdikt. Reprodukálj vagy futtass.
- E2E-t ne szórj szét mindenre — drága és törékeny; csak kritikus flow.
- Bug találtál, de nincs rá teszt? A javítás nem kész, amíg nincs regressziós teszt.

### Stale-PASS csapda (valós tanulság)
Ha Cybersec NO-GO-t adott és az ügynök új commitot készített a fix után, a korábbi QA PASS már egy más artifactra vonatkozik. Kötelező lépések:
1. Nézd meg a REVIEW kommentben és a Cybersec NO-GO-ban szereplő commit hash-t.
2. Ha eltérnek (vagy ha a kártyán azóta új commit volt), NE fogadd el a régi PASS-t -- futtasd újra a teszteket a legfrissebb commiten.
3. A verdikt-kommentbe mindig írd bele a konkrét commit hash-t (`commit <sha>`), hogy egyértelmű legyen, melyik artifactra vonatkozik.

### Round-trip persistencia-teszt (ne maszkold in-memory)
Adatbázis-írás tesztelésekor ne hidd el, hogy a teszt lefedi a perzisztenciát, ha az in-memory step outputját manuálisan override-olják a következő lépésben:
- ROSSZ: `step2({ ...step1Result, graceEndsAt: manualDate })` -- az in-memory adat szétválik attól, ami az adatbázisba kerül.
- JÓ: `step2(step1Result.graceEndsAt)` -- a step1 tényleges outputját adja tovább; ha a DB nem mentette a mezőt, step2 null-t kap és elbukik.
Minden round-trip tesztnél ellenőrizd, hogy a teszt NEM fed el egy adatvesztést azzal, hogy a hiányzó DB-mezőt kézzel injektálja a következő lépésbe.

### i18n-teljességellenőrzés (BidCalculatorForm-tanulság)
i18n wiring review-nál a render-path t()-hívások nem elegendők -- minden kódútvonalat le kell ellenőrizni:
- **Error catch ágak**: `catch` blokkban lévő `setError(... : 'hardcoded string')` sosem jelenik meg happy-path tesztben, mégis felhasználónak megjelenő szöveg
- **useEffect / async callback zárvány**: a `t()` elérhető, de elfelejtik bekötni
- Módszer (fron-ted javaslat): `grep -nE '>[A-Z]|aria-label="[A-Z]|placeholder="[A-Z]'` a módosított .tsx-en -- bármely találat potenciálisan bekötetlen i18n string (kizárni: adatvezérelt prop, CSS class, enum érték)
- Kulcs-paritás ellenőrzés: flatten + set-diff minden locale-ban -- egyetlen hiányzó kulcs láthatatlan fallback-leakhez vezet

### Non-vacuous fail-closed tesztverifikáció (VIES-tanulság)
Fail-closed garantiát csak akkor fogadd el, ha a tesztek bizonyítják, hogy a negatív ágak tényleg FAIL-re futnak:
- Timeout: a fetch tényleg lóg-e az AbortController-ig (ne csak gyors reject legyen)
- Injection guard: `vi.fn()` spy igazolja, hogy a live service NOT CALLED rossz inputra
- Minden failure mode-ra explicit `expect(res.valid).toBe(false)` -- a "zöld" önmagában nem elég ha a guard nem fut

## Ellenőrzés
- Minden acceptance criterion pipálva.
- Happy + loading/empty/error/edge state lefedve.
- Tesztek léteznek és zölden futnak; nincs szomszédos regresszió.
- i18n wiring: render-path ÉS catch/async ágak, kulcs-paritás mind a 7 locale-ban.

## Források
- https://martinfowler.com/articles/practical-test-pyramid.html
- https://www.browserstack.com/guide/qa-best-practices
- https://www.netguru.com/blog/qa-best-practices
- https://www.testrail.com/blog/testing-pyramid/

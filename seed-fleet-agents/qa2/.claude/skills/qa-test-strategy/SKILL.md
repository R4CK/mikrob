---
name: qa-test-strategy
description: Test-pyramid-based QA strategy, regression discipline, and independent sign-off procedure for moving work to DONE. Use when testing/verifying a feature or deciding if work is shippable (QA agent's core skill). Enforces that the author never verifies their own work.
---
# QA Test Strategy & Sign-off

## Mikor használd
Kész (vagy közel kész) munka tesztelésekor és a "shippable?" döntésnél. A flotta szabálya: a feladat KÉSZÍTŐJE soha nem ellenőrizheti a sajátját — DONE-ba csak MikroB vagy a QA ügynök teheti, és csak NEM saját munkát.
Kész (vagy közel kész) munka tesztelésekor és a "shippable?" döntésnél.
A flotta szabálya: a feladat KÉSZÍTŐJE soha nem ellenőrizheti a sajátját -- DONE-ba csak
MikroB vagy a QA ügynök teheti, és csak NEM saját munkát.

## Eljárás
1. **Shift left:** vond be magad korán (követelmény, design), ne csak a végén.
2. **Acceptance criteria:** írd ki a feladat összes elvárását, pipáld egyenként.
3. **Test pyramid:**
## Alapeljárás

1. **Ungated kártya keresése** -> `kanban-gate-scan` skill (Python board scan).
2. **gate-pretriage komment elolvasása** (ha van): a `@gate-pretriage` mechanikus előszűrő fut a gate előtt -- tsc, vacuous assertion, changed files listája. Olvasd el a kommentet MIELŐTT a committed kódba nézel: ezek ingyen információk (nem kell magadnak lefuttatni). `[warn]` = potenciális probléma amit igazolnod kell; `[info]` = fyi (pl. tsc excludes tests -> npm run typecheck kell).
3. **Committed kód olvasása** -- `git show <sha>:path/File.tsx`, SOHA nem a working tree.
3. **Acceptance criteria** -- írd ki a kártya elvárásait, pipáld egyenként.
3b. **Atomic-fact verifikáció** (KÖTELEZŐ, `atomic-fact-gate-protocol` skill) -- a REVIEW kommentből kinyert minden állítást atomi tényekre bonts és mindegyiket önállóan igazold. Zöld teszt nem bizonyíték: egy FAILED atom = QA FAIL még akkor is, ha X/X teszt zöld. -> részletek: `atomic-fact-gate-protocol` skill + `references/atomic-fact.md` claim sablon-ok.
4. **Test pyramid futtatás**:
   ```bash
   # HOL futtasd (kártya 973ed6eb): a fejlesztő ügynökök saját worktree-ben dolgoznak, a
   # megosztott klón CSAK fetch/landolás-alap. Gate-ként a felülvizsgált SHA-ra nyitott
   # eldobható worktree-ben futtass; ha csak olvasol/typecheckelsz, a fő klón is jó. SOHA ne
   # futtass más ügynök worktree-jében (ott élő, félkész munka van), és oda ne is commitolj.
   CC_MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
   git -C "$CC_MAIN" worktree add $HOME/qa-<sha> <sha>    # eldobható, a végén: worktree remove
   cd $HOME/qa-<sha>
   npx vitest run --reporter=verbose apps/<scope>
   npx tsc --noEmit 2>&1 | grep -E "error TS"
   ```
   - Unit (legtöbb): egységek izoláltan.
   - Integration (közép): komponensek/szolgáltatások interakciói.
   - E2E (kevés): csak kritikus user flow-k és magas kockázatú utak.
4. **Regresszió:** minden változásnál smoke-test a kritikus utakra; minden megtalált bugra írj automata tesztet, hogy némán ne térhessen vissza. Teljes regresszió release candidate előtt.
5. **Futtasd, ne feltételezd:** a teszteket ténylegesen futtasd le (vagy nézd végig). Zöld pipa, amit nem láttál lefutni, nem bizonyíték.
6. **Verdikt:**
   - PASS -> mozgasd DONE-ba (`/api/kanban/<id>/move` status=done) + eredmény-komment.
   - FAIL -> vissza in_progress-re precíz, reprodukálható bug-jelentéssel (lépések / elvárt / tényleges).
   - Integration (közép): komponensek / service-ek interakciói.
   - E2E (kevés): csak kritikus user flow + magas kockázatú utak.
5. **Regresszió**: minden változásnál smoke-test a kritikus utakra; minden bugra automata teszt.
6. **Verdikt komment** a kártyára (sha-t mindig beleírni):
   - `QA PASS -- commit <sha>, <N>/<N> teszt zöld, tsc clean. Gate: [Cybersec/Cybered szükséges-e]`
   - `QA FAIL -- commit <sha>. Repro: ... Elvárt: ... Tényleges: ... Következő lépés: ...`
7. **Move**: PASS -> `waiting` (MikroB zárja DONE-ba); FAIL -> `in_progress`.

## Buktatók
- SOHA ne hagyd jóvá a saját munkádat. Ha te készítetted, más (MikroB) ellenőrzi.
- "Valószínűleg működik" nem verdikt. Reprodukálj vagy futtass.
- E2E-t ne szórj szét mindenre — drága és törékeny; csak kritikus flow.
- Bug találtál, de nincs rá teszt? A javítás nem kész, amíg nincs regressziós teszt.
```bash
TOKEN=$(cat /home/neon/marveen/store/.dashboard-token)
# Komment
printf 'Authorization: Bearer %s\n' "$TOKEN" \
| curl -H @- -s -X POST http://localhost:3420/api/kanban/<id>/comments \
  -d '{"author":"qa","content":"QA PASS -- commit <sha>, ..."}'
# Move
printf 'Authorization: Bearer %s\n' "$TOKEN" \
| curl -H @- -s -X POST http://localhost:3420/api/kanban/<id>/move \
  -d '{"status":"waiting"}'
```

### Stale-PASS csapda (valós tanulság)
Ha Cybersec NO-GO-t adott és az ügynök új commitot készített a fix után, a korábbi QA PASS már egy más artifactra vonatkozik. Kötelező lépések:
1. Nézd meg a REVIEW kommentben és a Cybersec NO-GO-ban szereplő commit hash-t.
2. Ha eltérnek (vagy ha a kártyán azóta új commit volt), NE fogadd el a régi PASS-t -- futtasd újra a teszteket a legfrissebb commiten.
3. A verdikt-kommentbe mindig írd bele a konkrét commit hash-t (`commit <sha>`), hogy egyértelmű legyen, melyik artifactra vonatkozik.
## Kötelező ellenőrzőlista (minden kártyán)

### Round-trip persistencia-teszt (ne maszkold in-memory)
Adatbázis-írás tesztelésekor ne hidd el, hogy a teszt lefedi a perzisztenciát, ha az in-memory step outputját manuálisan override-olják a következő lépésben:
- ROSSZ: `step2({ ...step1Result, graceEndsAt: manualDate })` -- az in-memory adat szétválik attól, ami az adatbázisba kerül.
- JÓ: `step2(step1Result.graceEndsAt)` -- a step1 tényleges outputját adja tovább; ha a DB nem mentette a mezőt, step2 null-t kap és elbukik.
Minden round-trip tesztnél ellenőrizd, hogy a teszt NEM fed el egy adatvesztést azzal, hogy a hiányzó DB-mezőt kézzel injektálja a következő lépésbe.
**FE kártyák:**
- [ ] Rule 12: error state -- i18n kulcs + akciógomb + retry trigger (`retryKey` dep array)
- [ ] Rule 13: touch target MIN 44px a GOMB saját CSS-én (szülő 44px NEM elég)
- [ ] FAKE-SUCCESS: `onDeleted()`/`onSuccess()` AWAIT API call UTÁN hívódik-e?
- [ ] i18n: catch ágak, async callback-ek, nav-shell label-ek -- nem csak render-path
- [ ] RBAC-függő akció: az actor ténylegesen rendelkezik-e az Action-nel? (`rbac.ts` grep)
- [ ] CSP: nincs `style={{}}` inline-stílus React-ban (jsdom nem blokkolja, prod CSP igen)

### i18n-teljességellenőrzés (BidCalculatorForm-tanulság)
i18n wiring review-nál a render-path t()-hívások nem elegendők -- minden kódútvonalat le kell ellenőrizni:
- **Error catch ágak**: `catch` blokkban lévő `setError(... : 'hardcoded string')` sosem jelenik meg happy-path tesztben, mégis felhasználónak megjelenő szöveg
- **useEffect / async callback zárvány**: a `t()` elérhető, de elfelejtik bekötni
- Módszer (fron-ted javaslat): `grep -nE '>[A-Z]|aria-label="[A-Z]|placeholder="[A-Z]'` a módosított .tsx-en -- bármely találat potenciálisan bekötetlen i18n string (kizárni: adatvezérelt prop, CSS class, enum érték)
- Kulcs-paritás ellenőrzés: flatten + set-diff minden locale-ban -- egyetlen hiányzó kulcs láthatatlan fallback-leakhez vezet
**BE kártyák:**
- [ ] `authorizeScoped(ctx, Action.X)` ELSŐ hívás a handlerben
- [ ] tenantId KIZÁRÓLAG `ctx.tenantId`-ból (soha nem body-ból)
- [ ] Minden ÚJ `*Error` osztályhoz STATUS_BY_NAME bejegyzés + http-status.test.ts assertion -- ÉS a bejegyzés neve PONTOSAN egyezik a `this.name` értékkel (name-mismatch: más class ugyanolyan statussal != helyes mapping; -> `references/be-patterns.md` ## Error name vs. STATUS_BY_NAME). **FIGYELEM: `packages/modules/*/src/` domain csomagban definiált Error osztályok is ide tartoznak** -- ha a builder a domain-csomagban definiálta az Error-t (pl. `InvalidWorkAreaError` in `packages/modules/sites/src/work-area.ts`), az ugyanúgy STATE_BY_NAME bejegyzést igényel az `apps/api/src/http-status.ts`-ben; a builder könnyen kihagyja, mert a két fájl különböző csomagban él (d2e6e0e7 tanulság, 2026-08-01)
- [ ] Role-literal cross-check: domain `isX` string == `MembershipRole.X` enum értéke?
- [ ] Round-trip persistencia: step2 a step1 tényleges outputját kapja (nem kézi override)
- [ ] JSDoc sorrend-igény vs. tényleges kód: ha a comment "A -> B -> C" sorrendet ír, ellenőrizd hogy a kód is ebben a sorrendben fut-e; ha nem, a comment megtévesztő (nem szükségszerűen FAIL, de jegyezd meg a verdiktben)
- [ ] "Utolsó fallible lépés" igény: ha comment azt állítja hogy egy mutáló hívás az utolsó dobható lépés, ellenőrizd a rákövetkező kódot -- ha az is dobhat, a comment hibás
- [ ] tsc projekt-szintű: `npx tsc --noEmit` hibamentes

### Non-vacuous fail-closed tesztverifikáció (VIES-tanulság)
Fail-closed garantiát csak akkor fogadd el, ha a tesztek bizonyítják, hogy a negatív ágak tényleg FAIL-re futnak:
- Timeout: a fetch tényleg lóg-e az AbortController-ig (ne csak gyors reject legyen)
- Injection guard: `vi.fn()` spy igazolja, hogy a live service NOT CALLED rossz inputra
- Minden failure mode-ra explicit `expect(res.valid).toBe(false)` -- a "zöld" önmagában nem elég ha a guard nem fut
**Migráció kártyák:**
- [ ] ENABLE + FORCE RLS mindkét irányban (header ÉS child tábla külön)
- [ ] NULLIF(current_setting('app.tenant_id', true), '')::uuid minta (pool-reuse safe, PG18)
- [ ] Szimmetrikus USING + WITH CHECK (azonos predikátum)
- [ ] GRANT TO cleancore_app minden érintett táblán
- [ ] Minden INDEX tenant_id-vel vezet
- [ ] IF NOT EXISTS guard minden CREATE TABLE/INDEX-en (idempotens)
- [ ] DROP POLICY IF EXISTS CREATE POLICY előtt (idempotens)
- [ ] BEGIN/COMMIT wrap
- [ ] Child table cross-tenant FK rés: ha child.tenant_id NEM composite FK a parent(tenant_id, id)-ra, notézd -- B-owned sor kerülhet idegen parent alá (-> `references/be-patterns.md` ## Migráció: child table cross-tenant FK rés)

### Pipe exit-code csapda (Bash shell-tanulság)
`cmd | head -N; echo "EXIT:$?"` az exit code-ot a `head` parancsé adja vissza, NEM a `cmd`-é -- még ha `cmd` hibával zárult is, az `EXIT:0` jelenik meg.
- ROSSZ: `npx tsc --noEmit 2>&1 | head -10; echo "EXIT:$?"` -> EXIT:0 (head kilépési kódja)
- JÓ: `npx tsc --noEmit 2>&1; echo "REAL_EXIT:$?"` -> EXIT:2 (tsc valódi kilépési kódja)
Tsc/lint/teszt exit-code ellenőrzésnél MINDIG pipe nélkül futtass, vagy PIPESTATUS-t használj: `${PIPESTATUS[0]}`.
**Általános:**
- [ ] Nem saját munkát ellenőrzöm (Rule 4)
- [ ] A REVIEW hivatkozott sha-ja == a legújabb commit (nem stale)
- [ ] tsc clean (vitest nem type-check-el, zöld teszt mellé mindig tsc)

- [ ] Nem-kikényszerített doc-comment invariáns (Cybersec javaslat, 2026-08-21): ha egy komment, docstring vagy migrációs fejléc GARANCIÁT állít egy adatmezőre ("ide csak redaktált szöveg kerül", "csak valódi állapotváltásnál íródik", "csak szerver-oldali logoláshoz"), van-e a kód-útvonalon MELLETTE VAGY kikényszerítő hívás, VAGY teszt, ami pont ezt az invariánst állítja? Ha egyik sincs: FINDING, függetlenül attól, hogy a mai viselkedés helyes-e -- a komment ilyenkor a jövőbeli olvasót téveszti meg. Nyomon követés: sorold fel a mezőt ÍRÓ összes hívót (nem csak a nevesítettet), és mindegyikre kérdezd meg, hogy azon az ágon lefut-e a kikényszerítés.
- [ ] **CleanCore kártyákon: kód-duplikáció ellenőrzés** (card 4bade960, GitHub-first: jscpd, MIT, github.com/kucherenko/jscpd) -- `bash {{INSTALL_DIR}}/store/jscpd-duplication-check.sh <CleanCore path> [threshold%, default 5]`. Exit 0 = OK; exit 1 = a duplikáció a küszöb felett -- a konzol-riport megmondja melyik fájlpár, azt nézd meg FINDING-ként. Marveen (fleet) kódon nem kötelező (belső, nem CleanCore).

### Merge-base delta izoláció (git diff tanulság)
Ha egy feature-branch delta-ját akarod látni (mi változott a branch-en, NEM ami develop-ra jött azóta), `git diff develop..<sha>` HIBÁS ha develop előrement.
- HELYES: `git merge-base develop <sha>` -> majd `git diff <merge-base>..<sha>`
- `git diff develop..<sha>` a develop saját commit-jait is belekeveri a deltába (pl. 76 fájl látszik 46 helyett)
Ez a gate-elés során kritikus: mindig a valódi branch-deltát gate-eld, ne a develop-divergenciát.
## Atomic-fact buktató (magic-link tanulság)

### REVIEW-kommentben közölt tesztszámot mindig verifkáld (WF-5 tanulság)
Ha a REVIEW azt állítja "18+13+10 mind zöld" -- NE fogadd el a számot, nézd meg a tényleges tesztfájlokat a commitban:
- `git diff <sha>^1 <sha> --name-only | grep test` -> megmutatja a commitban lévő tesztfájlokat
- Számold meg a `it(` és `test(` hívásokat minden fájlban, ne a REVIEW állítását.
- WF-5 konkrét eset: a "10" ShiftEditPage tesztekre vonatkozott, de ShiftEditPage.test.tsx NEM létezett a commitban (a REVIEW tévedett). Így az edit komponens tesztek nélkül ment át.
Általános szabály: ha a REVIEW-ban szereplő tesztszám és a `git diff <sha>^1 <sha> --name-only` tesztfájlainak valódi száma nem adja ki az összeget, KERESS RÁJUK -- valamelyik fájl hiányzik vagy nem commitolt. (NEM `git show --name-only`: egy MERGE-commiton -- és a landolás ezen a flottán mindig az -- csak a MINDEN szülőtől eltérő, konfliktus-feloldott fájlokat listázza, tehát egy hihető, teljesnek látszó, HIÁNYOS listát ad; mérve: egy 12 fájlos landoló merge-re egyetlen fájlt írt ki. A `git diff <sha>^1 <sha>` alak nem-merge commiton azonos a `git show`-val.)
**Claim bizonyíték nélkül** (f94ae82f tanulság, 2026-08-06): ha a REVIEW azt állítja hogy "X tesztelve van"
de nincs konkrét atom-bizonyíték, az NEM elég. 151/151 zöld tesztnél is volt 2 MAJOR bug (magic-link),
mert a negatív atomok (email-mismatch, superadmin izoláció) soha nem kerültek ellenőrzésre.
-> Kötelező: `atomic-fact-gate-protocol` skill futtatása minden gate-elésnél. Minden REVIEW-állítást
bontsd atomokra, minden atomhoz futtasd a verifikáló parancsot. Claim csak akkor fogadható el, ha
minden atomja VERIFIED vagy UNTESTABLE (indokkal). -> `references/atomic-fact.md` sablon-ok.

### Contract-first FE tesztelés (WF-5 tanulság)
Ha egy FE komponens "contract-first" (a BE endpoint még nincs live), a teszthiány NEM elfogadható:
- A BE-függő integráció mocked-kel is tesztelhető: pre-fill loading state, API error handling (409/403/network), navigáció, form validáció
- Alap minimum: a komponens renderel, a hibakezelés az i18n kulcsokból jön (ne hardcode), a navigate() meghívódik siker/cancel esetén
- "A BE nincs live" nem magyarázza a teszthiányt -- a kontraktus létezik, a mock alapján írható teszt. A teszthiány QA finding, és WF-3 (BE) live-ra állítása ELŐTT pótolni kell.
## Fő buktatók (részletek a references/ mappában)

**FAKE-SUCCESS** (F4-FE c764ec8): `handleDelete()` kihagyja az API-t -> `onDeleted()` azonnal -> FAIL.
-> `references/fe-patterns.md` ## FAKE-SUCCESS demo-fallback

**Role-literal vakuum** (1a47cac2): `isWarehouseKeeper` 'warehouse_admin'-t keres, enum 'warehouse' ->
80/80 zöld vákuum, Cybersec NO-GO live reproval. -> `references/be-patterns.md` ## Role-literal vakuum

**Stale-PASS** (Cybersec NO-GO + fix commit -> régi QA PASS érvénytelen): mindig sha-t írj a verdiktbe.
-> `references/verdict-and-board.md` ## Stale-PASS csapda

**Rule 13 csapda**: szülő konténer `min-height: 44px` NEM teszi a gombot 44px-essé.
-> `references/fe-patterns.md` ## Rule 13

**Validáció -> 500**: ÚJ `*Error` osztály STATUS_BY_NAME nélkül -> 500 kliens-hibára.
-> `references/be-patterns.md` ## Validációs hiba -> 500

**Tests-green tsc-red**: vitest nem type-check-el; mindig futtatni `npx tsc --noEmit`.

**jscpd --threshold már önmagában exit-kódol** (card 4bade960, mérve nem feltételezve): jscpd@4.3.0 a `--threshold N` flag-gel ÖNMAGÁBAN nem-nulla exit kóddal áll le, ha a duplikáció eléri/meghaladja N%-ot (a `--help` szövege is ezt mondja) -- külön `--exitCode` flag NEM kell egy egyszerű pass/fail gate-hez, az csak azt választja meg MELYIK nem-nulla kódot használja. Ha valaha más jscpd major verzióra váltunk, ezt újra kell mérni, nem a régi mérésre hagyatkozni.

**Üres commit (bd462365, 2026-08-02)**: REVIEW azt állítja fájl hozzáadva, de a commit üres -- `git diff <sha>^ <sha> --name-only` üres kimenetet ad, a fa-hash megegyezik a szülőével. A `git show <sha> --stat` sem mutat changed file-okat. Ez akkor fordul elő, ha a builder `git commit` előtt nem adta hozzá a fájlt (`git add`), vagy a commit --amend egy korábbi üres commitot vitt tovább. Gate: `git diff <sha>^ <sha> --name-only` KÖTELEZŐ ellenőrzés minden "kész" commit-ra -- ha üres: QA FAIL azonnal, a fájl nincs commitolva.

**Board scan false-positive**: `MIKROB_CLOSED_RE`, `BLOCKED_MARKERS`, `is_gate_review()`.
-> `references/verdict-and-board.md` ## Board scan

**PG 18 GUC pool-reuse** (RLS fail-closed): `NULLIF(current_setting(...), '')::uuid` wrapper kell.
-> `references/be-patterns.md` ## PG 18 custom GUC

**Async void-swallow** (useCallback finally-only): minden API call-ban `catch` ág kötelező.
-> `references/fe-patterns.md` ## async useCallback void-swallow

**Error name mismatch** (64e493e7, 2026-07-31): `AssetQrRenderError` (this.name) != `QrRenderError` (STATUS_BY_NAME) -> internal_error code, nem qr_render. STATUS_BY_NAME match-et NÉV szerint ellenőrizd, nem csak hogy van-e entry.
-> `references/be-patterns.md` ## Error name vs. STATUS_BY_NAME name mismatch

**Child table cross-tenant FK rés** (6af23cea, 2026-07-31): child RLS `tenant_id=GUC` csak a saját sort védi; a FK-ellenőrzés bypass-olja a parent RLS-t -> B insertalhat child sort idegen parent alá. Composite FK vagy app-réteg enforcement kell.
-> `references/be-patterns.md` ## Migráció: child table cross-tenant FK rés

**Nem-kikényszerített doc-comment invariáns** (Cybersec javaslat, 2026-08-21, három azonos minta egy napon belül): `transportCause` kommentje "szerver-oldali logoláshoz" -- semmi nem olvasta (81e2484f); `provisioning_started_at` kommentje "CSAK valódi állapotváltásnál" -- működő CAS nélkül (09b41866); `last_error` kommentje "kizárólag redaktált szöveg" -- redakció nélkül a persist-határon (460c1725). Mindháromnál a komment volt az EGYETLEN "védelem", nem egy tényleges kikényszerítő hívás vagy teszt. A kód ma helyesen viselkedhet -- ez nem menti fel: a komment akkor is FINDING, ha a jelenlegi hívók mind jól viselkednek, mert a jövőbeli olvasót a garancia-állítás téveszti meg egy új hívónál. Lásd fenti "Általános" checklist-pont.

**Docs corpus scan timeout untracked fájloktól** (7e2f0a13, 2026-08-01): a `no-false-storage-claims.test.ts` docs corpus scan-je timeout-ra eshet, ha a docs/ mappában sok untracked (el nem kötelezett) fájl van (pl. stitch-gen HTML-ek). Ez NEM a szóban forgó kártya regressziója. Azonosítás: `git stash -u` (untracked-et is) -> teszt újrafuttatás -> ha most zöld -> pre-existing, a stash-elt fájlok okozták -> `git stash pop`. QA PASS adható NOTE-tal; külön bug-kártya a timeout emelésre.

**STATUS_BY_NAME csak CleanCore BE kártyáknál kötelező** (3114e28d, 2026-08-01): a `*Error osztályhoz STATUS_BY_NAME` ellenőrzőlista-pont CSAK CleanCore apps/api hatókörű BE kártyákon érvényes. Marveen (fleet) kódon (`src/web/routes/`) saját hibakezelés van, nem a CleanCore STATUS_BY_NAME rendszer -- ott nem kell STATUS_BY_NAME bejegyzést keresni.

**Domain-csomag Error STATUS_BY_NAME vakfoltja** (d2e6e0e7, 2026-08-01): ha a builder egy új `*Error` osztályt a `packages/modules/*/src/` domain csomagban definiál (pl. `InvalidWorkAreaError` in `packages/modules/sites/src/work-area.ts`), azt a STATUS_BY_NAME mapper (`apps/api/src/http-status.ts`) nem látja automatikusan -- különböző csomagban van. A builder könnyen kihagyja, mert a domain-kódon törekedve nem látja az API-réteget. Tesztek átmennek (`.toThrow(X)` az exception osztályát nézi, nem a HTTP státuszt). Ellenőrzés: `git diff <sha>^ <sha> -- '*.ts' | grep "^+.*class.*Error"` -- ez mutatja az adott commitban bevezetett összes új Error osztályt; minden találatot `grep`-elj http-status.ts-ben.

**Stale teszt-komment vs assertion (dda9870 tanulság, 2026-08-02)**: ha egy teszt-fájlban lévő KOMMENT faktálisan elavult (pl. "tier 1 from haiku is fable-5. That IS cheaper" -- amikor fable a legdrágább rung lett), de NEM szerepel assertion-ként, az NEM FAIL. Jelezd a verdiktben ("stale komment, frissítésre érdemes"), de ne blokkold a PASS-t miatta. Ha viszont az elavult állítás assertion-ban is megjelenik (`expect(X).toBe(Y)`), az FAIL.

**Marveen/fleet model-fallback kártyák extra ellenőrzőlistája** (dda9870, ae55270, e33af7c4 tapasztalat):
- [ ] `MODEL_LADDER` sorrend: az assertion tényleg azt a sorrendet teszteli, ami a committed kódban van? (`git show <sha>:src/model-catalog.ts | grep -A10 'MODEL_LADDER'`)
- [ ] Régi sorrend-feltételezés keresése az ÖSSZES test fájlban: `git show <sha>:src/__tests__/` -- grep az elavult rung-nevekre + sorrend-hivatkozásokra (nem csak a módosított fájlban)
- [ ] `NO_HAIKU_AGENTS` tag: az ügynökök neve pontos egyezés-e a valós agent_id-kkel? (`/api/agents` listával összevetni)
- [ ] `applyNoHaikuFloor` wiring: mind a futó, mind a parkolt ügynök útvonalában meg van-e hívva? (`grep -n 'applyNoHaikuFloor' model-fallback-runner.ts`)
- [ ] Cheaper-tier-wins guard: `ladderIndexOf(weeklyModel) < ladderIndexOf(currentModel)` guard a `decideParkedModelUpdate`-ban van-e, NEM a runnerben (single source of truth)
- [ ] `decideParkedModelUpdate` agentName paraméter: ha az `agentName` opcionális, az `undefined` eset megőrzi-e a régi viselkedést?
- [ ] Teszt-fájl scope: csak a marveen (`src/`) kódon futtasd a teszteket (`npx vitest run src/`), nem CleanCore-on

## References index

| Fájl | Tartalom |
|------|---------|
| `references/fe-patterns.md` | Rule 12/13, FAKE-SUCCESS, i18n, RBAC-FE, void-swallow, setTimeout, CSP, flow-map |
| `references/be-patterns.md` | WIRING-GAP slice, role-literal vakuum, validáció->500, atomic port, round-trip, PG18, payment webhook, rate-limit |
| `references/verdict-and-board.md` | Gate tiering, stale-PASS, részleges REVIEW, close-as-SATISFIED, batch re-gate, board scan szűrők, stuck-in-waiting recovery, "REVIEW" != review-kész, stale REVIEW handling |
| `references/SKILL-FULL-BACKUP.md` | Teljes 1924-soros eredeti (archívum) |
| `~/.claude/skills/atomic-fact-gate-protocol/SKILL.md` | Atomic-fact verifikáció + consensus protocol minden gate számára |
| `~/.claude/skills/atomic-fact-gate-protocol/references/atomic-fact.md` | Common claim decomposition sablonok (auth, RLS, migration, FAKE-SUCCESS stb.) |

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
- Tesztek zölden futnak + tsc clean; nincs szomszédos regresszió.
- i18n: render-path ÉS catch/async ágak, kulcs-paritás mind a 7 locale-ban.
- Verdikt kommentben konkrét sha + teszt-számok.

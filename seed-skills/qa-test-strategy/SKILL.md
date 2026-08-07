---
name: qa-test-strategy
description: Test-pyramid-based QA strategy, regression discipline, and independent sign-off procedure for moving work to DONE. Use when testing/verifying a feature or deciding if work is shippable (QA agent's core skill). Enforces that the author never verifies their own work.
---
# QA Test Strategy & Sign-off

## Mikor használd
Kész (vagy közel kész) munka tesztelésekor és a "shippable?" döntésnél.
A flotta szabálya: a feladat KÉSZÍTŐJE soha nem ellenőrizheti a sajátját -- DONE-ba csak
MikroB vagy a QA ügynök teheti, és csak NEM saját munkát.

## Alapeljárás

1. **Ungated kártya keresése** -> `kanban-gate-scan` skill (Python board scan).
2. **gate-pretriage komment elolvasása** (ha van): a `@gate-pretriage` mechanikus előszűrő fut a gate előtt -- tsc, vacuous assertion, changed files listája. Olvasd el a kommentet MIELŐTT a committed kódba nézel: ezek ingyen információk (nem kell magadnak lefuttatni). `[warn]` = potenciális probléma amit igazolnod kell; `[info]` = fyi (pl. tsc excludes tests -> npm run typecheck kell).
3. **Committed kód olvasása** -- `git show <sha>:path/File.tsx`, SOHA nem a working tree.
3. **Acceptance criteria** -- írd ki a kártya elvárásait, pipáld egyenként.
3b. **Atomic-fact verifikáció** (KÖTELEZŐ, `atomic-fact-gate-protocol` skill) -- a REVIEW kommentből kinyert minden állítást atomi tényekre bonts és mindegyiket önállóan igazold. Zöld teszt nem bizonyíték: egy FAILED atom = QA FAIL még akkor is, ha X/X teszt zöld. -> részletek: `atomic-fact-gate-protocol` skill + `references/atomic-fact.md` claim sablon-ok.
4. **Test pyramid futtatás**:
   ```bash
   cd /mnt/h/LM_Studio_Workdir/CleanCore
   npx vitest run --reporter=verbose apps/<scope>
   npx tsc --noEmit 2>&1 | grep -E "error TS"
   ```
   - Unit (legtöbb): egységek izoláltan.
   - Integration (közép): komponensek / service-ek interakciói.
   - E2E (kevés): csak kritikus user flow + magas kockázatú utak.
5. **Regresszió**: minden változásnál smoke-test a kritikus utakra; minden bugra automata teszt.
6. **Verdikt komment** a kártyára (sha-t mindig beleírni):
   - `QA PASS -- commit <sha>, <N>/<N> teszt zöld, tsc clean. Gate: [Cybersec/Cybered szükséges-e]`
   - `QA FAIL -- commit <sha>. Repro: ... Elvárt: ... Tényleges: ... Következő lépés: ...`
7. **Move**: PASS -> `waiting` (MikroB zárja DONE-ba); FAIL -> `in_progress`.

```bash
TOKEN=$(cat {{INSTALL_DIR}}/store/.dashboard-token)
# Komment
printf 'Authorization: Bearer %s\n' "$TOKEN" \
| curl -H @- -s -X POST http://localhost:3420/api/kanban/<id>/comments \
  -d '{"author":"qa","content":"QA PASS -- commit <sha>, ..."}'
# Move
printf 'Authorization: Bearer %s\n' "$TOKEN" \
| curl -H @- -s -X POST http://localhost:3420/api/kanban/<id>/move \
  -d '{"status":"waiting"}'
```

## Kötelező ellenőrzőlista (minden kártyán)

**FE kártyák:**
- [ ] Rule 12: error state -- i18n kulcs + akciógomb + retry trigger (`retryKey` dep array)
- [ ] Rule 13: touch target MIN 44px a GOMB saját CSS-én (szülő 44px NEM elég)
- [ ] FAKE-SUCCESS: `onDeleted()`/`onSuccess()` AWAIT API call UTÁN hívódik-e?
- [ ] i18n: catch ágak, async callback-ek, nav-shell label-ek -- nem csak render-path
- [ ] RBAC-függő akció: az actor ténylegesen rendelkezik-e az Action-nel? (`rbac.ts` grep)
- [ ] CSP: nincs `style={{}}` inline-stílus React-ban (jsdom nem blokkolja, prod CSP igen)

**BE kártyák:**
- [ ] `authorizeScoped(ctx, Action.X)` ELSŐ hívás a handlerben
- [ ] tenantId KIZÁRÓLAG `ctx.tenantId`-ból (soha nem body-ból)
- [ ] Minden ÚJ `*Error` osztályhoz STATUS_BY_NAME bejegyzés + http-status.test.ts assertion -- ÉS a bejegyzés neve PONTOSAN egyezik a `this.name` értékkel (name-mismatch: más class ugyanolyan statussal != helyes mapping; -> `references/be-patterns.md` ## Error name vs. STATUS_BY_NAME). **FIGYELEM: `packages/modules/*/src/` domain csomagban definiált Error osztályok is ide tartoznak** -- ha a builder a domain-csomagban definiálta az Error-t (pl. `InvalidWorkAreaError` in `packages/modules/sites/src/work-area.ts`), az ugyanúgy STATE_BY_NAME bejegyzést igényel az `apps/api/src/http-status.ts`-ben; a builder könnyen kihagyja, mert a két fájl különböző csomagban él (d2e6e0e7 tanulság, 2026-08-01)
- [ ] Role-literal cross-check: domain `isX` string == `MembershipRole.X` enum értéke?
- [ ] Round-trip persistencia: step2 a step1 tényleges outputját kapja (nem kézi override)
- [ ] JSDoc sorrend-igény vs. tényleges kód: ha a comment "A -> B -> C" sorrendet ír, ellenőrizd hogy a kód is ebben a sorrendben fut-e; ha nem, a comment megtévesztő (nem szükségszerűen FAIL, de jegyezd meg a verdiktben)
- [ ] "Utolsó fallible lépés" igény: ha comment azt állítja hogy egy mutáló hívás az utolsó dobható lépés, ellenőrizd a rákövetkező kódot -- ha az is dobhat, a comment hibás
- [ ] tsc projekt-szintű: `npx tsc --noEmit` hibamentes

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

**Általános:**
- [ ] Nem saját munkát ellenőrzöm (Rule 4)
- [ ] A REVIEW hivatkozott sha-ja == a legújabb commit (nem stale)
- [ ] tsc clean (vitest nem type-check-el, zöld teszt mellé mindig tsc)

## Atomic-fact buktató (magic-link tanulság)

**Claim bizonyíték nélkül** (f94ae82f tanulság, 2026-08-06): ha a REVIEW azt állítja hogy "X tesztelve van"
de nincs konkrét atom-bizonyíték, az NEM elég. 151/151 zöld tesztnél is volt 2 MAJOR bug (magic-link),
mert a negatív atomok (email-mismatch, superadmin izoláció) soha nem kerültek ellenőrzésre.
-> Kötelező: `atomic-fact-gate-protocol` skill futtatása minden gate-elésnél. Minden REVIEW-állítást
bontsd atomokra, minden atomhoz futtasd a verifikáló parancsot. Claim csak akkor fogadható el, ha
minden atomja VERIFIED vagy UNTESTABLE (indokkal). -> `references/atomic-fact.md` sablon-ok.

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
- Tesztek zölden futnak + tsc clean; nincs szomszédos regresszió.
- i18n: render-path ÉS catch/async ágak, kulcs-paritás mind a 7 locale-ban.
- Verdikt kommentben konkrét sha + teszt-számok.

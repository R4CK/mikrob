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

### Hardcoded language consistency check (sa-login tanulság)
Amikor egy app-ban nincs i18n rendszer (pl. Superadmin: hardcoded angol szöveg az elvárt minta), a "quality pass" könnyen hagy bent idegen nyelvi stringeket mert csak a látható/főbb elemeket módosítja. Szisztematikus grep kötelező:
```bash
# HU stringek keresése .tsx-ben (nem csak a változott sorokon)
grep -n "kód\|meg\|nem\|már\|csak\|belép\|állít\|generál\|titok\|beállít\|irányít\|kerdes" FILE.tsx
# Általánosabb: bármely non-ASCII felhasználói string a renderben
grep -nP '[áéíóöőúüű]' FILE.tsx | grep -v '^\s*//'
```
Nem elég a "primary flow" scan -- ellenőrizni kell:
- Error üzeneteket (setError() hívások)
- Label-eket és button szövegeket
- Loading state stringeket
- Footer/legal szövegeket
- MINDEN success/done state üzenetet
A `17c7b836` gate-nél a LoginPage-ben 5 HU string maradt (sorok: 18/170/219/231/232), a `7ca09e56`-nál az EnrollTotpPage-ben 5 (116/119-120/125/131/150) -- mindkettő quality pass commitok UTÁN.

### Nav-shell i18n ellenőrzés (e4cd0b06 tanulság -- QA MISS)
Amikor egy kártya ÚJ route-ot + nav itemet ad hozzá (pl. `/portal/quality` + "Minőség" bottom nav link), a shell/navigációs fájlt IS ellenőrizni kell -- nem csak a komponens saját i18n-jét.

**Ellenőrzési lépés**:
```bash
# Ha a commit shell/nav fájlt érint, grep a nav label-ekre
git show <commit> -- apps/web/src/features/*/ClientPortalShell.tsx \
  apps/web/src/components/nav/*.tsx \
  apps/web/src/routes/*.tsx 2>/dev/null | grep -E '^\+.*[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]{2,}' | grep -v '//'
# Bármely nem-t() szöveg a nav-ban potenciálisan hardcoded string
```

**Valós eset**: 61ee7bc (e4cd0b06) -- `ClientPortalShell.tsx:136` raw `Minőség` string a bottom nav-ban. A komponens i18n-je (18/18 portal.quality kulcs) tökéletes volt, de a shell nav label kimaradt. QA PASS-t adtam -> qa2 FAIL overrode.

**Rule**: ha a commit stat-jában nav/shell fájl szerepel -> kötelező i18n-scan a nav string-ekre.

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

### Self-advance board scan (Rule 11 -- KÖTELEZŐ eljárás)
A waiting+REVIEW kártyák keresése a self-advance loopban:
1. `GET /api/kanban` -- lista lekérés (NEM tartalmaz kommenteket!)
2. Minden `waiting` VAGY `in_progress` státuszú kártyára: `GET /api/kanban/{id}/comments` -- egyenként
3. Szűrés: `has_review = any('REVIEW' in c['content'] for c in comments)`
4. Szűrés -- LATEST verdict per gate (ne csak `any()`): a kommenteket hátulról olvasd, és az **első** (legfrissebb) qa2-komment nyitósorát egyeztesd regex-szel.
5. Ha `has_review=Y AND latest_qa2_verdict=None` -> ez az ungated kártya, gate-elni kell

**Kritikus**: a lista endpoint SOHA nem ágyaz be kommenteket. Ha a scan 0-t ad mikor sok waiting kártya van, az a root cause.

**API status filter TÖRÖTT (2026-07-13 tanulság):** `GET /api/kanban?status=waiting` NEM szűr -- az összes nem-archivált kártyát visszaadja (kb. 250+), köztük done/in_progress/planned státuszúakat is. A valódi státuszt KIZÁRÓLAG SQLite-ból olvasd:
```bash
# a sqlite3 CLI NEM garantalt telepitve (lasd a fajl kesobbi, aktualis szekcioit) --
# a beepitett python3 sqlite3 modul mindig elerheto:
python3 -c "
import sqlite3
con = sqlite3.connect('{{INSTALL_DIR}}/store/claudeclaw.db')
print(con.execute(\"SELECT id, status FROM kanban_cards WHERE id='CARD_ID'\").fetchall())
"
# vagy board scan:
python3 -c "
import sqlite3
con = sqlite3.connect('{{INSTALL_DIR}}/store/claudeclaw.db')
order = \"CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 ELSE 3 END\"
for row in con.execute(f\"SELECT id, priority, title FROM kanban_cards WHERE status='waiting' ORDER BY {order}\"):
    print(row)
"
```
Az API scan hamis "waiting" kártyákat ad -- mindig SQLite-tel validáld a státuszt mielőtt gate-munkát kezdesz.

**needs_qa_gate() helyes logika (2026-07-17 tanulság):** A `any('REVIEW' in c['content'])` hamis pozitívokat ad, mert (a) a QA saját "REVIEW: QA PASS" verdikt-kommentjei is REVIEW-val kezdődnek, (b) a MikroB "DONE/CLOSED" utó-komment nem QA szerzőjű, ezért a naiv check nem törli a flagot. Helyes szűrő:
```python
def needs_qa_gate(comms):
    # Csak BUILDER (nem qa) REVIEW-k számítanak, amelyek nem már-verdikt kommentek
    last_review_idx = None
    for i, cm in enumerate(comms):
        c = cm['content'].strip()
        if c.startswith('REVIEW') and cm['author'] != 'qa' and 'QA PASS' not in c and 'QA FAIL' not in c:
            last_review_idx = i
    if last_review_idx is None:
        return False
    # QA verdikt VAGY MikroB DONE/CLOSED után a REVIEW le van fedve
    for cm in comms[last_review_idx+1:]:
        if cm['author'] == 'qa' and ('QA PASS' in cm['content'] or 'QA FAIL' in cm['content']):
            return False
        if cm['author'] == 'mikrob' and ('DONE' in cm['content'] or 'CLOSED' in cm['content']):
            return False
    return True
```
Ez kizárja: (1) QA saját "REVIEW: QA PASS" kommentjeit, (2) olyan REVIEW-kat ahol MikroB már DONE-ba zárta a kártyát.

**Stale builder REVIEW DONE kártyán (2026-07-17 tanulság):** Fron-ted/fron-teddy olykor RÉGI commitra hivatkozó REVIEW-t posztoL EGY MÁR DONE KÁRTYÁN (pl. a pre-fix commitra, ami QA FAIL volt). Ez "visszanyitja" waiting-re. Detekció: ha a REVIEW commit sha-ja RÉGEBBI mint a kártyán lévő QA PASS sha-ja -> stale. Cselekvés: posztolj QA kommentet ("STALE REVIEW -- [commit sha] már QA FAIL-t kapott, fix @[sha] QA PASS-t kapott, DONE volt. Re-close szükséges (MikroB)."), ne gate-elj újra.

**Stale builder REVIEW QA-FAIL utáni re-submit nélküli fix (2026-07-24 tanulság):** A fejlesztő néha QA FAIL után re-submittol ugyanazzal a commit SHA-val (fix commit nélkül). Ez board-scan-nél "ungated"-ként jelenik meg (új REVIEW id > régi QA FAIL id), de a commit SHA változatlan.

Detekció:
```bash
# A REVIEW hivatkozott SHA == a QA FAIL SHA-ja?
git -C <repo> log --oneline apps/web/src/features/<mod>/ | head -3
# Ha a legújabb commit == a FAIL-ben hivatkozott SHA -> stale re-submit
```
Cselekvés: ne gate-elj újra. Posztolj kommentet:
```
STALE REVIEW -- nem gate-elem újra.
A [SHA] commit már QA FAIL-t kapott ([korábbi komment id]). A git log szerint nincs újabb commit.
Fix commit kell (lásd blocker lista), utána új REVIEW a fix SHA-val.
```
@mikrob értesítés kötelező: a fejlesztő nem tud a stale állapotról. NE mozdítsd a kártya státuszát (az in_progress állapotban van, ott is kell maradnia fix commit nélkül).

**Author-azonosítás (PONTOSAN)**: `c['author'] == 'qa'` / `== 'qa2'` / `startswith('cybersec')` / `== 'cybered'`. NE használj `startswith('qa')` -- az `qa2`-t is matcheli és kettős verdiktet okoz.

**Status-stuck kártya false-ungated csapda (2026-07-24 tanulság):** A `?status=waiting` API néha `done` státuszú kártyákat is visszaad (board API bug). Ráadásul MikroB olykor csak kommentben ír "DONE"-t, de az API státuszt nem frissíti -> a kártya `waiting`-ben marad. Mindkét esetben a scan tévesen "ungated"-nek látja. Szűrő:
```python
# 1. Ellenőrizd a valódi státuszt (a list response tartalmazza)
if c.get('status') == 'done': continue  # board API quirk: done kártya waiting listában

# 2. MikroB DONE/DUPLIKATUM/KONSZOLIDALVA komment a REVIEW után = nem kell gate
MIKROB_CLOSED_RE = re.compile(r'\b(DONE|DUPLIKATUM|KONSZOLIDALVA|LEZAROM|LEZÁRVA)\b', re.IGNORECASE)
mikrob_handled_after = any(
    cm['id'] > last_review_id
    and (cm.get('author') or '').lower() == 'mikrob'
    and MIKROB_CLOSED_RE.search(cm.get('content') or '')
    for cm in comms
)
if mikrob_handled_after: continue  # status-stuck v. dup/consolidated, MikroB kezeli
```

**DUPLIKATUM / KONSZOLIDALVA false-positive (2026-07-24 tanulság):** A naiv `has_review AND NOT has_qa` scan 3 hamis pozitívot adhat:
- `"DUPLIKATUM -- azonos cimű kártya NNN koveti a valós munkát... lezárom board-higiene miatt"` (MikroB komment): a kártya dup, a kanonikus kártyán már van gate -- NE gate-elj.
- `"DONE -- a gate KONSZOLIDALVA volt a NNN write-path kártyába..."` (MikroB komment): a gate egy másik kártyán futott le -- NE gate-elj.
- A `mikrob_done_after` filter csak 'DONE'-t keresett; ezért a DUPLIKATUM/KONSZOLIDALVA esetek átcsúsztak. A kiterjesztett regex (`DONE|DUPLIKATUM|KONSZOLIDALVA|LEZAROM|LEZÁRVA`) mindkét mintát kezeli.

**Stale-REVIEW false-ungated csapda (2026-07-24 tanulság):** Ha a QA már posztolt "STALE REVIEW" kommentet (saját komment, nem verdikt), a board scan még mindig "ungated"-ként látja a kártyát (mert a STALE REVIEW komment id-ja > a QA FAIL/PASS id-ja, de a scan csak a verdikt-kommenteket nézi). Kiegészítő szűrő:
```python
# STALE REVIEW komment megléte = a qa már kezelte, ne gate-elj újra
qa_stale_after = any(
    cm['id'] > last_review_id
    and (cm.get('author') or '').lower() == 'qa'
    and 'STALE REVIEW' in (cm.get('content') or '').upper()
    for cm in comments
)
if qa_stale_after: continue  # már kezelt stale eset, ne duplikáld
```
Ha a stale helyzet fennáll (nincs új commit), NE posztolj újabb stale kommentet -- a már meglévő elég, és a duplikátum zaj.

**Gate verdict detection (REGEX a nyitósoron, NEM `'NO-GO' in content`):** A "CYBERED GO (RE-GATE) -- a korábbi NO-GO-m ZARVA" típusú szövegben a 'NO-GO' string megjelenik egy GO verdiktben is. Csak a **comment első sorának elejét** kell illeszteni:
```python
import re
PASS_RE = re.compile(r'^(QA2?\s+PASS|CYBERSEC\s+GO|CYBERED\s+(FULL-CARD\s+)?GO)', re.IGNORECASE)
FAIL_RE = re.compile(r'^(QA2?\s+FAIL|CYBERSEC\s+NO-GO|CYBERED\s+NO-GO)', re.IGNORECASE)
first_line = content.strip().split('\n')[0]
if FAIL_RE.match(first_line): verdict = 'fail'
elif PASS_RE.match(first_line): verdict = 'pass'
```

**Latest-verdict per gate (NE `gates_pass - gates_fail`):** Ha egy ügynök előbb NO-GO-t, majd GO-t adott, az aktuális állapot GO. A `gates_pass - gates_fail` set-különbség ROSSZUL működik -- az early NO-GO törli a later GO-t. Helyette: iterálj chronologikusan és mindig FELÜLÍRD az előző verdiktet ugyanattól a gate-től.

### Atomic port vs. compensation saga (acef8c85 tanulság)
Ha egy multi-leg write (pl. 2-location TRANSFER) kompenzáció-saga (try/catch + visszaíró leg) helyett valódi atomikus portot (`applyDeltas([...])`) használ, a gate checklist eltér:

**Compensation saga (FAIL pattern -- ne fogadd el):**
- Leg 1 succeed → Leg 2 fail → catch → Leg 1 visszavon. Az in-memory store nem tud Leg 2-t elbuktatni, ezért a catch ág dead code a tesztekben → QA FAIL.

**Atomic port (PASS pattern -- ezt keresd):**
1. `applyDeltas([leg1, leg2])` egy hívásban -- mindkettő commit vagy mindkettő rollback
2. In-memory: validate-all-then-apply-all (ha bármelyik elbukna, semmi sem változik)
3. PG: egyetlen `withTenant` tranzakcióban futnak az UPSERT-ek

**Gate checklist atomic port-nál:**
```python
# 1. ALL-OR-NOTHING: ANY leg fails → NEITHER persists
#    - Negatív: source insufficient → source untouched + dest never opened (explicit assert)
#    - Pozitív: happy path → mindkettő a helyes értéken
# 2. PG transaction: tenantScopes === 1 (scripted session, withTenant hívásszám)
# 3. Nincs compensation branch a kódban (dead code nem megengedett)
# 4. Cross-tenant reject: legs straddling tenants → throw, nothing applied
```

Valós eset: acef8c85 -- e42861f QA FAIL (try/catch compensation, dead code), ad61447 QA PASS (applyDeltas port, tenantScopes===1 igazolva, ALL-OR-NOTHING teszt explicit assert mindkét legre).

### Close-as-SATISFIED gate pattern (4073fdb3 tanulság)
Ha egy kártya célja egy guard/feature bevezetése, de a backend azt állítja, hogy a goal MÁR TELJESÍTVE van egy korábbi commit által (nem írtak új kódot), a gate nem kódellenőrzés, hanem MEGLÉVŐ LEFEDETTSÉG VERIFIKÁCIÓ:

1. **Guard LETEZIK**: ellenőrizd, hogy a script/mechanizmus fizikailag jelen van (`ls scripts/...`, `grep -r "..."`).
2. **CI-kötve**: a guard be van kötve a CI pipeline-ba (`.github/workflows/ci.yml` step).
3. **Self-test zöld**: a guard saját önellenőrzése (fixture/self-test) lefut és OK-t ad.
4. **Nem nyit új támadási felületet**: ha nincs új runtime felület -> QA-only gate elég (Cybersec nem kötelező).
5. **pnpm typecheck / tsc clean**: ha a scope tartalmaz tsc-kompatibilis kódot, a typecheck is zöld legyen.

Ha mindez teljesül -> QA PASS verdikt, feltünteted: "close-as-SATISFIED -- a guard már él, no new code."

**no-floating-promises linter specifikus (2026-07-17):** Két különböző bug-osztályt fed le két külön fixture + önellenőrzéssel:
- `floating-authz.fixture.ts`: floating promise (un-awaited async statement) -- linter elkapja
- `misused-thenable-condition.fixture.ts`: `!promise` minta (Promise-as-condition) -- linter elkapja; tsc TS2367/TS2801 NEM kapja el ezt a formát
Mindkét self-test sorának meg kell jelennie a linter kimenetén:
```
no-floating-promises SELF-TEST OK: ...floating-authz.fixture.ts...
condition SELF-TEST OK: ...misused-thenable-condition.fixture.ts...
```
Ha valamelyik hiányzik -> a guard nem teljes -> QA FAIL a hiányzó osztályra.

### WIRING-GAP slice gate checklist (ismétlődő minta)
A "Wire X endpoint" slice kártyák (29aaa2c2 WIRING-GAP gyermekei) egységes mintát követnek:
a handler és a route-policy entry már létezett, csak a `router.register()` hívás hiányzott -> 501 runtime.

**Minimális gate-checklist (append-only http-guard.ts only esetén):**
1. `authorizeScoped(ctx, Action.X)` az ELSŐ hívás a handlerben (grep a handler fájlban)
2. Row-scope ha a kártyán jelezve: `assertXReadScope()` / `RowScope.Own` vs `RowScope.All`
3. Defense in depth: store-val visszakapott sor `tenantId` re-ellenőrzése a handler-szinten
4. Opaque 404: `*NotFoundError` suffix -> 404 via suffix rule (nincs explicit STATUS_BY_NAME bejegyzés szükséges)
5. Teszt: nem 501/NoHandlerError-t dob, hanem domain NotFoundError-t (ez bizonyítja a dispatch-t)
6. Route inventory coherence: `router.registrations()` tartalmazza az új route-ot
7. Nincs route-policy / http-status.ts módosítás (ha a policy entry már létezett és a hiba suffix-kezelt) -> minimális hot-file kollízió

**Cybersec szükséges ha:** row-scoped (own/all), PII-jellegű adat (proof photos, leave records), trust-boundary
**Csak QA:** ha pusztán adminisztratív read (pl. belső audit log, nem user-facing PII)

Valós esetek: 33f5bba8 (estimating-bids POST/GET), 19756eca (proof task-photos GET), ae8c08d7 (leave list GET)

### Gate tiering ajánlás a verdiktben
Minden PASS/FAIL komment végén jelezd, milyen gate-ek szükségesek:
- **Cybersec szükséges**: auth, RBAC, multi-tenant scope, PII, pénz, file-upload, superadmin, publikus endpoint
- **Cybered szükséges**: superadmin write, impersonation, internet-facing, magas-tétű publikus write path
- **Csak QA**: pure FE komponens, error page, i18n, belső audit (nincs új trust-boundary)
Ha a kártyán Cybersec GO vagy Cybered GO már szerepel, ezt is jelezd (ne jelezd szükségesnek, ami már megvan).

### Claim/RBAC-függő FE gate: actor tényleges képességét is ellenőrizd (2026-07-24 tanulság)
Ha egy FE kártya egy "claim" / "assign" / "approve" akciót drótozza be, a tesztek zöldje NEM elég -- ellenőrizd az actor tényleges RBAC képességét is:
1. `git show HEAD:apps/api/src/rbac.ts | grep -A5 'ShiftClaim\|SchedulesWrite\|Action.X'` -- melyik role-oknak van az adott Action-je?
2. Egyeztesd a FE actor-rel (pl. crew): ha a crew NEM szerepel az Action.X-nél -> **dead button** = flow-connectivity finding (Rule 9 QA FAIL).
3. Negatív FE teszt (pl. "crew-nél nincs Claim gomb") NEM elegendő bizonyíték arra, hogy a flow működik -- az RBAC-t forrásból kell olvasni, nem a FE viselkedéséből visszakövetkeztetni.
4. Ha az RBAC hiányzik: a FE-kártyát NEM lehet lezárni az RBAC-fix kártya landolása előtt; az e2e-nek a valódi crew claim-et kell bizonyítania.

Valós eset: 37ee1d6d F1 FE, 36/36 zöld, de crew actor nem rendelkezett SchedulesWrite képességgel -> Cybersec no-go flow-connectivity (813fe1fd kanon fix).

### Staging race: tartalom idegen commitba kerül (2026-07-24 tanulság)
Ha az ügynök kódja nem a saját feature-commitjában landolt (pl. WF-3 -> prettier chore 3a8a055, F1 -> prettier chore 12d1328), de a REVIEW a feature-commitra hivatkozik:
- `git show HEAD:<fajl>` -- ellenőrizd, hogy a tartalom HEAD-en intact-e.
- Ha intact: gate-elj a HEAD-en lévő tartalomra, verdiktben jelezd ("Staging note: tartalom X commitban landolt, HEAD-en intact").
- Ha HIÁNYZIK: QA FAIL -- a kód nincs commitolva, a feature nincs liverálva.

### Validációs hiba -> 500 anti-pattern + kötelező lefedettség (2026-07-24 tanulság, MikroB megerősítve)
Ha egy domain hibaosztály NINCS STATUS_BY_NAME-ben (`apps/api/src/http-status.ts`), az httpStatusForError() 500-at ad vissza -- kliens-hiba esetén is. Ez QA FAIL.

**BLOKKOLÓ gate-szabály (minden gate-en kötelező):** minden ÚJ `*Error` osztályhoz UGYANABBAN a commitban kell:
1. Explicit STATUS_BY_NAME bejegyzés a helyes HTTP státusszal (400/409/403 -- soha ne maradjon 500-ra esve)
2. Explicit `http-status.test.ts` assertion: `expect(httpStatusForError(err('XxxError'))).toBe(YYY)`

Ha a STATUS_BY_NAME bejegyzés megvan DE a teszt hiányzik -> gate finding (nem feltétlenül FAIL ha a kód helyes, de ajánlott follow-up). Ha a STATUS_BY_NAME is hiányzik -> QA FAIL.

Ellenőrzési módszer: `git show <sha> -- apps/api/src/http-status.ts` + `git show <sha> -- apps/api/src/http-status.test.ts` -- mindkettőben keresd az új osztálynevet.

### Rule 13: szülő-konténer 44px NEM egyenlő a gomb érintési célával (2026-07-24 tanulság)
Toggle switcher UI-nál (és hasonló compact interactive element-eknél) tipikus tévesztés:
- A szülő flex-konténer (`min-height: 44px`) megvan -> "Rule 13 compliant"
- DE a benne lévő `<button>` maga csak 28px tall, padding nélkül

**Az érintési cél a gomb padding-box-a, NEM a szülő magassága.** Ha a `<button>` 28px és a flex szülő `align-items: center`, a tényleges tapintható terület 28px marad a 44px-es soron belül.

Helyes ellenőrzés toggle/compact button-nál:
1. Megnézni a button saját CSS-ét (`height`, `min-height`, `padding`) -- ezek adják az effektív célterületet
2. Ha `height < 44px`: szükséges `padding` (pl. `padding: 8px 0` -> 28+16=44px) VAGY pseudo-elem hit-area (`::before { content:''; position:absolute; inset:-8px 0; }`)
3. Label (`<label>` wrapping `<input type=checkbox>`): önmagában is min 44px kell, nem csak a checkbox

Valós eset: 8eff0988 F2-FE AvailabilityPage -- avp-toggle (28px), avp-allday-label (24px), avp-time-input (36px) -> QA FAIL.

### "Részleges REVIEW" kezelése (2026-07-24 tanulság)
Ha az agent REVIEW kommentben maga jelzi, hogy az acceptance criterion NEM teljesül ("EMPIRIKUSAN NEM oldja meg a bugot", "ÖNMAGÁBAN NEM elég a card acceptance-jéhez"):
- Ez automatikusan QA FAIL -- nem kell részletesen verifikálni a teljes kódbázist
- A REVIEW-ban közölt repro (pl. "5/9 live e2e buktatás változatlan") önmaga a bizonyíték
- Kommentben idézd az agent vallomását, és add meg a következő javasolt lépést
- A kártyát `in_progress`-be kell mozgatni (van még tennivaló), MikroB iránymutatással ha az agent azt kérte
- A részleges fix értékét ismerd el (pl. "hasznos tranziencia-javítás"), de a card acceptance = zöld acceptance criterion

### QA FAIL kártyák stuck-in-waiting (board reconciliation)
Előfordul, hogy egy kártya QA FAIL verdikt után is `waiting` státuszban marad (ahelyett, hogy `in_progress` lenne). Ez akkor történik, ha:
- A QA FAIL comment kiírásra kerül, de a `move` API hívás elmarad (pl. context compaction közbeni megszakítás)
- Egy korábbi gating kör a FAILt nem követte status-mozgatással

Detekció a self-advance scan során: ha egy `waiting` kártyán van QA FAIL (nem csak QA PASS), az hibás állapot. Move parancs:
```bash
printf 'Authorization: Bearer %s\n' "$TOKEN" \
| curl -H @- -s -X POST http://localhost:3420/api/kanban/<id>/move \
  -d '{"status":"in_progress"}'
```
Valós eset: 8545ed3f + d9ff65ae -- mindkettő `waiting`-ben volt QA FAIL-lel.

### In_progress+REVIEW+QA (beragadt kártyák)
Ha egy `in_progress` kártyán REVIEW komment és QA PASS is van (de a kártya nem moved `waiting`-re), az beragadt. Ezeket NE zárd done-ba -- flageld MikroB-nak board-reconciliation üzenetben: `POST /api/messages from:qa to:mikrob`.

### Proaktív re-gate REVIEW nélkül (fix-commit elég)
Ha egy kártya QA FAIL oka konkrét és egy másik commit PONTOSAN azt pótolja (pl. "nincs test file" FAIL + azóta valaki committol egy test fájlt), NE várj új REVIEW kommentre -- ellenőrizd:
1. A commit message hivatkozik-e a FAIL-re vagy a kártya scope-jára?
2. A kommittált teszt lefedi-e a konkrét FAIL-okot?
Ha igen -> futtasd a teszteket és post QA PASS a legújabb committal. Ez gyorsítja a flottát.
Valós eset: be90f1f2 ("no test file" FAIL) -- 4e6d59a commitolta a tesztet, proaktív re-gate 28/28 PASS.

### Batch re-gate fix-commit scopeból (MW-pattern)
Ha egy fix commit több kártyát fed le egyszerre (pl. "replace stale DEMO_* tests (MW-03..08)"):
1. Azonosítsd a commit stat-jából melyik tesztfájlok változtak
2. Párosítsd kártyával (title/scope alapján)
3. Futtasd az összes érintett tesztfájlt egyszerre
4. Post QA PASS mindegyik kártyára (utalj a közös commitra és az összesített eredményre)
5. Move mindegyiket `waiting`-be
NE várj kártyánkénti REVIEW re-submitra -- a commit önmagában elég bizonyíték.
Valós eset: cd43c06 6 kártyát fedett le (WorkerList, SiteList, Offers, ChecklistPage, ProofList, SiteDetail) -- egyetlen test-run, 101/101 PASS, 6 kártya egyszerre gate-elve.

### FAKE-SUCCESS demo-fallback (F4-FE c764ec8 tanulság -- Rule 9 + Rule 12 sértés)
Contract-first FE-nél elfogadható a DEMO adat betöltése ha a BE pending. De SOHA nem elfogadható,
hogy egy destruktív akció (törlés, mentés, küldés) a pending BE-t azzal hidalja át, hogy
SIKERREL tér vissza -- "onDeleted()" / "onSuccess()" hívása az API call kihagyásával:

```tsx
// ANTI-PATTERN:
async function handleDelete() {
  // F4-BE pending -- skip actual API call in demo
  onDeleted()  // HAMIS siker, semmi sem történt
}

// HELYES: ha BE pending, tiltsd le a gombot
<button disabled title="F4-BE pending">Törlés</button>
// VAGY: hívd meg az API-t, kezeld a 404/501-et gracefully
```

**Ellenőrzés**: minden write-action (create/update/delete/submit) handler-ben ellenőrizd, hogy az
API hívás MEGTÖRTÉNIK. Ha `onSuccess()` / `onDeleted()` / `navigate()` az API await ELŐTT vagy
NÉLKÜL van -- az FAKE-SUCCESS -> QA FAIL (Rule 9: no no-op action, Rule 12: no fake success UI).

**Git grep**: `git show <sha>:path/Page.tsx | grep -n 'onDeleted\|onSuccess\|navigate('` -- ha a
hívás MEGELŐZI az `await api.call()` sort, gyanús. Párosítsd a függvény törzsével.

Valós eset: 406f6ac2 F4-FE ShiftTemplatesPage handleDelete() -- soha nem hívja deleteShiftTemplate(), rögtön onDeleted(). Zero teszt is ugyanabban a commitban. QA FAIL.

### Rule 9 ellenőrzés stale-test javítás UTÁN
Stale DEMO_* teszt javítása után a tesztek zöldre váltanak -- de ez nem jelenti, hogy minden Rule 9 probléma megoldódott. Külön ellenőrizd:
- Van-e a komponensben no-op gomb (nincs `onClick`, nincs `disabled`, mégis kattintható)?
- Ha igen: Rule 9 FAIL, még ha 100% is a tesztek.
Keresés: `grep -n 'type="button"' FILE.tsx | grep -v 'onClick\|disabled\|aria-disabled'`
Valós eset: 1a1b9706 (ChecklistPage) -- 38/38 PASS, de 3 template sor-szintű gomb onClick nélkül. qa2 megtalálta -> QA2 FAIL overrode a korábbi QA PASS-t.

### qa2 FAIL override a QA PASS után
A chronologikus latest-verdict rendszer azt jelenti, hogy qa2 adhat FAIL verdiktet UTÁN, hogy én QA PASS-t adtam. Ez helyes -- a legfrissebb győz. Ha qa2 FAIL-t ad:
- Olvasd el a teljes qa2 FAIL content-et
- Ha legitim finding -> fogadd el, move to in_progress
- Ha téves -> kommenteld ki (de ne overrode-old a FAIL-t PASS-szal, ha nincs új fix commit)

### Fake-setTimeout anti-pattern (Rule 12 + Rule 9)
A `setTimeout(() => setPending(false), N)` jellegű fake delay **QA FAIL** -- nem valós API callback, hanem optimista UI hazugság:
- A felhasználó sikeresnek látja a műveletet akkor is, ha a szerver hibát adott
- Ha a hálózat lassabb a delay-nél, a pending state korán törlődik (hamis OK)
- Rule 9: a gomb "kattintható" de nem vezet valós eredményre
Keresés: `grep -n "setTimeout" apps/web/src/features/**/*.tsx`
Jó csere: `await apiCall(...)` a handler-ben, `.catch(err => setError(t('...')))`; state `setPending(true)` előtte, `finally { setPending(false) }`. Ha a fron-ted kódjában van fake delay és nincs valós API call a hatáskörébe tartozó kártyán, QA FAIL.

### Promise.allSettled párhuzamos selector-betöltés
Form page-eknél (pl. NewShiftPage, NewSitePage) ahol több független dropdown-t kell feltölteni:
```typescript
// JÓ: mindkét fetch párhuzamosan fut, egyik failure nem blokkolja a másikat
const [sitesResult, workersResult] = await Promise.allSettled([
  listSites(1, 100),
  listWorkers(1, 100),
])
setSites(sitesResult.status === 'fulfilled' ? sitesResult.value.items : [])
setWorkers(workersResult.status === 'fulfilled' ? workersResult.value.items : [])
```
QA ellenőrzés: ha több selector párhuzamosan töltődik de `Promise.all`-lal (nem `allSettled`), az egyik failure az egész form-ot töri el -- ez QA FAIL. Az `allSettled` a helyes pattern: részleges sikerrel a form is elindulhat.

### Async durable-before-ack tesztelés (8deac0b2 tanulság)
Amikor egy szinkron audit/perzisztencia útvonalat async-re refaktorálnak (pl. PlatformStore audit metódusok Promise-t adnak vissza), két dedikált tesztet kell keresni:
1. **Throws -> reject, nem ack-elt**: `commitAppend` kivételt dob -> `appendAuditState` rejectál ÉS a bejegyzés NEM kerül az ack-olt chainbe. Ellenőrzés: `expect(chain.entries).toHaveLength(0)` a reject után.
2. **Delayed commit -> ack csak a write resolve után**: késleltetett `commitAppend` -> az ack CSAK a Promise resolve-a után történik meg. Ellenőrzés: a store üres amíg a delayed write le nem fut.

Ha ezek a tesztek hiányoznak, a durable-before-ack garancia üres ígéret -- jelezd QA FAIL-ként ("durable-before-ack nincs tesztelve").

**no-floating-promises lint futtatása**: a `pnpm lint:floating` wrapper `ERR_PNPM_IGNORED_BUILDS` miatt failelhet a dev-envben. Ha ez előfordul, futtasd közvetlenül:
```bash
node scripts/lint-no-floating-promises.cjs
```
A self-test sorának meg kell jelennie: `no-floating-promises SELF-TEST OK: the deliberately floating authz in the fixture is detected`. Ha a self-test NEM jelenik meg (timeout/error előtte), a lint eredménye nem megbízható.

### Guard ordering oracle ellenőrzés (4cc61ebe tanulság)
Amikor egy write-path guard (pl. site-access check) a run/entity betöltése UTÁN fut (mert szüksége van annak egy mezőjére, pl. `run.siteId`), intra-tenant existence oracle keletkezhet:
- Nem létező run -> 404
- Létező run, de a caller nincs a megfelelő site-en -> 403

Ez belső-tenanten belüli oracle (nem cross-tenant szivárgás). QA scope-ban:
- Ha a guard logikailag helyes és a tenant-scope invariáns tartja magát -> **nem QA FAIL** (funkcionálisan helyes)
- Jelzd LOW findingként és delegáld Cybersecnek (ők döntik el, kell-e uniform 404)
- Az "opaque" claim CSAK akkor tartható a start/create path-on (ahol a guard az adatlekérés ELŐTT fut)

Ellenőrizd a `??` fail-closed defaultot is: ha az AppDeps mezője optional (`workerSiteAccess?`), az `assembleAppRouter`-ben legyen `?? createInMemory...()` (empty seed = deny all), különben egy unwired router silently allow-ol -- ez QA FAIL.

### Rule 12 error-state checklist (visszatérő FAIL minta)
Minden FE komponens `error` state-je három feltételt kell teljesítsen (Rule 12):
1. **Beszédes üzenet** -- i18n kulcsból, érthető szöveg (nem nyers HTTP kód)
2. **Akciógomb** -- retry / vissza / kapcsolat opció KÖTELEZŐ (puszta `<p>` FAIL)
3. **Retrigger mechanism** -- a useEffect-nek legyen `retryKey` state a dep array-ben, különben a gomb kattintás nem csinál semmit

```tsx
// ROSSZ -- Rule 12 FAIL: csak szöveg, nincs akció, useEffect nem triggerelhető
{loadState === 'error' && (
  <p className="some-error">{t('error.generic')}</p>
)}
useEffect(() => { fetchData() }, [])  // üres dep -> nincs retry trigger

// HELYES -- Rule 12 PASS
const [retryKey, setRetryKey] = useState(0)
useEffect(() => { fetchData() }, [retryKey])  // retryKey a dep-ben
{loadState === 'error' && (
  <div role="alert">
    <p>{t('some.errLoad')}</p>
    <button type="button" onClick={() => setRetryKey(k => k + 1)}>
      {t('common.retry')}
    </button>
  </div>
)}
```

**useCallback alternatíva** (ha a fetch logika több helyről is kell):
```tsx
const loadData = useCallback(() => { ... }, [deps])
useEffect(() => { loadData() }, [loadData])
// retry gomb: onClick={loadData}
```

**Ellenőrzési séma kártyánként**:
```bash
# 1. Error state szöveg mellett van-e gomb?
grep -n "error\|Error" FILE.tsx | grep -v "//\|setError\|useState\|interface"
# 2. Van-e retryKey state vagy useCallback?
grep -n "retryKey\|retryCount\|useCallback" FILE.tsx
# 3. Minden useEffect dep array tartalmaz-e retry triggert?
grep -n "useEffect" FILE.tsx
```

**Valós esetek**:
- `BusinessHub.tsx` (11e564bc) -- `loadState==='error'` -> csak `<p>`, `useEffect([], [])` üres dep -> QA FAIL
- `PortalSlaScorecard.tsx` (410d11a2) -- `loadState==='error'` -> csak `<p>`, `useEffect([siteId])` dep-ben nincs retry -> QA FAIL
- `PortalQualityPage.tsx` (e4cd0b06) -- `retryKey` state + dep + retry gomb -> QA PASS (referencia implementáció)

### "REVIEW" szó != review-kész (6c5052b8 tanulság)
A `REVIEW` szó megjelenése egy kártya kommentjeiben NEM jelenti automatikusan, hogy a kártya gate-re kész. Három különböző kontextus:
- **Cybersec preliminary note**: "FORMAL GATE DEFERRED to when 6c5052b8 reaches REVIEW" -- jövőbeli, a kártya még in-progress
- **Blokkolt waiting**: "NEM done -> WAITING, 3 fuggoseg miatt" -- a kártya waiting de nem complete; az author EXPLICITON mondja "NEM done"
- **Valódi REVIEW signal**: "REVIEW: munka kész, [commit sha], gate-eljetek" -- az author befejezettnek nyilvánítja

Detekció: ha a legfrissebb "REVIEW" komment szerzője + tartalma "NEM done" / blokkolt-függőségeket sorol fel / jövőbeli gate-re utal -> NE gate-elj. Csak gate-elj, ha az author egyértelműen lezártnak nyilvánítja (commit sha + "REVIEW" vagy "KÉSZ" + nincs nyitott blokkológ).

### Role-literal vakuum: tesztek zöldek mert a mock a bugos string-et használja (1a47cac2 tanulság)
Ha egy domain-szintű role-check (pl. `isWarehouseKeeper(ctx)`) saját belső string-konstanst ('warehouse_admin')
keres `ctx.roles`-ban, DE a valódi `MembershipRole` enum értéke eltér ('warehouse'), a tesztek
80/80 zöldek lehetnek -- mert a teszt-mock is a bugos stringet adja.

**Ellenőrzés domain role-check esetén:**
1. Megnézni a domain kódban milyen string-et keres: `grep -n 'isWarehouse\|hasRole\|ctx.roles' apps/api/src/<domain>.ts`
2. Összehasonlítani a valódi `MembershipRole` enum értékekkel: `grep -n 'WarehouseKeeper\|warehouse' apps/api/src/identity.ts`
3. Ha eltérnek -> a 100% zöld teszt vákuum (a mock a bug-stringet adja, a valódi session más stringet)

**Helyes pattern:** a tesztnek a valódi `MembershipRole.WarehouseKeeper` konstanst kell mock-ban használni,
NEM hardcoded string literált. Így ha a domain kód is a valódi MembershipRole-t kereső kódot kap,
az eltérés teszthiba -> látható QA FAIL, nem rejtett bug.

**Gate-eléskor kötelező:** ha BE kártya domain role-checkkel jár, futtasd:
```bash
grep -n "ctx.roles\|hasRole\|isX(" apps/api/src/<domain>.ts
grep -n "MembershipRole\." apps/api/src/identity.ts
# Párosítsd: a kért string-literál megvan-e az enum-ban?
```
Ha a domain saját belső string-et keres (nem `MembershipRole.X`), az RBAC szétcsúszás kockázata -- QA finding.

Valós eset: 1a47cac2 -- `isWarehouseKeeper` 'warehouse_admin'-t keresett, `MembershipRole.WarehouseKeeper = 'warehouse'`. 80/80 PASS (vákuum), Cybersec NO-GO elo reprodukcioval. QA PASS -> Cybersec NO-GO lánc.

### In-memory store + periodikus refresh gate-elése (27d5c8d7 tanulság)
Ha egy periodikusan újratöltődő in-memory store-t gate-elsz (pl. superadmin account store 90s refresh), a kritikus tulajdonság: a "burned" / egyszer felhasznált state SOHA NEM KERÜL VISSZA ÁLLÍTÁSRA refresh után.

Kötelező ellenőrzési séma:
1. **Szeparáció igazolása**: a "burns" (pl. TOTP step) külön Map-ben él a "roster"-től. A `loadRoster()` CSAK a roster-t cseréli, a burns Map-et NEM érinti.
2. **withBurn() max-merge**: `step = max(DB-row ?? burn, in-memory-burn)` -- ha a DB-sor régebbi (stale, pl. `totpLastUsedStep: null`), az in-memory burn még mindig érvényes.
3. **burn-survives-refresh teszt bizonyíték**: a tesztnek explicit mutable-loader patternnel kell igazolnia:
   ```typescript
   // Égess -> stale DB-t tölts be -> ellenőrizd, hogy az égés megmarad
   expect(store.burnTotpStep('sa-1', 5)).toBe(TotpStepBurnOutcome.Burned)
   m.set([sa({ totpLastUsedStep: null })]) // stale DB row
   await store.refresh()
   expect(store.burnTotpStep('sa-1', 5)).toBe(TotpStepBurnOutcome.AlreadyUsed) // burn megőrzve
   ```
4. **findByToken=null**: magic-link accountoknak nincs static bearer -> `findByToken` mindig null
5. **Boot-seed**: a konstruktor await-eli a loadRoster()-t -- `findById` azonnal megoldható

Ha ezek bármelyike hiányzik -> QA FAIL.

### async useCallback void-swallow csapda (FORM-4 tanulság)
Ha egy `useCallback` async betöltő függvényt `void fn()` alakban hívnak, a rejectiont a hívó elnyeli. Ha a `useCallback`-ben nincs `catch` ág (csak `finally`), az összes hálózati/5xx/auth hiba csendben eltűnik: a loading törlődik, de sem error üzenet, sem retry gomb nem jelenik meg.

```typescript
// ROSSZ -- Rule-12 FAIL: csak finally, nincs catch
const loadPlan = useCallback(async () => {
  setLoading(true)
  try {
    const plan = await getPlan(id)
    setPlan(plan)
  } finally {
    setLoading(false)   // void loadPlan() swallowol minden rejectiot
  }
}, [id])
useEffect(() => { void loadPlan() }, [loadPlan])
// 500 hiba esetén: loading=false, plan=null, nincs hibaüzenet -> üres néma oldal

// HELYES -- catch ág + error state + retry
const [loadError, setLoadError] = useState<string | null>(null)
const loadPlan = useCallback(async () => {
  setLoading(true); setLoadError(null)
  try {
    const plan = await getPlan(id)
    setPlan(plan)
  } catch {
    setLoadError(t('module.loadError'))
  } finally {
    setLoading(false)
  }
}, [id, t])
// render: if (loadError) return <div role="alert">{loadError}<button onClick={() => void loadPlan()}>{t('common.retry')}</button></div>
```

**Detekció (kötelező minden betöltő useCallback-nél):**
```bash
# Van-e catch ág? (csak finally = gyanús)
git show <sha>:apps/web/src/features/<mod>/<Page>.tsx | grep -A20 "useCallback.*async\|async.*useCallback" | grep -c "catch"
# Ha 0 -> QA FAIL (Rule-12: silent error state)

# void hívás pattern keresése
grep -n "void.*load\|void.*fetch\|void.*get" apps/web/src/features/<mod>/<Page>.tsx
```

**Speciális eset: needs-build endpoint `null`-visszatérés vs. dobott hiba.** Ha az API fn `isNeedsWiring(err)` alapján `null`-t ad vissza (404/501), az nem dob -- ezt `if (!plan) { setNotFound(true) }` kezeli. DE ha a szerver 500-at dob, a `toFormApiError` dobja és a catch nélküli `useCallback` nyeli el. Mindkét utat külön tesztelni kell: (a) needs-build → notFound state, (b) 500 → error state + retry.

### Cancelled flag useEffect cleanup
`useEffect`-ben async fetch után state update szükséges -- de ha a component unmountol, a state update memory leak + "Can't perform a React state update on unmounted component" warningot okoz:
```typescript
useEffect(() => {
  let cancelled = false
  fetchData()
    .then(data => { if (!cancelled) setData(data) })
    .catch(err => { if (!cancelled) setError(err.message) })
  return () => { cancelled = true }  // cleanup
}, [id])
```
QA ellenőrzés: ha egy async useEffect nem tartalmaz cancelled/isMounted flag-et vagy AbortController cleanup-ot, és a component navigáció közben unmountolhat (pl. detail page), ezt jelezd LOW findingként.

### Atomic lockout adapter gate (recordAttempt pattern -- 3d65e1c5/6c5052b8 tanulság)
Amikor egy adapter `recordAttempt(accountId, evaluate)` callback-port mintát valósít meg (LockoutStore), ellenőrizd:

1. **Tranzakció**: a `pool.transaction()` callback mindhárom műveletet lefedi (INSERT + SELECT + UPDATE) -- a teszt `inTx` flag igazolja
2. **Row lock**: `SELECT ... FOR UPDATE` (nem sima SELECT) -- injection-safe, bound param `$1`
3. **Ensure-row**: `INSERT ... ON CONFLICT (account_id) DO NOTHING` ELŐTTE (két párhuzamos első kísérlet közül a vesztes DO NOTHING-et kap)
4. **Evaluate az AUTHORITATIVE state-en**: az evaluate függvény a `SELECT FOR UPDATE` után kapott sort kapja, nem a `get()` stale értékét
5. **Re-gate az evaluate-ban**: ha a domain `checkLockout(current, nowMs)` `blocked=true`-t ad, az evaluation visszaadja a blocked döntést `next=current`-tel (nincs counter-növelés)
6. **Bound params a write-nál**: az UPDATE minden értéke `$1,$2,...` -- a teszt ellenőrzi, hogy a SQL szöveg nem tartalmaz plain számokat

Teszt detekció:
```bash
# Ellenőrizd, hogy mind a 3 SQL op tranzakcióban fut (inTx=true)
grep -n "inTx\|FOR UPDATE\|DO NOTHING\|transaction" apps/api/src/*lockout*.test.ts
# Ellenőrizd, hogy a CAS re-gate path tesztelve van
grep -n "reGate\|blocked.*current\|checkLockout" packages/*/src/*password-login*.ts
```

### Payment webhook gate checklist (bb48709a előkészítés)
Pénz-útvonalon (webhook settle handler) ezeket kötelező ellenőrizni:

1. **Amount reconciliation**: `event.amountCents === invoice.expectedAmountCents` KÖTELEZŐ a settle előtt. "Authentic" (valid HMAC) != "correct for this invoice" -- egy másik tenanthoz vagy összeghez szóló legit event ne settle-eljen.
2. **VAT-aware compare (MoR)**: LemonSqueezy webhook `total` = BRUTTO (VAT-val), az invoice = NETTO. Ne naiv == összehasonlítás -- VAT-tudatos reconcile invariant kell (konfigurált VAT-rate a domain-ben, nem a webhook-ból).
3. **Idempotency**: `(provider, providerEventId)` UNIQUE constraint + idempotent settle (pl. `INSERT ... ON CONFLICT DO NOTHING` + settled invoice statecheck). Dupla webhook delivery ne double-settle-eljen.
4. **Tenant/invoice re-check settle előtt**: az invoice `ctx.tenantId` alatt LÉTEZIK és PENDING státuszú. Nem elég a webhook tenantId claim -- a DB-ből kell olvasni.
5. **Raw bytes a verify-nek**: a HTTP réteg a MÓDOSÍTATLAN nyers body byte-okat adja át a `verifyAndParseWebhook`-nak (nincs JSON round-trip, nincs charset transzformáció előtte).
6. **LS replay defense**: a LemonSqueezy webhook-ban nincs timestamp tolerance (csak HMAC) -- a domain idempotency guard (`assertPaymentEventNotReplayed` a `providerEventId`-val) compensálja. Ellenőrizd, hogy ez a reconcile ELŐTT hívódik.
7. **Vault/env runtime secret**: payment API kulcsok + webhook secret env-ből jönnek, nem hardcoded. Boot-refuse ha hiányzik prod-on (lásd SESSION_KEY minta).
8. **No leaked keys**: `JSON.stringify(checkoutSession)` nem tartalmazhat `apiKey`/`webhookSecret` mezőt (a tesztben ellenőrzött).

Detekció pattern:
```bash
# Amount reconciliation megvan-e?
grep -n "amountCents\|expectedAmount\|reconcil" packages/*/src/*settle*.ts
# Idempotency constraint a migrációban?
grep -rn "providerEventId\|provider_event_id" packages/*/migrations/
# Raw body path a route-ban?
grep -n "rawBody\|raw_body\|verifyAndParse" apps/api/src/routes/*.ts
```

### Pure domain + injected port gate checklist (6bde1999 tanulság)
Amikor egy kártya dependency-free pure domain modult vezet be (0 IO, injektált port), a gate checklist eltér a HTTP/adapter kártyáktól:

**1. Actor/tenant forrás (KÖTELEZŐ első ellenőrzés):**
```bash
git show <sha>:packages/modules/<mod>/src/<mod>.ts | grep -n "ctx\.\|requireTenant\|requireActor\|body\."
# Minden workerId/userId -> ctx.userId (SOHA nem body.*Id)
# Minden tenantId -> requireTenant(ctx) (SOHA nem body.tenantId)
```

**2. SoD (Segregation of Duties) ellenőrzés:**
- Megvan-e az `actor === resourceOwnerId -> SpecificSoDError` guard?
- Mindkét oldal ctx-ból jön-e? (nem bypassolható)
- Tenant guard ELŐBB fut-e a SoD-nál? (CrossTenantAccessError, nincs per-resource szivárgás)

**3. Workflow transitions fail-closed:**
```bash
git show <sha> -- '*.ts' | grep -n "status !== \|status ==" | head -20
# Pending-ból lehet dönteni; terminal state-ből nem (throw LeaveTransitionError/hasonló)
```

**4. Foreign row filtering (balance/availability):**
```bash
git show <sha> -- '*.ts' | grep -n "filter\|tenantId.*workerId\|tenantId.*type"
# Defense-in-depth: filter(r => r.tenantId===tenantId && r.workerId===workerId && r.type===type)
# Nincs bízás a hívó szűrésében
```

**5. Injected port: validáció ELŐTTE, port UTÁNA:**
```bash
git show <sha> -- '*.ts' | grep -n -A5 "function presign\|async function.*Port\|port\."
# assertSameTenant / scope-check -> documentKeyFor/objectKey build -> port.presignUpload(...)
# Traversal reject (/ és ..) a port előtt
```

**6. Immutability (transitions új objektumot adnak vissza):**
```bash
git show <sha> -- '*.ts' | grep -n "return { \.\.\.leave\|return { \.\.\.entity"
# Spread + override -> új objektum; az eredeti érintetlen
```

**7. Non-vacuous tesztek (a legfontosabb):**
- Balance teszt: konkrét napszámokat assertál (usedDays=5, pendingDays=2, remaining=13) -- nem csak "no throw"
- Port-spy teszt: `recordingPort()` + `expect(port.calls).toHaveLength(0)` cross-tenant/traversal esetén -- igazolja, hogy a port NEM hívódik meg bad input-ra
- SoD teszt: `expect(() => approve(workerCtx, ownLeave)).toThrow(LeaveSelfApprovalError)` -- konkrét error class

**8. tsc projekt-szintű:**
```bash
npx tsc --noEmit 2>&1 | grep "<module-name>" | head -10
# 0 hiba -> PASS
```

**Valós eset (6bde1999 @ 61ea236):** 21/21 non-vacuous unit test, mind a 8 pont ✓ -> QA PASS. Cybersec külön gateeli (SoD/RBAC trust-boundary, PII).

### Külső API proxy endpoint QA checklist (d702d593 tanulság)
Ha egy kártya publikus külső API-t proxyzó endpointot vezet be (pl. HuggingFace, GitHub, npm), a funkcionális QA az alábbi sorrendben fut:

**1. Paraméter sanitizáció élő tesztelése (curl-lal):**
```bash
TOKEN=$(cat store/.dashboard-token)
BASE="http://localhost:3420"

# Rosszindulatú sort/task/type param -> default-ra kell esni
printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -H @- -s "$BASE/api/endpoint?sort=__proto__" | python3 -c "import json,sys; d=json.load(sys.stdin); print('sort:', d.get('sort'))"
# -> 'downloads' (nem '__proto__')

# Injection a query stringben -> charset strip
printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -H @- -s "$BASE/api/endpoint?query=qwen%3Cscript%3E" | python3 -c "import json,sys; d=json.load(sys.stdin); print('query:', repr(d.get('query')))"
# -> 'qwen script' (tag-ek eltávolítva)

# Limit clamp
printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -H @- -s "$BASE/api/endpoint?limit=9999" | python3 -c "import json,sys; d=json.load(sys.stdin); print('limit:', d.get('limit'))"
# -> MAX_LIMIT (pl. 30)
```

**2. Auth gate (unauthed 401):**
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3420/api/endpoint
# -> 401
```

**3. Élő eredmény valósság-ellenőrzés:**
```bash
printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -H @- -s "$BASE/api/endpoint?query=test&limit=3" | python3 -c "
import json,sys; d=json.load(sys.stdin)
print('count:', d.get('count'))
for r in d.get('results', [])[:2]:
    print(' id:', r.get('id'), 'field:', r.get('expected_field'))
"
```

**4. Válasz-mezők teljessége:**
- Minden eredménynek van `id` (nem üres string)
- Számszerű mezők (`downloads`, `likes`) `Number.isFinite`-elve, nem NaN/null
- GGUF/flag mezők boolean (nem string)
- `ollama_pull` / action-hint csak akkor set, ha tényleg elvégezhető (pl. csak GGUF modellre)

**5. i18n paritás:**
```python
import re
en_keys = set(re.findall(r"'(SECTION\.[^']+)'", open('web/lang/en.js').read()))
hu_keys = set(re.findall(r"'(SECTION\.[^']+)'", open('web/lang/hu.js').read()))
print('missing HU:', en_keys - hu_keys)
print('missing EN:', hu_keys - en_keys)
```

**6. Error state-ek (Rule-12):**
- HTTP nem-OK: `d.error` / `t('..error..')` jelenik meg (nem nyers státuszkód)
- Hálózati hiba (fetch exception): `catch` ág `t(key)`-vel ír UI-ba
- Üres eredmény: empty state üzenet (nem blank)
- Betöltési state: spinner/loading szöveg

**Valós eset (d702d593 @ e2ff3ce):** HuggingFace GGUF-kereső proxy. Összesített ellenőrzés: sort=__proto__ -> downloads, task=MALICIOUS -> text-generation, injection stripped, limit=200 -> 30, 401 unauthed, élő találatok (Qwen3-Coder-30B stb.), 34/34 i18n kulcs, minden error state lefedve -> QA PASS.

### IA/flow-map gate (Rule 9 ellenőrzés design artifacton -- 99a7c66c tanulság)
Amikor egy IA/user-flow térképet gate-elsz (nem kód, hanem tervezési artifact), a flow-connectivity labeleket az AKTUÁLIS route-policy + http-guard ellen kell ellenőrizni -- a fejlesztő állítása nem elegendő.

**Két irányú mislabel lehetséges:**
1. `[needs-build]`-ként jelölt, de TÉNYLEG WIRED → non-blocker finding (mislabel, de nem dead-end)
2. A user journey tartalmaz egy lépést, ami nincs jelölve `[needs-build]`-ként, és a BE SEM LÉTEZIK → blocker (unlabeled dead-end, Rule 9 FAIL)

```bash
# Gyors ellenőrzés: szerepel-e az endpoint route-policy-ban?
grep -n "ENDPOINT_PATH" apps/api/src/route-policy.ts apps/api/src/http-guard.ts
# Ha nincs találat -> [needs-build] (ha az IA nem jelöli, QA FAIL)
```

**Valós esetek (99a7c66c):**
- `/workers/:userId/performance` + `/reviews`: IA `[needs-build]`-nek jelölte, de http-guard.ts:536+539-ben WIRED → Finding 1 (mislabel)
- `/portal/sites/:id/visits/:visitId`: Flow E-ben szerepel, de nincs BE endpoint, és az IA sem jelöli `[needs-build]`-ként → Finding 2 (blocker)

**Gate logika design artifactnál**: nincs futtatható teszt → a gate eredménye: (a) flow-connectivity labelek pontossága, (b) minden user journey lépés vagy WIRED vagy expliciten `[needs-build]`, (c) nincs néma zsákutca.

### Demo-fallback fake-success (Rule 12 -- PortalVisitDetail tanulság)
Bármely komponens, ami hardcoded fake adatot renderel üres state esetén, Rule 12 FAIL:

```tsx
// FAIL -- fake-success: a user "Kovács Jánost" lát, holott nincs valós adat
const entry = entries.find(e => e.id === visitId)
const demo = entry ?? {
  id: visitId ?? 'demo',
  cleanerName: 'Kovács János',   // hardcoded
  qaScore: 91,                    // hardcoded
}
// Ettől fogva `demo`-t rendereli, soha nem látja az empty state-et
```

```tsx
// HELYES -- explicit empty state, nincs fake
if (!entry) return <p className="vd-empty">{t('portal.visitNotFound')}</p>
// Vagy: valos API hívás a vizit adataiért
```

**Detekció:**
```bash
grep -n "?? {" apps/web/src/features/**/*.tsx | grep -v "//\|node_modules"
# Bármely `?? { id:` / `?? { name:` / `?? { score:` pattern gyanús
grep -n "demo\|fallback\|mock\|placeholder" apps/web/src/features/**/*.tsx | grep "const \|= {" | grep -v "//\|test"
```

**Valós eset**: `PortalVisitDetail.tsx:100-110` -- `entry ?? { cleanerName: 'Kovács János', qaScore: 91 }` üres entries esetén is mutat tartalmat. Rule 12 FAIL (a) a fake-success miatt, (b) mert a BE endpoint (`GET /portal/sites/:id/visits/:visitId`) nem létezik → unlabeled gap.

### CSP sweep tesztreferencia-regresszió (2026-07-16 tanulság)
CSS osztály-átnevezéssel járó CSP sweep után a tesztek is elcsúszhatnak:
- Tipikus minta: `alert.querySelector('a.btn')` -> osztályt átnevezték `vy-cta-btn`-re -> teszt null-t kap és FAIL-el
- Ellenőrzés: minden CSS className-re hivatkozó teszt-szelektort (`querySelector('.foo')`, `getByRole` aria-label, stb.) összevetni a commit diff-jével
- Módszer: `git show <sha> -- '*.tsx' '*.test.tsx' | grep "^[+-].*className"` -- ha egy className eltűnik a TSX-ből, keresni a tesztben is

### Rule 13 kis gombok csapdája (2026-07-16 tanulság)
Kisebb/"coming soon" vagy dekoratív gombok is interaktív elemek, és a 44px küszöb rájuk is vonatkozik:
- Csapda: `min-height: 34px` egy `disabled` attribute-tal rendelkező "coming soon" gombra -- Rule 13 FAIL
- BASE szabályban kell a >=44px, nem csak a mobile breakpointban
- Ellenőrzés: minden `button`, `<a>`, `role="button"` elemre a kapcsolt CSS osztályban keresni a `min-height` értékét, és BASE vs. breakpoint scope-ot ellenőrizni

### Atomic UPSERT adapter gate (566214a7 tanulság)
Egyetlen-statement atomi UPSERT adapter gate-elésekor az alábbi checklist kötelező:

1. **Egy statement**: a teszt igazolja, hogy pontosan 1 SQL query fut (`expect(sql.calls).toHaveLength(1)`)
2. **Kizárólag bound paraméterek**: a `params` array tartalmaz minden értéket, a SQL szövegben nincsenek interpolált literálok (`expect(text).not.toMatch(/'\w+'/)` vagy pozitív: `expect(params).toEqual([...bound values...])`)
3. **SQL shape assertion**: a `text` tartalmaz `ON CONFLICT ... DO UPDATE`, `WHERE ... >= 0`, `RETURNING` kulcsszavakat
4. **Dual fail-closed path**:
   - *0 rows* (meglévő sor, WHERE kizárta): `{ rows: [], rowCount: 0 }` → `InsufficientStockError`
   - *CHECK violation 23514* (új sor, negatív delta): `throw Object.assign(new Error(...), { code: '23514' })` → `InsufficientStockError`
5. **Nem-constraint hiba propagálódik**: egyéb DB hiba (`code: '08006'`) nem swallow-olódik `InsufficientStockError`-ként
6. **NUMERIC coercion**: a PG NUMERIC típus stringként érkezik (`quantity: '13.5'`) → `Number()` kell; teszteld explicit string inputtal
7. **In-memory referencia length-prefixed kulcs**: `${t.length}:${t}|${a.length}:${a}|${l}` injektív (tenant-boundary safe); tenant-izolációt a tesztek igazolják
8. **Adapter vs. wiring kártya**: ha a commit message jelzi, hogy a live route wiring külön kártyán van, ez nem FAIL -- az adapter kártya DONE-ba mehet, de jelzed a verdiktben

```bash
# Ellenőrzés: scripted SQL client pattern keresése
grep -n "createScriptedSqlClient\|sql.calls\|toHaveLength(1)" apps/api/src/*.test.ts
# Dual fail-closed path tesztelve?
grep -n "23514\|rowCount: 0\|rows: \[\]" apps/api/src/*store*.test.ts
```

### CSS lint guard non-vacuous CI-block verifikáció (31a71633 tanulság)
Ha egy CSS lint guard (pl. Rule-13 vitest) gate-elésénél a non-vacuity és CI-block bizonyítás szükséges:

**1. Non-vacuous bizonyítás (deliberate violation inject):**
```bash
# 1. Temporális violation fájl létrehozása
cat > /tmp/test-violation.css << 'CSSEOF'
.test-violation-btn { padding: 8px 16px; font-size: 14px; }
CSSEOF
cp /tmp/test-violation.css apps/web/src/styles/test-violation.css

# 2. Guard futtatása -- FAIL-nek kell lennie
npx vitest run apps/web/src/styles/rule13-touch-target.test.ts 2>&1 | grep -E "FAIL|violation|test-violation"

# 3. Fájl visszaállítása
rm apps/web/src/styles/test-violation.css
```
Ha a guard NEM ad FAIL-t a deliberate violation-re → a guard vacuumális → QA FAIL.

**2. @media breakpoint sweep** (a guard BASE-szintű szabályokat ellenőriz, de a @media override csökkentheti a min-height-et visszamenőleg):
```python
import re, pathlib
root = pathlib.Path('apps/web/src')
for f in root.rglob('*.css'):
    text = f.read_text()
    for m in re.finditer(r'@media[^{]+\{((?:[^{}]|\{[^{}]*\})*)\}', text, re.DOTALL):
        block = m.group(1)
        for mh in re.finditer(r'([\w.-]+)\s*\{[^}]*min-height\s*:\s*(\d+(?:\.\d+)?)(px)[^}]*\}', block):
            val = float(mh.group(2))
            if val < 44:
                print(f"{f}: {mh.group(1)} has min-height:{val}px in @media")
```
Ha a sweep talál `min-height < 44px`-et egy @media blokkban interaktív osztályon → Rule 13 FAIL (a breakpoint lecsökkenti a touch target méretet).

### PG 18 custom GUC pool-reuse csapda (a3709edb tanulság -- RLS fail-closed)
RLS policy-k `current_setting('app.tenant_id', true)::uuid` típusú USING/WITH CHECK feltételeinél PG 18 **viselkedésváltozást** okoz:

**PG 14-17:** `set_config('app.tenant_id', x, true)` (is_local=TRUE) commit után a GUC session értéke visszaáll NULL-ra → `NULL::uuid = NULL` → fail-closed (0 sor látható).

**PG 18:** Ugyanaz a commit után a GUC session értéke `''` (üres string) lesz az adott connectionön. Pool-reuse esetén a következő `asApp(null, ...)` hívás `''::uuid`-t próbál castolni → `invalid input syntax for type uuid: ""` hiba. Ez NEM csendes fail-closed, hanem exception.

**Bizonyítás:** `select current_setting('app.tenant_id', true)` után egy is_local commit-on ugyanazon connectionön → `{"val":""}` PG 18-ban.

**Fix:** `NULLIF(current_setting('app.tenant_id', true), '')::uuid` a policy-ban -- az üres stringet NULL-ra konvertálja a cast előtt, így PG 18 pool-reuse esetén is fail-closed marad.

**Gate checklist RLS migráció vizsgálatánál:**
1. A policy `USING` és `WITH CHECK` mindkét ágában `NULLIF(..., '')` wrapper megvan-e?
2. Az e2e teszt `asApp(null, ...)` eset után pool-reuse-t szimulál-e (max:1 pool, előbb volt is_local set)?
3. Ha a teszt `invalid input syntax for type uuid: ""` hibával bukik → PG 18 GUC csapda, nem maga a policy logika hibás.

### Embedded-postgres futtatása rendszer-PG nélkül (LD_LIBRARY_PATH trick)
Ha a rendszeren nincs telepített PostgreSQL és `sudo apt-get install` sem elérhető, az embedded-postgres csomag mégis futtatható az alábbi módon:

```bash
# 1. Ellenőrzés: a bundled lib tartalmaz-e minden szükséges SO-t?
LIB_DIR="<CleanCore>/node_modules/.pnpm/@embedded-postgres+linux-x64@<ver>/node_modules/@embedded-postgres/linux-x64/native/lib"
ldd "$LIB_DIR/../bin/initdb" | grep "not found"
# Ha nincs "not found" -> LD_LIBRARY_PATH-cal futtatható

# 2. Futtatás LD_LIBRARY_PATH-cal (a child processzek öröklik):
LD_LIBRARY_PATH="$LIB_DIR" node --input-type=module << 'EOF'
import EmbeddedPostgres from 'embedded-postgres'
// ... start PG, get URL, run vitest with PG_E2E_URL
EOF
```

**Startup szkript minta** (e2e gate-hez):
```javascript
// start-pg-e2e.mjs
process.env.LD_LIBRARY_PATH = LIB_DIR + ':' + (process.env.LD_LIBRARY_PATH || '')
const EmbeddedPostgres = (await import('file:///.../embedded-postgres/dist/index.js')).default
const pg = new EmbeddedPostgres({ databaseDir: '/tmp/cc-e2e-pg', port: 54321,
  user: 'postgres', password: 'postgres', createPostgresUser: false })
await pg.initialise()
await pg.start()
const { spawn } = await import('child_process')
const child = spawn('pnpm', ['vitest', 'run', 'apps/api/src/rls-*.e2e.test.ts'],
  { cwd: '<CleanCore>', env: { ...process.env, PG_E2E_URL: 'postgres://postgres:postgres@127.0.0.1:54321/postgres' }, stdio: 'inherit' })
const code = await new Promise(res => child.on('close', res))
await pg.stop()
process.exit(code)
```

**Csapdák:**
- Az embedded-postgres verzió egyeznie kell: `@embedded-postgres+linux-x64@18.x.y` (nem `17.x`)
- `createPostgresUser: false` szükséges (non-root userként fut, postgres OS user nélkül)
- A `LD_LIBRARY_PATH`-t a Node process INDÍTÁSA ELŐTT kell settelni (a child process örökli `process.env`-ből)
- **`initdb -U <OS_USER>` kötelező, ha raw pg_ctl/initdb binárist hívunk** (nem az EmbeddedPostgres osztályt). A default initdb superuser az OS user; ha a pgdata más user-rel lett inicializálva, a kapcsolódás `role "<user>" does not exist` hibával bukik. Fix: `initdb -D "$PGDATA" --no-locale -E UTF8 -U neon` (vagy `$(whoami)`). Régi pgdata újrahasználatánál mindig ellenőrizd, ki az initdb superuser -- inkább friss pgdata.
- **Port-ütközés**: ha a port már foglalt, a `pg_ctl start` csendes sikerjelzéssel indul de a postgres azonnal leáll. Ellenőrzés: `pg.log` tartalmát olvasd (`cat "$PGDATA/pg.log"`), ne a pg_ctl exit code-ját bízd meg. Más portot válassz ha `Address already in use`.
- **Vitest include pattern**: a `/tmp/*.test.ts` fájlokat a CleanCore vitest config kizárja (`include: packages/**/src/**`). E2E-t `apps/api/src/` alá tedd (és gate után töröld), vagy a PGDATA-t `/tmp`-re, de a test fájlt a repo-ba.

### Kártya deliverable = new fields → tesztjük kötelező (84a212ed/3c7e58ed tanulság)
Ha egy kártya BŐVÍT egy meglévő komponenst (új mező, új toggle, új fallback-lánc), a korábbi base-behavior tesztek NEM elegendők. A kártya deliverable-jén 0 lefedettség = QA FAIL, akkor is, ha az összes régi teszt zöld.

Ellenőrzési séma:
1. Olvasd el a kártya REVIEW kommentjét: mik az ÚJ feature-ök?
2. `grep -n 'NEW_FIELD\|newProp\|siteNamefalcback' SitePdfReport.test.tsx` -- van-e teszt rájuk?
3. Ha 0 találat -> QA FAIL, listázd pontosan mit kell tesztelni.

Valós esetek:
- 3c7e58ed (title input + includePhotos toggle): 20/20 base teszt zöld, de a 2 új mező (render, body-forwarding, blank-title omission) teljesen teszteletlen → QA FAIL
- ab478ebb (siteName fallback-lánc): `siteName ?? siteId.slice(0,8) ?? '—'` mind 3 ága teszteletlen → QA FAIL
- 87c0f578 (94402ee + b0fc7db): 28/28, explicit `title input (acf0767)` és `include photos toggle (acf0767)` suite-ok → QA PASS

### Contract field hozzáadás → mock TS2345 mellékhatás (47b8e33a / 84a212ed tanulság)
Ha egy megosztott interface-hez ÚJ kötelező mező kerül (pl. `siteName: string | null` az `UpcomingShift`-be), az összes meglévő tesztfájl, ami mock objektumokat épít abból a típusból, TS2345-öt kaphat. A vitest zöld marad (runtime nem ellenőrzi a típust), de tsc --noEmit piros.

Gate checklist contract-változásnál:
```bash
# Melyik interface változott?
git show <sha> -- 'packages/*/src/*.ts' | grep '^+.*readonly ' | head -20
# Keresés az összes tesztfájlban ami ezt a típust mockolja
grep -rn 'UpcomingShift\|ApiSchedulingSummary\|AFFECTED_TYPE' apps/web/src --include="*.test.*"
# tsc az egész web workspace-re
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | grep "error TS"
```

Fix: minden mock objektumhoz felvenni az új mezőt (pl. `siteName: null`).

Valós eset (84a212ed re-gate): 28/28 vitest zöld, de tsc 5 hibát adott:
- `SitePdfReport.test.tsx:292,302,322,333` TS2532: `mock.calls[0][1]` possibly undefined → fix: `mock.calls[0]![1]!` vagy `mock.lastCall![1]`
- `SiteDetailPage.test.tsx:240` TS2345: mock UpcomingShift-ből hiányzik `siteName: string | null` (47b8e33a mellékhatása) → fix: `siteName: null` hozzáadása minden mock shifthez

### Testing-library getAllByRole()[i] → TS2322/TS2345 (79213e5a tanulság)
A testing-library `getAllByRole()` / `getAllByTestId()` visszaadott tömbje `HTMLElement[]` típusú, de a `strictNullChecks + exactOptionalPropertyTypes` kombináció esetén az `arr[i]` típusa `HTMLElement | undefined` -- a tsc szerint az index elérheti az array végét. Vitest zöld marad (runtime nem ellenőrzi), de `tsc --noEmit` TS2322/TS2345-öt dob.

**Két tipikus mintázat:**

1. **TS2322: `arr[i]` possibly undefined** (pl. `LeaveApprovalsPage.test.tsx:98`)
```typescript
// HIBAS: items[0] tipusa HTMLElement | undefined
const items = screen.getAllByRole('row')
renderWithData(items[0])  // TS2322

// JO: non-null assertion ahol az elem garantalt meglete
renderWithData(items[0]!)
// VAGY: ha egyetlen elemet keresunk, hasznalj getByRole-t
const item = screen.getByRole('row', { name: /specific/i })
```

2. **TS2345: `HTMLElement | undefined` nem assignable to `Element`** (pl. fireEvent.click)
```typescript
// HIBAS
fireEvent.click(screen.getAllByRole('button')[0])

// JO
fireEvent.click(screen.getAllByRole('button')[0]!)
// VAGY
fireEvent.click(screen.getByRole('button', { name: /approve/i }))
```

3. **TS2379: mock hianyos kotelezo mezok (exactOptionalPropertyTypes)** -- ha az interface-nek uj kotelezo mezoi vannak es a mock nem tartalmazza oket:
```typescript
// HIBAS: ApiLeaveRequest kotelezo mezok hianyzanak
const mock: ApiLeaveRequest = { id: 'x', status: 'pending' }  // TS2379

// JO: minden kotelezo mezo undefined-kent is megadva
const mock: ApiLeaveRequest = { id: 'x', status: 'pending', tenantId: undefined, workerId: undefined, ... }
```

**Gate rutint:** `tsc --noEmit -p apps/web/tsconfig.json` minden uj tesztfajlt tartalmazo FE kártyán -- a vitest zold nem jelenti, hogy a tsc is zold.

**Valós eset (79213e5a @ 8e346c6):** 18/18 vitest PASS, de 8 tsc hiba: LeaveApprovalsPage.test.tsx:98,104,112,118,129,142 (TS2322+TS2345) + MyLeavePage.test.tsx:105,115,124,130 (TS2345+TS2379+TS2322). Fix: `arr[i]!` non-null assertion + mock kotelezo mezok hozzaadasa.

### Demo-szám szivárgás fetch-error esetén (Rule-12 -- 80c7646c tanulság)
Ha egy tab badge vagy KPI-szám null-coalescing-gel esik vissza demo adatra fetch-hiba esetén, az Rule-12 FAIL: a felhasználó egy fabricált számot lát "valós adatként".

```tsx
// FAIL -- fetch-error esetén DEMO_OPEN_SHIFTS.length (pl. 3) jelenik meg a badge-en
const openCount = summary?.kpi.open ?? DEMO_OPEN_SHIFTS.length

// HELYES -- fetch-error = 0 / null badge (nincs adat = nincs badge)
const openCount = summary?.kpi.open ?? 0
```

Detekció:
```bash
grep -n '?? DEMO_\|?? demo\|?? MOCK_' apps/web/src/features/**/*.tsx | grep -v '//'
# Bármely `?? DEMO_*` érték badge-en / KPI-ban potenciálisan Rule-12 FAIL
```

Megjegyzés: a DemoBanner-rel explicit jelölt panel (pl. Board/Open/Presence) hardcoded demo adatai elfogadhatók -- a DemoBanner kommunikálja, hogy nem valós adat. A FAIL akkor keletkezik, ha a valós API-ból töltött badge/KPI demó értékre esik vissza hiba esetén.

### Raw err.message → t(key) csere: teszt-assertion frissítés kötelező (6161b50b tanulság)
Ha egy kártya a `catch` blokkban a `err instanceof Error ? err.message : String(err)` pattern-t `t('i18n.key')`-re cseréli, a meglévő tesztek, amik az `err.message` RAW stringjét assertálják, elbuknak -- ez QA FAIL.

**Root cause**: a tesztek a mock error `.message` mezőjére assertálnak, pl.:
```tsx
// Teszt mock: new Error('no productivity rate')
// Régi kód: setError(err.message) → 'no productivity rate'
// ÚJ kód: setError(t('bid.calcError')) → 'Unable to calculate a bid' (EN fordítás)
expect(screen.getByText(/no productivity rate/)).toBeInTheDocument() // FAIL
```

**Detekció** (kötelező, ha a commit `err.message` → `t()` cserét tartalmaz):
```bash
# Melyik tesztfájlok assertálnak a régi error stringekre?
git show <commit> -- 'apps/**/*.tsx' | grep '^-.*err\.message\|^-.*String(err)' | head -20
# Keresés az érintett tesztfájlokban
grep -n "getByText\|toHaveTextContent\|getByRole.*alert" apps/web/src/features/**/*.test.tsx \
  | grep -i "error\|fail\|cannot\|unable\|invalid"
```

**Fix**: az assertion-t frissíteni az EN locale fordítási értékre:
```tsx
// RÉGI (FAIL): expect(screen.getByText(/no productivity rate/)).toBeInTheDocument()
// ÚJ (PASS):  expect(screen.getByText('Unable to calculate a bid')).toBeInTheDocument()
//             ^ a t('bid.calcError') EN fordítása packages/i18n/messages/en.json-ből
```

**EN érték megkeresése**:
```bash
grep -r "bid.calcError\|wcag.unknownError\|newRequest.errSubmit" \
  packages/i18n/messages/en.json
```

**Valós eset (6161b50b @ d925a9f):** 5 fájl 6 catch-blokkja javítva, 94/97 teszt zöld, 3 FAIL:
- `BidCalculatorForm`: `/no productivity rate/` → `'Unable to calculate a bid'` (t('bid.calcError'))
- `WcagGate`: `'publish failed'` → `'An unknown error occurred.'` (t('brand.wcag.unknownError'))
- `ClientNewRequestPage`: `/Server error/` → `'Submission failed. Please try again.'` (t('portal.newRequest.errSubmit'))

### Catch-block demo-adat eltávolítás -- regressziós teszt kötelező (425e2c55 tanulság)
Ha egy kártya `catch` blokkból demo-adatot távolít el és `setError()`-re cseréli, a kód változás önmagában helyes lehet, de **regressziós teszt nélkül QA FAIL**.

**Az anti-pattern:**
```tsx
// ELŐTTE (DEMO SZIVÁRGÁS): catch tüneti "siker"-t mutat, demo-adatot ad a listához
} catch {
  const fakeEntry = { id: 'inc-demo-001', tenantId: 'demo-tenant-001', ... }
  onAdd(fakeEntry)   // <- hazugság: felhasználó "sikernek" látja a hibát
}

// UTÁNA (HELYES): catch valós hibát jelez
} catch {
  setSubmitError(t('widget.saveError'))
}
```

**Amit QA-nak ellenőrizni kell a UTÁNA commiton:**
1. `grep -n "demo-tenant\|DEMO_\|demo_" <file>.tsx` -> 0 találat (kész)
2. `grep -n "wp-field-error\|submitError" <file>.tsx` -> megjelenik a render-ágban (kész)
3. **REGRESSZIÓS TESZT (ez a kritikus)**: van-e teszt ami:
   - mock-olja az API-hívást rejectionra (`addXxx.mockRejectedValue(...)`)
   - submitolja a formot
   - assertálja, hogy a hibaüzenet megjelenik (`screen.getByText(...)`)
   - assertálja, hogy `onAdd` NEM lett hívva (nincs demo-bejegyzés)
4. **Stale teszt-kommentek**: ha a fájl fejléce `"tests run on demo fallback"`-et mond de a demo fallback el lett távolítva, ez stale és frissítendő (QA FAIL finding)

**Valós eset (425e2c55 @ 5869966):** IncidentsTab/ReviewsTab/CertsTab mind kicserélve (`setSubmitError`-re), kód helyes, 26/26 teszt zöld -- DE: `addIncident/addReview/addCertification` mockjai soha nem kerültek rejection-tesztre, a teszt fejléce stale, a `'falls back to demo data'` teszt név elavult. QA FAIL.

### Placeholder-to-real-component regresszió (CAL-4 / 18d800f2 tanulság)
Ha egy FE kártya "Coming Soon" chipet (vagy bármilyen stub/placeholder elemet) VALÓDI komponensre cserél, az ANYA-oldal/anya-komponens meglévő tesztjei törhetnek -- mert azok az adott chip/elem számát explicit assertálták.

**Tipikus törési formák:**
- `expect(chips).toHaveLength(4)` → mostantól 3 (az egyik chip-et a valódi komponens váltotta fel)
- `expect(tabs.length).toBe(5)` → mostantól 6 (ha az új komponens új tabot is hoz)
- `expect(screen.getAllByText(/coming soon/i)).toHaveLength(N)` → N-1

**Detekciós lépés (kötelező, ha a commit `SettingsPage`/`*Shell`/`*Layout` fájlt is érint):**
```bash
# 1. Melyik placeholder/stub elem tűnt el a commit-ban?
git show <commit> -- '*.tsx' | grep '^-.*coming.soon\|^-.*Coming.Soon\|^-.*st-chip--soon\|^-.*placeholder'

# 2. Megkeresi, hogy az anya-komponens tesztje hány példányt vár
git show <commit>~1:apps/web/src/features/settings/SettingsPage.test.tsx | grep -n "toHaveLength\|toBe.*[0-9]" | head -20

# 3. Futtatja az anya-komponens tesztjét a ÚJ commit-on
pnpm vitest run apps/web/src/features/settings/SettingsPage.test.tsx
```

**Gate checklist placeholder-csere esetén:**
1. Az érintett anya-komponens tesztjeit LEFUTTATNI (nem csak az új komponens tesztjeit)
2. Ha a teszt failing: ez Fron Ted / a kártya fejlesztőjének javítandója, nem átugorható
3. A fix: a anya-tesztben a chip-számlálót csökkenteni, ÉS az új komponensre mock-ot bevezetni (pl. `getCalendarConfig` mock → loading state)

**Valós eset (18d800f2 @ b507c80):** CalendarSyncCard lecserélte a Google Calendar "Coming Soon" chip-et → SettingsPage.test.tsx 3 regresszió:
- `"renders 5 tab buttons"` → FAIL (6 lett)
- `"shows 4 integration cards"` → FAIL (3 chip maradt)
- `"all integration cards have coming-soon chips"` → FAIL (ua.)
Anya-teszt futtatás nem volt a commit-ban → QA FAIL.

### Rate-limit / lockout guard gate checklist (546d7e5b tanulság)
Amikor egy kártya brute-force védelmet vezet be (PIN/QR kiosk, login, stb.), ezeket kötelező ellenőrizni:

**1. Lockout ELŐBB fut a valós select/auth előtt (fail-closed):**
```bash
# A directory/authz-check NEM hívódhat meg zárolt state-nél
# Teszt: dir.resolveCalls === 0 AFTER lockout-trip
grep -n "resolveCalls\|resolveSelector\|calls.*0\|toHaveLength(0)" <test-file>
```

**2. Opaque failure (nincs oracle):**
- Rossz selector/jelszó → UGYANAZ a generikus error kerül rethrow-ra (nem szivárog "nincs találat" vs. "le van tiltva")
- Zárolt state → külön error class (pl. `KioskDeviceLockedError`) `retryAfterMs`-szel; de a selector-specifikus ok NEM derül ki

**3. Audit NEM szivárogtat hitelesítési adatot:**
```typescript
// HELYES: csak {deviceId, tenantId, outcome, atMs} -- nincs selector/PIN
expect(Object.keys(audit.events[0]!).sort()).toEqual(['atMs', 'deviceId', 'outcome', 'tenantId'])
```

**4. Siker visszaállítja a számlálót (reset on success):**
- N-1 fail + success + 2 fail = nem éri el a limitet újra
- Explicit teszt: fail → success → fail → success (nem zárol be)

**5. CAS retry fail-closed:**
- `LockoutConflictError` → retry (max N), soha nem bypass-olja a lockoutot
- Kimerített retry (pl. 5 kísérlet) → fail-closed (pl. `KioskDeviceLockedError(0)`)

**6. Per-key scope tartalmaz tenant-t (cross-tenant collision kizárva):**
```typescript
// HELYES: `kiosk-device:${tenantId}:${deviceId}`
// HIBÁS:  `kiosk-device:${deviceId}` -- cross-tenant collision lehetséges
grep -n "lockoutKey\|deviceLockoutKey\|tenantId.*deviceId" src/*.ts
```

**7. Csak valós auth-hiba számít a számlálóba:**
- Unrelated exception (pl. invalid nowMs, DB hiba) NEM növeli a lock-számlálót
- Teszt: más típusú exception propagál anélkül, hogy a lockout state változna

**Valós eset (546d7e5b @ 5186738):** 7/7 non-vacuous teszt -- lockout-trip után `dir.resolveCalls===0` igazolva, audit key-set assertion, success-reset teszt, CAS retry teszt, CAS exhaustion → fail-closed.

## Ellenőrzés
- Minden acceptance criterion pipálva.
- Happy + loading/empty/error/edge state lefedve.
- Tesztek léteznek és zölden futnak; nincs szomszédos regresszió.
- **Placeholder-csere esetén: anya-komponens tesztjei is lefuttatva** (nem csak az új komponens saját tesztjei).
- i18n wiring: render-path ÉS catch/async ágak, kulcs-paritás mind a 7 locale-ban.
- Betöltő useCallback-ek: `catch` ág megvan (csak `finally` = silent Rule-12 fail); `void fn()` hívás nem elég.
- Verdikt kommentben: commit hash + gate tiering ajánlás.
- CSP sweep után: minden teszt-szelektort összevetni a className-változásokkal.
- RLS policy-knál: `NULLIF(..., '')::uuid` wrapper PG 18 pool-reuse kompatibilitáshoz.
- Contract-változásnál: tsc --noEmit az egész workspace-re, nem csak az érintett fájlra.
- Kártya új mezőinél: explicit grep a tesztfájlban az ÚJ field/feature-re -- 0 találat = FAIL.
- Rate-limit guard: lockout ELŐBB fut; audit nem szivárogtat hitelesítési adatot; per-key scope tartalmaz tenant-t.
- Flow/IA doc gate: domain-funkció nevek és i18n-kulcsok (ld. alább).

### Cybersec GO érvényessége QA-FAIL fix után (79213e5a tanulság)
Ha egy kártya QA FAIL-t kapott és a fix-commit KIZÁRÓLAG CSS-t és/vagy tesztfájlokat változtatott (NEM production logikát), a korábbi Cybersec GO érvényes marad -- nem kell újra gate-elni a biztonsági átjárón.

**Érvényes marad, ha a fix csak:**
- CSS módosítás (pl. `min-height: 32px → 44px` Rule-13 javítás)
- Tesztfájlok (non-null assertion, mock-mezők pótlása)
- Dokumentáció / kommentek

**Újra kell gate-elni, ha a fix:**
- Production TSX/TS kódot változtat (authz, API hívás, token kezelés)
- Új dependency-t vezet be
- HTTP endpoint viselkedését módosítja
- Bármit érint, ami a korábbi Cybersec GO scope-jában volt

A verdiktben ezt explicit jelezd: `"A 4475351 fix csak CSS + tesztfájlok -- nincs új trust-boundary, a Cybersec GO (#N @ sha) érvényes marad."`

Valós eset (79213e5a): Cybersec GO #4654 @ 8e346c6, majd QA FAIL → fix commit 4475351 (CSS 44px + non-null assertions). QA PASS #4670 @ 4475351, Cybersec GO érvényes. MikroB lezárta.

### Flow/IA dokumentum gate -- függvénynév + i18n teljességellenőrzés (fb99fc85 tanulság)
Amikor flow/IA dizájn-dokumentumot gate-elsz, két ellenőrzés elengedhetetlen:

**1. Domain-funkció nevek a flow-connectivity manifestben**

A manifest a domain-függvényekre hivatkozik neve szerint. Ha a név eltér a tényleges committed kódtól, a FORM-3 implementer üres nevet kap (és esetleg proxy-funkciót hoz létre).

```bash
# Lekérd a tényleges exportált funkciókat a domain-modulból
git show <DOMAIN_COMMIT>:packages/modules/<mod>/src/<mod>.ts \
  | grep "^export function\|^export async function"
# Hasonlítsd a manifest sorait: "submitFormSubmission" vs "submitForm"
```

Valós eset (fb99fc85 @ af1b5ef): manifest "submitFormSubmission" → tényleges: `submitForm` (8f65661). QA FAIL.

**2. Minden felhasználónak megjelenő string a flow leírásban legyen az i18n-keys szekcióban**

A flow szövege tartalmaz konkrét UI-stringeket (pl. `"Photo upload failed. Try again."`). Ha ezek nem szerepelnek a "i18n keys needed" szekcióban, az implementer hardcode-olhatja.

```bash
# Grep a flow leírásban idézőjeles user-facing stringekre
git show <FLOW_COMMIT>:apps/web/src/features/X/FLOW.md \
  | grep -n '"[A-Z][^"]*\."'
# Hasonlítsd a Section 9 (i18n keys) listájával
```

Hiányzó kulcsok = Rule-12 FAIL finding (user-facing string t()-kulcs nélkül).

Valós eset (fb99fc85 @ af1b5ef):
- Flow E: `"Photo upload failed. Try again."` → hiányzik, javasolt: `forms.fill.photo.uploadFailed`
- Flow I: `"Submit when connected"` gombfelirat → hiányzik, javasolt: `forms.fill.submitWhenConnected`

**Gate logika flow/IA artifactnál:**
- Nincs futtatható teszt -- a gate tárgya: (a) flow-connectivity labelek pontossága, (b) domain-funkció nevek egyeznek a committed kóddal, (c) minden flow-ban említett user-facing string szerepel a i18n-keys szekcióban, (d) entitlement matrix pozitív + negatív kontrollal, (e) screen state inventory (loading/empty/error/offline).
- **Cybersec gate**: NEM szükséges clean flow/IA dokumentumra (nincs implementált trust-boundary). A Cybersec gate az implementáció-kártyára (pl. FORM-3, SUBCON-3) vonatkozik.

### HTTP handler gate -- make-live forward invariants (f11d23eb tanulság)
Amikor egy BE kártya guarded HTTP-handlereket vezet be (make-live kártya), négy visszatérő forward-invariant van, amit a QA gate-nek NON-VAKUOSAN kell bizonyítani:

**1. Server-generated ID (traversal/injection megelőzés)**
A resource ID-t a handler generálja (`randomUUID()`), SOHA nem a client body-ból olvassa. Ha a body tartalmaz `id` mezőt, azt figyelmen kívül kell hagyni.

```bash
# Kódban: randomUUID() jelen van, body id NEM olvasva
git show <sha>:apps/api/src/<mod>-http.ts | grep -n "randomUUID\|body.*id\|asRecord.*id"

# Teszt: body id !== generált id
expect(lv.id).not.toBe('attacker-id')  # a body id figyelmen kívül hagyva
expect(lv.id).toMatch(/^[0-9a-f-]{36}$/)  # UUID formátum
expect(store.get(tenantId, lv.id)?.id).toBe(lv.id)  # persist igazolva
```

**2. Opaque cross-boundary 404 (no existence oracle)**
Egy nem-létező sor és egy más scope-ba eső (cross-crew, cross-tenant) sor UGYANAZT a hibát adja. A hívó nem tudja megkülönböztetni "nincs" vs. "nincs jogosultság".

```typescript
// Helyes pattern:
function loadManageableLeave(ctx, id, scope, deps) {
  const leave = deps.store.get(tenantId, id)
  if (leave === null) throw new LeaveNotFoundError(id)           // absent
  if (scope !== RowScope.All && !managed.has(leave.workerId))
    throw new LeaveNotFoundError(id)                             // out-of-scope → SAME error
}
// Teszt: mindkét case LeaveNotFoundError-t ad
expect(() => approve(lead, 'absent-id', deps())).toThrow(LeaveNotFoundError)
expect(() => approve(lead, 'out-of-crew-id', deps([outCrew]))).toThrow(LeaveNotFoundError)
```

**3. Field-RBAC redaction (PII szűrés tier alapján)**
Érzékeny mezőt (orvosi adat, bér, privát indok) a viewer szerepétől függően kell redaktálni. Az owner és a legmagasabb jogosultság teljes adatot lát; a közbülső tier csak redaktáltat.

```bash
git show <sha>:apps/api/src/<mod>-http.ts | grep -n "redact\|reason.*null\|RowScope.All"
```

```typescript
// Teszt: crew-lead redaktált, manager teljes adatot kap
expect(approveLeaveHttp(lead, 'sick-lv', deps([sickLv])).reason).toBeNull()  // redacted
expect(approveLeaveHttp(admin, 'sick-lv', deps([sickLv])).reason).toBe('surgery recovery')
```

**4. RBAC guard: minden handler első hívása `authorizeScoped()`**
Minden endpoint `authorizeScoped(ctx, Action.Xxx)` -zel indul. ForbiddenError-t dob jogosulatlan szerepre.

```bash
git show <sha>:apps/api/src/<mod>-http.ts | grep -n "authorizeScoped"
# Minden handler ELSŐ utasítása legyen authorizeScoped
```

```typescript
// Teszt: Worker cannot approve (no LeaveManage)
expect(() => approveLeaveHttp(worker, 'lv-1', deps([lv]))).toThrow(ForbiddenError)
```

**Teljes gate checklist HTTP handler kártyákra:**
```bash
# 1. Server-generated id (randomUUID, nem body)
git show <sha>:apps/api/src/*-http.ts | grep -n "randomUUID"

# 2. requireTenant(ctx) -- SOHA nem body.tenantId
git show <sha>:apps/api/src/*-http.ts | grep -n "requireTenant\|body.*tenantId"

# 3. Opaque cross-scope: nincs oracle (LeaveNotFoundError / ResourceNotFoundError -- same for absent+unauthorized)
git show <sha>:apps/api/src/*-http.ts | grep -n "NotFoundError\|opaque"

# 4. Field-RBAC redaction (ha PII mező van)
git show <sha>:apps/api/src/*-http.ts | grep -n "redact\|RowScope.All.*reason\|null.*PII"

# 5. authorizeScoped első hívás minden handlerben
git show <sha>:apps/api/src/*-http.ts | grep -n "authorizeScoped" | head -20
```

**Valós eset (f11d23eb @ 41c5fa2):** 13 handler, 503/503 zöld (13 leave-http + 490 rbac unit), tsc clean. Mind a 4 forward-invariant non-vakuosan igazolva: (1) attacker-body-id ignorálva + UUID teszt, (2) absent == out-of-crew LeaveNotFoundError, (3) crew-lead sick-reason null / manager full, (4) ForbiddenError worker-approve-nál. QA PASS, Cybersec gate szükséges.

## Ellenőrzési lista (HTTP handler make-live kártyákhoz kiegészítve)
- Mind a 4 forward-invariant (`randomUUID`, `requireTenant`, opaque-404, field-RBAC) non-vakuosan tesztelve
- Minden handler `authorizeScoped()` első hívásként -- hibás role ForbiddenError-t dob (tesztelve)
- `in_progress` + `waiting` státuszok kezelése: domain workflow-transition (Pending → Approved/Rejected/Cancelled)
- In-memory adapter: length-prefixed kulcs (`${t.length}:${t}:${id}` forma), cross-tenant collision kizárva
- Make-live deferred: ha PG-RLS adapter / real presigner külön kártyán van, jelzed a verdiktben (nem FAIL)

### FE/BE path prefix csapda (`/api` vs `/v1` -- KIOSK-4 + SUBCON-4 tanulság)
FE `needs-wiring` kártyánál, miután a BE make-live kártya landolt, a leggyakoribb gate-csapda: a FE `/api/v1/...` path-szal hívja az endpointot, de a backend `/v1/...`-t vár (nincs `/api` prefix-stripping).

**Kötelező ellenőrzés minden FE API client fájlnál:**
```bash
# 1. Milyen path-eket hív a FE?
git show <sha>:apps/web/src/features/<mod>/*Api.ts | grep "'/api\|'/v1\|partnerFetch\|kioskFetch\|apiFetch"

# 2. Milyen path-eket ismer a BE? (server.ts mount + isXxxPath függvény)
git show <BE_sha>:apps/api/src/<mod>-http.ts | grep "startsWith\|===.*PATH\|const.*PATH\|'/v1"

# 3. Van-e Vite proxy?
git show <sha>:apps/web/vite.config.ts | grep "proxy\|rewrite\|/api"
# Ha nincs proxy -> az '/api/v1/...' hívás SOHA nem éri el a '/v1/...' handlert
```

**Auth mechanizmus csapda (SUBCON-4):** Ha a FE `Authorization: Bearer <localStorage_token>` headert küld, de a BE HttpOnly cookie-t vár (`cc_partner_session`), a FE nem tudja olvasni a cookie-t (JavaScript-ből hozzáférhetetlen), ezért a localStorage-ban tárolt token MINDIG null lesz. `credentials: 'include'` esetén a böngésző automatikusan küldi a cookie-t -- de csak ha a path és a Set-Cookie origin egyezik.

**Tipikus mismatch-ek (mind QA FAIL - flow-connectivity Rule 9):**
| FE (rossz) | BE (helyes) |
|---|---|
| `POST /api/v1/partner/auth/magic-link` body {token} | `GET /v1/partner/auth/verify?token=...` |
| `POST /api/v1/kiosk/auth` Bearer header | `POST /v1/kiosk/select` deviceToken body |
| `PATCH /api/v1/.../confirm` | `POST /v1/.../confirm` |
| `POST /api/v1/.../proof/presign` | `POST /v1/.../proof` |

**Verdikt minta (QA FAIL esetén):**
```
Flow-connectivity (Rule 9) mismatch: <file>.ts összes N endpontja needs-wiring és a <BE-card> backendtől
(sha, már landolt) INKOMPATIBILIS. Nincs Vite proxy, nincs /api strip -> a FE hívások soha nem jutnak el.
Javítás: (a) /api prefix DROP, (b) auth mechanizmus igazítás, (c) hiányzó BE endpointok jelölése.
Pass-ok: tesztek zöld, tsc clean, CSP, Rule-13, i18n.
```

### Hand-mock elfedi a factory hibát (SUBCON-3 tanulság)
Ha egy `createInMemoryXxx([...seed])` factory-t kézzel-írt mock helyettesít a tesztekben, a factory implementációjának hibája láthatatlan marad -- az összes teszt zöld, de a live production path sérült.

**Konkrét eset (SUBCON-3, bd10ec0 → 018298a):**
- `createInMemorySubcontractorDirectory` a `byEmail` indexet sosem töltötte fel a `seed` loop-ban
- A teszt kézzel-írt stub-ot használt: `{ findByEmail: async (e) => SUB }` → mindig megtalálta
- A live magic-link (`server.ts` → `createInMemorySubcontractorDirectory()`) ezért soha nem találta meg a partnert
- A fix: seed loop most MINDKÉT indexet tölti (`byEmail.set(normalizeEmail(email), s)` + `byId.set(...)`)

**Gate checklist, ha in-memory store van a kártyán:**
```bash
# 1. Teszt a VALÓDI factory-n megy-e? (nem hand-mock)
grep -n "createInMemory\|{ findBy\|{ getById\|findByEmail.*=>" apps/api/src/*.test.ts
# Ha `{ findByEmail: async` jellegű anonymus stub van -> GYANÚS, ellenőrizd a factory-t

# 2. Mindkét index (id + email/slug) feltöltve?
git show <sha>:apps/api/src/*.ts | grep -n "byEmail.set\|byId.set\|map.set\|index.set"
# Mindkét set() jelen kell lennie a seed loop-ban

# 3. server.ts a valódi factory-t használja-e?
git show <sha>:apps/api/src/server.ts | grep "createInMemory\|directory:"
```

**Non-vacuous teszt minta:**
```typescript
// HELYES: VALÓDI factory, seed email-lel + ellenőrzés mindkét irányban
const dir = createInMemorySubcontractorDirectory([
  { email: '  Partner@X.com ', subcontractor: SUB },
])
expect(await dir.findByEmail('partner@x.com')).toEqual(SUB)  // normalized match
expect(await dir.findByEmail('PARTNER@x.com')).toEqual(SUB)  // case-insensitive
expect(await dir.findByEmail('nobody@x.com')).toBeNull()     // miss = null
expect(await dir.getById('t1', 'sub-1')).toEqual(SUB)
expect(await dir.getById('t2', 'sub-1')).toBeNull()          // tenant-scoped

// ROSSZ: stub mindig talál -> factory indexelési hibát elfedi
const dir = { findByEmail: async () => SUB, getById: async () => SUB }
```

**Szabály:** ha a production `server.ts` a `createInMemoryXxx()` factory-t drótozza, a tesztnek is AZON keresztül kell mennie -- nem hand-mock-on. Full-green-suite ≠ bizonyíték ha a teszt izolált a factory-tól.

### `needs-build` endpoint graceful degradation (SUBCON-4 tanulság)
Ha egy FE kártya explicit `needs-build` jelöléssel rendelkezik (BE endpoint még nem létezik -- a hívás 404-et vagy 501-et ad), a QA gate a KÖVETKEZŐKET ellenőrzi:

**1. Nincs dangling/no-op gomb:**
Minden UI akció, ami egy `needs-build` endpointra hív, VAGY:
- (a) el van rejtve / `disabled` amíg az adat nem töltődött be (loading/error state-ben nem látható), VAGY
- (b) ha megjelenik, az endpoint hívása fail esetén GRACEFUL error state-t ad (Rule-12 error), nem silently no-op-ol

```bash
# Gyanús: gomb nincs disabled/hidden load-error state-ben
# Keresés: van-e conditional render a "work" / "detail" adat függvényében?
git show <sha>:apps/web/src/features/<mod>/<Page>.tsx | grep -n "if (!work)\|!detail\|loadError\|disabled="
# A gombnak NE jelenjen meg ha a backing adat null
```

**2. Error state nem hagy "csupasz" ablakot:**
```bash
# needs-build endpoint hívása hiba esetén setLoadError()-t hív?
git show <sha>:apps/web/src/features/<mod>/<Page>.tsx | grep -n "setLoadError\|setError\|catch"
# A render path-ban az error state látható, nem üres div:
git show <sha>:apps/web/src/features/<mod>/<Page>.tsx | grep -n "loadError\|error.*&&\|role=\"alert\""
```

**3. `unavailable` state hardcoded-placeholder helyett:**
Ha a BE endpoint nem létezik és 404/501-et ad, az "unavailable" állapot EXPLICIT legyen:
```tsx
// HELYES: explicit unavailable state, nem hardcoded fake adat
const profile = await getPartnerProfile().catch(() => ({ id: 'unavailable' }))
if (profile.id === 'unavailable') return <p>{t('subcon.profile.unavailable')}</p>

// ROSSZ: fake adat egy BE-nélküli mezőn → Rule-12 FAIL
const profile = await getPartnerProfile().catch(() => ({ name: 'Demo Partner', email: 'demo@x.com' }))
```

**4. Guard: `if (!data) return null` ELŐTT jelenjen meg az error state:**
```tsx
// HELYES sorrendiség:
if (loadError) return <ErrorState />
if (!work) return null  // Ne rendereljük a feltöltő gombot, ha nincs backing adat
return <UploadButton workId={work.id} />

// ROSSZ: gomb megjelenik null work-kal
return <UploadButton workId={work?.id} />  // work?.id = undefined → Rule-9 no-op
```

**Gate checklist needs-build endpoint jelzésnél:**
1. Minden needs-build endpoint listázva az IA/FLOW.md-ben `[needs-build]` jelöléssel
2. Minden ilyen endpoint hibája graceful error/unavailable state-t ad (nem üres képernyő)
3. Nincs dangling gomb: a needs-build backing adatától függő akció nem jelenik meg, ha az adat null
4. Logout / elsődleges navigáció MINDIG elérhető, attól függetlenül, hogy a needs-build endpoint hibázott-e
5. Rule-12: az error state i18n kulcsból jön, nem hardcoded string
6. tsc clean: `work?.id` típusa `string | undefined` -- ha a gomb `workId: string`-et vár, ez TS2322

**Valós eset (SUBCON-4, d28cce0):**
- `getWorkDetail`, `listWorkProofs`, `getPartnerProfile` = needs-build (minden hívás 404-et ad)
- `PartnerWorkDetailPage`: `if (!work) return null` UTÁN nem rendeli le az upload gombot → nincs dangling button
- `PartnerProfilePage`: `getPartnerProfile()` 404/501 → `{ id: 'unavailable' }` → `t('subcon.profile.unavailable')` message, logout elérhető
- QA PASS: mind a 3 needs-build endpoint graceful degradation igazolva

### External-partner cookie-auth GET endpoint gate (SUBCON-5 tanulság)
Amikor egy kártya cookie-alapú (HttpOnly `sub_session`) partner-portál GET endpointokat vezet be (nem Bearer + `authorizeScoped`, hanem `authenticatePartner` + domain-szintű sor-scope ellenőrzés), a gate-checklist eltér a standard handler kártyáktól:

**1. No-existence oracle (LEGFONTOSABB ellenőrzés)**
Nem-létező, nem-hozzárendelt és idegen-tenant resource mind UGYANOLYAN 404-et kell adjon. A hívó NEM tudhatja, "nem létezik" vs. "létezik, de nem a tiéd".

```typescript
// Teszt: nem-saját és ismeretlen ID AZONOS 404 body-t ad
expect(body(notMine.body)).toEqual(body(unknown.body))
```

Ha hiányzik ez az explicit `toEqual` assertion -> QA FAIL (az oracle el lehet fedve más ellenőrzéssel).

**2. Cookie-auth: minden endpoint 401 cookie nélkül**
```bash
# Tesztben minden SUBCON-N handler-re:
# - no-cookie request → 401 ellenőrizve (NEM csak a happy-path)
grep -n "no.*cookie\|without.*cookie\|401" apps/api/src/subcontractor-http.test.ts | grep -v "//"
```

Ha egy endpointnál hiányzik a no-cookie 401 teszt -> QA FAIL.

**3. Keyset pagináció DoS-cap**
Lista endpointnál: `Math.min(rawLimit, MAX)` (pl. max 100) kötelező; explicit teszt: `limit=2` → `p1.length=2 + nextCursor≠null`, cursor követése → `p2.length=remainder + nextCursor=null`.

**4. Profil endpoint: ID kizárólag session-ből**
`GET /partner/profile`-jellegű önprofil endpointnál NINCS `:id` path param -- az identity `auth.sub.id`-ből jön (session). Teszt: `expect(body.id).toBe(auth.sub.id)`.

**5. Route ordering: hosszabb path ELŐBB**
`/work/:id/proofs` regisztrálva ELŐTT a `/work/:id`-nál, különben a `/proofs` suffix work-id-ként értelmezendő.

**6. ID charset guard**
`/^[A-Za-z0-9_-]{1,64}$/` -- traversal (`../`, `/`, NUL) → 400.

**7. `server.ts` nincs a commit diff-ben**
Az új store-ok a factory-ban (`createInMemoryXxxDeps()`) kapnak helyet, nem `server.ts`-ben.

```bash
# Gyors összefoglaló ellenőrzés
git show <sha> -- apps/api/src/subcontractor-http.test.ts | grep -c "toEqual(body"  # >=1
git show <sha> -- apps/api/src/subcontractor-http.test.ts | grep -c "no.*cookie\|401"  # >=1 per endpoint
git show <sha> -- apps/api/src/server.ts                                               # ÜRES kell legyen
```

Valós eset (SUBCON-5, 7f7896d): 10 test (work-detail, proofs-keyset, profile) -- oracle test (`notMine.body === unknown.body`), 2-page keyset igazolva, no-cookie 401 mind a 3 endpointnál, `server.ts` nem érintett. QA PASS #4758.

### Üzenetküldő endpoint gate checklist (CHAT-F0b tanulság)
Bármely user-generated text küldésére (messaging, comment, form) ezeket kell ellenőrizni:

**1. BIDI/Trojan-Source karakterszűrés (KÖTELEZŐ user-submitted textnél)**
RTL override (`U+202E`), zero-width characters (`U+200B`, `U+FEFF`), és más homoglyph/direction-manipulation Unicode codepoint-ok engedélyezése lehetővé teszi kód-csempészést, UI-spoofingot, naplómanipulációt.

```bash
# Megvan-e a `hasForbiddenTextChars` (vagy egyenértékű) hívás a domain send-jében?
git show <sha>:packages/modules/<mod>/src/<mod>.ts | grep -n "hasForbidden\|forbidden.*char\|unicode.*check\|bidi\|rtlo\|rtl.*override"

# Ha nincs -> finding: user-submitted body nem szűrt -> finding Cybersecnek (trust-boundary)
# QA scope: a függvény LÉTEZIK és a send ELŐTT hívódik, reject ha talál
```

Non-vacuous teszt minta:
```typescript
// KÖTELEZŐ: explicit forbidden char teszt
it('rejects BIDI override in body', () => {
  const result = sendMessage(ctx, convId, '‮evil text‬', 'key-1', deps())
  expect(result).toThrow(ForbiddenTextError)  // vagy hasonló error
})
it('rejects zero-width char in body', () => {
  expect(() => sendMessage(ctx, convId, 'ok​text', 'key-1', deps())).toThrow()
})
it('allows normal unicode (emoji, accents)', () => {
  expect(() => sendMessage(ctx, convId, 'Árvíztűrő 🔥', 'key-1', deps())).not.toThrow()
})
```

**2. Idempotency key (dupla-send védelem)**
Messaging API-knál az újrapróbálás (retry, network hiccup) duplikált üzeneteket okozhat. Az idempotency key client-provided, server-enforced unique constraint.

```bash
# Van-e findByIdempotencyKey hívás a send ELŐTT?
git show <sha>:packages/modules/<mod>/src/<mod>.ts | grep -n "idempotencyKey\|findByIdempotency\|idempotent"

# A store-ban van-e UNIQUE constraint (tenantId, conversationId, senderId, idempotencyKey)?
git show <sha>:packages/modules/<mod>/src/<mod>.ts | grep -n "idempotencyKey" | head -10
```

Ha megvan: az idempotency path NEM dob hibát -- visszaadja az EREDETI üzenetet (nem 409, nem új sor).
Teszt: `sendMessage()` kétszer ugyanazzal a kulccsal → mindkétszer ugyanaz az `id` jön vissza.

**3. Keyset cursor pagináció (nem offset/page)**
Magas-volume messaging-nél az offset alapú `page=N` nem skálázható (teljes COUNT query + skip N sor). Helyes: `(createdAtMs, id)` tuple cursor.

```bash
# `afterMs` + `afterId` paramétert vár a listMessages/listConversations?
git show <sha>:packages/modules/<mod>/src/<mod>.ts | grep -n "afterMs\|afterId\|createdAtMs.*id\|cursor"
# Ha `page=` / `offset=` van -> finding: pagination pattern hibás
```

Teszt: keyset-en `N` üzenet után cursor → a következő lap pontosan az `N+1.`-től indul, nincs gap/duplikát.

**Messaging gate összefoglaló (3 kötelező check):**
| # | Mit néz | Hol |
|---|---------|-----|
| 1 | `hasForbiddenTextChars` hívás send előtt | domain send fn |
| 2 | `findByIdempotencyKey` guard + idempotent return | domain send fn |
| 3 | keyset `(createdAtMs, id)` cursor (nem offset) | domain list fn |

Valós eset (CHAT-F0b, cb7fce2): mindhárom teljesül -- `hasForbiddenTextChars` body-n, `findByIdempotencyKey` dupla-send guard, `(createdAtMs, id)` keyset cursor, `senderId = ctx.userId` (SoD), ThreadNotVisible cross-tenant.

### File-upload presign endpoint gate checklist (FORM-6 tanulság)
Bármely S3/R2-kompatibilis presign flow-nál (proof-upload, form-photo, document-attach) az alábbi 7 pontot kell ellenőrizni. Mindegyik non-vacuous tesztet igényel.

**1. Server-derived objectKey (legfontosabb)**
A client által küldött filename SOHA nem kerülhet az object key-be. A key formátuma kizárólag szerver-kontrollált komponensekből álljon:
```
tenants/{tenantId}/jobs/{jobId}/form/{fieldKey}/{randomUUID()}.{allowlisted_ext}
```
```bash
git show <sha>:apps/api/src/<handler>.ts | grep -n "objectKey\|presignUpload"
# PASS: `${tenantId}/.../${randomUUID()}.${ext}` ahol ext az allowlist-ből jön
# FAIL: `filename` / `body.filename` / `originalname` bármi formában a key-ben
```
Teszt: "the client filename NEVER enters the object key" -- assert-álja, hogy a REVIEW-ban küldött `filename` (pl. `"evil.exe"`) NEM jelenik meg a presign result `objectKey`-jében.

**2. Image/content-type allowlist (ne bízz az extension-ben)**
Extension → content-type MAP-ot kell használni; nem MIME-sniff, nem whitelist-string-concat:
```bash
git show <sha>:apps/api/src/<handler>.ts | grep -n "IMAGE_EXT_TO_TYPE\|allowedTypes\|contentType.*Map\|ext.*map"
# PASS: ReadonlyMap<ext, mime> -> get(ext) -> undefined = 415
# FAIL: `filename.endsWith('.jpg')` vagy concat-os MIME (bypass: `evil.jpg.php`)
```
Elfogadott ext-ek: jpg/jpeg/png/webp/heic/gif (project-specifikus lehet). Minden más → 415 `forms.photo.typeNotAllowed`.

**3. Traversal guard minden path-komponensen**
jobId, fieldKey, tenantId, ext -- mindegyikre:
```bash
git show <sha>:apps/api/src/<handler>.ts | grep -n "assertNoTraversal\|includes.*'\\.\\.'\\|charAt\|charCodeAt"
# '/', '\\', '..', C0 control chars (charCode < 32, 127) → 400
```
Plusz charset regex az opaque ID-kre: `/^[A-Za-z0-9_-]{1,64}$/` → 400 ha nem illeszkedik.

**4. RBAC guard → job-scope guard sorrendje (layering)**
A coarse RBAC gate (pl. `Action.FormSubmit`) fusson le ELŐBB, a job-assignment check UTÁNA:
```bash
git show <sha>:apps/api/src/<handler>.ts | grep -n "authorizeScoped\|isAssignedToJob\|Action\."
# Sorrend: authorizeScoped(ctx, Action.X) -> isAssignedToJob(...) -> presign
```
Teszt: "role WITHOUT FormSubmit → ForbiddenError BEFORE job lookup" -- a spy-ra fogott jobAssignment `isAssignedToJob` NEM fut meg.

**5. Job-scope fail-closed (nincs oracle)**
Csak a hozzárendelt filler presignálhat. A hibakód legyen opaque (ne áruljon el assignment-existence-t):
```bash
git show <sha>:apps/api/src/<handler>.ts | grep -n "isAssignedToJob\|FormPhotoNotAssigned\|notAssigned"
# Ha unassigned -> opaque 403, NEM "job not found" (enumeráció!), NEM 404
```

**6. TTL + méretkorlát (DoS cap)**
```bash
git show <sha>:apps/api/src/<handler>.ts | grep -n "ttlSeconds\|maxBytes\|TTL\|MAX_BYTES"
# PASS: ttlSeconds <= 600, maxBytes <= 50MB (tipikusan 300s / 10MB)
```

**7. Kulcs-ütközés megelőzés (két presign → különböző key)**
```bash
git show <sha>:apps/api/src/<handler>.ts | grep -n "randomUUID\|uuid\|nanoid\|crypto\.random"
# Legalább egy véletlenszerű komponens a key-ben
```
Teszt: "two presigns return DISTINCT objectKeys" -- assert `key1 !== key2`.

**Presign gate összefoglaló (7 kötelező check):**
| # | Mit néz | Buktatók |
|---|---------|----------|
| 1 | objectKey server-derived | filename a key-ben = FAIL |
| 2 | ext → MIME allowlist Map | string-concat bypass |
| 3 | traversal guard minden komponensen | `../`, `/`, control chars |
| 4 | RBAC before job-scope | helytelen sorrend = privilege escalation út |
| 5 | job-assignment fail-closed (opaque) | "not found" = oracle |
| 6 | TTL + maxBytes | DoS cap hiánya |
| 7 | random UUID komponens | fix key = overwrite lehetőség |

Valós eset (FORM-6, 4e6539b): mind a 7 teljesül -- `randomUUID().ext`, allowlisted ext Map, `assertNoTraversal` + charset minden komponensen, RBAC before job-lookup, `FormPhotoNotAssignedError` (opaque), 300s/10MB, 24/24 teszt.

### RLS migration SQL review gate (CHAT-F1a tanulság)
SQL-only kártyánál (nincs futó kód, csak migráció) az alábbi checklist elegendő. Nincs vitest; az SQL maga a deliverable.

**1. tenant_id FK minden táblán**
```sql
-- Minden CREATE TABLE-ben kötelező:
tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
```

**2. Composite FK-k ugyanazon tenant szülőhöz**
Gyerek tábla (pl. `message_receipts`) nem csak `tenant_id REFERENCES tenants`-t tart, hanem a közvetlen szülőre is composite FK-t: `(tenant_id, message_id) REFERENCES conversation_messages(tenant_id, id) ON DELETE CASCADE`. Ez biztosítja, hogy a sor csak ugyanazon tenant parent-hez kötődhet.

**3. tenant_id vezet MINDEN indexet**
```bash
git show <sha>:packages/control-plane/migrations/<migration>.sql | grep -A2 "CREATE.*INDEX"
# PASS: minden indexben tenant_id az első oszlop
# FAIL: bármi más első helyen (tenant bypass lehetséges index-only scan esetén)
```

**4. RLS ENABLE + FORCE + NULLIF fail-close**
```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;    -- FORCE: a tábla owner sem kerüli meg
DROP POLICY IF EXISTS <t>_tenant_isolation ON <t>;
CREATE POLICY <t>_tenant_isolation ON <t>
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- NULLIF('', '') = NULL -> sor kizárva / write visszautasítva (PG-18 pool-reuse fail-close)
```

**5. DROP POLICY IF EXISTS a CREATE POLICY előtt** -- idempotens re-run

**6. IF NOT EXISTS minden CREATE-en** -- CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS

**7. GRANT write-szemantikához igazítva**
| Jellemző | GRANT |
|---|---|
| Csak olvas + felvesz (immutable) | SELECT, INSERT |
| Mutálható (muted toggle, join/leave) | SELECT, INSERT, UPDATE, DELETE |
| Csak előre haladhat (DELIVERED → READ) | SELECT, INSERT, UPDATE |

**8. Nincs DOWN szekció** -- a CleanCore migration runner up-only (0022/0023/0026 mind); ha a 0022/0023 mintát követi, DOWN nem várható.

**Cascade lánc ellenőrzés:**
```
tenants → table_A → table_B → table_C
```
Minden `ON DELETE CASCADE` az elvárt irányban és a megfelelő PK-ra mutat (nem csak `tenant_id`, hanem a composite PK `(tenant_id, id)`-re).

Valós eset (CHAT-F1a, 770523b): 4 tábla (conversations/participants/messages/receipts), teljes cascade lánc, 3 tenant_id-vezető index, NULLIF fail-close 4×, GRANT write-szemantikához ✓.

### PG adapter gate checklist (CHAT-F1b / scripted-session pattern)
Durable PG adapter kártyánál (RLS-5 TenantSqlSession.withTenant seam, scripted unit + env-gated e2e).

**1. withTenant minden op-on**
```bash
git show <sha>:apps/api/src/pg-<domain>-store.ts | grep -n "withTenant\|session\."
# PASS: minden pub metódus session.withTenant(tenantId, fn)-n belül fut
# FAIL: közvetlen tx.query() hívás session.withTenant nélkül
```

**2. Belt-and-suspenders: explicit tenant_id predikátum**
```bash
git show <sha>:apps/api/src/pg-<domain>-store.ts | grep -n "WHERE tenant_id = \$1"
# Minden SELECT/INSERT/UPDATE hord explicit tenant_id = $1 predikátumot
```
Scripted unit teszt assertálja: `for call of session.calls: expect(call.params[0]).toBe(tenantId)`.

**3. Opaque null (no existence oracle)**
Absent/cross-tenant sor → `return null` (nem NotFoundException, nem 404 -- ne árulja el a sor létezését más tenant számára). Teszt: üres rows → null + a participants/joined query NEM fut meg (`session.calls.toHaveLength(1)`).

**4. SQL keyset pagination (NEM in-app full-fetch)**
```bash
git show <sha>:apps/api/src/pg-<domain>-store.ts | grep -n "LIMIT\|ORDER BY\|cursor"
# PASS: ORDER BY (...) LIMIT $N a SQL-ben; nincs .slice()/.filter() az összes sor felett
# FAIL: SELECT * FROM messages WHERE ...; rows.slice(offset, limit) -- in-app pagination NO-GO
```
Teszt: `expect(call.text).toMatch(/LIMIT \$N/)` + `call.params[limitIdx] === limit + 1` (limit+1 fetch a hasMore detektáláshoz).

**5. Cursor first-page null guard**
```sql
AND ($3::bigint IS NULL OR created_at_ms > $3 OR (created_at_ms = $3 AND id COLLATE "C" > $4))
```
`$3::bigint IS NULL` → TRUE ha nincs cursor → no filtering. Teszt: `call.params[2] === null` (first page).

**6. E2E env-gated skip nem QA FAIL**
`describe.skipIf(!PG_URL)` a pattern. Ha `PG_E2E_URL` nincs set (embedded-postgres soname issue WSL-en vagy CI-n nincs postgres service), az e2e skip expected -- nem FAIL. Megjegyzendő a verdiktben. CI postgres:16 service-en futnak. A unit tesztek (scripted session) elegendők a QA gate-hez.

**Scripted-session assert minta (non-vacuous):**
```typescript
expect(session.tenants).toEqual([tenantId])          // withTenant-en belül futott
expect(session.calls[0]!.params[0]).toBe(tenantId)   // tenant_id 1. param
expect(session.calls).toHaveLength(1)                // cross-tenant: nincs join query
```

Valós eset (CHAT-F1b, 32441d0): 7 op, mind withTenant-en, explicit $1 predikátum, opaque null (no participant join), SQL keyset limit+1, cursor null guard, 10/10 scripted unit, tsc clean, e2e 6 skip (PG_E2E_URL hiány -- expected).

### Async HTTP handler gate checklist (CHAT-F1c / RLS-5 Opt2 handler pattern)
Ha egy kártya RLS-5 Opt2 mintájú HTTP handler-eket vezet be (async read → sync domain guard → async write), az alábbi checklist kötelező:

**1. RBAC coarse gate FIRST:**
```bash
git show <sha>:apps/api/src/<domain>-http.ts | grep -n "authorizeScoped\|requireTenant" | head -10
# PASS: authorizeScoped(ctx, Action.X) a handler LEGELEJÉN, requireTenant(ctx) utána
# FAIL: bármely store hívás ELŐTTE fut
```

**2. tenantId forrása: ctx, soha nem body:**
```bash
git show <sha>:apps/api/src/<domain>-http.ts | grep -n "body\.\|tenantId" | head -20
# PASS: requireTenant(ctx) -> tenantId; sehol body.tenantId
```

**3. Opaque hiba cross-tenant/not-found esetén:**
- Hiányzó/más-tenanthoz tartozó erőforrás → generikus opaque hiba (pl. `ThreadNotVisible`), nem 404
- Teszt: `conv === null → throw ChatError(ThreadNotVisible)` -- a kód NEM árulja el, létezik-e a sor más tenantban

**4. Server-generated azonosítók:**
- Üzenet ID: `deps.newId()` -- nem kliens-küldött
- Sender: `ctx.userId` (SOHA nem `body.senderId`)

**5. Idempotency dedup (double-post védelem):**
- `findByIdempotencyKey(tenantId, convId, ctx.userId, key)` → original visszaadva ha találat
- A kulcsban `ctx.userId` van -- nem forgatható más tenant/user idempotencyKey-jére

**6. Limit clamp (DoS védelem):**
- `clampLimit(page.limit)`: default ≤ 50, max ≤ 100; negatív/undefined is kezelt
- Teszt: `limit=9999 → 100`

**7. Receipt forward-only (READ terminál):**
- `getReceipt → existing ?? deliverReceipt(...)` -- DELIVERED ha még nincs
- `markReceiptRead(existing)` -- csak előre haladhat, DELIVERED → READ, soha vissza

**8. In-memory store length-prefixed kulcsok:**
```typescript
// PASS: injektív, no collision
const lp = (...parts: string[]) => parts.map(p => `${p.length}:${p}`).join(':')
// FAIL: plain concat -> "ab" + "cd" == "a" + "bcd"
```

**9. Route-policy/http-guard deferred (kártya-specifikus):**
- Ha a dispatch jelzi, hogy a route wiring külön follow-up kártyán van, NE QA FAIL
- Jelezd a verdiktben: "route-policy deferred, follow-up kártya nyitva"

**10. F0 regresszió (domain modul refactor esetén):**
```bash
npx vitest run packages/modules/<domain>/src/ 2>&1 | tail -5
# PASS: mind a F0 teszt zöld
```

**Valós eset (CHAT-F1c, 4ccad55):** sendChatMessageHttp / listChatMessagesHttp / markChatMessageReadHttp -- 11/11 handler teszt + 67/67 F0 regresszió (conversation-service refactor behavior-preserving), messaging.error.* 4 kulcs 7/7 locale paritás, tsc EXIT 0.

### Route-mount gate checklist (CHAT-F1d tanulság)
Ha egy kártya már megírt handler-eket köt be a guarded tenant pipeline-ra (route-policy + http-guard), a gate az alábbi pontokat ellenőrzi:

**1. Route-policy bejegyzések (route-policy.ts):**
```bash
git show <sha>:apps/api/src/route-policy.ts | grep -n -A5 "CARD_ID\|conversations\|<domain>"
# Ellenőrizd: method, pattern, shell, action -- mind helyes?
# shell='manager' ha Crew is manager-shellbe tartozik (vagy a megfelelő shell)
# action = a handler authorizeScoped-jában szereplő Action
```

**2. http-guard wiring (http-guard.ts):**
```bash
git show <sha>:apps/api/src/http-guard.ts | grep -n "register.*<domain>\|<domain>Http\|conversationStore"
# PASS: router.register('METHOD', '/path', (ctx, req) => handlerHttp(...)) ✓
# Ellenőrizd a path-extractor regex-eket: [^/?]+ (nem [^/]+, mert a ? is megállít)
```

**3. Fail-closed optional store / AppDeps wiring:**
```bash
git show <sha>:apps/api/src/http-guard.ts | grep -n "??\|readonly.*Store.*optional\|conversationStore"
# PASS: deps.store ?? createInMemory<Domain>Store() -- fail-closed amíg nincs valós wiring
# Ha a store kötelező: nincs ?? default, viszont az assembleAppRouter-ben mindig injektált
```

**4. Route-inventory guard (az összes handler lefedve):**
```bash
# Ellenőrizd, hogy van-e "every registered handler maps to a ROUTE_POLICIES entry" típusú teszt
git show <sha>:apps/api/src/http-guard.test.ts | grep -n "route-inventory\|registrations\|matchRoute"
# Ha megvan: az új route-ok automatikusan ellenőrzöttek -- nincs szükség külön policy-tesztre
# Ha nincs: minden új route-ra explicit policy-teszt kell
```

**5. End-to-end guard teszt (3 kötelező ág):**
- **Pozitív (jogosult, participant):** a handler végigfut, eredményt ad
- **RBAC fail-closed (guard-szint, szinkron):** a role WITHOUT az Action → ForbiddenError a GUARDON (nem a handlerben)
- **Domain fail-closed (handler-szint, async):** jogosult role, de non-participant / nem látható erőforrás → opaque domain hiba (pl. ChatError, nem 404)

**6. Path extractor biztonság:**
```bash
git show <sha>:apps/api/src/http-guard.ts | grep -n "exec(path)\|searchParams\|Number.isFinite"
# Regex: [^/?]+ (megáll a ? query-stringnél) -- NE [^/]+ (a ? részt is felveszi)
# Limit: Number.isFinite guard, különben NaN kerül a clampLimit-be
```

**7. Shared fájlok (route-policy.ts, http-guard.ts) -- csak saját blokk módosítva:**
```bash
git show <sha> -- apps/api/src/route-policy.ts apps/api/src/http-guard.ts | grep "^+" | grep -v "^+++" | wc -l
# Más agent kódjába NEM nyúl bele (shared checkout invariant)
```

**Regresszió checklist:**
```bash
npx vitest run apps/api/src/http-guard.test.ts  # teljes http-guard teszt
npx vitest run apps/api/src/<domain>-http.test.ts  # handler regresszió
npx tsc --noEmit  # típusellenőrzés
```

**Valós eset (CHAT-F1d, b4b06da):** 3 chat route (POST/GET/POST) -- route-policy 3 entry (ChatPost/ChatRead, shell=manager), http-guard 3 register, fail-closed empty store (`?? createInMemoryAsyncConversationStore()`), route-inventory guard automatikusan lefedi, E2E: participant send/list ✓, Client ForbiddenError guardon ✓, non-participant ChatError handleren ✓. 50/50 + 21/21 regresszió + tsc EXIT 0.

### Deferred-handler batch route-mount gate (ROUTE-MOUNT-BATCH / 3879e684 előkészítés)
Ha több domain handler kerül egyszerre be a guarded pipeline-ra (pl. LEAVE/FORM/KIOSK/SUBCON), a gate a route-mount checklistet domenként ismétli. Plusz figyelési pontok batch-nél:

**1. Minden domain saját route-inventory tesztet kap:**
```typescript
it('ROUTE-MOUNT-BATCH LEAVE: the 7 leave routes are registered + policied', () => {
  const regs = router.registrations()
  const expected = ['POST /leave/requests', 'GET /leave/balance', ...]
  for (const path of expected) {
    const [method, p] = path.split(' ')
    expect(matchRoute(method, p.replace(/:id/g, 'sample'))).toBeDefined()
  }
})
```

**2. Per-domain RBAC authz mátrix (LeaveRequest vs LeaveManage példa):**
- LeaveRequest (Crew, Inspector, CrewLead, Dispatcher, Admin): request/cancel/balance/document
- LeaveManage (CrewLead.Own, Dispatcher.All, Admin.All): approve/reject/availability
- NEM jogosult (Client, WarehouseKeeper, Finance): 403 a GUARDON

**3. SoD (Segregation of Duties) end-to-end:**
```
request(Crew 'worker-1') → approve(Admin 'manager-1') ✓   (különböző user)
request(Crew 'worker-1') → approve(Crew 'worker-1')   FAIL (saját kérés jóváhagyása)
```

**4. Row-scope opaque guard (CrewLead.Own):**
- CrewLead saját crew tagján belül: PASS
- CrewLead másik crew tagján: opaque-404 (nem 403, mert a sor létezését nem árulja el)

**5. Cross-shell 403 (manager-shell route, portal role):**
- Client → 403 minden manager-shell leave route-on (szinkron, a GUARDON)

**6. Fail-closed optional store:**
- `leaveStore?: LeaveStore` -- `?? createInMemoryLeaveStore()` default
- Üres store = elveszett leave kérések per restart (dev/test), nem security hole

**Gate tiering:** LEAVE/FORM/SUBCON/KIOSK mind trust-boundary (RBAC + SoD + row-scope). Cybersec kötelező (approve SoD bypass, row-scope oracle, sick-reason field-RBAC).

### vi.mock hoisting TDZ trap (ca0934fd / MessagesPage tanulság)
Vitest automatikusan hoistol minden `vi.mock()` hívást a fájl tetejére -- az importok és `const`/`let` deklarációk ELÉ. Ha a mock factory callback-ben top-level `const`-ra hivatkozol, az a TDZ-ban van a factory futásakor: `ReferenceError: Cannot access 'MOCK_X' before initialization`.

**Detekció (kötelező minden vi.mock factory-t tartalmazó tesztfájlnál):**
```bash
# Vannak-e top-level const-ok amikre a factory hivatkozik?
git show <sha>:apps/web/src/features/<mod>/<Page>.test.tsx | grep -n "vi.mock\|MOCK_\|const MOCK"
# Ha a vi.mock factory-ban MOCK_* string jelenik meg, és az ugyanabban a fájlban
# const MOCK_*-ként van deklarálva -> TDZ csapda
```

**A teljes suite 0 teszttel elbukik** -- nem csak egy-egy teszt fail. A hibaüzenet:
```
ReferenceError: Cannot access 'MOCK_X' before initialization
 ❯ src/features/.../Page.test.tsx:N:M  (a factory hívásánál)
```

**Fix 1 -- vi.hoisted() (ajánlott):**
```typescript
// Mozgasd a factory által szükséges adatokat vi.hoisted() blokkba:
const { MOCK_MSGS, MOCK_CONV_CREATED } = vi.hoisted(() => ({
  MOCK_MSGS: [
    { id: 'msg-1', conversationId: 'conv-1', ... } as ChatMessage,
  ],
  MOCK_CONV_CREATED: { id: 'conv-new-001', kind: 'DIRECT', ... } as ChatConversation,
}))

// Most már biztonságos a factory-ban hivatkozni:
vi.mock('./chatApi', () => ({
  listMessages: vi.fn().mockResolvedValue({ items: MOCK_MSGS, nextCursor: null }),
  createConversation: vi.fn().mockResolvedValue(MOCK_CONV_CREATED),
}))
```

**Fix 2 -- beforeEach + külön .mockResolvedValue():**
```typescript
// A factory csak vi.fn()-eket ad:
vi.mock('./chatApi', () => ({
  listMessages: vi.fn(),
  createConversation: vi.fn(),
  sendMessage: vi.fn(),
  markMessageRead: vi.fn(),
}))
// A top-level konst maradhat:
const MOCK_MSGS: ChatMessage[] = [...]
// beforeEach-ben settelj:
beforeEach(() => {
  vi.mocked(listMessages).mockResolvedValue({ items: MOCK_MSGS, nextCursor: null })
})
```

**Gate reflex:** ha a tesztfájl `vi.mock(path, factory)` alakot tartalmaz ÉS a factory belsejében van bármilyen azonosító hivatkozás (nem inline literal), futtasd a tesztet ELŐSZÖR és ellenőrizd hogy legalább 1 teszt lefutott (nem `Tests: no tests`). 0 teszt = suite-level hiba, nem egyedi teszt fail.

**Valós eset (ca0934fd @ 6961ee6):** `MessagesPage.test.tsx` line 64 `MOCK_MSGS` hivatkozás a factory-ban, de `const MOCK_MSGS` line 24-en van. Teljes suite 0/0 -- QA FAIL. Fix: `vi.hoisted()` vagy `beforeEach` pattern.

## Források
- https://martinfowler.com/articles/practical-test-pyramid.html
- https://www.browserstack.com/guide/qa-best-practices
- https://www.netguru.com/blog/qa-best-practices
- https://www.testrail.com/blog/testing-pyramid/

# BE Gate Patterns -- részletes buktató katalógus

## WIRING-GAP slice gate checklist (ismétlődő minta)
"Wire X endpoint" kártyák egységes mintája: handler + route-policy már létezett,
csak `router.register()` hívás hiányzott -> 501 runtime.

Minimális gate-checklist:
1. `authorizeScoped(ctx, Action.X)` az ELSŐ hívás a handlerben
2. Row-scope ha jelezve: `assertXReadScope()` / `RowScope.Own` vs `RowScope.All`
3. Defense in depth: store-val visszakapott sor `tenantId` re-ellenőrzése
4. Opaque 404: `*NotFoundError` suffix -> 404 via suffix rule
5. Teszt: nem 501/NoHandlerError-t dob, hanem domain NotFoundError-t
6. Route inventory coherence: `router.registrations()` tartalmazza az új route-ot
7. Nincs route-policy / http-status.ts módosítás (ha policy entry már létezett)

Cybersec szükséges ha: row-scoped (own/all), PII adat, trust-boundary.
Csak QA: adminisztratív read (belső audit log, nem user-facing PII).

---

## Role-literal vakuum (1a47cac2 tanulság)
Ha domain-szintű role-check belső string-et keres ('warehouse_admin') DE a valódi
`MembershipRole` enum értéke eltér ('warehouse'), a tesztek 80/80 zöldek lehetnek
mert a teszt-mock is a bugos stringet adja.

Ellenőrzés:
```bash
grep -n 'isWarehouse\|hasRole\|ctx.roles' apps/api/src/<domain>.ts
grep -n 'WarehouseKeeper\|MembershipRole\.' apps/api/src/identity.ts
# Párosítsd: a kért string-literál megvan-e az enum-ban?
```

Ha eltérnek -> a 100% zöld teszt vákuum. Helyes pattern: tesztben `MembershipRole.X` konstans, nem hardcoded string.
Valós eset: 1a47cac2 -- 'warehouse_admin' vs 'warehouse'. 80/80 PASS (vákuum), Cybersec NO-GO elo reprodukcioval.

---

## Validációs hiba -> 500 anti-pattern (kötelező lefedettség)
Ha egy domain hibaosztály NINCS STATUS_BY_NAME-ben (`apps/api/src/http-status.ts`), az
`httpStatusForError()` 500-at ad vissza -- kliens-hiba esetén is. Ez QA FAIL.

BLOKKOLÓ gate-szabály: minden ÚJ `*Error` osztályhoz UGYANABBAN a commitban kell:
1. Explicit STATUS_BY_NAME bejegyzés (400/409/403 -- soha ne maradjon 500-ra esve)
2. Explicit `http-status.test.ts` assertion: `expect(httpStatusForError(err('XxxError'))).toBe(YYY)`

Ellenőrzés:
```bash
git show <sha> -- apps/api/src/http-status.ts      # STATUS_BY_NAME bejegyzés
git show <sha> -- apps/api/src/http-status.test.ts  # teszt assertion
```

---

## Atomic port vs. compensation saga (acef8c85 tanulság)
Multi-leg write (pl. 2-location TRANSFER):

FAIL pattern -- compensation saga (try/catch visszaíró leg): az in-memory store nem tud Leg 2-t elbuktatni
=> catch ág dead code a tesztekben.

PASS pattern -- atomic port (`applyDeltas([leg1, leg2])`):
1. `applyDeltas([leg1, leg2])` egy hívásban -- mindkettő commit vagy mindkettő rollback
2. In-memory: validate-all-then-apply-all
3. PG: egyetlen `withTenant` tranzakcióban futnak az UPSERT-ek

Gate checklist:
```
# 1. ALL-OR-NOTHING: ANY leg fails -> NEITHER persists
# 2. PG transaction: tenantScopes === 1
# 3. Nincs compensation branch (dead code nem megengedett)
# 4. Cross-tenant reject: legs straddling tenants -> throw, nothing applied
```

---

## Round-trip persistencia-teszt (ne maszkold in-memory)
```
ROSSZ: step2({ ...step1Result, graceEndsAt: manualDate }) -- szétválik amit a DB tárol
JÓ:   step2(step1Result.graceEndsAt) -- ha a DB nem mentette, step2 null-t kap és elbukik
```

---

## Staging race: tartalom idegen commitba kerül
Ha az ügynök kódja nem a saját feature-commitjában landolt (pl. prettier chore), de a REVIEW a feature-commitra hivatkozik:
- `git show HEAD:<fajl>` -- ellenőrizd, hogy a tartalom HEAD-en intact-e
- Ha intact: gate-elj, jelezd ("Staging note: tartalom X commitban landolt, HEAD-en intact")
- Ha HIÁNYZIK: QA FAIL -- a kód nincs commitolva

---

## Pure domain + injected port gate checklist (6bde1999 tanulság)
1. **Actor/tenant forrás**: minden workerId -> ctx.userId, tenantId -> requireTenant(ctx), SOHA nem body.*Id
2. **SoD**: `actor === resourceOwnerId` -> SpecificSoDError; mindkét oldal ctx-ból; tenant guard ELŐBB fut SoD-nál
3. **Workflow transitions fail-closed**: pending-ból lehet dönteni, terminal state-ből throw
4. **Foreign row filtering**: `filter(r => r.tenantId===tenantId && r.workerId===workerId && r.type===type)`
5. **Injected port**: validáció (assertSameTenant/scope-check/traversal reject) ELŐTTE, port UTÁNA
6. **Immutability**: `return { ...entity, newField }` -- spread + override, eredeti érintetlen
7. **Non-vacuous tesztek**: konkrét napszámok assertálva, port-spy igazolja hogy NEM hívódik bad input-ra
8. **tsc projekt-szintű**: `npx tsc --noEmit 2>&1 | grep "<module-name>"`

---

## Async durable-before-ack tesztelés (8deac0b2 tanulság)
Szinkron -> async refaktornál két dedikált teszt kell:
1. **Throws -> reject, nem ack-elt**: `commitAppend` kivételt dob -> `appendAuditState` rejectál ÉS bejegyzés NEM kerül ack-olt chainbe
2. **Delayed commit -> ack csak write resolve után**: késleltetett `commitAppend` -> ack CSAK a Promise resolve-a után

---

## In-memory store + periodikus refresh gate-elése (27d5c8d7 tanulság)
Periodikusan újratöltődő in-memory store-nál (pl. superadmin 90s refresh): a "burned" state SOHA nem kerül visszaállításra refresh után.

Kötelező ellenőrzési séma:
1. Burns külön Map-ben él a roster-től; `loadRoster()` CSAK roster-t cseréli
2. `withBurn() max-merge`: `step = max(DB-row ?? burn, in-memory-burn)` -- stale DB-sor esetén is érvényes az in-memory burn
3. **burn-survives-refresh teszt**: égess -> stale DB-t tölts be -> `store.refresh()` -> `AlreadyUsed` (nem `Burned`)
4. `findByToken=null`: magic-link accountoknak nincs static bearer
5. Boot-seed: konstruktor await-eli a loadRoster()-t

---

## Atomic lockout adapter gate (recordAttempt -- 3d65e1c5/6c5052b8)
1. Egy statement: `expect(sql.calls).toHaveLength(1)`
2. Kizárólag bound paraméterek: SQL szövegben nincs interpolált literál
3. SQL shape: `ON CONFLICT ... DO UPDATE`, `WHERE ... >= 0`, `RETURNING`
4. Dual fail-closed: 0 rows -> InsufficientStockError; 23514 CHECK violation -> InsufficientStockError
5. Nem-constraint hiba propagálódik (nem swallow-olódik)
6. NUMERIC coercion: PG NUMERIC stringként érkezik -> `Number()` kell
7. In-memory referencia length-prefixed kulcs: `${t.length}:${t}|${a.length}:${a}|${l}`

---

## PG 18 custom GUC pool-reuse csapda (a3709edb -- RLS fail-closed)
PG 18-ban pool-reuse esetén `set_config(..., true)` commit után `''` marad a connectionön
(nem NULL). `NULLIF(current_setting('app.tenant_id', true), '')::uuid` wrapper kell a policy-ban.

Gate checklist RLS migráció vizsgálatánál:
1. USING és WITH CHECK mindkét ágában `NULLIF(..., '')` wrapper megvan-e?
2. Az e2e teszt pool-reuse-t szimulál-e (max:1 pool, előbb volt is_local set)?

---

## Payment webhook gate checklist (pénz-útvonalon kötelező)
1. Amount reconciliation: `event.amountCents === invoice.expectedAmountCents` settle előtt
2. VAT-aware compare (MoR): LemonSqueezy `total` = BRUTTO, invoice = NETTO; VAT-tudatos reconcile
3. Idempotency: `(provider, providerEventId)` UNIQUE + idempotent settle
4. Tenant/invoice re-check: DB-ből olvas, nem webhook claim-et bíz
5. Raw bytes a verify-nek: nem JSON round-trip előtte
6. LS replay defense: `assertPaymentEventNotReplayed` a reconcile ELŐTT hívódik
7. Vault/env runtime secret: boot-refuse ha hiányzik prod-on
8. No leaked keys: `JSON.stringify(checkoutSession)` nem tartalmaz `apiKey`/`webhookSecret`

---

## Rate-limit / lockout guard gate checklist (546d7e5b)
Részletesen: SKILL-FULL-BACKUP.md#1101.

## Vacuous `.not.toBe(prefix)` -- partial string mismatch (caf9aaf9 tanulság, 2026-08-02)
Egy `.not.toBe('internal')` assertion vacuous ha a valós error code string 'internal_error' (nem 'internal'): 'internal_error' != 'internal' -> PASS -- bár a hiba fennáll (500 státusz esetén a pipeline 'internal_error' kódot ad, nem 'internal'-t). A primary status assertion (`toBe(404)`) elég a regressziót lefogni, de a secondary code-assertion nem erősíti a védelmet.

Pattern: `expect(res.body.error.code).not.toBe('internal')` helyett mindig: `expect(res.body.error.code).toBe('exact_expected_code')`.

Kapcsolódó általános minta: [[vacuous-not-tobe-assertion]].

---

## Error name vs. STATUS_BY_NAME name mismatch (64e493e7 tanulság, 2026-07-31)
Új hibaosztály megvizsgálásakor NEM elég hogy LÉTEZIK egy STATUS_BY_NAME bejegyzés -- a bejegyzés NEVének pontosan egyeznie kell a `this.name` értékkel.

Valós eset: `AssetQrRenderError` (`this.name = 'AssetQrRenderError'`) -- a STATUS_BY_NAME-ben `QrRenderError: 500` volt (az EREDETI site-renderer hibaosztálya). A kettő NEM illeszkedik, így `AssetQrRenderError` a default 500 fallthrough-ra esik, és a response code `internal_error` lesz `qr_render` helyett. A HTTP status helyes (500), de a kód informatívabb lett volna. Severity: NOTE (nem FAIL, ha a status helyes és generikus), de rögzítendő.

Ellenőrzés:
```bash
# 1. Milyen name-t állít be az osztály?
git show <sha> -- apps/api/src/<file>.ts | grep "this\.name"
# 2. Van-e PONTOSAN ez a name STATUS_BY_NAME-ben?
git show <sha> -- apps/api/src/http-status.ts | grep "<ExactName>"
# Ha nincs pontos match: ellenőrizd a fallthrough-t (NotFoundError suffix? GoneError suffix? .status field?)
# Ha a fallthrough 500 ad de a STATUS 500 kellene -> NOTE, nem FAIL
# Ha a fallthrough 500 ad de a STATUS 4xx kellene -> FAIL (validációs hiba 500-ra esik)
```

Fix: vagy reuse a meglévő hibaosztályt (`QrRenderError`), vagy adj hozzá `AssetQrRenderError: 500` + PUBLIC_5XX_CODES entry + http-status.test.ts assertion.

---

## Migráció: child table cross-tenant FK rés (6af23cea tanulság, 2026-07-31)
Ha egy child table `invoice_id REFERENCES parent_table(id)` FK-val kötődik a szülőhöz, DE a child saját RLS policy-ja csak `child.tenant_id = GUC`-ot ellenőriz: egy ügynök (GUC=B, tenant_id=B) insertálhat SAJÁT tenant_id=B-s sort egy IDEGEN invoice (tenant=A) alá.

Miért: a FK-ellenőrzés a DB szintjén bypass-olja az RLS-t (a FK constraint látja a parent sort, a policy nem védi a FK-t). A child RLS WITH CHECK `tenant_id=B = GUC=B` -> TRUE -> az insert sikeres.

Hatás:
- B nem látja A adatait (A olvasásnál GUC=A szűri ki B sorait)
- A nem látja B cross-linkelt sorát
- De B "roncsolja" A invoice-át (FK cascade: ha A törli invoice-át, B sora is törlődik)
- Violates principle: every child row's tenant_id must match its parent's tenant_id

Gate checklist (migration card-oknál):
```sql
-- Veszélyes minta: nincs cross-tenant constraint
CREATE TABLE child (
  tenant_id uuid REFERENCES tenants(id),  -- saját RLS OK
  parent_id uuid REFERENCES parent(id),   -- FK bypass-olja a parent RLS-t
  ...
);

-- Biztonságosabb minta 1: trigger vagy CHECK kényszer (PG trigger kell, CHECK nem tud cross-table-t)
-- Biztonságosabb minta 2: app-rétegben enforcement (withTenant scope-ol, parent id-t is tenant-scope-al lekéri)
-- Biztonságosabb minta 3: composite FK (tenant_id, parent_id) REFERENCES parent(tenant_id, id) -- parent-en UNIQUE(tenant_id, id) kell
```

Ha a child tábla RLS-sel van védve DE nincs composite FK:
- Cybersecnek ANNOTÁLNI kell (trust-boundary finding, nem feltétlenül FAIL ha az app réteg kielégítően scope-olja)
- QA-nál: NOTE a verdiktben, nem FAIL -- feltéve hogy az app réteg enforce-olja (withTenant + parent tenant check)

---

## Fail-closed guard AND-feltétel bypass (9a218e6c tanulság, 2026-08-02)
Egy fail-closed guard `if (!asyncStore && required && !syncStore)` feltétele -- a harmadik `!syncStore` tag BYPASS-t nyit: ha egy sync in-memory store injektálva van, `!syncStore = false` -> a feltétel false -> a guard NEM dob -> a kód silently folytatódik a nem-durable ágon.

Pattern neve: "guard weakened by unexpected AND clause" -- az extra `&&` tag szűkíti a dobtáblt.

Ellenőrzési szabály BE fail-closed guard vizsgálatánál:
1. Olvasd el az összes feltételt sorban: van-e olyan tag ami "hacsak valami más is jelen van" mintát követ?
2. Ha igen: az AND-olt tag bypass-olja-e a guard-ot egy alternatív dependency-vel?
3. Helyes forma: a guard CSAK a szükséges feltételt nézi (`!asyncStore && required`), nem tartalmaz "mentesítő" tagot.

Regressziós teszt minta: `durableWiringRequired=true + sync store injektálva -> EvaluationStorageUnavailableError`.

---

## Külső API proxy endpoint QA checklist (d702d593)
1. Paraméter sanitizáció: sort=__proto__ -> default; injection stripped; limit clamp
2. Auth gate: unauthed -> 401
3. Élő eredmény valósság-ellenőrzés: curl-lal real API hívás
4. Válasz-mezők teljessége: id, numerikus mezők `Number.isFinite`
5. i18n paritás; error state-ek (Rule-12)
Valós eset: SKILL-FULL-BACKUP.md#679.

---

## Marveen/fleet model-fallback gate patterns (dda9870, ae55270, e33af7c4 tapasztalat, 2026-08-02)

CleanCore-tól eltérő hatókör: `src/` (marveen repo), nem `/mnt/h/LM_Studio_Workdir/CleanCore`.
Teszt futtatás: `cd /tmp/cc-qa-<sha> && npx vitest run src/` (worktree-ben).
tsc: `npx tsc --noEmit` (project root-ból a worktree-ben).

### MODEL_LADDER sorrend-változás gate checklist
1. `git show <sha>:src/model-catalog.ts | grep -A15 'MODEL_LADDER'` -- a committed ladder sorrendje
2. Assertion a sorrendre: van-e explicit `MODEL_LADDER[0]` / `ladderIndexOf` összehasonlítás az új tesztekben?
3. Régi sorrend-feltételezés sweep: `git show <sha>:src/__tests__/ | grep -i "fable\|haiku\|sonnet\|opus"` -- minden teszt-fájlban, nem csak a módosítottban
4. Stale komment vs assertion: elavult komment ("tier 1 from haiku is fable-5. That IS cheaper") NEM FAIL ha nincs assertion rá -- jelezd a verdiktben, ne blokkold a PASS-t
5. Rung-index konzisztencia: `ladderIndexOf('claude-<model>')` hívások a tesztekben tényleg a committed ladder-t fedik-e?

### NO_HAIKU_AGENTS / floor guard checklist
1. Agent nevek exact egyezés: `NO_HAIKU_AGENTS` set tagjai == `/api/agents` listán szereplő `agent_id`-k?
2. `applyNoHaikuFloor` wiring: `grep -n 'applyNoHaikuFloor' src/web/model-fallback-runner.ts` -- futó ÉS parkolt agent útvonalban kell
3. `decideParkedModelUpdate` agentName: opcionális param esetén `undefined` eset megőrzi a régi viselkedést (ne törje a meglévő teszteket)
4. `buildAgentTierRows` floor: `tier > 0` ágban van-e `applyNoHaikuFloor` hívás a display logikában?
5. Single source of truth: a cheaper-tier-wins guard (`ladderIndexOf(weeklyModel) < ladderIndexOf(currentModel)`) a `decideParkedModelUpdate` pure függvényben van, NEM újraimplementálva a runnerben

### Worktree setup (marveen gate) -- BINDING: fleet-test.sh, SOHA nem /tmp (9070461f, 2026-08-06)
`/tmp` worktree-ből 7 teszt-fájl NÉMÁN SKIP-el (a hook-registration guard helyesen elutasítja a
`/tmp`-gyökerű script-utakat) -- ebből korábban "14 bukó teszt" baseline lett, holott 13 pusztán
artefakt volt. A régi `WDIR="/tmp/cc-qa-<cardid>"` minta EZT a csapdát futtatta.

Helyes eljárás -- EGY állandó, újrahasznosított worktree a `store/fleet-test.sh`-n keresztül:
```bash
# adott commit tesztelése:
bash {{INSTALL_DIR}}/store/fleet-test.sh --ref <sha> src/__tests__/x.test.ts --reporter=verbose
# tsc az állandó worktree-ben (a script maga cwd-t vált {{INSTALL_DIR}}-test-re):
cd {{INSTALL_DIR}}-test && npx tsc --noEmit 2>&1 | grep -E "error TS" | head -20
```
NINCS cleanup -- a `{{INSTALL_DIR}}-test` szándékosan maradandó (elsőre létrehozza, utána
reset+clean-eli a megadott commitra). Ha egy másik agent commit-ot dolgoz fel közben, a script
automatikusan a kért `--ref`-re állítja, nem ütközik.

Ismert, nem-blokkoló baseline-hibák ezen a worktree-n (külön kártyát igényelnek, NEM e kártya hibái):
`template-identity-hygiene.test.ts` (hardcode-olt abszolut home-utak a seed-skills/dream-ben) és
`memory-performance.test.ts` (Ollama-fuggő teszt-premissza, ha Ollama fut).

---

### Cross-agent isolation negatív teszt (baeddb21 tanulság)
Marveen fleet memory functions (`saveFailedEpisode`, `listFailedEpisodes`, `auditMemoryRecall` stb.)
agent_id paraméteres szűrést használnak. A pozitív tesztek (agent A adatait agent A visszakapja)
nem fedik azt, hogy agent A adatai NEM látszanak agent B lekérdezésekor.

Kötelező negatív atom marveen memory-jellegű kártyákon:
```typescript
// saveData for agentA
// query with agentB
const result = listXxx('agent-b', 100)
expect(result.find(r => r.agentId === 'agent-a')).toBeUndefined()
```
Ha ez hiányzik: UNTESTABLE (low risk, parameterized SQL) -- de MINDIG jelezd a verdiktben
és javasold follow-up patchben való pótlást.

---

### Marveen script-only gate (0d08f623 minta)
Ha a kártya kizárólag shell scriptet vagy ops scriptet ad hozzá (`store/*.sh`), test-pyramid N/A.
Spec-teljességi ellenőrzés:
1. Fájl ténylegesen jelen van a commitban: `git show <sha> --stat`
2. Protokoll-compliance: pl. SKIP/marker kimenet, exit 0 mindig
3. Read-only-e: NEM hívja a side-effect scripteket (csak kommentben hivatkozik)
4. Regex szinkronban a referencia-implementációval (`quota-check.sh` / `model-fallback.ts`)
5. Fail-safe guard: `|| echo 0`, `|| true`, `set -uo pipefail`
6. Nincs hardcoded secret
7. Gate-tier: read-only ops script -> QA-only elegendo, Cybersec/Cybered NEM szukseges

Valós eset: 0d08f623 (sched-precheck-quota-monitor.sh, commit acad210) -- QA2 PASS.

---

### ÚJ VISELKEDÉS TESZTLEFEDETTSÉG -- kötelező ellenőrzés (qa-qa2-strictness-gap tanulság)
A base-flow tesztek zöldje NEM elegendő. Az adott kártya ÚJ deliverable-je/viselkedése
külön tesztelve legyen.

Ellenőrzési séma minden kártyánál:
```bash
# 1. Mi az ÚJ viselkedés / mező / logika?
git diff <sha>^ <sha> --name-only

# 2. Van-e teszt KIFEJEZETTEN az ÚJ kódra?
git show <sha>:path/to/test.ts | grep -n "new-field\|new-behavior-name"

# 3. A tesztek lefedik az ÚJ feltételes ágakat?
git show <sha>:path/to/impl.ts | grep -n "if\|else\|switch"
# Minden ághoz létezik-e teszt?
```

Ha a tesztek mind a RÉGI base-flow-t tesztelik és az ÚJ mező/logika 0 teszttel rendelkezik:
-> QA FAIL: "az ÚJ [X] viselkedésnek nincs tesztlefedése; base-flow zöldje nem bizonyíték"

Valós esetek (qa-qa2-strictness-gap memory, 2026-07-17):
- 3c7e58ed: 20/20 base teszt zöld, de title-input + includePhotos toggle = 0 teszt -> qa FAIL, qa2 PASS (TEVES)
- ab478ebb: siteName 3-szintű fallback untested -> qa FAIL, qa2 PASS (TEVES)
MikroB döntés: a SZIGORÚBB qa verdikt nyert. Qa2 volt a leniens outlier.

SZABÁLY: ha az ÚJ kódhoz nincs teszt -> mindig FAIL, nem számít hány base-flow teszt zöld.

---

### Security-finding fix kártyák gate-mintája ([LOW][SEC] típus)
Ezek a kártyák egy biztonsági találatot javítanak. A QA gate eltér a feature kártyáktól.

Minimális ellenőrzési séma:
```bash
# 1. A javítás PONTOSAN a finding-ban leírt problémát orvosolja?
git show <sha> --stat  # mely fájlok változtak?
git show <sha>:path/fix.ts | grep -n "konkrét_fix"

# 2. VAN negatív teszt a régi sebezhető viselkedésre?
git show <sha>:path/test.ts | grep -n "should not\|403\|reject\|FAIL\|unauthorized"
# Ha nincs negatív teszt -> QA FAIL (a finding-fix nem bizonyítható tesztelhetően)

# 3. A fix nem vezet be ÚJ sérülékenységet? (alapszintű check, Cybersec mélyebben nézi)
git show <sha>:path/fix.ts | grep -n "bypass\|skip\|TODO\|FIXME\|as any\|!important"
```

Döntési fa:
- Fix megvan + negatív teszt bizonyítja a blokkolást -> QA PASS
- Fix megvan de 0 negatív teszt -> QA FAIL: "a fix nincs tesztelve negatív esettel"
- Fix hiányzik (csak TODO/komment) -> QA FAIL: "a finding nincs javítva, csak dokumentálva"

Gate-tier: [LOW][SEC] kártyák általában Cybersec-ot is igényelnek (trust-boundary érintett);
QA a funkcionális helyességet + tesztlefedettséget nézi, Cybersec a tényleges exploit-megszüntetést.

Valós esetek közelgő kártyákon: 914a2cc7 (CP-5 belső szerepkör határ),
2cb07372 (Feedback cross-tenant olvasás), 8779c351 (Presign replay), 767f9fc5 (Asset-type katalógus).

---

### "Header-ben van" != "argv-ben nincs" -- SAJAT HIBA (defcc189/bf6fe53, 2026-08-06)
KRITIKUS KULONBSEG, amit sajat magam tevesztettem el: `printf 'Authorization: Bearer %s\n' "$(cat token)" | curl -H @-`
a token-t a HEADER-be teszi (nem URL query-be), DE ez EGYARANT argv-ben van -- lathato `ps aux`-szal
es `/proc/<pid>/cmdline`-mal, PONTOSAN ugyanaz az osztaly mint a 0864de63-on helyesen elkapott
a `?key=<titok>` alaku URL-leak.

A HELYES minta: a header-tartalom FAJLBA irva (0600 mode), majd `curl -H "@fajl"`. Ekkor a token
SOHA nem jelenik meg a curl process argv-jeben.

Ellenorzesi seman: NE csak azt nezd, hogy a token URL-ben van-e (`?key=`) -- nezd meg AZT IS,
hogy a `-H` argumentum maga tartalmazza-e a nyers token erteket (`$(cat ...)` vagy kozvetlen
valtozo-interpolacio a `-H` stringben). Ha igen -> FAIL, akkor is ha "header-ben van".

```bash
# ROSSZ -- token argv-ben, akkor is ha headerkent kuldve:
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" | curl -H @- "$URL"

# JO -- token soha nem jelenik meg argv-ben:
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$HDR_FILE"
curl -H "@$HDR_FILE" "$URL"
```

Valos eset: sajat QA2 PASS-t adtam a bf6fe53-ra ("Bearer token HEADER-ben, nem URL-ben VERIFIED"),
holott a `local-llm-queue-result.sh:25` PONTOSAN a ROSSZ mintat hasznalta. A testver `qa` FAIL-t,
Cybersec NO-GO-t adott ugyanarra a commitra -- ok fogtak meg, en nem. Javitva 4a6ce08-ban.

**Tanulsag**: minden `-H "..."` curl-hivast, ami titkot tartalmaz, KULON ellenorizz -- a `-H` forma
maga NEM ment meg semmit, csak a `@fajl` forma biztonsagos.

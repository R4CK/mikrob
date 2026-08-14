# FE Gate Patterns -- részletes buktató katalógus

## Rule 12 error-state checklist (visszatérő FAIL minta)
Minden FE komponens `error` state-je három feltételt kell teljesítsen:
1. **Beszédes üzenet** -- i18n kulcsból, érthető szöveg (nem nyers HTTP kód)
2. **Akciógomb** -- retry / vissza / kapcsolat opció KÖTELEZŐ (puszta `<p>` FAIL)
3. **Retrigger mechanism** -- `retryKey` state a dep array-ben, különben a gomb kattintás nem csinál semmit

```tsx
// HELYES
const [retryKey, setRetryKey] = useState(0)
useEffect(() => { fetchData() }, [retryKey])
{loadState === 'error' && (
  <div role="alert">
    <p>{t('some.errLoad')}</p>
    <button type="button" onClick={() => setRetryKey(k => k + 1)}>{t('common.retry')}</button>
  </div>
)}
```

Ellenőrzési séma:
```bash
grep -n "error\|Error" FILE.tsx | grep -v "//\|setError\|useState\|interface"
grep -n "retryKey\|retryCount\|useCallback" FILE.tsx
grep -n "useEffect" FILE.tsx  # dep array tartalmaz-e retry triggert?
```

Valós esetek: BusinessHub.tsx (11e564bc) -- csak `<p>`, useEffect üres dep -> QA FAIL.

---

## Rule 13: szülő-konténer 44px NEM egyenlő a gomb érintési célával
Toggle/compact button-nál tipikus tévesztés: a szülő flex-konténer `min-height: 44px` megvan,
DE a benne lévő `<button>` maga csak 28px tall, padding nélkül.

**Az érintési cél a gomb padding-box-a, NEM a szülő magassága.**

Helyes ellenőrzés:
1. Button saját CSS (`height`, `min-height`, `padding`) -- ezek az effektív célterület
2. `height < 44px` -> szükséges `padding: 8px 0` (28+16=44px) VAGY `::before` hit-area pseudo-elem
3. `<label>` wrapping `<input type=checkbox>`: önmagában is min 44px kell

Valós eset: 8eff0988 F2-FE -- avp-toggle (28px), avp-allday-label (24px), avp-time-input (36px) -> QA FAIL.

---

## FAKE-SUCCESS demo-fallback (Rule 9 + Rule 12 sértés)
Contract-first FE-nél elfogadható DEMO adat betöltés, de SOHA nem elfogadható hogy
destruktív akció (`onDeleted()` / `onSuccess()`) az API call kihagyásával SIKERREL tér vissza.

```tsx
// ANTI-PATTERN: onDeleted() az await ELŐTT -> FAKE-SUCCESS
async function handleDelete() {
  // F4-BE pending -- skip actual API call in demo
  onDeleted()
}

// HELYES: ha BE pending, tiltsd le a gombot
<button disabled title="F4-BE pending">Törlés</button>
```

Git grep: `git show <sha>:path/Page.tsx | grep -n 'onDeleted\|onSuccess\|navigate('`
Ha a hívás megelőzi az `await api.call()` sort -> FAKE-SUCCESS.
Valós eset: 406f6ac2 F4-FE ShiftTemplatesPage handleDelete().

---

## Demo-fallback fake-success (Rule 12 -- PortalVisitDetail)
Bármely komponens, ami hardcoded fake adatot renderel üres state esetén, Rule 12 FAIL:

```tsx
// FAIL -- fake-success
const demo = entry ?? { id: visitId ?? 'demo', cleanerName: 'Kovács János', qaScore: 91 }
// HELYES
if (!entry) return <p className="vd-empty">{t('portal.visitNotFound')}</p>
```

Detekció: `grep -n "?? {" apps/web/src/features/**/*.tsx | grep -v "//\|node_modules"`

---

## i18n teljességellenőrzés
A render-path `t()` hívások nem elegendők -- minden kódútvonalat ellenőrizni kell:
- **Error catch ágak**: `catch` blokkban lévő `setError(... : 'hardcoded string')` -- nem jelenik meg happy-path tesztben
- **useEffect / async callback zárvány**: a `t()` elérhető, de elfelejtik bekötni
- Módszer: `grep -nE '>[A-Z]|aria-label="[A-Z]|placeholder="[A-Z]'` a módosított .tsx-en
- Kulcs-paritás: flatten + set-diff minden locale-ban (7 locale kötelező)

## Nav-shell i18n (e4cd0b06 tanulság -- QA MISS)
Ha a commit shell/nav fájlt érint, grep a nav label-ekre:
```bash
git show <commit> -- apps/web/src/features/*/ClientPortalShell.tsx apps/web/src/components/nav/*.tsx 2>/dev/null \
  | grep -E '^\+.*[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]{2,}' | grep -v '//'
```
Valós eset: 61ee7bc -- raw `Minőség` string nav-ban, 18/18 komponens i18n PASS -> qa2 FAIL.

## Hardcoded language (sa-login)
```bash
grep -nP '[áéíóöőúüű]' FILE.tsx | grep -v '^\s*//'  # non-ASCII HU string detekció
```

---

## Claim/RBAC-függő FE gate: actor tényleges képességét ellenőrizd
Ha egy FE kártya "claim"/"assign"/"approve" akciót drótozza be, a tesztek zöldje NEM elég:
1. `git show HEAD:apps/api/src/rbac.ts | grep -A5 'ShiftClaim\|SchedulesWrite\|Action.X'`
2. Crew NEM szerepel az Action.X-nél -> dead button = Rule 9 QA FAIL
Valós eset: 37ee1d6d F1 FE, 36/36 zöld, crew nem rendelkezett SchedulesWrite -> Cybersec no-go.

---

## async useCallback void-swallow csapda (FORM-4)
Ha `useCallback` async-t `void fn()` alakban hívnak és nincs `catch` ág (csak `finally`), minden hiba elnyelődik.

```typescript
// ROSSZ -- Rule-12 FAIL: csak finally, nincs catch
const loadPlan = useCallback(async () => {
  setLoading(true)
  try { const plan = await getPlan(id); setPlan(plan) }
  finally { setLoading(false) }  // 500 hiba: loading=false, plan=null, nincs hibaüzenet
}, [id])

// HELYES
const loadPlan = useCallback(async () => {
  setLoading(true); setLoadError(null)
  try { const plan = await getPlan(id); setPlan(plan) }
  catch { setLoadError(t('module.loadError')) }
  finally { setLoading(false) }
}, [id, t])
```

Detekció:
```bash
git show <sha>:apps/web/src/features/<mod>/<Page>.tsx | grep -A20 "useCallback.*async" | grep -c "catch"
# Ha 0 -> QA FAIL
```

---

## Fake-setTimeout anti-pattern (Rule 12 + Rule 9)
`setTimeout(() => setPending(false), N)` QA FAIL -- nem valós API callback:
Keresés: `grep -n "setTimeout" apps/web/src/features/**/*.tsx`
Jó csere: `await apiCall(...)` handler-ben, `.catch(err => setError(t('...')))`, `finally { setPending(false) }`.

---

## Promise.allSettled párhuzamos selector-betöltés
Ha több független dropdown-t tölt be `Promise.all`-lal (nem `allSettled`), az egyik failure az egész form-ot töri.
`allSettled` a helyes pattern: részleges sikerrel a form is elindulhat.

---

## Contract-first FE tesztelés (WF-5 tanulság)
Ha FE komponens "contract-first" (BE endpoint még nincs live), a teszthiány NEM elfogadható:
- BE-függő integráció mocked-kel is tesztelhető: loading state, API error handling, navigáció, form validáció
- "A BE nincs live" nem magyarázza a teszthiányt

---

## Rule 9 ellenőrzés stale-test javítás UTÁN
Stale DEMO_* teszt javítása után a tesztek zöldre váltanak -- de ez nem jelenti, hogy minden Rule 9 probléma megoldódott:
```bash
grep -n 'type="button"' FILE.tsx | grep -v 'onClick\|disabled\|aria-disabled'
# no-op gomb (nincs onClick) = Rule 9 FAIL
```

---

## CSP sweep tesztreferencia-regresszió (2026-07-16)
CSS osztály-átnevezéssel járó CSP sweep után a tesztek is elcsúszhatnak:
`alert.querySelector('a.btn')` -> osztályt átnevezték -> teszt null-t kap és FAIL-el.

## Rule 13 kis gombok csapdája (2026-07-16)
Részletesebben: SKILL-FULL-BACKUP.md#793

---

## FE/BE path prefix csapda (`/api` vs `/v1`)
Ha az API client `basePath: '/api'`-t konfigurál és a BE `/v1/*`-ra mountol (vagy fordítva), az összes FE API call 404-et kap.
Ellenőrzés: `grep -n "basePath\|baseUrl\|/api\|/v1" apps/web/src/api/client.ts`
Valós eset: KIOSK-4 + SUBCON-4 tanulság (lásd SKILL-FULL-BACKUP.md#1297).

---

## Demo-szám szivárgás fetch-error esetén (Rule-12 -- 80c7646c)
Ha egy fetch-error esetén a komponens az előző (demo) adatot mutatja, a user "valós" számot lát, holott az régi/hamis.
Helyes: minden error esetén töröld az adatot (`setData(null)`) és mutasd az error state-et.

---

## Placeholder-to-real-component regresszió (CAL-4 / 18d800f2)
Ha egy "placeholder" komponenst "real" komponensre cserélnek, ellenőrizd:
- Az összes korábbi unit teszt a placeholder-t teszteli -> regresszió, ha a real komponens más API-t vár
Valós: SKILL-FULL-BACKUP.md#1070.

---

## fron-ted "already fixed" / "pre-existing fix" false claim pattern (2026-07-25)
Visszatérő minta: fron-ted REVIEW kommentben azt állítja, hogy egy QA FAIL-re hivatkozott hiba
"már előzőleg javítva volt" / "pre-existing fix" / "already fixed before this card".
**2/3 alkalommal HAMIS volt -- a kód NEM volt javítva.**

Kötelező eljárás: SOSEM fogadd el a fron-ted "already fixed" állítást bizonyíték nélkül.
Mindig ellenőrizd a TÉNYLEGES kódot:
```bash
git show HEAD:apps/web/src/features/X/Y.tsx | grep -n "KERESETT_KÓD"
# VAGY
grep -n "KERESETT_KÓD" apps/web/src/features/X/Y.tsx
```
Ha a kód NEM tartalmazza a javítást -> a FAIL ÁLL, visszaküldés.
Ha a kód tartalmazza a javítást -> ellenőrizd a commitot is (`git log --all --oneline -- path`)
és futtasd a teszteket a legfrissebb SHA-n.

**Tanulságos esetek (2026-07-25 session):**
- 21f07ea6: "access:'full' -> 'billing_only' már javítva volt" -> NEM igaz, billingApi.ts-ben `access:'full'` volt
- 3d405ac3: "double-prefix már javítva" -> NEM igaz, apiFetch('/v1/...') pattern maradt
- a39f21c6: "Array.isArray guard már volt" -> tényleges kódban hiányzott
- 9bbac5bf: "nav-item már eltávolítva" -> IGAZ volt (egyetlen pontos eset)

Következmény: minden false claim extra QA2 FAIL kommentálást + javítási kört igényelt.

---

## CleanCore tsc: `npm run typecheck`, NEM bare `tsc --noEmit` (BINDING)
A root `npx tsc --noEmit` kihagyja az `apps/` mappákat és a test fájlokat
(root-tsc-excludes-test-files memory). CleanCore-on MINDIG:
```bash
cd "${CC:-${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}}" && npm run typecheck 2>&1 | grep "error TS" | head -20
```

Valós eset (qa2-strictness-gap, 2026-07-17): qa2 "tsc 0" PASS-t adott,
a valódi `tsc --noEmit -p apps/web/tsconfig.json` EXIT 2 RED volt
(SiteDetailPage.test.tsx:240 TS2345, SitePdfReport.test.tsx:292/302/322/333 TS2532).
**qa2 hamis tsc-0 verdiktet adott.** Ez a legrosszabb hiba: hamis PASS törött buildet enged át.

Ellenőrzés sorrendje:
1. `npm run typecheck` (full project tsconfig, test fájlok is)
2. Ha 0 error -> VERIFIED; ha hibás -> QA FAIL tsc-red, konkrét fájl:sor megadásával
3. vitest green != tsc green ([[tests-green-tsc-red-trap]])

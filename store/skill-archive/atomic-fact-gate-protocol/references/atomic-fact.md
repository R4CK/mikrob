# Common Claim Decompositions

Claim-típusonként az elvárt atomi tények. Minden gate ezt bővítheti saját lencsével.

---

## "A tesztek zöldek" / "X/X teszt passed"

| Atom | Ellenőrzés |
|------|-----------|
| A teszt-fájl ténylegesen a MEGVÁLTOZOTT kódot teszteli | `git diff <sha>^ <sha> --name-only` -> a tesztelt modul rajta van-e? |
| Az assertionök nem üresek / vacuous | `git show <sha>:path/test.ts \| grep -E "expect\(.*\)\.(not\.)?toBe\|toEqual\|toThrow"` -- `.not.toBeUndefined()` nem számít |
| A módosított kód-sor dentro van a tesztelt függvényen belül | `git show <sha>:path/impl.ts` + `git show <sha>:path/test.ts` -- a `describe` scope lefedi a changed function-t? |
| tsc clean (vitest nem type-check-el) | `npx tsc --noEmit 2>&1 \| grep "error TS"` -- üres output = VERIFIED |
| Commit nem üres | `git diff <sha>^ <sha> --name-only` -- ha üres: FAILED, nincs committolt fájl |

---

## "Auth guard van" / "authorize() hívva"

| Atom | Ellenőrzés |
|------|-----------|
| `authorize(ctx, Action.X)` / `authorizeScoped(...)` létezik a handlerben | `git show <sha>:path/handler.ts \| grep -n "authorize"` |
| ELSŐ hívás (adat-mutálás / DB-query előtt) | a grep találat line száma < az első `await` / DB-hívás sora |
| 401/403 teszt létezik a specifikus Action-re | `git show <sha>:path/handler.test.ts \| grep -A3 "403\|401\|ForbiddenError\|UnauthorizedError"` |
| tenantId kizárólag `ctx.tenantId`-ból | `git show <sha>:path/handler.ts \| grep -n "tenantId"` -- body/params nincs? |

---

## "RLS érvényes" / "tenant izoláció megvan"

| Atom | Ellenőrzés |
|------|-----------|
| `session.withTenant(tenantId, ...)` wrapper megvan | `git show <sha>:path/store.ts \| grep "withTenant"` |
| Explicit `WHERE tenant_id = $1` minden lekérdezésben | `git show <sha>:path/store.ts \| grep -n "WHERE\|tenant_id"` |
| rawClient NEM használatos tenant-scoped adaton | `git show <sha>:path/store.ts \| grep "rawClient"` -- ha van: FAILED |
| Negatív teszt: más tenant adatát nem adja vissza | test fájlban van-e cross-tenant assertion? |

---

## "Rollback pont mentve" / "store/.update-history bejegyzve"

| Atom | Ellenőrzés |
|------|-----------|
| `recordUpdateHistory` / `appendFileSync` hívva a success ágban | `git show <sha>:path/impl.ts \| grep "recordUpdateHistory\|appendFileSync"` |
| A TSV shape helyes (6 mező, field[1]=="update") | teszt: `recordUpdateHistory` describe-ján belül TSV shape test |
| fromSha != toSha guard: no-op esetén nem ír | teszt: `does NOT write a line when fromSha === toSha` |
| Csak success-ágban ír (conflict/failure esetén NEM) | `performUpstreamMerge -- conflict` test: `recordCalls === 0` |

---

## "Idempotens migráció"

| Atom | Ellenőrzés |
|------|-----------|
| `IF NOT EXISTS` minden `CREATE TABLE/INDEX`-en | `git show <sha>:path/migration.sql \| grep -c "IF NOT EXISTS"` vs CREATE COUNT |
| `DROP POLICY IF EXISTS` `CREATE POLICY` előtt | `git show <sha>:path/migration.sql \| grep -B1 "CREATE POLICY"` |
| `BEGIN/COMMIT` wrap | `git show <sha>:path/migration.sql \| grep -E "^BEGIN\|^COMMIT"` |
| `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` | `git show <sha>:path/migration.sql \| grep -iE "ENABLE\|FORCE"` |

---

## "Frontend hiba-kezelés megvan" (Rule 12)

| Atom | Ellenőrzés |
|------|-----------|
| i18n kulcsból jön a hibaüzenet (nem hardcode) | `git show <sha>:path/component.tsx \| grep -n "t('" -- minden hiba-szöveg? |
| Error state UI-ban renderelve (nem csak console.error) | `git show <sha>:path/component.tsx \| grep -n "error\|Error\|catch"` -- van JSX return? |
| Retry / back akció van a hiba-állapotban | komponensben van-e `onClick` a hiba-állapot JSX-en belül? |
| Catch ág NEM swallow-olja a hibát | `git show <sha>:path/component.tsx \| grep -A5 "catch"` -- `.catch(() => {})` = FAILED |

---

## "Honeypot / fake-success nincs" (FAKE-SUCCESS buktató)

| Atom | Ellenőrzés |
|------|-----------|
| `onSuccess()` / `onDeleted()` AWAIT után hívódik | `git show <sha>:path/component.tsx \| grep -B5 "onSuccess\|onDeleted"` -- `await` ott van? |
| API hívás valóban megtörténik (nem stub / no-op) | integrációs teszt vagy network call van a tesztre? |
| Response shape megfelel a tényleges API-nak | `SubmitXResponse` típus == a handler `json(res, {...})` payload-ja? |

---

## "Lock / CAS guard müxik" (concurrent write védelem)

| Atom | Ellenőrzés |
|------|-----------|
| Guard a MUTATION előtt fut | sorrendet nézd: `git show <sha>:path/impl.ts` -- guard megelőzi a write-t? |
| Failure path `releaseLock()` hívja | `git show <sha>:path/impl.ts \| grep -A10 "catch"` -- ott van a release? |
| Race condition teszt létezik | test fájlban van-e concurrent scenario? |

---

## "TypeScript hiba javítva" / "tsc clean"

| Atom | Ellenőrzés |
|------|-----------|
| tsc clean a commiton | `npx tsc --noEmit 2>&1 \| grep "error TS"` -- üres output = VERIFIED |
| Nincs elnyomás `@ts-ignore` / `@ts-expect-error` | `git show <sha>:path/file \| grep "@ts-ignore\|@ts-expect-error"` -- ha van: FAILED |
| Nincs `as any` prod kódban (test kód kivételével) | `git show <sha>:path/file \| grep "as any"` -- prod fájlban FAILED; test helper spy: elfogadható |
| A fix valódi típusszűkítés, nem cast-alapú elnyomás | a diff bemutatja a típus-flow pontosítását (pl. `string \| undefined` -> re-cast union) -- nem `// @ts-ignore` line-t töröl |

Valós eset (52f905ed, 0df0de3): `errBody.code as RegistrationErrorCode` (TS2367) ->
`rawCode = errBody.code as string` majd `rawCode as RegistrationErrorCode` -- helyes string narrowing, nem elnyomás.

---

## Általános negatív atom (minden kártyánál kötelező)

Ha a claim egy "X NEM történik" típusú biztonság: a negatív eset TESZTELVE legyen.

| Atom | Ellenőrzés |
|------|-----------|
| Negatív teszt (unauthorized attempt blocked) | `grep -n "403\|401\|ForbiddenError\|should.*not\|rejects" path/test.ts` |
| Boundary negatív (más tenant adatát nem adja vissza) | cross-tenant negative teszt? |
| Input validation negatív (rossz típus / hiányzó mező) | `grep -n "invalid\|missing\|400\|ValidationError" path/test.ts` |

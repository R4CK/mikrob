---
name: embedded-pg-e2e-runner
description: Run RLS / PG-dependent e2e tests on WSL2 without Docker using embedded-postgres. Covers the full setup: module path resolution, CJS/ESM mismatch, LD_LIBRARY_PATH for WSL2, OOM-kill avoidance, and database URL wiring. Trigger: "run rls e2e", "PG_E2E_URL", "embedded-postgres", "e2e against real postgres", "rls-chat e2e", "run e2e without docker".
---
# Embedded PG18 E2E Runner

## Mikor használd
- RLS vagy PG-specifikus e2e tesztek futtatása Dockera nélkül (WSL2)
- `PG_E2E_URL` env var kell a teszthez, de nincs futó Postgres-példány
- CleanCore `rls-*.e2e.test.ts` fájlok futtatása

## A működő runner script

```js
// run-e2e.mjs  (ESM)
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// A FŐ klón node_modules-át címezzük, nem a worktree-ét (kártya 973ed6eb): a telepítés OTT
// történik, a worktree-k node_modules-a oda mutató SYMLINK. A TESZT viszont a saját
// worktree-dben fut -- lásd a cwd-t lentebb.
const CC_MAIN = process.env.CLEANCORE_MAIN || '/mnt/h/LM_Studio_Workdir/CleanCore'

// CJS/ESM mismatch: embedded-postgres exports CJS default, use createRequire + .default
const { default: EmbeddedPostgres } = require(
  CC_MAIN + '/node_modules/' +
  '.pnpm/embedded-postgres@18.4.0-beta.17/node_modules/' +
  'embedded-postgres/dist/index.js'
)

const PORT = 54320
const databaseDir = mkdtempSync(join(tmpdir(), 'pg-e2e-'))

const pg = new EmbeddedPostgres({
  databaseDir,
  port: PORT,
  user: 'postgres',
  password: 'password',
  persistent: false,
})

// WSL2: native lib must be on LD_LIBRARY_PATH or PG won't start
const libPath =
  CC_MAIN + '/node_modules/' +
  '.pnpm/embedded-postgres@18.4.0-beta.17/node_modules/' +
  '@embedded-postgres/linux-x64/native/lib'

try {
  await pg.initialise()
  await pg.start()
  await pg.createDatabase('e2etest')

  const PG_E2E_URL = `postgresql://postgres:password@localhost:${PORT}/e2etest`

  execSync(
    'npx vitest run apps/api/src/rls-chat.e2e.test.ts --no-file-parallelism',
    {
      // A SAJÁT worktree-d, sosem a megosztott klón:
      //   CC="$(/home/neon/marveen/store/agent-worktree.sh <a te agent-neved> --path)"
      cwd: process.env.CC || CC_MAIN,
      env: { ...process.env, PG_E2E_URL, LD_LIBRARY_PATH: libPath },
      stdio: 'inherit',   // inherit: stdout/stderr -> terminal, nem pufferelt
    }
  )
} finally {
  await pg.stop()
}
```

Futtatás: `node --experimental-vm-modules run-e2e.mjs`

## Buktatók

### 1. CJS/ESM mismatch -- `EmbeddedPostgres is not a constructor`
`embedded-postgres` CJS-ként épül, `require()` kell hozzá ESM-ből. Megoldás: `createRequire` + `.default` destructuring.

```js
// ROSSZ (ESM import -- TypeError: EmbeddedPostgres is not a constructor)
import EmbeddedPostgres from 'embedded-postgres'

// JÓ
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { default: EmbeddedPostgres } = require('.../embedded-postgres/dist/index.js')
```

### 2. `cannot open shared object file` -- DE ELŐBB MÉRD MEG, KELL-E EGYÁLTALÁN
**Mérve 2026-08-15 ezen a gépen: NEM kellett sem `LD_LIBRARY_PATH`, sem symlink-shim.**
`env -u LD_LIBRARY_PATH` mellett az `initialise()` + `start()` + egy valódi kapcsolat + `stop()`
végigment (PostgreSQL 18.4). Ha valaki azért nem futtat PG-s e2e-t, mert azt hiszi, hogy ehhez
külön setup kell, próbálja meg előbb setup nélkül -- valószínűleg megy.

Ha MÉGIS ez jön:
```
error while loading shared libraries: libpq.so.5: cannot open shared object file
```
akkor a diagnózis konkrét: nézd meg, hogy a hibaüzenetben NÉVSZERINT megnevezett soname létezik-e a
`@embedded-postgres/linux-x64/native/lib` mappában.
- ha ott van, csak nincs a loader útján -> `LD_LIBRARY_PATH` arra a mappára;
- ha NINCS ott, de van verziózott párja (pl. `libpq.so.5.18` van, `libpq.so.5` nincs) -> a csomagból
  hiányoznak a soname-symlinkek. Ez 2026-08-14-én pontosan így állt, mára javult.

Ilyenkor a symlinkeket **külön shim-mappába** tedd és azt fűzd elé, **SOHA ne a `node_modules`-ba**:
worktree-ben az a megosztott fő klónba mutató symlink, tehát ott az egész flotta fáját írnád át.
```bash
for f in "$NATIVE/lib"/*.so.*; do b=$(basename "$f")
  soname=$(echo "$b" | sed -E 's/^(.*\.so\.[0-9]+)\.[0-9.]+$/\1/')
  [ "$soname" != "$b" ] && ln -sf "$f" "$SHIM/$soname"; done
LD_LIBRARY_PATH="$SHIM:$NATIVE/lib" node <boot script>
```

### 3. OOM kill (exit 137) -- stderr/stdout túl nagy
Ha `stdio: 'pipe'` és a vitest + PG naplók pufferelve mennek, Node OOM-kill-t kaphat nagy outputnál.
Megoldás: `stdio: 'inherit'` (terminálra ír, nem pufferel) VAGY `stdio: ['inherit','pipe','pipe']` + a pipe-ot `grep`-pelni.

### 4. `PG_E2E_URL=1` timeout
Ha a tesztek `PG_E2E_URL`-t connection string-ként várják de csak `'1'`-et kapnak, a PG Pool connection timeout-ot dob.
Megoldás: mindig teljes URL: `postgresql://postgres:password@localhost:${PORT}/dbname`

### 5. Abszolút modul-útvonal
`require('embedded-postgres')` nem működik ha a szkript nem a CleanCore gyökeréből fut.
Mindig az abszolút `.pnpm/...` útvonalat add meg, pl.:
```
$CLEANCORE_MAIN/node_modules/.pnpm/embedded-postgres@18.4.0-beta.17/node_modules/embedded-postgres/dist/index.js
```

### 6. Worktree vs. main repo: migration-tartalom eltérhet
Ha a gatelendő commit egy FEATURE BRANCEN él (nem a main repo HEAD-en), a worktree
(`$HOME/qa-<cardid>`) más migráció-fájlokat tartalmazhat mint a main CleanCore checkout.
Ellenőrzés: `git -C "${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}" merge-base --is-ancestor <sha> HEAD`
Ha a commit NEM ős: a migrációkat a WORKTREE-ből kell futtatni, nem a main repóból.

```js
// ROSSZ (main CleanCore checkout, hiányozhat pl. 0089_worm_trigger.sql)
execFileSync('npx', ['tsx', 'apps/api/src/control-plane-migrate.ts'], { cwd: MAIN_REPO })

// JÓ (worktree, tartalmazza a feature-branch migrációit)
execFileSync('npx', ['tsx', 'apps/api/src/control-plane-migrate.ts'], { cwd: WORKTREE })
```

### 7. `pnpm vitest` worktree-ből pnpm install-t triggerel
Ha a worktree-ből `pnpm vitest run ...`-t futtatsz, a pnpm TTY nélkül megtagadja a
node_modules eltávolítását:
```
[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules directory
```
Megoldás: a vitest binárist az abszolút pnpm-útvonalról hívd (`node /abs/path/to/vitest.mjs`),
pnpm érintése nélkül:

```js
const CC_MAIN = process.env.CLEANCORE_MAIN || '/mnt/h/LM_Studio_Workdir/CleanCore'
const VITEST_BIN = CC_MAIN + '/node_modules/.pnpm/vitest@3.2.6_' +
  '@types+debug@4.1.13_@types+node@22.20.0_jsdom@25.0.1_terser@5.48.0/' +
  'node_modules/vitest/vitest.mjs'

execFileSync('node', [VITEST_BIN, 'run', 'apps/api/src/my.e2e.test.ts',
  '--no-file-parallelism', '--reporter=verbose'], { cwd: WORKTREE, ... })
```

### 8. PG adatkönyvtár /tmp-ben törlődik session-váltáskor
Az embedded PG data dir (`mkdtempSync(join(tmpdir(), 'pg-...'))`) WSL2-n a `/tmp` alá kerül,
ami session-zárásnál törlődhet. Egy megszakadt session után a PG process futhat (ps-ben látszik),
de `connect ECONNREFUSED` jön vissza mert az adatkönyvtár eltűnt.
Megoldás: mindig friss `mkdtemp`-pel indíts új PG-t, ne próbálj csatlakozni a régire.
A PG jelenlétét ne a process-listán ellenőrizd -- próbálj valódi connection-t.

### 9. A SÉMÁT EGYSZER kell felhúzni -- a `migration-idempotency.e2e` NEM provizionáló
Ez a legdrágább buktató a listán: **nem hibát okoz, hanem HAMIS MÉRÉST**, és a hiba a te kódodra
mutat, nem a provizionálásra.

`migration-idempotency.e2e.test.ts` SZÁNDÉKOSAN kétszer futtatja a teljes migrációs készletet (a
második menet a tesztje). A második menet a 0055 ismert nem-idempotenciáján hasal el -- de már
azután, hogy újra lefuttatta a **0010**-et (blanket `ALTER DEFAULT PRIVILEGES`/`GRANT`: visszaadja a
DELETE-et minden táblának, visszacsinálva minden későbbi REVOKE-ot) és a **0008/0025**-öt
(`CREATE OR REPLACE FUNCTION`: visszaállítja a 0125 előtti epoch-only WORM trigger-törzseket).

Mérve 2026-08-15, három futás, amik KIZÁRÓLAG a provizionálásban térnek el:

| provizionálás | sorrend | eredmény |
|---|---|---|
| friss DB + a lánc EGYSZER | csak a guard | 17/17 zöld |
| friss DB + a lánc EGYSZER | matrix, majd guard | 17/17 zöld |
| friss DB + idempotency (2 menet) | matrix, majd guard | **3 bukás**, közte 2 biztonsági állítás |

A tévedés **polaritás-függő**: egy "nem tarthatja" állítás hamisan PIROS, egy "már nem tartja"
hamisan ZÖLD -- és a második a veszélyes, mert haladásnak olvasódik. A piros pedig egy ártatlan
szomszéd fájlra mutat: egy egész délutánt vitt el, mire kiderült, hogy nem a fájl a hibás, hanem az
adatbázis (kártya e91e0b63).

**Helyesen:** a láncot EGY menetben alkalmazd, `applyOne`-nal végig, vagy a `control-plane-migrate`
úton. Két dolog, ami órát visz el, ha nem tudod:
- **az adatbázist `cleancore_control`-nak KELL hívni** -- a 0010 `GRANT CONNECT ON DATABASE
  cleancore_control`-t futtat, más néven a lánc ott elhasal;
- a `schema_migrations` táblát a RUNNER hozza létre (`ensureVersionTable`), NEM egy migráció (a 0087
  csak revokál rajta) -- ha kézzel applikálsz, neked kell létrehoznod.

**ÉS HA SZÁNDÉKOSAN a kétszer-applikált esetet akarod előállítani (pl. egy detektort mérsz), a
kísérlet HAMISAN ZÖLD lehet, mert a szennyezés meg sem történt.** A `migration-idempotency.e2e`
NEM hozza létre a `cleancore_control` adatbázist -- azt a matrix-e2e csinálja a saját `beforeAll`-jában.
Ha az idempotency fut ELSŐKÉNT egy olyan példányon, ahol az adatbázis még nincs meg, akkor már az
1. menet 0010-én elhasal (`GRANT CONNECT ON DATABASE cleancore_control`), tehát semmit nem applikál
kétszer, és a detektorod tiszta adatbázist mér -- zölden, hibátlanul, semmiről.

Ellenőrizd az idempotency-futás kimenetén, hogy MELYIK menet bukott:
```
pass 2: 0055_email_check_collation_pinned.sql is NOT re-applicable   <- JÓ: a szennyezés megtörtént
pass 1: 0010_audit_appendonly_role.sql ...                            <- ÜRES MÉRÉS: hozd létre a DB-t
```
(backend lelete, kártya e91e0b63; nálam azért nem jött elő, mert a provizionálóm létrehozta a
DB-t a futás előtt -- vagyis a csapda pont annak áll, aki NEM használ külön provizionálót.)

## Ellenőrzés
```bash
node --experimental-vm-modules run-e2e.mjs
# Várt kimenet: "X passed (X)" -- nincs OOM, nincs timeout, PG leáll a finally-ban
```
Ha jogosultságot vagy trigger-törzset MÉRSZ, előbb ezt ellenőrizd -- egy sor, és megfogja a
kétszer-applikált fát:
```sql
-- a 0123 REVOKE-ja: ha a conversations tart UPDATE-et vagy DELETE-et, a 0010 újra lefutott utána
SELECT privilege_type FROM information_schema.table_privileges
 WHERE grantee = 'cleancore_app' AND table_name = 'conversations';
-- várt: üres (vagy csak SELECT/INSERT)
```

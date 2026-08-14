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
      //   CC="$({{INSTALL_DIR}}/store/agent-worktree.sh <a te agent-neved> --path)"
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

### 2. LD_LIBRARY_PATH hiánya -- PG nem indul WSL2-n
A beágyazott PG natív binárisaihoz kellenek a `.so` könyvtárak. Ha hiányzik a `LD_LIBRARY_PATH`:
```
error while loading shared libraries: libpq.so.5: cannot open shared object file
```
Megoldás: `LD_LIBRARY_PATH` az `@embedded-postgres/linux-x64/native/lib` mappára.

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

## Ellenőrzés
```bash
node --experimental-vm-modules run-e2e.mjs
# Várt kimenet: "X passed (X)" -- nincs OOM, nincs timeout, PG leáll a finally-ban
```

// TEMPORARY DIAGNOSTIC (card 5dcde7d3) -- NOT a permanent part of the suite.
//
// The flotta-wide blocker: some test creates /home/neon/marveen-test/store/claudeclaw.db
// as a side effect MID-RUN (not a leftover from a prior run -- that case is already
// self-healed, see fleet-test.sh), which then trips assert-not-live-install.ts for every
// file that starts after it. Two independent hypotheses (db.ts's initDatabase() with no
// override, channel-coordinator's initIngestDb() with no override) were checked directly
// by instrumenting THOSE specific functions and came back negative -- the diagnostic never
// fired even on a run where the marker DID appear. That rules out both known JS-level
// call sites, but not a native-addon (better-sqlite3) path a plain function-level console.error
// cannot see if some other, ungrepped, code path holds its own handle.
//
// This uses fs.watch() on STORE_DIR instead: OS-level inotify catches ANY create/write in
// that directory regardless of whether it came through a JS-visible call or a native addon's
// own libuv/syscall path, so it cannot miss the culprit the way per-function instrumentation
// can. It cannot report a JS call stack (inotify has none), but combined with vitest's own
// beforeEach/afterEach it can report WHICH TEST was running at the moment of the event -- run
// with `--no-file-parallelism` for a clean single-worker correlation.
import { watch, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, afterEach } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const storeDir = join(repoRoot, 'store')
const target = 'claudeclaw.db'

const g = globalThis as unknown as { __diagMarkerCurrentTest?: string; __diagMarkerArmed?: boolean }

beforeEach((ctx) => {
  g.__diagMarkerCurrentTest = `${ctx.task.file?.name ?? '?'} > ${ctx.task.name}`
})
afterEach(() => {
  g.__diagMarkerCurrentTest = '(between tests)'
})

if (!g.__diagMarkerArmed && existsSync(storeDir)) {
  g.__diagMarkerArmed = true
  try {
    watch(storeDir, (eventType, filename) => {
      if (filename === target) {
        // eslint-disable-next-line no-console
        console.error(
          `DIAG-MARKER-EVENT type=${eventType} at=${new Date().toISOString()} ` +
            `pid=${process.pid} currentTest=${g.__diagMarkerCurrentTest ?? '(none yet)'}`,
        )
      }
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('DIAG-WATCH-SETUP-FAILED', err)
  }
}

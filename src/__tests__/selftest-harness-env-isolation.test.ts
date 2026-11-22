// Card 1634bf55 (backend report msg 23386 + MikroB comment 37609): a land selftest that forgets
// to stub KANBAN_COMMENT_API/KANBAN_COMMENT_TOKEN_FILE/LAND_RUN_JOURNAL_FILE reaches the REAL
// dashboard and the REAL store/land-runs.jsonl -- confirmed live (three real /api/messages posts,
// a +3-byte write to the real journal, during a concurrent fleet-test with no other land running).
//
// CYBERED NO-GO (comment 37616, F-3) on this file's first version: it defined its OWN copy of the
// dead-env values and spread them INSIDE the test's own execFileSync call, so it never touched the
// real harness code at all -- deleting the override from BOTH store-selftests-all-run.test.ts's
// execWithKillRetry AND landing-downward-check.test.ts's selftest() left this file green, because
// nothing it did exercised either one. It also only proved the probe script CAN leak, which was
// never in doubt (two more files, agent-worktree-marveen.test.ts and landing-gate-verdict-
// check.test.ts, already proved that live, unstubbed, in the real suite).
//
// The fix (this same card, same commit) moved the dead-env values into ONE real module,
// src/__tests__/setup/isolate-land-selftest-state.ts, with an EXPORTED function
// (applyDeadLandSelftestEnv) that both a global vitest `setupFiles` entry calls once per worker
// (closing the two files nobody edited) AND the two harness files call explicitly (defense in
// depth). "protection, real mechanism" below imports and calls that REAL function -- not a local
// redefinition -- so if its body is ever gutted to a no-op, that case goes red. "global setup
// actually ran" separately checks that THIS test file's own worker already has the dead values in
// process.env before any test body runs, proving the `setupFiles` wiring in vitest.config.ts is
// live, not just the function existing unused. "vitest.config.ts still registers the setup file"
// is a plain structural check against the registration line itself going missing.
//
// The recorder runs as a separate PYTHON subprocess, not an in-process Node http.createServer:
// execFileSync below is synchronous and blocks this process's own event loop for its whole
// duration, so an in-process recorder would never get to handle the connection while it runs
// (measured: a first draft using node:http hung the "mutant" case for the full curl --max-time
// window with zero hits, looking exactly like a false negative). Same reason every real land
// selftest in this repo (marveen-land-card-branch.selftest.sh, kanban-comment-lib.selftest.sh)
// shells out to a python recorder instead.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// CYBERED GO 37626, F-5(a): a STATIC top-level import of isolate-land-selftest-state.ts here would
// trigger that module's own module-load-time call to applyDeadLandSelftestEnv() the moment THIS test
// file is loaded -- identical to what the vitest.config.ts setupFiles entry does -- making "global
// setup actually ran" pass even with the setupFiles entry removed, because the test file's own import
// would do the exact same thing. Importing the module only INSIDE later test bodies (after the first
// test's assertion already ran) means the first test sees ONLY whatever setupFiles already forced.
type SetupModule = typeof import('./setup/isolate-land-selftest-state.js')
let setupModule: SetupModule | undefined
async function loadSetupModule(): Promise<SetupModule> {
  setupModule ??= await import('./setup/isolate-land-selftest-state.js')
  return setupModule
}

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const LIB = join(REPO_ROOT, 'store', 'kanban-comment-lib.sh')

const RECORDER_PY = `
import http.server, sys
LOG_FILE = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        body = self.rfile.read(length) if length else b""
        with open(LOG_FILE, "a") as f:
            f.write(self.path + "\\t" + body.decode(errors="replace") + "\\n")
        self.send_response(200); self.end_headers()
    def log_message(self, *a):
        pass
with http.server.HTTPServer(("127.0.0.1", 0), H) as srv:
    print(srv.server_address[1]); sys.stdout.flush()
    srv.serve_forever()
`

let recorderProc: ChildProcess | undefined
let savedEnv: Record<string, string | undefined> | undefined

beforeEach(() => {
  // These tests deliberately mutate process.env.KANBAN_COMMENT_API/KANBAN_COMMENT_TOKEN_FILE to
  // simulate an ambient leak; restore so one test's mutation cannot leak into the next test in
  // this same file (vitest isolates per FILE by default, not per `it`).
  savedEnv = {
    KANBAN_COMMENT_API: process.env.KANBAN_COMMENT_API,
    KANBAN_COMMENT_TOKEN_FILE: process.env.KANBAN_COMMENT_TOKEN_FILE,
  }
})

afterEach(() => {
  if (recorderProc) {
    recorderProc.kill()
    recorderProc = undefined
  }
  if (savedEnv) {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    savedEnv = undefined
  }
})

function readHits(logFile: string): Array<{ path: string; body: string }> {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const [path, body] = l.split('\t')
      return { path: path ?? '', body: body ?? '' }
    })
}

async function startRecorder(work: string): Promise<{ url: string; logFile: string }> {
  const logFile = join(work, 'recorder.log')
  writeFileSync(logFile, '')
  recorderProc = spawn('python3', ['-c', RECORDER_PY, logFile], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let portOut = ''
  recorderProc.stdout?.on('data', (c: Buffer) => {
    portOut += c.toString()
  })
  for (let i = 0; i < 100 && !/\d+/.test(portOut); i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  const m = /(\d+)/.exec(portOut)
  if (!m) throw new Error(`recorder never printed a port (got: ${portOut})`)
  return { url: `http://127.0.0.1:${m[1]}`, logFile }
}

function writeProbe(work: string): string {
  const probe = join(work, 'probe.sh')
  // Exactly what agent-worktree-marveen.test.ts's unstubbed call sites do (CYBERED F-1): source
  // the shared lib and post a comment, with NO override of their own -- relying entirely on
  // whatever the caller's inherited env (process.env, spread as-is) leaves them.
  writeFileSync(probe, `#!/usr/bin/env bash\nset -u\n. "${LIB}"\nkanban_comment_on "probe-card" "PROBE-BODY"\n`)
  return probe
}

describe('card 1634bf55: the real applyDeadLandSelftestEnv mechanism, exercised directly', () => {
  it('global setup actually ran: this worker\'s process.env is already dead before this file imports the module', () => {
    // No import of isolate-land-selftest-state.ts above this point in the file (see
    // loadSetupModule) -- if vitest.config.ts's setupFiles entry for it is ever removed, this is
    // the assertion that goes red, because nothing else would have set these values yet. The
    // literal values are duplicated from DEAD_LAND_SELFTEST_ENV on purpose: importing that
    // constant here would itself trigger the module's load-time side effect (CYBERED GO 37626,
    // F-5a), making this check pass even with setupFiles removed.
    expect(process.env.KANBAN_COMMENT_API).toBe('http://127.0.0.1:1')
    expect(process.env.LAND_RUN_JOURNAL_FILE).toBe('/nonexistent/no-such-dir/land-runs.jsonl')
  })

  it('vitest.config.ts still registers the setup file as an active (non-commented) entry', () => {
    // Text check, not a static import: vitest.config.ts sits outside src/ (tsconfig rootDir),
    // so importing it as a module would break the tsc build for this test file.
    // CYBERED GO 37626, F-5b: strip `//`-to-end-of-line comments before matching, otherwise a
    // commented-out setupFiles entry (text still present, never loaded) passes this check while
    // the actual leak returns.
    const configSrc = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf-8')
    const withoutLineComments = configSrc
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    expect(withoutLineComments).toMatch(/setupFiles:\s*\[[^\]]*isolate-land-selftest-state\.ts/s)
  })

  it('the dead values are actually dead: unreachable loopback port and nonexistent paths', async () => {
    // CYBERED GO 37626, F-6: pins the literal shape so a mutant pointing these at something
    // reachable (e.g. a real port, an existing writable path) is caught, not just "some string".
    const { DEAD_LAND_SELFTEST_ENV } = await loadSetupModule()
    expect(DEAD_LAND_SELFTEST_ENV.KANBAN_COMMENT_API).toBe('http://127.0.0.1:1')
    expect(DEAD_LAND_SELFTEST_ENV.GATE_CHECK_API).toBe('http://127.0.0.1:1')
    expect(existsSync(DEAD_LAND_SELFTEST_ENV.KANBAN_COMMENT_TOKEN_FILE)).toBe(false)
    expect(existsSync(DEAD_LAND_SELFTEST_ENV.GATE_CHECK_TOKEN_FILE)).toBe(false)
    expect(existsSync(DEAD_LAND_SELFTEST_ENV.LAND_RUN_JOURNAL_FILE)).toBe(false)
  })

  it('protection, real mechanism: an unstubbed call site cannot reach an ambient leak target once applyDeadLandSelftestEnv runs', async () => {
    const { applyDeadLandSelftestEnv } = await loadSetupModule()
    const work = mkdtempSync(join(tmpdir(), 'selftest-isolation-'))
    const { url: recorderUrl, logFile } = await startRecorder(work)
    const tokenFile = join(work, 'token')
    writeFileSync(tokenFile, 'probe-token\n')
    // Simulate an ambient leak: something upstream pointed KANBAN_COMMENT_API at a live-shaped
    // target (the recorder stands in for the real dashboard).
    process.env.KANBAN_COMMENT_API = recorderUrl
    process.env.KANBAN_COMMENT_TOKEN_FILE = tokenFile
    // The REAL exported function, not a local copy -- this is what the global setupFile calls
    // once per worker, and what store-selftests-all-run.test.ts / landing-downward-check.test.ts
    // call explicitly before their own exec calls.
    applyDeadLandSelftestEnv()
    const probe = writeProbe(work)
    // Exactly the vulnerable shape: an UNSTUBBED call site, plain spread, no override of its own.
    execFileSync('bash', [probe], { encoding: 'utf-8', env: { ...process.env } })
    expect(readHits(logFile)).toHaveLength(0)
    rmSync(work, { recursive: true, force: true })
  })

  it('MUTANT: the identical unstubbed call site DOES leak when applyDeadLandSelftestEnv is never called', async () => {
    const work = mkdtempSync(join(tmpdir(), 'selftest-isolation-mutant-'))
    const { url: recorderUrl, logFile } = await startRecorder(work)
    const tokenFile = join(work, 'token')
    writeFileSync(tokenFile, 'probe-token\n')
    // Same ambient leak as above, but the real function is never called -- the pre-fix shape for
    // a call site nobody remembered to stub (agent-worktree-marveen.test.ts, before this card).
    process.env.KANBAN_COMMENT_API = recorderUrl
    process.env.KANBAN_COMMENT_TOKEN_FILE = tokenFile
    const probe = writeProbe(work)
    execFileSync('bash', [probe], { encoding: 'utf-8', env: { ...process.env } })
    const hits = readHits(logFile)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]?.path).toBe('/api/kanban/probe-card/comments')
    expect(hits[0]?.body).toContain('PROBE-BODY')
    rmSync(work, { recursive: true, force: true })
  })
})

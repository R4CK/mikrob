// Card 1634bf55 (backend report msg 23386 + MikroB comment 37609): a land selftest that forgets
// to stub KANBAN_COMMENT_API/KANBAN_COMMENT_TOKEN_FILE/LAND_RUN_JOURNAL_FILE reaches the REAL
// dashboard and the REAL store/land-runs.jsonl -- confirmed live (three real /api/messages posts,
// a +3-byte write to the real journal, during a concurrent fleet-test with no other land running).
// The fix forces a dead KANBAN_COMMENT_API/GATE_CHECK_API + an unreadable token file + a
// never-created journal path onto every selftest this suite's own harnesses run
// (store-selftests-all-run.test.ts's execWithKillRetry, landing-downward-check.test.ts's
// selftest() and its two standalone describes), UNCONDITIONALLY, so no individual script has to
// remember it.
//
// This file proves the override actually closes the hole, with a RECORDING fake endpoint standing
// in for "the live dashboard" (never the real one): a probe script that sources the REAL
// store/kanban-comment-lib.sh -- exactly the shared code every land/selftest script uses -- and
// calls its real kanban_comment_on, exactly as a selftest that forgot to stub would. Case 1 proves
// zero live POSTs reach the recorder once the override wins. Case 2 is the MUTANT: the identical
// probe, run WITHOUT the override (simulating the pre-fix harness), proves the recorder DOES
// receive the POST -- so a future edit that drops the override from either harness turns this red.
//
// The recorder runs as a separate PYTHON subprocess, not an in-process Node http.createServer:
// execFileSync below is synchronous and blocks this process's own event loop for its whole
// duration, so an in-process recorder would never get to handle the connection while it runs
// (measured: a first draft using node:http hung the "mutant" case for the full curl --max-time
// window with zero hits, looking exactly like a false negative). Same reason every real land
// selftest in this repo (marveen-land-card-branch.selftest.sh, kanban-comment-lib.selftest.sh)
// shells out to a python recorder instead.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const LIB = join(REPO_ROOT, 'store', 'kanban-comment-lib.sh')

const DEAD_SELFTEST_ENV: Readonly<Record<string, string>> = {
  KANBAN_COMMENT_API: 'http://127.0.0.1:1',
  KANBAN_COMMENT_TOKEN_FILE: '/nonexistent/no-such-dir/no-token',
  GATE_CHECK_API: 'http://127.0.0.1:1',
  GATE_CHECK_TOKEN_FILE: '/nonexistent/no-such-dir/no-token',
  LAND_RUN_JOURNAL_FILE: '/nonexistent/no-such-dir/land-runs.jsonl',
}

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

async function startRecorder(work: string): Promise<{ url: string; logFile: string }> {
  const logFile = join(work, 'recorder.log')
  writeFileSync(logFile, '')
  const portFile = join(work, 'recorder.port')
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
  writeFileSync(portFile, m[1])
  return { url: `http://127.0.0.1:${m[1]}`, logFile }
}

afterEach(() => {
  if (recorderProc) {
    recorderProc.kill()
    recorderProc = undefined
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

function writeProbe(work: string): string {
  const probe = join(work, 'probe.sh')
  // Exactly what a forgetful land selftest does: source the shared lib and post a comment, with
  // NO override of its own -- relying entirely on whatever the caller's env leaves it.
  writeFileSync(probe, `#!/usr/bin/env bash\nset -u\n. "${LIB}"\nkanban_comment_on "probe-card" "PROBE-BODY"\n`)
  return probe
}

describe('card 1634bf55: dead KANBAN_COMMENT_API override actually stops a leaking selftest', () => {
  it('a selftest that never stubs anything cannot reach the recorder once the dead-env override wins', async () => {
    const work = mkdtempSync(join(tmpdir(), 'selftest-isolation-'))
    const { url: recorderUrl, logFile } = await startRecorder(work)
    const tokenFile = join(work, 'token')
    writeFileSync(tokenFile, 'probe-token\n')
    const probe = writeProbe(work)
    execFileSync('bash', [probe], {
      encoding: 'utf-8',
      // Ambient env points KANBAN_COMMENT_API at the recorder (the realistic leak shape: an
      // inherited/ambient value, or kanban-comment-lib.sh's own live default) -- then the dead
      // override is spread on top, exactly as execWithKillRetry/selftest() do.
      env: { ...process.env, KANBAN_COMMENT_API: recorderUrl, KANBAN_COMMENT_TOKEN_FILE: tokenFile, ...DEAD_SELFTEST_ENV },
    })
    expect(readHits(logFile)).toHaveLength(0)
    rmSync(work, { recursive: true, force: true })
  })

  it('MUTANT: the identical probe DOES reach the recorder once the dead-env override is removed', async () => {
    const work = mkdtempSync(join(tmpdir(), 'selftest-isolation-mutant-'))
    const { url: recorderUrl, logFile } = await startRecorder(work)
    const tokenFile = join(work, 'token')
    writeFileSync(tokenFile, 'probe-token\n')
    const probe = writeProbe(work)
    execFileSync('bash', [probe], {
      encoding: 'utf-8',
      // Same ambient leak shape as above, but WITHOUT the fix's override -- the pre-fix harness
      // shape. If this ever stops reaching the recorder, the probe itself has drifted from what
      // the real bug looked like and this sensitivity check has gone silently vacuous.
      env: { ...process.env, KANBAN_COMMENT_API: recorderUrl, KANBAN_COMMENT_TOKEN_FILE: tokenFile },
    })
    const hits = readHits(logFile)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]?.path).toBe('/api/kanban/probe-card/comments')
    expect(hits[0]?.body).toContain('PROBE-BODY')
    rmSync(work, { recursive: true, force: true })
  })
})

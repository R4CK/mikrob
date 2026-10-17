// Card 669b7f92 (RedHat R3 on 84dcc5d4, komment 15755): the gate-agent exclusion in
// store/session-memory-inject-agents.json only ever gated the own-curated section of
// scripts/hooks/shared-memory-inject.py. The "KOZOS MEMORIA (shared tier)" section further down
// in main() was unconditional -- every gate agent (qa, qa2, cybersec, cybersec2, cybered) still
// got it injected at every session start, carrying an agent_id stamp that is as forgeable via
// the shared-token write path as the curated section's was before authentication. A gate agent
// reviewing a submitter's work is the highest-value target for this injection vector.
//
// This runs the REAL scripts/hooks/shared-memory-inject.py end to end (spawnSync against a
// python3 fixture server), logging every request path it sends, so a mutation that reintroduces
// the unconditional fetch for a gate agent is caught even if it happened to produce an empty
// section some other way.
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'shared-memory-inject.py')

const FIXTURE_SERVER = `
import http.server, sys, json

MEM_RESP = json.loads(sys.argv[1])
LOG_PATH = sys.argv[2]

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(LOG_PATH, 'a') as f:
            f.write(self.path + chr(10))
        if self.path.startswith('/api/memories'):
            body = json.dumps(MEM_RESP).encode()
        else:
            body = b'[]'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass

s = http.server.HTTPServer(('127.0.0.1', 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
`

function sandboxRoot(): { dir: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gate-exclusion-mem-'))
  mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(dir, 'store'), { recursive: true })
  const script = join(dir, 'scripts', 'hooks', 'shared-memory-inject.py')
  writeFileSync(script, readFileSync(HOOK, 'utf-8'))
  writeFileSync(join(dir, 'store', '.dashboard-token'), 'test-token-not-real\n')
  return { dir, script }
}

function startFixtureServer(memResp: unknown, logPath: string): Promise<{ proc: ChildProcessByStdio<null, Readable, null>; port: number }> {
  const proc = spawn('python3', ['-c', FIXTURE_SERVER, JSON.stringify(memResp), logPath], { stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((resolve, reject) => {
    let buf = ''
    proc.stdout.on('data', (d) => {
      buf += d.toString()
      const m = buf.match(/(\d+)/)
      if (m) resolve({ proc, port: parseInt(m[1]!, 10) })
    })
    proc.on('error', reject)
  })
}

let liveProc: ChildProcessByStdio<null, Readable, null> | undefined

afterEach(() => {
  liveProc?.kill()
  liveProc = undefined
})

async function runHook(script: string, cwd: string, dir: string) {
  const logPath = join(dir, 'requests.log')
  const memResp = [
    { id: 1, agent_id: 'teszter', content: 'egy megosztott bejegyzes.', keywords: '', created_label: '2026-01-01' },
  ]
  const { proc, port } = await startFixtureServer(memResp, logPath)
  liveProc = proc
  await new Promise((r) => setTimeout(r, 150))
  const r = spawnSync('python3', [script], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '', WEB_PORT: String(port) },
  })
  proc.kill()
  return r
}

function readRequestLog(dir: string): string[] {
  const path = join(dir, 'requests.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean)
}

describe('shared-memory-inject.py gate-agent exclusion from the shared tier (card 669b7f92)', () => {
  it.each(['qa', 'qa2', 'cybersec', 'cybersec2', 'cybered'])(
    'gate agent %s: no category=shared request is sent at all, and no KOZOS MEMORIA section is injected',
    async (gateAgent) => {
      const { dir, script } = sandboxRoot()
      const r = await runHook(script, `/home/neon/marveen/agents/${gateAgent}`, dir)
      expect(r.status, r.stderr).toBe(0)

      const requests = readRequestLog(dir)
      expect(requests.some((p) => p.includes('category=shared'))).toBe(false)

      if (r.stdout.trim()) {
        const out = JSON.parse(r.stdout)
        const ctx: string = out.hookSpecificOutput.additionalContext
        expect(ctx).not.toContain('KÖZÖS MEMÓRIA')
      }
    },
  )

  it('non-gate agent (teszter) is unaffected: the category=shared request still fires and the section is injected', async () => {
    const { dir, script } = sandboxRoot()
    const r = await runHook(script, '/home/neon/marveen/agents/teszter', dir)
    expect(r.status, r.stderr).toBe(0)

    const requests = readRequestLog(dir)
    expect(requests.some((p) => p.includes('category=shared') && p.includes('agent=teszter'))).toBe(true)

    const out = JSON.parse(r.stdout)
    const ctx: string = out.hookSpecificOutput.additionalContext
    expect(ctx).toContain('KÖZÖS MEMÓRIA')
    expect(ctx).toContain('egy megosztott bejegyzes.')
  })
})

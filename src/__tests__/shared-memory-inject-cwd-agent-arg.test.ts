// Card 44091907 (RedHat GO melleklete, 669b7f92 komment 20820, F-N1): _agent_id_from_cwd in
// scripts/hooks/shared-memory-inject.py identifies the caller purely from the SessionStart
// payload's cwd, expecting an "agents/<name>" segment. Any cwd that does not have one -- a
// gate-worktree (e.g. a disposable gate checkout), the live clone root, or a missing cwd --
// falls through to the literal "fleet" identity, which the 669b7f92 gate exclusion does NOT
// cover, so a gate agent (qa/cybersec/...) running from one of those cwds gets the shared-tier
// injection the exclusion exists to deny it. The fix: an explicit --agent argument in the gate
// agent's own hook command line, which bypasses the cwd ambiguity entirely.
//
// This runs the REAL scripts/hooks/shared-memory-inject.py end to end (spawnSync against a
// python3 fixture server), same harness as shared-memory-inject-gate-exclusion.test.ts.
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
  const dir = mkdtempSync(join(tmpdir(), 'cwd-agent-arg-mem-'))
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

async function runHook(script: string, dir: string, payload: Record<string, unknown>, extraArgs: string[] = []) {
  const logPath = join(dir, 'requests.log')
  const memResp = [
    { id: 1, agent_id: 'teszter', content: 'egy megosztott bejegyzes.', keywords: '', created_label: '2026-01-01' },
  ]
  const { proc, port } = await startFixtureServer(memResp, logPath)
  liveProc = proc
  await new Promise((r) => setTimeout(r, 150))
  const r = spawnSync('python3', [script, ...extraArgs], {
    input: JSON.stringify(payload),
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

function readResolutionLog(dir: string): Array<Record<string, unknown>> {
  const path = join(dir, 'store', 'shared-memory-inject-agent-resolution.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

describe('shared-memory-inject.py: explicit --agent bypasses cwd-ambiguous gate-exclusion gaps (card 44091907 F-N1)', () => {
  it('gate agent on a NON-agents/ cwd (e.g. a gate-worktree), WITHOUT --agent: falls back to "fleet" and the shared tier leaks (the pre-fix gap, pinned so the --agent bypass below stays necessary)', async () => {
    const { dir, script } = sandboxRoot()
    const r = await runHook(script, dir, { cwd: '/home/neon/marveen-agent-worktrees/cybersec' })
    expect(r.status, r.stderr).toBe(0)
    const requests = readRequestLog(dir)
    expect(requests.some((p) => p.includes('category=shared'))).toBe(true)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.additionalContext).toContain('KÖZÖS MEMÓRIA')
  })

  it('gate agent on the SAME non-agents/ cwd, WITH --agent cybersec: no category=shared request, no KÖZÖS MEMÓRIA section', async () => {
    const { dir, script } = sandboxRoot()
    const r = await runHook(script, dir, { cwd: '/home/neon/marveen-agent-worktrees/cybersec' }, ['--agent', 'cybersec'])
    expect(r.status, r.stderr).toBe(0)
    const requests = readRequestLog(dir)
    expect(requests.some((p) => p.includes('category=shared'))).toBe(false)
    if (r.stdout.trim()) {
      const out = JSON.parse(r.stdout)
      expect(out.hookSpecificOutput.additionalContext).not.toContain('KÖZÖS MEMÓRIA')
    }
  })

  it('missing cwd entirely, WITH --agent qa2: still excluded (no category=shared request)', async () => {
    const { dir, script } = sandboxRoot()
    const r = await runHook(script, dir, {}, ['--agent', 'qa2'])
    expect(r.status, r.stderr).toBe(0)
    const requests = readRequestLog(dir)
    expect(requests.some((p) => p.includes('category=shared'))).toBe(false)
  })

  it('--agent=cybered (= form) is accepted the same as a separate argument', async () => {
    const { dir, script } = sandboxRoot()
    const r = await runHook(script, dir, { cwd: '/home/neon/marveen-agent-worktrees/cybered' }, ['--agent=cybered'])
    expect(r.status, r.stderr).toBe(0)
    const requests = readRequestLog(dir)
    expect(requests.some((p) => p.includes('category=shared'))).toBe(false)
  })

  it('non-gate agent explicit --agent still gets the shared tier (the arg is an identity override, not a blanket suppression)', async () => {
    const { dir, script } = sandboxRoot()
    const r = await runHook(script, dir, { cwd: '/some/odd/cwd' }, ['--agent', 'teszter'])
    expect(r.status, r.stderr).toBe(0)
    const requests = readRequestLog(dir)
    expect(requests.some((p) => p.includes('category=shared') && p.includes('agent=teszter'))).toBe(true)
  })

  it('every invocation appends a resolution-measurement row (cwd, source, resolved agent, whether --agent was used)', async () => {
    const { dir, script } = sandboxRoot()
    await runHook(script, dir, { cwd: '/home/neon/marveen-agent-worktrees/cybersec', source: 'resume' }, ['--agent', 'cybersec'])
    const rows = readResolutionLog(dir)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({
      cwd: '/home/neon/marveen-agent-worktrees/cybersec',
      source: 'resume',
      resolved_agent: 'cybersec',
      used_explicit_agent_arg: true,
      cwd_had_agents_segment: false,
    })
  })
})

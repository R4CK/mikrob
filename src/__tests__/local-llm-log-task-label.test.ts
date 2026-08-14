// store/local-llm.sh --log-task: label the usage log without touching the prompt (card ea3e4270).
//
// WHY THE FLAG EXISTS. `--task` does three things at once: it picks a prompt template, it brings the
// call under the dashboard's per-category switch, and it labels the usage log. A caller that only
// wants the metric to say what this call WAS therefore could not use it -- so the fleet's whole
// dispatch-offload path logged as `chat`, the default, and "the share of task=code" measured who
// typed a flag rather than what ran (card 63c7d6f9 measured that: `chat` calls have a median of 35s
// and 941 output tokens; they are drafting work).
//
// END TO END, not source-level: the script is copied into a sandbox so `$HERE` -- and with it the
// usage log it appends to -- is the sandbox, and a stub ollama in its OWN process answers the call.
// An in-process server cannot: every case here drives the script with spawnSync, which blocks this
// thread's event loop, so the stub would never get to reply.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync, mkdtempSync, copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let sandbox: string
let server: ChildProcess
let host: string

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'log-task-'))
  copyFileSync(join(ROOT, 'store', 'local-llm.sh'), join(sandbox, 'local-llm.sh'))
  mkdirSync(join(sandbox, 'local-llm-skills'))
  writeFileSync(join(sandbox, 'local-llm-model'), 'stub-model:latest\n')

  const stub = join(sandbox, 'stub.js')
  writeFileSync(
    stub,
    `const http = require('node:http')
const s = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url.startsWith('/api/tags')) return res.end(JSON.stringify({ models: [{ name: 'stub-model:latest' }] }))
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => res.end(JSON.stringify({ response: 'drafted', eval_count: 7, prompt_eval_count: 3 })))
})
s.listen(0, '127.0.0.1', () => console.log(String(s.address().port)))
`,
  )
  server = spawn('node', [stub], { stdio: ['ignore', 'pipe', 'inherit'] })
  host = await new Promise((resolve) => {
    server.stdout?.once('data', (d) => resolve(`http://127.0.0.1:${String(d).trim()}`))
  })
})

afterAll(() => { server?.kill() })

function run(args: readonly string[]): { status: number; out: string } {
  const r = spawnSync('bash', [join(sandbox, 'local-llm.sh'), ...args, 'draft this'], {
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, OLLAMA_HOST: host },
  })
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** The last usage row as columns: epoch, caller, task, model, ms, status, source, in, out. */
function lastRow(): string[] {
  const log = join(sandbox, 'local-llm-usage.log')
  if (!existsSync(log)) return []
  const lines = readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean)
  return lines[lines.length - 1].split('\t')
}

describe('local-llm.sh --log-task (card ea3e4270)', () => {
  it('labels the usage log with the given name', () => {
    const r = run(['--log-task', 'card-draft', '--caller', 'backend2', '--source', 'dispatch-offload'])
    expect(r.status).toBe(0)
    const row = lastRow()
    expect(row[2]).toBe('card-draft')
    expect(row[1]).toBe('backend2')
    expect(row[6]).toBe('dispatch-offload')
  })

  it('CONTROL: without it the same call still logs the old default -- nothing changed by accident', () => {
    const r = run(['--caller', 'backend2', '--source', 'dispatch-offload'])
    expect(r.status).toBe(0)
    expect(lastRow()[2]).toBe('chat')
  })

  it('does NOT pick a template: an unknown label is fine, an unknown --task is not', () => {
    // This is the whole point of a separate flag. `--task card-draft` would die on a missing
    // template file; the label must not, or the metric fix would force a prompt change.
    expect(run(['--log-task', 'card-draft']).status).toBe(0)
    const asTask = run(['--task', 'card-draft'])
    expect(asTask.status).not.toBe(0)
    expect(asTask.out).toContain('unknown --task')
  })

  it('the label is charset-checked like --task -- it lands in a TSV column', () => {
    // A free-text value in a metric column is how a metric gets forged; same allowlist as card
    // 2de47a4e applied to the task name.
    for (const bad of ['../../etc/passwd', 'a b', 'UP', 'foo;id', 'a'.repeat(65)]) {
      const r = run(['--log-task', bad])
      expect(r.status, `${bad} should be rejected`).not.toBe(0)
      expect(r.out, `${bad} should hit the allowlist`).toContain('invalid --log-task')
    }
  })

  it('a real --task still labels the log when no --log-task is given', () => {
    writeFileSync(join(sandbox, 'local-llm-skills', 'summarize.txt'), 'Summarize:\n{{INPUT}}\n')
    const r = run(['--task', 'summarize'])
    expect(r.status).toBe(0)
    expect(lastRow()[2]).toBe('summarize')
  })
})

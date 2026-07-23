import { spawn, execFile } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { STORE_DIR } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import type { RouteContext } from './types.js'

// ---------------------------------------------------------------------------
// Local offload LLM (Ollama on the WSL GPU) control surface.
//
// SECURITY: this is a trust boundary -- these endpoints trigger model pulls,
// swap the active model, and run generations from the browser. Every one is
// behind the /api/* Bearer gate enforced in src/web.ts (do NOT re-auth here,
// do NOT add to any public-path allowlist). User input NEVER reaches a shell:
// all child processes are spawned with an argv array (execFile / spawn), never
// a `sh -c`-style string, and the run-prompt is piped via stdin. Model names
// are charset-validated before any use; the prompt is length-capped; every
// spawned process has a timeout. No secret (dashboard token, env) is surfaced.
// ---------------------------------------------------------------------------

const OLLAMA_BASE = 'http://127.0.0.1:11434'
const MODEL_FILE = join(STORE_DIR, 'local-llm-model')
const RAG_SCRIPT = join(STORE_DIR, 'local-llm-rag.sh')
const BRIDGE_UNIT = 'quota-bridge.service'
const OLLAMA_UNIT = 'ollama'

// Model tag charset: letters/digits and the punctuation Ollama allows in a
// name (repo/name:tag, digests, registry host). Anchored + length-capped so a
// crafted value cannot smuggle shell metacharacters or an unbounded string.
const MODEL_RE = /^[A-Za-z0-9._:/@-]{1,200}$/
const MAX_PROMPT_LEN = 4000
const RUN_TIMEOUT_MS = 120_000

interface CmdResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

// Run a child process with an argv array (never a shell string). Resolves with
// the captured output regardless of exit code so callers can inspect a nonzero
// exit (e.g. `systemctl is-active` prints "inactive" AND exits nonzero).
function runCmd(
  file: string,
  args: string[],
  opts: { timeoutMs?: number; input?: string; maxBuffer?: number } = {},
): Promise<CmdResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        const timedOut = !!(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed &&
          (err as NodeJS.ErrnoException & { signal?: string }).signal === 'SIGTERM')
        resolve({
          code: err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? (err as unknown as { code: number }).code
            : (err ? 1 : 0),
          stdout: stdout || '',
          stderr: stderr || '',
          timedOut,
        })
      },
    )
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input)
    }
  })
}

async function ollama(pathname: string, timeoutMs = 5000): Promise<any | null> {
  try {
    const res = await fetch(`${OLLAMA_BASE}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function readActiveModel(): string {
  try {
    if (existsSync(MODEL_FILE)) return readFileSync(MODEL_FILE, 'utf-8').trim()
  } catch { /* fall through */ }
  return ''
}

async function bridgeActive(): Promise<boolean> {
  const r = await runCmd('systemctl', ['--user', 'is-active', BRIDGE_UNIT], { timeoutMs: 5000 })
  return r.stdout.trim() === 'active'
}

// Optional GPU snapshot via nvidia-smi. Returns null when the tool is absent
// (no GPU / not installed) so the UI can honestly say "no GPU data".
async function gpuInfo(): Promise<null | { name: string; mem_used_mb: number; mem_total_mb: number; util_pct: number }> {
  const r = await runCmd(
    'nvidia-smi',
    ['--query-gpu=name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
    { timeoutMs: 5000 },
  )
  if (r.code !== 0 || !r.stdout.trim()) return null
  const line = r.stdout.trim().split('\n')[0]
  const parts = line.split(',').map(s => s.trim())
  if (parts.length < 4) return null
  const mem_used_mb = Number(parts[1])
  const mem_total_mb = Number(parts[2])
  const util_pct = Number(parts[3])
  return {
    name: parts[0] || 'GPU',
    mem_used_mb: Number.isFinite(mem_used_mb) ? mem_used_mb : 0,
    mem_total_mb: Number.isFinite(mem_total_mb) ? mem_total_mb : 0,
    util_pct: Number.isFinite(util_pct) ? util_pct : 0,
  }
}

// --- Pull job registry (in-memory; cap 1 concurrent pull) ------------------
interface PullJob { id: string; model: string; done: boolean; ok: boolean; lastLine: string; error: string; startedAt: number }
const pullJobs = new Map<string, PullJob>()
let activePullId: string | null = null

function startPull(model: string): PullJob {
  const id = randomUUID()
  const job: PullJob = { id, model, done: false, ok: false, lastLine: 'Indítás...', error: '', startedAt: Date.now() }
  pullJobs.set(id, job)
  activePullId = id

  // spawn ollama with an argv array; user input is a single validated argv
  // element, so it can never be interpreted as a shell token.
  const child = spawn('ollama', ['pull', model], { stdio: ['ignore', 'pipe', 'pipe'] })
  const onData = (buf: Buffer) => {
    const text = buf.toString()
    // Ollama emits a CR-updated progress bar; keep the last non-empty segment.
    const seg = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean)
    if (seg.length) job.lastLine = seg[seg.length - 1].slice(0, 300)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('error', (err) => {
    job.done = true; job.ok = false
    job.error = err instanceof Error ? err.message : String(err)
    if (activePullId === id) activePullId = null
  })
  child.on('close', (code) => {
    job.done = true
    job.ok = code === 0
    if (code !== 0 && !job.error) job.error = `ollama pull kilépési kód: ${code}`
    if (activePullId === id) activePullId = null
  })

  // Safety timeout: a wedged pull should not pin the single slot forever.
  const killTimer = setTimeout(() => {
    if (!job.done) { try { child.kill('SIGTERM') } catch { /* gone */ } }
  }, 30 * 60 * 1000)
  child.on('close', () => clearTimeout(killTimer))

  return job
}

export async function tryHandleLocalLlm(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (!path.startsWith('/api/local-llm/')) return false

  // GET /api/local-llm/status
  if (path === '/api/local-llm/status' && method === 'GET') {
    const [tags, ps, bridge, gpu] = await Promise.all([
      ollama('/api/tags'),
      ollama('/api/ps'),
      bridgeActive(),
      gpuInfo(),
    ])
    const ollamaUp = tags !== null
    const models = (tags?.models || []).map((m: any) => ({ name: m.name, size: m.size ?? 0 }))
    const running = ps?.models || []
    const active = readActiveModel()
    json(res, {
      ollama_up: ollamaUp,
      active_model: active,
      active_present: models.some((m: any) => m.name === active),
      models,
      running,
      bridge_active: bridge,
      gpu,
    })
    return true
  }

  // GET /api/local-llm/running -> Ollama /api/ps passthrough
  if (path === '/api/local-llm/running' && method === 'GET') {
    const ps = await ollama('/api/ps')
    if (ps === null) { json(res, { ollama_up: false, models: [] }); return true }
    json(res, { ollama_up: true, models: ps.models || [] })
    return true
  }

  // GET /api/local-llm/logs?source=bridge|ollama&lines=N
  if (path === '/api/local-llm/logs' && method === 'GET') {
    const source = url.searchParams.get('source') === 'ollama' ? 'ollama' : 'bridge'
    let n = parseInt(url.searchParams.get('lines') || '120', 10)
    if (!Number.isFinite(n) || n < 1) n = 120
    if (n > 500) n = 500
    const unit = source === 'ollama' ? OLLAMA_UNIT : BRIDGE_UNIT
    const r = await runCmd('journalctl', ['--user', '-u', unit, '-n', String(n), '--no-pager'], { timeoutMs: 8000 })
    // journalctl exits nonzero / prints nothing (or "-- No entries --") when the
    // unit has no journal.
    let out = r.stdout.trim()
    if (/^-- No entries --$/.test(out)) out = ''
    if (!out) {
      const note = source === 'ollama'
        ? `Nincs "${OLLAMA_UNIT}" felhasználói systemd unit (az Ollama másképp fut vagy nincs journal-naplója).`
        : `Nincs napló a "${BRIDGE_UNIT}" unithoz (lehet, hogy a szolgáltatás nem fut).`
      json(res, { source, lines: [], note })
      return true
    }
    json(res, { source, lines: out.split('\n') })
    return true
  }

  // POST /api/local-llm/model  {model} -> swap active model
  if (path === '/api/local-llm/model' && method === 'POST') {
    let model = ''
    try { model = (JSON.parse((await readBody(req)).toString()).model || '').trim() } catch { /* bad json */ }
    if (!MODEL_RE.test(model)) { json(res, { error: 'Érvénytelen modellnév.' }, 400); return true }
    const tags = await ollama('/api/tags')
    if (tags === null) { json(res, { error: 'Az Ollama nem elérhető.' }, 503); return true }
    const present = (tags.models || []).some((m: any) => m.name === model)
    if (!present) { json(res, { error: 'Ez a modell nincs letöltve. Előbb húzd le (pull).' }, 409); return true }
    try {
      atomicWriteFileSync(MODEL_FILE, model + '\n')
    } catch (err) {
      logger.warn({ err }, 'local-llm: aktív modell írása sikertelen')
      json(res, { error: 'Az aktív modell mentése nem sikerült.' }, 500)
      return true
    }
    json(res, { ok: true, active_model: model })
    return true
  }

  // POST /api/local-llm/pull  {model} -> start async pull (new download or update)
  if (path === '/api/local-llm/pull' && method === 'POST') {
    let model = ''
    try { model = (JSON.parse((await readBody(req)).toString()).model || '').trim() } catch { /* bad json */ }
    if (!MODEL_RE.test(model)) { json(res, { error: 'Érvénytelen modellnév.' }, 400); return true }
    if (activePullId && !pullJobs.get(activePullId)?.done) {
      json(res, { error: 'Már fut egy letöltés. Várd meg, míg befejeződik.' }, 409)
      return true
    }
    const job = startPull(model)
    json(res, { ok: true, job_id: job.id })
    return true
  }

  // GET /api/local-llm/pull-status?job_id=
  if (path === '/api/local-llm/pull-status' && method === 'GET') {
    const id = url.searchParams.get('job_id') || ''
    const job = pullJobs.get(id)
    if (!job) { json(res, { error: 'Ismeretlen letöltési feladat.' }, 404); return true }
    json(res, { job_id: job.id, model: job.model, done: job.done, ok: job.ok, last_line: job.lastLine, error: job.error })
    // Reap finished jobs a while after completion to avoid unbounded growth.
    if (job.done && Date.now() - job.startedAt > 10 * 60 * 1000) pullJobs.delete(id)
    return true
  }

  // POST /api/local-llm/run  {prompt} -> run the local model via the RAG wrapper
  if (path === '/api/local-llm/run' && method === 'POST') {
    let prompt = ''
    try { prompt = String(JSON.parse((await readBody(req, { maxBytes: 64 * 1024 })).toString()).prompt || '') } catch { /* bad json */ }
    prompt = prompt.trim()
    if (!prompt) { json(res, { error: 'Üres prompt.' }, 400); return true }
    if (prompt.length > MAX_PROMPT_LEN) { json(res, { error: `A prompt túl hosszú (max ${MAX_PROMPT_LEN} karakter).` }, 400); return true }
    if (!existsSync(RAG_SCRIPT)) { json(res, { error: 'A RAG wrapper (local-llm-rag.sh) nem található.' }, 500); return true }
    // Prompt is piped via stdin, never placed on the argv/command line.
    const r = await runCmd('bash', [RAG_SCRIPT, '--agent', 'mikrob'], { timeoutMs: RUN_TIMEOUT_MS, input: prompt })
    if (r.timedOut) { json(res, { error: 'A helyi modell időtúllépés miatt nem válaszolt.' }, 504); return true }
    if (r.code !== 0) {
      const detail = (r.stderr.trim() || r.stdout.trim() || 'ismeretlen hiba').slice(0, 500)
      json(res, { error: `A helyi modell futtatása hibázott: ${detail}` }, 502)
      return true
    }
    json(res, { ok: true, response: r.stdout.trim(), model: readActiveModel() })
    return true
  }

  return false
}

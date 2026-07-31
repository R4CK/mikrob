import { spawn, execFile } from 'node:child_process'
import { readFileSync, existsSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
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
// The embedding model is used exclusively for memory/RAG vector search (src/db.ts).
// It never receives code/task dispatches. Exposed in the status response so the
// dashboard can show both roles clearly and avoid the "nomic gets tasks too?" confusion.
const EMBED_MODEL = 'nomic-embed-text'
const RAG_SCRIPT = join(STORE_DIR, 'local-llm-rag.sh')
// Append-only usage ledger written by the instrumented local-llm wrappers.
// One TSV line per real model invocation:
//   epoch_seconds \t caller \t task \t model \t ms \t status \t source
const USAGE_FILE = join(STORE_DIR, 'local-llm-usage.log')
const BRIDGE_UNIT = 'quota-bridge.service'
const OLLAMA_UNIT = 'ollama'
// Proactive-offload control (card 48f3b675): the aggressiveness slider persists into the SAME config
// the fleet agents + the local-llm-offload skill read. 0 = never offload, 100 = offload maximally.
const OFFLOAD_CONFIG_FILE = join(STORE_DIR, 'local-llm-offload-active.json')
// The marked "optimal" point on the slider AND the DEFAULT (card 48f3b675, Peti req 2245): the offload
// GPU (GTX 1660 Ti, ~5 GB usable) is barely loaded (~6% util), so the honest recommendation is to
// offload MORE than a naive middle setting -- and the DEFAULT starts here so the fleet offloads
// aggressively out of the box (more mechanical work to the local model, fewer Claude tokens).
const OPTIMAL_AGGRESSIVENESS = 75
const DEFAULT_AGGRESSIVENESS = OPTIMAL_AGGRESSIVENESS

/** Clamp/parse an aggressiveness input to an integer in [0,100]; non-numeric -> the default. (Mechanical
 *  pure fn -- drafted via the local-llm offload per the proactive-offload directive, verified here.) */
export function normalizeAggressiveness(input: unknown): number {
  const parsed = typeof input === 'number' ? input : parseFloat(String(input))
  if (isNaN(parsed) || !isFinite(parsed)) return DEFAULT_AGGRESSIVENESS
  return Math.round(Math.max(0, Math.min(100, parsed)))
}

// --- Coding-difficulty taxonomy for local-LLM offload (card afcfe93e) --------------------------
// Ordered ASCENDING by how hard the piece is for the local 7B coding model. ONLY coding tasks --
// no other category. The higher the offload aggressiveness, the harder a coding task may be handed
// to the local model. The 7B (qwen2.5-coder) reliably handles up to ~'isolated' (snippet/fn/test/
// type); 'module' is the practical ceiling; 'feature'/'architecture' are BEYOND its reliable limit
// (multi-file / cross-file wiring, per the local-llm-offload skill) -- reachable only at max
// aggressiveness, and expect a higher draft-discard rate there.
export const CODING_DIFFICULTY_LEVELS = [
  'trivial', // snippet / regex / format / docstring
  'isolated', // isolated function / unit test / type / validator
  'module', // multi-function module (single file)
  'feature', // multi-file feature
  'architecture', // architecture / cross-file wiring
] as const
export type CodingDifficulty = (typeof CODING_DIFFICULTY_LEVELS)[number]

/** The OFFLOAD CEILING: even at 100% aggressiveness we never hand the local 7B more than it can
 *  realistically do. Per the local-llm-offload skill the 7B cannot reliably do multi-file features
 *  or cross-file wiring, so 'module' (multi-function, single file) is the hardest OFFLOADABLE level.
 *  'feature' and 'architecture' remain in the taxonomy to CLASSIFY tasks, but they always stay
 *  ONLINE (Claude) -- they are never valid offload thresholds. (Peti: "a 100% se engedjen többet
 *  mint amit a modell reálisan tud.") */
export const RELIABLE_CEILING: CodingDifficulty = 'module'

/** The difficulty levels that may be picked as an offload threshold (<= the reliable ceiling). */
export const OFFLOADABLE_THRESHOLDS: readonly CodingDifficulty[] = CODING_DIFFICULTY_LEVELS.slice(
  0,
  CODING_DIFFICULTY_LEVELS.indexOf(RELIABLE_CEILING) + 1,
)

/** Default max offloadable coding-difficulty for a given aggressiveness %. Higher % -> more offload
 *  + harder allowed, but CAPPED at the reliable ceiling ('module') so even 100% never offloads what
 *  the 7B can't do. Pure + deterministic. Single source of truth for the slider<->dropdown mapping
 *  (local-llm-rag.sh mirrors this table -- keep them in sync). */
export function defaultDifficultyForAggressiveness(pct: unknown): CodingDifficulty {
  const a = normalizeAggressiveness(pct)
  if (a >= 85) return 'module' // capped: feature/architecture never auto-offload
  if (a >= 75) return 'isolated'
  return 'trivial'
}

/** Validate a difficulty input to a known taxonomy level; unknown/absent -> null. Used to classify a
 *  TASK's difficulty (all 5 levels are valid tasks). */
export function normalizeDifficulty(input: unknown): CodingDifficulty | null {
  return typeof input === 'string' && (CODING_DIFFICULTY_LEVELS as readonly string[]).includes(input)
    ? (input as CodingDifficulty)
    : null
}

/** Validate an offload THRESHOLD input, CLAMPED to the reliable ceiling. A request for a level above
 *  the ceiling (feature/architecture) is clamped down to 'module' -- those never offload. Unknown/
 *  absent -> null (caller derives the threshold from the slider). */
export function normalizeThreshold(input: unknown): CodingDifficulty | null {
  const d = normalizeDifficulty(input)
  if (d === null) return null
  return CODING_DIFFICULTY_LEVELS.indexOf(d) > CODING_DIFFICULTY_LEVELS.indexOf(RELIABLE_CEILING)
    ? RELIABLE_CEILING
    : d
}

/** Is a coding task of `taskLevel` allowed to draft locally under `threshold`? At-or-below = yes. */
export function isDraftableLocally(taskLevel: CodingDifficulty, threshold: CodingDifficulty): boolean {
  return CODING_DIFFICULTY_LEVELS.indexOf(taskLevel) <= CODING_DIFFICULTY_LEVELS.indexOf(threshold)
}

/** Read the offload config JSON, fail-soft to an empty object (the endpoint fills defaults). */
function readOffloadConfig(): Record<string, unknown> {
  try {
    if (existsSync(OFFLOAD_CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(OFFLOAD_CONFIG_FILE, 'utf-8'))
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    }
  } catch (err) {
    logger.warn({ err }, 'offload-config: read/parse failed, using defaults')
  }
  return {}
}

// Model tag charset: letters/digits and the punctuation Ollama allows in a
// name (repo/name:tag, digests, registry host). Anchored + length-capped so a
// crafted value cannot smuggle shell metacharacters or an unbounded string.
const MODEL_RE = /^[A-Za-z0-9._:/@-]{1,200}$/
const MAX_PROMPT_LEN = 4000
const RUN_TIMEOUT_MS = 120_000

// --- Model recommendations (curated) + HuggingFace search ------------------
// The offload GPU is a GTX 1660 Ti with 6 GB VRAM (~5 GB usable). A Q4 model
// larger than ~5 GB spills its overflow layers to CPU and runs much slower, so
// every recommendation carries an explicit gpu_fit. These are Ollama-library
// names (reliably pullable via `ollama pull <name>`), curated for CODING.
type GpuFit = 'fits' | 'tight' | 'spills'
interface ModelRec {
  name: string
  params: string
  size_gb: number
  gpu_fit: GpuFit
  pullable: true
  // i18n key resolved on the client (kept locale-neutral in the API).
  note_key: string
  ollama_pull: string
}
const CODING_MODEL_RECS: Omit<ModelRec, 'ollama_pull'>[] = [
  { name: 'qwen2.5-coder:1.5b', params: '1.5B', size_gb: 1.0, gpu_fit: 'fits',   pullable: true, note_key: 'localLlm.rec.note.small' },
  { name: 'qwen2.5-coder:3b',   params: '3B',   size_gb: 1.9, gpu_fit: 'fits',   pullable: true, note_key: 'localLlm.rec.note.balanced' },
  { name: 'qwen2.5-coder:7b',   params: '7B',   size_gb: 4.7, gpu_fit: 'tight',  pullable: true, note_key: 'localLlm.rec.note.balanced' },
  { name: 'deepseek-coder:1.3b', params: '1.3B', size_gb: 0.8, gpu_fit: 'fits',  pullable: true, note_key: 'localLlm.rec.note.small' },
  { name: 'deepseek-coder:6.7b', params: '6.7B', size_gb: 3.8, gpu_fit: 'fits',  pullable: true, note_key: 'localLlm.rec.note.balanced' },
  { name: 'codegemma:2b',       params: '2B',   size_gb: 1.6, gpu_fit: 'fits',   pullable: true, note_key: 'localLlm.rec.note.small' },
  { name: 'codegemma:7b',       params: '7B',   size_gb: 5.0, gpu_fit: 'tight',  pullable: true, note_key: 'localLlm.rec.note.tight' },
  { name: 'codellama:7b',       params: '7B',   size_gb: 3.8, gpu_fit: 'fits',   pullable: true, note_key: 'localLlm.rec.note.balanced' },
  { name: 'starcoder2:3b',      params: '3B',   size_gb: 1.7, gpu_fit: 'fits',   pullable: true, note_key: 'localLlm.rec.note.small' },
  { name: 'starcoder2:7b',      params: '7B',   size_gb: 4.0, gpu_fit: 'tight',  pullable: true, note_key: 'localLlm.rec.note.tight' },
  { name: 'qwen2.5-coder:14b',  params: '14B',  size_gb: 9.0, gpu_fit: 'spills', pullable: true, note_key: 'localLlm.rec.note.spills' },
  { name: 'deepseek-coder-v2:16b', params: '16B', size_gb: 8.9, gpu_fit: 'spills', pullable: true, note_key: 'localLlm.rec.note.spills' },
]

const HF_BASE = 'https://huggingface.co/api/models'
const HF_TIMEOUT_MS = 8000
const HF_MAX_LIMIT = 30
const HF_DEFAULT_LIMIT = 20
// Whitelisted UI sort -> HuggingFace hub API sort field.
const HF_SORT_MAP: Record<string, string> = {
  downloads: 'downloads',
  likes: 'likes',
  trending: 'trendingScore',
  lastModified: 'lastModified',
}
// Whitelisted pipeline-task filters. '' means "any task" (no task filter).
const HF_TASK_ALLOW = new Set(['text-generation', 'text2text-generation', ''])
// Free-text query: strip to a safe charset and cap the length so a crafted
// value cannot smuggle URL/query control characters or an unbounded string.
function sanitizeHfQuery(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 ._/-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}

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
  // nvidia-smi is often NOT on the systemd service PATH; on WSL it lives at a
  // fixed absolute path. Try the known locations before giving up.
  const candidates = ['/usr/lib/wsl/lib/nvidia-smi', '/usr/bin/nvidia-smi', 'nvidia-smi']
  const args = ['--query-gpu=name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits']
  for (const bin of candidates) {
    const r = await runCmd(bin, args, { timeoutMs: 5000 })
    if (!r || r.code !== 0 || !r.stdout.trim()) continue
    const line = r.stdout.trim().split('\n')[0]
    const parts = line.split(',').map(s => s.trim())
    if (parts.length < 4) continue
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
  return null
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

// --- Usage ledger reading + aggregation -----------------------------------
// Pure fs read + JS parse; NO shell interpolation. Reads only the tail of the
// (append-only, unbounded) ledger so a large file can never blow up the heap.

export interface UsageRow { ts: number; caller: string; task: string; model: string; ms: number; status: string; source: string }

// Read at most `maxLines` from the END of the ledger, bounded to `maxBytes` of
// tail so we never load a giant file. Returns [] on a missing/unreadable file.
function tailUsageLines(maxLines = 5000, maxBytes = 4 * 1024 * 1024): string[] {
  let fd: number | null = null
  try {
    if (!existsSync(USAGE_FILE)) return []
    fd = openSync(USAGE_FILE, 'r')
    const size = fstatSync(fd).size
    if (size === 0) return []
    const readLen = Math.min(size, maxBytes)
    const start = size - readLen
    const buf = Buffer.allocUnsafe(readLen)
    readSync(fd, buf, 0, readLen, start)
    let text = buf.toString('utf-8')
    // If we started mid-file, the first line is likely a partial -- drop it.
    if (start > 0) { const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : '' }
    const lines = text.split('\n').filter(l => l.length > 0)
    return lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines
  } catch {
    return []
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* already gone */ } }
  }
}

function parseUsageRows(lines: string[]): UsageRow[] {
  const rows: UsageRow[] = []
  for (const line of lines) {
    const p = line.split('\t')
    if (p.length < 7) continue // malformed / short -> skip
    const ts = Number(p[0])
    if (!Number.isFinite(ts)) continue
    const ms = Number(p[4])
    rows.push({
      ts,
      caller: (p[1] || 'direct').trim() || 'direct',
      task: (p[2] || 'chat').trim() || 'chat',
      model: (p[3] || '').trim(),
      ms: Number.isFinite(ms) ? ms : 0,
      // Keep the raw status/source values (do NOT coerce to a fixed pair) so a
      // UI-probe row (source "ui") stays distinguishable from real bare/rag calls.
      status: (p[5] || 'ok').trim() || 'ok',
      source: (p[6] || 'bare').trim() || 'bare',
    })
  }
  return rows
}

// Calendar date (YYYY-MM-DD) of a UTC epoch in Europe/Budapest local time.
const BUDAPEST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit',
})
function budapestDate(epochSec: number): string {
  return BUDAPEST_DAY.format(new Date(epochSec * 1000))
}

// The last `n` Budapest calendar days (oldest -> newest). Anchored at 12:00 UTC
// so whole-day steps never land on a DST midnight boundary.
function lastDays(n: number, nowSec: number): string[] {
  const today = budapestDate(nowSec)
  const [y, m, d] = today.split('-').map(Number)
  const anchor = Date.UTC(y, m - 1, d, 12, 0, 0)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) out.push(budapestDate((anchor - i * 86400000) / 1000))
  return out
}

// A row is a REAL fleet invocation unless it is a dashboard quick-test probe
// (caller ui-test / source ui). UI probes are counted separately so they never
// inflate the metric.
//
// Was a `source === 'bare' || 'rag'` allowlist, which silently miscounted
// every dispatch-time offload call (source 'dispatch-offload', introduced by
// offload-dispatch.sh) as a UI probe -- 83 real local-LLM invocations were
// invisible in `today`/`total`/`last_7d` and lumped into `ui_probes`, making
// utilization look near-zero when it wasn't. caller !== 'ui-test' is the only
// signal that actually identifies a probe; any current or future real source
// tag must count.
export function isRealCall(r: UsageRow): boolean {
  return r.caller !== 'ui-test'
}

function buildUsage() {
  const allRows = parseUsageRows(tailUsageLines())
  const rows = allRows.filter(isRealCall)
  const ui_probes = allRows.length - rows.length
  const nowSec = Math.floor(Date.now() / 1000)
  const today = budapestDate(nowSec)
  const days14 = lastDays(14, nowSec)
  const last7Set = new Set(days14.slice(-7))

  const callerCounts = new Map<string, number>()
  const taskCounts = new Map<string, number>()
  const dayCounts = new Map<string, number>()
  const bySource = { bare: 0, rag: 0 }
  const byStatus = { ok: 0, err: 0 }
  let todayCount = 0
  let last7Count = 0

  for (const r of rows) {
    callerCounts.set(r.caller, (callerCounts.get(r.caller) || 0) + 1)
    taskCounts.set(r.task, (taskCounts.get(r.task) || 0) + 1)
    if (r.source === 'rag') bySource.rag++; else bySource.bare++
    if (r.status === 'err') byStatus.err++; else byStatus.ok++
    const day = budapestDate(r.ts)
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1)
    if (day === today) todayCount++
    if (last7Set.has(day)) last7Count++
  }

  const by_caller = [...callerCounts.entries()]
    .map(([caller, count]) => ({ caller, count }))
    .sort((a, b) => b.count - a.count)
  const by_task = [...taskCounts.entries()]
    .map(([task, count]) => ({ task, count }))
    .sort((a, b) => b.count - a.count)
  const by_day = days14.map(date => ({ date, count: dayCounts.get(date) || 0 }))
  const recent = rows.slice(-20).reverse().map(r => ({
    ts: r.ts, caller: r.caller, task: r.task, model: r.model, ms: r.ms, status: r.status, source: r.source,
  }))

  return {
    total: rows.length,
    today: todayCount,
    last_7d: last7Count,
    ui_probes,
    by_caller,
    by_source: bySource,
    by_task,
    by_status: byStatus,
    by_day,
    recent,
  }
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
      embed_model: EMBED_MODEL,
      embed_present: models.some((m: any) => m.name === EMBED_MODEL),
      models,
      running,
      bridge_active: bridge,
      gpu,
    })
    return true
  }

  // GET /api/local-llm/offload-config -> the current offload aggressiveness + the marked optimum,
  // plus the coding-difficulty threshold (card afcfe93e): the effective max difficulty a coding task
  // may be to still draft locally. `explicit` = the operator picked a level from the dropdown;
  // otherwise it is DERIVED from the aggressiveness slider via defaultDifficultyForAggressiveness.
  if (path === '/api/local-llm/offload-config' && method === 'GET') {
    const cfg = readOffloadConfig()
    const aggressiveness = normalizeAggressiveness(cfg.aggressiveness)
    const explicit = normalizeThreshold(cfg.codingDifficultyThreshold)
    const derived = defaultDifficultyForAggressiveness(aggressiveness)
    json(res, {
      active: cfg.active !== false, // default on unless explicitly disabled
      mode: typeof cfg.mode === 'string' ? cfg.mode : 'proactive',
      aggressiveness,
      optimal: OPTIMAL_AGGRESSIVENESS,
      codingDifficultyThreshold: explicit ?? derived,
      codingDifficultyExplicit: explicit !== null,
      codingDifficultyDerived: derived,
      codingDifficultyLevels: CODING_DIFFICULTY_LEVELS,
      offloadableThresholds: OFFLOADABLE_THRESHOLDS,
      reliableCeiling: RELIABLE_CEILING,
    })
    return true
  }

  // POST /api/local-llm/offload-config { aggressiveness: 0..100 } -> persist into the shared config the
  // agents + skill read. Bearer-gated by src/web.ts (never unauth-settable). Only the aggressiveness
  // field is touched; the rest of the directive metadata (active/mode/set_by/policy) is preserved.
  if (path === '/api/local-llm/offload-config' && method === 'POST') {
    const body = (await readBody(req)).toString()
    let parsed: { aggressiveness?: unknown; codingDifficultyThreshold?: unknown }
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      json(res, { error: 'invalid_json', message: 'A kérés törzse érvénytelen JSON.' }, 400)
      return true
    }
    const hasAggr = parsed.aggressiveness !== undefined
    const hasDiff = parsed.codingDifficultyThreshold !== undefined
    if (!hasAggr && !hasDiff) {
      json(
        res,
        { error: 'missing_field', message: 'Adj meg legalább egy mezőt: aggressiveness (0-100) vagy codingDifficultyThreshold.' },
        400,
      )
      return true
    }
    const cfg = readOffloadConfig()
    if (hasAggr) {
      cfg.aggressiveness = normalizeAggressiveness(parsed.aggressiveness)
      cfg.aggressiveness_set_at = new Date().toISOString()
    }
    if (hasDiff) {
      // 'auto'/null/'' -> clear the explicit override so the threshold follows the slider again.
      const raw = parsed.codingDifficultyThreshold
      if (raw === null || raw === 'auto' || raw === '') {
        delete cfg.codingDifficultyThreshold
        delete cfg.coding_difficulty_set_at
      } else if (normalizeDifficulty(raw) === null) {
        json(
          res,
          {
            error: 'invalid_field',
            message: `Érvénytelen nehézségi szint. Engedélyezett: ${OFFLOADABLE_THRESHOLDS.join(', ')} (vagy "auto").`,
          },
          400,
        )
        return true
      } else {
        // Clamp to the reliable ceiling: a request for feature/architecture is stored as 'module'
        // (those never offload). normalizeThreshold(raw) is non-null here (raw is a known level).
        cfg.codingDifficultyThreshold = normalizeThreshold(raw)
        cfg.coding_difficulty_set_at = new Date().toISOString()
      }
    }
    try {
      atomicWriteFileSync(OFFLOAD_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n')
    } catch (err) {
      logger.error({ err }, 'offload-config: write failed')
      json(res, { error: 'write_failed', message: 'A beállítás mentése nem sikerült, próbáld újra.' }, 500)
      return true
    }
    const aggressiveness = normalizeAggressiveness(cfg.aggressiveness)
    const explicit = normalizeThreshold(cfg.codingDifficultyThreshold)
    const derived = defaultDifficultyForAggressiveness(aggressiveness)
    json(res, {
      aggressiveness,
      optimal: OPTIMAL_AGGRESSIVENESS,
      codingDifficultyThreshold: explicit ?? derived,
      codingDifficultyExplicit: explicit !== null,
      codingDifficultyDerived: derived,
      codingDifficultyLevels: CODING_DIFFICULTY_LEVELS,
      offloadableThresholds: OFFLOADABLE_THRESHOLDS,
      reliableCeiling: RELIABLE_CEILING,
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
    // Tag this as a UI probe (caller=ui-test, source=ui) so the usage metric can
    // exclude dashboard quick-tests from the real fleet-invocation counts.
    const r = await runCmd(
      'bash',
      [RAG_SCRIPT, '--agent', 'mikrob', '--caller', 'ui-test', '--source', 'ui'],
      { timeoutMs: RUN_TIMEOUT_MS, input: prompt },
    )
    if (r.timedOut) { json(res, { error: 'A helyi modell időtúllépés miatt nem válaszolt.' }, 504); return true }
    if (r.code !== 0) {
      const detail = (r.stderr.trim() || r.stdout.trim() || 'ismeretlen hiba').slice(0, 500)
      json(res, { error: `A helyi modell futtatása hibázott: ${detail}` }, 502)
      return true
    }
    json(res, { ok: true, response: r.stdout.trim(), model: readActiveModel() })
    return true
  }

  // GET /api/local-llm/usage -> invocation metrics from the append-only ledger
  if (path === '/api/local-llm/usage' && method === 'GET') {
    json(res, buildUsage())
    return true
  }

  // GET /api/local-llm/model-recommendations -> curated coding-model list
  // for this 6 GB GPU. Static/factual; marks the currently active model.
  if (path === '/api/local-llm/model-recommendations' && method === 'GET') {
    const active = readActiveModel()
    // A rec is "active" when it prefixes the on-disk tag: the file may carry a
    // quant suffix (e.g. qwen2.5-coder:7b-instruct-q4_K_M) that the base name
    // (qwen2.5-coder:7b) prefixes -- and ':7b' never prefixes ':1.5b', so no
    // sibling false-match. Anchor on the ':tag' boundary defensively.
    const isActive = (name: string): boolean => {
      if (!active) return false
      if (active === name) return true
      return active.startsWith(name) && (active.length === name.length || active[name.length] === '-')
    }
    const models = CODING_MODEL_RECS.map(m => ({
      ...m,
      ollama_pull: `ollama pull ${m.name}`,
      active: isActive(m.name),
    }))
    json(res, {
      active_model: active,
      gpu: { name: 'GTX 1660 Ti', vram_gb: 6, usable_gb: 5 },
      models,
    })
    return true
  }

  // GET /api/local-llm/hf-search?query=&task=&sort=&gguf=&limit=
  // Proxy the public HuggingFace models API. Params are whitelisted/sanitized;
  // only GGUF results carry an ollama_pull (Ollama pulls GGUF repos directly).
  if (path === '/api/local-llm/hf-search' && method === 'GET') {
    const query = sanitizeHfQuery(url.searchParams.get('query') || '')
    let task = (url.searchParams.get('task') || 'text-generation').trim()
    if (!HF_TASK_ALLOW.has(task)) task = 'text-generation'
    let sort = (url.searchParams.get('sort') || 'downloads').trim()
    if (!Object.prototype.hasOwnProperty.call(HF_SORT_MAP, sort)) sort = 'downloads'
    // gguf defaults ON; only an explicit false/0 turns it off.
    const ggufRaw = (url.searchParams.get('gguf') || 'true').trim().toLowerCase()
    const gguf = !(ggufRaw === 'false' || ggufRaw === '0' || ggufRaw === 'no')
    let limit = parseInt(url.searchParams.get('limit') || String(HF_DEFAULT_LIMIT), 10)
    if (!Number.isFinite(limit) || limit < 1) limit = HF_DEFAULT_LIMIT
    if (limit > HF_MAX_LIMIT) limit = HF_MAX_LIMIT

    const hf = new URL(HF_BASE)
    if (query) hf.searchParams.set('search', query)
    if (task) hf.searchParams.append('filter', task)
    if (gguf) hf.searchParams.append('filter', 'gguf')
    hf.searchParams.set('sort', HF_SORT_MAP[sort])
    hf.searchParams.set('direction', '-1')
    hf.searchParams.set('limit', String(limit))

    let data: unknown
    try {
      const r = await fetch(hf.toString(), {
        signal: AbortSignal.timeout(HF_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      })
      if (!r.ok) {
        json(res, { error: `A HuggingFace keresés hibázott (HTTP ${r.status}). Próbáld újra később.` }, 502)
        return true
      }
      data = await r.json()
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError'
      json(res, {
        error: timedOut
          ? 'A HuggingFace keresés időtúllépés miatt megszakadt. Próbáld újra.'
          : 'A HuggingFace nem érhető el. Ellenőrizd a hálózatot és próbáld újra.',
      }, 502)
      return true
    }
    if (!Array.isArray(data)) {
      json(res, { error: 'A HuggingFace válasza értelmezhetetlen volt. Próbáld újra.' }, 502)
      return true
    }
    const results = data.slice(0, limit).map((m: any) => {
      const id = String((m && (m.id || m.modelId)) || '')
      const tags = Array.isArray(m?.tags) ? m.tags.map((x: unknown) => String(x)) : []
      const isGguf =
        /gguf/i.test(String(m?.library_name || '')) ||
        tags.some((tg: string) => /^gguf$/i.test(tg)) ||
        /gguf/i.test(id)
      const downloads = Number(m?.downloads)
      const likes = Number(m?.likes)
      return {
        id,
        downloads: Number.isFinite(downloads) ? downloads : 0,
        likes: Number.isFinite(likes) ? likes : 0,
        tags: tags.slice(0, 12),
        gguf: isGguf,
        ollama_pull: isGguf && id ? `ollama pull hf.co/${id}` : null,
        hf_url: id ? `https://huggingface.co/${encodeURI(id)}` : '',
      }
    }).filter((x: { id: string }) => x.id)
    json(res, { query, task, sort, gguf, limit, count: results.length, results })
    return true
  }

  return false
}

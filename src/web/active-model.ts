import { existsSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Claude Code writes one .jsonl session log per session under
// ~/.claude/projects/<encoded-working-dir>/. Every assistant turn carries the
// model id that answered it. We use that to surface the *live* running model
// (vs. the configured value in agent-config.json), so the dashboard can show
// what the running process is actually using, including across restarts.
//
// When an agent is launched with --continue, Claude Code appends to the same
// session jsonl across restarts, so the latest "model" field may reflect a
// pre-restart turn rather than the freshly-spawned process. Callers that know
// when the current session started should pass sinceUnixSec; we then ignore
// any line whose own timestamp predates that, leaving the caller to fall back
// to the configured model until the new session writes its first turn.
/**
 * The last `maxBytes` of a file, split into whole lines (a truncated first line is dropped).
 *
 * WHY THIS EXISTS (card d3dc35bf). Both readers below scan the transcript from the END for the most
 * recent turn, and both used to `readFileSync` the WHOLE file and `split('\n')` it -- synchronously,
 * on the `GET /api/agents` request path, once per running agent. Measured on the live fleet on
 * 2026-08-16: the newest transcripts had reached 276 MB, `GET /api/agents` answered in 3.8-7.4 s
 * (p50 4.4 s) while every other route answered in ~12 ms, and the dashboard pinned a core at 98%
 * with every HTTP request timing out -- which freezes the whole fleet, because the agents reach each
 * other through this API. The 3 s cache could not help: the UI polls every 3 s.
 *
 * A bounded tail read is not an approximation of what the callers want, it IS what they want: the
 * latest turn. The honest limit is stated rather than hidden -- a transcript whose last WINDOW bytes
 * contain no matching turn reads as "no value", where the old code would have kept scanning back to
 * byte zero. For a live session that window is minutes of history; for an idle one the answer was
 * already stale.
 *
 * ASYNC, NOT SYNC (card 9a2fd3f7, Cybersec follow-up to d3dc35bf). The bounded window fixed the
 * cost of a SINGLE call (28x faster), but every call was still `readSync`/`readdirSync`/`statSync`
 * on the request-handling thread -- one running agent, one blocking read, and `getAgentSummary`
 * makes two of these PER agent. Measured: a burst of 20 concurrent `GET /api/agents` (6 running
 * agents) went back to 0.21-4.4s, and an unrelated `GET /api/memories` sent mid-burst blocked for
 * 1.51s -- a synchronous call blocks the WHOLE event loop, not just its own route, so N callers
 * queue behind each other's file I/O regardless of which endpoint they hit. `fs/promises` offloads
 * the actual read to libuv's thread pool instead of the JS thread, so N concurrent reads run
 * concurrently instead of serializing the entire server behind them.
 */
const TAIL_WINDOW = 512 * 1024
const TAIL_WINDOW_RETRY = 4 * 1024 * 1024

async function readTailLines(file: string, maxBytes: number): Promise<string[]> {
  const size = (await stat(file)).size
  const start = Math.max(0, size - maxBytes)
  const length = size - start
  if (length <= 0) return []
  const buf = Buffer.allocUnsafe(length)
  const handle = await open(file, 'r')
  try {
    await handle.read(buf, 0, length, start)
  } finally {
    await handle.close()
  }
  const lines = buf.toString('utf-8').split('\n')
  // A window that does not start at byte 0 almost certainly begins mid-line; that fragment is not
  // parseable JSON and would only add a swallowed exception per call.
  if (start > 0) lines.shift()
  return lines
}

/** Tail lines, widening the window ONCE when the first one held no complete line (a single huge
 *  tool result can exceed it). Two bounded reads, never the whole file. */
async function tailLinesFor(file: string): Promise<string[]> {
  const first = await readTailLines(file, TAIL_WINDOW)
  if (first.some((l) => l.trim().length > 0)) return first
  return readTailLines(file, TAIL_WINDOW_RETRY)
}

/** The most-recently-modified `.jsonl` in `dir`, or null when there is none. The per-file `stat`
 *  calls run concurrently (small, bounded fan-out: one session-log directory's file count). */
async function newestJsonl(dir: string): Promise<string | null> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  if (files.length === 0) return null
  const withMtime = await Promise.all(
    files.map(async (f) => ({ f, mtime: (await stat(join(dir, f))).mtimeMs })),
  )
  withMtime.sort((a, b) => b.mtime - a.mtime)
  return withMtime[0]!.f
}

const TTL_MS = 3000

/**
 * Cache a `compute()` result for TTL_MS, keyed by `key` -- AND coalesce concurrent callers for the
 * same key into the same in-flight read (card 9a2fd3f7, part 2). Async alone was not enough: a
 * burst of N concurrent requests all miss the value cache in the same instant (none of them has
 * finished long enough to populate it for the others), so all N independently re-open, re-stat, and
 * re-read the identical file. Measured live after the async conversion: a 20-request burst against
 * 6 running agents got WORSE (up to 17.35s), not better -- Node's libuv threadpool defaults to 4
 * threads, and 20 x 6 x 2 (model + tokens) independent read sequences queue behind those 4 exactly
 * like the requests used to queue behind the single JS thread. Coalescing collapses that fan-out
 * back down to one read per (key) per TTL window, which is the actual number of distinct answers
 * that exist.
 */
function coalesced<T>(
  cacheMap: Map<string, { value: T; expiresAt: number }>,
  inFlight: Map<string, Promise<T>>,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const cached = cacheMap.get(key)
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
  const pending = inFlight.get(key)
  if (pending) return pending
  const promise = compute()
    .then((value) => {
      cacheMap.set(key, { value, expiresAt: Date.now() + TTL_MS })
      return value
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, promise)
  return promise
}

const cache = new Map<string, { value: string | null; expiresAt: number }>()
const modelInFlight = new Map<string, Promise<string | null>>()

// Resolve the session-log directory Claude Code writes for a working dir.
// Logs live under <config-root>/projects/<encoded-working-dir>/, where the
// config root is ~/.claude by default but an alternate one when the agent was
// launched with CLAUDE_CONFIG_DIR. Pass that absolute config root as configDir
// so we read the right project dir for agents on a non-default config.
export function projectsDirFor(workingDir: string, configDir?: string, homeDirOverride?: string): string {
  const base = configDir ?? join(homeDirOverride ?? homedir(), '.claude')
  const encoded = workingDir.replace(/[/.]/g, '-')
  return join(base, 'projects', encoded)
}

export function readActiveModelFromProjectDir(workingDir: string, sinceUnixSec?: number, configDir?: string): Promise<string | null> {
  const cacheKey = `${workingDir}:${sinceUnixSec ?? ''}:${configDir ?? ''}`
  return coalesced(cache, modelInFlight, cacheKey, async () => {
    try {
      const dir = projectsDirFor(workingDir, configDir)
      if (!existsSync(dir)) return null
      const newest = await newestJsonl(dir)
      if (newest === null) return null
      const lines = await tailLinesFor(join(dir, newest))
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line) continue
        try {
          const entry = JSON.parse(line)
          const msg = entry?.message
          const model = msg?.model
          if (typeof model !== 'string' || model.startsWith('<')) continue
          if (sinceUnixSec !== undefined) {
            const ts = entry?.timestamp
            if (typeof ts !== 'string') continue
            const lineUnix = Math.floor(new Date(ts).getTime() / 1000)
            if (!Number.isFinite(lineUnix) || lineUnix < sinceUnixSec) continue
          }
          return model
        } catch { /* skip malformed JSON line */ }
      }
      return null
    } catch {
      return null // fall through, same as the old try/catch's outer swallow
    }
  })
}

const ctxCache = new Map<string, { value: number | null; expiresAt: number }>()
const ctxInFlight = new Map<string, Promise<number | null>>()

// Current context size of the live session, in tokens. Claude Code records a
// `usage` object on each assistant turn; the context that gets re-read every
// turn is input_tokens + cache_read_input_tokens + cache_creation_input_tokens
// (output_tokens is the new reply, not context). We scan the newest transcript
// from the end for the last turn carrying a usage and sum those three. Returns
// null when there is no transcript / no usage yet (fresh session). This is what
// the dashboard surfaces so the operator can see a session growing heavy and
// decide to restart it.
export function readContextTokensFromProjectDir(workingDir: string, configDir?: string): Promise<number | null> {
  const cacheKey = `${workingDir}:${configDir ?? ''}`
  return coalesced(ctxCache, ctxInFlight, cacheKey, async () => {
    try {
      const dir = projectsDirFor(workingDir, configDir)
      if (!existsSync(dir)) return null
      const newest = await newestJsonl(dir)
      if (newest === null) return null
      const lines = await tailLinesFor(join(dir, newest))
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line) continue
        try {
          const u = JSON.parse(line)?.message?.usage
          if (u && typeof u === 'object') {
            const inp = Number(u.input_tokens) || 0
            const cr = Number(u.cache_read_input_tokens) || 0
            const cc = Number(u.cache_creation_input_tokens) || 0
            const total = inp + cr + cc
            if (total > 0) return total
          }
        } catch { /* skip malformed JSON line */ }
      }
      return null
    } catch {
      return null // fall through, same as the old try/catch's outer swallow
    }
  })
}

/**
 * Wall-clock mtime (ms) of the newest transcript for a working dir, or null
 * when there is none (fresh session, unreadable dir, agent on a remote host).
 *
 * This is the cheapest "when did this session last do anything" signal, and
 * the honest one: Claude Code appends to the jsonl on every turn, so the
 * file's mtime is written BY the session, outside the dashboard process. A
 * clock kept in dashboard memory dies with the dashboard, and a
 * count-the-sweeps streak measures the sweep interval rather than the agent.
 * Neither survives a restart; this does.
 *
 * What it does NOT measure: whether the agent is working right now. A single
 * long tool call (a 30-minute Bash, a subagent) appends nothing while it runs,
 * so the transcript goes quiet while real work is in flight. Callers must pair
 * this with a live-work signal -- the guard uses paneIdle -- and never treat a
 * stale mtime on its own as "finished".
 *
 * The mtime is already computed inside readContextTokensFromProjectDir to pick
 * the newest file; this exposes it rather than recomputing the selection
 * differently, so the two always describe the SAME transcript.
 */
export function readTranscriptMtimeFromProjectDir(workingDir: string, configDir?: string): number | null {
  try {
    const dir = projectsDirFor(workingDir, configDir)
    if (!existsSync(dir)) return null
    let newest: number | null = null
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const m = statSync(join(dir, f)).mtimeMs
      if (newest === null || m > newest) newest = m
    }
    return newest
  } catch { return null }
}

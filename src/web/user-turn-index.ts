// Incremental index of "real user turns" per day, over the Claude session transcripts
// (~/.claude/projects/**/*.jsonl). Card ba0d218f.
//
// THE PROBLEM IT REPLACES. GET /api/overview computed today's and yesterday's turn counts by
// re-reading EVERY transcript modified since the window start and JSON.parsing every line -- on every
// request. Measured on this host: 930 MB across 15 files for the "today" call and 1.01 GB across 162
// files for the "yesterday" one, ~770k lines parsed per request. That is where the ~12s went, and it
// got worse exactly when the fleet was busy, because busy agents are what makes those files big.
//
// WHY INCREMENTAL WORKS HERE: a session transcript is APPEND-ONLY. So a file whose size and mtime are
// unchanged since the last pass cannot contain a new turn, and a file that grew only needs its NEW
// BYTES read. The index keeps, per file, the byte offset already counted plus the per-day tallies it
// produced; a refresh reads the delta and nothing else.
//
// The daily tallies are kept per file (not as one global number) so a truncated or rewritten file can
// be recounted in isolation, and so a day's total is always the sum of what was actually observed --
// never a running counter that could drift.
//
// Deliberately NOT a cache with a TTL: a TTL would still pay the full 2 GB whenever it expired. This
// pays it once, then only for what is appended.

import { existsSync, mkdirSync, openSync, readdirSync, readSync, closeSync, statSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWriteFileSync } from './atomic-write.js'

/** Per-file state: how much has been counted, and what it contributed to each day. */
interface FileEntry {
  /** Bytes already consumed. A file that grew is read from here. */
  offset: number
  /** Size at the last pass -- a SMALLER size means the file was truncated/rewritten -> recount. */
  size: number
  /** 'YYYY-MM-DD' (local) -> turns observed in this file on that day. */
  days: Record<string, number>
}

interface IndexState {
  version: 1
  files: Record<string, FileEntry>
}

const EMPTY: IndexState = { version: 1, files: {} }

/** A partial trailing line (the agent is mid-write) is left for the next pass. */
function splitCompleteLines(chunk: string): { lines: string[]; consumed: number } {
  const lastNl = chunk.lastIndexOf('\n')
  if (lastNl < 0) return { lines: [], consumed: 0 }
  return {
    lines: chunk.slice(0, lastNl).split('\n').filter((l) => l.length > 0),
    // Byte length, not character length: the offset is a BYTE offset into the file.
    consumed: Buffer.byteLength(chunk.slice(0, lastNl + 1), 'utf-8'),
  }
}

/** Local calendar day of an ISO timestamp, matching the overview's local-midnight windows. */
function localDay(tsMs: number): string {
  const d = new Date(tsMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Is this transcript line a REAL user turn (an operator prompt / channel message), rather than a tool
 * result, a slash-command echo or a synthetic system event? Same rule the old inline counter used --
 * kept identical on purpose so the numbers do not move when the mechanism changes.
 */
export function isRealUserTurn(entry: unknown): boolean {
  const e = entry as { type?: unknown; isMeta?: unknown; message?: { content?: unknown } }
  if (e?.type !== 'user' || e.isMeta === true) return false
  const content = e.message?.content
  if (typeof content === 'string') {
    return !content.startsWith('<local-command') && !content.startsWith('<command-name>')
  }
  if (Array.isArray(content)) {
    return !content.some((b) => (b as { type?: unknown })?.type === 'tool_result')
  }
  return false
}

/** Count the turns in a chunk of complete lines, bucketed by local day. */
export function countTurnsByDay(lines: readonly string[]): Record<string, number> {
  const days: Record<string, number> = {}
  for (const line of lines) {
    let e: unknown
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRealUserTurn(e)) continue
    const ts = Date.parse(String((e as { timestamp?: unknown }).timestamp ?? ''))
    if (!Number.isFinite(ts)) continue
    const day = localDay(ts)
    days[day] = (days[day] ?? 0) + 1
  }
  return days
}

export interface UserTurnIndexDeps {
  /** Transcript root; injectable for tests. */
  readonly root?: string
  /** Where the index is persisted; injectable for tests. */
  readonly statePath?: string
}

const defaultRoot = (): string => join(homedir(), '.claude', 'projects')

function loadState(path: string): IndexState {
  try {
    if (!existsSync(path)) return { ...EMPTY, files: {} }
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as IndexState
    if (raw?.version !== 1 || typeof raw.files !== 'object' || raw.files === null) {
      return { ...EMPTY, files: {} }
    }
    return raw
  } catch {
    // A corrupt index must cost one full re-scan, never a wrong answer.
    return { ...EMPTY, files: {} }
  }
}

function saveState(path: string, state: IndexState): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    atomicWriteFileSync(path, JSON.stringify(state))
  } catch {
    /* an unwritable index only costs performance, never correctness */
  }
}

/** Read `length` bytes starting at `offset`. Returns '' on any error. */
function readFrom(file: string, offset: number, length: number): string {
  if (length <= 0) return ''
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.allocUnsafe(length)
    const read = readSync(fd, buf, 0, length, offset)
    return buf.toString('utf-8', 0, read)
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* already gone */
      }
    }
  }
}

export interface RefreshStats {
  readonly filesSeen: number
  readonly filesRead: number
  readonly bytesRead: number
}

/**
 * Bring the index up to date and return the per-day totals.
 *
 * Only files that GREW are read, and only their new bytes. A file that shrank is recounted from zero
 * (it was rotated or rewritten); an unchanged file is not opened at all.
 */
export function refreshUserTurnIndex(deps: UserTurnIndexDeps = {}): {
  days: Record<string, number>
  stats: RefreshStats
} {
  const root = deps.root ?? defaultRoot()
  const statePath =
    deps.statePath ?? join(process.env['MARVEEN_STORE'] ?? 'store', 'user-turn-index.json')
  const state = loadState(statePath)
  let filesSeen = 0
  let filesRead = 0
  let bytesRead = 0

  if (existsSync(root)) {
    for (const projectDir of readdirSync(root)) {
      const absDir = join(root, projectDir)
      try {
        if (!statSync(absDir).isDirectory()) continue
      } catch {
        continue
      }
      for (const fname of readdirSync(absDir)) {
        if (!fname.endsWith('.jsonl')) continue
        const abs = join(absDir, fname)
        let size: number
        try {
          size = statSync(abs).size
        } catch {
          continue
        }
        filesSeen++
        const prev = state.files[abs]
        // Unchanged -> nothing to do. This is the whole point: the common case costs one stat().
        if (prev && prev.size === size && prev.offset === size) continue
        // Truncated or rewritten -> the old tallies describe bytes that no longer exist.
        const from = prev && size >= prev.size ? prev.offset : 0
        const days = from === 0 ? {} : { ...(prev?.days ?? {}) }
        const chunk = readFrom(abs, from, size - from)
        const { lines, consumed } = splitCompleteLines(chunk)
        const counted = countTurnsByDay(lines)
        for (const [day, n] of Object.entries(counted)) days[day] = (days[day] ?? 0) + n
        state.files[abs] = { offset: from + consumed, size, days }
        filesRead++
        bytesRead += chunk.length
      }
    }
  }

  saveState(statePath, state)

  const days: Record<string, number> = {}
  for (const entry of Object.values(state.files)) {
    for (const [day, n] of Object.entries(entry.days)) days[day] = (days[day] ?? 0) + n
  }
  return { days, stats: { filesSeen, filesRead, bytesRead } }
}

/** Turns on one local calendar day (`YYYY-MM-DD`). */
export function turnsOnDay(days: Record<string, number>, dayMs: number): number {
  return days[localDay(dayMs)] ?? 0
}

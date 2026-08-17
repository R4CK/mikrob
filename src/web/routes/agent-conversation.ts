import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { json } from '../http-helpers.js'
import { agentDir } from '../agent-config.js'
import { resolveAgentConfigDir } from '../claude-plans.js'
import { projectsDirFor } from '../active-model.js'
import { isMainChannelsAgent } from '../main-agent.js'
import { PROJECT_ROOT } from '../../config.js'
import type { RouteContext } from './types.js'

// Read-only, human-readable conversation view for an agent. The dashboard
// terminal only mirrors the live tmux pane (no history, and it does not show
// the full Telegram traffic cleanly). The complete conversation lives in the
// Claude Code transcript (.jsonl): every inbound channel message, every
// outbound reply, and every action. We parse the newest session transcript
// into a chat-style timeline so an operator can actually review what happened
// -- and, for customer-hosted Marveens, support them. Read-only.

interface Entry {
  ts: string | null
  // in  = inbound channel (e.g. Telegram) message from the user
  // out = outbound message the agent sent back (reply/react/edit)
  // note = the agent's own narration text for that turn
  // action = a tool the agent ran (Bash, search, draft, ...)
  kind: 'in' | 'out' | 'note' | 'action'
  text: string
  label?: string
}

const MAX_TEXT = 6000
const DEFAULT_LIMIT = 400

function workingDirFor(name: string): string {
  return isMainChannelsAgent(name) ? PROJECT_ROOT : agentDir(name)
}

function sessionsDirFor(name: string): string {
  const configDir = isMainChannelsAgent(name) ? undefined : (resolveAgentConfigDir(name).configDir ?? undefined)
  return projectsDirFor(workingDirFor(name), configDir)
}

/** Every session transcript for `name`, newest first. */
function listSessionFiles(name: string): Array<{ file: string; sessionId: string; mtime: number; size: number }> {
  const dir = sessionsDirFor(name)
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const st = statSync(join(dir, f))
        return { file: join(dir, f), sessionId: f.replace(/\.jsonl$/, ''), mtime: st.mtimeMs, size: st.size }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

function newestTranscript(name: string): string | null {
  const files = listSessionFiles(name)
  return files.length ? files[0].file : null
}

/**
 * Resolve a specific session by id (card 77fd0f07, pair-FE 03d2ae9c: session dropdown lets an
 * operator replay a PAST run, not just the newest). `sessionId` is user-supplied (query param) --
 * matched against the directory's OWN listing rather than joined into a path, so an id that is not
 * one of this agent's actual session files (traversal attempt, typo, stale id from a rotated
 * session) resolves to null instead of ever touching an attacker-chosen path.
 */
function transcriptForSession(name: string, sessionId: string | null): string | null {
  if (sessionId === null) return newestTranscript(name)
  const files = listSessionFiles(name)
  return files.find(f => f.sessionId === sessionId)?.file ?? null
}

const CHANNEL_RE = /<channel\b[^>]*>([\s\S]*?)<\/channel>/g

function clip(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + ' …' : s
}

// One-line human label for a non-messaging tool call.
function actionLabel(name: string, input: Record<string, unknown>): string {
  const base = name.includes('__') ? name.split('__').pop()! : name
  const pick = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (name === 'Bash') return `Bash: ${pick('description') || pick('command').slice(0, 80)}`
  if (name === 'Read') return `Read: ${pick('file_path')}`
  if (name === 'Write') return `Write: ${pick('file_path')}`
  if (name === 'Edit') return `Edit: ${pick('file_path')}`
  if (base.includes('search_gmail')) return `Gmail keresés: ${pick('query')}`
  if (base.includes('draft_gmail')) return `Gmail draft: ${pick('subject')}`
  if (base.includes('send_gmail')) return `Email küldés: ${pick('subject')}`
  if (base.includes('import_to_google_doc')) return `Google Doc: ${pick('file_name')}`
  if (base.includes('import_to_google_slides')) return `Google Slides: ${pick('file_name')}`
  if (base === 'WebSearch') return `Web keresés: ${pick('query')}`
  if (base === 'WebFetch') return `Web lekérés: ${pick('url')}`
  if (base.includes('download_attachment')) return 'Csatolmány letöltés'
  return base
}

// Turn the newest transcript into a flat, chronological, readable timeline.
// Async (fs/promises): a transcript can be large (card 77fd0f07, Cybersec
// NO-GO comment 14132 -- this file family has had the sync-full-file-read
// class fixed twice already, fb76229f/e016ca9f), so this offloads the read
// to libuv's threadpool instead of blocking the single JS thread/event loop.
async function buildTimeline(file: string): Promise<Entry[]> {
  const entries: Entry[] = []
  const raw = (await readFile(file, 'utf-8')).split('\n')
  for (const line of raw) {
    const t = line.trim()
    if (!t) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(t) } catch { continue }
    const type = d['type']
    const ts = typeof d['timestamp'] === 'string' ? (d['timestamp'] as string) : null
    const msg = d['message'] as Record<string, unknown> | undefined
    if (!msg) continue

    if (type === 'user') {
      const content = msg['content']
      const asText = typeof content === 'string' ? content : ''
      // Only surface real inbound channel messages; skip tool results,
      // system-reminders and slash-command echoes.
      if (asText.includes('<channel')) {
        let m: RegExpExecArray | null
        CHANNEL_RE.lastIndex = 0
        while ((m = CHANNEL_RE.exec(asText)) !== null) {
          const inner = m[1].trim()
          if (inner) entries.push({ ts, kind: 'in', text: clip(inner) })
        }
      }
      continue
    }

    if (type === 'assistant') {
      const content = msg['content']
      if (!Array.isArray(content)) continue
      for (const block of content as Array<Record<string, unknown>>) {
        const bt = block['type']
        if (bt === 'text') {
          const txt = typeof block['text'] === 'string' ? (block['text'] as string).trim() : ''
          if (txt) entries.push({ ts, kind: 'note', text: clip(txt) })
        } else if (bt === 'tool_use') {
          const name = typeof block['name'] === 'string' ? (block['name'] as string) : ''
          const input = (block['input'] as Record<string, unknown>) ?? {}
          if (name.endsWith('telegram__reply') || name.endsWith('__reply')) {
            const txt = typeof input['text'] === 'string' ? (input['text'] as string) : ''
            if (txt) entries.push({ ts, kind: 'out', text: clip(txt), label: 'válasz' })
          } else if (name.endsWith('telegram__react') || name.endsWith('__react')) {
            const emoji = typeof input['emoji'] === 'string' ? (input['emoji'] as string) : '?'
            entries.push({ ts, kind: 'out', text: emoji, label: 'reakció' })
          } else if (name.endsWith('telegram__edit_message') || name.endsWith('__edit_message')) {
            const txt = typeof input['text'] === 'string' ? (input['text'] as string) : ''
            entries.push({ ts, kind: 'out', text: clip(txt), label: 'szerkesztés' })
          } else {
            entries.push({ ts, kind: 'action', text: actionLabel(name, input) })
          }
        }
      }
      continue
    }
  }
  // The full timeline, oldest-first; the route windows it for pagination.
  return entries
}

// The session picker only needs to show the recent past, not the entire
// history (an active agent accumulates thousands of session files over
// time). Capping bounds the LIST endpoint's worst-case cost to N files
// regardless of total history size -- an old session beyond the cap is still
// individually replayable via ?sessionId= (transcriptForSession is uncapped),
// it just does not appear in the picker. Card 77fd0f07, Cybersec NO-GO
// (comment 14132): the uncapped, uncached version measured at ~4.2s of
// blocking full-file reads for one real agent's history (2238 files, 603MB).
const MAX_SESSIONS_LISTED = 50

// entryCount requires a full parse of the transcript file (buildTimeline),
// which is the expensive part Cybersec's finding was about -- caching it by
// (mtime, size) means a closed session (the overwhelming majority: mtime
// only changes while a session is actively being appended to) is parsed at
// most once, no matter how many times the list is requested. Combined with
// the cap above, worst case is "at most MAX_SESSIONS_LISTED cold parses",
// not "the agent's entire history".
const entryCountCache = new Map<string, { mtime: number; size: number; count: number }>()

async function entryCountCached(file: string, mtime: number, size: number): Promise<number> {
  const hit = entryCountCache.get(file)
  if (hit && hit.mtime === mtime && hit.size === size) return hit.count
  const count = (await buildTimeline(file)).length
  entryCountCache.set(file, { mtime, size, count })
  return count
}

// GET /api/agents/:agent/sessions -- the session picker's data source (card
// 77fd0f07, pair-FE 03d2ae9c). One entry per transcript file, newest first,
// so the operator can pick a PAST run instead of only ever seeing the latest.
async function tryHandleAgentSessions(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  const match = path.match(/^\/api\/agents\/([^/]+)\/sessions$/)
  if (!match || method !== 'GET') return false
  const name = decodeURIComponent(match[1])
  try {
    const sessions = await Promise.all(
      listSessionFiles(name)
        .slice(0, MAX_SESSIONS_LISTED)
        .map(async (f) => ({
          sessionId: f.sessionId,
          mtime: f.mtime,
          entryCount: await entryCountCached(f.file, f.mtime, f.size),
        })),
    )
    json(res, { agent: name, sessions })
  } catch {
    json(res, { error: 'A session-lista feldolgozása nem sikerült' }, 500)
  }
  return true
}

export async function tryHandleAgentConversation(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (await tryHandleAgentSessions(ctx)) return true
  const match = path.match(/^\/api\/agents\/([^/]+)\/conversation$/)
  if (!match || method !== 'GET') return false
  const name = decodeURIComponent(match[1])
  // Pagination: `limit` is the page size, `offset` is how many of the NEWEST
  // entries to skip. offset=0 is the latest page; the UI pages further back
  // (offset += limit) to load older history beyond the on-screen window -- and
  // beyond the old fixed cap, since the whole transcript is now reachable.
  const limitRaw = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : DEFAULT_LIMIT
  const offsetRaw = Number(url.searchParams.get('offset'))
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0
  // Session selection (card 77fd0f07, pair-FE 03d2ae9c): absent/empty means
  // "newest", matching app-conversation.js's `conversationCurrentSessionId`
  // null convention (it never sends the param when unset).
  const sessionId = url.searchParams.get('sessionId') || null

  const file = transcriptForSession(name, sessionId)
  if (!file) { json(res, { agent: name, entries: [], total: 0, offset: 0, hasOlder: false, note: 'Nincs még beszélgetés-előzmény ehhez az agenthez.' }); return true }
  try {
    const all = await buildTimeline(file)
    const total = all.length
    const end = Math.max(0, total - offset)
    const start = Math.max(0, end - limit)
    const entries = all.slice(start, end)
    json(res, {
      agent: name,
      sessionId: file.split('/').pop()?.replace('.jsonl', '') ?? null,
      total,
      offset,
      hasOlder: start > 0,
      count: entries.length,
      entries,
    })
  } catch {
    json(res, { error: 'A beszélgetés feldolgozása nem sikerült' }, 500)
  }
  return true
}

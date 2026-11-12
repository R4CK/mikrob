// HOTMEMHAMIS925 (TASNADIDIAG908 measurement, develop c8c9d7cd = v1.39.0): no
// dashboard-memory tier (hot/warm/cold/shared) reaches an agent's context on its
// own. buildMemoryContext has had no caller since the first release, and no
// shipped hook reads memories. The scaffold's CLAUDE.md prompt nevertheless told
// every new agent that the hot tier is "paid again at EVERY session start", and
// the same false picture reached a customer (09-08).
//
// Two pins, tied together: the scaffold text states what actually loads, and the
// thing it describes stays true. If someone wires a memory-loading hook or calls
// buildMemoryContext, the second group fails and names the sentence to update.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const SCAFFOLD = readFileSync(join(ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')

function section(src: string, header: string): string {
  const start = src.indexOf(header)
  expect(start, `${header} not found in the scaffold prompt`).toBeGreaterThan(0)
  const end = src.indexOf('\n## ', start)
  return src.slice(start, end > start ? end : undefined)
}

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      srcFiles(p, out)
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
  }
  return out
}

function hookCommands(settingsPath: string): Array<{ event: string; text: string }> {
  const json = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  const out: Array<{ event: string; text: string }> = []
  for (const [event, groups] of Object.entries<any>(json.hooks ?? {})) {
    for (const g of groups) for (const h of g.hooks ?? []) out.push({ event, text: String(h.command ?? h.prompt ?? '') })
  }
  return out
}

// Hooks that may name the endpoint because they only PRINT a recipe for the agent
// to run, and load nothing themselves. Each entry carries its reason.
const RECIPE_PRINTERS: Record<string, string> = {
  'scripts/hooks/memory-lookup-nudge.py':
    'on a human message it prints the search recipe; the agent runs it and picks the keyword (TG 16727)',
}
const isExemptPrinter = (rel: string) => rel in RECIPE_PRINTERS

// Hooks that actually FETCH memories (unlike RECIPE_PRINTERS, which never touch the network) but
// are the deliberate exception the scaffold text below names: a designed PUSH of the SHARED tier
// (and, pilot-flagged, the agent's own curated hot/warm/cold) at SessionStart, not an accidental
// leak (Peti 2026-07-19; card 5a4bea2e part A for the own-curated half). Card b2f7ede4 wired this
// hook into templates/settings.json.template for backend2/backend3/logs, which is what makes this
// describe block see it for the first time -- other agents already carried it via their own
// per-agent seed, invisible to this test's two file paths. Each entry's own it.each below proves
// the exemption is not a loophole: GET-only, never a write.
const MEMORY_PUSH_HOOKS: Record<string, string> = {
  'scripts/hooks/shared-memory-inject.py':
    'SessionStart push of the shared tier (always) and the agent\'s own curated hot/warm/cold ' +
    '(pilot-flagged, fullstack only) -- the scaffold text says so explicitly',
}
const isExemptPush = (rel: string) => rel in MEMORY_PUSH_HOOKS

// Each mention of the endpoint, with the curl command it sits in (same line), or
// the bare line when no curl precedes it there.
function memoryMentions(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/api\/memories/g)) {
    const lineStart = text.lastIndexOf('\n', m.index!) + 1
    const lineEnd = text.indexOf('\n', m.index!)
    const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
    const at = m.index! - lineStart
    const curl = line.lastIndexOf('curl', at)
    out.push(curl < 0 ? line : line.slice(curl))
  }
  return out
}

// A write is an explicit mutating method, or a request body without -G/--get
// (curl -G turns --data* into query parameters, i.e. a GET).
function isWrite(cmd: string): boolean {
  if (!/^curl\b/.test(cmd)) return false
  if (/(?:^|\s)-X\s*(?:POST|PATCH|PUT|DELETE)\b/.test(cmd)) return true
  return /(?:^|\s)(?:-d|--data(?:-binary|-raw|-urlencode)?)\b/.test(cmd) && !/(?:^|\s)(?:-G|--get)\b/.test(cmd)
}

describe('scaffold memory section says what actually loads (HOTMEMHAMIS925)', () => {
  const memo = section(SCAFFOLD, '## Memoria rendszer')

  it('does not claim that a tier is loaded at session start', () => {
    expect(memo).not.toMatch(/session-indulás újra kifizeti/i)
    expect(memo).not.toMatch(/BETÖLTÉSÉBŐL/)
  })

  it('states that no tier loads on its own, and what does', () => {
    expect(memo).toContain('EGYIK tierje sem töltődik be magától')
    expect(memo).toContain('csak az kerül be, amit te magad lekérdezel')
    expect(memo).toContain('Magától a CLAUDE.md, a Claude Code saját fájl-memóriája')
    expect(memo).toContain('a SessionStart hookok saját blokkjai')
  })

  // CYBERED NO-GO F2 (card b2f7ede4): the file's own header promises "two pins, tied together",
  // but only the negative claim above was pinned -- the exception sentence that makes the
  // scaffold honest again (shared tier DOES auto-load, via this one named hook) had nothing
  // requiring it to exist, name the hook, or stay true. Measured: deleting the sentence, pointing
  // it at a nonexistent script, or claiming the agent's own curated tiers always load (false,
  // pilot-flag only) all left this describe block green before this test existed.
  it('states the SessionStart exception (shared tier auto-loads via the named hook)', () => {
    expect(memo).toContain('EGY SZÁNDÉKOS KIVÉTEL van')
    for (const key of Object.keys(MEMORY_PUSH_HOOKS)) expect(memo).toContain(key)
  })

  // CYBERED NO-GO F3 (card b2f7ede4): the exception sentence was partly wrong. (a) the hook
  // excludes GATE_AGENT_NAMES entirely (shared-memory-inject-gate-exclusion.test.ts), but the
  // sentence read as if every agent gets the push; (b) the template matcher is
  // startup|resume|compact|clear, the sentence named only three of the four; (c) "kurátort
  // emlékeid" is not valid Hungarian for "curated" (kurált).
  it('names the gate-agent exception, all four SessionStart sources, and spells "kurált" correctly', () => {
    expect(memo).toContain('gate-ügynököknél (qa, qa2, cybersec, cybersec2, cybered) nem fut')
    expect(memo).toContain('session-induláskor/resume-nál/compact-nál/clear-nél')
    expect(memo).toContain('kurált emlékeid')
    expect(memo).not.toMatch(/kurátort emlékeid/)
  })

  // The exception paragraph's own trailing claim (own-curated hot/warm/cold does NOT also
  // auto-load, pilot flag aside) is a separate sentence from the general claim pinned above --
  // measured S4: flipping just this sentence to "always loads" left the general-claim pin green.
  it('states that own-curated hot/warm/cold does not also auto-load (pilot flag aside)', () => {
    expect(memo).toContain('NEM töltődnek be magától (kivéve pilot-flaggel')
  })
})

describe('...and that stays true (update the scaffold sentence if one of these fails)', () => {
  it('nothing in src calls buildMemoryContext', () => {
    const callers = srcFiles(join(ROOT, 'src'))
      .filter((f) => /\bbuildMemoryContext\s*\(/.test(readFileSync(f, 'utf-8').replace(/export async function buildMemoryContext\s*\(/g, '')))
      .map((f) => relative(ROOT, f))
    expect(callers).toEqual([])
  })

  it.each(['templates/settings.json.template', '.claude/settings.json'])('no hook in %s reads memories', (file) => {
    const readers = hookCommands(join(ROOT, file))
      // Only the PreCompact save prompt may name the endpoint, and only in writing curls.
      .filter((h) => memoryMentions(h.text).length > 0 && !(h.event === 'PreCompact' && memoryMentions(h.text).every(isWrite)))
    expect(readers).toEqual([])
  })

  it.each(['templates/settings.json.template', '.claude/settings.json'])('no script a hook in %s runs names the memories endpoint', (file) => {
    const scripts = new Set<string>()
    for (const h of hookCommands(join(ROOT, file))) for (const m of h.text.matchAll(/scripts\/[\w./-]+\.(?:py|sh|mjs|js|ts)/g)) scripts.add(m[0])
    expect(scripts.size, 'no script path parsed from the hooks: the parser is blind').toBeGreaterThan(0)
    const hits = [...scripts].filter((rel) => existsSync(join(ROOT, rel)) && !isExemptPrinter(rel) && !isExemptPush(rel) && /api\/memories/.test(readFileSync(join(ROOT, rel), 'utf-8')))
    expect(hits).toEqual([])
  })

  // An exemption must not become the loophole: an exempt hook may PRINT the
  // endpoint (a recipe the agent runs itself), but it may not reach it.
  it.each(Object.keys(RECIPE_PRINTERS))('exempt %s only prints: no network, DB, subprocess or dynamic code on any line', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf-8')
    expect(src).toMatch(/api\/memories/) // stale-exemption guard: drop the entry when this stops holding
    expect(src).not.toMatch(/urlopen|urllib|http\.client|HTTPConnection|(?:from|import)\s+http\b|httplib|socket|sqlite3|subprocess|\brequests\b|os\.system|os\.popen|os\.exec|os\.spawn|popen|__import__|importlib|asyncio|open_connection|\b(?:exec|eval|compile)\s*\(/)
  })

  // A push exemption must not become a write loophole either. CYBERED NO-GO (card b2f7ede4 F1)
  // found eight ways past a keyword-spelling check (data=/method= inside Request(...)): a second
  // positional argument, a nested call hiding the keyword, urlopen(url, data=...) with no
  // Request() at all, a post-construction .data/.method assignment, subprocess/http.client, a
  // **kwargs splat, and a GET to a DIFFERENT host carrying the dashboard token in the URL -- all
  // GREEN under the old check. This is now an allow-list: only urllib.request/urllib.parse for
  // network, every urlopen() call takes a Request (never a raw URL), every Request(...) call
  // takes exactly one argument with no keyword or splat, nothing touches .data/.method after
  // construction, and every http(s):// host literal in the file is the dashboard itself.
  function topLevelArgs(argStr: string): string[] {
    const args: string[] = []
    let depth = 0
    let cur = ''
    let quote: string | null = null
    for (let i = 0; i < argStr.length; i++) {
      const ch = argStr[i]
      if (quote) {
        cur += ch
        if (ch === '\\') { cur += argStr[++i] ?? ''; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue }
      if (ch === ')' || ch === ']' || ch === '}') { depth--; cur += ch; continue }
      if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue }
      cur += ch
    }
    if (cur.trim()) args.push(cur.trim())
    return args
  }

  it.each(Object.keys(MEMORY_PUSH_HOOKS))('exempt %s only reads: allow-list, not a spelling check (CYBERED NO-GO, card b2f7ede4 F1)', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf-8')
    expect(src).toMatch(/api\/memories/) // stale-exemption guard: drop the entry when this stops holding

    // No network/exec surface beyond urllib.request + urllib.parse.
    expect(src).not.toMatch(/urllib3|http\.client|HTTPConnection|(?:from|import)\s+http\b|httplib|\bsocket\b|subprocess|\brequests\b|os\.system|os\.popen|os\.exec|os\.spawn|\bpopen\b|__import__|importlib|asyncio|open_connection|\b(?:exec|eval|compile)\s*\(/)

    // No splat, and no post-construction .data/.method/.add_data mutation -- .add_header stays
    // allowed (that is how the Authorization header is legitimately attached).
    expect(src).not.toMatch(/\*\*\w/)
    expect(src).not.toMatch(/\.(?:method|data|add_data)\s*=/)

    // Every urlopen() call takes a Request object (first arg is not a raw string literal), and
    // never carries a write-shaped kwarg itself.
    const urlopenCalls = [...src.matchAll(/\burlopen\(((?:[^()]|\([^()]*\))*)\)/g)]
    expect(urlopenCalls.length, 'no urlopen(...) call found: the parser is blind').toBeGreaterThan(0)
    for (const call of urlopenCalls) {
      const firstArg = topLevelArgs(call[1])[0] ?? ''
      expect(firstArg, `urlopen() first arg is a raw literal, not a Request object: ${call[0]}`).not.toMatch(/^['"]/)
      expect(call[1], `urlopen() call carries a write-shaped kwarg: ${call[0]}`).not.toMatch(/(?:^|,)\s*(?:data|method)\s*=/)
    }

    // Every Request(...) call takes EXACTLY ONE argument: no second positional, no nested call
    // hiding a keyword after it, no keyword, no splat.
    const requestCalls = [...src.matchAll(/urllib\.request\.Request\(((?:[^()]|\([^()]*\))*)\)/g)]
    expect(requestCalls.length, 'no urllib.request.Request(...) call found: the parser is blind').toBeGreaterThan(0)
    for (const call of requestCalls) {
      const args = topLevelArgs(call[1])
      expect(args.length, `Request() takes more than one argument: ${call[0]}`).toBe(1)
      expect(args[0], `Request()'s one argument has a keyword or splat: ${call[0]}`).not.toMatch(/[=*]/)
    }

    // Every http(s):// host literal in the file is the dashboard itself -- a bare GET to a
    // different host is still a leak if the dashboard token rides along in the URL.
    const hostLiterals = [...src.matchAll(/https?:\/\/[^"'\s%]+/g)].map((m) => m[0])
    for (const host of hostLiterals) {
      expect(host, `non-dashboard host literal: ${host}`).toMatch(/^http:\/\/localhost:/)
    }
  })
})

describe('the write/read classifier the PreCompact exception relies on', () => {
  const one = (cmd: string) => memoryMentions(cmd).every(isWrite)
  it('POST, PATCH and a bare -d are writes', () => {
    expect(one(`curl -s -X POST http://h/api/memories -d '{}'`)).toBe(true)
    expect(one(`curl -s -X PATCH http://h/api/memories/5 -d '{}'`)).toBe(true)
    expect(one(`curl -s http://h/api/memories -d '{}'`)).toBe(true)
  })
  it('a plain GET, a -G --data-urlencode search and a prose mention are reads', () => {
    expect(one(`curl -s "http://h/api/memories?category=hot"`)).toBe(false)
    expect(one(`curl -s -G --data-urlencode "category=hot" "http://h/api/memories"`)).toBe(false)
    expect(one(`Kérd le: GET /api/memories`)).toBe(false)
  })
})

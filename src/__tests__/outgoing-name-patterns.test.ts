import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, getDb } from '../db.js'
import { tryHandleNamePatterns } from '../web/routes/name-patterns.js'
import {
  addPattern, removePattern, readPatterns, NamePatternError, type NamePatternDeps,
} from '../web/outgoing-name-patterns.js'
import type { RouteContext } from '../web/routes/types.js'

// Card 98dbbcc9. What is actually at stake, and therefore what these tests pin:
//
// scripts/hooks/outgoing-copy-gate.py compiles `"|".join(bad_name_patterns)` at import time
// with no try/except. A pattern Python cannot compile makes the hook exit 1 with empty
// stdout -- and only exit 2 blocks a tool call, so the gate does not fail closed, it
// SILENTLY STOPS RUNNING for every agent. So the load-bearing property is not "the API
// returns 400", it is "a rejected pattern never reaches the file", and the file that IS
// written still loads in Python.
//
// The second property is confidentiality: this file names a private third party, so the
// patterns must not appear in the audit trail, and the file must stay 0600.

// Resolved from THIS file, not process.cwd(): vitest runs with the agent directory as cwd,
// so a cwd-relative path silently pointed at a non-existent script.
const TOOL = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'scripts', 'name-pattern-tool.py')
const ADMIN: RouteContext['auth'] = { kind: 'token' }

let dir: string
let rulesPath: string

function realDeps(overrides: Partial<NamePatternDeps> = {}): NamePatternDeps {
  return {
    rulesPath,
    isWorktree: () => false,
    runTool: (req) =>
      JSON.parse(
        execFileSync('python3', [TOOL], { input: JSON.stringify(req), timeout: 20_000 }).toString(),
      ),
    ...overrides,
  }
}

function writeRules(obj: unknown) {
  writeFileSync(rulesPath, JSON.stringify(obj), { mode: 0o600 })
}

function readRules(): Record<string, unknown> {
  return JSON.parse(readFileSync(rulesPath, 'utf8')) as Record<string, unknown>
}

function mkRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: '',
    writeHead(s: number, h?: Record<string, unknown>) { this.statusCode = s; if (h) Object.assign(this.headers, h); return this },
    setHeader(k: string, v: string) { this.headers[k] = v },
    end(d?: string) { if (d !== undefined) this.body += d },
  }
}

async function call(
  method: string,
  opts: { body?: unknown; auth?: RouteContext['auth']; deps?: NamePatternDeps; path?: string } = {},
) {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const req = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  req.headers = {}
  const res = mkRes()
  const path = opts.path ?? '/api/security/name-patterns'
  const handled = await tryHandleNamePatterns(
    {
      req: req as http.IncomingMessage,
      res: res as unknown as http.ServerResponse,
      path, method,
      url: new URL(`http://127.0.0.1:3420${path}`),
      auth: 'auth' in opts ? opts.auth : ADMIN,
    },
    opts.deps ?? realDeps(),
  )
  return { handled, statusCode: res.statusCode, json: () => JSON.parse(res.body || '{}') as Record<string, unknown> }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'name-patterns-test-'))
  rulesPath = join(dir, 'outgoing-copy-gate-rules.json')
  writeRules({ bad_name_patterns: [], correction: 'A helyes alak: Kovács.' })
  getDb().prepare('DELETE FROM config_change_log').run()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('name-pattern validation runs the engine that consumes the file', () => {
  it('REJECTS a pattern Python cannot compile and leaves the file untouched', () => {
    const before = readFileSync(rulesPath, 'utf8')
    expect(() => addPattern(realDeps(), 'unclosed(', 'regex')).toThrow(NamePatternError)
    expect(readFileSync(rulesPath, 'utf8')).toBe(before)
  })

  it('rejects the two shapes Node would have accepted and Python crashes on', () => {
    // The whole reason validation is not done with `new RegExp`. If either of these ever
    // lands in the file, every agent's outgoing-copy gate stops running silently.
    for (const bad of ['(?<n>x)', '\\p{L}']) {
      expect(() => addPattern(realDeps(), bad, 'regex'), bad).toThrow(NamePatternError)
    }
    expect(readPatterns(realDeps()).patterns).toEqual([])
  })

  it('does NOT falsely reject a Python-only construct', () => {
    expect(addPattern(realDeps(), '(?P<n>Kovacs)', 'regex').count).toBe(1)
  })

  it('refuses a catastrophically backtracking pattern', () => {
    expect(() => addPattern(realDeps(), '(a+)+$', 'regex')).toThrow(NamePatternError)
    expect(readPatterns(realDeps()).patterns).toEqual([])
  })

  it('escapes a literal in Python, so a name full of metacharacters is storable', () => {
    addPattern(realDeps(), "O'Brien (Jr.)", 'literal')
    const [stored] = readPatterns(realDeps()).patterns
    expect(stored).toBe("O'Brien\\ \\(Jr\\.\\)")
    // The point of escaping: it matches the literal name, not a regex group.
    const hit = execFileSync('python3', [
      '-c', 'import re,sys; p,s=sys.stdin.read().split("\\x00"); print("HIT" if re.search(p,s) else "MISS")',
    ], { input: `${stored}\x00Levelet írt O'Brien (Jr.) tegnap` }).toString().trim()
    expect(hit).toBe('HIT')
  })

  it('whatever it accepts still compiles JOINED, the way the hook compiles it', () => {
    addPattern(realDeps(), 'Kovács(né)?', 'regex')
    addPattern(realDeps(), "O'Brien (Jr.)", 'literal')
    addPattern(realDeps(), '(?P<x>Nagy)', 'regex')
    const joined = readPatterns(realDeps()).patterns.join('|')
    const out = execFileSync('python3', [
      '-c', 'import re,sys; re.compile(sys.stdin.read()); print("LOADS")',
    ], { input: joined }).toString().trim()
    expect(out).toBe('LOADS')
  })
})

describe('file discipline', () => {
  it('keeps the file at 0600 across a write', () => {
    // atomicWriteFileSync only chmods when the caller passes opts.mode; omitting it silently
    // relaxes 0600 to the umask default. This file names a private person.
    addPattern(realDeps(), 'Kovacs', 'literal')
    expect(statSync(rulesPath).mode & 0o777).toBe(0o600)
  })

  it('preserves sibling keys instead of rewriting the file to just its own field', () => {
    addPattern(realDeps(), 'Kovacs', 'literal')
    expect(readRules().correction).toBe('A helyes alak: Kovács.')
  })

  it('refuses to write from a git worktree, where the file would not be the fleet-read one', () => {
    const deps = realDeps({ isWorktree: () => true })
    expect(() => addPattern(deps, 'Kovacs', 'literal')).toThrow(NamePatternError)
    expect(readPatterns(realDeps()).patterns).toEqual([])
  })

  it('reports broken for a malformed file and refuses to delete from it', () => {
    writeRules({ correction: 'x' }) // bad_name_patterns key absent == malformed, per the hook
    expect(readPatterns(realDeps()).state).toBe('broken')
    expect(() => removePattern(realDeps(), 'anything')).toThrow(NamePatternError)
  })

  it('distinguishes a deliberate empty list from a broken file', () => {
    expect(readPatterns(realDeps()).state).toBe('empty')
    addPattern(realDeps(), 'Kovacs', 'literal')
    expect(readPatterns(realDeps()).state).toBe('active')
  })
})

describe('HTTP surface', () => {
  it('denies device, federation and anonymous principals on every method', async () => {
    for (const auth of [
      { kind: 'device', device: 'evil', deviceId: 1 } as RouteContext['auth'],
      { kind: 'federation', peer: 'p' } as RouteContext['auth'],
      undefined,
    ]) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const r = await call(method, { auth, body: { value: 'x', mode: 'literal' } })
        expect(r.statusCode, `${method} ${String(auth?.kind)}`).toBe(403)
      }
    }
    expect(readPatterns(realDeps()).patterns).toEqual([])
  })

  it('GET returns the list plus the three-state health of the file', async () => {
    addPattern(realDeps(), 'Kovacs', 'literal')
    const r = await call('GET')
    expect(r.statusCode).toBe(200)
    expect(r.json().patterns).toEqual(['Kovacs'])
    expect(r.json().state).toBe('active')
    expect(r.json().file_mode_ok).toBe(true)
  })

  it('POST adds and DELETE removes, by value', async () => {
    const add = await call('POST', { body: { value: 'Kovacs', mode: 'literal' } })
    expect(add.statusCode).toBe(201)
    expect(add.json().count).toBe(1)

    const del = await call('DELETE', { body: { pattern: 'Kovacs' } })
    expect(del.json().count).toBe(0)
    expect(readPatterns(realDeps()).patterns).toEqual([])
  })

  it('a stale delete removes NOTHING rather than the wrong row', async () => {
    addPattern(realDeps(), 'Elso', 'literal')
    addPattern(realDeps(), 'Masodik', 'literal')
    const r = await call('DELETE', { body: { pattern: 'Harmadik' } })
    expect(r.statusCode).toBe(404)
    expect(readPatterns(realDeps()).patterns).toEqual(['Elso', 'Masodik'])
  })

  it('returns 400 with a speaking reason for a bad pattern, and writes nothing', async () => {
    const r = await call('POST', { body: { value: 'unclosed(', mode: 'regex' } })
    expect(r.statusCode).toBe(400)
    expect(String(r.json().error)).toMatch(/nem fordul le/)
    expect(readPatterns(realDeps()).patterns).toEqual([])
  })

  it('rejects an unknown mode rather than guessing', async () => {
    const r = await call('POST', { body: { value: 'x', mode: 'wildcard' } })
    expect(r.statusCode).toBe(400)
  })

  it('ignores paths it does not own', async () => {
    const r = await call('GET', { path: '/api/security/bridge-enroll' })
    expect(r.handled).toBe(false)
  })
})

describe('the pattern content never leaves the operator screen', () => {
  it('writes COUNTS to the audit trail, never the pattern itself', async () => {
    const secret = 'Nagyné Titkos Magánszemély'
    await call('POST', { body: { value: secret, mode: 'literal' } })
    await call('DELETE', { body: { pattern: 'Nagyné\\ Titkos\\ Magánszemély' } })

    const rows = getDb()
      .prepare('SELECT key, old_value, new_value FROM config_change_log')
      .all() as Array<{ key: string; old_value: string | null; new_value: string | null }>
    expect(rows).toHaveLength(2)
    const blob = JSON.stringify(rows)
    // Not just the whole string -- any distinctive fragment of the name would be a leak.
    for (const frag of ['Nagyné', 'Titkos', 'Magánszemély']) {
      expect(blob, `audit trail leaked ${frag}`).not.toContain(frag)
    }
    expect(rows[0].key).toBe('security.name_patterns')
    expect(rows.map((r) => r.new_value)).toEqual(['1', '0'])
  })
})

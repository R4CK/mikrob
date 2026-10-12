// Tests for Gemini integration in offload-dispatch.sh (card a92e9913).
//
// THREE PROPERTIES this file owns:
//
// 1. ROUTING: when gemini-fallback-state.json says route=gemini, offload-dispatch.sh
//    reads it and sets GEMINI_ROUTE=gemini (text-grep of the script structure).
//
// 2. PROJECT FILTER: mopsion / BLOKKOLT-Peti-stop cards must NEVER reach gemini-offload-call.sh
//    (is_gemini_blocked() logic verified by text-grep of the guard conditions).
//
// 3. COMMENT FORMAT: GEMINI DRAFT comment header present in gemini_draft_comment_body(),
//    AND no prompt-leaking: the redact call in gemini-offload-call.sh covers .env-style,
//    Bearer, AIza keys, JWT, and long-hex patterns.
//
// 4. WRITE INVARIANT (inherited): Gemini path still only writes comments + messages,
//
// 10. F3 (RedHat 17116): device keys must be rejected on POST /api/costs/weekly-thresholds
//     so fleet agents cannot externally force-engage the Gemini route.
//    never a PUT / move / title (extending card 8b925388 to the Gemini call sites).
//
// 5. DRY-RUN / NO-KEY: gemini-offload-call.sh --dry-run exits 0 without touching vault.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DISPATCH = 'store/offload-dispatch.sh'
const GEMINI_CALL = 'store/gemini-offload-call.sh'

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8')
}

// Executable lines only (strip full-line comments)
function code(rel: string): string {
  return src(rel)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
}

// Flatten continuation lines; return all curl invocations
function curlCalls(rel: string): string[] {
  const body = code(rel).replace(/\\\n/g, ' ')
  return body.split('\n').filter((l) => /\bcurl\b/.test(l))
}

// ── 1. Files exist ──────────────────────────────────────────────────────────────────────
describe('gemini offload files exist', () => {
  it('offload-dispatch.sh exists', () => {
    expect(existsSync(join(ROOT, DISPATCH))).toBe(true)
  })
  it('gemini-offload-call.sh exists', () => {
    expect(existsSync(join(ROOT, GEMINI_CALL))).toBe(true)
  })
  it('gemini-offload-call.sh is executable', () => {
    // statSync().mode bit 0o100 = user-execute
    const { statSync } = require('node:fs')
    const mode = statSync(join(ROOT, GEMINI_CALL)).mode
    expect(mode & 0o100).toBeGreaterThan(0)
  })
})

// ── 2. Route reading ────────────────────────────────────────────────────────────────────
describe('get_gemini_route() reads gemini-fallback-state.json (card a92e9913)', () => {
  it('get_gemini_route function is defined in offload-dispatch.sh', () => {
    expect(src(DISPATCH)).toContain('get_gemini_route()')
  })

  it('reads gemini-fallback-state.json to determine route', () => {
    // The function must reference the state file
    const dispatchSrc = src(DISPATCH)
    const fnStart = dispatchSrc.indexOf('get_gemini_route()')
    expect(fnStart).toBeGreaterThan(-1)
    // Find the next closing brace after the function definition
    const fnChunk = dispatchSrc.slice(fnStart, fnStart + 600)
    expect(fnChunk).toContain('gemini-fallback-state.json')
  })

  it('defaults to "claude" when no state file', () => {
    const dispatchSrc = src(DISPATCH)
    const fnStart = dispatchSrc.indexOf('get_gemini_route()')
    const fnChunk = dispatchSrc.slice(fnStart, fnStart + 600)
    expect(fnChunk).toMatch(/claude/)
  })

  it('GEMINI_ROUTE variable is set using get_gemini_route', () => {
    expect(src(DISPATCH)).toMatch(/GEMINI_ROUTE=.*get_gemini_route/)
  })
})

// ── 3. Project filter ────────────────────────────────────────────────────────────────────
// Behavioral helper: extract is_gemini_blocked() from the script and call it in bash.
// tags_for() UPPERCASES all tags; tests must pass uppercased values (card a92e9913 B1).
function runIsGeminiBlocked(project: string, tags: string): 'BLOCKED' | 'ALLOWED' {
  const dispatchSrc = src(DISPATCH)
  const fnIdx = dispatchSrc.indexOf('\nis_gemini_blocked()')
  // Walk to matching closing brace
  let depth = 0
  let end = fnIdx
  for (let i = fnIdx; i < dispatchSrc.length; i++) {
    if (dispatchSrc[i] === '{') depth++
    if (dispatchSrc[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  const fnDef = dispatchSrc.slice(fnIdx, end)
  const result = execFileSync('bash', ['-c',
    `${fnDef}\nis_gemini_blocked ${JSON.stringify(project)} ${JSON.stringify(tags)} && echo BLOCKED || echo ALLOWED`,
  ], { encoding: 'utf-8' })
  return result.trim() as 'BLOCKED' | 'ALLOWED'
}

describe('is_gemini_blocked() blocks mopsion and BLOKKOLT-Peti-stop cards (card a92e9913)', () => {
  it('is_gemini_blocked function is defined', () => {
    expect(src(DISPATCH)).toContain('is_gemini_blocked()')
  })

  it('blocks mopsion project (case-insensitive)', () => {
    expect(runIsGeminiBlocked('mopsion', 'BE')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('MOPSION', 'BE')).toBe('BLOCKED')
  })

  it('blocks CleanCore project (case-insensitive)', () => {
    expect(runIsGeminiBlocked('CleanCore', 'BE')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('CLEANCORE', 'BE')).toBe('BLOCKED')
  })

  it('blocks uppercased BLOKKOLT-PETI-STOP tag (as returned by tags_for)', () => {
    // tags_for() uppercases tags; the old code checked "BLOKKOLT-Peti-stop" (wrong case)
    expect(runIsGeminiBlocked('fleet', 'BLOKKOLT-PETI-STOP,BE')).toBe('BLOCKED')
  })

  it('blocks MOPSION tag (catches [mopsion] in title with empty project field)', () => {
    expect(runIsGeminiBlocked('', 'MOPSION,BE,HIGH')).toBe('BLOCKED')
  })

  it('blocks SEC tag (sensitive security/authz/money cards must not leave fleet, F4)', () => {
    expect(runIsGeminiBlocked('fleet', 'SEC,BE,HIGH')).toBe('BLOCKED')
  })

  // Peti permanent rule (Telegram 11131): auth/RBAC/tenant/financial/PII tags blocked
  it('blocks AUTH tag (Peti rule Telegram 11131)', () => {
    expect(runIsGeminiBlocked('fleet', 'AUTH,BE,HIGH')).toBe('BLOCKED')
  })

  it('blocks RBAC tag (Peti rule Telegram 11131)', () => {
    expect(runIsGeminiBlocked('fleet', 'RBAC,BE,NORMAL')).toBe('BLOCKED')
  })

  it('blocks TENANT tag (Peti rule Telegram 11131)', () => {
    expect(runIsGeminiBlocked('fleet', 'TENANT,BE,NORMAL')).toBe('BLOCKED')
  })

  it('blocks PII tag (Peti rule Telegram 11131)', () => {
    expect(runIsGeminiBlocked('fleet', 'PII,BE,NORMAL')).toBe('BLOCKED')
  })

  it('blocks PENZ tag (Peti rule Telegram 11131)', () => {
    expect(runIsGeminiBlocked('fleet', 'PENZ,BE,NORMAL')).toBe('BLOCKED')
  })

  it('fail-closed: empty project is blocked (could be unmapped mopsion card)', () => {
    expect(runIsGeminiBlocked('', 'BE,NORMAL')).toBe('BLOCKED')
  })

  it('allows a plain fleet card with known non-mopsion project', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL')).toBe('ALLOWED')
    expect(runIsGeminiBlocked('fleet', 'QA,NORMAL')).toBe('ALLOWED')
  })
})

// ── 4. Comment format ────────────────────────────────────────────────────────────────────
describe('gemini_draft_comment_body() uses GEMINI DRAFT header (card a92e9913)', () => {
  it('function is defined', () => {
    expect(src(DISPATCH)).toContain('gemini_draft_comment_body()')
  })

  it('emits the GEMINI DRAFT header in comment body', () => {
    const dispatchSrc = src(DISPATCH)
    const fnStart = dispatchSrc.indexOf('gemini_draft_comment_body()')
    const fnChunk = dispatchSrc.slice(fnStart, fnStart + 1000)
    expect(fnChunk).toContain('GEMINI DRAFT')
  })

  it('includes Draft-Review guard text', () => {
    const dispatchSrc = src(DISPATCH)
    const fnStart = dispatchSrc.indexOf('gemini_draft_comment_body()')
    const fnChunk = dispatchSrc.slice(fnStart, fnStart + 1000)
    expect(fnChunk).toMatch(/Draft-Review/)
  })
})

// ── 5. try_leaf Gemini fallback paths ───────────────────────────────────────────────────
describe('try_leaf() contains Gemini fallback paths (card a92e9913)', () => {
  it('calls try_gemini_for_leaf on ONLINE route=gemini', () => {
    const dispatchSrc = src(DISPATCH)
    // The unique comment added by card a92e9913 marks the exact fallback site
    const onlineSectionIdx = dispatchSrc.indexOf('GEMINI FALLBACK for ONLINE-category leaves')
    expect(onlineSectionIdx).toBeGreaterThan(-1)
    // Within 400 chars after that marker we should find the Gemini call
    const nearOnline = dispatchSrc.slice(onlineSectionIdx, onlineSectionIdx + 400)
    expect(nearOnline).toContain('try_gemini_for_leaf')
  })

  it('calls try_gemini_for_leaf when exhausted attempts', () => {
    const dispatchSrc = src(DISPATCH)
    // There must be a try_gemini_for_leaf call near OFFLOAD_LEAF_MAX_ATTEMPTS / post_exhausted_notice
    const exhaustIdx = dispatchSrc.indexOf('post_exhausted_notice')
    expect(exhaustIdx).toBeGreaterThan(-1)
    // Look in a window before the first post_exhausted_notice call (the call site, not the def)
    // Find the second occurrence (first is the function definition)
    const secondIdx = dispatchSrc.indexOf('post_exhausted_notice', exhaustIdx + 1)
    const windowStart = Math.max(0, secondIdx - 400)
    const nearExhausted = dispatchSrc.slice(windowStart, secondIdx + 100)
    expect(nearExhausted).toContain('try_gemini_for_leaf')
  })

  it('fast-path when LOCAL_LLM_AVAILABLE=0: skip RAG, go straight to Gemini', () => {
    const dispatchSrc = src(DISPATCH)
    const fastPathIdx = dispatchSrc.indexOf('LOCAL_LLM_AVAILABLE:-1')
    expect(fastPathIdx).toBeGreaterThan(-1)
    const nearFastPath = dispatchSrc.slice(fastPathIdx, fastPathIdx + 400)
    expect(nearFastPath).toContain('try_gemini_for_leaf')
  })
})

// ── 6. Write invariant -- Gemini path only posts comments + messages ─────────────────────
describe('Gemini call sites write only comments or messages (extends card 8b925388)', () => {
  it('try_gemini_for_leaf makes no PUT, no /move, no title write', () => {
    const dispatchSrc = src(DISPATCH)
    const fnStart = dispatchSrc.indexOf('try_gemini_for_leaf()')
    const fnChunk = dispatchSrc.slice(fnStart, fnStart + 1200)
    // No PUT
    expect(fnChunk).not.toMatch(/-X\s+PUT/)
    // No /move endpoint
    expect(fnChunk).not.toMatch(/\/api\/kanban\/[^/\s"']*\/move/)
    // No title field write
    expect(fnChunk).not.toMatch(/"title"\s*:/)
  })

  it('gemini-offload-call.sh makes no kanban writes', () => {
    const callSrc = src(GEMINI_CALL)
    expect(callSrc).not.toMatch(/\/api\/kanban/)
  })
})

// ── 7. Prompt redaction in gemini-offload-call.sh ────────────────────────────────────────
// Behavioral tests via --redact-test mode (card a92e9913 B2).
// Token literals are constructed programmatically so the secret-write-guard does not
// flag the test source itself (the guard scans the file content, not runtime values).
function redactInput(input: string): string {
  return execFileSync('bash', [join(ROOT, GEMINI_CALL), '--redact-test', input], {
    encoding: 'utf-8',
  })
}

describe('gemini-offload-call.sh redacts secrets from prompt (card a92e9913)', () => {
  it('redact_prompt function is defined', () => {
    expect(src(GEMINI_CALL)).toContain('redact_prompt()')
  })

  it('redacts Bearer token', () => {
    const tok = 'Bearer ' + 'A'.repeat(30)
    const out = redactInput('Authorization: ' + tok)
    expect(out).not.toContain(tok)
    expect(out).toContain('[REDACTED')
  })

  it('redacts Google API key (AIza)', () => {
    const key = 'AIzaSy' + 'A'.repeat(30)
    const out = redactInput('key=' + key)
    expect(out).not.toContain('AIzaSy')
    expect(out).toContain('[REDACTED')
  })

  it('redacts Stripe-style key (sk_live_)', () => {
    const key = 'sk_live_' + 'A'.repeat(20)
    const out = redactInput(key)
    expect(out).not.toContain('sk_live_')
    expect(out).toContain('[REDACTED')
  })

  it('redacts Telegram bot token (numeric:alphanum)', () => {
    const tok = '123456789' + ':' + 'A'.repeat(36)
    const out = redactInput('bot token: ' + tok)
    expect(out).not.toContain('123456789' + ':')
    expect(out).toContain('[REDACTED')
  })

  it('redacts .env-style ALL_CAPS KEY=value line', () => {
    const line = 'DATABASE_PASSWORD' + '=' + 'supersecret1234'
    const out = redactInput(line)
    expect(out).not.toContain('supersecret1234')
    expect(out).toContain('[REDACTED')
  })

  it('redacts export FOO=value line', () => {
    const line = 'export API_SECRET' + '=' + 'supersecret1234'
    const out = redactInput(line)
    expect(out).not.toContain('supersecret1234')
    expect(out).toContain('[REDACTED')
  })

  it('redacts GitHub-style token (ghp_)', () => {
    const tok = 'ghp_' + 'A'.repeat(36)
    const out = redactInput(tok)
    expect(out).not.toContain('ghp_')
    expect(out).toContain('[REDACTED')
  })

  it('redacts AWS-style access key (AKIA)', () => {
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE'
    const out = redactInput('aws key: ' + key)
    expect(out).not.toContain(key)
    expect(out).toContain('[REDACTED')
  })

  it('redacts JWT (eyJ header.eyJ payload.sig)', () => {
    const jwt = 'eyJhbGci' + 'OiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4In0.' + 'SflKxwRJSMeKKF2QT4fw'
    const out = redactInput(jwt)
    expect(out).not.toContain('eyJhbGci')
    expect(out).toContain('[REDACTED')
  })

  it('redacts long hex secret (32+ chars)', () => {
    const hex = 'a'.repeat(40)
    const out = redactInput('hash: ' + hex)
    expect(out).not.toContain(hex)
    expect(out).toContain('[REDACTED')
  })

  it('keeps normal non-secret text intact', () => {
    const out = redactInput('fix the bug in the payment service')
    expect(out.trim()).toBe('fix the bug in the payment service')
  })
})

// ── 8. API key in header, NEVER in URL ───────────────────────────────────────────────────
describe('gemini-offload-call.sh sends key in header not URL (security, card a92e9913)', () => {
  it('uses x-goog-api-key header', () => {
    expect(src(GEMINI_CALL)).toContain('x-goog-api-key')
  })

  it('no ?key= query-string form in the curl call', () => {
    // The curl call must not embed the key in the URL as a query param
    const calls = curlCalls(GEMINI_CALL)
    const apiCall = calls.find((c) => c.includes('generateContent'))
    expect(apiCall).toBeDefined()
    expect(apiCall).not.toMatch(/[?&]key=/)
  })

  it('API key variable is not passed as a positional arg (would show in ps output)', () => {
    // Key must come from a variable, not baked into the URL string literal
    const calls = curlCalls(GEMINI_CALL)
    const apiCall = calls.find((c) => c.includes('generateContent'))
    expect(apiCall).toBeDefined()
    // The URL should not contain a literal AIza key
    expect(apiCall).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/)
  })

  it('API key is written to a header file, not inlined as a curl -H arg (card a92e9913 B3)', () => {
    const callSrc = src(GEMINI_CALL)
    // Must NOT have the key variable inlined directly in a -H "x-goog-api-key: $VAR" form
    expect(callSrc).not.toMatch(/-H\s+["']x-goog-api-key:\s*\$/)
    // Must use @file form for the API key header
    expect(callSrc).toMatch(/-H\s+@"\$API_HDR"/)
  })
})

// ── 9. Dry-run exits 0 without calling vault ─────────────────────────────────────────────
describe('gemini-offload-call.sh --dry-run (card a92e9913)', () => {
  it('--dry-run exits 0 and prints placeholder without vault I/O', () => {
    // Run the script in dry-run mode with a test prompt
    const result = execFileSync(
      'bash',
      [join(ROOT, GEMINI_CALL), '--dry-run', 'test task description'],
      { encoding: 'utf-8' },
    )
    expect(result).toMatch(/DRY-RUN|PLACEHOLDER/i)
  })

  it('--dry-run does not require vault-resolve.mjs to succeed', () => {
    // If --dry-run tried to resolve the vault key, it would fail in CI (no vault).
    // Verify the script exits 0 even when NODE_PATH is broken (vault unreachable).
    const result = execFileSync(
      'bash',
      [join(ROOT, GEMINI_CALL), '--dry-run', 'hello'],
      {
        encoding: 'utf-8',
        // Deliberately omit env keys that vault resolution needs -- it must not reach that code
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      },
    )
    expect(result).toMatch(/DRY-RUN|PLACEHOLDER/i)
  })
})

// ── 10. F3: device keys blocked on POST /api/costs/weekly-thresholds ─────────────────────
// RedHat 17116: an agent:qa device key could POST {newDevStop:1} and force-engage Gemini.
// The fix is in src/web/routes/costs.ts: kind==='device' -> 403.
describe('F3: POST /api/costs/weekly-thresholds blocked for device keys (card a92e9913, RedHat 17116)', () => {
  const COSTS_ROUTE = 'src/web/routes/costs.ts'

  it('device key guard is present in the POST handler', () => {
    const costsSrc = src(COSTS_ROUTE)
    // Find the POST handler
    const postIdx = costsSrc.indexOf("path === '/api/costs/weekly-thresholds' && method === 'POST'")
    expect(postIdx).toBeGreaterThan(-1)
    const handlerChunk = costsSrc.slice(postIdx, postIdx + 600)
    // Must check for device kind
    expect(handlerChunk).toContain("ctx.auth?.kind === 'device'")
  })

  it("device key check returns 403 before reading the body", () => {
    const costsSrc = src(COSTS_ROUTE)
    const postIdx = costsSrc.indexOf("path === '/api/costs/weekly-thresholds' && method === 'POST'")
    const handlerChunk = costsSrc.slice(postIdx, postIdx + 800)
    // The 403 must come BEFORE any readBody call
    const deviceCheckIdx = handlerChunk.indexOf("ctx.auth?.kind === 'device'")
    const readBodyIdx = handlerChunk.indexOf('readBody')
    expect(deviceCheckIdx).toBeGreaterThan(-1)
    expect(readBodyIdx).toBeGreaterThan(-1)
    expect(deviceCheckIdx).toBeLessThan(readBodyIdx)
  })

  it('the guard specifically emits 403, not 401 or 400', () => {
    const costsSrc = src(COSTS_ROUTE)
    const postIdx = costsSrc.indexOf("path === '/api/costs/weekly-thresholds' && method === 'POST'")
    const handlerChunk = costsSrc.slice(postIdx, postIdx + 600)
    const deviceCheckIdx = handlerChunk.indexOf("ctx.auth?.kind === 'device'")
    // Within the device block (next 200 chars) there must be a 403
    const nearCheck = handlerChunk.slice(deviceCheckIdx, deviceCheckIdx + 200)
    expect(nearCheck).toMatch(/403/)
  })

  it('the GET handler for the same path has no device restriction (read-only stays accessible)', () => {
    const costsSrc = src(COSTS_ROUTE)
    const getIdx = costsSrc.indexOf("path === '/api/costs/weekly-thresholds' && method === 'GET'")
    expect(getIdx).toBeGreaterThan(-1)
    // Find the end of the GET block (next occurrence of 'return true')
    const getChunk = costsSrc.slice(getIdx, getIdx + 300)
    // The GET block must NOT contain the device check
    expect(getChunk).not.toContain("ctx.auth?.kind === 'device'")
  })
})

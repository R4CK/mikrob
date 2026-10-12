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
// title is optional (3rd arg) for content-gate tests (WhiteHat2 F1c).
function runIsGeminiBlocked(project: string, tags: string, title = ''): 'BLOCKED' | 'ALLOWED' {
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
    `${fnDef}\nis_gemini_blocked ${JSON.stringify(project)} ${JSON.stringify(tags)} ${JSON.stringify(title)} && echo BLOCKED || echo ALLOWED`,
  ], { encoding: 'utf-8' })
  return result.trim() as 'BLOCKED' | 'ALLOWED'
}

describe('is_gemini_blocked() -- project allowlist + tag blocks + content-gate (card a92e9913)', () => {
  it('is_gemini_blocked function is defined', () => {
    expect(src(DISPATCH)).toContain('is_gemini_blocked()')
  })

  // F1a: PROJECT ALLOWLIST -- only "mikrob" (casefold) is allowed
  it('blocks mopsion project (not in allowlist)', () => {
    expect(runIsGeminiBlocked('mopsion', 'BE')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('MOPSION', 'BE')).toBe('BLOCKED')
  })

  it('blocks CleanCore project (not in allowlist)', () => {
    expect(runIsGeminiBlocked('CleanCore', 'BE')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('CLEANCORE', 'BE')).toBe('BLOCKED')
  })

  it('blocks unknown/other projects (WhiteHat2 F1a -- allowlist, not blocklist)', () => {
    expect(runIsGeminiBlocked('Ingatlan', 'BE,NORMAL')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('fleet', 'QA,NORMAL')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('SomeOtherProject', 'BE')).toBe('BLOCKED')
  })

  it('fail-closed: empty project is blocked', () => {
    expect(runIsGeminiBlocked('', 'BE,NORMAL')).toBe('BLOCKED')
  })

  it('allows only the mikrob/MikroB project (case-insensitive)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL')).toBe('ALLOWED')
    expect(runIsGeminiBlocked('MikroB', 'BE,NORMAL')).toBe('ALLOWED')
    expect(runIsGeminiBlocked('MIKROB', 'BE,NORMAL')).toBe('ALLOWED')
  })

  // F1b: TAG BLOCKS -- casefold + accent-strip + expanded blocklist
  it('blocks BLOKKOLT-PETI-STOP tag (uppercase, as returned by tags_for)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BLOKKOLT-PETI-STOP,BE')).toBe('BLOCKED')
  })

  it('blocks any BLOKKOLT-* variant (generalised, WhiteHat2 F1b)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BLOKKOLT-PETI-DONTES,BE')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BLOKKOLT-ANYTHING,BE')).toBe('BLOCKED')
  })

  it('blocks MOPSION tag (catches [mopsion] in title with empty project)', () => {
    expect(runIsGeminiBlocked('mikrob', 'MOPSION,BE,HIGH')).toBe('BLOCKED')
  })

  it('blocks SEC tag', () => {
    expect(runIsGeminiBlocked('mikrob', 'SEC,BE,HIGH')).toBe('BLOCKED')
  })

  // Peti permanent rule (Telegram 11131)
  it('blocks AUTH tag', () => {
    expect(runIsGeminiBlocked('mikrob', 'AUTH,BE,HIGH')).toBe('BLOCKED')
  })

  it('blocks RBAC tag', () => {
    expect(runIsGeminiBlocked('mikrob', 'RBAC,BE,NORMAL')).toBe('BLOCKED')
  })

  it('blocks TENANT tag', () => {
    expect(runIsGeminiBlocked('mikrob', 'TENANT,BE,NORMAL')).toBe('BLOCKED')
  })

  it('blocks PII tag', () => {
    expect(runIsGeminiBlocked('mikrob', 'PII,BE,NORMAL')).toBe('BLOCKED')
  })

  it('blocks PENZ tag', () => {
    expect(runIsGeminiBlocked('mikrob', 'PENZ,BE,NORMAL')).toBe('BLOCKED')
  })

  // F1b accent/casefold variants (WhiteHat2 finding -- these passed through before)
  it('blocks PÉNZ tag (accented uppercase, WhiteHat2 F1b)', () => {
    expect(runIsGeminiBlocked('mikrob', 'PÉNZ,BE,NORMAL')).toBe('BLOCKED')
  })

  it('blocks PENZUGY tag', () => {
    expect(runIsGeminiBlocked('mikrob', 'PENZUGY,BE,NORMAL')).toBe('BLOCKED')
  })

  it('blocks SECURITY tag (WhiteHat2 F1b)', () => {
    expect(runIsGeminiBlocked('mikrob', 'SECURITY,BE,NORMAL')).toBe('BLOCKED')
  })

  it('blocks AUTHZ tag (WhiteHat2 F1b)', () => {
    expect(runIsGeminiBlocked('mikrob', 'AUTHZ,BE,NORMAL')).toBe('BLOCKED')
  })

  it('blocks SUPERADMIN tag (WhiteHat2 F1b)', () => {
    expect(runIsGeminiBlocked('mikrob', 'SUPERADMIN,BE,NORMAL')).toBe('BLOCKED')
  })

  it('blocks FINANCE, BILLING, PAYMENT tags (WhiteHat2 F1b)', () => {
    expect(runIsGeminiBlocked('mikrob', 'FINANCE,BE,NORMAL')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BILLING,BE,NORMAL')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'PAYMENT,BE,NORMAL')).toBe('BLOCKED')
  })

  it('blocks SECRET, CRYPTO, GDPR, PRIVACY, LEGAL, CYBERSEC tags (WhiteHat2 F1b)', () => {
    expect(runIsGeminiBlocked('mikrob', 'SECRET,BE,NORMAL')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'CRYPTO,BE,NORMAL')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'GDPR,BE,NORMAL')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'PRIVACY,BE,NORMAL')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'LEGAL,BE,NORMAL')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'CYBERSEC,BE,NORMAL')).toBe('BLOCKED')
  })

  // F1c: CONTENT GATE on card title (WhiteHat2 finding -- tag-less security audit cards)
  it('blocks by title content-gate (security keyword, WhiteHat2 F1c)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', '[MikroB][LOW] Heti önaudit: SSE ?token= query param biztonsági lelet')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Auth middleware security review')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'RBAC jogosultsági ellenőrzés')).toBe('BLOCKED')
  })

  it('allows a plain mikrob fleet card (no sensitive tags or title keywords)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Add logging to the dashboard API endpoint')).toBe('ALLOWED')
    expect(runIsGeminiBlocked('mikrob', 'QA,NORMAL', 'Write unit tests for the date formatter')).toBe('ALLOWED')
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
describe('try_leaf() Gemini fallback paths (card a92e9913)', () => {
  // F1d (WhiteHat2): categorical-online leaves NEVER go to Gemini -- the router already
  // classified them as sensitive.  The old "GEMINI FALLBACK for ONLINE-category leaves"
  // marker + try_gemini_for_leaf call has been removed from that branch.
  it('categorical-online branch does NOT call try_gemini_for_leaf (F1d, WhiteHat2)', () => {
    const dispatchSrc = src(DISPATCH)
    // Find the categorical-online handling section
    const catOnlineIdx = dispatchSrc.indexOf('categorical-online')
    expect(catOnlineIdx).toBeGreaterThan(-1)
    // Extract the block up to the next rc= assignment or return (conservative 600 char window)
    const catOnlineBlock = dispatchSrc.slice(catOnlineIdx, catOnlineIdx + 600)
    // Must NOT contain a try_gemini_for_leaf call inside this block
    expect(catOnlineBlock).not.toContain('try_gemini_for_leaf')
  })

  it('categorical-online branch does NOT have the old GEMINI FALLBACK marker (F1d cleanup)', () => {
    expect(src(DISPATCH)).not.toContain('GEMINI FALLBACK for ONLINE-category leaves')
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

// ── 7. Secret detection in gemini-offload-call.sh ────────────────────────────────────────
// FAIL-CLOSED (F2, WhiteHat2, card a92e9913): ANY secret-shaped token in prompt -> exit 2,
// no output, no send to Gemini.  The old "best-effort redaction" (replacing with [REDACTED])
// is removed: a false-negative in redaction leaks secrets; fail-closed is the only safe default.
//
// Token literals are constructed programmatically so the secret-write-guard does not
// flag the test source itself (the guard scans the file content, not runtime values).
function redactInput(input: string): { exitCode: number; output: string } {
  try {
    const output = execFileSync('bash', [join(ROOT, GEMINI_CALL), '--redact-test', input], {
      encoding: 'utf-8',
    })
    return { exitCode: 0, output }
  } catch (e: any) {
    return { exitCode: e.status ?? 1, output: e.stdout ?? '' }
  }
}

describe('gemini-offload-call.sh detects secrets fail-closed (F2, card a92e9913)', () => {
  it('redact_prompt function is defined', () => {
    expect(src(GEMINI_CALL)).toContain('redact_prompt()')
  })

  it('blocks (exit 2, no output) on Bearer token', () => {
    const tok = 'Bearer ' + 'A'.repeat(30)
    const r = redactInput('Authorization: ' + tok)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on Google API key (AIza)', () => {
    const key = 'AIzaSy' + 'A'.repeat(30)
    const r = redactInput('key=' + key)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on Stripe-style key (sk_live_)', () => {
    const key = 'sk_live_' + 'A'.repeat(20)
    const r = redactInput(key)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on Telegram bot token (numeric:alphanum)', () => {
    const tok = '123456789' + ':' + 'A'.repeat(36)
    const r = redactInput('bot token: ' + tok)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on .env-style ALL_CAPS KEY=value line', () => {
    const line = 'DATABASE_PASSWORD' + '=' + 'supersecret1234'
    const r = redactInput(line)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on export FOO=value line', () => {
    const line = 'export API_SECRET' + '=' + 'supersecret1234'
    const r = redactInput(line)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on GitHub-style token (ghp_)', () => {
    const tok = 'ghp_' + 'A'.repeat(36)
    const r = redactInput(tok)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on AWS-style access key (AKIA)', () => {
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE'
    const r = redactInput('aws key: ' + key)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on JWT (eyJ header.eyJ payload.sig)', () => {
    const jwt = 'eyJhbGci' + 'OiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4In0.' + 'SflKxwRJSMeKKF2QT4fw'
    const r = redactInput(jwt)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on long hex secret (32+ chars)', () => {
    const hex = 'a'.repeat(40)
    const r = redactInput('hash: ' + hex)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('passes through (exit 0, output intact) normal non-secret text', () => {
    const text = 'fix the bug in the payment service'
    const r = redactInput(text)
    expect(r.exitCode).toBe(0)
    expect(r.output.trim()).toBe(text)
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

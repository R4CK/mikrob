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

// Extract a bash function's full source (name through matching closing brace), by name.
function extractFn(fullSrc: string, name: string): string {
  const idx = fullSrc.indexOf(`\n${name}()`)
  let depth = 0
  let end = idx
  for (let i = idx; i < fullSrc.length; i++) {
    if (fullSrc[i] === '{') depth++
    if (fullSrc[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  return fullSrc.slice(idx, end)
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
// title is optional (3rd arg), desc is optional (4th arg) for content-gate tests.
function runIsGeminiBlocked(project: string, tags: string, title = '', desc = ''): 'BLOCKED' | 'ALLOWED' {
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
    `${fnDef}\nis_gemini_blocked ${JSON.stringify(project)} ${JSON.stringify(tags)} ${JSON.stringify(title)} ${JSON.stringify(desc)} && echo BLOCKED || echo ALLOWED`,
  ], { encoding: 'utf-8' })
  return result.trim() as 'BLOCKED' | 'ALLOWED'
}

// F4 (WhiteHat NO-GO, komment 17848, card e87e7520): a real embedded newline cannot survive
// runIsGeminiBlocked above -- JSON.stringify() escapes "\n" into the two literal characters
// backslash+n before the text ever reaches bash, so a test built on it can never exercise the
// re.DOTALL fix either way. This variant passes title/desc as real argv elements (positional
// params after the inline script), so an actual LF byte reaches the Python side unescaped.
function runIsGeminiBlockedRaw(project: string, tags: string, title: string, desc: string): 'BLOCKED' | 'ALLOWED' {
  const fnDef = extractFn(src(DISPATCH), 'is_gemini_blocked')
  const script = `${fnDef}\nis_gemini_blocked "$1" "$2" "$3" "$4" && echo BLOCKED || echo ALLOWED`
  const result = execFileSync('bash', ['-c', script, 'bash', project, tags, title, desc], { encoding: 'utf-8' })
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

  // N5(c) (RedHat NO-GO, b3ce0a88 komment 18124, card e45945a2): exact-match-only tag
  // comparison let a punctuation-decorated title-bracket tag bypass both the BLOCKED_TAGS
  // exact-match set and the old startswith("blokkolt-") check. Confirmed on pre-fix code
  // (git show of this same card) that all three shapes below returned ALLOWED.
  it('blocks a comma-suffixed "[SEC,x]" title-bracket tag (N5(c))', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE', 'Valami [SEC,x] cim')).toBe('BLOCKED')
  })

  it('blocks a hyphen-suffixed "[SEC-hardening]" title-bracket tag (N5(c))', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE', 'Valami [SEC-hardening] cim')).toBe('BLOCKED')
  })

  it('blocks a non-hyphen BLOKKOLT suffix: "[BLOKKOLT,x]" and "[BLOKKOLT x]" (N5(c))', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE', 'Valami [BLOKKOLT,x] cim')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BE', 'Valami [BLOKKOLT x] cim')).toBe('BLOCKED')
  })

  it('does not over-block a tag that merely CONTAINS "sec" as a substring (N5(c), no over-blocking)', () => {
    expect(runIsGeminiBlocked('mikrob', 'RESECTION,BE,NORMAL')).toBe('ALLOWED')
    expect(runIsGeminiBlocked('mikrob', 'INSECURE,BE,NORMAL')).toBe('ALLOWED')
    expect(runIsGeminiBlocked('mikrob', 'NORMAL-PRIORITY,BE')).toBe('ALLOWED')
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

  // F1c extension: CONTENT GATE on description (card a92e9913 MikroB 11335)
  // A card like 6a4e34c1 has no sensitive tag, no sensitive title, but sensitive description.
  it('blocks by description content-gate (security keyword in desc, no title keyword)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Heti audit eredménye', 'Az SSE végpont ?token= query paramétert küld -- biztonsági lelet.')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'API endpoint cleanup', 'The auth middleware leaks the JWT token in the response.')).toBe('BLOCKED')
  })

  it('blocks by description with password keyword (no title match)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'User onboarding flow', 'Admin password reset uses a hardcoded default secret.')).toBe('BLOCKED')
  })

  it('allows card with clean title AND clean description', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Add CSV export', 'Export the monthly report as a downloadable CSV file.')).toBe('ALLOWED')
  })

  // RedHat 17510 finding 1: the content gate matched only whole ASCII words, with no
  // normalization and no stemming -- 3 of 6 tag-less sensitive cards passed through
  // (payroll, Számla/ÁFA, Jogosultság), as did bracket labels like [Biztonság]/[FIN].
  // These are the exact measured bypass cases; each must now BLOCK.
  it('blocks tag-less payroll card (RedHat 17510 finding 1)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Payroll export javitas', '')).toBe('BLOCKED')
  })

  it('blocks tag-less Számla/ÁFA card, accented (RedHat 17510 finding 1)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Számla/ÁFA export finomítás', '')).toBe('BLOCKED')
  })

  it('blocks tag-less Jogosultság card, accented suffix extension (RedHat 17510 finding 1)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Jogosultság kezelés', '')).toBe('BLOCKED')
  })

  it('blocks bracket label [Biztonság] (accented, trailing boundary previously never matched)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', '[Biztonság] heti audit', '')).toBe('BLOCKED')
  })

  it('blocks bracket label [FIN]', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', '[FIN] heti riport', '')).toBe('BLOCKED')
  })

  it('still allows a genuinely clean card after normalization (no over-blocking regression)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Add logging to the dashboard API endpoint', '')).toBe('ALLOWED')
  })

  // WhiteHat2 H1 (card 40d2a253, non-blocking GO finding on a92e9913): the content gate used
  // to cap title/desc at 1000/8000 chars before inspecting them, but try_leaf() sends the FULL,
  // uncapped title+desc to Gemini as "$task" -- a sensitive word placed past the old cut point
  // reached Gemini unblocked. Fixed by inspecting the full text (via stdin, no argv cap needed).
  it('blocks a sensitive word placed past the old 8000-char description cap (WhiteHat2 H1)', () => {
    const pad = 'x'.repeat(9000)
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'clean title', `${pad} biztonsagi resz`)).toBe('BLOCKED')
  })

  it('still allows a long but genuinely clean description past the old cap (no over-blocking)', () => {
    const pad = 'x'.repeat(9000)
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'clean title', `${pad} nothing sensitive here`)).toBe('ALLOWED')
  })

  // RedHat 17567 B2 (card a92e9913 delta-gate NO-GO): vocabulary parity with the router's own
  // authz/PII prefilter -- "permission", "access control" and the Hungarian "szemelyes adat" /
  // "hozzaferes" were measured to pass through this gate unblocked.
  it('blocks a permission-model card with no sensitive tag (RedHat 17567 B2)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Permission model for the export', '')).toBe('BLOCKED')
  })

  it('blocks an access-control-list card with no sensitive tag (RedHat 17567 B2)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Access control list for exports', '')).toBe('BLOCKED')
  })

  it('blocks a Hungarian personal-data (szemelyes adat) card, accented (RedHat 17567 B2)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Személyes adat maszkolás a naplóban', '')).toBe('BLOCKED')
  })

  it('blocks a Hungarian access-rights (hozzaferes) card, accented (RedHat 17567 B2)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Hozzáférés-vezérlés finomhangolása', '')).toBe('BLOCKED')
  })

  // RedHat 17567 B4(a) (card a92e9913 delta-gate NO-GO): the existing accented test cases above
  // (Számla/ÁFA, Jogosultság, Biztonság) happen to have their ENTIRE matched stem in plain ASCII
  // -- the accent sits only after the matched portion ("jogosult" matches inside "Jogosultság"
  // even without any accent-stripping at all), so a mutant that disables normalization() still
  // passes them. These three instead have the accented character INSIDE the matched stem itself
  // ("pénz" vs stem "penz": the é is the stem's 2nd letter; "jelszó" vs stem "jelszo": the ó is
  // the stem's 6th/last letter; "számla" vs stem "szamla": the á is the stem's 3rd letter), so
  // they only match AFTER casefold+accent-stripping -- a disabled-normalization mutant goes red.
  it('blocks "Pénzügyi riport" -- accent sits INSIDE the matched stem (RedHat 17567 B4a)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Pénzügyi riport', '')).toBe('BLOCKED')
  })

  it('blocks "Jelszó csere" -- accent sits INSIDE the matched stem (RedHat 17567 B4a)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Jelszó csere', '')).toBe('BLOCKED')
  })

  it('blocks "Számla" alone -- accent sits INSIDE the matched stem (RedHat 17567 B4a)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Számla', '')).toBe('BLOCKED')
  })

  // N3 (RedHat 17653, card e87e7520 -> deferred to 15398b82): the WhiteHat2 H1 cap-reinsert
  // guard above (line ~317) only pads the DESCRIPTION -- a mutant that reintroduces a
  // title[:1000] cap specifically would stay green forever, because no existing test puts the
  // sensitive word past a 1000-char TITLE. Mirrors the desc guard, for the title field.
  it('blocks a sensitive word placed past a 1000-char title cap (N3, mirrors WhiteHat2 H1 for title)', () => {
    const pad = 'x'.repeat(1200)
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', `${pad} biztonsagi resz`, 'clean desc')).toBe('BLOCKED')
  })

  it('still allows a long but genuinely clean title past a 1000-char cap (N3, no over-blocking)', () => {
    const pad = 'x'.repeat(1200)
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', `${pad} nothing sensitive here`, 'clean desc')).toBe('ALLOWED')
  })

  // N3 (same source): the three B4a "accent inside the matched stem" cases right above are all
  // TITLE-only (desc=''). A mutant that disables normalization on the DESCRIPTION specifically
  // (e.g. a copy-paste bug that normalizes title_n but not desc_n) would stay green forever,
  // since nothing exercises an accent-inside-stem word in the description field.
  it('blocks "Jelszó módosítás szükséges" in the DESCRIPTION -- accent inside stem (N3, mirrors B4a for desc)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'clean title', 'Jelszó módosítás szükséges')).toBe('BLOCKED')
  })

  // N3 (same source): "hozzaferes", "afa" and "berszamfejtes" stem-deletion mutants stayed
  // green against the EXISTING B2 test strings above, because those strings also contain a
  // SIBLING stem ("Hozzáférés-vezérlés finomhangolása" also matches "fin" via "finomhangolasa";
  // "Számla/ÁFA" also matches "szamla") -- deleting either stem alone left the other one
  // blocking, so the mutation went undetected. These three are standalone strings containing
  // ONLY the named stem (verified: no other SENS_RE/TENANT_ISOLATION_RE/BLOCKED_TAGS stem fires
  // on them), so deleting that one stem from SENS_RE now DOES flip the matching test to ALLOWED.
  it('blocks "AFA kalkulacio hiba a riportban" -- isolated stem, no sibling overlap (N3)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'AFA kalkulacio hiba a riportban', '')).toBe('BLOCKED')
  })

  it('blocks "Hozzaferes lista a modulhoz" -- isolated stem, no "fin" sibling (N3)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Hozzaferes lista a modulhoz', '')).toBe('BLOCKED')
  })

  it('blocks "Berszamfejtes exportja hianyos" -- previously untested stem, no sibling overlap (N3)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Berszamfejtes exportja hianyos', '')).toBe('BLOCKED')
  })

  // N3 (same source): "penz" törlése is only an EQUIVALENT mutant against a string that ALSO
  // contains "penzugy" ("penz" is a strict prefix of "penzugy" and is listed first in the
  // alternation, so Python's leftmost-alternative matching always resolves via "penz" first --
  // deleting "penzugy" would never be caught by ANY test, that part IS a true equivalent mutant
  // and is not worth chasing). Deleting "penz" itself is NOT equivalent: a string containing
  // "penz" but NOT "penzugy" isolates it cleanly, as below.
  it('blocks "Penz atutalas naplozasa" -- isolated "penz" stem, no "penzugy" substring (N3)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Penz atutalas naplozasa', '')).toBe('BLOCKED')
  })

  // RedHat 17510 finding 2, sharpened by WhiteHat2 H2 (card 40d2a253): is_gemini_blocked used
  // to treat rc=1 as "allowed" -- but rc=1 is ALSO what a bare, uncaught Python exception exits
  // with by default, so a genuine classifier bug was silently indistinguishable from "allowed".
  // Fixed by giving "allowed" its own code (42) that nothing else can produce; rc=1 now means
  // BLOCKED, same as any other unexpected interpreter outcome.
  function runIsGeminiBlockedWithFakeRc(rc: number): 'BLOCKED' | 'ALLOWED' {
    const fnDef = extractFn(src(DISPATCH), 'is_gemini_blocked')
    const result = execFileSync('bash', ['-c',
      `python3() { return ${rc}; }\n${fnDef}\nis_gemini_blocked mikrob "BE,NORMAL" "clean title" "clean desc" && echo BLOCKED || echo ALLOWED`,
    ], { encoding: 'utf-8' })
    return result.trim() as 'BLOCKED' | 'ALLOWED'
  }

  it('fail-closed on interpreter crash: python3 missing (rc=127) -> BLOCKED, not allowed', () => {
    expect(runIsGeminiBlockedWithFakeRc(127)).toBe('BLOCKED')
  })

  it('fail-closed on interpreter crash: oversized argv (rc=126) -> BLOCKED, not allowed', () => {
    expect(runIsGeminiBlockedWithFakeRc(126)).toBe('BLOCKED')
  })

  it('fail-closed on rc=1, the SAME code a bare Python exception exits with (WhiteHat2 H2) -> BLOCKED, not allowed', () => {
    expect(runIsGeminiBlockedWithFakeRc(1)).toBe('BLOCKED')
  })

  it('fail-closed on any other unexpected nonzero rc -> BLOCKED, not allowed', () => {
    expect(runIsGeminiBlockedWithFakeRc(99)).toBe('BLOCKED')
  })

  it('rc=42, the deliberate allowed signal, passes through as ALLOWED', () => {
    expect(runIsGeminiBlockedWithFakeRc(42)).toBe('ALLOWED')
  })

  it('the real classifier still returns ALLOWED end-to-end for a genuinely clean card (fail-closed fix does not break the real path)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'clean title', 'clean desc')).toBe('ALLOWED')
  })

  // N1 (RedHat 17653, card e87e7520): fullwidth-Latin obfuscation ("ｓｅｃｒｅｔ") bypassed the
  // old NFD-only norm(), which decomposes combining accents but not compatibility chars. NFKD
  // decomposes fullwidth forms to plain ASCII, so these must now BLOCK.
  it('blocks fullwidth-Latin obfuscated "secret" in the title (N1, NFKD)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'ｓｅｃｒｅｔ kezeles', '')).toBe('BLOCKED')
  })

  it('blocks fullwidth-Latin obfuscated "jelszo" in the description (N1, NFKD)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'clean title', 'ｊｅｌｓｚｏ csere')).toBe('BLOCKED')
  })

  // N1 second half: Cyrillic homoglyphs (visually identical to Latin, distinct codepoint) have
  // no NFKD decomposition to Latin at all -- only the explicit substitution table catches them.
  // "ѕесrеt" below uses Cyrillic с/е/ѕ in place of Latin c/e/s.
  it('blocks a Cyrillic-homoglyph "secret" (N1, homoglyph map)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'ѕеcrеt handling', '')).toBe('BLOCKED')
  })

  it('still allows a genuinely clean card after the N1 fix (no over-blocking regression)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Add logging to the dashboard API endpoint', 'Export the monthly report.')).toBe('ALLOWED')
  })

  // N6 first half (RedHat 17653, card e87e7520): BLOCKED_TAGS was missing exact-match entries
  // for "fin" and "biztonsag" -- both stems already existed in SENS_RE for title/desc text, but
  // a TAG literally named "fin"/"biztonsag" fell through because BLOCKED_TAGS never had them.
  it('blocks FIN tag (N6, exact-match tag addition)', () => {
    expect(runIsGeminiBlocked('mikrob', 'FIN,NORMAL', 'Clean title', '')).toBe('BLOCKED')
  })

  it('blocks BIZTONSAG tag (N6, exact-match tag addition)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BIZTONSAG,NORMAL', 'Clean title', '')).toBe('BLOCKED')
  })

  // N6 second half: Hungarian tenant-isolation co-occurrence, ported from the routers prefilter.
  // A bare "berlo" (tenant/lessee) stem alone must stay ALLOWED (also means a literal building
  // tenant); it only blocks when it co-occurs with a separation/isolation verb within 40 chars.
  it('blocks "berlo" co-occurring with "elkulonit" within 40 chars, either order (N6)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'A berlok adatainak elkulonitese kotelezo', '')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'A berlok adatainak szetvalasztasa fontos', '')).toBe('BLOCKED')
  })

  it('allows a bare "berlo" mention with no isolation verb nearby (N6, no over-blocking)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'A berlo szerzodese februarban lejar', '')).toBe('ALLOWED')
  })

  // F2 (WhiteHat NO-GO, komment 17848, card e87e7520): the homoglyph table is open-ended and
  // norm() silently dropped any unmapped non-ASCII letter -- fail-closed instead on a script
  // the table doesn't cover (Greek, Armenian, small-caps, struck-through Latin all qualify;
  // using Greek iota below since it's distinct from every mapped Cyrillic row).
  it('blocks a sensitive word spelled with an unmapped (non-table) homoglyph letter (F2, fail-closed)', () => {
    // Greek small iota (U+03B9) in place of Latin "i" in "privacy" -- not in _HOMOGLYPH_MAP.
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'prιvacy review', '')).toBe('BLOCKED')
  })

  it('still allows genuine Hungarian accented text after the F2 fail-closed fix (no over-blocking)', () => {
    // NFKD decomposes accented Hungarian letters into base-ASCII + a combining mark (category
    // Mn, not a Letter) -- has_unmapped_letter() must NOT trip on this.
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'Frissítsd a riportok oszlopait', 'Törd le a hónap végi összesítést.')).toBe('ALLOWED')
  })

  // F4 (WhiteHat NO-GO, komment 17848, card e87e7520): TENANT_ISOLATION_RE gaps. (a) "." does
  // not span a newline, so a multi-line description bypassed the co-occurrence check.
  it('blocks "berlo" + isolation verb co-occurring across a REAL newline (F4, re.DOTALL)', () => {
    expect(runIsGeminiBlockedRaw('mikrob', 'BE,NORMAL', 'Clean title', 'A berlok adatainak\nelkulonitese kotelezo')).toBe('BLOCKED')
  })

  // F4 (b): the verb list only had "elkulonit"/"szetvalaszt" -- natural phrasings using
  // izolacio/szeparalas/elvalasztas/kulonvalasztas/kulonites still bypassed.
  it('blocks "berlo" co-occurring with each newly-added isolation verb stem (F4)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'A berlok izolacioja a riportokban', '')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'A berlok szeparalasa fontos', '')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'A berlok elvalasztasa a riportban', '')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'A berlok kulonvalasztasa kotelezo', '')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'A berlok adatainak kulonitese', '')).toBe('BLOCKED')
  })

  // F5 (WhiteHat NO-GO, komment 17848, card e87e7520): the homoglyph table had 13 rows but only
  // 2 (Cyrillic е, ѕ) were covered by a test -- deleting any OTHER row stayed 134/134 green.
  // One explicit, distinct-stem test per remaining row so each row's removal goes RED on its own.
  it('blocks Cyrillic homoglyph "а" (U+0430) in "password" (F5, table row а)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'pаssword reset', '')).toBe('BLOCKED')
  })
  it('blocks Cyrillic homoglyph "о" (U+043E) in "token" (F5, table row о)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'tоken rotation', '')).toBe('BLOCKED')
  })
  it('blocks Cyrillic homoglyph "р" (U+0440) in "superadmin" (F5, table row р)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'suрeradmin access', '')).toBe('BLOCKED')
  })
  it('blocks Cyrillic homoglyph "с" (U+0441) in "access" (F5, table row с)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'aсcess review', '')).toBe('BLOCKED')
  })
  it('blocks Cyrillic homoglyph "у" (U+0443) in "payment" (F5, table row у)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'paуment flow', '')).toBe('BLOCKED')
  })
  it('blocks Cyrillic homoglyph "х" (U+0445) in "xss" (F5, table row х)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'хss filter', '')).toBe('BLOCKED')
  })
  it('blocks Cyrillic homoglyph "і" (U+0456) in "pii" (F5, table row і)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'pіi masking', '')).toBe('BLOCKED')
  })
  it('blocks Cyrillic homoglyph "һ" (U+04BB) in "hacker" (F5, table row һ)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'һacker report', '')).toBe('BLOCKED')
  })
  it('blocks Cyrillic homoglyph "ԃ" (U+0503) in "gdpr" (F5, table row ԃ)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'gԃpr audit', '')).toBe('BLOCKED')
  })
  it('blocks Latin small letter script "ɡ" (U+0261) in "gdpr" (F5, table row ɡ)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'ɡdpr audit v2', '')).toBe('BLOCKED')
  })
  it('blocks Roman numeral "ⅰ" (U+2170) in "privacy" (F5, table row ⅰ)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE,NORMAL', 'prⅰvacy notice', '')).toBe('BLOCKED')
  })

  // C1 (WhiteHat2 GO 17900, card e87e7520 -> deferred to 33047d3f): an ASCII control byte
  // (DEL/BS/US/...) spliced into a sensitive stem is already ascii, so it survived
  // encode("ascii","ignore") in norm() unchanged and split the word, bypassing SENS_RE.
  // runIsGeminiBlockedRaw (not the JSON.stringify-based helper) is required: JSON.stringify
  // would \u00XX-escape a C0 control byte as six literal text characters, which bash's
  // double-quote parsing does not expand back -- only a real argv element carries the byte.
  it('blocks a DEL (0x7F) control char spliced into "secret" in the title (C1)', () => {
    expect(runIsGeminiBlockedRaw('mikrob', 'BE,NORMAL', 'se\x7Fcret feature', '')).toBe('BLOCKED')
  })
  it('blocks a BS (0x08) control char spliced into "jelszo" in the description (C1)', () => {
    expect(runIsGeminiBlockedRaw('mikrob', 'BE,NORMAL', 'clean title', 'jel\x08szo csere')).toBe('BLOCKED')
  })
  it('blocks a US (0x1F) control char spliced into "tenant" in the title (C1)', () => {
    expect(runIsGeminiBlockedRaw('mikrob', 'BE,NORMAL', 'ten\x1Fant scope fix', '')).toBe('BLOCKED')
  })

  // C3 (WhiteHat2 GO 17900, card e87e7520 -> deferred to 33047d3f): the F2 fail-closed check
  // (has_unmapped_letter) only ran on title/desc, never on tags -- a tag with an unmapped
  // homoglyph normalized via norm()'s silent ascii-drop into something that no longer matched
  // BLOCKED_TAGS, instead of being blocked outright.
  it('blocks a tag containing an unmapped Greek-epsilon homoglyph for "sec" (C3)', () => {
    expect(runIsGeminiBlocked('mikrob', 'sεc,BE,NORMAL')).toBe('BLOCKED')
  })
  it('still allows a genuinely accented Hungarian tag after the C3 fix (no over-blocking)', () => {
    // "é" NFKD-decomposes to base-ASCII "e" + a combining mark (category Mn, not a Letter) --
    // has_unmapped_letter() must not trip on this, same invariant as the title/desc check.
    expect(runIsGeminiBlocked('mikrob', 'BE,FELÉPÍTÉS,NORMAL')).toBe('ALLOWED')
  })

  // T1: CALL-SITE GUARD -- is_gemini_blocked must be called at both Gemini call sites.
  // These tests go RED if the guard is removed from either call site.
})

// ── T1 (true behavioral, RedHat 17510 finding 3) ─────────────────────────────────────────
// MikroB 11363 / RedHat 17510: the previous T1 tests only grepped SOURCE TEXT POSITIONS
// (does "is_gemini_blocked" appear textually before "try_gemini_for_leaf" in a window?).
// That stays green if a call site drops the title/desc ARGUMENTS (so the content-gate never
// actually runs) or if the categorical-online branch regains an unguarded Gemini call outside
// the windows those tests scan. This block instead SOURCES the real try_leaf() function with
// stubbed dependencies (no real kanban/API/network calls) and actually EXECUTES both call
// sites end-to-end, asserting on whether the (recording) try_gemini_for_leaf stub was invoked.
describe('try_leaf() end-to-end behavioral guard (T1, RedHat 17510 finding 3)', () => {
  type TryLeafOpts = {
    fastPath: boolean // true = LOCAL_LLM_AVAILABLE=0 call site; false = exhausted-attempts call site
    project: string
    tags: string
    title: string
    desc: string
    ragRc?: number // which branch of try_leaf's local-RAG result to exercise (default 5 = transient)
    offloadNoGemini?: boolean // card 21fbc293, WhiteHat2 F1: the draft loop's fail-closed env var
  }

  function runTryLeaf(
    opts: TryLeafOpts & { advisoryDraftStub?: string; qualityGateStub?: string },
  ): { geminiCalled: boolean; geminiArgs: string } {
    const dispatchSrc = src(DISPATCH)
    const isBlockedFn = extractFn(dispatchSrc, 'is_gemini_blocked')
    const routeEnabledFn = extractFn(dispatchSrc, 'gemini_route_enabled')
    const tryLeafFn = extractFn(dispatchSrc, 'try_leaf')
    const ragRc = opts.ragRc ?? 5
    const advisoryDraftStub = opts.advisoryDraftStub ?? 'advisory_draft() { cat >/dev/null; }'
    const qualityGateStub = opts.qualityGateStub ?? 'draft_quality_ok() { echo "OK"; }'

    const script = `
set -uo pipefail
HERE="$(mktemp -d)"
touch "$HERE/gemini-offload-enabled"   # route enabled for this test
GEMINI_ROUTE="gemini"
LOCAL_LLM_AVAILABLE=${opts.fastPath ? '0' : '1'}
OFFLOAD_LEAF_MAX_ATTEMPTS=2
${opts.offloadNoGemini ? 'OFFLOAD_NO_GEMINI=1' : ''}
RECORD="$(mktemp)"

# Stub RAG as a real executable (try_leaf calls "$RAG" ... as a command, not a function):
# rc=5 = transient failure (not 0, not 9); rc=9 = categorical-online (router decision, RedHat
# 17567 B3) -- this branch must NEVER call try_gemini_for_leaf, regardless of content.
RAG="$(mktemp)"
printf '#!/usr/bin/env bash\\nexit ${ragRc}\\n' > "$RAG"
chmod +x "$RAG"

${isBlockedFn}
${routeEnabledFn}

# Stubs for everything else try_leaf touches -- no real kanban/API/network I/O.
attempts_op() { echo '{"attempts":2}'; }
graph_repo_for() { echo ""; }
graph_args_for() { :; }
decompose_sample_context() { :; }
${qualityGateStub}
post_draft_comment() { :; }
${advisoryDraftStub}
post_exhausted_notice() { :; }
nudge_leaf_owner() { :; }
try_gemini_for_leaf() { echo "CALLED:$*" >> "$RECORD"; return 0; }

${tryLeafFn}

try_leaf "test-leaf-1" "$TEST_TITLE" "$TEST_DESC" "backend2" "$TEST_TAGS" "$TEST_PROJECT" "" "" "test-leaf-1" "false" >/dev/null 2>&1

cat "$RECORD" 2>/dev/null
rm -rf "$HERE" "$RAG" "$RECORD"
`
    const out = execFileSync('bash', ['-c', script], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        TEST_TITLE: opts.title,
        TEST_DESC: opts.desc,
        TEST_TAGS: opts.tags,
        TEST_PROJECT: opts.project,
      },
    })
    const called = out.includes('CALLED:')
    return { geminiCalled: called, geminiArgs: out.trim() }
  }

  // Call site 1 (fast path, LOCAL_LLM_AVAILABLE=0): allowed leaf -> Gemini actually invoked.
  it('call site 1 (fast path): allowed leaf really reaches try_gemini_for_leaf', () => {
    const r = runTryLeaf({ fastPath: true, project: 'mikrob', tags: 'BE,NORMAL', title: 'Add CSV export', desc: 'Export the monthly report.' })
    expect(r.geminiCalled).toBe(true)
  })

  // Call site 1: blocked leaf (sensitive tag) -> Gemini must NOT be invoked, end-to-end.
  it('call site 1 (fast path): blocked leaf (SEC tag) never reaches try_gemini_for_leaf', () => {
    const r = runTryLeaf({ fastPath: true, project: 'mikrob', tags: 'SEC,NORMAL', title: 'Add CSV export', desc: 'Export the monthly report.' })
    expect(r.geminiCalled).toBe(false)
  })

  // Call site 1: blocked leaf via CONTENT (desc), no sensitive tag/title -- proves the
  // title/desc arguments actually reach is_gemini_blocked at THIS call site, not just in
  // the standalone is_gemini_blocked unit tests above.
  it('call site 1 (fast path): blocked leaf via description content-gate never reaches try_gemini_for_leaf', () => {
    const r = runTryLeaf({ fastPath: true, project: 'mikrob', tags: 'BE,NORMAL', title: 'Heti audit eredménye', desc: 'Az SSE végpont ?token= query paramétert küld -- biztonsági lelet.' })
    expect(r.geminiCalled).toBe(false)
  })

  // Call site 2 (exhausted attempts): allowed leaf -> Gemini actually invoked.
  it('call site 2 (exhausted attempts): allowed leaf really reaches try_gemini_for_leaf', () => {
    const r = runTryLeaf({ fastPath: false, project: 'mikrob', tags: 'BE,NORMAL', title: 'Add CSV export', desc: 'Export the monthly report.' })
    expect(r.geminiCalled).toBe(true)
  })

  // Call site 2: blocked leaf (wrong project) -> Gemini must NOT be invoked, end-to-end.
  it('call site 2 (exhausted attempts): blocked leaf (non-allowlisted project) never reaches try_gemini_for_leaf', () => {
    const r = runTryLeaf({ fastPath: false, project: 'mopsion', tags: 'BE,NORMAL', title: 'Add CSV export', desc: 'Export the monthly report.' })
    expect(r.geminiCalled).toBe(false)
  })

  // Call site 2: blocked leaf via CONTENT (desc) -- same argument-wiring proof as call site 1.
  it('call site 2 (exhausted attempts): blocked leaf via description content-gate never reaches try_gemini_for_leaf', () => {
    const r = runTryLeaf({ fastPath: false, project: 'mikrob', tags: 'BE,NORMAL', title: 'API endpoint cleanup', desc: 'The auth middleware leaks the JWT token in the response.' })
    expect(r.geminiCalled).toBe(false)
  })

  // RedHat 17567 B3 (card a92e9913 delta-gate NO-GO): the router's categorical-online verdict
  // (local RAG exits 9) must NEVER fall back to Gemini -- F1d exists precisely because the
  // router already classified the leaf as auth/security/multi-file, so sending it to an
  // external API discards that verdict. No targeted test exercised this branch before (the
  // existing 96/96-green suite would stay green even if an unguarded try_gemini_for_leaf call
  // were reintroduced at the bottom of the rc=9 branch). These two cover it, content-gate
  // outcome notwithstanding -- categorical-online bypasses Gemini regardless of content.
  it('categorical-online (RAG rc=9) never reaches try_gemini_for_leaf, even for an allowed-by-content leaf', () => {
    const r = runTryLeaf({ fastPath: false, ragRc: 9, project: 'mikrob', tags: 'BE,NORMAL', title: 'Add CSV export', desc: 'Export the monthly report.' })
    expect(r.geminiCalled).toBe(false)
  })

  it('categorical-online (RAG rc=9) never reaches try_gemini_for_leaf for a sensitive leaf either', () => {
    const r = runTryLeaf({ fastPath: false, ragRc: 9, project: 'mikrob', tags: 'BE,NORMAL', title: 'Auth middleware review', desc: 'Tenant-scoped authorization check.' })
    expect(r.geminiCalled).toBe(false)
  })

  // N2 (RedHat 17653, card e87e7520): the CS3a sub-branch -- rc=9 WITH a non-empty advisory
  // draft that then FAILS draft_quality_ok -- was never exercised by any existing test, because
  // the stub advisory_draft() always returned empty output. A regression that reintroduced an
  // unguarded try_gemini_for_leaf call in this specific sub-branch would stay green forever.
  // These stub advisory_draft() to actually return a draft, and draft_quality_ok() to FAIL it,
  // for both a content-allowed and a content-sensitive leaf -- Gemini must never be reached.
  const CS3A_ADVISORY_STUB = 'advisory_draft() { cat >/dev/null; echo "mock non-empty advisory draft text"; }'
  const CS3A_QUALITY_FAIL_STUB = 'draft_quality_ok() { printf "FAIL\\ttoo short\\n"; }'

  it('CS3a: advisory-draft quality-gate failure never reaches try_gemini_for_leaf, for an allowed-by-content leaf (N2)', () => {
    const r = runTryLeaf({
      fastPath: false, ragRc: 9, project: 'mikrob', tags: 'BE,NORMAL',
      title: 'Add CSV export', desc: 'Export the monthly report.',
      advisoryDraftStub: CS3A_ADVISORY_STUB, qualityGateStub: CS3A_QUALITY_FAIL_STUB,
    })
    expect(r.geminiCalled).toBe(false)
  })

  it('CS3a: advisory-draft quality-gate failure never reaches try_gemini_for_leaf, for a sensitive leaf (N2)', () => {
    const r = runTryLeaf({
      fastPath: false, ragRc: 9, project: 'mikrob', tags: 'BE,NORMAL',
      title: 'Auth middleware review', desc: 'Tenant-scoped authorization check.',
      advisoryDraftStub: CS3A_ADVISORY_STUB, qualityGateStub: CS3A_QUALITY_FAIL_STUB,
    })
    expect(r.geminiCalled).toBe(false)
  })

  // Card 21fbc293, WhiteHat2 F1 (Gate-SHA 8af958a2): the per-card draft loop
  // (gemini-orchestrator-draft.ts) sets OFFLOAD_NO_GEMINI=1 so its invocations of this script
  // stay LOCAL-only (decision B, file sink) even when route=gemini and the flag file is
  // present. Both call sites must honor it -- without it, an otherwise-allowed leaf reaches
  // try_gemini_for_leaf (asserted above), so this is the real fail-closed contrast case.
  it('OFFLOAD_NO_GEMINI=1 blocks call site 1 (fast path) even for an otherwise-allowed leaf', () => {
    const r = runTryLeaf({
      fastPath: true, project: 'mikrob', tags: 'BE,NORMAL',
      title: 'Add CSV export', desc: 'Export the monthly report.',
      offloadNoGemini: true,
    })
    expect(r.geminiCalled).toBe(false)
  })

  it('OFFLOAD_NO_GEMINI=1 blocks call site 2 (exhausted attempts) even for an otherwise-allowed leaf', () => {
    const r = runTryLeaf({
      fastPath: false, project: 'mikrob', tags: 'BE,NORMAL',
      title: 'Add CSV export', desc: 'Export the monthly report.',
      offloadNoGemini: true,
    })
    expect(r.geminiCalled).toBe(false)
  })
})

describe('is_gemini_blocked guard present at every Gemini call site (T1, card a92e9913)', () => {
  // Call site 1: fast-path when LOCAL_LLM_AVAILABLE=0
  it('call site 1 (LOCAL_LLM_AVAILABLE=0): is_gemini_blocked called before try_gemini_for_leaf', () => {
    const codeStr = code(DISPATCH)
    // Anchor: the fast-path block is identified by LOCAL_LLM_AVAILABLE:-1
    const anchorIdx = codeStr.indexOf('LOCAL_LLM_AVAILABLE:-1')
    expect(anchorIdx).toBeGreaterThan(-1)
    // Window: from anchor to the closing "return 1" of that if-block (~300 chars)
    const window = codeStr.slice(anchorIdx, anchorIdx + 500)
    // Guard must appear BEFORE try_gemini_for_leaf in this window
    const guardPos = window.indexOf('is_gemini_blocked')
    const geminiPos = window.indexOf('try_gemini_for_leaf')
    expect(guardPos).toBeGreaterThan(-1)
    expect(geminiPos).toBeGreaterThan(-1)
    expect(guardPos).toBeLessThan(geminiPos)
  })

  // Call site 2: exhausted-attempts fallback.
  // Anchor: the comparison `${n:-0}" -ge "$OFFLOAD_LEAF_MAX_ATTEMPTS"` is unique in executable code.
  it('call site 2 (exhausted attempts): is_gemini_blocked called before try_gemini_for_leaf', () => {
    const codeStr = code(DISPATCH)
    const anchorStr = '${n:-0}" -ge "$OFFLOAD_LEAF_MAX_ATTEMPTS"'
    const anchorIdx = codeStr.indexOf(anchorStr)
    expect(anchorIdx).toBeGreaterThan(-1)
    const window = codeStr.slice(anchorIdx, anchorIdx + 500)
    const guardPos = window.indexOf('is_gemini_blocked')
    const geminiPos = window.indexOf('try_gemini_for_leaf')
    expect(guardPos).toBeGreaterThan(-1)
    expect(geminiPos).toBeGreaterThan(-1)
    expect(guardPos).toBeLessThan(geminiPos)
  })

  // Call site 1: gemini_route_enabled must also be checked before try_gemini_for_leaf
  it('call site 1: gemini_route_enabled checked before try_gemini_for_leaf', () => {
    const codeStr = code(DISPATCH)
    const anchorIdx = codeStr.indexOf('LOCAL_LLM_AVAILABLE:-1')
    const window = codeStr.slice(anchorIdx, anchorIdx + 500)
    const enabledPos = window.indexOf('gemini_route_enabled')
    const geminiPos = window.indexOf('try_gemini_for_leaf')
    expect(enabledPos).toBeGreaterThan(-1)
    expect(enabledPos).toBeLessThan(geminiPos)
  })

  // Call site 2: gemini_route_enabled must also be checked before try_gemini_for_leaf
  it('call site 2: gemini_route_enabled checked before try_gemini_for_leaf', () => {
    const codeStr = code(DISPATCH)
    const anchorStr = '${n:-0}" -ge "$OFFLOAD_LEAF_MAX_ATTEMPTS"'
    const anchorIdx = codeStr.indexOf(anchorStr)
    const window = codeStr.slice(anchorIdx, anchorIdx + 500)
    const enabledPos = window.indexOf('gemini_route_enabled')
    const geminiPos = window.indexOf('try_gemini_for_leaf')
    expect(enabledPos).toBeGreaterThan(-1)
    expect(enabledPos).toBeLessThan(geminiPos)
  })
})

// ── O1: gemini_route_enabled fail-closed switch ──────────────────────────────────────────
describe('gemini_route_enabled() fail-closed switch (O1, card a92e9913)', () => {
  it('gemini_route_enabled function is defined in offload-dispatch.sh', () => {
    expect(src(DISPATCH)).toContain('gemini_route_enabled()')
  })

  it('gemini_route_enabled returns false (disabled) when flag file does not exist', () => {
    const dispatchSrc = src(DISPATCH)
    const fnIdx = dispatchSrc.indexOf('\ngemini_route_enabled()')
    let depth = 0; let end = fnIdx
    for (let i = fnIdx; i < dispatchSrc.length; i++) {
      if (dispatchSrc[i] === '{') depth++
      if (dispatchSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    const fnDef = dispatchSrc.slice(fnIdx, end)
    // Extract HERE from the script (it's set before this function)
    const hereMatch = dispatchSrc.match(/^HERE="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)"$/m)
    const hereSetup = hereMatch ? hereMatch[0] : 'HERE=/nonexistent'
    const result = execFileSync('bash', ['-c',
      `${hereSetup}\n${fnDef}\ngemini_route_enabled && echo ENABLED || echo DISABLED`,
    ], { encoding: 'utf-8' })
    expect(result.trim()).toBe('DISABLED')
  })

  it('flag file reference uses HERE variable (stays in store/)', () => {
    const fnIdx = src(DISPATCH).indexOf('gemini_route_enabled()')
    const fnChunk = src(DISPATCH).slice(fnIdx, fnIdx + 300)
    expect(fnChunk).toContain('gemini-offload-enabled')
    expect(fnChunk).toContain('HERE')
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

// N4 (RedHat 17653, card e87e7520 -> deferred to 15398b82): 6 of the card's 19 named patterns
// (anthropic, aws_secret, twilio, twilio_sid, digitalocean, cloudflare) CANNOT be isolated
// end-to-end via redactInput() -- their realistic value shape structurally also satisfies a
// different, legitimate pattern (e.g. a real AWS secret key literally contains the substring
// "access_key=", which the broader "cred" rule is deliberately built to catch; a real Twilio
// key is 32 hex chars, which "hex32" is deliberately built to catch). This is DEFENSE IN DEPTH,
// not a test gap -- RedHat's own framing for these: "a viselkedes jo a valos alaku tablakon".
// To still satisfy "deleting this pattern tuple flips a test red" for these 6, this helper
// extracts the pattern array by LABEL and tests that ONE regex alone (not the combined
// SECRET_PATTERNS/PII_PATTERNS list) against a value -- so the test is sensitive to deleting
// that exact tuple, independent of sibling-pattern overlap. If the label no longer exists in
// the array (deleted), this returns false.
function patternAloneMatches(label: string, text: string): boolean {
  const callSrc = src(GEMINI_CALL)
  const s1 = callSrc.indexOf('SECRET_PATTERNS = [')
  const e1 = callSrc.indexOf('\nfor pattern, label in SECRET_PATTERNS:')
  const s2 = callSrc.indexOf('PII_PATTERNS = [')
  const e2 = callSrc.indexOf('\nfor pattern, label in PII_PATTERNS:')
  const arrays = callSrc.slice(s1, e1) + '\n' + callSrc.slice(s2, e2)
  const driver = `
import sys, re
target = sys.argv[1]
text = sys.argv[2]
for pattern, lbl in SECRET_PATTERNS + PII_PATTERNS:
    if lbl == target:
        print('1' if re.search(pattern, text, re.DOTALL) else '0')
        sys.exit(0)
print('0')
`
  const code = arrays + '\n' + driver
  const result = execFileSync('python3', ['-c', code, label, text], { encoding: 'utf-8' })
  return result.trim() === '1'
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

  // N4 (RedHat 17653, card e87e7520 -> deferred to 15398b82): the original 'A'.repeat(36)
  // padding is all valid hex digits, so hex32 ALSO matches it -- deleting the 'telegram'
  // pattern alone left this test green (hex32 still caught it). Non-hex padding (g-z, no
  // a-f) isolates it: only 'telegram' matches now.
  it('blocks (exit 2, no output) on Telegram bot token (numeric:alphanum) (N4, isolated from hex32)', () => {
    const tok = '123456789' + ':' + 'ghijklmnopqrstuvwxyzghijklmnopqrstuv'
    const r = redactInput('see this bot id: ' + tok)
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

  // N4 (same source): 'A'.repeat(36) is all valid hex, so hex32 also matched -- deleting
  // 'github' alone left this green. Non-hex padding isolates it.
  it('blocks (exit 2, no output) on GitHub-style token (ghp_) (N4, isolated from hex32)', () => {
    const tok = 'ghp_' + 'ghijklmnopqrstuvwxyzghijklmnopqrstuv'
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

  // RedHat 17510 finding 4: 19 of 39 tested secret shapes were not detected. Extended
  // coverage with provider formats that were previously entirely missing.
  it('blocks (exit 2, no output) on Anthropic API key (sk-ant-)', () => {
    const key = 'sk-ant-api03-' + 'a'.repeat(30)
    const r = redactInput('key: ' + key)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  // N4 (same source): 'a'.repeat(36) is all valid hex, so hex32 also matched -- deleting
  // 'npm' alone left this green. Non-hex padding isolates it.
  it('blocks (exit 2, no output) on npm access token (npm_) (N4, isolated from hex32)', () => {
    const tok = 'npm_' + 'ghijklmnopqrstuvwxyzghijklmnopqrstuv'
    const r = redactInput(tok)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on Docker Hub personal access token (dckr_pat_)', () => {
    const tok = 'dckr_pat_' + 'a'.repeat(22)
    const r = redactInput(tok)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  // N4 (RedHat 17653, card e87e7520 -> deferred to 15398b82): 10 of the card's 19 named
  // patterns had NO dedicated test at all (they were only covered, if at all, by generic
  // text that also matched a different detector). Each value below is constructed to match
  // ONLY its own pattern -- verified against the extracted SECRET_PATTERNS/PII_PATTERNS list
  // before writing these, and each was mutation-tested (delete the pattern tuple -> this
  // exact test goes red; restore -> green).
  it('blocks (exit 2, no output) on a PEM private key header (N4, privkey)', () => {
    // Built via concatenation so the secret-write-guard pre-commit hook does not flag this
    // test file as containing a literal key header (same convention as the Bearer/JWT
    // literals above).
    const r = redactInput('-----BEGIN ' + 'RSA PRIVATE KEY' + '-----')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on an SSH public key fingerprint line (N4, ssh_pubkey)', () => {
    const r = redactInput('ssh-ed25519 ' + 'ghijklmnopqrstuvwxyz'.repeat(3))
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a Google OAuth client id (N4, google_oauth)', () => {
    const id = '123456789012-' + 'ghijklmnopqrstuvwxyzghijklmnopqr' + '.apps.googleusercontent.com'
    const r = redactInput(id)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a SendGrid API key (N4, sendgrid)', () => {
    const key = 'SG.' + 'ghijklmnopqrstuvwxyzgh' + '.' + 'ghijklmnopqrstuvwxyzghijklmnopqrstuvwxyzghi'
    const r = redactInput(key)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a Discord bot token (N4, discord)', () => {
    const tok = 'M' + 'ghijklmnopqrstuvwxyzghij' + '.' + 'ghijkl' + '.' + 'ghijklmnopqrstuvwxyzghijklm'
    const r = redactInput(tok)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on an Azure AccountKey, not at line-start (N4, azure)', () => {
    const r = redactInput('see this: AccountKey=' + 'ghijklmnopqrstuvwxyzghijklmnopqrstuvwxyz==')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a Hungarian TAJ number (N4, hu_taj)', () => {
    const r = redactInput('taj: 123 456 789')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a credit-card-shaped number (N4, cc_number)', () => {
    const r = redactInput('4111 1111 1111 1111')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a bare sk- prefixed generic key (N4, sk_generic)', () => {
    const r = redactInput('sk-' + 'ghijklmnopqrstuvwxyzghijk')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a context-free high-entropy token with a "+" (N4, opaque_token, isolated from opaque_b64url)', () => {
    const r = redactInput('G1h2I3j4K5l6M7n8O9p0Q1r2S3t4U5v6+7x8Y9z0A1')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on AWS secret access key assignment', () => {
    const line = 'aws_secret_access_key=' + 'A'.repeat(40)
    const r = redactInput(line)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  // N4 (same source): the remaining 6 of the 19 named patterns -- anthropic, aws_secret,
  // twilio, twilio_sid, digitalocean, cloudflare -- cannot be isolated end-to-end (see the
  // patternAloneMatches() comment above for why: their realistic value shape structurally
  // also satisfies sk_generic/cred/hex32). These assert the pattern's OWN regex, by label,
  // against a realistic value -- mutation-proof regardless of sibling overlap. A negative
  // control (a clean string) confirms the helper itself isn't vacuously true.
  it('patternAloneMatches returns false for a clean string (helper negative control)', () => {
    expect(patternAloneMatches('anthropic', 'nothing sensitive here')).toBe(false)
  })

  it('"anthropic" pattern alone matches a real-shaped Anthropic key (N4, equivalent-mutant w.r.t. sk_generic)', () => {
    expect(patternAloneMatches('anthropic', 'sk-ant-api03-' + 'a'.repeat(30))).toBe(true)
  })

  it('"aws_secret" pattern alone matches a real-shaped AWS secret key assignment (N4, equivalent-mutant w.r.t. cred)', () => {
    expect(patternAloneMatches('aws_secret', 'aws_secret_access_key=' + 'A'.repeat(40))).toBe(true)
  })

  it('"twilio" pattern alone matches a real-shaped Twilio key (N4, equivalent-mutant w.r.t. hex32)', () => {
    expect(patternAloneMatches('twilio', 'SK' + 'a'.repeat(32))).toBe(true)
  })

  it('"twilio_sid" pattern alone matches a real-shaped Twilio SID (N4, equivalent-mutant w.r.t. hex32)', () => {
    expect(patternAloneMatches('twilio_sid', 'AC' + 'a'.repeat(32))).toBe(true)
  })

  it('"digitalocean" pattern alone matches a real-shaped DigitalOcean token (N4, equivalent-mutant w.r.t. hex32)', () => {
    expect(patternAloneMatches('digitalocean', 'dop_v1_' + 'a'.repeat(64))).toBe(true)
  })

  it('"cloudflare" pattern alone matches a real-shaped Cloudflare token (N4, equivalent-mutant w.r.t. cred)', () => {
    expect(patternAloneMatches('cloudflare', 'cloudflare_token=' + 'a'.repeat(30))).toBe(true)
  })

  it('blocks (exit 2, no output) on uppercase/mixed-case long hex (hex32 widened to mixed case)', () => {
    const hex = 'AbCdEf0123456789'.repeat(3)
    const r = redactInput('hash: ' + hex)
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  // PII DECISION (RedHat 17510 finding 4: "the PII decision is missing"). Explicit scope:
  // email, Hungarian phone number, Hungarian tax number -- same fail-closed response as a
  // secret (exit 2, nothing sent).
  it('blocks (exit 2, no output) on an email address (PII)', () => {
    const r = redactInput('contact the user at john.doe@example.com for details')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a Hungarian phone number (PII)', () => {
    const r = redactInput('call them at +36 20 123 4567')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a Hungarian tax number / adószám (PII)', () => {
    const r = redactInput('adoszam: 12345678-1-02')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  // WhiteHat2 H3 (card 40d2a253, non-blocking GO finding on a92e9913): three secret shapes
  // still reached Gemini through the old "cred"/"bearer" patterns.
  it('blocks (exit 2, no output) on JSON-style "apiKey": "..." (WhiteHat2 H3)', () => {
    const r = redactInput('{"apiKey": "AbCdEf1234567890"}')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a short Bearer token (WhiteHat2 H3)', () => {
    const r = redactInput('Authorization: Bearer ab12cd')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a quoted credential value containing spaces (WhiteHat2 H3)', () => {
    const r = redactInput('secret: "my secret value here"')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  // M1 (WhiteHat2 H3 remainder, card e87e7520): \b treats "_" as a word character, so \bsecret
  // never matched the "secret" inside an underscore-glued key name like APP_SECRET or
  // auth_token (no boundary between "_" and the next letter). Fixed with a negative lookbehind
  // excluding only letters/digits.
  it('blocks (exit 2, no output) on an underscore-prefixed secret key (WhiteHat2 H3 / M1)', () => {
    const r = redactInput('APP_SECRET="a b c d e f g h"')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on an underscore-prefixed token key (WhiteHat2 H3 / M1)', () => {
    const r = redactInput("auth_token = 'x y z 1 2 3 4 5'")
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('still allows a clean word that merely contains "secret" as a mid-word substring (no over-blocking, M1)', () => {
    const r = redactInput('the ultrasecretrecipe card title mentions nothing sensitive here')
    expect(r.exitCode).toBe(0)
  })

  // F3 (WhiteHat NO-GO, komment 17848, card e87e7520): the "cred" pattern's lookbehind did not
  // recognize a camelCase key-name boundary (lowercase-then-uppercase transition), so
  // apiToken:/dbPassword: style keys let their values through unredacted.
  it('blocks (exit 2, no output) on a camelCase "apiToken:" key (F3)', () => {
    const r = redactInput('apiToken: ' + 'A'.repeat(16))
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a camelCase "dbPassword:" key (F3)', () => {
    const r = redactInput('dbPassword: ' + 'B'.repeat(16))
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  // F1 (WhiteHat NO-GO, komment 17848, card e87e7520): layer 1 (is_gemini_blocked) normalized
  // title/desc, but this layer (the actual outbound-prompt scanner) did not -- an obfuscated
  // KEY NAME let the real VALUE through, because the keyword alternation never matched the
  // obfuscated spelling. Fullwidth "token" (compat chars -> plain ASCII under NFKD) in front of
  // a real-looking value must now block.
  it('blocks (exit 2, no output) on a fullwidth-obfuscated key name with a real value (F1)', () => {
    const r = redactInput('ｔｏｋｅｎ: ' + 'C'.repeat(16))
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a Cyrillic-homoglyph-obfuscated key name with a real value (F1)', () => {
    // "ѕеcrеt" -- Cyrillic ѕ/е in place of Latin s/e, Latin c/r/t unchanged.
    const r = redactInput('ѕеcrеt: ' + 'D'.repeat(16))
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  // F2 (same komment): the outbound-prompt scanner must also fail-closed on an unmapped
  // non-ASCII letter (a script/homoglyph the table doesn't cover), same as layer 1.
  it('blocks (exit 2, no output) on an unmapped (non-table) homoglyph letter anywhere in the prompt (F2)', () => {
    // Greek small iota (U+03B9), not in the homoglyph table.
    const r = redactInput('a note about prιvacy settings, nothing else')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('still allows genuine Hungarian accented prose with no secret/PII shape (F2, no over-blocking)', () => {
    const r = redactInput('Frissítsd a riportok oszlopait a hónap végén.')
    expect(r.exitCode).toBe(0)
  })

  // N5 (RedHat 17653, card e87e7520): 9 secret/PII shapes that reached Gemini unblocked.
  it('blocks (exit 2, no output) on an AWS ASIA temporary-credential key id (N5)', () => {
    const r = redactInput('ASIA' + 'Q'.repeat(16))
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a Google OAuth refresh token (N5)', () => {
    const r = redactInput('1//0' + 'a'.repeat(25))
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a Cookie: session= header (N5)', () => {
    const r = redactInput('Cookie: sessionid=abcdef1234567890')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a Stripe whsec_ webhook secret (N5)', () => {
    const r = redactInput('whsec_' + 'a'.repeat(20))
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a context-free base64url high-entropy token (N5)', () => {
    // Underscores break up any 32+ run of pure hex chars, so this is caught by the NEW
    // opaque_b64url pattern specifically, not by the pre-existing hex32 pattern.
    const r = redactInput('ab1C_de2D_fg3E_hi4F_jk5G_lm6H_no7I_pq8J_')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on prose "the token is <value>" (N5)', () => {
    const r = redactInput('the token is AbCdEf123456')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on prose "the password for the box is <value>" (N5)', () => {
    const r = redactInput('the password for the box is Sup3rSecr3t')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a space-formatted Hungarian phone number with parens (N5)', () => {
    const r = redactInput('call them at +36 (30) 123-4567')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('blocks (exit 2, no output) on a bare/unlabeled IBAN (N5)', () => {
    const r = redactInput('HU42117730161111101800000000')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  it('passes through (exit 0, output intact) normal non-secret text', () => {
    const text = 'fix the bug in the payment service'
    const r = redactInput(text)
    expect(r.exitCode).toBe(0)
    expect(r.output.trim()).toBe(text)
  })

  // C1 (WhiteHat2 GO 17900, card e87e7520 -> deferred to 33047d3f): an ASCII control byte
  // spliced into the "cred" pattern's keyword itself (inside "token", not just before it --
  // a char right before an already-alnum-adjacent keyword can accidentally satisfy the
  // boundary lookbehind instead of breaking the match) is already ascii and survived _fold()
  // untouched, splitting the literal keyword text the alternation needs to match.
  it('blocks (exit 2, no output) when a DEL control char splits the "token" keyword itself (C1)', () => {
    const r = redactInput('tok\x7Fen: ' + 'abcdefgh12345678')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })
  it('blocks (exit 2, no output) when a US control char splits the "password" keyword itself (C1)', () => {
    const r = redactInput('pass\x1Fword: ' + '"my secret value"')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })

  // C2 (WhiteHat2 GO 17900, card e87e7520 -> deferred to 33047d3f): U+2028 (LINE SEPARATOR)
  // and U+2800 (BRAILLE PATTERN BLANK) are invisible but neither decomposes under NFKD nor
  // falls into the Mn/Cf categories _fold() stripped before this fix, so either one spliced
  // into a keyword broke the SECRET_PATTERNS alternation the same way a control char did.
  it('blocks (exit 2, no output) when U+2028 (LINE SEPARATOR) splits the "token" keyword (C2)', () => {
    const r = redactInput('tok en: ' + 'abcdefgh12345678')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
  })
  it('blocks (exit 2, no output) when U+2800 (BRAILLE PATTERN BLANK) splits the "token" keyword (C2)', () => {
    const r = redactInput('tok⠀en: ' + 'abcdefgh12345678')
    expect(r.exitCode).toBe(2)
    expect(r.output).toBe('')
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

// ── 11. Card c8a6e1da: Unicode separators (F1) + remaining 25 probe shapes (F2) ───────────
// Regression corpus is the literal probe list RedHat (b3ce0a88 komment 18336, 35 shapes, 22
// left open after e45945a2) and WhiteHat (b3ce0a88 komment 18322, 9 shapes, 3 left open after
// e45945a2) wrote out -- the 25 that remained ALLOWED after e45945a2's tokenize-on-any-
// non-alnum fix. e45945a2's own 13-shape closure (comma/hyphen/space-inside-a-bracket forms) is
// covered by the earlier N5(c) describe block above and is NOT repeated here.
describe('card c8a6e1da F1: non-ASCII separator between a blocked tag word and trailing text', () => {
  const unicodeSeparators: Array<[string, string]> = [
    ['em dash U+2014', '—'],
    ['en dash U+2013', '–'],
    ['non-breaking hyphen U+2010', '‐'],
    ['figure dash U+2011', '‑'],
    ['minus sign U+2212', '−'],
    ['middle dot U+00B7', '·'],
    ['bullet U+2022', '•'],
    ['ideographic comma U+3001', '、'],
    ['rightwards arrow U+2192', '→'],
    ['division slash U+2215', '∕'],
    ['zero-width space U+200B', '​'],
    ['zero-width joiner U+200D', '‍'],
  ]
  it.each(unicodeSeparators)('blocks "[SEC<sep>x]" with a %s separator', (_label, sep) => {
    expect(runIsGeminiBlocked('mikrob', 'BE', `Valami [SEC${sep}x] cim`)).toBe('BLOCKED')
  })
  it('blocks a non-hyphen BLOKKOLT suffix joined by an em dash', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE', 'Valami [BLOKKOLT—Peti] cim')).toBe('BLOCKED')
  })
})

describe('card c8a6e1da F2: RedHat 22 + WhiteHat 3 remaining open probe shapes', () => {
  const redHat22: Array<[string, string]> = [
    ['bare "SEC : x"', 'SEC : x'],
    ['bare "BLOKKOLT-Peti: x"', 'BLOKKOLT-Peti: x'],
    ['bare "SEC x"', 'SEC x'],
    ['bare "x SEC"', 'x SEC'],
    ['bare "SEC"', 'SEC'],
    ['bare "SEC | x"', 'SEC | x'],
    ['bare "SEC - x"', 'SEC - x'],
    ['bare "-SEC- x"', '-SEC- x'],
    ['bare "_SEC_ x"', '_SEC_ x'],
    ['angle-bracket "<SEC> x"', '<SEC> x'],
    ['fullwidth angle bracket "＜SEC＞ x"', '＜SEC＞ x'],
    ['pipe "|SEC| x"', '|SEC| x'],
    ['slash "/SEC/ x"', '/SEC/ x'],
    ['asterisk "*SEC* x"', '*SEC* x'],
    ['hash "#SEC x"', '#SEC x'],
    ['double quote \'"SEC" x\'', '"SEC" x'],
    ["single quote \"'SEC' x\"", "'SEC' x"],
    ['tilde "~SEC~ x"', '~SEC~ x'],
    ['split "[S E C] x"', '[S E C] x'],
    ['split "[S.E.C] x"', '[S.E.C] x'],
    ['split "[S-E-C] x"', '[S-E-C] x'],
  ]
  it.each(redHat22)('blocks RedHat open shape: %s', (_label, title) => {
    expect(runIsGeminiBlocked('mikrob', 'BE', title)).toBe('BLOCKED')
  })

  const whiteHat3: Array<[string, string]> = [
    ['split "[S EC]"', '[S EC]'],
    ['split "[S.E.C]" (bracketed)', '[S.E.C]'],
    ['digit suffix "[SEC2]"', '[SEC2]'],
  ]
  it.each(whiteHat3)('blocks WhiteHat open shape: %s', (_label, title) => {
    expect(runIsGeminiBlocked('mikrob', 'BE', title)).toBe('BLOCKED')
  })

  // Backtick triggers bash command substitution inside runIsGeminiBlocked's inline -c script
  // (a test-harness quoting limit, not a production one) -- runIsGeminiBlockedRaw passes it as
  // a real argv element instead, which is what the production call path (printf | python3)
  // already does for title/desc.
  it('blocks backtick delimiter "`SEC` x" (argv form, avoids bash command substitution in the harness)', () => {
    expect(runIsGeminiBlockedRaw('mikrob', 'BE', '`SEC` x', '')).toBe('BLOCKED')
  })

  it('digit-suffix also closes BLOKKOLT2 and MOPSION2', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE', '[BLOKKOLT2] x')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BE', '[MOPSION2] x')).toBe('BLOCKED')
  })
})

describe('card c8a6e1da: negative controls (no new over-blocking)', () => {
  // M2 (RedHat NO-GO 2. kor, komment 18638): the digit-precedes-"sec" exception this test used
  // to pin was REMOVED -- RedHat measured it has 0 live-board impact (3181 cards) and that it
  // was simultaneously exempting "1 SEC x"/"3 BLOKKOLT-Peti x"/"7 MOPSION x" (mandatory to
  // close), so both now correctly BLOCK rather than ALLOW. This intentionally narrows what used
  // to be an accepted "N sec" idiom exemption; see the REVIEW on card 09117e0a for the decision.
  it('now blocks the former "N sec" exemption too, since the exception shielded blokkolt/mopsion the same way (M2)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE', 'Fix the ui, wait 5 sec')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BE', 'Retry after 10 sec delay')).toBe('BLOCKED')
  })

  it('still does not over-block substring matches inside brackets (e45945a2 parity)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE', '[Resection of X] title')).toBe('ALLOWED')
  })

  it('does not block ordinary short-word prose that is not a split tag', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE', 'Sector map')).toBe('ALLOWED')
    expect(runIsGeminiBlocked('mikrob', 'BE', 'Seconds')).toBe('ALLOWED')
    expect(runIsGeminiBlocked('mikrob', 'BE', 'Secondary')).toBe('ALLOWED')
    expect(runIsGeminiBlocked('mikrob', 'BE', 'Sect')).toBe('ALLOWED')
    expect(runIsGeminiBlocked('mikrob', 'BE', 'A clean benign title about nothing sensitive')).toBe('ALLOWED')
  })
})

// ── 12. F3: mutation coverage for the 3 previously-green probe gaps ──────────────────────
// WhiteHat (b3ce0a88 komment 18322) measured 3 mutants that stayed green at 194/194 before this
// card: comma/hyphen/space-only separator, first-token-only inspection, and digit-as-separator.
// These tests exist to KILL those specific mutants, not to re-prove the already-covered shapes.
describe('card c8a6e1da F3: kill the 3 previously-green mutants', () => {
  it('kills "only comma/hyphen/space are separators" (an exotic Unicode separator alone must still block)', () => {
    // If someone narrowed tag_tokens_of() back to ASCII-only separators, this would go ALLOWED.
    expect(runIsGeminiBlocked('mikrob', 'BE', 'Valami [SEC•x] cim')).toBe('BLOCKED')
  })

  it('kills "only the FIRST token in a segment is checked" (the blocked word as the LAST token)', () => {
    // If someone only checked tag_tokens[0], "x SEC" (SEC last) would go ALLOWED.
    expect(runIsGeminiBlocked('mikrob', 'BE', 'x SEC')).toBe('BLOCKED')
  })

  it('kills "a digit always separates tokens" (digit-suffix must still require exact stripped match)', () => {
    // If someone stripped trailing digits unconditionally without checking membership, this
    // would ALSO block e.g. "x9" -- assert the suffix-strip path is exact-match-gated, not blanket.
    expect(runIsGeminiBlocked('mikrob', 'BE', '[SEC2] x')).toBe('BLOCKED')
    expect(runIsGeminiBlocked('mikrob', 'BE', '[x9] harmless')).toBe('ALLOWED')
  })
})

// ── 13. Card 09117e0a/c8a6e1da: RedHat's 2nd NO-GO delta (komment 18638) ─────────────────
// M1: the LABEL side of the per-tag loop had no test independent of the title-side whole-title
// loop's own redundant coverage -- a "first token only" regression there would have stayed green
// forever. M2: the blanket digit-precedes-word exception is now REMOVED (see the updated
// negative-control test above). M3: the split-letter join is now a sliding window with no
// per-token length guard.
describe('card c8a6e1da M1 (RedHat NO-GO 2. kor): pin the tag-cycle "first token only" mutant on the LABEL side', () => {
  it('blocks a LABEL "x SEC" (SEC as the LAST token of the label, not the title)', () => {
    // The title-side whole-title loop would ALSO catch a title "x SEC" even under the MB mutant
    // (first-token-only on the per-tag loop), masking a regression there. Passing this as a
    // LABEL (tags_csv) exercises ONLY the per-tag loop's any(), with nothing else to fall back on.
    expect(runIsGeminiBlocked('mikrob', 'x SEC', '')).toBe('BLOCKED')
  })

  it('blocks a LABEL "x-SEC" (SEC as the LAST token, hyphen delimiter)', () => {
    expect(runIsGeminiBlocked('mikrob', 'x-SEC', '')).toBe('BLOCKED')
  })

  it('blocks title "[5 SEC] y" (SEC as the LAST token inside the bracket segment)', () => {
    // The whole-title loop's digit-precedes-word carve-out was removed (M2), but this still
    // independently proves the per-TAG loop (which the bracket-extracted "5 SEC" segment also
    // goes through) checks every token, not just the first.
    expect(runIsGeminiBlocked('mikrob', 'BE', '[5 SEC] y')).toBe('BLOCKED')
  })

  it('blocks title "[5,SEC] y" (SEC as the LAST token, comma delimiter)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE', '[5,SEC] y')).toBe('BLOCKED')
  })
})

describe('card c8a6e1da M2 (RedHat NO-GO 2. kor): the digit-precedes-word exception no longer shields blokkolt/mopsion', () => {
  const noLongerExempt: Array<[string, string]> = [
    ['"1 SEC x"', '1 SEC x'],
    ['"2. SEC cleanup"', '2. SEC cleanup'],
    ['"3 BLOKKOLT-Peti x"', '3 BLOKKOLT-Peti x'],
    ['"7 MOPSION x"', '7 MOPSION x'],
  ]
  it.each(noLongerExempt)('blocks %s (previously exempted by the digit-precedes carve-out)', (_label, title) => {
    expect(runIsGeminiBlocked('mikrob', 'BE', title)).toBe('BLOCKED')
  })

  it('blocks "2 [SEC<ZWSP>x]" (digit before a bracketed, zero-width-split tag)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE', '2 [SEC​x]')).toBe('BLOCKED')
  })
})

describe('card c8a6e1da M3 (RedHat NO-GO 2. kor): split-letter sliding window, no per-token length guard', () => {
  const uneven: Array<[string, string]> = [
    ['"[MOP SION]" (uneven split, "sion" is 4 chars)', '[MOP SION] x'],
    ['"[SUPER ADMIN]" (uneven split)', '[SUPER ADMIN] x'],
    ['"[S ECURITY]" (uneven split)', '[S ECURITY] x'],
    ['"[PEN ZUGY]" (uneven split)', '[PEN ZUGY] x'],
    ['"[CLEAN CORE]" (uneven split)', '[CLEAN CORE] x'],
    ['"[BLOK KOLT]" (uneven split)', '[BLOK KOLT] x'],
    ['label "MOP SION" (bare, no brackets)', ''],
  ]
  it.each(uneven)('blocks %s', (_label, title) => {
    const tagsArg = title === '' ? 'MOP SION' : 'BE'
    expect(runIsGeminiBlocked('mikrob', tagsArg, title)).toBe('BLOCKED')
  })

  const leadingTrailingToken: Array<[string, string]> = [
    ['"[x S E C]" (leading non-blocked token)', '[x S E C] y'],
    ['"[Foo S E C]" (leading non-blocked token)', '[Foo S E C] y'],
    ['"[S E C hardening]" (trailing long word)', '[S E C hardening] y'],
    ['"[S E C-hardening]" (trailing long word, hyphen)', '[S E C-hardening] y'],
  ]
  it.each(leadingTrailingToken)('blocks %s', (_label, title) => {
    expect(runIsGeminiBlocked('mikrob', 'BE', title)).toBe('BLOCKED')
  })

  const digitSuffixOnJoin: Array<[string, string]> = [
    ['"[S E C 2]" (digit as its own token)', '[S E C 2] y'],
    ['"[S E C2]" (digit fused onto the last letter)', '[S E C2] y'],
  ]
  it.each(digitSuffixOnJoin)('blocks %s', (_label, title) => {
    expect(runIsGeminiBlocked('mikrob', 'BE', title)).toBe('BLOCKED')
  })

  it('still does not over-block "[Resection of X]" (e45945a2 parity, no per-token length guard needed)', () => {
    expect(runIsGeminiBlocked('mikrob', 'BE', '[Resection of X] title')).toBe('ALLOWED')
  })

  it('MJ mutation check: the join must be EXACT, not a substring -- "[sec urity]" over-joining risk', () => {
    // Sanity: "sec"+"urity" joins to "security", which IS a real blocked word (correctly BLOCKED,
    // not a false positive) -- this documents the join is exact-equality, not substring search.
    expect(runIsGeminiBlocked('mikrob', 'BE', '[sec urity] y')).toBe('BLOCKED')
  })
})

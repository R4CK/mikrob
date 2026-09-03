import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Card 934dc104. Two separate defects, both about the gate being unable to state its own
// posture, and both now pinned here because neither was covered before:
//
//  1. WHERE the rules file is looked up used to be resolved relative to THIS SCRIPT. The
//     fleet has one script copy per agent worktree but exactly ONE rules file (main clone,
//     gitignored + 0600, so it never travels). Same gate, opposite posture, decided by the
//     caller: silent pass from the main root, fail-closed email from every worktree, on a
//     config that checkout could never receive.
//  2. The THREE loader states collapsed into TWO branches. load_bad_name() already told
//     MISSING apart from DELIBERATELY-EMPTY (the card-3ec64c96 sentinel), but every call
//     site asks `is None`, so a zero-pattern name filter was byte-for-byte as quiet as a
//     working one.
//
// Both call points (email + telegram) are asserted for every state, because they have
// DIFFERENT postures by design (email fail-closed, telegram fail-open + systemMessage) and
// a test that only covers one would let the other drift.

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')

let TMP: string

beforeAll(() => { TMP = mkdtempSync(join(tmpdir(), 'copygate-')) })
afterAll(() => { rmSync(TMP, { recursive: true, force: true }) })

/** Call the PURE resolver with synthetic dirs. The env is pinned to an isolated path so the
 *  module-level load at import touches the temp dir, never the real store/. */
function resolve(scriptDir: string, envValue: string | null): string {
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
env = sys.argv[2] or None
print(json.dumps(g.resolve_rules_path(sys.argv[1], env)))
`
  const r = spawnSync('python3', ['-c', code, scriptDir, envValue ?? ''], {
    encoding: 'utf-8',
    env: { ...process.env, OUTGOING_COPY_GATE_RULES: join(TMP, 'isolated-import.json') },
  })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout.trim())
}

/** Run the gate as the hook actually runs it: a payload on stdin, exit code back. */
function runGate(payload: unknown, rulesPath: string) {
  const r = spawnSync('python3', [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, OUTGOING_COPY_GATE_RULES: rulesPath },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

// The email call point is only reached for a command the gate CLASSIFIES as a send, so the
// fixture has to be a real send shape (that classification is pinned by its own test file).
const SENDER = ['python3', '/x/scripts/' + 'send' + '.py', '--' + 'to', 'a@b.hu', '--body'].join(' ')
const emailSend = (body: string) => ({
  tool_name: 'Bash',
  tool_input: { command: `${SENDER} ${JSON.stringify(body)}` },
})
const telegramReply = (text: string) => ({
  tool_name: 'mcp__plugin_telegram_telegram__reply',
  tool_input: { chat_id: '0', text },
})

/** Build a fake main clone + a fake worktree pointing at it, exactly as git lays them out. */
function makeTree(name: string, opts: { mainHasRules: boolean; worktreeHasRules: boolean }) {
  const base = join(TMP, name)
  const main = join(base, 'main')
  const wt = join(base, 'wt')
  mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true })
  mkdirSync(join(main, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(main, 'store'), { recursive: true })
  mkdirSync(join(wt, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(wt, 'store'), { recursive: true })
  // A worktree's `.git` is a FILE holding the pointer, which is the whole basis of the fix.
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`)
  const rules = JSON.stringify({ bad_name_patterns: [] })
  if (opts.mainHasRules) writeFileSync(join(main, 'store', 'outgoing-copy-gate-rules.json'), rules)
  if (opts.worktreeHasRules) writeFileSync(join(wt, 'store', 'outgoing-copy-gate-rules.json'), rules)
  return { main, wt }
}

describe('rules-file lookup is checkout-independent (card 934dc104)', () => {
  it("a WORKTREE with no rules file of its own reads the MAIN clone's -- the whole defect", () => {
    const { main, wt } = makeTree('wt-falls-back', { mainHasRules: true, worktreeHasRules: false })
    expect(resolve(join(wt, 'scripts', 'hooks'), null))
      .toBe(join(main, 'store', 'outgoing-copy-gate-rules.json'))
  })

  it('the MAIN clone still reads its own file (nothing that worked today changes)', () => {
    const { main } = makeTree('main-unchanged', { mainHasRules: true, worktreeHasRules: false })
    expect(resolve(join(main, 'scripts', 'hooks'), null))
      .toBe(join(main, 'store', 'outgoing-copy-gate-rules.json'))
  })

  it('a checkout that HAS its own file keeps it -- per-checkout override survives', () => {
    const { wt } = makeTree('wt-own-file', { mainHasRules: true, worktreeHasRules: true })
    expect(resolve(join(wt, 'scripts', 'hooks'), null))
      .toBe(join(wt, 'store', 'outgoing-copy-gate-rules.json'))
  })

  it('with no file anywhere the error still names THIS checkout, not a phantom path', () => {
    const { wt } = makeTree('no-file', { mainHasRules: false, worktreeHasRules: false })
    expect(resolve(join(wt, 'scripts', 'hooks'), null))
      .toBe(join(wt, 'store', 'outgoing-copy-gate-rules.json'))
  })

  it('OUTGOING_COPY_GATE_RULES still wins over both', () => {
    const { wt } = makeTree('env-wins', { mainHasRules: true, worktreeHasRules: true })
    expect(resolve(join(wt, 'scripts', 'hooks'), '/somewhere/else.json')).toBe('/somewhere/else.json')
  })

  it('a NON-worktree checkout (.git is a directory) is not redirected anywhere', () => {
    // Negative control: the redirect must trigger on the worktree pointer, not on "the file
    // is missing" -- otherwise a plain clone would start reading a stranger's config.
    const base = join(TMP, 'plain-clone')
    mkdirSync(join(base, '.git'), { recursive: true })
    mkdirSync(join(base, 'scripts', 'hooks'), { recursive: true })
    expect(resolve(join(base, 'scripts', 'hooks'), null))
      .toBe(join(base, 'store', 'outgoing-copy-gate-rules.json'))
  })
})

describe('the three loader states are distinct at BOTH call points (card 934dc104)', () => {
  const missing = () => join(TMP, 'does-not-exist.json')

  function rulesFile(name: string, content: unknown): string {
    const p = join(TMP, name)
    writeFileSync(p, JSON.stringify(content))
    return p
  }

  it('MISSING: email is fail-CLOSED, telegram is fail-OPEN with a systemMessage', () => {
    const r = runGate(emailSend('Kedves Ugyfel, itt a kulcs.'), missing())
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('NEV-SZABALY fajl hianyzik')

    const t = runGate(telegramReply('Kész a feladat.'), missing())
    expect(t.code).toBe(0)
    expect(JSON.parse(t.stdout).systemMessage).toContain('hianyzik')
  })

  it('MALFORMED (bad_name_patterns key absent) is BROKEN, not "zero patterns"', () => {
    // The wrong SHAPE is someone writing the file wrong, not a decision to have no patterns.
    const p = rulesFile('malformed.json', { correction: 'x' })
    expect(runGate(emailSend('Kedves Ugyfel, itt a kulcs.'), p).code).toBe(2)
  })

  it('EMPTY-BUT-VALID: neither call point blocks, and neither claims the file is missing', () => {
    // The state the live install is actually in. It must NOT look like MISSING (that was the
    // fail-closed worktree bug) and must NOT look like a healthy filter either.
    const p = rulesFile('empty.json', { bad_name_patterns: [] })
    const r = runGate(emailSend('Kedves Ugyfel, itt a kulcs.'), p)
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain('NEV-SZABALY')

    const t = runGate(telegramReply('Kész a feladat.'), p)
    expect(t.code).toBe(0)
    expect(t.stdout.trim()).toBe('')
  })

  it('EMPTY-BUT-VALID leaves a rate-limited log line -- an inert filter is not silent', () => {
    const dir = mkdtempSync(join(TMP, 'emptylog-'))
    const p = join(dir, 'outgoing-copy-gate-rules.json')
    writeFileSync(p, JSON.stringify({ bad_name_patterns: [] }))
    runGate(telegramReply('Kész.'), p)
    const code = `
import importlib.util, io, json, os, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
log = os.path.join(os.path.dirname(sys.argv[1]), "outgoing-copy-gate.log")
text = io.open(log, encoding="utf-8").read() if os.path.exists(log) else ""
# the second call inside the window must NOT append again
print(json.dumps({"logged": "SZANDEKOSAN URES" in text, "again": g._log_empty_rules()}))
`
    const r = spawnSync('python3', ['-c', code, p], {
      encoding: 'utf-8', env: { ...process.env, OUTGOING_COPY_GATE_RULES: p },
    })
    if (r.status !== 0) throw new Error(r.stderr)
    const out = JSON.parse(r.stdout.trim())
    expect(out.logged).toBe(true)
    expect(out.again).toBe(false)
  })

  it('ACTIVE: a configured pattern actually blocks, on both call points', () => {
    // Negative control for the whole card: if this passed while EMPTY also passed silently,
    // the "empty is inert" assertion above would be vacuous.
    const p = rulesFile('active.json', {
      bad_name_patterns: ['Kovacs Bela'],
      correction: 'Helyesen: Kovács Béla.',
    })
    const r = runGate(emailSend('Kedves Kovacs Bela, itt a kulcs.'), p)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('HELYTELEN NEV')

    const t = runGate(telegramReply('Szia Kovacs Bela, kész.'), p)
    expect(t.code).toBe(2)
    expect(t.stderr).toContain('HELYTELEN NEV')
  })
})

describe('--status answers the question the card was opened about', () => {
  it('names the resolved file and the state, and never prints a pattern', () => {
    const p = join(TMP, 'status-active.json')
    writeFileSync(p, JSON.stringify({ bad_name_patterns: ['Kovacs Bela'], correction: 'x' }))
    const r = spawnSync('python3', [GATE, '--status'], {
      encoding: 'utf-8', env: { ...process.env, OUTGOING_COPY_GATE_RULES: p },
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(p)
    expect(r.stdout).toContain('ACTIVE')
    // The file is 0600 and names a private person: the readout may COUNT patterns, never show them.
    expect(r.stdout).not.toContain('Kovacs Bela')
  })

  it('reports EMPTY distinctly from BROKEN', () => {
    const empty = join(TMP, 'status-empty.json')
    writeFileSync(empty, JSON.stringify({ bad_name_patterns: [] }))
    const e = spawnSync('python3', [GATE, '--status'], {
      encoding: 'utf-8', env: { ...process.env, OUTGOING_COPY_GATE_RULES: empty },
    })
    expect(e.stdout).toContain('EMPTY')

    const b = spawnSync('python3', [GATE, '--status'], {
      encoding: 'utf-8', env: { ...process.env, OUTGOING_COPY_GATE_RULES: join(TMP, 'nope.json') },
    })
    expect(b.stdout).toContain('BROKEN')
  })
})

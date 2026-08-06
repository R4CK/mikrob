// weekly-usage-relogin.sh must never take the OAuth code from argv (card e5411be1).
//
// argv is world-readable via /proc/<pid>/cmdline for the life of the process, and the shell records
// it in history -- so `--paste <code>` briefly published a live one-time OAuth code to every local
// user. LOW severity (single-use, short TTL, rare manual step) but the same class as the
// token-in-argv finding, so it is closed for consistency.
//
// Every case below is reachable WITHOUT tmux: the script resolves the code before it touches a pane,
// so these assertions exercise the real intake path rather than a mocked one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'store',
  'weekly-usage-relogin.sh',
)

/**
 * Run the script; never throws -- returns the exit code and merged output.
 *
 * USAGE_PROBE_PANE is pinned to a name that cannot exist, so the script's tmux branch always reports
 * "panel gone" instead of reaching a real session. This is not cosmetic: the first version of this
 * file omitted it, the live `mikrob-usage-probe` pane was present, and the fixture code was pasted
 * straight into Peti's logged-in Claude session. A test must never be able to touch production state.
 */
function run(args: string[], stdin?: string): { code: number; out: string } {
  const env = { ...process.env, USAGE_PROBE_PANE: 'relogin-test-pane-does-not-exist' }
  try {
    const out = execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      ...(stdin === undefined ? {} : { input: stdin }),
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relogin-code-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the code is never accepted from argv', () => {
  it('REFUSES --paste <code> outright, and says why', () => {
    const r = run(['--paste', 'abc123-oauth-code'])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/must NOT be passed as an argument/i)
    expect(r.out).toMatch(/proc\/<pid>\/cmdline/)
  })

  it('the refusal tells the caller the SAFE form (an error with no way forward is a trap)', () => {
    const r = run(['--paste', 'abc123'])
    expect(r.out).toMatch(/--paste-file|stdin|\| /i)
  })

  it('does NOT silently fall back to the argv code (no quiet leak)', () => {
    // A tolerant implementation would accept it and warn; that keeps the leak alive.
    expect(run(['--paste', 'abc123']).code).not.toBe(0)
  })

  it('the usage line no longer advertises `--paste CODE`', () => {
    const r = run(['--bogus'])
    expect(r.out).toContain('usage:')
    expect(r.out).not.toMatch(/--paste CODE/)
    expect(r.out).toMatch(/stdin/)
  })

  it('the script source contains no `CODE="\\${2', () => {
    // The original intake. Asserting on the source catches a re-introduction that a behavioural
    // test would miss if someone added a second, argv-reading branch.
    const src = readFileSync(SCRIPT, 'utf-8')
    expect(src).not.toMatch(/CODE="\$\{2/)
  })
})

describe('--paste reads STDIN', () => {
  it('rejects an EMPTY stdin rather than pasting nothing into the panel', () => {
    const r = run(['--paste'], '')
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/empty code/i)
  })

  it('rejects whitespace-only stdin (a stray newline is not a code)', () => {
    const r = run(['--paste'], '\n\n')
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/empty code/i)
  })

  it('a piped code gets PAST intake and fails later on the missing panel, not on parsing', () => {
    // Proves the stdin path actually yields a code: the next failure is the tmux panel check.
    const r = run(['--paste'], 'a-real-looking-code-123\n')
    expect(r.out).toMatch(/panel gone/i)
    expect(r.out).not.toMatch(/empty code|must NOT be passed/i)
  })
})

describe('--paste-file requires 0600', () => {
  it('REFUSES a world-readable code file (same leak, different place)', () => {
    const f = join(dir, 'code.txt')
    writeFileSync(f, 'abc123')
    chmodSync(f, 0o644)
    const r = run(['--paste-file', f])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/must be mode 0600/i)
    expect(r.out).toMatch(/644/)
  })

  it('REFUSES a group-readable file too (0640 is not "close enough")', () => {
    const f = join(dir, 'code.txt')
    writeFileSync(f, 'abc123')
    chmodSync(f, 0o640)
    expect(run(['--paste-file', f]).code).toBe(2)
  })

  it('ACCEPTS a 0600 file -- and then fails on the panel, proving the code was read', () => {
    const f = join(dir, 'code.txt')
    writeFileSync(f, 'a-real-looking-code-123')
    chmodSync(f, 0o600)
    const r = run(['--paste-file', f])
    expect(r.out).toMatch(/panel gone/i)
    expect(r.out).not.toMatch(/must be mode 0600|empty code/i)
  })

  it('a missing path is a clear error, not a silent empty code', () => {
    const r = run(['--paste-file', join(dir, 'nope.txt')])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/no such file/i)
  })

  it('--paste-file with no path is rejected', () => {
    expect(run(['--paste-file']).code).toBe(2)
  })
})

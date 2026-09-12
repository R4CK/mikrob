// Card dc5b714d: every per-agent config this module writes must be OWNER-ONLY, whichever state the
// file was in beforehand.
//
// WHY A SECOND FILE, next to isolated-config-mcp-reconcile.test.ts. That one pins `.claude.json`,
// and card 75c2dbb7 fixed the writer it goes through. Measured on 2026-09-06, FIVE other writes in
// agent-process.ts never went through that writer at all -- the plugins registry pair, the agent
// `.env`, `.mcp.json`, and `.claude/settings.json` -- and every one of their live files sat at 0664.
// `.mcp.json` is the same content class as the incident that started this line of work: one of the
// fleet's carried an `env` block with an API key in it, group- and world-readable.
//
// FIVE, not four: my first report said four and Cybersec measured the fifth. The missed one was
// `.claude/settings.json`, whose BASENAME matches an already-fixed file while its PATH does not --
// two `settings.json` sit side by side on disk. The code routed all five from the start; only the
// prose was short, which is exactly the kind of drift a doc-accuracy gate catches and a test does
// not, so it is corrected in both places rather than only on the card.
//
// BOTH STARTING STATES, CROSSED. A mode-less write does not touch the mode of a file that already
// exists, so a creation-only bench would have called the old code correct for a file sitting on disk
// at 0664 -- which is every file this card is actually about. The CREATION case additionally drops
// the umask to 0002 on purpose: this fleet installs 0077, and under 0077 even a mode-less create
// comes out 0600, so on this machine that case would agree with itself either way.
//
// WHAT THIS FILE DOES NOT MEASURE, stated rather than implied. Removing the `{ mode }` option from
// the writer leaves every case here GREEN (measured), because the chmod that follows has already
// fixed the file by the time anything looks at it. `{ mode }` exists to close the WINDOW between
// creation and that chmod, and a rest-state assertion cannot see a window. So the at-rest guarantee
// is measured and the window is argued -- do not read a green run here as covering both.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let SANDBOX = ''
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(SANDBOX, 'agents', name) }
})

const { ensureIsolatedChannelConfigDir } = await import('../web/agent-process.js')

const AGENT = 'testagent'
const OWNER_ONLY = 0o600

const pluginsDir = (): string => join(SANDBOX, 'agents', AGENT, '.claude-config', 'plugins')
const known = (): string => join(pluginsDir(), 'known_marketplaces.json')
const installed = (): string => join(pluginsDir(), 'installed_plugins.json')
const modeOf = (p: string): number => statSync(p).mode & 0o777

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'cfgmode-'))
  const claude = join(SANDBOX, 'home', '.claude')
  mkdirSync(join(claude, 'plugins'), { recursive: true })
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: {} }))
  writeFileSync(
    join(SANDBOX, 'home', '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true, mcpServers: {} }, null, 2),
  )
  // The two shared plugin files the reconcile copies down. Without them the writes are skipped and
  // every assertion below would be vacuous -- which the first case checks before asserting a mode.
  writeFileSync(join(claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({ m: {} }, null, 2))
  writeFileSync(
    join(claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { p: [{ scope: 'project', projectPath: '/old' }] } }, null, 2),
  )
  mkdirSync(join(SANDBOX, 'agents', AGENT), { recursive: true })
})
afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('card dc5b714d: per-agent config files are written owner-only', () => {
  it('CONTROL: the reconcile really writes these files -- the mode cases are not vacuous', () => {
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    expect(existsSync(known()), 'known_marketplaces.json was never written').toBe(true)
    expect(existsSync(installed()), 'installed_plugins.json was never written').toBe(true)
    // ...and it wrote CONTENT, not an empty placeholder: the project path was re-pointed.
    const inst = JSON.parse(readFileSync(installed(), 'utf-8')) as {
      plugins: Record<string, Array<{ projectPath?: string }>>
    }
    expect(inst.plugins['p']![0]!.projectPath).not.toBe('/old')
  })

  it('CREATION: a file that did not exist is born 0600, not at the umask default', () => {
    // THE UMASK IS SET HERE ON PURPOSE, and without it this case proves nothing. The fleet installs
    // umask 0077 (ensure-umask-dropin.sh), and under 0077 a mode-LESS create already comes out 0600
    // -- so on this machine the bench would agree whether or not the writer passes `{ mode }`.
    // Measured: process umask is 0077 as the suite runs. Dropping to 0002 is what makes the
    // `{ mode }` half load-bearing, and it also matches any host that has not taken the drop-in.
    const previous = process.umask(0o002)
    try {
      ensureIsolatedChannelConfigDir(AGENT, 'telegram')
      expect(modeOf(known())).toBe(OWNER_ONLY)
      expect(modeOf(installed())).toBe(OWNER_ONLY)
    } finally {
      process.umask(previous)
    }
  })

  it('REWRITE: a file already on disk at 0644 is NARROWED back to 0600', () => {
    // The state the fleet was actually in. A mode-less write leaves this untouched for ever, which
    // is why 15 of each of these sat at 0664 until they were measured.
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    chmodSync(known(), 0o644)
    chmodSync(installed(), 0o664)
    expect(modeOf(known())).toBe(0o644)

    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    expect(modeOf(known())).toBe(OWNER_ONLY)
    expect(modeOf(installed())).toBe(OWNER_ONLY)
  })

  it('the isolated .claude.json and settings.json stay 0600 too -- the other writer is unchanged', () => {
    // Card 75c2dbb7 fixed those two. Asserted here as well so a future change to the shared helper
    // cannot quietly regress them while this file only watches the ones it added.
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    const cfg = join(SANDBOX, 'agents', AGENT, '.claude-config')
    expect(modeOf(join(cfg, '.claude.json'))).toBe(OWNER_ONLY)
    expect(modeOf(join(cfg, 'settings.json'))).toBe(OWNER_ONLY)
  })
})

describe('card dc5b714d: no write in agent-process.ts bypasses the owner-only helpers', () => {
  // The behavioural cases above reach three of the five call sites. The other two (`.mcp.json` and
  // the per-agent `.claude/settings.json`) live in the spawn path, which this harness cannot drive.
  // What is left to guarantee for those is a WIRING fact -- that they go through a helper -- and a
  // source-level count is the honest way to state a wiring fact.
  //
  // Comments are stripped first (root CLAUDE.md principle 12): a `writeFileSync(` quoted in a
  // comment satisfies a naive scan and would let a real bypass hide behind an explanation of one.
  const SRC = new URL('../web/agent-process.ts', import.meta.url)
  const code = (): string =>
    readFileSync(SRC, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n')

  it('no writeFileSync is left to the umask', () => {
    // Two helper call sites (writeJsonAtomic's staging write, writeAgentConfig's write) plus the
    // parked-input rescue file, which is TEXT and so cannot go through either JSON helper -- it
    // passes RESCUE_FILE_MODE (0o600) explicitly instead.
    //
    // WIDENED, NOT WEAKENED (B-wave, card 42938a74). The old form was `toBe(2)` on the raw count,
    // which an upstream merge tripped for two different reasons at once: one genuine bypass (a
    // .mcp.json written at the default mode -- fixed, it now goes through writeJsonAtomic) and one
    // correct-but-uncounted write (the rescue file). A bare number could not tell those apart. The
    // property this card actually cares about is stated directly below: a write that names no mode
    // is the defect, wherever it is.
    const hits = code().match(/(?<![.\w])writeFileSync\s*\(/g) ?? []
    expect(
      hits.length,
      'a write in agent-process.ts is not going through writeJsonAtomic/writeAgentConfig',
    ).toBe(3)
    const modeless = code()
      .split('\n')
      .filter((l) => /(?<![.\w])writeFileSync\s*\(/.test(l) && !/\bmode\b/.test(l))
    expect(
      modeless,
      'a writeFileSync in agent-process.ts names no mode, so the umask decides it',
    ).toEqual([])
  })

  it('CONTROL: the scan can see a bypass -- it is not matching nothing', () => {
    // Without this, `toBe(2)` could hold because the pattern stopped matching at all.
    const withBypass = code() + '\nwriteFileSync(somePath, data)\n'
    const hits = withBypass.match(/(?<![.\w])writeFileSync\s*\(/g) ?? []
    expect(hits.length).toBe(4)   // 3 real sites + the synthetic bypass (B-wave, card 42938a74)
  })

  it('CONTROL: the comment stripper is what makes the count honest', () => {
    // A quoted call in a comment must NOT be counted -- otherwise the guard can be satisfied by
    // deleting a real helper call and mentioning it in prose.
    const commented = code() + '\n// writeFileSync(somePath, data) -- explained, not performed\n'
    const hits =
      commented
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n')
        .match(/(?<![.\w])writeFileSync\s*\(/g) ?? []
    expect(hits.length).toBe(3)   // the commented one must NOT be counted (B-wave, card 42938a74)
  })
})

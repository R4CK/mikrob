// Card 25ea084c (TOKENVAK915): the main agent's own isolated config root used to be invisible
// to the context/idle/restart-gate readers -- context-guard-runner.ts and
// context-restart-gate-runner.ts each hardcoded `undefined` (the shared ~/.claude root) for
// MAIN_AGENT_ID unconditionally. This pins the NEW shared resolver's own logic: "probe every
// candidate root, newest transcript wins" -- the same rule mainConfigRoots()/mainTranscriptDirs()
// already use for inbound-ingestion timestamps (2026-09-11 CONFIG-DIR BLIND SPOT).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir as realTmpdir } from 'node:os'
import { encodeClaudeProjectDir } from '../claude-project-dir.js'

// FAKE homedir, so "the shared root" in this test is a sandboxed tmp dir, never the real
// $HOME/.claude -- writing a transcript into the operator's actual Claude config would be a real,
// destructive side effect, not a test fixture.
const FAKE_HOME = mkdtempSync(join(realTmpdir(), 'main-transcript-root-home-'))
vi.mock('node:os', async (orig) => ({
  ...(await orig<typeof import('node:os')>()),
  homedir: () => FAKE_HOME,
}))

const SHARED_ROOT = join(FAKE_HOME, '.claude')

let roots: string[] = []
vi.mock('../web/inbound-probe.js', () => ({
  mainConfigRoots: () => roots,
}))

const { mainAgentConfigDir } = await import('../web/main-transcript-root.js')

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
  tmpDirs.length = 0
  roots = []
  try { rmSync(join(SHARED_ROOT, 'projects'), { recursive: true, force: true }) } catch { /* ignore */ }
})

function makeTmpDir(): string {
  const d = mkdtempSync(join(realTmpdir(), 'main-transcript-root-'))
  tmpDirs.push(d)
  return d
}

/** Writes a transcript .jsonl for `workingDir` under `configRoot`, with the given mtime. */
function writeTranscript(configRoot: string, workingDir: string, mtimeMs: number): void {
  const dir = join(configRoot, 'projects', encodeClaudeProjectDir(workingDir))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, '{}\n', 'utf-8')
  const sec = mtimeMs / 1000
  utimesSync(file, sec, sec)
}

describe('mainAgentConfigDir', () => {
  it('returns undefined when no candidate root has a transcript at all', () => {
    const workingDir = makeTmpDir()
    const isolated = makeTmpDir()
    roots = [SHARED_ROOT, isolated]
    expect(mainAgentConfigDir(workingDir)).toBe(undefined)
  })

  it('returns undefined when only the SHARED root has the (freshest, or only) transcript', () => {
    const workingDir = makeTmpDir()
    const isolated = makeTmpDir()
    writeTranscript(SHARED_ROOT, workingDir, Date.now())
    roots = [SHARED_ROOT, isolated]
    expect(mainAgentConfigDir(workingDir)).toBe(undefined)
    rmSync(join(SHARED_ROOT, 'projects', encodeClaudeProjectDir(workingDir)), { recursive: true, force: true })
  })

  it('returns the ISOLATED root when only it has a transcript (the actual TOKENVAK915 bug)', () => {
    const workingDir = makeTmpDir()
    const isolated = makeTmpDir()
    writeTranscript(isolated, workingDir, Date.now())
    roots = [SHARED_ROOT, isolated]
    expect(mainAgentConfigDir(workingDir)).toBe(isolated)
  })

  it('MUTATION PIN: the ISOLATED root wins when it is the FRESHER of two existing transcripts', () => {
    const workingDir = makeTmpDir()
    const isolated = makeTmpDir()
    const now = Date.now()
    writeTranscript(SHARED_ROOT, workingDir, now - 60_000) // older, stale (pre-isolation)
    writeTranscript(isolated, workingDir, now) // newer, live
    roots = [SHARED_ROOT, isolated]
    expect(mainAgentConfigDir(workingDir)).toBe(isolated)
    rmSync(join(SHARED_ROOT, 'projects', encodeClaudeProjectDir(workingDir)), { recursive: true, force: true })
  })

  it('MUTATION PIN: the SHARED root wins when it is the FRESHER of two existing transcripts', () => {
    const workingDir = makeTmpDir()
    const isolated = makeTmpDir()
    const now = Date.now()
    writeTranscript(isolated, workingDir, now - 60_000) // older, isolation turned off since
    writeTranscript(SHARED_ROOT, workingDir, now) // newer, live
    roots = [SHARED_ROOT, isolated]
    expect(mainAgentConfigDir(workingDir)).toBe(undefined)
    rmSync(join(SHARED_ROOT, 'projects', encodeClaudeProjectDir(workingDir)), { recursive: true, force: true })
  })

  it('a non-existent candidate root is ignored, not fatal', () => {
    const workingDir = makeTmpDir()
    const neverProvisioned = join(makeTmpDir(), 'does-not-exist')
    const isolated = makeTmpDir()
    writeTranscript(isolated, workingDir, Date.now())
    roots = [SHARED_ROOT, neverProvisioned, isolated]
    expect(mainAgentConfigDir(workingDir)).toBe(isolated)
  })
})

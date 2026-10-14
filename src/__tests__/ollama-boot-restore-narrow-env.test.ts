// Card 39b958a4 (Cybersec F2, GO b9a657e6 comment 5821): runOllamaBootRestore() spawns
// ollama-boot-restore.sh, which detaches a long-lived `ollama serve` daemon via `setsid nohup`.
// That daemon inherits whatever env execFileSync hands the wrapping bash process -- unlike this
// file's other execFileSync calls, which only spawn short-lived helpers. Passing the full
// inherited process.env (this dashboard process's own environment, including
// CLAUDE_CODE_MESSAGING_TOKEN) would put it in that daemon's /proc/<pid>/environ indefinitely.
//
// Matched on the comment-stripped source (cards 06d36307, 2f0c7d24 shape: a symbol named only in a
// comment satisfies a naive presence check), because this file is imported with its real module
// side effects by many other tests -- a source assertion pins the wiring without needing to spawn
// the real script or mock the whole module.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MONITOR_PATH = join(__dirname, '../web/channel-monitor.ts')
const srcRaw = readFileSync(MONITOR_PATH, 'utf-8')
const src = srcRaw
  .split('\n')
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')

describe('runOllamaBootRestore passes a narrow env, not the inherited process.env (card 39b958a4)', () => {
  const fnStart = src.indexOf('function runOllamaBootRestore')
  expect(fnStart, 'runOllamaBootRestore not found').toBeGreaterThan(0)
  const fnEnd = src.indexOf('\nfunction ', fnStart + 1)
  const fnBody = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined)

  it('calls execFileSync with an explicit env option', () => {
    expect(fnBody).toMatch(/execFileSync\(['"]\/bin\/bash['"],\s*\[OLLAMA_RESTORE_SCRIPT\][^)]*env:/)
  })

  it('does not spread the full process.env into that call', () => {
    expect(fnBody).not.toMatch(/\.\.\.process\.env/)
  })

  it('the narrow-env builder only carries PATH, HOME and an optional OLLAMA_HOST', () => {
    const builderStart = src.indexOf('function buildOllamaRestoreEnv')
    expect(builderStart, 'buildOllamaRestoreEnv not found').toBeGreaterThan(0)
    const builderEnd = src.indexOf('\nfunction ', builderStart + 1)
    const builderBody = src.slice(builderStart, builderEnd > builderStart ? builderEnd : undefined)
    expect(builderBody).toContain('PATH: process.env.PATH')
    expect(builderBody).toContain('HOME: process.env.HOME')
    expect(builderBody).toContain('OLLAMA_HOST')
    expect(builderBody).not.toMatch(/\.\.\.process\.env/)
  })
})

// Guard: a scheduled task that only exists on one host is one reinstall away from gone (card 975e5a97).
//
// offload-overnight-batch was configured live but absent from seed-scheduled-tasks/, so the fix that
// finally made it run was unversioned -- invisible to a fresh checkout and to every other host. Same
// for the canary that watches for exactly this class of silent death. Both are seeded now, and the
// seeds must stay portable: a hardcoded /home/neon path would "work" here and break everywhere else.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'seed-scheduled-tasks')
// Tasks whose absence from the seed caused, or would hide, a silent failure.
const MUST_BE_SEEDED = ['offload-overnight-batch', 'scheduled-task-canary'] as const

interface SeedConfig {
  schedule?: string
  agent?: string
  type?: string
  command?: string
  enabled?: boolean
  timeoutMs?: number
}

const seeds = (): Array<[string, SeedConfig]> =>
  readdirSync(SEED_DIR)
    .filter((n) => existsSync(join(SEED_DIR, n, 'task-config.json')))
    .map((n) => [n, JSON.parse(readFileSync(join(SEED_DIR, n, 'task-config.json'), 'utf-8')) as SeedConfig])

const readSeed = (name: string): SeedConfig =>
  JSON.parse(readFileSync(join(SEED_DIR, name, 'task-config.json'), 'utf-8')) as SeedConfig

describe('seed-scheduled-tasks durability (card 975e5a97)', () => {
  it.each(MUST_BE_SEEDED)('%s is present in the seed set', (name) => {
    expect(existsSync(join(SEED_DIR, name, 'task-config.json')), `${name} must be versioned, not host-local`).toBe(true)
  })

  it.each(MUST_BE_SEEDED)('%s is a command task with a real command', (name) => {
    const cfg = readSeed(name)
    expect(cfg.type).toBe('command') // no LLM session required, so it runs even at 03:00
    expect(cfg.command ?? '').not.toBe('')
    expect(cfg.schedule ?? '').toMatch(/\S/)
    expect(cfg.enabled).toBe(true)
  })

  // A seed is rendered onto whatever host installs it; an absolute path from this box would
  // silently point at nothing there -- the same "configured but never runs" failure again.
  it('no seed config hardcodes this machine\'s install path', () => {
    for (const name of readdirSync(SEED_DIR)) {
      const file = join(SEED_DIR, name, 'task-config.json')
      if (!existsSync(file)) continue
      const raw = readFileSync(file, 'utf-8')
      expect(raw, `${name} must use {{INSTALL_DIR}}, not a hardcoded path`).not.toContain('/home/neon')
      if (/\bcommand\b/.test(raw) && /store\//.test(raw)) {
        expect(raw, `${name} references store/ so it must template the install dir`).toContain('{{INSTALL_DIR}}')
      }
    }
  })

  // Now repo-wide (card 699675d7 closed the four stragglers). A seed that pins a concrete agent id
  // targets an agent that does not exist on a fork whose main agent has another name.
  it('no seed pins a concrete agent id', () => {
    const all = seeds()
    expect(all.length, 'no seeds parsed -- this assertion would be vacuous').toBeGreaterThan(5)
    for (const [name, cfg] of all) expect(cfg.agent, `${name} pins a concrete agent id`).toBe('{{MAIN_AGENT_ID}}')
  })

  // The prompt BODIES carried the same hardcoding, and that half matters more: one of them was an
  // actual API payload (`{"from":"mikrob",...}`), which on a differently-named fork attributes the
  // message to a nonexistent sender. The prose name "MikroB" is not an id and stays.
  it('no seed prompt hardcodes the main agent id in its body', () => {
    const files = readdirSync(SEED_DIR)
      .map((n) => join(SEED_DIR, n, 'SKILL.md'))
      .filter((f) => existsSync(f))
    expect(files.length).toBeGreaterThan(3)
    for (const f of files) {
      const body = readFileSync(f, 'utf-8')
      expect(/(?<![A-Za-z0-9_-])mikrob(?![A-Za-z0-9_])/.test(body), `${f} hardcodes the agent id`).toBe(false)
    }
  })

  // A missing trailing newline was, on its own, enough to make seed_copy_is_untouched() never match:
  // every live file ends with 0a, every seed SKILL.md ended with `.` (0x2e). For stuck-card-monitor
  // that single byte was the ONLY difference -- zero content drift, yet the refresh treated it as
  // user-modified forever (card dec9a318, measured by Cybered).
  it('every seed SKILL.md ends with a newline', () => {
    const files = readdirSync(SEED_DIR)
      .map((n) => join(SEED_DIR, n, 'SKILL.md'))
      .filter((f) => existsSync(f))
    expect(files.length, 'no seed SKILL.md found -- this assertion would be vacuous').toBeGreaterThan(3)
    for (const f of files) {
      expect(readFileSync(f, 'utf-8').endsWith('\n'), `${f} has no trailing newline`).toBe(true)
    }
  })

  it('every seed config is valid JSON', () => {
    for (const name of readdirSync(SEED_DIR)) {
      const file = join(SEED_DIR, name, 'task-config.json')
      if (!existsSync(file)) continue
      expect(() => JSON.parse(readFileSync(file, 'utf-8')), `${name} has malformed JSON`).not.toThrow()
    }
  })
})

// Card 5423775c (Cybered C1/C2 follow-up on b715a0b1): mainConfigRoots()'s explicit
// MAIN_AGENT_CONFIG_DIR candidate used its own ad-hoc tilde expansion (`raw.startsWith('~') ?
// join(homedir(), raw.slice(1)) : raw`), never the launcher's whitelist/traversal/tilde-form
// gauntlet (expandAndValidateConfigDir, config-dir-path.ts). Mutating that candidate (e.g.
// dropping the validation call entirely) left the suite green, since nothing asserted a bad
// value was ever rejected. Fixed: mainConfigRoots() now runs the raw setting through the exact
// same expandAndValidateConfigDir the launcher's resolveMainAgentConfigDir() (agent-process.ts)
// uses, so a watchdog never probes a root the launcher would have refused to export as
// CLAUDE_CONFIG_DIR.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

const settings: Record<string, string> = {}
vi.mock('../settings-store.js', async () => {
  const actual = await vi.importActual<typeof import('../settings-store.js')>('../settings-store.js')
  return { ...actual, getEffectiveSettingValue: (key: string) => settings[key] ?? '' }
})

describe('mainConfigRoots(): explicit MAIN_AGENT_CONFIG_DIR candidate is validated, not raw', () => {
  beforeEach(() => {
    for (const k of Object.keys(settings)) delete settings[k]
  })

  it('a well-formed ~/-prefixed value is included, expanded against homedir()', async () => {
    settings.MAIN_AGENT_CONFIG_DIR = '~/.claude-bot'
    const { mainConfigRoots } = await import('../web/inbound-probe.js')
    expect(mainConfigRoots()).toContain(join(homedir(), '.claude-bot'))
  })

  it('a path with a `..` traversal segment is rejected, not pushed raw (mutation pin)', async () => {
    settings.MAIN_AGENT_CONFIG_DIR = '/home/op/../../etc/claude-evil'
    const { mainConfigRoots } = await import('../web/inbound-probe.js')
    const roots = mainConfigRoots()
    expect(roots).not.toContain('/home/op/../../etc/claude-evil')
    expect(roots.some((r) => r.includes('..'))).toBe(false)
  })

  it('a malformed tilde form (mid-string `~`) is rejected, not pushed raw (mutation pin)', async () => {
    settings.MAIN_AGENT_CONFIG_DIR = '/home/op/~weird'
    const { mainConfigRoots } = await import('../web/inbound-probe.js')
    expect(mainConfigRoots()).not.toContain('/home/op/~weird')
  })

  it('a disallowed character (shell-significant outside the whitelist) is rejected, not pushed raw', async () => {
    settings.MAIN_AGENT_CONFIG_DIR = '/home/op/claude; rm -rf /'
    const { mainConfigRoots } = await import('../web/inbound-probe.js')
    expect(mainConfigRoots()).not.toContain('/home/op/claude; rm -rf /')
  })

  it('no explicit setting -> only the two default roots, same as before this fix', async () => {
    const { mainConfigRoots } = await import('../web/inbound-probe.js')
    const roots = mainConfigRoots()
    expect(roots).toHaveLength(2)
  })
})

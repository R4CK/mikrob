// Card 01eb0d0c: ensureFederationClaudeMdSection() used to gate the sub-agent reply/loop block
// on cfg.enabled ALONE, so every sub-agent's CLAUDE.md carried the 1209-char block even with
// ZERO peers configured -- measured on the live install, which has federation enabled and
// peers: [] (see claude-md-federation-block-committed-idempotent.test.ts). A sub-agent only
// needs the addressing/reply rules once a peer can actually address it directly. This pins the
// fix: the block appears once a peer exists, and is absent (or removed, if it was written
// while a peer existed and the last one is then removed) when there are none.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FederationConfig } from '../web/federation/config.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-fed-subagent-test-'))

const { configMock } = vi.hoisted(() => ({ configMock: { current: null as FederationConfig | null } }))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  STORE_DIR: join(tmpRoot, 'store'),
  MAIN_AGENT_ID: 'mikrob',
  BOT_NAME: 'MikroB',
  WEB_PORT: 3420,
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

vi.mock('../logger.js', () => ({ logger: { info: () => {}, warn: () => {} } }))

vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: () => 'hu' }))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
}))

vi.mock('../web/federation/local-catalog.js', () => ({
  catalogAgentNames: () => ['backend'],
}))

vi.mock('../web/federation/config.js', async () => {
  const actual = await vi.importActual<typeof import('../web/federation/config.js')>('../web/federation/config.js')
  return { ...actual, getFederationConfig: () => configMock.current }
})

const { ensureFederationClaudeMdSection } = await import('../web/federation/onboarding.js')
const { FEDERATION_BLOCK_BEGIN } = await import('../web/federation/onboarding.js')

function setupSubAgent(content: string) {
  const dir = join(tmpRoot, 'agents', 'backend')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}
const readSubAgent = () => readFileSync(join(tmpRoot, 'agents', 'backend', 'CLAUDE.md'), 'utf-8')

describe('ensureFederationClaudeMdSection: sub-agent block requires an actual peer (card 01eb0d0c)', () => {
  it('enabled with ZERO peers does not write the sub-agent block at all', () => {
    setupSubAgent('# Backend\n\nexisting text\n')
    configMock.current = { enabled: true, systemId: 'mikrob', routingMode: 'catalog-first', peers: [] }
    ensureFederationClaudeMdSection()
    expect(readSubAgent()).not.toContain(FEDERATION_BLOCK_BEGIN)
  })

  it('enabled with at least one peer DOES write the sub-agent block', () => {
    setupSubAgent('# Backend\n\nexisting text\n')
    configMock.current = {
      enabled: true,
      systemId: 'mikrob',
      routingMode: 'catalog-first',
      peers: [{ id: 'teodor', baseUrl: 'https://teodor.example', outboundToken: 'x'.repeat(64), inboundToken: 'y'.repeat(64), trust: 'untrusted' }],
    }
    ensureFederationClaudeMdSection()
    expect(readSubAgent()).toContain(FEDERATION_BLOCK_BEGIN)
  })

  it('a peer that is later removed down to zero also REMOVES the sub-agent block', () => {
    setupSubAgent('# Backend\n\nexisting text\n')
    configMock.current = {
      enabled: true,
      systemId: 'mikrob',
      routingMode: 'catalog-first',
      peers: [{ id: 'teodor', baseUrl: 'https://teodor.example', outboundToken: 'x'.repeat(64), inboundToken: 'y'.repeat(64), trust: 'untrusted' }],
    }
    ensureFederationClaudeMdSection()
    expect(readSubAgent()).toContain(FEDERATION_BLOCK_BEGIN)

    configMock.current = { enabled: true, systemId: 'mikrob', routingMode: 'catalog-first', peers: [] }
    ensureFederationClaudeMdSection()
    expect(readSubAgent()).not.toContain(FEDERATION_BLOCK_BEGIN)
  })
})

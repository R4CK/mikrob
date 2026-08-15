import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findServerScopes,
  allServerScopes,
  collectAllMcpFilePaths,
} from '../web/vault-bindings.js'

// Card 691f5475 / 8763e412. The vault binding machinery could not reach the fleet's MCP servers at
// all, for two independent reasons, and both were invisible: it only ever read a config's TOP-LEVEL
// `mcpServers`, and it only ever looked in .mcp.json paths. The fleet's servers live under
// `projects[<cwd>].mcpServers` inside agents/<name>/.claude-config/.claude.json -- neither shape.
// Measured on 2026-08-15: all 15 `resend` declarations were project-scoped, which is why that
// credential had to be migrated with a one-off script instead of through this mechanism.

const CLAUDE_JSON_SHAPE = {
  projects: {
    '/home/someone': {
      mcpServers: {
        resend: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } },
        other: { command: '/bin/true' },
      },
    },
    '/home/someone/work': {
      mcpServers: { resend: { type: 'http', url: 'https://mcp.example.com/mcp' } },
    },
  },
}

const MCP_JSON_SHAPE = {
  mcpServers: { resend: { command: '/bin/true', env: { RESEND_API_KEY: 'plaintext' } } },
}

describe('findServerScopes sees every scope a server can be declared in', () => {
  it('finds a server declared ONLY under projects[<cwd>] -- the case that was invisible', () => {
    const scopes = findServerScopes(CLAUDE_JSON_SHAPE, 'resend')
    // Two projects declare it; the old lookup found zero and reported "server not found".
    expect(scopes.map((s) => s.scope)).toEqual(['projects[/home/someone]', 'projects[/home/someone/work]'])
  })

  it('still finds a top-level declaration (the .mcp.json shape)', () => {
    expect(findServerScopes(MCP_JSON_SHAPE, 'resend').map((s) => s.scope)).toEqual(['root'])
  })

  it('finds BOTH when a config carries the same server at both scopes', () => {
    const both = { ...MCP_JSON_SHAPE, ...CLAUDE_JSON_SHAPE }
    expect(findServerScopes(both, 'resend')).toHaveLength(3)
  })

  it('returns the LIVE object, so a caller can mutate it in place', () => {
    // This is what the sync relies on: it edits cfg and writes the whole document back.
    const doc = JSON.parse(JSON.stringify(CLAUDE_JSON_SHAPE))
    for (const { cfg } of findServerScopes(doc, 'resend')) cfg['headersHelper'] = 'helper args'
    expect(doc.projects['/home/someone'].mcpServers.resend.headersHelper).toBe('helper args')
    expect(doc.projects['/home/someone/work'].mcpServers.resend.headersHelper).toBe('helper args')
  })

  it('is quiet on absent servers and on malformed documents', () => {
    expect(findServerScopes(CLAUDE_JSON_SHAPE, 'nosuchserver')).toEqual([])
    for (const junk of [null, undefined, 42, 'string', [], { projects: 'not-an-object' }, { mcpServers: [] }]) {
      expect(findServerScopes(junk, 'resend')).toEqual([])
    }
  })

  it('ignores a non-object server entry rather than handing one to a mutator', () => {
    expect(findServerScopes({ mcpServers: { resend: 'oops' } }, 'resend')).toEqual([])
  })
})

describe('allServerScopes enumerates what the plaintext scan must cover', () => {
  it('lists every server at every scope', () => {
    const names = allServerScopes(CLAUDE_JSON_SHAPE).map((s) => `${s.scope}:${s.serverName}`)
    expect(names).toEqual([
      'projects[/home/someone]:resend',
      'projects[/home/someone]:other',
      'projects[/home/someone/work]:resend',
    ])
  })

  it('picks up an env-bearing server nested in projects -- the scan case that mattered', () => {
    // A plaintext key sitting in projects[...].mcpServers used to be invisible to the scan whose
    // entire job is to find plaintext keys.
    const doc = { projects: { '/x': { mcpServers: { s: { env: { API_TOKEN: 'plaintext-value' } } } } } }
    const found = allServerScopes(doc)
    expect(found).toHaveLength(1)
    expect(found[0]!.cfg['env']).toEqual({ API_TOKEN: 'plaintext-value' })
  })
})

describe('collectAllMcpFilePaths reaches the isolated per-agent configs', () => {
  it('includes agents/<name>/.claude-config/.claude.json, labelled as such', () => {
    // Built on a throwaway tree on purpose: the fleet test worktree has no agents/ directory, so an
    // assertion against the real one would pass vacuously exactly where this suite runs.
    const root = mkdtempSync(join(tmpdir(), 'vault-roots-'))
    const agentsDir = join(root, 'agents')
    mkdirSync(join(agentsDir, 'backend', '.claude-config'), { recursive: true })
    writeFileSync(join(agentsDir, 'backend', '.claude-config', '.claude.json'), '{}')
    mkdirSync(join(agentsDir, 'qa'), { recursive: true })
    writeFileSync(join(agentsDir, 'qa', '.mcp.json'), '{}')

    const paths = collectAllMcpFilePaths({
      projectRoot: root,
      homeDir: root,
      agentsDir,
      agentNames: ['backend', 'qa'],
    })
    const labels = paths.map((p) => p.label)
    expect(labels).toContain('agent-config:backend')
    expect(labels).toContain('agent:qa')
    expect(paths.find((p) => p.label === 'agent-config:backend')!.path)
      .toBe(join(agentsDir, 'backend', '.claude-config', '.claude.json'))
  })

  it('does not invent paths for agents that have no config file', () => {
    // Negative control: without this, the assertion above could be passing on a list that contains
    // every agent unconditionally.
    const root = mkdtempSync(join(tmpdir(), 'vault-roots-empty-'))
    mkdirSync(join(root, 'agents', 'ghost'), { recursive: true })
    const labels = collectAllMcpFilePaths({
      projectRoot: root,
      homeDir: root,
      agentsDir: join(root, 'agents'),
      agentNames: ['ghost'],
    }).map((p) => p.label)
    expect(labels).not.toContain('agent-config:ghost')
    expect(labels).not.toContain('agent:ghost')
  })
})

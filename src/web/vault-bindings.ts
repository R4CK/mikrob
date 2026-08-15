import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { readFileOr, AGENTS_BASE_DIR, listAgentNames } from './agent-config.js'
import { getSecret, listSecrets } from './vault.js'
import { getExternalProjectPaths } from './dashboard-settings.js'
import { shellEscape } from './sanitize.js'
import { logger } from '../logger.js'

const BINDINGS_PATH = join(PROJECT_ROOT, 'store', 'vault-bindings.json')
const VAULT_WRAPPER_PATH = join(PROJECT_ROOT, 'scripts', 'vault-env-wrapper.sh')
const VAULT_HEADERS_HELPER_PATH = join(PROJECT_ROOT, 'scripts', 'vault-headers-helper.sh')

export interface VaultBindingTarget {
  mcpFilePath: string
  serverName: string
}

export interface VaultBinding {
  vaultSecretId: string
  envVar: string
  targets: VaultBindingTarget[]
  // When set, this is a REMOTE-server header binding rather than an env binding.
  // The secret is injected into request headers at connection time via the
  // headersHelper script -- the plaintext token never lands in .mcp.json.
  headerName?: string
  // Auth scheme prefix for the header value, e.g. "Bearer" -> "Bearer <secret>".
  // Empty/undefined means the raw secret is used as the header value.
  headerScheme?: string
}

interface BindingsStore {
  bindings: VaultBinding[]
}

const SENSITIVE_PATTERNS = [
  /_KEY$/i, /_TOKEN$/i, /_SECRET$/i, /_PASSWORD$/i, /_PASS$/i,
  /^API_/i, /^AUTH_/i, /^OAUTH_/i,
  /PASSWORD/i, /CREDENTIAL/i, /ACCESS_KEY/i,
]

const NON_SENSITIVE_VALUE_PATTERNS = [
  /^(true|false)$/i,
  /^https?:\/\//,
  /^\d+$/,
  /^\//,
  /^\$\{/,
]

export interface ScanFinding {
  mcpFilePath: string
  serverName: string
  envVar: string
  maskedValue: string
  suggestedVaultId: string
  alreadyInVault: boolean
  existingVaultId?: string
}

export interface SyncResult {
  updated: number
  errors: string[]
}

function readBindings(): BindingsStore {
  try { return JSON.parse(readFileSync(BINDINGS_PATH, 'utf-8')) }
  catch { return { bindings: [] } }
}

function writeBindings(store: BindingsStore): void {
  atomicWriteFileSync(BINDINGS_PATH, JSON.stringify(store, null, 2) + '\n')
}

export function getBindings(): VaultBinding[] {
  return readBindings().bindings
}

export function addBinding(binding: VaultBinding): void {
  const store = readBindings()
  const idx = store.bindings.findIndex(
    b => b.vaultSecretId === binding.vaultSecretId && b.envVar === binding.envVar,
  )
  if (idx >= 0) {
    store.bindings[idx] = binding
  } else {
    store.bindings.push(binding)
  }
  writeBindings(store)
}

export function removeBinding(vaultSecretId: string, envVar: string): boolean {
  const store = readBindings()
  const before = store.bindings.length
  store.bindings = store.bindings.filter(
    b => !(b.vaultSecretId === vaultSecretId && b.envVar === envVar),
  )
  if (store.bindings.length === before) return false
  writeBindings(store)
  return true
}

export function removeBindingsForSecret(vaultSecretId: string): void {
  const store = readBindings()
  const toRemove = store.bindings.filter(b => b.vaultSecretId === vaultSecretId)
  const remaining = store.bindings.filter(b => b.vaultSecretId !== vaultSecretId)
  for (const binding of toRemove) {
    for (const target of binding.targets) {
      try {
        const content = JSON.parse(readFileOr(target.mcpFilePath, '{}'))
        // EVERY scope, not just the top level: the same server is often declared under
        // projects[<cwd>] in a .claude.json, which is where the fleet's actually live.
        const scopes = findServerScopes(content, target.serverName)
        if (scopes.length === 0) continue
        for (const { cfg: serverCfg } of scopes) {
          if (binding.headerName) {
            // Rebuild the server's headersHelper from the header bindings that
            // survive this secret's removal.
            applyHeadersHelper(
              serverCfg,
              headerBindingsForServer(target.mcpFilePath, target.serverName, remaining),
            )
          } else {
            if (!serverCfg.env) continue
            delete serverCfg.env[binding.envVar]
            if (!serverHasVaultRefs(serverCfg.env)) unwrapCommand(serverCfg)
          }
        }
        atomicWriteFileSync(target.mcpFilePath, JSON.stringify(content, null, 2))
      } catch { /* skip */ }
    }
  }
  store.bindings = remaining
  writeBindings(store)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Every declaration of `serverName` in one parsed config, at ANY scope.
 *
 * Two shapes carry MCP servers and only one of them was ever read here: the top-level
 * `mcpServers` of a .mcp.json, and `projects[<cwd>].mcpServers` inside a .claude.json. The live
 * fleet's servers are in the SECOND one (measured 2026-08-15, card 691f5475: all 15 `resend`
 * declarations are project-scoped), so binding one through the dashboard was impossible -- the
 * sync looked at `content.mcpServers[name]`, found nothing, and reported "server not found".
 * That is why the first credential migration had to be a one-off script instead of this mechanism.
 *
 * Returns the live config objects, so a caller mutates them in place and writes the document back.
 */
export function findServerScopes(
  doc: unknown,
  serverName: string,
): Array<{ scope: string; cfg: Record<string, any> }> {
  const out: Array<{ scope: string; cfg: Record<string, any> }> = []
  for (const entry of allServerScopes(doc)) {
    if (entry.serverName === serverName) out.push({ scope: entry.scope, cfg: entry.cfg })
  }
  return out
}

/** Every (scope, serverName, cfg) triple in one parsed config -- the scan-side counterpart. */
export function allServerScopes(
  doc: unknown,
): Array<{ scope: string; serverName: string; cfg: Record<string, any> }> {
  const out: Array<{ scope: string; serverName: string; cfg: Record<string, any> }> = []
  if (!isPlainObject(doc)) return out
  const push = (scope: string, servers: unknown): void => {
    if (!isPlainObject(servers)) return
    for (const [serverName, cfg] of Object.entries(servers)) {
      if (isPlainObject(cfg)) out.push({ scope, serverName, cfg: cfg as Record<string, any> })
    }
  }
  push('root', (doc as Record<string, unknown>)['mcpServers'])
  const projects = (doc as Record<string, unknown>)['projects']
  if (isPlainObject(projects)) {
    for (const [cwd, node] of Object.entries(projects)) {
      if (isPlainObject(node)) push(`projects[${cwd}]`, (node as Record<string, unknown>)['mcpServers'])
    }
  }
  return out
}

/**
 * The roots this walks. Parameters only so the tests can build a throwaway tree: every caller uses
 * the defaults. Without them this function is untestable in the fleet test worktree, which has no
 * agents/ directory at all -- any assertion about agent configs would pass there vacuously.
 */
export interface McpFileRoots {
  projectRoot?: string
  homeDir?: string
  agentsDir?: string
  agentNames?: string[]
}

export function collectAllMcpFilePaths(roots: McpFileRoots = {}): Array<{ path: string, label: string }> {
  const projectRoot = roots.projectRoot ?? PROJECT_ROOT
  const home = roots.homeDir ?? homedir()
  const agentsDir = roots.agentsDir ?? AGENTS_BASE_DIR
  const paths: Array<{ path: string, label: string }> = []
  const projectMcp = join(projectRoot, '.mcp.json')
  if (existsSync(projectMcp)) paths.push({ path: projectMcp, label: 'project' })
  const userMcp = join(home, '.claude.json')
  if (existsSync(userMcp)) paths.push({ path: userMcp, label: 'user' })

  for (const agentName of roots.agentNames ?? listAgentNames()) {
    const agentMcp = join(agentsDir, agentName, '.mcp.json')
    if (existsSync(agentMcp)) paths.push({ path: agentMcp, label: `agent:${agentName}` })
    // The isolated per-agent config -- each agent runs with CLAUDE_CONFIG_DIR pointing at it, and
    // it is where the fleet's MCP servers actually live. It was missing from this list, so nothing
    // bound through the dashboard could ever reach a running agent.
    const agentClaude = join(agentsDir, agentName, '.claude-config', '.claude.json')
    if (existsSync(agentClaude)) paths.push({ path: agentClaude, label: `agent-config:${agentName}` })
    const projectsDir = join(agentsDir, agentName, 'projects')
    if (existsSync(projectsDir)) {
      try {
        for (const proj of readdirSync(projectsDir)) {
          if (!statSync(join(projectsDir, proj)).isDirectory()) continue
          const projMcp = join(projectsDir, proj, '.mcp.json')
          if (existsSync(projMcp)) paths.push({ path: projMcp, label: `project:${agentName}/${proj}` })
        }
      } catch { /* ignore */ }
    }
  }
  for (const extPath of getExternalProjectPaths()) {
    const extMcp = join(extPath, '.mcp.json')
    if (existsSync(extMcp)) paths.push({ path: extMcp, label: `external:${basename(extPath)}` })
  }
  return paths
}

function maskValue(val: string): string {
  if (val.length <= 6) return '***'
  return val.slice(0, 3) + '...' + val.slice(-3)
}

function looksLikeSensitiveValue(val: string): boolean {
  if (!val || val.length < 8) return false
  if (val.startsWith('vault:')) return false
  for (const p of NON_SENSITIVE_VALUE_PATTERNS) {
    if (p.test(val)) return false
  }
  return true
}

function looksLikeSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some(p => p.test(key))
}

export function scanMcpConfigs(): ScanFinding[] {
  const findings: ScanFinding[] = []
  const mcpFiles = collectAllMcpFilePaths()
  const existingSecrets = listSecrets()

  const vaultValues = new Map<string, string>()
  for (const s of existingSecrets) {
    const val = getSecret(s.id)
    if (val) vaultValues.set(val, s.id)
  }

  for (const { path: mcpPath } of mcpFiles) {
    try {
      const parsed = JSON.parse(readFileOr(mcpPath, '{}'))
      // Scan project-scoped servers too, not only the top level -- otherwise a plaintext secret
      // sitting in a .claude.json's projects[<cwd>].mcpServers is invisible to the scan that
      // exists to find exactly that.
      for (const { serverName, cfg } of allServerScopes(parsed)) {
        const env = cfg?.env || {}
        for (const [envVar, envVal] of Object.entries(env) as Array<[string, string]>) {
          if (!looksLikeSensitiveKey(envVar)) continue
          if (!looksLikeSensitiveValue(String(envVal))) continue

          const existingVaultId = vaultValues.get(String(envVal))
          findings.push({
            mcpFilePath: mcpPath,
            serverName,
            envVar,
            maskedValue: maskValue(String(envVal)),
            suggestedVaultId: `${serverName}-${envVar}`,
            alreadyInVault: !!existingVaultId,
            existingVaultId,
          })
        }
      }
    } catch { /* skip unreadable files */ }
  }
  return findings
}

function wrapCommand(serverCfg: any): void {
  if (serverCfg.command === VAULT_WRAPPER_PATH) return
  serverCfg._vaultOriginalCommand = serverCfg.command
  if (serverCfg.args?.length) serverCfg._vaultOriginalArgs = serverCfg.args
  serverCfg.args = [serverCfg.command, ...(serverCfg.args || [])]
  serverCfg.command = VAULT_WRAPPER_PATH
}

function unwrapCommand(serverCfg: any): void {
  if (serverCfg.command !== VAULT_WRAPPER_PATH) return
  if (!serverCfg._vaultOriginalCommand) return
  serverCfg.command = serverCfg._vaultOriginalCommand
  serverCfg.args = serverCfg._vaultOriginalArgs || []
  delete serverCfg._vaultOriginalCommand
  delete serverCfg._vaultOriginalArgs
}

function serverHasVaultRefs(env: Record<string, string> | undefined): boolean {
  if (!env) return false
  return Object.values(env).some(v => typeof v === 'string' && v.startsWith('vault:'))
}

// All header bindings (across every secret) that target one server in one file.
// The headersHelper for a server must carry EVERY header the vault manages for
// it, so syncing one secret must not drop another secret's header.
function headerBindingsForServer(
  mcpFilePath: string,
  serverName: string,
  all: VaultBinding[] = getBindings(),
): VaultBinding[] {
  return all.filter(
    b => b.headerName && b.targets.some(t => t.mcpFilePath === mcpFilePath && t.serverName === serverName),
  )
}

// Rebuild (or clear) a remote server's headersHelper from the given header
// bindings, and strip any managed plaintext headers so the token only ever
// exists as a vault id on disk. Claude Code runs the helper per connection.
function applyHeadersHelper(serverCfg: any, headerBindings: VaultBinding[]): void {
  for (const b of headerBindings) {
    if (serverCfg.headers && b.headerName) delete serverCfg.headers[b.headerName]
  }
  if (headerBindings.length === 0) {
    delete serverCfg.headersHelper
  } else {
    const args = headerBindings.map(
      b => `${b.headerName}=${b.headerScheme ?? 'Bearer'}:::${b.vaultSecretId}`,
    )
    serverCfg.headersHelper = [VAULT_HEADERS_HELPER_PATH, ...args].map(shellEscape).join(' ')
  }
  if (serverCfg.headers && Object.keys(serverCfg.headers).length === 0) delete serverCfg.headers
}

export function syncSecret(vaultSecretId: string): SyncResult {
  const bindings = getBindings().filter(b => b.vaultSecretId === vaultSecretId)
  if (bindings.length === 0) return { updated: 0, errors: [] }

  const secret = getSecret(vaultSecretId)
  if (secret === null) return { updated: 0, errors: [`Vault secret "${vaultSecretId}" not found`] }

  let updated = 0
  const errors: string[] = []

  for (const binding of bindings) {
    for (const target of binding.targets) {
      try {
        const content = JSON.parse(readFileOr(target.mcpFilePath, '{}'))
        const scopes = findServerScopes(content, target.serverName)
        if (scopes.length === 0) {
          errors.push(`Server "${target.serverName}" not found in ${target.mcpFilePath}`)
          continue
        }
        for (const { cfg: serverCfg } of scopes) {
          if (binding.headerName) {
            // Remote header binding: wire the headersHelper (rebuilt from ALL
            // header bindings for this server) and strip any plaintext header.
            applyHeadersHelper(
              serverCfg,
              headerBindingsForServer(target.mcpFilePath, target.serverName),
            )
          } else {
            if (!serverCfg.env) serverCfg.env = {}
            serverCfg.env[binding.envVar] = `vault:${vaultSecretId}`
            if (serverCfg.command && !serverCfg.url) wrapCommand(serverCfg)
          }
        }
        atomicWriteFileSync(target.mcpFilePath, JSON.stringify(content, null, 2))
        updated++
      } catch (err: any) {
        errors.push(`Failed to update ${target.mcpFilePath}: ${err.message}`)
      }
    }
  }

  if (updated > 0) logger.info({ vaultSecretId, updated }, 'Vault secret synced to .mcp.json files')
  return { updated, errors }
}

export function unsyncBinding(vaultSecretId: string, envVar: string): void {
  const all = getBindings()
  const bindings = all.filter(
    b => b.vaultSecretId === vaultSecretId && b.envVar === envVar,
  )
  // Header bindings are rebuilt from the set that survives this removal (the
  // binding is still in the store here; removeBinding runs afterwards).
  const remaining = all.filter(
    b => !(b.vaultSecretId === vaultSecretId && b.envVar === envVar),
  )
  for (const binding of bindings) {
    for (const target of binding.targets) {
      try {
        const content = JSON.parse(readFileOr(target.mcpFilePath, '{}'))
        const scopes = findServerScopes(content, target.serverName)
        if (scopes.length === 0) continue
        for (const { cfg: serverCfg } of scopes) {
          if (binding.headerName) {
            applyHeadersHelper(
              serverCfg,
              headerBindingsForServer(target.mcpFilePath, target.serverName, remaining),
            )
          } else {
            if (!serverCfg.env) continue
            delete serverCfg.env[envVar]
            if (!serverHasVaultRefs(serverCfg.env)) unwrapCommand(serverCfg)
          }
        }
        atomicWriteFileSync(target.mcpFilePath, JSON.stringify(content, null, 2))
      } catch { /* skip */ }
    }
  }
}

export function syncAllBindings(): SyncResult {
  const allBindings = getBindings()
  const secretIds = new Set(allBindings.map(b => b.vaultSecretId))
  let totalUpdated = 0
  const allErrors: string[] = []

  for (const id of secretIds) {
    const result = syncSecret(id)
    totalUpdated += result.updated
    allErrors.push(...result.errors)
  }
  return { updated: totalUpdated, errors: allErrors }
}

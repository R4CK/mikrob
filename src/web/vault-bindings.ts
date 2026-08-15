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

/**
 * Where a credential was found. Only `env` findings are auto-bindable: the vault wrapper injects an
 * environment variable, so a header- or arg-carried secret needs a human decision (usually: move it
 * behind headersHelper), and the UI must not offer a one-click "sync" that cannot work.
 */
export type CredentialCarrier = 'env' | 'headers' | 'args' | 'headersHelper'

export interface ScanFinding {
  mcpFilePath: string
  serverName: string
  envVar: string
  maskedValue: string
  suggestedVaultId: string
  alreadyInVault: boolean
  existingVaultId?: string
  /** Absent means `env` -- older callers predate the other three carriers. */
  carrier?: CredentialCarrier
  /** Human-readable spot inside the declaration, e.g. `headers.Authorization` or `args[3]`. */
  location?: string
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

/**
 * VALUE-shaped credential detection, for the carriers that have no key name worth reading.
 *
 * The env scan asks "is this key called something like a secret" (SENSITIVE_PATTERNS), which works
 * because env vars are SCREAMING_SNAKE and people name them honestly. That heuristic is useless one
 * layer over: header names are `Authorization`, `X-Api-Key`, `X-Auth-Token` -- every one of them
 * scores FALSE against patterns written for `_TOKEN$`/`_KEY$` -- and a CLI arg has no name at all.
 * So here the VALUE is the evidence: a known token shape, or something with the length and entropy
 * of a random string. Card 2f42a24d, from Cybersec's finding on 8763e412.
 */
const TOKEN_SHAPES = [
  /^sk-[A-Za-z0-9_-]{16,}$/,          // OpenAI-style
  /^re_[A-Za-z0-9_-]{16,}$/,          // Resend
  /^ghp_[A-Za-z0-9]{20,}$/,           // GitHub PAT (classic)
  /^github_pat_[A-Za-z0-9_]{20,}$/,   // GitHub PAT (fine-grained)
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,     // the rest of the GitHub family
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,   // Slack
  /^AKIA[0-9A-Z]{16}$/,               // AWS access key id
  /^AIza[A-Za-z0-9_-]{30,}$/,         // Google API key
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,  // JWT
]

/** Shannon entropy per character -- a random token sits around 4+, English prose around 2-3. */
function shannonEntropy(v: string): number {
  if (!v) return 0
  const freq = new Map<string, number>()
  for (const ch of v) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let bits = 0
  for (const n of freq.values()) {
    const p = n / v.length
    bits -= p * Math.log2(p)
  }
  return bits
}

const OPAQUE_TOKEN = /^[A-Za-z0-9+/=_.-]{24,}$/

/**
 * `model-context-protocol-server-filesystem` shaped: two or more separator-delimited segments that
 * are all plain lowercase words. Measured, not guessed -- entropy alone put that exact string above
 * a 3.5 threshold, so length+entropy on their own flag package names as credentials.
 */
function looksLikeWords(v: string): boolean {
  const parts = v.split(/[-._]/).filter(Boolean)
  return parts.length >= 2 && parts.every(p => /^[a-z]{3,}$/.test(p))
}

export function looksLikeCredentialValue(raw: string): boolean {
  const v = (raw ?? '').trim().replace(/^(Bearer|Basic|Token|ApiKey)\s+/i, '')
  if (!v) return false
  if (v.startsWith('${') || v.startsWith('vault:')) return false   // already a reference
  if (/^https?:\/\//.test(v) || v.startsWith('/') || v.startsWith('~/')) return false
  if (TOKEN_SHAPES.some(p => p.test(v))) return true
  // Nothing recognisable: fall back to shape. THREE conditions, because any two of them let
  // something through that measurably matters:
  //   length alone           -> every package path is a credential
  //   entropy alone          -> a six-character random string is one, a real 40-char key is not
  //   without class-mixing   -> `modelcontextprotocol-server-filesystem` scores 3.6 bits and passes
  if (!OPAQUE_TOKEN.test(v)) return false
  if (looksLikeWords(v)) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter(p => p.test(v)).length
  return classes >= 2 && shannonEntropy(v) >= 3.0
}

/**
 * A CLI arg or a helper command line can carry the secret embedded in a bigger string:
 *   --header "Authorization: Bearer <token>"      Authorization=Bearer:::ReSend      --key=<token>
 * so each whitespace-separated word is also tried without its `name=` / `name:` prefix. Both the
 * whole word and the suffix are tested rather than only the suffix, because base64 padding ends in
 * `=` and stripping there would truncate a real token into a shorter one.
 */
function credentialCandidates(text: string): string[] {
  const out: string[] = []
  for (const word of String(text ?? '').split(/[\s"'`,;]+/)) {
    if (!word) continue
    out.push(word)
    const eq = word.lastIndexOf('=')
    if (eq >= 0 && eq < word.length - 1) out.push(word.slice(eq + 1))
    const colon = word.lastIndexOf(':')
    if (colon >= 0 && colon < word.length - 1) out.push(word.slice(colon + 1))
  }
  return out
}

/**
 * `roots` exists so the scan can be pointed at a fixture directory in a test. Without it the only
 * way to check that the detector is WIRED -- rather than merely correct in isolation -- would be to
 * plant a fake credential in the live fleet config, which is the last place to put one.
 */
export function scanMcpConfigs(roots: McpFileRoots = {}): ScanFinding[] {
  const findings: ScanFinding[] = []
  const mcpFiles = collectAllMcpFilePaths(roots)
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
            carrier: 'env',
            location: `env.${envVar}`,
          })
        }

        // The other three carriers. `headers` is empty across every declaration today, which is the
        // reason to add it now rather than later: the scan going quiet on the NEXT remote server is
        // not something anyone would notice.
        const push = (carrier: CredentialCarrier, location: string, value: string): void => {
          const existingVaultId = vaultValues.get(value)
          findings.push({
            mcpFilePath: mcpPath,
            serverName,
            envVar: location,
            maskedValue: maskValue(value),
            suggestedVaultId: `${serverName}-${location.replace(/[^A-Za-z0-9]+/g, '-')}`,
            alreadyInVault: !!existingVaultId,
            existingVaultId,
            carrier,
            location,
          })
        }

        for (const [header, headerVal] of Object.entries(cfg?.headers ?? {}) as Array<[string, string]>) {
          if (looksLikeCredentialValue(String(headerVal))) {
            push('headers', `headers.${header}`, String(headerVal))
          }
        }

        const args: unknown[] = Array.isArray(cfg?.args) ? cfg.args : []
        args.forEach((arg, i) => {
          for (const candidate of credentialCandidates(String(arg))) {
            if (looksLikeCredentialValue(candidate)) {
              push('args', `args[${i}]`, candidate)
              return   // one finding per arg: the same token would otherwise report twice
            }
          }
        })

        if (typeof cfg?.headersHelper === 'string') {
          for (const candidate of credentialCandidates(cfg.headersHelper)) {
            if (looksLikeCredentialValue(candidate)) {
              push('headersHelper', 'headersHelper', candidate)
              break
            }
          }
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

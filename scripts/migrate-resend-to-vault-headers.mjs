#!/usr/bin/env node
// Move the `resend` MCP server off an environment variable and onto the vault headersHelper.
// Card 691f5475 / 8c623d0d / 93f1c3ce, after the RESEND_API_KEY leak (f8db701c).
//
// WHAT IT CHANGES, per config file, for the `resend` server wherever it is declared (top-level
// `mcpServers` AND `projects[<cwd>].mcpServers` -- the live fleet uses the latter):
//     headers: { Authorization: "Bearer ${RESEND_API_KEY}" }   ->   headersHelper: "<helper> Authorization=Bearer:::ReSend"
// so the secret is resolved from the vault at connection time and never has to exist in any
// agent session's environment.
//
// WHY A SCRIPT AND NOT THE DASHBOARD'S OWN vault-binding sync: that machinery only reads
// top-level `mcpServers` and only from .mcp.json paths, so it cannot see any of these 15 files
// (measured 2026-08-15). Teaching it both shapes is its own card (8763e412); this script is the
// migration, not the permanent mechanism.
//
// WHY ALL 15 FILES AND NOT JUST THE SHARED ONE: reconcileMcpServers (agent-process.ts) is additive
// and never overwrites an entry that already exists, so fixing ~/.claude.json alone would reach
// only brand-new agents. Measured, not assumed.
//
// Idempotent: a file already carrying the right headersHelper and no managed header is left alone.
// Default is a DRY RUN; pass --apply to write. Every write is atomic (tmp + rename) and verified by
// reading the file back and re-checking the shape, because these are live agent configs.
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HELPER = '/home/neon/marveen/scripts/vault-headers-helper.sh'
const VAULT_ID = 'ReSend'
const HEADER = 'Authorization'
const SCHEME = 'Bearer'
const EXPECTED_HELPER = `${HELPER} ${HEADER}=${SCHEME}:::${VAULT_ID}`
const AGENTS_DIR = '/home/neon/marveen/agents'

const apply = process.argv.includes('--apply')
// --only <substring>: restrict the run to matching paths. This exists so the rollout can be
// staged -- prove the change on ONE real fleet config before writing the other fourteen.
const onlyIdx = process.argv.indexOf('--only')
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null

function configPaths() {
  const paths = [join(homedir(), '.claude.json')]
  if (existsSync(AGENTS_DIR)) {
    for (const name of readdirSync(AGENTS_DIR).sort()) {
      const p = join(AGENTS_DIR, name, '.claude-config', '.claude.json')
      try {
        if (statSync(p).isFile()) paths.push(p)
      } catch {
        /* agent without an isolated config dir */
      }
    }
  }
  return paths.filter((p) => existsSync(p)).filter((p) => (only ? p.includes(only) : true))
}

/** Every place a server named `resend` is declared in one parsed config. */
function resendScopes(doc) {
  const out = []
  if (doc?.mcpServers?.resend) out.push({ scope: 'root', cfg: doc.mcpServers.resend })
  for (const [cwd, node] of Object.entries(doc?.projects ?? {})) {
    if (node?.mcpServers?.resend) out.push({ scope: `projects[${cwd}]`, cfg: node.mcpServers.resend })
  }
  return out
}

/** Returns 'already' | 'migrated' -- mutates cfg in place for the latter. */
function migrateOne(cfg) {
  const hadManagedHeader = typeof cfg.headers?.[HEADER] === 'string'
  if (cfg.headersHelper === EXPECTED_HELPER && !hadManagedHeader) return 'already'

  cfg.headersHelper = EXPECTED_HELPER
  if (cfg.headers) {
    delete cfg.headers[HEADER]
    if (Object.keys(cfg.headers).length === 0) delete cfg.headers
  }
  return 'migrated'
}

let changed = 0
let already = 0
const problems = []

for (const path of configPaths()) {
  let doc
  try {
    doc = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    problems.push(`${path}: unreadable/unparseable (${err.message})`)
    continue
  }

  const scopes = resendScopes(doc)
  if (scopes.length === 0) {
    console.log(`  --  ${path}: no resend server`)
    continue
  }

  const results = scopes.map((s) => `${s.scope}:${migrateOne(s.cfg)}`)
  const didChange = results.some((r) => r.endsWith(':migrated'))
  console.log(`  ${didChange ? (apply ? 'WRITE' : 'would') : ' ok  '} ${path}  [${results.join(', ')}]`)
  if (!didChange) {
    already++
    continue
  }
  changed++
  if (!apply) continue

  // Atomic write, then read back and re-check -- these files belong to running agents.
  const tmp = `${path}.migrate-tmp`
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n')
  renameSync(tmp, path)

  const after = JSON.parse(readFileSync(path, 'utf-8'))
  for (const s of resendScopes(after)) {
    if (s.cfg.headersHelper !== EXPECTED_HELPER) problems.push(`${path} ${s.scope}: headersHelper missing after write`)
    if (typeof s.cfg.headers?.[HEADER] === 'string') problems.push(`${path} ${s.scope}: ${HEADER} header still present after write`)
  }
}

console.log(`\n${apply ? 'written' : 'would change'}: ${changed}, already migrated: ${already}`)
if (problems.length > 0) {
  console.log('PROBLEMS:')
  for (const p of problems) console.log('  -', p)
  process.exitCode = 1
} else if (!apply) {
  console.log('(dry run -- pass --apply to write)')
}

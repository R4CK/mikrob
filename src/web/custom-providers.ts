// customProvider registry (card f1800242, B-part -- A-part was 96c00ee5's
// readAgentCustomProvider/writeAgentCustomProvider per-agent string field).
//
// Peti's decision (Telegram 10874, 2026-10-10): "Szukitve mehet" -- a custom
// provider base-url may ONLY point at a loopback endpoint (127.0.0.0/8, ::1,
// or the literal host "localhost" -- e.g. Ollama, LM Studio). No external,
// paid API base-url may be registered. This is the SAME reasoning as the
// MiniMax NO-GO (card 48565f81, CLAUDE.md rule 17): a custom provider that
// could reach a paid online endpoint would re-open exactly the door Peti
// closed there.
//
// isLoopbackHost() deliberately never resolves a hostname via DNS: a synchronous,
// fail-closed check cannot safely use dns.lookup() (async, and the OS resolver is
// exactly what a DNS-rebinding attack controls). Only a literal loopback IP or the
// exact string "localhost" is accepted -- "localhost.evil.com", "0.0.0.0", and any
// other hostname are rejected outright, never resolved.
import { existsSync, readFileSync } from 'node:fs'
import { isIPv4, isIPv6 } from 'node:net'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

export type CustomProviderDef = {
  id: string
  baseUrl: string
  /** Vault key id (see getSecret/launchSecretRef in agent-process.ts) holding the auth token. */
  secretId: string
}

export class CustomProviderValidationError extends Error {}

function isLoopbackHost(hostnameRaw: string): boolean {
  // The WHATWG URL parser keeps IPv6 hostnames bracketed ("[::1]") and normalizes an IPv4-mapped
  // address to compressed hex groups ("::ffff:127.0.0.1" -> "::ffff:7f00:1"), never dotted-quad --
  // measured directly (node -e), not assumed.
  const hostname = hostnameRaw.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost') return true
  if (isIPv4(hostname)) return hostname.startsWith('127.')
  if (isIPv6(hostname)) {
    if (hostname === '::1') return true
    // IPv4-mapped IPv6: the first hex group (left-padded to 4 digits) is the address's first two
    // octets, so "7f.." is the 127.0.0.0/8 mapping regardless of the second group's value.
    const mapped = hostname.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/)
    return !!mapped && mapped[1].padStart(4, '0').startsWith('7f')
  }
  return false
}

/** Fail-closed: throws on anything that is not a loopback http(s) URL. Never returns false. */
export function assertLoopbackBaseUrl(baseUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new CustomProviderValidationError(`custom provider baseUrl is not a valid URL: ${baseUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CustomProviderValidationError(`custom provider baseUrl must be http or https: ${baseUrl}`)
  }
  // URL strips IPv6 brackets into hostname already (e.g. "[::1]" -> "::1").
  if (!isLoopbackHost(parsed.hostname)) {
    throw new CustomProviderValidationError(
      `custom provider baseUrl must point at a loopback host (127.0.0.0/8, ::1, or "localhost"), got "${parsed.hostname}"`,
    )
  }
}

function validateDef(raw: unknown): CustomProviderDef {
  if (typeof raw !== 'object' || raw === null) {
    throw new CustomProviderValidationError('custom provider entry is not an object')
  }
  const d = raw as Record<string, unknown>
  if (typeof d.id !== 'string' || !d.id.trim()) {
    throw new CustomProviderValidationError('custom provider entry is missing "id"')
  }
  if (typeof d.baseUrl !== 'string' || !d.baseUrl.trim()) {
    throw new CustomProviderValidationError(`custom provider '${d.id}' is missing "baseUrl"`)
  }
  if (typeof d.secretId !== 'string' || !d.secretId.trim()) {
    throw new CustomProviderValidationError(`custom provider '${d.id}' is missing "secretId"`)
  }
  assertLoopbackBaseUrl(d.baseUrl)
  return { id: d.id.trim(), baseUrl: d.baseUrl.trim(), secretId: d.secretId.trim() }
}

const CUSTOM_PROVIDERS_PATH = join(PROJECT_ROOT, 'store', 'custom-providers.json')

/**
 * Reads the registry, re-validating every entry (fail-closed against a hand-edited or
 * fleet-transfer-imported file bypassing writeCustomProviders' own validation -- WhiteHat L3,
 * card f1800242 comment: "the stored value is not trustworthy, so the READ site must re-check").
 * Throws on a corrupt file or ANY invalid entry, rather than silently dropping the bad one and
 * returning the rest: a partially-trusted registry is not a safe thing to launch an agent against.
 */
export function listCustomProviders(): CustomProviderDef[] {
  if (!existsSync(CUSTOM_PROVIDERS_PATH)) return []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(CUSTOM_PROVIDERS_PATH, 'utf8'))
  } catch {
    throw new CustomProviderValidationError('custom-providers.json is not valid JSON')
  }
  const list = (raw as { providers?: unknown })?.providers
  if (!Array.isArray(list)) {
    throw new CustomProviderValidationError('custom-providers.json: "providers" is not an array')
  }
  const defs = list.map(validateDef)
  const seen = new Set<string>()
  for (const def of defs) {
    if (seen.has(def.id)) throw new CustomProviderValidationError(`custom-providers.json: duplicate id "${def.id}"`)
    seen.add(def.id)
  }
  return defs
}

/** Validates every entry (fail-closed, same rule as listCustomProviders) BEFORE writing any of
 *  them -- a bad entry never reaches disk, "mentéskor" validation per Peti's decision. */
export function writeCustomProviders(defs: CustomProviderDef[]): void {
  const validated = defs.map(validateDef)
  const seen = new Set<string>()
  for (const def of validated) {
    if (seen.has(def.id)) throw new CustomProviderValidationError(`duplicate id "${def.id}"`)
    seen.add(def.id)
  }
  atomicWriteFileSync(CUSTOM_PROVIDERS_PATH, JSON.stringify({ providers: validated }, null, 2))
}

/** Fail-closed lookup: throws (never returns null/undefined) when the id is not registered, so a
 *  caller can never silently treat an unknown custom provider as "no custom provider". */
export function getCustomProviderOrThrow(id: string): CustomProviderDef {
  const def = listCustomProviders().find((p) => p.id === id)
  if (!def) throw new CustomProviderValidationError(`custom provider '${id}' is not registered`)
  return def
}

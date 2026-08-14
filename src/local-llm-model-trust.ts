// The publisher-trust decision for "make this model the fleet default", shared by both doors.
//
// WHY THIS FILE EXISTS. The decision used to live only in store/first-run-llm.sh, so the dashboard's
// "use this model" button (POST /api/local-llm/model) reached the same end state -- store/local-llm-model,
// the file every agent's drafts are produced by -- while checking nothing but the model name and
// whether ollama had it. One guarded door and one unguarded door onto the same resource is not a
// control; it is a control plus a bypass.
//
// The rules here are deliberately the SAME rules the script applies, in the same order, because two
// implementations that drift are worse than one door:
//   1. The reviewed list decides. store/llm-catalog-trust.json is tracked and review-gated; the
//      `trusted` boolean inside llm-catalog-cache.json is a build-time snapshot in a gitignored,
//      agent-writable file, and is NEVER read here. That flag being authoritative was the defect
//      that made revocation a no-op (card eb843c46).
//   2. Facts come from the cache -- owner, downloads, parts, digests -- because facts are what a
//      cache is for.
//   3. Missing or unreadable trust list means NOT trusted. Fail closed.
//   4. No catalogue entry is weaker than an untrusted publisher, not stronger: no provenance at
//      all. It gates too, and the confirmation answer is the model tag (which varies) rather than
//      a constant every operator would memorise once.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export type DigestVerdict = 'ok' | 'mismatch' | 'not-possible'

export interface ModelTrustBasis {
  /** True only when the reviewed list currently names this publisher. */
  trusted: boolean
  /** Publisher from the catalogue, or 'unverified' when there is no entry at all. */
  owner: string
  downloads: number | null
  parts: { path: string; sha256: string | null }[]
  /** 'ok' = every part present with the catalogued digest. 'not-possible' = nothing to compare. */
  digest: DigestVerdict
  /** Parts that are absent or carry no digest -- named so a refusal can say which. */
  missing: string[]
  /** What an operator has to name back to override: the publisher, or the tag when unknown. */
  confirmWith: string
}

interface CatalogueEntry {
  installRef?: string
  repoOwner?: string
  downloads?: number
  parts?: { path?: string; sha256?: string }[]
}

function readTrustedPublishers(trustFile: string): Set<string> {
  try {
    const doc = JSON.parse(readFileSync(trustFile, 'utf-8')) as { trustedPublishers?: unknown }
    if (!Array.isArray(doc.trustedPublishers)) return new Set()
    return new Set(doc.trustedPublishers.map((p) => String(p).trim().toLowerCase()).filter(Boolean))
  } catch {
    // Unreadable, absent, or malformed: no trust. The alternative -- treating an unparseable file
    // as "everything is fine" -- turns a typo into a fleet-wide bypass.
    return new Set()
  }
}

function findEntry(cacheFile: string, model: string): CatalogueEntry | null {
  try {
    const doc = JSON.parse(readFileSync(cacheFile, 'utf-8')) as { models?: CatalogueEntry[] }
    return (doc.models || []).find((m) => m.installRef === model) ?? null
  } catch {
    return null
  }
}

export function decideModelTrust(opts: {
  model: string
  cacheFile: string
  trustFile: string
  blobsDir: string
}): ModelTrustBasis {
  const publishers = readTrustedPublishers(opts.trustFile)
  const entry = findEntry(opts.cacheFile, opts.model)

  if (!entry) {
    return {
      trusted: false,
      owner: 'unverified',
      downloads: null,
      parts: [],
      digest: 'not-possible',
      missing: [],
      confirmWith: opts.model,
    }
  }

  const owner = (entry.repoOwner || 'unknown').trim()
  const parts = (entry.parts || []).map((p) => ({ path: p.path || '?', sha256: p.sha256 || null }))
  // An empty parts list must not report a successful digest check: "nothing failed" and "everything
  // matched" are different claims, and the confident one would lend authority to a hand-written
  // cache entry. Same reasoning as the script's no-parts branch.
  let digest: DigestVerdict = 'not-possible'
  let missing: string[] = []
  if (parts.length > 0) {
    missing = parts
      .filter((p) => !p.sha256 || !existsSync(join(opts.blobsDir, `sha256-${p.sha256}`)))
      .map((p) => p.path)
    digest = missing.length === 0 ? 'ok' : 'mismatch'
  }

  return {
    trusted: publishers.has(owner.toLowerCase()),
    owner,
    downloads: typeof entry.downloads === 'number' ? entry.downloads : null,
    parts,
    digest,
    missing,
    confirmWith: owner,
  }
}

/** Case-insensitive, trimmed: the answer is a name to be read off a screen, not a token. */
export function confirmationMatches(basis: ModelTrustBasis, answer: string | undefined): boolean {
  if (!answer) return false
  return answer.trim().toLowerCase() === basis.confirmWith.trim().toLowerCase()
}

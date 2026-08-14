// Both doors onto store/local-llm-model must apply the same trust decision (card eb843c46).
//
// The defect this file exists for: the dashboard's "use this model" button (POST
// /api/local-llm/model) validated the model NAME and asked ollama whether the file was downloaded,
// then wrote the fleet default. The CLI door (store/first-run-llm.sh --use) refused unreviewed
// publishers and digest mismatches. Same destination, two rule sets -- so the strict one was
// advisory, and the operator using the CLI believed a control existed that a single POST walked
// around.
//
// Tests come in two layers because the failure modes are different:
//   - decideModelTrust: the decision itself, including the cache-versus-list direction that made
//     revocation a no-op.
//   - the route: that the decision is actually WIRED to the write, which is exactly what was
//     missing before. A correct decision function nothing calls would reproduce the bug.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'llm-model-trust-'))
const SANDBOX_STORE = join(tmpRoot, 'store')
const BLOBS = join(tmpRoot, 'blobs')
mkdirSync(SANDBOX_STORE, { recursive: true })
mkdirSync(BLOBS, { recursive: true })
process.env.FIRST_RUN_BLOBS = BLOBS

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot, STORE_DIR: SANDBOX_STORE }
})

const { decideModelTrust, confirmationMatches } = await import('../local-llm-model-trust.js')
const { tryHandleLocalLlm } = await import('../web/routes/local-llm.js')

const TRUSTED = 'hf.co/Qwen/Good-GGUF:Q4_K_M'
const UNTRUSTED = 'hf.co/Sketchy/Thing-GGUF:Q4_K_M'
const OID_T = `aaaa${'0'.repeat(56)}1111`
const OID_U = `bbbb${'0'.repeat(56)}2222`
const CACHE = join(SANDBOX_STORE, 'llm-catalog-cache.json')
const TRUST = join(SANDBOX_STORE, 'llm-catalog-trust.json')
const MODEL_FILE = join(SANDBOX_STORE, 'local-llm-model')

/** `cachedTrusted` is set to the OPPOSITE of the truth on purpose in the drift tests: the cached
 *  boolean must not influence anything. */
function writeCache(entries: { ref: string; owner: string; oid: string | null; downloads?: number; cachedTrusted?: boolean }[]): void {
  writeFileSync(
    CACHE,
    JSON.stringify({
      schemaVersion: 1,
      models: entries.map((e) => ({
        installRef: e.ref,
        repo: e.ref,
        repoOwner: e.owner,
        downloads: e.downloads ?? 5,
        trusted: e.cachedTrusted ?? false,
        parts: e.oid === null ? [] : [{ path: 'weights.gguf', sha256: e.oid }],
      })),
    }),
  )
}

function writeTrust(publishers: string[] | null): void {
  if (publishers === null) {
    rmSync(TRUST, { force: true })
    return
  }
  writeFileSync(TRUST, JSON.stringify({ trustedPublishers: publishers }))
}

function decide(model: string) {
  return decideModelTrust({ model, cacheFile: CACHE, trustFile: TRUST, blobsDir: BLOBS })
}

beforeEach(() => {
  writeFileSync(join(BLOBS, `sha256-${OID_T}`), '')
  writeFileSync(join(BLOBS, `sha256-${OID_U}`), '')
  writeCache([
    { ref: TRUSTED, owner: 'Qwen', oid: OID_T, downloads: 91234, cachedTrusted: true },
    { ref: UNTRUSTED, owner: 'Sketchy', oid: OID_U, downloads: 12, cachedTrusted: false },
  ])
  writeTrust(['qwen'])
  rmSync(MODEL_FILE, { force: true })
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('decideModelTrust', () => {
  it('trusts a publisher the reviewed list names', () => {
    const b = decide(TRUSTED)
    expect(b.trusted).toBe(true)
    expect(b.owner).toBe('Qwen')
    expect(b.digest).toBe('ok')
  })

  it('does not trust a publisher the list omits, whatever the cache says', () => {
    writeCache([{ ref: UNTRUSTED, owner: 'Sketchy', oid: OID_U, cachedTrusted: true }])
    expect(decide(UNTRUSTED).trusted).toBe(false)
  })

  it('trusts a listed publisher even when the cache says otherwise', () => {
    // The other direction. Without this, "always return false" would pass the test above.
    writeCache([{ ref: TRUSTED, owner: 'Qwen', oid: OID_T, cachedTrusted: false }])
    expect(decide(TRUSTED).trusted).toBe(true)
  })

  it('revocation takes effect immediately, with no catalogue rebuild', () => {
    writeTrust([])
    expect(decide(TRUSTED).trusted).toBe(false)
  })

  it('a missing or malformed trust list means NOT trusted', () => {
    writeTrust(null)
    expect(decide(TRUSTED).trusted).toBe(false)
    writeFileSync(TRUST, '{ this is not json')
    expect(decide(TRUSTED).trusted).toBe(false)
  })

  it('reports a digest mismatch when a blob is absent', () => {
    rmSync(join(BLOBS, `sha256-${OID_U}`), { force: true })
    const b = decide(UNTRUSTED)
    expect(b.digest).toBe('mismatch')
    expect(b.missing).toEqual(['weights.gguf'])
  })

  it('an empty parts list is "not possible", never "ok"', () => {
    writeCache([{ ref: UNTRUSTED, owner: 'Sketchy', oid: null }])
    expect(decide(UNTRUSTED).digest).toBe('not-possible')
  })

  it('no catalogue entry gates, and the confirmation answer is the model tag', () => {
    writeCache([])
    const b = decide(UNTRUSTED)
    expect(b.trusted).toBe(false)
    expect(b.owner).toBe('unverified')
    expect(b.confirmWith).toBe(UNTRUSTED)
    expect(confirmationMatches(b, 'unverified')).toBe(false)
    expect(confirmationMatches(b, UNTRUSTED)).toBe(true)
  })

  it('the confirmation is a name, so case and padding do not matter', () => {
    const b = decide(UNTRUSTED)
    expect(confirmationMatches(b, '  sKeTcHy ')).toBe(true)
    expect(confirmationMatches(b, 'Qwen')).toBe(false)
    expect(confirmationMatches(b, undefined)).toBe(false)
  })
})

describe('GET /api/local-llm/catalog labels trust from the reviewed list', () => {
  // The badge and the gate must give the same answer. Rendering the cached flag meant a publisher
  // dropped after an incident still showed as trusted until someone rebuilt the catalogue -- the UI
  // telling the operator "fine" one click before the gate refuses them.
  function get(): Promise<{ status: number; body: any }> {
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = {
      writeHead(status: number) { out.status = status; return res },
      end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    }
    const url = new URL('http://localhost:3420/api/local-llm/catalog')
    const ctx = { req: {} as any, res, path: url.pathname, method: 'GET', url } as unknown as RouteContext
    return tryHandleLocalLlm(ctx).then(() => out)
  }

  it('a revoked publisher is labelled unverified even while the cache says trusted', async () => {
    writeCache([{ ref: TRUSTED, owner: 'Qwen', oid: OID_T, cachedTrusted: true }])
    writeTrust([])
    const r = await get()
    const m = r.body.models.find((x: any) => x.installRef === TRUSTED)
    expect(m.trusted).toBe(false)
    expect(m.trustReason).toBe('unverified')
  })

  it('a listed publisher is labelled trusted even while the cache says otherwise', async () => {
    writeCache([{ ref: TRUSTED, owner: 'Qwen', oid: OID_T, cachedTrusted: false }])
    writeTrust(['qwen'])
    const r = await get()
    const m = r.body.models.find((x: any) => x.installRef === TRUSTED)
    expect(m.trusted).toBe(true)
    expect(m.trustReason).toBe('allowlisted-publisher')
  })
})

describe('POST /api/local-llm/model applies the same decision as the CLI door', () => {
  function post(body: unknown): Promise<{ status: number; body: any }> {
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = {
      writeHead(status: number) { out.status = status; return res },
      end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    }
    // Buffer chunks, not strings: readBody concatenates them as Buffers, and a string chunk throws
    // ERR_INVALID_ARG_TYPE inside the route rather than failing an assertion.
    const req: any = Readable.from([Buffer.from(JSON.stringify(body))])
    req.headers = {}
    const url = new URL('http://localhost:3420/api/local-llm/model')
    const ctx = { req, res, path: url.pathname, method: 'POST', url } as unknown as RouteContext
    return tryHandleLocalLlm(ctx).then(() => out)
  }

  // The runtime is stubbed at fetch level rather than by pointing the route somewhere else: the
  // test must not depend on whether this host happens to be running ollama, and production code
  // gains no test-only branch.
  beforeEach(() => {
    vi.stubGlobal('fetch', async (u: string) =>
      String(u).endsWith('/api/tags')
        ? new Response(JSON.stringify({ models: [{ name: TRUSTED }, { name: UNTRUSTED }] }), { status: 200 })
        : new Response('null', { status: 200 }),
    )
  })

  it('writes the default for a trusted publisher', async () => {
    const r = await post({ model: TRUSTED })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(readFileSync(MODEL_FILE, 'utf-8').trim()).toBe(TRUSTED)
  })

  it('REFUSES an untrusted publisher instead of writing -- this was the bypass', async () => {
    const r = await post({ model: UNTRUSTED })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('publisher_not_trusted')
    expect(existsSync(MODEL_FILE)).toBe(false)
  })

  it('returns what the decision rests on, so a confirmation can show it', async () => {
    const r = await post({ model: UNTRUSTED })
    expect(r.body.confirmWith).toBe('Sketchy')
    expect(r.body.basis.owner).toBe('Sketchy')
    expect(r.body.basis.downloads).toBe(12)
    // Full digest, not a prefix: a truncated one cannot be compared against anything.
    expect(r.body.basis.parts[0].sha256).toBe(OID_U)
  })

  it('accepts an untrusted publisher only when the caller names it back', async () => {
    const wrong = await post({ model: UNTRUSTED, iTrust: 'Qwen' })
    expect(wrong.status).toBe(403)
    expect(existsSync(MODEL_FILE)).toBe(false)

    const right = await post({ model: UNTRUSTED, iTrust: 'sketchy' })
    expect(right.status, JSON.stringify(right.body)).toBe(200)
    expect(readFileSync(MODEL_FILE, 'utf-8').trim()).toBe(UNTRUSTED)
  })

  it('a digest mismatch cannot be confirmed away', async () => {
    // No override exists for this one, in either door: the bytes on disk are not the bytes that
    // were catalogued, so there is nothing to knowingly consent to.
    rmSync(join(BLOBS, `sha256-${OID_U}`), { force: true })
    const r = await post({ model: UNTRUSTED, iTrust: 'sketchy' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('digest_mismatch')
    expect(existsSync(MODEL_FILE)).toBe(false)
  })

  it('revoking a publisher blocks the dashboard door too', async () => {
    writeTrust([])
    const r = await post({ model: TRUSTED })
    expect(r.status).toBe(403)
    expect(existsSync(MODEL_FILE)).toBe(false)
  })
})

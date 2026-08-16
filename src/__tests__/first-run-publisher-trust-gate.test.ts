// The publisher-trust gate on `first-run-llm.sh --use` (card eb843c46, EPIC ebc7b4dd / T2).
//
// The digest control that shipped before this one answers "are these the bytes we catalogued". The
// question it cannot answer is whether the PUBLISHER should be trusted with the job, because a
// faithfully delivered backdoor matches its own digest. So trust is a separate decision, made
// against store/llm-catalog-trust.json -> trustedPublishers, and for anyone outside that list it is
// the operator's decision rather than the script's.
//
// THESE ARE BEHAVIOURAL TESTS, not source greps. The gate is exercised by actually running the
// script against a sandbox copy of store/ and a stub runtime, because the failure mode worth
// catching is "the gate exists in the file but something reaches the write anyway".
//
// Every case asserts the MODEL FILE, not just the exit code: the property under test is whether an
// untrusted model became the fleet default, and an exit code is only a proxy for that.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync, mkdtempSync, copyFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decideModelTrust } from '../local-llm-model-trust.js'

const ROOT = join(__dirname, '..', '..')
const TRUSTED_REF = 'hf.co/Qwen/Good-GGUF:Q4_K_M'
const UNTRUSTED_REF = 'hf.co/Sketchy/Thing-GGUF:Q4_K_M'
const OID_TRUSTED = `aaaa${'0'.repeat(56)}1111`
const OID_UNTRUSTED = `bbbb${'0'.repeat(56)}2222`

// FAST, SPECIFIC FAILURE FIRST. A single stray apostrophe inside the python3 -c '...' block this
// script embeds closes bash's surrounding single quote early and the whole file fails to PARSE --
// every case below then fails too, but as five loosely-related-looking assertion mismatches instead
// of one "syntax error near unexpected token" (Cybersec, card d7220a73: exactly this happened from a
// comment reading "store/llm-catalog.py's own", the same apostrophe-in-a-single-quoted-shell-string
// class already pinned once this session in gpu-detect.sh). This check names the actual defect.
it('store/first-run-llm.sh is syntactically valid bash', () => {
  const r = spawnSync('bash', ['-n', join(ROOT, 'store', 'first-run-llm.sh')], { encoding: 'utf-8' })
  expect(r.status, r.stderr).toBe(0)
})

let sandbox: string
let server: ChildProcess
let host: string

/** The catalogue the gate reads for FACTS. Note what the `trusted` flag is doing in here: it is
 *  set to the OPPOSITE of the truth in the two cache-versus-list tests below, because the whole
 *  point after Cybersec F1 is that this cached boolean no longer decides anything. */
function writeCatalogue(withUntrusted: boolean, cachedTrustedOverrides: Record<string, boolean> = {}): void {
  const models: unknown[] = [
    {
      installRef: TRUSTED_REF,
      repo: 'Qwen/Good-GGUF',
      repoOwner: 'Qwen',
      downloads: 91234,
      trusted: cachedTrustedOverrides[TRUSTED_REF] ?? true,
      parts: [{ path: 'good-q4_k_m.gguf', sha256: OID_TRUSTED }],
    },
  ]
  if (withUntrusted) {
    models.push({
      installRef: UNTRUSTED_REF,
      repo: 'Sketchy/Thing-GGUF',
      repoOwner: 'Sketchy',
      downloads: 12,
      trusted: cachedTrustedOverrides[UNTRUSTED_REF] ?? false,
      parts: [{ path: 'thing-q4_k_m.gguf', sha256: OID_UNTRUSTED }],
    })
  }
  writeFileSync(join(sandbox, 'llm-catalog-cache.json'), JSON.stringify({ schemaVersion: 1, models }))
}

/** The REVIEWED list -- tracked in git, and the only thing allowed to decide trust. */
function writeTrustList(publishers: string[] | null): void {
  const p = join(sandbox, 'llm-catalog-trust.json')
  if (publishers === null) {
    rmSync(p, { force: true })
    return
  }
  writeFileSync(p, JSON.stringify({ trustedPublishers: publishers, relevantFamilies: [], relevanceKeywords: [] }))
}

function use(args: string[]): { code: number; out: string; modelFile: string } {
  const r = spawnSync('bash', [join(sandbox, 'first-run-llm.sh'), '--use', ...args], {
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, OLLAMA_HOST: host, FIRST_RUN_BLOBS: join(sandbox, 'blobs') },
  })
  const modelFilePath = join(sandbox, 'local-llm-model')
  return {
    code: r.status ?? -1,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    modelFile: existsSync(modelFilePath) ? readFileSync(modelFilePath, 'utf-8').trim() : '',
  }
}

function clearModelFile(): void {
  rmSync(join(sandbox, 'local-llm-model'), { force: true })
}

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'first-run-trust-'))
  // The script resolves everything from its own directory, so a copy IS the sandbox -- no new
  // environment knobs had to be added to the production script to make it testable.
  copyFileSync(join(ROOT, 'store', 'first-run-llm.sh'), join(sandbox, 'first-run-llm.sh'))
  mkdirSync(join(sandbox, 'blobs'))
  // Content-addressed blobs named exactly as the digest check expects, so the digest control PASSES
  // in every case below. That isolation matters: a refusal has to come from the trust gate, not
  // from a digest mismatch that would have refused anyway.
  writeFileSync(join(sandbox, 'blobs', `sha256-${OID_TRUSTED}`), '')
  writeFileSync(join(sandbox, 'blobs', `sha256-${OID_UNTRUSTED}`), '')
  writeCatalogue(true)
  writeTrustList(['qwen'])

  // THE STUB RUNTIME MUST BE ITS OWN PROCESS. An in-process http server cannot answer these
  // requests: every case below drives the script with spawnSync, which blocks this thread's event
  // loop, so the server would never get to reply and the script would exit 3 ("runtime not
  // answering") before reaching the gate at all. Every test would then fail for the wrong reason.
  const tags = JSON.stringify({ models: [{ name: TRUSTED_REF }, { name: UNTRUSTED_REF }] })
  const stub = join(sandbox, 'stub-runtime.js')
  writeFileSync(
    stub,
    `const http = require('node:http')
const body = ${JSON.stringify(tags)}
http.createServer((_q, s) => {
  s.writeHead(200, { 'Content-Type': 'application/json' })
  s.end(body)
}).listen(0, '127.0.0.1', function () { console.log(this.address().port) })
`,
  )
  server = spawn(process.execPath, [stub], { stdio: ['ignore', 'pipe', 'ignore'] })
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stub runtime never reported a port')), 15_000)
    server.stdout?.once('data', (d: Buffer) => {
      clearTimeout(timer)
      resolve(d.toString().trim())
    })
  })
  host = `http://127.0.0.1:${port}`
})

afterAll(() => {
  server.kill()
  rmSync(sandbox, { recursive: true, force: true })
})

// STATE IS SET UP BEFORE EACH TEST, NOT RESTORED AFTER. Found while mutation-testing this file: the
// restore-at-the-end version left the sandbox dirty whenever a test failed, and the next two tests
// then passed FOR THE WRONG REASON off that leftover state -- they were green under a mutation that
// should have broken them. A test that only cleans up when it succeeds provides no isolation
// exactly when isolation matters.
beforeEach(() => {
  writeCatalogue(true)
  writeTrustList(['qwen'])
  clearModelFile()
})

describe('first-run-llm.sh --use: publisher trust gate', () => {
  it('a trusted publisher passes straight through -- no new friction where there is no new risk', () => {
    clearModelFile()
    const r = use([TRUSTED_REF])
    expect(r.code, r.out).toBe(0)
    expect(r.modelFile).toBe(TRUSTED_REF)
    // The NEGATIVE CONTROL for the whole gate. Without it, a gate that fired on everything would
    // pass every other test in this file while making the trusted path unusable.
    expect(r.out).not.toContain('UNTRUSTED PUBLISHER')
  })

  it('an untrusted publisher does NOT become the fleet default', () => {
    clearModelFile()
    const r = use([UNTRUSTED_REF])
    expect(r.code, r.out).toBe(7)
    expect(r.modelFile).toBe('')
  })

  it('the refusal shows what the decision rests on: publisher, downloads and the FULL digest', () => {
    clearModelFile()
    const { out } = use([UNTRUSTED_REF])
    expect(out).toContain('Sketchy')
    expect(out).toContain('12') // downloads -- an unknown-popularity repo is part of the picture
    // Not a prefix: a truncated digest cannot be compared against anything, so the screen carries
    // the whole 64 hex characters.
    expect(out).toContain(OID_UNTRUSTED)
    // ...and it must name the way forward, or a fail-closed control is just a dead end.
    expect(out).toContain(`--i-trust Sketchy`)
  })

  it('naming the WRONG publisher is refused -- the answer has to come from the screen', () => {
    clearModelFile()
    const r = use([UNTRUSTED_REF, '--i-trust', 'Qwen'])
    expect(r.code, r.out).toBe(7)
    expect(r.modelFile).toBe('')
  })

  it('naming the right publisher accepts it, and the acceptance is logged', () => {
    clearModelFile()
    const r = use([UNTRUSTED_REF, '--i-trust', 'sketchy']) // case-insensitive: it is a name, not a token
    expect(r.code, r.out).toBe(0)
    expect(r.modelFile).toBe(UNTRUSTED_REF)
    const log = readFileSync(join(sandbox, 'first-run-llm.log'), 'utf-8')
    expect(log).toMatch(/untrusted default ACCEPTED: .*Sketchy/)
  })

  it('a model with no catalogue entry gates too, and the answer is the MODEL TAG, not a constant', () => {
    // Cybersec F3: while the required answer was the literal "unverified" for every entry-less
    // model, the case with the least information had the most memorisable password. The answer is
    // now the tag, which differs per model -- so it still has to be read off the screen.
    clearModelFile()
    writeCatalogue(false)
    const r = use([UNTRUSTED_REF])
    expect(r.code, r.out).toBe(7)
    expect(r.modelFile).toBe('')
    expect(r.out).toContain(`--i-trust ${UNTRUSTED_REF}`)
    expect(r.out).not.toContain('--i-trust unverified')

    // The old constant must no longer work...
    const stale = use([UNTRUSTED_REF, '--i-trust', 'unverified'])
    expect(stale.code, stale.out).toBe(7)
    expect(stale.modelFile).toBe('')

    // ...and the tag must.
    const ok = use([UNTRUSTED_REF, '--i-trust', UNTRUSTED_REF])
    expect(ok.code, ok.out).toBe(0)
    expect(ok.modelFile).toBe(UNTRUSTED_REF)
  })

  it('an entry with NO parts does not get a confident "digest check: OK"', () => {
    // Cybersec F2: an empty parts list produced no mismatches, so the script announced that every
    // part matched -- a confident security claim about something it never checked. Reachable only
    // via a hand-written cache today, which is exactly the case where that reassurance would be
    // read as corroboration of a bypass.
    clearModelFile()
    writeFileSync(
      join(sandbox, 'llm-catalog-cache.json'),
      JSON.stringify({
        schemaVersion: 1,
        models: [{ installRef: TRUSTED_REF, repo: 'Qwen/Good-GGUF', repoOwner: 'Qwen', downloads: 1, trusted: true, parts: [] }],
      }),
    )
    const r = use([TRUSTED_REF])
    expect(r.out).not.toContain('digest check: OK')
    expect(r.out).toContain('digest check: NOT POSSIBLE')
  })

  describe('the decision comes from the reviewed list, not the cached flag (Cybersec F1)', () => {
    // The defect this replaced: the gate read the `trusted` boolean stored in the gitignored,
    // agent-writable llm-catalog-cache.json, frozen at catalogue-build time. Flipping only that
    // flag walked past the gate entirely, and removing a publisher from the reviewed list had no
    // effect on anything already cached -- a control that could be edited but not enforced.
    it('a cached trusted:true does NOT pass a publisher who is off the list', () => {
      clearModelFile()
      writeCatalogue(true, { [UNTRUSTED_REF]: true }) // the cache lies in the dangerous direction
      writeTrustList(['qwen']) // ...and Sketchy is still not on the reviewed list
      const r = use([UNTRUSTED_REF])
      expect(r.code, r.out).toBe(7)
      expect(r.modelFile).toBe('')
    })

    it('a cached trusted:false does NOT block a publisher who IS on the list', () => {
      // The other direction matters just as much: revocation must work, but so must the ordinary
      // path. A gate that ignored the cache by always refusing would pass the test above.
      clearModelFile()
      writeCatalogue(true, { [TRUSTED_REF]: false })
      writeTrustList(['qwen'])
      const r = use([TRUSTED_REF])
      expect(r.code, r.out).toBe(0)
      expect(r.modelFile).toBe(TRUSTED_REF)
      expect(r.out).not.toContain('UNTRUSTED PUBLISHER')
    })

    it('revoking a publisher takes effect immediately, without rebuilding the catalogue', () => {
      clearModelFile()
      writeTrustList([]) // incident: Qwen removed from the reviewed list
      const r = use([TRUSTED_REF]) // the cache still says trusted:true
      expect(r.code, r.out).toBe(7)
      expect(r.modelFile).toBe('')
    })

    it('a missing trust list means NOT trusted, not "trust everything"', () => {
      clearModelFile()
      writeTrustList(null)
      const r = use([TRUSTED_REF])
      expect(r.code, r.out).toBe(7)
      expect(r.modelFile).toBe('')
    })
  })

  describe('the two doors agree, case by case', () => {
    // Cybersec's objection to fixing the HTTP door with its own copy of the rules was that two
    // implementations drift -- which is exactly what this card is about. Their suggestion was for
    // the route to shell out to this script. I kept a shared decision module instead (no subprocess
    // on a request path, and a structured basis the UI can render rather than human-readable
    // stdout), which makes the drift risk real and worth MEASURING rather than promising.
    //
    // So: the same scenario matrix, run through the script (exit code) and through the module the
    // HTTP door uses (decision object). They must agree on every row. If someone edits one side's
    // rules, this goes red the same day.
    const rows: { name: string; ref: string; trust: string[] | null; cachedTrusted?: boolean; entry: boolean }[] = [
      { name: 'listed publisher', ref: TRUSTED_REF, trust: ['qwen'], entry: true },
      { name: 'unlisted publisher', ref: UNTRUSTED_REF, trust: ['qwen'], entry: true },
      { name: 'cache lies trusted, list omits', ref: UNTRUSTED_REF, trust: ['qwen'], cachedTrusted: true, entry: true },
      { name: 'cache lies untrusted, list names', ref: TRUSTED_REF, trust: ['qwen'], cachedTrusted: false, entry: true },
      { name: 'publisher revoked', ref: TRUSTED_REF, trust: [], entry: true },
      { name: 'trust list missing', ref: TRUSTED_REF, trust: null, entry: true },
      { name: 'no catalogue entry', ref: UNTRUSTED_REF, trust: ['qwen'], entry: false },
    ]

    for (const row of rows) {
      it(`${row.name}: script and module reach the same verdict`, () => {
        clearModelFile()
        if (row.entry) {
          writeCatalogue(true, row.cachedTrusted === undefined ? {} : { [row.ref]: row.cachedTrusted })
        } else {
          writeCatalogue(false)
          if (row.ref === TRUSTED_REF) throw new Error('the no-entry row must use the ref the catalogue drops')
        }
        writeTrustList(row.trust)

        const module = decideModelTrust({
          model: row.ref,
          cacheFile: join(sandbox, 'llm-catalog-cache.json'),
          trustFile: join(sandbox, 'llm-catalog-trust.json'),
          blobsDir: join(sandbox, 'blobs'),
        })
        // Exit 0 = the script let it through without asking; exit 7 = it stopped and demanded a
        // named confirmation. That is precisely "trusted" versus "not trusted".
        const script = use([row.ref])
        expect(script.code === 0, `script exit ${script.code}, module trusted=${module.trusted}\n${script.out}`)
          .toBe(module.trusted)
        // ...and when they both refuse, they must demand the SAME answer, or one door's instructions
        // would not work on the other.
        if (!module.trusted) expect(script.out).toContain(`--i-trust ${module.confirmWith}`)
      })
    }
  })

  describe('the catalogue listing checks schemaVersion before reading a field (card 4117f98e)', () => {
    // The other consumer the version was written for. This step turns catalogue fields into
    // install instructions, so reading a document from a schema it does not know is the exact
    // failure schemaVersion exists to prevent -- and it never looked either.
    function withStubCatalogue(schemaVersion: unknown): { code: number; out: string } {
      // A stub llm-catalog.py in the sandbox: the script resolves it next to itself, so this
      // exercises the real read path with a controlled document instead of the network.
      writeFileSync(
        join(sandbox, 'llm-catalog.py'),
        `#!/usr/bin/env python3\nimport json\nprint(json.dumps({"schemaVersion": ${JSON.stringify(schemaVersion)}, "generatedAt": "2026-08-14T00:00:00Z", "source": "cache", "stale": False, "host": {}, "warnings": [], "models": [{"repo": "Qwen/Good-GGUF", "quant": "Q4_K_M", "fileMib": 4000, "tier": "fits", "installRef": ${JSON.stringify(TRUSTED_REF)}, "repoOwner": "Qwen", "trusted": True, "notes": []}]}))\n`,
      )
      const r = spawnSync('bash', [join(sandbox, 'first-run-llm.sh')], {
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, OLLAMA_HOST: host, FIRST_RUN_BLOBS: join(sandbox, 'blobs') },
      })
      return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
    }

    it('refuses to read a version it does not understand, and says which failure it is', () => {
      const r = withStubCatalogue(99)
      expect(r.out).toContain("version '99'")
      expect(r.out).not.toContain('Qwen/Good-GGUF') // no field of that document was rendered
    })

    it('CONTROL: the same document at the supported version IS listed', () => {
      // Without this, "never lists anything" would pass the test above.
      const r = withStubCatalogue(1)
      expect(r.out).toContain('Qwen/Good-GGUF')
    })
  })

  describe('a STALE catalogue says so before the operator picks from it (card 3f6087f4)', () => {
    // Cybered's LOW on the e35bc379 GO: the envelope has carried `stale` and `source` since it was
    // written, and nothing outside the JSON ever read them. So an operator choosing from a frozen
    // fallback shipped in the repo saw a screen identical to a live catalogue -- while the digests
    // on it are the evidence behind the trust label, and "as of generatedAt" is part of what that
    // evidence means.
    function listWithStaleness(stale: boolean): string {
      writeFileSync(
        join(sandbox, 'llm-catalog.py'),
        `#!/usr/bin/env python3\nimport json\nprint(json.dumps({"schemaVersion": 1, "generatedAt": "2026-08-14T06:38:12Z", "source": "bundled-fallback", "stale": ${stale ? 'True' : 'False'}, "host": {}, "warnings": [], "models": [{"repo": "Qwen/Good-GGUF", "quant": "Q4_K_M", "fileMib": 4000, "tier": "fits", "installRef": ${JSON.stringify(TRUSTED_REF)}, "repoOwner": "Qwen", "trusted": True, "notes": []}]}))\n`,
      )
      const r = spawnSync('bash', [join(sandbox, 'first-run-llm.sh')], {
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, OLLAMA_HOST: host, FIRST_RUN_BLOBS: join(sandbox, 'blobs') },
      })
      return `${r.stdout ?? ''}${r.stderr ?? ''}`
    }

    it('names the source and the moment it was recorded', () => {
      const out = listWithStaleness(true)
      expect(out).toContain('NOT live')
      expect(out).toContain('bundled-fallback')
      expect(out).toContain('2026-08-14T06:38:12Z')
      expect(out).toContain('Qwen/Good-GGUF') // and it still offers the models
    })

    it('CONTROL: a LIVE catalogue gets no such note', () => {
      // Otherwise a script that printed the warning unconditionally would pass the test above, and
      // a notice shown on every run is one nobody reads by the second week.
      const out = listWithStaleness(false)
      expect(out).not.toContain('NOT live')
      expect(out).toContain('Qwen/Good-GGUF')
    })
  })

  // --- what the OFFER shows, card a34effcb (Cybered on the fbbb4015 gate) -----------------------
  // Two findings about the same screen: the line said "pull <installRef from the catalogue>" while
  // printing the REPO cut at 42 characters (45% of a live 435-model catalogue is longer than that,
  // and a repo is not a pullable ref at all -- it lacks the hf.co prefix and the quant tag), and the
  // trust label carried no evidence even though downloads and per-part digests were already in the
  // document. A confirmation that shows only a name is a click-through, not a decision (T1), and
  // that applies to the offer as much as to the confirm dialog.
  describe('the catalogue offer is copy-pasteable and its trust label is checkable (card a34effcb)', () => {
    const LONG_REPO = 'unsloth/Qwen2.5-Coder-32B-Instruct-128K-GGUF-extra' // 50 chars, was cut at 42
    const LONG_REF = `hf.co/${LONG_REPO}:Q4_K_M`

    function listWith(models: unknown[]): string {
      writeFileSync(
        join(sandbox, 'llm-catalog.py'),
        `#!/usr/bin/env python3\nimport json\nprint(json.dumps({"schemaVersion": 1, "generatedAt": "2026-08-14T00:00:00Z", "source": "cache", "stale": False, "host": {}, "warnings": [], "models": ${JSON.stringify(models)}}))\n`,
      )
      const r = spawnSync('bash', [join(sandbox, 'first-run-llm.sh')], {
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, OLLAMA_HOST: host, FIRST_RUN_BLOBS: join(sandbox, 'blobs') },
      })
      return `${r.stdout ?? ''}${r.stderr ?? ''}`
    }

    const trustedLong = {
      repo: LONG_REPO, repoOwner: 'Qwen', quant: 'Q4_K_M', fileMib: 4000, tier: 'fits',
      installRef: LONG_REF, downloads: 175821, notes: [],
      parts: [{ path: 'a.gguf', sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' }],
    }

    it('a long repo name is printed in FULL, not silently cut', () => {
      const out = listWith([trustedLong])
      // ASSERT ON THE NAME LINE ITSELF, not on "the string appears somewhere" (QA FAIL on 55ed33e).
      // The first version of this test was VACUOUS: `toContain(LONG_REPO)` is satisfied by the
      // `pull: <installRef>` line, and installRef CONTAINS the repo by construction -- so it stayed
      // green under a mutation that put `[:42]` back on the name line, which is the one regression
      // this test exists to catch. QA proved that by mutating the print statement and re-running.
      // Pinning the numbered entry plus the quant that follows it ties the assertion to the line
      // whose truncation was the defect; the fixture below keeps the two facts independent as well.
      const nameLine = new RegExp(`^\\s*1\\) ${LONG_REPO.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')}\\s+Q4_K_M\\b`, 'm')
      expect(out).toMatch(nameLine)
    })

    it('CONTROL for the test above: it fails when the name line is truncated', () => {
      // The control that the first version lacked, expressed as data instead of as a code mutation:
      // the same assertion run against a name line that WAS cut at 42 characters must not match. If
      // this ever passes, the regex above stopped being anchored to the name line.
      const cut = `   1) ${LONG_REPO.slice(0, 42)}  Q4_K_M  4.0 GB  fits  trusted publisher`
      const nameLine = new RegExp(`^\\s*1\\) ${LONG_REPO.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')}\\s+Q4_K_M\\b`, 'm')
      expect(cut).not.toMatch(nameLine)
    })

    it('the pull line carries the installRef verbatim -- the thing you actually type', () => {
      const out = listWith([trustedLong])
      expect(out).toContain(`pull: ${LONG_REF}`)
      // ...and the instruction no longer sends the reader to a field that was never on screen.
      expect(out).not.toContain('<installRef from the catalogue>')
    })

    it('the trust label comes with its evidence: downloads + digest prefix', () => {
      const out = listWith([trustedLong])
      expect(out).toContain('trusted publisher')
      expect(out).toContain('175821 downloads')
      expect(out).toContain('sha256 abcdef012345')
    })

    it('a missing digest is SAID, not left to be assumed -- with a control that one shows otherwise', () => {
      const noDigest = { ...trustedLong, parts: [{ path: 'a.gguf' }] }
      expect(listWith([noDigest])).toContain('no digest published')
      expect(listWith([trustedLong])).not.toContain('no digest published')
    })

    it('a missing download count is said too, rather than printing a bare label', () => {
      // The key is OMITTED rather than set to null on purpose: the stub is a Python source file, so
      // a JSON `null` would not even parse there -- and an absent field is the shape a real
      // catalogue entry takes when the API returned no count.
      const { downloads: _dropped, ...noDownloads } = trustedLong
      expect(listWith([noDownloads])).toContain('download count unknown')
    })

    it('an UNVERIFIED entry in the offered list is called out, with the reason it got there', () => {
      // The ordering is (tier, trusted, downloads), so within a tier the reviewed publishers come
      // first -- an unverified entry this high means nothing trusted was left at that size. That is
      // information, and it used to be visible only as an absence.
      const sketchy = {
        repo: 'Sketchy/Thing-GGUF', repoOwner: 'Sketchy', quant: 'Q4_K_M', fileMib: 4000,
        tier: 'fits', installRef: UNTRUSTED_REF, downloads: 12, notes: [],
        parts: [{ path: 'b.gguf', sha256: OID_UNTRUSTED }],
      }
      const out = listWith([trustedLong, sketchy])
      expect(out).toContain('UNVERIFIED publisher')
      expect(out).toContain('NOT on the reviewed list')
      // CONTROL: an all-trusted list must NOT print the callout, otherwise the assertion above
      // would pass on a line that is always there.
      expect(listWith([trustedLong])).not.toContain('NOT on the reviewed list')
    })
  })

  it('the gate behaves identically without a TTY -- a pipe is not a yes', () => {
    // Every case above already runs without a TTY (spawnSync gives pipes), so this pins the
    // property rather than discovering it: there is no interactive branch that a terminal would
    // reach and a cron job would skip. Asserted by running the untrusted case with stdin closed.
    clearModelFile()
    const r = spawnSync('bash', [join(sandbox, 'first-run-llm.sh'), '--use', UNTRUSTED_REF], {
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OLLAMA_HOST: host, FIRST_RUN_BLOBS: join(sandbox, 'blobs') },
    })
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(7)
    expect(existsSync(join(sandbox, 'local-llm-model'))).toBe(false)
  })
})

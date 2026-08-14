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
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync, mkdtempSync, copyFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '..', '..')
const TRUSTED_REF = 'hf.co/Qwen/Good-GGUF:Q4_K_M'
const UNTRUSTED_REF = 'hf.co/Sketchy/Thing-GGUF:Q4_K_M'
const OID_TRUSTED = `aaaa${'0'.repeat(56)}1111`
const OID_UNTRUSTED = `bbbb${'0'.repeat(56)}2222`

let sandbox: string
let server: ChildProcess
let host: string

/** The catalogue the gate reads. `withUntrusted: false` drops the entry entirely, which is the
 *  no-provenance case -- strictly weaker than an untrusted publisher, so it must gate too. */
function writeCatalogue(withUntrusted: boolean): void {
  const models: unknown[] = [
    {
      installRef: TRUSTED_REF,
      repo: 'Qwen/Good-GGUF',
      repoOwner: 'Qwen',
      downloads: 91234,
      trusted: true,
      parts: [{ path: 'good-q4_k_m.gguf', sha256: OID_TRUSTED }],
    },
  ]
  if (withUntrusted) {
    models.push({
      installRef: UNTRUSTED_REF,
      repo: 'Sketchy/Thing-GGUF',
      repoOwner: 'Sketchy',
      downloads: 12,
      trusted: false,
      parts: [{ path: 'thing-q4_k_m.gguf', sha256: OID_UNTRUSTED }],
    })
  }
  writeFileSync(join(sandbox, 'llm-catalog-cache.json'), JSON.stringify({ schemaVersion: 1, models }))
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

  it('a model with no catalogue entry gates too -- no provenance is weaker than untrusted', () => {
    clearModelFile()
    writeCatalogue(false)
    const r = use([UNTRUSTED_REF])
    expect(r.code, r.out).toBe(7)
    expect(r.modelFile).toBe('')
    expect(r.out).toContain('--i-trust unverified')
    writeCatalogue(true)
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

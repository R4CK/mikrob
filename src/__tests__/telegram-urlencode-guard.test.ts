// Card b43d6dfd (Cybersec finding on the a52ffdf8 gate): scripts/notify.sh posted the alert
// body with plain `curl -d "text=${MESSAGE}"`. `-d` sends the value RAW, so an `&` anywhere in
// the message starts a NEW form parameter -- everything after it silently vanishes from `text`,
// and a crafted message can override a later field such as parse_mode. Real trigger: the
// filename lists formatUpstreamAnalysis emits.
//
// Two layers here:
//   1. A BEHAVIOURAL proof against a local echo server that `-d` really does truncate and
//      `--data-urlencode` really does not. Without this the guard is just a string match on
//      source text, which proves nothing about what curl does.
//   2. A CORPUS guard over every scripts/*.sh + store/*.sh, so the class stays closed. notify.sh
//      was the last offender; every other Telegram caller already used --data-urlencode.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// MUST be async: the echo server runs in THIS process, so a synchronous execFileSync would
// block the event loop and the server could never accept curl's connection (deadlock).
const execFileAsync = promisify(execFile)

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STORE_DIR = join(REPO_ROOT, 'store')
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts')

// A message shaped like the real trigger: an `&` mid-text, plus the other reserved characters.
const HOSTILE = 'files: a.ts & b.ts <tag> 100% done +1'

describe('BEHAVIOUR: -d truncates on "&", --data-urlencode does not', () => {
  let server: Server
  let port = 0
  let lastBody = ''

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        lastBody = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    // No keep-alive: curl would otherwise hold the connection open and server.close()
    // would never fire its callback, hanging the suite.
    server.keepAliveTimeout = 0
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  })

  /** Parse the received form body the way a server would, returning the `text` field. */
  function receivedText(): string | undefined {
    return new URLSearchParams(lastBody).get('text') ?? undefined
  }

  it('the OLD form (-d) loses everything after the "&" and injects a bogus parameter', async () => {
    await execFileAsync('curl', [
      '-s', '-o', '/dev/null', '-X', 'POST', `http://127.0.0.1:${port}/`,
      '-d', 'chat_id=123',
      '-d', `text=${HOSTILE}`,
      '-d', 'parse_mode=HTML',
    ])
    // The message is cut at the `&` -- this is the bug, reproduced.
    expect(receivedText()).not.toBe(HOSTILE)
    expect(receivedText()).toBe('files: a.ts ')
    // ...and the remainder became a spurious form field the server never asked for:
    // 3 fields were sent, more than 3 arrived.
    expect([...new URLSearchParams(lastBody).keys()].length).toBeGreaterThan(3)
  })

  it('the NEW form (--data-urlencode) delivers the message byte-for-byte', async () => {
    await execFileAsync('curl', [
      '-s', '-o', '/dev/null', '-X', 'POST', `http://127.0.0.1:${port}/`,
      '--data-urlencode', 'chat_id=123',
      '--data-urlencode', `text=${HOSTILE}`,
      '--data-urlencode', 'parse_mode=HTML',
    ])
    expect(receivedText()).toBe(HOSTILE)
    // parse_mode survives intact -- a crafted message cannot override it.
    expect(new URLSearchParams(lastBody).get('parse_mode')).toBe('HTML')
    expect(new URLSearchParams(lastBody).get('chat_id')).toBe('123')
  })

  it('an ordinary ASCII message is delivered identically by BOTH forms (no caller regression)', async () => {
    const plain = 'Ertesites elkuldve, minden rendben'
    await execFileAsync('curl', ['-s', '-o', '/dev/null', '-X', 'POST', `http://127.0.0.1:${port}/`, '-d', `text=${plain}`])
    const viaD = receivedText()
    await execFileAsync('curl', ['-s', '-o', '/dev/null', '-X', 'POST', `http://127.0.0.1:${port}/`, '--data-urlencode', `text=${plain}`])
    expect(receivedText()).toBe(viaD)
    expect(receivedText()).toBe(plain)
  })
})

/** One curl invocation, reassembled across `\`-continued lines. */
function findCurlInvocations(source: string): Array<{ text: string; startLine: number }> {
  const lines = source.split('\n')
  const out: Array<{ text: string; startLine: number }> = []
  let buf: string[] = []
  let startLine = -1
  let inCurl = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!inCurl && /\bcurl\b/.test(line)) {
      inCurl = true
      startLine = i + 1
      buf = []
    }
    if (inCurl) {
      buf.push(line)
      if (!line.trimEnd().endsWith('\\')) {
        out.push({ text: buf.join('\n'), startLine })
        inCurl = false
      }
    }
  }
  return out
}

/** True iff the invocation sends a variable-expanded `text=`/`chat_id=` via bare `-d`. */
function sendsRawFormValue(invocation: string): boolean {
  return /(^|\s)-d\s+"?(text|chat_id)=[^"']*\$/m.test(invocation)
}

const SCRIPTS_LIB_DIR = join(SCRIPTS_DIR, 'lib')

const CASES = [
  ...readdirSync(STORE_DIR).filter((f) => f.endsWith('.sh')).map((file) => ({ dir: STORE_DIR, file })),
  ...readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.sh')).map((file) => ({ dir: SCRIPTS_DIR, file })),
  // scripts/lib/send-telegram.sh (NOTIFYVAKSWEEP826): the actual curl call that used to live
  // inline in notify.sh now lives here, and every other honest sender delegates to it -- the
  // corpus scan must reach into scripts/lib/ or the one file that matters most goes unscanned.
  ...readdirSync(SCRIPTS_LIB_DIR).filter((f) => f.endsWith('.sh')).map((file) => ({ dir: SCRIPTS_LIB_DIR, file })),
]

describe('CORPUS: no script sends a Telegram message body through bare -d', () => {
  it('scans a non-trivial number of scripts (the guard is not vacuously passing)', () => {
    expect(CASES.length).toBeGreaterThan(20)
  })

  it.each(CASES)('$file: text=/chat_id= payloads use --data-urlencode', ({ dir, file }) => {
    const source = readFileSync(join(dir, file), 'utf8')
    const offenders = findCurlInvocations(source).filter((c) => sendsRawFormValue(c.text))
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  line ${o.startLine}: ${o.text.trim().slice(0, 120)}`).join('\n')
      throw new Error(
        `${file} sends a form value through bare -d at:\n${detail}\n` +
          `An "&" in the value starts a NEW form parameter, truncating the message and letting a ` +
          `crafted value override a later field (e.g. parse_mode). Fix: --data-urlencode "text=$VAR".`,
      )
    }
  })

  it('notify.sh delegates delivery to the shared honest-send library, which uses --data-urlencode for text (card b43d6dfd, superseded by NOTIFYVAKSWEEP826)', () => {
    const src = readFileSync(join(SCRIPTS_DIR, 'notify.sh'), 'utf8')
    expect(src).toMatch(/send_telegram_message\s+"\$TOKEN"\s+"\$CHAT_ID"\s+"\$MESSAGE"/)
    expect(src).not.toMatch(/(^|\s)-d\s+"text=/m)
    const lib = readFileSync(join(SCRIPTS_LIB_DIR, 'send-telegram.sh'), 'utf8')
    expect(lib).toMatch(/--data-urlencode\s+"text=\$\{text\}"/)
    expect(lib).not.toMatch(/(^|\s)-d\s+"text=/m)
  })
})

describe('the corpus scanner itself is not vacuous', () => {
  it('flags a synthetic offender', () => {
    const script = ['#!/bin/bash', 'curl -s -X POST "$API" \\', '  -d "text=${MSG}" \\', '  -d "parse_mode=HTML"'].join('\n')
    expect(findCurlInvocations(script).filter((c) => sendsRawFormValue(c.text))).toHaveLength(1)
  })

  it('does NOT flag the sanctioned --data-urlencode form', () => {
    const script = ['#!/bin/bash', 'curl -s -X POST "$API" \\', '  --data-urlencode "text=${MSG}"'].join('\n')
    expect(findCurlInvocations(script).filter((c) => sendsRawFormValue(c.text))).toEqual([])
  })

  it('does NOT flag a fixed literal payload (nothing to expand, nothing to truncate)', () => {
    const script = '#!/bin/bash\ncurl -s -X POST "$API" -d "parse_mode=HTML"\n'
    expect(findCurlInvocations(script).filter((c) => sendsRawFormValue(c.text))).toEqual([])
  })
})

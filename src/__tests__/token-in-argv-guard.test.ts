// Guard: no store/*.sh may pass a Bearer token as a curl COMMAND-LINE argument (card edb7559f,
// Cybersec finding chain starting at 83191d8d -> b7fa5281's own token, /proc/<pid>/cmdline leak).
//
// /proc/<pid>/cmdline is world-readable, so `curl -H "Authorization: Bearer $TOK"` hands the
// dashboard (or any other) bearer token to any local user/process that can list processes. The
// sanctioned fix is a private 0600 temp header file passed as `-H @"$hdr_file"` (already the pattern
// in weekly-usage-panel-read.sh, redispatch-guard.sh, weekly-usage-probe.sh, and now the 6 files this
// card fixed). This test enumerates EVERY store/*.sh and fails on the FIRST script that regresses.
//
// MULTI-LINE AWARE ON PURPOSE: a naive per-line regex would have missed offload-dispatch.sh's POST
// call, where `curl -X POST ... \` and `-H "Authorization: Bearer $TOK" \` are on different lines --
// exactly the miss I made scanning by eye before writing this guard. The scanner below joins a curl
// invocation across backslash-continued lines before testing it, the same way bash itself does.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STORE_DIR = join(REPO_ROOT, 'store')
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts')

/** One curl invocation, reassembled across `\`-continued lines, with its 1-based start line. */
interface CurlInvocation {
  readonly text: string
  readonly startLine: number
}

/** Split a script into logical curl invocations (continuation lines joined), like bash would see them. */
function findCurlInvocations(source: string): CurlInvocation[] {
  const lines = source.split('\n')
  const out: CurlInvocation[] = []
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

/**
 * True iff the invocation carries a literal `Authorization: Bearer $VAR`-shaped header (argv leak).
 * `$VAR` covers BOTH a bare variable (`$TOK`) and a command substitution (`$(cat "...")`) -- a regex
 * matching only `[A-Za-z_]` after the `$` misses the latter entirely, since `(` isn't a variable-name
 * character. That gap let scripts/channels.sh and scripts/doctor.sh (which inline `$(cat "...")`) slip
 * past an earlier draft of this scanner (card b267df80).
 */
function leaksTokenInArgv(invocation: string): boolean {
  if (!/Authorization:\s*Bearer\s*\$(\(|[A-Za-z_])/.test(invocation)) return false
  // The sanctioned form reads the header from a file (`-H @"$hdr_file"` / `-H @"$hdr"` / `-H @"$hf"`);
  // that never matches the Bearer-in-argv pattern above in the first place, but keep this as an
  // explicit second check so a future refactor that keeps BOTH forms in one invocation still trips.
  return !/-H\s+@/.test(invocation)
}

function scanDir(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.sh'))
}

const STORE_SCRIPTS = scanDir(STORE_DIR)
const SCRIPTS_SCRIPTS = scanDir(SCRIPTS_DIR)

describe('no store/*.sh or scripts/*.sh puts a Bearer token in curl argv', () => {
  it('scans a non-trivial number of scripts in both directories (the guard is not vacuously passing)', () => {
    expect(STORE_SCRIPTS.length).toBeGreaterThan(10)
    expect(SCRIPTS_SCRIPTS.length).toBeGreaterThan(3)
  })

  const cases: Array<{ dir: string; file: string }> = [
    ...STORE_SCRIPTS.map((file) => ({ dir: STORE_DIR, file })),
    ...SCRIPTS_SCRIPTS.map((file) => ({ dir: SCRIPTS_DIR, file })),
  ]

  it.each(cases)('$file: every curl reads its auth header from a file, never argv', ({ dir, file }) => {
    const source = readFileSync(join(dir, file), 'utf8')
    const offenders = findCurlInvocations(source).filter((c) => leaksTokenInArgv(c.text))
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  line ${o.startLine}: ${o.text.trim().slice(0, 100)}`).join('\n')
      throw new Error(
        `${file} passes a Bearer token in curl argv (/proc/<pid>/cmdline leak) at:\n${detail}\n` +
          `Fix: 0600 temp header file + \`-H @"$hdr_file"\`, trap 'rm -f "$hdr_file"' EXIT ` +
          `(see weekly-usage-panel-read.sh or offload-dispatch.sh).`,
      )
    }
  })
})

describe('the scanner itself catches what a naive single-line regex would miss', () => {
  it('flags a Bearer header split onto a CONTINUATION line (the offload-dispatch.sh miss)', () => {
    const script = [
      '#!/usr/bin/env bash',
      'curl -s -X POST "$DASH/api/x" -H "Content-Type: application/json" \\',
      '  -H "Authorization: Bearer $TOK" \\',
      "  -d '{}'",
    ].join('\n')
    const offenders = findCurlInvocations(script).filter((c) => leaksTokenInArgv(c.text))
    expect(offenders).toHaveLength(1)
    expect(offenders[0]?.startLine).toBe(2) // the curl starts on line 2, not the header line
  })

  it('flags a Bearer header via COMMAND SUBSTITUTION, not just a bare variable (the channels.sh/doctor.sh miss)', () => {
    // $(cat "...") is not a bare `$VAR` -- a regex anchored on `\$[A-Za-z_]` doesn't match the `(`
    // and silently passes this, exactly what happened to an earlier draft of this guard.
    const script = [
      '#!/usr/bin/env bash',
      'curl -s -H "Authorization: Bearer $(cat "store/.dashboard-token")" "$DASH/api/x"',
    ].join('\n')
    const offenders = findCurlInvocations(script).filter((c) => leaksTokenInArgv(c.text))
    expect(offenders).toHaveLength(1)
  })

  it('does NOT flag the sanctioned @headerfile pattern', () => {
    const script = [
      '#!/usr/bin/env bash',
      'hdr_file="$(mktemp)"; chmod 600 "$hdr_file"',
      "printf 'Authorization: Bearer %s\\n' \"$TOK\" > \"$hdr_file\"",
      'curl -s -H @"$hdr_file" "$DASH/api/x"',
    ].join('\n')
    expect(findCurlInvocations(script).filter((c) => leaksTokenInArgv(c.text))).toEqual([])
  })

  it('does NOT flag a curl with no Authorization header at all', () => {
    const script = '#!/usr/bin/env bash\ncurl -s "http://example.com"\n'
    expect(findCurlInvocations(script).filter((c) => leaksTokenInArgv(c.text))).toEqual([])
  })

  it('does NOT flag a MENTION of the pattern inside a comment or doc string (not a real curl call)', () => {
    // The guard only inspects lines that actually contain `curl`; a comment describing the bug class
    // without the word "curl" on the same joined invocation is data, not code.
    const script = '#!/usr/bin/env bash\n# never write Authorization: Bearer $TOK on a command line\necho hi\n'
    expect(findCurlInvocations(script)).toEqual([])
  })
})

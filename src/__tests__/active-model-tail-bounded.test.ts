// The transcript readers must cost the same on a 300 MB session as on a 3 KB one (card d3dc35bf).
//
// WHAT HAPPENED. `readActiveModelFromProjectDir` and `readContextTokensFromProjectDir` both scan the
// newest transcript from the END for the most recent turn, and both used to `readFileSync` the WHOLE
// file and `split('\n')` it -- synchronously, on the `GET /api/agents` request path, once per running
// agent. Measured on the live fleet on 2026-08-16: transcripts had reached 276 MB, `GET /api/agents`
// answered in 3.8-7.4 s (p50 4.4 s) against ~12 ms for every other route, and the dashboard sat at
// 98% CPU with every HTTP request timing out. That freezes the whole fleet, because the agents reach
// each other through this API. The 3 s cache could not help: the UI polls every 3 s.
//
// WHY THIS FILE ASSERTS CONTENT AND NOT TIME. A "must finish in N ms" test is a flake generator on a
// shared box. Boundedness is the property that matters and it is exactly checkable: put the only
// matching turn far outside the tail window and require that it is NOT found. If the reader still
// answers, it read the whole file, and the cost is linear again. Constant cost follows from the
// bound; it does not need its own stopwatch.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readActiveModelFromProjectDir,
  readContextTokensFromProjectDir,
  projectsDirFor,
} from '../web/active-model.js'

const WORKDIR = '/fake/agent/workdir'
let configRoot: string
let projectDir: string

function turn(model: string, tokens = 10): string {
  return JSON.stringify({
    timestamp: new Date(2_000_000_000_000).toISOString(),
    message: { model, usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  })
}

/** A line that is large but carries nothing either reader wants -- a tool result, in practice. */
function filler(bytes: number): string {
  return JSON.stringify({ type: 'tool_result', content: 'x'.repeat(bytes) })
}

beforeAll(() => {
  configRoot = mkdtempSync(join(tmpdir(), 'active-model-tail-'))
  projectDir = projectsDirFor(WORKDIR, configRoot)
  mkdirSync(projectDir, { recursive: true })
})

afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true })
})

describe('the transcript readers are bounded to the tail', () => {
  it('still finds the latest turn in an ordinary transcript (positive control)', () => {
    // Without this, every "not found" assertion below could be passing because the reader is broken.
    const f = join(projectDir, 'small.jsonl')
    writeFileSync(f, [turn('claude-old-5'), filler(100), turn('claude-latest-5')].join('\n') + '\n')
    expect(readActiveModelFromProjectDir(WORKDIR, undefined, configRoot)).toBe('claude-latest-5')
    expect(readContextTokensFromProjectDir(WORKDIR, configRoot)).toBe(10)
  })

  it('does NOT read past the tail window -- a turn 3 MB back is out of reach, on purpose', () => {
    // The bound, stated as a behaviour rather than a promise. 3 MB of filler after the only real
    // turn puts it outside the 512 KB window; the old whole-file reader would have found it, which
    // is precisely the cost this card exists to remove.
    const f = join(projectDir, 'huge.jsonl')
    writeFileSync(f, turn('claude-way-back-5') + '\n')
    for (let i = 0; i < 30; i += 1) appendFileSync(f, filler(100_000) + '\n')
    // Newest by mtime wins, and this file is the newest.
    expect(readActiveModelFromProjectDir(WORKDIR, undefined, configRoot)).toBeNull()
    expect(readContextTokensFromProjectDir(WORKDIR, configRoot)).toBeNull()
  })

  it('finds a turn that IS inside the window, at the end of the same huge file', () => {
    // The other half: bounded must not mean blind. Appending a real turn to that same multi-megabyte
    // file makes it visible again, so the reader is reading the tail rather than giving up on size.
    const f = join(projectDir, 'huge.jsonl')
    appendFileSync(f, turn('claude-fresh-5', 77) + '\n')
    expect(readActiveModelFromProjectDir(WORKDIR, undefined, configRoot)).toBe('claude-fresh-5')
    expect(readContextTokensFromProjectDir(WORKDIR, configRoot)).toBe(77)
  })

  it('widens the window ONCE when a single line is bigger than it', () => {
    // A tool result larger than 512 KB would otherwise leave the window with no complete line at
    // all, and the reader would answer null for a session that has a perfectly good turn just
    // behind it. One retry at 4 MB, then it gives up -- bounded either way, never the whole file.
    const f = join(projectDir, 'zwide.jsonl')
    writeFileSync(f, [turn('claude-behind-a-wall-5', 42), filler(700_000)].join('\n') + '\n')
    expect(readActiveModelFromProjectDir(WORKDIR, undefined, configRoot)).toBe('claude-behind-a-wall-5')
    expect(readContextTokensFromProjectDir(WORKDIR, configRoot)).toBe(42)
  })
})

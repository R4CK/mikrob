// store/transcript-perms-guard.sh: the cron-driven chmod that keeps session transcripts private
// (card bdcd2dc1, extended by 89846e07).
//
// WHY THESE TESTS EXIST. The guard's scope used to be two hand-written paths, and Cybered found a
// third live transcript tree nobody had added. Measuring before fixing turned up a FOURTH
// (~/.claude/tmp/*/projects) and a token-shaped file at a config root (~/.claude/history.jsonl,
// 64 MB of prompt history). Nothing was exposed -- all of them happen to be 700/600 -- which is
// precisely why a list is the wrong mechanism here: it fails silently and looks fine for months.
//
// So the property under test is not "these three paths are covered" (that would be the same list,
// re-typed in a test). It is that a tree matching the harness SHAPE is covered even when nobody
// added it -- including one created after the guard was written.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, chmodSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '..', '..')
const GUARD = join(ROOT, 'store', 'transcript-perms-guard.sh')

let box: string
let home: string
let marveen: string

function mode(p: string): string {
  return (statSync(p).mode & 0o777).toString(8)
}

function seedFile(p: string, m: number): string {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, 'x')
  chmodSync(p, m)
  return p
}

function runGuard(): { code: number; out: string } {
  const r = spawnSync('bash', [GUARD], {
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, HOME: home, TRANSCRIPT_GUARD_ROOT: marveen },
  })
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'transcript-guard-'))
  home = join(box, 'home')
  marveen = join(box, 'marveen')
  mkdirSync(join(marveen, 'store'), { recursive: true })
})

afterAll(() => {
  rmSync(box, { recursive: true, force: true })
})

describe('transcript-perms-guard.sh', () => {
  it('tightens transcripts in every harness tree, listed or not', () => {
    const listed = seedFile(join(home, '.claude/projects/a/x.jsonl'), 0o664)
    // The tree Cybered found missing (weekly-usage-panel-read.sh creates it).
    const probe = seedFile(join(home, '.claude-usage-probe/projects/b/y.jsonl'), 0o664)
    // The one MY measurement found while fixing that: per-config harness dirs.
    const tmpCfg = seedFile(join(home, '.claude/tmp/cfg/projects/c/z.jsonl'), 0o664)
    const channels = seedFile(join(marveen, '.channels-config/projects/d/w.jsonl'), 0o664)

    expect(runGuard().code).toBe(0)
    for (const f of [listed, probe, tmpCfg, channels]) expect(mode(f), f).toBe('600')
  })

  it('covers a transcript tree that did not exist when the guard was written', () => {
    // The actual property. A list cannot pass this; a glob over the shape can, and that is the
    // difference between a control that keeps working and one that quietly stops.
    const future = seedFile(join(home, '.claude-some-future-harness/projects/p/q.jsonl'), 0o664)
    expect(runGuard().code).toBe(0)
    expect(mode(future)).toBe('600')
  })

  it('tightens transcript-shaped files sitting at a config root, not only inside projects/', () => {
    // ~/.claude/history.jsonl is the live one: 64 MB of prompt history, covered by nothing before.
    const history = seedFile(join(home, '.claude/history.jsonl'), 0o664)
    expect(runGuard().code).toBe(0)
    expect(mode(history)).toBe('600')
  })

  it('tightens directories to 700 and the dashboard token to 600', () => {
    const f = seedFile(join(home, '.claude/projects/a/x.jsonl'), 0o664)
    chmodSync(join(f, '..'), 0o755)
    const token = seedFile(join(marveen, 'store/.dashboard-token'), 0o644)

    expect(runGuard().code).toBe(0)
    expect(mode(join(f, '..'))).toBe('700')
    expect(mode(token)).toBe('600')
  })

  it('leaves non-transcript files alone -- it is a targeted chmod, not a sweep', () => {
    // The negative control. Without it, "chmod -R 600 everything under $HOME" would pass every
    // other case in this file while breaking whatever else lives there.
    const notes = seedFile(join(home, '.claude/projects/a/notes.txt'), 0o664)
    const outside = seedFile(join(home, 'unrelated/data.jsonl'), 0o664)

    expect(runGuard().code).toBe(0)
    expect(mode(notes)).toBe('664')
    // A .jsonl outside any harness config root is not ours to touch either.
    expect(mode(outside)).toBe('664')
  })

  it('is idempotent and stays quiet when there is nothing to do', () => {
    const f = seedFile(join(home, '.claude/projects/a/x.jsonl'), 0o664)
    expect(runGuard().code).toBe(0)
    const second = runGuard()
    expect(second.code).toBe(0)
    expect(second.out.trim()).toBe('')
    expect(mode(f)).toBe('600')
  })
})

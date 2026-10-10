// card b11a9353: .gitignore's `agents/` entry was unanchored, so it matched at ANY depth, not
// just the top-level per-agent worktree scratch dir it was meant for. Concrete find: it silently
// excluded seed-skills/wizard/agents/openai.yaml (vendored upstream metadata) from every commit --
// `git add` succeeded with no error, the file just never made it in. Pinned behaviourally (via
// `git check-ignore`) rather than by matching the .gitignore text, so a future reformat that keeps
// the same bug (e.g. a second unanchored line) still fails this.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'check-ignore', '--quiet', path])
    return true
  } catch (err: unknown) {
    const status = (err as { status?: number }).status
    if (status === 1) return false
    throw err
  }
}

describe('.gitignore agents/ entry is anchored to repo root (card b11a9353)', () => {
  it('a nested agents/ dir (e.g. inside a vendored seed skill) is NOT ignored', () => {
    expect(isIgnored('seed-skills/some-skill/agents/some-file.yaml')).toBe(false)
  })

  it('the root-level per-agent worktree scratch dir is still ignored', () => {
    expect(isIgnored('agents/some-role/some-file.json')).toBe(true)
  })
})

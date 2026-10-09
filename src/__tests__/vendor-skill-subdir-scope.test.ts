// Card 339d29a5: caveman was vendored at the REPO ROOT into the globally-shared
// ~/.claude/skills/caveman, even though the skill itself (the thing actually used) is
// entirely inside skills/caveman -- a one-directory monorepo. Two concrete problems that
// follow from vendoring the wrong scope:
//
//   1. LICENSE MISMATCH: the repo's LICENSING.md splits per-directory (skills/ = MIT,
//      engine/proxy/Go-binaries = BSL-1.1). Vendoring repo root pulled the BSL-licensed
//      tree into the global skills dir while the registry's `license` field said plain
//      MIT -- a licence claim describing only part of what was actually vendored.
//   2. INVISIBLE SKILL: scripts/skill-index.sh only scans ONE level under each top-level
//      skills dir for SKILL.md (`for skill_dir in "$dir"/*/`). With a root vendor, SKILL.md
//      sits at skills/caveman/SKILL.md -- one level too deep -- so the skill never showed
//      up in the global index at all.
//
// This test proves the fix at the vendor-skill.sh level: given a monorepo shaped like
// caveman (one MIT subdir holding the skill, other root-level content outside it), vendoring
// with --subdir lands SKILL.md directly at the destination's own root (fixing #2) and never
// copies the out-of-scope root content (fixing #1 -- nothing BSL-licensed ships at all).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let sandbox: string
let upstreamRepo: string

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'vendor-skill-subdir-'))
  copyFileSync(join(ROOT, 'store', 'vendor-skill.sh'), join(sandbox, 'vendor-skill.sh'))

  // Shape this exactly like the caveman monorepo: root LICENSE (MIT + a scope note),
  // out-of-scope BSL-flavored root content (engine/), and the actual skill in skills/<name>/
  // with no LICENSE of its own (same as upstream caveman -- the subdir inherits the root's
  // MIT grant, it does not carry a second licence file).
  upstreamRepo = join(sandbox, 'upstream-repo')
  mkdirSync(join(upstreamRepo, 'skills', 'demo-skill'), { recursive: true })
  mkdirSync(join(upstreamRepo, 'engine'), { recursive: true })
  git(['init', '-q', '-b', 'main'], upstreamRepo)
  git(['config', 'user.email', 'a@b'], upstreamRepo)
  git(['config', 'user.name', 't'], upstreamRepo)
  writeFileSync(join(upstreamRepo, 'LICENSE'), 'Scope note: MIT except engine/ (BSL-1.1).\nMIT License\n')
  writeFileSync(join(upstreamRepo, 'engine', 'core.go'), '// BSL-licensed engine code, out of scope\n')
  writeFileSync(join(upstreamRepo, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\n---\nbody\n')
  writeFileSync(join(upstreamRepo, 'skills', 'demo-skill', 'README.md'), 'readme\n')
  git(['add', '-A'], upstreamRepo)
  git(['commit', '-q', '-m', 'one'], upstreamRepo)
})

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
})

function vendor(args: string[], dest: string): void {
  execFileSync('bash', [join(sandbox, 'vendor-skill.sh'), '--repo', upstreamRepo, ...args, '--dest', dest], {
    stdio: 'pipe',
  })
}

describe('vendor-skill.sh --subdir scoping (card 339d29a5)', () => {
  it('a root vendor (no --subdir) nests SKILL.md one level deep -- invisible to a depth-1 skill scanner', () => {
    const dest = mkdtempSync(join(tmpdir(), 'vendor-dest-root-'))
    vendor(['--name', 'demo-skill'], dest)
    expect(existsSync(join(dest, 'demo-skill', 'SKILL.md'))).toBe(false)
    expect(existsSync(join(dest, 'demo-skill', 'skills', 'demo-skill', 'SKILL.md'))).toBe(true)
    rmSync(dest, { recursive: true, force: true })
  })

  it('--subdir skills/demo-skill lands SKILL.md at the vendored dir\'s own root', () => {
    const dest = mkdtempSync(join(tmpdir(), 'vendor-dest-subdir-'))
    vendor(['--name', 'demo-skill', '--subdir', 'skills/demo-skill'], dest)
    expect(existsSync(join(dest, 'demo-skill', 'SKILL.md'))).toBe(true)
    rmSync(dest, { recursive: true, force: true })
  })

  it('--subdir never copies out-of-scope root content (the BSL-licensed engine/)', () => {
    const dest = mkdtempSync(join(tmpdir(), 'vendor-dest-scope-'))
    vendor(['--name', 'demo-skill', '--subdir', 'skills/demo-skill'], dest)
    expect(existsSync(join(dest, 'demo-skill', 'engine'))).toBe(false)
    expect(existsSync(join(dest, 'demo-skill', 'LICENSE'))).toBe(false) // only UPSTREAM-LICENSE, written by the script
    rmSync(dest, { recursive: true, force: true })
  })

  it('VENDORED.md records the narrowed subdir, not "<repo root>"', () => {
    const dest = mkdtempSync(join(tmpdir(), 'vendor-dest-provenance-'))
    vendor(['--name', 'demo-skill', '--subdir', 'skills/demo-skill'], dest)
    const vendored = readFileSync(join(dest, 'demo-skill', 'VENDORED.md'), 'utf-8')
    expect(vendored).toContain('| subdir | skills/demo-skill |')
    rmSync(dest, { recursive: true, force: true })
  })
})

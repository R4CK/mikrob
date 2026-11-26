// store/vendor-skill.sh: WhiteHat follow-up on card f3a6f30a (card af3cd669), F1-F3.
//
// F1: `cp -RL "$src/." "$dest/"` dereferences every symlink in $src BY CONTENT. An upstream
// symlink that points OUTSIDE $src (anywhere on this machine, not just inside the clone) makes
// cp -RL copy whatever local file sits at that path into the vendored skill -- which then ships
// to every agent that reads the global skills dir. Fix: validate every symlink in $src resolves
// to a real target INSIDE $src, before any destructive step runs.
//
// F2: a broken or cyclic upstream symlink makes `cp -RL` fail (exit 4), but that used to happen
// AFTER the destination's prior payload was already wiped (`find "$dest" ... -exec rm -rf {} +`
// ran first) and BEFORE `rm -rf "$dest/.git"` (unreached, since the script exits on cp failure).
// A root-vendor (no --subdir) hitting this left dest half-replaced, with a live .git inside it.
// Fix: the same up-front symlink validation (F1) also catches a broken/cyclic symlink (realpath
// fails to resolve it) before $dest is touched at all.
//
// F3: five of the file's existing symlink-defense-in-depth guards (the sanctioned-exclusion
// realpath-containment check, and the two VENDORED.md/UPSTREAM-LICENSE unlink-before-write
// guards) are unreachable by every test that existed before this file: cp -RL already
// dereferences any symlink upstream ships, so none of those tests ever leave dest holding a
// REAL, LEFTOVER symlink for these guards to act on. VENDORED.md and UPSTREAM-LICENSE are the
// two filenames the top-level cleanup explicitly SKIPS (`! -name 'VENDORED.md' ! -name
// 'UPSTREAM-LICENSE'`), specifically so they survive across a re-vendor -- which is exactly the
// scenario that makes a leftover symlink at either name possible. Testing that scenario directly
// (plant the symlink in dest BEFORE running vendor, not via what upstream ships) is what makes
// these guards reachable.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  lstatSync,
  copyFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let sandbox: string
let SCRIPT: string
beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'vendor-skill-symlink-safety-'))
  SCRIPT = join(sandbox, 'vendor-skill.sh')
  copyFileSync(join(ROOT, 'store', 'vendor-skill.sh'), SCRIPT)
})
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const dirs: string[] = []
function mkdtemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function initUpstream(): string {
  const repo = mkdtemp('vendor-skill-symsafe-upstream-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'a@b.c')
  git(repo, 'config', 'user.name', 't')
  mkdirSync(join(repo, 'skills', 'foo'), { recursive: true })
  writeFileSync(join(repo, 'skills', 'foo', 'SKILL.md'), 'free content\n')
  git(repo, 'add', 'skills/foo')
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init')
  return repo
}

function runVendor(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
}

describe('F1 (card af3cd669): an upstream symlink pointing outside its own subtree is rejected, not followed', () => {
  it('refuses to vendor, and never copies the escaped content, when a committed symlink resolves outside $src', () => {
    const outside = mkdtemp('vendor-skill-symsafe-outside-')
    const sentinelPath = join(outside, 'local-secret.txt')
    writeFileSync(sentinelPath, 'LOCAL SECRET -- must never be vendored\n')

    const upstream = initUpstream()
    // An ABSOLUTE symlink, same as a real attacker would ship (it must work regardless of where
    // this machine clones the repo to -- a relative escape only works if the attacker can predict
    // the clone depth, an absolute target works unconditionally).
    symlinkSync(sentinelPath, join(upstream, 'skills', 'foo', 'escape'))
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'add escaping symlink')

    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )

    expect(res.status).not.toBe(0)
    const dest = join(skillsDir, 'foo')
    // The secret content must never land anywhere under dest, win or lose on exact dest shape.
    if (existsSync(dest)) {
      const walk = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
        )
      for (const f of walk(dest)) {
        if (lstatSync(f).isFile()) {
          expect(readFileSync(f, 'utf-8')).not.toContain('LOCAL SECRET')
        }
      }
    }
    // The real file outside the vendor tree is untouched either way.
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('LOCAL SECRET -- must never be vendored\n')
  })

  it('CONTROL: a symlink that stays inside $src is still vendored normally (dereferenced, not rejected)', () => {
    const upstream = initUpstream()
    mkdirSync(join(upstream, 'skills', 'foo', 'nested'))
    writeFileSync(join(upstream, 'skills', 'foo', 'nested', 'real.txt'), 'inside content\n')
    symlinkSync(
      join(upstream, 'skills', 'foo', 'nested', 'real.txt'),
      join(upstream, 'skills', 'foo', 'inside-link'),
    )
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'add in-tree symlink')

    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status, res.stderr).toBe(0)
    const dest = join(skillsDir, 'foo')
    expect(lstatSync(join(dest, 'inside-link')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(dest, 'inside-link'), 'utf-8')).toBe('inside content\n')
  })
})

describe('F2 (card af3cd669): a broken/cyclic upstream symlink aborts before any destructive step', () => {
  it('a re-vendor hitting a broken symlink leaves the prior dest payload untouched (no half-replace)', () => {
    const upstream = initUpstream()
    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const dest = join(skillsDir, 'foo')

    // First vendor: succeeds normally, establishing a known-good prior state.
    let res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status, res.stderr).toBe(0)
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toBe('free content\n')
    const vendoredBefore = readFileSync(join(dest, 'VENDORED.md'), 'utf-8')

    // Second commit: upstream now also ships a broken symlink (target never exists anywhere).
    symlinkSync('/this/path/does/not/exist/anywhere', join(upstream, 'skills', 'foo', 'broken'))
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'add broken symlink')

    res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status).not.toBe(0)
    // The prior, good payload must still be exactly as it was -- not wiped, not half-replaced.
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toBe('free content\n')
    expect(readFileSync(join(dest, 'VENDORED.md'), 'utf-8')).toBe(vendoredBefore)
  })

  it('a root-vendor (no --subdir) hitting a broken symlink never leaves a .git behind in dest (card 728179d1 interaction)', () => {
    const upstream = initUpstream()
    // Broken symlink at the repo ROOT this time, so src === clone (root-vendor path).
    symlinkSync('/this/path/does/not/exist/either', join(upstream, 'broken-root'))
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'root-level broken symlink')

    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const res = runVendor(['--repo', upstream, '--name', 'rootfoo'], { CLAUDE_SKILLS_DIR: skillsDir })

    expect(res.status).not.toBe(0)
    const dest = join(skillsDir, 'rootfoo')
    expect(existsSync(join(dest, '.git'))).toBe(false)
  })
})

describe('F3 (card af3cd669): the symlink-defense-in-depth guards are reachable, not dead code', () => {
  it('a sanctioned exclusion through a LEFTOVER symlink at dest/VENDORED.md is refused, not followed (REALPATH924 guard)', () => {
    // VENDORED.md/UPSTREAM-LICENSE are the ONLY names the top-level cleanup skips (line 102);
    // anything else nested (e.g. dest/legacy/evil) is unconditionally wiped by that cleanup
    // before the sanctioned-exclusion block ever runs, so it can never reach this guard. The
    // only scenario where a pre-existing symlink can survive to be checked here is at exactly
    // one of those two exempt names, with a sanctioned entry naming that same path.
    const outside = mkdtemp('vendor-skill-symsafe-outside-')
    const sentinelPath = join(outside, 'sentinel.txt')
    writeFileSync(sentinelPath, 'do not delete me\n')

    const upstream = initUpstream()
    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const sanctionedPath = join(mkdtemp('vendor-skill-symsafe-sanctioned-'), 'sanctioned.json')
    const dest = join(skillsDir, 'foo')

    writeFileSync(sanctionedPath, JSON.stringify({ sanctioned: {} }))
    let res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir, VENDOR_SANCTIONED_FILE: sanctionedPath },
    )
    expect(res.status, res.stderr).toBe(0)

    // Replace the real VENDORED.md with a symlink escaping dest -- cleanup exempts this exact
    // name, and this upstream never ships its own VENDORED.md, so cp -RL never overwrites it.
    rmSync(join(dest, 'VENDORED.md'))
    symlinkSync(outside, join(dest, 'VENDORED.md'), 'dir')

    writeFileSync(
      sanctionedPath,
      JSON.stringify({ sanctioned: { [dest]: ['missing:VENDORED.md'] } }),
    )
    res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir, VENDOR_SANCTIONED_FILE: sanctionedPath },
    )
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('resolves outside dest')
    expect(existsSync(sentinelPath)).toBe(true)
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('do not delete me\n')
  })

  it('a leftover VENDORED.md symlink from a prior run is replaced with a real file, never written through (WRITETHRU924 guard)', () => {
    const outside = mkdtemp('vendor-skill-symsafe-outside-')
    const sentinelPath = join(outside, 'sentinel.txt')
    writeFileSync(sentinelPath, 'untouched\n')

    const upstream = initUpstream()
    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const dest = join(skillsDir, 'foo')

    let res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status, res.stderr).toBe(0)

    // Replace the real VENDORED.md the first run wrote with a symlink to the sentinel -- the
    // top-level cleanup explicitly SKIPS this filename on the next run, so it survives into it.
    rmSync(join(dest, 'VENDORED.md'))
    symlinkSync(sentinelPath, join(dest, 'VENDORED.md'))
    expect(lstatSync(join(dest, 'VENDORED.md')).isSymbolicLink()).toBe(true)

    res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status, res.stderr).toBe(0)
    expect(lstatSync(join(dest, 'VENDORED.md')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(dest, 'VENDORED.md'), 'utf-8')).toContain('VENDORED -- do not edit here')
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('untouched\n')
  })

  it('a leftover UPSTREAM-LICENSE symlink from a prior run is replaced with a real file, never written through (WRITETHRU924 guard)', () => {
    const outside = mkdtemp('vendor-skill-symsafe-outside-')
    const sentinelPath = join(outside, 'sentinel.txt')
    writeFileSync(sentinelPath, 'untouched\n')

    const upstream = initUpstream()
    writeFileSync(join(upstream, 'LICENSE'), 'MIT\n')
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'add root LICENSE')

    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const dest = join(skillsDir, 'foo')

    let res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status, res.stderr).toBe(0)
    expect(readFileSync(join(dest, 'UPSTREAM-LICENSE'), 'utf-8')).toBe('MIT\n')

    rmSync(join(dest, 'UPSTREAM-LICENSE'))
    symlinkSync(sentinelPath, join(dest, 'UPSTREAM-LICENSE'))

    res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status, res.stderr).toBe(0)
    expect(lstatSync(join(dest, 'UPSTREAM-LICENSE')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(dest, 'UPSTREAM-LICENSE'), 'utf-8')).toBe('MIT\n')
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('untouched\n')
  })
})

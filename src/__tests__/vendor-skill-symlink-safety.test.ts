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
// Use /tmp explicitly, not tmpdir(): fleet-test.sh overrides TMPDIR to a path under $HOME
// (vendor-skill-sanctioned-exclusion.test.ts's beforeAll documents this), and vendor-skill.sh
// normalises sanctioned-exclusion dest keys with ${dest/#"$HOME"/\~} -- a dest under $HOME
// would be stored as ~/... in the JSON but this file's REALPATH924 test writes the raw
// /home/... path as the key, causing a lookup miss and the exclusion silently not applying.
function mkdtemp(prefix: string): string {
  const d = mkdtempSync(join('/tmp', prefix))
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
    // RELATIVE target, unlike F1's escape test above: a symlink committed with an ABSOLUTE target
    // under the fixture repo's own pre-clone path keeps pointing at that original path after
    // `git clone` copies the tree elsewhere -- literally escaping $src from the clone's point of
    // view, which is a test bug, not a real "stays inside" case. A relative target resolves
    // relative to the symlink's own location, so it correctly follows the tree into the clone.
    symlinkSync(join('nested', 'real.txt'), join(upstream, 'skills', 'foo', 'inside-link'))
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

  // CYBERED NO-GO 39256, finding F-1: the broken-symlink tests above use a target whose PARENT
  // directory is also missing (`/this/path/does/not/exist/...`) -- the one shape plain `realpath`
  // (no -e) actually fails to resolve. A dangling symlink whose target's PARENT exists, only the
  // final component is missing, resolves fine under plain `realpath` (it only requires leading
  // components to exist), so it passed the old containment check and let the destructive steps
  // run before `cp -RL` itself failed on the missing file.
  it('a dangling symlink whose missing target sits in an EXISTING directory aborts before any destructive step', () => {
    const upstream = initUpstream()
    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const dest = join(skillsDir, 'foo')

    let res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status, res.stderr).toBe(0)
    const vendoredBefore = readFileSync(join(dest, 'VENDORED.md'), 'utf-8')

    symlinkSync('missing.txt', join(upstream, 'skills', 'foo', 'dangling'))
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'dangling symlink, existing parent')

    res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status).not.toBe(0)
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toBe('free content\n')
    expect(readFileSync(join(dest, 'VENDORED.md'), 'utf-8')).toBe(vendoredBefore)
  })

  it('a dangling symlink (existing-parent variant) at a root-vendor never leaves a .git behind in dest', () => {
    const upstream = initUpstream()
    symlinkSync('missing.txt', join(upstream, 'dangling-root'))
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'root-level dangling symlink')

    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const res = runVendor(['--repo', upstream, '--name', 'rootfoo2'], { CLAUDE_SKILLS_DIR: skillsDir })

    expect(res.status).not.toBe(0)
    const dest = join(skillsDir, 'rootfoo2')
    expect(existsSync(join(dest, '.git'))).toBe(false)
  })

  // CYBERED NO-GO 39256, finding F-1 continued: a directory symlink pointing at its own ancestor
  // (here `d/up -> ..`, i.e. back at $src) resolves to a real, existing, in-tree target, so it
  // passed BOTH the existence check and the old containment check (which explicitly allowed
  // "resolves to src itself"). `cp -RL` dereferencing it then recurses without bound, failing only
  // after the destructive cleanup already ran.
  it('a directory symlink that loops back to an ancestor (including $src itself) is rejected up front', () => {
    const upstream = initUpstream()
    mkdirSync(join(upstream, 'skills', 'foo', 'd'))
    symlinkSync('..', join(upstream, 'skills', 'foo', 'd', 'up'), 'dir')
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'ancestor-loop symlink')

    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status).not.toBe(0)
    expect(existsSync(join(skillsDir, 'foo'))).toBe(false)
  })
})

describe('F1 residuals (card af3cd669, CYBERED NO-GO 39256 F-2): the old guard only validated symlinks already found under $src, not the three routes below that redirect $src/LICENSE_FILE themselves', () => {
  it('refuses to vendor when --subdir itself resolves, via a symlink, outside the upstream clone', () => {
    const outside = mkdtemp('vendor-skill-symsafe-outside-')
    const sentinelPath = join(outside, 'canary.txt')
    writeFileSync(sentinelPath, 'LOCAL CANARY -- must never be vendored\n')

    const upstream = initUpstream()
    symlinkSync(outside, join(upstream, 'skills', 'evil'), 'dir')
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'subdir itself is an escaping symlink')

    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const res = runVendor(
      ['--repo', upstream, '--name', 'evilname', '--subdir', 'skills/evil'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status).not.toBe(0)
    expect(existsSync(join(skillsDir, 'evilname'))).toBe(false)
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('LOCAL CANARY -- must never be vendored\n')
  })

  it('refuses to vendor when a MIDDLE component of --subdir is a symlink escaping the clone', () => {
    const outside = mkdtemp('vendor-skill-symsafe-outside-')
    mkdirSync(join(outside, 's'))
    const sentinelPath = join(outside, 's', 'canary.txt')
    writeFileSync(sentinelPath, 'LOCAL CANARY -- must never be vendored\n')

    const upstream = initUpstream()
    symlinkSync(outside, join(upstream, 'skills', 'link'), 'dir')
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'middle-component escaping symlink')

    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const res = runVendor(
      ['--repo', upstream, '--name', 'evilname2', '--subdir', 'skills/link/s'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status).not.toBe(0)
    expect(existsSync(join(skillsDir, 'evilname2'))).toBe(false)
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('LOCAL CANARY -- must never be vendored\n')
  })

  it('refuses to vendor when the resolved LICENSE file escapes the upstream clone via a symlink', () => {
    const outside = mkdtemp('vendor-skill-symsafe-outside-')
    const sentinelPath = join(outside, 'local-license.txt')
    writeFileSync(sentinelPath, 'LOCAL LICENSE CONTENT -- must never be vendored\n')

    const upstream = initUpstream()
    symlinkSync(sentinelPath, join(upstream, 'LICENSE'))
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'LICENSE is an escaping symlink')

    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status).not.toBe(0)
    const dest = join(skillsDir, 'foo')
    if (existsSync(dest)) {
      expect(existsSync(join(dest, 'UPSTREAM-LICENSE'))).toBe(false)
    }
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('LOCAL LICENSE CONTENT -- must never be vendored\n')
  })
})

describe('F3 fixture gaps (card af3cd669, CYBERED NO-GO 39256 F-3): pin the slash in the containment check and the equal-to-src rejection', () => {
  it('refuses a symlink resolving to a SIBLING directory sharing a name prefix with $src', () => {
    const upstream = initUpstream()
    mkdirSync(join(upstream, 'skills', 'foo-evil'))
    const sentinelPath = join(upstream, 'skills', 'foo-evil', 'canary.txt')
    writeFileSync(sentinelPath, 'LOCAL CANARY -- must never be vendored\n')
    symlinkSync('../foo-evil/canary.txt', join(upstream, 'skills', 'foo', 'link'))
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'sibling-prefix escaping symlink')

    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status).not.toBe(0)
    expect(existsSync(join(skillsDir, 'foo'))).toBe(false)
  })

  it('refuses a symlink that resolves to $src itself', () => {
    const upstream = initUpstream()
    symlinkSync('.', join(upstream, 'skills', 'foo', 'self'), 'dir')
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'self-referential symlink')

    const skillsDir = mkdtemp('vendor-skill-symsafe-skills-')
    const res = runVendor(
      ['--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'],
      { CLAUDE_SKILLS_DIR: skillsDir },
    )
    expect(res.status).not.toBe(0)
    expect(existsSync(join(skillsDir, 'foo'))).toBe(false)
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

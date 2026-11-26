import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, symlinkSync, existsSync, lstatSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

// EXCLUSION924 (card fd0b2180, Cybersec F1 on 728179d1): vendor-skill.sh had no memory of a
// deliberate exclusion decision (e.g. Peti removing a paid-feature file after the first
// vendor) -- a re-vendor just `cp -R`s whatever upstream ships today, silently restoring an
// excluded path with no warning. Fixed by consulting store/vendored-skill-sanctioned.json's
// "missing:<path>" entries after the copy step and re-deleting them. VENDOR_SANCTIONED_FILE
// lets this test point at a throwaway baseline instead of the real, tracked one.
const ROOT = join(__dirname, '..', '..')

// Test-isolation fix (found while landing card 68254bd7, unrelated card): vendor-skill.sh derives
// its git-clone-cache dir (ADOPTED_DIR) from its OWN on-disk location (`$(dirname "$0")/adopted`),
// never from an env var. Invoking the real store/vendor-skill.sh directly, as this file used to,
// made every clone in this test land in the REAL, TRACKED store/adopted/ of whatever checkout runs
// the suite -- never cleaned up, and racing any other test (e.g. token-in-argv-guard.test.ts) that
// scans store/adopted/ concurrently in the same vitest run (TOCTOU ENOENT, or a stray curl-shaped
// fixture string). Fixed the same way vendor-skill-dest.test.ts / vendor-skill-no-git.test.ts
// already do: copy the script into a throwaway sandbox so `$(dirname "$0")` -- and therefore
// ADOPTED_DIR -- resolves inside the sandbox instead.
let scriptSandbox: string
let SCRIPT: string
beforeAll(() => {
  // Use /tmp explicitly: fleet-test.sh overrides TMPDIR to a path under $HOME, and vendor-skill.sh
  // normalises dest keys with ${dest/#"$HOME"/\~} -- a dest under $HOME would be stored as ~/...
  // in the JSON but the test writes /home/... as the key, causing a lookup miss and silent bypass.
  scriptSandbox = mkdtempSync(join('/tmp', 'vendor-skill-sanctioned-script-'))
  SCRIPT = join(scriptSandbox, 'vendor-skill.sh')
  copyFileSync(join(ROOT, 'store', 'vendor-skill.sh'), SCRIPT)
})
afterAll(() => {
  rmSync(scriptSandbox, { recursive: true, force: true })
})

const dirs: string[] = []
function mkdtemp(prefix: string): string {
  const d = mkdtempSync(join('/tmp', prefix))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd })
}

function makeUpstream(): string {
  const repo = mkdtemp('vendor-skill-upstream-')
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'a@b.c')
  git(repo, 'config', 'user.name', 't')
  mkdirSync(join(repo, 'skills', 'foo'), { recursive: true })
  writeFileSync(join(repo, 'skills', 'foo', 'SKILL.md'), 'free content\n')
  writeFileSync(join(repo, 'skills', 'foo', 'CLOUD.md'), 'paid feature content\n')
  git(repo, 'add', 'skills/foo')
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init')
  return repo
}

function runVendor(upstream: string, skillsDir: string, sanctionedFile: string) {
  return spawnSync('bash', [SCRIPT, '--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'], {
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_SKILLS_DIR: skillsDir, VENDOR_SANCTIONED_FILE: sanctionedFile },
  })
}

describe('vendor-skill.sh respects vendored-skill-sanctioned.json "missing:" exclusions', () => {
  it('a re-vendor does NOT restore a sanctioned-excluded path', () => {
    const upstream = makeUpstream()
    const skillsDir = mkdtemp('vendor-skill-skills-')
    const sanctionedPath = join(mkdtemp('vendor-skill-sanctioned-'), 'sanctioned.json')
    const dest = join(skillsDir, 'foo')

    // First vendor: no sanctioned file at all -- both files land, same as before this fix.
    writeFileSync(sanctionedPath, JSON.stringify({ sanctioned: {} }))
    let res = runVendor(upstream, skillsDir, sanctionedPath)
    expect(res.status, res.stderr).toBe(0)
    expect(readdirSync(dest).sort()).toEqual(['CLOUD.md', 'SKILL.md', 'VENDORED.md'])

    // Simulate the exclusion decision (what a human does by hand after vendoring) and record it.
    rmSync(join(dest, 'CLOUD.md'))
    writeFileSync(sanctionedPath, JSON.stringify({ sanctioned: { [dest]: ['missing:CLOUD.md'] } }))

    // Re-vendor: CLOUD.md must stay excluded.
    res = runVendor(upstream, skillsDir, sanctionedPath)
    expect(res.status, res.stderr).toBe(0)
    expect(readdirSync(dest).sort()).toEqual(['SKILL.md', 'VENDORED.md'])
  })

  it('refuses a suspicious exclusion path (absolute or containing ..) with a nonzero exit', () => {
    const upstream = makeUpstream()
    const skillsDir = mkdtemp('vendor-skill-skills-')
    const sanctionedPath = join(mkdtemp('vendor-skill-sanctioned-'), 'sanctioned.json')
    const dest = join(skillsDir, 'foo')

    writeFileSync(sanctionedPath, JSON.stringify({ sanctioned: {} }))
    runVendor(upstream, skillsDir, sanctionedPath)

    writeFileSync(sanctionedPath, JSON.stringify({ sanctioned: { [dest]: ['missing:../../../etc/passwd'] } }))
    // FAILCLOSED924 (card f3a6f30a): a refused entry used to degrade to "not excluded" with
    // exit 0 -- a silent skip of a deliberate exclusion decision. It must now fail loud, so a
    // caller (or a human watching the vendor run) notices immediately instead of waiting for
    // the next integrity-heartbeat sweep.
    const res = runVendor(upstream, skillsDir, sanctionedPath)
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('refusing suspicious')
    // The legitimate files are untouched -- a refused exclusion never deletes anything else.
    expect(readdirSync(dest).sort()).toEqual(['CLOUD.md', 'SKILL.md', 'VENDORED.md'])
  })

  it('refuses to vendor a symlinked directory that escapes $src, before touching dest', () => {
    // SYMLINKESC924 (card f3a6f30a, RedHat): upstream ships a symlinked directory. That fix made
    // `cp -RL` dereference it into a real directory on copy, treating "safe because it's a copy,
    // not a live symlink, once inside dest" as the containment guarantee -- which still let
    // `cp -RL` read (dereference) whatever the symlink pointed at, no matter where that was.
    // SYMLINKVALIDATE924 (card af3cd669, WhiteHat, canary-measured) supersedes that model: ANY
    // upstream symlink resolving outside $src is now refused up front, before $dest is touched at
    // all, because the earlier "dereference is safe" reasoning never actually stopped the local
    // file's CONTENT from being pulled into the vendored skill. The REALPATH924 sanctioned-
    // exclusion guard this test used to reach via a surviving upstream symlink is still reachable,
    // just only via a DEST-side leftover at an exempt name -- see
    // vendor-skill-symlink-safety.test.ts's own REALPATH924 test for that path.
    const outside = mkdtemp('vendor-skill-outside-')
    const sentinelPath = join(outside, 'sentinel.txt')
    writeFileSync(sentinelPath, 'do not delete me\n')

    const upstream = makeUpstream()
    mkdirSync(join(upstream, 'skills', 'foo', 'linked'))
    symlinkSync(outside, join(upstream, 'skills', 'foo', 'linked', 'target'), 'dir')
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'add symlinked dir')

    const skillsDir = mkdtemp('vendor-skill-skills-')
    const sanctionedPath = join(mkdtemp('vendor-skill-sanctioned-'), 'sanctioned.json')
    const dest = join(skillsDir, 'foo')

    writeFileSync(sanctionedPath, JSON.stringify({ sanctioned: {} }))
    const res = runVendor(upstream, skillsDir, sanctionedPath)
    expect(res.status).not.toBe(0)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(sentinelPath)).toBe(true)
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('do not delete me\n')
  })

  it('refuses to vendor when the sanctioned-exclusions file is corrupt JSON (fail-closed)', () => {
    const upstream = makeUpstream()
    const skillsDir = mkdtemp('vendor-skill-skills-')
    const sanctionedPath = join(mkdtemp('vendor-skill-sanctioned-'), 'sanctioned.json')

    writeFileSync(sanctionedPath, '{ this is not valid json')
    const res = runVendor(upstream, skillsDir, sanctionedPath)
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('unreadable/corrupt')
  })

  it('refuses to vendor when upstream ships VENDORED.md itself as an escaping symlink', () => {
    // WRITETHRU924 (card f3a6f30a, RedHat): this used to prove the `cat > dest/VENDORED.md`
    // provenance write dereferenced upstream's own VENDORED.md symlink into a plain file instead
    // of following it. SYMLINKVALIDATE924 (card af3cd669, WhiteHat, canary-measured) now refuses
    // ANY upstream symlink escaping $src before $dest is touched, including one at this exact
    // name -- the WRITETHRU924 guard itself is still reachable, just only via a DEST-side leftover
    // symlink surviving a re-vendor; see vendor-skill-symlink-safety.test.ts's own WRITETHRU924
    // test for that path.
    const outside = mkdtemp('vendor-skill-outside-')
    const sentinelPath = join(outside, 'sentinel.txt')
    writeFileSync(sentinelPath, 'untouched\n')

    const upstream = makeUpstream()
    symlinkSync(sentinelPath, join(upstream, 'skills', 'foo', 'VENDORED.md'))
    git(upstream, 'add', '-A')
    git(upstream, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'upstream ships a VENDORED.md symlink')

    const skillsDir = mkdtemp('vendor-skill-skills-')
    const sanctionedPath = join(mkdtemp('vendor-skill-sanctioned-'), 'sanctioned.json')
    const dest = join(skillsDir, 'foo')
    writeFileSync(sanctionedPath, JSON.stringify({ sanctioned: {} }))

    const res = runVendor(upstream, skillsDir, sanctionedPath)
    expect(res.status).not.toBe(0)
    expect(existsSync(dest)).toBe(false)
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('untouched\n')
  })

  it('applies a sanctioned exclusion recorded with a real ~/-prefixed key (the tilde transform)', () => {
    // The real store/vendored-skill-sanctioned.json keys every entry as "~/..." -- the bash
    // `dest_key="${dest/#"$HOME"/\~}"` anchored-prefix substitution is what produces that form.
    // Every other test in this file points skillsDir at a plain /tmp path that never starts
    // with $HOME, so the substitution never actually fires there and a break in the anchor
    // (e.g. turning it into an unanchored replace) would go unnoticed. Point a fake $HOME at
    // the skills dir's parent so the substitution engages for real.
    const upstream = makeUpstream()
    const fakeHome = mkdtemp('vendor-skill-fake-home-')
    const skillsDir = join(fakeHome, '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    const sanctionedPath = join(mkdtemp('vendor-skill-sanctioned-'), 'sanctioned.json')
    const dest = join(skillsDir, 'foo')

    writeFileSync(sanctionedPath, JSON.stringify({ sanctioned: {} }))
    let res = spawnSync('bash', [SCRIPT, '--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: fakeHome, CLAUDE_SKILLS_DIR: skillsDir, VENDOR_SANCTIONED_FILE: sanctionedPath },
    })
    expect(res.status, res.stderr).toBe(0)

    rmSync(join(dest, 'CLOUD.md'))
    writeFileSync(sanctionedPath, JSON.stringify({ sanctioned: { '~/.claude/skills/foo': ['missing:CLOUD.md'] } }))
    res = spawnSync('bash', [SCRIPT, '--repo', upstream, '--name', 'foo', '--subdir', 'skills/foo'], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: fakeHome, CLAUDE_SKILLS_DIR: skillsDir, VENDOR_SANCTIONED_FILE: sanctionedPath },
    })
    expect(res.status, res.stderr).toBe(0)
    expect(readdirSync(dest).sort()).toEqual(['SKILL.md', 'VENDORED.md'])
  })

  it('control: without a sanctioned entry, a re-vendor restores whatever upstream currently ships', () => {
    const upstream = makeUpstream()
    const skillsDir = mkdtemp('vendor-skill-skills-')
    const sanctionedPath = join(mkdtemp('vendor-skill-sanctioned-'), 'sanctioned.json')
    const dest = join(skillsDir, 'foo')

    writeFileSync(sanctionedPath, JSON.stringify({ sanctioned: {} }))
    runVendor(upstream, skillsDir, sanctionedPath)
    rmSync(join(dest, 'CLOUD.md'))

    // No sanctioned entry recorded this time -- the fix must not become "always exclude".
    const res = runVendor(upstream, skillsDir, sanctionedPath)
    expect(res.status, res.stderr).toBe(0)
    expect(readdirSync(dest).sort()).toEqual(['CLOUD.md', 'SKILL.md', 'VENDORED.md'])
  })
})

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
  scriptSandbox = mkdtempSync(join(tmpdir(), 'vendor-skill-sanctioned-script-'))
  SCRIPT = join(scriptSandbox, 'vendor-skill.sh')
  copyFileSync(join(ROOT, 'store', 'vendor-skill.sh'), SCRIPT)
})
afterAll(() => {
  rmSync(scriptSandbox, { recursive: true, force: true })
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

  it('refuses a suspicious exclusion path (absolute or containing ..) instead of rm -rf-ing it', () => {
    const upstream = makeUpstream()
    const skillsDir = mkdtemp('vendor-skill-skills-')
    const sanctionedPath = join(mkdtemp('vendor-skill-sanctioned-'), 'sanctioned.json')
    const dest = join(skillsDir, 'foo')

    writeFileSync(sanctionedPath, JSON.stringify({ sanctioned: {} }))
    runVendor(upstream, skillsDir, sanctionedPath)

    writeFileSync(sanctionedPath, JSON.stringify({ sanctioned: { [dest]: ['missing:../../../etc/passwd'] } }))
    const res = runVendor(upstream, skillsDir, sanctionedPath)
    expect(res.status, res.stderr).toBe(0)
    expect(res.stderr).toContain('refusing suspicious')
    // The legitimate files are untouched -- a refused exclusion degrades to "not excluded",
    // never to "vendor failed" or "something else got deleted".
    expect(readdirSync(dest).sort()).toEqual(['CLOUD.md', 'SKILL.md', 'VENDORED.md'])
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

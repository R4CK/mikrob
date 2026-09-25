// store/vendor-skill.sh: a root-vendored skill (no --subdir) must never carry a .git directory
// into ~/.claude/skills/<name>/ (card 728179d1, Cybersec finding on card 3c73a420).
//
// WHY THIS MATTERS. src == the clone itself when --subdir is omitted, so `cp -R "$src/."` used to
// copy $clone/.git along with the payload -- the vendored copy became a full git working tree
// tracking upstream. Measured live: ~/.claude/skills/caveman (branch main, tracking origin/main,
// 10 tracked deletions restoring Peti's excluded Caveman-Cloud skills) and ~/.claude/skills/unlazy
// (detached HEAD). A bare `git pull`/`git restore .`/`git checkout .` on either would bypass the
// whole point of the type=code vendored-skill registry (detect+flag upstream drift, never
// auto-apply it) with no review, no card, no signal.
//
// END TO END, not source-level: the script is copied into a sandbox (so its own store/adopted/
// clone cache is isolated) and run against a REAL local git repo (a file:// clone target, no
// network needed) in root-vendoring mode -- the exact shape that triggered the bug.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
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
  sandbox = mkdtempSync(join(tmpdir(), 'vendor-skill-nogit-'))
  copyFileSync(join(ROOT, 'store', 'vendor-skill.sh'), join(sandbox, 'vendor-skill.sh'))

  // A real, tiny local repo to clone from -- vendor-skill.sh's own `git clone -q "$REPO"` works
  // against a plain filesystem path exactly as it would against a URL.
  upstreamRepo = join(sandbox, 'upstream-repo')
  mkdirSync(upstreamRepo, { recursive: true })
  git(['init', '-q', '-b', 'main'], upstreamRepo)
  git(['config', 'user.email', 'a@b'], upstreamRepo)
  git(['config', 'user.name', 't'], upstreamRepo)
  writeFileSync(join(upstreamRepo, 'SKILL.md'), '# fake skill\n')
  git(['add', 'SKILL.md'], upstreamRepo)
  git(['commit', '-q', '-m', 'one'], upstreamRepo)
})

afterAll(() => { rmSync(sandbox, { recursive: true, force: true }) })

describe('vendor-skill.sh: root-vendoring never leaves a .git in the destination (card 728179d1)', () => {
  it('a --repo vendor with no --subdir copies the payload but not .git', () => {
    const skillsDir = join(sandbox, 'skills-dest-1')
    const r = execFileSync(
      'bash',
      [join(sandbox, 'vendor-skill.sh'), '--repo', upstreamRepo, '--name', 'fake-root-skill'],
      { cwd: sandbox, encoding: 'utf-8', env: { ...process.env, CLAUDE_SKILLS_DIR: skillsDir } },
    )
    void r
    const dest = join(skillsDir, 'fake-root-skill')
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dest, '.git'))).toBe(false)
  })

  it('CONTROL: a --subdir vendor (the case that never had the bug) still has no .git either', () => {
    // A second commit adding a subdirectory, so --subdir has something real to point at.
    mkdirSync(join(upstreamRepo, 'sub'), { recursive: true })
    writeFileSync(join(upstreamRepo, 'sub', 'SKILL.md'), '# fake sub skill\n')
    git(['add', 'sub/SKILL.md'], upstreamRepo)
    git(['commit', '-q', '-m', 'two'], upstreamRepo)

    const skillsDir = join(sandbox, 'skills-dest-2')
    execFileSync(
      'bash',
      [join(sandbox, 'vendor-skill.sh'), '--repo', upstreamRepo, '--name', 'fake-sub-skill', '--subdir', 'sub'],
      { cwd: sandbox, encoding: 'utf-8', env: { ...process.env, CLAUDE_SKILLS_DIR: skillsDir } },
    )
    const dest = join(skillsDir, 'fake-sub-skill')
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dest, '.git'))).toBe(false)
  })
})

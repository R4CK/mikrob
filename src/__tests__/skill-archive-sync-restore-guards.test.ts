// Card a9878e3e (WhiteHat CYBERSEC GO on 0fb92c16, komment f0b88947/msg 10408), F1: the three
// safety guards added to store/skill-archive-sync.sh and store/skill-archive-restore.sh (card
// 0fb92c16, items 1-2) -- the dot-prefixed-name refusal in BOTH scripts, and the remote-tilalom
// refusal in sync.sh -- had NO test coverage at all. A mutation sweep over those lines found 3/3
// survivors (nothing exercised the refusal paths), so a future edit that silently drops or
// weakens any of the three would ship undetected.
//
// This runs the REAL scripts end to end (execFileSync, sandboxed $HOME) against both the refusal
// paths (must exit non-zero with the documented message) and a clean control (must succeed), so a
// mutation that removes or weakens a guard flips at least one of these tests.
//
// Also covers F2 (same card): sync.sh's remote-tilalom originally checked ONLY `git remote`
// output. A legacy .git/remotes/<name> file or a branch.<branch>.remote config value can make a
// push succeed while `git remote` still prints nothing -- both paths are now checked too.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SYNC = join(REPO_ROOT, 'store', 'skill-archive-sync.sh')
const RESTORE = join(REPO_ROOT, 'store', 'skill-archive-restore.sh')

function run(script: string, args: string[], home: string): { out: string; code: number } {
  try {
    const out = execFileSync('bash', [script, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
    })
    return { out, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
  }
}

function sandboxHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'skill-archive-home-'))
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  return home
}

function makeLiveSkill(home: string, name: string): void {
  const dir = join(home, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: test\n---\nbody\n')
}

describe('skill-archive-sync.sh / skill-archive-restore.sh dot-prefixed-name guard (card a9878e3e F1)', () => {
  it('sync.sh refuses a ".git" skill name (would resolve DEST to the archive\'s own .git)', () => {
    const home = sandboxHome()
    try {
      makeLiveSkill(home, '.git')
      const r = run(SYNC, ['.git'], home)
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('dot-prefixed')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('sync.sh refuses any dot-prefixed name, not just ".git"', () => {
    const home = sandboxHome()
    try {
      makeLiveSkill(home, '.hidden-skill')
      const r = run(SYNC, ['.hidden-skill'], home)
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('dot-prefixed')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('sync.sh ACCEPTS a normal skill name (control: the guard does not over-refuse)', () => {
    const home = sandboxHome()
    try {
      makeLiveSkill(home, 'normal-skill')
      const r = run(SYNC, ['normal-skill'], home)
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('copied')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('restore.sh refuses a ".git" skill name (would resolve SRC to the archive\'s own .git)', () => {
    const home = sandboxHome()
    try {
      // Seed an archive with a real ".git"-named entry would require bypassing sync.sh's own
      // guard, so the archive dir is built directly here -- restore.sh's guard must fire on the
      // name alone, before it even looks at what is archived.
      mkdirSync(join(home, '.claude', 'skill-archive', '.git-shadow'), { recursive: true })
      const r = run(RESTORE, ['.git', '--yes'], home)
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('dot-prefixed')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('restore.sh refuses any dot-prefixed name, not just ".git"', () => {
    const home = sandboxHome()
    try {
      const r = run(RESTORE, ['.hidden-skill', '--yes'], home)
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('dot-prefixed')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('restore.sh ACCEPTS a normal skill name (control: the guard does not over-refuse)', () => {
    const home = sandboxHome()
    try {
      const archDir = join(home, '.claude', 'skill-archive', 'normal-skill')
      mkdirSync(archDir, { recursive: true })
      writeFileSync(join(archDir, 'SKILL.md'), 'archived body\n')
      const r = run(RESTORE, ['normal-skill', '--yes'], home)
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('restored')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('skill-archive-sync.sh remote-tilalom guard (card a9878e3e F1 + F2)', () => {
  it('refuses when the archive has a named git remote (`git remote add`)', () => {
    const home = sandboxHome()
    try {
      makeLiveSkill(home, 'normal-skill')
      // First sync initializes the archive repo; then add a remote to it directly.
      expect(run(SYNC, ['normal-skill'], home).code).toBe(0)
      execFileSync('git', ['-C', join(home, '.claude', 'skill-archive'), 'remote', 'add', 'origin', 'https://example.invalid/x.git'])
      const r = run(SYNC, ['normal-skill'], home)
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('git remote configured')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('ACCEPTS a remote-less archive (control: the guard does not over-refuse)', () => {
    const home = sandboxHome()
    try {
      makeLiveSkill(home, 'normal-skill')
      const r = run(SYNC, ['normal-skill'], home)
      expect(r.code, r.out).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  // F2: a legacy .git/remotes/<name> file is honored by `git push <name>` even though `git
  // remote` never lists it (that command only reads [remote "..."] stanzas in .git/config).
  it('F2: refuses when the archive has a legacy .git/remotes/<name> file, even though `git remote` prints nothing', () => {
    const home = sandboxHome()
    try {
      makeLiveSkill(home, 'normal-skill')
      expect(run(SYNC, ['normal-skill'], home).code).toBe(0)
      const archiveRoot = join(home, '.claude', 'skill-archive')
      // Sanity: `git remote` really is empty at this point -- otherwise this test would pass for
      // the wrong reason (the OLD check, not the new legacy-path check).
      const remoteList = execFileSync('git', ['-C', archiveRoot, 'remote'], { encoding: 'utf-8' }).trim()
      expect(remoteList).toBe('')
      mkdirSync(join(archiveRoot, '.git', 'remotes'), { recursive: true })
      writeFileSync(join(archiveRoot, '.git', 'remotes', 'origin'), 'URL: https://example.invalid/x.git\nPull: refs/heads/*:refs/remotes/origin/*\n')
      const r = run(SYNC, ['normal-skill'], home)
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('legacy .git/remotes')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  // F2: branch.<branch>.remote can be set directly to a URL (valid git config, no `git remote
  // add` required), so `git remote` prints nothing while `git push` with no args still resolves
  // a destination from this value.
  it('F2: refuses when the archive has a branch.<branch>.remote config value, even though `git remote` prints nothing', () => {
    const home = sandboxHome()
    try {
      makeLiveSkill(home, 'normal-skill')
      expect(run(SYNC, ['normal-skill'], home).code).toBe(0)
      const archiveRoot = join(home, '.claude', 'skill-archive')
      const remoteList = execFileSync('git', ['-C', archiveRoot, 'remote'], { encoding: 'utf-8' }).trim()
      expect(remoteList).toBe('')
      const branch = execFileSync('git', ['-C', archiveRoot, 'branch', '--show-current'], { encoding: 'utf-8' }).trim()
      execFileSync('git', ['-C', archiveRoot, 'config', `branch.${branch}.remote`, 'https://example.invalid/x.git'])
      const r = run(SYNC, ['normal-skill'], home)
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('branch.<name>.remote')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

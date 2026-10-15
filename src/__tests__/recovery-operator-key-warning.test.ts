// Card 0c508c7b, F2 (WhiteHat2 on d7e1d611 @4e5aef10): a rollback to a commit that predates
// device-key scope would make a LIVE operator-scoped key behave as 'full' (no scope column in the
// old code). recovery-prev-version.sh must warn loudly, BEFORE the rollback happens, if any
// operator-scoped key currently exists, naming how to revoke it.
//
// This builds a throwaway repo + SQLite DB (not the real install) and runs the real
// recovery-prev-version.sh --dry-run against it, so the warning is proved by actual output, not
// by reading the source.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RECOVERY = join(REPO, 'recovery-prev-version.sh')
const GUARD = join(REPO, 'store', 'rollback-guard.sh')

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', stdio: 'pipe' })
}

function makeRepo(): { dir: string; older: string } {
  const dir = mkdtempSync(join(tmpdir(), 'recov-opkey-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@local')
  git(dir, 'config', 'user.name', 'test')
  mkdirSync(join(dir, 'store'), { recursive: true })
  writeFileSync(join(dir, 'f'), '0')
  git(dir, 'add', 'f')
  git(dir, 'commit', '-q', '-m', 'c0')
  const older = git(dir, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(dir, 'f'), '1')
  git(dir, 'add', 'f')
  git(dir, 'commit', '-q', '-m', 'c1')
  copyFileSync(RECOVERY, join(dir, 'recovery-prev-version.sh'))
  chmodSync(join(dir, 'recovery-prev-version.sh'), 0o755)
  copyFileSync(GUARD, join(dir, 'store', 'rollback-guard.sh'))
  return { dir, older }
}

function seedDeviceKeysDb(dir: string, operatorKeyCount: number): void {
  const schema = `
    CREATE TABLE IF NOT EXISTS device_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      scope TEXT NOT NULL DEFAULT 'full'
    );
    DELETE FROM device_keys;
  `
  let inserts = ''
  for (let i = 0; i < operatorKeyCount; i++) {
    inserts += `INSERT INTO device_keys (key_hash, name, created_at, scope) VALUES ('h${i}', 'k${i}', 0, 'operator');\n`
  }
  execFileSync('sqlite3', [join(dir, 'store', 'claudeclaw.db')], { input: schema + inserts, stdio: 'pipe' })
}

function runRecovery(dir: string, target: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [join(dir, 'recovery-prev-version.sh'), '--to', target, '--dry-run'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, ROLLBACK_GUARD_NOTIFY: '0' },
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

describe('recovery-prev-version.sh operator-key rollback warning (card 0c508c7b F2)', () => {
  let repo: { dir: string; older: string }
  beforeAll(() => {
    repo = makeRepo()
  })
  afterAll(() => {
    if (repo) rmSync(repo.dir, { recursive: true, force: true })
  })

  it('warns and names the revoke path when a live operator-scoped key exists', () => {
    seedDeviceKeysDb(repo.dir, 2)
    const r = runRecovery(repo.dir, repo.older)
    expect(r.out).toContain('2 élő operator-hatókörű kulcs')
    expect(r.out).toContain('/api/auth/device-keys/')
  })

  it('stays silent when there is no operator-scoped key', () => {
    seedDeviceKeysDb(repo.dir, 0)
    const r = runRecovery(repo.dir, repo.older)
    expect(r.out).not.toContain('operator-hatókörű kulcs')
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSeamDir } from './setup/default-ssh-dir-seam.js'

// WhiteHat F1 (card 2564e877, gate on 87fd2f19): two CONCURRENT `vitest run` invocations
// (CLAUDE.md rule 17 allows up to 2 at once) used to collide on the same
// /tmp/marveen-ssh-seam/w<pool-id> path, because VITEST_POOL_ID restarts at 1 for every
// run -- the entry-time rmSync in default-ssh-dir-seam.ts then wiped the OTHER run's
// directory mid-run, a false red unrelated to any real test failure.

describe('resolveSeamDir (87fd2f19 F1)', () => {
  let root: string

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('gives two concurrent runs on the same pool slot different directories', () => {
    root = join(tmpdir(), `ssh-seam-test-concurrent-${process.pid}-${Date.now()}`)
    const origSlot = process.env.VITEST_POOL_ID
    process.env.VITEST_POOL_ID = '1'
    try {
      const dirA = resolveSeamDir(root, '11111')
      const dirB = resolveSeamDir(root, '22222')
      expect(dirA).not.toBe(dirB)
    } finally {
      if (origSlot === undefined) delete process.env.VITEST_POOL_ID
      else process.env.VITEST_POOL_ID = origSlot
    }
  })

  it('reuses the same directory for the same run and pool slot (no accumulation)', () => {
    root = join(tmpdir(), `ssh-seam-test-reuse-${process.pid}-${Date.now()}`)
    const origSlot = process.env.VITEST_POOL_ID
    process.env.VITEST_POOL_ID = '1'
    try {
      const first = resolveSeamDir(root, '33333')
      const second = resolveSeamDir(root, '33333')
      expect(first).toBe(second)
    } finally {
      if (origSlot === undefined) delete process.env.VITEST_POOL_ID
      else process.env.VITEST_POOL_ID = origSlot
    }
  })

  it('prunes a stale run directory (dead pid) but keeps the live, current one', () => {
    root = join(tmpdir(), `ssh-seam-test-prune-${process.pid}-${Date.now()}`)
    const deadPid = 999999999 // not a real running pid
    mkdirSync(join(root, `r${deadPid}`, 'w1'), { recursive: true })
    const livePid = process.pid
    mkdirSync(join(root, `r${livePid}`, 'w1'), { recursive: true })

    resolveSeamDir(root, String(livePid))

    expect(existsSync(join(root, `r${deadPid}`))).toBe(false)
    expect(existsSync(join(root, `r${livePid}`))).toBe(true)
  })
})

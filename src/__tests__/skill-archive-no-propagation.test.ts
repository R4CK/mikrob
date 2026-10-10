// Card 59cfcb21 (MikroB DONTES condition 3): store/skill-archive/ is tracked but must NEVER be read
// by an installer or the agent-skill-drift-sync tool -- the day one of them does, the archive stops
// being "tracked but non-propagating" and becomes a second seed-skills/, which is exactly what this
// card was built to avoid for loki-mode-derived (BSL 1.1) content like evidence-gated-delivery.
//
// This pins the guard's PASS/FAIL contract behaviourally: run it against the real repo (must PASS),
// then against a throwaway copy where one installer-shaped file has been made to reference
// "skill-archive" (must FAIL) -- so a future installer edit that starts reading the archive is
// caught here, not discovered live.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'store', 'skill-archive-no-propagation.selftest.sh')

function run(root: string): { out: string; code: number } {
  try {
    const out = execFileSync('bash', [join(root, 'store', 'skill-archive-no-propagation.selftest.sh')], {
      cwd: root,
      encoding: 'utf-8',
    })
    return { out, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
  }
}

describe('skill-archive-no-propagation.selftest.sh', () => {
  it('PASSes against the real repo -- no installer/update.sh/drift-sync references store/skill-archive/', () => {
    const result = execFileSync('bash', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf-8' })
    expect(result).toContain('PASS')
  })

  it('MUTATION PROOF: an installer file referencing "skill-archive" flips the guard to FAIL', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-archive-guard-'))
    try {
      mkdirSync(join(root, 'store'), { recursive: true })
      copyFileSync(SCRIPT, join(root, 'store', 'skill-archive-no-propagation.selftest.sh'))
      writeFileSync(join(root, 'install-linux.sh'), '#!/usr/bin/env bash\necho hello\n')
      writeFileSync(join(root, 'update.sh'), '#!/usr/bin/env bash\necho hello\n')

      const clean = run(root)
      expect(clean.code).toBe(0)
      expect(clean.out).toContain('PASS')

      // Tamper: an installer starts reading the archive.
      writeFileSync(join(root, 'install-linux.sh'), '#!/usr/bin/env bash\ncp -r store/skill-archive/foo ~/.claude/skills/foo\n')

      const tampered = run(root)
      expect(tampered.code).toBe(1)
      expect(tampered.out).toContain('FAIL')
      expect(tampered.out).toContain('install-linux.sh')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Cybersec F4 (komment 14381): a plain substring match is evadable by a GENERIC wildcard copy
  // that never spells "skill-archive" at all -- e.g. `cp -r "$ROOT/store/"* "$dest/"` would sweep
  // in any future stray directory, named or not, without ever matching `grep -q "skill-archive"`.
  // This proves the hardened guard (card 59cfcb21 F1 fix, MikroB komment 14386) catches that case
  // via its generic-wildcard-copy check, independent of the literal-name belt-and-braces check.
  it('MUTATION PROOF: a generic wildcard copy of store/ or ~/.claude/ flips the guard to FAIL even without naming "skill-archive"', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-archive-guard-wildcard-'))
    try {
      mkdirSync(join(root, 'store'), { recursive: true })
      copyFileSync(SCRIPT, join(root, 'store', 'skill-archive-no-propagation.selftest.sh'))
      writeFileSync(join(root, 'install-linux.sh'), '#!/usr/bin/env bash\necho hello\n')
      writeFileSync(join(root, 'update.sh'), '#!/usr/bin/env bash\necho hello\n')

      const clean = run(root)
      expect(clean.code).toBe(0)
      expect(clean.out).toContain('PASS')

      // Tamper: a generic whole-directory copy, no mention of "skill-archive" anywhere.
      writeFileSync(
        join(root, 'update.sh'),
        '#!/usr/bin/env bash\nROOT="$(pwd)"\ncp -r "$ROOT/store/"* "$HOME/.claude/skills/"\n'
      )

      const tampered = run(root)
      expect(tampered.code).toBe(1)
      expect(tampered.out).not.toContain('references skill-archive by name')
      expect(tampered.out).toContain('generic whole-directory copy')
      expect(tampered.out).toContain('update.sh')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

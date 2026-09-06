// Card 50af1a27 (3c cluster of the upstream integration): every `npm ci` in update.sh must carry
// `--include=dev`, adopted from upstream (AUTOUPDNODEENV905).
//
// WHY THIS IS A TEST AND NOT JUST A COMMIT. The mechanism is invisible unless one env var happens
// to be set, so a future edit that drops the flag breaks nothing anyone can see -- until an update
// runs on a host that sets it, and then the build dies with nothing to point at.
//
// MEASURED on this host rather than taken from upstream's word (2026-09-06, npm 10.9.8, node
// v22.23.2), with a REAL install into a throwaway temp tree, not a --dry-run:
//
//   NODE_ENV unset,      npm ci                 -> dev dep PRESENT
//   NODE_ENV=production, npm ci                 -> dev dep PRUNED     <- the defect
//   NODE_ENV=production, npm ci --include=dev   -> dev dep PRESENT    <- the fix
//   NODE_ENV=production, npm ci --omit=dev      -> dev dep PRUNED     (control)
//
// A NOTE ON THE INSTRUMENT, because the first attempt got the wrong answer: `npm ci --dry-run`
// reports "add semver" in BOTH directions -- it does not honour the NODE_ENV pruning it is being
// asked about. A dry-run was the wrong tool for this question and would have concluded that
// upstream's fix addressed a mechanism that does not exist here.
//
// SCOPE, stated so the next reader does not overclaim: NODE_ENV is set nowhere in this install
// (.env, scripts/start.sh, install-linux.sh, update.sh -- all measured empty), so this closes a
// LATENT hole, not a live outage. The rollback site matters more than the main one: without the
// flag the rollback re-creates the pruned tree it exists to escape, and it does so behind
// `|| true`, so the recovery path would report success on a build that never ran.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

/** Every line that actually INVOKES `npm ci`, ignoring the prose that merely names it.
 *
 *  Comments are stripped, and so are QUOTED STRINGS -- the first version of this scan stripped only
 *  comments and promptly matched update.sh's own Hungarian error message ("HIBA: npm ci sikertelen
 *  ..."), which names the command inside an echo. Same class as the comment case (cards 06d36307,
 *  2f0c7d24): a presence check that reads prose as code. */
function npmCiInvocations(src: string): string[] {
  return src
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''"))
    .filter((l) => /(^|[;&|]|\s)npm\s+ci(\s|$)/.test(l))
    .map((l) => l.trim())
}

describe('update.sh keeps the dev dependencies its own build needs (card 50af1a27)', () => {
  const calls = npmCiInvocations(UPDATE)

  it('the scan finds the call sites at all -- never vacuously green', () => {
    // Without this the loop below passes on an empty list, which is exactly how a guard that
    // matched nothing would look. Two sites today: the main dep install and the rollback.
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it('every npm ci invocation carries --include=dev', () => {
    for (const call of calls) {
      expect(call, `an npm ci without --include=dev prunes the compiler under NODE_ENV=production: ${call}`)
        .toContain('--include=dev')
    }
  })

  it('the ROLLBACK site is one of them, by name and not by count', () => {
    // A count-only assertion would stay green if the rollback call were deleted and a third one
    // added elsewhere. This is the site whose failure is silent.
    const rollback = UPDATE.slice(UPDATE.indexOf('rollback_guard_check "$INSTALL_DIR"'))
    expect(rollback).toContain('npm ci --silent --include=dev')
  })

  it('the audit keeps its own --omit=dev, so the security scope did not widen with the install', () => {
    // Installing dev deps must not quietly enlarge what `npm audit` gates on: the audit answers a
    // question about the shipped tree, and that question did not change.
    expect(UPDATE).toContain('npm audit --audit-level=high --omit=dev')
  })
})

// Card 248d3013 (LATENSKULCSARGV920, ported from upstream #1478). launchSecretRef/clearLaunchSecrets
// are the mechanism behind resolveProviderEnv's secretShellRef contract (see
// provider-env-adoption.test.ts for that side): a vault-sourced key never travels as a literal
// token in the tmux `new-session` argv. It is written to a private 0600 file instead, and the
// launch command carries only a shell command-substitution reference to that file.
//
// MERGED WITH UPSTREAM'S OWN LATER launch-secret-ref.test.ts (card 14256aac, upstream batch 8):
// both files test the same two functions, independently written; upstream's had several cases
// this one lacked (the mutation-found directory-re-tightening case, a wider path-traversal set,
// a live shell-substitution proof, and a source-literal + call-site-wiring guard) -- folded in
// below as additional `it` blocks rather than picking one side wholesale.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  launchSecretRef,
  clearLaunchSecrets,
  LAUNCH_SECRETS_DIR,
  LAUNCH_SECRETS_DIR_MODE,
  LAUNCH_SECRET_FILE_MODE,
} from '../web/agent-process.js'

const TEST_PREFIX = 'launch-secret-ref-test-249d3013'

/** Every file this suite writes, named so cleanup can find them by prefix without touching a real
 *  agent's secret that might legitimately live in the same shared directory. */
function testPath(name: string): string {
  return join(LAUNCH_SECRETS_DIR, name)
}

afterEach(() => {
  if (!existsSync(LAUNCH_SECRETS_DIR)) return
  for (const f of readdirSync(LAUNCH_SECRETS_DIR)) {
    if (f.startsWith(TEST_PREFIX)) {
      try { unlinkSync(join(LAUNCH_SECRETS_DIR, f)) } catch { /* best-effort */ }
    }
  }
})

describe('launchSecretRef', () => {
  it('writes the value to a private file and returns a $(cat \'path\') reference, not the value', () => {
    const value = 'super-secret-value-do-not-argv'
    const ref = launchSecretRef(`${TEST_PREFIX}.plain`, value)
    expect(ref).not.toContain(value)
    expect(ref).toMatch(/^"\$\(cat '.+'\)"$/)
    const path = testPath(`${TEST_PREFIX}.plain`)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe(value)
  })

  it('the secret file is 0600 and the directory is 0700', () => {
    launchSecretRef(`${TEST_PREFIX}.modecheck`, 'x')
    const fileStat = statSync(testPath(`${TEST_PREFIX}.modecheck`))
    expect(fileStat.mode & 0o777).toBe(LAUNCH_SECRET_FILE_MODE)
    const dirStat = statSync(LAUNCH_SECRETS_DIR)
    expect(dirStat.mode & 0o777).toBe(LAUNCH_SECRETS_DIR_MODE)
  })

  it('a later call for the same name overwrites, not appends', () => {
    const ref1 = launchSecretRef(`${TEST_PREFIX}.rotate`, 'old-value')
    const path = testPath(`${TEST_PREFIX}.rotate`)
    expect(readFileSync(path, 'utf-8')).toBe('old-value')
    const ref2 = launchSecretRef(`${TEST_PREFIX}.rotate`, 'new-value')
    expect(readFileSync(path, 'utf-8')).toBe('new-value')
    // Same name -> same path -> same reference shape (not a new randomised file per call).
    expect(ref1).toBe(ref2)
  })

  it('sanitizes a name containing a path separator -- no path traversal', () => {
    const ref = launchSecretRef(`${TEST_PREFIX}/../../etc/passwd`, 'x')
    const match = ref.match(/^"\$\(cat '(.+)'\)"$/)
    expect(match).toBeTruthy()
    const path = (match as RegExpMatchArray)[1]
    // The written file must stay INSIDE LAUNCH_SECRETS_DIR -- '/' is filtered out of the name, so
    // there is nothing left in it that could climb a directory.
    expect(path.startsWith(LAUNCH_SECRETS_DIR + '/')).toBe(true)
    unlinkSync(path)
  })

  it('a name that is only dots falls back to a fixed safe name, not the parent directory', () => {
    const ref = launchSecretRef('..', 'x')
    const match = ref.match(/^"\$\(cat '(.+)'\)"$/)
    const path = (match as RegExpMatchArray)[1]
    expect(path).toBe(join(LAUNCH_SECRETS_DIR, 'unnamed'))
    unlinkSync(path)
  })

  // Upstream's mutation-found gap (batch 8, card 14256aac): `mkdirSync`'s mode only applies when
  // it CREATES the directory, so a directory left looser by an older version, a different umask,
  // or a manual change outlives a fix that only sets the mode at creation time. The chmod-every-
  // call line already in launchSecretRef covers this; this pins that it keeps covering it.
  it('re-tightens an already-existing, looser directory -- not only at creation', () => {
    mkdirSync(LAUNCH_SECRETS_DIR, { recursive: true })
    chmodSync(LAUNCH_SECRETS_DIR, 0o777)
    expect(statSync(LAUNCH_SECRETS_DIR).mode & 0o777).toBe(0o777) // positive control: really loose
    launchSecretRef(`${TEST_PREFIX}.retighten`, 'x')
    expect(statSync(LAUNCH_SECRETS_DIR).mode & 0o777).toBe(LAUNCH_SECRETS_DIR_MODE)
  })

  // Wider than the path-separator case above: the property that matters is the DIRECTORY the
  // file lands in, not the shape of the name. Upstream's own first version of this asserted the
  // name's shape instead and missed that an all-dots name resolves to the parent directory once
  // joined -- fixed in launchSecretRef (see the dots case above), re-measured here across every
  // shape, including ones with no leading '..' at all.
  it('every traversal-shaped name still lands inside LAUNCH_SECRETS_DIR, not just the ../ ones', () => {
    for (const bad of ['../../../etc/malicious', '..', '.', '/etc/passwd', '', 'a/../../b']) {
      const ref = launchSecretRef(bad, 'x')
      const path = /\$\(cat '(.+)'\)/.exec(ref)?.[1] ?? ''
      expect(dirname(path), bad).toBe(LAUNCH_SECRETS_DIR)
      expect(basename(path), bad).not.toContain('/')
      unlinkSync(path)
    }
    expect(existsSync('/etc/malicious')).toBe(false)
  })

  // Every assertion above measures the TEXT's shape. This measures that the substitution,
  // actually executed, returns the ORIGINAL secret -- i.e. that the agent really does receive the
  // key, not just that the string looks right.
  it('the shell actually returns the value from the reference (the mechanism works, not just looks right)', () => {
    const value = 'proba-ertek-shell-12345'
    const ref = launchSecretRef(`${TEST_PREFIX}.shell`, value)
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${ref}`], { encoding: 'utf-8' })
    expect(out).toBe(value)
    const path = /\$\(cat '(.+)'\)/.exec(ref)?.[1] ?? ''
    unlinkSync(path)
  })

  // WHY THIS IS SEPARATE FROM EVERY TEST ABOVE: those measure launchSecretRef and
  // resolveProviderEnv. The fix's effect hangs on one line at each CALL SITE -- if a caller goes
  // back to interpolating the value, every test above stays green and the secret is back in `ps`.
  // This reads the SOURCE and pins the forbidden shape, plus that stopAgentProcess's own BODY (not
  // just somewhere in the file) calls clearLaunchSecrets -- mutation-measured: moving that call to
  // a dead spot survived the weaker "appears somewhere in the file" assertion this one replaces.
  it('the source never reverts to the literal shape, and cleanup is wired into stopAgentProcess itself', () => {
    const source = readFileSync(
      join(fileURLToPath(import.meta.url), '..', '..', 'web', 'agent-process.ts'),
      'utf-8',
    )
    const forbidden = /export ANTHROPIC_(API_KEY|AUTH_TOKEN)="\$\{/g
    const hits = source.match(forbidden) ?? []
    expect(hits, `the secret's VALUE must not interpolate into the launch command: ${hits.join(', ')}`).toHaveLength(0)
    // Positive control on the pattern itself.
    const sample = 'export ANTHROPIC_AUTH_TOKEN="${key}" && '
    expect(sample.match(forbidden) ?? []).toHaveLength(1)
    // ...and the RIGHT shape must be present at every call site (not just "the wrong one is gone").
    expect((source.match(/launchSecretRef\(/g) ?? []).length).toBeGreaterThanOrEqual(3)

    const stopStart = source.indexOf('async function stopAgentProcessUnlocked(')
    expect(stopStart, 'stopAgentProcessUnlocked not found').toBeGreaterThan(-1)
    const stopEnd = source.indexOf('\nexport ', stopStart + 10)
    const stopBody = source.slice(stopStart, stopEnd > 0 ? stopEnd : undefined)
    expect(stopBody).toContain('clearLaunchSecrets(name)')
    expect(stopBody).toContain('kill-session') // positive control on the slice itself
    expect(stopBody.length).toBeGreaterThan(200)
  })
})

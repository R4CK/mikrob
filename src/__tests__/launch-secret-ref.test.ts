// Card 248d3013 (LATENSKULCSARGV920, ported from upstream #1478). launchSecretRef/clearLaunchSecrets
// are the mechanism behind resolveProviderEnv's secretShellRef contract (see
// provider-env-adoption.test.ts for that side): a vault-sourced key never travels as a literal
// token in the tmux `new-session` argv. It is written to a private 0600 file instead, and the
// launch command carries only a shell command-substitution reference to that file.
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
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
})

describe('clearLaunchSecrets', () => {
  it('removes the provider-key files for an agent, and the BYO key file, and nothing else', () => {
    const agent = `${TEST_PREFIX}-agentA`
    const otherAgent = `${TEST_PREFIX}-agentB`
    launchSecretRef(`${agent}.DEEPSEEK_API_KEY`, 'a')
    launchSecretRef(`${agent}.openrouter-fleet-key`, 'b')
    launchSecretRef(`agent-${agent}-api-key`, 'c')
    // A sibling agent's secret, and an unrelated file that merely starts similarly, must survive.
    launchSecretRef(`${otherAgent}.DEEPSEEK_API_KEY`, 'd')
    launchSecretRef(`agent-${otherAgent}-api-key`, 'e')

    const removed = clearLaunchSecrets(agent)
    expect(removed).toBe(3)
    expect(existsSync(testPath(`${agent}.DEEPSEEK_API_KEY`))).toBe(false)
    expect(existsSync(testPath(`${agent}.openrouter-fleet-key`))).toBe(false)
    expect(existsSync(testPath(`agent-${agent}-api-key`))).toBe(false)
    expect(existsSync(testPath(`${otherAgent}.DEEPSEEK_API_KEY`))).toBe(true)
    expect(existsSync(testPath(`agent-${otherAgent}-api-key`))).toBe(true)

    clearLaunchSecrets(otherAgent)
  })

  it('an agent name that is a PREFIX of another agent name does not clear the other one', () => {
    // 'agentA' vs 'agentAA' -- the naive `startsWith` shape used elsewhere in this file could
    // over-match without the trailing '.' in providerPrefix; this proves it does not.
    const short = `${TEST_PREFIX}-agentA`
    const long = `${TEST_PREFIX}-agentAA`
    launchSecretRef(`${short}.DEEPSEEK_API_KEY`, 'a')
    launchSecretRef(`${long}.DEEPSEEK_API_KEY`, 'b')
    clearLaunchSecrets(short)
    expect(existsSync(testPath(`${short}.DEEPSEEK_API_KEY`))).toBe(false)
    expect(existsSync(testPath(`${long}.DEEPSEEK_API_KEY`))).toBe(true)
    clearLaunchSecrets(long)
  })

  it('returns 0 for an agent that never had a launch secret written', () => {
    expect(clearLaunchSecrets(`${TEST_PREFIX}-never-launched`)).toBe(0)
  })
})

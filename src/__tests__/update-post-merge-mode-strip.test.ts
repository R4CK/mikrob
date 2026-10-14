// Card 758e06dd (Cybersec hardening finding from ae071239's GO, comment 4934).
// buildUpdateScriptEnv already stripped NODE_ENV (card c116696f) but left POST_MERGE_MODE
// untouched. update.sh skips its mandatory pre-update checkpoint when POST_MERGE_MODE=1, because
// the legitimate caller (the post-upstream-merge rebuild+restart path) already took one before
// spawning. If this process's own environment ever carries POST_MERGE_MODE, the normal fork-pull
// path would silently inherit it too and skip a checkpoint it actually needs -- measured on the
// live dashboard (pid 561) as NOT currently present, so this is latent hardening, not an active
// incident.
import { describe, it, expect, afterEach } from 'vitest'
import { buildUpdateScriptEnv } from '../web/routes/updates.js'

describe('buildUpdateScriptEnv strips POST_MERGE_MODE before spawning update.sh (card 758e06dd)', () => {
  const original = process.env.POST_MERGE_MODE

  afterEach(() => {
    if (original === undefined) delete process.env.POST_MERGE_MODE
    else process.env.POST_MERGE_MODE = original
  })

  it('strips an inherited POST_MERGE_MODE from the returned env', () => {
    process.env.POST_MERGE_MODE = '1'
    const env = buildUpdateScriptEnv({})
    expect(env.POST_MERGE_MODE).toBeUndefined()
  })

  it('still lets the legitimate caller set it via extraEnv', () => {
    delete process.env.POST_MERGE_MODE
    const env = buildUpdateScriptEnv({ POST_MERGE_MODE: '1' })
    expect(env.POST_MERGE_MODE).toBe('1')
  })

  it('leaves the REAL process.env untouched, same as the NODE_ENV strip', () => {
    process.env.POST_MERGE_MODE = '1'
    buildUpdateScriptEnv({})
    expect(process.env.POST_MERGE_MODE).toBe('1')
  })
})

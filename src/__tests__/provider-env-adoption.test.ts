// Card e80c011a (B-wave, parent bd450735). Adopting upstream's resolveProviderEnv() refactor:
// the fork built ollamaEnv / deepseekEnv / openrouterEnv inline in startAgentProcess, upstream
// extracts one pure function.
//
// A refactor of the string that LAUNCHES EVERY AGENT is only safe if it is provably a no-op, so
// this file does not assert what the new function returns in isolation -- it reimplements the OLD
// inline expressions verbatim and asserts BYTE-IDENTICAL output across every provider path. If the
// two ever diverge, the diff is the failure message.
//
// MINIMAX: upstream's version also adds a `minimax-` branch, and this file's conflict-guard rule
// said to adopt the refactor "wholesale (... plus adds minimax)". Peti gave MiniMax a NO-GO on card
// 48565f81 (CLAUDE.md rule 17: another paid online model works against pushing easy work to the
// local LLM). So the shape is upstream's and the provider set is the fork's -- and that is pinned
// below, because a later "sync with upstream" would otherwise reintroduce a declined feature as a
// side effect of a merge, which is exactly how declined features come back.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProviderEnv, shSingleQuote } from '../web/agent-process.js'
// OLLAMA_URL lives in config, not agent-process -- importing it from the wrong module made
// the legacy copy below interpolate `undefined` and fail against correct code.
import { OLLAMA_URL } from '../config.js'
import { REPO_ROOT } from './helpers/repo-location.js'

/** The fork's PRE-REFACTOR expressions, copied verbatim from the code being replaced. */
function legacyExports(model: string, getSecret: (id: string) => string | null): string {
  const isClaude = model.startsWith('claude-')
  const isDeepseek = model.startsWith('deepseek-')
  const isOpenRouter = !isClaude && !isDeepseek && model.includes('/')
  const isOllama = !isClaude && !isDeepseek && !isOpenRouter
  const ollamaEnv = isOllama ? `export ANTHROPIC_AUTH_TOKEN=ollama && export ANTHROPIC_BASE_URL=${OLLAMA_URL} && export ANTHROPIC_MODEL=${shSingleQuote(model)} && ` : ''
  const deepseekKey = isDeepseek ? (getSecret('DEEPSEEK_API_KEY') ?? '') : ''
  const deepseekEnv = isDeepseek ? `export ANTHROPIC_AUTH_TOKEN="${deepseekKey}" && export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic && export ANTHROPIC_MODEL=${shSingleQuote(model)} && ` : ''
  const openrouterKey = isOpenRouter ? (getSecret('openrouter-fleet-key') ?? '') : ''
  const openrouterEnv = isOpenRouter ? `export ANTHROPIC_AUTH_TOKEN="${openrouterKey}" && export ANTHROPIC_BASE_URL=https://openrouter.ai/api && export ANTHROPIC_MODEL=${shSingleQuote(model)} && ` : ''
  return `${ollamaEnv}${deepseekEnv}${openrouterEnv}`
}

const SECRETS: Record<string, string> = {
  DEEPSEEK_API_KEY: 'ds-test-key',
  'openrouter-fleet-key': 'or-test-key',
}
const getSecret = (id: string): string | null => SECRETS[id] ?? null

// Every discriminator branch, plus the shapes that historically broke it: an OpenRouter id (has a
// '/'), an Ollama tag (has a ':'), and a value carrying a single quote (card b7fa5281's injection).
const MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'deepseek-v4-pro',
  'anthropic/claude-3.5-sonnet',
  'meta-llama/llama-3.1-70b-instruct',
  'qwen3.6:27b',
  'llama3:latest',
  "evil'; rm -rf / #",
  "deepseek-eve'l",
  "vendor/mo'del",
]

describe('resolveProviderEnv adoption is a no-op (card e80c011a)', () => {
  it.each(MODELS)('%s: byte-identical to the pre-refactor inline expressions', (model) => {
    expect(resolveProviderEnv(model, getSecret).exportsStr).toBe(legacyExports(model, getSecret))
  })

  it('a missing secret degrades exactly as before -- empty string, not "null"', () => {
    const none = (): string | null => null
    for (const m of ['deepseek-v4-pro', 'vendor/model']) {
      expect(resolveProviderEnv(m, none).exportsStr).toBe(legacyExports(m, none))
      expect(resolveProviderEnv(m, none).exportsStr).not.toContain('null')
    }
  })

  it('claude models get an EMPTY chain, so the host OAuth path is untouched', () => {
    // The default path for the whole fleet. A non-empty string here would redirect every Claude
    // agent at a custom base URL.
    expect(resolveProviderEnv('claude-opus-5', getSecret)).toEqual({ provider: 'claude', exportsStr: '' })
  })

  it('classifies each id to the right provider', () => {
    expect(resolveProviderEnv('claude-opus-5', getSecret).provider).toBe('claude')
    expect(resolveProviderEnv('deepseek-v4-pro', getSecret).provider).toBe('deepseek')
    expect(resolveProviderEnv('vendor/model', getSecret).provider).toBe('openrouter')
    expect(resolveProviderEnv('qwen3.6:27b', getSecret).provider).toBe('ollama')
  })

  it("a quote in the model id cannot close the shell quote (card b7fa5281's escape holds)", () => {
    const out = resolveProviderEnv("qwen'; touch /tmp/pwned #", getSecret).exportsStr
    expect(out).toContain(`'\\''`)   // the escape sequence, i.e. the quote was neutralised
    expect(out).not.toContain("qwen'; touch")
  })
})

describe('the RULE TEXT stays out too (Cybered, comment 19877)', () => {
  // Cybered's finding, and it is the sharp half of this card: the code pin above is not enough.
  // At merge time the authority a human acts on is the WRITTEN RULE in the conflict guard, not a
  // red test -- "a red test loses an argument with a written rule". Worse, adopting the refactor
  // SHRANK the decision point it depends on: before, upstream's change was one big "new function
  // replaces inline code" hunk, obviously a decision; after, it is two small hunks that look purely
  // additive (an isMinimax discriminator line, an if(isMinimax) block), and the reflex on those is
  // union. So the prose that says "union" had to change, and now it is pinned.
  const RULES = readFileSync(join(REPO_ROOT, 'src/__tests__/fork-upstream-conflict-guard.test.ts'), 'utf-8')

  it('no rule tells a future merger that adopting minimax is safe', () => {
    // Matched with the surrounding words that made them INSTRUCTIONS. Both sentences survive in the
    // file as explicitly refuted history ("this comment used to read ..."), which is more useful
    // than deleting them -- but neither may stand as current guidance again.
    expect(RULES).not.toMatch(/adds a fourth provider[\s\S]{0,120}safe to adopt wholesale/i)
    expect(RULES).not.toMatch(/resolveProviderEnv\(\) refactor wholesale[^"]{0,200}plus adds minimax/i)
  })

  it('the rule says the minimax branch is NOT adoptable, and names the NO-GO', () => {
    expect(RULES).toContain('THE MINIMAX BRANCH IS NOT ADOPTABLE')
    expect(RULES).toContain('48565f81')
  })

  it('the rule warns that the remaining conflict LOOKS additive -- union is the wrong reflex', () => {
    // Without this the next merger sees two innocent hunks and no reason to hesitate.
    expect(RULES).toMatch(/do NOT union them|union is WRONG here/)
  })

  it('the SECOND door is shut: the routes/agents.ts rule no longer argues for MiniMax gating', () => {
    // routes/agents.ts said a literal reading would "wrongly discard" upstream's MiniMax gating in
    // /api/models/available -- i.e. it argued FOR bringing it in. The launcher-side exclusion is
    // worthless if the route side walks back in through a different rule.
    expect(RULES).not.toMatch(/wrongly discard[\s\S]{0,80}MiniMax direct-API gating/i)
    expect(RULES).not.toMatch(/discard two unrelated upstream additions: MiniMax/i)
    expect(RULES).toContain('WITH ONE NAMED EXCEPTION')
  })

  it('the runAsUser half is recorded as NOT adopted, not as a verified no-op', () => {
    expect(RULES).toMatch(/DO NOT adopt upstream\\?'s umask 002/)
    expect(RULES).not.toMatch(/adopt upstream\\?'s umask 002[\s\S]{0,80}wholesale \(verified no-op/)
  })
})

describe('MiniMax stays out (Peti NO-GO, card 48565f81)', () => {
  it('a minimax- model does NOT get a minimax provider chain', () => {
    // Without a `minimax-` branch it falls through the discriminator to ollama, exactly as it did
    // before this refactor -- the point is that adopting upstream's shape did not smuggle the
    // declined provider in. This is the assertion that fails if someone "syncs with upstream".
    const r = resolveProviderEnv('minimax-m3', getSecret)
    expect(r.provider).not.toBe('minimax')
    expect(r.exportsStr).not.toContain('minimax.io')
    expect(r.exportsStr).toBe(legacyExports('minimax-m3', getSecret))
  })

  it('the source carries no minimax endpoint or key at all', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/web/agent-process.ts'), 'utf-8')
    expect(src).not.toContain('api.minimax.io')
    expect(src).not.toContain('MINIMAX_API_KEY')
    // CLAUDE_CODE_MAX_CONTEXT_TOKENS arrives only with upstream's minimax branch; its presence
    // would mean the branch came along.
    expect(src).not.toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
  })
})

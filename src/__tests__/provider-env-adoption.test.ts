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

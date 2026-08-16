// Cybered LOW-1 (card d7220a73): store/llm-catalog.py's `repo` field comes RAW from the HuggingFace
// discovery API and is embedded verbatim into `installRef` ("hf.co/<repo>:<quant>"). The catalogue
// build now drops a malformed repo id, but that check does not survive being written to the
// gitignored, agent-writable cache and read back in --offline mode -- so the consumer that actually
// executes `ollama pull` (POST /api/local-llm/pull) re-checks the same HF-repo shape here.
import { describe, it, expect } from 'vitest'
import { isValidPullTarget } from '../web/routes/local-llm.js'

describe('isValidPullTarget', () => {
  it('accepts a well-formed hf.co ref, with and without a quant tag', () => {
    expect(isValidPullTarget('hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_0')).toBe(true)
    expect(isValidPullTarget('hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF')).toBe(true)
  })

  it('accepts a plain ollama tag unaffected by the hf.co-specific check', () => {
    expect(isValidPullTarget('qwen2.5-coder:7b-instruct-q4_K_M')).toBe(true)
  })

  it('rejects a malformed repo id inside an hf.co ref -- the exact shape Cybered named', () => {
    expect(isValidPullTarget('hf.co/../etc/passwd:Q4_0')).toBe(false)
    expect(isValidPullTarget('hf.co/.hidden/coder-model:Q4_0')).toBe(false)
  })

  it('rejects an hf.co ref with more than one slash in the repo id', () => {
    expect(isValidPullTarget('hf.co/a/b/c:Q4_0')).toBe(false)
  })

  it('rejects an hf.co ref with no repo id at all', () => {
    expect(isValidPullTarget('hf.co/:Q4_0')).toBe(false)
    expect(isValidPullTarget('hf.co/')).toBe(false)
  })

  it('still enforces the underlying charset (MODEL_RE) regardless of the hf.co check', () => {
    expect(isValidPullTarget('hf.co/Qwen/Coder-GGUF:Q4_0; rm -rf /')).toBe(false)
  })
})

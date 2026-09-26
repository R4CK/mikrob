// Card e80c011a (B-wave, parent bd450735). Adopting upstream's resolveProviderEnv() refactor:
// the fork built ollamaEnv / deepseekEnv / openrouterEnv inline in startAgentProcess, upstream
// extracts one pure function.
//
// Card 248d3013 (LATENSKULCSARGV920) changed the function's OWN contract on top of that adoption:
// the caller no longer hands resolveProviderEnv a secret's raw VALUE -- it hands a `secretShellRef`
// callback that returns the secret's shell REFERENCE (built by `launchSecretRef`, which writes the
// value to a private 0600 file and returns a `"$(cat '<path>')"` command-substitution string). The
// raw value therefore never has a chance to reach a shell string inside this function, which is why
// the old byte-identical-to-a-legacy-inline-copy framing this file used to have is gone: that
// framing asserted a NO-OP, and this card is a deliberate behaviour change (the whole point is that
// a vault-sourced key no longer sits in the tmux `new-session` argv, readable from
// /proc/<pid>/cmdline for as long as the pane's wrapper shell lives).
//
// MINIMAX: upstream's version also adds a `minimax-` branch, and this file's conflict-guard rule
// said to adopt the refactor "wholesale (... plus adds minimax)". Peti gave MiniMax a NO-GO on card
// 48565f81 (CLAUDE.md rule 17: another paid online model works against pushing easy work to the
// local LLM). So the shape is upstream's and the provider set is the fork's -- and that is pinned
// below, because a later "sync with upstream" would otherwise reintroduce a declined feature as a
// side effect of a merge, which is exactly how declined features come back.
import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProviderEnv, shSingleQuote, launchSecretRef, LAUNCH_SECRETS_DIR } from '../web/agent-process.js'
import { REPO_ROOT } from './helpers/repo-location.js'

/** Stub `secretShellRef`: the exact contract resolveProviderEnv now depends on -- a fixed,
 *  non-secret marker for a known id, `null` otherwise. Never a raw value. */
const REF: Record<string, string> = {
  DEEPSEEK_API_KEY: `"$(cat '/fake/launch-secrets/deepseek-marker')"`,
  'openrouter-fleet-key': `"$(cat '/fake/launch-secrets/openrouter-marker')"`,
}
const secretShellRef = (id: string): string | null => REF[id] ?? null
const noSecret = (): string | null => null

describe('resolveProviderEnv adoption: provider classification unchanged (card e80c011a)', () => {
  it('classifies each id to the right provider', () => {
    expect(resolveProviderEnv('claude-opus-5', secretShellRef).provider).toBe('claude')
    expect(resolveProviderEnv('deepseek-v4-pro', secretShellRef).provider).toBe('deepseek')
    expect(resolveProviderEnv('vendor/model', secretShellRef).provider).toBe('openrouter')
    expect(resolveProviderEnv('qwen3.6:27b', secretShellRef).provider).toBe('ollama')
  })

  it('claude models get an EMPTY chain, so the host OAuth path is untouched', () => {
    // The default path for the whole fleet. A non-empty string here would redirect every Claude
    // agent at a custom base URL.
    expect(resolveProviderEnv('claude-opus-5', secretShellRef)).toEqual({ provider: 'claude', exportsStr: '' })
  })

  it('the deepseek/openrouter exportsStr carries the secretShellRef output verbatim', () => {
    // Not re-escaped, not re-quoted, not mangled -- the reference is already a complete, safe
    // shell token by the time it reaches this function (see launchSecretRef).
    const ds = resolveProviderEnv('deepseek-v4-pro', secretShellRef).exportsStr
    expect(ds).toContain(`ANTHROPIC_AUTH_TOKEN=${REF.DEEPSEEK_API_KEY} && `)
    expect(ds).toContain('ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic')
    const or = resolveProviderEnv('vendor/model', secretShellRef).exportsStr
    expect(or).toContain(`ANTHROPIC_AUTH_TOKEN=${REF['openrouter-fleet-key']} && `)
    expect(or).toContain('ANTHROPIC_BASE_URL=https://openrouter.ai/api')
  })

  it('a missing secret degrades to an empty single-quoted token, not "null"', () => {
    for (const m of ['deepseek-v4-pro', 'vendor/model']) {
      const out = resolveProviderEnv(m, noSecret).exportsStr
      expect(out).toContain(`=${shSingleQuote('')} && `)
      expect(out).not.toContain('null')
    }
  })

  it("a quote in the model id cannot close the shell quote (card b7fa5281's escape holds)", () => {
    const out = resolveProviderEnv("qwen'; touch /tmp/pwned #", secretShellRef).exportsStr
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
  // Card 99c2eb09 moved the acknowledgement DATA out of the guard TEST and into a module both
  // the test and the (now scheduled) drift checker read, so the landing gate stopped depending
  // on a live upstream fetch. This reader follows the data, not the old filename.
  const RULES = readFileSync(join(REPO_ROOT, 'src/fork-upstream/acknowledged-conflicts.ts'), 'utf-8')

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

describe('the KEY never reaches a shell string at all now (card 248d3013, LATENSKULCSARGV920)', () => {
  // Card 1075d0e4 (Cybered) escaped the key AT THE SINK because it was interpolated into a shell
  // command string, and a hostile vault value could otherwise close the quote and inject a command
  // -- BEFORE the Claude Code hook layer exists, so no PreToolUse guard could ever see it, and the
  // launch command is not logged, so detection was ~nil. Card 248d3013 removes the premise: the
  // value is written to a private 0600 file (atomicWriteFileSync, never a shell string) and the
  // launch command carries only a reference to the file's PATH -- a fixed, non-attacker-controlled
  // shape. The injection question does not get answered here any more, it gets made moot.
  const hostile = [
    ['double-quote breakout', 'x";touch /tmp/pwned;#'],
    ['single-quote breakout', "y';touch /tmp/pwned;#"],
    ['command substitution', '$(touch /tmp/pwned)'],
    ['backtick substitution', '`touch /tmp/pwned`'],
  ] as const

  const writtenPaths: string[] = []
  afterAll(() => {
    for (const p of writtenPaths) { try { if (existsSync(p)) unlinkSync(p) } catch { /* best-effort */ } }
  })

  it.each(hostile)('%s: launchSecretRef never puts the value in a shell string', (_name, value) => {
    const ref = launchSecretRef('test-248d3013-hostile-key', value)
    // The value is DATA in a file, not text in the command -- it must not appear in the reference.
    expect(ref).not.toContain(value)
    const match = ref.match(/^"\$\(cat '(.+)'\)"$/)
    expect(match, `launchSecretRef did not return the expected "$(cat '<path>')" shape, got: ${ref}`).toBeTruthy()
    const path = (match as RegExpMatchArray)[1]
    expect(path.startsWith(LAUNCH_SECRETS_DIR)).toBe(true)
    writtenPaths.push(path)
    // ...and reading the file back gives the value byte-exact, proving nothing was lost or altered
    // by being routed through a file instead of a shell string.
    expect(readFileSync(path, 'utf-8')).toBe(value)
  })

  it('resolveProviderEnv passes the shell ref through untouched -- it never re-escapes or mangles it', () => {
    const marker = `"$(cat '/fake/path/for/this/test')"`
    const out = resolveProviderEnv('deepseek-v4-pro', (id) => (id === 'DEEPSEEK_API_KEY' ? marker : null)).exportsStr
    expect(out).toContain(`ANTHROPIC_AUTH_TOKEN=${marker} && `)
  })

  it('no provider branch calls getSecret or a vault function directly -- only secretShellRef', () => {
    // The shape assertion: a future "sync with upstream" (or a well-meaning refactor) that hands
    // resolveProviderEnv a raw value again fails here, rather than silently reopening the
    // LATENSKULCSARGV920 exposure this card closed.
    const src = readFileSync(join(REPO_ROOT, 'src/web/agent-process.ts'), 'utf-8')
    const fn = src.slice(src.indexOf('export function resolveProviderEnv'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).not.toMatch(/getSecret\(/)
    expect(body).not.toMatch(/ANTHROPIC_AUTH_TOKEN="\$\{/)
  })
})

describe('MiniMax stays out (Peti NO-GO, card 48565f81)', () => {
  it('a minimax- model does NOT get a minimax provider chain', () => {
    // Without a `minimax-` branch it falls through the discriminator to ollama, exactly as it did
    // before this refactor -- the point is that adopting upstream's shape did not smuggle the
    // declined provider in. This is the assertion that fails if someone "syncs with upstream".
    const r = resolveProviderEnv('minimax-m3', secretShellRef)
    expect(r.provider).not.toBe('minimax')
    expect(r.provider).toBe('ollama')
    expect(r.exportsStr).not.toContain('minimax.io')
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

describe('every shell sink in resolveProviderEnv is escaped, by PROVENANCE (Cybersec 19942)', () => {
  // WHY THIS EXISTS AND WHY IT IS A SOURCE-SHAPE TEST.
  //
  // The two key sinks were fixed because a key is obviously a secret. OLLAMA_URL sat on the very
  // same line, bare and not even double-quoted, and I read past it three times -- because I was
  // enumerating sinks by asking "is this a secret?" instead of "does an outside writer decide this
  // string?". A base URL is not a secret and IS attacker-influenced: it is a settings-registry
  // entry of type 'string' with no valueSet, so validateSettingValue returns String(raw) unchanged.
  //
  // So this asserts the general rule rather than a list of three names: inside resolveProviderEnv,
  // EVERY interpolation that reaches the launch command line goes through shSingleQuote(). A future
  // provider added by anyone (upstream included) is covered without touching this file. Pinned at
  // source level because the string is only ever executed inside a real tmux session -- there is no
  // cheap seam to drive end-to-end, which is the same reason backend's key-quoting test is one.
  //
  // CARD 248d3013 (LATENSKULCSARGV920) ADDS A SECOND TRUSTED SHAPE, `${keyRef}`, because the key
  // sinks no longer hold a raw value to escape at all -- they hold whatever `secretShellRef(...)`
  // returned, which this function must pass through untouched (see the "KEY never reaches a shell
  // string" describe block above for what THAT mechanism itself guarantees). Trusting `keyRef` by
  // NAME alone would be exactly the fragility this file's sibling guard warns against ("a guard
  // written from the instances you just fixed describes your diff, not the class"), so the
  // dedicated provenance test below additionally proves every `${keyRef}` in this body is preceded
  // by `const keyRef = secretShellRef(` -- not `getSecret(` or any other source.
  const SRC = readFileSync(join(REPO_ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')

  function resolveProviderEnvBody(): string {
    const start = SRC.indexOf('export function resolveProviderEnv(')
    expect(start, 'resolveProviderEnv not found -- was it renamed?').toBeGreaterThan(-1)
    // Ends at the next top-level `export ` / comment banner after the function.
    const end = SRC.indexOf('\n// All tmux operations route through', start)
    expect(end, 'end marker moved -- widen this slice rather than letting it silently cover less')
      .toBeGreaterThan(start)
    return SRC.slice(start, end)
  }

  it('no interpolation reaches the command line unescaped', () => {
    const body = resolveProviderEnvBody()
    // Non-vacuity FIRST, independent of the offender check below: the slice actually contains
    // interpolations at all (every `${`, escaped or not), so an empty offender list cannot be
    // hiding an empty slice.
    const totalInterpolations = (body.match(/\$\{/g) || []).length
    expect(totalInterpolations, 'no interpolations found -- the slice above is probably wrong').toBeGreaterThan(3)
    // Card f1203a7c (Cybered): checks the OPENING boundary only, not a captured span of the full
    // interpolation body. The old `/\$\{([^{}]*)\}/` extracted the content between `${` and the
    // NEXT `}` -- which cannot span a NESTED brace, so `${({ u: OLLAMA_URL }).u}` slipped through
    // unrecognised (measured: 27/27 green with that exact shape present, a simple unescaped
    // `${OLLAMA_URL}` correctly caught). This form asks only "does shSingleQuote( sit immediately
    // after `${`", which holds regardless of nesting depth inside the interpolation.
    const unescaped = [...body.matchAll(/\$\{(?!shSingleQuote\(|keyRef\}|launchSecretRef\()/g)]
    expect(
      unescaped.length,
      'an interpolation reaches the tmux launch command line without shSingleQuote() immediately ' +
        'after ${. It does not matter whether the value looks like a secret: what matters is ' +
        'whether something outside this process decides the string. Wrap it, or prove it cannot ' +
        'be written from outside.',
    ).toBe(0)
  })

  it('every ${keyRef} sink is provably sourced from secretShellRef, not getSecret or the vault', () => {
    const body = resolveProviderEnvBody()
    const keyRefSinks = (body.match(/\$\{keyRef\}/g) || []).length
    expect(keyRefSinks, 'expected the deepseek and openrouter branches to each use ${keyRef}').toBe(2)
    const provenance = (body.match(/const keyRef = secretShellRef\(/g) || []).length
    // One-to-one: every sink has a matching declaration straight off secretShellRef, in the SAME
    // function -- not a re-derived or renamed value that merely happens to be called keyRef.
    expect(provenance, 'every ${keyRef} must be declared `const keyRef = secretShellRef(...)`').toBe(keyRefSinks)
    expect(body).not.toMatch(/getSecret\(/)
  })

  it('BITES: the exact bare shape this NO-GO was about is caught', () => {
    // Guard against the assertion above going vacuous (an empty match set also has length 0).
    const mutated = 'export function resolveProviderEnv(' +
      '\n  x = `export ANTHROPIC_BASE_URL=${OLLAMA_URL} && `' +
      '\n// All tmux operations route through'
    expect([...mutated.matchAll(/\$\{(?!shSingleQuote\(|keyRef\}|launchSecretRef\()/g)].length).toBe(1)
  })

  it('BITES-NESTED: the nested-brace bypass Cybered measured is caught too (card f1203a7c)', () => {
    // The exact mutant that slipped past the OLD capture-based regex, 27/27 green: a
    // same-meaning interpolation reaching the sink through an object-literal indirection with a
    // brace nested inside the ${...}.
    const mutated = 'export function resolveProviderEnv(' +
      '\n  x = `export ANTHROPIC_BASE_URL=${({ u: OLLAMA_URL }).u} && `' +
      '\n// All tmux operations route through'
    expect([...mutated.matchAll(/\$\{(?!shSingleQuote\(|keyRef\}|launchSecretRef\()/g)].length).toBeGreaterThan(0)
  })

  it('BITES-RENAMED: a differently-named bare variable is still caught (248d3013 exemption is narrow)', () => {
    // The `keyRef}` exemption is a literal-name shape, not "any bare identifier" -- proven here so
    // a future edit cannot widen it by accident while this test still shows green.
    const mutated = 'export function resolveProviderEnv(' +
      '\n  x = `export ANTHROPIC_AUTH_TOKEN=${otherRef} && `' +
      '\n// All tmux operations route through'
    expect([...mutated.matchAll(/\$\{(?!shSingleQuote\(|keyRef\}|launchSecretRef\()/g)].length).toBe(1)
  })

  it('CONTROL: a properly escaped interpolation, even nested, is not flagged', () => {
    const src = 'export function resolveProviderEnv(' +
      '\n  x = `export ANTHROPIC_BASE_URL=${shSingleQuote(({ u: OLLAMA_URL }).u)} && `' +
      '\n// All tmux operations route through'
    expect([...src.matchAll(/\$\{(?!shSingleQuote\(|keyRef\}|launchSecretRef\()/g)]).toEqual([])
  })

  it('CONTROL: the bare keyRef sink is not flagged (card 248d3013)', () => {
    const src = 'export function resolveProviderEnv(' +
      '\n  const keyRef = secretShellRef(\'X\') ?? shSingleQuote(\'\')' +
      '\n  x = `export ANTHROPIC_AUTH_TOKEN=${keyRef} && `' +
      '\n// All tmux operations route through'
    expect([...src.matchAll(/\$\{(?!shSingleQuote\(|keyRef\}|launchSecretRef\()/g)]).toEqual([])
  })
})


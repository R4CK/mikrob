// Auto template selection for the local-LLM queue (card 48aacf56, item 4).
//
// The load-bearing property is NOT "matches lots of things" -- it is "never confidently picks the
// WRONG template". A wrong template reshapes the request into something the caller did not ask for,
// which is worse than the free-form default. So the negative controls below matter more than the
// positive ones.
import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pickTemplate, isPickableTemplate, KNOWN_TEMPLATES } from '../local-llm-template-picker.js'

const SKILL_DIR = join(process.cwd(), 'store', 'local-llm-skills')

describe('pickTemplate -- positive routing', () => {
  it.each([
    ['write a regex that matches a semver string', 'regex'],
    ['irj egy regularis kifejezest az emailre', 'regex'],
    ['generate a TypeScript type definition for the payload', 'type-def'],
    ['write unit tests for the parser', 'test-scaffold'],
    ['produce a full test suite for the adapter', 'test-suite-full'],
    ['add a docstring to this function', 'docstring'],
    ['write a commit message for these changes', 'commit-msg'],
    ['translate this paragraph to German', 'translate'],
    ['forditsd le ezt a bekezdest angolra', 'translate'],
    ['extract keywords from this report', 'keywords'],
    ['summarize the incident report', 'summarize'],
    ['osszefoglald a jegyzokonyvet roviden', 'summarize'],
    ['write an SQL migration to add the column', 'sql-migration'],
    ['transform this JSON into the new shape', 'json-transform'],
    ['decompose this card into subtasks', 'card-decompose'],
    ['bontsd le ezt a kartyat lepesekre', 'card-decompose'],
    ['triage these inbound messages', 'msg-triage'],
    ['write user stories for the booking flow', 'user-story'],
    ['list the edge cases for this parser', 'edge-cases'],
    ['write a bash script that rotates the logs', 'shell-script'],
    ['produce a yaml config for the service', 'yaml-config'],
    ['write release notes for this version', 'release-notes'],
  ])('%s -> %s', (desc, expected) => {
    expect(pickTemplate(desc)).toBe(expected)
  })
})

describe('pickTemplate -- NEGATIVE controls (the part that matters)', () => {
  it('returns null for a vague description rather than guessing', () => {
    expect(pickTemplate('please help me with this thing we discussed')).toBeNull()
    expect(pickTemplate('finish the work on the backend module')).toBeNull()
  })

  it('returns null for a description too short to carry a signal', () => {
    // "regex" alone is as likely to be a question ABOUT regexes as a request FOR one.
    expect(pickTemplate('regex')).toBeNull()
    expect(pickTemplate('tests')).toBeNull()
  })

  it('does not fire on bare generic words that appear in most descriptions', () => {
    // 'code' and 'test' alone must not route; they occur in nearly every task description.
    expect(pickTemplate('review the code in the pricing module carefully')).toBeNull()
    expect(pickTemplate('the test environment needs a restart before we continue')).toBeNull()
  })

  it('returns null for non-string input instead of throwing', () => {
    expect(pickTemplate(undefined)).toBeNull()
    expect(pickTemplate(null)).toBeNull()
    expect(pickTemplate(42)).toBeNull()
    expect(pickTemplate({ prompt: 'regex please' })).toBeNull()
  })

  it('prefers the more specific rule when two could match', () => {
    // "full test suite" must not degrade into the single-scaffold template.
    expect(pickTemplate('please write a full test suite for the queue module')).toBe('test-suite-full')
  })
})

describe('safety: the picker can only ever name a real, allowlisted template', () => {
  it('every returnable name exists as a file on disk', () => {
    // A picked name that has no backing file would fail at the sink -- and would do so only in
    // production, when the queue actually runs it.
    if (!existsSync(SKILL_DIR)) return // not the live checkout; the next test still guards the set
    const onDisk = new Set(readdirSync(SKILL_DIR).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)))
    const missing = KNOWN_TEMPLATES.filter((t) => !onDisk.has(t))
    expect(missing).toEqual([])
  })

  it('never returns caller-controlled text -- traversal attempts fall through to null', () => {
    expect(pickTemplate('../../etc/passwd please translate it')).toBe('translate') // still an allowlisted NAME
    expect(isPickableTemplate('../../etc/passwd')).toBe(false)
    expect(pickTemplate('../../../root/.ssh/id_rsa')).toBeNull()
  })

  it('isPickableTemplate accepts only the known set', () => {
    expect(isPickableTemplate('regex')).toBe(true)
    expect(isPickableTemplate('definitely-not-a-template')).toBe(false)
    expect(isPickableTemplate(undefined)).toBe(false)
    expect(isPickableTemplate(123)).toBe(false)
  })

  it('every pick for a realistic description is allowlisted (no free-form leakage)', () => {
    const samples = [
      'write a regex for postcodes', 'summarize this thread', 'translate to Hungarian',
      'write unit tests for the store', 'decompose this card into subtasks',
      'some entirely unrelated sentence about the weather today',
    ]
    for (const s of samples) {
      const got = pickTemplate(s)
      expect(got === null || isPickableTemplate(got)).toBe(true)
    }
  })
})

describe('the two triage taxonomies do not steal each other (card 002120b1)', () => {
  // MEASURED, which is how this was found: `pickTemplate('triage this email')` returned
  // 'msg-triage'. The two templates emit DIFFERENT JSON taxonomies -- triage gives
  // spam|promo|personal|work|urgent, msg-triage gives gate-verdict|dispatch-request|reconcile|
  // question|status|noise. So an email triaged by the wrong one comes back as confidently wrong
  // structured output in a valid-looking shape: the caller cannot see it took the wrong contract.
  // That is strictly worse than returning null, which is why this pair needed splitting rather
  // than reordering.
  it('an EMAIL triage request gets the email classifier', () => {
    expect(pickTemplate('triage this email from a customer')).toBe('triage')
    expect(pickTemplate('please triage the inbox for me')).toBe('triage')
  })

  it('an INTER-AGENT triage request gets the fleet classifier', () => {
    expect(pickTemplate('triage this inter-agent message')).toBe('msg-triage')
    expect(pickTemplate('triage the inbound agent message')).toBe('msg-triage')
    expect(pickTemplate('classify these messages for me')).toBe('msg-triage')
  })

  it('the split does not depend on rule ORDER -- the two patterns are disjoint', () => {
    // Measured by swapping the two rules in RULES: all cases here stay green, because neither
    // pattern matches the other's phrasing. Worth pinning, because "first match wins" makes rule
    // order load-bearing elsewhere in this file, and a reader could reasonably assume it is here
    // too and 'fix' a future bug by reordering.
    expect(pickTemplate('triage this email from a customer')).toBe('triage')
    expect(pickTemplate('triage this inter-agent message')).toBe('msg-triage')
  })

  it('an UNQUALIFIED triage request matches NEITHER -- a coin flip is not a match', () => {
    // This file's own doctrine: anything vague falls through to null rather than guessing. Here the
    // guess would be between two incompatible output contracts, so null is the only honest answer.
    expect(pickTemplate('triage this for me please')).toBeNull()
  })
})

describe('changelog and release-notes are different documents (card 002120b1)', () => {
  it('a CHANGELOG request no longer routes to release-notes', () => {
    // release-notes used to own /\bchangelog entry\b/, so the phrase that most plainly names the
    // changelog template returned a different one: user-facing New/Improved/Fixed prose instead of
    // Keep a Changelog Added/Changed/Fixed/Removed/Deprecated/Security groups.
    expect(pickTemplate('write a changelog entry for these changes')).toBe('changelog')
    expect(pickTemplate('generate a changelog for the release')).toBe('changelog')
  })

  it('a RELEASE NOTES request still routes to release-notes', () => {
    expect(pickTemplate('write release notes for v2')).toBe('release-notes')
  })

  it('a PR description is reachable at all -- it used to return null', () => {
    // pr-body.txt shipped on disk but was absent from KNOWN_TEMPLATES, so the picker could never
    // select it however the request was phrased.
    expect(pickTemplate('write a PR description for these commits')).toBe('pr-body')
    expect(pickTemplate('draft the pull-request body')).toBe('pr-body')
  })
})


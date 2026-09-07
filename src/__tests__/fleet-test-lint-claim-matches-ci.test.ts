// The lint-ratchet comment in fleet-test.sh makes a claim about CI, and claims about a NEIGHBOURING
// file rot silently (card 774624c4).
//
// WHAT WENT STALE. The comment said ESLint is called by nothing -- "not this script, not `npm test`,
// and there is no .github/workflows". That last clause stopped being true on 2026-08-22, when
// `.github/workflows/test.yml` landed with 56af7a69 (`secret-gate.yml` is older still). Nobody
// noticed for two weeks, because a comment has no failing mode.
//
// WHY THAT IS WORSE THAN AN ORDINARY STALE COMMENT. Its CONCLUSION is still correct -- CI runs
// typecheck and the suite, and neither runs the linter -- so this ratchet remains the only thing in
// the repo that executes ESLint. A reader who spotted the false clause could reasonably draw the
// OPPOSITE conclusion, that CI now covers lint and this block is redundant, and delete the one
// mechanism that actually looks. The correction is therefore not cosmetic.
//
// SO THE PREMISE IS PINNED, not the prose. This does not check the wording; it checks the fact the
// wording depends on. The day a workflow starts running ESLint, this fails and someone re-reads the
// comment -- which is the outcome the two silent weeks did not produce.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKFLOWS = join(ROOT, '.github', 'workflows')

const workflowFiles = (): string[] =>
  existsSync(WORKFLOWS)
    ? readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    : []

// Cybered NO-GO (card cd4f9762, comment 22265) on the first version of this file: a bare
// `\blint\b` misses "eslint" itself -- "lint" inside "eslint" has no WORD boundary before it (the
// preceding character is "s", not a non-word character), so `\b` never matches there. Reproduced
// independently, twice: a `pretest: "eslint src"` script and a workflow `run: npx eslint src` step
// both slipped through the old pattern (`node -e` confirmed `/\blint\b/i.test("eslint src")` is
// `false`), reopening the exact silent gap this ratchet exists to close, on a new axis. `lint` and
// `eslint` each still sit on their own word boundaries in `\b(lint|eslint)\b`, so "delint"/"linter"
// still do not slip THROUGH the other direction (Rule 12).
const LINT_MENTION_RE = /\b(lint|eslint)\b/i

describe('LINT_MENTION_RE itself (card cd4f9762, Cybered NO-GO comment 22265)', () => {
  // Cybered reproduced this against the real files this describe block reads (a scratch
  // pretest="eslint src" and a scratch workflow "run: npx eslint src"), independently of source
  // inspection. Pinned here directly on the regex too, so the exact shape cannot regress silently
  // a second time on the same axis.
  it('catches a DIRECT eslint invocation, not just an npm/pnpm/yarn "lint" call', () => {
    expect(LINT_MENTION_RE.test('eslint src')).toBe(true)
    expect(LINT_MENTION_RE.test('npx eslint src')).toBe(true)
  })

  it('still catches every "lint" call form the widening was FOR', () => {
    expect(LINT_MENTION_RE.test('npm run lint')).toBe(true)
    expect(LINT_MENTION_RE.test('pnpm lint')).toBe(true)
    expect(LINT_MENTION_RE.test('yarn lint')).toBe(true)
  })

  it('CONTROL: a word merely CONTAINING "lint" does not slip through the other direction (Rule 12)', () => {
    expect(LINT_MENTION_RE.test('delint')).toBe(false)
    expect(LINT_MENTION_RE.test('linter')).toBe(false)
    expect(LINT_MENTION_RE.test('splinter')).toBe(false)
  })

  it('a package NAME containing eslint (e.g. installing eslint-plugin-x) DOES match -- documented, ' +
    'not a bug: neither caller runs this against install/dependency lines, only script COMMANDS ' +
    '(package.json scripts values) and workflow file bodies, and today neither contains one ' +
    '(asserted below in each describe block)', () => {
    expect(LINT_MENTION_RE.test('eslint-plugin-import')).toBe(true)
  })
})

describe('the lint-ratchet comment in fleet-test.sh still matches CI (card 774624c4)', () => {
  it('the negative control: there ARE workflows, so the check below is not vacuous', () => {
    // The original defect was a claim that no workflows exist. If they ever disappear, the lint
    // assertion would pass over an empty set and prove nothing -- so their existence is asserted
    // first, exactly as the comment's corrected text now states it.
    expect(workflowFiles().length).toBeGreaterThan(0)
    expect(workflowFiles()).toContain('test.yml')
  })

  it('NO workflow runs the linter -- which is why the ratchet is still the only caller', () => {
    // Card cd4f9762 (Cybered finding, F-2): the old pattern only matched the CALL FORM used
    // today (`eslint`, `run lint`, `npm run lint`) -- `pnpm lint`/`yarn lint` have no "run" and
    // slipped through untested. LINT_MENTION_RE is the wider net; it still finds zero matches
    // on the current two workflow files (asserted as the negative control above), so widening it
    // costs nothing today and closes the pnpm/yarn gap (and, per the comment on its definition,
    // the direct-eslint gap the first version of this widening reopened).
    const offenders = workflowFiles().filter((f) =>
      LINT_MENTION_RE.test(readFileSync(join(WORKFLOWS, f), 'utf-8')),
    )
    expect(
      offenders,
      'a workflow now mentions lint, so fleet-test.sh\'s lint-ratchet comment (and possibly the ' +
        'ratchet itself) needs re-reading: it states that this script is the only thing that ' +
        'executes ESLint.',
    ).toEqual([])
  })

  it('`npm test` is still only the suite, not a lint-and-test bundle', () => {
    // The other half of the comment's claim. If `npm test` ever grew a lint step, CI would run the
    // linter transitively and the sentence would be wrong again -- without any workflow mentioning
    // eslint, so the check above would not catch it.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }
    expect(pkg.scripts?.['test']).toBe('vitest run')
  })

  it('NO lifecycle hook other than the "lint" script itself references lint (card cd4f9762, F-1)', () => {
    // `npm test` runs `pretest` first if one exists, and `npm ci`/`npm install` (CI's own
    // `.github/workflows/test.yml` step, --ignore-scripts not set) runs `preinstall`. The check
    // above only pins the `test` key's own value -- a `pretest` or `preinstall` hook that calls
    // lint would run the linter under CI transitively without EITHER of the two checks above
    // noticing, since no workflow file would say "lint" either. Pin the general fact instead:
    // across every npm lifecycle hook, only the `lint` key itself may mention lint.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }
    const offenders = Object.entries(pkg.scripts ?? {})
      .filter(([name, cmd]) => name !== 'lint' && LINT_MENTION_RE.test(cmd))
      .map(([name]) => name)
    expect(
      offenders,
      'a script other than "lint" now mentions lint in package.json -- if it is an npm lifecycle ' +
        'hook (pretest, preinstall, ...) it runs implicitly under `npm test`/`npm ci`, which would ' +
        'make the two checks above (workflow files, the "test" key) both blind to it.',
    ).toEqual([])
  })

  // A FOURTH CHECK WAS WRITTEN AND REMOVED, and the reason belongs here rather than in a commit
  // message nobody re-reads. It asserted that fleet-test.sh no longer contains the sentence
  // "there is no .github/workflows" -- and it failed immediately, on the CORRECTION NOTE, which
  // quotes that sentence in order to say it was wrong. Two things were wrong with it:
  //   * it contradicted this file's own stated design, three paragraphs up: pin the FACT, not the
  //     prose. The three checks above fail when reality changes; a wording check fails when someone
  //     writes ABOUT the wording, which is the opposite of useful.
  //   * it is the same false positive this fleet has hit before -- a guard that matches a corpus
  //     matches its own commentary, and the correction note is exactly the text a future reader
  //     needs most.
  // If the stale sentence were ever re-introduced as a CLAIM, the three checks above would still
  // pass -- that gap is real and accepted: a prose guard that cannot tell a claim from a quotation
  // costs more than it catches.
})

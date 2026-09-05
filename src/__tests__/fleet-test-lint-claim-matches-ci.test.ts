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

describe('the lint-ratchet comment in fleet-test.sh still matches CI (card 774624c4)', () => {
  it('the negative control: there ARE workflows, so the check below is not vacuous', () => {
    // The original defect was a claim that no workflows exist. If they ever disappear, the lint
    // assertion would pass over an empty set and prove nothing -- so their existence is asserted
    // first, exactly as the comment's corrected text now states it.
    expect(workflowFiles().length).toBeGreaterThan(0)
    expect(workflowFiles()).toContain('test.yml')
  })

  it('NO workflow runs the linter -- which is why the ratchet is still the only caller', () => {
    const offenders = workflowFiles().filter((f) =>
      /\b(eslint|run lint|npm run lint)\b/i.test(readFileSync(join(WORKFLOWS, f), 'utf-8')),
    )
    expect(
      offenders,
      'a workflow now runs the linter, so fleet-test.sh\'s lint-ratchet comment (and possibly the ' +
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

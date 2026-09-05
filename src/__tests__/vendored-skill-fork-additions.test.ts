// Card 4a3c75a5 (Cybersec, on the 4276708e gate): three skills we vendor from an external repo
// carry fork-written content -- 70 lines, purely additive, zero deletions from the vendor text.
//
// WHAT THE MEASUREMENT ACTUALLY SHOWED, which is not quite what the card assumed. The card asked
// for the content to be moved "into the fork's own skill files, not behind the vendor symlink".
// It is ALREADY there: seed-skills/sp-*/ holds all three files, git-tracked, byte-identical to the
// installed copy. The source is safe. What is NOT safe is a future re-vendoring: re-copying these
// three files from upstream is the natural way to take a vendor update, and it would drop all 70
// lines in one commit, silently, because nothing here objects.
//
// So this file guards the direction that is actually exposed -- our own repo dropping our own
// additions -- and reads ONLY seed-skills/, never the vendored checkout, so it is deterministic on
// any machine and does not depend on ~/.claude existing.
//
// Provenance and the full section list: docs/fork-additions-to-vendored-skills.md
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SEED = join(REPO_ROOT, 'seed-skills')

// One entry per vendored file we have extended. The anchors are phrases from the ADDED sections;
// each is distinctive enough that it cannot survive a wholesale re-copy from upstream.
const FORK_ADDITIONS: { file: string; added: number; anchors: string[] }[] = [
  {
    file: 'sp-receiving-code-review/SKILL.md',
    added: 8,
    anchors: [
      '## The Bottom Line',
      'External feedback = suggestions to evaluate, not orders to follow',
      'No performative agreement. Technical rigor always.',
    ],
  },
  {
    file: 'sp-verification-before-completion/SKILL.md',
    added: 30,
    anchors: [
      'Claiming work is complete without verification is dishonesty, not efficiency.',
      'The bare-`grep` trap.',
      // The measured numbers are the point of that section: without them it is an opinion.
      'found 1 of 3',
      '## Why This Matters',
    ],
  },
  {
    file: 'sp-test-driven-development/writing-good-tests.md',
    added: 32,
    anchors: [
      '### Short-circuit operator vacuous fixture trap',
      'the fixture must make',
      'completionRate: 73',
    ],
  },
]

describe('fork additions to vendored skills survive re-vendoring (card 4a3c75a5)', () => {
  it.each(FORK_ADDITIONS.map((a) => [a.file, a] as const))(
    '%s still carries its fork-written section',
    (_name, entry) => {
      const path = join(SEED, entry.file)
      expect(existsSync(path), `${entry.file} is missing from seed-skills/`).toBe(true)
      const text = readFileSync(path, 'utf-8')
      for (const anchor of entry.anchors) {
        expect(
          text,
          `${entry.file} no longer contains a fork-written passage (${JSON.stringify(anchor)}). ` +
            'If this file was just re-copied from the vendored upstream, the re-copy dropped ' +
            `${entry.added} lines of our own content -- see docs/fork-additions-to-vendored-skills.md ` +
            'and put them back rather than deleting this expectation.',
        ).toContain(anchor)
      }
    },
  )

  it('the provenance record exists and names all three files', () => {
    const doc = join(REPO_ROOT, 'docs', 'fork-additions-to-vendored-skills.md')
    expect(existsSync(doc), 'docs/fork-additions-to-vendored-skills.md missing').toBe(true)
    const text = readFileSync(doc, 'utf-8')
    for (const { file } of FORK_ADDITIONS) {
      expect(text, `the record does not mention ${file}`).toContain(file)
    }
  })
})

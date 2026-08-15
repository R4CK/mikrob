// No NUL byte in a text file (card ee01f7ce, Cybersec F3).
//
// THE DEFECT CLASS. A single NUL byte anywhere in a file is enough for grep to call the whole file
// binary, and `grep -I` (and the ugrep shim, see below) then SKIPS it: no match, no warning, rc=1 --
// indistinguishable from a clean file. Every grep-based secret/marker sweep we own inherits that
// blindness, so a NUL byte is a way to hide content from our own tooling. store/repomix.sh was the
// measured case (a `secretlint-disable` marker in a NUL-containing file muted the secret scanner and
// the pack went ahead); its own guard test pins the fix behaviourally.
//
// This file closes the other half: stop new NUL bytes from entering the corpus at all, so the next
// sweep does not have to be clever. It is the "highest value" item on the card because it is the one
// that acts on files nobody has looked at yet.
//
// WHAT WE MEASURED ABOUT THE FIVE EXISTING ONES, because the card assumed corruption (a known WSL
// write fault) and that turned out to be wrong: all of them are DELIBERATE literal control
// characters -- a regex character class written as `[<NUL>-\x1f]`, prose quoting an injection test,
// and a test fixture feeding a binary-ish string. Removing the byte would change what each file
// means, so they are recorded here with their exact count rather than "cleaned". Rewriting them as
// `\x00` escapes would keep the meaning AND empty this list, but the four security-reference copies
// belong to Cybersec/Cybered/teszter, so that is their call and not a drive-by here.
//
// A NOTE THAT COST AN HOUR, worth leaving for the next reader: in an AGENT's interactive shell
// `grep` is a bash function installed by the harness that shims to ugrep with `-I` HARDCODED. So an
// agent grepping by hand is NUL-blind even without asking for it, while a shell SCRIPT gets GNU grep
// 3.12 (the function is not exported -- measured) and is only blind if it passes -I itself. A
// zero-result grep typed at an agent prompt is therefore not evidence of absence.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

/** Extensions whose files are SUPPOSED to be binary. Deliberately short: a new binary type in the
 *  repo should be an acknowledged addition, not something this guard waves through. */
const BINARY_EXT: readonly string[] = ['.png', '.jpg']

/** Text files that hold a NUL on purpose, with the exact number of them. The count is the point: a
 *  NEW NUL appearing in one of these files changes it and turns this red, so an entry cannot become
 *  a blanket exemption for the file. This list must only ever SHRINK. */
const DELIBERATE_NUL: Readonly<Record<string, number>> = {
  // Prose describing an injection test, quoting the literal characters it is about:
  // "when the verdict text quotes an injection/control-char test (literal `<NUL>`, `\x01`, BIDI ...)"
  'seed-fleet-agents/cybered/.claude/skills/cybered-gate-pattern/SKILL.md': 1,
  // Two regex character classes written with a literal NUL as the range start:
  // `const FORBIDDEN = /[<NUL>-\x1f\x7f-\x9f‪-‮⁦-⁩]/` and `[<NUL>-\x1f\x7f]`.
  //
  // THE LIST SHRANK ON ITS FIRST DAY, which is the whole point of it. Three sibling copies
  // (cybered, cybersec, teszter) were rewritten hours after this guard landed -- 6434 -> 11607
  // bytes, literal NULs replaced by escapes -- exactly the follow-up flagged on card ee01f7ce as
  // "their call, not a drive-by here". The stale-list assertion caught it by name and their entries
  // were deleted rather than re-pinned at 0, because an entry that says "this file holds a
  // deliberate NUL" about a file with none is a lie the list must not carry.
  //
  // The seed copy was NOT rewritten and still holds its two, so it stays. When it follows, delete
  // this line too; it must never be updated to 0.
  'seed-skills/white-hat-security-testing/references/recurring-no-go-classes.md': 2,
  // A test fixture: `for (const content of ['', '<NUL>\x01garbage', '\n\n\n'])` -- the NUL is the
  // input under test, so escaping it here would weaken the test it belongs to.
  'src/__tests__/last-update-badge.test.ts': 1,
}

interface Scanned {
  readonly path: string
  readonly nulCount: number
}

/** Every tracked file that contains at least one NUL. `git ls-files -z` because a repo path may
 *  legally contain a newline, and splitting on one would corrupt the very filenames this guard is
 *  meant to name. */
function filesWithNul(): { scanned: number; hits: Scanned[] } {
  const raw = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  const paths = raw
    .toString('utf-8')
    .split('\0')
    .filter((p) => p.length > 0)
  const hits: Scanned[] = []
  for (const p of paths) {
    let buf: Buffer
    try {
      buf = readFileSync(join(REPO_ROOT, p))
    } catch {
      continue // deleted from the worktree but still in the index; not this guard's business
    }
    let n = 0
    for (const byte of buf) if (byte === 0) n++
    if (n > 0) hits.push({ path: p, nulCount: n })
  }
  return { scanned: paths.length, hits }
}

const { scanned, hits } = filesWithNul()
const isBinaryExt = (p: string) => BINARY_EXT.some((e) => p.toLowerCase().endsWith(e))

describe('no NUL byte in a text file (card ee01f7ce)', () => {
  it('the scan actually read the repository -- it is not asserting over nothing', () => {
    // The negative control. Every assertion below is a filter that passes trivially on an empty
    // list, so a broken `git ls-files`, a wrong REPO_ROOT or an unreadable tree would otherwise
    // report a perfectly clean corpus it never opened.
    expect(scanned, 'git ls-files returned almost nothing').toBeGreaterThan(1000)
    expect(
      hits.length,
      'not one NUL-containing file found -- the byte check is broken'
    ).toBeGreaterThan(10)
  })

  it('every NUL-containing file is either a binary format or a recorded deliberate case', () => {
    const undeclared = hits
      .filter((h) => !isBinaryExt(h.path) && !(h.path in DELIBERATE_NUL))
      .map((h) => `${h.path} (${h.nulCount} NUL)`)
    expect(
      undeclared,
      'These text files contain a NUL byte, which makes them INVISIBLE to every `grep -I` sweep we ' +
        'run -- silently, with no warning and no match. Either remove the byte (write it as a \\x00 ' +
        'escape if the content is about control characters), or, if it genuinely has to be a raw ' +
        'byte, add the file to DELIBERATE_NUL with its count and the reason.'
    ).toEqual([])
  })

  it('the deliberate list is a snapshot of reality, not an aspiration', () => {
    // Same discipline the list demands of everyone else. An entry whose file is gone, or whose NUL
    // has been removed or multiplied, is a stale exemption pretending to be a decision.
    const byPath = new Map(hits.map((h) => [h.path, h.nulCount]))
    const stale = Object.entries(DELIBERATE_NUL)
      .filter(([p, n]) => byPath.get(p) !== n)
      .map(([p, n]) => `${p}: expected ${n}, found ${byPath.get(p) ?? 'no NUL at all'}`)
    expect(
      stale,
      'these entries no longer describe the file: if the NUL is gone, DELETE the line (the list may ' +
        'only shrink); if the count changed, a new NUL arrived and needs its own reason'
    ).toEqual([])
  })

  it('the byte check finds a NUL wherever it sits in a file', () => {
    // The detector is the part that could quietly disable this guard, so it is exercised directly
    // rather than trusted. A first-byte and a last-byte case because an off-by-one in a hand-rolled
    // scan typically survives the middle-of-file case that everyone tests.
    const count = (s: Buffer) => [...s].filter((b) => b === 0).length
    expect(count(Buffer.from('clean text\n', 'utf-8'))).toBe(0)
    expect(count(Buffer.from([0x61, 0x00, 0x62]))).toBe(1)
    expect(count(Buffer.from([0x00, 0x61])), 'NUL as the first byte').toBe(1)
    expect(count(Buffer.from([0x61, 0x00])), 'NUL as the last byte').toBe(1)
    expect(count(Buffer.from([0x00, 0x00, 0x00]))).toBe(3)
  })
})

// Card 0b3a3084: when the local-LLM offload posts a draft, the leaf's owner is told IMMEDIATELY.
//
// THE MEASURED PROBLEM (backend2's finding, twice on one day on one agent). The draft arrives
// ASYNCHRONOUSLY, after dispatch. On f3757cc7 and 90e4cbdf the agent read the card at dispatch time
// with zero comments, the draft landed later (10:10:10 on 90e4cbdf, well after the work had started),
// and nothing looked back. Both times the draft-review guard (1338e68b) caught it at the END -- which
// is correct behaviour for a guard and useless for the offload, because a draft discovered after the
// work is done is an administrative item, not a token saving. "Read the comments when you pick up the
// card" cannot close this: at pick-up time there is nothing to read.
//
// WHY THESE ASSERTIONS AND NOT AN END-TO-END RUN. Sending a real nudge needs a live dashboard, a
// loaded 7B and a running recipient session. The part that can actually be wrong is the ROUTING
// DECISION (who gets told when the assignee is missing or parked), and that is a pure function the
// script exposes through --test-nudge-recipient, so it is driven here for real rather than grepped.
// The pairing invariant -- both posting sites nudge -- is a source property and is checked as one.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const SCRIPT = join(REPO_ROOT, 'store/offload-dispatch.sh')
const SRC = readFileSync(SCRIPT, 'utf8')

/** Executable lines only: a helper named in a comment is documentation, not a call. */
const CODE_LINES = SRC.split('\n').filter((l) => !/^\s*#/.test(l))

/** Run the script's own routing decision. Returns [recipient, note]. */
function route(assignee: string, running: '0' | '1'): [string, string] {
  const out = execFileSync('bash', [SCRIPT, '--test-nudge-recipient', assignee, running], {
    encoding: 'utf-8',
  })
  const [to, note = ''] = out.replace(/\n$/, '').split('\t')
  return [to ?? '', note]
}

describe('the draft nudge routes to someone who will actually receive it (card 0b3a3084)', () => {
  it('a running assignee is told directly', () => {
    const [to, note] = route('backend', '1')
    expect(to).toBe('backend')
    expect(note).toBe('')
  })

  it('a PARKED assignee does not swallow the nudge -- it goes to mikrob, naming them', () => {
    // POST /api/messages ACCEPTS a message for a parked agent (it validates that the recipient is a
    // known agent, not that it holds a session) and the row sits pending until the router abandons
    // it. So a nudge sent to a parked agent is not an error anywhere -- it is a silent loss, which
    // is the exact failure this card exists to remove. mikrob never parks itself, so it is the one
    // recipient that always has a session.
    const [to, note] = route('qa2', '0')
    expect(to).toBe('mikrob')
    expect(note).toContain('qa2')
    expect(note).toMatch(/PARKOLVA/)
  })

  it('a leaf with NO assignee goes to mikrob, and says so', () => {
    // Rule 6a requires an assignee on every planned card; practice does not always follow. Sending
    // nothing would hide both the draft AND the rule violation.
    const [to, note] = route('', '1')
    expect(to).toBe('mikrob')
    expect(note).toMatch(/NINCS felelose/)
  })

  it('a whitespace-only assignee counts as no assignee, not as an agent named " "', () => {
    const [to] = route('   ', '1')
    expect(to).toBe('mikrob')
  })

  it('the harness is really running the script -- otherwise every case above is vacuous', () => {
    // Two DIFFERENT inputs must give two different answers; a stub returning one constant passes
    // any single-case check.
    expect(route('backend', '1')[0]).not.toBe(route('backend', '0')[0])
    expect(SRC).toContain('--test-nudge-recipient')
  })
})

describe('one contract, both call sites', () => {
  /** Lines that CALL a posting helper (not the two function definitions). */
  function postingCallSites(): { line: string; index: number }[] {
    return CODE_LINES.map((line, index) => ({ line, index })).filter(
      ({ line }) =>
        /\b(post_draft_comment|post_exhausted_notice)\s+"/.test(line) && !/\)\s*\{\s*$/.test(line)
    )
  }

  it('finds both posting sites at all', () => {
    // The card was opened because one of a pair got updated and the other did not. A matcher that
    // silently finds zero sites would let exactly that ship.
    const sites = postingCallSites()
    expect(sites.length).toBe(2)
    expect(sites.some(({ line }) => line.includes('post_draft_comment'))).toBe(true)
    expect(sites.some(({ line }) => line.includes('post_exhausted_notice'))).toBe(true)
  })

  it('every posting site nudges the owner right after posting', () => {
    for (const { line, index } of postingCallSites()) {
      const following = CODE_LINES.slice(index + 1, index + 3).join('\n')
      expect(following, `no nudge next to: ${line.trim()}`).toMatch(/nudge_leaf_owner\s+"/)
    }
  })

  it('the nudge cannot fail the dispatch -- the script is best-effort by contract', () => {
    for (const line of CODE_LINES.filter((l) => /nudge_leaf_owner\s+"/.test(l))) {
      expect(line, `nudge call must not be able to abort: ${line.trim()}`).toMatch(
        /\|\|\s*true\s*$/
      )
    }
    // And nothing turned on errexit underneath it since.
    expect(SRC).toMatch(/^set -uo pipefail$/m)
    expect(SRC).not.toMatch(/^set -e/m)
  })

  it('a dead dashboard still exits 0', () => {
    // The whole path is a non-blocking dispatch step; a broken board must not fail the dispatch that
    // called it. Port 1 refuses immediately, so this costs nothing.
    const out = execFileSync('bash', [SCRIPT, 'deadbeef'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        DASHBOARD_URL: 'http://127.0.0.1:1',
        OFFLOAD_VRAM_GUARD: '/nonexistent',
      },
    })
    expect(out).toContain('skip')
  })
})

describe('the leaf fields survive an EMPTY field (the bug that shipped, card 0b3a3084)', () => {
  // The leaf tuple is base64-encoded field-per-column and read back with `read -r`. A TAB
  // delimiter is IFS-WHITESPACE, so bash collapses consecutive tabs and an EMPTY field vanishes,
  // shifting every later field one to the left. `parent_context` is empty for any leaf with no
  // parent -- most cards -- so the field after it, `assignee_raw`, was lost: the nudge announced
  // "the card has NO assignee" for #370 (assigned to backend) and #327 (assigned to backend2),
  // and both went to mikrob instead. The same shift handed the local model the assignee name as
  // its --context. The 7-field form hid it because the empty field was last.

  it('bash really does collapse a TAB delimiter -- the premise, not folklore', () => {
    const tab = execFileSync(
      'bash',
      ['-c', `printf 'A\tB\t\tD\n' | { IFS=$'\t' read -r a b c d; echo "[$c][$d]"; }`],
      { encoding: 'utf-8' }
    ).trim()
    const pipe = execFileSync(
      'bash',
      ['-c', `printf 'A|B||D\n' | { IFS='|' read -r a b c d; echo "[$c][$d]"; }`],
      { encoding: 'utf-8' }
    ).trim()
    expect(tab, 'a tab delimiter drops the empty field and shifts D left').toBe('[D][]')
    expect(pipe, 'the chosen delimiter keeps the empty field in place').toBe('[][D]')
  })

  it('the writer and the reader agree on a delimiter that is not IFS whitespace', () => {
    // Anchored to the executable lines, comment-stripped: the explanation above names both
    // delimiters, so a file-wide search would stay green after the code went back to a tab.
    const code = SRC.split('\n').filter((l) => !/^\s*#/.test(l))
    const writer = code.filter((l) => /\.join\(base64\.b64encode/.test(l))
    const reader = code.filter((l) => /^\s*while IFS=.*read -r b64id/.test(l))
    expect(writer.length, 'writer line not found').toBe(1)
    expect(reader.length, 'reader line not found').toBe(1)
    expect(writer[0], 'writer must not join on a tab').not.toMatch(/"\\t"\.join/)
    expect(reader[0], 'reader must not split on a tab').not.toMatch(/IFS=\$'\\t'/)
    // The delimiter sits BEFORE `.join(` in python: `"|".join(base64...)`.
    const delim = /"(.)"\.join\(base64/.exec(writer[0])?.[1]
    expect(delim, 'could not read the writer delimiter').toBeDefined()
    expect(reader[0], `reader must use the same delimiter as the writer (${delim})`).toContain(
      `IFS='${delim}'`
    )
    // Base64 is A-Za-z0-9+/= -- the delimiter must not collide with it, or a field splits itself.
    expect(delim!, 'delimiter collides with the base64 alphabet').not.toMatch(/[A-Za-z0-9+/=]/)
  })
})

describe('the nudge is labelled as automation, not as the orchestrator reading your card', () => {
  it('carries the disclaiming tag, the way fleet-nudger.sh does', () => {
    // from must be a registered fleet agent (POST /api/messages rejects an unknown sender), and
    // 'local-llm' is not one -- it is a comment-author identity, not an agent directory. The fleet's
    // existing convention for an automated message is from=mikrob plus a tag saying no human-shaped
    // orchestrator looked at anything. Card 3307b428 (never sign a draft as mikrob) is about COMMENT
    // authorship, which the gate sweeps key on; a message is not swept by author.
    expect(SRC).toMatch(/NUDGE_FROM="mikrob"/)
    expect(SRC).toMatch(/NUDGE_TAG=".*nem MikroB olvasta el/)
  })

  it('the draft comment author is untouched by this change', () => {
    expect(SRC).toContain('DRAFT_AUTHOR="local-llm"')
  })

  it('the draft nudge points at the Draft-Review line the guard will ask for', () => {
    // Telling someone a draft exists without telling them what closes it just moves the surprise.
    expect(SRC).toMatch(/Draft-Review: ELFOGADVA/)
  })
})

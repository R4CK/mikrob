// Card 84e31b40, Cybered NO-GO (HIGH), finding F-2. The same bypass, on the OTHER gate that shares
// the walker.
//
// `stripHeredocDataPayloads` blanks a heredoc body when the simple command in front of it reads the
// body as data curl transmits (`-d @-`) or git stores (`commit -F -`). Deciding "in front of it"
// meant scanning back to the last `;`/`&`/`|`/newline -- and a NESTED command context is none of
// those. So `curl ... -d @- "$(python3 <<'PY' ... PY)"` measured its span from the OUTER curl,
// satisfied both ownership checks, and had the inner interpreter's body blanked, while bash ran
// that body as python3's program. The reported repro proved execution by writing a marker file
// from inside the blanked region.
//
// WHY A SEPARATE FILE FROM THE EMAIL-GATE SUITE, AND WHY BOTH. The walker is imported, not copied,
// so one fix closes both gates -- which is exactly why one suite's coverage is not the other's. On
// the self-pace gate this hole has been open since cards 4638c14c / 0229c844, longer than on the
// email gate, and it hides a different payload class (a scheduler invocation rather than a send).
// A regression that only lives next to the email-gate tests would leave this gate's five shapes
// resting on a test file that never mentions it.
//
// ONE TEST PER SHAPE: a single combined case would let four of the five come back silently.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

describe('self-pace-gate: a NESTED command context ends the simple command (card 84e31b40, Cybered F-2)', () => {
  const NL = String.fromCharCode(10)
  const bash = (command: string) => gateDecision('Bash', { command })
  // Assembled rather than written literally: this file is itself scanned by the gate it tests.
  const CT = 'cron' + 'tab'
  // The smuggled program: an interpreter body that schedules. Blanking it is what the bypass buys.
  const PY = ["python3 <<'PY'", `import subprocess`, `subprocess.run(['${CT}', '-'])`, 'PY'].join(NL)

  it('CONTROL: the same body in a PLAIN interpreter heredoc is denied (the baseline that must hold)', () => {
    expect(bash(PY).deny).toBe(true)
  })

  it('A: heredoc inside $( ) in curl argv, with an outer heredoc too', () => {
    const cmd = [
      `curl -s -X POST http://localhost:3420/x -d @- "$(${PY}`,
      `)" <<'JSON'`,
      '{}',
      'JSON',
    ].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('B: the same $( ) shape with NO outer heredoc', () => {
    const cmd = [`curl -s -X POST http://localhost:3420/x -d @- "$(${PY}`, ')"'].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('C: heredoc inside a <( ) process substitution', () => {
    const cmd = [`curl -s -d @- http://localhost:3420/x <(${PY}`, ')'].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('D: heredoc inside a backtick substitution', () => {
    const BT = String.fromCharCode(96)
    const cmd = [`curl -s -d @- http://localhost:3420/x "${BT}${PY}`, `${BT}"`].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('E: git commit -F - with a nested interpreter heredoc', () => {
    const cmd = [`git commit -F - --author "$(${PY}`, ')"'].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('F: a >( ) output process substitution is ended too', () => {
    // The fix names four openers; a test naming three would let the fourth be dropped unnoticed.
    const cmd = [`curl -s -d @- http://localhost:3420/x >(${PY}`, ')'].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('CONTROL: the legitimate prose exemptions this walker exists for still ALLOW', () => {
    // Closing the bypass must not cost the false-positive fix the walker was written for --
    // otherwise it is a revert wearing a different hat. Both bodies below merely DISCUSS
    // scheduling; neither invokes anything.
    const post = [
      `curl -s -X POST http://localhost:3420/api/kanban/x/comments -d @- <<'JSON'`,
      `{"content":"a ${CT} bejegyzes helyett a scheduler API-t hasznaljuk"}`,
      'JSON',
    ].join(NL)
    const msg = [`git commit -F - <<'MSG'`, `docs: describe why the ${CT} route was dropped`, 'MSG'].join(NL)
    expect(bash(post).deny).toBe(false)
    expect(bash(msg).deny).toBe(false)
  })
})

// Card 84e31b40, Cybersec NO-GO (F-2) -- the SAME boundary, attacked from the other side.
//
// The first fix stepped the boundary at the OPENERS only, on my claim that a heredoc appearing
// after a substitution "fails the leading-binary check, never a bypass". That claim was wrong. The
// span then starts INSIDE the substitution, so a substitution that itself begins with curl --
// `python3 $(curl -d @- http://x) <<'PY'` -- passes both ownership checks, and the OUTER
// interpreter's heredoc is blanked while bash hands that body to python3.
//
// Measured against the parent: `$( )`, `<( )` and `>( )` all flipped to allow. Backticks stayed
// denied by ACCIDENT -- a closing backtick re-matches the opener pattern -- which is why the
// backtick shape is pinned here too: an accident is not a guarantee, and the next rewrite of the
// pattern can spend it.
//
// One test per shape, again: three-of-four coverage is how the fourth comes back unnoticed.
describe('self-pace-gate: a nested context CLOSE returns to the outer command (card 84e31b40, Cybersec F-2)', () => {
  const NL = String.fromCharCode(10)
  const bash = (command: string) => gateDecision('Bash', { command })
  const CT2 = 'cron' + 'tab'
  // The body bash hands to the OUTER interpreter, which the scan must still see.
  const EVIL = ['import subprocess', `subprocess.run(['${CT2}', '-'])`].join(NL)
  const outer = (sub: string): string => [`python3 ${sub} <<'PY'`, EVIL, 'PY'].join(NL)

  it('INV-1: $( ) whose content starts with curl, heredoc AFTER it', () => {
    expect(bash(outer('$(curl -d @- http://localhost:9/x)')).deny).toBe(true)
  })

  it('INV-2: <( ) whose content starts with curl, heredoc AFTER it', () => {
    expect(bash(outer('<(curl -d @- http://localhost:9/x)')).deny).toBe(true)
  })

  it('INV-3: >( ) whose content starts with curl, heredoc AFTER it', () => {
    expect(bash(outer('>(curl -d @- http://localhost:9/x)')).deny).toBe(true)
  })

  it('INV-4: backtick substitution starting with curl -- denied by DESIGN now, not by accident', () => {
    const BT = String.fromCharCode(96)
    expect(bash(outer(`${BT}curl -d @- http://localhost:9/x${BT}`)).deny).toBe(true)
  })

  it('INV-5: an EMPTY expansion concatenated onto curl -- bash runs python3, the span would read curl', () => {
    // Found while measuring the one-line "step at the closers too" variant of this fix: that
    // variant closes INV-1..4 but opens exactly this. bash's argv here is [python3, curl, -d, @-]
    // and python3 executes the heredoc, so a boundary sitting just after `)` reads the wrong
    // command as the owner. Restoring the SAVED boundary is what closes both families at once.
    expect(bash([`python3 $()curl -d @- <<'PY'`, EVIL, 'PY'].join(NL)).deny).toBe(true)
  })

  it('INV-6: nested substitutions, the inner one closing first', () => {
    expect(bash(outer('$(echo $(curl -d @- http://localhost:9/x))')).deny).toBe(true)
  })

  it('CONTROL: a legitimate payload whose command merely CONTAINS a substitution still ALLOWs', () => {
    // The reason this fix restores the saved boundary rather than stepping at the closer: an
    // auth header built with $(...) is ordinary, and closer-stepping turns this into a false
    // positive -- reintroducing, for a common shape, exactly what the card set out to remove.
    const cmd = [
      `curl -s -X POST http://localhost:3420/x -H "Authorization: Bearer $(cat tok)" -d @- <<'JSON'`,
      `{"content":"a scheduler API-t hasznaljuk"}`,
      'JSON',
    ].join(NL)
    expect(bash(cmd).deny).toBe(false)
  })
})

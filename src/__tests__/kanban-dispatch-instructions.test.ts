import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { kanbanMoveInstructions } from '../web/routes/kanban.js'
import { MAIN_AGENT_ID, OWNER_NAME } from '../config.js'

// The status probe is now TWO lines (card 41d8e96f: the token-read printf must
// be piped into curl, never embedded mid-line as an argv element) -- the printf
// line immediately followed by the `| curl ... | python3 -c ...` line.
const probeLine = (out: string): string | undefined => {
  const lines = out.split('\n')
  const idx = lines.findIndex((l) => l.includes('/api/kanban |'))
  return idx === -1 ? undefined : `${lines[idx - 1]}\n${lines[idx]}`
}

// A card dispatched to an agent used to just say "drag it to done" -- but a
// headless agent cannot drag, and the run left no record on the card. The
// instructions now give the agent the exact curl to post a REVIEW result
// summary and to move the card to waiting, so the dispatched task's RESULT
// lands on its own card (visible in the dashboard UI) -- the lightweight
// alternative to per-session cards. Card 7fda4058 (2026-08-07): the template
// used to tell every agent to self-close to "done", which collides with the
// standing gate rule (only MikroB/QA close a finished card) -- an agent that
// followed the template literally would have bypassed the gate.
describe('kanbanMoveInstructions', () => {
  it('gives the agent the curl to post a REVIEW result comment AND to move to waiting, never self-close to done', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    // Step 1: a human-readable REVIEW result comment lands on the card.
    expect(out).toContain('/api/kanban/abc123/comments')
    expect(out).toContain('"author":"cody"')
    expect(out).toContain('REVIEW')
    // Step 2: move to waiting, NOT done -- closing is MikroB/gate's job.
    expect(out).toContain('/api/kanban/abc123/move')
    expect(out).toContain('"status":"waiting"')
    expect(out).not.toContain('"status":"done"')
    // It must NOT rely on the agent "dragging" the card (a headless agent can't).
    expect(out).not.toContain('húzd "done"-ra')
  })

  // Upstream ties the `actor` field to a "self-close to done, with actor" flow (kanbanMoveInstructions
  // telling the agent to move done/in_progress with actor="cody"). Our fork's completion step is
  // "waiting", not "done" -- self-close is the exact thing the first test above forbids -- so this
  // function has no "done"/self-pickup-in_progress curl to name an actor on in the first place. The
  // `actor` field itself is real and used (moveKanbanCard/fireKanbanDispatch's self-advance-echo
  // suppression, see kanban.ts), just not through THIS instructional text's completion step.
  it('does not instruct a self-close-to-done actor move (fork policy, not upstream\'s)', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).not.toContain('"status":"done","actor":"cody"')
  })

  // The dispatch fires once, when the card enters in_progress, and is correct at
  // that moment -- but the message rides the normal inter-agent queue and a busy
  // session may read it a round later, after the work is already done. The guard
  // cannot live at dispatch time (the card is not `testing` yet when the message
  // is written), so it has to be IN the message. These assert it is there, that it
  // is actionable, and that it is read BEFORE the work rather than after it.
  it('tells the reader to re-check the card status before starting', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('MIELŐTT NEKIKEZDESZ')
    expect(out).toContain('testing')
    expect(out).toContain('NE kezdj bele')
  })

  it('hands over the status check as a runnable command, not as an instruction to compose', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    const probe = probeLine(out)
    expect(probe).toBeDefined()
    // Same token discipline as every other command in the message: read at run
    // time, never embedded.
    expect(probe).toContain('$(cat ')
    expect(probe).toContain('.dashboard-token')
  })

  // Text assertions cannot tell a working command from a plausible-looking one,
  // and this line's whole value is that the reader can paste it. So run the
  // program it emits: once against a board (the answer must be THIS card's status
  // AND description, not a neighbour's) and once against the error object the
  // endpoint returns when the token cannot be read -- the shape that made the
  // first draft die on a Python TypeError, which is the one answer a pre-flight
  // check must never give.
  const runProbeProgram = (out: string, stdin: string): string => {
    const probe = probeLine(out)!
    const program = probe.slice(probe.indexOf('python3 -c "') + 'python3 -c "'.length).replace(/"\s*$/, '')
    return execFileSync('python3', ['-c', program], { input: stdin, encoding: 'utf-8' }).trim()
  }

  // 2026-09-15, 7ed56208: an agent that ran exactly this probe never saw a
  // card-specific closing-status override, because the probe printed only the
  // status field -- the override lived one field over, in description, which
  // the probe never fetched. The probe now prints both.
  it('the emitted program reports THIS card status and description, and survives an error response', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    const board = JSON.stringify([
      { id: 'zzz999', status: 'in_progress', description: 'neighbour, must not leak' },
      { id: 'abc123', status: 'testing', description: 'zaro-statusz: review, nem done' },
    ])
    expect(runProbeProgram(out, board)).toBe('status: testing\ndescription: zaro-statusz: review, nem done')
    expect(runProbeProgram(out, JSON.stringify([{ id: 'zzz999', status: 'done' }]))).toBe('nincs ilyen kartya')
    const noDesc = runProbeProgram(out, JSON.stringify([{ id: 'abc123', status: 'planned', description: null }]))
    expect(noDesc).toBe('status: planned\ndescription: (nincs)')
    const err = runProbeProgram(out, JSON.stringify({ error: 'Unauthorized' }))
    expect(err).toContain('Unauthorized')
    expect(err).not.toContain('Traceback')
  })

  // Card 41d8e96f (Cybersec F1 MEDIUM, live): the status probe used to splice the
  // printf-auth command literally into curl's OWN argv (`curl -s ${auth} ${base}/...`),
  // because `auth` is a shell line-continuation ending in `\` meant to sit at the END of a
  // line -- mid-line it just escapes the following space. Rendered, curl tried to resolve
  // "printf" as a hostname and the token sat in /proc/<pid>/cmdline. The fix makes the
  // printf line and the piped curl line two ACTUAL lines, same shape as the REVIEW/move
  // commands below. Pinned two ways: the auth line must stand alone (not embedded inside a
  // `curl ... ${auth} ...` single line), and the curl line must read the header from stdin.
  it('the status probe pipes the auth line into curl -H @-, never splices it into curl argv', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    const probe = probeLine(out)!
    const [authLine, curlLine] = probe.split('\n')
    expect(authLine).toMatch(/^\s*printf 'Authorization: Bearer %s\\n' "\$\(cat .*\)" \\$/)
    expect(curlLine).toMatch(/^\s*\|\s*curl -s -H @- http:\/\//)
    // The regression shape: curl's own command-line carrying "printf" as if it were a
    // hostname/argument, which is what a mid-line splice produced.
    expect(curlLine).not.toMatch(/curl\s+-s\s+printf\b/)
  })

  it('puts the warning BEFORE the completion steps -- it is a pre-flight check', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out.indexOf('MIELŐTT NEKIKEZDESZ')).toBeLessThan(out.indexOf('Amikor VÉGEZTÉL'))
    // And it is the first thing in the block, not buried mid-message.
    expect(out.startsWith('MIELŐTT NEKIKEZDESZ')).toBe(true)
  })

  it('keeps the bearer token out of the message (reads it at run time)', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('$(cat ')
    expect(out).toContain('.dashboard-token')
  })

  // UPSTREAM-SYNC BATCH 4 (card 0b550d89): removed the two upstream tests that lived here
  // ("says the card own closing status outranks the template default" / "puts the ranking
  // sentence with step 2..."). Both assert step 2 literally says `"status":"done","actor":...`
  // and reads `2) Állítsd a kártyát done-ra` -- upstream's own, unchanged step 2. This fork's
  // step 2 says `"status":"waiting"` (the test right above this comment already pins that,
  // `toContain('"status":"waiting"')`, and it is untouched by this batch): the builder never
  // sets a closing status directly, the escalateTo/gate decides it after the REVIEW comment
  // (CLAUDE.md rule 4). Upstream's "program-specific closing status" sentence, declined in
  // kanban.ts's own merge resolution (see DECISIONS.md 2026-10-09 / 0b550d89 entry) for the
  // same reason, has no step-2 "done" left to rank against on this fork. Not adapted -- removed.

  // CARD 64c455da (WhiteHat M1 a 0b550d89 gate-ből): a "MIELŐTT NEKIKEZDESZ" szekció egy MÁSIK,
  // mondatban (a description-mezőt olvasó útmutatóban) ugyanezt az upstream gate-bypass koncepciót
  // hordozta tovább -- "más záró-státusz ... felülírja ... lásd a 2) lépésnél" -- szerveroldali
  // done-gate hiányában ez egy kártyaleírásból jövő injekciós emelő volt: egy kártya szövege
  // rávehetett volna egy ügynököt, hogy gate nélkül döntse el a záró-státuszt. Ez a teszt pirosra
  // vált, ha a szöveg BÁRHOL (nem csak a már letörölt escalation-résznél) visszakapja ezt a jogot.
  it('the description-override guidance never grants override rights over the closing status', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    // The description CAN carry stronger rules than the template (e.g. "no live restart") --
    // that general mechanism stays. What must NEVER appear again is a sentence pointing a
    // description-driven override AT the closing-status step.
    expect(out).not.toMatch(/más záró-státusz/)
    expect(out).not.toMatch(/felülírja.*2\)\s*lépésnél/)
    // Positive control: the sentence that explains the description can override NON-gate
    // defaults is still present, so this is not a vacuous "the feature was deleted" pass.
    expect(out).toContain('description')
    expect(out).toContain('nincs éles restart')
  })

  // Card e25a549a / RedHat NO-GO (komment 15997, B1): a kanban-assignee-guard strukturálisan
  // tiltja az assignee=MAIN_AGENT_ID írást (Peti 10943), de ez a sablon a nem-main-agent ágon
  // pontosan EZT a PUT-ot írta elő elakadás esetén ("told át <escalateTo>-re"), ahol
  // escalateTo=MAIN_AGENT_ID -- a tanácsolt lépés a guard miatt mindig 400-at adott volna. A
  // kártya a végrehajtón marad, a közvetlenül MAIN_AGENT_ID-hez szóló komment + a "waiting"
  // státusz a jelzés (MikroB saját waiting-sweepje olvassa ki, CLAUDE.md 4a szabály).
  it('a sub-agent escalation path never instructs reassigning the card to MAIN_AGENT_ID', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).not.toContain(`"assignee":"${MAIN_AGENT_ID}"`)
    expect(out).toContain(`a TE NEVEDEN marad`)
  })

  // Positive control: the main-agent's OWN escalation (to the human operator) is a different
  // value (OWNER_NAME, never the forbidden "mikrob"), so the old reassignment step is untouched
  // there -- this guards against the fix accidentally deleting the main-agent branch too.
  it('the main agent escalating to the operator still reassigns the card (unaffected branch)', () => {
    const out = kanbanMoveInstructions('abc123', MAIN_AGENT_ID)
    expect(out).toContain(`"assignee":"${OWNER_NAME}"`)
  })
})

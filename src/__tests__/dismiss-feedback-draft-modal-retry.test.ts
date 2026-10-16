// dismissFeedbackDraftModalIfPresent: verified retry + bounded backoff (card 813eeee9).
//
// WHY IT EXISTS. Measured live on backend3 (2026-09-19 09:20-09:36): the dismiss key ('0') does
// not always land on the modal -- it went into the prompt INPUT instead -- and the old code
// logged "Dismissed" unconditionally without re-checking. The not-ready caller re-ran this every
// second for 11+ minutes, each pass adding another '0' to the input box (it grew to 40+
// characters) while the log kept repeating a FALSE "Dismissed" next to it. This pins: (1) the
// function only claims success after RE-CAPTURING and confirming the modal is actually gone, (2)
// a failed attempt clears the stray digit(s) before retrying, (3) retries are bounded -- it does
// not loop forever and does not falsely log "Dismissed" when it never worked.
//
// captureTmux and runTmux both go through node:child_process execFileSync -- the pattern
// clear-input-buffer-retry.test.ts already uses in this suite, extended here because this
// function's retry loop also calls clearInputBuffer internally, so the capture-pane queue must
// cover BOTH call sites in call order.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents · 1 feedback d…'
  const MODAL_BOX = [
    '╭──────────────────────────────────────────────────────────────────────────────╮',
    '│ ✻ Bug report drafted: a test fixture summary…                                │',
    '│ 1 to review · 2 to send · 0 to dismiss                                       │',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ]
  // Modal still up, prompt empty -- the key has not been sent yet (or landed on the modal and was consumed).
  const MODAL_IDLE_PROMPT = [...MODAL_BOX, '', SEP, '❯ ', SEP, FOOTER].join('\n')
  // Modal still up, but the dismiss key MISSED and landed in the prompt input instead (the
  // measured incident shape): the stray '0' sits after the prompt marker.
  const MODAL_STRAY_DIGIT = [...MODAL_BOX, '', SEP, '❯ 0', SEP, FOOTER].join('\n')
  // Same, but several retries' worth of stray digits piled up (what the OLD code produced).
  const MODAL_STRAY_DIGITS_PILED = [...MODAL_BOX, '', SEP, '❯ 0000000000', SEP, FOOTER].join('\n')
  // Input box cleared (clearInputBuffer's own verify target), modal still up behind it.
  const MODAL_INPUT_CLEARED = MODAL_IDLE_PROMPT
  // The dismiss actually worked: no modal box, empty prompt.
  const DISMISSED = ['', SEP, '❯ ', SEP, FOOTER].join('\n')

  return {
    MODAL_IDLE_PROMPT,
    MODAL_STRAY_DIGIT,
    MODAL_STRAY_DIGITS_PILED,
    MODAL_INPUT_CLEARED,
    DISMISSED,
    // One entry per capture-pane call, consumed in order; the last one repeats once exhausted --
    // same convention as clear-input-buffer-retry.test.ts.
    panes: [] as string[],
    captures: 0,
    sendKeys: [] as string[],
  }
})

vi.mock('node:child_process', async (orig) => ({
  ...((await orig()) as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      if (args.includes('capture-pane')) {
        h.captures++
        return h.panes[Math.min(h.captures - 1, h.panes.length - 1)] ?? h.DISMISSED
      }
      if (args.includes('send-keys')) {
        h.sendKeys.push(args[args.length - 1])
      }
    }
    return ''
  }),
}))

import { logger } from '../logger.js'
import { dismissFeedbackDraftModalIfPresent } from '../web/agent-process.js'

beforeEach(() => {
  h.panes = []
  h.captures = 0
  h.sendKeys = []
  vi.restoreAllMocks()
})

describe('dismissFeedbackDraftModalIfPresent verified retry (card 813eeee9)', () => {
  it('returns without sending anything when the modal is not present', async () => {
    h.panes = [h.DISMISSED]
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    await dismissFeedbackDraftModalIfPresent('s')
    expect(h.sendKeys).toEqual([])
    expect(info).not.toHaveBeenCalled()
  })

  it('logs "Dismissed" only once the modal is RE-VERIFIED gone on the first try', async () => {
    h.panes = [h.MODAL_IDLE_PROMPT, h.DISMISSED]
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    await dismissFeedbackDraftModalIfPresent('s')
    expect(h.sendKeys.filter((k) => k === '0')).toHaveLength(1)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][1]).toMatch(/Dismissed/)
  })

  // THE CASE THAT PROVES THE FIX: the old code logged "Dismissed" right here, on the very capture
  // that shows the key missed and landed in the prompt input instead.
  it('does NOT log "Dismissed" when the key lands in the prompt input instead of the modal', async () => {
    h.panes = [h.MODAL_IDLE_PROMPT, h.MODAL_STRAY_DIGIT]
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    // Let the retry run its course (it will call clearInputBuffer and try again); only assert
    // that the FIRST miss was never reported as success.
    await dismissFeedbackDraftModalIfPresent('s')
    const falseSuccess = info.mock.calls.some((c) => String(c[1]).match(/Dismissed/))
    expect(falseSuccess).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('clears the stray input and SUCCEEDS on a later attempt after the first miss', async () => {
    // capture order: 1=presence check, 2=after 1st '0' (still stray), then clearInputBuffer's own
    // captures (row-count read, verify), then 3rd capture = after 2nd '0' (dismissed).
    h.panes = [
      h.MODAL_IDLE_PROMPT, // 1: presence check
      h.MODAL_STRAY_DIGIT, // 2: after attempt 1's '0' -- still present, digit stray
      h.MODAL_STRAY_DIGIT, // 3: clearInputBuffer row-count read
      h.MODAL_INPUT_CLEARED, // 4: clearInputBuffer verify -- box empty, clear succeeded
      h.DISMISSED, // 5: after attempt 2's '0' -- modal actually gone
    ]
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger as never)
    await dismissFeedbackDraftModalIfPresent('s')
    expect(h.sendKeys.filter((k) => k === '0')).toHaveLength(2)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][1]).toMatch(/Dismissed/)
    expect(error).not.toHaveBeenCalled()
  })

  // THE CASE THAT PROVES THE LOOP IS BOUNDED. Without a cap, a modal that can never be dismissed
  // by this key (card 813eeee9 point 4) would retry forever instead of giving up loudly.
  it('gives up after bounded retries and logs an error -- never a false "Dismissed"', async () => {
    // Every capture returns the piled-stray-digit shape: the modal never actually clears.
    h.panes = [h.MODAL_STRAY_DIGITS_PILED]
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger as never)
    await dismissFeedbackDraftModalIfPresent('s')
    const falseSuccess = info.mock.calls.some((c) => String(c[1]).match(/Dismissed/))
    expect(falseSuccess).toBe(false)
    // clearInputBuffer logs its own exhaustion error on each of the 3 outer attempts (expected,
    // not this function's concern); the LAST error call is this function's own "gave up" signal.
    expect(error.mock.calls.length).toBeGreaterThan(0)
    const lastCall = error.mock.calls[error.mock.calls.length - 1]
    expect(String(lastCall[1])).toMatch(/wedged/)
  }, 15000)

  it('answers the opt-out follow-up with Escape (keep feedback drafting ON), not a second "0"', async () => {
    const OPT_OUT = ['✻ done', '', 'Turn off Claude-drafted feedback? 0 to turn off · Esc to keep', '', '', '─'.repeat(80), '❯ ', '─'.repeat(80), '  ⏵⏵ bypass permissions on'].join('\n')
    h.panes = [h.MODAL_IDLE_PROMPT, OPT_OUT]
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    await dismissFeedbackDraftModalIfPresent('s')
    expect(h.sendKeys).toEqual(['0', 'Escape'])
    expect(info).toHaveBeenCalledTimes(1)
  })
})

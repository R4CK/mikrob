// Cybered, card bd4b74a3 (delta-review of the reverted idle-fastpath, msg 25438/comment
// 22505): the actual safety property against a mis-classified pane (a genuinely blocking
// SendFeedback modal that a static capture cannot be told apart from the passive notice --
// see pane-state.ts's detectsFeedbackDraftModal comment) is NOT any classifier. It is a
// structural invariant: every caller that consults isSessionReadyForPrompt for a delivery
// decision must route its ACTUAL keystroke-send through sendPromptToSession, because that is
// the ONE place dismissFeedbackDraftModalIfPresent's unconditional preflight runs. A caller
// that got a "ready" answer and then wrote into the pane some other way -- a lighter,
// bookkeeping-only path, or a future direct tmux call added "just for this one case" -- would
// reopen exactly the 2026-08-31/2026-09-07 incident class, this time for a reason no pane
// classifier could ever catch, because the bypass happens after classification.
//
// This is a STATIC, source-text check (the fleet-nudger-no-direct-pane-write.test.ts /
// context-compact-monitor-no-direct-pane-write.test.ts pattern), not a runtime one: the
// property is about what code EXISTS, not about a particular call's behavior, and a future
// caller must fail this check the moment the bypass is written, not only when it happens to
// be exercised by some other test's fixture.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')

// The four callers Cybered named as consulting isSessionReadyForPrompt for a delivery
// decision. Not every isSessionReadyForPrompt call site qualifies (a read-only status probe,
// e.g. for a dashboard indicator, never sends anything and is out of scope) -- these four
// specifically gate an actual prompt injection on the result.
const CALLERS = ['message-router.ts', 'schedule-runner.ts', 'inbox-nudge-watcher.ts', 'telegram-inbox-wake.ts']

/** Strips `//` and `/* * /`-style comment lines so a mention IN PROSE (this file's own header,
 * a commit message quoted in a code comment) never counts as the executable property. Line-based
 * and deliberately simple, matching the existing no-direct-pane-write tests' own techniques --
 * this repo's source does not use multi-line block comments for the patterns under test here. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join('\n')
}

describe('every isSessionReadyForPrompt caller routes its actual send through sendPromptToSession (Cybered, card bd4b74a3)', () => {
  for (const file of CALLERS) {
    const path = join(WEB_DIR, file)
    const src = readFileSync(path, 'utf-8')
    const code = codeOnly(src)

    it(`${file}: actually consults isSessionReadyForPrompt (sanity -- this file is in scope)`, () => {
      expect(code).toMatch(/\bisSessionReadyForPrompt\s*\(/)
    })

    it(`${file}: imports sendPromptToSession from agent-process.js`, () => {
      const importBlock = code.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/agent-process\.js['"]/)
      expect(importBlock, `${file} has no import from './agent-process.js' carrying sendPromptToSession`).not.toBeNull()
      expect(importBlock![1]).toMatch(/\bsendPromptToSession\b/)
    })

    it(`${file}: actually CALLS sendPromptToSession -- imported but unused would not protect anything`, () => {
      expect(code).toMatch(/\bsendPromptToSession\s*\(/)
    })

    it(`${file}: never writes into a pane directly -- no bypass of sendPromptToSession's preflight`, () => {
      expect(
        code,
        `${file} sends tmux keystrokes directly -- this bypasses dismissFeedbackDraftModalIfPresent's ` +
          'unconditional preflight inside sendPromptToSession, reopening the modal/notice misclassification risk',
      ).not.toMatch(/tmux[^\n]*send[-\s]keys/i)
      expect(code).not.toMatch(/execFileSync\(\s*['"]tmux['"]/)
      expect(code).not.toMatch(/spawn\(\s*['"]tmux['"]/)
    })
  }
})

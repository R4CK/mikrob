import { describe, it, expect } from 'vitest'
import { detectPaneState, detectBackgroundAgents, isReadyForPrompt, detectsPermissionDialog, detectsHeldPeerMessage } from '../pane-state.js'

// Background (sub-)agents render as a block BELOW the idle footer: a blank row,
// a `⏺ main` row for the session's own thread, then one `◯ <type>  <label>
// <elapsed> · ↓ <n> tokens` row per agent. Every shape below is a real
// `tmux capture-pane -p` tail from a fleet session (2026-10-16, Claude Code
// 2.1.301) with the agent name, task labels and token counts replaced by
// neutral ones; the glyphs, separators and column layout are the captured bytes.
//
// Two misreads came from this block, both measured on the live capture:
//   - main thread at turn start, footer clipped to `· e…` (the `esc to
//     interrupt` segment) by the longer subagent hint: the clipped footer was no
//     longer the LAST line, so the pane read 'unknown' (orange "ismeretlen").
//   - main thread mid-turn with several agents: the rows pushed the spinner and
//     the `esc to interrupt` footer out of the bottom live windows, so a running
//     turn read 'idle'.

const SEP = '─'.repeat(80)
const NAME_BAR = '─'.repeat(67) + ' AgentOne ─'

const row = (label: string, elapsed: string, tokens: string) =>
  `  ◯ general-purpose  ${label} ${elapsed} · ↓ ${tokens} tokens`

const ROWS = [
  row('Reviewing the first result fi…', '17m 23s', '171.9k'),
  row('Verifying the second checkout…', '16m 30s', '319.7k'),
]

// Main thread idle, waiting for its two agents.
const IDLE_WITH_AGENTS = [
  '  The first and second checks are still running.',
  '',
  '✻ Waiting for 2 background agents to finish',
  '',
  NAME_BAR,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · ↓ to manage',
  '',
  '  ⏺ main',
  ...ROWS,
].join('\n')

// Main thread starting a turn: spinner without a token counter yet, and the
// footer clipped mid-`esc to interrupt`.
const TURN_START_WITH_AGENTS = [
  '✻ Waiting for 2 background agents to finish',
  '',
  '⏺ Agent "first check" finished · 17m 23s',
  '',
  '✢ Mulling… (21s)',
  '',
  NAME_BAR,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · /tasks to see subagents · e…',
  '',
  '  ⏺ main',
  ROWS[0],
].join('\n')

// Main thread mid-turn (token counter live) with five agents below the footer.
const BUSY_WITH_FIVE_AGENTS = [
  '⏺ Running 1 shell command…',
  '',
  '✽ Mulling… (1m 52s · ↓ 7.9k tokens)',
  '  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude\'s',
  '     current work',
  '',
  NAME_BAR,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 2 shells · esc to interrupt · ↓ to manage',
  '',
  '  ⏺ main',
  row('Task one                      ', '6m 30s', '26.0k'),
  row('Task two                      ', '6m 28s', '31.2k'),
  row('Task three                    ', '6m 25s', '12.4k'),
  row('Task four                     ', '6m 21s', '8.8k'),
  row('Task five                     ', '6m 19s', '40.1k'),
].join('\n')

// RedHat N1 (card 0499d1f4, comment 24984 on 4f5e43e6): splitBackgroundAgentBlock cuts
// EVERYTHING from a spoofed `⏺ main` header downward, as long as the nearest non-blank line
// above it merely LOOKS like a footer (FOOTER_LEAD_RX) -- it never checks that the rows below
// the header are genuine `◯` agent rows (the stricter condition detectBackgroundAgents already
// applies). Tool output can echo exactly such a header (a footer-lead phrase + `⏺ main` + junk)
// earlier in the pane; the backward scan for the LAST `⏺ main` then finds THIS spoofed one
// (there is no later one), and detectPaneState discards everything below it -- including the
// REAL live busy footer and spinner that come after it, further down (more recent) in the pane.
// Measured (RedHat): old tree reads busy, the pinned tree reads idle.
const SPOOFED_HEADER_IN_TOOL_OUTPUT = [
  '  Tool output echoed this status line for a report:',
  '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
  '  ⏺ main',
  '  this row is not a real ◯ agent row -- just more echoed text',
]

// A genuinely busy pane (real spinner, real `esc to interrupt` footer at the very bottom) with
// the spoofed header sitting ABOVE it, inside what would be ordinary scrollback/tool output.
const BUSY_WITH_SPOOFED_HEADER_ABOVE = [
  ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
  '',
  '⏺ Running 1 shell command…',
  '',
  '✽ Mulling… (1m 52s · ↓ 7.9k tokens)',
  '',
  NAME_BAR,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 2 shells · esc to interrupt · ↓ to manage',
].join('\n')

describe('background-agent block below the footer', () => {
  it('N1 (RedHat 24984): a spoofed header in tool output above the real footer must not hide a busy pane', () => {
    expect(detectPaneState(BUSY_WITH_SPOOFED_HEADER_ABOVE)).toBe('busy')
  })

  it('N1 control: the same spoofed header with a genuinely idle pane below it still reads idle', () => {
    const idlePane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      NAME_BAR,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
    ].join('\n')
    expect(detectPaneState(idlePane)).toBe('idle')
  })

  // RedHat NO-GO 30564, F1: the real footer right next to a live spinner can itself be clipped
  // by tmux's width cut before ever reaching the literal `on`. These three used to read idle
  // (behind a spoofed header) because the clipped text never matched the old guard-key regex --
  // not because the spoofed header hid them per se, but because the override that stops the cut
  // never fired, so the cut discarded the spinner right along with the clipped footer.
  it('F1a (30564): a spoofed header with a real footer clipped before reaching `on` still reads busy', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      '✽ Mulling… (1m 52s · ↓ 7.9k tokens)',
      '',
      NAME_BAR,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissi…',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('busy')
  })

  it('F1b (30564): a spoofed header with a real footer clipped mid shift+tab hint still reads busy', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      '✽ Mulling… (1m 52s · ↓ 7.9k tokens)',
      '',
      NAME_BAR,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+t…',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('busy')
  })

  it('F1c (30564): a spoofed header with a bare `esc to interrupt` footer (no `on` prefix) still reads busy', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      NAME_BAR,
      '❯ ',
      SEP,
      '  esc to interrupt',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('busy')
  })

  // RedHat NO-GO 30564, F2: the opposite direction -- a genuinely mechanical trailing block
  // (real agent rows plus an ordinary wrapped label continuation ending in the bare word "on")
  // used to wrongly SKIP the cut, which let the kept rows push the real footer/spinner (sitting
  // right above the header) out of the live tail window. Same corpus as the existing
  // BUSY_WITH_FIVE_AGENTS case, just with one more row.
  it('F2 (30564): a wrapped label continuation ending in "depends on" does not fool the cut into skipping', () => {
    const pane = BUSY_WITH_FIVE_AGENTS + '\n     the retry logic depends on'
    expect(detectPaneState(pane)).toBe('busy')
  })

  // QA FAIL 30874 on the F1/F2 fix above, same two directions, different trigger.
  it('QA1 (30874): a spoofed header with a footer clipped mid "esc to interrupt" and NO nearby spinner still reads busy', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      NAME_BAR,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on · 1 shell · esc to int…',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('busy')
  })

  it('QA2 (30874): a wrapped continuation mentioning "ctrl+t" mid-sentence does not fool the cut into skipping', () => {
    const pane = BUSY_WITH_FIVE_AGENTS + '\n     the shortcut documented here relies on · press ctrl+t to jump'
    expect(detectPaneState(pane)).toBe('busy')
  })

  // CYBERED GO 8b8bc092 residuals, folded into this round per MikroB dispatch 18375.
  it('RedHat-B(i) (8b8bc092): a footer clipped to "· e…" with only ONE separator and no spinner still reads busy', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      NAME_BAR,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on · e…',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('busy')
  })

  it('RedHat-B(iii) (8b8bc092): a paste placeholder with a shell-tail footer behind the spoof still reads busy', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      NAME_BAR,
      '❯ [Pasted text #1 +812 chars]',
      SEP,
      '  ⏵⏵ bypass permissions on · 1 shell',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('busy')
  })

  // 8 rows, the quoted label FIRST (outside the 5-line footer window and clear of the 12-line
  // busy window's own content), so only the override's own row-scan can rescue this -- a shorter
  // block risks the windowed esc-to-interrupt/spinner checks further down masking the regression
  // by accident (measured: a 5-row variant with the label inside the last 5 lines read busy even
  // without this fix, because BUSY_ESC_TO_INTERRUPT_RX is also checked unscoped against the last
  // LIVE_FOOTER_REGION_LINES lines independently of the cut).
  it('RedHat-C (8b8bc092) regression: a genuine agent label quoting "esc to interrupt" must not skip the cut', () => {
    const pane = [
      '⏺ Running 1 shell command…',
      '',
      '✽ Mulling… (1m 52s · ↓ 7.9k tokens)',
      '',
      NAME_BAR,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on · 2 shells · esc to interrupt · ↓ to manage',
      '',
      '  ⏺ main',
      row('Watching for the esc to interrupt phrase in captures', '6m 28s', '31.2k'),
      row('Task two                      ', '6m 27s', '28.0k'),
      row('Task three                    ', '6m 25s', '12.4k'),
      row('Task four                     ', '6m 21s', '8.8k'),
      row('Task five                     ', '6m 19s', '40.1k'),
      row('Task six                      ', '6m 15s', '11.1k'),
      row('Task seven                    ', '6m 10s', '9.9k'),
      row('Task eight                    ', '6m 05s', '7.7k'),
    ].join('\n')
    expect(detectPaneState(pane)).toBe('busy')
  })

  it('idle main thread with running agents reads idle, and the agents are counted', () => {
    expect(detectPaneState(IDLE_WITH_AGENTS)).toBe('idle')
    expect(detectBackgroundAgents(IDLE_WITH_AGENTS)).toEqual({ total: 2, running: 2, queued: 0 })
  })

  it('main thread at turn start with a clipped `esc to interrupt` reads busy, not unknown', () => {
    expect(detectPaneState(TURN_START_WITH_AGENTS)).toBe('busy')
    expect(isReadyForPrompt(TURN_START_WITH_AGENTS)).toBe(false)
    expect(detectBackgroundAgents(TURN_START_WITH_AGENTS)).toEqual({ total: 1, running: 1, queued: 0 })
  })

  it('main thread mid-turn with five agents reads busy, not idle', () => {
    expect(detectPaneState(BUSY_WITH_FIVE_AGENTS)).toBe('busy')
    expect(isReadyForPrompt(BUSY_WITH_FIVE_AGENTS)).toBe(false)
    expect(detectBackgroundAgents(BUSY_WITH_FIVE_AGENTS)).toEqual({ total: 5, running: 5, queued: 0 })
  })

  it('reads the same with blank rows below the block', () => {
    expect(detectPaneState(IDLE_WITH_AGENTS + '\n\n\n')).toBe('idle')
    expect(detectBackgroundAgents(IDLE_WITH_AGENTS + '\n\n\n')).toEqual({ total: 2, running: 2, queued: 0 })
  })

  it('a row without the elapsed/token tail is counted in total but not as running', () => {
    const pane = IDLE_WITH_AGENTS + '\n  ◯ general-purpose  Some other task'
    expect(detectBackgroundAgents(pane)).toEqual({ total: 3, running: 2, queued: 0 })
  })

  it('a just-started agent (elapsed time, no token count yet) counts as running', () => {
    const pane = IDLE_WITH_AGENTS + '\n  ◯ Explore  Find the callers                                  1s'
    expect(detectBackgroundAgents(pane)).toEqual({ total: 3, running: 3, queued: 0 })
  })

  // The row tail is `[elapsed, tokens, "N queued"]` joined with ` · ` (Claude
  // Code 2.1.301 source). The owner saw `1 queued` at the end of a row on the
  // card that read orange "ismeretlen".
  it('a row ending in `· N queued` is still running, and the queued messages are summed', () => {
    const pane = IDLE_WITH_AGENTS.replace(ROWS[1], ROWS[1] + ' · 2 queued') + '\n' + ROWS[0] + ' · 1 queued'
    expect(detectBackgroundAgents(pane)).toEqual({ total: 3, running: 3, queued: 3 })
    expect(detectPaneState(pane)).toBe('idle')
  })

  it('the turn-start shape with a queued row reads busy, not unknown', () => {
    expect(detectPaneState(TURN_START_WITH_AGENTS + ' · 1 queued')).toBe('busy')
  })

  it('an idle agent (`waiting` instead of a clock) is not counted as running', () => {
    const pane = IDLE_WITH_AGENTS + '\n  ◯ general-purpose  Parked task waiting · 1 queued'
    expect(detectBackgroundAgents(pane)).toEqual({ total: 3, running: 2, queued: 1 })
  })

  it('no block -> null (plain idle footer, shells only)', () => {
    const pane = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · 2 shells · ↓ to manage'].join('\n')
    expect(detectBackgroundAgents(pane)).toBeNull()
    expect(detectPaneState(pane)).toBe('idle')
  })

  it('an unknown row shape under `⏺ main` is not counted: nothing is invented', () => {
    const pane = IDLE_WITH_AGENTS + '\n  ✔ general-purpose  Done task 3m 2s · ↓ 1.0k tokens'
    expect(detectBackgroundAgents(pane)).toBeNull()
    expect(detectPaneState(pane)).toBe('idle')
  })

  it('an unknown row (a wrapped label) under a busy footer still reads busy', () => {
    const pane = BUSY_WITH_FIVE_AGENTS + '\n     continuation of a wrapped label'
    expect(detectPaneState(pane)).toBe('busy')
    expect(detectBackgroundAgents(pane)).toBeNull()
  })

  it('a `⏺ main` line that does not sit under the footer is not a block', () => {
    const pane = ['  some reply text', '  ⏺ main', ROWS[0], '', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · ↓ to manage'].join('\n')
    expect(detectBackgroundAgents(pane)).toBeNull()
    expect(detectPaneState(pane)).toBe('idle')
  })

  it('a million-token row counts as running', () => {
    const pane = IDLE_WITH_AGENTS + '\n' + row('Long task', '40m 2s', '1.2M')
    expect(detectBackgroundAgents(pane)).toEqual({ total: 3, running: 3, queued: 0 })
  })

  it('agent rows without the `⏺ main` header are not a block', () => {
    const pane = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · ↓ to manage', ROWS[0]].join('\n')
    expect(detectBackgroundAgents(pane)).toBeNull()
  })

  it('a block quoted in the scrollback (not at the bottom) does not count', () => {
    const pane = [
      '  ⏺ main',
      ROWS[0],
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on · ↓ to manage',
    ].join('\n')
    expect(detectBackgroundAgents(pane)).toBeNull()
  })

  it('a clipped footer that is not an `esc to interrupt` prefix stays idle', () => {
    const pane = IDLE_WITH_AGENTS.replace(
      '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · ↓ to manage',
      '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · /tasks to see subagents · ↓ to man…',
    )
    expect(detectPaneState(pane)).toBe('idle')
  })

  // RedHat round-3 residual 1 (8b8bc092, comment 31136 on 07df3f995): a wrapped label
  // continuation behind a spoofed header coincidentally matches BUSY_ESC_CLIPPED_RX (ends
  // "on · e…", which also happens to satisfy FOOTER_LEAD_RX, so only the indent check in
  // rowCarriesLiveSignal -- not the FOOTER_LEAD_RX gate below -- can reject it), wrongly
  // blocking the cut that should discard this stale/spoofed trailing block.
  it('RedHat round-3 residual: a wrapped continuation coincidentally matching a clipped busy footer must not block the cut', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      NAME_BAR,
      '❯ ',
      SEP,
      '     the retry logic depends on · e…',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('idle')
  })

  // RedHat round-3 residual 2 (8b8bc092, comment 31136): BUSY_ESC_CLIPPED_RX alone matches any
  // prose ending "· e…", even idle text with no mode-word lead at all ("see the docs · e…").
  it('RedHat round-3 residual: an idle pane whose last line merely ends "· e…" with no mode-word lead stays idle', () => {
    const pane = [
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
      '  see the docs · e…',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('idle')
  })

  // QA1 (card 8b8bc092, comment 31261, FAIL on the round-3 fix): the FOOTER_LEAD_RX gate was
  // unanchored, so idle prose that happens to contain a "<word> on ·" shape anywhere in a
  // sentence -- not just as the line's own chrome -- still read busy.
  it('QA1: idle prose containing "...on ·" deep in a sentence stays idle, not busy', () => {
    const pane = [
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
      '  you can toggle it by typing turn it on · e…',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('idle')
  })

  // QA2/QA3 (card 8b8bc092, comment 31261): the indent cutoff (ROW_SIGNAL_MAX_INDENT=3) is a
  // margin tuned to RedHat's own fixture (indent 5), not a structural guarantee -- the exact
  // same coincidentally-matching text at indent 2 or 3 is still inside the cutoff and still
  // tripped the (ungated) BUSY_ESC_CLIPPED_RX check in rowCarriesLiveSignal.
  //
  // This spoofed lead deliberately matches FOOTER_LEAD_RX (so splitBackgroundAgentBlock still
  // treats it as a header-lead candidate) but NOT the full IDLE_FOOTER_RX, and a harmless
  // trailing row follows the continuation: this isolates the test to the row-level cut decision
  // alone (confirmed by mutation: forcing the cut to never fire turns this 'unknown', not
  // coincidentally 'idle' via the separate lastLine gate or via the lead line itself being
  // picked up as a stray real footer).
  it('QA2/QA3: the same coincidental continuation at indent 2 or 3 must not block the cut either', () => {
    const LEAD_NOT_FULL_FOOTER = [
      '  Tool output echoed this status line for a report:',
      '  bypass permissions on · 1 shell',
      '  ⏺ main',
      '  this row is not a real ◯ agent row -- just more echoed text',
    ]
    const atIndent = (n: number) => [
      ...LEAD_NOT_FULL_FOOTER,
      '',
      NAME_BAR,
      '❯ ',
      SEP,
      // Koteg 26 (upstream #2177, COMMATAIL1022): FOOTER_SHELL_TAIL_RX is now anchored to the
      // genuine glyph lead (⏵⏵/⏵/⏸), so the echoed `bypass permissions on · 1 shell` line in
      // LEAD_NOT_FULL_FOOTER above (deliberately glyph-less, to prove it is quoted text, not
      // chrome) no longer coincidentally counts as a real footer either -- a real one is needed
      // here, same as the other fixtures in this file, so the test still isolates what it says
      // it isolates: the row-level cut decision on the continuation line below, not whether a
      // footer exists at all.
      '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
      `${' '.repeat(n)}the retry logic depends on · e…`,
      '  a harmless trailing row that is not a footer or a clip',
    ].join('\n')
    expect(detectPaneState(atIndent(2))).toBe('idle')
    expect(detectPaneState(atIndent(3))).toBe('idle')
  })

  // RedHat LOW (card 8b8bc092, comment 31259, folded in per MikroB 31260): a clipped busy
  // footer with no mode word at all (default permission mode) must still read busy -- the
  // mode-lead requirement cannot be the ONLY accepted shape.
  it('RedHat LOW: a mode-less clipped busy footer (default mode, no "on" word) still reads busy', () => {
    const pane = [
      SEP,
      '❯ ',
      SEP,
      '  1 shell, 1 monitor · /tasks to see subagents · e…',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('busy')
  })
})

// RedHat class A (card 8e9828c9): idleFooterIndex picked the FIRST (oldest) matching line
// in the whole pane, not the most recent one. A footer-lead line echoed earlier (e.g. inside
// a spoofed background-agent block, SPOOFED_HEADER_IN_TOOL_OUTPUT) is OLDER -- a smaller array
// index -- than the real, current footer further down, and the forward scan locked onto it,
// corrupting everything downstream that anchors on footerIdx: the typing-box scan, the queued-
// messages hint check, and (via the raw IDLE_FOOTER_RX.test(pane) bypass) detectsPermissionDialog
// and detectsHeldPeerMessage. Fix: idleFooterIndex scans from the bottom (last match wins, the
// same pattern detectsThinkingBlockError already used), and the two raw-test call sites were
// migrated to hasIdleFooter() behind the same background-agent-block cut detectPaneState applies.
describe('class A: typing/queued/dialog behind a spoofed background-agent block (idleFooterIndex most-recent-match)', () => {
  it('a parked (typed but unsubmitted) input reads typing, not idle, behind a spoofed footer-lead line', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      SEP,
      '❯ finish the review',
      SEP,
      '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('typing')
  })

  it('a queued-messages hint reads busy, not idle, behind a spoofed footer-lead line', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      SEP,
      '❯ Press up to edit queued messages',
      SEP,
      '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('busy')
  })

  it('a real permission dialog is still detected behind a stale idle-footer line quoted in scrollback', () => {
    const pane = [
      '  ⏎  Earlier tool output quoted this status line for a report:',
      '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
      '',
      '',
      '',
      '─'.repeat(120),
      ' Bash command',
      '',
      '   cat /etc/hostname',
      '   Show system hostname',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, allow reading from /etc from this project',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
      '',
    ].join('\n')
    expect(detectsPermissionDialog(pane)).toBe(true)
  })
})

// RedHat NO-GO (card 8e9828c9, comment 31373): the first round fixed the WHOLE-PANE
// most-recent-match problem but missed 3 shapes. Red on the fix round-1 sha
// (947588391), green on the fix round-2 sha below.
describe('class A round 2: dialog-hidden-by-cut, shell-tail/trailing-hint footer, region-bound false positive', () => {
  // F1: splitBackgroundAgentBlock finds the LAST `⏺ main` header by POSITION and
  // treats everything below it (to pane end) as "rows" to cut when none of those
  // rows carry a live signal -- a real dialog has no elapsed/spinner signal of its
  // own, so a spoofed header positioned ABOVE it (not just above a trailing block)
  // discarded the whole dialog, not just the spoof.
  it('a real permission dialog below a spoofed background-agent header is still detected (F1)', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      '─'.repeat(120),
      ' Bash command',
      '',
      '   cat /etc/hostname',
      '   Show system hostname',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, allow reading from /etc from this project',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
      '',
    ].join('\n')
    expect(detectsPermissionDialog(pane)).toBe(true)
  })

  it('the held-peer dialog below the same spoofed header is still detected (F1)', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      '─'.repeat(120),
      ' Held message from another session',
      '',
      ' Press Enter to review',
      '',
    ].join('\n')
    expect(detectsHeldPeerMessage(pane)).toBe(true)
  })

  // F2a: the real (bottommost) footer in the shell-tail form (FOOTER_SHELL_TAIL_RX,
  // no IDLE_FOOTER_RX tail) used to lose to an EARLIER IDLE_FOOTER_RX match (the
  // spoof's own footer-lead line) because idleFooterIndex scanned for IDLE_FOOTER_RX
  // across the whole pane before ever checking what the true last line looked like.
  it('typed input reads typing, not idle, behind the spoof when the real footer is the shell-tail form (F2a)', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      SEP,
      '❯ finish the review',
      SEP,
      '  ⏵⏵ bypass permissions on · 1 shell',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('typing')
  })

  it('a queued-messages hint reads busy, not idle, behind the spoof when the real footer is the shell-tail form (F2a)', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      SEP,
      '❯ Press up to edit queued messages',
      SEP,
      '  ⏵⏵ bypass permissions on · 1 shell',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('busy')
  })

  // F2b: a real footer combining the shift+tab parenthetical AND a `·`-separated
  // tail (`... on (shift+tab to cycle) · ctrl+t to hide tasks`) matched neither
  // IDLE_FOOTER_RX alternative, so rowCarriesLiveSignal rejected the row, and
  // behind a spoofed header positioned above it, the cut discarded the real
  // typing box along with the spoof.
  it('typed input reads typing, not idle, behind the spoof when the real footer combines the parenthetical and a trailing hint (F2b)', () => {
    const pane = [
      ...SPOOFED_HEADER_IN_TOOL_OUTPUT,
      '',
      SEP,
      '❯ finish the review',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ctrl+t to hide tasks',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('typing')
  })

  // F4: a NEW false positive from the round-1 fix. hasIdleFooterNear bounded its
  // search to BUSY_LIVE_REGION_LINES (12), tuned for the busy-indicator scan, not
  // for how far a genuine footer can sit from the true bottom. Trailing chrome
  // after the footer (a wrapped banner) pushed it past that window, so a stale
  // dialog quoted above a REAL, genuinely idle footer was wrongly flagged as a
  // live dialog.
  it('a stale dialog quoted above a real idle footer is not a dialog, even with 30 lines of chrome trailing the footer (F4, RedHat repro)', () => {
    const pane = [
      ' Bash command',
      '',
      '   cat /etc/hostname',
      '   Show system hostname',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, allow reading from /etc from this project',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
      '',
      '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
      ...Array.from({ length: 30 }, (_, i) => `  wrapped session-title banner line ${i}`),
    ].join('\n')
    expect(detectsPermissionDialog(pane)).toBe(false)
  })
})

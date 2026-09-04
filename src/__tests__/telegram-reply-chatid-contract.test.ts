// Card 0264b294. MikroB's Telegram reply failed with `chat 0 is not allowlisted`, and the card's
// hypothesis was that a session-level `0` -> real-chat-id binding existed and the update.sh
// service-restart lost it.
//
// There is no such binding, and there never was. The plugin's assertAllowedChat() is
// unconditional -- anything outside `allowFrom`/`groups` throws -- and `git log -S` over the
// upstream history finds no commit that ever introduced a `0` branch. So `chat_id: 0` is not a
// convention that broke; it is a recipe that names a behaviour this install does not have. Same
// class as the endpoint I once shipped that the fork did not implement: the fix is to RUN the
// recipe against the live install, not to trust that it reads correctly.
//
// 23 scheduled tasks already address Peti by his real id and work. 5 said `0` and silently failed.
// This test pins the aligned state so the fiction cannot creep back, and -- the second half --
// guards the fork-local plugin feature that the SAME CLAUDE.md recipe depends on.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const REPO_ROOT = join(import.meta.dirname, '..', '..')

// The chat id every working call site uses. Kept as a pattern, not a literal, so this test does
// not itself become the 29th place hardcoding it -- it asserts "a real numeric id", not "this id".
const REAL_ID_RX = /chat_id[\s"'`:=]*\d{6,}/

/**
 * Does this line INSTRUCT an agent to pass 0 as the chat id?
 *
 * The discriminator matters more than it looks. After the fix, the corrected prose still contains
 * the string `chat_id: 0` -- in sentences saying it does NOT work. A naive substring scan would
 * fail the very card that fixed the problem, which is exactly the trap a docs-corpus guard set for
 * me once before. So: find `chat_id` bound to a bare 0, then drop lines carrying a negation.
 */
export function instructsChatIdZero(line: string): boolean {
  if (!/chat_id[\s"'`:=(]*0(?![0-9])/.test(line)) return false
  // A line that says the 0 is wrong is documentation, not an instruction.
  //
  // The negation markers must be PHRASES, not the bare word "nem". My first version tested for
  // /\bNEM\b/ on the whole line, and it silently swallowed the real instruction in
  // quota-limit-monitor -- "(reply tool, chat_id 0), ha a NEW: sor NEM ures" -- where the "NEM"
  // negates something else entirely. The mutation that should have caught the regression did not
  // bite, which is how the hole surfaced. Both halves below are taken from the ACTUAL corpus
  // rather than invented, because that is precisely the mistake that produced the hole.
  //
  // Deliberate trade-off: a line that both instructs 0 AND happens to contain "HIBÁS" reads as a
  // warning and is missed. That costs a false negative in a guard, never a false alarm on correct
  // prose -- the safe direction here, since the loud failure mode is what makes people ignore it.
  return /NEM a 0|SEHOL nem működik|nem működik|HIBÁS|téves|does not work|doesn't work/.test(line)
    ? false
    : true
}

describe('the `chat_id: 0` recipe is gone from everything the fleet reads', () => {
  // --- the discriminator itself, proven rather than assumed --------------------------------
  it('recognises the instruction shapes that actually shipped', () => {
    // Every one of these is a VERBATIM line that shipped and silently failed -- not a line I
    // imagined a guard ought to catch.
    for (const line of [
      '   reply(chat_id="0", text="Egy sub-ágenshez ismeretlen, NEM párosított sender [ID] írt")',
      '4. Telegram küldés: a reply tool-lal (chat_id: 0)',
      'CSAK akkor irj Telegramra (reply chat_id 0), ha a kimenetben CHANGED=1',
      'Küldj EGY rövid üzenetet (reply tool, `chat_id: 0`), ebben a formában:',
      'kuldj rovid Telegram uzenetet Petinek (reply tool, chat_id 0, MarkdownV2)',
      // THE ONE THAT GOT PAST THE FIRST VERSION. Its "NEM ures" negates the NEW: line, not the
      // chat id, so a whole-line "contains nem" filter read a live instruction as a warning.
      'CSAK akkor irj Telegramra (reply tool, chat_id 0), ha a NEW: sor NEM ures',
      // ...and the pairing escalation, whose "NEM párosított" is the same trap in the other file.
      'Telegram-plugin csak, `chat_id` `0`): NE találj ki identitást, NEM párosított sender',
    ]) {
      expect(instructsChatIdZero(line), line).toBe(true)
    }
  })

  it('does NOT fire on prose that warns the 0 is wrong', () => {
    for (const line of [
      '- `chat_id=0` a Bot API-nak HIBÁS ("chat not found"). Mindig a valós ID kell.',
      'A `chat_id: 0` SEHOL nem működik: sem a nyers Bot API-nál, sem az MCP `reply` tool-nál.',
      'chat_id: a valós chat ID az allowlistából, NEM a 0.',
    ]) {
      expect(instructsChatIdZero(line), line).toBe(false)
    }
  })

  // --- repo-owned facts: these hold on any checkout, no environment needed -----------------
  it('the root CLAUDE.md no longer tells anyone to pass 0', () => {
    const md = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf-8')
    const bad = md.split('\n').filter(instructsChatIdZero)
    expect(bad, `CLAUDE.md still instructs chat_id 0:\n${bad.join('\n')}`).toEqual([])
  })

  it('the CLAUDE.md Telegram recipes name a real numeric chat id instead', () => {
    const md = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf-8')
    // Both call sites the card touched: the unknown-sender pairing escalation and the morning
    // kick-off. If someone reverts either to 0, this fails alongside the check above.
    expect(md).toMatch(/reply\(chat_id="\d{6,}"/)
    expect(md).toMatch(/reply tool-lal \(chat_id: \d{6,}/)
  })

  it('the seeded telegram-reply-fallback skill states plainly that 0 never works', () => {
    const p = join(REPO_ROOT, 'seed-skills', 'telegram-reply-fallback', 'SKILL.md')
    const s = readFileSync(p, 'utf-8')
    // It used to assert the OPPOSITE -- that 0 was the reply tool's internal convention for the
    // main channel. A skill that confidently documents a behaviour nobody implemented is worse
    // than one that says nothing, because it stops the reader from checking.
    expect(s).toContain('SEHOL nem működik')
    expect(s.split('\n').filter(instructsChatIdZero)).toEqual([])
  })
})

// -------------------------------------------------------------------------------------------
// The live install. Absent environment => explicit skip with a reason; present-but-wrong => fail.
// A diagnostic that quietly passes when it could not look is not a diagnostic.
// -------------------------------------------------------------------------------------------
const TASKS_DIR = join(homedir(), '.claude', 'scheduled-tasks')

describe('the live scheduled tasks address Peti by a real chat id', () => {
  const present = existsSync(TASKS_DIR)

  it.skipIf(!present)('no scheduled task instructs chat_id 0', () => {
    const offenders: string[] = []
    for (const dir of readdirSync(TASKS_DIR)) {
      const f = join(TASKS_DIR, dir, 'SKILL.md')
      if (!existsSync(f)) continue
      for (const line of readFileSync(f, 'utf-8').split('\n')) {
        if (instructsChatIdZero(line)) offenders.push(`${dir}: ${line.trim().slice(0, 120)}`)
      }
    }
    expect(offenders, `scheduled tasks still instructing chat_id 0:\n${offenders.join('\n')}`)
      .toEqual([])
  })

  it('reports whether it could actually look', () => {
    // Deliberately not skipped: if the tasks directory is missing, the check above proved
    // nothing, and that fact should be visible in the run rather than inferred from a green tick.
    expect(typeof present).toBe('boolean')
    if (!present) console.warn(`[telegram-chatid] ${TASKS_DIR} absent -- live task check did not run`)
  })
})

// -------------------------------------------------------------------------------------------
// The armed landmine next door. The SAME CLAUDE.md recipe this card fixed also depends on the
// reply tool's `buttons` parameter -- a fork-local edit made 2026-08-16 for Peti's tappable
// approve/deny pairing flow.
//
// That edit was made directly in the marketplace checkout, which is a git repo tracking upstream,
// and was never committed. An upstream pull on 2026-09-01 discarded it: the marketplace source
// and the 0.0.7 cache are now byte-identical pure upstream, with no `buttons`. It still works
// today only because the project-scope install is pinned to the 0.0.6 cache directory, which
// survived. One plugin update and the mandated pairing flow loses its buttons silently.
//
// Restoring it means editing the plugin and restarting MikroB's own channel, which is not mine to
// do -- so this test does not fix it. It makes it impossible to lose QUIETLY.
// -------------------------------------------------------------------------------------------
describe('the live Telegram plugin still carries the fork-local features CLAUDE.md relies on', () => {
  function liveServerPath(): string | null {
    const reg = join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
    if (!existsSync(reg)) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(reg, 'utf-8'))
    } catch {
      return null
    }
    const entries = (parsed as { plugins?: Record<string, { scope?: string; projectPath?: string; installPath?: string }[]> })
      ?.plugins?.['telegram@claude-plugins-official']
    if (!Array.isArray(entries)) return null
    // The copy the running fleet loads is the PROJECT-scope one for this repo -- not whichever
    // version number happens to be highest. Reading the registry beats guessing a path.
    const proj = entries.find(e => e?.scope === 'project' && typeof e.installPath === 'string')
    if (!proj?.installPath) return null
    const p = join(proj.installPath, 'server.ts')
    return existsSync(p) ? p : null
  }

  const live = liveServerPath()

  it.skipIf(!live)('the reply tool still accepts a `buttons` parameter', () => {
    const src = readFileSync(live as string, 'utf-8')
    // Not a bare substring: `buttons` appears in an upstream comment about the permission-request
    // keyboard even in the unpatched file, so matching that would make this test always pass.
    // These two are the fork edit itself.
    expect(src, 'the fork-local `buttons` param is gone from the live plugin copy')
      .toMatch(/const buttons = \(args\.buttons/)
    expect(src).toMatch(/buttons\.reduce\(/)
  })

  it('reports whether it could actually look', () => {
    if (!live) console.warn('[telegram-plugin] project-scope install path not resolvable -- fork-feature check did not run')
    expect(live === null || typeof live === 'string').toBe(true)
  })
})

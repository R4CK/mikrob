// kanban-snapshot.sh must not lose its owner-only guarantee (card 90e4cbdf).
//
// WHAT WAS WRONG. The script had neither `umask` nor `chmod`, and wrote two private files: the
// rendered board (KANBAN-SNAPSHOT.md -- every card title and fresh comments) and the transient
// .kanban-snapshot-cards.json.tmp (the FULL /api/kanban dump). Both read 600 on disk, which is why
// nothing noticed: a `>` redirect PRESERVES the mode of a file that already exists, and these had
// first been created by a hand-run under the fleet's 0077 umask. Delete either and let the
// 15-minute OS cron recreate it -- cron runs umask 022 and the new file is silently 644.
//
// MEASURED END-TO-END, not argued (2026-09-11, against the live dashboard, clean slate, umask 022):
//   unfixed script -> KANBAN-SNAPSHOT.md at 644   (run in a 0700 sandbox, nothing exposed)
//   fixed script   -> KANBAN-SNAPSHOT.md at 600
// Same conditions both times; only the script differed.
//
// WHAT THIS FILE DOES AND DOES NOT DO, stated rather than implied. It is a TEXT guard: it pins that
// the two mechanisms are still present and still ordered correctly. It deliberately does NOT re-run
// the script, because that needs a live dashboard on a live port, and a unit suite that depends on
// one is a suite that goes red for reasons that have nothing to do with the code. The behavioural
// proof is on the card; this exists so the mechanism cannot be deleted without a test going red.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'kanban-snapshot.sh')
const src = readFileSync(SCRIPT, 'utf8')
const lines = src.split('\n')
const codeLines = lines.map((l) => (l.trim().startsWith('#') ? '' : l))

describe('kanban-snapshot.sh file modes (card 90e4cbdf)', () => {
  it('sets umask 077', () => {
    expect(codeLines.some((l) => /^\s*umask\s+077\s*$/.test(l))).toBe(true)
  })

  it('sets the umask BEFORE the first thing it writes', () => {
    // Order is the whole point: a umask after the first redirect protects nothing that already ran.
    // Matched on comment-stripped lines so the explanatory prose above the umask cannot satisfy it.
    const umaskAt = codeLines.findIndex((l) => /^\s*umask\s+077\s*$/.test(l))
    const firstWriteAt = codeLines.findIndex((l) => /^\s*>\s*"\$STORE/.test(l) || /\s>\s*"\$STORE/.test(l))
    expect(umaskAt, 'no umask 077 outside a comment').toBeGreaterThanOrEqual(0)
    expect(firstWriteAt, 'no redirect into $STORE found -- update this test with the script').toBeGreaterThanOrEqual(0)
    expect(umaskAt).toBeLessThan(firstWriteAt)
  })

  it('forces the mode explicitly on BOTH outputs, not just via the umask', () => {
    // umask governs CREATION only. A pre-existing file with a looser mode, or a future caller that
    // writes either path differently, slips past it -- the same argument db-backup.sh makes.
    const chmods = codeLines.filter((l) => /^\s*chmod\s+600\s/.test(l)).join('\n')
    expect(chmods).toMatch(/\.kanban-snapshot-cards\.json\.tmp/)
    expect(chmods).toMatch(/\$OUT/)
  })

  it('CONTROL: the two files this is about are still the ones the script writes', () => {
    // If the script grows a third output, the assertions above would still pass while covering less
    // than they claim. This fails when the set of written paths changes.
    expect(src).toContain('OUT="$INSTALL_DIR/KANBAN-SNAPSHOT.md"')
    expect(src).toContain('.kanban-snapshot-cards.json.tmp')
  })
})

// The scheduler's own redirect log must not stay group-writable (card 76c3a1fb).
//
// WHAT THIS IS ABOUT, and why card 90e4cbdf did not already cover it. That card gave
// kanban-snapshot.sh and db-backup.sh a `umask 077` plus explicit `chmod 600` on the files THEY
// write. The scheduled entry, though, is `... <script>.sh >> store/<script>-cron.log 2>&1`: that
// file is created by the SHELL THE SCHEDULER SPAWNS, before the script -- and therefore before its
// umask -- exists at all. No umask inside the script can reach it. Cybersec measured both logs at
// 664 on the live box: group-WRITABLE, i.e. every future traceback and curl error from the
// hardened scripts lands in a file outside their hardening, and the logs are not integrity-bound.
//
// THE FIX SHIPPED HERE is the only one available to a repo change: each script tightens the inode
// BY NAME on every run, right after $STORE is defined. The exposure window shrinks from "until
// somebody notices" to "the milliseconds between the redirect creating an empty file and the
// script's first statements". Belt-and-braces would be a `umask 077` on the scheduled line itself;
// that is host state, and an agent session cannot write it (the governance gate refuses), so it is
// reported to MikroB rather than applied here.
//
// WHAT THIS FILE PROVES, and how it avoids being a restatement of the source. It does not merely
// grep for a `chmod`: it EXTRACTS the line each script actually ships and EXECUTES it against a
// sandbox $STORE, so the quoting, the parameter expansion and the `|| true` are all exercised as
// written. Two behaviours per script, because either one alone can be satisfied by a broken line:
// a 664 file must come out 600, and a MISSING file must not make the line fail (a hand-run has no
// redirect, and `set -e` is on in both scripts).
//
// KNOWN LIMIT, stated rather than implied: the schedule itself is host state, invisible to this
// repo. A THIRD scheduled script that never adds such a chmod cannot be discovered from here. The
// last case narrows that as far as the repo allows -- it asserts the set of scripts carrying a
// `-cron.log` reference is exactly the pair below, so a fourth one appearing turns this red and
// forces a decision instead of silently widening the blind spot.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const STORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store')

// The scripts the fleet's scheduler invokes with a `>> store/<name>-cron.log` redirect.
const SCHEDULED = ['db-backup', 'kanban-snapshot'] as const

function codeLines(base: string): string[] {
  // Comment-stripped, so the explanatory prose above each chmod cannot satisfy an assertion about
  // the chmod. Same discipline as kanban-snapshot-file-modes.test.ts.
  return readFileSync(join(STORE_DIR, `${base}.sh`), 'utf8')
    .split('\n')
    .map((l) => (l.trim().startsWith('#') ? '' : l))
}

/** The shipped chmod line for this script, or null. The expected path is DERIVED from the script's
 *  own basename, so the pair cannot drift apart by editing only one of them. */
function shippedChmodLine(base: string): string | null {
  const needle = `chmod 600 "$STORE/${base}-cron.log"`
  return codeLines(base).find((l) => l.includes(needle)) ?? null
}

function modeOf(path: string): string {
  return (statSync(path).mode & 0o777).toString(8).padStart(3, '0')
}

describe('the scheduler redirect log is tightened by the script it belongs to (card 76c3a1fb)', () => {
  for (const base of SCHEDULED) {
    it(`${base}.sh ships a chmod for its OWN -cron.log`, () => {
      expect(
        shippedChmodLine(base),
        `no \`chmod 600 "$STORE/${base}-cron.log"\` outside a comment in ${base}.sh`
      ).not.toBeNull()
    })

    it(`${base}.sh defines $STORE BEFORE that chmod (or it targets /-cron.log)`, () => {
      // Order is load-bearing: with $STORE unset the path collapses to `/db-backup-cron.log`, the
      // chmod fails, `|| true` swallows it, and the real log stays 664 with nothing to show for it.
      const lines = codeLines(base)
      const storeAt = lines.findIndex((l) => /^\s*STORE=/.test(l))
      const chmodAt = lines.findIndex((l) => l.includes(`chmod 600 "$STORE/${base}-cron.log"`))
      expect(storeAt, 'no STORE= assignment outside a comment').toBeGreaterThanOrEqual(0)
      expect(chmodAt).toBeGreaterThan(storeAt)
    })

    it(`${base}.sh's OWN chmod line turns a 664 log into 600 when executed`, () => {
      // The shipped text, run for real -- not a paraphrase of it.
      const line = shippedChmodLine(base)!
      const sandbox = mkdtempSync(join(tmpdir(), 'cron-log-modes-'))
      const log = join(sandbox, `${base}-cron.log`)
      writeFileSync(log, 'a line the scheduler shell already wrote\n')
      chmodSync(log, 0o664)
      expect(modeOf(log), 'the founding condition was not created').toBe('664')

      execFileSync('bash', ['-euo', 'pipefail', '-c', `STORE=${JSON.stringify(sandbox)}\n${line}`])
      expect(modeOf(log)).toBe('600')
    })

    it(`${base}.sh's OWN chmod line does not fail when there is no log (hand-run)`, () => {
      // A hand-run has no redirect, so the file legitimately does not exist. Both scripts run under
      // `set -e`; without the `|| true` this line would abort the backup/snapshot entirely.
      const line = shippedChmodLine(base)!
      const sandbox = mkdtempSync(join(tmpdir(), 'cron-log-modes-empty-'))
      expect(() =>
        execFileSync('bash', [
          '-euo',
          'pipefail',
          '-c',
          `STORE=${JSON.stringify(sandbox)}\n${line}`,
        ])
      ).not.toThrow()
    })
  }

  it('CONTROL: no OTHER store script references a -cron.log without being listed here', () => {
    // The schedule lives on the host, not in this repo, so a newly scheduled script cannot be
    // discovered from here. This is the part that CAN be: if a third script starts naming a
    // `-cron.log`, this goes red and someone has to decide whether it needs the same treatment,
    // instead of the blind spot widening quietly.
    //
    // Comment-stripped, and matched on a PATH shape rather than the bare substring. Both matter,
    // measured while writing this: store/log-permissions.sh (card 9cbc471e) names both cron logs
    // in its header prose and says in an echo that they come back at 664 -- it documents this very
    // gap, it does not own a log. Counting prose made this case red on a script that is part of
    // the answer, not part of the problem.
    const referencing = readdirSync(STORE_DIR)
      .filter((f) => f.endsWith('.sh'))
      .filter((f) => {
        const code = readFileSync(join(STORE_DIR, f), 'utf8')
          .split('\n')
          .filter((l) => !l.trim().startsWith('#'))
          .join('\n')
        return /["'$/][\w.-]+-cron\.log/.test(code)
      })
      .map((f) => f.replace(/\.sh$/, ''))
      .sort()
    expect(referencing).toEqual([...SCHEDULED].sort())
  })
})

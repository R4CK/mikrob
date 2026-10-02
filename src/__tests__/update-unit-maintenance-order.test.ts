import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// A repair that only runs when there is something to pull is a repair that
// never runs on the machines that need it.
//
// update.sh returns early ("already on the latest commit") long before the
// unit-maintenance block used to sit. Two consequences, both measured on a live
// host on 2026-08-04:
//   - a machine updated 1.28.2 -> 1.29.0 and its channels unit still carried
//     the old Restart=on-failure: the run that PULLS a new repair is still
//     executing the OLD copy of update.sh (bash reads a script incrementally,
//     there is no re-exec), so it runs the old code, which lacks the repair;
//   - re-running update.sh did not help either: with nothing to pull it exits
//     at the up-to-date branch, above the repairs.
// The repair would first have run one whole release later.
//
// The morning-timer repair had the identical defect for weeks before the
// channels migration was placed next to it, which is what makes this a class
// and not a one-off. These tests pin the ordering so it cannot come back.

const ROOT = join(__dirname, '..', '..')
const UPDATE = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

/**
 * Strips bash `#...` comments from source text, line by line, tracking single/double-quote
 * state so a `#` inside a quoted string is not mistaken for a comment start. Deliberately
 * narrow (no heredoc/backtick/escape handling) -- built for the one check below, not as a
 * general bash parser: a full-line comment or a trailing `  # ...` comment on an otherwise
 * ordinary line of this file strips correctly, which is all this test needs.
 */
function stripShellComments(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      let inSingle = false
      let inDouble = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === "'" && !inDouble) inSingle = !inSingle
        else if (ch === '"' && !inSingle) inDouble = !inDouble
        else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

/** Line number (1-based) of the first line matching `re`. */
function lineOf(src: string, re: RegExp): number {
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1
  throw new Error(`no line matches ${re}`)
}

function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`function ${name}() not found`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`unterminated ${name}()`)
  return src.slice(start, end + 2)
}

function runScript(body: string): { out: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), 'unitmaint-'))
  try {
    const p = join(dir, 'probe.sh')
    writeFileSync(p, body + '\n')
    try {
      return { out: execFileSync('bash', [p], { encoding: 'utf-8' }).trim(), code: 0 }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number }
      return { out: `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`.trim(), code: err.status ?? -1 }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const OLD_CHANNELS_UNIT = ['[Service]', 'ExecStart=/root/marveen/scripts/channels.sh', 'Restart=on-failure', 'RestartSec=10', ''].join('\n')
const OLD_MORNING_TIMER = ['[Unit]', 'Description=Marveen Reggeli Napindito Timer', 'Requires=marveen-morning.service', '', '[Timer]', 'OnCalendar=*-*-* 07:27:00', ''].join('\n')

describe('unit maintenance runs before the up-to-date early exit', () => {
  it('the maintenance call precedes the early exit in file order', () => {
    const call = lineOf(UPDATE, /^run_unit_maintenance$/)
    const upToDateBranch = lineOf(UPDATE, /OLD_VERSION" = "\$NEW_VERSION/)
    expect(call).toBeLessThan(upToDateBranch)
  })

  it('no unit repair is left below the early exit', () => {
    const upToDateIdx = UPDATE.indexOf('if [ "$OLD_VERSION" = "$NEW_VERSION" ]')
    const below = UPDATE.slice(upToDateIdx)
    // definitions and calls must all be above; below there may only be the
    // breadcrumb comment that says so.
    expect(below).not.toMatch(/^migrate_channels_restart\b/m)
    expect(below).not.toMatch(/^repair_morning_timer\b/m)
    expect(below).not.toMatch(/^\s*sed -i\.marveen-bak .*-morning\.service/m)
  })

  it('both repairs are wired into the single maintenance entry point', () => {
    const wrapper = sliceShellFn(UPDATE, 'run_unit_maintenance')
    expect(wrapper).toMatch(/repair_morning_timer "\$@"/)
    expect(wrapper).toMatch(/migrate_channels_restart "\$@"/)
    expect(UPDATE).toMatch(/^run_unit_maintenance$/m)
  })

  // Cybersec NO-GO (card ef6a8031, 2026-10-02): a batch-3 upstream merge wired
  // install_keepalive_probe_timer and park_morning_timer into this same entry
  // point despite both being named NOT adopted in acknowledged-conflicts.ts --
  // the fork-upstream-conflict-guard suite does not look at update.sh function
  // names, so nothing else would have caught it. This pins the absence the
  // same way the tests above pin the ordering, so a future merge re-adding
  // either call here fails loudly instead of landing silently.
  it('no not-adopted unit function is wired into the maintenance entry point', () => {
    const wrapper = sliceShellFn(UPDATE, 'run_unit_maintenance')
    expect(wrapper).not.toMatch(/install_keepalive_probe_timer/)
    expect(wrapper).not.toMatch(/park_morning_timer/)
    expect(UPDATE).not.toMatch(/^install_keepalive_probe_timer\(\)/m)
    expect(UPDATE).not.toMatch(/^park_morning_timer\(\)/m)
  })

  // Cybersec LOW L1 (card ef6a8031, comment 11261; fixed on card e47dc04a): the two checks
  // above look at the exact upstream SHAPE -- a definition at top level and a call inside the
  // wrapper. Measured mutation M4 (defining the function AND calling it OUTSIDE the wrapper,
  // e.g. right after run_unit_maintenance instead of inside it) passes both checks 7/7 green.
  // The 12th code-quality rule's fix for this class: scan the COMMENT-STRIPPED whole file for
  // the bare name, not just one function's body -- a comment is allowed to name the not-adopted
  // functions (the NOT ADOPTED breadcrumb above run_unit_maintenance does exactly that), real
  // code is not. This is strictly stronger than, not a replacement for, the two checks above.
  it('no not-adopted unit function name appears anywhere in the comment-stripped file', () => {
    const stripped = stripShellComments(UPDATE)
    expect(stripped).not.toMatch(/install_keepalive_probe_timer/)
    expect(stripped).not.toMatch(/park_morning_timer/)
  })

  it('CONTROL: the comment stripper does not eat the adopted functions it must still see', () => {
    // If the stripper over-strips, the test above would pass for the wrong reason (nothing
    // left to search). Prove it still finds real, currently-adopted names after stripping.
    const stripped = stripShellComments(UPDATE)
    expect(stripped).toMatch(/repair_morning_timer/)
    expect(stripped).toMatch(/migrate_channels_restart/)
  })

  it('CONTROL: a mutation that defines+calls the not-adopted function OUTSIDE the wrapper is caught', () => {
    // Reproduces Cybersec's measured M4 gap directly: the two pre-existing checks only look at
    // run_unit_maintenance's body and the top-level `name() {` form, so a function defined with
    // a different declaration style and called right after the wrapper (not inside it) slips
    // past both. The comment-stripped whole-file scan must still catch it.
    const mutated = `${UPDATE}\nfunction install_keepalive_probe_timer { :; }\ninstall_keepalive_probe_timer\n`
    expect(stripShellComments(mutated)).toMatch(/install_keepalive_probe_timer/)
  })
})

describe('the maintenance itself, executed for real', () => {
  const body = [
    sliceShellFn(UPDATE, 'repair_morning_timer'),
    sliceShellFn(UPDATE, 'migrate_channels_restart'),
    sliceShellFn(UPDATE, 'run_unit_maintenance'),
  ].join('\n')

  function run(dir: string) {
    return runScript(`${body}\nrun_unit_maintenance "${dir}"`)
  }

  it('repairs BOTH unit kinds in one pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'units-'))
    try {
      writeFileSync(join(dir, 'marveen-channels.service'), OLD_CHANNELS_UNIT)
      writeFileSync(join(dir, 'marveen-morning.timer'), OLD_MORNING_TIMER)
      const r = run(dir)
      expect(r.code).toBe(0)
      expect(readFileSync(join(dir, 'marveen-channels.service'), 'utf-8')).toMatch(/^Restart=always$/m)
      expect(readFileSync(join(dir, 'marveen-morning.timer'), 'utf-8')).not.toMatch(/^Requires=/m)
      // the rest of the timer must survive
      expect(readFileSync(join(dir, 'marveen-morning.timer'), 'utf-8')).toContain('OnCalendar=*-*-* 07:27:00')
      expect(readdirSync(dir).filter((f) => f.includes('marveen-bak'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent: the second pass changes nothing and says nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'units-'))
    try {
      writeFileSync(join(dir, 'marveen-channels.service'), OLD_CHANNELS_UNIT)
      writeFileSync(join(dir, 'marveen-morning.timer'), OLD_MORNING_TIMER)
      run(dir)
      const after1 = [
        readFileSync(join(dir, 'marveen-channels.service'), 'utf-8'),
        readFileSync(join(dir, 'marveen-morning.timer'), 'utf-8'),
      ]
      const second = run(dir)
      expect(second.code).toBe(0)
      expect(second.out).not.toContain('javitva')
      expect(readFileSync(join(dir, 'marveen-channels.service'), 'utf-8')).toBe(after1[0])
      expect(readFileSync(join(dir, 'marveen-morning.timer'), 'utf-8')).toBe(after1[1])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives a machine with no unit directory at all (macOS)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'units-'))
    try {
      expect(run(join(dir, 'nope')).code).toBe(0)
      expect(run(dir).code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

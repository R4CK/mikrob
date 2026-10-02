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
 * narrow (no heredoc/backtick/escape/multi-line-quote handling, stated explicitly rather than
 * discovered later) -- built for the checks below, not as a general bash parser.
 *
 * A `#` only starts a comment when it begins a WORD -- preceded by whitespace, or the first
 * character of the line -- never mid-identifier. Without this, bash's own parameter-expansion
 * `#` (`${var#pattern}`, the positional-arg-count `$#`) gets mistaken for a comment start and
 * silently eats the rest of the line (Cybersec/QA LOW on card e47dc04a, comment 11423/11427,
 * against the real occurrence at update.sh's `${_node_pin#*$'\t'}`) -- a false negative for any
 * later call on that same line, which an allowlist/denylist check must not have.
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
        else if (ch === '#' && !inSingle && !inDouble) {
          const prev = line[i - 1]
          if (prev === undefined || prev === ' ' || prev === '\t') return line.slice(0, i)
        }
      }
      return line
    })
    .join('\n')
}

// Cybersec/Cybered NO-GO (card e47dc04a, comments 11423/11425) on this card's OWN first
// attempt: the "fix" for the ef6a8031 leak was still a DENYLIST of the two names that had
// already leaked, which cannot catch a THIRD, not-yet-seen not-adopted unit function wired into
// the same wrapper -- measured directly: install_main_inbox_observer_unit (itself named NOT
// adopted in acknowledged-conflicts.ts, from the SAME upstream package the original leak came
// from) wired into run_unit_maintenance passed the denylist 48/48 green. MikroB's acceptance
// criterion (comment 11277) was an ALLOWLIST from the start: run_unit_maintenance may call ONLY
// the functions explicitly adopted today, and ANY other name -- known or not -- is red.
const ADOPTED_UNIT_FUNCTIONS = new Set(['repair_morning_timer', 'migrate_channels_restart'])

/**
 * Every function name `run_unit_maintenance`-shaped wrapper body calls as a bare statement
 * (`name` or `name "$@"` on its own line), in file order. Comment-stripped first so a NOT
 * ADOPTED breadcrumb naming a function is never mistaken for a real call. Deliberately does
 * NOT try to be a general bash statement parser -- every real call in this wrapper, adopted or
 * not, uses exactly this shape (grep-verified against every historical version of this
 * function), and the allowlist below is checking an exhaustive POSITIVE list, so a call shaped
 * differently than this would itself be worth a human look, not a thing to silently accept.
 */
function calledFunctionNames(wrapperBody: string): string[] {
  const names: string[] = []
  for (const raw of stripShellComments(wrapperBody).split('\n')) {
    const line = raw.trim()
    if (!line || line === '{' || line === '}') continue
    if (/^return\b/.test(line)) continue
    if (/\)\s*\{?$/.test(line)) continue // the wrapper's own `name() {` header line
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+"\$@"|\s+\$@)?$/)
    if (m) names.push(m[1])
  }
  return names
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
  // names, so nothing else would have caught it.
  it('no not-adopted unit function is wired into the maintenance entry point', () => {
    const wrapper = sliceShellFn(UPDATE, 'run_unit_maintenance')
    expect(wrapper).not.toMatch(/install_keepalive_probe_timer/)
    expect(wrapper).not.toMatch(/park_morning_timer/)
    expect(UPDATE).not.toMatch(/^install_keepalive_probe_timer\(\)/m)
    expect(UPDATE).not.toMatch(/^park_morning_timer\(\)/m)
  })

  // THE ACTUAL ACCEPTANCE CRITERION (card e47dc04a, comment 11277, re-affirmed after this
  // card's own first attempt was NO-GO'd for still being a denylist, comments 11423/11425):
  // run_unit_maintenance may call ONLY the functions explicitly adopted today. This is an
  // ALLOWLIST, not a longer denylist -- it catches every not-yet-named not-adopted function
  // (not just the two that have already leaked once), because it does not need to know that
  // function's name in advance to reject it.
  it('run_unit_maintenance calls ONLY the adopted unit functions (allowlist, not denylist)', () => {
    const wrapper = sliceShellFn(UPDATE, 'run_unit_maintenance')
    const called = calledFunctionNames(wrapper)
    for (const name of called) {
      expect(ADOPTED_UNIT_FUNCTIONS.has(name), `unexpected call to '${name}' -- not in the adopted allowlist`).toBe(true)
    }
    // Not vacuous: both adopted calls are really extracted, not an empty match set passing by
    // having nothing to check.
    expect(called).toContain('repair_morning_timer')
    expect(called).toContain('migrate_channels_restart')
  })

  // CONTROL, reproducing Cybersec's measured M5 directly: a THIRD, not-yet-named not-adopted
  // unit function (install_main_inbox_observer_unit -- itself named NOT adopted in
  // acknowledged-conflicts.ts, from the same upstream package the original leak came from)
  // wired into the wrapper must fail the allowlist check above, proving it is not merely
  // re-testing the two already-known names.
  it('CONTROL: wiring an unnamed-until-now not-adopted unit function into the wrapper fails the allowlist', () => {
    const wrapper = sliceShellFn(UPDATE, 'run_unit_maintenance')
    const mutated = wrapper.replace(
      /\breturn 0\b/,
      'install_main_inbox_observer_unit "$@"\n  return 0',
    )
    expect(mutated).not.toBe(wrapper) // the replace actually matched something
    const called = calledFunctionNames(mutated)
    expect(called.every((name) => ADOPTED_UNIT_FUNCTIONS.has(name))).toBe(false)
  })

  // CONTROL: the extractor itself must not silently swallow a call that sits on the SAME line
  // as a bash parameter-expansion `#` -- the exact shape the stripShellComments LOW finding
  // (comment 11423/11427) warned about. This does not reproduce a real update.sh line (none
  // currently puts a call after a `#...}` expansion); it proves the extractor's own robustness
  // independent of whether today's file happens to trigger it.
  it('CONTROL: stripShellComments does not eat a call that follows a parameter-expansion #', () => {
    const line = 'x="${var#pattern}"; migrate_channels_restart "$@"'
    expect(stripShellComments(line)).toContain('migrate_channels_restart "$@"')
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

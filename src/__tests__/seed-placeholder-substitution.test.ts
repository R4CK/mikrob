// Every placeholder a shipped seed template USES must actually be SUBSTITUTED by every seeder
// (card 252e36d3).
//
// The gap this locks: template-identity-hygiene already forbids a hardcoded chat id in a shipped
// template and points at `{{CHAT_ID}}` as the fix -- but the scheduled-task seeding loops in
// update.sh / install-linux.sh / install-macos.sh substituted MAIN_AGENT_ID, BOT_NAME, OWNER_NAME and
// INSTALL_DIR and *not* CHAT_ID. So obeying the hygiene rule would have shipped a literal
// `{{CHAT_ID}}` string into the installed task, i.e. an instruction telling the agent to post to a
// non-existent chat. The two rules only work together, so they are tested together.
//
// Source-level assertions on purpose: the realistic regression is someone adding a new placeholder to
// a template (or a new seeder) and forgetting the matching sed line. Running the installers for real
// would need a full fake install; grepping the substitution list catches the omission directly.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

/** The scripts that render seed-scheduled-tasks/ into an install. */
const SEEDERS = ['update.sh', 'install-linux.sh', 'install-macos.sh']

const SEED_DIR = join(REPO_ROOT, 'seed-scheduled-tasks')

/** Every `{{PLACEHOLDER}}` actually used by a shipped scheduled-task template. */
function placeholdersUsedInTemplates(): Set<string> {
  const found = new Set<string>()
  if (!existsSync(SEED_DIR)) return found
  for (const task of readdirSync(SEED_DIR)) {
    const dir = join(SEED_DIR, task)
    if (!statSync(dir).isDirectory()) continue
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (!statSync(p).isFile()) continue
      for (const m of readFileSync(p, 'utf-8').matchAll(/\{\{([A-Z_]+)\}\}/g)) {
        found.add(m[1]!)
      }
    }
  }
  return found
}

/**
 * The placeholder names a seeder's SCHEDULED-TASK sed pipeline replaces.
 *
 * Scoped to that ONE pipeline on purpose: update.sh also substitutes {{CHAT_ID}} in an unrelated
 * CLAUDE.md re-render block, so a whole-file grep reports CHAT_ID as covered even after the
 * scheduled-task loop drops it -- which is exactly the omission this file exists to catch (verified:
 * with a whole-file grep, deleting the loop's CHAT_ID line left every assertion green).
 *
 * The loop is identified by its output redirection into `$target/`, which only the scheduled-task
 * seeding block uses.
 */
function placeholdersSubstitutedBy(seeder: string): Set<string> {
  const src = readFileSync(join(REPO_ROOT, seeder), 'utf-8')
  const marker = src.indexOf('"$f" > "$target/')
  expect(marker, `${seeder} must contain the scheduled-task seeding loop`).toBeGreaterThan(-1)
  // Walk back to the `sed` that opens this pipeline; everything between is its -e list.
  const sedStart = src.lastIndexOf('sed ', marker)
  expect(sedStart, `${seeder}: no sed opening the scheduled-task loop`).toBeGreaterThan(-1)
  const block = src.slice(sedStart, marker)
  const out = new Set<string>()
  for (const m of block.matchAll(/s[|/]\{\{([A-Z_]+)\}\}[|/]/g)) out.add(m[1]!)
  return out
}

describe('seed template placeholders are all substituted by every seeder', () => {
  const used = placeholdersUsedInTemplates()

  it('the shipped templates actually use placeholders (guards against a vacuous pass)', () => {
    // If this ever returns an empty set the test below would pass trivially.
    expect(used.size).toBeGreaterThan(0)
    expect(used.has('INSTALL_DIR')).toBe(true)
  })

  it.each(SEEDERS)('%s substitutes every placeholder the templates use', (seeder) => {
    const substituted = placeholdersSubstitutedBy(seeder)
    const missing = [...used].filter((p) => !substituted.has(p)).sort()
    expect(missing, `${seeder} never substitutes: ${missing.join(', ')}`).toEqual([])
  })

  it('CHAT_ID specifically -- the one that was missing (regression lock)', () => {
    // template-identity-hygiene tells authors to use {{CHAT_ID}} instead of a literal chat id; that
    // advice is only safe while every seeder renders it.
    for (const seeder of SEEDERS) {
      expect(
        placeholdersSubstitutedBy(seeder).has('CHAT_ID'),
        `${seeder} must substitute {{CHAT_ID}} in its scheduled-task seeding loop`,
      ).toBe(true)
    }
  })

  it('no shipped scheduled-task template still carries a raw absolute home path', () => {
    const offenders: string[] = []
    for (const task of readdirSync(SEED_DIR)) {
      const dir = join(SEED_DIR, task)
      if (!statSync(dir).isDirectory()) continue
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (!statSync(p).isFile()) continue
        const text = readFileSync(p, 'utf-8')
        if (/\/(home|Users)\/(?!<)[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/.test(text)) {
          offenders.push(`${task}/${f}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  // Card d041760b (Cybered MEDIUM). render_seed_template() came in from upstream, where NO seed task
  // uses {{CHAT_ID}} -- so omitting that rule is correct THERE. In this fork four fleet tasks use it.
  // Without the rule, the rendered template keeps the literal {{CHAT_ID}} while the installed file
  // carries the real id; the hashes never match, seed_copy_is_untouched concludes
  // "operator-modified", and those four are skipped FOREVER while being reported as KEPT. A fix to
  // gate-reconciler would never reach a single install.
  //
  // This asserts on update.sh's TEXT rather than executing it: the script restarts services and
  // rewrites a live install, so running it in the suite is exactly what the live-install guard
  // exists to prevent.
  describe('{{CHAT_ID}} survives the seed-refresh comparison (card d041760b)', () => {
    const updateSh = readFileSync(join(REPO_ROOT, 'update.sh'), 'utf-8')

    it('render_seed_template substitutes {{CHAT_ID}}', () => {
      const fn = updateSh.slice(updateSh.indexOf('render_seed_template() {'))
      const body = fn.slice(0, fn.indexOf('\n}'))
      expect(body).toContain('{{CHAT_ID}}')
    })

    it('CHAT_ID is resolved BEFORE the first render call, not only at the seeding block', () => {
      // Ordering is the whole defect: the value was assigned far below the render call sites, so
      // the substitution ran with an empty variable even once the rule existed.
      const assign = updateSh.indexOf('SCHED_CHAT_ID=$(grep')
      const renderDef = updateSh.indexOf('render_seed_template() {')
      const firstUse = updateSh.indexOf('refresh_untouched_seeds "seed-scheduled-tasks"')
      expect(assign).toBeGreaterThan(-1)
      expect(assign).toBeLessThan(renderDef)
      expect(assign).toBeLessThan(firstUse)
    })

    it('the fleet tasks that use {{CHAT_ID}} are still the known set', () => {
      // If a new task starts using it, this test should make someone look rather than silently
      // widen the blast radius of any future regression. Card f2a14f91 (2026-08-27): the three
      // separate gate-reconciler/folyamatos-munka-orchestrator/stuck-card-monitor seeds were
      // retired in favor of the single heartbeat-consolidated seed that already covers them.
      const users = readdirSync(SEED_DIR).filter((task) => {
        const f = join(SEED_DIR, task, 'SKILL.md')
        return existsSync(f) && readFileSync(f, 'utf-8').includes('{{CHAT_ID}}')
      })
      // agent-skill-drift-sync-heartbeat joined the set on card 222fdc5e: its report now goes to
      // Peti only when the script's own ALERT:yes verdict says the diverged SET changed.
      expect(users.sort()).toEqual(
        ['agent-skill-drift-sync-heartbeat', 'fleet-nudger', 'heartbeat-consolidated'].sort(),
      )
    })
  })
})

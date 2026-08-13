// Guard: the installer and the updater must render seed templates identically (card d041760b).
//
// The same seed files are rendered in TWO places -- install-linux.sh at install time and update.sh's
// render_seed_template on every update -- from two different sets of shell variables. When those two
// diverge, the damage is silent and compounding:
//
//   update.sh read `^CHAT_ID=` from .env. The installer WRITES `ALLOWED_CHAT_ID` and renders from its
//   own $CHAT_ID. So the grep matched nothing and update.sh rendered {{CHAT_ID}} as EMPTY while the
//   installer rendered the real id. seed_copy_is_untouched() then compared the live file against
//   update.sh's rendering, never matched, and treated all four fleet-orchestration prompts as
//   user-modified FOREVER -- refresh_untouched_seeds silently stopped updating them. The escalation
//   line they carry (`reply chat_id {{CHAT_ID}}`) also lost its destination.
//
// So this pins the two properties that keep the renderings aligned: the same placeholder set, and a
// chat-id source that the installer actually writes.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UPDATE = readFileSync(join(REPO, 'update.sh'), 'utf-8')
const INSTALL = readFileSync(join(REPO, 'install-linux.sh'), 'utf-8')

/** Placeholders a script substitutes, i.e. every `{{X}}` appearing on a sed `s/…/…/g` line. */
function renderedPlaceholders(script: string): Set<string> {
  const out = new Set<string>()
  for (const line of script.split('\n')) {
    if (!/-e\s+"s[/|]\{\{/.test(line)) continue
    for (const m of line.matchAll(/\{\{([A-Z_]+)\}\}/g)) out.add(m[1] as string)
  }
  return out
}

/** Placeholders that actually occur in the seed corpus. */
function placeholdersInSeeds(): Set<string> {
  const found = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else for (const m of readFileSync(p, 'utf-8').matchAll(/\{\{([A-Z_]+)\}\}/g)) found.add(m[1] as string)
    }
  }
  for (const d of ['seed-scheduled-tasks', 'seed-skills', 'seed-agents', 'seed-config']) {
    const full = join(REPO, d)
    if (existsSync(full)) walk(full)
  }
  return found
}

// {{INPUT}} is a RUNTIME placeholder in prose, deliberately left literal by both renderers.
const RUNTIME_PLACEHOLDERS = new Set(['INPUT'])

describe('seed rendering parity between installer and updater (card d041760b)', () => {
  it('parses a non-trivial placeholder set from both scripts', () => {
    // an over-strict regex here would make every assertion below vacuously true
    expect(renderedPlaceholders(UPDATE).size).toBeGreaterThan(3)
    expect(renderedPlaceholders(INSTALL).size).toBeGreaterThan(3)
  })

  it('substitutes the same placeholders in both scripts', () => {
    const u = renderedPlaceholders(UPDATE)
    const i = renderedPlaceholders(INSTALL)
    // A placeholder handled by only one of them renders differently in the two paths, which is exactly
    // what made seed_copy_is_untouched blind.
    expect([...u].filter((p) => !i.has(p)).sort()).toEqual([])
    expect([...i].filter((p) => !u.has(p)).sort()).toEqual([])
  })

  it('covers every placeholder the seed corpus actually uses', () => {
    const seedUsed = [...placeholdersInSeeds()].filter((p) => !RUNTIME_PLACEHOLDERS.has(p))
    expect(seedUsed.length).toBeGreaterThan(2)
    const u = renderedPlaceholders(UPDATE)
    expect(seedUsed.filter((p) => !u.has(p)).sort()).toEqual([])
  })

  // The specific divergence this card fixed: update.sh must read a key the installer WRITES.
  it('resolves the chat id from the key the installer writes', () => {
    expect(INSTALL, 'installer no longer writes ALLOWED_CHAT_ID -- update this guard with it')
      .toMatch(/env_merge_key\s+ALLOWED_CHAT_ID/)
    const block = UPDATE.slice(UPDATE.indexOf('SCHED_CHAT_ID='))
    expect(block.slice(0, 800)).toMatch(/\^ALLOWED_CHAT_ID=/)
  })

  // The installer defaults to 0 (`${CHAT_ID:-0}`); an empty default in update.sh would re-diverge the
  // two renderings for any install that never paired.
  it('uses the same empty-value default as the installer', () => {
    expect(UPDATE).toMatch(/SCHED_CHAT_ID="\$\{SCHED_CHAT_ID:-0\}"/)
    expect(UPDATE).not.toMatch(/\{\{CHAT_ID\}\}\/\$\{SCHED_CHAT_ID:-\}/)
  })

  // Every {{CHAT_ID}} substitution must carry its OWN `:-` default, not rely on a top-level
  // assignment running first. render_seed_template is sliced out and executed on its own under
  // `set -u` by seed-refresh-untouched-only.test.ts; without the in-line default that probe dies
  // with "SCHED_CHAT_ID: unbound variable" (QA FAIL on 7a376c9). The redundancy IS the safety net.
  it('gives every CHAT_ID substitution its own default', () => {
    const subs = [...UPDATE.matchAll(/-e "s\/\{\{CHAT_ID\}\}\/([^"]*)\/g"/g)].map((m) => m[1] as string)
    expect(subs.length, 'no CHAT_ID substitution found -- the regex would make this vacuous').toBeGreaterThanOrEqual(3)
    for (const sub of subs) expect(sub, `substitution "${sub}" has no :- default`).toMatch(/:-.+\}$/)
  })

  // One resolved value, not several. Two variables deriving the same id from different keys is what
  // produced this bug family: the seed path and the CLAUDE.md regen path disagreed.
  it('resolves the chat id once, in a single variable', () => {
    expect(UPDATE).not.toMatch(/REGEN_CHAT_ID/)
    const assignments = [...UPDATE.matchAll(/^\s*[A-Z_]*CHAT_ID=\$\(grep/gm)]
    expect(assignments.length, 'more than one place greps the chat id out of .env').toBeLessThanOrEqual(2)
  })
})

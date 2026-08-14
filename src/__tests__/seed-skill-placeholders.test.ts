// Every identity placeholder in a seed skill must be one the seeding path actually renders
// (card 041681b5).
//
// The failure this pins is live, not hypothetical: `~/.claude/skills/local-llm-offload/SKILL.md` on
// this install contains `{{INSTALL_DIR}}/store/local-llm-rag.sh` inside a command an agent is told to
// run. The skills were copied verbatim by the installer and refreshed verbatim by update.sh, while
// the placeholder convention was only ever rendered for CLAUDE.md and scheduled tasks. So the two
// halves of the convention were each fine and nobody owned the join.
//
// The hygiene guard (template-identity-hygiene.test.ts) pushes authors TOWARDS the placeholder; this
// one makes sure the placeholder means something. Together they close the loop -- separately, either
// one is satisfiable by shipping a broken file.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { substituteTemplatePlaceholders } from '../web/agent-scaffold.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SEED_SKILLS = join(REPO_ROOT, 'seed-skills')

/** UPPERCASE_SNAKE only: `{{name}}` in the i18n skill is its SUBJECT MATTER (the invalid
 *  double-brace form it teaches you to find), not an identity placeholder. */
const IDENTITY_PLACEHOLDER_RX = /\{\{([A-Z][A-Z0-9_]*)\}\}/g

/** There are TWO placeholder namespaces here, and this test found the second one by failing on it.
 *  `{{INPUT}}` belongs to the local-model task templates (store/local-llm-skills/<task>.txt) and is
 *  replaced by store/local-llm.sh at CALL time -- a skill that documents that mechanism has to print
 *  it literally, so rendering it at seed time would corrupt the documentation. Listed by name rather
 *  than by a loose pattern: a new unrenderable placeholder should still fail here. */
const RUNTIME_PLACEHOLDERS = new Set(['INPUT'])

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const IDENTITY = {
  projectRoot: '/opt/some-install',
  mainAgentId: 'mainagent',
  botName: 'BotName',
  ownerName: 'Owner',
  webPort: 3420,
}

describe('seed-skills placeholders are renderable (card 041681b5)', () => {
  it('every {{IDENTITY_PLACEHOLDER}} used in a seed skill is one the renderer knows', () => {
    const unknown: string[] = []
    for (const file of walk(SEED_SKILLS)) {
      const text = readFileSync(file, 'utf-8')
      const rendered = substituteTemplatePlaceholders(text, IDENTITY)
      // Whatever survives the renderer would ship LITERALLY to a user's skill file.
      for (const m of rendered.matchAll(IDENTITY_PLACEHOLDER_RX)) {
        if (RUNTIME_PLACEHOLDERS.has(m[1])) continue
        unknown.push(`${file.slice(REPO_ROOT.length + 1)}: {{${m[1]}}}`)
      }
    }
    expect(unknown, `Unrenderable placeholder in a shipped skill:\n${unknown.join('\n')}`).toEqual([])
  })

  it('the {{INPUT}} exemption is real: local-llm.sh is what replaces it, at call time', () => {
    // An exemption is a claim; this checks the claim instead of repeating it. If the runtime stops
    // handling {{INPUT}}, the skill's documentation of it becomes wrong and this fails.
    const runtime = readFileSync(join(REPO_ROOT, 'store', 'local-llm.sh'), 'utf-8')
    expect(runtime).toContain('{{INPUT}}')
  })

  it('CONTROL: the check can fail -- an unknown placeholder is not silently accepted', () => {
    // Without this, "the renderer knows everything" and "the regex never matches" look identical.
    const rendered = substituteTemplatePlaceholders('run {{NOT_A_REAL_PLACEHOLDER}}/x', IDENTITY)
    expect([...rendered.matchAll(IDENTITY_PLACEHOLDER_RX)].length).toBe(1)
  })

  it('CONTROL: a known placeholder really is substituted, and the i18n examples are left alone', () => {
    const rendered = substituteTemplatePlaceholders('cat {{INSTALL_DIR}}/store/x and {{name}}', IDENTITY)
    expect(rendered).toContain('/opt/some-install/store/x')
    expect(rendered).toContain('{{name}}') // lowercase: the i18n skill's subject matter, untouched
  })

  it('no seed skill hardcodes an absolute home path any more', () => {
    // The hygiene guard covers this repo-wide; asserted here too because this suite is the one a
    // future author of a SKILL will run, and the two rules only make sense together.
    const offenders: string[] = []
    for (const file of walk(SEED_SKILLS)) {
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          if (!line.includes('://') && /\/(Users|home)\/(?!<)[A-Za-z0-9._-]+/.test(line)) {
            offenders.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}`)
          }
        })
    }
    expect(offenders).toEqual([])
  })
})

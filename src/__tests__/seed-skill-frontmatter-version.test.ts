// Card eb70cb13: skill frontmatter gains `version` + `related_skills` (hermes-agent /
// agentskills.io convention, docs/skill-factory.md). This is the structural half -- without it,
// "every skill should have a version" is exactly the kind of rule a future skill author forgets,
// the same class of gap code-quality rule 6 exists to close on the writer side elsewhere in this
// repo.
//
// What these pin, and why each is here rather than being obvious:
//   - every OWN (non-vendored) seed skill has a version field, not just the ones this card touched.
//   - vendored `sp-*` skills must NOT have it added here -- their content belongs to the upstream
//     repo (docs/fork-additions-to-vendored-skills.md), and a locally-added field could silently
//     collide with an upstream field of the same name and different semantics on the next re-vendor.
//   - every related_skills entry names a skill that actually exists on disk -- a typo or a renamed/
//     deleted skill would otherwise sit there as a dead reference nobody notices.
//   - the check can fail: a control fixture with a missing version and a dangling related_skills
//     entry proves the assertions are not vacuously true.
import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync, readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SEED_SKILLS = join(REPO_ROOT, 'seed-skills')
const VENDORED_PREFIX = 'sp-'

function skillDirs(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'SKILL.md')))
    .map((e) => e.name)
}

function frontmatter(text: string): string | null {
  const m = /^---\n(.*?)\n---\n/s.exec(text)
  return m ? m[1] : null
}

/** Minimal, deliberately not a full YAML parser (frontmatter here can contain an unquoted colon in
 *  `description`, which is a separate, pre-existing quirk this card does not touch) -- just enough
 *  to read a `related_skills: [a, b]` flow-list line without choking on the rest of the block. */
function relatedSkillsOf(fm: string): string[] | null {
  const m = /^related_skills:\s*\[([^\]]*)\]\s*$/m.exec(fm)
  if (!m) return null
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const names = skillDirs(SEED_SKILLS)
const ownNames = names.filter((n) => !n.startsWith(VENDORED_PREFIX))
const vendoredNames = names.filter((n) => n.startsWith(VENDORED_PREFIX))

describe('seed-skills frontmatter: version + related_skills (card eb70cb13)', () => {
  it('CONTROL (sanity): the fork actually has both an own skill and a vendored sp-* one', () => {
    // Without this, "zero vendored skills found" and "the vendored exemption holds" look identical.
    expect(ownNames.length).toBeGreaterThan(0)
    expect(vendoredNames.length).toBeGreaterThan(0)
  })

  it('every OWN (non sp-*) seed skill has a version field', () => {
    const missing: string[] = []
    for (const name of ownNames) {
      const text = readFileSync(join(SEED_SKILLS, name, 'SKILL.md'), 'utf-8')
      const fm = frontmatter(text)
      if (!fm || !/^version:/m.test(fm)) missing.push(name)
    }
    expect(missing, `Own skills missing a version field:\n${missing.join('\n')}`).toEqual([])
  })

  it('vendored sp-* skills do NOT carry a locally-added version field', () => {
    // Not a claim that upstream will never add its own `version:` -- only that THIS repo did not
    // inject one, which would risk colliding with a future upstream field of different semantics.
    const withVersion: string[] = []
    for (const name of vendoredNames) {
      const text = readFileSync(join(SEED_SKILLS, name, 'SKILL.md'), 'utf-8')
      const fm = frontmatter(text)
      if (fm && /^version:/m.test(fm)) withVersion.push(name)
    }
    expect(withVersion, `Vendored skills with a version field (should not happen from this repo):\n${withVersion.join('\n')}`).toEqual([])
  })

  it('every related_skills entry names a skill that actually exists', () => {
    const nameSet = new Set(names)
    const dangling: string[] = []
    for (const name of ownNames) {
      const text = readFileSync(join(SEED_SKILLS, name, 'SKILL.md'), 'utf-8')
      const fm = frontmatter(text)
      if (!fm) continue
      const related = relatedSkillsOf(fm)
      if (!related) continue
      for (const r of related) {
        if (!nameSet.has(r)) dangling.push(`${name} -> ${r}`)
      }
    }
    expect(dangling, `Dangling related_skills reference (skill does not exist):\n${dangling.join('\n')}`).toEqual([])
  })

  it('no own skill lists itself in related_skills', () => {
    const selfRefs: string[] = []
    for (const name of ownNames) {
      const text = readFileSync(join(SEED_SKILLS, name, 'SKILL.md'), 'utf-8')
      const fm = frontmatter(text)
      if (!fm) continue
      const related = relatedSkillsOf(fm)
      if (related?.includes(name)) selfRefs.push(name)
    }
    expect(selfRefs).toEqual([])
  })
})

describe('seed-skills frontmatter checks -- CONTROL: proven to fail on a broken fixture', () => {
  const tmpDirs: string[] = []
  function makeSkill(dir: string, name: string, frontmatterBody: string): void {
    const skillDir = join(dir, name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), `---\n${frontmatterBody}\n---\n# ${name}\n`, 'utf-8')
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      try {
        rmSync(tmpDirs.pop()!, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  })

  it('a skill missing version would be caught, not silently accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-skills-fixture-'))
    tmpDirs.push(dir)
    makeSkill(dir, 'no-version-skill', 'name: no-version-skill\ndescription: test fixture')
    const own = skillDirs(dir).filter((n) => !n.startsWith(VENDORED_PREFIX))
    const missing = own.filter((n) => {
      const fm = frontmatter(readFileSync(join(dir, n, 'SKILL.md'), 'utf-8'))
      return !fm || !/^version:/m.test(fm)
    })
    expect(missing).toEqual(['no-version-skill'])
  })

  it('a dangling related_skills reference would be caught, not silently accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-skills-fixture-'))
    tmpDirs.push(dir)
    makeSkill(
      dir,
      'has-dangling-ref',
      'name: has-dangling-ref\ndescription: test fixture\nversion: "1.0.0"\nrelated_skills: [does-not-exist]',
    )
    const nameSet = new Set(skillDirs(dir))
    const text = readFileSync(join(dir, 'has-dangling-ref', 'SKILL.md'), 'utf-8')
    const related = relatedSkillsOf(frontmatter(text)!)!
    const dangling = related.filter((r) => !nameSet.has(r))
    expect(dangling).toEqual(['does-not-exist'])
  })
})

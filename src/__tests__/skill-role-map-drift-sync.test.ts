// Card 3e59d70e, CYBERED F-1 (MEDIUM, comment 38477): the 86 per-named-skill symlinks this card
// wired directly into agents/*/.claude/skills were not declared in store/skill-role-map.json --
// so store/agent-skill-drift-sync.sh's clone-family check read "fron-ted has a skill fron-teddy's
// live directory lacks" as a genuine gap and reported 15 false MISSING lines (fron-teddy missing
// 12 of fron-ted's new links, fron-ted missing 3 of fron-teddy's).
//
// Fix: declare the skill in BOTH siblings' `roles[name]` array in skill-role-map.json. This test
// pins the mechanism directly (run the REAL script against a synthetic fixture, same technique as
// the sibling skill-drift-map.test.ts): a skill present live for only one clone-family sibling and
// undeclared for the other is reported MISSING; the moment it is declared for the lagging sibling
// too, scan_missing_skills' existing `_is_provisioner_managed` guard (agent-skill-drift-sync.sh:480,
// "the provisioner owns this skill for $m and will symlink it in at $m's next start -- not a
// clone-family gap") takes over and the same pair reports zero MISSING, with NO live symlink
// required on the lagging sibling -- the provisioner creates it at that agent's next start.
//
// Uses the REAL sibling family list (fron-ted/fron-teddy is a hardcoded pair in
// store/sibling-family-list.sh, not overridable), so the fixture must use those real names.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const TOOL = join(REPO_ROOT, 'store', 'agent-skill-drift-sync.sh')

let root: string
let agentsDir: string
let roleMapPath: string

function writeRoleMap(frontedExtra: string[], frontTeddyExtra: string[]): void {
  const roleMap = {
    'fleet-core': [],
    roles: {
      'fron-ted': frontedExtra,
      'fron-teddy': frontTeddyExtra,
    },
  }
  writeFileSync(roleMapPath, JSON.stringify(roleMap, null, 2) + '\n', 'utf-8')
}

function run(): string {
  return execFileSync('bash', [TOOL], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_SKILL_DRIFT_ROOT: root,
      AGENT_SKILL_DRIFT_AGENTS_DIR: agentsDir,
      AGENT_SKILL_DRIFT_SEEDS_DIR: join(root, 'seed-skills'),
      AGENT_SKILL_DRIFT_SEED_FLEET_DIR: join(root, 'seed-fleet-agents'),
      AGENT_SKILL_DRIFT_STATE: join(root, 'state.json'),
      AGENT_SKILL_DRIFT_ROLE_MAP: roleMapPath,
      AGENT_SKILL_DRIFT_TEST_SESSIONS: '',
    },
  })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'skillrolemap-driftsync-'))
  agentsDir = join(root, 'agents')
  roleMapPath = join(root, 'role-map.json')
  mkdirSync(join(root, 'seed-skills'), { recursive: true })
  mkdirSync(join(root, 'seed-fleet-agents'), { recursive: true })

  // Only fron-ted has this skill live; fron-teddy's directory does not.
  mkdirSync(join(agentsDir, 'fron-ted', '.claude', 'skills', 'only-fron-ted-skill'), { recursive: true })
  writeFileSync(join(agentsDir, 'fron-ted', '.claude', 'skills', 'only-fron-ted-skill', 'SKILL.md'), 'x\n')
  mkdirSync(join(agentsDir, 'fron-teddy', '.claude'), { recursive: true })
  mkdirSync(join(agentsDir, 'fron-teddy', '.claude', 'skills'), { recursive: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('agent-skill-drift-sync.sh clone-family MISSING vs skill-role-map.json declaration (card 3e59d70e F-1)', () => {
  it('reports the skill MISSING for the lagging sibling when undeclared for either (the bug)', () => {
    writeRoleMap([], [])
    const out = run()
    expect(out).toMatch(/fron-teddy\/only-fron-ted-skill -- present in a sibling's LIVE copy only/)
    expect(out).toMatch(/missing=1/)
  })

  it('still reports MISSING when declared for fron-ted only (the skill\'s OWNER, not the lagging sibling)', () => {
    writeRoleMap(['only-fron-ted-skill'], [])
    const out = run()
    expect(out).toMatch(/fron-teddy\/only-fron-ted-skill -- present in a sibling's LIVE copy only/)
    expect(out).toMatch(/missing=1/)
  })

  it('reports zero MISSING once declared for the LAGGING sibling too, with no live symlink needed (the fix)', () => {
    writeRoleMap(['only-fron-ted-skill'], ['only-fron-ted-skill'])
    const out = run()
    expect(out).not.toContain('only-fron-ted-skill -- present in a sibling')
    expect(out).toMatch(/missing=0/)
  })
})

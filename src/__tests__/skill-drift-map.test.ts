// store/skill-drift-map.py classifies the difference between the LIVE global skills and the tracked
// templates (card bf67711e). Its whole value is that the classification is trustworthy, because two
// kinds of difference are CORRECT BY DESIGN and acting on them would cause harm:
//
//   * placeholder rendering -- the templates ship {{INSTALL_DIR}} and the installer renders it
//     (card 041681b5); "fixing" that in the template puts a literal placeholder back into commands
//     agents are told to run;
//   * de-personalisation -- the templates say "a felhasznalo" where the live copy says the owner's
//     name; syncing live -> template would leak this install's owner into every fresh install of
//     the fork.
//
// So the load-bearing assertions here are the NEGATIVE ones: those two must NOT be reported as
// drift. The tests RUN the tool against a synthetic pair of trees rather than reading its source --
// the sibling secret-shape-scan test makes the same choice for the same reason.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const TOOL = join(REPO_ROOT, 'store/skill-drift-map.py')

let root: string
let installDir: string
let liveDir: string

/** Write one skill file into a template tree and its live counterpart. */
function pair(skill: string, template: string, live: string): void {
  const t = join(installDir, 'seed-skills', skill)
  const l = join(liveDir, skill)
  mkdirSync(t, { recursive: true })
  mkdirSync(l, { recursive: true })
  writeFileSync(join(t, 'SKILL.md'), template)
  writeFileSync(join(l, 'SKILL.md'), live)
}

function run(args: string[] = []): string {
  return execFileSync('python3', [TOOL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, INSTALL_DIR: installDir, SKILLS_DIR: liveDir },
  })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'driftmap-'))
  installDir = join(root, 'install')
  liveDir = join(root, 'live')
  mkdirSync(join(installDir, 'seed-skills'), { recursive: true })
  mkdirSync(liveDir, { recursive: true })
  // The identity values the tool reads, same source update.sh uses.
  writeFileSync(join(installDir, '.env'), 'OWNER_NAME=Peti\nBOT_NAME=MikroB\nMAIN_AGENT_ID=mikrob\n')

  pair('identical-skill', 'same bytes\n', 'same bytes\n')
  pair('placeholder-skill', 'run {{INSTALL_DIR}}/store/x.sh\n', `run ${installDir}/store/x.sh\n`)
  pair('owner-skill', 'a felhasználó kérése szerint\n', 'Peti kérése szerint\n')
  pair('lagging-skill', 'line one\n', 'line one\nline two added live\n')
  pair('live-lost-skill', 'line one\nline two only in template\n', 'line one\n')
  pair('two-sided-skill', 'line one\nonly template\n', 'line one\nonly live\n')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('store/skill-drift-map.py', () => {
  it('does NOT report a rendered placeholder as drift', () => {
    // The dangerous direction: a tool that flags this sends someone to "sync" the template and put a
    // literal {{INSTALL_DIR}} into a command. Asserted by name, not just by the summary count.
    const out = run(['--skill', 'placeholder-skill'])
    expect(out).toMatch(/1\s+placeholder rendering only \(correct\)/)
    expect(out).not.toMatch(/two-sided|template LAGS|LIVE LOST/)
  })

  it('does NOT report de-personalisation as drift', () => {
    // The other dangerous direction: "reconciling" this writes the owner's name into a template that
    // strangers install.
    const out = run(['--skill', 'owner-skill'])
    expect(out).toMatch(/1\s+de-personalisation only \(correct\)/)
    expect(out).not.toMatch(/two-sided|template LAGS|LIVE LOST/)
  })

  it('reports nothing at all for byte-identical files', () => {
    const out = run(['--skill', 'identical-skill'])
    expect(out).toMatch(/REAL DRIFT:\n\s+0\s+\(none\)/)
  })

  it('separates the three real classes instead of lumping them together', () => {
    // Direction matters: "template LAGS" is a safe sync, "LIVE LOST" and "two-sided" need a human.
    // A tool that called all three "different" would make the safe subset unfindable.
    expect(run(['--skill', 'lagging-skill'])).toMatch(/1\s+template LAGS/)
    expect(run(['--skill', 'live-lost-skill'])).toMatch(/1\s+LIVE LOST content/)
    expect(run(['--skill', 'two-sided-skill'])).toMatch(/1\s+two-sided/)
  })

  it('names the differing lines and which side they are on', () => {
    // A count alone cannot be acted on. The per-skill mode has to say WHAT differs and WHERE, or the
    // reconciliation still needs a manual diff and the tool has bought nothing.
    const out = run(['--skill', 'two-sided-skill'])
    expect(out).toMatch(/live-only \| only live/)
    expect(out).toMatch(/tpl-only\s+\| only template/)
  })

  it('sees every template tree, not only seed-skills', () => {
    // seed-fleet-agents/<agent>/.claude/skills is where a NEW AGENT is seeded from; a tool blind to
    // it would report a clean bill while every freshly created agent got a stale skill.
    const agentSkill = join(installDir, 'seed-fleet-agents/qa/.claude/skills/agent-only-skill')
    mkdirSync(agentSkill, { recursive: true })
    writeFileSync(join(agentSkill, 'SKILL.md'), 'old\n')
    mkdirSync(join(liveDir, 'agent-only-skill'), { recursive: true })
    writeFileSync(join(liveDir, 'agent-only-skill/SKILL.md'), 'old\nnew live line\n')
    const out = run(['--skill', 'agent-only-skill'])
    expect(out).toMatch(/1\s+template LAGS/)
    expect(out).toMatch(/seed-fleet-agents\/qa\/agent-only-skill/)
  })
})

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
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

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

describe('placeholder-count regression (card d4412070, bf67711e follow-up: embedded-pg-e2e-runner incident)', () => {
  // Each test gets its OWN fresh git repo -- these mutate committed state (add/commit), and sharing
  // one repo across tests in sequence would make each test's outcome depend on execution order.
  let gitRoot: string
  let gitInstallDir: string
  let gitLiveDir: string

  beforeEach(() => {
    gitRoot = mkdtempSync(join(tmpdir(), 'driftmap-git-'))
    gitInstallDir = join(gitRoot, 'install')
    gitLiveDir = join(gitRoot, 'live')
    mkdirSync(join(gitInstallDir, 'seed-skills'), { recursive: true })
    mkdirSync(gitLiveDir, { recursive: true })
    writeFileSync(join(gitInstallDir, '.env'), 'OWNER_NAME=Peti\n')
    git(['init', '-q'], gitInstallDir)
    git(['config', 'user.email', 'test@test.local'], gitInstallDir)
    git(['config', 'user.name', 'test'], gitInstallDir)
  })

  afterEach(() => {
    rmSync(gitRoot, { recursive: true, force: true })
  })

  function commitAll(message: string): void {
    git(['add', '-A'], gitInstallDir)
    git(['commit', '-q', '-m', message], gitInstallDir)
  }

  function runGit(args: string[] = []): string {
    return execFileSync('python3', [TOOL, ...args], {
      encoding: 'utf8',
      env: { ...process.env, INSTALL_DIR: gitInstallDir, SKILLS_DIR: gitLiveDir },
    })
  }

  it('the incident itself: a whole-file copy that flattens a placeholder is caught', () => {
    // Reproduces the actual bf67711e-day bug: {{INSTALL_DIR}} overwritten with a literal absolute
    // path by careless whole-file copy. The main classifier alone would call this correct (it
    // renders before comparing) -- this is the check that exists BECAUSE that happened for real.
    const tplPath = join(gitInstallDir, 'seed-skills', 'embedded-pg-e2e-runner', 'SKILL.md')
    mkdirSync(join(gitInstallDir, 'seed-skills', 'embedded-pg-e2e-runner'), { recursive: true })
    writeFileSync(tplPath, 'run at {{INSTALL_DIR}}/store/x.sh with port {{WEB_PORT}}\n')
    commitAll('initial')
    writeFileSync(tplPath, `run at ${gitInstallDir}/store/x.sh with port 3420\n`)
    const out = runGit()
    expect(out).toMatch(/embedded-pg-e2e-runner\/SKILL\.md: 2 -> 0/)
  })

  it('an unrelated content edit that keeps both placeholders is NOT flagged', () => {
    const tplPath = join(gitInstallDir, 'seed-skills', 'embedded-pg-e2e-runner', 'SKILL.md')
    mkdirSync(join(gitInstallDir, 'seed-skills', 'embedded-pg-e2e-runner'), { recursive: true })
    writeFileSync(tplPath, 'run at {{INSTALL_DIR}}/store/x.sh with port {{WEB_PORT}}\n')
    commitAll('initial')
    writeFileSync(tplPath, 'run at {{INSTALL_DIR}}/store/x.sh with port {{WEB_PORT}} -- extra line\n')
    const out = runGit()
    expect(out).toMatch(/PLACEHOLDER-COUNT REGRESSIONS[^\n]*\n\s+\(none\)/)
  })

  it('a brand-new untracked template file has nothing to regress FROM, so it is not flagged', () => {
    // No initial commit at all here: the file is new relative to HEAD (there is no HEAD).
    mkdirSync(join(gitInstallDir, 'seed-skills', 'new-skill'), { recursive: true })
    writeFileSync(join(gitInstallDir, 'seed-skills', 'new-skill', 'SKILL.md'), 'no placeholders here\n')
    const out = runGit()
    expect(out).not.toMatch(/new-skill/)
  })

  it('--skill filters the regression list to just that skill', () => {
    mkdirSync(join(gitInstallDir, 'seed-skills', 'embedded-pg-e2e-runner'), { recursive: true })
    mkdirSync(join(gitInstallDir, 'seed-skills', 'other-skill'), { recursive: true })
    writeFileSync(
      join(gitInstallDir, 'seed-skills', 'embedded-pg-e2e-runner', 'SKILL.md'),
      '{{INSTALL_DIR}} and {{WEB_PORT}}\n',
    )
    writeFileSync(join(gitInstallDir, 'seed-skills', 'other-skill', 'SKILL.md'), '{{INSTALL_DIR}}\n')
    commitAll('initial')
    // Flatten BOTH after the commit -- both are real regressions; --skill must show only one.
    writeFileSync(
      join(gitInstallDir, 'seed-skills', 'embedded-pg-e2e-runner', 'SKILL.md'),
      'flattened, no placeholders left\n',
    )
    writeFileSync(join(gitInstallDir, 'seed-skills', 'other-skill', 'SKILL.md'), 'flattened too\n')
    const out = runGit(['--skill', 'embedded-pg-e2e-runner'])
    expect(out).toMatch(/embedded-pg-e2e-runner\/SKILL\.md/)
    expect(out).not.toMatch(/other-skill/)
  })
})

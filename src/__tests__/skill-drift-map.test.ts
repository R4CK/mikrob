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

/** Write one skill file into a PER-AGENT template tree and the live tree that tree installs to.
 * seed-fleet-agents/<agent>/ is `cp -r`d into agents/<agent>/ (install-linux.sh:1534), so the live
 * counterpart is agents/<agent>/.claude/skills -- NOT the global set `pair()` above writes to. */
function agentPair(agent: string, skill: string, template: string, live: string): void {
  const t = join(installDir, 'seed-fleet-agents', agent, '.claude/skills', skill)
  const l = join(installDir, 'agents', agent, '.claude/skills', skill)
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
    //
    // The live half of this fixture used to sit in liveDir (the GLOBAL skills dir). That was the
    // defect this test could not see, because it was built into the fixture: a per-agent seed
    // installs into agents/<agent>/.claude/skills (install-linux.sh:1534), never into the global
    // set. The assertion below is unchanged -- only the fixture moved to where the file really goes.
    agentPair('qa', 'agent-only-skill', 'old\n', 'old\nnew live line\n')
    const out = run(['--skill', 'agent-only-skill'])
    expect(out).toMatch(/1\s+template LAGS/)
    expect(out).toMatch(/seed-fleet-agents\/qa\/agent-only-skill/)
  })
})

// Card bfc028b4. Every template tree is paired with the live copy it actually installs to, and
// getting that pairing wrong is silent -- the tool kept reporting, the reports were just about the
// wrong two files. Measured on the real install before the fix: 17 TEMPLATE-ONLY skills of which 1
// was real, and two LIVE LOST content rows that never appeared at all.
describe('each template tree is paired with ITS OWN live root (card bfc028b4)', () => {
  it('THE DEFECT: a per-agent skill matching its OWN agent is clean, even when the global copy differs', () => {
    // The shape that misled a real sync: identical to agents/<a>/..., different from ~/.claude/skills.
    // Against the global root this reads as drift and invites a "fix" the agent will never see.
    agentPair('backend', 'paired-skill', 'the one true line\n', 'the one true line\n')
    mkdirSync(join(liveDir, 'paired-skill'), { recursive: true })
    writeFileSync(join(liveDir, 'paired-skill/SKILL.md'), 'a completely different global line\n')
    const out = run(['--skill', 'paired-skill'])
    expect(out, 'the per-agent pair is byte-identical, so nothing about it is drift')
      .not.toMatch(/seed-fleet-agents\/backend\/paired-skill/)
  })

  it('a skill installed ONLY per-agent is not TEMPLATE-ONLY just because the global set lacks it', () => {
    // 16 of the 17 TEMPLATE-ONLY rows on the real install were exactly this.
    agentPair('cybered', 'per-agent-only-skill', 'body\n', 'body\n')
    const out = run(['--skill', 'per-agent-only-skill'])
    expect(out).not.toMatch(/TEMPLATE-ONLY skill/)
  })

  it('CONTROL: a skill missing from the agent\'s OWN live tree is still TEMPLATE-ONLY', () => {
    // Without this the fix could have "passed" by silencing the category rather than aiming it.
    const seed = join(installDir, 'seed-fleet-agents/cybered/.claude/skills/genuinely-absent')
    mkdirSync(seed, { recursive: true })
    writeFileSync(join(seed, 'SKILL.md'), 'body\n')
    // cybered HAS a live tree (created by the case above) -- the skill just is not in it.
    const out = run(['--skill', 'genuinely-absent'])
    expect(out).toMatch(/1\s+TEMPLATE-ONLY skill/)
  })

  it('an agent seeded but never installed reports ONCE, not once per skill', () => {
    // Per-skill reporting is what made the old count unreadable: the signal drowned in its own
    // repetition. Three skills, one row.
    for (const s of ['a-skill', 'b-skill', 'c-skill']) {
      const seed = join(installDir, 'seed-fleet-agents/notinstalled/.claude/skills', s)
      mkdirSync(seed, { recursive: true })
      writeFileSync(join(seed, 'SKILL.md'), 'body\n')
    }
    const out = run(['--full'])
    const rows = out.split('\n').filter((l) => l.includes('LIVE TREE ABSENT'))
    expect(rows.filter((l) => l.includes('notinstalled'))).toHaveLength(1)
  })

  it('the installer\'s __MARVEEN_INSTALL_DIR__ sentinel renders, it is not drift', () => {
    // seed-fleet-agents/ uses a SECOND placeholder convention (install-linux.sh:1546 sed) that the
    // tool did not know about, so every sentinel-bearing line read as a difference.
    agentPair('marketing', 'sentinel-skill',
      'run __MARVEEN_INSTALL_DIR__/store/x.sh\n', `run ${installDir}/store/x.sh\n`)
    const out = run(['--skill', 'sentinel-skill'])
    expect(out).toMatch(/1\s+placeholder rendering only \(correct\)/)
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

  it('a flattened __MARVEEN_INSTALL_DIR__ is the same corruption and is counted too (card bfc028b4)', () => {
    // seed-fleet-agents/ ships a SECOND placeholder convention, rewritten by sed at
    // install-linux.sh:1546. Counting only {{NAME}} left the whole per-agent tree unwatched for
    // exactly the flattening this section exists to catch. Measured: without the widened pattern
    // this case is the only one of the five bfc028b4 cases that stays green, so it is the one that
    // makes that half of the change load-bearing rather than decorative.
    const dir = join(gitInstallDir, 'seed-fleet-agents/backend/.claude/skills/sentinel-skill')
    mkdirSync(dir, { recursive: true })
    const tplPath = join(dir, 'SKILL.md')
    writeFileSync(tplPath, 'run __MARVEEN_INSTALL_DIR__/store/x.sh\n')
    commitAll('initial')
    writeFileSync(tplPath, `run ${gitInstallDir}/store/x.sh\n`)
    const out = runGit()
    expect(out).toMatch(/sentinel-skill\/SKILL\.md: 1 -> 0/)
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

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Card ca593869 (Cybersec finding on 2a653b4b): mocks makeLazyBinResolver directly (not
// resolveFromPath) because background-tasks.ts imports and calls makeLazyBinResolver itself --
// mocking resolveFromPath alone would not intercept platform.ts's OWN internal call to it from
// inside makeLazyBinResolver's closure (a same-module call is not redirected by vi.mock's
// export-level override the way a cross-module import is).
//
// vi.hoisted: the mock factory below runs before this file's own top-level code, so the flag it
// reads must be created through vi.hoisted rather than a plain `let`, which would not exist yet.
const claudeResolveState = vi.hoisted(() => ({ shouldThrow: true, binPath: '/bin/true' }))

// Card a5ef4771: records the `env` passed to every `tmux new-session` call so a test can assert
// the dangerous channel vars never reach it, WITHOUT changing behaviour for the existing tests in
// this file -- every call (including non-'new-session' ones, and tmuxBin()'s own `which` lookup
// via execSync, which this does not touch) still runs the real implementation.
const execFileCallLog = vi.hoisted(() => ({
  newSessionEnvs: [] as (NodeJS.ProcessEnv | undefined)[],
  newSessionArgs: [] as (readonly string[])[],
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (file: string, args?: readonly string[], options?: unknown) => {
      if (args?.[0] === 'new-session') {
        const env = (options as { env?: NodeJS.ProcessEnv } | undefined)?.env
        execFileCallLog.newSessionEnvs.push(env)
        execFileCallLog.newSessionArgs.push(args)
      }
      return actual.execFileSync(file, args as string[], options as Parameters<typeof actual.execFileSync>[2])
    },
  }
})

vi.mock('../platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform.js')>()
  return {
    ...actual,
    makeLazyBinResolver: (name: string) => {
      if (name !== 'claude') return actual.makeLazyBinResolver(name)
      // The flag is checked INSIDE the closure, at CALL time (spawnBackgroundTask invokes
      // claudeBin() well after this factory ran) -- not here, at makeLazyBinResolver('claude')
      // call time. background-tasks.ts creates claudeBin ONCE at its own module top level, and
      // ESM module caching means that module (and this closure) is only evaluated once across a
      // test file's dynamic imports, so a flag read here would freeze at whatever value it had
      // during the FIRST test to import the module -- exactly the bug this comment exists to
      // prevent a future edit from reintroducing.
      // The resolvable branch returns an inert binary, never the real `claude`. The spawn below
      // runs through the SHARED tmux server, whose environment carries the main agent's
      // TELEGRAM_STATE_DIR, from a checkout whose project settings enable the telegram plugin.
      // A real `claude -p` there started its own poller, which SIGTERMs the main agent's poller
      // through bot.pid: every fleet-test run knocked MikroB off Telegram (53 restarts on
      // 2026-09-25). This test only needs the resolver to succeed, not a real CLI.
      return () => {
        if (claudeResolveState.shouldThrow) throw new Error('claude: command not found (PATH gap simulated for this test)')
        return claudeResolveState.binPath
      }
    },
  }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

describe('background_tasks schema and CRUD', () => {
  let db: ReturnType<typeof Database>

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE background_tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','timeout')),
        tmux_session TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        output TEXT
      )
    `)
    db.exec(`CREATE INDEX idx_bg_tasks_agent ON background_tasks(agent_id, status)`)
  })

  it('inserts a running task', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('ABCD1234', 'marveen', 'test prompt', 'running', 'bg-ABCD1234', now)

    const row = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get('ABCD1234') as any
    expect(row.agent_id).toBe('marveen')
    expect(row.status).toBe('running')
    expect(row.prompt).toBe('test prompt')
    expect(row.tmux_session).toBe('bg-ABCD1234')
    expect(row.finished_at).toBeNull()
  })

  it('finishes a task with done status', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('AAAA1111', 'samu', 'build something', 'running', 'bg-AAAA1111', now)

    db.prepare('UPDATE background_tasks SET status = ?, finished_at = ?, output = ? WHERE id = ?')
      .run('done', now + 100, 'Build succeeded', 'AAAA1111')

    const row = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get('AAAA1111') as any
    expect(row.status).toBe('done')
    expect(row.output).toBe('Build succeeded')
    expect(row.finished_at).toBe(now + 100)
  })

  it('rejects invalid status', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(() => {
      db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)')
        .run('BAD10000', 'test', 'bad', 'invalid_status', now)
    }).toThrow()
  })

  it('counts running tasks per agent', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('A1000001', 'marveen', 'p1', 'running', now)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('A2000002', 'marveen', 'p2', 'running', now)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('A3000003', 'marveen', 'p3', 'done', now)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('A4000004', 'samu', 'p4', 'running', now)

    const count = (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get('marveen') as any).c
    expect(count).toBe(2)

    const samuCount = (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get('samu') as any).c
    expect(samuCount).toBe(1)
  })

  it('lists tasks with optional agent filter', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('B1000001', 'marveen', 'p1', 'running', now)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('B2000002', 'samu', 'p2', 'done', now)

    const all = db.prepare('SELECT * FROM background_tasks ORDER BY started_at DESC').all()
    expect(all).toHaveLength(2)

    const running = db.prepare("SELECT * FROM background_tasks WHERE status = 'running'").all()
    expect(running).toHaveLength(1)

    const marveenOnly = db.prepare("SELECT * FROM background_tasks WHERE agent_id = ? AND status = 'running'").all('marveen')
    expect(marveenOnly).toHaveLength(1)
  })

  it('supports timeout status', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('T1000001', 'test', 'slow task', 'running', now)
    db.prepare('UPDATE background_tasks SET status = ?, finished_at = ?, output = ? WHERE id = ?')
      .run('timeout', now + 1800, '(timeout after 30 min)', 'T1000001')

    const row = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get('T1000001') as any
    expect(row.status).toBe('timeout')
  })

  it('atomic create respects concurrency limit', () => {
    const now = Math.floor(Date.now() / 1000)
    const maxConcurrent = 3

    const atomicCreate = db.transaction((id: string, agentId: string, prompt: string, session: string) => {
      const running = (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get(agentId) as any).c
      if (running >= maxConcurrent) return null
      db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, agentId, prompt, 'running', session, now)
      return { id }
    })

    expect(atomicCreate('C1000001', 'agent1', 'p1', 'bg-C1000001')).toBeTruthy()
    expect(atomicCreate('C2000002', 'agent1', 'p2', 'bg-C2000002')).toBeTruthy()
    expect(atomicCreate('C3000003', 'agent1', 'p3', 'bg-C3000003')).toBeTruthy()
    expect(atomicCreate('C4000004', 'agent1', 'p4', 'bg-C4000004')).toBeNull()

    expect(atomicCreate('C5000005', 'agent2', 'p5', 'bg-C5000005')).toBeTruthy()
  })

  it('marks orphaned tasks as failed', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('OR000001', 'marveen', 'orphan', 'running', 'bg-OR000001', now - 3600)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('OR000002', 'samu', 'also orphan', 'running', 'bg-OR000002', now - 1800)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('OR000003', 'marveen', 'already done', 'done', now - 7200, now - 3600)

    const finishNow = Math.floor(Date.now() / 1000)
    const info = db.prepare("UPDATE background_tasks SET status = 'failed', finished_at = ?, output = '(orphaned on restart)' WHERE status = 'running'")
      .run(finishNow)
    expect(info.changes).toBe(2)

    const tasks = db.prepare('SELECT * FROM background_tasks ORDER BY id').all() as any[]
    expect(tasks.find((t: any) => t.id === 'OR000001').status).toBe('failed')
    expect(tasks.find((t: any) => t.id === 'OR000002').status).toBe('failed')
    expect(tasks.find((t: any) => t.id === 'OR000003').status).toBe('done')
  })

  it('DELETE captures output before kill (order test)', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('DE000001', 'marveen', 'cancel me', 'running', 'bg-DE000001', now)

    const task = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get('DE000001') as any
    expect(task.status).toBe('running')
    expect(task.tmux_session).toBe('bg-DE000001')

    db.prepare('UPDATE background_tasks SET status = ?, finished_at = ?, output = ? WHERE id = ?')
      .run('failed', now + 1, 'captured output before kill', 'DE000001')

    const cancelled = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get('DE000001') as any
    expect(cancelled.status).toBe('failed')
    expect(cancelled.output).toBe('captured output before kill')
  })
})

describe('background-tasks route ID regex', () => {
  it('matches exactly 8 hex chars', () => {
    const re = /^\/api\/background-tasks\/([A-F0-9]{8})$/
    expect(re.test('/api/background-tasks/ABCD1234')).toBe(true)
    expect(re.test('/api/background-tasks/12345678')).toBe(true)
    expect(re.test('/api/background-tasks/ABCD123')).toBe(false)
    expect(re.test('/api/background-tasks/ABCD12345')).toBe(false)
    expect(re.test('/api/background-tasks/abcd1234')).toBe(false)
    expect(re.test('/api/background-tasks/')).toBe(false)
  })
})

// Card ca593869: claudeBin() used to resolve AFTER createBackgroundTaskAtomic() had already
// inserted a 'running' row and BEFORE the try/catch that cleans up a spawn failure -- so a PATH
// gap threw straight out of spawnBackgroundTask, leaving the row stuck at 'running' forever
// (neither pollUntilDone nor checkAndFinalize clean it up; only web.ts's startup sweep does).
// Three such failures exhausted the agent's MAX_CONCURRENT=3 slots with zero tasks actually
// running, until a dashboard restart.
describe('spawnBackgroundTask: a PATH gap must not leave an orphaned running row (card ca593869)', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db.js')
    initDatabase(':memory:')
  })

  it('claudeBin() resolution failure throws BEFORE any row is inserted', async () => {
    claudeResolveState.shouldThrow = true
    const { spawnBackgroundTask } = await import('../web/routes/background-tasks.js')
    const { getRunningBackgroundTasks } = await import('../db.js')

    expect(() => spawnBackgroundTask('marveen', 'test prompt')).toThrow(/claude/)
    expect(getRunningBackgroundTasks()).toEqual([])
  })

  it('CONTROL: a task with a resolvable binary DOES reach the insert (unlike the PATH-gap case above)', async () => {
    claudeResolveState.shouldThrow = false
    const { spawnBackgroundTask } = await import('../web/routes/background-tasks.js')
    const { getBackgroundTasks } = await import('../db.js')

    spawnBackgroundTask('samu', 'a normal prompt')
    // includeFinished=true: the real tmux spawn inside the try/catch may itself fail in this
    // sandboxed test environment, which synchronously marks the row 'failed' -- that path is
    // already covered by the existing catch-block behavior, not what this test pins. What
    // matters here is that the row EXISTS at all, proving the insert was reached this time.
    expect(getBackgroundTasks('samu', true).length).toBe(1)
  })
})

// Card a5ef4771 (follow-up to 9e2039c0, which only fixed the test that reproduced this on the
// shared tmux server): spawnBackgroundTask used to hand `tmux new-session` `{ ...process.env }`
// verbatim. A bg-task's cwd is a marveen checkout, whose .claude/settings.json turns the channel
// plugin on -- if process.env ever carries the main agent's TELEGRAM_STATE_DIR (or a sibling
// channel var), the plugin inside that bg-task session sees bot.pid pointing at the main agent's
// poller and SIGTERMs it as 'stale' (measured 2026-09-25: 53 Telegram-plugin deaths in one day).
describe('spawnBackgroundTask: channel env vars must never reach `tmux new-session` (card a5ef4771)', () => {
  const plantedVars = {
    TELEGRAM_BOT_TOKEN: '123456:planted-token',
    SLACK_BOT_TOKEN: 'xoxb-planted',
    SLACK_APP_TOKEN: 'xapp-planted',
    DISCORD_BOT_TOKEN: 'planted-discord-token',
    TELEGRAM_STATE_DIR: '/home/neon/marveen/.claude/channels/telegram',
    SLACK_STATE_DIR: '/planted/slack-state',
    DISCORD_STATE_DIR: '/planted/discord-state',
    GOOGLECHAT_STATE_DIR: '/planted/googlechat-state',
    TEAMS_STATE_DIR: '/planted/teams-state',
  }
  let savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    const { initDatabase } = await import('../db.js')
    initDatabase(':memory:')
    claudeResolveState.shouldThrow = false
    execFileCallLog.newSessionEnvs.length = 0
    execFileCallLog.newSessionArgs.length = 0
    savedEnv = {}
    for (const key of Object.keys(plantedVars)) {
      savedEnv[key] = process.env[key]
      process.env[key] = (plantedVars as Record<string, string>)[key]
    }
  })

  afterEach(() => {
    for (const key of Object.keys(plantedVars)) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it('strips every channel bot-token and state-dir var, even though the dashboard process has them set', async () => {
    const { spawnBackgroundTask } = await import('../web/routes/background-tasks.js')

    spawnBackgroundTask('marveen', 'another prompt')

    expect(execFileCallLog.newSessionEnvs.length).toBe(1)
    const spawnedEnv = execFileCallLog.newSessionEnvs[0]
    for (const key of Object.keys(plantedVars)) {
      expect(spawnedEnv?.[key]).toBeUndefined()
    }
  })

  it('leaves unrelated env vars (PATH) untouched', async () => {
    const { spawnBackgroundTask } = await import('../web/routes/background-tasks.js')

    spawnBackgroundTask('marveen', 'yet another prompt')

    const spawnedEnv = execFileCallLog.newSessionEnvs[0]
    expect(spawnedEnv?.PATH).toBe(process.env.PATH)
  })

  // Card 99ade79b (MEDIUM): the prompt no longer rides in this `env` object at all -- it is
  // written to a 0600 temp file and only the file's PATH crosses into the tmux client's argv/env.
  it('never puts the raw prompt into the `env` object passed to execFileSync', async () => {
    const { spawnBackgroundTask } = await import('../web/routes/background-tasks.js')

    spawnBackgroundTask('marveen', 'a prompt that must not leak into env')

    const spawnedEnv = execFileCallLog.newSessionEnvs[0]
    expect(spawnedEnv?.BG_PROMPT).toBeUndefined()
    expect(JSON.stringify(spawnedEnv)).not.toContain('a prompt that must not leak into env')
  })

  // Card 99ade79b (MEDIUM, self-audit 2026-11-20): the prompt used to be spelled directly into
  // this `execFileSync` call's own argv (`-e BG_PROMPT=${prompt}`) -- readable by any local user
  // via /proc/<pid>/cmdline of the tmux CLIENT process while it runs. Only a temp-file PATH may
  // appear in argv now, never the prompt text.
  it('never puts the raw prompt text into the tmux client argv (card 99ade79b)', async () => {
    const { spawnBackgroundTask } = await import('../web/routes/background-tasks.js')
    const distinctivePrompt = 'ARGVLEAKPIN-distinctive-prompt-marker-with spaces'

    spawnBackgroundTask('marveen', distinctivePrompt)

    expect(execFileCallLog.newSessionArgs.length).toBe(1)
    const args = execFileCallLog.newSessionArgs[0] ?? []
    for (const arg of args) {
      expect(arg).not.toContain(distinctivePrompt)
    }
    // The file-path pointer IS expected to appear somewhere in argv (the `-e BG_PROMPT_FILE=...`
    // pair) -- a vacuous pass (e.g. the prompt never reaching this call at all) would also satisfy
    // the loop above, so pin that the mechanism is actually present.
    expect(args.some((a) => a.includes('BG_PROMPT_FILE='))).toBe(true)
  })
})

// Card 68eaeb93 (WhiteHat2 a5ef4771 gate finding, comment 19787): on THIS process's own already-
// running tmux server (every test above has already created and torn down several sessions on
// it by the time this describe runs), a new session's pane used to inherit the server's "global
// environment" -- captured once when the server first started -- not the `env` option passed to
// this `tmux new-session` client call. BG_PROMPT therefore arrived EMPTY in the pane every time
// except when this was the very first session on a cold server (masking the bug in a one-off
// manual test). Repro: point the mocked claude resolver at a real, tiny shell script, run
// spawnBackgroundTask through the REAL tmux binary (no `claude` process ever starts -- only
// `/bin/true`-class stand-ins, same convention as the describe blocks above), and read back what
// the stand-in actually received.
//
// Card 99ade79b round 2 (CYBERSEC NO-GO 34703 F1/F2): the prompt no longer reaches the pane via
// BG_PROMPT at all (env AND argv leaks closed) -- it is piped to the stand-in's STDIN instead. The
// stand-in below records both its own argv (must never contain the prompt text -- this is the
// NO-GO's F1, one level past the tmux-client argv the test at "card 99ade79b" above already
// covers) and its stdin (must be exactly the prompt -- this is the "pane still receives it" half
// of the card's own acceptance criterion).
describe('spawnBackgroundTask: prompt reaches the pane via stdin, never argv or env (card 68eaeb93 + 99ade79b round 2)', () => {
  let outFile: string
  let argvFile: string
  let envFile: string
  let sessionName: string | undefined

  beforeEach(async () => {
    const { initDatabase } = await import('../db.js')
    initDatabase(':memory:')
    claudeResolveState.shouldThrow = false
    const dir = mkdtempSync(join(tmpdir(), 'bg-prompt-repro-'))
    const scriptPath = join(dir, 'fake-claude.sh')
    outFile = join(dir, 'out.txt')
    argvFile = join(dir, 'argv.txt')
    envFile = join(dir, 'env.txt')
    writeFileSync(
      scriptPath,
      `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argvFile)}\ncat > ${JSON.stringify(outFile)}\nenv > ${JSON.stringify(envFile)}\n`,
      { mode: 0o700 }
    )
    claudeResolveState.binPath = scriptPath
  })

  afterEach(() => {
    claudeResolveState.binPath = '/bin/true'
    claudeResolveState.shouldThrow = true
    if (sessionName) {
      try { execFileSync('tmux', ['kill-session', '-t', sessionName]) } catch { /* already gone */ }
    }
    sessionName = undefined
  })

  it('a prompt reaches the pane via stdin even though this process already has a running tmux server, and never appears in the stand-in\'s own argv', async () => {
    const { spawnBackgroundTask } = await import('../web/routes/background-tasks.js')
    const prompt = 'repro prompt for card 68eaeb93, with spaces'

    const task = spawnBackgroundTask('marveen', prompt)
    if ('error' in task) throw new Error(task.error)
    sessionName = task.tmux_session ?? undefined

    const deadline = Date.now() + 5000
    let seen = ''
    while (Date.now() < deadline) {
      if (existsSync(outFile)) {
        seen = readFileSync(outFile, 'utf-8')
        if (seen) break
      }
      await new Promise((r) => setTimeout(r, 100))
    }

    expect(seen).toBe(prompt)
    const argvSeen = existsSync(argvFile) ? readFileSync(argvFile, 'utf-8') : ''
    expect(argvSeen).not.toContain(prompt)
    // CYBERSEC NO-GO 34703 F2: the round-1 fix introduced `export BG_PROMPT=...` in the pane,
    // putting the prompt into the claude process's own environ too. Round 2 drops that export.
    const envSeen = existsSync(envFile) ? readFileSync(envFile, 'utf-8') : ''
    expect(envSeen).not.toContain(prompt)
    expect(envSeen).not.toMatch(/^BG_PROMPT=/m)
  }, 10_000)
})

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import Database from 'better-sqlite3'

// Card ca593869 (Cybersec finding on 2a653b4b): mocks makeLazyBinResolver directly (not
// resolveFromPath) because background-tasks.ts imports and calls makeLazyBinResolver itself --
// mocking resolveFromPath alone would not intercept platform.ts's OWN internal call to it from
// inside makeLazyBinResolver's closure (a same-module call is not redirected by vi.mock's
// export-level override the way a cross-module import is).
//
// vi.hoisted: the mock factory below runs before this file's own top-level code, so the flag it
// reads must be created through vi.hoisted rather than a plain `let`, which would not exist yet.
const claudeResolveState = vi.hoisted(() => ({ shouldThrow: true }))
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
      const real = actual.makeLazyBinResolver('claude')
      return () => {
        if (claudeResolveState.shouldThrow) throw new Error('claude: command not found (PATH gap simulated for this test)')
        return real()
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

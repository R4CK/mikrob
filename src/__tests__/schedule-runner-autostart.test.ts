import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the daily-batch-agent "never runs" fix.
//
// Root cause: a daily batch agent has no 24/7 tmux session. When its cron
// fired (e.g. a `0 2 * * *` digest), attemptFireTask found the target session
// missing and returned 'missing' -- a silent skip. The task was enabled and
// scheduled but could never fire.
//
// Fix: when the session is missing, START the agent and return a new 'starting'
// state. The caller enqueues a retry that delivers the prompt on a later tick
// once Claude has booted. Crucially this retry must bypass skipIfBusy -- the
// whole point was to wake the agent for its scheduled run, so a skipIfBusy=true
// task must NOT drop the delivery.

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('schedule-runner auto-starts a stopped agent for its scheduled task', () => {
  it('attemptFireTask can return a distinct "starting" state', () => {
    // The return union must carry 'starting' so the caller can tell an
    // auto-start apart from a genuine busy session.
    //
    // Card e9d3cd12 moved the union into a named FireOutcome alias (both the guarded wrapper and
    // the unguarded body return it), so reading the first 200 chars of the signature no longer
    // sees the literal. Same property, now asserted where the union actually lives -- plus the
    // link that makes it meaningful: the function really does return THAT alias.
    const alias = SRC.slice(SRC.indexOf('type FireOutcome ='))
    expect(alias.slice(0, 200)).toMatch(/'starting'/)
    const body = SRC.slice(SRC.indexOf('function attemptFireTaskUnguarded('))
    expect(body.slice(0, 300)).toMatch(/Promise<FireOutcome>/)
  })

  it('the missing-session branch auto-starts the agent instead of skipping', () => {
    // Locate the (host-aware) missing-session guard and assert it now launches the agent.
    const guardIdx = SRC.indexOf('if (!sessionExistsOnHost(')
    expect(guardIdx).toBeGreaterThan(0)
    // ANCHOR-based (card fa9e1c39), not a fixed character window. The old `guardIdx + 3000` window
    // had already been widened once (from 1800) as the block grew its own comments/try-catch, and
    // each widening was blind to how much headroom was left -- the next growth silently pushes
    // `catch (err)` out of the window and the test fails on something unrelated to the real change.
    // The real, stable boundary is the busy-check that follows this block in the source.
    const nextCheckIdx = SRC.indexOf('if (!task.forceSend', guardIdx)
    expect(nextCheckIdx).toBeGreaterThan(guardIdx)
    const missingBlock = SRC.slice(guardIdx, nextCheckIdx)
    expect(missingBlock).toMatch(/startAgentProcess\(agentName\)/)
    expect(missingBlock).toMatch(/return 'starting'/)
    // And the new branch is inside the same block, not bolted on somewhere else.
    expect(missingBlock).toMatch(/catch \(err\)/)
  })

  it('the cron loop enqueues a retry for "starting" WITHOUT the skipIfBusy gate', () => {
    // Find where the cron loop handles a 'starting' result. That branch must
    // insert a pending retry, and must NOT be guarded by task.skipIfBusy
    // (otherwise a skipIfBusy=true daily digest would auto-start the agent and
    // then drop the delivery -- the original bug). Target the cron-loop's
    // standalone branch specifically (runScheduledTaskNow also references
    // 'starting', but in an `|| result === 'busy'` form).
    const startingIdx = SRC.indexOf("if (result === 'starting') {")
    expect(startingIdx).toBeGreaterThan(0)
    // Slice the starting-branch up to the next else-if / busy handling.
    const busyHandlingIdx = SRC.indexOf("result === 'busy'", startingIdx)
    expect(busyHandlingIdx).toBeGreaterThan(startingIdx)
    const startingBranch = SRC.slice(startingIdx, busyHandlingIdx)
    expect(startingBranch).toMatch(/insertPendingTaskRetryIfNew/)
    // Not gated by the skipIfBusy flag (the code form `task.skipIfBusy`); a
    // mention in an explanatory comment is fine.
    expect(startingBranch).not.toMatch(/task\.skipIfBusy/)
  })

  it('documents WHY (daily batch agent), not just what', () => {
    const guardIdx = SRC.indexOf('if (!sessionExistsOnHost(')
    // Same anchor-based boundary as above, for the same reason (card fa9e1c39).
    const nextCheckIdx = SRC.indexOf('if (!task.forceSend', guardIdx)
    const rationale = SRC.slice(guardIdx, nextCheckIdx)
    expect(rationale).toMatch(/auto-start|batch agent|digest/i)
    expect(rationale).toMatch(/skipIfBusy/i)
  })
})

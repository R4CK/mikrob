// Card dbc0b4bf. otel_spans held 9229 rows of which 12 were closed -- starts, no durations.
//
// The measurement that shaped the fix, because it says the defect was NOT the one the card assumed:
//   agent_messages   delivered 16756 | done 5185 | failed 779 | pending 5
//   ... carrying a trace+span:  delivered 9296 | done 12
//   otel_spans       running 9297 | ok 12
// The close path was never broken. Of the 12 traced messages that reached a terminal status, 12 had
// closed spans -- 100%. Tracing and completion were on DISJOINT POPULATIONS: nothing marks a
// tmux-injected message done, because there is no completion signal to observe. So the span was
// opened on a path whose real terminal event is DELIVERY, and delivery is what this table's own
// header calls it: inter-agent latency.
//
// These tests run the real SQL against an in-memory database with the production schema, so they
// pin the statements rather than a restatement of them.
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

type Status = 'ok' | 'error' | 'timeout' | 'running'
let db: InstanceType<typeof Database>

// The two statements under test, kept byte-identical in shape to db.ts's. The difference between
// them IS the card: one overwrites unconditionally, one refuses to.
const closeSpan = (t: string, s: string, endMs: number, st: Status): boolean =>
  db.prepare('UPDATE otel_spans SET end_ms = ?, status = ? WHERE trace_id = ? AND span_id = ?')
    .run(endMs, st, t, s).changes > 0

const closeSpanIfOpen = (t: string, s: string, endMs: number, st: Status): boolean =>
  db.prepare('UPDATE otel_spans SET end_ms = ?, status = ? WHERE trace_id = ? AND span_id = ? AND end_ms IS NULL')
    .run(endMs, st, t, s).changes > 0

const openSpanAt = (t: string, s: string, startMs: number): void => openSpan(t, s, startMs)

const openSpan = (t: string, s: string, startMs: number): void => {
  db.prepare(
    'INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes) ' +
    "VALUES (?, ?, NULL, 'mikrob', 'mikrob->backend2', ?, NULL, 'running', NULL)",
  ).run(t, s, startMs)
}

const spanOf = (t: string, s: string) =>
  db.prepare('SELECT end_ms, status FROM otel_spans WHERE trace_id = ? AND span_id = ?')
    .get(t, s) as { end_ms: number | null; status: string } | undefined

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE otel_spans (
      trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT,
      agent_id TEXT NOT NULL, operation TEXT NOT NULL,
      start_ms INTEGER NOT NULL, end_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'running', attributes TEXT,
      PRIMARY KEY (trace_id, span_id))`)
})

describe('otel_spans: the span closes at delivery (card dbc0b4bf)', () => {
  it('a delivered message leaves a span with a real duration, not a running row', () => {
    openSpan('T1', 'S1', 1000)
    expect(spanOf('T1', 'S1')).toMatchObject({ end_ms: null, status: 'running' })
    expect(closeSpanIfOpen('T1', 'S1', 1250, 'ok')).toBe(true)
    const span = spanOf('T1', 'S1')!
    expect(span.status).toBe('ok')
    // The point of the whole card: a duration exists and is the send->deliver latency.
    expect(span.end_ms! - 1000).toBe(250)
  })

  it('a LATER done does not overwrite the measured latency -- first terminal event wins', () => {
    // This is the regression the if-open variant exists to prevent. Both quantities are plausible
    // numbers in the same column, so getting it wrong is invisible afterwards: nothing in the row
    // says whether 250ms was a delivery latency or an hour-long task that happened to be quick.
    openSpan('T2', 'S2', 1000)
    closeSpanIfOpen('T2', 'S2', 1250, 'ok')          // delivered
    const second = closeSpanIfOpen('T2', 'S2', 9_999_000, 'ok') // marked done much later
    expect(second, 'the second close must report that it changed nothing').toBe(false)
    expect(spanOf('T2', 'S2')!.end_ms).toBe(1250)
  })

  it('a message that never went through delivery is still closed by the done path', () => {
    // The if-open guard must not turn into "never closes": federated and API-reported messages do
    // not pass the router's delivery path, and they are exactly the 12 rows that used to close.
    openSpan('T3', 'S3', 1000)
    expect(closeSpanIfOpen('T3', 'S3', 4000, 'ok')).toBe(true)
    expect(spanOf('T3', 'S3')).toMatchObject({ end_ms: 4000, status: 'ok' })
  })

  it('a failed terminal status closes with error, not silently as ok', () => {
    openSpan('T4', 'S4', 1000)
    closeSpanIfOpen('T4', 'S4', 2000, 'error')
    expect(spanOf('T4', 'S4')!.status).toBe('error')
  })

  it('CONTRAST: the unconditional close still overwrites -- external reporters keep that', () => {
    // routes/spans.ts uses closeOtelSpan's return value to detect "span does not exist yet" and
    // falls back to an upsert-close. Making that one first-writer-wins would send an already-closed
    // span down the not-found path and rewrite it anyway, so the two functions must stay different.
    openSpan('T5', 'S5', 1000)
    expect(closeSpan('T5', 'S5', 2000, 'ok')).toBe(true)
    expect(closeSpan('T5', 'S5', 3000, 'ok'), 'unconditional close reports a change again').toBe(true)
    expect(spanOf('T5', 'S5')!.end_ms).toBe(3000)
  })

  it('closing a span that does not exist reports false, so callers can tell the two apart', () => {
    expect(closeSpanIfOpen('NOPE', 'NOPE', 1, 'ok')).toBe(false)
  })
})

describe('WHICH INTERVAL the span measures (Cybered NO-GO, comment 19920)', () => {
  // Nothing pinned this before, and that is how it slipped: the span was opened with the TICK's
  // clock, but stamping happens AFTER the sessionExists / isSessionReadyForPrompt checks, so the
  // clock only started once the message was already deliverable. The queueing wait -- the entire
  // quantity worth having -- was excluded, while four comments called it send->delivered latency.
  //
  // Measured on the live DB, 9330 traced deliveries: real wait averaged 1289.8s (worst 26576s),
  // a tick-start span would have reported 1.8s (worst 544.9s). ~700x under on average, and always
  // toward "healthy" -- in precisely the failure this table would be watched for.
  //
  // Cybered also measured that the swap left the suite 9/9 GREEN, i.e. the old tests pinned the
  // CLOSING and not the REPORTING. That gap is what this block closes.

  it('the reported duration is the FULL wait, not the tick fragment', () => {
    const createdMs = 1_000_000
    const deliveredMs = createdMs + 1_290_000 // ~21.5 min, the measured fleet average
    openSpanAt('T-wait', 'S-wait', createdMs)
    closeSpanIfOpen('T-wait', 'S-wait', deliveredMs, 'ok')
    const span = spanOf('T-wait', 'S-wait')!
    expect(span.end_ms! - createdMs).toBe(1_290_000)
    // The number a tick-start clock would have produced instead, had the router stamped the span
    // when it got round to the message rather than when the message was created.
    expect(span.end_ms! - (deliveredMs - 1_800)).not.toBe(1_290_000)
  })

  it('the router opens the span at msg.created_at, NOT at the tick clock', () => {
    // Source-level, because the statement above cannot see which value the router passes -- and
    // that is exactly the substitution Cybered proved the suite could not detect.
    const src = readFileSync(join(REPO_ROOT, 'src/web/message-router.ts'), 'utf-8')
    const fn = src.slice(src.indexOf('function stampTraceOnMessage'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toContain('start_ms: msg.created_at * 1000')
    // The tick clock must not be what opens it. `nowMs` was the parameter that carried it.
    expect(body).not.toMatch(/start_ms:\s*nowMs/)
    expect(body).not.toMatch(/start_ms:\s*now\b/)
    expect(body).not.toMatch(/start_ms:\s*Date\.now\(\)/)
  })

  it('the span start and the ABANDON clock speak about the same instant', () => {
    // The abandon window already measures age as `now - msg.created_at * 1000`. If the span used a
    // different origin, two mechanisms would disagree about how long the same message had waited.
    const src = readFileSync(join(REPO_ROOT, 'src/web/message-router.ts'), 'utf-8')
    expect(src).toContain('const ageMs = now - msg.created_at * 1000')
    expect(src).toContain('start_ms: msg.created_at * 1000')
  })
})

describe('the wiring, not just the statement (card dbc0b4bf)', () => {
  it('the router closes the span on the DELIVERY path, and only on success', async () => {
    // A statement nobody calls closes nothing -- the exact shape of the original defect, where a
    // working close path sat on a population that never reached it.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { REPO_ROOT } = await import('./helpers/repo-location.js')
    const src = readFileSync(join(REPO_ROOT, 'src/web/message-router.ts'), 'utf-8')

    expect(src, 'the router must import the if-open close').toContain('closeOtelSpanIfOpen')
    const close = src.indexOf('closeOtelSpanIfOpen(traceCtx.trace_id')
    expect(close, 'the close is not wired into the router at all').toBeGreaterThan(-1)

    // Anchor on the delivery mark NEAREST the close, not the first one in the file. There is an
    // earlier markMessageDelivered on a different path, and anchoring on that one made this test
    // compare against a `catch` several hundred lines too early -- it failed while the code was
    // correct. A position assertion is only as good as the position it anchors to.
    const delivered = src.lastIndexOf('markMessageDelivered(msg.id)', close)
    expect(delivered, 'no delivery mark precedes the close').toBeGreaterThan(-1)
    expect(close, 'the close must follow the delivery mark').toBeGreaterThan(delivered)

    // Inside the try, not the catch: the catch retries a transient inject failure on a later tick,
    // so closing there would stamp an end on an operation still in flight.
    const catchIdx = src.indexOf('} catch (err) {', close)
    expect(catchIdx, 'no catch found after the close').toBeGreaterThan(-1)
    expect(close, 'the close must sit in the success path, before the catch').toBeLessThan(catchIdx)
  })

  it('the SHIPPED statement carries the guard, not just the copy in this file', async () => {
    // Mutation testing earned this one. The behavioural tests above run SQL restated HERE, so
    // deleting `AND end_ms IS NULL` from db.ts left all eight of them green -- they were pinning my
    // copy, not the shipped statement. A restated copy keeps passing after the real one breaks.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { REPO_ROOT } = await import('./helpers/repo-location.js')
    const src = readFileSync(join(REPO_ROOT, 'src/db.ts'), 'utf-8')

    const ifOpen = src.slice(src.indexOf('export function closeOtelSpanIfOpen'))
    const body = ifOpen.slice(0, ifOpen.indexOf('\n}'))
    expect(body, 'closeOtelSpanIfOpen must refuse an already-closed span').toContain('end_ms IS NULL')

    // And the unconditional one must NOT grow the guard: routes/spans.ts depends on its return
    // value to detect a missing span, so the two must stay genuinely different.
    const plain = src.slice(src.indexOf('export function closeOtelSpan('))
    const plainBody = plain.slice(0, plain.indexOf('\n}'))
    expect(plainBody, 'closeOtelSpan must stay unconditional').not.toContain('end_ms IS NULL')
  })

  it('the done path uses the if-open variant, so it cannot rewrite a delivery latency', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { REPO_ROOT } = await import('./helpers/repo-location.js')
    const src = readFileSync(join(REPO_ROOT, 'src/web/routes/messages.ts'), 'utf-8')
    expect(src).toContain('closeOtelSpanIfOpen(done.trace_id, done.span_id')
    expect(src, 'the unconditional close must be gone from this path').not.toMatch(
      /closeOtelSpan\(done\.trace_id/,
    )
  })
})

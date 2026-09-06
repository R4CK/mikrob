// The stuck-incident write endpoint (card 878cd292, parent f92671df).
//
// WHY AN ENDPOINT AT ALL, rather than a store script the heartbeat prompt calls. The D section is a
// PROMPT, not code, and a log that depends on a prompt-follower remembering to write it is exactly
// as reliable as the kanban prose it replaces. The writer is therefore `redispatch-guard.sh check`
// itself: it already runs on EVERY D-section check and already computes all four fields, so the row
// becomes a by-product of the decision instead of a step that can be skipped. That is code-quality
// rule 6 -- structural protection instead of discipline.
//
// The guard already talks to this dashboard over HTTP (`_curl_get "/api/kanban"`, token in a 0600
// header file, never argv), so this is the same channel it already trusts, with the same auth: /api/*
// is gated centrally in web.ts, so this route inherits the bearer requirement without opting in.
//
// FAIL-OPEN IS THE CALLER'S JOB, NOT THIS FILE'S. This endpoint answers honestly -- 400 on a bad
// body, 500 never swallowed into a fake success. It is the GUARD that must ignore whatever comes
// back, because a logging fault must not change what the guard decided or the exit code it returns.
// Both halves are pinned: the writer's tests here, and the guard's own selftest on its side.
import { recordStuckIncident } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

/** Field validation kept deliberately narrow: this is internal telemetry written by ONE caller we
 *  own, so the useful posture is "refuse a shape that would store a meaningless row", not a general
 *  input-sanitising layer. A bad row here is worse than no row -- it would be counted. */
function badRequest(body: {
  cardId?: unknown
  assignee?: unknown
  verdict?: unknown
  detectedAt?: unknown
  stalledMs?: unknown
}): string | null {
  if (typeof body.cardId !== 'string' || body.cardId.trim() === '') return 'cardId is required'
  if (typeof body.verdict !== 'string' || body.verdict.trim() === '') return 'verdict is required'
  if (body.assignee !== null && body.assignee !== undefined && typeof body.assignee !== 'string') {
    return 'assignee must be a string or null'
  }
  for (const [k, v] of [
    ['detectedAt', body.detectedAt],
    ['stalledMs', body.stalledMs],
  ] as const) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return `${k} must be a non-negative number`
    }
  }
  return null
}

export async function tryHandleStuckIncidents(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/stuck-incidents' && method === 'POST') {
    let data: Record<string, unknown>
    try {
      data = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    } catch {
      // The same posture routes/messages.ts takes on its PUT: a malformed body is the caller's
      // mistake and answers 400, never an unhandled throw in a request handler.
      json(res, { error: 'Invalid JSON body' }, 400)
      return true
    }
    const bad = badRequest(data)
    if (bad !== null) {
      json(res, { error: bad }, 400)
      return true
    }
    // recordStuckIncident never throws and reports `skipped` with a reason -- including the two
    // CALLING-ERROR verdicts, which are deliberately not rows. The reason is passed back so the
    // caller can tell "nothing to log" from "logging broke"; conflating them would make a broken
    // writer look like a quiet one.
    const result = recordStuckIncident({
      cardId: (data['cardId'] as string).trim(),
      assignee: typeof data['assignee'] === 'string' ? data['assignee'] : null,
      verdict: (data['verdict'] as string).trim(),
      detectedAt: data['detectedAt'] as number,
      stalledMs: data['stalledMs'] as number,
    })
    json(res, result)
    return true
  }

  return false
}

// Shared hourly Gemini-call budget for the MikroB Ghost pipeline (card 612058c2 delta-gate,
// WhiteHat2 NO-GO H1 @c5e5ec28, comment 19879).
//
// THE BUG THIS CLOSES: gemini-orchestrator.ts's ranking call and gemini-orchestrator-draft-
// review.ts's per-card review calls are the only two places this pipeline actually reaches the
// Gemini REST API (gemini-orchestrator-draft.ts runs with OFFLOAD_NO_GEMINI=1, local-only -- no
// network call there). The pre-delta gemini-ghost-runner.sh counted TICKS, not calls: one tick
// could rank+review an unbounded number of eligible cards (measured: ~160 MikroB-project cards
// live), each review a real Gemini network call, while the log only grew by one row per tick.
// "At most 5 real calls per hour" was true of tick count, false of actual outbound calls.
//
// WHY THIS SHARES gemini-agy-call.sh's HOURLY WINDOW, NOT A NEW ONE (card 612058c2 Teendo 3: "az
// oranyi plafon a gemini-agy-call.sh meglevo flotta-szintu szamlaloja, nem uj szamlalo"): the
// fleet-wide hourly cap is "how many real Gemini calls go out in an hour", not "how many of them
// this one caller made" -- the pre-delta version counted only hivo==='quota-bridge-ghost' rows,
// which let Ghost calls and MikroB's own gemini-agy-call.sh calls add up past the real ceiling (5
// Ghost + 5 agy = 10/hour instead of a shared 5). This counts both seged==='agy' rows (real
// jailed-CLI "agy" calls) AND this module's own seged==='agy-ghost' rows toward the SAME hourly
// window, and takes the SAME flock (gemini-agy-call.hourly.lock) so the check-then-append is
// atomic against a concurrent gemini-agy-call.sh invocation too, not just against another Ghost
// call.
//
// WHY A DIFFERENT `seged` VALUE, NOT A LITERAL seged==='agy' ROW (RedHat F-RH-V1, card 612058c2
// delta-gate @c5e5ec28): scripts/seged-hivo.py's OWN daily quota (quota_problem(), lim['agy_nap'],
// fleet-wide 20/day) ALSO counts rows by `row.get('seged') == 'agy'` -- a first version of this
// module tagged its rows 'agy' to share gemini-agy-call.sh's hourly count, and that same tag
// silently fed the UNRELATED daily cap too: 4 hours of Ghost ticks (5/hour) would exhaust the
// entire day's fleet-wide "agy" jailed-CLI budget meant for MikroB's own direct usage, a resource
// a REST-API pipeline has no business consuming. 'agy-ghost' is invisible to quota_problem()'s
// `seged == engine` check (engine is always exactly 'agy') while still sharing THIS module's own
// hourly accounting with real 'agy' rows below.
//
// RESIDUAL ASYMMETRY (documented, not fixed here -- out of scope per this card's own earlier
// commit message): gemini-agy-call.sh's OWN hourly check only counts seged==='agy' rows, so it
// cannot see 'agy-ghost' rows and will keep admitting direct agy calls even while Ghost is near
// its own hourly ceiling. This module counts BOTH tags, so Ghost always yields to combined usage;
// the gap is one-directional (a direct agy call can still exceed the SHARED ceiling Ghost itself
// respects), bounded by the fact that direct agy calls are a conscious MikroB action, not an
// unattended loop -- unifying the two fully would mean editing the already-gated, flock-protected
// gemini-agy-call.sh itself, judged too risky for this card's blast radius.
//
// RESERVE, NOT "CHECK THEN THE CALLER APPENDS LATER": the budget is consumed (the log row
// appended) INSIDE the same locked critical section as the count, before the caller ever reaches
// the network call -- so the spent slot is recorded per actual call attempt, not at the end of a
// tick (the other half of H1: "a felhasznalt keret hivasonkent irodjon, ne a tick vegen").
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const STORE = join(ROOT, 'store')

const HOURLY_LOCK = process.env.GEMINI_AGY_HOURLY_LOCK ?? join(STORE, 'gemini-agy-call.hourly.lock')
// F5 (card 6b7c2c25, WhiteHat GO 612058c2 komment 19967): this used to read
// process.env.SEGED_HIVO_HELPERS, and the RESERVE_SCRIPT below then EXECUTES whatever file that
// path names via importlib.exec_module(), with this process's own privileges -- any process
// upstream in the call chain (not just this script's own selftest) could silently redirect a
// real production call to run arbitrary Python. Same risk class gemini-agy-call.sh's own F-A fix
// (card 09117e0a) already closed for its shell equivalent: the real path is fixed, derived from
// ROOT, with no env override; a test needing a sandboxed copy passes it explicitly via
// reserveGhostCallSlot()'s segedHivoPath parameter instead.
const SEGED_HIVO = join(ROOT, 'scripts', 'seged-hivo.py')
const LOCK_WAIT_S = 30

/** M2 regression (WhiteHat2, card 612058c2 NO-GO): a non-numeric/zero/negative
 *  GEMINI_AGY_HOURLY_LIMIT must fail CLOSED (fall back to the documented default), never fail
 *  open to "no cap". Number('') is 0 and Number('abc') is NaN -- both rejected here explicitly
 *  rather than relying on `> 0` alone to also reject NaN by accident. */
export function resolveHourlyLimit(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return 5
  return n
}

const HOURLY_LIMIT = resolveHourlyLimit(process.env.GEMINI_AGY_HOURLY_LIMIT)

/** F2 (WhiteHat GO, card 612058c2 Teendo @6b9f61eb, comment 19967): 'agy-ghost' rows are tagged
 *  differently ON PURPOSE (see the module header above) so they do NOT feed seged-hivo.py's own
 *  'agy' daily cap -- but that left them with NO daily cap of their own at all: during an outage,
 *  Ghost could spend 5/hour around the clock with nothing capping the day's total. Same fail-
 *  closed parsing as resolveHourlyLimit. */
export function resolveDailyGhostLimit(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return 20
  return n
}

const DAILY_GHOST_LIMIT = resolveDailyGhostLimit(process.env.GEMINI_AGY_GHOST_DAILY_LIMIT)

// Runs under `flock -x -w <N> <lock> python3 -I - <seged_hivo_path> <hourly_limit> <card_id>
// <status> <daily_ghost_limit> <hivas_id>`: the lock is held for exactly this count-then-append
// critical section, mirroring gemini-agy-call.sh's own flock (store/gemini-agy-call.sh HOURLY_LOCK).
//
// hivas_id (card 9963bf35 follow-up to cbeeba61): the caller may pass its OWN pre-generated
// hivas_id (empty string = generate one here, byte-identical to before this card) so it can later
// correlate recordGhostCallDetail()'s enrichment row to THIS exact reservation row (same hivas_id
// = "last row wins" per scripts/seged-hivo.py's calls_of()/the gemini-calls.ts route's dedupeCalls)
// instead of appearing as a second, separately-counted call.
const RESERVE_SCRIPT = `
import datetime, importlib.util, os, sys, time
spec = importlib.util.spec_from_file_location('seged_hivo', sys.argv[1])
sh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sh)
limit = int(sys.argv[2])
card_id = sys.argv[3]
status = sys.argv[4]
daily_ghost_limit = int(sys.argv[5])
caller_hivas_id = sys.argv[6] if len(sys.argv) > 6 else ''
window_start = time.time() - 3600
today = datetime.datetime.now().astimezone().date().isoformat()
used = 0
ghost_today = 0
ghost_attempts_hour = 0
for row in sh.calls_of(sh.read_log()):
    try:
        ts = datetime.datetime.fromisoformat(str(row.get('ido', ''))).timestamp()
    except ValueError:
        ts = None
    # Cybersec2 NO-GO F1 (card 5cb861e6, comment 26900): releaseGhostCallSlot() below un-spends
    # 'used' on a 503 so a retriable provider failure does not block OTHER engines sharing this
    # budget -- but counted alone, that let a 503 outage grant an UNBOUNDED number of real
    # Gemini network attempts (measured: 40 consecutive 503s = 40 granted calls). This counts
    # EVERY agy-ghost reservation attempt in the window, successful OR later released, so the
    # gross number of real network attempts this engine makes per hour is capped at the same
    # limit regardless of how many of them get released afterward.
    if row.get('seged') == 'agy-ghost' and ts is not None and ts >= window_start:
        ghost_attempts_hour += 1
    # H1 (RedHat NO-GO, card f0b3b674 komment 20369, Gate-SHA 44931ad6): 'agy-heavy' rows (the
    # heavy-second-opinion path, store/offload-dispatch.sh) must count toward this SAME shared
    # hourly window too, same reasoning as the 'agy-ghost' symmetry fix above (612058c2 F2) --
    # without this, 'used' here undercounts and a reservation can be granted past the real cap.
    if row.get('seged') not in ('agy', 'agy-ghost', 'agy-heavy') or row.get('status') == 'blocked':
        continue
    if ts is not None and ts >= window_start:
        used += 1
    if row.get('seged') == 'agy-ghost' and str(row.get('ido', ''))[:10] == today:
        ghost_today += 1
if ghost_today >= daily_ghost_limit:
    print('CAPPED_DAILY')
    sys.exit(3)
if ghost_attempts_hour >= limit:
    print('CAPPED_ATTEMPTS')
    sys.exit(4)
if used >= limit:
    print('CAPPED')
    sys.exit(2)
sh.append_log({
    'ido': datetime.datetime.now().isoformat(),
    'hivas_id': caller_hivas_id or os.urandom(8).hex(),
    'seged': 'agy-ghost',
    'hivo': 'quota-bridge-ghost',
    'kartya': card_id,
    'feladattipus': 'kod',
    'status': status,
})
print('OK')
sys.exit(0)
`

/**
 * Atomically checks the SHARED fleet-wide hourly "agy" budget and, if a slot remains, immediately
 * reserves it (appends the log row) before returning -- so two near-simultaneous callers can
 * never both observe "budget available" and both proceed. Fail-closed: any inability to run the
 * check (missing flock/python3, timeout, non-zero/non-OK exit) returns false -- "could not confirm
 * a slot is free" must never be read as "a slot is free".
 */
export function reserveGhostCallSlot(
  cardId: string,
  status: 'ok' | 'error' = 'ok',
  segedHivoPath: string = SEGED_HIVO,
  hivasId: string = '',
): boolean {
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(
      'flock',
      ['-x', '-w', String(LOCK_WAIT_S), HOURLY_LOCK, 'python3', '-I', '-', segedHivoPath,
       String(HOURLY_LIMIT), cardId, status, String(DAILY_GHOST_LIMIT), hivasId],
      { input: RESERVE_SCRIPT, encoding: 'utf-8', timeout: (LOCK_WAIT_S + 10) * 1000 },
    )
  } catch {
    return false
  }
  if (result.error) return false
  return result.status === 0
}

// Card 5cb861e6 (daytime-mode phase c7abdf57): reserveGhostCallSlot() above spends the slot
// (appends the log row) BEFORE the real network call, which is correct for the concurrency
// atomicity H1 fixed -- but it means a retriable provider failure (503 "model overloaded") still
// consumes one of the 5 hourly slots even though nothing about OUR usage caused it. Measured
// live (card's own "mai allapot" note): the first real call hit exactly this, gemini-flash-latest
// returning 503 under high demand.
//
// WHY A NEW LOG ROW, NOT AN IN-PLACE REWRITE: scripts/seged-hivo.py's own calls_of() already
// treats "the LAST row with a given hivas_id wins" as its update mechanism (see its docstring) --
// append_log() is the only write primitive the module exposes, and reusing it here keeps this
// release path consistent with how every other row in this log is ever changed (never rewritten
// in place). A status='blocked' row is already excluded from the hourly/daily count by the exact
// same filter RESERVE_SCRIPT above uses (`row.get('status') == 'blocked': continue`), so marking
// the row blocked after the fact un-spends the slot with zero change to the counting logic.
const RELEASE_SCRIPT = `
import datetime, importlib.util, sys
spec = importlib.util.spec_from_file_location('seged_hivo', sys.argv[1])
sh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sh)
card_id = sys.argv[2]
target = None
for row in reversed(sh.read_log()):
    if row.get('seged') == 'agy-ghost' and row.get('kartya') == card_id:
        target = row
        break
if target is None or target.get('status') == 'blocked':
    print('NOT_FOUND')
    sys.exit(1)
sh.append_log({
    'ido': datetime.datetime.now().isoformat(),
    'hivas_id': target['hivas_id'],
    'seged': 'agy-ghost',
    'hivo': 'quota-bridge-ghost',
    'kartya': card_id,
    'feladattipus': 'kod',
    'status': 'blocked',
})
print('OK')
sys.exit(0)
`

/**
 * Un-spends the SINGLE most recent, not-already-released reservation for this exact cardId (card
 * 5cb861e6): call this when the network call that followed a reserveGhostCallSlot() turned out to
 * be a retriable provider failure (HTTP 503), so it does not count against the SHARED hourly cap
 * (freeing room for other engines -- 'agy'/'agy-heavy' -- sharing that same budget). It does NOT
 * re-open room for another agy-ghost attempt in the same hour: RESERVE_SCRIPT's own
 * ghost_attempts_hour counts every agy-ghost reservation in the window regardless of whether it
 * was later released, so a string of 503s still caps out at `limit` real network attempts per
 * hour (Cybersec2 NO-GO F1, card 5cb861e6 comment 26900 -- the un-bounded version measured 40
 * consecutive 503s granting 40 real calls instead of 5).
 * Safe to call even when there is nothing to release (returns false, nothing is written twice).
 * Same flock as reserveGhostCallSlot -- the read-then-append here must not race a concurrent
 * reservation or release for the same cardId.
 */
export function releaseGhostCallSlot(
  cardId: string,
  segedHivoPath: string = SEGED_HIVO,
): boolean {
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(
      'flock',
      ['-x', '-w', String(LOCK_WAIT_S), HOURLY_LOCK, 'python3', '-I', '-', segedHivoPath, cardId],
      { input: RELEASE_SCRIPT, encoding: 'utf-8', timeout: (LOCK_WAIT_S + 10) * 1000 },
    )
  } catch {
    return false
  }
  if (result.error) return false
  return result.status === 0
}

// Card cbeeba61 (Peti Telegram 14348): the Ghost calls page (src/web/routes/gemini-calls.ts)
// reads store/seged-hivo-naplo.jsonl directly, keyed by hivas_id (dedupeCalls: last row with a
// given hivas_id wins, same rule scripts/seged-hivo.py's own calls_of() uses). Before this card,
// reserveGhostCallSlot's own reservation row was the ONLY row most Ghost calls ever got -- no
// model, duration or token count, and feladattipus hardcoded 'kod' -- so the page showed
// model='ismeretlen' for essentially every Ghost-sourced row (154 of them, measured). This
// records a SECOND row with the SAME hivas_id right after the real network call completes,
// carrying the fields the page already knows how to read (modell/duracio_s/tokens_total/status/
// feladattipus) -- it REPLACES what dedupeCalls shows for that call, it does not add a second
// one. NEVER logs prompt or response text, only metadata (card's own explicit requirement).

/** Generates a hivas_id in the SAME 16-hex-char shape RESERVE_SCRIPT's own `os.urandom(8).hex()`
 *  produces, so a caller can generate one up front, pass it into reserveGhostCallSlot's hivasId
 *  param, and reuse the identical value here to correlate the two rows. */
export function randomHivasId(): string {
  return randomBytes(8).toString('hex')
}

export interface GhostCallDetail {
  /** The real model id requested (e.g. gemini-flash-latest), never a guess. */
  model: string
  durationMs: number
  outcome: 'ok' | 'error' | 'blocked'
  /** Only when the API reported it (metering only, never prompt/response content). */
  totalTokens?: number
  /** Truthful task type -- 'ghost-rank' (decideGeminiOrder) or 'ghost-review' (reviewOneCard),
   *  never the old hardcoded 'kod'. */
  taskType: string
}

const RECORD_DETAIL_SCRIPT = `
import datetime, importlib.util, sys
spec = importlib.util.spec_from_file_location('seged_hivo', sys.argv[1])
sh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sh)
hivas_id = sys.argv[2]
card_id = sys.argv[3]
task_type = sys.argv[4]
status = sys.argv[5]
model = sys.argv[6]
duracio_s = float(sys.argv[7])
tokens_raw = sys.argv[8]
row = {
    'ido': datetime.datetime.now().isoformat(),
    'hivas_id': hivas_id,
    'seged': 'agy-ghost',
    'hivo': 'quota-bridge-ghost',
    'kartya': card_id,
    'feladattipus': task_type,
    'status': status,
    'modell': model,
    'duracio_s': duracio_s,
}
if tokens_raw:
    row['tokens_total'] = int(tokens_raw)
sh.append_log(row)
print('OK')
sys.exit(0)
`

/**
 * Best-effort, fire-and-forget (card cbeeba61): this is diagnostic detail for an already-decided
 * call outcome, not budget enforcement -- unlike reserveGhostCallSlot/releaseGhostCallSlot, a
 * failure here must never change whether the caller's own result is treated as success or
 * failure. Takes the SAME flock as the other two (the read-then-append inside RECORD_DETAIL_SCRIPT
 * is a plain append, but sharing the lock keeps every seged-hivo-naplo.jsonl writer serialized).
 * Also appends an llm_ledger row (provider=gemini) so the same call shows up in any llm_ledger-
 * based reporting, same shape freellm-call.sh/gemini-offload-call.sh already write for their own
 * providers.
 */
export function recordGhostCallDetail(
  hivasId: string,
  cardId: string,
  detail: GhostCallDetail,
  segedHivoPath: string = SEGED_HIVO,
): boolean {
  let ok = false
  try {
    const result = spawnSync(
      'flock',
      ['-x', '-w', String(LOCK_WAIT_S), HOURLY_LOCK, 'python3', '-I', '-', segedHivoPath,
       hivasId, cardId, detail.taskType, detail.outcome, detail.model,
       String(detail.durationMs / 1000), detail.totalTokens !== undefined ? String(detail.totalTokens) : ''],
      { input: RECORD_DETAIL_SCRIPT, encoding: 'utf-8', timeout: (LOCK_WAIT_S + 10) * 1000 },
    )
    ok = !result.error && result.status === 0
  } catch {
    ok = false
  }
  try {
    const okFlag = detail.outcome === 'ok' ? ['--ok'] : ['--fail', '--fail-reason', detail.outcome]
    spawnSync(
      'python3',
      [join(STORE, 'llm-ledger-append.py'), '--agent', 'quota-bridge-ghost', '--task-type', detail.taskType,
       '--provider', 'gemini', '--model', detail.model, ...okFlag,
       '--latency-ms', String(Math.round(detail.durationMs)), '--card', cardId],
      { timeout: 10_000 },
    )
  } catch {
    // best-effort, same fire-and-forget convention as every other llm_ledger writer
  }
  return ok
}

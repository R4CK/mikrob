// The scheduled upstream-drift watcher's I/O half (card a1ce8952, parent 1f276349).
//
// The branching lives in src/fork-upstream/drift-watch.ts and is tested offline; this file only
// carries the decision out. Keeping the two apart is what makes "stay silent" testable: the cases
// that matter are the ones that must not write to the board, and they cannot be exercised against
// the live dashboard without writing to it first.
//
// MODES
//   (default)   decide and act: open a card, comment on the open one, or say nothing
//   --report    print the full human report and exit -- no board writes, no state writes
//   --dry-run   decide and print the action, write nothing
//
// SEAMS (all env, all optional)
//   MARVEEN_ROOT               repo whose upstream is checked   (default: this script's repo)
//   MARVEEN_DASHBOARD_URL      dashboard base URL               (default: http://localhost:3420)
//   MARVEEN_TOKEN_FILE         bearer token file                (default: <root>/store/.dashboard-token)
//   MARVEEN_DRIFT_STATE_FILE   fingerprint state                (default: <root>/store/fork-upstream-drift-state.json)
//   MARVEEN_DRIFT_JSON         a canned DriftResult, instead of running the real check
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(process.env.MARVEEN_ROOT || join(HERE, '..'))
const DASH = process.env.MARVEEN_DASHBOARD_URL || 'http://localhost:3420'
const TOKEN_FILE = process.env.MARVEEN_TOKEN_FILE || join(ROOT, 'store', '.dashboard-token')
const STATE_FILE = process.env.MARVEEN_DRIFT_STATE_FILE || join(ROOT, 'store', 'fork-upstream-drift-state.json')

const { runDriftCheck, formatDriftReport } = await import(join(ROOT, 'dist', 'fork-upstream', 'drift-check.js'))
const { decideDriftAction } = await import(join(ROOT, 'dist', 'fork-upstream', 'drift-watch.js'))

const args = new Set(process.argv.slice(2))
const REPORT_ONLY = args.has('--report')
const DRY_RUN = args.has('--dry-run')

function fail(reason) {
  console.log(`ERROR:${reason}`)
  process.exit(2)
}

/** The board is a set of cards this watcher must not act on and one it must. Only the three OPEN
 *  statuses are asked for: a `done` drift card is an answered one, and treating it as open would
 *  make the watcher comment into an archive nobody reads. */
async function openCards(token) {
  const res = await fetch(`${DASH}/api/kanban?status=planned,in_progress,waiting`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`kanban-list-${res.status}`)
  const rows = await res.json()
  if (!Array.isArray(rows)) throw new Error('kanban-list-not-an-array')
  return rows
}

/** Rule 6a: a planned card without an assignee is a rule violation the moment it is created, and
 *  the same rule says the load is shared between equal siblings rather than piled on one. Rule 3a
 *  names backend<->backend2 as the sibling pair, but its "pl." is an example and backend3 does the
 *  same marveen-infra work today, so all three are counted -- balancing across two of three would
 *  quietly starve the least loaded one. The count comes from the board already fetched, so this
 *  costs no extra request. Ties and surprises resolve to the first name: a card with an assignee
 *  beats a card without one, and MikroB re-balances if the count is not the whole story. */
const BE_SIBLINGS = ['backend', 'backend2', 'backend3']

function pickAssignee(rows) {
  const load = (who) => rows.filter((c) => String(c.assignee || '') === who).length
  return BE_SIBLINGS.reduce((best, who) => (load(who) < load(best) ? who : best), BE_SIBLINGS[0])
}

function readState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
    return typeof s.fingerprint === 'string' ? s.fingerprint : null
  } catch {
    return null
  }
}

function writeState(action, drift) {
  if (action.fingerprint === null) return
  const files = [...drift.guarded, ...drift.unwatched, ...drift.stale.map((s) => s.file)].sort()
  // `files` is for the human reading this file, never for the decision -- the fingerprint is.
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ fingerprint: action.fingerprint, files, action: action.kind, at: new Date().toISOString() }, null, 2)
  )
}

const drift = process.env.MARVEEN_DRIFT_JSON
  ? JSON.parse(readFileSync(process.env.MARVEEN_DRIFT_JSON, 'utf-8'))
  : runDriftCheck(ROOT)

if (REPORT_ONLY) {
  console.log(formatDriftReport(drift))
  process.exit(0)
}

let token
try {
  token = readFileSync(TOKEN_FILE, 'utf-8').trim()
} catch {
  fail('no-token-file')
}
if (!token) fail('empty-token')

let rows
try {
  rows = await openCards(token)
} catch (e) {
  // A dashboard that is down is not a drift verdict. Report and leave the state alone, so the next
  // run still knows what was last said.
  fail(`board-unreadable-${e.message}`)
}

const action = decideDriftAction(
  drift,
  rows.map((c) => ({ id: String(c.id), title: String(c.title ?? ''), createdAt: Number(c.created_at ?? 0) })),
  readState()
)

if (DRY_RUN) {
  console.log(`DRYRUN:${action.kind}:${action.kind === 'silent' ? action.reason : action.kind === 'comment' ? action.cardId : action.title}`)
  process.exit(0)
}

async function post(path, body) {
  const res = await fetch(`${DASH}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path}-${res.status}`)
  return res.json()
}

const SEVERE = drift.reachable && (drift.guarded.length > 0 || drift.unwatched.length > 0)

const CARD_FOOTER = [
  '',
  'Gate: QA + Cybersec',
  '',
  'Ezt a kártyát a `fork-upstream-drift-watch` ütemezett feladat nyitotta, nem ember. Amíg nyitva van, a',
  'figyelő NEM nyit újat: a változásokat ERRE a kártyára kommenteli, és hallgat, ha a drift nem mozdult.',
  'Ha lezárod anélkül, hogy a döntéseket felülvizsgálnád, a figyelő addig hallgat, amíg az upstream oldal',
  'ténylegesen tovább nem mozdul -- a zárás tehát válasznak számít, nem elnémításnak.',
].join('\n')

try {
  if (action.kind === 'silent') {
    console.log(`SILENT:${action.reason}`)
  } else if (action.kind === 'open') {
    const created = await post('/api/kanban', {
      title: action.title,
      description: `${action.description}\n${CARD_FOOTER}`,
      status: 'planned',
      priority: SEVERE ? 'high' : 'normal',
      assignee: pickAssignee(rows),
      project: 'marveen',
    })
    console.log(`OPENED:${created.id}`)
  } else {
    await post(`/api/kanban/${action.cardId}/comments`, {
      author: 'fork-upstream-drift-watch',
      content: action.content,
    })
    console.log(`COMMENTED:${action.cardId}`)
  }
} catch (e) {
  // The write failed, so the state must NOT record that we spoke.
  fail(`write-failed-${e.message}`)
}

writeState(action, drift)

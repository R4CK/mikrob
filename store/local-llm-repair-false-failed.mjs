// One-shot repair for card 41df5159: direct-sync rows that card ea931c14's output verification
// marked `failed` even though the call SUCCEEDED.
//
// WHY THESE ROWS ARE PROVABLY NOT REAL FAILURES. store/local-llm.sh reaches `_queue_finish complete`
// only AFTER the Ollama generation returns (line 361, past the `|| { ... die }` block at 334); its
// failure path posts /fail with `{"error":"local-llm.sh call failed"}` instead. So a row whose error
// is exactly the verification message is, by construction, one where the model call worked and the
// script then posted its intentionally empty `{"result":""}` statistics completion. The route fix in
// this card stops producing them; this script corrects the ones already written.
//
// SELECTION IS EXACT, NOT HEURISTIC. Three conditions, all required:
//   1. prompt = DIRECT_CALL_PLACEHOLDER  -- the same structural marker fail()/reclaimStaleRunning()
//      use, deliberately not the caller-supplied `source` string.
//   2. status = 'failed'
//   3. error   = 'output verification failed: empty output'  -- the EXACT string, so the 141
//      'local-llm.sh call failed', 42 'abandoned' and 9 'requeued' direct rows (real failures, and a
//      real crash-recovery signal) are left alone. A LIKE/prefix match would have swept those up.
//
// ROLLBACK IS A FILE, NOT A PROMISE (root CLAUDE.md code rule 11). --apply writes every touched id
// with its prior status/error/finished_at to a JSON journal BEFORE the UPDATE, and --revert <file>
// puts them back verbatim. Run --dry-run first; it prints the same counts --apply will act on.
//
// Usage:
//   node store/local-llm-repair-false-failed.mjs --dry-run [--db <path>]
//   node store/local-llm-repair-false-failed.mjs --apply   [--db <path>] [--journal <path>]
//   node store/local-llm-repair-false-failed.mjs --revert <journal.json> [--db <path>]
import { createRequire } from 'node:module'
import { writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const PLACEHOLDER = '(direct call -- registered for concurrency tracking only, no content stored)'
const FALSE_ERROR = 'output verification failed: empty output'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(name)

const dbPath = resolve(arg('--db', join(HERE, 'claudeclaw.db')))
const Database = require('better-sqlite3')

function selectFalseFailed(db) {
  return db
    .prepare(
      `SELECT id, status, error, finished_at FROM local_llm_queue
        WHERE prompt = ? AND status = 'failed' AND error = ?
        ORDER BY id`,
    )
    .all(PLACEHOLDER, FALSE_ERROR)
}

function main() {
  if (has('--revert')) {
    const journalPath = arg('--revert')
    if (!journalPath) throw new Error('--revert needs a journal path')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    const db = new Database(dbPath)
    const put = db.prepare(
      'UPDATE local_llm_queue SET status = ?, error = ?, finished_at = ? WHERE id = ?',
    )
    const tx = db.transaction((rows) => {
      for (const r of rows) put.run(r.status, r.error, r.finished_at, r.id)
    })
    tx(journal.rows)
    console.log(`reverted ${journal.rows.length} row(s) from ${journalPath}`)
    db.close()
    return
  }

  const db = new Database(dbPath, { readonly: !has('--apply') })
  const rows = selectFalseFailed(db)
  console.log(`db:      ${dbPath}`)
  console.log(`matched: ${rows.length} direct-sync row(s) failed ONLY by the empty-output check`)
  // Print what is deliberately NOT touched, so the operator sees the boundary rather than trusting it.
  const others = db
    .prepare(
      `SELECT error, COUNT(*) AS n FROM local_llm_queue
        WHERE prompt = ? AND status = 'failed' AND error <> ? GROUP BY error ORDER BY n DESC`,
    )
    .all(PLACEHOLDER, FALSE_ERROR)
  for (const o of others) console.log(`untouched: ${o.n} x ${JSON.stringify(o.error)}`)

  if (!has('--apply')) {
    console.log('dry-run: nothing written. Re-run with --apply to correct them.')
    db.close()
    return
  }

  const journalPath = resolve(
    arg('--journal', join(HERE, `local-llm-repair-41df5159-${rows.length}.json`)),
  )
  writeFileSync(journalPath, JSON.stringify({ dbPath, rows }, null, 2), 'utf8')
  console.log(`journal: ${journalPath}`)

  const put = db.prepare(`UPDATE local_llm_queue SET status = 'done', error = NULL WHERE id = ?`)
  const tx = db.transaction((rs) => {
    for (const r of rs) put.run(r.id)
  })
  tx(rows)
  const left = selectFalseFailed(db).length
  console.log(`applied: ${rows.length} row(s) -> done; ${left} still matching (must be 0)`)
  db.close()
  if (left !== 0) process.exit(1)
}

main()

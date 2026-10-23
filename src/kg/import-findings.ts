// MT-10a (card 63206155, parent 81593084): imports kanban_verdicts NO-GO/FAIL rows into the
// knowledge graph as `finding` nodes, classified into `error_class` nodes via a deterministic
// keyword taxonomy.
//
// WHY KEYWORDS, NOT A LOCAL-LLM CLASSIFIER (MikroB decision on this card, msg_id:13955): the
// card's own open question offered three options (keyword taxonomy / local-LLM classification /
// manual taxonomy). MikroB picked the deterministic keyword taxonomy with an explicit
// `unclassified` bucket, measured by coverage (`unclassifiedCount` / `verdictsSeen` in the
// report below) -- a local-LLM classifier is only warranted if that stays over 20%, and that
// would be a separate card, not scope-creep into this one.
//
// WHAT TEXT GETS CLASSIFIED: kanban_verdicts.verdict is a literal GO/NO-GO/PASS/FAIL word, not
// prose (src/db.ts GateVerdictWord) -- `gate` is just QA/CYBERSEC/CYBERED. The only free-text
// field on the structured verdict row is `findings_ref` (card 2bfa4c67), so classification runs
// over `${gate} ${findings_ref}`. A verdict with no findings_ref (common today -- see below)
// classifies as `unclassified` by construction, same as a row whose findings_ref matches no rule.
//
// MEASURED ON THE LIVE TABLE (2026-10-23): kanban_verdicts has 0 rows -- the structured
// gate-verdict record (card 2bfa4c67) shipped but gates still post free-text kanban_comments
// verdicts (the CLAUDE.md 4c convention), not the structured API. This importer is correct and
// tested against fixtures regardless (same posture as import-from-relations.ts, MT-01); the
// coverage measurement the card asks for will read as 0/0 until gates adopt the structured API,
// which is tracked outside this card.
//
// Deterministic, same shape as import-from-relations.ts and import-decisions-log.ts: one
// transaction (atomic -- a bad row rolls back the whole run, not a partial one), idempotent by
// construction (the finding node id is derived from kanban_verdicts.id, a stable autoincrement
// primary key; upsertEdge's composite PK makes a re-run a no-op for edges already present).

import type Database from 'better-sqlite3'
import { upsertNode, upsertEdge } from './store.js'
import { mapProjectToPartition, GLOBAL_PARTITION } from './project-map.js'

export interface FindingsImportReport {
  verdictsSeen: number
  verdictsSkippedMissing: number
  findingsUpserted: number
  foundOnEdges: number
  classEdges: number
  classifiedCount: number
  unclassifiedCount: number
}

interface VerdictRow {
  id: number
  card_id: string
  gate: string
  verdict: string
  sha: string | null
  findings_ref: string | null
}

interface CardRow {
  id: string
  title: string
  project: string | null
}

interface ErrorClassRule {
  id: string
  title: string
  pattern: RegExp
}

// Ordered: first match wins. Deliberately small and conservative -- a rule that is too broad
// mis-groups unrelated findings, which is worse than leaving them `unclassified` (the card's own
// acceptance criterion only requires that two findings with the SAME real root cause land on the
// same class, not that every row gets classified). Extend this list as real findings_ref text is
// observed; do not guess categories that have never actually appeared.
const ERROR_CLASS_RULES: readonly ErrorClassRule[] = [
  {
    id: 'missing-env-allowlist',
    title: 'Hiányzó/nem engedélyezett env-változó',
    pattern: /\benv[-_ ]?(var|valtozo|allowlist)\b|\ballowlist\b/i,
  },
  {
    id: 'secret-leak',
    title: 'Titok/kulcs szivárgás',
    pattern: /\bsecret\b|\btitok\b|\bapi[-_ ]?key\b|\btoken leak\b|\bkulcs szivárg/i,
  },
  {
    id: 'lint-regression',
    title: 'Lint-szabály regresszió',
    pattern: /\blint[-_ ]?(ratchet|rule|regression)?\b/i,
  },
  {
    id: 'flaky-test',
    title: 'Flaky/instabil teszt',
    pattern: /\bflaky\b|\binstabil\b|\bintermittens\b/i,
  },
  {
    id: 'race-condition',
    title: 'Versenyfeltétel / konkurrencia hiba',
    pattern: /\brace condition\b|\bverseny ?felt[ée]tel\b|\bconcurrency\b/i,
  },
  {
    id: 'auth-bypass',
    title: 'Hitelesítés/jogosultság megkerülés',
    pattern: /\bauth(entication|orization)? bypass\b|\bjogosults[aá]g.*megker[uü]l/i,
  },
  {
    id: 'injection',
    title: 'Injection (SQL/command/path)',
    pattern: /\binjection\b|\binjekci[oó]\b/i,
  },
  {
    id: 'fail-open',
    title: 'Fail-open hiba (védelem kikerülhető hibánál)',
    pattern: /\bfail[-_ ]?open\b/i,
  },
]

const UNCLASSIFIED_CLASS_ID = 'unclassified'
const UNCLASSIFIED_CLASS_TITLE = 'Nem osztályozott'

/** Picks the first matching rule's id, or the unclassified bucket. Exported so the coverage
 *  measurement the card asks for (and a future taxonomy-tuning pass) can run this over real
 *  findings_ref text without re-running the whole import. */
export function classifyFindingText(gate: string, findingsRef: string | null): string {
  const text = `${gate} ${findingsRef ?? ''}`
  for (const rule of ERROR_CLASS_RULES) {
    if (rule.pattern.test(text)) return rule.id
  }
  return UNCLASSIFIED_CLASS_ID
}

function errorClassTitle(classId: string): string {
  return ERROR_CLASS_RULES.find((r) => r.id === classId)?.title ?? UNCLASSIFIED_CLASS_TITLE
}

function findingNodeId(verdictId: number): string {
  return `finding:${verdictId}`
}

function errorClassNodeId(classId: string): string {
  return `error_class:${classId}`
}

function cardNodeId(cardId: string): string {
  return `card:${cardId}`
}

function makeCardLookup(mainDb: Database.Database): (id: string) => CardRow | undefined {
  const stmt = mainDb.prepare('SELECT id, title, project FROM kanban_cards WHERE id = ?')
  const cache = new Map<string, CardRow | undefined>()
  return (id: string) => {
    if (cache.has(id)) return cache.get(id)
    const row = stmt.get(id) as CardRow | undefined
    cache.set(id, row)
    return row
  }
}

/** Reads kanban_verdicts NO-GO/FAIL rows from the MAIN dashboard database and mirrors them into
 *  the knowledge-graph database as `finding` nodes, classified into `error_class` nodes. The two
 *  handles are injected (same pattern as import-from-relations.ts) so tests point both at
 *  disposable fixtures and a future CLI entry point can point mainDb at the live claudeclaw.db
 *  without this module caring. */
export function importFindings(mainDb: Database.Database, kgDb: Database.Database): FindingsImportReport {
  const report: FindingsImportReport = {
    verdictsSeen: 0,
    verdictsSkippedMissing: 0,
    findingsUpserted: 0,
    foundOnEdges: 0,
    classEdges: 0,
    classifiedCount: 0,
    unclassifiedCount: 0,
  }
  const lookup = makeCardLookup(mainDb)
  const classNodesWritten = new Set<string>()
  const cardNodesWritten = new Set<string>()

  const verdicts = mainDb
    .prepare(
      `SELECT id, card_id, gate, verdict, sha, findings_ref FROM kanban_verdicts
       WHERE verdict IN ('NO-GO','FAIL')`,
    )
    .all() as VerdictRow[]
  report.verdictsSeen = verdicts.length

  const runImport = kgDb.transaction(() => {
    for (const v of verdicts) {
      const card = lookup(v.card_id)
      if (!card) {
        report.verdictsSkippedMissing += 1
        continue
      }
      const project = mapProjectToPartition(card.project)
      const cardId = cardNodeId(v.card_id)
      if (!cardNodesWritten.has(cardId)) {
        cardNodesWritten.add(cardId)
        upsertNode(kgDb, {
          id: cardId,
          type: 'card',
          project,
          title: card.title,
          source_ref: `kanban_cards:${card.id}`,
          extractor: 'import:kanban_verdicts_findings',
        })
      }
      const findingId = findingNodeId(v.id)
      upsertNode(kgDb, {
        id: findingId,
        type: 'finding',
        project,
        title: `${v.gate} ${v.verdict}`,
        body: v.findings_ref ?? null,
        source_ref: `kanban_verdicts:${v.id}`,
        gate_sha: v.sha ?? null,
        extractor: 'import:kanban_verdicts_findings',
      })
      report.findingsUpserted += 1

      if (
        upsertEdge(kgDb, {
          src: cardId,
          dst: findingId,
          rel: 'found_on',
          source: 'import:kanban_verdicts_findings',
        }) > 0
      ) {
        report.foundOnEdges += 1
      }

      const classId = classifyFindingText(v.gate, v.findings_ref)
      if (classId === UNCLASSIFIED_CLASS_ID) report.unclassifiedCount += 1
      else report.classifiedCount += 1

      const classNodeId = errorClassNodeId(classId)
      if (!classNodesWritten.has(classNodeId)) {
        classNodesWritten.add(classNodeId)
        upsertNode(kgDb, {
          id: classNodeId,
          type: 'error_class',
          project: GLOBAL_PARTITION,
          title: errorClassTitle(classId),
          source_ref: classNodeId,
          extractor: 'import:kanban_verdicts_findings',
        })
      }
      if (
        upsertEdge(kgDb, {
          src: findingId,
          dst: classNodeId,
          rel: 'of_class',
          source: 'import:kanban_verdicts_findings',
        }) > 0
      ) {
        report.classEdges += 1
      }
    }
  })
  runImport()

  return report
}

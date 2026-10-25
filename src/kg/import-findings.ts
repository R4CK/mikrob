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
// transaction (atomic for infrastructure faults; rows with secret-shaped findings_ref are
// pre-screened and skipped rather than aborting the whole run -- F5, card 61348647).
// Idempotent by construction (finding node id from kanban_verdicts.id stable autoincrement pk;
// of_class edges are delete-then-insert per run so reclassification removes stale edges -- F4).

import type Database from 'better-sqlite3'
import { upsertNode, upsertEdge, sanitizeKgText, findSecretShape } from './store.js'
import { mapProjectToPartition, GLOBAL_PARTITION } from './project-map.js'

export interface FindingsImportReport {
  verdictsSeen: number
  verdictsSkippedMissing: number
  verdictsSkippedSecret: number
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

// Ordered: first match wins. Security-specific rules come FIRST so that a finding like
// "auth bypass via env allowlist" does not get mis-grouped into the generic env-allowlist
// bucket (F2, card 61348647 -- measured: 7/7 realistic mixed-signal sentences misclassified
// with generics-first). Generic rules follow. Deliberately small and conservative -- a rule
// that is too broad mis-groups unrelated findings, which is worse than leaving them
// `unclassified`. Extend as real findings_ref text is observed; do not guess.
const ERROR_CLASS_RULES: readonly ErrorClassRule[] = [
  // Security-specific first.
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
  {
    id: 'race-condition',
    title: 'Versenyfeltétel / konkurrencia hiba',
    pattern: /\brace condition\b|\bverseny ?felt[ée]tel\b|\bconcurrency\b/i,
  },
  // Generic quality rules after security.
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
]

const UNCLASSIFIED_CLASS_ID = 'unclassified'
const UNCLASSIFIED_CLASS_TITLE = 'Nem osztályozott'

// F3 (card 61348647): truncate classification text to the body cap before running patterns.
// The auth-bypass rule's `.*` quantifier on an untruncated 480 KB string triggers catastrophic
// backtracking (~15 s measured). The body cap (8000) is already the schema's hard limit for
// stored text, so any text beyond it can never be indexed or surfaced -- truncating here is
// consistent with what the DB would store anyway.
const CLASSIFICATION_TEXT_CAP = 8000

/** Picks the first matching rule's id, or the unclassified bucket. Exported so the coverage
 *  measurement the card asks for (and a future taxonomy-tuning pass) can run this over real
 *  findings_ref text without re-running the whole import. */
export function classifyFindingText(gate: string, findingsRef: string | null): string {
  const full = `${gate} ${findingsRef ?? ''}`
  const text = full.length > CLASSIFICATION_TEXT_CAP ? full.slice(0, CLASSIFICATION_TEXT_CAP) : full
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
    verdictsSkippedSecret: 0,
    findingsUpserted: 0,
    foundOnEdges: 0,
    classEdges: 0,
    classifiedCount: 0,
    unclassifiedCount: 0,
  }
  const lookup = makeCardLookup(mainDb)
  const classNodesWritten = new Set<string>()
  const cardNodesWritten = new Set<string>()

  const allVerdicts = mainDb
    .prepare(
      `SELECT id, card_id, gate, verdict, sha, findings_ref FROM kanban_verdicts
       WHERE verdict IN ('NO-GO','FAIL')`,
    )
    .all() as VerdictRow[]
  report.verdictsSeen = allVerdicts.length

  // F5 (card 61348647): pre-screen for secret-shaped findings_ref BEFORE the transaction.
  // A single secret row must not abort the entire import; skip and count it instead.
  // Screening happens on the sanitized text so invisible-char-disguised secrets are caught
  // by the same path as clear-text ones (F1 interaction).
  const verdicts = allVerdicts.filter((v) => {
    if (findSecretShape(sanitizeKgText(v.findings_ref))) {
      report.verdictsSkippedSecret += 1
      return false
    }
    return true
  })

  const runImport = kgDb.transaction(() => {
    for (const v of verdicts) {
      const card = lookup(v.card_id)
      if (!card) {
        report.verdictsSkippedMissing += 1
        continue
      }
      // F1 (card 61348647): sanitize findings_ref before it reaches classifyFindingText
      // (classification input) and upsertNode body (storage). upsertNode already sanitizes
      // internally, but BIDI chars between words can create spurious regex word boundaries that
      // mis-classify the finding before it ever hits the node write path. Sanitizing here
      // keeps classification and storage consistent on the same clean text.
      const safeRef = sanitizeKgText(v.findings_ref) ?? null
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
        body: safeRef,
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

      const classId = classifyFindingText(v.gate, safeRef)
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
      // F4 (card 61348647): delete stale of_class edges for this finding before inserting
      // the new one. upsertEdge uses INSERT OR IGNORE, so without this DELETE a reclassified
      // finding accumulates two of_class edges: the old one and the new one.
      kgDb.prepare(`DELETE FROM kg_edges WHERE src = ? AND rel = 'of_class'`).run(findingId)
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

// Connection + CRUD for the knowledge graph (MT-01/MT-13 alap, card ee9ee17b).
//
// Deliberately a SEPARATE file from store/claudeclaw.db (see the MODULTERV, section 1): a
// backfill or embedding write must never contend with the kanban/message hot path. Opened the
// same way src/channel-coordinator/ingest.ts opens its own handle onto a different file --
// own connection, own WAL assertion, own busy_timeout.
//
// Write authority (MT-13 jogosultság tábla): only the capture worker (MT-05, a later card) and
// mikrob create/mutate nodes in production. This module itself does not enforce WHO calls it --
// that is the HTTP route layer's job (F1b/F2/F3, not yet built) -- it only enforces WHAT a write
// may contain (secret-shape rejection, length bounds via the CHECK constraints already in the
// schema) and that every status change is audited.

import Database from 'better-sqlite3'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { SECRET_PATTERNS } from '../security/secret-gate.js'
import { MIGRATIONS, KG_SCHEMA_VERSION, type KgNodeType, type KgEdgeRel } from './schema.js'

export const KG_DB_FILENAME = 'knowledge-graph.db'

// Shared with upsertNode's re-import guard and setNodeStatus callers (e.g. MT-09's anchor-staleness
// module): 'archived'/'superseded' are terminal, deliberately-set statuses (section 5 állapotgép) --
// a drift check marking a node 'stale' must not override one, same reasoning the re-import guard
// below already applies to a kanban_relations re-run.
export const PROTECTED_STATUSES = new Set(['archived', 'superseded'])

export class KgSecretError extends Error {
  constructor(public readonly field: string, public readonly patternName: string) {
    super(`kg write refused: ${field} matches secret pattern '${patternName}'`)
    this.name = 'KgSecretError'
  }
}

export class KgValidationError extends Error {
  constructor(public readonly field: string, reason: string) {
    super(`kg write refused: ${field} ${reason}`)
    this.name = 'KgValidationError'
  }
}

// F4 (eeb57483, WhiteHat GO condition on ee9ee17b): id/source_ref/gate_sha are built by this
// module's own callers today (`card:<id>`, `git:<sha>`, `kanban_cards:<id>`), but a future caller
// (the capture worker, MT-05) is untrusted input -- validate the shape here, at the one place
// every write already passes through, rather than trusting every future caller to repeat it.
const SAFE_ID_PATTERN = /^[A-Za-z0-9:_.-]+$/
const GATE_SHA_PATTERN = /^[0-9a-f]{7,64}(,[0-9a-f]{7,64})*$/i
const MAX_ID_LENGTH = 300
const MAX_SOURCE_REF_LENGTH = 500
const MAX_GATE_SHA_LENGTH = 200

function assertValidIdentifiers(input: KgNodeInput): void {
  if (!input.id || input.id.length > MAX_ID_LENGTH || !SAFE_ID_PATTERN.test(input.id)) {
    throw new KgValidationError('id', `must be 1-${MAX_ID_LENGTH} chars of [A-Za-z0-9:_.-]`)
  }
  if (
    !input.source_ref ||
    input.source_ref.length > MAX_SOURCE_REF_LENGTH ||
    !SAFE_ID_PATTERN.test(input.source_ref)
  ) {
    throw new KgValidationError('source_ref', `must be 1-${MAX_SOURCE_REF_LENGTH} chars of [A-Za-z0-9:_.-]`)
  }
  if (input.gate_sha != null && input.gate_sha !== '') {
    if (input.gate_sha.length > MAX_GATE_SHA_LENGTH || !GATE_SHA_PATTERN.test(input.gate_sha)) {
      throw new KgValidationError('gate_sha', 'must be one or more comma-separated 7-64 char hex shas')
    }
  }
}

// F2 (eeb57483): the schema's CHECK constraints (title<=200, body<=8000, snippet<=12000) reject
// the row outright -- measured on the live table, 16/811 card titles exceed 200 chars (max 270).
// Truncate rather than reject: a long title is a card someone actually titled that way, not a
// malformed input, and the MODULTERV calls this cosmetic metadata, not identity (the id column
// carries identity). Truncation beats silent corruption of "the whole import stops here".
function capLength(text: string | null | undefined, max: number): string | null | undefined {
  if (text == null) return text
  return text.length > max ? text.slice(0, max) : text
}

// F-a (card 4ecd75d0, WhiteHat 22805/23292): upsertNode is the ONE write path every kg-* importer
// goes through, but it stored title/body/snippet/keywords UNFILTERED -- invisible/BIDI/control
// characters (a Unicode tag character, an RLO override, a ZWSP, a C0/C1 control) all passed
// straight into a node that the capture pipeline's OWN output-side check (isSafeDraftField,
// capture-pipeline.ts) would have rejected outright had it arrived through that path instead. Every
// kg-importer (comments, DECISIONS.md entries, cold-memory rows, kanban card titles pulled in as
// `card` nodes) shares this same unfiltered gap, so the fix belongs HERE, once, not per-importer.
// The regex is the SAME one capture-pipeline.ts's isSafeDraftField/frameReviewAsData already use on
// LLM input/output (imported from here, not duplicated back -- capture-pipeline.ts already imports
// upsertNode/findSecretShape from this module, so the dependency only runs one way).
// NO 'g' FLAG on the exported constant, deliberately: capture-pipeline.ts's isSafeDraftField calls
// `.test()` on this exact object repeatedly across many parseDraft() calls, and a global regex's
// `.test()` advances `lastIndex` as a SIDE EFFECT -- the next call then resumes mid-string instead
// of from the start, silently missing a real match. sanitizeKgText below needs global replacement,
// so it builds its OWN throwaway global instance from `.source` instead of mutating this one --
// same pattern capture-pipeline.ts's frameReviewAsData already uses for the identical reason.
// "szomszéd-karakter" gap (card f66b3652, RedHat 23202/23225, landed on develop while this move was
// in flight): the class is a hand-picked list, not a Unicode category, so the Cf/Cc neighbors of
// every character above were still unfiltered -- measured against Unicode 16.0 unicodedata:
// interlinear annotation terminator, Khmer vowel inherent AA, more musical-notation format chars,
// the full Mongolian free-variation-selector block, and the Arabic/Syriac/Kaithi/Egyptian-
// hieroglyph/shorthand format-control blocks. Carried forward here rather than re-landed on the
// narrower pre-f66b3652 list.
//
// Card 80ab5067 (WhiteHat LOW on 4ecd75d0, Gate-SHA 45237719, F1): an AWS-key-shaped value
// survived sanitize in 14 of 16 crafted variants, built from code points this list still missed:
// - \u{E0000}-\u{E0FFF} widened from the two narrower sub-ranges this file already had
//   (\u{E0000}-\u{E007F} tags, \u{E0100}-\u{E01EF} variation selectors supplement) to the WHOLE
//   contiguous Supplementary Special-purpose Plane allocation (the reserved \u{E0080}-\u{E00FF}
//   and \u{E01F0}-\u{E0FFF} gaps between and after them are Default_Ignorable too -- Unicode
//   reserves the entire plane 14 range for this purpose, assigned or not).
// - ￰-￸ added next to the existing ￹-￻ (deliberately still excludes
//   ￼/�, OBJECT REPLACEMENT CHARACTER / REPLACEMENT CHARACTER -- those are visible
//   mojibake markers, not invisible carriers).
// - ￾￿ and one pair per astral plane (\u{xFFFE}-\u{xFFFF} for every plane 1-16) added:
//   the full Unicode NONCHARACTER set (together with the existing ﷐-﷯ range below),
//   66 code points total -- guaranteed never assigned a meaning, so a value using one to dodge a
//   literal denylist is unambiguous.
// - ⠀ (BRAILLE PATTERN BLANK) added: visually empty like the rest of this list even though
//   it is a real assigned Lo-category letter, not Default_Ignorable -- the same practical risk
//   (a "blank" separator inside a value that defeats a secret-shape regex) as the intentionally
//   invisible characters above.
// NFKC normalization runs in sanitizeKgText BEFORE this strip (not folded into the regex itself):
// a compatibility-equivalent character that NFKC rewrites INTO one of the ranges here must still
// be caught, and normalizing first is the only order that guarantees it.
export const UNSAFE_CHARS_RX = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00ad\\u061c' +
    '\\u0600-\\u0605\\u06dd\\u070f\\u0890-\\u0891\\u08e2\\u180b-\\u180f' +
    '\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\u2800\\u3164\\ufeff' +
    '\\u034f\\u115f\\u1160\\u17b4-\\u17b5\\u206a-\\u206f\\ufe00-\\ufe0f\\uffa0' +
    '\\ufdd0-\\ufdef\\ufff0-\\ufff8\\ufff9-\\ufffb\\ufffe\\uffff' +
    '\\u{1fffe}-\\u{1ffff}\\u{2fffe}-\\u{2ffff}\\u{3fffe}-\\u{3ffff}\\u{4fffe}-\\u{4ffff}' +
    '\\u{5fffe}-\\u{5ffff}\\u{6fffe}-\\u{6ffff}\\u{7fffe}-\\u{7ffff}\\u{8fffe}-\\u{8ffff}' +
    '\\u{9fffe}-\\u{9ffff}\\u{afffe}-\\u{affff}\\u{bfffe}-\\u{bffff}\\u{cfffe}-\\u{cffff}' +
    '\\u{dfffe}-\\u{dffff}\\u{efffe}-\\u{effff}\\u{ffffe}-\\u{fffff}\\u{10fffe}-\\u{10ffff}' +
    '\\u{110BD}\\u{110CD}\\u{13430}-\\u{1343F}\\u{1BCA0}-\\u{1BCA3}' +
    '\\u{E0000}-\\u{E0FFF}\\u{1D173}-\\u{1D17A}]',
  'u',
)

/** Strips (never rejects -- these are importer rows, not adversarial LLM output) every invisible,
 *  BIDI-override and control character from a kg_nodes text field. Exported so every kg-importer
 *  can apply the SAME sanitization to text that reaches upsertNode by a path other than its own
 *  string fields (e.g. a card title copied in as a `card` node's title) -- still cheap/idempotent
 *  to call twice.
 *
 *  Card 80ab5067 (WhiteHat LOW on 4ecd75d0, F1): NFKC-normalizes FIRST, strips UNSAFE_CHARS_RX
 *  second. Order matters both ways: a compatibility-equivalent character can NFKC-decompose INTO
 *  one of the code points UNSAFE_CHARS_RX strips (stripping first would miss it), and normalizing
 *  the text that is actually STORED (not a copy used only for a downstream check) closes the
 *  compatibility-character half of the same gap the widened UNSAFE_CHARS_RX closes for the
 *  literal-code-point half -- the two are independent escape routes to the same problem, so both
 *  letters of the finding ("ranges" and "no NFKC") need a fix, not either alone. */
export function sanitizeKgText<T extends string | null | undefined>(text: T): T {
  if (text == null) return text
  const normalized = text.normalize('NFKC')
  return normalized.replace(new RegExp(UNSAFE_CHARS_RX.source, 'gu'), '') as T
}

/** Reuses the SAME patterns the commit-time secret-gate scans diffs with (src/security/
 *  secret-gate.ts), so a node body is held to the same bar as a commit -- one source of truth
 *  for "what a secret shape looks like", not a second regex list that can drift from the first. */
export function findSecretShape(text: string | null | undefined): string | null {
  if (!text) return null
  for (const { name, pattern } of SECRET_PATTERNS) {
    // SECRET_PATTERNS entries may carry the `g`/`y` flag from prior use elsewhere; .test() on a
    // global regex advances lastIndex, which would make a second call on the same pattern silently
    // skip matches. A fresh RegExp per call sidesteps that without touching the shared constant.
    const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
    if (re.test(text)) return name
  }
  return null
}

function assertNoSecretShape(fields: Record<string, string | null | undefined>): void {
  for (const [field, value] of Object.entries(fields)) {
    const hit = findSecretShape(value)
    if (hit) throw new KgSecretError(field, hit)
  }
}

// --- KG-local secret/PII shapes (card 03dff487, Cybersec MEDIUM-2 on 4e9ad774/81593084) ---
//
// These stay OUT of the shared src/security/secret-gate.ts SECRET_PATTERNS on purpose: the
// tracked tree itself has bare 64-hex in 15 files and password-shaped assignments in 37
// (measured by Cybersec, comment 32780 on 4e9ad774) -- a blanket addition there would reject the
// repo's own content. A kg_nodes field is extracted memory/finding prose, not source code, so a
// tighter, KG-only screen applies here instead. MikroB's decision (card description): phase 1 is
// key=value assignments with a length floor and placeholder exclusions; bare 64-hex/base64 only
// reject with a key-ish word nearby, otherwise report-only (left to the backfill dry-run,
// scripts/kg-secret-shape-scan.ts); email/phone are REDACTED, not rejected, so one PII token does
// not cost the whole node.

const KG_LOCAL_PLACEHOLDER_RX = /^(x+|changeme|example|\.{3}|<.*>|\$\{.*\})$/i

function isKgLocalPlaceholderValue(value: string): boolean {
  return KG_LOCAL_PLACEHOLDER_RX.test(value.trim())
}

// `*_API_KEY=`/`password=` assignment shape: an unprefixed `SOME_SERVICE_API_KEY=...` or
// `password=...`/`password: ...`, case-insensitive key, with a minimum value length (8) so a
// one-character placeholder slips through before it even reaches the exclusion list.
const KG_LOCAL_KV_SECRET_RX = /\b([A-Za-z0-9_]*_API_KEY|password)\s*[:=]\s*(['"]?)([^\s'",;]{1,200})\2/gi

function findKgLocalKvSecret(text: string): string | null {
  for (const m of text.matchAll(KG_LOCAL_KV_SECRET_RX)) {
    const value = m[3]
    if (value.length >= 8 && !isKgLocalPlaceholderValue(value)) return `${m[1].toLowerCase()}=`
  }
  return null
}

// Bare 64-hex and base64 blobs are high-false-positive on their own (a git sha, a hash digest, a
// base64-encoded image are all benign) -- reject only with a key-ish word nearby, the same
// "report, don't block, unless there's context" the card's description asks for.
const KG_LOCAL_HEX64_RX = /\b[0-9a-f]{64}\b/gi
const KG_LOCAL_BASE64_BLOB_RX = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g
const KG_LOCAL_KEY_CONTEXT_RX = /\b(key|secret|token|password|credential|api)\b/i
const KG_LOCAL_CONTEXT_WINDOW = 40

function hasKgLocalKeyContext(text: string, index: number): boolean {
  const start = Math.max(0, index - KG_LOCAL_CONTEXT_WINDOW)
  return KG_LOCAL_KEY_CONTEXT_RX.test(text.slice(start, index))
}

function findKgLocalContextualSecret(text: string): string | null {
  for (const m of text.matchAll(KG_LOCAL_HEX64_RX)) {
    if (hasKgLocalKeyContext(text, m.index ?? 0)) return 'bare 64-hex (key context)'
  }
  for (const m of text.matchAll(KG_LOCAL_BASE64_BLOB_RX)) {
    if (hasKgLocalKeyContext(text, m.index ?? 0)) return 'base64 blob (key context)'
  }
  return null
}

/** KG-local reject-worthy shapes only (used by upsertNode, in addition to the shared
 *  SECRET_PATTERNS check) -- the 64-hex/base64 shapes here REQUIRE key context; without it they
 *  are report-only (see kgLocalSecretShapeCounts, used by the backfill dry-run instead). */
export function findKgLocalSecretShape(text: string | null | undefined): string | null {
  if (!text) return null
  return findKgLocalKvSecret(text) ?? findKgLocalContextualSecret(text)
}

function assertNoKgLocalSecretShape(fields: Record<string, string | null | undefined>): void {
  for (const [field, value] of Object.entries(fields)) {
    const hit = findKgLocalSecretShape(value)
    if (hit) throw new KgSecretError(field, hit)
  }
}

// Email / Hungarian phone number: redact rather than reject (MikroB's decision in the card
// description) -- an email or phone number inside otherwise-legitimate memory/finding prose
// should not cost the whole node, unlike a key=value secret or a high-confidence key blob, where
// the field is either not worth keeping or trivially reconstructed from the rest.
// Same shapes src/skill-scan.ts already uses for its own PII rules (email-address,
// hu-phone-number) -- reused here as literal regexes rather than imported, since skill-scan.ts
// is an unrelated feature (skill-body scanning) and this module should not depend on it.
const KG_LOCAL_EMAIL_RX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const KG_LOCAL_HU_PHONE_RX = /(?<!\d)(\+36|0036|06)[ -]?(\d{1,2})[ -]?\d{3}[ -]?\d{3,4}(?!\d)/g

/** Replaces every email/phone match with a fixed placeholder, in place of findSecretShape's
 *  reject-and-throw -- the card's decision for PII specifically. Exported like sanitizeKgText so
 *  an importer that builds a field outside upsertNode's own string inputs can apply the same
 *  redaction before the text reaches upsertNode. */
export function redactKgLocalPii<T extends string | null | undefined>(text: T): T {
  if (text == null) return text
  return (text as string)
    .replace(KG_LOCAL_EMAIL_RX, '[redacted:email]')
    .replace(KG_LOCAL_HU_PHONE_RX, '[redacted:phone]') as T
}

/** Report-only counts for the backfill dry-run (Kesz-ha point 3): how many matches of EACH of
 *  the 5 shapes exist in this text, WITHOUT the write-path's context requirement for 64-hex/
 *  base64 -- a wider net on purpose, so the dry-run tells the operator the true collision
 *  surface, not just what the write path would currently block. Never called from upsertNode. */
export function kgLocalSecretShapeCounts(text: string | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {
    'kv-secret (password=/*_API_KEY=)': 0,
    'bare-64-hex': 0,
    'base64-blob': 0,
    email: 0,
    phone: 0,
  }
  if (!text) return counts
  for (const m of text.matchAll(KG_LOCAL_KV_SECRET_RX)) {
    if (m[3].length >= 8 && !isKgLocalPlaceholderValue(m[3])) counts['kv-secret (password=/*_API_KEY=)']++
  }
  counts['bare-64-hex'] = [...text.matchAll(KG_LOCAL_HEX64_RX)].length
  counts['base64-blob'] = [...text.matchAll(KG_LOCAL_BASE64_BLOB_RX)].length
  counts.email = [...text.matchAll(KG_LOCAL_EMAIL_RX)].length
  counts.phone = [...text.matchAll(KG_LOCAL_HU_PHONE_RX)].length
  return counts
}

export interface KgNodeInput {
  id: string
  type: KgNodeType
  project: string
  title: string
  body?: string | null
  snippet?: string | null
  snippet_lang?: string | null
  keywords?: string | null
  status?: 'draft' | 'active' | 'stale' | 'superseded' | 'archived'
  source_ref: string
  gate_sha?: string | null
  extractor: string
  embedding?: Buffer | null
  embed_model?: string | null
}

export interface KgEdgeInput {
  src: string
  dst: string
  rel: KgEdgeRel
  weight?: number
  source: string
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export function kgDbPath(storeDir: string = STORE_DIR): string {
  return join(storeDir, KG_DB_FILENAME)
}

function currentVersion(db: Database.Database): number {
  const row = db.pragma('user_version', { simple: true }) as number
  return row
}

/** Runs every migration whose version is above the DB's current user_version, in order. A fresh
 *  file starts at user_version 0, so this also IS the initial schema creation -- there is no
 *  separate "create" path to drift from "migrate". */
export function migrate(db: Database.Database, toVersion: number = KG_SCHEMA_VERSION): void {
  const have = currentVersion(db)
  if (have >= toVersion) return
  const tx = db.transaction(() => {
    for (const m of MIGRATIONS) {
      if (m.version <= have || m.version > toVersion) continue
      for (const stmt of m.up) db.exec(stmt)
      db.pragma(`user_version = ${m.version}`)
    }
  })
  tx()
}

/** The tested rollback path (EK-MT-1): runs down-migrations in reverse version order until the
 *  DB's user_version reaches toVersion. toVersion=0 drops every kg_* table/trigger/FTS index the
 *  schema created, leaving a plain empty SQLite file -- the "rm + rebuild" recovery path (section
 *  4 of the MODULTERV) is then just migrate() again on that same emptied file, exercised by
 *  rebuild() below. */
export function migrateDown(db: Database.Database, toVersion: number = 0): void {
  const have = currentVersion(db)
  if (have <= toVersion) return
  const tx = db.transaction(() => {
    for (const m of [...MIGRATIONS].sort((a, b) => b.version - a.version)) {
      if (m.version > have || m.version <= toVersion) continue
      for (const stmt of m.down) db.exec(stmt)
      db.pragma(`user_version = ${m.version - 1}`)
    }
  })
  tx()
}

export function openKgDb(dbPath: string = kgDbPath()): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  // Concurrent-write risk flagged in the plan-grilling verdict (3f6fc4ce comment 20727): multiple
  // agents landing/closing cards at once can both touch this file. WAL lets readers proceed
  // during a writer; busy_timeout (not asserted by WAL mode itself) turns a second writer's
  // contention into a bounded wait instead of an immediate SQLITE_BUSY throw, following the same
  // pattern already proven on claudeclaw.db (src/channel-coordinator/ingest.ts).
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

/** The "teljes újraépítés" recovery path (section 4): close the handle, delete the file (and its
 *  WAL/SHM sidecars), then reopen+migrate on a clean file. Tested directly (not just described)
 *  by kg-store.test.ts, since the graph is fully derivable from source data and this IS the
 *  documented disaster-recovery procedure, not a hypothetical one. */
export function rebuild(db: Database.Database, dbPath: string): Database.Database {
  db.close()
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix
    if (existsSync(p)) unlinkSync(p)
  }
  return openKgDb(dbPath)
}

export function upsertNode(db: Database.Database, input: KgNodeInput): void {
  assertValidIdentifiers(input)
  // F-a (card 4ecd75d0): sanitize BEFORE the secret-shape check, not after -- an invisible
  // character inserted inside a token (e.g. a ZWSP mid-hash) could otherwise dodge
  // findSecretShape's regexes while still reconstituting into the real secret on display/copy.
  const sanitizedTitle = sanitizeKgText(input.title)
  const sanitizedBody = sanitizeKgText(input.body)
  const sanitizedSnippet = sanitizeKgText(input.snippet)
  const sanitizedKeywords = sanitizeKgText(input.keywords)
  // Card 03dff487 (KG-local secret/PII shapes): PII redaction runs BEFORE both secret-shape
  // checks, same reasoning as sanitizeKgText running before them -- the checks and the stored
  // text must agree on what is actually being written, and an email/phone match must never
  // reach either check as a reject candidate once the card's decision is to redact it instead.
  const piiRedactedTitle = redactKgLocalPii(sanitizedTitle)
  const piiRedactedBody = redactKgLocalPii(sanitizedBody)
  const piiRedactedSnippet = redactKgLocalPii(sanitizedSnippet)
  const piiRedactedKeywords = redactKgLocalPii(sanitizedKeywords)
  assertNoSecretShape({
    title: piiRedactedTitle,
    body: piiRedactedBody,
    snippet: piiRedactedSnippet,
    keywords: piiRedactedKeywords,
  })
  assertNoKgLocalSecretShape({
    title: piiRedactedTitle,
    body: piiRedactedBody,
    snippet: piiRedactedSnippet,
    keywords: piiRedactedKeywords,
  })
  const now = nowSec()
  const title = capLength(piiRedactedTitle, 200) as string
  const body = capLength(piiRedactedBody ?? null, 8000)
  const snippet = capLength(piiRedactedSnippet ?? null, 12000)

  const tx = db.transaction(() => {
    // F1 (eeb57483, WhiteHat GO condition on ee9ee17b): a re-import (e.g. importFromRelations
    // running again after a card was archived) must not silently reactivate an archived node --
    // the archived state is a deliberate decision (setNodeStatus), not metadata a later import run
    // should be able to overwrite. Preserve it and audit the blocked attempt instead of applying
    // the caller's requested status.
    // F1-a (card eeb57483 RedHat, card 0deb6893): the protection above covered ONLY 'archived' --
    // 'superseded' is set by the exact same sanctioned, audited path (setNodeStatus) and is just
    // as deliberate a decision, but a re-import still silently flipped it back to 'active'
    // with no audit trail at all. Protect both terminal-ish states the same way.
    const existing = db.prepare('SELECT status FROM kg_nodes WHERE id = ?').get(input.id) as
      | { status: string }
      | undefined
    const requestedStatus = input.status ?? 'active'
    const isProtected = existing?.status !== undefined && PROTECTED_STATUSES.has(existing.status)
    const finalStatus = isProtected ? existing!.status : requestedStatus
    if (isProtected && requestedStatus !== existing!.status) {
      db.prepare(
        'INSERT INTO kg_audit (node_id, action, actor, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(input.id, 'import_reactivation_blocked', input.extractor, existing!.status, requestedStatus, now)
    }

    db.prepare(
      `INSERT INTO kg_nodes
         (id, type, project, title, body, snippet, snippet_lang, keywords, status, source_ref,
          gate_sha, quality, extractor, embedding, embed_model, created_at, updated_at)
       VALUES (@id, @type, @project, @title, @body, @snippet, @snippet_lang, @keywords, @status,
          @source_ref, @gate_sha, 0, @extractor, @embedding, @embed_model, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, body=excluded.body, snippet=excluded.snippet,
         snippet_lang=excluded.snippet_lang, keywords=excluded.keywords, status=excluded.status,
         source_ref=excluded.source_ref, gate_sha=excluded.gate_sha, extractor=excluded.extractor,
         embedding=excluded.embedding, embed_model=excluded.embed_model, updated_at=excluded.updated_at`,
    ).run({
      id: input.id,
      type: input.type,
      project: input.project,
      title,
      body,
      snippet,
      snippet_lang: input.snippet_lang ?? null,
      keywords: piiRedactedKeywords ?? null,
      status: finalStatus,
      source_ref: input.source_ref,
      gate_sha: input.gate_sha ?? null,
      extractor: input.extractor,
      embedding: input.embedding ?? null,
      embed_model: input.embed_model ?? null,
      created_at: now,
      updated_at: now,
    })
  })
  tx()
}

/** INSERT OR IGNORE: the composite primary key (src,dst,rel) already gives idempotency, same
 *  pattern as kanban_relations (src/db.ts writeRelationEdges) -- re-running an import is a no-op
 *  rather than a duplicate-row problem. */
export function upsertEdge(db: Database.Database, input: KgEdgeInput): number {
  const now = nowSec()
  return db.prepare(
    `INSERT OR IGNORE INTO kg_edges (src, dst, rel, weight, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.src, input.dst, input.rel, input.weight ?? 1.0, input.source, now).changes
}

/** The only sanctioned way to change a node's status (section 5 állapotgép): every transition is
 *  audited (kg_audit), which a raw `UPDATE kg_nodes SET status=...` would silently skip. */
export function setNodeStatus(
  db: Database.Database,
  nodeId: string,
  status: 'draft' | 'active' | 'stale' | 'superseded' | 'archived',
  actor: string,
): void {
  const before = db.prepare('SELECT status FROM kg_nodes WHERE id = ?').get(nodeId) as
    | { status: string }
    | undefined
  if (!before) throw new Error(`kg node not found: ${nodeId}`)
  const now = nowSec()
  const tx = db.transaction(() => {
    db.prepare('UPDATE kg_nodes SET status = ?, updated_at = ? WHERE id = ?').run(status, now, nodeId)
    db.prepare(
      'INSERT INTO kg_audit (node_id, action, actor, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(nodeId, 'status_change', actor, before.status, status, now)
  })
  tx()
}

export function getNode(db: Database.Database, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
}

// MT-09 (card 9e2c33c2): anchor CRUD. repo/path/sha are untrusted the same way id/source_ref are
// (a future capture worker, MT-05, is the eventual caller) -- repo and sha get the same tight
// patterns id already uses; path gets its own pattern because a git `show <sha>:<path>` call is
// the whole point of an anchor, and an unchecked ".." or a leading "/" would let a bad anchor read
// outside the intended repo tree (the caller still scopes `git -C <repo-dir>`, but the row itself
// should not be able to claim a path that was never a valid in-repo path to begin with).
const SAFE_REPO_PATTERN = /^[A-Za-z0-9_-]+$/
// Allows both real in-repo file paths (src/kg/store.ts) and synthetic DB-record references
// (kanban_comments:abc123, kanban_cards:abc123) used by the capture pipeline (MT-02/MT-05).
// The colon is safe here: the path-traversal concern is ".." segments and a leading "/", not
// namespace separators that never appear in a `git show <sha>:<path>` context.
const SAFE_ANCHOR_PATH_PATTERN = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_.:/-]+$/
const ANCHOR_SHA_PATTERN = /^[0-9a-f]{7,64}$/i

export interface KgAnchorInput {
  node_id: string
  repo: string
  path: string
  symbol?: string | null
  line_start?: number | null
  line_end?: number | null
  sha: string
  content_hash?: string | null
  state?: 'fresh' | 'drifted' | 'gone'
}

export interface KgAnchorRow {
  id: number
  node_id: string
  repo: string
  path: string
  symbol: string | null
  line_start: number | null
  line_end: number | null
  sha: string
  content_hash: string | null
  state: 'fresh' | 'drifted' | 'gone'
  checked_at: number
}

function assertValidAnchor(input: KgAnchorInput): void {
  if (!SAFE_REPO_PATTERN.test(input.repo)) {
    throw new KgValidationError('repo', 'must match [A-Za-z0-9_-]+')
  }
  if (!SAFE_ANCHOR_PATH_PATTERN.test(input.path)) {
    throw new KgValidationError('path', 'must be a relative in-repo path with no ".." segment')
  }
  if (!ANCHOR_SHA_PATTERN.test(input.sha)) {
    throw new KgValidationError('sha', 'must be a 7-64 char hex sha')
  }
}

/** Upsert keyed on (node_id, repo, path, symbol), looked up with `symbol IS ?` rather than relying
 *  on the schema's UNIQUE constraint + ON CONFLICT: SQLite treats NULL != NULL in a unique index,
 *  so an anchor with no symbol (whole-file anchor) would silently accumulate duplicate rows under
 *  ON CONFLICT instead of updating in place. This lookup works the same for both cases. */
export function upsertAnchor(db: Database.Database, input: KgAnchorInput): number {
  assertValidAnchor(input)
  const now = nowSec()
  const existing = db
    .prepare('SELECT id FROM kg_anchors WHERE node_id = ? AND repo = ? AND path = ? AND symbol IS ?')
    .get(input.node_id, input.repo, input.path, input.symbol ?? null) as { id: number } | undefined
  if (existing) {
    db.prepare(
      `UPDATE kg_anchors SET line_start = ?, line_end = ?, sha = ?, content_hash = ?, state = ?,
         checked_at = ? WHERE id = ?`,
    ).run(
      input.line_start ?? null,
      input.line_end ?? null,
      input.sha,
      input.content_hash ?? null,
      input.state ?? 'fresh',
      now,
      existing.id,
    )
    return existing.id
  }
  const info = db
    .prepare(
      `INSERT INTO kg_anchors
         (node_id, repo, path, symbol, line_start, line_end, sha, content_hash, state, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.node_id,
      input.repo,
      input.path,
      input.symbol ?? null,
      input.line_start ?? null,
      input.line_end ?? null,
      input.sha,
      input.content_hash ?? null,
      input.state ?? 'fresh',
      now,
    )
  return Number(info.lastInsertRowid)
}

export function getAnchorsForPath(db: Database.Database, repo: string, path: string): KgAnchorRow[] {
  return db
    .prepare('SELECT * FROM kg_anchors WHERE repo = ? AND path = ?')
    .all(repo, path) as KgAnchorRow[]
}

/** The only sanctioned way to change an anchor's state (mirrors setNodeStatus): audits every actual
 *  state transition to kg_audit under the anchor's owning node_id, so "why did this go stale" is
 *  answerable the same way "why did this node change status" already is. A same-state refresh (only
 *  checked_at/content_hash moving, e.g. re-confirming 'fresh') is not an audited transition. */
export function setAnchorState(
  db: Database.Database,
  anchorId: number,
  state: 'fresh' | 'drifted' | 'gone',
  contentHash: string | null,
  actor: string,
): void {
  const before = db.prepare('SELECT node_id, state FROM kg_anchors WHERE id = ?').get(anchorId) as
    | { node_id: string; state: string }
    | undefined
  if (!before) throw new Error(`kg anchor not found: ${anchorId}`)
  const now = nowSec()
  const tx = db.transaction(() => {
    db.prepare('UPDATE kg_anchors SET state = ?, content_hash = ?, checked_at = ? WHERE id = ?').run(
      state,
      contentHash,
      now,
      anchorId,
    )
    if (before.state !== state) {
      db.prepare(
        'INSERT INTO kg_audit (node_id, action, actor, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(before.node_id, 'anchor_state_change', actor, before.state, state, now)
    }
  })
  tx()
}

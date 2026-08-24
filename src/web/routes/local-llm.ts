import { spawn, execFile } from 'node:child_process'
import { readFileSync, existsSync, openSync, fstatSync, readSync, closeSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { STORE_DIR, MAIN_AGENT_ID } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { decideModelTrust, relabelCatalogueTrust } from '../../local-llm-model-trust.js'
import { readBenchState, benchInfoFor } from '../../local-llm-bench-state.js'
import { getDb, createAgentMessage } from '../../db.js'
import { pickTemplate } from '../../local-llm-template-picker.js'
import {
  enqueue as enqueueLocalLlm,
  startDirect as startDirectLocalLlm,
  claimNext as claimNextLocalLlm,
  complete as completeLocalLlm,
  fail as failLocalLlm,
  abstain as abstainLocalLlm,
  verifyOutput,
  isDirectSyncCall,
  reclaimStaleRunning as reclaimStaleLocalLlm,
  getById as queueGetById,
  listRecent as queueListRecent,
  stats as queueStats,
  statsByAgent as queueStatsByAgent,
  resolveEscalationTarget,
  buildEscalationMessage,
  type QueueStatus,
} from '../../local-llm-queue.js'
import { getUtilizationSamples } from '../local-llm-utilization-history.js'
import { readWeeklySnapshot } from '../../costops/weekly-limit.js'

/** A queue row still `running` after this long means its worker died: the 7B's slowest measured
 *  call is ~70s, so 10 minutes used to be far past any legitimate run -- true for a WORKER-claimed
 *  row, whose started_at is set right before it shells out. Card 5dcd9bc8 added a SECOND source of
 *  `running` rows: a direct-sync local-llm.sh call registers itself BEFORE it even attempts the GPU
 *  flock (store/local-llm.sh's GPU_LOCK_WAIT, default 600s), so its legitimate started_at-to-finish
 *  span can reach GPU_LOCK_WAIT + TIMEOUT (default 120s) = 720s under real contention -- past the
 *  old 10-minute threshold while the call is still genuinely alive. Reclaiming it early would flip
 *  it back to `pending`, where local-llm-worker.sh's claimNext() could then hand a PLACEHOLDER row
 *  (see DIRECT_CALL_PLACEHOLDER) to the model as if it were real work. 20 minutes keeps a
 *  comfortable margin over the 720s default worst case for either row source. */
const STALE_RUNNING_MS = 20 * 60 * 1000

/** Upper bound on a queued prompt. Not the main defence (the caller is authenticated) -- it stops a
 *  runaway caller from parking megabytes in the queue and monopolising the single GPU slot. */
const MAX_QUEUE_PROMPT_BYTES = 100_000

/**
 * Fire the inter-agent notification for a row that just moved to `escalated` (card 03fca184). Never
 * throws -- an escalation is best-effort on top of the state transition that already landed; a
 * message-send failure must not make the fail()/reclaim() call itself look like it failed, same
 * discipline as fireKanbanDispatch in routes/kanban.ts.
 */
function notifyEscalation(id: number): void {
  try {
    const row = queueGetById(getDb(), id)
    if (!row || row.status !== 'escalated') return
    const target = resolveEscalationTarget(getDb(), row, MAIN_AGENT_ID)
    createAgentMessage(MAIN_AGENT_ID, target, buildEscalationMessage(row))
    logger.info({ id, target }, 'Local-LLM queue row escalated to online agent')
  } catch (err) {
    logger.warn({ id, err }, 'Local-LLM queue escalation notify failed (state transition already landed)')
  }
}
import {
  RAMP_FLOOR_AGGRESSIVENESS,
  rampAggressiveness,
  readThresholdConfig,
  readWeeklyPercent,
  resolveAggressivenessSource,
  type AggressivenessSource,
} from '../../costops/weekly-threshold.js'
import type { RouteContext } from './types.js'

// ---------------------------------------------------------------------------
// Local offload LLM (Ollama on the WSL GPU) control surface.
//
// SECURITY: this is a trust boundary -- these endpoints trigger model pulls,
// swap the active model, and run generations from the browser. Every one is
// behind the /api/* Bearer gate enforced in src/web.ts (do NOT re-auth here,
// do NOT add to any public-path allowlist). User input NEVER reaches a shell:
// all child processes are spawned with an argv array (execFile / spawn), never
// a `sh -c`-style string, and the run-prompt is piped via stdin. Model names
// are charset-validated before any use; the prompt is length-capped; every
// spawned process has a timeout. No secret (dashboard token, env) is surfaced.
// ---------------------------------------------------------------------------

const OLLAMA_BASE = 'http://127.0.0.1:11434'
const MODEL_FILE = join(STORE_DIR, 'local-llm-model')
// The embedding model is used exclusively for memory/RAG vector search (src/db.ts).
// It never receives code/task dispatches. Exposed in the status response so the
// dashboard can show both roles clearly and avoid the "nomic gets tasks too?" confusion.
const EMBED_MODEL = 'nomic-embed-text'
// Ollama's /api/tags always reports the resolved name with its tag (e.g. "nomic-embed-text:latest"),
// even when the model was configured/referenced without one -- a bare comparison against a tagless
// name then reports "not pulled" for a model that is actually present.
function modelNameMatches(catalogName: string, configuredName: string): boolean {
  if (catalogName === configuredName) return true
  const bare = configuredName.includes(':') ? configuredName : `${configuredName}:latest`
  return catalogName === bare
}
const RAG_SCRIPT = join(STORE_DIR, 'local-llm-rag.sh')
// Card 0c054ebf: the --task preset templates ARE the category list -- this directory is the single
// source of truth (readdirSync below), never a hand-maintained UI array that could drift from what
// local-llm.sh actually offers. HU descriptions are curated (no other source carries prose text),
// keyed by filename; an on-disk category with no curated entry still appears (name-only fallback).
const SKILL_DIR = join(STORE_DIR, 'local-llm-skills')
// Append-only usage ledger written by the instrumented local-llm wrappers.
// One TSV line per real model invocation:
//   epoch_seconds \t caller \t task \t model \t ms \t status \t source
const USAGE_FILE = join(STORE_DIR, 'local-llm-usage.log')
const BRIDGE_UNIT = 'quota-bridge.service'
const OLLAMA_UNIT = 'ollama'
// Proactive-offload control (card 48f3b675): the aggressiveness slider persists into the SAME config
// the fleet agents + the local-llm-offload skill read. 0 = never offload, 100 = offload maximally.
const OFFLOAD_CONFIG_FILE = join(STORE_DIR, 'local-llm-offload-active.json')
// GPU-filtered, trust-labelled HuggingFace model catalogue (card 61a4a85f, EPIC ebc7b4dd T4).
// The script owns cache/staleness/fallback itself (store/llm-catalog.py: envelope()/fallback()) --
// this route only decides WHEN to pay for a live refresh, never reimplements those semantics.
const LLM_CATALOG_SCRIPT = join(STORE_DIR, 'llm-catalog.py')
const LLM_CATALOG_CACHE_FILE = join(STORE_DIR, 'llm-catalog-cache.json')
// The REVIEWED trust list, and the content-addressed blob directory the digest check compares
// against. Both are overridable by env for tests only -- production reads the real locations, and
// nothing here decides anything from an environment variable that is absent in production.
const LLM_CATALOG_TRUST_FILE = join(STORE_DIR, 'llm-catalog-trust.json')
// Written ONLY by store/local-llm-bench.sh, on a run that actually succeeded.
const LLM_BENCH_STATE_FILE = join(STORE_DIR, 'local-llm-model-state.json')
// The one catalogue schema this build knows how to read (card 4117f98e). It is compared, not
// assumed: a document from another version may have moved the very fields read below.
const CATALOG_SCHEMA_VERSION = 1
const OLLAMA_BLOBS_DIR = process.env.FIRST_RUN_BLOBS || join(homedir(), '.ollama', 'models', 'blobs')
// HuggingFace discovery hits 3 keyword searches + a tree fetch per candidate repo -- slow relative
// to a dashboard poll, and the catalogue does not meaningfully change within a day. A GET this
// page-load-frequent must not refresh live every time.
const LLM_CATALOG_TTL_MS = 12 * 60 * 60 * 1000
const LLM_CATALOG_LIVE_TIMEOUT_MS = 45_000
const LLM_CATALOG_OFFLINE_TIMEOUT_MS = 10_000
// The marked "optimal" point on the slider AND the DEFAULT (card 48f3b675, Peti req 2245): the offload
// GPU (GTX 1660 Ti, ~5 GB usable) is barely loaded (~6% util), so the honest recommendation is to
// offload MORE than a naive middle setting -- and the DEFAULT starts here so the fleet offloads
// aggressively out of the box (more mechanical work to the local model, fewer Claude tokens).
const OPTIMAL_AGGRESSIVENESS = 75
const DEFAULT_AGGRESSIVENESS = OPTIMAL_AGGRESSIVENESS

// Curated HU one-line descriptions per --task preset (card 0c054ebf), mirroring the EN comment
// block in store/local-llm-rag.sh. Keyed by the preset name (== store/local-llm-skills/<name>.txt).
// A category on disk without an entry here still lists (falls back to just its name) -- the
// description map is a UX nicety, never a gate on whether a category is shown or controllable.
const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  code: 'Kódrészlet pontos specifikációból (RAG + önjavító ellenőrző kör)',
  'commit-msg': 'Git diff / változás-összefoglaló -> egy Conventional Commits üzenet',
  'pr-body': 'Commitok vagy diff -> PR-leírás (Summary / Changes / Test plan)',
  changelog: 'Változás-összefoglaló -> Keep-a-Changelog bejegyzések (Added/Changed/Fixed/...)',
  summarize: '1-3 mondatos tényszerű összefoglaló',
  rewrite: 'Világos, tömör szövegjavítás',
  classify: 'Általános osztályozó -> {"label","confidence","reason"} JSON',
  triage: 'E-mail/üzenet triázs -> {"category","reason"} JSON',
  'msg-triage': 'Inter-agent üzenet triázs -> {"category","urgency","suggested_action"} JSON',
  'card-decompose': 'Feladat -> {"phase","tasks":[{"task","subtasks":[...]}]} munkabontás JSON',
  'daily-log': 'Események/jegyzetek -> tömör HU napi napló bejegyzés (MikroB hangnem)',
  'morning-brief': 'E-mail/naptár/hírek -> átfutható HU reggeli összefoglaló',
  'board-reconcile': 'Kártya-lista -> tömör HU board-reconcile összefoglaló + következő lépések',
  'tg-draft': 'Egy gondolat -> nem-kritikus HU Telegram-üzenet vázlat (MikroB hangnem, nincs auto-küldés)',
  translate: 'Forrásszöveg -> fordítás a kért nyelvre (csak az értékek)',
  'doc-draft': 'Kód/diff/spec -> markdown dokumentáció-vázlat',
  'test-scaffold': 'Függvény/spec -> teszt-fájl váz (happy/edge/error, valós assertek)',
  'crud-adapter': 'Entitás/port spec -> CRUD adapter boilerplate (scope-hű, nincs spekulatív extra)',
  docstring: 'Függvény/osztály -> ugyanaz a kód doc-kommentekkel kiegészítve (a kód változatlan)',
  'dep-diff': 'Lockfile/manifest diff -> tömör add/remove/upgrade összefoglaló, major-bump jelzéssel',
  'pr-review': 'Diff -> első körös review-jegyzetek (súlyozott; a végső döntés emberi gate-é)',
  'i18n-keys': 'EN kulcs/érték párok + célnyelv(ek) -> lefordított párok (kulcsok/placeholderek megtartva)',
  regex: 'Leírt minta + példák -> egy regex + MATCH/NO-MATCH ellenőrzés',
  'type-def': 'Minta JSON/használat -> TypeScript típus/interface definíció',
  'sql-migration': 'Leírt séma-változás -> additív forward SQL migráció (+down); DRAFT, gate-kritikus',
  'api-client': 'Végpont-spec -> egy típusos API-kliens függvény (hiba-úttal)',
  'refactor-draft': 'Kód + mechanikus változás -> refaktorált kód, viselkedés változatlan',
  'code-explain': 'Kódrészlet -> tömör, egyszerű nyelvű magyarázat (csak olvasás)',
  'error-i18n': 'Nyers hiba -> i18n kulcs + beszédes, nem-szivárogtató felhasználói üzenet (12. szabály)',
  'env-doc': 'Config/.env minta -> markdown env-változó táblázat (csak nevek, nincs titkos érték)',
  mermaid: 'Leírt folyamat/architektúra -> érvényes mermaid diagram',
  'bugfix-draft': 'Hibás kód + repró -> minimális javítás-vázlat; DRAFT, repró-teszt + gate kell',
  'json-transform': 'JSON + leírt transzformáció -> az eredmény JSON',
  'schema-validator': 'Típus/alak -> futásidejű validátor (zod / JSON Schema)',
  'sample-data': 'Séma + darabszám -> valósághű minta-sorok teszthez/seedhez (nincs valós PII)',
  'a11y-check': 'Markup -> első körös WCAG AA leletek (a QA gate dönt)',
  'responsive-check': 'CSS/markup -> első körös reszponzivitási leletek (13. szabály; a QA gate dönt)',
  'release-notes': 'Changelog/commitok -> felhasználó-orientált kiadási jegyzetek',
  'yaml-config': 'Leírt pipeline -> érvényes YAML (CI/compose/k8s)',
  dockerfile: 'Leírt stack -> Dockerfile-vázlat (nincs sütött titok)',
  'shell-script': 'Leírt feladat -> bash script vázlat (biztonságos alapértékekkel)',
  naming: 'Kód -> elnevezési javaslatok (csak ahol tényleg nem egyértelmű)',
  'action-items': 'Jegyzet/átirat -> markdown teendő-lista',
  'cron-expr': 'Köznyelvi ütemezés -> cron kifejezés + emberi visszaolvasás',
  // Card b82f952f (Peti COSTOPS): further well-bounded, DRAFT-only fuzzy/reviewable presets beyond
  // the first 44 -- generative or judgement tasks the 7B handles reliably, never deterministic
  // transforms (those are code) and never a security/architecture decision.
  'user-story': 'Feature + szerepek -> user story-k (szerep/cél/elfogadási kritérium); DRAFT, min. 5 ahol indokolt',
  'acceptance-criteria': 'User story/feature -> Given/When/Then elfogadási kritériumok (pozitív + negatív); DRAFT, a QA gate dönt',
  'edge-cases': 'Függvény/spec -> tesztelendő edge-case-ek és hibautak listája; DRAFT a teszteléshez',
  'log-summary': 'Zajos logsorok -> tömör hiba/incidens digest (csoportosítva, első teendő); DRAFT triázs',
  keywords: 'Szöveg -> tömör kulcsszó/címke lista (kereséshez/memóriához, csak a szövegből)',
  'alt-text': 'Kép-kontextus -> egy tömör alt-text screen-readerhez (jelentés, nem "kép:"); DRAFT',
  faq: 'Feature/dokumentáció -> rövid GYIK Q&A párok (csak a bemenetből); DRAFT',
  'commit-split': 'Diff/változás -> javasolt logikai commit-bontás (Conventional subjectek); DRAFT',
  // Card 91b68885 (Peti jóváhagyás, 2026-08-02): +15 kategória a 2026-08-02-i javaslat-listából.
  // (A) általános kategóriák + (B) nehezebb programozási kategóriák -- a RELIABLE_CEILING a
  // 2026-08-07-i döntéssel "feature"-ig emelkedett (lásd RELIABLE_CEILING definíciója), csak az
  // "architecture" (cross-file wiring, rendszertervezés) marad mindig online.
  'code-review-checklist': 'Diff -> súlyozott review-checklist (bug/hibakezelés/security/teszt/style)',
  'migration-plan-draft': 'Séma-változás leírás -> lépésenkénti migrációs terv (nem SQL, rollback-lépésekkel)',
  'api-doc-draft': 'Endpoint/kód -> OpenAPI-szerű doksi-vázlat',
  'onboarding-doc': 'Modul/repo -> gyors "hogyan indulj el" onboarding doksi',
  'incident-postmortem-draft': 'Incidens-log/repró -> blameless postmortem-vázlat (idővonal/ok/fix/teendő)',
  'module-impl': 'Modul-specifikáció -> teljes multi-függvényes modul (egyfájlos, module-szint); DRAFT',
  'class-impl': 'Osztály-specifikáció -> teljes osztály minden metódussal; DRAFT',
  'state-machine-impl': 'Leírt átmenetek -> állapotgép implementáció (érvénytelen átmenet explicit elutasítva); DRAFT',
  'algorithm-impl': 'Bounded algoritmus-specifikáció -> implementáció + komplexitás-komment; DRAFT',
  'parser-impl': 'Leírt grammatika -> kis parser/tokenizer implementáció; DRAFT',
  'rate-limiter-impl': 'Limitálási szabály -> rate-limiter/backoff wrapper (fail-closed alapértelmezés); DRAFT',
  'validation-pipeline': 'Validációs lépések -> pipeline, ami MINDEN hibát összegyűjt, nem csak az elsőt; DRAFT',
  'cache-wrapper-impl': 'Cache-szabály + interfész -> cache decorator/wrapper (hiba-eset explicit); DRAFT',
  'worker-consumer-impl': 'Queue/üzenet-alak -> worker/consumer (ack/nack, retry/dead-letter); DRAFT',
  'test-suite-full': 'Modul/spec -> teljes teszt-suite (happy/edge/error, valós assertek); DRAFT',
  // Peti 2026-08-02 ("az ügynökök feladatai alapján készíts még kategóriákat"): a valós fleet-szerepek
  // (QA, Cybersec/Cybered, jogász, marketing, pénzügy, performance) visszatérő, mechanikus KIMENET-
  // formázási feladatai -- mindegyik csak a bemenetből dolgozik, nem talál ki tényt/számot/ítéletet.
  'qa-test-plan': 'Feature/kártya -> teszt-terv váz (unit/integráció/e2e bontásban); DRAFT, a qa-engineer dönt',
  'bug-report-draft': 'Repró-lépések -> strukturált hibajegy (title/steps/expected/actual); DRAFT triázshoz',
  'finding-writeup': 'MÁR AZONOSÍTOTT biztonsági lelet -> formázott jelentés-bekezdés; DRAFT, a Cybersec/Cybered gate dönt',
  'retro-notes': 'Nyers jegyzetek -> retro-összefoglaló (jól ment/rosszul ment/teendők); DRAFT',
  'standup-update': 'Nyers haladás-jegyzet -> rövid napi Done/Doing/Blocked státusz; DRAFT',
  'pricing-comparison-draft': 'Csomag/ár adatok -> ár-összehasonlító táblázat; DRAFT, a finance-officer dönt',
  'unit-economics-summary': 'Már kiszámolt CAC/LTV/burn számok -> szöveges összefoglaló; DRAFT, nem számol újat',
  'gtm-plan-draft': 'Feature/termék leírás -> go-to-market terv váz; DRAFT, a marketing-strategist dönt',
  'landing-copy-draft': 'Feature/termék leírás -> landing-oldal szöveg váz (headline/subhead/CTA); DRAFT',
  'legal-summary': 'Szerződés/klauzula szövege -> köznyelvi összefoglaló; SOSEM ad új jogi szöveget/véleményt',
  'perf-summary': 'Már mért before/after teljesítmény-számok -> szöveges összefoglaló; DRAFT, nem mér újat',
}

/** Clamp/parse an aggressiveness input to an integer in [0,100]; non-numeric -> the default. (Mechanical
 *  pure fn -- drafted via the local-llm offload per the proactive-offload directive, verified here.) */
export function normalizeAggressiveness(input: unknown): number {
  const parsed = typeof input === 'number' ? input : parseFloat(String(input))
  if (isNaN(parsed) || !isFinite(parsed)) return DEFAULT_AGGRESSIVENESS
  return Math.round(Math.max(0, Math.min(100, parsed)))
}

// --- Coding-difficulty taxonomy for local-LLM offload (card afcfe93e) --------------------------
// Ordered ASCENDING by how hard the piece is for the local 7B coding model. ONLY coding tasks --
// no other category. The higher the offload aggressiveness, the harder a coding task may be handed
// to the local model. The 7B (qwen2.5-coder) reliably handles up to ~'isolated' (snippet/fn/test/
// type); 'module' is the practical ceiling; 'feature'/'architecture' are BEYOND its reliable limit
// (multi-file / cross-file wiring, per the local-llm-offload skill) -- reachable only at max
// aggressiveness, and expect a higher draft-discard rate there.
export const CODING_DIFFICULTY_LEVELS = [
  'trivial', // snippet / regex / format / docstring
  'isolated', // isolated function / unit test / type / validator
  'module', // multi-function module (single file)
  'feature', // multi-file feature
  'architecture', // architecture / cross-file wiring
] as const
export type CodingDifficulty = (typeof CODING_DIFFICULTY_LEVELS)[number]

/** The OFFLOAD CEILING: even at 100% aggressiveness we never hand the local 7B more than it can
 *  realistically do. Raised 'module' -> 'feature' (Peti, 2026-08-07: explicit reversal of the
 *  2026-08-02 decision below, for token savings -- full file creation and multi-file/medium-difficulty
 *  tasks may now offload at high aggressiveness). 'architecture' (cross-file wiring, system design)
 *  remains BEYOND the reliable limit and always stays ONLINE (Claude) -- it is never a valid offload
 *  threshold. Prior reasoning (kept for context): "a 100% se engedjen többet mint amit a modell
 *  reálisan tud" -- still true, just re-drawn one level higher after Peti's explicit re-ask. */
export const RELIABLE_CEILING: CodingDifficulty = 'feature'

/** The difficulty levels that may be picked as an offload threshold (<= the reliable ceiling). */
export const OFFLOADABLE_THRESHOLDS: readonly CodingDifficulty[] = CODING_DIFFICULTY_LEVELS.slice(
  0,
  CODING_DIFFICULTY_LEVELS.indexOf(RELIABLE_CEILING) + 1,
)

/** Default max offloadable coding-difficulty for a given aggressiveness %. Higher % -> more offload
 *  + harder allowed, but CAPPED at RELIABLE_CEILING so even 100% never offloads what the 7B can't do.
 *  Pure + deterministic. Single source of truth for the slider<->dropdown mapping (local-llm-rag.sh
 *  mirrors this table -- keep them in sync).
 *
 *  Cybersec 2026-08-07 (c6cc2c97, comment 9908): the raw tier below is CLAMPED to RELIABLE_CEILING
 *  via Math.min on the level index, not returned as a bare literal -- a literal here would silently
 *  outrun the ceiling if it's ever lowered again (the router uses this as the default threshold for
 *  callers that declare no difficulty of their own, local-llm-router.ts). Raising the ceiling is
 *  always safe; only a future lowering depends on this clamp actually doing something today. */
export function defaultDifficultyForAggressiveness(pct: unknown): CodingDifficulty {
  const a = normalizeAggressiveness(pct)
  const raw: CodingDifficulty = a >= 95 ? 'feature' : a >= 85 ? 'module' : a >= 75 ? 'isolated' : 'trivial'
  const rawIdx = CODING_DIFFICULTY_LEVELS.indexOf(raw)
  const ceilingIdx = CODING_DIFFICULTY_LEVELS.indexOf(RELIABLE_CEILING)
  return CODING_DIFFICULTY_LEVELS[Math.min(rawIdx, ceilingIdx)]!
}

/** The live auto-ramp state for the FE (card 346d3933): the weekly %, the threshold it climbs to, the
 *  floor it starts from, and the aggressiveness the ramp WOULD set right now (plus the coding-
 *  difficulty tier that value unlocks). Read-only view; it never mutates the config. `weeklyPct` is
 *  null when no live reading exists yet, in which case `autoAggressiveness` is null too. */
export function offloadRampState(): {
  weeklyPct: number | null
  newDevStop: number
  floor: number
  autoAggressiveness: number | null
  autoDifficulty: CodingDifficulty | null
} {
  const weeklyPct = readWeeklyPercent()
  const { newDevStop } = readThresholdConfig()
  const autoAggressiveness = weeklyPct === null ? null : rampAggressiveness(weeklyPct, newDevStop)
  return {
    weeklyPct,
    newDevStop,
    floor: RAMP_FLOOR_AGGRESSIVENESS,
    autoAggressiveness,
    autoDifficulty:
      autoAggressiveness === null ? null : defaultDifficultyForAggressiveness(autoAggressiveness),
  }
}

/** The auto-ramp state SHAPED for the FE contract (card e93a1dff): what fron-ted's 8b4ddcf0 panel
 *  renders, derived from the raw {@link offloadRampState} plus the resolved source and the current
 *  aggressiveness. Returns null when there is no live weekly reading (nothing honest to show). PURE:
 *  it never mutates the config or changes ramp behaviour -- it only re-expresses 346d3933's internals.
 *  `reason` is an i18n KEY, never hardcoded text (rule 12). */
export interface RampContract {
  active: boolean
  weeklyPercent: number
  newDevStop: number
  current: number
  target: number
  reason: string
}
export function mapRampState(
  ramp: ReturnType<typeof offloadRampState>,
  source: AggressivenessSource,
  current: number,
): RampContract | null {
  if (ramp.weeklyPct === null || ramp.autoAggressiveness === null) return null
  const target = ramp.autoAggressiveness
  // "Actively ramping" only under AUTO control AND when the weekly % has pushed the target above the
  // floor -- a manual override or a floor-level auto value is present but not elevating.
  const active = source === 'auto' && target > ramp.floor
  const reason =
    source === 'manual'
      ? 'localLlm.offload.ramp.reason.manual'
      : ramp.weeklyPct >= ramp.newDevStop
        ? 'localLlm.offload.ramp.reason.atThreshold'
        : target > ramp.floor
          ? 'localLlm.offload.ramp.reason.ramping'
          : 'localLlm.offload.ramp.reason.floor'
  return { active, weeklyPercent: ramp.weeklyPct, newDevStop: ramp.newDevStop, current, target, reason }
}

/** Validate a difficulty input to a known taxonomy level; unknown/absent -> null. Used to classify a
 *  TASK's difficulty (all 5 levels are valid tasks). */
export function normalizeDifficulty(input: unknown): CodingDifficulty | null {
  return typeof input === 'string' && (CODING_DIFFICULTY_LEVELS as readonly string[]).includes(input)
    ? (input as CodingDifficulty)
    : null
}

/** Validate an offload THRESHOLD input, CLAMPED to the reliable ceiling. A request for a level above
 *  the ceiling (feature/architecture) is clamped down to 'module' -- those never offload. Unknown/
 *  absent -> null (caller derives the threshold from the slider). */
export function normalizeThreshold(input: unknown): CodingDifficulty | null {
  const d = normalizeDifficulty(input)
  if (d === null) return null
  return CODING_DIFFICULTY_LEVELS.indexOf(d) > CODING_DIFFICULTY_LEVELS.indexOf(RELIABLE_CEILING)
    ? RELIABLE_CEILING
    : d
}

/** Is a coding task of `taskLevel` allowed to draft locally under `threshold`? At-or-below = yes. */
export function isDraftableLocally(taskLevel: CodingDifficulty, threshold: CodingDifficulty): boolean {
  return CODING_DIFFICULTY_LEVELS.indexOf(taskLevel) <= CODING_DIFFICULTY_LEVELS.indexOf(threshold)
}

/**
 * Is `task` a syntactically valid category name (Cybersec, card 18a0acb9)? Every real --task preset
 * is lower kebab/snake-case, so a strict allowlist lets the categories POST reject a `../`-bearing
 * value BEFORE it is joined into a filesystem path -- no traversal out of the skills dir, no probe on
 * a malformed name. Pure so the guard is unit-testable without the route.
 */
export function isValidCategoryName(task: string): boolean {
  return /^[a-z0-9_-]{1,64}$/.test(task)
}

/** Read the offload config JSON, fail-soft to an empty object (the endpoint fills defaults). */
function readOffloadConfig(): Record<string, unknown> {
  try {
    if (existsSync(OFFLOAD_CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(OFFLOAD_CONFIG_FILE, 'utf-8'))
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    }
  } catch (err) {
    logger.warn({ err }, 'offload-config: read/parse failed, using defaults')
  }
  return {}
}

// Model tag charset: letters/digits and the punctuation Ollama allows in a
// name (repo/name:tag, digests, registry host). Anchored + length-capped so a
// crafted value cannot smuggle shell metacharacters or an unbounded string.
const MODEL_RE = /^[A-Za-z0-9._:/@-]{1,200}$/

// Same shape store/llm-catalog.py's HF_REPO_RX enforces at catalogue-build time. MODEL_RE above is
// deliberately loose (it also has to accept plain ollama tags like "qwen2.5-coder:7b"), so it alone
// would still pass a malformed "hf.co/<repo>:<quant>" ref. The catalogue is a gitignored,
// agent-writable file read back in --offline mode without ever touching the network again, so a
// build-time check does not survive being written to disk -- the consumer that actually executes the
// pull re-checks the embedded repo id here (Cybered LOW-1, card d7220a73).
const HF_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

// EXPORTED so the HF-repo-shape control (Cybered LOW-1, card d7220a73) can be unit-tested directly,
// without spawning a real `ollama` process through the route.
export function isValidPullTarget(model: string): boolean {
  if (!MODEL_RE.test(model)) return false
  if (!model.startsWith('hf.co/')) return true
  const rest = model.slice('hf.co/'.length)
  const repo = rest.includes(':') ? rest.slice(0, rest.lastIndexOf(':')) : rest
  return HF_REPO_RE.test(repo)
}

const MAX_PROMPT_LEN = 4000
const RUN_TIMEOUT_MS = 120_000

// --- Model recommendations (curated) + HuggingFace search ------------------
// The offload GPU is a GTX 1660 Ti with 6 GB VRAM (~5 GB usable). A Q4 model
// larger than ~5 GB spills its overflow layers to CPU and runs much slower, so
// every recommendation carries an explicit gpu_fit. These are Ollama-library
// names (reliably pullable via `ollama pull <name>`), curated for CODING.
type GpuFit = 'fits' | 'tight' | 'spills'
interface ModelRec {
  name: string
  params: string
  size_gb: number
  gpu_fit: GpuFit
  pullable: true
  // i18n key resolved on the client (kept locale-neutral in the API).
  note_key: string
  ollama_pull: string
}
const CODING_MODEL_RECS: Omit<ModelRec, 'ollama_pull'>[] = [
  { name: 'qwen2.5-coder:1.5b', params: '1.5B', size_gb: 1.0, gpu_fit: 'fits',   pullable: true, note_key: 'localLlm.rec.note.small' },
  { name: 'qwen2.5-coder:3b',   params: '3B',   size_gb: 1.9, gpu_fit: 'fits',   pullable: true, note_key: 'localLlm.rec.note.balanced' },
  { name: 'qwen2.5-coder:7b',   params: '7B',   size_gb: 4.7, gpu_fit: 'tight',  pullable: true, note_key: 'localLlm.rec.note.balanced' },
  { name: 'deepseek-coder:1.3b', params: '1.3B', size_gb: 0.8, gpu_fit: 'fits',  pullable: true, note_key: 'localLlm.rec.note.small' },
  { name: 'deepseek-coder:6.7b', params: '6.7B', size_gb: 3.8, gpu_fit: 'fits',  pullable: true, note_key: 'localLlm.rec.note.balanced' },
  { name: 'codegemma:2b',       params: '2B',   size_gb: 1.6, gpu_fit: 'fits',   pullable: true, note_key: 'localLlm.rec.note.small' },
  { name: 'codegemma:7b',       params: '7B',   size_gb: 5.0, gpu_fit: 'tight',  pullable: true, note_key: 'localLlm.rec.note.tight' },
  { name: 'codellama:7b',       params: '7B',   size_gb: 3.8, gpu_fit: 'fits',   pullable: true, note_key: 'localLlm.rec.note.balanced' },
  { name: 'starcoder2:3b',      params: '3B',   size_gb: 1.7, gpu_fit: 'fits',   pullable: true, note_key: 'localLlm.rec.note.small' },
  { name: 'starcoder2:7b',      params: '7B',   size_gb: 4.0, gpu_fit: 'tight',  pullable: true, note_key: 'localLlm.rec.note.tight' },
  { name: 'qwen2.5-coder:14b',  params: '14B',  size_gb: 9.0, gpu_fit: 'spills', pullable: true, note_key: 'localLlm.rec.note.spills' },
  { name: 'deepseek-coder-v2:16b', params: '16B', size_gb: 8.9, gpu_fit: 'spills', pullable: true, note_key: 'localLlm.rec.note.spills' },
]

const HF_BASE = 'https://huggingface.co/api/models'
const HF_TIMEOUT_MS = 8000
const HF_MAX_LIMIT = 30
const HF_DEFAULT_LIMIT = 20
// Whitelisted UI sort -> HuggingFace hub API sort field.
const HF_SORT_MAP: Record<string, string> = {
  downloads: 'downloads',
  likes: 'likes',
  trending: 'trendingScore',
  lastModified: 'lastModified',
}
// Whitelisted pipeline-task filters. '' means "any task" (no task filter).
const HF_TASK_ALLOW = new Set(['text-generation', 'text2text-generation', ''])
// Free-text query: strip to a safe charset and cap the length so a crafted
// value cannot smuggle URL/query control characters or an unbounded string.
function sanitizeHfQuery(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 ._/-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}

interface CmdResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

// Run a child process with an argv array (never a shell string). Resolves with
// the captured output regardless of exit code so callers can inspect a nonzero
// exit (e.g. `systemctl is-active` prints "inactive" AND exits nonzero).
function runCmd(
  file: string,
  args: string[],
  opts: { timeoutMs?: number; input?: string; maxBuffer?: number } = {},
): Promise<CmdResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        const timedOut = !!(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed &&
          (err as NodeJS.ErrnoException & { signal?: string }).signal === 'SIGTERM')
        resolve({
          code: err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? (err as unknown as { code: number }).code
            : (err ? 1 : 0),
          stdout: stdout || '',
          stderr: stderr || '',
          timedOut,
        })
      },
    )
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input)
    }
  })
}

// Serves the cache file as-is when it is younger than LLM_CATALOG_TTL_MS, so a repeat dashboard
// visit costs a file read, not a HuggingFace round-trip. Any read/parse failure (missing file,
// corrupt JSON, unparsable generatedAt) is treated as "no fresh cache" -- the caller falls through
// to a live refresh rather than surfacing a parse error for a file it did not ask the user about.
function readLlmCatalogCacheIfFresh(): unknown | null {
  try {
    const doc = JSON.parse(readFileSync(LLM_CATALOG_CACHE_FILE, 'utf-8'))
    const generatedMs = Date.parse(doc?.generatedAt)
    if (Number.isFinite(generatedMs) && Date.now() - generatedMs < LLM_CATALOG_TTL_MS) return doc
  } catch { /* no cache yet, or unreadable -- fall through to a live/offline run */ }
  return null
}

// Runs llm-catalog.py with the given extra args (`[]` for a live refresh, `['--offline']` for the
// script's own cache-or-bundled-fallback path) and parses its stdout. Never throws: a bad exit code,
// empty output, or unparsable JSON all resolve to null so the route can try the next fallback tier.
async function runLlmCatalogScript(args: string[], timeoutMs: number): Promise<unknown | null> {
  const r = await runCmd('python3', [LLM_CATALOG_SCRIPT, ...args], { timeoutMs, maxBuffer: 4 * 1024 * 1024 })
  if (r.code !== 0 || !r.stdout.trim()) return null
  try { return JSON.parse(r.stdout) } catch { return null }
}

async function ollama(pathname: string, timeoutMs = 5000): Promise<any | null> {
  try {
    const res = await fetch(`${OLLAMA_BASE}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function readActiveModel(): string {
  try {
    if (existsSync(MODEL_FILE)) return readFileSync(MODEL_FILE, 'utf-8').trim()
  } catch { /* fall through */ }
  return ''
}

async function bridgeActive(): Promise<boolean> {
  const r = await runCmd('systemctl', ['--user', 'is-active', BRIDGE_UNIT], { timeoutMs: 5000 })
  return r.stdout.trim() === 'active'
}

// Optional GPU snapshot via nvidia-smi. Returns null when the tool is absent
// (no GPU / not installed) so the UI can honestly say "no GPU data".
//
// EXPORTED for the utilization sampler (card b6b1493d), which injects it rather than importing this
// module wholesale -- this file imports the sampler's reader below, and a two-way import would be a
// cycle. Note for anyone wiring it somewhere else: this costs up to THREE nvidia-smi spawns with a
// 5s timeout each, so ~15s on a host with no GPU. Do not call it on a per-request path.
export async function gpuInfo(): Promise<null | { name: string; mem_used_mb: number; mem_total_mb: number; util_pct: number }> {
  // nvidia-smi is often NOT on the systemd service PATH; on WSL it lives at a
  // fixed absolute path. Try the known locations before giving up.
  const candidates = ['/usr/lib/wsl/lib/nvidia-smi', '/usr/bin/nvidia-smi', 'nvidia-smi']
  const args = ['--query-gpu=name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits']
  for (const bin of candidates) {
    const r = await runCmd(bin, args, { timeoutMs: 5000 })
    if (!r || r.code !== 0 || !r.stdout.trim()) continue
    const line = r.stdout.trim().split('\n')[0]
    const parts = line.split(',').map(s => s.trim())
    if (parts.length < 4) continue
    const mem_used_mb = Number(parts[1])
    const mem_total_mb = Number(parts[2])
    const util_pct = Number(parts[3])
    return {
      name: parts[0] || 'GPU',
      mem_used_mb: Number.isFinite(mem_used_mb) ? mem_used_mb : 0,
      mem_total_mb: Number.isFinite(mem_total_mb) ? mem_total_mb : 0,
      util_pct: Number.isFinite(util_pct) ? util_pct : 0,
    }
  }
  return null
}

// card a265e48c: the "Aktív feladat" widget must show what is ACTUALLY running RIGHT NOW (0 or 1,
// single-worker), not the queue's `status='running'` row count -- store/local-llm.sh (card 5dcd9bc8,
// intentional) registers a row as running BEFORE it acquires the GPU flock, so a burst of parallel
// dispatches sits "running" simultaneously while only one of them can actually hold the lock (a real
// user saw this as "44"). Rather than touch that registration timing (built that way on purpose, so
// the utilization tile does not flicker to 0/1 under load), this probes the SAME OS-level flock
// store/local-llm.sh itself takes: `flock -n` tries to grab-and-immediately-release it non-blocking;
// succeeding means nobody else holds it right now.
const GPU_LOCK_PATH = '/tmp/local-llm-gpu.lock' // MUST match store/local-llm.sh's GPU_LOCK constant.

/** True iff some process currently holds the GPU flock (single-worker: at most one ever does).
 *  `lockPath` is injectable so a test can probe a throwaway file instead of the real GPU lock. */
export async function isGpuLockHeld(lockPath: string = GPU_LOCK_PATH): Promise<boolean> {
  const r = await runCmd('flock', ['-n', lockPath, '-c', 'true'], { timeoutMs: 2000 })
  // code 0 = we acquired (and released) it ourselves -> nobody else had it -> NOT held.
  // code 1 = flock declined (someone else holds it) -> held. Anything else (binary missing, a
  // timeout that should never happen with -n, ...) fails SAFE as "not held", never a false-busy read.
  return r.code === 1
}

// --- Pull job registry (in-memory; cap 1 concurrent pull) ------------------
interface PullJob { id: string; model: string; done: boolean; ok: boolean; lastLine: string; error: string; startedAt: number }
const pullJobs = new Map<string, PullJob>()
let activePullId: string | null = null

function startPull(model: string): PullJob {
  const id = randomUUID()
  const job: PullJob = { id, model, done: false, ok: false, lastLine: 'Indítás...', error: '', startedAt: Date.now() }
  pullJobs.set(id, job)
  activePullId = id

  // spawn ollama with an argv array; user input is a single validated argv
  // element, so it can never be interpreted as a shell token.
  const child = spawn('ollama', ['pull', model], { stdio: ['ignore', 'pipe', 'pipe'] })
  const onData = (buf: Buffer) => {
    const text = buf.toString()
    // Ollama emits a CR-updated progress bar; keep the last non-empty segment.
    const seg = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean)
    if (seg.length) job.lastLine = seg[seg.length - 1].slice(0, 300)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('error', (err) => {
    job.done = true; job.ok = false
    job.error = err instanceof Error ? err.message : String(err)
    if (activePullId === id) activePullId = null
  })
  child.on('close', (code) => {
    job.done = true
    job.ok = code === 0
    if (code !== 0 && !job.error) job.error = `ollama pull kilépési kód: ${code}`
    if (activePullId === id) activePullId = null
  })

  // Safety timeout: a wedged pull should not pin the single slot forever.
  const killTimer = setTimeout(() => {
    if (!job.done) { try { child.kill('SIGTERM') } catch { /* gone */ } }
  }, 30 * 60 * 1000)
  child.on('close', () => clearTimeout(killTimer))

  return job
}

// --- Usage ledger reading + aggregation -----------------------------------
// Pure fs read + JS parse; NO shell interpolation. Reads only the tail of the
// (append-only, unbounded) ledger so a large file can never blow up the heap.

export interface UsageRow {
  ts: number; caller: string; task: string; model: string; ms: number; status: string; source: string
  /** Output tokens the local model reported for this call (Ollama `eval_count`, TSV col 8). */
  evalTokens: number
  /** Input tokens the local model reported (Ollama `prompt_eval_count`, TSV col 9). */
  promptTokens: number
  /** Ollama's own generation-only duration in ms (`eval_duration`, TSV col 10, card b21deb9a) --
   *  excludes prompt processing and GPU-lock queueing, unlike `ms` above. 0 for a row written
   *  before this column existed, meaning "speed unknown", never a guess. */
  evalDurationMs: number
}

// Read at most `maxLines` from the END of the ledger, bounded to `maxBytes` of
// tail so we never load a giant file. Returns [] on a missing/unreadable file.
function tailUsageLines(maxLines = 5000, maxBytes = 4 * 1024 * 1024): string[] {
  let fd: number | null = null
  try {
    if (!existsSync(USAGE_FILE)) return []
    fd = openSync(USAGE_FILE, 'r')
    const size = fstatSync(fd).size
    if (size === 0) return []
    const readLen = Math.min(size, maxBytes)
    const start = size - readLen
    const buf = Buffer.allocUnsafe(readLen)
    readSync(fd, buf, 0, readLen, start)
    let text = buf.toString('utf-8')
    // If we started mid-file, the first line is likely a partial -- drop it.
    if (start > 0) { const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : '' }
    const lines = text.split('\n').filter(l => l.length > 0)
    return lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines
  } catch {
    return []
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* already gone */ } }
  }
}

/** Exported for the token-accounting tests (card d08b98f4): the sums the panel shows are only as
 *  trustworthy as this parse, so it is asserted against known ledger lines rather than by eye. */
export function parseUsageRows(lines: string[]): UsageRow[] {
  const rows: UsageRow[] = []
  for (const line of lines) {
    const p = line.split('\t')
    if (p.length < 7) continue // malformed / short -> skip
    const ts = Number(p[0])
    if (!Number.isFinite(ts)) continue
    const ms = Number(p[4])
    // Card d08b98f4: local-llm.sh has ALWAYS written the two token columns (log_usage args 3 and 4,
    // straight from Ollama's eval_count / prompt_eval_count) -- this parser simply dropped them, so
    // the dashboard had to guess at "tokens saved". A row written before those columns existed, or a
    // non-numeric value, counts as 0: a missing measurement must never inflate the saving.
    const nonNegInt = (v: string | undefined): number => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    }
    rows.push({
      evalTokens: nonNegInt(p[7]),
      promptTokens: nonNegInt(p[8]),
      evalDurationMs: nonNegInt(p[9]),
      ts,
      caller: (p[1] || 'direct').trim() || 'direct',
      task: (p[2] || 'chat').trim() || 'chat',
      model: (p[3] || '').trim(),
      ms: Number.isFinite(ms) ? ms : 0,
      // Keep the raw status/source values (do NOT coerce to a fixed pair) so a
      // UI-probe row (source "ui") stays distinguishable from real bare/rag calls.
      status: (p[5] || 'ok').trim() || 'ok',
      source: (p[6] || 'bare').trim() || 'bare',
    })
  }
  return rows
}

/** What the "Utolsó generálás" dashboard row shows (card b21deb9a): the LM Studio/llama.cpp
 *  server console prints a `[generation: prompt=N tokens, output=M tokens, speed=X tokens/s]` line
 *  plus a peak-VRAM line after every completion; this is the same shape sourced from data the fleet
 *  already has, rather than tailing a log file the actual server (Ollama, confirmed live on this
 *  host) does not write in that format. `tokensPerSec` is null when the row predates the
 *  eval_duration column or reports zero duration -- never a divide-by-zero guess. */
export interface LastGenerationStats {
  ts: number
  model: string
  promptTokens: number
  outputTokens: number
  tokensPerSec: number | null
  vramBytes: number | null
}

/** Scans from the newest row backward for the last COMPLETED real generation (ok status, actual
 *  output tokens) -- a UI probe or a failed call never happened as far as this row is concerned.
 *  `psModels` is Ollama's live `/api/ps` model list (or null if Ollama could not be reached); its
 *  `size_vram` for the matching model is the closest live equivalent to LM Studio's "peak allocated
 *  VRAM" line -- null when the model has since been unloaded (Ollama's idle TTL), which is an
 *  honest "unknown now", not a stale number from the time of generation. */
export function lastGenerationStats(
  rows: readonly UsageRow[],
  psModels: ReadonlyArray<{ name?: unknown; size_vram?: unknown }> | null,
): LastGenerationStats | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    if (!isRealCall(r) || r.status !== 'ok' || r.evalTokens <= 0) continue
    const tokensPerSec = r.evalDurationMs > 0 ? r.evalTokens / (r.evalDurationMs / 1000) : null
    let vramBytes: number | null = null
    if (psModels) {
      const hit = psModels.find((m) => typeof m.name === 'string' && m.name && modelNameMatches(m.name, r.model))
      if (hit && typeof hit.size_vram === 'number') vramBytes = hit.size_vram
    }
    return { ts: r.ts, model: r.model, promptTokens: r.promptTokens, outputTokens: r.evalTokens, tokensPerSec, vramBytes }
  }
  return null
}

// Calendar date (YYYY-MM-DD) of a UTC epoch in Europe/Budapest local time.
const BUDAPEST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit',
})
function budapestDate(epochSec: number): string {
  return BUDAPEST_DAY.format(new Date(epochSec * 1000))
}

// The last `n` Budapest calendar days (oldest -> newest). Anchored at 12:00 UTC
// so whole-day steps never land on a DST midnight boundary.
function lastDays(n: number, nowSec: number): string[] {
  const today = budapestDate(nowSec)
  const [y, m, d] = today.split('-').map(Number)
  const anchor = Date.UTC(y, m - 1, d, 12, 0, 0)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) out.push(budapestDate((anchor - i * 86400000) / 1000))
  return out
}

// A row is a REAL fleet invocation unless it is a dashboard quick-test probe
// (caller ui-test / source ui). UI probes are counted separately so they never
// inflate the metric.
//
// Was a `source === 'bare' || 'rag'` allowlist, which silently miscounted
// every dispatch-time offload call (source 'dispatch-offload', introduced by
// offload-dispatch.sh) as a UI probe -- 83 real local-LLM invocations were
// invisible in `today`/`total`/`last_7d` and lumped into `ui_probes`, making
// utilization look near-zero when it wasn't. caller !== 'ui-test' is the only
// signal that actually identifies a probe; any current or future real source
// tag must count.
export function isRealCall(r: UsageRow): boolean {
  return r.caller !== 'ui-test'
}

// Fallback boundary for tokens_saved_since_weekly_reset when no /usage-panel snapshot has ever
// been captured (card 87b2fef9): the most recent UTC Monday 00:00. Superseded the moment a real
// snapshot exists -- its resetBoundarySetAt (costops/weekly-limit.ts) is the authoritative source.
export function lastUtcMondaySec(nowSec: number): number {
  const d = new Date(nowSec * 1000)
  const daysSinceMonday = (d.getUTCDay() + 6) % 7 // getUTCDay: 0=Sun..6=Sat
  const mondayUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday, 0, 0, 0)
  return Math.floor(mondayUtc / 1000)
}

function buildUsage() {
  const allRows = parseUsageRows(tailUsageLines())
  const rows = allRows.filter(isRealCall)
  const ui_probes = allRows.length - rows.length
  const nowSec = Math.floor(Date.now() / 1000)
  const today = budapestDate(nowSec)
  const days14 = lastDays(14, nowSec)
  const last7Set = new Set(days14.slice(-7))
  // card 87b2fef9: the weekly-reset boundary, not a rolling 7 days -- the label's own change IS the
  // reset (see resetBoundarySetAt's doc comment), so this reuses the official /usage snapshot rather
  // than a second, independent week computation.
  const weeklySnapshot = readWeeklySnapshot()
  const resetBoundarySec = weeklySnapshot?.resetBoundarySetAt ?? lastUtcMondaySec(nowSec)

  const callerCounts = new Map<string, number>()
  const taskCounts = new Map<string, number>()
  // Card 0c054ebf: last-used timestamp per task, alongside the count -- the categories panel shows
  // both ("N hívás, utoljára: ..."), not just the count. rows are appended chronologically so the
  // last assignment in the loop for a given task is always its latest ts; no need to compare/max.
  const taskLastTs = new Map<string, number>()
  const dayCounts = new Map<string, number>()
  const bySource = { bare: 0, rag: 0 }
  const byStatus = { ok: 0, err: 0 }
  let todayCount = 0
  let last7Count = 0
  // Card d08b98f4: MEASURED, not estimated. Only real (non-probe) calls that actually SUCCEEDED are
  // counted -- an errored call produced no answer, so it saved nothing -- and the numbers come from
  // the local model's own eval_count/prompt_eval_count, not from a token-per-character guess.
  let tokensToday = 0
  let tokensWeek = 0
  let tokensTotal = 0
  let tokensSinceWeeklyReset = 0

  for (const r of rows) {
    callerCounts.set(r.caller, (callerCounts.get(r.caller) || 0) + 1)
    taskCounts.set(r.task, (taskCounts.get(r.task) || 0) + 1)
    taskLastTs.set(r.task, r.ts)
    if (r.source === 'rag') bySource.rag++; else bySource.bare++
    if (r.status === 'err') byStatus.err++; else byStatus.ok++
    const day = budapestDate(r.ts)
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1)
    if (day === today) todayCount++
    if (last7Set.has(day)) last7Count++
    if (r.status !== 'err') {
      const tokens = r.evalTokens + r.promptTokens
      tokensTotal += tokens
      if (day === today) tokensToday += tokens
      if (last7Set.has(day)) tokensWeek += tokens
      if (r.ts >= resetBoundarySec) tokensSinceWeeklyReset += tokens
    }
  }

  const by_caller = [...callerCounts.entries()]
    .map(([caller, count]) => ({ caller, count }))
    .sort((a, b) => b.count - a.count)
  const by_task = [...taskCounts.entries()]
    .map(([task, count]) => ({ task, count, lastTs: taskLastTs.get(task) ?? null }))
    .sort((a, b) => b.count - a.count)
  const by_day = days14.map(date => ({ date, count: dayCounts.get(date) || 0 }))
  const recent = rows.slice(-20).reverse().map(r => ({
    ts: r.ts, caller: r.caller, task: r.task, model: r.model, ms: r.ms, status: r.status, source: r.source,
  }))

  return {
    total: rows.length,
    today: todayCount,
    last_7d: last7Count,
    // Card d08b98f4: the Claude Limit panel's third row. `today_count`/`week_count` are the same
    // numbers as `today`/`last_7d` under the names that card's FE half asks for; the token figures
    // are the local model's own accounting summed over successful real calls.
    model: readActiveModel(),
    today_count: todayCount,
    week_count: last7Count,
    tokens_saved_today: tokensToday,
    tokens_saved_week: tokensWeek,
    tokens_saved_total: tokensTotal,
    // card 87b2fef9: what the FE dashboard widget should bind instead of tokens_saved_total -- pinned
    // to the weekly-limit reset boundary (see resetBoundarySec above), not all-time or a rolling 7d.
    tokens_saved_since_weekly_reset: tokensSinceWeeklyReset,
    ui_probes,
    by_caller,
    by_source: bySource,
    by_task,
    by_status: byStatus,
    by_day,
    recent,
  }
}

/** All --task presets, sourced from disk (never a hardcoded UI array -- card 0c054ebf), merged with
 *  usage (count + last-used) and the per-category enable state persisted in the offload config. A
 *  category present on disk but never invoked still lists, with count 0 and lastTs null. */
export function listCategories(): Array<{
  name: string
  description: string
  enabled: boolean
  count: number
  lastTs: number | null
}> {
  let names: string[] = []
  try {
    names = readdirSync(SKILL_DIR)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => f.slice(0, -'.txt'.length))
      .sort()
  } catch (err) {
    logger.warn({ err }, 'listCategories: could not read skill dir')
    return []
  }

  const rows = parseUsageRows(tailUsageLines()).filter(isRealCall)
  const counts = new Map<string, number>()
  const lastTs = new Map<string, number>()
  for (const r of rows) {
    counts.set(r.task, (counts.get(r.task) || 0) + 1)
    lastTs.set(r.task, r.ts) // chronological order (see buildUsage) -> last write wins
  }

  const cfg = readOffloadConfig()
  const disabled = new Set(
    Array.isArray(cfg.disabledCategories) ? (cfg.disabledCategories as unknown[]).map(String) : [],
  )

  // Peti 2026-08-02: most-used categories first (call count desc), name asc as a stable tie-break
  // for zero-usage categories -- so the list reads as "what the fleet actually reaches for", not
  // an arbitrary filesystem order.
  return names
    .map((name) => ({
      name,
      description: CATEGORY_DESCRIPTIONS[name] ?? name,
      enabled: !disabled.has(name),
      count: counts.get(name) ?? 0,
      lastTs: lastTs.get(name) ?? null,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

export async function tryHandleLocalLlm(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (!path.startsWith('/api/local-llm/')) return false

  // --- Async work queue (card defcc189) -------------------------------------------------
  // The offload path was synchronous and one-shot: an agent blocked 15-70s per call, so agents
  // rationally made few of them (measured: 87% of 740 calls were the single dispatch shot).
  // These three endpoints make it fire-and-forget, which is what lets offload be REPEATED during
  // a card instead of happening once at dispatch.

  // POST /api/local-llm/queue -> enqueue, returns the id immediately (never blocks on the model)
  if (path === '/api/local-llm/queue' && method === 'POST') {
    const body = (await readBody(req)).toString()
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(body || '{}') as Record<string, unknown>
    } catch {
      json(res, { error: 'invalid JSON body' }, 400)
      return true
    }
    const agent = typeof payload['agent'] === 'string' ? payload['agent'].trim() : ''
    const prompt = typeof payload['prompt'] === 'string' ? payload['prompt'] : ''
    if (!agent || !prompt.trim()) {
      json(res, { error: 'agent and prompt are required' }, 400)
      return true
    }
    // Explicit size cap (Cybersec non-blocking note on bf6fe53). The caller is authenticated, so
    // this is not the main defence -- it stops one runaway caller from parking megabytes of prompt
    // in the queue table and then occupying the single GPU slot for however long that takes.
    // 100 KB is far above any real sub-task and far below "someone pasted a repo in".
    if (prompt.length > MAX_QUEUE_PROMPT_BYTES) {
      json(
        res,
        {
          error: `prompt too large (${prompt.length} chars, max ${MAX_QUEUE_PROMPT_BYTES}) -- split it into smaller sub-tasks`,
        },
        413,
      )
      return true
    }
    // Security-category gate (card 7405ca61): card-independence (card 28c92213/03fca184) widened
    // this endpoint from "an already-vetted mechanical sub-task drafted at dispatch time" to "any
    // task any agent chooses to submit". The synchronous local-llm-rag.sh --auto path already runs
    // every prompt through this SAME routeTask() classifier before it ever reaches the 7B; the async
    // worker (local-llm-worker.sh -> store/local-llm.sh) does not consult it at all -- it never has.
    // Gating HERE, at the single enqueue choke-point every async caller funnels through (submit.sh,
    // any future caller, this route itself), closes that gap once for the whole path instead of
    // needing every future caller to remember to check. A vetoed category (authz/isolation/
    // architecture/security-decision) is refused outright rather than silently queued for local
    // drafting -- the caller does it online instead, exactly like the synchronous path already
    // requires.
    //
    // DYNAMIC IMPORT, NOT A STATIC ONE (measured, not stylistic): local-llm-router.ts imports
    // CODING_DIFFICULTY_LEVELS/RELIABLE_CEILING/etc FROM this very file already (its own header
    // comment: "Threshold logic is REUSED from ./web/routes/local-llm.js"). A static top-level
    // import here closes that into a real circular dependency -- proven by running it: router.ts's
    // module-top-level NEVER_OFFLOADABLE_LEVELS read CODING_DIFFICULTY_LEVELS as undefined mid-cycle
    // and threw on load, taking every route in this file down with it. A dynamic import resolves
    // after both modules have finished initializing, same reasoning local-llm-rag.sh already uses
    // for this exact router import.
    const { routeTask } = await import('../../local-llm-router.js')
    const routed = routeTask({ description: prompt })
    if (routed.route === 'online') {
      json(
        res,
        {
          error: `this task belongs online, not on the local queue: ${routed.reason}`,
          route: routed.route,
          reason: routed.reason,
          category: routed.category ?? null,
        },
        422,
      )
      return true
    }
    // `template` names a file under store/local-llm-skills; the same allowlist local-llm.sh
    // enforces is applied HERE too, so a '../' can never reach the worker's argv in the first
    // place. Rejecting at the edge beats sanitizing at the sink.
    let template = typeof payload['template'] === 'string' ? payload['template'] : null
    if (template !== null && !isValidCategoryName(template)) {
      json(res, { error: 'invalid template name' }, 400)
      return true
    }
    // Card 48aacf56 item 4: when the caller names no template, infer one from the task shape.
    // 78 templates ship and they beat free-form chat, but measured over 740 calls almost none were
    // used because the caller had to know the name. The picker only ever returns an allowlisted
    // name and returns null when nothing fits -- an explicit caller choice always wins.
    let templateAuto = false
    if (template === null) {
      const picked = pickTemplate(prompt)
      if (picked) { template = picked; templateAuto = true }
    }
    const priority = payload['priority']
    const allowedPriority = ['low', 'normal', 'high', 'urgent']
    try {
      const id = enqueueLocalLlm(
        getDb(),
        {
          agent,
          prompt,
          cardId: typeof payload['card_id'] === 'string' ? payload['card_id'] : null,
          taskType: typeof payload['task_type'] === 'string' ? payload['task_type'] : null,
          template,
          context: typeof payload['context'] === 'string' ? payload['context'] : null,
          priority: (typeof priority === 'string' && allowedPriority.includes(priority)
            ? priority
            : 'normal') as 'low' | 'normal' | 'high' | 'urgent',
          source: typeof payload['source'] === 'string' ? payload['source'] : 'agent',
        },
        Date.now(),
      )
      json(res, { id, status: 'pending', template, template_auto: templateAuto })
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : 'enqueue failed' }, 400)
    }
    return true
  }

  // POST /api/local-llm/queue/start -> a DIRECT/synchronous local-llm.sh call registers itself as
  // already `running` (card 5dcd9bc8). This is NOT the async offload queue from above: it exists
  // only so the dashboard's "active task" tile counts real in-flight generate calls, which the
  // async queue's `running` status never reflected (real usage bypasses that queue entirely). No
  // prompt/content travels in the body -- the row is written with a fixed placeholder
  // (DIRECT_CALL_PLACEHOLDER) regardless of what a caller sends, so this endpoint cannot become a
  // second place agent prompt content ends up stored.
  if (path === '/api/local-llm/queue/start' && method === 'POST') {
    const body = (await readBody(req)).toString()
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(body || '{}') as Record<string, unknown>
    } catch {
      json(res, { error: 'invalid JSON body' }, 400)
      return true
    }
    const agent = typeof payload['agent'] === 'string' ? payload['agent'].trim() : ''
    if (!agent) {
      json(res, { error: 'agent is required' }, 400)
      return true
    }
    try {
      const id = startDirectLocalLlm(
        getDb(),
        {
          agent,
          prompt: '',
          cardId: typeof payload['card_id'] === 'string' ? payload['card_id'] : null,
          taskType: typeof payload['task_type'] === 'string' ? payload['task_type'] : null,
          source: typeof payload['source'] === 'string' ? payload['source'] : 'direct-sync',
        },
        Date.now(),
      )
      json(res, { id, status: 'running' })
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : 'start failed' }, 400)
    }
    return true
  }

  // GET /api/local-llm/utilization-history -> the rolling window the live waveform draws
  // (card b6b1493d). Read-only: the background sampler fills the buffer, this only hands it over,
  // so the endpoint costs nothing beyond a copy and cannot itself spawn nvidia-smi.
  //
  // An EMPTY samples array is a normal answer, not an error: it is what the first seconds after a
  // restart look like, and the FE has to render that state anyway.
  if (path === '/api/local-llm/utilization-history' && method === 'GET') {
    json(res, { samples: getUtilizationSamples() })
    return true
  }

  // GET /api/local-llm/last-generation -> prompt/output tokens + tokens/s + VRAM for the most
  // recent COMPLETED real generation (card b21deb9a, Peti Telegram-kérés 2026-08-21): the
  // dashboard-visible equivalent of the LM Studio/llama.cpp console's
  // `[generation: prompt=N tokens, output=M tokens, speed=X tokens/s]` + peak-VRAM lines, sourced
  // from data local-llm.sh already logs (eval_count/prompt_eval_count/eval_duration) plus a live
  // /api/ps VRAM lookup, rather than tailing a log file the actual server on this host does not
  // write in that literal format. All fields are null (never a raw error) when no real generation
  // has happened yet -- the normal state right after a fresh install.
  if (path === '/api/local-llm/last-generation' && method === 'GET') {
    const rows = parseUsageRows(tailUsageLines())
    const ps: unknown = await ollama('/api/ps')
    const psModels = ps && typeof ps === 'object' && Array.isArray((ps as { models?: unknown }).models)
      ? (ps as { models: ReadonlyArray<{ name?: unknown; size_vram?: unknown }> }).models
      : null
    const stats = lastGenerationStats(rows, psModels)
    json(res, stats ?? { ts: null, model: null, promptTokens: null, outputTokens: null, tokensPerSec: null, vramBytes: null })
    return true
  }

  // GET /api/local-llm/queue -> depth + latency + per-agent breakdown (dashboard feedback loop:
  // it shows WHICH agents never use the local model, which is the number Peti tunes against).
  if (path === '/api/local-llm/queue' && method === 'GET') {
    json(res, { ...queueStats(getDb()), by_agent: queueStatsByAgent(getDb()) })
    return true
  }

  // GET /api/local-llm/queue/list?status=&limit= -> recent rows for the dashboard panel (card
  // 48aacf56 item 5): pending/running/done/failed/escalated drafts with agent, task, timing.
  // Checked BEFORE the /queue/<id> catch-all below, or "list" would parse as an invalid numeric id.
  if (path === '/api/local-llm/queue/list' && method === 'GET') {
    const rawStatus = url.searchParams.get('status')
    const VALID_STATUSES: readonly QueueStatus[] = ['pending', 'running', 'done', 'failed', 'escalated']
    if (rawStatus !== null && !(VALID_STATUSES as readonly string[]).includes(rawStatus)) {
      json(res, { error: `invalid status (want one of ${VALID_STATUSES.join(', ')})` }, 400)
      return true
    }
    const limit = parseInt(url.searchParams.get('limit') || '100', 10)
    const rows = queueListRecent(getDb(), limit, (rawStatus as QueueStatus | null) ?? undefined)
    json(res, { rows })
    return true
  }

  // POST /api/local-llm/queue/claim -> the WORKER takes the next row (atomic; see claimNext).
  // Empty queue answers 200 with an empty object rather than 404: "nothing to do" is the normal
  // steady state, not an error, and the worker polls this on every idle tick.
  if (path === '/api/local-llm/queue/claim' && method === 'POST') {
    // Reclaim first: a worker killed mid-run (service restart, OOM, the WSL VM dropping) leaves its
    // row `running` forever. Doing it here means recovery happens whenever a worker is alive,
    // without a second timer -- and a dead worker cannot clean up after itself by definition.
    const reclaimed = reclaimStaleLocalLlm(getDb(), STALE_RUNNING_MS, Date.now())
    for (const id of reclaimed.escalatedIds) notifyEscalation(id)
    const row = claimNextLocalLlm(getDb(), Date.now())
    json(res, row ?? {})
    return true
  }

  // POST /api/local-llm/queue/<id>/complete | /fail | /abstain -- worker result sinks.
  const doneMatch = path.match(/^\/api\/local-llm\/queue\/(\d+)\/(complete|fail|abstain)$/)
  if (doneMatch && method === 'POST') {
    const id = Number(doneMatch[1])
    const kind = doneMatch[2]
    const body = (await readBody(req)).toString()
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(body || '{}') as Record<string, unknown>
    } catch {
      json(res, { error: 'invalid JSON body' }, 400)
      return true
    }
    if (!queueGetById(getDb(), id)) {
      json(res, { error: 'not found' }, 404)
      return true
    }
    if (kind === 'complete') {
      const result = String(payload['result'] ?? '')
      // A DIRECT-SYNC row is a STATISTICS registration, not queued work (card 41df5159): local-llm.sh
      // hands the model's answer straight back to its caller on stdout and posts an intentionally
      // empty `{"result":""}` here purely to close the row. It therefore has no output to verify, and
      // running the check on it marked EVERY successful direct call `failed` on the dashboard -- 460
      // rows, all of them from calls that had actually succeeded (_queue_finish complete is only
      // reached after the Ollama response returns; the failure path posts /fail instead). The
      // verification (card ea931c14) stays exactly as it was for real WORKER results, which is what
      // it was built for.
      const statisticsOnly = isDirectSyncCall(getDb(), id)
      if (!statisticsOnly) {
        // Independent verification (card ea931c14, komment 14138 requirement 1) BEFORE accepting the
        // result as done -- a completion that fails this check is treated as a failed ATTEMPT, not a
        // silent success, so it still counts toward the retry/escalation budget fail() already owns.
        const verdict = verifyOutput(result)
        if (!verdict.ok) {
          const status = failLocalLlm(getDb(), id, `output verification failed: ${verdict.reason}`, Date.now())
          if (status === 'escalated') notifyEscalation(id)
          json(res, { id, status, verified: false, reason: verdict.reason })
          return true
        }
      }
      completeLocalLlm(getDb(), id, result, Date.now())
      // `verified` reports what actually happened, not what would look tidy: a statistics row was
      // never verified, and saying otherwise would make the field useless as evidence.
      json(
        res,
        statisticsOnly
          ? { id, status: 'done', verified: false, verificationSkipped: 'direct-sync' }
          : { id, status: 'done', verified: true },
      )
    } else if (kind === 'fail') {
      const status = failLocalLlm(getDb(), id, String(payload['error'] ?? 'unknown error'), Date.now())
      if (status === 'escalated') notifyEscalation(id)
      json(res, { id, status })
    } else {
      // abstain (card ea931c14, requirement 2): GPU-lock contention, not a real attempt -- does not
      // touch the escalation path at all, so no notifyEscalation() call here.
      abstainLocalLlm(getDb(), id)
      json(res, { id, status: 'pending' })
    }
    return true
  }

  // GET /api/local-llm/queue/<id> -> poll one row (the agent picks its draft up later)
  if (path.startsWith('/api/local-llm/queue/') && method === 'GET') {
    const raw = path.slice('/api/local-llm/queue/'.length)
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) {
      json(res, { error: 'invalid queue id' }, 400)
      return true
    }
    const row = queueGetById(getDb(), id)
    if (!row) {
      json(res, { error: 'not found' }, 404)
      return true
    }
    json(res, row)
    return true
  }

  // GET /api/local-llm/status
  if (path === '/api/local-llm/status' && method === 'GET') {
    const [tags, ps, bridge, gpu] = await Promise.all([
      ollama('/api/tags'),
      ollama('/api/ps'),
      bridgeActive(),
      gpuInfo(),
    ])
    const ollamaUp = tags !== null
    // INSTALLED and BENCHMARKED are separate facts with separate sources (card d730070e).
    // `installedAt` is ollama's own modified_at, so it is right even for a model pulled by hand;
    // `benchmarked` comes from the file store/local-llm-bench.sh writes when a run succeeds. Both
    // were `null` placeholders in the catalogue schema with nothing behind them, which left the UI
    // unable to distinguish a measured model from one downloaded a minute ago -- and this card
    // exists because "the download finished" is not evidence it produces usable code.
    const benchState = readBenchState(LLM_BENCH_STATE_FILE)
    // `name` is narrowed to a string ONCE, here, rather than at each use: `tags` comes back from
    // ollama as `any`, so every later `m.name` was an unsafe argument into a string parameter --
    // three of them, two added by the status-tile fix (9e54fa61) that tripped the lint ratchet.
    const rawModels = (Array.isArray(tags?.models) ? tags.models : []) as unknown[]
    const models = rawModels.map((raw) => {
      const m = raw as { name?: unknown; size?: unknown; modified_at?: unknown }
      const name = typeof m.name === 'string' ? m.name : ''
      return {
        name,
        size: m.size ?? 0,
        installedAt: typeof m.modified_at === 'string' ? m.modified_at : null,
        ...benchInfoFor(benchState, name),
      }
    })
    const running = ps?.models || []
    const active = readActiveModel()
    json(res, {
      ollama_up: ollamaUp,
      active_model: active,
      active_present: ollamaUp ? models.some((m) => modelNameMatches(m.name, active)) : null,
      embed_model: EMBED_MODEL,
      embed_present: ollamaUp ? models.some((m) => modelNameMatches(m.name, EMBED_MODEL)) : null,
      models,
      running,
      bridge_active: bridge,
      gpu,
    })
    return true
  }

  // GET /api/local-llm/catalog -> the GPU-filtered, trust-labelled HuggingFace model catalogue
  // (card 61a4a85f). Three tiers, each cheaper/less fresh than the last: a fresh cache file, then a
  // live refresh, then the script's own --offline (cache-or-bundled, marked stale) fallback. Only if
  // ALL THREE fail does this route synthesize an empty envelope itself -- still a structurally valid
  // document (rule 12: never a raw error for the UI to choke on), never a bare 500.
  if (path === '/api/local-llm/catalog' && method === 'GET') {
    // The trust label is recomputed from the reviewed list on the way out, whichever tier answered.
    // The `trusted` flag inside the catalogue is a build-time snapshot: after a publisher is removed
    // following an incident, that snapshot keeps saying "trusted" until someone rebuilds, so the
    // badge would contradict the gate the operator meets one click later.
    const label = <T extends { models?: unknown[] }>(doc: T): T => relabelCatalogueTrust(doc, LLM_CATALOG_TRUST_FILE)
    // SCHEMA CHECK ON EVERY TIER (card 4117f98e). schemaVersion exists so that a consumer meeting a
    // document it does not understand refuses it rather than reading fields that may have moved --
    // and this route is one of the two consumers the version was written for. It never looked, so
    // the guard was enforced only by the producer against itself.
    //
    // An unknown version does not end the request: the next tier may still be readable (a cache
    // written by a newer build, with a live refresh from this one). Only when no tier produces a
    // document this build understands does the empty envelope below go out, saying why.
    const usable = <T,>(doc: T | null): T | null => {
      if (!doc) return null
      const v = (doc as { schemaVersion?: unknown }).schemaVersion
      if (v === CATALOG_SCHEMA_VERSION) return doc
      logger.warn({ schemaVersion: v, understood: CATALOG_SCHEMA_VERSION }, 'local-llm: nem ismert katalógus-séma, kihagyva')
      return null
    }
    const fresh = usable(readLlmCatalogCacheIfFresh())
    if (fresh) { json(res, label(fresh)); return true }
    const live = usable(await runLlmCatalogScript([], LLM_CATALOG_LIVE_TIMEOUT_MS))
    if (live) { json(res, label(live)); return true }
    const offline = usable(await runLlmCatalogScript(['--offline'], LLM_CATALOG_OFFLINE_TIMEOUT_MS))
    if (offline) { json(res, label(offline)); return true }
    json(res, {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      source: 'none',
      stale: true,
      host: { gpu: null, ramTotalMib: null },
      models: [],
      // The message names BOTH ways this line is reached, because they call for different
      // actions: nothing produced a document, or every document was from a schema this build
      // does not read (update MikroB). A single generic string would send the reader looking
      // for a broken script when the file is merely newer than the code.
      warnings: [
        'llm-catalog.py did not produce a document this build can read (live and --offline both '
          + `failed, or their schemaVersion was not ${CATALOG_SCHEMA_VERSION})`,
      ],
    })
    return true
  }

  // GET /api/local-llm/offload-config -> the current offload aggressiveness + the marked optimum,
  // plus the coding-difficulty threshold (card afcfe93e): the effective max difficulty a coding task
  // may be to still draft locally. `explicit` = the operator picked a level from the dropdown;
  // otherwise it is DERIVED from the aggressiveness slider via defaultDifficultyForAggressiveness.
  if (path === '/api/local-llm/offload-config' && method === 'GET') {
    const cfg = readOffloadConfig()
    const aggressiveness = normalizeAggressiveness(cfg.aggressiveness)
    const explicit = normalizeThreshold(cfg.codingDifficultyThreshold)
    const derived = defaultDifficultyForAggressiveness(aggressiveness)
    json(res, {
      active: cfg.active !== false, // default on unless explicitly disabled
      mode: typeof cfg.mode === 'string' ? cfg.mode : 'proactive',
      aggressiveness,
      optimal: OPTIMAL_AGGRESSIVENESS,
      // Card 346d3933: the auto-ramp contract for the FE. `source` says whether the slider is under
      // manual or automatic control; `ramp` reports the live weekly %, the threshold it climbs to, and
      // what the auto value would be right now -- so the dashboard can show "Auto: 94% (weekly 82%)"
      // and offer a "back to Auto" action when the operator has taken manual control.
      aggressivenessSource: resolveAggressivenessSource(cfg),
      ramp: mapRampState(offloadRampState(), resolveAggressivenessSource(cfg), aggressiveness),
      codingDifficultyThreshold: explicit ?? derived,
      codingDifficultyExplicit: explicit !== null,
      codingDifficultyDerived: derived,
      codingDifficultyLevels: CODING_DIFFICULTY_LEVELS,
      offloadableThresholds: OFFLOADABLE_THRESHOLDS,
      reliableCeiling: RELIABLE_CEILING,
    })
    return true
  }

  // POST /api/local-llm/offload-config { aggressiveness: 0..100 } -> persist into the shared config the
  // agents + skill read. Bearer-gated by src/web.ts (never unauth-settable). Only the aggressiveness
  // field is touched; the rest of the directive metadata (active/mode/set_by/policy) is preserved.
  if (path === '/api/local-llm/offload-config' && method === 'POST') {
    const body = (await readBody(req)).toString()
    let parsed: { aggressiveness?: unknown; codingDifficultyThreshold?: unknown }
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      json(res, { error: 'invalid_json', message: 'A kérés törzse érvénytelen JSON.' }, 400)
      return true
    }
    const hasAggr = parsed.aggressiveness !== undefined
    const hasDiff = parsed.codingDifficultyThreshold !== undefined
    if (!hasAggr && !hasDiff) {
      json(
        res,
        { error: 'missing_field', message: 'Adj meg legalább egy mezőt: aggressiveness (0-100) vagy codingDifficultyThreshold.' },
        400,
      )
      return true
    }
    const cfg = readOffloadConfig()
    if (hasAggr) {
      // Card 346d3933: setting the slider is a MANUAL override -- it wins over the auto ramp until the
      // operator hands control back with 'auto'. 'auto'/null/'' clears the manual flag so the ramp
      // (weekly-usage-panel-read.sh -> apply-offload-ramp) resumes driving the value.
      const raw = parsed.aggressiveness
      if (raw === 'auto' || raw === null || raw === '') {
        cfg.aggressiveness_source = 'auto'
      } else {
        cfg.aggressiveness = normalizeAggressiveness(raw)
        cfg.aggressiveness_source = 'manual'
      }
      cfg.aggressiveness_set_at = new Date().toISOString()
    }
    if (hasDiff) {
      // 'auto'/null/'' -> clear the explicit override so the threshold follows the slider again.
      const raw = parsed.codingDifficultyThreshold
      if (raw === null || raw === 'auto' || raw === '') {
        delete cfg.codingDifficultyThreshold
        delete cfg.coding_difficulty_set_at
      } else if (normalizeDifficulty(raw) === null) {
        json(
          res,
          {
            error: 'invalid_field',
            message: `Érvénytelen nehézségi szint. Engedélyezett: ${OFFLOADABLE_THRESHOLDS.join(', ')} (vagy "auto").`,
          },
          400,
        )
        return true
      } else {
        // Clamp to the reliable ceiling: a request for feature/architecture is stored as 'module'
        // (those never offload). normalizeThreshold(raw) is non-null here (raw is a known level).
        cfg.codingDifficultyThreshold = normalizeThreshold(raw)
        cfg.coding_difficulty_set_at = new Date().toISOString()
      }
    }
    try {
      atomicWriteFileSync(OFFLOAD_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n')
    } catch (err) {
      logger.error({ err }, 'offload-config: write failed')
      json(res, { error: 'write_failed', message: 'A beállítás mentése nem sikerült, próbáld újra.' }, 500)
      return true
    }
    const aggressiveness = normalizeAggressiveness(cfg.aggressiveness)
    const explicit = normalizeThreshold(cfg.codingDifficultyThreshold)
    const derived = defaultDifficultyForAggressiveness(aggressiveness)
    json(res, {
      aggressiveness,
      optimal: OPTIMAL_AGGRESSIVENESS,
      codingDifficultyThreshold: explicit ?? derived,
      codingDifficultyExplicit: explicit !== null,
      codingDifficultyDerived: derived,
      codingDifficultyLevels: CODING_DIFFICULTY_LEVELS,
      offloadableThresholds: OFFLOADABLE_THRESHOLDS,
      reliableCeiling: RELIABLE_CEILING,
    })
    return true
  }

  // GET /api/local-llm/categories -> all --task presets (card 0c054ebf), not just the 4 coding-
  // difficulty levels the threshold dropdown covers. Source of truth is the skill-template
  // directory on disk, merged with real usage counts/last-used and the per-category on/off state.
  if (path === '/api/local-llm/categories' && method === 'GET') {
    json(res, { categories: listCategories() })
    return true
  }

  // POST /api/local-llm/categories { task, enabled } -> toggle ONE category's enabled state. Single-
  // field mutate (not a full-array replace) so two browser tabs toggling different categories can't
  // race and silently drop each other's change. Enforcement lives in store/local-llm.sh (reads the
  // same disabledCategories array before running any --task preset) -- this is not decorative.
  if (path === '/api/local-llm/categories' && method === 'POST') {
    const body = (await readBody(req)).toString()
    let parsed: { task?: unknown; enabled?: unknown }
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      json(res, { error: 'invalid_json', message: 'A kérés törzse érvénytelen JSON.' }, 400)
      return true
    }
    const task = typeof parsed.task === 'string' ? parsed.task.trim() : ''
    if (!task) {
      json(res, { error: 'missing_field', message: 'Adj meg egy task nevet.' }, 400)
      return true
    }
    // Charset allowlist BEFORE the path join (Cybersec, card 18a0acb9): keeps a `../`-bearing value
    // from ever reaching join(SKILL_DIR, ...) and escaping the skills dir. Fail-closed 400 -- no
    // filesystem probe on a malformed name.
    if (!isValidCategoryName(task)) {
      json(res, { error: 'invalid_category', message: 'Érvénytelen kategórianév: csak a-z, 0-9, kötőjel és aláhúzás engedélyezett (legfeljebb 64 karakter).' }, 400)
      return true
    }
    if (!existsSync(join(SKILL_DIR, `${task}.txt`))) {
      json(res, { error: 'unknown_category', message: `Ismeretlen kategória: "${task}".` }, 404)
      return true
    }
    const enabled = parsed.enabled !== false // default true (enable) if the field is omitted/truthy
    const cfg = readOffloadConfig()
    const current = new Set(
      Array.isArray(cfg.disabledCategories) ? (cfg.disabledCategories as unknown[]).map(String) : [],
    )
    if (enabled) current.delete(task)
    else current.add(task)
    cfg.disabledCategories = [...current].sort()
    try {
      atomicWriteFileSync(OFFLOAD_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n')
    } catch (err) {
      logger.error({ err }, 'categories: write failed')
      json(res, { error: 'write_failed', message: 'A beállítás mentése nem sikerült, próbáld újra.' }, 500)
      return true
    }
    json(res, { categories: listCategories() })
    return true
  }

  // GET /api/local-llm/running -> Ollama /api/ps passthrough
  if (path === '/api/local-llm/running' && method === 'GET') {
    const ps = await ollama('/api/ps')
    if (ps === null) { json(res, { ollama_up: false, models: [] }); return true }
    json(res, { ollama_up: true, models: ps.models || [] })
    return true
  }

  // GET /api/local-llm/logs?source=bridge|ollama&lines=N
  if (path === '/api/local-llm/logs' && method === 'GET') {
    const source = url.searchParams.get('source') === 'ollama' ? 'ollama' : 'bridge'
    let n = parseInt(url.searchParams.get('lines') || '120', 10)
    if (!Number.isFinite(n) || n < 1) n = 120
    if (n > 500) n = 500
    const unit = source === 'ollama' ? OLLAMA_UNIT : BRIDGE_UNIT
    const r = await runCmd('journalctl', ['--user', '-u', unit, '-n', String(n), '--no-pager'], { timeoutMs: 8000 })
    // journalctl exits nonzero / prints nothing (or "-- No entries --") when the
    // unit has no journal.
    let out = r.stdout.trim()
    if (/^-- No entries --$/.test(out)) out = ''
    if (!out) {
      const note = source === 'ollama'
        ? `Nincs "${OLLAMA_UNIT}" felhasználói systemd unit (az Ollama másképp fut vagy nincs journal-naplója).`
        : `Nincs napló a "${BRIDGE_UNIT}" unithoz (lehet, hogy a szolgáltatás nem fut).`
      json(res, { source, lines: [], note })
      return true
    }
    json(res, { source, lines: out.split('\n') })
    return true
  }

  // POST /api/local-llm/model  {model} -> swap active model
  //
  // THIS IS THE SECOND DOOR ONTO store/local-llm-model, and until card eb843c46 it was the unguarded
  // one: the CLI path (store/first-run-llm.sh --use) refuses an unreviewed publisher and a digest
  // mismatch, while this endpoint checked the model NAME and whether ollama had the file, then
  // wrote. Same end state -- the model every agent's drafts come from -- under two different rule
  // sets, which means the stricter set was advisory. Both doors now apply the same TRUST decision,
  // from src/local-llm-model-trust.ts, so they cannot drift apart.
  //
  // AN UNTRUSTED PUBLISHER CANNOT BE ACCEPTED THROUGH THIS DOOR AT ALL (card d297f26f, Cybersec
  // residual finding on eb843c46, MikroB's decision). It used to accept an `iTrust` field and check
  // it against `basis.confirmWith` -- but that value came back from THIS SAME response one request
  // earlier, so "confirming" it was an unauthenticated echo: anything holding the dashboard token
  // (every fleet agent) could clear it in two automated requests, no human ever reading the
  // publisher/downloads/digest evidence the confirmation screen exists to show. The CLI's own
  // `--i-trust` answer has the same shape, but reaching it requires actual shell access to the host,
  // a materially stronger bar than "holds the dashboard token" -- so it stays the one channel that
  // can honestly claim a human read the screen. This door now always refuses an untrusted publisher
  // and points at the CLI instead of offering a weaker version of the same confirmation.
  if (path === '/api/local-llm/model' && method === 'POST') {
    let model = ''
    try {
      const body = JSON.parse((await readBody(req)).toString())
      model = (body.model || '').trim()
    } catch { /* bad json */ }
    if (!MODEL_RE.test(model)) { json(res, { error: 'Érvénytelen modellnév.' }, 400); return true }
    const tags = await ollama('/api/tags')
    if (tags === null) { json(res, { error: 'Az Ollama nem elérhető.' }, 503); return true }
    const present = (tags.models || []).some((m: any) => m.name === model)
    if (!present) { json(res, { error: 'Ez a modell nincs letöltve. Előbb húzd le (pull).' }, 409); return true }

    const basis = decideModelTrust({
      model,
      cacheFile: LLM_CATALOG_CACHE_FILE,
      trustFile: LLM_CATALOG_TRUST_FILE,
      blobsDir: OLLAMA_BLOBS_DIR,
    })
    // A digest mismatch has NO override, here or in the script: the bytes on disk are not the bytes
    // that were catalogued, so there is nothing an operator could knowingly consent to.
    if (basis.digest === 'mismatch') {
      logger.warn({ model, missing: basis.missing }, 'local-llm: digest-eltérés, aktív modell váltás elutasítva')
      json(res, {
        error: 'A letöltött súlyok nem egyeznek a katalógusban rögzített ellenőrzőösszeggel, ezért nem tehető alapértelmezetté. Töltsd le újra a modellt, vagy frissítsd a katalógust.',
        code: 'digest_mismatch',
        basis: { model, missing: basis.missing },
      }, 409)
      return true
    }
    if (!basis.trusted) {
      // No confirmation path here -- see the door-level comment above. The evidence still goes
      // back to the caller so the dashboard can show WHY, and the exact CLI command an operator
      // with real shell access would run, but nothing sent back to this endpoint can act on it.
      logger.warn({ model, owner: basis.owner }, 'local-llm: nem jóváhagyott kiadó, a HTTP-út nem fogadja el')
      json(res, {
        error: `Ez a modell nem jóváhagyott kiadótól származik (${basis.owner}), ezért a dashboardról nem tehető a flotta alapértelmezett modelljévé. Nézd át a kiadót, a letöltésszámot és az ellenőrzőösszegeket, majd ha mégis ezt akarod, futtasd a szerveren: store/first-run-llm.sh --use ${model} --i-trust ${basis.confirmWith}`,
        code: 'publisher_not_trusted',
        basis: {
          model,
          owner: basis.owner,
          downloads: basis.downloads,
          partCount: basis.parts.length,
          // Never truncated: a shortened digest cannot be compared against anything.
          parts: basis.parts,
          digest: basis.digest,
        },
      }, 403)
      return true
    }
    try {
      atomicWriteFileSync(MODEL_FILE, model + '\n')
      logger.info(
        { model, owner: basis.owner, trusted: basis.trusted, digest: basis.digest, confirmed: !basis.trusted },
        'local-llm: aktív modell beállítva',
      )
    } catch (err) {
      logger.warn({ err }, 'local-llm: aktív modell írása sikertelen')
      json(res, { error: 'Az aktív modell mentése nem sikerült.' }, 500)
      return true
    }
    json(res, { ok: true, active_model: model })
    return true
  }

  // POST /api/local-llm/pull  {model} -> start async pull (new download or update)
  if (path === '/api/local-llm/pull' && method === 'POST') {
    let model = ''
    try { model = (JSON.parse((await readBody(req)).toString()).model || '').trim() } catch { /* bad json */ }
    // This is the door that actually spawns `ollama pull`, so an `hf.co/` ref gets the stricter
    // HF-repo-shape check on top of MODEL_RE's charset (see isValidPullTarget).
    if (!isValidPullTarget(model)) { json(res, { error: 'Érvénytelen modellnév.' }, 400); return true }
    if (activePullId && !pullJobs.get(activePullId)?.done) {
      json(res, { error: 'Már fut egy letöltés. Várd meg, míg befejeződik.' }, 409)
      return true
    }
    const job = startPull(model)
    json(res, { ok: true, job_id: job.id })
    return true
  }

  // GET /api/local-llm/pull-status?job_id=
  if (path === '/api/local-llm/pull-status' && method === 'GET') {
    const id = url.searchParams.get('job_id') || ''
    const job = pullJobs.get(id)
    if (!job) { json(res, { error: 'Ismeretlen letöltési feladat.' }, 404); return true }
    json(res, { job_id: job.id, model: job.model, done: job.done, ok: job.ok, last_line: job.lastLine, error: job.error })
    // Reap finished jobs a while after completion to avoid unbounded growth.
    if (job.done && Date.now() - job.startedAt > 10 * 60 * 1000) pullJobs.delete(id)
    return true
  }

  // POST /api/local-llm/run  {prompt} -> run the local model via the RAG wrapper
  if (path === '/api/local-llm/run' && method === 'POST') {
    let prompt = ''
    try { prompt = String(JSON.parse((await readBody(req, { maxBytes: 64 * 1024 })).toString()).prompt || '') } catch { /* bad json */ }
    prompt = prompt.trim()
    if (!prompt) { json(res, { error: 'Üres prompt.' }, 400); return true }
    if (prompt.length > MAX_PROMPT_LEN) { json(res, { error: `A prompt túl hosszú (max ${MAX_PROMPT_LEN} karakter).` }, 400); return true }
    if (!existsSync(RAG_SCRIPT)) { json(res, { error: 'A RAG wrapper (local-llm-rag.sh) nem található.' }, 500); return true }
    // Prompt is piped via stdin, never placed on the argv/command line.
    // Tag this as a UI probe (caller=ui-test, source=ui) so the usage metric can
    // exclude dashboard quick-tests from the real fleet-invocation counts.
    // --no-route (card e817817c): the wrapper now routes by default, and this box exists to ask THE
    // LOCAL MODEL something. Whoever typed here already decided; a routing verdict would surface as
    // exit 9 -> a 502 "futtatása hibázott", i.e. the test box breaking on a subset of prompts.
    const r = await runCmd(
      'bash',
      [RAG_SCRIPT, '--no-route', '--agent', 'mikrob', '--caller', 'ui-test', '--source', 'ui'],
      { timeoutMs: RUN_TIMEOUT_MS, input: prompt },
    )
    if (r.timedOut) { json(res, { error: 'A helyi modell időtúllépés miatt nem válaszolt.' }, 504); return true }
    if (r.code !== 0) {
      const detail = (r.stderr.trim() || r.stdout.trim() || 'ismeretlen hiba').slice(0, 500)
      json(res, { error: `A helyi modell futtatása hibázott: ${detail}` }, 502)
      return true
    }
    json(res, { ok: true, response: r.stdout.trim(), model: readActiveModel() })
    return true
  }

  // GET /api/local-llm/usage -> invocation metrics from the append-only ledger
  if (path === '/api/local-llm/usage' && method === 'GET') {
    json(res, buildUsage())
    return true
  }

  // GET /api/local-llm/model-recommendations -> curated coding-model list
  // for this 6 GB GPU. Static/factual; marks the currently active model.
  if (path === '/api/local-llm/model-recommendations' && method === 'GET') {
    const active = readActiveModel()
    // A rec is "active" when it prefixes the on-disk tag: the file may carry a
    // quant suffix (e.g. qwen2.5-coder:7b-instruct-q4_K_M) that the base name
    // (qwen2.5-coder:7b) prefixes -- and ':7b' never prefixes ':1.5b', so no
    // sibling false-match. Anchor on the ':tag' boundary defensively.
    const isActive = (name: string): boolean => {
      if (!active) return false
      if (active === name) return true
      return active.startsWith(name) && (active.length === name.length || active[name.length] === '-')
    }
    const models = CODING_MODEL_RECS.map(m => ({
      ...m,
      ollama_pull: `ollama pull ${m.name}`,
      active: isActive(m.name),
    }))
    json(res, {
      active_model: active,
      gpu: { name: 'GTX 1660 Ti', vram_gb: 6, usable_gb: 5 },
      models,
    })
    return true
  }

  // GET /api/local-llm/hf-search?query=&task=&sort=&gguf=&limit=
  // Proxy the public HuggingFace models API. Params are whitelisted/sanitized;
  // only GGUF results carry an ollama_pull (Ollama pulls GGUF repos directly).
  if (path === '/api/local-llm/hf-search' && method === 'GET') {
    const query = sanitizeHfQuery(url.searchParams.get('query') || '')
    let task = (url.searchParams.get('task') || 'text-generation').trim()
    if (!HF_TASK_ALLOW.has(task)) task = 'text-generation'
    let sort = (url.searchParams.get('sort') || 'downloads').trim()
    if (!Object.prototype.hasOwnProperty.call(HF_SORT_MAP, sort)) sort = 'downloads'
    // gguf defaults ON; only an explicit false/0 turns it off.
    const ggufRaw = (url.searchParams.get('gguf') || 'true').trim().toLowerCase()
    const gguf = !(ggufRaw === 'false' || ggufRaw === '0' || ggufRaw === 'no')
    let limit = parseInt(url.searchParams.get('limit') || String(HF_DEFAULT_LIMIT), 10)
    if (!Number.isFinite(limit) || limit < 1) limit = HF_DEFAULT_LIMIT
    if (limit > HF_MAX_LIMIT) limit = HF_MAX_LIMIT

    const hf = new URL(HF_BASE)
    if (query) hf.searchParams.set('search', query)
    if (task) hf.searchParams.append('filter', task)
    if (gguf) hf.searchParams.append('filter', 'gguf')
    hf.searchParams.set('sort', HF_SORT_MAP[sort])
    hf.searchParams.set('direction', '-1')
    hf.searchParams.set('limit', String(limit))

    let data: unknown
    try {
      const r = await fetch(hf.toString(), {
        signal: AbortSignal.timeout(HF_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      })
      if (!r.ok) {
        json(res, { error: `A HuggingFace keresés hibázott (HTTP ${r.status}). Próbáld újra később.` }, 502)
        return true
      }
      data = await r.json()
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError'
      json(res, {
        error: timedOut
          ? 'A HuggingFace keresés időtúllépés miatt megszakadt. Próbáld újra.'
          : 'A HuggingFace nem érhető el. Ellenőrizd a hálózatot és próbáld újra.',
      }, 502)
      return true
    }
    if (!Array.isArray(data)) {
      json(res, { error: 'A HuggingFace válasza értelmezhetetlen volt. Próbáld újra.' }, 502)
      return true
    }
    const results = data.slice(0, limit).map((m: any) => {
      const id = String((m && (m.id || m.modelId)) || '')
      const tags = Array.isArray(m?.tags) ? m.tags.map((x: unknown) => String(x)) : []
      const isGguf =
        /gguf/i.test(String(m?.library_name || '')) ||
        tags.some((tg: string) => /^gguf$/i.test(tg)) ||
        /gguf/i.test(id)
      const downloads = Number(m?.downloads)
      const likes = Number(m?.likes)
      return {
        id,
        downloads: Number.isFinite(downloads) ? downloads : 0,
        likes: Number.isFinite(likes) ? likes : 0,
        tags: tags.slice(0, 12),
        gguf: isGguf,
        ollama_pull: isGguf && id ? `ollama pull hf.co/${id}` : null,
        hf_url: id ? `https://huggingface.co/${encodeURI(id)}` : '',
      }
    }).filter((x: { id: string }) => x.id)
    json(res, { query, task, sort, gguf, limit, count: results.length, results })
    return true
  }

  return false
}

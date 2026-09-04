// Name/phrase rules for the outgoing-copy gate -- the storage half of card 98dbbcc9.
//
// The file this module owns (store/outgoing-copy-gate-rules.json) is consumed by
// scripts/hooks/outgoing-copy-gate.py, which does `re.compile("|".join(pats))` at import
// time OUTSIDE any try/except. Three consequences drive every decision below:
//
//  1. VALIDATION MUST RUN PYTHON. A pattern that Node's RegExp accepts can still be a
//     Python compile error -- measured, both directions: `(?<n>x)` and `\p{L}` pass Node
//     and crash Python, `(?P<n>x)` and `(?#c)x` pass Python and are rejected by Node. And a
//     crash is not fail-closed: the hook exits 1 with empty stdout, only exit 2 blocks, so
//     the gate SILENTLY STOPS RUNNING for every agent. Hence scripts/name-pattern-tool.py.
//  2. THE MODE IS PART OF THE CONTENT. The file is 0600 because it names a private third
//     party. atomicWriteFileSync() only chmods when the caller passes opts.mode, so an
//     omitted mode silently relaxes 0600 -> umask (0664 here). It is passed, and asserted.
//  3. THE CONTENT NEVER LEAVES. Patterns go to the authenticated operator's own screen and
//     nowhere else: not the audit row, not the logger, not an error string we raise.
//     Callers get counts.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

export const RULES_FILENAME = 'outgoing-copy-gate-rules.json'
const TOOL = join(PROJECT_ROOT, 'scripts', 'name-pattern-tool.py')
const FILE_MODE = 0o600
// Generous for one small JSON exchange, tight enough that a regex the in-tool SIGALRM budget
// somehow fails to interrupt still cannot hold an HTTP handler open.
const TOOL_TIMEOUT_MS = 10_000
// A file that is PRESENT but unreadable still holds someone else's live configuration, so a
// rewrite would destroy it. Only an ABSENT file is safe to create from scratch. Kept separate
// from removePattern's wording: there the file may also simply not exist.
const UNREADABLE_FILE_MESSAGE =
  'A szabályfájl sérült vagy nem olvasható, ezért nem írom felül -- a benne lévő szabályok elvesznének. ' +
  'Előbb a fájlt kell helyreállítani.'

/** File present+valid+>=1 pattern / present+valid+empty / missing-unreadable-malformed.
 *  Mirrors the hook's own three states so the UI can say which one is true. */
export type GateState = 'active' | 'empty' | 'broken'

export interface RulesShape {
  bad_name_patterns: string[]
  [k: string]: unknown
}

export interface NamePatternDeps {
  rulesPath: string
  /** True when this checkout is a git WORKTREE (its `.git` is a file, not a directory). */
  isWorktree: () => boolean
  /** Runs the Python validator. Injected so tests can drive it without a subprocess. */
  runTool: (req: unknown) => { ok: boolean; pattern?: string; error?: string }
}

export class NamePatternError extends Error {}

function defaultRunTool(req: unknown): { ok: boolean; pattern?: string; error?: string } {
  let out: string
  try {
    out = execFileSync('python3', [TOOL], {
      input: JSON.stringify(req),
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString()
  } catch (err) {
    // A timeout here means the tool could not decide in ten seconds. The only known way to
    // get there is a pattern so pathological that even the interrupt did not land, which is
    // exactly the thing we must not write. Treat it as a rejection, never as a pass.
    const killed = (err as { killed?: boolean }).killed
    return {
      ok: false,
      error: killed
        ? 'A minta ellenőrzése időtúllépéssel leállt, ezért nem vettem fel. Ez majdnem biztosan egy nagyon lassú (visszalépéses) minta -- add meg pontos szövegként.'
        : 'A minta-ellenőrző nem futott le. Szólj a rendszergazdának.',
    }
  }
  try {
    const parsed = JSON.parse(out) as { ok?: unknown; pattern?: unknown; error?: unknown }
    return {
      ok: parsed.ok === true,
      pattern: typeof parsed.pattern === 'string' ? parsed.pattern : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
    }
  } catch {
    return { ok: false, error: 'A minta-ellenőrző értelmezhetetlen választ adott.' }
  }
}

export function defaultDeps(): NamePatternDeps {
  return {
    rulesPath: join(STORE_DIR, RULES_FILENAME),
    isWorktree: () => {
      // A worktree's `.git` is a FILE holding a gitdir pointer; the main clone's is a
      // directory. The rules file is gitignored AND 0600, so it exists only in the main
      // clone -- a worktree-hosted dashboard would happily create a SECOND one that the
      // fleet's hooks never read, i.e. rules that look saved and protect nothing.
      try {
        return statSync(join(PROJECT_ROOT, '.git')).isFile()
      } catch {
        return false // no .git at all (a packaged install) is not a worktree
      }
    },
    runTool: defaultRunTool,
  }
}

/** One `null` used to mean four different things -- absent, unreadable, unparseable, wrong
 *  shape -- and only the FIRST is safe to overwrite. A writer must tell them apart; a reader
 *  may keep collapsing them (the hook itself treats every non-usable file as malformed). */
type RawRead = { kind: 'ok'; value: RulesShape } | { kind: 'absent' } | { kind: 'unreadable' }

function readRawState(deps: NamePatternDeps): RawRead {
  let text: string
  try {
    text = readFileSync(deps.rulesPath, 'utf8')
  } catch (err) {
    // ENOENT is the only "there is nothing here to lose" case. EACCES, EISDIR and friends
    // mean the file IS there and we simply cannot see what it holds.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' }
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unreadable' }
    const obj = parsed as Record<string, unknown>
    // The hook treats a MISSING key as malformed and only an explicit [] as a deliberate
    // empty. Keep that distinction rather than normalising it away here.
    if (!Array.isArray(obj.bad_name_patterns)) return { kind: 'unreadable' }
    if (!obj.bad_name_patterns.every((p) => typeof p === 'string')) return { kind: 'unreadable' }
    return { kind: 'ok', value: obj as RulesShape }
  } catch {
    return { kind: 'unreadable' }
  }
}

function readRaw(deps: NamePatternDeps): RulesShape | null {
  const raw = readRawState(deps)
  return raw.kind === 'ok' ? raw.value : null
}

export function readPatterns(deps: NamePatternDeps): { state: GateState; patterns: string[] } {
  const raw = readRaw(deps)
  if (raw === null) return { state: 'broken', patterns: [] }
  return { state: raw.bad_name_patterns.length ? 'active' : 'empty', patterns: raw.bad_name_patterns }
}

function write(deps: NamePatternDeps, patterns: string[]): void {
  if (deps.isWorktree()) {
    throw new NamePatternError(
      'Ez a példány git worktree-ből fut, ahol a szabályfájl nem a flotta által olvasott példány. ' +
        'A név-szabályokat a fő telepítés dashboardján kell szerkeszteni.',
    )
  }
  // Preserve every sibling key (notably `correction`, which the hook appends to its refusal
  // message): this endpoint owns ONE field, and rewriting the file must not quietly drop the
  // rest of someone else's configuration.
  const existing = readRawState(deps)
  // The single point where the file is destroyed, so the refusal lives here rather than in
  // each caller: an unreadable file is NOT an empty one to build on.
  if (existing.kind === 'unreadable') throw new NamePatternError(UNREADABLE_FILE_MESSAGE)
  const next: RulesShape = {
    ...(existing.kind === 'ok' ? existing.value : {}),
    bad_name_patterns: patterns,
  }
  atomicWriteFileSync(deps.rulesPath, JSON.stringify(next, null, 2) + '\n', { mode: FILE_MODE })
}

/** Add one rule. `mode: 'literal'` escapes it in Python; `'regex'` stores it as typed.
 *  Returns the new count -- never the pattern. */
export function addPattern(
  deps: NamePatternDeps,
  value: string,
  mode: 'literal' | 'regex',
): { count: number } {
  const current = readRaw(deps)
  const patterns = current?.bad_name_patterns ?? []
  const verdict = deps.runTool({ op: 'prepare', patterns, value, mode })
  if (!verdict.ok || !verdict.pattern) {
    throw new NamePatternError(verdict.error || 'A minta nem fogadható el.')
  }
  const next = [...patterns, verdict.pattern]
  write(deps, next)
  return { count: next.length }
}

/** Remove one rule by its exact stored source. Removing by value rather than by index so a
 *  stale list on the operator's screen deletes nothing instead of deleting the wrong row. */
export function removePattern(deps: NamePatternDeps, pattern: string): { count: number; removed: boolean } {
  const current = readRaw(deps)
  if (current === null) {
    throw new NamePatternError(
      'A szabályfájl hiányzik vagy sérült, ezért nem törlök belőle. Előbb a fájlt kell helyreállítani.',
    )
  }
  const patterns = current.bad_name_patterns
  const next = patterns.filter((p) => p !== pattern)
  if (next.length === patterns.length) return { count: patterns.length, removed: false }
  write(deps, next)
  return { count: next.length, removed: true }
}

/** True when the rules file is present with the mode we require. Surfaced to the UI so a
 *  relaxed mode is visible rather than assumed. */
export function fileModeOk(deps: NamePatternDeps): boolean {
  try {
    return (statSync(deps.rulesPath).mode & 0o777) === FILE_MODE
  } catch {
    return false
  }
}

export function rulesFileExists(deps: NamePatternDeps): boolean {
  return existsSync(deps.rulesPath)
}

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

// "When was this system last updated?" -- the answer the dashboard badge shows (card 0898db66).
//
// Primary source is store/.update-history, which update.sh appends to on every version
// transition. The file is TAB-separated and carries several event kinds:
//
//   <ISO ts>\t update            \t<branch>\t<from sha>\t<to sha>\t auto
//   <ISO ts>\t rollback          \t<branch>\t<from sha>\t<to sha>\t recovery
//   <ISO ts>\t rollback-refused  \t<context>\t<from>\t<to>\t<reason>
//   <ISO ts>\t checkpoint        \t<branch>\t<sha>\t<sha>\t<note>
//
// Only `update` answers the question. `rollback` also moves the running version, but calling
// that "last updated" would report a version going BACKWARDS as an update -- exactly the kind of
// reassuring-but-wrong badge that lets a rolled-back install look current. `rollback-refused` and
// `checkpoint` change nothing at all.
//
// Fallback is dist/.built-commit: its mtime is when the running build was produced. Weaker (a
// rebuild without a version change also touches it) so it is reported with its own source label
// rather than passed off as an update.

export interface LastUpdate {
  /** ISO 8601, as recorded. Null when nothing could be determined. */
  timestamp: string | null
  /** The commit the system moved TO. Null when the fallback path was used. */
  toSha: string | null
  /** package.json version of the running checkout. */
  version: string | null
  /** Which of the two sources answered, so the UI need not guess how solid this is. */
  source: 'update-history' | 'built-commit' | null
}

const UPDATE_HISTORY = 'store/.update-history'
const BUILT_COMMIT = 'dist/.built-commit'

function readVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

/** Last successful `update` row, newest first. Returns null when there is none. */
function fromHistory(root: string): { timestamp: string; toSha: string } | null {
  let raw: string
  try {
    raw = readFileSync(join(root, UPDATE_HISTORY), 'utf-8')
  } catch {
    return null
  }
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const cols = (lines[i] ?? '').split('\t')
    // ts, event, branch, from, to, note -- anything shorter is a truncated write, not a row
    if (cols.length < 5) continue
    if (cols[1] !== 'update') continue
    const timestamp = (cols[0] ?? '').trim()
    const toSha = (cols[4] ?? '').trim()
    // A row whose timestamp does not parse is worse than no row: the badge would render
    // "Invalid Date" and look like a UI bug rather than a missing record.
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) continue
    if (!/^[0-9a-f]{7,40}$/i.test(toSha)) continue
    return { timestamp, toSha }
  }
  return null
}

/** mtime of the build marker: when the running build was produced. */
function fromBuiltCommit(root: string): { timestamp: string } | null {
  try {
    return { timestamp: statSync(join(root, BUILT_COMMIT)).mtime.toISOString() }
  } catch {
    return null
  }
}

/**
 * Never throws and never rejects: a missing or malformed history file yields
 * `{timestamp: null, source: null}` so the caller can render "unknown" instead of failing.
 */
export function readLastUpdate(root: string = PROJECT_ROOT): LastUpdate {
  const version = readVersion(root)
  const hist = fromHistory(root)
  if (hist) return { timestamp: hist.timestamp, toSha: hist.toSha, version, source: 'update-history' }
  const built = fromBuiltCommit(root)
  if (built) return { timestamp: built.timestamp, toSha: null, version, source: 'built-commit' }
  return { timestamp: null, toSha: null, version, source: null }
}

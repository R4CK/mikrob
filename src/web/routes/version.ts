// GET /api/version -- semver + short commit hash + build time for the dashboard sidebar (card
// 1bf4f8a4, Peti's correction: a bare commit hash says nothing on its own, a real semver version
// is the point).
//
// Rule 10 (GitHub-first / don't reinvent, applies internally too): reuses readVersion() from
// public-digest.ts (package.json is already the single source of truth for the semver there) and
// dist/.built-commit -- the SAME build-marker update.sh/recovery-prev-version.sh stamp after a
// successful build (see update.sh's "Stamp the build-marker AFTER a successful build" comment) --
// for the commit hash and build time, rather than reading live git HEAD via update-checker.ts's
// currentGitHead(). HEAD can be AHEAD of what is actually running (a `git pull` without a
// rebuild+restart is exactly the stale-dist trap this fleet has hit before), so the marker
// answers "what commit is this PROCESS actually running", which is what the sidebar claims to
// show -- HEAD would silently lie the moment dist falls behind it.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../../config.js'
import { json } from '../http-helpers.js'
import { readVersion } from './public-digest.js'
import type { RouteContext } from './types.js'

const BUILT_COMMIT_FILE = join(PROJECT_ROOT, 'dist', '.built-commit')

export interface VersionInfo {
  readonly version: string
  /** Short (7-char) commit hash dist was built from, or null if the marker is absent (e.g. `npm
   *  run dev`, or a checkout that has never been built). */
  readonly commitHash: string | null
  /** ISO timestamp of the build-marker's mtime, or null alongside a null commitHash. */
  readonly buildTime: string | null
  /** True when dist/.built-commit ON DISK right now names a DIFFERENT commit than the one this
   *  process actually loaded at startup (card 165350f1) -- i.e. a landing rebuilt dist after this
   *  process started, so a restart would pick up a different build than the one answering this
   *  request. False (never null) when there is nothing to compare, including when neither marker
   *  has a commit at all. */
  readonly newerBuildOnDisk: boolean
}

interface BuiltCommitMarker {
  readonly commitHash: string | null
  readonly buildTime: string | null
}

function readBuiltCommitMarker(): BuiltCommitMarker {
  try {
    if (existsSync(BUILT_COMMIT_FILE)) {
      const full = readFileSync(BUILT_COMMIT_FILE, 'utf-8').trim()
      return {
        commitHash: full.length > 0 ? full.slice(0, 7) : null,
        buildTime: statSync(BUILT_COMMIT_FILE).mtime.toISOString(),
      }
    }
  } catch {
    // Fail-closed: an unreadable/missing marker degrades to nulls, never a 500 -- the version
    // number alone is still worth showing.
  }
  return { commitHash: null, buildTime: null }
}

/** Pure comparison, exported separately so the staleness logic is testable without touching the
 *  real filesystem (card 165350f1). */
export function hasNewerBuildOnDisk(running: BuiltCommitMarker, onDisk: BuiltCommitMarker): boolean {
  return running.commitHash !== null && onDisk.commitHash !== null && onDisk.commitHash !== running.commitHash
}

// Captured ONCE, at module load (i.e. process startup) -- version AND commit/build-time read
// TOGETHER, as one snapshot of what this process actually loaded. Before this fix, `version` came
// from readVersion()'s own cache (effectively frozen at first call) while commitHash/buildTime were
// re-read from disk on every request -- a landing that rebuilds dist without restarting the
// service made /api/version report a commit hash that never belonged to the running version string.
// Freezing both together here removes that mismatch by construction; readVersionInfo() below does
// a SEPARATE fresh read purely to detect (not to report as current) that disk has moved on.
const RUNNING_VERSION = readVersion()
const RUNNING_BUILT = readBuiltCommitMarker()

export function readVersionInfo(): VersionInfo {
  const onDisk = readBuiltCommitMarker()
  return {
    version: RUNNING_VERSION,
    commitHash: RUNNING_BUILT.commitHash,
    buildTime: RUNNING_BUILT.buildTime,
    newerBuildOnDisk: hasNewerBuildOnDisk(RUNNING_BUILT, onDisk),
  }
}

export async function tryHandleVersion(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path === '/api/version' && method === 'GET') {
    json(res, readVersionInfo())
    return true
  }
  return false
}

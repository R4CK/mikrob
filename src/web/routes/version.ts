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
}

export function readVersionInfo(): VersionInfo {
  let commitHash: string | null = null
  let buildTime: string | null = null
  try {
    if (existsSync(BUILT_COMMIT_FILE)) {
      const full = readFileSync(BUILT_COMMIT_FILE, 'utf-8').trim()
      commitHash = full.length > 0 ? full.slice(0, 7) : null
      buildTime = statSync(BUILT_COMMIT_FILE).mtime.toISOString()
    }
  } catch {
    // Fail-closed: an unreadable/missing marker degrades to nulls, never a 500 -- the version
    // number alone is still worth showing.
  }
  return { version: readVersion(), commitHash, buildTime }
}

export async function tryHandleVersion(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path === '/api/version' && method === 'GET') {
    json(res, readVersionInfo())
    return true
  }
  return false
}

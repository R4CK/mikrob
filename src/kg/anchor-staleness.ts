// MT-09 (card 9e2c33c2): landing-time staleness check (EK-MT-8). A landing that modifies the body
// an anchor points at should not leave the solution node silently claiming "this is still how it's
// done" -- the MODULTERV calls this out explicitly (section 9: land.completed -> MT-09 horgony
// ellenőrzés) and the state machine (section 5) draws the edge from 'active'/'fresh' to
// 'stale'/'drifted' through exactly this check.
//
// Deliberately thin: it does NOT re-locate a moved/renamed symbol, does not diff semantically, and
// does not try to tell "the symbol was reformatted" apart from "the symbol's logic changed" -- it
// hashes the exact anchored line range's text at the new sha and compares to the stored hash. A
// false 'drifted' (cosmetic-only change) costs a re-review of a solution node; a missed drift costs
// silently stale advice. The spec (EK-MT-8) only requires detecting "the body changed", not
// characterizing HOW -- a smarter diff is out of scope here and would be premature complexity for a
// card whose own MVP gate (EK-MT-5) has not run yet.
//
// Only marks, never deletes (section 9, "csak jelöl, sosem töröl") -- there is no DELETE anywhere
// in this file, by construction, not by discipline.

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getAnchorsForPath, setAnchorState, setNodeStatus, getNode, PROTECTED_STATUSES } from './store.js'

/** Injected port (injected-port-adapters skill): the real adapter shells out to `git show
 *  <sha>:<path>` scoped to the landed repo's directory; tests inject an in-memory fixture. Returns
 *  null when the path does not exist at that sha (deleted, or never existed) -- the one signal this
 *  module treats as 'gone' rather than attempting to hash. */
export type GitShowFn = (sha: string, path: string) => string | null

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** 1-indexed, inclusive line range, matching kg_anchors.line_start/line_end. No range (either
 *  bound null/undefined) means the anchor covers the whole file. */
export function extractAnchorRange(
  content: string,
  lineStart?: number | null,
  lineEnd?: number | null,
): string {
  if (lineStart == null || lineEnd == null) return content
  const lines = content.split('\n')
  return lines.slice(lineStart - 1, lineEnd).join('\n')
}

export interface LandingAnchorCheckInput {
  repo: string
  changedPaths: readonly string[]
  sha: string
  gitShow: GitShowFn
  actor: string
}

export interface LandingAnchorCheckReport {
  checked: number
  unchanged: number
  drifted: number
  gone: number
  nodesMarkedStale: number
}

/** Re-checks every anchor on a file the landing touched, classifying it fresh / drifted / gone
 *  (EK-MT-8) and, when it moved off 'fresh', pushing the owning node to 'stale' -- unless that node
 *  already sits in a terminal, deliberately-set status (archived/superseded), which this must not
 *  silently override (same protection upsertNode already gives those two statuses on re-import). */
export function checkLandingAnchors(
  db: Database.Database,
  input: LandingAnchorCheckInput,
): LandingAnchorCheckReport {
  const report: LandingAnchorCheckReport = {
    checked: 0,
    unchanged: 0,
    drifted: 0,
    gone: 0,
    nodesMarkedStale: 0,
  }
  const paths = new Set(input.changedPaths)
  for (const path of paths) {
    const anchors = getAnchorsForPath(db, input.repo, path)
    for (const anchor of anchors) {
      report.checked += 1
      const fileContent = input.gitShow(input.sha, path)

      let newState: 'fresh' | 'drifted' | 'gone'
      let newHash: string | null
      if (fileContent == null) {
        newState = 'gone'
        newHash = anchor.content_hash
      } else {
        const body = extractAnchorRange(fileContent, anchor.line_start, anchor.line_end)
        newHash = sha256Hex(body)
        // No prior hash (anchor created without one) establishes a baseline here rather than
        // claiming drift it has no evidence for.
        newState = anchor.content_hash == null || anchor.content_hash === newHash ? 'fresh' : 'drifted'
      }

      if (newState === 'gone') report.gone += 1
      else if (newState === 'drifted') report.drifted += 1
      else report.unchanged += 1

      if (newState !== anchor.state || newHash !== anchor.content_hash) {
        setAnchorState(db, anchor.id, newState, newHash, input.actor)
      }

      if (newState !== 'fresh') {
        const node = getNode(db, anchor.node_id) as { status: string } | undefined
        if (node && node.status !== 'stale' && !PROTECTED_STATUSES.has(node.status)) {
          setNodeStatus(db, anchor.node_id, 'stale', input.actor)
          report.nodesMarkedStale += 1
        }
      }
    }
  }
  return report
}

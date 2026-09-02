// Card 1f1e3ae4 (Fazis fe3eff9f): resolve the shas that kanban_relations already carries as
// `gate-sha` targets into the FILES those commits touched -- the hop the phase's headline question
// ("which cards touched file X") needs and card 6cd61430 deliberately left out.
//
// NEVER IMPORTED BY db.ts, AND THAT IS THE POINT. This module shells out to git, and one measured
// sweep of the CleanCore half takes 33 seconds (the /mnt/h drvfs mount, not git). A module the
// request path cannot reach cannot end up inside a comment write by accident; the separation is
// structural rather than a comment asking people to be careful. The sweep script imports both this
// and db.ts -- db.ts imports nothing from here.

import { execFileSync } from 'node:child_process'
import { PROJECT_ROOT } from './config.js'
import type { RelationEdge } from './kanban-relations.js'

/** The `source` tag every edge below is written under. Its own tag, separate from 'marker-v1':
 *  these edges are derived from GIT, not from card text, so they must reconcile (and be undone)
 *  independently of the marker extraction. */
export const GIT_SOURCE = 'git-v1'

/** Where a sha was found. `none` and `ambiguous` are explicit outcomes, not repo names -- see
 *  {@link resolveShaRepos}. */
export type ShaLocation = string

/** The repos a Gate-SHA can name, in the order they are probed.
 *
 *  CleanCore's path follows the fleet convention (CLAUDE.md): the MAIN clone via CLEANCORE_MAIN,
 *  never an agent worktree, which holds somebody's half-finished work. marveen resolves from
 *  PROJECT_ROOT so the sweep reads the checkout it was started in rather than a hard-coded path. */
export function defaultRepos(): { name: string; path: string }[] {
  return [
    { name: 'marveen', path: PROJECT_ROOT },
    {
      name: 'cleancore',
      path: process.env.CLEANCORE_MAIN || '/mnt/h/LM_Studio_Workdir/CleanCore',
    },
  ]
}

/** Marks a sha that was probed in every repo and found in none. An EXPLICIT value rather than an
 *  absent row: absence cannot be told apart from "this sha has never been swept", and the card asks
 *  for unresolvable shas to be MARKED. Not a valid repo name, and the relation type says what it
 *  is. Measured at 5 shas of 1069 (deleted branch, force-push, a rewritten history). */
export const UNRESOLVED = 'none'

/** Marks a sha that resolves in MORE THAN ONE repo, or that git itself calls ambiguous.
 *
 *  Zero cases today across the 1069 shas, and the design still refuses to assume it. A card was
 *  gated on ONE commit; recording the files of both candidates would assert changes the card never
 *  made. Fail closed: the sha is marked and gets no file edges, which is visible and fixable (state
 *  a longer sha) rather than silently wrong. */
export const AMBIGUOUS = 'ambiguous'

function git(repoPath: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    input,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    // Capture stderr instead of inheriting it. A probe against a repo that is not there is an
    // ORDINARY outcome here (the caller handles it), and inherited stderr would print git's fatal
    // line straight into whatever log the sweep runs under, making a handled case look like a crash.
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

export interface ShaResolution {
  /** The sha AS STATED on the Gate-SHA line. The `gate-sha` edges are keyed on this abbreviated
   *  form, so every edge here must be too or the card -> sha -> file join silently finds nothing.
   *  Measured: 569 marveen abbreviations collapse to 542 distinct commits. */
  readonly sha: string
  /** Repo name, or {@link UNRESOLVED} / {@link AMBIGUOUS}. */
  readonly location: ShaLocation
  /** Full object name, only when `location` is a real repo. The internal lookup key for the file
   *  listing -- never the edge key. */
  readonly full?: string
}

/**
 * Which repo each sha lives in, probed with ONE `git cat-file --batch-check` per repo.
 *
 * Batched because the per-sha form is 30x slower for no benefit: 1069 individual `git cat-file -e`
 * calls take 2.3s per repo, one batch-check takes 0.07s.
 *
 * A line that is not `<name> commit <size>` means "not here" -- including git's own `ambiguous`
 * answer for a too-short abbreviation, which is treated exactly like a multi-repo hit.
 */
export function resolveShaRepos(
  shas: readonly string[],
  repos = defaultRepos(),
): Map<string, ShaResolution> {
  const hits = new Map<string, { repo: string; full: string }[]>()
  for (const sha of shas) hits.set(sha, [])

  for (const repo of repos) {
    let out: string
    try {
      out = git(repo.path, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${shas.join('\n')}\n`)
    } catch {
      // A missing or unreadable repo must not take the whole sweep down: the other repo's shas are
      // still resolvable, and a sha that is only missing BECAUSE its repo was unreachable simply
      // reconciles back on the next run. Reported by the caller through the location counts.
      continue
    }
    const lines = out.split('\n')
    for (let i = 0; i < shas.length; i++) {
      const parts = (lines[i] || '').trim().split(/\s+/)
      if (parts.length >= 2 && parts[1] === 'commit') {
        hits.get(shas[i]!)!.push({ repo: repo.name, full: parts[0]! })
      }
    }
  }

  const out = new Map<string, ShaResolution>()
  for (const sha of shas) {
    const found = hits.get(sha)!
    if (found.length === 0) out.set(sha, { sha, location: UNRESOLVED })
    else if (found.length > 1) out.set(sha, { sha, location: AMBIGUOUS })
    else out.set(sha, { sha, location: found[0]!.repo, full: found[0]!.full })
  }
  return out
}

/** Framing marker for the batched `git show`. Chosen so it cannot collide with a path: git quotes
 *  and escapes unusual filenames, and no repo here has a file starting with this token. */
const COMMIT_MARK = '__KRC__ '

/**
 * Parse the output of the batched `git show --name-only -m --first-parent --format="__KRC__ %H"`.
 *
 * PURE, and separated from the git call on purpose: this framing is where the bugs live (blank
 * lines, a commit that appears twice because two abbreviations resolved to it, an empty listing),
 * and none of that needs a repository to test.
 */
export function parseNameOnlyBatch(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let current: string[] | undefined
  for (const raw of stdout.split('\n')) {
    if (raw.startsWith(COMMIT_MARK)) {
      const full = raw.slice(COMMIT_MARK.length).trim()
      // `git show A B` with A === B prints the commit once; two abbreviations of one commit must
      // therefore share, not overwrite, the listing.
      current = out.get(full)
      if (!current) {
        current = []
        out.set(full, current)
      }
      continue
    }
    const path = raw.trim()
    if (path && current && !current.includes(path)) current.push(path)
  }
  return out
}

/**
 * The files each commit touched, one `git show` per repo for every sha in it.
 *
 * `-m --first-parent` IS THE WHOLE CORRECTNESS OF THIS FUNCTION, and the dispatching card's own
 * suggestion ("git show --name-only") gets it wrong. On a MERGE commit, plain `git show` prints a
 * COMBINED diff, which for a clean merge is EMPTY -- measured on b44bd8e2: zero file lines, against
 * six from `git diff --name-only b44bd8e2^1 b44bd8e2`. marveen's Gate-SHAs are predominantly
 * marveen-land MERGE commits, so the naive form would have produced empty listings for most of the
 * marveen half and looked like a successful sweep. `-m` splits a merge into one diff per parent and
 * `--first-parent` keeps the branch side, which is the change the card actually landed.
 */
export function filesForCommits(repoPath: string, fullShas: readonly string[]): Map<string, string[]> {
  if (fullShas.length === 0) return new Map()
  const stdout = git(repoPath, [
    'show',
    '--name-only',
    '-m',
    '--first-parent',
    `--format=${COMMIT_MARK}%H`,
    ...fullShas,
  ])
  return parseNameOnlyBatch(stdout)
}

/** A path as it is stored in `to_id`: REPO-QUALIFIED.
 *
 *  Both repos have a `README.md`, a `package.json` and a `src/`. A bare path would fuse marveen and
 *  CleanCore cards under one "file" on exactly the query this whole layer exists to answer. */
export function qualifyPath(repo: string, path: string): string {
  return `${repo}:${path}`
}

export interface GitSweepResult {
  readonly edges: RelationEdge[]
  /** How many shas landed in each location -- repo names plus `none` / `ambiguous`. */
  readonly byLocation: Record<string, number>
}

/**
 * Every edge the git sweep states for `shas`: one `resolved-in` edge per sha (always, including the
 * unresolvable ones -- see {@link UNRESOLVED}) and one `touches-file` edge per file of a resolvable
 * one.
 *
 * Pure with respect to the database: it returns edges and the caller reconciles them, so the same
 * insert-and-delete mechanics that card 6cd61430 proved are reused rather than re-implemented.
 */
export function gitSweepEdges(shas: readonly string[], repos = defaultRepos()): GitSweepResult {
  const resolutions = resolveShaRepos(shas, repos)
  const edges: RelationEdge[] = []
  const byLocation: Record<string, number> = {}

  for (const r of resolutions.values()) {
    byLocation[r.location] = (byLocation[r.location] ?? 0) + 1
    edges.push({
      from_type: 'sha',
      from_id: r.sha,
      to_type: 'repo',
      to_id: r.location,
      relation_type: 'resolved-in',
    })
  }

  for (const repo of repos) {
    const inRepo = [...resolutions.values()].filter((r) => r.location === repo.name && r.full)
    if (inRepo.length === 0) continue
    const distinctFull = [...new Set(inRepo.map((r) => r.full!))]
    let listing: Map<string, string[]>
    try {
      listing = filesForCommits(repo.path, distinctFull)
    } catch {
      // Same posture as an unreachable repo above: skip this repo's file edges this run rather
      // than aborting the sweep. The reconcile is a full recompute, so the next run restores them.
      continue
    }
    for (const r of inRepo) {
      for (const path of listing.get(r.full!) ?? []) {
        edges.push({
          from_type: 'sha',
          from_id: r.sha,
          to_type: 'file',
          to_id: qualifyPath(repo.name, path),
          relation_type: 'touches-file',
        })
      }
    }
  }

  return { edges, byLocation }
}

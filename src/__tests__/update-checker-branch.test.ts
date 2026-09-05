// Regression test for the update checker's branch selection.
//
// The checker used to hardcode `main` while update.sh pulls
// `origin/<current branch>`. On any checkout that follows another branch
// (e.g. `develop`) the two disagreed: the dashboard advertised a "new version"
// the update button could never deliver, and stayed silent about the commits
// that actually were on the way. trackedBranch() is what keeps the two in sync,
// so it is pinned here.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  trackedBranch, currentVersion, getUpdateStatus,
  upstreamDefaultBranch, upstreamRepoConfig, UPSTREAM_BRANCH_FALLBACK,
} from '../web/update-checker.js'
import { PROJECT_ROOT } from '../config.js'

function gitBranch(): string {
  return execFileSync('/usr/bin/git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8',
  }).trim()
}

describe('update checker branch selection', () => {
  it('follows the branch the checkout is actually on', () => {
    const actual = gitBranch()
    // Detached HEAD reports the literal "HEAD"; the helper substitutes main
    // there, matching what update.sh tells the operator to check out.
    const expected = actual && actual !== 'HEAD' ? actual : 'main'
    expect(trackedBranch()).toBe(expected)
  })

  it('never returns an empty ref', () => {
    // An empty branch would produce `origin/` / `commits/` requests that fail
    // in confusing ways; the fallback must always yield a usable ref.
    expect(trackedBranch()).toBeTruthy()
  })

  it('does not silently assume main on a non-main checkout', () => {
    const actual = gitBranch()
    if (!actual || actual === 'HEAD' || actual === 'main') return // nothing to prove here
    expect(trackedBranch()).not.toBe('main')
  })
})

// The Updates panel shows the running instance's semver; it must come from
// package.json and never be fabricated. currentVersion() is the single source.
describe('update checker current version', () => {
  it('returns the semver from package.json at PROJECT_ROOT', () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'))
    expect(currentVersion()).toBe(pkg.version)
    // sanity: it is a real semver, not an empty/garbage value
    expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('is exposed on the /api/updates status object', () => {
    expect(getUpdateStatus().version).toBe(currentVersion())
  })

  it('returns empty (never fabricates) when package.json is missing/unreadable', () => {
    expect(currentVersion('/nonexistent-root-xyz')).toBe('')
    expect(currentVersion('/etc')).toBe('') // dir exists, no package.json -> ''
  })
})
// Card 1140a745. The upstream entry used to hardcode `main`, which is the same silent-blindness
// shape the update check itself exists to prevent: rename the upstream default branch and
// `commits/main` starts 404-ing, the marveen entry becomes a permanent error string, and the
// upstream-update banner goes quiet.
//
// Every case here injects its own fetch. The suite must never reach the network to prove this
// resolves -- a test that needs GitHub to be up measures the weather, not the code.
describe('upstream default branch resolution (card 1140a745)', () => {
  function fetchReturning(body: unknown, ok = true): typeof fetch {
    return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch
  }

  it('CONTROL: the fallback is a real value and the happy path differs from it', () => {
    // Without this the two cases below are indistinguishable: if the fixture branch happened to BE
    // the fallback, "resolved correctly" and "fell back" would look identical.
    expect(UPSTREAM_BRANCH_FALLBACK).toBe('main')
    expect('trunk').not.toBe(UPSTREAM_BRANCH_FALLBACK)
  })

  it('uses the branch the remote reports as its default', async () => {
    expect(await upstreamDefaultBranch(fetchReturning({ default_branch: 'trunk' }))).toBe('trunk')
  })

  it('asks the REPO endpoint, not a branch-specific one', async () => {
    // A lookup pointed at commits/<branch> would need the answer it is trying to find.
    let seen = ''
    const spy = (async (url: string) => {
      seen = String(url)
      return { ok: true, json: async () => ({ default_branch: 'trunk' }) }
    }) as unknown as typeof fetch
    await upstreamDefaultBranch(spy, 'Owner/Repo')
    expect(seen).toBe('https://api.github.com/repos/Owner/Repo')
  })

  it('falls back when the request is refused (rate limit, 404, anything non-ok)', async () => {
    expect(await upstreamDefaultBranch(fetchReturning({ default_branch: 'trunk' }, false)))
      .toBe(UPSTREAM_BRANCH_FALLBACK)
  })

  it('falls back when the call throws -- a network error must not break the whole refresh', async () => {
    const boom = (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
    expect(await upstreamDefaultBranch(boom)).toBe(UPSTREAM_BRANCH_FALLBACK)
  })

  it('falls back on an unusable answer, EMPTY STRING included', async () => {
    // '' is the one that would not look like a failure downstream: it builds `.../commits/`, a
    // different endpoint entirely, failing for a reason that looks nothing like its cause.
    for (const bad of [{}, { default_branch: null }, { default_branch: 7 }, { default_branch: '' }])
      expect(await upstreamDefaultBranch(fetchReturning(bad)), JSON.stringify(bad))
        .toBe(UPSTREAM_BRANCH_FALLBACK)
  })

  it('THE WIDER HALF: the tracking ref is derived from the SAME resolved branch, not a second literal', () => {
    // Fixing only `branch` would swap one silent blindness for another: mergeBaseWith() returns ''
    // for an absent local ref and computeStatus reads that as `behind = 0` with NO error, so a
    // renamed upstream default would report "up to date" against a ref that tracks nothing.
    const cfg = upstreamRepoConfig('trunk')
    expect(cfg.branch).toBe('trunk')
    expect(cfg.trackingRef).toBe('upstream/trunk')
    expect(cfg.remote).toBe('Szotasz/marveen')
  })
})

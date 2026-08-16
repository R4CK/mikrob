// Card 156c84d2: deploy-freshness-check.sh's freshness verdict compared a commit timestamp against
// `docker image inspect --format '{{.Created}}'`, which is the timestamp of the image's TOP layer --
// not "when did the last deploy run". If a rebuild's layers are byte-identical to a prior build
// (nothing touching that layer changed between commits), Docker reuses the cached layer AND its
// ORIGINAL Created time, even though a fresh `docker compose up -d --build` just ran. Measured on
// card af68e54d: the freshness alert reported both cleancore-web and cleancore-api built 2026-08-07,
// while the containers actually running (Up 39h) were from a 2026-08-12 redeploy -- no code affecting
// either image had changed in between, so the rebuild fully cache-hit both.
//
// Root-cause fix lives in CleanCore (apps/api/Dockerfile already had it via card 95c93fc6; this card
// extended it to apps/web/Dockerfile + infra/docker-compose.app.yml): both images now take a GIT_SHA
// build ARG that infra/deploy.sh sets to the CURRENT HEAD on every invocation, placed BEFORE their
// COPY layers, so a differing commit always invalidates the cache forward and `.Created` reflects the
// true build time again -- this script's own comparison logic needed no change for that part.
//
// This test covers the SEPARATE, in-repo change: the script now also reads the baked-in
// `org.opencontainers.image.revision` label directly and reports it in both the STALE and FRESH
// detail lines, so a human (or the next investigation) can answer "which commit is this, really"
// without SSHing in by hand -- belt-and-suspenders on top of the Dockerfile fix, not a replacement
// for it (the drift math is unchanged).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'deploy-freshness-check.sh')

function problems(text: string): string[] {
  const found: string[] = []
  if (!text.includes('image build epoch')) return ['this test is looking at the wrong file']
  if (!/image_revision\(\)\s*\{[^}]*org\.opencontainers\.image\.revision/.test(text)) {
    found.push('no image_revision() reader for the org.opencontainers.image.revision label')
  }
  if (!/WEB_REV=.*image_revision cleancore-web/.test(text)) {
    found.push('WEB_REV is not populated from image_revision on the web image')
  }
  if (!/API_REV=.*image_revision cleancore-api/.test(text)) {
    found.push('API_REV is not populated from image_revision on the api image')
  }
  // Both branches (STALE and FRESH) must surface the revision, or the label only helps half the time.
  const staleBlock = text.slice(text.indexOf('if (( stale == 1 ))'), text.indexOf('echo "FRESH"'))
  if (!staleBlock.includes('${WEB_REV}') || !staleBlock.includes('${API_REV}')) {
    found.push('the STALE detail lines do not include both revision labels')
  }
  const freshBlock = text.slice(text.indexOf('echo "FRESH"'))
  if (!freshBlock.includes('${WEB_REV}') || !freshBlock.includes('${API_REV}')) {
    found.push('the FRESH detail line does not include both revision labels')
  }
  return found
}

describe('deploy-freshness-check.sh reports the baked commit-revision label (card 156c84d2)', () => {
  const text = readFileSync(SCRIPT, 'utf-8')

  it('is syntactically valid bash', () => {
    const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)
  })

  it('reads and reports the revision label for both images, in both verdict branches', () => {
    expect(problems(text)).toEqual([])
  })

  it('CONTROL: removing the revision reader is caught', () => {
    const mutated = text.replace(
      /image_revision\(\) \{ \$SSH "docker image inspect \$1 --format '\{\{index \.Config\.Labels \\"org\.opencontainers\.image\.revision\\"\}\}'" 2>\/dev\/null; \}\n/,
      '',
    )
    expect(mutated, 'the mutation did not apply').not.toBe(text)
    expect(problems(mutated)).toContain('no image_revision() reader for the org.opencontainers.image.revision label')
  })

  it('CONTROL: dropping the revision label from only the FRESH line is caught', () => {
    const mutated = text.replace(
      'echo "detail: web image $((-web_drift))m ahead of last FE commit (revision label: ${WEB_REV}); api $((-api_drift))m ahead of last BE commit (revision label: ${API_REV})"',
      'echo "detail: web image $((-web_drift))m ahead of last FE commit; api $((-api_drift))m ahead of last BE commit"',
    )
    expect(mutated, 'the mutation did not apply').not.toBe(text)
    expect(problems(mutated)).toContain('the FRESH detail line does not include both revision labels')
  })
})

// Card 9d13747b: the shared clone's LOCAL $BRANCH ref is never advanced by a landing --
// cleancore-land.sh pushes straight to origin and never touches this checkout, so the local ref
// can sit days behind. commit_epoch() used to read `$BRANCH` (the stale local ref), which measured
// a false SMALL drift (57/61 minutes) while the real drift against origin/main was ~23 hours --
// understating staleness is the dangerous direction here (a FRESH false negative hides a real
// stale deploy from the heartbeat). Fixed by fetching origin/$BRANCH before reading it.
describe('deploy-freshness-check.sh reads origin/$BRANCH, not the stale local ref (card 9d13747b)', () => {
  const text = readFileSync(SCRIPT, 'utf-8')

  function driftProblems(t: string): string[] {
    const found: string[] = []
    if (!/git -C "\$REPO" fetch origin "\$BRANCH"/.test(t)) {
      found.push('no `git fetch origin "$BRANCH"` before the commit epoch is read')
    }
    const fetchIdx = t.indexOf('fetch origin')
    const commitEpochIdx = t.indexOf('commit_epoch()')
    if (fetchIdx === -1 || commitEpochIdx === -1 || fetchIdx > commitEpochIdx) {
      found.push('the fetch does not run BEFORE commit_epoch() is defined/used')
    }
    if (!/commit_epoch\(\) \{ git -C "\$REPO" log -1 --format=%ct "origin\/\$BRANCH"/.test(t)) {
      found.push('commit_epoch() reads "$BRANCH" (the stale local ref) instead of "origin/$BRANCH"')
    }
    return found
  }

  it('fetches origin/$BRANCH before measuring the commit epoch, and reads it from there', () => {
    expect(driftProblems(text)).toEqual([])
  })

  it('CONTROL: reverting to the bare local $BRANCH ref is caught', () => {
    const mutated = text
      .replace(/\n# The shared clone's LOCAL[\s\S]*?fetch origin "\$BRANCH" --quiet[^\n]*\n\n/, '\n')
      .replace(
        'commit_epoch() { git -C "$REPO" log -1 --format=%ct "origin/$BRANCH" -- "$@" 2>/dev/null; }',
        'commit_epoch() { git -C "$REPO" log -1 --format=%ct "$BRANCH" -- "$@" 2>/dev/null; }',
      )
    expect(mutated, 'the mutation did not apply').not.toBe(text)
    expect(driftProblems(mutated)).toContain(
      'commit_epoch() reads "$BRANCH" (the stale local ref) instead of "origin/$BRANCH"',
    )
  })
})

// The repomix wrapper's security guarantees are CONFIGURATION, so they rot silently (card b41c3dd3,
// Cybersec conditional GO cm#6194). Nothing in the type system stops someone from "simplifying" the
// flag checks away, and the failure is invisible: repomix keeps working, it just starts packing
// secrets. Cybersec's conditions 3 and 4 are the load-bearing ones, so they are pinned here.
//
// Source-level assertions on purpose: the realistic regression is an edit to the wrapper, not a
// runtime fault. Actually packing a repo would need a fixture tree and the pinned binary; grepping
// the script catches the omission directly and runs everywhere.
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const WRAPPER = readFileSync(join(REPO_ROOT, 'store/repomix.sh'), 'utf8')

/** The mute-scan command AS THE SCRIPT WRITES IT, lifted out of the source rather than retyped.
 *  Retyping it would test this file's copy of the command and stay green while the script's own
 *  went blind -- which is exactly the failure card ee01f7ce found. */
function muteScanCommand(): string {
  const m = WRAPPER.match(/MUTED=\$\((grep [^)]*)\)/)
  if (!m) throw new Error('the mute-scan grep is gone from store/repomix.sh')
  return m[1]!
}

/** Runs a grep invocation over a throwaway tree, with the script's `"$REPO"` bound to it. */
function scan(command: string, dir: string): { status: number; out: string } {
  try {
    const out = execFileSync('bash', ['-c', command.replace('"$REPO"', JSON.stringify(dir))], {
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    return { status: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string }
    return { status: err.status ?? -1, out: String(err.stdout ?? '') }
  }
}

describe('store/repomix.sh -- Cybersec conditions stay enforced (card b41c3dd3)', () => {
  it('condition 4: refuses --no-security-check so secretlint can never be switched off', () => {
    expect(WRAPPER).toContain('--no-security-check')
    // The flag must be REFUSED, not merely mentioned: a `die` on the same guard.
    const guard = WRAPPER.slice(WRAPPER.indexOf('--no-security-check'))
    expect(guard).toMatch(/die \d+ "REFUSED/)
  })

  it('condition 4: the alternate spellings are covered too (one-flag foot-gun)', () => {
    for (const spelling of ['--no-security', '--security-check=false']) {
      expect(WRAPPER).toContain(spelling)
    }
  })

  it('condition 6: refuses --remote (fetching a third-party repo is an adopt review)', () => {
    expect(WRAPPER).toContain('--remote')
    const guard = WRAPPER.slice(WRAPPER.indexOf('--remote'))
    expect(guard).toMatch(/die \d+ "REFUSED/)
  })

  it('condition 2: pins an exact repomix version, never floating latest', () => {
    const pin = WRAPPER.match(/PINNED_VERSION="([^"]+)"/)
    // The literal is deliberate, not brittleness: an UNREVIEWED bump must fail here, so every
    // version change is acknowledged by a human. Bumped 1.17.0 -> 1.18.0 with card 827330ce
    // (upstream security release; the ReDoS-hardened redaction also runs on the local pack path).
    expect(pin?.[1]).toBe('1.18.0')
    expect(WRAPPER).not.toContain('repomix@latest')
  })

  it('condition 3: documents the registry + --ignore-scripts install rule', () => {
    // `prepare` runs on a git-URL install, so the install METHOD is the control.
    expect(WRAPPER).toContain('--ignore-scripts')
  })

  it('condition 5: default output path is under the gitignored store/ tree', () => {
    const out = WRAPPER.match(/OUT_DIR_DEFAULT="([^"]+)"/)
    expect(out?.[1]).toContain('/store/')
  })

  // ── the mute scan must be able to SEE the file it judges (card ee01f7ce, Cybersec F3) ──────────
  //
  // The guard above pins that the refusal EXISTS. This pins that it can still look: a scan that
  // skips the file is indistinguishable from a clean repo, because both produce no output and rc=1.
  // Behavioural rather than source-level on purpose -- the whole finding was that the source READ
  // correctly (`grep -rIl ... secretlint-disable`) and did the wrong thing.

  it('a secretlint-disable marker is found even in a file that also contains a NUL byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repomix-nul-'))
    try {
      writeFileSync(join(dir, 'plain.txt'), 'nothing to see\n')
      // A NUL anywhere in the file is enough for grep to call it binary. One byte, at the end,
      // after a perfectly ordinary marker line.
      writeFileSync(join(dir, 'muted.txt'), 'secretlint-disable\nAKIAIOSFODNN7EXAMPLE\n\0')
      const { status, out } = scan(muteScanCommand(), dir)
      expect(status, 'the mute scan reported nothing -- it did not see the file').toBe(0)
      expect(out).toContain('muted.txt')
      expect(out, 'a clean file must not be reported').not.toContain('plain.txt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the fixture really is invisible to the old form -- so the test above is not vacuous', () => {
    // Without this, a fixture that any grep would find makes the assertion above pass for free. The
    // two forms differ ONLY in -I vs -a, and this is the measured difference card ee01f7ce is about.
    // It also documents the near-miss: `-aI` is still blind, because -a and -I set one setting and
    // the last one wins. Anyone "fixing" the script by appending -I re-opens the hole.
    const dir = mkdtempSync(join(tmpdir(), 'repomix-nul-neg-'))
    try {
      writeFileSync(join(dir, 'muted.txt'), 'secretlint-disable\nAKIAIOSFODNN7EXAMPLE\n\0')
      const blind = `grep -rIl --exclude-dir=.git -e 'secretlint-disable' "$REPO"`
      expect(
        scan(blind, dir).status,
        'the -I form found it -- this platform does not reproduce'
      ).toBe(1)
      const alsoBlind = `grep -raIl --exclude-dir=.git -e 'secretlint-disable' "$REPO"`
      expect(scan(alsoBlind, dir).status, '-aI is not a fix; -I wins as the later flag').toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('binary is the isolated pinned install, not a PATH lookup (no wrapper bypass)', () => {
    expect(WRAPPER).toContain('.npm-tools/bin/repomix')
    // A bare `repomix` call would resolve via PATH and skip every guard above.
    expect(WRAPPER).not.toMatch(/^\s*repomix\s/m)
  })
})

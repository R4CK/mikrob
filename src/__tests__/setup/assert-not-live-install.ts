// GLOBAL SUITE GATE: refuse to run the test suite inside a LIVE install.
//
// 2026-07-27, one full-suite run in the production checkout: settings-store.test.ts
// rmSync'd the live store/config-overrides.json (dropping MAIN_AGENT_ISOLATED_CONFIG
// and ultimately 401-ing the main agent that evening), env.test.ts unlink+rewrote the
// live .env (mode 600 -> 644), and the auth suites pushed real break-glass Telegram
// alerts to the owner. Tests must only ever run from a worktree/CI checkout whose
// store/ carries no runtime state.
//
// Detection is marker-based, not path-based: a live install is recognized by the
// runtime artifacts only a running fleet produces. A fresh clone or worktree has
// none of them, so CI and PR-verify flows are unaffected. This is a HARD failure
// on purpose -- a silent skip would hide that someone is one `npm test` away from
// mutating production state (loaded via vitest `setupFiles`, so it gates every
// worker; per-file guards cannot be forgotten this way).
//
// SELF-HEAL A MARKER NEWER THAN THIS RUN (card 5dcde7d3, MikroB decision). A stray marker left
// over from a PRIOR run is already self-healed elsewhere (fleet-test.sh, card f96717cf). This
// closes a DIFFERENT case: three independent, exhaustive instrumentation passes (per-call-site
// logging, a Node Module._load wrap of better-sqlite3's constructor, and an LD_PRELOAD libc
// interception of the entire open/rename/link family) each verified themselves against real,
// known-legitimate opens and each caught ZERO real opens of the live store/claudeclaw.db across
// several reliable reproductions of this exact refusal -- evidence the check cannot currently
// tell "a genuine pre-existing live install" from "something this run's OWN suite left behind
// mid-run through a path none of the three instruments could see". A marker whose mtime is AFTER
// this `vitest run` invocation started (per globalSetup's record-run-start.ts sentinel, written
// once in the main process before any worker starts) cannot be a pre-existing live install --
// deleted and the check retried once. A marker at or before the start, or with no sentinel to
// compare against (this file run outside the normal globalSetup wiring), keeps the original
// fail-closed behaviour untouched: refuse, loudly, exactly as before.
import { existsSync, statSync, unlinkSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sentinelPathFor } from './record-run-start.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const LIVE_MARKERS = [
  join('store', '.dashboard-token'),
  join('store', 'claudeclaw.db'),
  join('store', '.claude-oauth-token'),
]

// `root` is a parameter (not the module-level `repoRoot` constant) so a test can drive this
// against a throwaway directory instead of needing to fake this file's own on-disk location.
export function runStartedAtMs(root: string): number | null {
  try {
    const raw = readFileSync(sentinelPathFor(root), 'utf-8').trim()
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export function selfHealFreshMarkers(markers: string[], root: string): string[] {
  const runStart = runStartedAtMs(root)
  if (runStart === null) return markers // no sentinel: cannot judge freshness, change nothing
  const stillLive: string[] = []
  for (const m of markers) {
    const full = join(root, m)
    let mtimeMs: number
    try {
      mtimeMs = statSync(full).mtimeMs
    } catch {
      continue // vanished between the existsSync check and here; not live either way
    }
    if (mtimeMs > runStart) {
      try {
        unlinkSync(full)
        continue // healed: this marker no longer counts as "found"
      } catch {
        // could not remove it -- fall through and treat it as still live, fail-closed
      }
    }
    stillLive.push(m)
  }
  return stillLive
}

const found = selfHealFreshMarkers(LIVE_MARKERS.filter((m) => existsSync(join(repoRoot, m))), repoRoot)
if (found.length > 0) {
  // The remedy must NOT suggest /tmp (card 9070461f). It used to, and that sent every agent who hit
  // this message into the other trap: from a /tmp worktree the hook-registration guard correctly
  // refuses its own script paths, so 7 suites SKIP and the run silently measures less than it looks
  // like it does (see helpers/repo-location.ts -- a "14 failing tests" baseline was once tracked as
  // a defect when 13 were purely that artifact). store/fleet-test.sh manages one durable, non-/tmp
  // worktree and is the single supported way in.
  throw new Error(
    `REFUSING TO RUN TESTS: ${repoRoot} looks like a LIVE install (found: ${found.join(', ')}). ` +
      'The suite mutates files under the checkout it runs in (store/, .env, .claude/skills/). ' +
      // SUITERED807 (upstream) reached the same conclusion we did: the remedy must not send
      // people to /tmp, because our own hook-path guard (isUnsafeHookCommand) rejects a
      // /tmp-prefixed PROJECT_ROOT and 7 suites then go falsely red. Keeping OUR remedy --
      // `store/fleet-test.sh` is fork-specific and does more than a bare worktree: it reuses one
      // durable non-/tmp checkout, symlinks node_modules and refuses temp-dir targets -- and
      // adopting upstream's reasoning for why /tmp is the wrong answer.
      'Run it via `store/fleet-test.sh` (optionally with vitest paths/args), which reuses the ' +
      'fleet test worktree UNDER YOUR HOME. Do NOT use a /tmp worktree: the hook-registration ' +
      'guard rejects /tmp-rooted script paths, so 7 suites would skip and the gate tests would ' +
      'go falsely red there.',
  )
}

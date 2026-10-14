// TOKENVAK915: the main agent's own isolated config root (MAIN_AGENT_ISOLATED_CONFIG /
// MAIN_AGENT_CONFIG_DIR) was never searched by context-guard-runner.ts's and
// context-restart-gate-runner.ts's own local `configDirFor` copies -- both hardcoded `undefined`
// (the shared ~/.claude default) for the main agent unconditionally, so a session actually
// running isolated had its context/idle/restart-gate readers measuring the WRONG (empty or
// stale) directory. Flagged independently three times during the b5b7eb6b upstream-drift series
// (docs/token-usage.md, token-usage.ts, context-restart-gate-runner.ts), never carded until now.
//
// Same "blind spot" class, and the same fix, as the 2026-09-11 inbound-probe incident
// (mainConfigRoots()' own header): whether the main session writes under the shared ~/.claude or
// an isolated CLAUDE_CONFIG_DIR is decided by gates (settings, fleet token, dir existence) that a
// watchdog must not try to re-derive -- re-deriving them is exactly how the schedule-runner blind
// spot happened a second time. Probe every candidate root and let the freshest transcript answer
// the question, the same principle mainConfigRoots()/mainTranscriptDirs() already use for
// inbound-ingestion timestamps.
//
// This is the ONE shared place that knowledge lives for the two runners, so they can delegate to
// it instead of carrying their own, independently-drifting copies (card 25ea084c) -- mirroring
// upstream's own src/web/main-transcript-root.ts, adapted to this fork's isolation mechanism
// (MAIN_AGENT_ISOLATED_CONFIG/.channels-config/MAIN_AGENT_CONFIG_DIR) rather than upstream's own.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mainConfigRoots } from './inbound-probe.js'
import { readTranscriptMtimeFromProjectDir } from './active-model.js'

/**
 * The main agent's own config dir, chosen by freshest transcript mtime across every candidate
 * isolation root (`mainConfigRoots()`). Returns `undefined` when the shared ~/.claude root itself
 * is the freshest (or the only one with any transcript at all) -- same meaning `configDirFor`'s
 * existing callers already give `undefined`: "use the default root", not "no root found".
 */
export function mainAgentConfigDir(workingDir: string): string | undefined {
  const sharedRoot = join(homedir(), '.claude')
  let best: string | undefined
  let bestMtime = -1
  for (const root of mainConfigRoots()) {
    const configDir = root === sharedRoot ? undefined : root
    const mtime = readTranscriptMtimeFromProjectDir(workingDir, configDir)
    if (mtime !== null && mtime > bestMtime) {
      bestMtime = mtime
      best = configDir
    }
  }
  return best
}

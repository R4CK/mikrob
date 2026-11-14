// Gemini fallback DECISION logic (card 2a418584). Pure and dependency-free -- no clock, no network,
// no filesystem -- so every transition is unit-testable. The I/O (vault read, API call, Telegram
// notify) lives in the client (src/gemini-client.ts) and the runner.
//
// HOW THIS RELATES TO src/model-fallback.ts (important, and the reason this is a SEPARATE module):
// model-fallback.ts walks a chain of CLAUDE model ids (opus -> sonnet -> haiku) by rewriting the
// agent's model and respawning its Claude Code session. Gemini cannot be an entry in that chain --
// Claude Code cannot run a Gemini model, so writing "gemini-…" into the agent's model config would
// simply break the session. Gemini is therefore a DIFFERENT KIND of fallback: when the Claude chain
// is exhausted (bottom reached AND still limit-frozen), work is routed OUT to the Gemini API, the
// same shape as the existing local-LLM offload route -- not a Claude-Code model swap.
//
// The card's four requirements map onto the states below:
//   (1) key validation           -> `keyValid` fact (set from a REAL API call by the caller)
//   (2) Claude-freeze -> Gemini  -> 'engage'
//   (3) Telegram signal on switch-> the 'engage'/'revert' actions are the ONLY notify triggers
//   (4) auto-revert after reset  -> 'revert'

/** Route currently serving fleet work. */
export type FallbackRoute = 'claude' | 'gemini'

export interface GeminiFallbackFacts {
  /** Master toggle (config). When false, Gemini is never engaged. */
  enabled: boolean
  /** Did the last REAL key validation succeed? A key we cannot use must never be engaged. */
  keyValid: boolean
  /** Is the Claude chain exhausted -- i.e. limit-frozen at the BOTTOM model, nothing lower to try? */
  claudeExhausted: boolean
  /** Route currently in effect. */
  route: FallbackRoute
  /** When we switched to Gemini (ms epoch), or null when on Claude. */
  engagedAt: number | null
  /** Current time (ms epoch). */
  now: number
  /**
   * Minimum time on Gemini before we are willing to probe Claude again. Prevents flapping: without
   * it, a momentarily-clear banner would bounce the fleet back and forth across providers.
   */
  minEngagementMs: number
  /** True when Gemini itself is failing (quota/auth) -- we must not pretend it is serving. */
  geminiUnavailable?: boolean
}

export type GeminiFallbackAction =
  | { kind: 'none' }
  /** Switch fleet work to Gemini. Caller: notify Peti on Telegram. */
  | { kind: 'engage'; reason: 'claude_exhausted' }
  /** Switch back to Claude. Caller: notify Peti on Telegram. */
  | { kind: 'revert'; reason: 'claude_recovered' | 'gemini_unavailable' }

/**
 * Decide the route for the fleet.
 *
 * Fail-safe bias: every uncertain case resolves toward CLAUDE, never toward silently sitting on a
 * provider that cannot answer. Specifically:
 *   - disabled, or a key that failed real validation -> never engage (and revert if somehow engaged),
 *     because engaging on an unusable key would make the fleet deaf while *looking* covered;
 *   - Gemini failing while engaged -> revert immediately, even inside the anti-flap window: staying
 *     on a dead provider is strictly worse than probing Claude early;
 *   - Claude recovered -> revert, but only after the anti-flap window has elapsed.
 */
export function decideGeminiFallback(f: GeminiFallbackFacts): GeminiFallbackAction {
  const engaged = f.route === 'gemini'

  // Gemini is not usable (off, or the key did not validate) -> must not be the serving route.
  if (!f.enabled || !f.keyValid) {
    return engaged ? { kind: 'revert', reason: 'gemini_unavailable' } : { kind: 'none' }
  }

  if (engaged) {
    // Sitting on a provider that is itself erroring helps nobody -- go back and let Claude's own
    // limit handling take over. Deliberately NOT gated by the anti-flap window.
    if (f.geminiUnavailable) return { kind: 'revert', reason: 'gemini_unavailable' }
    // Claude's window has reset -> climb back, once we have been here long enough not to flap.
    if (!f.claudeExhausted) {
      const heldLongEnough = f.engagedAt === null || f.now - f.engagedAt >= f.minEngagementMs
      if (heldLongEnough) return { kind: 'revert', reason: 'claude_recovered' }
    }
    return { kind: 'none' }
  }

  // On Claude: engage only when the chain is genuinely exhausted AND Gemini can actually answer.
  if (f.claudeExhausted && !f.geminiUnavailable) {
    return { kind: 'engage', reason: 'claude_exhausted' }
  }
  return { kind: 'none' }
}

/**
 * The Telegram text for a route switch (card requirement 3). Hungarian, since it goes to Peti.
 * Deliberately carries NO key, NO prompt and NO model output -- only the routing fact.
 */
export function switchNotification(action: GeminiFallbackAction, model: string): string | null {
  if (action.kind === 'engage') {
    return (
      `⚠️ Claude kvota elfogyott (a teljes model-lanc limitelt) -- atkapcsoltam GEMINI-re (${model}). ` +
      `A flotta tovabb dolgozik, de a Gemini-kimenet DRAFT: a gate ugyanugy visszaellenorzi. ` +
      `A kvota-reset utan automatikusan visszaallok Claude-ra.`
    )
  }
  if (action.kind === 'revert') {
    return action.reason === 'claude_recovered'
      ? `✅ Claude kvota visszaallt -- visszakapcsoltam Claude-ra (a Gemini-fallback kikapcsolva).`
      : `⚠️ A Gemini-fallback NEM elerheto (kvota vagy kulcs-hiba) -- visszakapcsoltam Claude-ra. ` +
          `Ha a Claude is limitelt, a flotta a resetig varakozik.`
  }
  return null
}

// SWITCHBACK-HYSTERESIS-V1 (card 7f112c2f): the same switch-back confirmation rule
// store/quota-bridge.py's confirm_switchback() applies (grep SWITCHBACK-HYSTERESIS-V1 to see both
// sides), read from the same store/switchback-hysteresis.json. WHY: this runner's existing
// MIN_ENGAGEMENT_MS anti-flap (gemini-fallback-runner.ts) only measures time-since-engaged, not
// how the underlying signal (claudeExhausted) behaved across recent runs -- a single run where it
// happens to read false is enough to revert once the window has elapsed, with no requirement that
// the signal stayed clear. This rule adds that requirement on top: revert only once `confirmProbes`
// consecutive runs recorded `ok: true` (claudeExhausted === false), with the oldest and newest of
// that trailing run at least `minGapSec` apart.
export interface SwitchbackProbe {
  ok: boolean
  ts: number
}

/** Pure mirror of store/quota-switchback.py's confirm_switchback(). Any behavioural change to one
 * must be made to the other -- see that module's docstring for the exact semantics. */
export function confirmSwitchback(
  probeLog: readonly SwitchbackProbe[],
  confirmProbes: number,
  minGapSec: number,
): boolean {
  if (confirmProbes < 1) return false
  const run: SwitchbackProbe[] = []
  for (let i = probeLog.length - 1; i >= 0; i--) {
    const entry = probeLog[i]
    if (!entry.ok) break
    run.push(entry)
  }
  if (run.length < confirmProbes) return false
  const newestTs = run[0].ts
  const oldestTs = run[confirmProbes - 1].ts
  return newestTs - oldestTs >= minGapSec * 1000
}

/** Appends one probe result and trims to maxLen, mirroring store/quota-switchback.py's
 * record_probe(). Returns a NEW array (no mutation). */
export function recordProbe(
  probeLog: readonly SwitchbackProbe[],
  ok: boolean,
  ts: number,
  maxLen = 20,
): SwitchbackProbe[] {
  const next = [...probeLog, { ok, ts }]
  return next.slice(-maxLen)
}

/** Reads store/switchback-hysteresis.json. Missing/corrupt -> the documented defaults (2
 * confirmProbes, 300s minGapSec), mirroring quota_switchback.load_hysteresis_config()'s fail
 * direction: toward the hysteresis rule's own defaults, not toward disabling it. */
export function loadHysteresisConfigSync(
  readFile: (path: string) => string,
  path: string,
): { confirmProbes: number; minGapSec: number } {
  try {
    const raw = JSON.parse(readFile(path)) as Record<string, unknown>
    const confirmProbes = typeof raw.confirmProbes === 'number' ? raw.confirmProbes : 2
    const minGapSec = typeof raw.minGapSec === 'number' ? raw.minGapSec : 300
    if (confirmProbes < 1 || minGapSec < 0) throw new Error('out of range')
    return { confirmProbes, minGapSec }
  } catch {
    return { confirmProbes: 2, minGapSec: 300 }
  }
}

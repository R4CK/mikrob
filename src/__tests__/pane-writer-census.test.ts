import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

// Card 1d421873. The in-process pane-writer census, DERIVED from the source instead of typed out.
//
// WHY DERIVED. session-send-lock.ts's header is the only place a reader learns the pane is NOT
// fully serialized, and it had gone stale in the dangerous direction: it listed four writers as
// unguarded that had since been brought under the lane, while acknowledged-conflicts.ts asserted
// the same thing about scheduleIdentitySetup one day after the fix landed. A security review was
// dispatched from those sentences and went looking for a defect that was no longer there. Both
// lists were hand-kept, and a hand-kept list of "who writes to the pane" rots every time someone
// adds a writer or fixes one -- silently, because nothing reads it back.
//
// So this file does not restate the census. It COMPUTES it and pins the CLASSIFICATION:
//   - a file that starts writing to a pane and is not in the table fails here, by name;
//   - a file whose write shape changes (control keys -> text) fails here;
//   - a file that writes TEXT and loses its lane coverage fails here.
// Adding a pane writer therefore costs one deliberate line in EXPECTED with a reason, which is the
// point: the classification is the judgement, the list is not.
//
// WHAT THIS DOES AND DOES NOT PROVE. Lane coverage is measured PER FILE (does this module acquire
// the lane at all), not per call site -- a static test cannot follow a helper through its callers.
// It catches a writer added with no lock anywhere in its module, which is how every incident in
// this class actually arrived; it does not prove a given call site sits inside the held span. Said
// out loud so nobody reads a green run as "the pane is fully serialized" -- the exact overstatement
// session-send-lock.ts's own header warns against.

const SRC = join(REPO_ROOT, 'src')
/** tmux key names that cannot carry a message into an input frame. */
const CONTROL_KEYS = new Set(['Escape', 'Enter', 'Up', 'Down', 'Tab', 'C-c', 'C-u', 'BSpace', 'Space'])

interface Census {
  /** send-keys sites whose payload can put TEXT on the pane (a literal `-l`, or a command word). */
  readonly textSites: number
  /** send-keys sites that only press control keys -- they can interrupt, but cannot splice text. */
  readonly ctrlOnlySites: number
  /** does the module take the per-pane send lane anywhere? */
  readonly lane: boolean
}

/** Every pane-writing module under src/, with its measured shape. Comments are stripped first:
 *  a documented example of a send-keys call must never count as a writer (kódminőségi elv 12). */
function measure(): Map<string, Census> {
  const out = new Map<string, Census>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) {
        if (entry !== '__tests__') walk(p)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      const raw = readFileSync(p, 'utf-8')
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/\/\/.*/, ''))
        .join('\n')
      const sites = code.match(/\[\s*'send-keys'[^\]]*\]/g)
      if (!sites) continue
      let textSites = 0
      let ctrlOnlySites = 0
      for (const site of sites) {
        const args = [...site.matchAll(/'([^']*)'/g)]
          .map((m) => m[1]!)
          .slice(1)
          .filter((a) => a !== '-t' && a !== '--')
        const carriesText = args.includes('-l') || args.some((a) => !CONTROL_KEYS.has(a) && !a.startsWith('-'))
        if (carriesText) textSites++
        else ctrlOnlySites++
      }
      out.set(p.slice(SRC.length + 1).replaceAll('\\', '/'), {
        textSites,
        ctrlOnlySites,
        // THE IMPORT IS NOT THE USE. The first version of this line matched the whole file, so it
        // matched the `import { tryAcquireSessionSendLane }` statement too -- and a mutant that
        // deleted the actual acquire while leaving the import behind passed cleanly. Measured, not
        // reasoned: M1 survived until this line dropped import statements first.
        lane: /(tryAcquireSessionSendLane|withSessionSendLock)\s*\(/.test(
          code.split('\n').filter((l) => !/^\s*import\b/.test(l)).join('\n'),
        ),
      })
    }
  }
  walk(SRC)
  return out
}

/** The pinned classification. `lane: false` needs a reason that survives a security review. */
const EXPECTED: Record<string, Census & { why: string }> = {
  'web/agent-process.ts': {
    textSites: 5, ctrlOnlySites: 14, lane: true,
    why: 'the delivery path itself, plus scheduleIdentitySetup /rename (IDENTLANE910) and the modal answers',
  },
  'web/agent-worker.ts': {
    textSites: 1, ctrlOnlySites: 2, lane: true,
    why: "the worker's /clear, run inside withSessionSendLock via clearWorkerContext",
  },
  'web/channel-mcp-reconnect.ts': {
    textSites: 1, ctrlOnlySites: 7, lane: true,
    why: '/mcp plus menu navigation, all inside the lane span of attemptChannelMcpReconnect',
  },
  'web/channel-monitor.ts': {
    textSites: 0, ctrlOnlySites: 3, lane: true,
    why: 'recover-mode Enter presses only; the clear+re-inject span takes the lock',
  },
  'web/channel-plugin-unlock.ts': {
    textSites: 1, ctrlOnlySites: 7, lane: true,
    why: '/mcp plus menu navigation, inside runUnlockProbe’s lane span',
  },
  'web/context-restart-gate-runner.ts': {
    textSites: 1, ctrlOnlySites: 1, lane: true,
    why: 'the restart-gate /clear',
  },
  'web/tmux-keys.ts': {
    textSites: 1, ctrlOnlySites: 1, lane: false,
    why: 'NOT A WRITER: it only BUILDS the argv arrays its callers pass to tmux, so it has nothing to serialize',
  },
}

describe('in-process pane writers (card 1d421873)', () => {
  const actual = measure()

  it('discovery works at all -- it finds the writer this card is about', () => {
    // The control. A regex that matched nothing would make every assertion below vacuously true,
    // and this file would report a clean pane-writer census for a tree full of writers.
    expect(actual.size).toBeGreaterThan(3)
    expect(actual.has('web/agent-process.ts')).toBe(true)
    expect(actual.get('web/agent-process.ts')!.textSites).toBeGreaterThan(0)
  })

  it('every pane-writing module is classified -- a new one fails here by name', () => {
    const unclassified = [...actual.keys()].filter((f) => !(f in EXPECTED))
    expect(
      unclassified,
      `new pane writer(s) with no entry in EXPECTED: ${unclassified.join(', ')}. ` +
        'Classify it: does it write TEXT, and does its module take the send lane? ' +
        'See session-send-lock.ts for why this matters.',
    ).toEqual([])
  })

  it('a classified module that stopped writing must be removed from the table, not left to rot', () => {
    const gone = Object.keys(EXPECTED).filter((f) => !actual.has(f))
    expect(gone, `EXPECTED names files that no longer write to a pane: ${gone.join(', ')}`).toEqual([])
  })

  it('the measured shape matches the pinned classification', () => {
    for (const [file, exp] of Object.entries(EXPECTED)) {
      const got = actual.get(file)!
      expect({ file, ...got }).toEqual({
        file,
        textSites: exp.textSites,
        ctrlOnlySites: exp.ctrlOnlySites,
        lane: exp.lane,
      })
    }
  })

  it('anything that can put TEXT on a pane takes the lane, unless its entry says why not', () => {
    // THE SECURITY ASSERTION. Control keys can interrupt a delivery; only text can land INSIDE
    // someone else's frame, which is the prompt-injection shape this whole lock exists for.
    const offenders = [...actual.entries()]
      .filter(([f, c]) => c.textSites > 0 && !c.lane && !EXPECTED[f]?.why.startsWith('NOT A WRITER'))
      .map(([f]) => f)
    expect(
      offenders,
      `text-capable pane writer(s) with no send-lane acquisition: ${offenders.join(', ')}`,
    ).toEqual([])
  })
})

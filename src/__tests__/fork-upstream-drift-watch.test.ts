// Card a1ce8952 (parent 1f276349, step 3): the scheduled watcher must open a card OR update the
// existing one, never produce a fresh identical card per run.
//
// Everything interesting about this watcher is a branch that must NOT act, so every case here is
// offline: decideDriftAction takes the drift result, the open cards and the previous fingerprint as
// arguments, and this file never touches the dashboard. The shell wiring on top is pinned
// separately by store/fork-upstream-drift-watch.selftest.sh, because a decision nobody calls is a
// decision nobody makes.
import { describe, it, expect } from 'vitest'
import type { DriftResult } from '../fork-upstream/drift-check.js'
import {
  CLEAN_FINGERPRINT,
  DRIFT_CARD_MARKER,
  decideDriftAction,
  driftFingerprint,
  findDriftCard,
  isDriftCardTitle,
  summarizeDrift,
  type OpenCard,
} from '../fork-upstream/drift-watch.js'

function result(over: Partial<DriftResult> = {}): DriftResult {
  return { reachable: true, guarded: [], unwatched: [], stale: [], hunks: {}, ...over }
}

const STALE_TWO = result({
  stale: [
    { file: 'web/app.js', recorded: 'aaaaaaaaaaaa1111', actual: 'bbbbbbbbbbbb2222', rule: 'union of both tails' },
    { file: 'src/db.ts', recorded: 'cccccccccccc3333', actual: 'dddddddddddd4444', rule: 'comment-only collision' },
  ],
})

const OPEN_CARD: OpenCard = {
  id: 'card0001',
  title: `${DRIFT_CARD_MARKER}[marveen][INFRA][SEC] upstream-drift: 2 fájl újra-döntést vár`,
  createdAt: 100,
}

describe('the drift card is identified by an ANCHORED marker, not by mentioning it', () => {
  it('matches the marker at the start of the title', () => {
    expect(isDriftCardTitle(`${DRIFT_CARD_MARKER} valami`)).toBe(true)
  })

  it('matches through the [NN%] progress prefix rule 2 puts in front of every worked card', () => {
    expect(isDriftCardTitle(`[40%]${DRIFT_CARD_MARKER} valami`)).toBe(true)
    expect(isDriftCardTitle(`[100%] ${DRIFT_CARD_MARKER} valami`)).toBe(true)
  })

  it('THE DECOY: a card that merely MENTIONS the marker is not the drift card', () => {
    // The card that asked for this watcher, and any future card about it, will quote the marker.
    // A substring match would make the watcher comment on that card forever instead of on the
    // drift, and the real drift would never get a card at all.
    const decoy = `[marveen][INFRA] ütemezett figyelő, ami ${DRIFT_CARD_MARKER} kártyát nyit vagy frissít`
    expect(isDriftCardTitle(decoy)).toBe(false)
    expect(findDriftCard([{ id: 'decoy', title: decoy }])).toBeNull()
  })

  it('picks the OLDEST when a board somehow carries two, so the choice is not row order', () => {
    const newer: OpenCard = { id: 'newer', title: `${DRIFT_CARD_MARKER} b`, createdAt: 200 }
    const older: OpenCard = { id: 'older', title: `${DRIFT_CARD_MARKER} a`, createdAt: 100 }
    expect(findDriftCard([newer, older])?.id).toBe('older')
    expect(findDriftCard([older, newer])?.id).toBe('older')
  })
})

describe('the fingerprint turns on the FILE SET, not on upstream churn', () => {
  it('does NOT change when only the upstream blob shas move', () => {
    // upstream/develop moves most days. A fingerprint over the shas would post a comment every
    // morning while the actionable fact -- which files nobody has re-decided -- was identical.
    const churned = result({
      stale: STALE_TWO.stale.map((s) => ({ ...s, actual: `${s.actual}-moved` })),
    })
    expect(driftFingerprint(churned)).toBe(driftFingerprint(STALE_TWO))
  })

  it('DOES change when a file joins or leaves the set', () => {
    const grown = result({
      stale: [...STALE_TWO.stale, { file: 'web/style.css', recorded: 'e1', actual: 'e2', rule: 'union' }],
    })
    expect(driftFingerprint(grown)).not.toBe(driftFingerprint(STALE_TWO))
  })

  it('does not confuse a file that moved from stale to unwatched with one that did not move', () => {
    const moved = result({ unwatched: ['web/app.js'], stale: [STALE_TWO.stale[1]!] })
    expect(driftFingerprint(moved)).not.toBe(driftFingerprint(STALE_TWO))
  })

  it('is order-independent, so a git listing order change is not a new drift', () => {
    const reversed = result({ stale: [...STALE_TWO.stale].reverse() })
    expect(driftFingerprint(reversed)).toBe(driftFingerprint(STALE_TWO))
  })
})

describe('an unreachable upstream says nothing and REMEMBERS nothing', () => {
  const unreachable = result({ reachable: false })

  it('never opens a card for an environment fact', () => {
    const a = decideDriftAction(unreachable, [], null)
    expect(a.kind).toBe('silent')
    expect(a.kind === 'silent' && a.reason).toBe('upstream-unreachable')
  })

  it('does not overwrite the state, so a network blip cannot erase what was already reported', () => {
    // If a blip wrote its own fingerprint, the next reachable run would see "changed" and repeat a
    // report the board already carries.
    const a = decideDriftAction(unreachable, [OPEN_CARD], 'previous-fingerprint')
    expect(a.fingerprint).toBeNull()
  })
})

describe('drift: open once, then update the same card', () => {
  it('opens a card when there is none and nothing was ever reported', () => {
    const a = decideDriftAction(STALE_TWO, [], null)
    expect(a.kind).toBe('open')
    if (a.kind !== 'open') throw new Error('unreachable')
    expect(a.title.startsWith(DRIFT_CARD_MARKER)).toBe(true)
    expect(a.description).toContain('web/app.js')
    expect(a.fingerprint).toBe(driftFingerprint(STALE_TWO))
  })

  it('THE POINT OF THE CARD: an unchanged drift with the card open produces NO new card and NO comment', () => {
    const a = decideDriftAction(STALE_TWO, [OPEN_CARD], driftFingerprint(STALE_TWO))
    expect(a.kind).toBe('silent')
    expect(a.kind === 'silent' && a.reason).toBe('unchanged')
  })

  it('comments on the EXISTING card when the drift set changed, instead of opening a second one', () => {
    const a = decideDriftAction(STALE_TWO, [OPEN_CARD], 'a-different-fingerprint')
    expect(a.kind).toBe('comment')
    expect(a.kind === 'comment' && a.cardId).toBe(OPEN_CARD.id)
  })

  it('does not reopen a card a human closed while the drift stood still', () => {
    // Closing the card is an answer. Opening a replacement every morning is the same duplication
    // as opening a fresh card every morning, one human action later.
    const a = decideDriftAction(STALE_TWO, [], driftFingerprint(STALE_TWO))
    expect(a.kind).toBe('silent')
    expect(a.kind === 'silent' && a.reason).toBe('closed-and-unchanged')
  })

  it('DOES open again once the world actually moves after such a close', () => {
    const grown = result({
      stale: [...STALE_TWO.stale, { file: 'web/style.css', recorded: 'e1', actual: 'e2', rule: 'union' }],
    })
    expect(decideDriftAction(grown, [], driftFingerprint(STALE_TWO)).kind).toBe('open')
  })

  it('opens rather than staying silent when the state was lost, even with the card closed', () => {
    expect(decideDriftAction(STALE_TWO, [], null).kind).toBe('open')
  })
})

describe('clean: report the resolution once, and never close the card by machine', () => {
  const clean = result()

  it('comments on the open card the first time the drift is gone', () => {
    const a = decideDriftAction(clean, [OPEN_CARD], driftFingerprint(STALE_TWO))
    expect(a.kind).toBe('comment')
    expect(a.kind === 'comment' && a.content).toContain('MEGSZŰNT')
    expect(a.fingerprint).toBe(CLEAN_FINGERPRINT)
  })

  it('says it once, not every morning', () => {
    const a = decideDriftAction(clean, [OPEN_CARD], CLEAN_FINGERPRINT)
    expect(a.kind).toBe('silent')
    expect(a.kind === 'silent' && a.reason).toBe('clean-already-reported')
  })

  it('stays silent when nothing is open and nothing is wrong', () => {
    const a = decideDriftAction(clean, [], null)
    expect(a.kind).toBe('silent')
    expect(a.kind === 'silent' && a.reason).toBe('clean')
  })
})

describe('the card body carries the shape, not the 19KB of accumulated rule prose', () => {
  it('names every affected file with both blob sides', () => {
    const body = summarizeDrift(STALE_TWO)
    for (const s of STALE_TWO.stale) {
      expect(body).toContain(s.file)
      expect(body).toContain(s.recorded.slice(0, 12))
      expect(body).toContain(s.actual.slice(0, 12))
    }
  })

  it('separates the three severities instead of reporting one number', () => {
    const mixed = result({ guarded: ['web/app.js'], unwatched: ['src/db.ts'], stale: STALE_TWO.stale })
    const body = summarizeDrift(mixed)
    expect(body).toContain('FORK-OWNED FÁJLOK')
    expect(body).toContain('SENKI NEM DÖNTÖTTE EL')
    expect(body).toContain('AZ ELISMERÉS MÁR NEM AZT ÍRJA LE')
  })

  it('stays bounded when the drift is large, and SAYS it was truncated', () => {
    const many = result({
      stale: Array.from({ length: 400 }, (_, i) => ({
        file: `src/generated/file-${i}.ts`,
        recorded: 'a'.repeat(40),
        actual: 'b'.repeat(40),
        rule: 'x'.repeat(200),
      })),
    })
    const body = summarizeDrift(many)
    expect(body.length).toBeLessThan(4200)
    expect(body).toContain('levágva')
  })

  it('points at the command that produces the full report', () => {
    expect(summarizeDrift(STALE_TWO)).toContain('fork-upstream-drift-watch.mjs --report')
  })
})

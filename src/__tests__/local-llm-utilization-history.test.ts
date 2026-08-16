// Rolling utilization history + its sampler (card b6b1493d, child of cf61fcac).
//
// The three properties that would rot silently, and why each is here:
//
// 1. A MISSING GPU READING IS null, NEVER 0. A zero draws a flat line at the bottom of the waveform,
//    which reads as "the GPU is idle" -- a claim nobody measured. This is the same rule the GPU
//    detector states about never inventing a number, one layer up, and the reason the sample type
//    allows null at all.
// 2. THE SAMPLER MUST NOT OUTGROW WHAT IT MEASURES. gpuInfo() shells out to nvidia-smi and tries
//    three candidate paths at 5s each, so on a GPU-less host ONE sample can take 15 seconds against
//    a 3-second interval. Without the overlap guard the ticks pile up; without the backoff the host
//    pays 15s per tick forever to be told the same thing.
// 3. A MONITOR MUST NOT BE ABLE TO KILL WHAT IT WATCHES. A reader that throws must produce a sample
//    or no sample, never an exception into a timer callback.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createUtilizationSampler,
  getUtilizationSamples,
  recordUtilizationSample,
  resetUtilizationHistory,
  MAX_SAMPLES,
  WINDOW_MS,
  type UtilizationSample,
} from '../web/local-llm-utilization-history.js'

const GPU = { util_pct: 42, mem_used_mb: 3000, mem_total_mb: 6000 }

function sample(ts: number, over: Partial<UtilizationSample> = {}): UtilizationSample {
  return { ts, util_pct: 10, mem_used_mb: 1, mem_total_mb: 2, active_tasks: 0, ...over }
}

beforeEach(() => resetUtilizationHistory())

describe('the rolling window', () => {
  it('keeps samples in order and hands back a COPY (a reader cannot corrupt the buffer)', () => {
    recordUtilizationSample(sample(1000))
    recordUtilizationSample(sample(2000))
    const first = getUtilizationSamples(2000)
    expect(first.map((s) => s.ts)).toEqual([1000, 2000])
    first.push(sample(9999))
    expect(getUtilizationSamples(2000)).toHaveLength(2) // the push did not reach the buffer
  })

  it('drops samples older than the window', () => {
    recordUtilizationSample(sample(1000))
    recordUtilizationSample(sample(2000))
    // "now" is far enough ahead that only the second sample is still inside the window.
    const kept = getUtilizationSamples(2000 + WINDOW_MS - 1)
    expect(kept.map((s) => s.ts)).toEqual([2000])
  })

  it('enforces the hard count cap even if every sample is inside the window', () => {
    // The age cap is the intended limit; this one is the limit that cannot be misconfigured by
    // shortening the interval, so it needs its own control.
    for (let i = 0; i < MAX_SAMPLES + 50; i++) recordUtilizationSample(sample(10_000 + i))
    const kept = getUtilizationSamples(10_000 + MAX_SAMPLES + 50)
    expect(kept.length).toBeLessThanOrEqual(MAX_SAMPLES)
    expect(kept[kept.length - 1]!.ts).toBe(10_000 + MAX_SAMPLES + 49) // the NEWEST survived
  })

  it('an empty window is a normal answer, not an error (the first seconds after a restart)', () => {
    expect(getUtilizationSamples(123)).toEqual([])
  })
})

describe('the sampler', () => {
  it('records the GPU reading and the running-task count together', async () => {
    const s = createUtilizationSampler({
      readGpu: async () => GPU,
      readActiveTasks: () => 3,
      now: () => 5000,
    })
    expect(await s.tick()).toEqual({
      ts: 5000,
      util_pct: 42,
      mem_used_mb: 3000,
      mem_total_mb: 6000,
      active_tasks: 3,
    })
  })

  it('a failed GPU read is null, NOT zero -- a flat line at the bottom is a claim of its own', async () => {
    const s = createUtilizationSampler({
      readGpu: async () => null,
      readActiveTasks: () => 2,
      now: () => 5000,
    })
    const got = await s.tick()
    expect(got?.util_pct).toBeNull()
    expect(got?.mem_used_mb).toBeNull()
    expect(got?.mem_total_mb).toBeNull()
    // ...and the half that WAS measured still lands: a machine with no GPU still has a queue.
    expect(got?.active_tasks).toBe(2)
  })

  it('OVERLAP GUARD: a tick that starts while the previous is still probing does nothing', async () => {
    // The real failure this prevents: nvidia-smi takes 15s on a GPU-less host against a 3s
    // interval, so five ticks would be in flight at once and the backlog would grow forever.
    let release = (): void => {}
    let calls = 0
    const s = createUtilizationSampler({
      readGpu: async () => {
        calls += 1
        await new Promise<void>((r) => {
          release = r
        })
        return GPU
      },
      readActiveTasks: () => 0,
      now: () => 1,
    })
    const slow = s.tick()
    const declined = await s.tick() // second tick while the first is stuck in readGpu
    expect(declined, 'the overlapping tick must decline, not queue').toBeNull()
    expect(calls, 'and it must not have probed the GPU a second time').toBe(1)

    release()
    await slow
    expect(getUtilizationSamples(1)).toHaveLength(1) // exactly one sample, not two
  })

  it('BACKOFF: after repeated failures the GPU probe is skipped, and retried later', async () => {
    let probes = 0
    const s = createUtilizationSampler({
      readGpu: async () => {
        probes += 1
        return null // no GPU on this host, every time
      },
      readActiveTasks: () => 7,
      now: () => 1,
    })
    // The first three ticks probe and fail; from the fourth the probe is skipped.
    for (let i = 0; i < 10; i++) await s.tick()
    expect(probes, 'the probe must stop being paid for on every tick').toBeLessThan(10)
    expect(probes).toBe(3)
    // THE OTHER HALF STILL SAMPLES. A skipped GPU probe must not skip the queue: it is a local
    // SQLite read, it cannot hang, and it is the number that still means something here.
    const kept = getUtilizationSamples(1)
    expect(kept).toHaveLength(10)
    expect(kept.every((k) => k.active_tasks === 7)).toBe(true)
    expect(kept.every((k) => k.util_pct === null)).toBe(true)
  })

  it('BACKOFF is not permanent -- a driver that comes back is picked up again', async () => {
    let probes = 0
    let haveGpu = false
    const s = createUtilizationSampler({
      readGpu: async () => {
        probes += 1
        return haveGpu ? GPU : null
      },
      readActiveTasks: () => 0,
      now: () => 1,
    })
    for (let i = 0; i < 19; i++) await s.tick() // into backoff, before the retry tick
    const probesBeforeRetry = probes
    haveGpu = true
    await s.tick() // the 20th tick retries
    expect(probes, 'the retry tick must probe again').toBe(probesBeforeRetry + 1)
    const kept = getUtilizationSamples(1)
    expect(kept[kept.length - 1]!.util_pct, 'and the recovered GPU is recorded').toBe(42)
  })

  it('a reader that THROWS never escapes into the timer callback', async () => {
    const s = createUtilizationSampler({
      readGpu: async () => {
        throw new Error('nvidia-smi exploded')
      },
      readActiveTasks: () => {
        throw new Error('db locked')
      },
      now: () => 4242,
    })
    const got = await s.tick()
    // A sample is still produced, with the honest values: nothing known about the GPU, and a queue
    // count of 0 rather than a guess.
    expect(got).toEqual({
      ts: 4242,
      util_pct: null,
      mem_used_mb: null,
      mem_total_mb: null,
      active_tasks: 0,
    })
  })
})

// Rolling utilization history for the live local-LLM monitor (card b6b1493d, child of cf61fcac).
//
// WHAT IT IS FOR. The dashboard already answers "what is the GPU doing RIGHT NOW"
// (GET /api/local-llm/status) and "how deep is the queue right now" (GET /api/local-llm/queue). A
// waveform needs the shape over TIME, and a poll-only design cannot provide it: the browser would
// only ever see the moments it happened to ask about, with gaps wherever the tab was closed. So a
// background sampler keeps a short rolling window and the endpoint serves it.
//
// IN MEMORY ON PURPOSE. The window is minutes long and a restart legitimately starts a new one --
// the card says so, and a DB table for data whose whole value is being seconds old would be a
// durability promise nobody needs.
//
// THE SAMPLER MUST NOT COST MORE THAN WHAT IT MEASURES, which is the design constraint the card did
// not mention and the measurement did. `gpuInfo()` shells out to nvidia-smi and tries THREE
// candidate paths, each with a 5s timeout, so on a machine with no GPU one sample can take 15
// seconds -- five times the sampling interval. Without the two guards below, the ticks would pile up
// on each other and the monitor would become the load it is supposed to display:
//   1. OVERLAP GUARD -- a tick that starts while the previous one is still in flight does nothing.
//   2. PROBE BACKOFF -- after a few consecutive GPU-probe failures the GPU read is skipped on most
//      ticks and retried only occasionally. The QUEUE half keeps sampling every tick regardless: it
//      is a local SQLite read, it cannot hang, and a machine with no GPU still has a queue worth
//      watching.
//
// A MISSING READING IS null, NEVER 0. A zero draws a flat line at the bottom, which reads as "the
// GPU is idle" -- a claim we have not measured. null leaves a gap, which is what actually happened.
// (Same rule the GPU detector states about inventing numbers, one layer up.)

/** One point on the waveform. `util_pct` / `mem_*` are null when the GPU could not be read. */
export interface UtilizationSample {
  readonly ts: number
  readonly util_pct: number | null
  readonly mem_used_mb: number | null
  readonly mem_total_mb: number | null
  readonly active_tasks: number
}

/** What the sampler needs from the outside. Injected so this module never spawns a process itself
 *  and can be tested without a GPU, a database, or a clock. */
export interface UtilizationSamplerDeps {
  /** The live GPU snapshot, or null when nvidia-smi is absent / failed. Must not throw. */
  readGpu: () => Promise<{ mem_used_mb: number; mem_total_mb: number; util_pct: number } | null>
  /** How many tasks are ACTUALLY running right now (card a265e48c: the GPU-flock probe is
   *  inherently async; a sync stub still works fine since `await` on a plain number just resolves
   *  to it). Must not throw. */
  readActiveTasks: () => number | Promise<number>
  now?: () => number
}

/** 10 minutes of window at a 3s cadence is ~200 points -- enough for a readable waveform, small
 *  enough that the whole window is a few KB on the wire. */
export const WINDOW_MS = 10 * 60_000
export const SAMPLE_INTERVAL_MS = 3_000
/** Hard belt on top of the age cap: if the interval is ever shortened, the buffer still cannot grow
 *  without bound. Age is the intended limit; this is the one that cannot be misconfigured. */
export const MAX_SAMPLES = 400

/** Consecutive GPU-probe failures after which the probe is only retried every RETRY_EVERY ticks. */
const BACKOFF_AFTER_FAILURES = 3
const RETRY_EVERY = 20

const samples: UtilizationSample[] = []

/** Drop everything older than the window, and anything beyond the hard cap. */
function prune(nowMs: number): void {
  const cutoff = nowMs - WINDOW_MS
  while (samples.length > 0 && samples[0]!.ts < cutoff) samples.shift()
  while (samples.length > MAX_SAMPLES) samples.shift()
}

/** Append one point. Exported for the sampler and for tests; the route only reads. */
export function recordUtilizationSample(sample: UtilizationSample): void {
  samples.push(sample)
  prune(sample.ts)
}

/** The window, oldest first. A copy, so a caller cannot mutate the buffer it is reading. */
export function getUtilizationSamples(nowMs: number = Date.now()): UtilizationSample[] {
  prune(nowMs)
  return samples.slice()
}

/** Test seam only: forget the window. Never called by the server. */
export function resetUtilizationHistory(): void {
  samples.length = 0
}

/**
 * One sampling tick, exported so a test can drive it deterministically instead of waiting on a timer.
 *
 * Returns the sample it recorded, or null when it declined to run (overlap). Never throws: a
 * monitor that can crash the process it observes is worse than no monitor.
 */
export function createUtilizationSampler(deps: UtilizationSamplerDeps): {
  tick: () => Promise<UtilizationSample | null>
} {
  const now = deps.now ?? Date.now
  let inFlight = false
  let gpuFailures = 0
  let ticks = 0

  return {
    async tick(): Promise<UtilizationSample | null> {
      // GUARD 1: the previous tick is still waiting on nvidia-smi. Skipping is the whole point --
      // queueing would turn a slow probe into an unbounded backlog of probes.
      if (inFlight) return null
      inFlight = true
      ticks += 1
      try {
        // GUARD 2: after repeated failures the probe is almost certainly going to fail again (no
        // GPU on this host), so stop paying 15 seconds for that answer on every tick. Retry
        // occasionally, because a driver can come back.
        const skipGpu = gpuFailures >= BACKOFF_AFTER_FAILURES && ticks % RETRY_EVERY !== 0
        let gpu: { mem_used_mb: number; mem_total_mb: number; util_pct: number } | null = null
        if (!skipGpu) {
          try {
            gpu = await deps.readGpu()
          } catch {
            gpu = null
          }
          gpuFailures = gpu === null ? gpuFailures + 1 : 0
        }

        let active = 0
        try {
          active = await deps.readActiveTasks()
        } catch {
          active = 0
        }

        const sample: UtilizationSample = {
          ts: now(),
          util_pct: gpu ? gpu.util_pct : null,
          mem_used_mb: gpu ? gpu.mem_used_mb : null,
          mem_total_mb: gpu ? gpu.mem_total_mb : null,
          active_tasks: active,
        }
        recordUtilizationSample(sample)
        return sample
      } finally {
        inFlight = false
      }
    },
  }
}

/** Start the background sampler. Returns the timer handle so the server can clear it on shutdown --
 *  a live interval keeps the event loop alive, so an unowned one means the process never exits. */
export function startUtilizationSampler(deps: UtilizationSamplerDeps): NodeJS.Timeout {
  const sampler = createUtilizationSampler(deps)
  const handle = setInterval(() => void sampler.tick(), SAMPLE_INTERVAL_MS)
  // Do not hold the process open for a monitor: if everything else has finished, this should not be
  // the reason node stays alive.
  handle.unref?.()
  return handle
}

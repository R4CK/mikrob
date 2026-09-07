// Let the RECIPIENT see how many other messages are already waiting behind this one, so they can
// decide for themselves whether to self-interrupt a long-running step (card 30a34eba).
//
// WHY THIS AND NOT A GENERAL "message older than 60 minutes" ALERT. Backend's own 30-hour window
// measurement (this card's own description) found the 60+ minute delay tail is not a queue bug --
// it is normal, uneven per-recipient background load (0.16 to 30.34 minutes across recipients on
// the same bus, in the same window). A general staleness alert on that population would fire ~49
// times in 30 hours, almost all of them ordinary workload, not an incident. The actual FIX for the
// delay itself (mid-turn delivery instead of only at turn boundaries) is a bigger, separate
// decision (also named in this card's description) -- this is the cheap, additive part: give the
// recipient the ONE fact they need to decide for themselves, without a false-alarm noise budget.
//
// DELIBERATELY QUIET ON THE COMMON CASE (depth 0): a note that fires on every delivery is one
// people learn to skip, same lesson as this session's cleancore-suite-run.sh semaphore and
// fleet-test.sh's belt-and-braces check.

/** Depth 0 (nothing else waiting) formats to '', so a normal delivery adds no noise. */
export function formatQueueDepthNote(otherPendingCount: number): string {
  if (otherPendingCount <= 0) return ''
  return (
    `\n\n[üzenet-sor] +${otherPendingCount} további üzenet vár rád a sorban. ` +
    `Ha épp egy hosszú lépés közepén vagy, ez alapján eldöntheted, érdemes-e megszakítanod.`
  )
}

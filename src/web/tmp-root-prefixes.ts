// SINGLE SOURCE OF TRUTH for the transient-filesystem prefixes.
//
// Adopted from upstream (card ec7bdad8) because the list had already been copied
// once here and a copy is how it drifts. Upstream's own reason is stated in terms
// of TWO TypeScript guards sharing it; THAT IS NOT YET TRUE IN THIS FORK, and the
// difference is written down rather than implied, so the next reader does not act
// on a promise the code does not keep:
//
//  1. `isUnsafeHookCommand` (agent-scaffold.ts) refuses to write a hook command
//     containing one of these into the shared ~/.claude/settings.json. When /tmp
//     is cleared on the next reboot the referenced script is gone, python3/node
//     exits non-zero, and Claude Code blocks every prompt -- the 2026-07-14
//     silent fleet-freeze incident. THIS is the consumer here.
//
//  2. Upstream also makes its suite gate (src/__tests__/setup/assert-not-live-install.ts)
//     REFUSE to run from a checkout rooted under one of these. This fork's copy of
//     that gate only WARNS about /tmp in its remedy text -- it does not measure the
//     running root. Adopting that refusal is a real behaviour change for every
//     agent (a scratchpad is tmp-rooted), so it is NOT taken here; it is carded
//     separately rather than smuggled in behind a list extraction.
//
//  3. A THIRD copy exists that cannot import this module at all: scripts/boot-hook-prune.py
//     carries the same four prefixes in Python. It is pinned against this list by
//     src/__tests__/tmp-root-prefixes.test.ts, because an import cannot cross that
//     language boundary and nothing else would notice the two drifting apart.
export const TMP_ROOT_PREFIXES = ['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/']

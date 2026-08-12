import { randomBytes } from 'node:crypto'

// One-time CSRF state tokens for the OAuth authorization-code flow (card 426da6c1). Issued at
// /login, consumed exactly once at /auth/google/callback -- a state that was never issued,
// already used, or has expired is rejected. Short TTL (default 10 minutes): the login redirect
// round-trip normally takes seconds, not minutes.
export class StateStore {
  private states = new Map<string, number>() // state -> expiresAt

  constructor(
    private readonly ttlMs: number = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(): string {
    const state = randomBytes(24).toString('hex')
    this.states.set(state, this.now() + this.ttlMs)
    return state
  }

  // Consumes (deletes) the state unconditionally, then reports whether it was valid at the
  // moment of consumption. A state can only ever be consumed once -- replaying the same
  // callback URL a second time must not succeed twice.
  consume(state: string): boolean {
    const expiresAt = this.states.get(state)
    this.states.delete(state)
    if (expiresAt === undefined) return false
    return expiresAt > this.now()
  }
}

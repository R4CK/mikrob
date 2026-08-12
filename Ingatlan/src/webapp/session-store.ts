import { randomBytes } from 'node:crypto'

export interface SessionRecord {
  email: string
  createdAt: number
  expiresAt: number
}

// In-memory, single-process session store -- appropriate for a single-user, localhost-only app
// (card 3d04350b explicitly scopes this to Peti alone; no need for a DB-backed or distributed
// session store, which would be complexity this app will never use). Sessions do not survive a
// server restart -- an accepted tradeoff, a re-login costs one click.
export class SessionStore {
  private sessions = new Map<string, SessionRecord>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(email: string): string {
    const id = randomBytes(32).toString('hex')
    const createdAt = this.now()
    this.sessions.set(id, { email, createdAt, expiresAt: createdAt + this.ttlMs })
    return id
  }

  // Expired sessions are evicted on access (lazy cleanup) -- no background timer needed for a
  // single-user app whose session count is always tiny.
  get(sessionId: string): SessionRecord | null {
    const record = this.sessions.get(sessionId)
    if (!record) return null
    if (record.expiresAt <= this.now()) {
      this.sessions.delete(sessionId)
      return null
    }
    return record
  }

  destroy(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}

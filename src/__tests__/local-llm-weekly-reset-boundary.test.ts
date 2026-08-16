// card 87b2fef9: the fallback boundary for tokens_saved_since_weekly_reset when no /usage-panel
// snapshot has ever recorded a resetAt -- most recent UTC Monday 00:00.
import { describe, it, expect } from 'vitest'
import { lastUtcMondaySec } from '../web/routes/local-llm.js'

const utc = (y: number, m: number, d: number, h = 0, min = 0): number =>
  Math.floor(Date.UTC(y, m - 1, d, h, min) / 1000)

describe('lastUtcMondaySec', () => {
  it('on a Monday, returns that same day at 00:00 UTC', () => {
    // 2026-08-17 is a Monday.
    expect(lastUtcMondaySec(utc(2026, 8, 17, 15, 30))).toBe(utc(2026, 8, 17))
  })

  it('mid-week, returns the Monday that started the current week', () => {
    // 2026-08-19 is a Wednesday.
    expect(lastUtcMondaySec(utc(2026, 8, 19, 9, 0))).toBe(utc(2026, 8, 17))
  })

  it('on a Sunday, returns the PRECEDING Monday, not the same day', () => {
    // 2026-08-23 is a Sunday -- the trap for a naive `dow` mod-7 without the +6 offset.
    expect(lastUtcMondaySec(utc(2026, 8, 23, 23, 59))).toBe(utc(2026, 8, 17))
  })

  it('crosses a month boundary correctly', () => {
    // 2026-09-01 is a Tuesday; the Monday before it is 2026-08-31.
    expect(lastUtcMondaySec(utc(2026, 9, 1, 5, 0))).toBe(utc(2026, 8, 31))
  })

  it('always lands exactly at 00:00:00 UTC (whole-day boundary)', () => {
    const boundary = lastUtcMondaySec(utc(2026, 8, 20, 13, 47))
    expect(boundary % 86400).toBe(0)
  })
})

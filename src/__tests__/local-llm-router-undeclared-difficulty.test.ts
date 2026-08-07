// Card c7a0c142: an UNDECLARED difficulty must not be a cheaper path than a declared one.
//
// Cybersec's side-finding on the c6cc2c97 gate: `routeTask` gated on difficulty only when the
// caller passed one. Without it the configured threshold reached the reason STRING and nothing
// else, so the offload ceiling bound whoever declared honestly and not whoever left the flag off.
// Not a live exploit -- the category/SHAPE gate still fires on security-shaped work -- but a
// control that only binds the cooperative caller is not a control.
//
// The inference is deliberately NARROW: the fleet directive is to offload aggressively, and every
// false "too hard" costs a real offload. These tests pin both directions -- hard shapes are caught,
// ordinary offloadable work is NOT.
import { describe, expect, it } from 'vitest'
import { inferDifficulty, routeTask } from '../local-llm-router.js'

/** Threshold 'isolated' = the 75% slider default: anything above an isolated unit stays online. */
const AT_ISOLATED = { aggressiveness: 75 } as const

describe('inferDifficulty -- hard SHAPES, not long sentences', () => {
  it.each([
    ['design the data model for the reporting service', 'architecture'],
    ['an architectural refactor of the auth module', 'architecture'],
    ['rename the field across the codebase', 'feature'],
    ['a multi-file change touching several packages', 'feature'],
    ['build the end-to-end flow for invoicing', 'feature'],
    ['wire up the new adapter to the payroll route', 'feature'],
    ['write the migration and the adapter that reads it', 'feature'],
  ])('reads %j as %s', (text, level) => {
    expect(inferDifficulty(text)).toBe(level)
  })

  it.each([
    'write a unit test for parseScanPath',
    'add a regex that matches an epoch millisecond timestamp',
    'a helper that formats a duration in minutes',
    'add the Hungarian i18n strings for the clock-in error keys',
    // Long and wordy, but still one isolated unit -- length must not imply difficulty.
    'please write a small pure function that takes two numbers and returns their ratio, ' +
      'rounded to two decimals, returning null when the divisor is zero, with jsdoc',
  ])('leaves ordinary offloadable work unflagged: %j', (text) => {
    expect(inferDifficulty(text)).toBeNull()
  })
})

describe('routeTask with NO declared difficulty', () => {
  it('routes ONLINE when the inferred difficulty exceeds the threshold', () => {
    const d = routeTask({ description: 'design the data model for billing', ...AT_ISOLATED })
    expect(d.route).toBe('online')
    expect(d.difficulty).toBe('architecture')
    expect(d.reason).toMatch(/inferred/)
  })

  it('still routes LOCAL for ordinary work -- the default is not narrowed', () => {
    const d = routeTask({ description: 'write a unit test for parseScanPath', ...AT_ISOLATED })
    expect(d.route).toBe('local')
  })

  it('respects a RAISED threshold: the same task offloads when the operator allows it', () => {
    // 'feature'-level work is online at the isolated default and local once the ceiling is raised,
    // which is the whole point of the threshold being a decision input rather than a log string.
    const task = 'a multi-file change touching several packages'
    expect(routeTask({ description: task, ...AT_ISOLATED }).route).toBe('online')
    expect(routeTask({ description: task, threshold: 'feature' }).route).toBe('local')
  })

  it('never lets an undeclared ARCHITECTURE task offload, even at maximum aggressiveness', () => {
    // The ceiling is 'feature'; architecture is never draftable locally however high the slider.
    const d = routeTask({ description: 'design the system architecture', aggressiveness: 100 })
    expect(d.route).toBe('online')
  })

  it('declared and undeclared now agree on the same task', () => {
    // The defect was exactly this asymmetry: declaring got you gated, omitting did not.
    const task = 'a multi-file change touching several packages'
    const declared = routeTask({ description: task, difficulty: 'feature', ...AT_ISOLATED })
    const undeclared = routeTask({ description: task, ...AT_ISOLATED })
    expect(undeclared.route).toBe(declared.route)
  })

  it('a category signal still wins over the difficulty path', () => {
    // Ordering matters: a security-shaped task must report WHY it is online, not be relabelled as
    // a difficulty verdict.
    const d = routeTask({ description: 'treat a missing role as owner', ...AT_ISOLATED })
    expect(d.route).toBe('online')
    expect(d.category).toBeDefined()
  })
})

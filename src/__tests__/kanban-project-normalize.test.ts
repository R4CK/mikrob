// Card project-name drift (Peti 2026-08-08): "CleanCore" / "cleancore", and "MikroB" /
// "mikrob-infra" / "fleet-infra" / "marveen" / "infra" etc, fragmented into distinct project
// buckets because the field was free-text with no case-folding. normalizeProjectName folds
// known variants onto the canonical name; it must NOT swallow a genuinely new project name.

import { describe, it, expect } from 'vitest'
import { normalizeProjectName } from '../web/routes/kanban.js'

describe('normalizeProjectName', () => {
  it('folds known CleanCore case variants onto the canonical name', () => {
    expect(normalizeProjectName({ project: 'cleancore' })).toEqual({ project: 'CleanCore' })
    expect(normalizeProjectName({ project: 'CLEANCORE' })).toEqual({ project: 'CleanCore' })
    expect(normalizeProjectName({ project: 'CleanCore' })).toEqual({ project: 'CleanCore' })
  })

  it('folds known MikroB-umbrella variants onto the canonical name', () => {
    for (const variant of ['mikrob', 'mikrob-infra', 'fleet-infra', 'marveen', 'infra', 'Infra', 'MikroB-ops', 'marveen-infra']) {
      expect(normalizeProjectName({ project: variant })).toEqual({ project: 'MikroB' })
    }
  })

  it('leaves an unrecognised project name untouched -- normalisation, not an allowlist', () => {
    expect(normalizeProjectName({ project: 'SomeNewProduct' })).toEqual({ project: 'SomeNewProduct' })
  })

  it('leaves data without a project field untouched', () => {
    const data = { title: 'x' }
    expect(normalizeProjectName(data)).toEqual({ title: 'x' })
  })

  it('leaves a non-string project value untouched', () => {
    const data = { project: null }
    expect(normalizeProjectName(data)).toEqual({ project: null })
  })

  it('preserves the rest of the payload unchanged', () => {
    expect(normalizeProjectName({ title: 'Card', project: 'cleancore', priority: 'high' }))
      .toEqual({ title: 'Card', project: 'CleanCore', priority: 'high' })
  })
})

describe('normalizeProjectName -- "None" sentinel (card c9b0b0c4)', () => {
  // The real incident: card a6101228 landed with project = the literal string "None" -- a Python
  // caller's str(None) serialized straight into the JSON body. That string is truthy in JS, so
  // `project ?? undefined` never caught it and it reached the DB as a non-NULL value that every
  // `WHERE project IS NULL` filter and every project-grouped view then missed.
  it('folds the literal string "None" onto real absence (null), not a canonical project', () => {
    expect(normalizeProjectName({ project: 'None' })).toEqual({ project: null })
    expect(normalizeProjectName({ project: 'none' })).toEqual({ project: null })
    expect(normalizeProjectName({ project: 'NONE' })).toEqual({ project: null })
  })

  it('folds other common null-ish sentinels the same way', () => {
    expect(normalizeProjectName({ project: 'null' })).toEqual({ project: null })
    expect(normalizeProjectName({ project: 'undefined' })).toEqual({ project: null })
    expect(normalizeProjectName({ project: '' })).toEqual({ project: null })
    expect(normalizeProjectName({ project: '   ' })).toEqual({ project: null })
  })

  it('does NOT treat a real project literally named "None-something" as the sentinel', () => {
    // Exact-match only, on the trimmed/lowercased whole value -- must not eat a substring.
    expect(normalizeProjectName({ project: 'NoneSuch' })).toEqual({ project: 'NoneSuch' })
  })
})

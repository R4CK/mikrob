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

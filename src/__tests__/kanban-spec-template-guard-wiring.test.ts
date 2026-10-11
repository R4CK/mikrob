// Card 81452ce2 delta-gate F1 (WhiteHat2 NO-GO, komment 16326): specTemplateGuardCheck must fire
// ONLY after the planned -> in_progress transition has actually SUCCEEDED, never on a request a
// later 409 guard rejects. Before this fix the call sat textually BEFORE dependencyBlockBody and
// the actual write, so a rejected request could still have written the warn comment or the
// [BLOKKOLT-Peti-dontes] title tag. This is a source-text wiring test (no route under test here --
// kanban-spec-template-guard.test.ts covers the function's own behaviour) because the defect is
// entirely about ORDER, which a unit test of the function in isolation cannot see.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = readFileSync(join(REPO_ROOT, 'src', 'web', 'routes', 'kanban.ts'), 'utf8')

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = SOURCE.indexOf(startMarker)
  expect(start, `marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0)
  const end = SOURCE.indexOf(endMarker, start)
  expect(end, `marker not found after start: ${endMarker}`).toBeGreaterThanOrEqual(0)
  return SOURCE.slice(start, end)
}

describe('specTemplateGuardCheck wiring in kanban.ts', () => {
  it('is called exactly twice (PUT handler + POST /move handler)', () => {
    const calls = SOURCE.split('specTemplateGuardCheck(').length - 1
    expect(calls).toBe(2)
  })

  it('PUT handler: the call is textually AFTER the successful updateKanbanCard write, not before it', () => {
    const putHandlerSlice = sliceBetween(
      "if (updateKanbanCard(id, normalizeProjectName(data)",
      "'Kártya nem található'",
    )
    const writeIdx = putHandlerSlice.indexOf('updateKanbanCard(id, normalizeProjectName(data)')
    const guardIdx = putHandlerSlice.indexOf('specTemplateGuardCheck(')
    expect(guardIdx, 'specTemplateGuardCheck must be called in the PUT success branch').toBeGreaterThan(-1)
    expect(guardIdx).toBeGreaterThan(writeIdx)
  })

  it('PUT handler: the call is AFTER the dependency/bulk-attribution 409 guards, not before them', () => {
    const putHandlerSlice = sliceBetween(
      "if (updateKanbanCard(id, normalizeProjectName(data)",
      "'Kártya nem található'",
    )
    const guardIdx = putHandlerSlice.indexOf('specTemplateGuardCheck(')
    const dependencyIdx = SOURCE.indexOf('dependencyBlockBody(id, data.status')
    const guardAbsoluteIdx = SOURCE.indexOf('specTemplateGuardCheck(', SOURCE.indexOf("if (updateKanbanCard(id, normalizeProjectName(data)"))
    expect(guardIdx).toBeGreaterThan(-1)
    expect(guardAbsoluteIdx).toBeGreaterThan(dependencyIdx)
  })

  it('POST /move handler: the call is textually AFTER the successful moveKanbanCard write, not before it', () => {
    const moveHandlerSlice = sliceBetween(
      'if (moveKanbanCard(id, status, sort_order',
      "'Kártya nem található'",
    )
    const writeIdx = moveHandlerSlice.indexOf('moveKanbanCard(id, status, sort_order')
    const guardIdx = moveHandlerSlice.indexOf('specTemplateGuardCheck(')
    expect(guardIdx, 'specTemplateGuardCheck must be called in the move success branch').toBeGreaterThan(-1)
    expect(guardIdx).toBeGreaterThan(writeIdx)
  })

  it('POST /move handler: the call is AFTER the dependency 409 guard, not before it', () => {
    const dependencyIdxInMove = SOURCE.indexOf('dependencyBlockBody(id, status, force')
    const moveCallIdx = SOURCE.lastIndexOf('specTemplateGuardCheck(')
    expect(dependencyIdxInMove).toBeGreaterThan(-1)
    expect(moveCallIdx).toBeGreaterThan(dependencyIdxInMove)
  })

  it('both call sites pass a captured prevStatus, not the literal post-mutation card status', () => {
    const occurrences = [...SOURCE.matchAll(/specTemplateGuardCheck\(id, (\w+),/g)].map((m) => m[1])
    expect(occurrences).toEqual(['specTemplatePrevStatus', 'specTemplatePrevStatus'])
  })
})

import { describe, it, expect } from 'vitest'
import { mapProjectToPartition, GLOBAL_PARTITION } from '../kg/project-map.js'

describe('mapProjectToPartition (MikroB decision D2, 3f6fc4ce comment 20814)', () => {
  it('maps the live, capitalized card labels to their canonical lowercase partition', () => {
    expect(mapProjectToPartition('MikroB')).toBe('mikrob')
    expect(mapProjectToPartition('mopsion')).toBe('mopsion')
    expect(mapProjectToPartition('Ingatlan')).toBe('ingatlan')
  })

  it('NULL/empty project maps to the _global partition, not a guess', () => {
    expect(mapProjectToPartition(null)).toBe(GLOBAL_PARTITION)
    expect(mapProjectToPartition(undefined)).toBe(GLOBAL_PARTITION)
    expect(mapProjectToPartition('   ')).toBe(GLOBAL_PARTITION)
  })

  it('an unknown-but-present project passes through lowercased, not folded into _global', () => {
    expect(mapProjectToPartition('NewProject')).toBe('newproject')
  })
})

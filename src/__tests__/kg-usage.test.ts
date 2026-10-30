import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../kg/store.js'
import { recordKgOffered, recordKgUsageFeedback, parseMegoldasTarLines } from '../kg/usage.js'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

describe('recordKgOffered (MT-08, card 1a350f22)', () => {
  it('writes one offered row per node', () => {
    const db = freshDb()
    recordKgOffered(db, 'cardA', ['sol:1', 'sol:2'], 'backend3')
    const rows = db.prepare(`SELECT node_id, card_id, agent, event FROM kg_usage ORDER BY node_id`).all()
    expect(rows).toEqual([
      { node_id: 'sol:1', card_id: 'cardA', agent: 'backend3', event: 'offered' },
      { node_id: 'sol:2', card_id: 'cardA', agent: 'backend3', event: 'offered' },
    ])
    db.close()
  })

  it('is idempotent: a second call for the same (card, node) does not duplicate the offered row', () => {
    const db = freshDb()
    recordKgOffered(db, 'cardA', ['sol:1'], 'backend3')
    recordKgOffered(db, 'cardA', ['sol:1'], 'backend3')
    const count = db.prepare(`SELECT COUNT(*) AS n FROM kg_usage WHERE card_id='cardA' AND node_id='sol:1' AND event='offered'`).get() as { n: number }
    expect(count.n).toBe(1)
    db.close()
  })

  it('a duplicate node id in the SAME call is deduped too', () => {
    const db = freshDb()
    recordKgOffered(db, 'cardA', ['sol:1', 'sol:1'], 'backend3')
    const count = db.prepare(`SELECT COUNT(*) AS n FROM kg_usage WHERE card_id='cardA' AND node_id='sol:1'`).get() as { n: number }
    expect(count.n).toBe(1)
    db.close()
  })

  it('the same node offered to a DIFFERENT card gets its own row (card_id is part of the key)', () => {
    const db = freshDb()
    recordKgOffered(db, 'cardA', ['sol:1'], 'backend3')
    recordKgOffered(db, 'cardB', ['sol:1'], 'backend3')
    const count = db.prepare(`SELECT COUNT(*) AS n FROM kg_usage WHERE node_id='sol:1' AND event='offered'`).get() as { n: number }
    expect(count.n).toBe(2)
    db.close()
  })
})

describe('recordKgUsageFeedback anti-inflation gate (MikroB decision 26148)', () => {
  it('records used/not_relevant/harmful when the node WAS offered to that card', () => {
    const db = freshDb()
    recordKgOffered(db, 'cardA', ['sol:1'], 'backend3')
    expect(recordKgUsageFeedback(db, 'cardA', 'sol:1', 'backend3', 'used')).toBe(true)
    const row = db.prepare(`SELECT event FROM kg_usage WHERE card_id='cardA' AND node_id='sol:1' AND event='used'`).get()
    expect(row).toBeTruthy()
    db.close()
  })

  it('REFUSES to record feedback for a node never offered to that card -- no row is written', () => {
    const db = freshDb()
    // Nothing offered at all.
    expect(recordKgUsageFeedback(db, 'cardA', 'sol:99', 'backend3', 'used')).toBe(false)
    const count = db.prepare(`SELECT COUNT(*) AS n FROM kg_usage`).get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('a node offered to a DIFFERENT card does not satisfy the gate for this card', () => {
    const db = freshDb()
    recordKgOffered(db, 'cardOther', ['sol:1'], 'backend3')
    expect(recordKgUsageFeedback(db, 'cardA', 'sol:1', 'backend3', 'used')).toBe(false)
    const count = db.prepare(`SELECT COUNT(*) AS n FROM kg_usage WHERE event != 'offered'`).get() as { n: number }
    expect(count.n).toBe(0)
    db.close()
  })

  it('mutation check: removing the offered-gate (always returning true) would let an unsolicited card id through -- this test is RED against that mutant', () => {
    // This test IS the one from above ("REFUSES..."); restated with an explicit name so the
    // intent (catching a dropped anti-inflation check) is unambiguous from the test list alone.
    const db = freshDb()
    const recorded = recordKgUsageFeedback(db, 'card-never-offered-anything', 'sol:not-offered', 'someone', 'harmful')
    expect(recorded).toBe(false)
    db.close()
  })
})

describe('parseMegoldasTarLines (MT-08 REVIEW template)', () => {
  it('parses a plain "felhasznalva" line', () => {
    expect(parseMegoldasTarLines('Megoldás-tár: sol:7f3a91c2 felhasznalva')).toEqual([
      { nodeId: 'sol:7f3a91c2', event: 'used' },
    ])
  })

  it('parses the accented spelling too', () => {
    expect(parseMegoldasTarLines('Megoldás-tár: sol:1 felhasználva')).toEqual([{ nodeId: 'sol:1', event: 'used' }])
  })

  it('parses "nem illett" as not_relevant', () => {
    expect(parseMegoldasTarLines('Megoldás-tár: sol:1 nem illett')).toEqual([{ nodeId: 'sol:1', event: 'not_relevant' }])
  })

  it('"nincs talalat" carries no node id to record against -- skipped, not an error', () => {
    expect(parseMegoldasTarLines('Megoldás-tár: - nincs talalat')).toEqual([])
    expect(parseMegoldasTarLines('Gate-SHA: abc\nMegoldás-tár: - nincs találat\nSkills: x')).toEqual([])
  })

  it('parses the harmful keyword (ASCII and accented) and the literal English word', () => {
    expect(parseMegoldasTarLines('Megoldás-tár: sol:1 artalmas')).toEqual([{ nodeId: 'sol:1', event: 'harmful' }])
    expect(parseMegoldasTarLines('Megoldás-tár: sol:1 ártalmas')).toEqual([{ nodeId: 'sol:1', event: 'harmful' }])
    expect(parseMegoldasTarLines('Megoldás-tár: sol:1 harmful')).toEqual([{ nodeId: 'sol:1', event: 'harmful' }])
  })

  it('a comment with no Megoldás-tár line at all yields an empty array, never throws', () => {
    expect(parseMegoldasTarLines('REVIEW -- done, all green.')).toEqual([])
    expect(parseMegoldasTarLines('')).toEqual([])
  })

  it('multiple lines in one comment are all parsed', () => {
    const content = [
      'Gate-SHA: abc123',
      'Megoldás-tár: sol:1 felhasznalva',
      'Megoldás-tár: sol:2 nem illett',
      'Skills: x, y',
    ].join('\n')
    expect(parseMegoldasTarLines(content)).toEqual([
      { nodeId: 'sol:1', event: 'used' },
      { nodeId: 'sol:2', event: 'not_relevant' },
    ])
  })

  it('a malformed line (unrecognised verb) is skipped silently, not thrown', () => {
    expect(parseMegoldasTarLines('Megoldás-tár: sol:1 valami-ismeretlen-szo')).toEqual([])
  })

  it('does not match a bare mention of the phrase mid-sentence without the colon-id-verb shape', () => {
    expect(parseMegoldasTarLines('A Megoldás-tár koncepcio hasznos lehet.')).toEqual([])
  })
})

import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, saveAgentMemory, searchAgentMemories, getDb } from '../db.js'

// Card 3bcc1242 part 1: searchAgentMemories used to have NO content-shape filter at all, so a
// query against backend's memories returned tool-log rows (Bash:/Write:/Edit: prefixes) almost
// exclusively -- measured live, 844 of 858 backend auto_generated rows are this shape, and a
// search for e.g. "git merge" surfaced only auto-logged Bash rows, never the hand-written lesson
// about the SAME topic sitting a few rows away.
//
// THE PRIOR (rejected) approach was to filter on `auto_generated=1`. That flag also marks 475
// hand-written fleet memories -- the entire shared tier, most of warm -- so filtering on it would
// make those invisible from search with no error to signal it (a not-found memory is
// functionally a deleted one). This suite's central assertion is exactly that distinction: shape
// filters correctly regardless of the flag's value.
describe('searchAgentMemories filters by CONTENT SHAPE, not the auto_generated flag (card 3bcc1242)', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
  })

  it('a tool-log-shaped row is excluded even though it matches the query', () => {
    saveAgentMemory('backend', 'Bash: git merge origin/develop', 'hot', 'git merge deploy', true)
    const results = searchAgentMemories('backend', 'git merge', 10)
    expect(results.find((m) => m.content.startsWith('Bash: '))).toBeUndefined()
  })

  it('an auto_generated=1 HAND-WRITTEN memory (the flag-based approach\'s exact failure case) still surfaces', () => {
    // auto_generated=true here on purpose: this is what a bulk-import or a shared-tier fleet
    // rule looks like in the schema today -- NOT a tool-log row, despite the flag.
    const id = saveAgentMemory(
      'backend',
      'git merge conflicts on the fork-upstream guard must be resolved by re-reading the acknowledged blob shas.',
      'cold',
      'git merge conflict',
      true,
    ).id
    const results = searchAgentMemories('backend', 'git merge', 10)
    expect(results.map((m) => m.id)).toContain(id)
  })

  it('a shared-tier auto_generated row (real fleet pattern) is never hidden by the shape filter', () => {
    const id = saveAgentMemory(
      'shared',
      'git merge base can equal theirs in a 3-way merge -- gate the rewritten branches, not just the diff.',
      'shared',
      'git merge base',
      true,
    ).id
    const results = searchAgentMemories('someone-else', 'git merge base', 10)
    expect(results.map((m) => m.id)).toContain(id)
  })

  it('every declared tool-log prefix is excluded, not only Bash', () => {
    getDb().exec('DELETE FROM memories')
    const prefixes = ['Bash: ', 'Write: ', 'Edit: ', 'NotebookEdit: ', 'Agent spawned: ', 'Workflow: ']
    for (const p of prefixes) {
      saveAgentMemory('backend', `${p}deploy step for the widget rollout`, 'hot', 'widget rollout', true)
    }
    const results = searchAgentMemories('backend', 'widget rollout', 20)
    expect(results).toHaveLength(0)
  })

  it('a real memory that merely CONTAINS the word "Bash" mid-sentence is not caught by the prefix filter', () => {
    getDb().exec('DELETE FROM memories')
    const id = saveAgentMemory(
      'backend',
      'The Bash noisy-command-guard hook blocks raw install/test output from reaching context.',
      'warm',
      'bash guard noisy',
      false,
    ).id
    const results = searchAgentMemories('backend', 'bash guard noisy', 10)
    expect(results.map((m) => m.id)).toContain(id)
  })
})

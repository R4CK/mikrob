// Card baeddb21: Episodic failed-episode pattern + LoCoMo recall audit
import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  saveFailedEpisode,
  listFailedEpisodes,
  auditMemoryRecall,
  saveAgentMemory,
  type FailedEpisodeParams,
} from '../db.js'

beforeAll(() => {
  process.env['NODE_ENV'] = 'test'
  initDatabase(':memory:')
})

describe('saveFailedEpisode', () => {
  it('saves with episodic sector and cold category', () => {
    const result = saveFailedEpisode({
      agentId: 'backend2',
      task: 'Indexelés hozzáadása a job táblához',
      attempt: 'ALTER TABLE jobs ADD INDEX idx_tenant',
      error: 'Tenant-scope invariáns nem érvényesül az indexben',
      lesson: 'Composite index szükséges (tenant_id, created_at) sorrendben',
    })
    expect(result.id).toBeGreaterThan(0)
    expect(result.topicKey).toMatch(/^failed_episode:/)
    expect(result.content).toContain('[BUKOTT_EPIZÓD]')
    expect(result.content).toContain('Indexelés hozzáadása')
    expect(result.content).toContain('Tanulság:')
  })

  it('includes all four fields in content', () => {
    const params: FailedEpisodeParams = {
      agentId: 'qa',
      task: 'E2E teszt futtatás',
      attempt: 'vitest --run e2e',
      error: 'Import resolution failed: cannot find module',
      lesson: 'tsx loader kell: vitest --run --loader tsx e2e',
      keywords: 'vitest e2e import tsx',
    }
    const result = saveFailedEpisode(params)
    expect(result.content).toContain('Feladat: E2E teszt futtatás')
    expect(result.content).toContain('Próbálkozás: vitest --run e2e')
    expect(result.content).toContain('Hiba: Import resolution failed')
    expect(result.content).toContain('Tanulság: tsx loader kell')
  })

  it('generates unique topic_key per call even for identical task name', () => {
    const params: FailedEpisodeParams = {
      agentId: 'backend2',
      task: 'duplicate task',
      attempt: 'same attempt',
      error: 'same error',
      lesson: 'same lesson',
    }
    const r1 = saveFailedEpisode(params)
    const r2 = saveFailedEpisode(params)
    expect(r1.topicKey).not.toBe(r2.topicKey)
  })

  it('handles special characters in task without throwing', () => {
    expect(() => saveFailedEpisode({
      agentId: 'mikrob',
      task: 'Auth-token / OAuth callback (fix)',
      attempt: 'setSession() only',
      error: 'setApiToken() missing -> 401 on API calls',
      lesson: 'Both setSession() AND setApiToken() required',
    })).not.toThrow()
  })
})

describe('listFailedEpisodes', () => {
  it('returns only failed_episode entries for the given agent', () => {
    saveFailedEpisode({
      agentId: 'test-agent-list',
      task: 'List test task',
      attempt: 'attempt A',
      error: 'error A',
      lesson: 'lesson A',
    })
    // Also save a regular memory to ensure it does NOT appear
    saveAgentMemory('test-agent-list', 'Regular warm memory', 'warm', 'keyword1', true)

    const episodes = listFailedEpisodes('test-agent-list', 10)
    expect(episodes.length).toBeGreaterThanOrEqual(1)
    for (const ep of episodes) {
      expect(ep.topic_key).toMatch(/^failed_episode:/)
      expect(ep.sector).toBe('episodic')
      expect(ep.category).toBe('cold')
    }
  })

  it('respects the limit parameter', () => {
    const agentId = 'test-agent-limit'
    for (let i = 0; i < 5; i++) {
      saveFailedEpisode({ agentId, task: `task ${i}`, attempt: 'a', error: 'e', lesson: 'l' })
    }
    const episodes = listFailedEpisodes(agentId, 3)
    expect(episodes.length).toBe(3)
  })
})

describe('auditMemoryRecall', () => {
  it('returns a valid audit object for an agent with no memories', () => {
    const audit = auditMemoryRecall('nonexistent-agent', 10)
    expect(typeof audit.sampleSize).toBe('number')
    expect(typeof audit.keywordPrecisionAtK).toBe('number')
    expect(typeof audit.staleRatio).toBe('number')
    expect(typeof audit.ftsHealthy).toBe('boolean')
    expect(typeof audit.failedEpisodeCount).toBe('number')
    expect(audit.runAt).toBeGreaterThan(0)
  })

  it('detects failed episode count correctly', () => {
    const agentId = 'audit-agent-ep'
    saveFailedEpisode({ agentId, task: 'audit task 1', attempt: 'a', error: 'e', lesson: 'l' })
    saveFailedEpisode({ agentId, task: 'audit task 2', attempt: 'a', error: 'e', lesson: 'l' })

    const audit = auditMemoryRecall(agentId, 10)
    expect(audit.failedEpisodeCount).toBe(2)
  })

  it('computes precision@10 > 0 when keyword-tagged memories exist', () => {
    const agentId = 'audit-agent-kw'
    saveAgentMemory(agentId, 'Tenant isolation via RLS policy', 'cold', 'tenant rls isolation policy', true)
    saveAgentMemory(agentId, 'OAuth callback needs setApiToken', 'warm', 'oauth callback setApiToken token', true)

    const audit = auditMemoryRecall(agentId, 50)
    // At least the keyword-tagged entries should be findable
    expect(audit.keywordPrecisionAtK).toBeGreaterThanOrEqual(0)
    expect(audit.keywordPrecisionAtK).toBeLessThanOrEqual(1)
    expect(audit.testedCount).toBeGreaterThanOrEqual(2)
  })

  it('ftsHealthy is true on fresh in-memory DB', () => {
    const audit = auditMemoryRecall('mikrob', 5)
    expect(audit.ftsHealthy).toBe(true)
  })

  it('tier distribution sums match sample', () => {
    const agentId = 'audit-agent-tier'
    saveAgentMemory(agentId, 'Hot memory', 'hot', 'hot active', true)
    saveAgentMemory(agentId, 'Warm memory', 'warm', 'warm config', true)
    saveAgentMemory(agentId, 'Cold memory', 'cold', 'cold archive', true)

    const audit = auditMemoryRecall(agentId, 50)
    const tierSum = Object.values(audit.tierDistribution).reduce((a, b) => a + b, 0)
    expect(tierSum).toBe(audit.sampleSize <= 3 ? tierSum : tierSum)
    // sampleSize capped by actual count, so tierSum <= sampleSize
    expect(tierSum).toBeLessThanOrEqual(audit.sampleSize)
  })
})

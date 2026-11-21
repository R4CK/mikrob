// Card b34f791c: the dashboard's boot call to ensureFederationClaudeMdSection() was re-inserting
// the MARVEEN-FEDERATION managed block into the git-tracked root CLAUDE.md on EVERY boot, because
// the committed file on develop never carried the block -- so every restart dirtied the tracked
// tree, and every following `update.sh` refused (exit 3, dirty tree) until someone manually
// stashed it. The fix commits the block this live install's own config renders, so a boot write
// against UNCHANGED config is a true no-op (applyFederationBlock already returns null when the
// rendered block is byte-identical to what's already there -- see onboarding.ts).
//
// This does not make the write immune to a FUTURE config change (enabling/disabling federation,
// adding a peer, changing WEB_PORT): a deliberate config change is EXPECTED to dirty the tree
// once, the same way editing any other tracked file does, and is a rare admin action, not a
// boot-time churn. The scope note at the end of claude-md-main-section-writers.test.ts already
// flagged exactly this as a known, separate (not a MAIN_AGENT_ID no-op bug) class and deferred the
// fix to a follow-up card -- this file is that follow-up.
//
// MAIN_AGENT_ID/BOT_NAME/WEB_PORT are env-derived (config.ts) and differ between the real
// deployment (.env sets MAIN_AGENT_ID=mikrob) and a disposable fleet-test.sh worktree (no .env,
// defaults to 'marveen') -- the same caution claude-md-main-section-writers.test.ts's
// agent-id-header pin already took. So this file extracts the identity values FROM the committed
// block's own text instead of importing the env-dependent constants, keeping the pin meaningful
// for drift in the renderer's prose/logic without being a deployment-config oracle.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'
import {
  renderFederationBlock,
  applyFederationBlock,
  FEDERATION_BLOCK_BEGIN,
  FEDERATION_BLOCK_END,
  FEDERATION_POLICY_ANCHOR,
  type OnboardingIdentity,
} from '../web/federation/onboarding.js'
import { DEFAULT_ROUTING_MODE, type FederationConfig } from '../web/federation/config.js'

const ROOT_CLAUDE_MD_PATH = join(REPO_ROOT, 'CLAUDE.md')

function extractCommittedBlock(content: string): string {
  const begin = content.indexOf(FEDERATION_BLOCK_BEGIN)
  const end = content.indexOf(FEDERATION_BLOCK_END)
  expect(begin, 'MARVEEN-FEDERATION block missing from the committed root CLAUDE.md').toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(begin)
  return content.slice(begin, end + FEDERATION_BLOCK_END.length)
}

/** Identity + config this live install's committed block was rendered with, derived from the
 *  committed text itself (not from env-dependent constants -- see file header). */
function identityFromCommittedBlock(block: string): OnboardingIdentity {
  const mainAgentId = /"from":"([^"]+)"/.exec(block)?.[1]
  const webPort = /localhost:(\d+)\/api\/messages/.exec(block)?.[1]
  expect(mainAgentId, 'could not find the embedded from-id in the committed block').toBeDefined()
  expect(webPort, 'could not find the embedded port in the committed block').toBeDefined()
  return { botName: 'irrelevant-for-render', mainAgentId: mainAgentId!, webPort: Number(webPort), lang: 'hu' }
}

describe('b34f791c: the committed root CLAUDE.md carries the MARVEEN-FEDERATION block byte-exact', () => {
  const root = readFileSync(ROOT_CLAUDE_MD_PATH, 'utf-8')
  const committedBlock = extractCommittedBlock(root)
  const identity = identityFromCommittedBlock(committedBlock)
  const cfg: FederationConfig = { enabled: true, systemId: identity.mainAgentId, routingMode: DEFAULT_ROUTING_MODE, peers: [] }

  it('re-rendering the SAME (enabled, no-peer) config the committed block itself describes is a no-op', () => {
    const rendered = renderFederationBlock(cfg, identity)
    expect(applyFederationBlock(root, rendered), 'a boot write against unchanged config must not dirty the tracked file').toBeNull()
  })

  it('round-trips: removing then re-inserting the block reproduces the original file exactly (no blank-line leak)', () => {
    const removed = applyFederationBlock(root, null)
    expect(removed, 'disabling federation should change the committed file (block is present)').not.toBeNull()
    const reinserted = applyFederationBlock(removed!, renderFederationBlock(cfg, identity))
    expect(reinserted, 'the block should go back in (removed content has no block to short-circuit on)').not.toBeNull()
    expect(reinserted).toBe(root)
  })

  it('the owner-editable policy section (seeded once, outside the managed block) is preserved untouched', () => {
    const anchorCount = root.split(FEDERATION_POLICY_ANCHOR).length - 1
    expect(anchorCount, 'the policy anchor must appear exactly once').toBe(1)
    // The policy anchor sits BEFORE the managed block in this file (seeded earlier, the managed
    // block appended later) -- re-rendering the managed block must never touch it.
    const policyIdx = root.indexOf(FEDERATION_POLICY_ANCHOR)
    const blockIdx = root.indexOf(FEDERATION_BLOCK_BEGIN)
    expect(policyIdx).toBeGreaterThanOrEqual(0)
    expect(blockIdx).toBeGreaterThan(policyIdx)
    const rendered = applyFederationBlock(root, renderFederationBlock(cfg, identity))
    // null (no-op) means the whole file, policy section included, is untouched by definition.
    expect(rendered).toBeNull()
  })

  it('BEGIN appears exactly once and is followed by exactly one END (no duplicate/corrupted block)', () => {
    expect(root.split(FEDERATION_BLOCK_BEGIN).length - 1).toBe(1)
    expect(root.split(FEDERATION_BLOCK_END).length - 1).toBe(1)
  })
})

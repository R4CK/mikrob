// QA2 L1 (25ea084c, TOKENVAK915), confirmed by WhiteHat2's own L1: the bugfix itself
// (context-guard-runner.ts's and context-restart-gate-runner.ts's configDirFor() delegating
// to mainAgentConfigDir() for MAIN_AGENT_ID) had zero pin on the REAL delegation. Every existing
// test either mocks the WHOLE main-transcript-root.js module (context-restart-gate-wiring.test.ts,
// which even mocks a non-existent `configDirFor` export on that module -- dead code, since nothing
// imports that name FROM main-transcript-root.js) or tests mainAgentConfigDir() in isolation
// (main-transcript-root.test.ts). Neither ever calls a runner's REAL configDirFor(). Reproduced by
// QA2: reverting both runners' configDirFor() to the pre-fix `name === MAIN_AGENT_ID ? undefined :
// ...` left 24 files / 491 tests green.
//
// Fix here: mock ONLY mainAgentConfigDir (the one real dependency configDirFor calls), then call
// the REAL, unmocked configDirFor from each runner module directly. This proves delegation happens
// AND that the main agent's own computed working dir (agentConfigRoot(MAIN_AGENT_ID) === PROJECT_ROOT)
// is the argument passed through -- a mutant that calls mainAgentConfigDir with the wrong argument,
// or that keeps the old unconditional `undefined`, turns red here.
import { describe, it, expect, vi } from 'vitest'

const ISOLATED_DIR = '/isolated/main/config'

const mainAgentConfigDirMock = vi.fn((workingDir: string) => (workingDir === expectedWorkingDir ? ISOLATED_DIR : undefined))
let expectedWorkingDir = ''

vi.mock('../web/main-transcript-root.js', () => ({
  mainAgentConfigDir: (workingDir: string) => mainAgentConfigDirMock(workingDir),
  // newestMainConfigRoot is imported transitively by neither runner's configDirFor, but keep the
  // module shape honest in case something else in the import chain reaches for it.
  newestMainConfigRoot: () => undefined,
}))

describe('configDirFor REAL delegation to mainAgentConfigDir (not a mocked configDirFor)', () => {
  it('context-restart-gate-runner.ts: MAIN_AGENT_ID resolves through the real function, with the real working dir', async () => {
    const { MAIN_AGENT_ID, PROJECT_ROOT } = await import('../config.js')
    expectedWorkingDir = PROJECT_ROOT
    mainAgentConfigDirMock.mockClear()
    const { configDirFor } = await import('../web/context-restart-gate-runner.js')
    const result = configDirFor(MAIN_AGENT_ID)
    expect(mainAgentConfigDirMock).toHaveBeenCalledWith(PROJECT_ROOT)
    expect(result).toBe(ISOLATED_DIR)
  })

  it('context-guard-runner.ts: MAIN_AGENT_ID resolves through the real function, with the real working dir', async () => {
    const { MAIN_AGENT_ID, PROJECT_ROOT } = await import('../config.js')
    expectedWorkingDir = PROJECT_ROOT
    mainAgentConfigDirMock.mockClear()
    const { configDirFor } = await import('../web/context-guard-runner.js')
    const result = configDirFor(MAIN_AGENT_ID)
    expect(mainAgentConfigDirMock).toHaveBeenCalledWith(PROJECT_ROOT)
    expect(result).toBe(ISOLATED_DIR)
  })

  it('a non-main agent never reaches mainAgentConfigDir, in either runner (mutation pin: the branch is name-gated)', async () => {
    mainAgentConfigDirMock.mockClear()
    const restartGate = await import('../web/context-restart-gate-runner.js')
    const guard = await import('../web/context-guard-runner.js')
    restartGate.configDirFor('some-sub-agent')
    guard.configDirFor('some-sub-agent')
    expect(mainAgentConfigDirMock).not.toHaveBeenCalled()
  })
})

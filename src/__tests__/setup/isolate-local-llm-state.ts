// GLOBAL SUITE GATE: point the local-LLM scripts' state directory at a throwaway dir, so the
// suite can never write the LIVE install's ledger.
//
// THE DEFECT THIS CLOSES (card 4c5c540c). Several suites run the REAL store/local-llm.sh against
// a fake Ollama/dashboard -- deliberately, they are behaviour tests of the script itself. The
// script appends every call to `$STATE_DIR/local-llm-usage.log`, and STATE_DIR is resolved by
// store/local-llm-state-dir.sh, which for a git WORKTREE deliberately returns the MAIN clone's
// store. That redirect is correct for its own purpose (an agent calling the script from a
// worktree must see the install's kill switches), and it is exactly what defeats us here:
//
//   assert-not-live-install.ts   keeps the suite OUT of the live checkout
//   resolve_local_llm_state_dir  sends this one file's writes back INTO the live install
//
// Two mechanisms, each right on its own, wrong in combination -- so the suite ran from a
// worktree as designed and still appended to the production ledger. Measured before the fix:
// 232 rows of agent=test-agent/model=test-model in store/local-llm-usage.log, the newest written
// less than two minutes earlier by a routine landing's fleet-test run. They surfaced on the
// operator's Overview swimlane as a third "model" beside the two real ones.
//
// WHY HERE AND NOT IN THE TWELVE TEST FILES. Twelve suites currently exec the script without
// isolating state; patching each one fixes today and not tomorrow, because the thirteenth test
// to spawn that script reintroduces it silently and the only symptom is fake rows in a chart
// nobody cross-checks. The resolver already documents `env` as the branch that "wins outright,
// for tests and any future layout" -- this uses it, once, for every worker.
//
// A test that needs a specific state directory still overrides it: passing LOCAL_LLM_STATE_DIR
// in the child's own env beats the value inherited from here (that is how
// local-llm-state-dir.test.ts drives the resolver's other branches).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Per-worker, and NOT cleaned up on exit: these directories are tiny, and a leftover one is a
// readable record of what a failing run wrote. The OS reclaims /tmp; a rmSync in an exit handler
// would race the very subprocesses whose output we would want to look at.
const workerTmp = mkdtempSync(join(tmpdir(), 'marveen-test-llm-state-'))

process.env.LOCAL_LLM_STATE_DIR = workerTmp

// THE SAME ARGUMENT, ONE AXIS OVER: the GPU LOCK (card f3b219bb).
//
// store/local-llm.sh resolves `GPU_LOCK="${LOCAL_LLM_GPU_LOCK_PATH:-/tmp/local-llm-gpu.lock}"`, so
// a suite that execs the real script without overriding it takes the LIVE, fleet-wide lock that
// every other agent's genuine local-llm.sh call is competing for. Under real fleet contention the
// script gives up with `gpu lock busy -- could not acquire within 30s` and exits 6, which fails the
// landing over load, not over any code change.
//
// Commit da76583c (this card's first round) fixed the TWO files that had flaked at the time, one by
// one. That is the
// approach the STATE_DIR half of this very file already rejected in writing -- "patching each one
// fixes today and not tomorrow, because the thirteenth test to spawn that script reintroduces it
// silently". It duly did not hold: measured on develop before this change, four suites that
// actually exec local-llm.sh still took the real lock (advisory-envelope, build-freshness,
// local-llm-host-guard, local-llm-state-dir). Setting it here, once per worker, is the same fix the
// state directory already got, for the same reason.
//
// A test that is genuinely ABOUT the shared lock still overrides it in the CHILD's own env, which
// beats what is inherited from here -- that is how local-llm-sh-active-task-registration.test.ts
// (card 8a6de2ee) keeps testing real cross-process contention on a throwaway path of its own.
process.env.LOCAL_LLM_GPU_LOCK_PATH = join(workerTmp, 'gpu.lock')

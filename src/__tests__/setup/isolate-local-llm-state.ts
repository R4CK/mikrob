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

// A THIRD AXIS, the SAME argument again: VRAM (card 6b1020ff).
//
// card-build-route.sh, gate-pretriage.sh, i18n-draft.sh, local-llm.sh (both directly and via its
// `generate` mode's own choke-point, card 234306ca), local-llm-rag.sh, offload-dispatch.sh and
// route-classify.sh each resolve their own `*_VRAM_GUARD="${OVERRIDE:-$HERE/vram-guard-check.sh}"`
// and, when the file exists, run it and read the REAL host's nvidia-smi. A suite that execs one of
// these scripts without overriding it is therefore graded on the SHARED HOST'S CURRENT GPU STATE,
// not on the behaviour it is testing. Measured failing live (2026-09-25): with the Windows side of
// this WSL host holding ~5.4/6.1 GiB of VRAM -- foreign to the fleet, indefinite duration, nothing
// this repo controls -- three unrelated suites (route-classify-gpu-busy-early-exit,
// local-llm-sh-generate-timeout-safety-net, local-llm-sh-gpu-abstain) failed on three different
// assertions, none of them about VRAM. The gpu-abstain CONTROL case is the sharpest instance: it
// asserts exit code 5 (a genuine call failure) specifically to prove exit 6 is EXCLUSIVE to flock
// contention, and the VRAM choke-point's exit 6 (a deliberate reuse of the same code, see
// local-llm.sh) defeats that proof outright under a busy host GPU.
//
// Same fix as the two axes above, once per worker rather than patched into each of the (currently
// six, and growing) call sites: point every override at a path that cannot exist. Each script's own
// `[ -f "$VRAM_GUARD" ]` / `[[ -f "$VRAM_GUARD" ]]` check then skips the block entirely -- the
// documented behaviour for "no guard installed" (case (a) in vram-guard-check.sh's own header), not
// a new code path invented for tests.
//
// A test that is genuinely ABOUT VRAM pressure still overrides the relevant variable in the CHILD's
// own env (see local-llm-vram-choke-point.test.ts), which beats what is inherited from here.
const noSuchVramGuard = join(workerTmp, 'no-such-vram-guard')
process.env.LOCAL_LLM_VRAM_GUARD = noSuchVramGuard
process.env.ROUTE_CLASSIFY_VRAM_GUARD = noSuchVramGuard
process.env.CARD_BUILD_ROUTE_VRAM_GUARD = noSuchVramGuard
process.env.PRETRIAGE_VRAM_GUARD = noSuchVramGuard
process.env.I18N_DRAFT_VRAM_GUARD = noSuchVramGuard
process.env.OFFLOAD_VRAM_GUARD = noSuchVramGuard

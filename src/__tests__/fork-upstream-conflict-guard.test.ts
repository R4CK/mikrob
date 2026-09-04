// Card 641aca3f: guard that a future `git merge upstream/develop` gives ZERO conflicts on the
// fork-owned web files (web/app.js, web/lang/{hu,en}.js, web/style.css). See the "Upstream-owned vs
// fork-owned fájlok" README section for the full investigation.
//
// Card f085fd44 widened it. The original guard could only see the four files it was told about, and
// that is exactly what went wrong: three OTHER files were conflicting -- one of them behaviour-
// critical (src/model-fallback.ts, where a wholesale merge in either direction either reintroduces
// a fleet-wide false positive or drops a real detection) -- and nothing was watching them. So the
// question this file answers is no longer "do these four still merge cleanly" but "is every
// conflicting file one we have already decided how to resolve".
//
// The premise this test enforces was MEASURED, not assumed: a real `git merge --no-commit --no-ff
// upstream/develop` dry-run (throwaway worktree, never touching the real checkout) currently gives
// zero conflicts on those files -- upstream and the fork's ~496 web/app.js references live in
// different regions of the same 18.5k-line bundler-less global script. A prior investigation (this
// same card) found no clean way to physically extract the fork's interleaved code into a separate
// overlay file without a hook framework the plain-script app does not have, and the measured
// conflict count did not justify inventing one. So instead of moving code, this test keeps the
// zero-conflict CLAIM itself honest over time: if a future upstream commit starts touching the same
// region as the fork code, this goes red BEFORE a real merge attempt surprises anyone.
//
// Network-dependent (needs the `upstream` remote reachable) and mutates nothing in the real
// checkout -- all git operations run inside a throwaway worktree under a fresh temp dir, removed in
// finally. Skips (not fails) when upstream is unreachable, same "always-armed meta-test states the
// reason out loud" discipline as REPO_UNDER_TMP-gated suites (see helpers/repo-location.ts).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const UPSTREAM_REMOTE = 'upstream'
const UPSTREAM_BRANCH = 'develop'
const FETCH_TIMEOUT_MS = 20_000

// The fork-owned web files the card named as the conflict risk. Kept as an explicit list (not
// derived) because "which files are fork-owned" is a human/architectural judgement, not something
// git state can compute -- the guard's job is to check THESE specific files stay conflict-free, not
// to discover the list.
//
// web/app.js moved OUT of this list to ACKNOWLEDGED_CONFLICTS (card 2e634e5c, 2026-08-17): the
// zero-conflict claim stopped holding once the fork's app.js modularisation (36 extracted
// web/app-*.js slices, STUB markers left behind) landed on content upstream still edits inline.
// See the ACKNOWLEDGED_CONFLICTS entry below for the measured resolution policy -- this is not a
// regression, it is the expected cost of the extraction, same character as
// src/web/update-checker.ts's entry.
//
// web/style.css moved OUT to ACKNOWLEDGED_CONFLICTS too (measured 2026-09-01, heartbeat
// reconciliation ahead of card 0f7f7fe9's land): same pattern as web/app.js, one insertion point.
// See the ACKNOWLEDGED_CONFLICTS entry below.
const GUARDED_FILES = ['web/lang/hu.js', 'web/lang/en.js'] as const

// Files that DO conflict today, deliberately, and whose resolution rule is written down (card
// f085fd44). This list is not a second copy of the one above: those files must never conflict,
// these are KNOWN to, and the point of naming them is that the resolution is a decision someone
// already made rather than one improvised mid-merge.
//
// They are listed here for one reason -- so the check below can be about the WHOLE conflict set
// rather than four hand-picked files. Before this, a manual list of four could only ever see what
// it already knew about: three files conflicted for weeks with nothing watching them, and the only
// reason anyone noticed was a human running the dry-run by hand.
const ACKNOWLEDGED_CONFLICTS = {
  // Card 684dda18, self-created 2026-09-02: adopting upstream's resolveKanbanDispatch()
  // (session-down is no longer a silent no-op) appended the fork's own isSelfAdvanceMove/
  // isGenuineSelfAdvanceSwitch below it -- the fork's file is now a strict superset of upstream's
  // (verified: diffing the shared prefix shows zero divergence, the only delta is the fork-only
  // tail). Resolution: keep the fork version wholesale, it already contains everything upstream
  // has plus the fork-only additions.
  'src/kanban-dispatch.ts':
    "keep the fork version wholesale -- it is upstream's resolveKanbanDispatch verbatim plus the fork-only isSelfAdvanceMove/isGenuineSelfAdvanceSwitch appended after, zero divergence on the shared part",
  // Card 684dda18, self-created 2026-09-02 (add/add): ported this test file from upstream
  // (kanban-dispatch-rearm.test.ts) to cover the db.ts dispatched_at re-arm fix, adapting ONE case
  // to pass force:true on a waiting->in_progress reopen -- the fork's own reviewedCardBlocksInProgress
  // gate (card c4f2de32) blocks that transition without a gate-verdict comment, which upstream has
  // no equivalent of. Everything else is byte-identical to upstream's version.
  'src/__tests__/kanban-dispatch-rearm.test.ts':
    "keep the fork version wholesale -- identical to upstream except the one move() call the fork's reviewedCardBlocksInProgress gate (card c4f2de32) requires force:true on",
  // New conflict (measured 2026-08-26, card b4a7c9c3-adjacent unblock, not caused by that card's
  // own diff): upstream added two new exports to this file -- OPEN_QUESTION_DEFERRAL_CAP_MS and
  // deferralOverride() -- at a point where the fork side of the hunk is EMPTY (the fork's
  // restartBlockedBy() has no successor in this file yet). This is the SAME open-question-deferral
  // feature the src/web/auto-restart-runner.ts entry below already documents as "adopted, purely
  // additive, no fork-side conflict" (re-read 2026-08-26) -- that entry's decision already covers
  // this file's content, it just never got its own key here because src/auto-restart.ts itself had
  // not started conflicting yet. Resolution: adopt both new exports verbatim, nothing to merge
  // against on the fork side.
  'src/auto-restart.ts':
    'adopt upstream OPEN_QUESTION_DEFERRAL_CAP_MS + deferralOverride() verbatim -- fork side of the hunk is empty, and this is the same open-question-deferral feature already adopted per the src/web/auto-restart-runner.ts entry',
  // BEHAVIOUR-CRITICAL. The fork removed "upgrade to increase your usage limit" from the
  // usage-limit regex (2026-06-30: it matched Claude Code's /upgrade STARTUP HINT, so fresh agents
  // read as limited and got needlessly downgraded). Upstream still has that token AND added a real
  // "session limit" variant (2026-08-08). Resolution: ADOPT the session-limit alternative, KEEP the
  // /upgrade removal. Neither side's file may be taken wholesale -- see the pinned pair in
  // model-fallback.test.ts ("keeps BOTH halves of the fork/upstream resolution at once").
  'src/model-fallback.ts':
    'take upstream session-limit alternative, keep the fork /upgrade removal (never a wholesale side) Round 2 (2026-09-02, fron-ted, landing 5dd4a211, d1ed3c18ba86..93ea8f17a6c9): upstream widened the same regex with the weekly/session wordings measured 2026-08-18 (reached your weekly limit, approaching ... weekly limit, (weekly|session) limit reached) -- adopt those alternatives too; the /upgrade token is STILL present upstream and STILL dropped here. Same principle: union of detections minus the startup-hint false positive.',
  // The test file diverges with the module it tests: fork-only weekly-tier tests plus the pinned
  // resolution pair above. Resolution: keep both sides' cases, drop neither.
  'src/__tests__/model-fallback.test.ts':
    'union of both sides cases -- fork weekly-tier + upstream additions Round 2 (2026-09-02, 38b6e76e9f51..09bc3bf772d1): upstream added one case for the weekly/session wordings; union unchanged, keep it with the fork cases.',
  // The fork restructured this file into a MULTI-REPO aggregate (marveen + mikrob blocks, per-repo
  // results in `repos`); upstream kept the single-result shape and is still adding features to it,
  // e.g. the running `version` in the Updates header (upstream aefa693). So it is not "fork parts
  // are additive" in either direction -- measured 2026-08-14, the fork side currently LACKS that
  // version field. Resolution: keep the fork's aggregate structure, and port upstream's new
  // single-result features onto it one by one.
  'src/web/update-checker.ts':
    'keep the fork aggregate shape, port upstream single-result features onto it' +
    "Re-measured 2026-09-03 (backend2, card 934dc104 landing-block, 24e46f990c7b..c98efe359fd0): upstream reworked its SINGLE-repo checker -- parseGitHubRemote() now prefers an `upstream` remote over `origin` (a fork otherwise asks itself about itself and stays silent forever), branchOnRemote()/remoteIsOwnOrigin() pick the right branch to query, and upstreamMergeBase() takes a base the queried remote actually knows instead of reporting fork-distance. The rule is unchanged and now has concrete work behind it: these are exactly the 'single-result features' to port onto the fork's aggregate shape. Blob bumped.",
  // ORIGINAL entry (2026-08-16, card 78c14372) merged `agentDir` (fork) + `readAgentClaudeConfigDir`
  // (upstream) onto one import line. RE-MEASURED 2026-09-01 (heartbeat reconciliation): upstream
  // replaced its own `readAgentClaudeConfigDir` with `resolveAgentConfigDirForRead` (new module,
  // ./claude-plans.js) -- confirmed by reading configDirFor()'s own comment in the merged body
  // (line ~143): the old helper returned a stale transcript on an auto-provisioned agent dir
  // instead of null, "worse than the null this comment warns about, because the gate then believes
  // it can see". `readAgentClaudeConfigDir` has zero remaining call sites in this file (grep
  // confirms) -- dead after the replacement. Upstream also added `sendPromptToSession` to the
  // agent-process.js import, used at the (unconflicted, auto-merged) wake-delivery call site
  // ~line 571. `agentDir` (fork) is still used (line ~130) and stays. Resolution: three import
  // lines -- `{ listAgentNames, agentDir } from './agent-config.js'`,
  // `{ resolveAgentConfigDirForRead } from './claude-plans.js'`,
  // `{ agentSessionName, capturePane, sendPromptToSession } from './agent-process.js'` -- drop
  // `readAgentClaudeConfigDir` (dead, superseded), adopt both new upstream imports (their usage
  // sites already merged in clean, this was only ever the import line colliding).
  'src/web/context-restart-gate-runner.ts':
    "three import lines: { listAgentNames, agentDir } from './agent-config.js' (fork's agentDir stays, still used), { resolveAgentConfigDirForRead } from './claude-plans.js' (upstream, replaces the now-dead readAgentClaudeConfigDir -- fixed a stale-transcript bug), { agentSessionName, capturePane, sendPromptToSession } from './agent-process.js' (upstream's sendPromptToSession, used at the wake-delivery call site) -- drop readAgentClaudeConfigDir entirely, zero remaining call sites Re-read 2026-09-03 (card 3bd18e70, blob 268fc2e6): upstream replaced sendPromptToSession with sendSystemDirective from './system-directive.js' at the wake-delivery call site (GUARDHITELES903); that import line and the call site sit outside the conflict hunk and auto-merge, so the only conflicting hunk is still the agent-config/claude-plans import pair -- resolve as above, drop readAgentClaudeConfigDir.",
  // The SAME one-line import class as the entry above, one file over (measured 2026-08-22 on
  // upstream/develop 317937dc). Both sides appended a binding to the SAME import from
  // './web/agent-scaffold.js': the fork's `ensureNpmProtectGuard`, upstream's
  // `ensureSkillsPathTrapSection`. Nothing else in the 400-line file diverges, and neither name
  // exists on the other side, so there is nothing to weigh. Resolution: keep both bindings on one
  // line. Taking either side wholesale silently drops a guard or a warning nobody would miss until
  // it failed to appear.
  // Re-read 2026-08-25 (card 9ef96512, blob 79ba29b7): upstream now also imports
  // watchEgressAllowlistForReaderRender and wires a call in the same hookDecision.register
  // branch (EGRESSRENDER824). Import line conflict grows: fork adds ensureNpmProtectGuard,
  // upstream now adds ensureSkillsPathTrapSection + watchEgressAllowlistForReaderRender.
  // Adopt the watcher call alongside the merged import.
  // Re-read 2026-08-26 (card fbb36b41): upstream added listAllAgentNames to the same
  // agent-config import (HBGATEWIRE826 -- hidden/technical agents were skipping
  // hook-seeding because the hook-seed loop used listAgentNames, which filters
  // .hidden-from-dashboard; heartbeat-worker then ran with zero dashboard-side
  // hooks). listAgentNames stays imported too -- a SEPARATE, unrelated call
  // (watchEgressAllowlistForReaderRender) still legitimately wants the
  // dashboard-visible-only list. Adopted: merged import with BOTH names, swapped
  // only the hook-seed loop's call site to listAllAgentNames(). Still a single
  // hunk, no other conflict in the file. Landed via the F5 cutover merge (72f5f13b).
  // Re-read 2026-09-01 (heartbeat reconciliation, blob moved to 42406c87): upstream added ONE more
  // import to the same merged line -- ensureAgentProvenanceHook -- plus a cosmetic comment-casing
  // hunk (upstream: "listALLAgentNames", fork: "listAllAgentNames"; camelCase is the real symbol
  // name, kept as-is). Verified the new import's call-site (`agent-scaffold.ts` line ~523) is NOT a
  // fork call-site at all today (grep: fork src/web.ts never calls it) and merges CLEANLY on its own
  // (not one of this file's two conflict hunks) -- so adopting the import is the only change this
  // hunk needs. Checked what it does: an idempotent per-agent hook installer (settings.json
  // UserPromptSubmit, guarded by isUnsafeHookCommand, same shape as the fork's own
  // ensureNpmProtectGuard/ensureBlastRadiusGuard installers) -- additive, no fork-side conflict.
  'src/web.ts':
    'merge import line (ensureNpmProtectGuard from fork + ensureSkillsPathTrapSection + watchEgressAllowlistForReaderRender + listAllAgentNames + ensureAgentProvenanceHook from upstream, all on one line, keep listAgentNames too), adopt upstream watchEgressAllowlistForReaderRender call (EGRESSRENDER824), the hook-seed loop\'s listAllAgentNames call-site swap (HBGATEWIRE826), and the new ensureAgentProvenanceHook import (its call-site auto-merges cleanly, verified additive/idempotent) -- keep fork\'s "listAllAgentNames" comment casing, no other conflict in the file Re-read 2026-09-03 (card 3bd18e70, blob 6ed7224c): upstream added ensureSystemDirectiveAuthSection to the same agent-scaffold import (GUARDHITELES903) -- merge it onto the one import line too; its ensureSystemDirectiveAuthSection(MAIN_AGENT_ID) call, the new tryHandleHeartbeat import and its route-chain call are additive and auto-merge. Same conflict, one more name.' +
    "Re-measured 2026-09-03 (backend2, card 934dc104 landing-block, 6ed7224c0882..a515f9c8750b): upstream added a desktop-lock route (its own import line, one route-chain call, one 60s TTL sweeper). None of it touches the agent-scaffold import line this rule is about; all three hunks are additive and auto-merge. Resolution unchanged; blob bumped.",
  // The call-site half of the same upstream change, and the same INDEPENDENT-ADDITIVE class as
  // src/db.ts below rather than a disagreement (measured 2026-08-22). Two hunks, both caused by the
  // two sides adding a DIFFERENT CLAUDE.md section-writer at the same insertion point, each with
  // its own BEGIN/END markers and its own regex: the fork's `ensureLocalFirstSection` (the
  // local-LLM-first standing reminder, card 3828a2b6) and upstream's `ensureSkillsPathTrapSection`
  // (the `.claude-config/skills` symlink trap, SKILLUTCSAPDA822). They follow the same five-rule
  // idempotency contract, write disjoint marker pairs, and neither reads or overwrites what the
  // other writes -- both blocks can coexist in one CLAUDE.md, which is what an agent should get.
  // Resolution: keep BOTH functions, either order -- union, not a pick -- and add both to the
  // startAgentProcess() call chain. The second hunk is only the two functions' shared tail
  // (read/replace-or-append/write); keeping both bodies gives each its own copy of it.
  // NOT a fork-vs-upstream disagreement about the same code: the two sides changed
  // DIFFERENT things in one file (measured 2026-08-23 against upstream/develop, merge-base
  // ea7ed17c). Fork side: e48a6075 deleted keychainDelete() as verified-dead (card 9568c04b)
  // and touched nothing else. Upstream side: a real availability/security fix -- a 5s timeout
  // on every `security` call (a locked keychain pops a GUI prompt and blocks forever;
  // VAULTKEY822 measured a 48-minute HTTP outage from exactly that) plus keychainRetrieveStatus(),
  // which separates errSecItemNotFound ("the keychain answered, there is no key") from every
  // other failure, so a locked keychain can no longer read as "no key" and trigger a silent key
  // swap (VAULTUJKULCS822). Upstream also re-added keychainDelete() with the timeout.
  // Measured on upstream/develop: keychainRetrieveStatus IS live (src/web/vault.ts:102), while
  // keychainDelete has NO production caller there either -- its only reference is a mock stub in
  // vault-master-key.test.ts, so the fork's dead-code finding still holds on both sides.
  // Resolution: ADOPT the timeout + keychainRetrieveStatus + the errSecItemNotFound distinction,
  // KEEP the fork's deletion of keychainDelete. Neither side wholesale: taking the fork's would
  // drop a fix for a measured outage, taking upstream's would resurrect dead code the fork
  // deliberately removed. If keychainDelete ever gains a real caller upstream, it comes back
  // WITH that caller, not before. (The extra key in the upstream test's mock factory is
  // harmless -- vi.mock does not check the factory against the real module's exports.)
  'src/web/keychain.ts':
    'adopt the upstream timeout + keychainRetrieveStatus + errSecItemNotFound handling, keep the fork deletion of the dead keychainDelete -- never a wholesale side',
  // Re-read 2026-08-25 (card 9ef96512, blob 3082c145): upstream grew significantly --
  // kanban-write gate (agentGetsKanbanWriteGate/injectKanbanWriteGate, heartbeat-only),
  // quarantineReader refactor to project scope (EGRESSRENDER824: main-agent reader now in
  // PROJECT_ROOT/.claude/agents for live-reload on spawn, not ~/.claude/agents), legacy cleanup,
  // and watchEgressAllowlistForReaderRender (file-watcher re-renders reader prompt on
  // egress-allowlist.json change). All additive. Section-writer rule still applies for the
  // ensureLocalFirstSection / ensureSkillsPathTrapSection conflict. Extend to ADOPT the
  // kanban-write gate, quarantineReader project-scope refactor, and watcher from upstream
  // alongside the fork's section-writer, neither side taken wholesale.
  'src/web/agent-scaffold.ts':
    "keep BOTH section-writers (fork ensureLocalFirstSection + upstream ensureSkillsPathTrapSection), AND adopt upstream kanban-write gate (agentGetsKanbanWriteGate/injectKanbanWriteGate), quarantineReader project-scope refactor (EGRESSRENDER824), and watchEgressAllowlistForReaderRender -- all additive, none taken wholesale. Re-read 2026-08-26 (card 72f5f13b, unblocking fbb36b41/489dae5f landings): upstream moved AGAIN since this rule was written (added findDuplicateJsonKeys dup-key detection in ensureAgentHooks, HEARTBEAT_AGENT_ID import, EMAIL_GATE_MATCHER/emailGateMatcherStale export) -- 22 diff hunks total against a 1600-line security-critical file (fleet-wide hook wiring: git-protect/npm-protect/blast-radius/pentest-install guards live here). NOT safe to hand-merge under time pressure just to unblock a landing. The fork's own guards (git-protect/npm-protect/blast-radius/pentest-install, unchanged in this diff) remain authoritative and untouched on live develop. Full reconciliation of ALL upstream additions (this round's + the previously-acknowledged kanban-write-gate round) is done and build+test-verified in the disposable card-72f5f13b merge worktree, pending the Peti-supervised F5 cutover (card 5c134edf) -- that is where this file's real sync lands, not a piecemeal live-develop patch." +
    "Re-measured 2026-09-03 (backend2, card 6500e1d3 landing-block, 2a72fb5c7f38..936cdac15d5c): upstream threaded a new AGENT_API_ORIGIN through resolveDashboardOrigin, giving it a third parameter and the precedence AGENT_API_ORIGIN > DASHBOARD_PUBLIC_URL > localhost. Its reason is measured, not stylistic: on a single-host install behind hairpin NAT the public name resolved but its 443 was unreachable FROM THE HOST, so 73 generated curl examples across 18 agent CLAUDE.md files pointed at a dead address and returned curl exit 7 -- nothing the agent could even surface. An empty AGENT_API_ORIGIN keeps the old behaviour byte-for-byte. None of it touches the section-writers, the kanban-write gate or the quarantineReader scope that this rule decides. Resolution unchanged; blob bumped. The 'not safe to hand-merge under time pressure' warning above STILL STANDS and is not weakened by this bump. FORK-ONLY additions to keep across any future reconciliation (cards ab4c85f2 + 5c5d7bc4, not upstream's): the ensureSystemDirectiveAuthSection section-writer with its BEGIN/END markers and buildSystemDirectiveAuthBody, plus the import of SYSTEM_DIRECTIVE_SENDER from './system-directive-id.js' that body interpolates. That import is the point, not decoration: the scaffold recipe must name the SAME id routes/messages.ts reserves, or agents are sent to verify a field nobody rejects. Upstream has neither the section nor the const module.",
  // ORIGINAL entry (2026-08-16, card 88505fb5) described a schema-migration/trigger hunk in
  // ensureSchema() -- that hunk no longer conflicts (both sides' migrations merged clean since).
  // RE-MEASURED 2026-09-01 (heartbeat reconciliation): the file conflicts again, but at a totally
  // different spot -- moveKanbanCard(), and it is a comment-only collision, zero code divergence.
  // Fork's comment documents `depBlocked`/`isForceActor` (card a8aa9ae5, the dependency-block +
  // force-actor guard) immediately above it. Upstream's comment documents the `dispatched_at=NULL`
  // clear-on-non-in_progress-move -- but that SQL branch is UNCHANGED, shared ancestor code a few
  // lines below the conflict marker, already identical on both sides; upstream is just adding
  // documentation for behavior the fork already has, not proposing new behavior. Resolution: keep
  // the fork's comment (it explains code that follows inside the marker) AND append upstream's
  // comment right before the `db.prepare(status === 'in_progress' ? ... : ...)` line it describes
  // -- both coexist, no functional change either way.
  'src/db.ts':
    "comment-only collision at moveKanbanCard(), zero code divergence -- keep fork's depBlocked/isForceActor comment (a8aa9ae5) AND append upstream's dispatched_at=NULL clear-on-move comment just above the db.prepare() branch it documents (that SQL is already identical/shared on both sides)." +
    " Re-measured 2026-09-02 (MikroB landing-block, QA stale-blob catch 9a9dc8394559..59fbb9d1d82b): upstream moved again, but entirely elsewhere in the file (EMAILKAPU901 PR2 -- content_hash/consumed_at columns and plumbing on the approvals table, a one-shot-consumption anchor for its email-approval gate). Zero overlap with moveKanbanCard(); resolution at the actual conflict point is unchanged. Re-measured AGAIN 2026-09-02 (Cybersec, card 9dc0fba8 landing-block, 59fbb9d1d82b..d15ec3aba7a1): upstream moved once more and again elsewhere -- updateKanbanCard() now writes a kanban_card_events row on a real status transition and takes an `actor` argument. The only occurrence of moveKanbanCard in that diff is inside a NEW COMMENT (\'audited exactly like one made through moveKanbanCard\'), not at the conflict point. Resolution unchanged; blob bumped. Re-measured a THIRD time 2026-09-02 (fron-ted, landing 5dd4a211, d15ec3aba7a1..61dc38447a22): upstream added touchAncestorChain() (parent updated_at bubbling from createKanbanCard/updateKanbanCard, cycle/depth guarded) -- additive, elsewhere in the file, no line of moveKanbanCard() touched. Resolution unchanged; blob bumped." +
    "Re-measured 2026-09-03 (backend2, card 934dc104 landing-block, 61dc38447a22..6a71eab9ab67): upstream added countNewerMessagesFromSameSender() after markMessageDelivered() -- the DB half of its freshness/supersession signal (see the src/web/message-router.ts entry, which keeps that feature alongside the fork's staleness note). Additive, nowhere near moveKanbanCard(). Resolution unchanged; blob bumped." +
    "Re-measured 2026-09-04 (backend, card 5bee4b22 landing-block, 6a71eab9ab67..cf4c1052f7ef): upstream made saveMemory() fire-and-forget an embedding after the INSERT (mirroring saveAgentMemory), so rows written through that path -- the nightly daily-log digest among them -- stop being left unvectorised. 13 lines added inside saveMemory(), one turned into `const info =`. moveKanbanCard() does not appear in the diff at all. Resolution unchanged; blob bumped.",
  // Card 2e634e5c. Both sides independently fixed the SAME ghost-session bug (agent DELETE leaving
  // an orphaned tmux session), but the fork's fix is strictly more correct: it AWAITS
  // stopAgentProcess(), tracks the result, and logs on failure; upstream's is a floating (un-awaited)
  // call to the same async function -- the exact race its own comment warns against ("must run while
  // the dir still exists"), since rmSync(dir) right after can start before the un-awaited stop
  // finishes reading the config. Measured 2026-08-16. Resolution: keep the fork's version wholesale,
  // upstream adds nothing the fork lacks here.
  'src/web/routes/agents.ts':
    'keep the fork version wholesale -- it already awaits stopAgentProcess() and tracks/logs the result; upstream is an un-awaited (racy) reimplementation of the same fix' +
    "Re-measured 2026-09-03 (backend2, card 934dc104 landing-block, 7711d18a7752..4b7a61e33448) and the rule needed SHARPENING, not just a bump. 'Keep the fork version wholesale' was written about ONE hunk (the awaited stopAgentProcess()), and read literally against today's blob it would now discard two unrelated upstream additions: MiniMax direct-API gating in /api/models/available, and the freshness/supersession annotation on the main-agent inbox-drain path (the same feature acknowledged in src/web/message-router.ts and src/db.ts). Corrected rule: at the stopAgentProcess conflict point keep the FORK side (it awaits and logs; upstream's is an un-awaited reimplementation of the same fix); everywhere else in this file the sides are additive -- keep both.",
  // Card 2e634e5c, re-measured 2026-09-02 (card 684dda18): the dispatch-instruction-text generator
  // hunk still resolves the same direction as before (upstream's variant tells the agent to move its
  // OWN card straight to `"status":"done"`, which contradicts fork rule 4 that a builder never
  // self-closes to done -- keep the fork's `"status":"waiting"` text). The OTHER two hunks are now a
  // genuine two-way merge, not a wholesale fork pick: upstream refactored
  // resolveKanbanDispatchTarget() into resolveKanbanDispatch(), which surfaces a 'session-down'
  // reason instead of silently dropping the dispatch when the assignee's tmux session is not
  // running, paired with a new reportUndeliveredDispatch() that leaves a card comment + pings
  // MAIN_AGENT_ID. That is a real reliability fix (a down session used to hold a card in_progress
  // forever with zero signal -- exactly the class of stuck-card this fork's own gate-reconciler
  // heartbeat has to work around by polling) and does not touch the fork-only self-advance dispatch-
  // echo suppression (isSelfAdvanceMove/isGenuineSelfAdvanceSwitch, which returns before ever
  // reaching resolveKanbanDispatch) or the newDevStopWouldBlock/landedGuardVerdict gates in the
  // /move handler (neither lives inside this function, unaffected). Resolution: adopt
  // resolveKanbanDispatch + reportUndeliveredDispatch verbatim, keep the fork's self-advance block
  // and /clear-before-switch call wholesale, catch-block also reports undelivered on dispatch error.
  // src/kanban-dispatch.ts auto-merges with zero conflict (upstream's insertion and the fork's
  // isSelfAdvanceMove/isGenuineSelfAdvanceSwitch appendix sit in non-overlapping regions) so it is
  // not itself a guarded/acknowledged file. Also ported upstream's src/db.ts companion fix (see that
  // entry above) and its two new contract tests (kanban-dispatch-rearm.test.ts,
  // kanban-dispatch-silent-noop.test.ts), adapting one rearm-test case to pass `force: true` on the
  // reopen -- reopening a `waiting` card without a verdict is blocked by the fork-only
  // reviewedCardBlocksInProgress() gate (card c4f2de32), which upstream has no equivalent of.
  'src/web/routes/kanban.ts':
    "dispatch-text hunk: keep the fork's waiting-text wholesale (fork rule 4, no self-close-to-done). Other two hunks: adopt upstream's resolveKanbanDispatch + reportUndeliveredDispatch (session-down is no longer a silent no-op), keep the fork's self-advance suppression + /clear-before-switch wholesale alongside it -- non-overlapping concerns, not a fork-vs-upstream pick. Re-measured 2026-09-02 (Cybersec, card 9dc0fba8 landing-block, 00ec734f520d..89423d29b8af): upstream moved, entirely outside all three recorded hunks -- it fixed the POST handler so a caller-supplied card id wins in the row AND in the response (it used to store the supplied id and echo the generated one, HTTP 200 pointing at a card that does not exist), and it lifts `actor` out of the field set for db.ts\'s new audit event. Zero hits on resolveKanbanDispatch, reportUndeliveredDispatch, the waiting-text hunk, the self-advance suppression or the /clear-before-switch block. Resolution at the conflict points unchanged; blob bumped.",
  // Card 2e634e5c, fourth file. A genuine two-way merge, not a wholesale pick either direction:
  // the fork owns Firecrawl namespace default-deny + FIRECRAWL_SCRAPE_ALLOWED_KEYS param-allowlist
  // (card 91c4a369); upstream owns the tier-based egressDecision({blocked,tier}) shape, agentType
  // parameter, QUARANTINE_DOMAINS + quarantine_domains runtime list, and ALLOWED_QUARANTINE audit
  // logging. Taking upstream's egressDecision wholesale would reopen 91c4a369: its own function
  // starts `if (toolName !== 'WebFetch') return {blocked:false, tier:'not-webfetch'}`, which makes
  // every mcp__firecrawl__* call blocked:false immediately. Taking the fork's isEgressBlocked
  // wholesale would lose the quarantine tier + audit logging entirely. Resolution: the Firecrawl
  // namespace/param checks run FIRST, the not-webfetch early-return only after those, URL-based
  // tiers next, and the quarantine tier LAST -- deliberately widened to cover the two URL-bearing
  // Firecrawl tools too (not just WebFetch), because the quarantine-reader sub-agent's own `tools:`
  // line lists firecrawl_scrape/firecrawl_map alongside WebFetch (verified in
  // templates/sub-agents/quarantine-reader.md and every agents/*/.claude/agents/ copy) -- a tier
  // that only widened WebFetch would leave the sub-agent's other declared tool stuck on the
  // ordinary allowlist. Co-planned with Cybersec (card 2e634e5c); independently verified here
  // (read both source files, confirmed the quarantine-reader tools: line, ran both test suites).
  // Re-read 2026-08-25 (card 9ef96512, blob 229076d5): upstream only added a comment explaining
  // EGRESSRENDER824 grant latency (no structural/logic change). Merge strategy unchanged.
  'scripts/hooks/egress-gate.mjs':
    "merge both sides in one egressDecision() -- fork Firecrawl namespace-default-deny + param-allowlist (91c4a369) run BEFORE upstream's not-webfetch early-return (which would otherwise reopen 91c4a369), then upstream's tier-based decision + quarantine tier + audit logging, with the quarantine tier extended to the two URL-bearing Firecrawl tools",
  // The test file for the entry above, same relationship as model-fallback.ts/.test.ts: the fork
  // added a case (card 5cd87b6f -- github.com/raw.githubusercontent.com reachable through the
  // quarantine tier) at a spot where upstream's side adds nothing (measured 2026-08-17, real merge
  // dry-run: the upstream half of the hunk is empty). Resolution: keep the fork's added case,
  // nothing to take from upstream at this hunk.
  'src/__tests__/egress-gate.test.ts':
    'keep the fork-added github.com/raw.githubusercontent.com case (card 5cd87b6f) -- upstream side of this hunk is empty, nothing to merge in',
  // Card 2e634e5c. NOT a disagreement -- upstream independently built the runner-side measurement
  // wiring (configDirFor/measureContextTokens/measureIdleMs) that the fork's OWN idle-flush domain
  // logic (src/context-guard.ts: idleFlushEnabled/idleFlushTokens, already shipped and tested) has
  // been waiting for; the fork's context-guard-runner.ts never wired it up. Straight port, ONE real
  // adaptation required: this fork's `readContextTokensFromProjectDir` is ASYNC (an fs/promises
  // read, see active-model.ts), upstream's is sync -- upstream's measureContextTokens (and the
  // shared configDirFor extracted alongside it) must be awaited, matching the fork's existing async
  // measurePct, not copied verbatim as sync. Measured 2026-08-17 (real merge dry-run + read both
  // active-model.ts versions to confirm the sync/async split; the two call sites needing an added
  // `await` are already inside `async function checkAgent`, no further signature changes ripple).
  // Resolution: keep the fork's async measurePct, adopt upstream's configDirFor/measureContextTokens
  // (made async)/measureIdleMs verbatim otherwise, await the two new call sites.
  'src/web/context-guard-runner.ts':
    "keep the fork async measurePct/configDirFor; adopt upstream measureContextTokens+measureIdleMs to wire the fork's existing idleFlushEnabled domain logic, making measureContextTokens async (fork's readContextTokensFromProjectDir is async, upstream's is sync) and awaiting its two call sites in checkAgent" +
    " SHARPENED 2026-09-03 (backend2, card 6500e1d3 landing-block, b17ba4f630db..2876a41d1fb2) -- NOT a plain blob bump: upstream moved AT one of the two points this rule names. configDirFor() now calls resolveAgentConfigDirForRead() instead of readAgentClaudeConfigDir(), because an agent whose config dir was auto-provisioned by the launcher has no field to read and the old call silently returned the host default, i.e. ANOTHER agent's absence. That is a real bug fix and it does not conflict with 'keep the fork's async configDirFor': the two sides change different things about the same function, so keep the fork's async shape and adopt upstream's resolver INSIDE it. Second upstream change, additive and to be adopted: the request-handoff branch of checkAgent now goes through sendSystemDirective instead of a bare sendPromptToSession (GUARDHITELES903) -- a message telling an agent to drop work and stop is indistinguishable from a prompt injection without a queue anchor, and an agent correctly refused one on 2026-09-03.",
  // Card 2e634e5c, fifth file, the largest and the only one NOT fully hand-verified line-by-line --
  // recorded as a POLICY, not a line-by-line merge, same character as the src/web/update-checker.ts
  // entry above. web/app.js is a STUB scaffold: its content was extracted into 36 web/app-*.js
  // slice files (modularisation slices 1-39-ish, see each slice's own "Moved to X as part of
  // modularisation, slice N" header comment), all wired into index.html. Upstream never learned
  // about the extraction and keeps editing the monolithic content inline, so any upstream commit
  // touching an extracted region now conflicts against the STUB comment that replaced it.
  // Measured 2026-08-17 on ONE representative hunk (the i18n-nav block, upstream lines merged
  // against web/app-i18n-nav.js): the fork's slice was a near-total superset of upstream's block
  // (plus fork-only additions -- local-llm nav entry) MINUS one real, missing behavior -- upstream
  // had added a `renderUpdatesVersion(window._updatesStatus)` re-apply call inside
  // renderStaticI18n() so a language switch immediately re-localizes the Updates page's cached
  // "Current: vX.Y.Z" subtitle; the fork's extracted slice lacked it. Ported forward in this same
  // commit (web/app-i18n-nav.js). The remaining ~11,000-line hunk (everything after the i18n-nav
  // block) was NOT hand-audited -- doing so slice-by-slice is a real, separate undertaking, not a
  // five-minute conflict-resolution note. Resolution POLICY until that audit happens: web/app.js's
  // STUB scaffold + the 36 extracted slice files are authoritative; upstream's monolithic content
  // in a conflicting region is superseded by the corresponding slice file and must NOT be taken
  // wholesale -- diff the specific upstream hunk against its named slice file (per the STUB
  // comment) and port only genuinely-new upstream behavior forward, the same discipline just
  // proven on the i18n-nav hunk. A dedicated full-parity audit card (diff all 36 slices against
  // upstream's still-monolithic app.js) is recommended but not opened here -- judgement call for
  // MikroB, not unilaterally opened per the dedup rule.
  'web/app.js':
    'STUB scaffold + 36 extracted web/app-*.js slices are authoritative; a conflicting upstream hunk must be diffed against its named slice file and only genuinely-new upstream behavior ported forward, never taken wholesale -- proven on the i18n-nav hunk (found + fixed one real gap: missing renderUpdatesVersion re-apply on language switch). Re-audited 2026-08-25 (card 9ef96512, blob c8c11f94): 3 upstream hunks, all in the loadOllamaModels / resetWizard / startup-init region (app-settings.js). Ported: (1) loadOllamaModels refactored to populate both optgroups (ollamaModelGroup edit-panel + agentModelOllamaGroup wizard -- wizard was missing local-model option entirely); (2) agentModelOllamaGroup added to wizard HTML (index.html); (3) resetWizard() now calls loadOllamaModels() (app-wizard.js); (4) loadOllamaModels() added to startup init (app-settings.js). No behavioral gap found in any other region. Re-audited 2026-09-02 (card 684dda18, blob e8c74d15): upstream diff since c8c11f94 has 3 hunks -- (1) activity-badge "thinking orb" spinner for state===working (app-activity.js): NOT a gap, the fork already signals "working" via a different mechanism (activity-badge.act-working has its own "breathing" pulse animation in style.css, card predates this) -- adding the orb on top would double-animate the same signal, skipped as redundant. (2) /api/context-guard-fed static badge on Agents-grid cards (app-agents.js): NOT a gap, the fork already has a strictly superior LIVE-POLLED per-agent context HUD (agentHudBlockHtml + GET /api/agent-hud poll, card e9504aba) with a bar + percentage + color tiers, upstream\'s is a page-load-only static badge -- fork mechanism supersedes it. (3) MiniMax direct-API model option (loadAvailableModels, mirrors the existing DeepSeek pattern, gated behind MINIMAX_API_KEY): a genuinely NEW, not-yet-adopted upstream feature needing a backend port too (src/web/routes/agents.ts models endpoint) -- this is an ADOPTION decision, not a passive conflict resolution, so it is NOT folded in here; opened as its own low-priority follow-up card (48565f81) for Peti to decide on. No further behavioral gap found in this increment. Remaining ~11k lines (other regions, prior to c8c11f94) still not yet hand-audited slice-by-slice.',
  // Two independent additive hunks with no behavioral overlap. Fork adds: HEARTBEAT.md ignore,
  // Ingatlan/ runtime data exclusions, and per-extension keep-tracked exceptions for operational
  // scripts (store/*.sh, store/*.py, store/stitch-tools/gen.mjs) by switching store/ → store/*
  // with negation rules. Upstream adds: .pre-ship-evidence/, evidence/, transcripts/,
  // .session-capture/ (EVIDGUARD818 -- captured output never belongs in repo). Resolution: union
  // of both sides -- keep the fork's store/* + negation lines (the fork's more nuanced pattern
  // supersedes upstream's bare store/ line), and append upstream's evidence/transcript ignores.
  '.gitignore':
    'union of both additive sides: keep fork store/* + !store/*.sh/py/stitch negation structure + Ingatlan/ + HEARTBEAT.md, AND append upstream EVIDGUARD818 evidence/transcript/session-capture ignores -- both sides add to non-overlapping regions',
  // Measured 2026-09-01, heartbeat reconciliation ahead of card 0f7f7fe9's land: single hunk, both
  // sides purely additive at the same insertion point in the file, zero semantic overlap. Fork adds
  // .agent-hud* rules (per-agent live HUD: context-pct + active-model, kanban f07c5b7c). Upstream
  // adds .agent-ctx-badge rules (context-window-used badge on the Agents grid card, tiers mirror
  // context-guard's actPct/hardPct). Different class names, different features, neither references
  // or overrides the other. Resolution: keep BOTH blocks verbatim, in either order -- not a
  // wholesale-one-side pick, same "two independent additive hunks" character as the .gitignore
  // entry above, just CSS instead of ignore-patterns.
  'web/style.css':
    'two independent additive hunks, no overlap: keep fork .agent-hud* rules AND upstream .agent-ctx-badge rules verbatim, both blocks, either order',
  // Measured 2026-09-01, same heartbeat reconciliation. Both sides independently arrived at the
  // IDENTICAL functional value (REPLAY_SOURCES = new Set(['compact', 'resume', 'startup', 'clear']))
  // via separate reasoning chains (fork: rule-14 /clear between cards + model-fallback step-down
  // respawn; upstream: context-restart gate's own /clear). Not a real conflict -- only the export
  // keyword and the comment differ. Resolution: keep the fork's `export const` (the hook-matcher
  // test imports it, per its own comment) and the fork's comment (documents the fork-specific
  // rule-14/respawn callers upstream's comment does not mention); the set literal itself is
  // byte-identical either way.
  'src/web/agent-taskstate.ts':
    "both sides converge on the same REPLAY_SOURCES set; keep fork's `export const` + fork comment (upstream's unexported const would break the fork's hook-matcher import), set contents identical",
  // Same underlying convergence as src/web/agent-taskstate.ts above, in the paired test file: both
  // add a `replays on clear too` case with the same assertion, different comment/test-name framing.
  // Resolution: keep the fork's version (references CLAUDE.md rule 14 + the model-fallback respawn,
  // both fork-specific), drop upstream's duplicate case -- not a wholesale-theirs, a same-assertion
  // dedup.
  'src/__tests__/agent-taskstate.test.ts':
    "duplicate `replays on clear too` case on both sides (same assertion, different framing) -- keep fork's version (cites CLAUDE.md rule 14 + model-fallback respawn), drop upstream's duplicate",
  // Two additive, non-overlapping import blocks -- same character as the .gitignore/web/style.css
  // entries above. Fork imports estimateCostUsd/stripDateSuffix from model-pricing.js; upstream
  // imports listAgentNames from agent-config.js and resolveAgentConfigDirForRead from
  // claude-plans.js. No name collision between the two sets. Resolution: keep all three imports
  // (fork's two + upstream's two, five total), reconfirm no name/behavior collision against the
  // actual merged file body at real-merge time (this entry only clears the import-line hunk, not a
  // full-file audit).
  // Two INDEPENDENT delivery annotations, one from each side, on the same two lines. Fork
  // (card 9566a197) imports getKanbanCardStateByIdPrefix and appends formatDeliveryStalenessNote()
  // AFTER the wrapper's output -- 'the card this message stamped has since changed column', which
  // only the router can know because only it knows how long the queue actually held the message.
  // Upstream imports countNewerMessagesFromSameSender and passes a new 7th `freshness` argument
  // INTO wrapAgentMessageForDelivery, which renders it inside the sender line as [!FRISSESSEG...]
  // (age + how many newer messages the same sender has queued since). Different question,
  // different position in the output, no shared symbol: neither one's absence is implied by the
  // other's presence. Resolution: KEEP BOTH -- all three imports, upstream's freshness argument
  // threaded through (the fork's own wrapper already carries six params, so the 7th is additive),
  // and the fork's staleNote still appended after the wrapper, not folded into it. At real-merge
  // time verify the two annotations do not double-report the same wait to the reader.
  'src/web/message-router.ts':
    "additive on both sides, keep BOTH: fork's getKanbanCardStateByIdPrefix import + " +
    "formatDeliveryStalenessNote() appended after the wrapper (card 9566a197), AND upstream's " +
    "countNewerMessagesFromSameSender import + the 7th `freshness` argument into " +
    "wrapAgentMessageForDelivery (rendered inside the sender line). Different signals, different " +
    "positions, no symbol collision -- taking either side wholesale silently drops a shipped feature",
  // Card 206ab192 (URGENT: this file being undecided blocked EVERY marveen landing). The CONFLICT is
  // one hunk -- fork's rollback-guard quarantine block (card 980454f7, the leftover that re-armed the
  // loop which walked the live install back 529 commits) vs upstream's boot.log timestamp header --
  // but resolving only that would miss the actual question, so it was measured properly:
  //
  // OUR Linux branch is BYTE-IDENTICAL to the merge base. The fork's only divergence in this file is
  // the quarantine block, which sits before the OS dispatch and touches nothing upstream changed.
  // Upstream took the file 89 -> 175 lines with work that is squarely OUR problem, not generic:
  //   - a flock + pidfile IDEMPOTENT launch, because on WSL two autostart hooks reach this script on
  //     the same boot (wsl.conf [boot] and a Windows ONLOGON task) and the loser used to start a
  //     SECOND channels.sh polling the SAME bot token -- incoming messages split between two pollers
  //     with no error anywhere. This fleet runs on WSL2.
  //   - system-scope units tried BEFORE `systemctl --user`, because as root the user call fails and
  //     the script fell through to nohup, putting a second dashboard next to the system-unit one
  //     (EADDRINUSE crash loop).
  //
  // SO THE DECISION IS ADOPT -- but start.sh and stop.sh are ONE PROTOCOL and must move together.
  // start.sh's new _service_live() decides 'already running' from the PIDFILE, and that is only sound
  // because upstream also made stop.sh remove the pidfile ONLY AFTER the process is confirmed gone
  // (the other half of 9d3b77f4, 43 insertions in scripts/stop.sh). OUR stop.sh is still the merge-base
  // version: it does `kill` and then `rm -f` the pidfile immediately, without waiting for exit. Taking
  // start.sh alone would therefore hand the new liveness check a pidfile that is already gone while the
  // old process is still winding down -- the update finalizer runs stop.sh then start.sh back to back,
  // which is exactly the sequence upstream's comment says it fixed. scripts/stop.sh does NOT conflict
  // (our side is unmodified), so nothing forces it to be looked at -- which is precisely why it is
  // named here.
  'scripts/start.sh':
    'ADOPT upstream wholesale for the OS-dispatch region (our Linux branch is byte-identical to the ' +
    'merge base, so this is a clean take, not authorship): the flock+pidfile idempotent launch, the ' +
    'system-scope-units-first branch, and the boot.log timestamp header. KEEP the fork rollback-guard ' +
    '--quarantine-stray block (card 980454f7), which sits before the OS dispatch and overlaps nothing. ' +
    'MANDATORY PAIR: adopt scripts/stop.sh from the same upstream commit (9d3b77f4) IN THE SAME ' +
    'CHANGE -- start.sh decides "already running" from the pidfile, which is only sound once stop.sh ' +
    'removes that pidfile after confirming exit; our stop.sh still unlinks it immediately after kill. ' +
    'stop.sh does not conflict, so nothing else will force it to be looked at. Adopting start.sh ' +
    'alone is WORSE than adopting neither',
  'src/web/token-usage.ts':
    "additive, non-colliding imports on both sides -- keep fork's estimateCostUsd/stripDateSuffix (model-pricing.js) AND upstream's listAgentNames (agent-config.js) + resolveAgentConfigDirForRead (claude-plans.js), all four together",
  // Test-fixture window-size conflict, NOT a source conflict: src/web/schedule-runner.ts itself
  // merges clean (both sides' additions land in different spots of the same guardIdx block), only
  // this pinned slice-window assertion collides because fork and upstream each widened the SAME
  // line for a different reason -- fork to 3000 (try/catch REJECTING-verdict mapping, card
  // e9d3cd12), upstream to 2800 (main-agent guard ahead of this block). Resolution POLICY, not a
  // verified number: take the wider of the two (3000) as the floor, but RE-MEASURE against the
  // actual merged guardIdx block at real-merge time -- since schedule-runner.ts gains BOTH
  // additions at once, the true minimum window may need to exceed 3000, not just default to
  // whichever side happened to ask for more.
  'src/__tests__/schedule-runner-autostart.test.ts':
    'window-size fixture only, source merges clean -- use 3000 (the wider of fork/upstream) as a floor, but re-measure the real merged guardIdx block size at merge time since both additions land together',
  // The fork's package.json is a strict superset of upstream's: it adds react/react-dom/recharts
  // (superadmin SPA), google-auth-library (Google auth), vite/ESLint toolchain, a newer Claude
  // Agent SDK (^0.3.224 vs upstream ^0.2.116), and overrides for hono/fast-uri/body-parser.
  // Upstream bumped the version to 1.34.0 and removed the preinstall + lint scripts.
  // Resolution: "canonical" below is scoped to the DEPENDENCY LIST + scripts only -- upstream's
  // slimmer set is a subset of what the fork ships, and version bumps for shared packages (pino,
  // better-sqlite3, claude-agent-sdk) require evaluation before adoption, not automatic
  // take-theirs. It does NOT extend to the top-level `version` field: rule 12783b1e (DECISIONS.md
  // 2026-08-20, reaffirmed 2026-08-25 after two agents read "canonical" as covering the version
  // field too and landed conflicting X.Y.Z values, card 30bb2739) requires the fork's OWN
  // X.Y.Z to track upstream's on every sync-merge (`+mikrob.N` is the fork's separate,
  // per-X.Y.Z counter) -- that IS "taking theirs" for X.Y.Z specifically. Measured 2026-08-25
  // (card 9ef96512); version-field ambiguity fixed 2026-08-26 (card 30bb2739).
  'package.json':
    'dependency list + scripts stay fork-canonical (superset of upstream: react/recharts/vite/eslint/google-auth/newer claude-agent-sdk/overrides; shared-dep version bumps need case-by-case evaluation); the top-level `version` field is the ONE exception -- its X.Y.Z tracks upstream on every sync-merge per rule 12783b1e, fork keeps only its own +mikrob.N counter',
  // Lock-file conflict from independently added/updated dependencies. The fork manages its own
  // package set; upstream its own. Regenerated by `npm ci` from the fork's package.json.
  // Resolution: keep the fork's lockfile; upstream lockfile sections for packages not in the
  // fork's package.json are not applicable.
  'package-lock.json':
    'keep the fork lockfile canonical; regenerate from fork package.json via npm ci if ever needed',
  // Fork changed three curl calls to the `printf | curl -H @-` token-argv-safe pattern (security
  // fix: token never appears in process argv). Upstream replaced the main kanban heartbeat curl
  // command with a Python one-liner (HBHEREDOC819/HBKANBANDRIFT819 incident hardening: no pipe,
  // no heredoc, counts come from counts.* not from list length). Two independent changes on
  // partially-overlapping lines. Resolution: adopt upstream's Python one-liner + all accompanying
  // incident documentation for the kanban section; keep the fork's printf|curl pattern for the
  // OTHER curl calls in the file (the ones upstream did not replace with Python).
  // Re-read 2026-08-25 (card 9ef96512, blob 26c691e5): upstream replaced the Python one-liner
  // with a heartbeat-metrics.sh script call (HBMEMBLIND819 third contract -- a fixed, on-disk
  // instrument with COUNTS/URGENT/WAITING/SCHEDULES/TASK_RUNS_1H output lines). Also imports
  // HEARTBEAT_AGENT_ID from config (replacing 'heartbeat' literal) and adds HeartbeatIdentity.metricsScript field.
  // Resolution: adopt upstream's metrics-script approach (metricsScript field, bash invocation,
  // updated format section referencing COUNTS verbatim) for the kanban reporting block;
  // keep the fork's printf|curl token-argv-safe pattern for the remaining curl calls
  // (quota park + inter-agent message section) that upstream did not touch.
  // Re-read 2026-08-26 (card 367c23a9, unblocking backend's unrelated landing): upstream moved
  // again (blob bb4a7bc7). Verified the metricsScript adoption decided above was NEVER actually
  // applied to live develop's heartbeat-agent-scaffold.ts (zero occurrences of metricsScript /
  // HEARTBEAT_AGENT_ID / heartbeat-metrics.sh, checked directly) -- a real feature adoption
  // (new script + identity field + report-format rewrite), not a trivial import merge, and
  // exactly the class of change already deferred to the Peti-supervised F5 cutover for
  // agent-scaffold.ts. Blob bumped to record today's re-read; resolution unchanged, stays
  // pending F5.
  'src/web/heartbeat-agent-scaffold.ts':
    'two-way merge: adopt upstream metrics-script approach (HBMEMBLIND819 third contract -- bash heartbeat-metrics.sh, HeartbeatIdentity.metricsScript, HEARTBEAT_AGENT_ID import, updated report format using COUNTS/URGENT/WAITING/SCHEDULES/TASK_RUNS_1H lines verbatim) for the kanban section; keep fork printf|curl token-argv-safe pattern for the remaining curl calls (quota park + inter-agent message) that upstream did not touch -- NOT yet applied to live develop, deferred to F5 same as agent-scaffold.ts' +
    "Re-measured 2026-09-03 (backend2, card 6500e1d3 landing-block, bb4a7bc74200..ad28ed576466): upstream threaded the same AGENT_API_ORIGIN into currentHeartbeatIdentity's resolveDashboardOrigin call, and REWROTE the 'Collect the four data sources' prose plus the calendar wording (now HEARTBEAT_CALENDAR_ID rather than 'whatever account the MCP server is authenticated as'). The metrics-script contract this rule adopts is untouched, and so is the fork's printf|curl token-argv-safe pattern it keeps. NOTE for whoever executes the merge: this rule says to take upstream's report format 'verbatim' -- that word now refers to TODAY's block, not the one it was written against, so copy from this blob rather than from memory.",
  // Re-read 2026-08-23 against upstream 9736ea67 (card 394fb5ce): the file moved on, so the rule
  // below now describes TODAY's two hunks rather than the ones it was first written for. The
  // SIGTERM/janitor hunks the previous text named have since merged cleanly and are gone; what
  // conflicts now is:
  //   1. runPreCheck's signature -- fork keeps it ASYNC (card 955f014e: it runs on the scheduler
  //      tick, so a synchronous child freezes the event loop, HTTP server included), upstream is
  //      still sync and adds quotaWorkClass() immediately above it. Non-overlapping intent: keep
  //      the fork's async signature, adopt upstream's quotaWorkClass definition alongside it.
  //   2. the auto-start call -- fork wraps startAgentProcess in try/catch (card e9d3cd12: it can
  //      now REJECT, and an uncaught rejection ends the whole tick, silently stopping every task
  //      ordered after a wedged agent), upstream still has the bare await. Keep the fork's.
  // Upstream's new sawTurn / 'lost' watchdog in the same file merges CLEANLY and is adopted with
  // no decision needed -- it is recorded here only so the next reader knows it was looked at.
  'src/web/schedule-runner.ts':
    'two independent non-overlapping changes: keep the fork async runPreCheck signature (955f014e) and the fork try/catch around startAgentProcess (e9d3cd12); adopt upstream quotaWorkClass() and the cleanly-merging sawTurn/lost watchdog' +
    "Re-measured 2026-09-03 (backend2, card 6500e1d3 landing-block, 9736ea673775..a7c10a08f1fa): upstream added a desktop-lock gate (decideDesktopGate/readDesktopLock/recordDesktopSkip), owner-escalation for pending retries (markPendingTaskRetryOwnerAlert + OWNER_ESCALATION_EXTRA_MS, classifyTelegramSendError generalised to classifySendError), and channel-provider imports. All of it is elsewhere in the file; the fork's async runPreCheck signature and its try/catch around startAgentProcess -- the two things this rule decides -- are untouched. Resolution unchanged; blob bumped.",
  // Fork added agents/** to the exclude list (with explanatory comment: live-install agent SDK
  // tests would otherwise drown the real suite). Upstream added assert-supported-node.ts to
  // setupFiles and updated the comment above setupFiles to list both gates. Both changes are
  // independently valuable. Resolution: keep fork's agents/** exclusion + its comment; adopt
  // upstream's assert-supported-node.ts setup file (porting the file itself from upstream) and
  // update the comment to mention both setup files.
  'vitest.config.ts':
    'keep fork agents/** exclusion + comment; adopt upstream assert-supported-node.ts in setupFiles (port the file from upstream) + updated comment listing both setup-file gates',
  // ── Card bc898166: upstream 37b23702 "Fix/agent lifecycle async ordering" (#1014) ────────────
  // Five files at once, because upstream shipped ONE PR that reworks the same area the fork already
  // reworked -- convergent evolution, not a disagreement. Measured file by file against the merge
  // base (ea7ed17c), not inferred from the PR title. NONE of the five belongs in GUARDED_FILES:
  // that list means "must never conflict", and both sides are actively developing all five, so
  // promising zero conflicts here would be a claim that fails on the next upstream release.
  //
  // THE LOAD-BEARING ONE. The fork made these three functions PRIVATE `*Unlocked` bodies and
  // exports lock-wrapping versions instead (withLifecycleLock, card 74ba7c78 + 346edea2, after a
  // Cybersec AND a Cybered NO-GO), so that restart composes stop+start INSIDE ONE lock keyed on the
  // OPERATION. Upstream's PR makes the same three functions async and exports them DIRECTLY, with
  // no lock at all -- so taking upstream's side on these three signature lines silently deletes the
  // atomicity two security gates were spent on. Only the three signature lines conflict; upstream's
  // body changes merge cleanly and are kept.
  // RE-READ 2026-09-01 (heartbeat reconciliation, blob moved to 3dc78cdf): the withLifecycleLock
  // conflict this rule used to describe is GONE -- verified the fork's *Unlocked private bodies +
  // withLifecycleLock wrappers (card 74ba7c78) are still intact in the current file (grep, all 3
  // call sites present), so that hunk landed correctly in a past cycle and is simply no longer part
  // of today's conflict. Three DIFFERENT hunks conflict now, all genuinely additive on both sides:
  // (1) ISOLATED_CONFIG_SKIP set -- fork skips 'skills' (Peti 2026-08-03, per-agent curated skill
  //     set) and upstream separately skips 'projects' (memory-store symlink collision fix); the two
  //     rationales are orthogonal directory names, union both.
  // (2) provider-env building -- upstream refactored the inline ollama/deepseek/openrouter
  //     export-string building into a shared resolveProviderEnv() (agent-process.ts, tested in
  //     agent-provider-env.test.ts). Verified line-by-line: it reproduces the fork's exact
  //     ollama/deepseek/openrouter export strings byte-for-byte (SAME shSingleQuote sink-escaping,
  //     card b7fa5281, cited verbatim in both), and ADDS a fourth provider (minimax, with its own
  //     documented context-window workaround) -- net additive, safe to adopt wholesale.
  // (3) cmd assembly -- upstream adds a `umask 002` prefix and routes the tmux call through
  //     agentTmuxTarget(name)/startTarget instead of a bare `null` host, unlocking per-user/remote
  //     agent hosting. Verified BOTH are no-ops for every agent as configured today:
  //     agentTmuxTarget() returns {host:null, runAsUser:null} unless an agent's OWN config sets a
  //     remote host or runAsUser (none do), and upstream's own doc comment states
  //     "host=null is byte-identical to the prior direct local tmux call" -- so adopting this is
  //     zero behavior change today and opt-in infrastructure for later, not a live architecture
  //     switch that needs a decision now.
  'src/web/agent-process.ts':
    'union all three: (1) ISOLATED_CONFIG_SKIP keeps BOTH \'skills\' (fork) and \'projects\' (upstream) entries; (2) adopt upstream\'s resolveProviderEnv() refactor wholesale (verified byte-identical output for ollama/deepseek/openrouter incl. the b7fa5281 shSingleQuote fix, plus adds minimax); (3) adopt upstream\'s umask 002 + agentTmuxTarget(name)/startTarget cmd-assembly change wholesale (verified no-op for any agent without remote/runAsUser config, per upstream\'s own "byte-identical to the prior direct local tmux call" doc comment) -- the fork\'s *Unlocked/withLifecycleLock split (card 74ba7c78) is UNRELATED to this hunk set and already correctly merged, do not touch it (4) Re-read 2026-09-03 (card 3bd18e70, blob 4c439228): the agent-scaffold import line now conflicts too -- union the fork ensureLocalFirstSection with upstream ensureSystemDirectiveAuthSection (GUARDHITELES903) on one line; the ensureSystemDirectiveAuthSection(name) call in startAgentProcess auto-merges (additive).' +
    "Re-measured 2026-09-03 (backend2, card 934dc104 landing-block, 4c43922809b2..45e20624c63f): upstream replaced the identity slash command `/name` with `/rename` (identitySlashCommands + three comments + two log messages), because `/name` does not exist and the rejected line sits parked in the input box, which the router then reads as busy. Untouched: ISOLATED_CONFIG_SKIP, resolveProviderEnv(), the umask/agentTmuxTarget assembly and the agent-scaffold import line -- i.e. every point this rule decides. Resolution unchanged; blob bumped.",
  // Upstream adds a re-entrancy guard (`tickRunning`) around the sweep, for the exact reason the
  // fork ALSO has: once checkAgent awaits a real restart instead of a blocking execSync('sleep N')
  // (fork card 873c48df), a sweep can still be running when the next interval fires. Measured: the
  // fork's sweep has NO overlap protection of any kind, so this is something upstream has and the
  // fork lacks, not a duplicate. The fork's sweep BODY is unchanged inside upstream's try/finally.
  'src/web/auto-restart-runner.ts':
    "adopt upstream tickRunning re-entrancy guard (the fork sweep has no overlap protection and its restart path is equally async), keeping the fork sweep body verbatim inside the try/finally. Re-read 2026-08-26: upstream also added open-question deferral (restartBlockedBy in src/auto-restart.ts + hasOpenInboundQuestion check) so a due restart never swallows a pending owner exchange -- adopted, purely additive, no fork-side conflict. Re-read again 2026-08-26 (unblocking a backend2 landing): upstream now wires the ACTUAL deferralOverride()/OPEN_QUESTION_DEFERRAL_CAP_MS call (openQuestionDeferrals streak map, cap-override logging) on top of the restartBlockedBy check already acknowledged above -- still purely additive on top of the fork's existing tickRunning guard and sweep body, nothing removed or contradicted on the fork side. Not yet applied to live develop (same deferred-pending-reconciliation character as the other large runner files in this map); resolution unchanged, blob bumped to record the re-read.",
  // Three hunks, and NOT all one direction -- the reason this entry is per-hunk rather than a side.
  // (1)+(2) The fork's runner is a superset: a weekly-tier axis with durable-baseline bookkeeping
  // (recordBaselineIfAbsent/clearBaseline, "cheaper tier wins" so a park/start cycle cannot undo a
  // downgrade) and a parked-agent path upstream has no equivalent for; checkAgent's own parameter
  // list differs accordingly. Upstream's simpler action.kind form would drop all of it.
  // (3) is the SAME tickRunning guard as auto-restart-runner, and the same measurement applies.
  'src/web/model-fallback-runner.ts':
    'per hunk: keep the fork weekly-tier structure + durable-baseline bookkeeping + parked-agent path (hunks 1-2, upstream has no equivalent), and adopt upstream tickRunning re-entrancy guard (hunk 3) keeping the fork sweep body',
  // Same one-line shape in both skills routes, and the same resolution. The fork made the unzip
  // call ASYNC (execShellAsync) -- a fork-specific correctness property: a sync child on the request
  // path blocks the event loop for every other agent. Upstream kept execSync but passes the path
  // through shellEscape() instead of bare double quotes. Neither side is wholesale right: the fork
  // must stay async, and upstream's escaping is strictly better hygiene -- the fork already calls
  // shellEscape two lines away in the same file, so this line is an inconsistency, not a policy.
  // (Measured: tmpPath is a server-side randomUUID() name, so today's fork line is not exploitable;
  // the escaping is defence in depth, not an open hole being closed.)
  'src/web/routes/skills.ts':
    'keep the fork await execShellAsync (async, does not block the event loop) AND adopt upstream shellEscape(tmpPath) in place of bare double quotes -- never a wholesale side',
  // Two hunks. The unzip line is identical to src/web/routes/skills.ts above, same rule. The import
  // line is the shape already acknowledged for src/web/context-restart-gate-runner.ts: each side
  // added a DIFFERENT binding to the same import (fork: findSymlinkTaintedEntries, from its
  // symlink-reject consolidation, card bb0ae7fa; upstream: shellEscape). Keep both bindings.
  'src/web/routes/agents-skills.ts':
    'union the import line (keep the fork findSymlinkTaintedEntries AND upstream shellEscape); on the unzip line keep the fork await execShellAsync and adopt upstream shellEscape(tmpPath)',
  // ── Card be520693: upstream moved 37b23702 -> 704293f4 and brought two MORE files in ─────────
  // Both are additive on both sides and neither is a disagreement -- measured in a throwaway
  // worktree against the merge base, one conflict hunk each.
  //
  // One additive block per side at the same insertion point, reading and writing nothing the other
  // touches. Fork: stripDataPayloads(), which blanks a curl -d/--data LITERAL payload BEFORE the
  // send-pattern scan (card 132fc28c) -- without it a kanban comment whose PROSE discussed sending
  // a registration e-mail was blocked as if it were an outbound send, i.e. the gate censored talk
  // about the action instead of stopping the action. Upstream: MANAGE_EMAIL_SEND_OPS, the set of
  // outbound-shaped operations of the multiplexed manage_email tool. Keep BOTH -- the fork's
  // false-positive fix does not weaken upstream's new op coverage, and vice versa.
  'scripts/email-send-gate.mjs':
    'keep both additive blocks -- the fork stripDataPayloads() literal-payload blanking (card 132fc28c false-positive fix) AND upstream MANAGE_EMAIL_SEND_OPS; neither side taken wholesale',
  // A one-line import conflict over TWO DIFFERENT gates, not one gate named twice -- checked, not
  // assumed: the fork's EGRESS_GATE_MATCHER is 'WebFetch|mcp__firecrawl__.*' (the web-egress gate),
  // upstream's EMAIL_GATE_MATCHER is 'Bash|.*send_email.*|.*manage_email.*' plus an
  // emailGateMatcherStale() staleness check. Both belong in the merged tree.
  // The union is SAFE because src/web/agent-scaffold.ts, which defines all three symbols, merges
  // cleanly -- verified on the merge result, where EMAIL_GATE_MATCHER, emailGateMatcherStale and
  // EGRESS_GATE_MATCHER are all present. Taking only the fork's import would drop upstream's new
  // test block; taking only upstream's would drop the fork's egress-gate assertions.
  'src/__tests__/hook-command-quoting.test.ts':
    'union the import (fork EGRESS_GATE_MATCHER + upstream EMAIL_GATE_MATCHER/emailGateMatcherStale -- different gates) and keep both sides test blocks; agent-scaffold.ts merges cleanly and defines all three',
  // -- Card 0ea89716: upstream 56af7a69 (the vitest+typecheck workflow, MARVCI822) ---------------
  // ONE hunk, and the two sides are SEMANTICALLY THE SAME assertion -- measured in a throwaway
  // worktree on the real merge, not inferred from the commit titles. Both accept exactly TRAP:5 or
  // TRAP:6 (upstream's regex is anchored), and both sides wrote it for the SAME reason: WHICH line
  // $LINENO blames when the ERR trap fires is bash-version dependent, so pinning one number makes
  // the test a bash-release detector rather than an abort-really-happened guard.
  //
  // The fork got there first (card 3aa02ac6, commit 7b90f485), upstream independently on its first
  // ubuntu CI run. So there is nothing to trade off in the CODE -- only the COMMENTS differ, and
  // they are complementary: the fork's names the measured <=5.2 (blames the enclosing `fi`) vs 5.3
  // (blames the failing command) split, upstream's names bash 3.2 / macOS, which is where the
  // original installer incident happened and which the fork comment does not record.
  //
  // Resolution: keep the FORK's assertion -- identical behaviour, and `toContain` on the literal
  // array prints the expected set on failure, where a regex prints only the pattern -- and fold
  // upstream's bash 3.2 / macOS provenance into the fork's comment. Neither comment wholesale.
  //
  // Deliberately NOT GUARDED_FILES: this is not a fork-owned web file, and upstream is entitled to
  // keep changing it. The rule for resolving it is what needed recording, not a ban on conflicting.
  'src/__tests__/installer-start-and-fallback.test.ts':
    'keep the fork assertion (expect([TRAP:5, TRAP:6]).toContain -- identical behaviour to upstream anchored regex, better failure output) and fold upstream bash 3.2 / macOS provenance into the fork comment; neither comment taken wholesale',
  // Card 3ec64c96 (2026-08-25): the fork independently patched the same send-detector class of
  // false positive upstream had already fixed (KAPUHATOKOR822, upstream's own four-false-positive
  // afternoon, measured 2026-08-22) -- upstream's is_send_invocation() is a position-aware,
  // shlex-tokenized detector that went through multiple adversarial hardening rounds and handles
  // cases the fork's own first-draft URL-anchoring patch did not (a schemeless domain, wrapper
  // shells, interpreter -c/-e code strings). Rather than ship the narrower fork-local patch, this
  // ADOPTED upstream's is_send_invocation() section VERBATIM (a fork-only attribution comment sits
  // just before it, which is why the region still diffs byte-for-byte against upstream -- see the
  // note in the file itself). The fork ALSO carries its own, separate load_bad_name() sentinel fix
  // (NO_BAD_NAME_PATTERNS, distinguishing "rules file missing/broken" from "rules file present but
  // deliberately empty"), which upstream does not have and does not touch. Resolution: keep the
  // fork's file wholesale (it is a strict superset: upstream's detector unchanged in substance,
  // plus the fork's own sentinel fix and attribution comment) -- if upstream's is_send_invocation
  // changes again, replace the fork's copy of that section with the new upstream version and leave
  // the sentinel fix and the attribution comment untouched.
  // Re-read 2026-08-26 (card fbb36b41 round 7, Cybersec GATEKOTOJEL817 bypass finding + fix):
  // upstream moved again -- dropped the fork's attribution comment (cosmetic) and appears to have
  // REVERTED its own load_bad_name()/NO_BAD_NAME_PATTERNS handling to a simpler form that loses the
  // "present-but-deliberately-empty" vs "missing/broken" distinction the fork's card-3ec64c96 fix
  // provides (still verified intact and selftest-covered on the fork's side, 13/13 green). Also
  // adds a new, independent, non-conflicting fail-closed try/except around __main__ (a send that
  // cannot be inspected due to an internal crash now blocks, exit 2, instead of silently falling
  // through as non-blocking exit 1) -- valuable, but NOT adopted in this round to keep the fix
  // scoped to the reported bypass; a candidate for a future round. Resolution unchanged: keep the
  // fork file wholesale (still a strict superset on the sentinel fix), same policy as before.
  'scripts/hooks/outgoing-copy-gate.py':
    "keep the fork file wholesale -- it already carries upstream's is_send_invocation() verbatim (adopted for card 3ec64c96) plus the fork's own separate load_bad_name() sentinel fix upstream lacks (and appears to have reverted on its own side); if upstream's detector changes again, re-adopt that section only, leaving the sentinel fix and attribution comment untouched. Upstream's fail-closed __main__ wrapper is now ADOPTED (B-wave, card 630d9864) -- it was recorded here as a candidate for years of rounds, and measuring it first showed it was not cosmetic: a payload whose tool_input is not a dict made collect_mcp_body() raise AttributeError, python exited 1, and PreToolUse reads 1 as NON-blocking, so a malformed call walked past the gate unchecked. Taken UNIONED with the fork's --status branch, which stays ahead of the net (a read-only posture readout must not answer with a send-refusal), and verified NOT to reach telegram_gate(), which is fail-OPEN by design. Five cases in outgoing-copy-gate.selftest.py pin both directions." +
    " Round 10 (2026-08-26, card fbb36b41, QA stale-blob catch cd51631d01de..4deba6bb7214): adopted two more upstream fixes verbatim. (1) RESENDGATE826 -- _curl_resend_verdict() narrows the resend-target curl/wget match from method-blind to method-aware: a read-only GET/HEAD domain-verification query (no body) now passes, only an actual send (non-safe method, or an implicit-POST body flag) still blocks; an undecidable method (variable, --config, truncated flag) stays fail-closed ('unknown' != 'read'). Grafted at the same call site the fork already carries upstream's is_send_invocation() from, no fork logic touched. (2) DIGIT-HYPHEN SUFFIX in accent_check_tokens(): a Hungarian numeric suffix glued to a number (429-es, 403-as, 2026-os) is no longer misread as a bare word needing an accent check -- ported with the fork's IDENTIFIER_ALLOWLIST skip-block kept intact and untouched (the two skips are independent 'continue' branches, order does not matter). Comment text kept in the fork's established Hungarian-prose convention for this file rather than copied English verbatim -- functionally identical to upstream's." +
    " Round 11 (2026-08-26, Cybersec NO-GO comment 16540): round 10's two ports each had a real, live-reproduced bypass. (1) RESENDGATE826: `curl -G -d ...` (a documented curl trick moving -d's payload into the query string and sending GET) let get_forced override has_body, so a full send slipped through as 'read' -- fixed by deleting the get_forced exception entirely, has_body alone now decides. (2) DIGIT-HYPHEN SUFFIX: the skip had no shape/length bound, so ANY word after a digit-hyphen vanished from the accent check (`5-keszen` lost a real accent error), not just the intended short numeral suffix -- fixed with a closed DIGIT_HYPHEN_SUFFIX_ALLOWLIST ({es,as,os,ös}), same allowlist-plus-assert shape as IDENTIFIER_ALLOWLIST. Both verified against Cybersec's own live reproductions; 24/24 selftest green. This F5 merge lands round 11 onto live develop, superseding the round-10-only commit 12fcda43 that had landed there directly, independently of this branch, before this merge." +
    " Round 12 (2026-09-02, MikroB landing-block, QA stale-blob catch 4deba6bb7214..c724df596611): upstream refactored (EMAILKAPU901 PR1) -- collect_bash_body()/collect_mcp_body() moved VERBATIM out to a new sibling module scripts/hooks/email_extract.py (a level-2 approval gate elsewhere now hashes the same letter this gate audits, so upstream wants exactly one extraction implementation, parity-pinned by its own test), imported behind a guarded try/except that fails CLOSED for the email path (stub returns an unreadable-reason, same as today's unreadable branch) if the import breaks, and leaves telegram (which never calls these) untouched. NOT adopted this round: the fork's file still has the inline functions verbatim (recorded resolution unchanged, still a strict superset via the sentinel fix), so this round is acknowledge-only. The extraction-module split is a real, reasonable refactor and a candidate for a future round -- but splitting a security-audited function across a new file is exactly the kind of change that wants its own dedicated review (parity test included), not a rider on an unrelated landing-unblock." + " Round 13 (2026-09-03, backend2, fleet-wide landing block, standing authority from MikroB msg 19101): upstream rewrote load_bad_name() itself (CLCOPYGATEHIANY902, c724df596611..d35afdd048eb) -- the exact function this entry's resolution is about. It now returns (regex, state) and SPLITS what the fork treats as one case: a MISSING or EMPTY rules file becomes fail-OPEN for email with a loud systemMessage on every send, while only an INVALID file (present but unparseable/bad schema/uncompilable regex) stays fail-CLOSED. Upstream's reason is a fresh customer install, where the file is deliberately not shipped (it names a private person) and the old behaviour left a paying customer unable to send mail at all. NOT adopted, acknowledge-only. Two reasons, and neither is 'we did not look': (1) it is a security-POSTURE change, not a refactor -- adopting it would relax this fork from fail-closed to fail-open on the email path, which is a decision for a card with a gate, not a rider on a landing-unblock; (2) not adopting keeps this fork on the STRICTER side, so the acknowledge-only choice cannot lose protection. Measured while deciding, and worth its own card: on THIS install store/outgoing-copy-gate-rules.json exists but has ZERO bad_name_patterns. CORRECTED 2026-09-03 (card 934dc104, backend2, measured by running the gate rather than reading it): zero patterns returns the card-3ec64c96 SENTINEL, not None, so the email branch was NOT fail-closed from the main clone -- it passed silently. The fail-closed reading came from a WORKTREE copy, where the script-relative rules path resolved to a file that checkout can never have; card 934dc104 made that path checkout-independent. The state upstream is responding to (a fresh install with no rules file at all) is still real and still not adopted here, for the two reasons above. That is an operational finding for the owner, not a reason to take upstream's relaxation blind.",
  // New conflict surfaced 2026-08-26 (card 72f5f13b F4 gate, NOTIFYVAK826, upstream advanced
  // past the merge point mid-integration): fork changed the message-body curl call to
  // --data-urlencode (card b43d6dfd security fix -- an `&` in the message must not start a
  // new form param / override parse_mode). Upstream independently made delivery HONEST
  // (NOTIFYVAK826): capture the response, require both a clean curl exit AND the Bot API's
  // own "ok":true before reporting success, since this script is the fleet's FALLBACK channel
  // used exactly when the primary Telegram plugin is already down -- a swallowed failure here
  // is indistinguishable from silence. Upstream also gated the tmux sender-detection behind
  // `[ -n "${TMUX:-}" ]` so a detached caller (cron/systemd) never mislabels a system alert as
  // coming from an arbitrary agent. Resolution: keep BOTH -- the fork's --data-urlencode call
  // wrapped in upstream's RESPONSE/CURL_EXIT/ok:true honesty check, token masked in error
  // output, plus upstream's TMUX-guarded sender detection.
  // Upstream refactored again (NOTIFYVAKSWEEP826, #1084 + #1086, measured live 2026-08-26): the
  // RESPONSE/CURL_EXIT/ok:true honesty check moved out of notify.sh into a new shared library,
  // scripts/lib/send-telegram.sh (send_telegram_message TOKEN CHAT_ID TEXT [extra curl args],
  // plus telegram_api_call for non-sendMessage methods), and rippled into 8 more callers across
  // two rounds. notify.sh's lib call is a strict superset of the fork's b43d6dfd
  // --data-urlencode fix (the lib's own --data-urlencode "text=..." already carries it) and
  // keeps the fork's TMUX-guarded sender-attribution block unchanged. Resolution: adopt
  // notify.sh + all 8 callers + the new lib wholesale where no fork-specific logic is lost
  // (disk-space-guard, unit-fail-notify, fleet-memory-gate, github-pr-monitor, set-bot-menu,
  // stuck-modal-guard); hand-merge limit-monitor.sh (keeps the fork's canonical
  // session-limit-pattern.sh sourcing, card 115c21e7 -- verified the canonical JSON already
  // covers upstream's inline additions, nothing lost either way) and
  // host-restart-watchdog.sh (keeps the fork's prior-shutdown cause classifier, card RELIA-A,
  // upstream never had it) around the new honest-send contract.
  'scripts/notify.sh':
    "adopt upstream wholesale -- the new scripts/lib/send-telegram.sh shared honesty-check subsumes the fork's b43d6dfd --data-urlencode fix, and upstream's file keeps the fork's TMUX-guarded sender-attribution block unchanged",
  'scripts/lib/send-telegram.sh': 'adopt upstream wholesale (round 2 adds telegram_api_call, the method-agnostic sibling send_telegram_message now calls)',
  'scripts/disk-space-guard.sh': 'adopt upstream wholesale -- honest-send-via-lib replaces an unchecked inline curl, no fork-specific logic in this file',
  'scripts/unit-fail-notify.sh': 'adopt upstream wholesale -- honest-send-via-lib replaces an unchecked inline curl (best-effort exit-0 contract unchanged), no fork-specific logic in this file',
  'scripts/limit-monitor.sh': "keep the fork's session-limit-pattern.sh sourcing (canonical regex, card 115c21e7) + its own extra-signal regex, graft upstream's honest-send-via-lib + stamp-dedupe-hash-only-on-confirmed-success onto the alert block. Round 2 (MD5SUMHIANY826, QA fbb36b41 round-8 stale-blob catch): upstream replaced the bare `md5sum | awk` dedupe hash (empty string on macOS, silently swallowing every alert) with the shared scripts/lib/content-hash.sh dedupe_check() -- fail-open on no hashing tool, no stamp written on an empty hash. Grafted onto the same alert block, fork logic unchanged. Round 3 (2026-09-02, fron-ted, landing 5dd4a211, 61c0d229af89..8a34f0936860): upstream added a MEASURED quota path (scripts/lib/quota-check.py over .claude-rate-limits.json, warn at 90%, stale-skip) ahead of the text scan, a send_alert() wrapper over scripts/lib/send-telegram.sh, and a fleet-wide pane scan. Resolution principle unchanged -- fork logic stays; graft ONLY the honest-send wrapper (already the recorded rule). The measured-quota path is deliberately NOT grafted: the fork already alerts from its own quota monitor (store/quota-check.sh + quota-bridge), a second measured alerter would double-notify Peti. If MikroB wants the upstream measured path instead, that is a separate decision, not this ack.",
  'scripts/lib/content-hash.sh': 'adopt upstream wholesale -- brand-new shared hashing helper (MD5SUMHIANY826), no fork-specific logic to preserve',
  'src/__tests__/content-hash.test.ts': "adopt upstream wholesale -- upstream's own unit test for the new content-hash.sh, no fork-specific logic to preserve",
  'scripts/host-restart-watchdog.sh': "keep the fork's prior-shutdown cause classifier wholesale (classify_shutdown_from_log/prev_boot_log/HOST_RESTART_WATCHDOG_LIB test hook, card RELIA-A, upstream never had it), graft upstream's HOSTWD_PROC_STAT test hook + honest-send-via-lib + stamp-btime-baseline-only-on-confirmed-delivery",
  'scripts/fleet-memory-gate.sh': 'adopt upstream wholesale -- honest-send-via-lib + cooldown-stamp-only-on-success, no fork-specific logic in this file',
  'scripts/github-pr-monitor.sh': 'adopt upstream wholesale -- honest-send-via-lib + snapshot-not-persisted-on-failed-alert + an unrelated REPO-parsing regex fix (ERE has no lazy quantifier), no fork-specific logic in this file',
  'scripts/set-bot-menu.sh': 'adopt upstream wholesale -- honest telegram_api_call() replaces a silent fire-and-forget curl for setMyCommands, no fork-specific logic in this file',
  'scripts/stuck-modal-guard.sh': 'adopt upstream wholesale -- honest-send-via-lib + backoff-stamp-only-on-success, no fork-specific logic in this file',
  'src/__tests__/notify-delivery-honesty.test.ts': 'adopt upstream wholesale -- trivial test-scaffolding update to stage the new scripts/lib/send-telegram.sh alongside notify.sh',
  // NOT an upstream conflict -- upstream deleted this file outright when notify.sh stopped
  // inlining its curl call (NOTIFYVAKSWEEP826). It is the fork's OWN corpus-wide security guard
  // (card b43d6dfd): it scans every scripts/*.sh + store/*.sh for a bare `-d "text=$VAR"` that
  // would silently truncate a Telegram message on "&". Kept, with the CASES list extended into
  // scripts/lib/ (where the curl call now actually lives) and the notify.sh-specific assertion
  // updated to check the delegation to send_telegram_message() plus the library's own
  // --data-urlencode usage.
  'src/__tests__/telegram-urlencode-guard.test.ts':
    "fork-owned corpus guard (card b43d6dfd), NOT deleted -- extended CASES into scripts/lib/ and updated the notify.sh-specific assertion for the NOTIFYVAKSWEEP826 lib delegation",
  // The fork's ONLY addition to this upstream test file: stageTree() also copies
  // store/session-limit-pattern.sh + .json for limit-monitor.sh's fork-only dependency. Round 2
  // (MD5SUMHIANY826) is upstream's own addition -- stageTree() also copies the new
  // scripts/lib/content-hash.sh, adopted verbatim alongside it.
  'src/__tests__/send-honesty-sweep.test.ts': "upstream file (now also stages scripts/lib/content-hash.sh, MD5SUMHIANY826) + the fork's session-limit-pattern.sh/.json staging addition in stageTree() for limit-monitor.sh's fork-only dependency",
  // Round 4 closing sweep (#1088, measured 2026-08-26, card fbb36b41). Two identical hunks
  // (main-agent-on-shared-config guard alerts). Real merge-tree dry run confirms the fork's
  // -H @"$_hdr_file" security fix (card b267df80) is UNCHANGED context on both sides, not part of
  // the conflict -- upstream only adds HTTP-status capture for honest delivery logging on top of
  // it. Resolution: keep the fork's header-file curl call, append upstream's status capture.
  'scripts/channels.sh':
    'keep the fork\'s -H @"$_hdr_file" 0600-temp-file security pattern (card b267df80) unchanged, append upstream\'s HTTP-status-capture honest-delivery check (NOTIFYVAKSWEEP826) on both guard-alert call sites' +
    ' Re-measured 2026-09-02 (backend, card 9d7a247a landing-block, a550d6852ebc..f1c6939e42b1): upstream moved in three hunks, ALL outside the recorded conflict -- it centralises Claude Code installing/updating (DISABLE_AUTOUPDATER on every host, a single serialized claude_install/self-heal point, and the tmux set-environment -g that makes launch order irrelevant), after two concurrent per-session auto-updaters wiped the shared global install. The recorded conflict sits at the two guard-alert POSTs (lines 501-537 of the old blob); the changed hunks are at 366-378, 381-387 and 650-656. Zero hits on _hdr_file, guard alert, NOTIFYVAKSWEEP or Authorization in the whole diff. Resolution at the conflict points unchanged; blob bumped. Whether the fork ADOPTS upstream\'s serialized installer is a separate question for the next upstream merge, not a conflict resolution.' +
    "Re-measured 2026-09-03 (backend2, card 934dc104 landing-block, f1c6939e42b1..f3bafcfaa0aa): upstream moved ONE line, `/name` -> `/rename` in the post-start identity send-keys (line ~849). The recorded conflict is at the two guard-alert POSTs; zero overlap. Resolution unchanged; blob bumped. Worth flagging for the next merge, not for this resolution: `/name` is not a real Claude Code command, so the fork is sending a line that parks in the input box -- an adoption question, not a conflict.",
  // Independent-additive, same class as the src/web.ts import-line conflicts: fork's {{CHAT_ID}}
  // and upstream's {{PROJECT_ROOT}} both added to the SAME sed chain in render_seed_template().
  // {{PROJECT_ROOT}} is the node seeder's alias for {{INSTALL_DIR}} -- ledger-live-drain uses that
  // form, and without it the historical-blob match never fires, so that task stays permanently
  // classified "touched" and never refreshes. Keep both. (Also required adding {{PROJECT_ROOT}} to
  // install-linux.sh/install-macos.sh's own seed-scheduled-tasks loops to satisfy the fork's own
  // seed-render-parity guard, card d041760b -- done alongside this fix, see update.sh/install-*.sh
  // diffs.)
  'update.sh':
    "independent-additive: keep both sed -e lines in render_seed_template() -- {{CHAT_ID}} from the fork (4 fleet-orchestration prompts) and {{PROJECT_ROOT}} from upstream (ledger-live-drain, node-seeder alias for {{INSTALL_DIR}}). SECOND hunk added 2026-09-02 (Cybersec/MikroB, card 9dc0fba8's landing-block triage): upstream fixed the ahead-vs-diverged bug in the AHEAD-detect block (d9cfd076, refuse only when AHEAD AND BEHIND, not ahead alone) -- ported that BEHIND-aware check into the fork's `else` branch of the POST_MERGE_MODE conditional, the POST_MERGE_MODE if-branch itself is untouched (that special-case already has its own reasoning for skipping the check entirely)",
  // A REAL security-regression risk unlike the two files above: THIS conflict hunk has the fork's
  // -H @"$hdr_file" 0600-temp-file call INSIDE the conflicting region (not shared context), and
  // upstream's replacement uses a bare `-H "Authorization: Bearer $(cat "$TOKEN_FILE")"` --
  // exactly the token-in-argv vulnerability (/proc/<pid>/cmdline is world-readable) the fork's own
  // comment warns about. Taking upstream wholesale here would have been a real regression.
  // Resolution: keep the fork's hdr_file call, graft upstream's GUARD_HTTP status-capture +
  // stderr-on-non-2xx logging on top (same NOTIFYVAKSWEEP826 pattern as channels.sh).
  'scripts/install-prod-tree-guard-hook.sh':
    'keep the fork\'s -H @"$hdr_file" 0600-temp-file security pattern (upstream\'s replacement would have leaked the token via curl argv), graft upstream\'s GUARD_HTTP status-capture + non-2xx stderr logging (NOTIFYVAKSWEEP826) on top',
  // Card 9dc0fba8, Cybersec measured + MikroB decided 2026-09-02: upstream rewrote its silent
  // Ollama-install step (OLLAMA_URL precedence, probe, embedding-pull, PR merged as c23fde9a). The
  // fork does NOT have that step -- Peti's directive (2026-08-13, EPIC ebc7b4dd, see the header of
  // store/first-run-llm.sh) intentionally removed the silent pre-install: the runtime is now
  // offered-never-silent, the embedding model is a separate automatic dependency, and the coding
  // model comes from an explicit user-picked catalogue. Upstream's rewrite improves a step that no
  // longer exists on this side, so there is nothing to graft. Resolution: keep the fork version
  // wholesale.
  'install-linux.sh':
    "GRAFT, not wholesale (updated 2026-09-02, card 9dc0fba8, MikroB approval): the Ollama half is unchanged -- upstream's OLLAMA_URL precedence/probe/embedding-pull rewrite still targets the silent auto-install step Peti's 2026-08-13 directive (EPIC ebc7b4dd) removed, so there is still nothing to graft THERE. But upstream then changed a DIFFERENT part of the same file, and that part applies here: the Telegram-pairing liveness check now asks three ways (user unit / system unit / channels.pid + kill -0) instead of `systemctl --user is-active` alone, because the installer's own no-systemd branch starts the bridge with nohup and the old check then called it 'not started', skipped pairing and left ALLOWED_CHAT_ID=0. Upstream's own comment names our platform: \"WSL is a documented supported platform and has no systemd user session by default, so this is not an exotic shape.\" This fork runs on WSL and has that same nohup fallback, so the fix is adopted (_bridge_is_up + the more precise failure message) while the fork's Ollama removal stays",
  // Card 9dc0fba8, same decision: this is a modify/delete conflict, not content -- the fork DELETED
  // this test file entirely (it asserted behavior of the removed silent-install step), upstream
  // MODIFIED it. Resurrecting a deleted test for a feature this fork intentionally does not have
  // would be wrong regardless of what upstream's edit says. Resolution: keep the deletion.
  'src/__tests__/installer-ollama-nonfatal.test.ts':
    'keep the deletion -- this test covers the silent Ollama pre-install step Peti\'s 2026-08-13 directive (EPIC ebc7b4dd) removed from the fork; upstream modified rather than deleted it because upstream never removed that step, but the fork has no code left for this test to exercise',
  // Card ab4c85f2, 2026-09-03: this fork adopted upstream's GUARDHITELES903
  // authenticated-directive mechanism. Upstream ships both halves; this fork had
  // NEITHER, so the adoption touches an upstream-owned module, an upstream-owned
  // test, and a long-diverged fork file. Three conflicts, three different rules.
  //
  // Deliberately NOT GUARDED_FILES for any of them: upstream owns this feature
  // and is entitled to keep improving it. We want its future changes, not a
  // permanent exemption from reading them.
  'src/web/system-directive.ts':
    "take upstream's version wholesale, then re-apply TWO hunks: (1) the fork imports SYSTEM_DIRECTIVE_SENDER from './system-directive-id.js' (a const-only module) and re-exports it, where upstream declares it inline -- the fork needs the shared const because routes/messages.ts guards on it, and a request-path file must not import this tmux-side module; (2) card 5c5d7bc4: systemDirectiveEnvelope() interpolates ${SYSTEM_DIRECTIVE_SENDER} where upstream hardcodes from_agent=\"system\" in the prose, because the fork's reserved id is 'system-directive' and NOT upstream's 'system'. Do NOT take upstream's literal back: the value drives the recipient's verification, and an envelope naming a different id than the row is a REAL directive refused as injection-suspect. Nothing else in the file is intentionally fork-divergent -- if the diff shows more, upstream changed the logic and that change is wanted",
  // The fork's copy is upstream's file plus fork-owned additions AND one
  // deliberately INVERTED assertion, so a wholesale take in either direction is
  // wrong here.
  'src/__tests__/system-directive-auth-section.test.ts':
    "merge, do not take a side: keep upstream's new/changed cases, and keep the fork's four additions (the fourth is card 5c5d7bc4's 'the directive channel owns a sender id that no other writer uses' describe, which upstream cannot have: upstream's channel IS on the shared `system` id) -- the 'two halves must ship together' describe block (wiring tripwire this fork needs and upstream does not), the token-not-in-argv assertion, and the INVERTED [CONTEXT-RESTART-GATE] case. Upstream asserts that prefix is IN scope; here it is OUT, because this fork's restart gate sends createAgentMessage(agent -> coordinator) alerts, not directives to the recipient. Never take upstream's in-scope assertion without ALSO adopting upstream's gate wake nudge -- the fork test asserts context-restart-gate-runner.ts contains no sendSystemDirective precisely so that pair cannot drift",
  // Add/add on the same call site: both sides independently routed the
  // channels-recovery memory-save through sendSystemDirective. The semantics are
  // identical; only the import placement and a fork comment differ.
  // Adopted from upstream and kept as close to it as the fork's tooling allows:
  // the ONLY divergence is the mock signature, forced by lint, not by taste.
  'src/__tests__/system-directive.test.ts':
    "take upstream's version wholesale, then re-apply TWO hunks: (1) the sendPromptToSession mock's call signature lives in vi.fn's generic (type SendPrompt) instead of upstream's four underscore-prefixed parameters -- this fork's eslint sets @typescript-eslint/no-unused-vars to a bare 'error' with no argsIgnorePattern, so upstream's shape is four findings and lint-ratchet refuses the landing; (2) card 5c5d7bc4 added one FORK-ONLY case to the systemDirectiveEnvelope describe ('states the reserved sender by VALUE'), which pins the interpolation upstream does not have. Keep it: it is the only test that covers the land-before-restart window, where an agent's scaffolded CLAUDE.md still names the old id and only the envelope's interpolated value keeps a real stop order verifiable. Everything else is upstream's; if the diff shows more, upstream changed the tests and those changes are wanted",
  // Card 22e4c0d9, 2026-09-04: BOTH sides added the same GET /api/messages/:id handler, and the
  // CODE is byte-identical (verified by diffing the two bodies with comments stripped) -- only the
  // comment above it differs. Upstream's explains what the endpoint is for; the fork's records WHY
  // this fork was missing it (the ab4c85f2 recipe told every agent to call an endpoint that 404'd,
  // so a real stop order would have been refused as injection-suspect). Resolution: keep either
  // side's CODE, they are the same; keep the FORK's comment, it carries the incident. Nothing else
  // in this file is part of this decision -- the fork's own additions here (reserved-sender guard,
  // JSON-parse hardening, `to` validation, card-state stamping) sit in other regions and have
  // merged cleanly so far. NOTE: this file used to auto-merge SILENTLY; the fork's comment is what
  // turned it into an honest conflict, and for a trust-boundary route file that is the better
  // state -- a future upstream change here now forces a re-read instead of arriving unseen.
  'src/web/routes/messages.ts':
    "both sides added the SAME GET /api/messages/:id handler (identical code, comments differ) -- keep either side's code and the FORK's comment, which records the ab4c85f2 incident that made the endpoint necessary; the fork's other additions in this file (reserved-sender guard, JSON-parse hardening, to-validation, card-state stamping) live in separate regions and are not part of this decision",
  'src/web/channel-monitor.ts':
    "both sides made the SAME change to triggerMarveenMemorySave (bare sendPromptToSession -> sendSystemDirective(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, prompt)), so take either for that hunk -- they are semantically equal. Everything ELSE in this file is long-standing fork divergence unrelated to this card: resolve those on their own merits, they are not part of the ab4c85f2 decision. CORRECTION 2026-09-04 (card 272361eb, B-wave): this entry used to say 'lazy bin resolver vs upstream's eager resolveFromPath consts' and had the two sides BACKWARDS -- upstream was the lazy one, WE had the eager module-level consts, which throw at IMPORT time and take every importer of this module down on a PATH gap. That half is no longer a divergence at all: the fork adopted upstream's tmuxBin()/claudeBin() shape, matching platform.ts's own documented rule and agent-process.ts's existing use. What REMAINS undecided here is upstream's STUCKINPUT827 injected-prompt-registry work and its subagent-overdue alert (shouldAlertStuckSubAgent, SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS), neither of which this fork has.",
  // Card 272361eb (B-wave 3/6). Upstream's ENTIRE delta in this file is resolveAgentConfigDirForRead
  // (43+/1-, the function plus its comment), which the fork has now adopted with identical logic --
  // so the two sides no longer disagree about behaviour, only about how much comment sits above it.
  'src/web/claude-plans.ts':
    "keep the fork's copy: the function body is upstream's verbatim (same signature, same " +
    "projects/-required check, same null fallbacks), and the fork's longer comment carries the " +
    "measurement that upstream's does not -- 0 of 15 agents on this install are in the state it " +
    "fixes, so it is a LATENT correctness fix rather than a live defect, and a later reader must " +
    "not be left believing a bug was repaired that was not happening. If upstream changes the " +
    "function itself, adopt that; a comment-only delta is not a reason to touch this file.",
  // Card 272361eb (B-wave 3/6): both sides amended the SAME assertion after the same rename.
  'src/__tests__/channel-monitor-resume-recovery.test.ts':
    "keep the FORK's version. Both sides fixed the case that broke when the eager TMUX const became " +
    "the lazy tmuxBin(), but upstream swapped one literal spelling for another " +
    "(tmuxPath:\\s*tmuxBin\\(\\)) and will therefore break again on the next rename. The fork " +
    "matches any expression in that position, because the property under test is that the periodic " +
    "reap calls the SHARED reaper with a tmux path -- not which expression produced the path. Take " +
    "upstream's side only if it stops pinning a spelling.",
  // Card 39b32ac6 (B-wave 2/6), a TAIL-vs-TAIL conflict both sides created for the same feature.
  'src/__tests__/seed-refresh-untouched-only.test.ts':
    "keep the fork's 180 lines of fork-owned cases (seed_copy_try_merge, operator-authored skills, " +
    "the CLAUDE.md exclusion) -- a wholesale take of upstream's file drops all of them -- and APPEND " +
    "upstream's SEEDREFRESH826 describe block, which covers the same top-level scheduled-tasks refresh " +
    "with the more realistic fixture (the node seeder's {{PROJECT_ROOT}} alias resolved on disk, which " +
    "the fork's own first draft did not exercise). Both sides appended at the tail for the same reason, " +
    "so this is a union, not a pick. ONE fork amendment inside upstream's block, and it is deliberate: " +
    "upstream's 'a locally modified copy survives' case is VACUOUS -- measured by deleting the source " +
    "line under test, which left it green, because nothing refreshing at all also leaves the edit alone. " +
    "A witness task (untouched, one release behind) refreshes in the same run, so the edited copy being " +
    "spared now means the rule held rather than the feature being absent. Keep upstream's RED-BEFORE " +
    "case alongside it; it pins the source line by name, which the witness does not.",
} as const

// THE UPSTREAM CONTENT EACH RULE ABOVE WAS DECIDED AGAINST (card a1d613e3, Cybersec msg 19105).
//
// THE DEFECT THIS CLOSES. The acknowledgement above is keyed on the FILE NAME and nothing else, so
// it is permanent: once a path appears in it, ANY later conflict in that file -- a different hunk,
// different semantics, a weakened assertion -- passes this guard silently, forever. That is not a
// hypothetical. Card 0ea89716 chose the acknowledgement list OVER GUARDED_FILES precisely BECAUSE
// "upstream legitimately keeps editing the file", so a future, different conflict there is the
// stated PREMISE of the decision, not an edge case. And one of the exempted files,
// src/__tests__/installer-start-and-fallback.test.ts, is itself a watchdog -- it measures that an
// installer abort really happened. An upstream change that weakened it would have crossed a gate
// whose only comment on the matter was "we already decided about this file".
//
// SO THE RULE IS BOUND TO CONTENT, NOT TO A NAME: the upstream-side blob sha the decision was read
// against. Same file, same blob -> the decision still describes what is there, land on. Same file,
// DIFFERENT blob -> the guard blocks again and asks for a fresh decision. The "decide once" benefit
// survives (the identical conflict never stops a landing twice); the permanence does not.
//
// GRANULARITY, STATED HONESTLY: this is the whole FILE's blob, so it also trips on an upstream edit
// that never touches the conflicting region. That over-triggering is deliberate and is the cheaper
// error -- it costs one re-read of a file we already know is contentious, whereas under-triggering
// is the defect being fixed here. It is also only ever evaluated for files that ACTUALLY conflict
// in this run, so an upstream edit that resolves the conflict is silent.
//
// Typed as Record<keyof typeof ACKNOWLEDGED_CONFLICTS, string>: a rule without a recorded blob, or
// a blob without a rule, is a COMPILE error rather than a silent gap between two lists.
const ACKNOWLEDGED_UPSTREAM_BLOBS: Readonly<Record<keyof typeof ACKNOWLEDGED_CONFLICTS, string>> = {
  'src/kanban-dispatch.ts': '7fffc38f78b99573fb88fd797ac67b3593ffb872',
  'src/__tests__/kanban-dispatch-rearm.test.ts': 'd9a186a0af48c44c14299c284dbe0caf45d8feaa',
  'src/auto-restart.ts': 'a1f2d75ed063a78eb5be23acb2c4138ca14fff19',
  'src/model-fallback.ts': '93ea8f17a6c9608003f047c1c9b5f8defe0f1da8',
  'src/__tests__/model-fallback.test.ts': '09bc3bf772d195be0980f4bec929eed4ecfadc67',
  'src/web/update-checker.ts': 'c98efe359fd032ee0f196b114d70fb57d166a88c',
  'src/web/context-restart-gate-runner.ts': '268fc2e659fa8210c2b67c1df64e4006c2e727af',
  'src/web.ts': 'a515f9c8750b2aeece08eb66034f466e6d8a7732',
  'src/web/keychain.ts': '1e1730ee0d8f6b1d4b51c5c254f3fab56acfa376',
  'src/web/agent-scaffold.ts': '936cdac15d5c59305cdff4e7659ec95e95d86f2a',
  'src/db.ts': 'cf4c1052f7efa2fcbfbbfec89f8e76eec543e405',
  'src/web/routes/agents.ts': '4b7a61e33448134091ae6a9175857a4027bdab28',
  'src/web/routes/kanban.ts': '89423d29b8af3e949cb520eefc8f5a0d03ff380c',
  'scripts/hooks/egress-gate.mjs': '229076d5812e7d50a188ca07b43a87fb6239b233',
  'src/__tests__/egress-gate.test.ts': 'c24ca54ffc49de70d602790fa1d6b80e3aea4156',
  'src/web/context-guard-runner.ts': '2876a41d1fb283e5591dec8666b67734b2b52b53',
  'web/app.js': 'e8c74d15bbb930ca7fff43139b868b0e638e7a11',
  'web/style.css': 'b774ccb836f07ca78c300077302834a80cd12edb',
  'src/web/agent-taskstate.ts': '625d03282bb75b554ce23822f67cc4e51b0706c1',
  'src/__tests__/agent-taskstate.test.ts': '82dc411aa813d66c0800e7f8007dfdcd2a42e43f',
  // 2026-09-02 (fron-ted, landing 5dd4a211): upstream moved 346fa637 -- body-only change in
  // correlateWithKanban() (skips parent cards via NOT EXISTS + comment), import hunk untouched,
  // the four-imports rule above still holds; additive, no collision with the fork's edits.
  'src/web/message-router.ts': 'ac55c39b847d2ebbea43ab83cd449a1b774f73ca',
  'scripts/start.sh': '5ddd9df0c82471ff51efd542c72693033e462988',
  'src/web/token-usage.ts': '346fa63739d85f7af55b06d9359f4ec82db00f3e',
  'src/__tests__/schedule-runner-autostart.test.ts': '678cbb42e4447b206598bfbb9bc271602a3f896b',
  '.gitignore': '1e5adbb2332be0dbf5a710c1899e49305ccb318b',
  'package.json': '031fc59039e3081034cf870745202076818b1bff',
  'package-lock.json': 'f4f25dd6896d5a4f80c13df1b056b632f86f37e6',
  'src/web/heartbeat-agent-scaffold.ts': 'ad28ed576466d9a591209c501ced06998ec1a505',
  'src/web/schedule-runner.ts': 'a7c10a08f1fac72f1401ec53eb415fcd2aee2e24',
  'vitest.config.ts': '62d4ac7606cd719d40e07fc0d82c7f777dda0b30',
  'src/web/agent-process.ts': '45e20624c63fdb4377943aede3cf4fc0d46b3319',
  'src/web/auto-restart-runner.ts': '044dde0ad94f5a57ff8e611656f288b25fecdaff',
  'src/web/model-fallback-runner.ts': '681fcaefd6588fc2f6f3db880238b8288d1dcd15',
  'src/web/routes/skills.ts': '34c1e440bd5009e79546d686ec9fbc481ba0af7e',
  'src/web/routes/agents-skills.ts': '23a380b7d40b5cd70885d9205c6fb4cc1fe9dbfe',
  'scripts/email-send-gate.mjs': 'abaaedc4d0e9f76fa159307659473ffaac306411',
  'src/__tests__/hook-command-quoting.test.ts': '1048b1988e6c8554754900c62570d76d455f1057',
  'src/__tests__/installer-start-and-fallback.test.ts': '9017ce4fcfe808b73fdcd1389ebf1c9eaf374f7e',
  'scripts/hooks/outgoing-copy-gate.py': 'd35afdd048eb048cdd585e6ceddcf17dc1e4c702',
  'scripts/notify.sh': '5477e66ecad5cca6425a535de0d16fce0e3eca28',
  'scripts/lib/send-telegram.sh': '293aecf24507b6d56bda99e5a4ff937e1491ab97',
  'scripts/disk-space-guard.sh': 'd3f693c01d607952a8165cc4d8106024008f22e4',
  'scripts/unit-fail-notify.sh': 'ada00f95a7b3665feac1305bb5287698b81839de',
  'scripts/limit-monitor.sh': '8a34f09368608f221ee4d32f6cb5cfd5070ec45b',
  'scripts/lib/content-hash.sh': 'a2fc1103d635bd7602229447cb299f4540cd3d22',
  'src/__tests__/content-hash.test.ts': '57cbbd6ffa36d800c3c9b9e8649acba17b960949',
  'scripts/host-restart-watchdog.sh': '07948350e336ec02d58d952df016ab6b07d7d052',
  'src/__tests__/notify-delivery-honesty.test.ts': '06f96abf8c49fb07b8bbf570c8ca895fe6f23ee9',
  // Upstream deleted this file (delete/modify conflict against the fork's still-modified copy) --
  // there is no upstream blob to pin. This is the documented sentinel for that case (see
  // readyToPasteEntry's blobLine fallback below): if upstream's side of the pair ever changes
  // (e.g. a file with this path reappears upstream), the guard trips again and this needs a fresh
  // decision rather than silently comparing against a phantom blob.
  'src/__tests__/telegram-urlencode-guard.test.ts': '(absent upstream -- delete/modify conflict, no blob to pin)',
  'scripts/fleet-memory-gate.sh': 'ce2e49d6460c56cc49c7637dc0073d0172d5520f',
  'scripts/github-pr-monitor.sh': '545425b675857bcbdab5018dbcbb42dca1722416',
  'scripts/set-bot-menu.sh': 'b45aca69c59f9b69748592df70d0a9ea77189206',
  'scripts/stuck-modal-guard.sh': '5bf19fc208ac41c204ae007189553efcb1d2790d',
  'src/__tests__/send-honesty-sweep.test.ts': 'afc17a2222a86a7645343f837618ebe74516dacc',
  'scripts/channels.sh': 'f3bafcfaa0aa3068fa37f3c0f844a2923117c2bf',
  'update.sh': 'abca56b71701073b5ce0c604037fb47766739193',
  'scripts/install-prod-tree-guard-hook.sh': '9647c9658a5e6352ae0bae57842590a1c2d6e30c',
  'install-linux.sh': '21f10d99336757c0a1416b6e20297b1d3cda42cd',
  'src/__tests__/installer-ollama-nonfatal.test.ts': '7467d0dc6674099a5af6b65d4388d18ff1f99f78',
  // Card ab4c85f2, 2026-09-03 (adopting GUARDHITELES903 into a fork that had neither half).
  'src/web/system-directive.ts': '7b69015ec8f1942349f9f912bfda228fb01ee771',
  'src/__tests__/system-directive.test.ts': '08409868f5f889240baceba1c4a240ac17d2c138',
  'src/__tests__/system-directive-auth-section.test.ts': '80d65e4651601d320447bf188d53548a5ef5f8ba',
  'src/web/channel-monitor.ts': 'd1c642f669ff2a28b6eec79bbf503365c9ac1b08',
  'src/web/routes/messages.ts': '98710db9e171616e0600061eec649542e779506a',
  // Card 272361eb, 2026-09-04 (B-wave 3/6).
  'src/web/claude-plans.ts': '548f996dbe82ae1062e94ced4acb5a670bfd2bf9',
  'src/__tests__/channel-monitor-resume-recovery.test.ts': 'e7850cae42ac213af8bcb18dfc9d8c72acae9370',
  // Card 39b32ac6, 2026-09-04 (B-wave 2/6): both sides appended a SEEDREFRESH826 block at the tail.
  'src/__tests__/seed-refresh-untouched-only.test.ts': 'db592152fd319865336fe07aa0ee184d1790a192',
}

/** A conflict whose written rule was decided against DIFFERENT upstream content than what is
 *  there now. Not "unwatched" -- somebody did look at this file -- but the thing they looked at
 *  has moved, so the acknowledgement no longer says anything about today's conflict. */
export interface StaleAcknowledgement {
  readonly file: string
  readonly recorded: string
  readonly actual: string
  /** The rule that was written LAST time, carried into the failure message. A reader who is being
   *  asked to decide again needs to see what the previous decision actually said -- otherwise the
   *  gate blocks them and makes them go look it up, which is how a re-decision becomes a
   *  rubber-stamp. It is also why ACKNOWLEDGED_CONFLICTS has a runtime consumer and not only a
   *  type-level one. */
  readonly rule: string
}

/**
 * Split a conflict set into the three verdicts. Pure and injectable (`blobOf`) ON PURPOSE: the
 * live test around it only runs when the upstream remote is reachable, so without a seam the
 * classification itself would be exercised on exactly the machines that can already do a real
 * merge, and nowhere else. `blobOf` returns null when the path does not exist upstream (a
 * delete/modify conflict), which is a STALE acknowledgement, not a pass.
 */
export function classifyConflicts(
  conflicted: readonly string[],
  blobOf: (file: string) => string | null
): { guarded: string[]; unwatched: string[]; stale: StaleAcknowledgement[] } {
  const guarded = conflicted.filter((f) => (GUARDED_FILES as readonly string[]).includes(f))
  const acknowledged = conflicted.filter(
    (f) =>
      !guarded.includes(f) && Object.prototype.hasOwnProperty.call(ACKNOWLEDGED_UPSTREAM_BLOBS, f)
  )
  const unwatched = conflicted.filter((f) => !guarded.includes(f) && !acknowledged.includes(f))
  const stale: StaleAcknowledgement[] = []
  for (const file of acknowledged) {
    const recorded = (ACKNOWLEDGED_UPSTREAM_BLOBS as Readonly<Record<string, string>>)[file]!
    const actual = blobOf(file)
    if (actual !== recorded) {
      const rule = (ACKNOWLEDGED_CONFLICTS as Readonly<Record<string, string>>)[file]!
      stale.push({ file, recorded, actual: actual ?? '(absent upstream)', rule })
    }
  }
  return { guarded, unwatched, stale }
}

// Card 1e8111a3. Cybersec measured 8 unwatched-conflict occurrences where the failure message told
// the reader WHAT to do (decide a rule, record it in ACKNOWLEDGED_CONFLICTS/_BLOBS) but not HOW --
// every occurrence required hand-typing the file path and running `git rev-parse` to get the blob
// sha the message already had access to. These two functions build that entry instead of describing
// it, so the failure message becomes paste-and-edit rather than a from-scratch chore.

/** Pull the `<<<<<<<`/`=======`/`>>>>>>>` conflict hunks out of a merged file's raw content, so an
 *  unwatched-conflict message can show both sides without a second git invocation per file. Returns
 *  '' if the content has no conflict markers (e.g. git produced a binary "conflict" it cannot mark
 *  inline) -- the ready-to-paste entry below still works without it. */
export function extractConflictHunks(content: string, maxChars = 2000): string {
  const hunks: string[] = []
  let current: string[] | null = null
  for (const line of content.split('\n')) {
    if (line.startsWith('<<<<<<<')) {
      current = [line]
      continue
    }
    if (current) {
      current.push(line)
      if (line.startsWith('>>>>>>>')) {
        hunks.push(current.join('\n'))
        current = null
      }
    }
  }
  const joined = hunks.join('\n...\n')
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n... (truncated)` : joined
}

/** The ACKNOWLEDGED_CONFLICTS + ACKNOWLEDGED_UPSTREAM_BLOBS entry for a brand-new unwatched
 *  conflict, pre-filled with the one value this guard can supply with certainty (the upstream blob
 *  the decision would be read against). The resolution text stays a TODO on purpose -- which side to
 *  keep is human judgement, never derived. */
export function readyToPasteEntry(file: string, upstreamBlob: string | null): string {
  const blobLine = upstreamBlob ?? '(absent upstream -- delete/modify conflict, no blob to pin)'
  return (
    `  '${file}':\n` +
    `    'TODO -- decide what to keep from each side',\n` +
    `  // ACKNOWLEDGED_UPSTREAM_BLOBS:\n` +
    `  '${file}': '${blobLine}',`
  )
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: FETCH_TIMEOUT_MS })
}

function upstreamIsReachable(): boolean {
  try {
    execFileSync('git', ['remote', 'get-url', UPSTREAM_REMOTE], {
      cwd: REPO_ROOT,
      timeout: 5_000,
      stdio: 'pipe',
    })
    execFileSync('git', ['ls-remote', '--exit-code', UPSTREAM_REMOTE, 'HEAD'], {
      cwd: REPO_ROOT,
      timeout: FETCH_TIMEOUT_MS,
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

const canRun = upstreamIsReachable()
const SKIP_REASON =
  `the '${UPSTREAM_REMOTE}' remote is not configured or not reachable from this environment ` +
  '(no network, or CI has no upstream fetch access). This guard needs a live upstream fetch, so it ' +
  'skips rather than false-failing on an environment limitation.'

// Pure, so both states are unit-testable without touching real network reachability (card
// d359535c, Cybered's finding): the old META test asserted only `typeof canRun === 'boolean'`,
// which is true whichever way canRun goes -- it could never distinguish armed from skipped, so a
// suite with a dead upstream remote read exactly as green as one with a live one, and the only
// trace of the difference was a console.log line most CI views never surface.
//
// The fix does NOT make the guard fail when skipped -- that would reopen exactly the false-red-on-
// an-environment-limitation problem this file's header comment already rejected (same discipline as
// REPO_UNDER_TMP-gated suites: skip, do not false-fail, when the precondition is an environment
// fact rather than a code defect). Instead the skip state is baked into the TEST'S OWN NAME, which
// every reporter shows (console list, JUnit XML, GitHub Actions summary) -- unlike a console.log
// line, a test name cannot be collapsed or filtered out of a green run's summary.
export function metaAnnouncement(armed: boolean): { name: string; message: string } {
  return armed
    ? {
        name: 'META: ARMED -- upstream reachable, the merge-conflict guard below actually ran',
        message:
          '[fork-upstream-conflict-guard] ARMED -- upstream reachable, running the real merge dry-run.',
      }
    : {
        name: 'META: SKIPPED -- the merge-conflict guard below did NOT run this pass (no upstream reachability)',
        message: `[fork-upstream-conflict-guard] SKIPPED -- ${SKIP_REASON}`,
      }
}

const META = metaAnnouncement(canRun)

describe('fork/upstream web-file merge-conflict guard (card 641aca3f)', () => {
  it(META.name, () => {
    console.log(META.message)
    // Content check, not a type check: pins the message to the SAME state the test name reports,
    // so the two cannot drift apart silently.
    expect(META.message).toContain(canRun ? 'ARMED' : 'SKIPPED')
  })

  it.skipIf(!canRun)(
    'a real merge of upstream/develop conflicts on ZERO fork-owned web files',
    () => {
      const worktree = mkdtempSync(join(tmpdir(), 'fork-conflict-guard-'))
      try {
        git(['fetch', '--quiet', UPSTREAM_REMOTE, UPSTREAM_BRANCH], REPO_ROOT)
        // Detached worktree of our own HEAD -- never touches the real checkout's index or files.
        git(['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD'], REPO_ROOT)

        let conflicted: string[] = []
        const conflictHunks: Record<string, string> = {}
        try {
          git(
            ['merge', '--no-commit', '--no-ff', `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`],
            worktree
          )
          // Clean merge, nothing conflicted anywhere.
        } catch {
          conflicted = git(['diff', '--name-only', '--diff-filter=U'], worktree)
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
          // Grab both sides' conflict markers WHILE the working tree still has them -- `merge
          // --abort` below wipes this, so it is now or never (card 1e8111a3, ready-to-paste
          // failure message).
          for (const f of conflicted) {
            try {
              conflictHunks[f] = extractConflictHunks(readFileSync(join(worktree, f), 'utf-8'))
            } catch {
              // Binary file, or otherwise unreadable as text -- the ready-to-paste entry below
              // still works without a hunk snippet.
            }
          }
        } finally {
          try {
            git(['merge', '--abort'], worktree)
          } catch {
            // Nothing to abort (merge did not start / already clean) -- fine.
          }
        }

        const blobOf = (f: string): string | null => {
          try {
            return git(['rev-parse', `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}:${f}`], worktree).trim()
          } catch {
            return null // deleted upstream -- a delete/modify conflict, not a match
          }
        }

        // One classification for all three verdicts, from the same pure function the offline
        // tests below exercise -- so what runs here is not a second, hand-inlined copy of the
        // rules that could drift from the one that is actually unit-tested.
        const verdict = classifyConflicts(conflicted, blobOf)

        const conflictedGuardedFiles = verdict.guarded
        expect(
          conflictedGuardedFiles,
          `upstream/develop now conflicts on fork-owned web file(s): ${conflictedGuardedFiles.join(', ')}. ` +
            'The "zero-conflict" claim in the README\'s "Upstream-owned vs fork-owned fájlok" section no ' +
            'longer holds -- re-run the card 641aca3f investigation (measure whether an overlay extraction ' +
            'is now justified) before the next upstream integration.'
        ).toEqual([])

        // The check the original guard could not make (card f085fd44). Watching four named files
        // means a conflict anywhere else is invisible: three files -- one of them behaviour-critical
        // -- had been conflicting with nothing watching, and were found only because a human ran
        // the dry-run by hand. So this asserts on the WHOLE conflict set: every conflicting file
        // must be one someone has already decided how to resolve.
        const unwatched = verdict.unwatched
        // Card 1e8111a3: the entry below, not just the instruction to write one. blobOf() is the
        // same closure classifyConflicts already consulted for acknowledged files -- calling it
        // again here for unwatched ones costs one more `git rev-parse` per file, paid only on the
        // failure path.
        const unwatchedGuidance = unwatched
          .map(
            (f) =>
              `\n--- ${f} ---\n` +
              readyToPasteEntry(f, blobOf(f)) +
              (conflictHunks[f] ? `\n\n  both sides' conflicting hunk(s):\n${conflictHunks[f]}` : '')
          )
          .join('\n')
        expect(
          unwatched,
          `upstream/develop conflicts on file(s) nobody has decided how to resolve: ${unwatched.join(', ')}. ` +
            'Decide the rule NOW, while there is time to look at both sides, and record it in ' +
            'ACKNOWLEDGED_CONFLICTS above -- not during the merge, when the cheap move is to take one ' +
            'side wholesale. If the file is fork-owned and should never conflict, it belongs in ' +
            `GUARDED_FILES instead. Ready-to-paste entries:${unwatchedGuidance}`
        ).toEqual([])

        // THE ACKNOWLEDGEMENT MUST STILL DESCRIBE WHAT IS THERE (card a1d613e3). The two checks
        // above only ask WHETHER a file was decided about; this one asks whether the decision was
        // read against TODAY's upstream content. Without it the exemption is permanent: card
        // 0ea89716 put installer-start-and-fallback.test.ts on the list precisely because upstream
        // keeps editing it, so a LATER, different conflict there -- in a test whose whole job is to
        // measure that an installer abort really happened -- would have crossed this gate in
        // silence, on the strength of a decision about some other hunk.
        expect(
          verdict.stale,
          'the upstream side of these acknowledged conflicts has CHANGED since the rule was ' +
            'written, so the recorded resolution no longer describes the conflict it is exempting: ' +
            verdict.stale
              .map(
                (s) =>
                  `${s.file} (recorded ${s.recorded.slice(0, 12)}, now ${s.actual.slice(0, 12)}) ` +
                  `-- the rule written last time was: "${s.rule}"`
              )
              .join('; ') +
            '. Read both sides again, update the rule in ACKNOWLEDGED_CONFLICTS if the resolution ' +
            'changed, then record the new sha in ACKNOWLEDGED_UPSTREAM_BLOBS. `git rev-parse ' +
            `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}:<file>\` prints it.`
        ).toEqual([])
      } finally {
        try {
          git(['worktree', 'remove', '--force', worktree], REPO_ROOT)
        } catch {
          rmSync(worktree, { recursive: true, force: true })
        }
      }
    }
  )
})

// Always runs, no network involved: pins BOTH states of metaAnnouncement() deterministically (card
// d359535c). The live META test above can only ever exercise whichever state this environment
// happens to be in right now -- these two cases are what actually prove the skip path produces a
// distinct, loud test name rather than silently reusing the armed one.
describe('metaAnnouncement (card d359535c: the skip state must be loud, not just typeof-boolean)', () => {
  it('armed: the name says ARMED and the message matches', () => {
    const a = metaAnnouncement(true)
    expect(a.name).toContain('ARMED')
    expect(a.name).not.toContain('SKIPPED')
    expect(a.message).toContain('ARMED')
  })

  it('skipped: the name says SKIPPED and the message matches -- this is what used to be invisible', () => {
    const a = metaAnnouncement(false)
    expect(a.name).toContain('SKIPPED')
    expect(a.name).not.toContain('ARMED')
    expect(a.message).toContain('SKIPPED')
  })

  it('the two states never produce the same test name (armed cannot masquerade as skipped or vice versa)', () => {
    expect(metaAnnouncement(true).name).not.toBe(metaAnnouncement(false).name)
  })
})

// Offline half of card a1d613e3. The live guard above only runs where the upstream remote is
// reachable, so without these the content-binding would be exercised nowhere else -- and the whole
// finding was about a check that looked present and decided nothing.
describe('classifyConflicts: an acknowledgement is bound to CONTENT, not to a file name (card a1d613e3)', () => {
  // Cybersec's own example: a watchdog test that upstream keeps editing, exempted by name.
  const WATCHDOG = 'src/__tests__/installer-start-and-fallback.test.ts'
  const RECORDED = '9017ce4fcfe808b73fdcd1389ebf1c9eaf374f7e'

  it('the fixture is a REAL entry, not a name that happens to look like one', () => {
    // Without this, every case below could be measuring the "unwatched" path by accident: a typo in
    // WATCHDOG would send it there and the stale cases would trivially "pass" for the wrong reason.
    expect(Object.keys(ACKNOWLEDGED_UPSTREAM_BLOBS)).toContain(WATCHDOG)
    expect(ACKNOWLEDGED_UPSTREAM_BLOBS[WATCHDOG]).toBe(RECORDED)
  })

  it('SAME file, SAME upstream blob -> still acknowledged, the landing is not stopped twice', () => {
    const v = classifyConflicts([WATCHDOG], () => RECORDED)
    expect(v.unwatched).toEqual([])
    expect(v.stale).toEqual([])
  })

  it('THE DEFECT: same file, DIFFERENT upstream content -> blocks again instead of passing', () => {
    // This is the case that used to be silent forever. The name was on the list, so the guard said
    // nothing -- about a hunk nobody had ever looked at, in a test that measures whether an
    // installer abort really happened.
    const moved = 'ffffffffffffffffffffffffffffffffffffffff'
    const v = classifyConflicts([WATCHDOG], () => moved)
    expect(v.stale).toEqual([
      { file: WATCHDOG, recorded: RECORDED, actual: moved, rule: ACKNOWLEDGED_CONFLICTS[WATCHDOG] },
    ])
    // The PREVIOUS rule travels with the finding. Blocking someone and making them go look up what
    // they decided last time is how a re-decision turns into a rubber-stamp.
    expect(v.stale[0]!.rule).toContain('TRAP:5')
    // Still not "unwatched" -- somebody DID decide about this file. The two verdicts are different
    // questions and the messages a reader gets must not be interchangeable.
    expect(v.unwatched).toEqual([])
  })

  it('a delete/modify conflict (gone upstream) is stale, not a pass', () => {
    const v = classifyConflicts([WATCHDOG], () => null)
    expect(v.stale).toEqual([
      {
        file: WATCHDOG,
        recorded: RECORDED,
        actual: '(absent upstream)',
        rule: ACKNOWLEDGED_CONFLICTS[WATCHDOG],
      },
    ])
  })

  it('an undecided file is still UNWATCHED, and is never reported as stale', () => {
    const v = classifyConflicts(['src/some/brand-new-file.ts'], () => 'whatever')
    expect(v.unwatched).toEqual(['src/some/brand-new-file.ts'])
    expect(v.stale).toEqual([])
  })

  it('a fork-owned GUARDED file is classified as guarded, not as undecided', () => {
    const v = classifyConflicts([GUARDED_FILES[0]], () => 'whatever')
    expect(v.guarded).toEqual([GUARDED_FILES[0]])
    expect(v.unwatched).toEqual([])
    expect(v.stale).toEqual([])
  })

  it('blobOf is consulted ONLY for acknowledged files -- no needless git call per conflict', () => {
    const asked: string[] = []
    classifyConflicts([WATCHDOG, 'src/some/brand-new-file.ts', GUARDED_FILES[0]], (f) => {
      asked.push(f)
      return RECORDED
    })
    expect(asked).toEqual([WATCHDOG])
  })
})

// Offline unit tests for the two card-1e8111a3 helpers -- no network, no worktree, so the format of
// the ready-to-paste entry is pinned even on a machine where `upstream` is unreachable.
describe('readyToPasteEntry + extractConflictHunks (card 1e8111a3: hand a paste-ready entry, not just an instruction)', () => {
  it('readyToPasteEntry embeds the file path and the resolved upstream blob', () => {
    const entry = readyToPasteEntry('src/some/brand-new-file.ts', 'deadbeef00000000000000000000000000000000')
    expect(entry).toContain("'src/some/brand-new-file.ts'")
    expect(entry).toContain('deadbeef00000000000000000000000000000000')
    expect(entry).toContain('ACKNOWLEDGED_UPSTREAM_BLOBS')
    // The resolution itself is never guessed -- it is human judgement.
    expect(entry).toContain('TODO')
  })

  it('readyToPasteEntry states a delete/modify conflict plainly when there is no blob', () => {
    const entry = readyToPasteEntry('src/some/deleted-upstream.ts', null)
    expect(entry).toContain('absent upstream')
    expect(entry).not.toContain('null')
  })

  it('extractConflictHunks pulls out exactly the marked region, not the whole file', () => {
    const content = [
      'line before',
      '<<<<<<< HEAD',
      'fork version',
      '=======',
      'upstream version',
      '>>>>>>> upstream/develop',
      'line after',
    ].join('\n')
    const hunk = extractConflictHunks(content)
    expect(hunk).toContain('fork version')
    expect(hunk).toContain('upstream version')
    expect(hunk).not.toContain('line before')
    expect(hunk).not.toContain('line after')
  })

  it('extractConflictHunks joins multiple hunks in the same file', () => {
    const content = [
      '<<<<<<< HEAD',
      'a-fork',
      '=======',
      'a-upstream',
      '>>>>>>> upstream/develop',
      'unrelated middle',
      '<<<<<<< HEAD',
      'b-fork',
      '=======',
      'b-upstream',
      '>>>>>>> upstream/develop',
    ].join('\n')
    const hunk = extractConflictHunks(content)
    expect(hunk).toContain('a-fork')
    expect(hunk).toContain('b-upstream')
    expect(hunk).not.toContain('unrelated middle')
  })

  it('extractConflictHunks returns empty for content with no markers (e.g. a binary conflict)', () => {
    expect(extractConflictHunks('just some ordinary file content\n')).toBe('')
  })

  it('extractConflictHunks truncates a hunk larger than the given cap', () => {
    const bigLine = 'x'.repeat(5000)
    const content = ['<<<<<<< HEAD', bigLine, '=======', 'short', '>>>>>>> upstream/develop'].join(
      '\n'
    )
    const hunk = extractConflictHunks(content, 200)
    expect(hunk.length).toBeLessThan(250)
    expect(hunk).toContain('truncated')
  })
})

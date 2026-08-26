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
const GUARDED_FILES = ['web/lang/hu.js', 'web/lang/en.js', 'web/style.css'] as const

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
  // BEHAVIOUR-CRITICAL. The fork removed "upgrade to increase your usage limit" from the
  // usage-limit regex (2026-06-30: it matched Claude Code's /upgrade STARTUP HINT, so fresh agents
  // read as limited and got needlessly downgraded). Upstream still has that token AND added a real
  // "session limit" variant (2026-08-08). Resolution: ADOPT the session-limit alternative, KEEP the
  // /upgrade removal. Neither side's file may be taken wholesale -- see the pinned pair in
  // model-fallback.test.ts ("keeps BOTH halves of the fork/upstream resolution at once").
  'src/model-fallback.ts':
    'take upstream session-limit alternative, keep the fork /upgrade removal (never a wholesale side)',
  // The test file diverges with the module it tests: fork-only weekly-tier tests plus the pinned
  // resolution pair above. Resolution: keep both sides' cases, drop neither.
  'src/__tests__/model-fallback.test.ts':
    'union of both sides cases -- fork weekly-tier + upstream additions',
  // The fork restructured this file into a MULTI-REPO aggregate (marveen + mikrob blocks, per-repo
  // results in `repos`); upstream kept the single-result shape and is still adding features to it,
  // e.g. the running `version` in the Updates header (upstream aefa693). So it is not "fork parts
  // are additive" in either direction -- measured 2026-08-14, the fork side currently LACKS that
  // version field. Resolution: keep the fork's aggregate structure, and port upstream's new
  // single-result features onto it one by one.
  'src/web/update-checker.ts':
    'keep the fork aggregate shape, port upstream single-result features onto it',
  // A one-line import conflict, not a behavioural one (measured 2026-08-16, card 78c14372): the fork
  // added `agentDir` to the existing import from './agent-config.js' (workingDirFor() now goes
  // through the sanitized helper instead of building its own path), and upstream independently added
  // `readAgentClaudeConfigDir` to the SAME import line for an unrelated feature. Nothing else in the
  // file diverges. Resolution: merge both imports onto one line, keep both bindings.
  'src/web/context-restart-gate-runner.ts':
    'merge both added imports onto one line (agentDir from the fork, readAgentClaudeConfigDir from upstream) -- no other conflict in the file',
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
  // hunk, no other conflict in the file.
  'src/web.ts':
    'merge import line (ensureNpmProtectGuard from fork + ensureSkillsPathTrapSection + watchEgressAllowlistForReaderRender + listAllAgentNames from upstream, all on one line, keep listAgentNames too), adopt upstream watchEgressAllowlistForReaderRender call (EGRESSRENDER824) and the hook-seed loop\'s listAllAgentNames call-site swap (HBGATEWIRE826) -- no other conflict in the file',
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
    'keep BOTH section-writers (fork ensureLocalFirstSection + upstream ensureSkillsPathTrapSection), AND adopt upstream kanban-write gate (agentGetsKanbanWriteGate/injectKanbanWriteGate), quarantineReader project-scope refactor (EGRESSRENDER824), and watchEgressAllowlistForReaderRender -- all additive, none taken wholesale',
  // A single additive hunk (measured 2026-08-16, card 88505fb5), not a behavioural disagreement:
  // both sides add an INDEPENDENT schema migration/trigger at the same insertion point inside
  // ensureSchema(). Fork: the timestamp-integrity triggers (epoch validation + repair on
  // kanban_cards/kanban_comments) plus the kanban_card_events.forced column migration. Upstream:
  // the kanban_cards_status_bumps_updated_at self-healing trigger (keeps updated_at honest when a
  // raw SQL UPDATE only touches status). Neither reads or overwrites anything the other writes.
  // Resolution: keep BOTH blocks, either order -- union, not a pick.
  'src/db.ts':
    'keep both additive migrations -- the fork timestamp-integrity triggers + forced column, and the upstream kanban_cards_status_bumps_updated_at trigger -- neither side taken wholesale',
  // Card 2e634e5c. Both sides independently fixed the SAME ghost-session bug (agent DELETE leaving
  // an orphaned tmux session), but the fork's fix is strictly more correct: it AWAITS
  // stopAgentProcess(), tracks the result, and logs on failure; upstream's is a floating (un-awaited)
  // call to the same async function -- the exact race its own comment warns against ("must run while
  // the dir still exists"), since rmSync(dir) right after can start before the un-awaited stop
  // finishes reading the config. Measured 2026-08-16. Resolution: keep the fork's version wholesale,
  // upstream adds nothing the fork lacks here.
  'src/web/routes/agents.ts':
    'keep the fork version wholesale -- it already awaits stopAgentProcess() and tracks/logs the result; upstream is an un-awaited (racy) reimplementation of the same fix',
  // Card 2e634e5c, three hunks, all resolving the same direction. (1) The dispatch-instruction-text
  // generator: upstream's variant tells the agent to move its OWN card straight to `"status":"done"`
  // -- that is upstream's own (simpler) workflow, and directly contradicts this fork's core rule
  // that a builder never self-closes to done (root CLAUDE.md rule 4); the fork's `"status":"waiting"`
  // text is the one actually in force. (2)+(3) fireKanbanDispatch's `actor` param and the /move
  // handler: the fork ALREADY implements upstream's stated goal (actor-based self-advance dispatch-
  // echo suppression, see the unconflicted comment right after hunk 2) using `actor?: string`
  // (matches the rest of the file's `typeof actor === 'string'` handling), and additionally carries
  // TWO fork-only gates upstream's /move handler lacks entirely: newDevStopWouldBlock() (weekly-quota
  // stop) and landedGuardVerdict() (blocks reopening a waiting-for-gate card without force=true) --
  // taking upstream's handler wholesale would silently drop both. Measured 2026-08-16. Resolution:
  // keep the fork version wholesale in all three hunks.
  'src/web/routes/kanban.ts':
    "keep the fork version wholesale in all three hunks -- upstream's dispatch text tells the agent to self-close to done (violates fork rule 4), and its /move handler lacks the fork-only newDevStopWouldBlock + landedGuardVerdict gates",
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
    "keep the fork async measurePct/configDirFor; adopt upstream measureContextTokens+measureIdleMs to wire the fork's existing idleFlushEnabled domain logic, making measureContextTokens async (fork's readContextTokensFromProjectDir is async, upstream's is sync) and awaiting its two call sites in checkAgent",
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
    'STUB scaffold + 36 extracted web/app-*.js slices are authoritative; a conflicting upstream hunk must be diffed against its named slice file and only genuinely-new upstream behavior ported forward, never taken wholesale -- proven on the i18n-nav hunk (found + fixed one real gap: missing renderUpdatesVersion re-apply on language switch). Re-audited 2026-08-25 (card 9ef96512, blob c8c11f94): 3 upstream hunks, all in the loadOllamaModels / resetWizard / startup-init region (app-settings.js). Ported: (1) loadOllamaModels refactored to populate both optgroups (ollamaModelGroup edit-panel + agentModelOllamaGroup wizard -- wizard was missing local-model option entirely); (2) agentModelOllamaGroup added to wizard HTML (index.html); (3) resetWizard() now calls loadOllamaModels() (app-wizard.js); (4) loadOllamaModels() added to startup init (app-settings.js). No behavioral gap found in any other region. Remaining ~11k lines (other regions) not yet hand-audited slice-by-slice.',
  // Two independent additive hunks with no behavioral overlap. Fork adds: HEARTBEAT.md ignore,
  // Ingatlan/ runtime data exclusions, and per-extension keep-tracked exceptions for operational
  // scripts (store/*.sh, store/*.py, store/stitch-tools/gen.mjs) by switching store/ → store/*
  // with negation rules. Upstream adds: .pre-ship-evidence/, evidence/, transcripts/,
  // .session-capture/ (EVIDGUARD818 -- captured output never belongs in repo). Resolution: union
  // of both sides -- keep the fork's store/* + negation lines (the fork's more nuanced pattern
  // supersedes upstream's bare store/ line), and append upstream's evidence/transcript ignores.
  '.gitignore':
    'union of both additive sides: keep fork store/* + !store/*.sh/py/stitch negation structure + Ingatlan/ + HEARTBEAT.md, AND append upstream EVIDGUARD818 evidence/transcript/session-capture ignores -- both sides add to non-overlapping regions',
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
  'src/web/heartbeat-agent-scaffold.ts':
    'two-way merge: adopt upstream metrics-script approach (HBMEMBLIND819 third contract -- bash heartbeat-metrics.sh, HeartbeatIdentity.metricsScript, HEARTBEAT_AGENT_ID import, updated report format using COUNTS/URGENT/WAITING/SCHEDULES/TASK_RUNS_1H lines verbatim) for the kanban section; keep fork printf|curl token-argv-safe pattern for the remaining curl calls (quota park + inter-agent message) that upstream did not touch',
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
    'two independent non-overlapping changes: keep the fork async runPreCheck signature (955f014e) and the fork try/catch around startAgentProcess (e9d3cd12); adopt upstream quotaWorkClass() and the cleanly-merging sawTurn/lost watchdog',
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
  'src/web/agent-process.ts':
    'keep the fork *Unlocked private bodies + withLifecycleLock wrappers on all three signature hunks (start/stop/restart) -- upstream exports the same functions unlocked, which would delete the card 74ba7c78 atomicity; upstream body changes outside those lines merge cleanly and are kept',
  // Upstream adds a re-entrancy guard (`tickRunning`) around the sweep, for the exact reason the
  // fork ALSO has: once checkAgent awaits a real restart instead of a blocking execSync('sleep N')
  // (fork card 873c48df), a sweep can still be running when the next interval fires. Measured: the
  // fork's sweep has NO overlap protection of any kind, so this is something upstream has and the
  // fork lacks, not a duplicate. The fork's sweep BODY is unchanged inside upstream's try/finally.
  'src/web/auto-restart-runner.ts':
    'adopt upstream tickRunning re-entrancy guard (the fork sweep has no overlap protection and its restart path is equally async), keeping the fork sweep body verbatim inside the try/finally',
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
    "keep the fork file wholesale -- it already carries upstream's is_send_invocation() verbatim (adopted for card 3ec64c96) plus the fork's own separate load_bad_name() sentinel fix upstream lacks (and appears to have reverted on its own side); if upstream's detector changes again, re-adopt that section only, leaving the sentinel fix and attribution comment untouched. Upstream's new fail-closed __main__ wrapper is a candidate for future adoption, not yet taken.",
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
  'scripts/limit-monitor.sh': "keep the fork's session-limit-pattern.sh sourcing (canonical regex, card 115c21e7) + its own extra-signal regex, graft upstream's honest-send-via-lib + stamp-dedupe-hash-only-on-confirmed-success onto the alert block. Round 2 (MD5SUMHIANY826, QA fbb36b41 round-8 stale-blob catch): upstream replaced the bare `md5sum | awk` dedupe hash (empty string on macOS, silently swallowing every alert) with the shared scripts/lib/content-hash.sh dedupe_check() -- fail-open on no hashing tool, no stamp written on an empty hash. Grafted onto the same alert block, fork logic unchanged.",
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
    'keep the fork\'s -H @"$_hdr_file" 0600-temp-file security pattern (card b267df80) unchanged, append upstream\'s HTTP-status-capture honest-delivery check (NOTIFYVAKSWEEP826) on both guard-alert call sites',
  // Independent-additive, same class as the src/web.ts import-line conflicts: fork's {{CHAT_ID}}
  // and upstream's {{PROJECT_ROOT}} both added to the SAME sed chain in render_seed_template().
  // Keep both. (Also required adding {{PROJECT_ROOT}} to install-linux.sh/install-macos.sh's own
  // seed-scheduled-tasks loops to satisfy the fork's own seed-render-parity guard, card d041760b --
  // done alongside this fix, see update.sh/install-*.sh diffs.)
  'update.sh':
    'independent-additive: keep both sed -e lines in render_seed_template() -- {{CHAT_ID}} from the fork (4 fleet-orchestration prompts) and {{PROJECT_ROOT}} from upstream (ledger-live-drain, node-seeder alias for {{INSTALL_DIR}})',
  // A REAL security-regression risk unlike the two files above: THIS conflict hunk has the fork's
  // -H @"$hdr_file" 0600-temp-file call INSIDE the conflicting region (not shared context), and
  // upstream's replacement uses a bare `-H "Authorization: Bearer $(cat "$TOKEN_FILE")"` --
  // exactly the token-in-argv vulnerability (/proc/<pid>/cmdline is world-readable) the fork's own
  // comment warns about. Taking upstream wholesale here would have been a real regression.
  // Resolution: keep the fork's hdr_file call, graft upstream's GUARD_HTTP status-capture +
  // stderr-on-non-2xx logging on top (same NOTIFYVAKSWEEP826 pattern as channels.sh).
  'scripts/install-prod-tree-guard-hook.sh':
    'keep the fork\'s -H @"$hdr_file" 0600-temp-file security pattern (upstream\'s replacement would have leaked the token via curl argv), graft upstream\'s GUARD_HTTP status-capture + non-2xx stderr logging (NOTIFYVAKSWEEP826) on top',
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
  'src/model-fallback.ts': 'd1ed3c18ba86badd1f72cf6fb28d1f3193974012',
  'src/__tests__/model-fallback.test.ts': '38b6e76e9f5184a9ade636a057b79c4e522f1e3b',
  'src/web/update-checker.ts': '24e46f990c7b0a5c8fa065d12ba1ee592b547691',
  'src/web/context-restart-gate-runner.ts': 'aae818bb7ded38146343eb0a0748b83422d018ce',
  'src/web.ts': '67695fc52c4a2e802b9ca79edda0649f1d802d33',
  'src/web/keychain.ts': '1e1730ee0d8f6b1d4b51c5c254f3fab56acfa376',
  'src/web/agent-scaffold.ts': '3082c145b46770b40d586f2266a3446d6a28b826',
  'src/db.ts': '66381e77bdb6cce583bd3b397a3ae2202ae61e9e',
  'src/web/routes/agents.ts': '7711d18a7752828a113f9389a2c3943e6b74ab0e',
  'src/web/routes/kanban.ts': '5620fe397bdadad1a619408367a783d0470a13fe',
  'scripts/hooks/egress-gate.mjs': '229076d5812e7d50a188ca07b43a87fb6239b233',
  'src/__tests__/egress-gate.test.ts': 'c24ca54ffc49de70d602790fa1d6b80e3aea4156',
  'src/web/context-guard-runner.ts': 'b17ba4f630dbba93cfd5520e3c37a854a5c80c81',
  'web/app.js': 'c8c11f94ac1007da3ce29f5cbbd4ab84a75a8701',
  '.gitignore': '1e5adbb2332be0dbf5a710c1899e49305ccb318b',
  'package.json': 'bbb946b636ac92c4e69abd4d62d4762c35105347',
  'package-lock.json': 'a3e12f8a7eb91de9556b3b84acf928c1c22cfcef',
  'src/web/heartbeat-agent-scaffold.ts': '26c691e53e1283d4cee2543e53f26532b0a9c06c',
  'src/web/schedule-runner.ts': '9736ea6737757cc0155671dca3d9d2874b330885',
  'vitest.config.ts': '62d4ac7606cd719d40e07fc0d82c7f777dda0b30',
  'src/web/agent-process.ts': 'bb28237a19c881551c8415ebeecd58fcaac01923',
  'src/web/auto-restart-runner.ts': '40b83f7012812cc0bdf48f1e093dd8b8d6bb4db2',
  'src/web/model-fallback-runner.ts': '681fcaefd6588fc2f6f3db880238b8288d1dcd15',
  'src/web/routes/skills.ts': '34c1e440bd5009e79546d686ec9fbc481ba0af7e',
  'src/web/routes/agents-skills.ts': '23a380b7d40b5cd70885d9205c6fb4cc1fe9dbfe',
  'scripts/email-send-gate.mjs': 'abaaedc4d0e9f76fa159307659473ffaac306411',
  'src/__tests__/hook-command-quoting.test.ts': '1048b1988e6c8554754900c62570d76d455f1057',
  'src/__tests__/installer-start-and-fallback.test.ts': '9017ce4fcfe808b73fdcd1389ebf1c9eaf374f7e',
  'scripts/hooks/outgoing-copy-gate.py': 'cd51631d01de4aa84776a3ad5ff8d8f6a85aa167',
  'scripts/notify.sh': '5477e66ecad5cca6425a535de0d16fce0e3eca28',
  'scripts/lib/send-telegram.sh': '293aecf24507b6d56bda99e5a4ff937e1491ab97',
  'scripts/disk-space-guard.sh': 'd3f693c01d607952a8165cc4d8106024008f22e4',
  'scripts/unit-fail-notify.sh': 'ada00f95a7b3665feac1305bb5287698b81839de',
  'scripts/limit-monitor.sh': '61c0d229af89a02ec949651888a5aee13b863ab2',
  'scripts/lib/content-hash.sh': 'a2fc1103d635bd7602229447cb299f4540cd3d22',
  'src/__tests__/content-hash.test.ts': '57cbbd6ffa36d800c3c9b9e8649acba17b960949',
  'scripts/host-restart-watchdog.sh': '07948350e336ec02d58d952df016ab6b07d7d052',
  'scripts/fleet-memory-gate.sh': 'ce2e49d6460c56cc49c7637dc0073d0172d5520f',
  'scripts/github-pr-monitor.sh': '545425b675857bcbdab5018dbcbb42dca1722416',
  'scripts/set-bot-menu.sh': 'b45aca69c59f9b69748592df70d0a9ea77189206',
  'scripts/stuck-modal-guard.sh': '5bf19fc208ac41c204ae007189553efcb1d2790d',
  'src/__tests__/notify-delivery-honesty.test.ts': '06f96abf8c49fb07b8bbf570c8ca895fe6f23ee9',
  'src/__tests__/telegram-urlencode-guard.test.ts': '(absent upstream -- delete/modify conflict, no blob to pin)',
  'src/__tests__/send-honesty-sweep.test.ts': 'afc17a2222a86a7645343f837618ebe74516dacc',
  'scripts/channels.sh': '440c177464c2bcf2d090f8958373b94e011e9f62',
  'update.sh': 'de0cad0164f4473d1cd1bd65dd019ae9465e4fe3',
  'scripts/install-prod-tree-guard-hook.sh': '9647c9658a5e6352ae0bae57842590a1c2d6e30c',
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

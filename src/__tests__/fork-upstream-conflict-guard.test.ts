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
import { mkdtempSync, rmSync } from 'node:fs'
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
const ACKNOWLEDGED_CONFLICTS: Readonly<Record<string, string>> = {
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
  'src/__tests__/model-fallback.test.ts': 'union of both sides cases -- fork weekly-tier + upstream additions',
  // The fork restructured this file into a MULTI-REPO aggregate (marveen + mikrob blocks, per-repo
  // results in `repos`); upstream kept the single-result shape and is still adding features to it,
  // e.g. the running `version` in the Updates header (upstream aefa693). So it is not "fork parts
  // are additive" in either direction -- measured 2026-08-14, the fork side currently LACKS that
  // version field. Resolution: keep the fork's aggregate structure, and port upstream's new
  // single-result features onto it one by one.
  'src/web/update-checker.ts': 'keep the fork aggregate shape, port upstream single-result features onto it',
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
  'src/web.ts':
    'merge both added imports onto one line (ensureNpmProtectGuard from the fork, ensureSkillsPathTrapSection from upstream) -- no other conflict in the file',
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
  'src/web/agent-scaffold.ts':
    'keep BOTH section-writers -- the fork ensureLocalFirstSection and the upstream ensureSkillsPathTrapSection -- and call both; neither side taken wholesale',
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
    'keep the fork version wholesale in all three hunks -- upstream\'s dispatch text tells the agent to self-close to done (violates fork rule 4), and its /move handler lacks the fork-only newDevStopWouldBlock + landedGuardVerdict gates',
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
  'scripts/hooks/egress-gate.mjs':
    'merge both sides in one egressDecision() -- fork Firecrawl namespace-default-deny + param-allowlist (91c4a369) run BEFORE upstream\'s not-webfetch early-return (which would otherwise reopen 91c4a369), then upstream\'s tier-based decision + quarantine tier + audit logging, with the quarantine tier extended to the two URL-bearing Firecrawl tools',
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
    'keep the fork async measurePct/configDirFor; adopt upstream measureContextTokens+measureIdleMs to wire the fork\'s existing idleFlushEnabled domain logic, making measureContextTokens async (fork\'s readContextTokensFromProjectDir is async, upstream\'s is sync) and awaiting its two call sites in checkAgent',
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
    'STUB scaffold + 36 extracted web/app-*.js slices are authoritative; a conflicting upstream hunk must be diffed against its named slice file and only genuinely-new upstream behavior ported forward, never taken wholesale -- proven on the i18n-nav hunk (found + fixed one real gap: missing renderUpdatesVersion re-apply on language switch), remaining ~11k lines not yet hand-audited slice-by-slice',
  // Two independent additive hunks with no behavioral overlap. Fork adds: HEARTBEAT.md ignore,
  // Ingatlan/ runtime data exclusions, and per-extension keep-tracked exceptions for operational
  // scripts (store/*.sh, store/*.py, store/stitch-tools/gen.mjs) by switching store/ → store/*
  // with negation rules. Upstream adds: .pre-ship-evidence/, evidence/, transcripts/,
  // .session-capture/ (EVIDGUARD818 -- captured output never belongs in repo). Resolution: union
  // of both sides -- keep the fork's store/* + negation lines (the fork's more nuanced pattern
  // supersedes upstream's bare store/ line), and append upstream's evidence/transcript ignores.
  '.gitignore':
    'union of both additive sides: keep fork store/* + !store/*.sh/py/stitch negation structure + Ingatlan/ + HEARTBEAT.md, AND append upstream EVIDGUARD818 evidence/transcript/session-capture ignores -- both sides add to non-overlapping regions',
  // Lock-file conflict from independently added/updated dependencies. The fork manages its own
  // package set; upstream its own. Regenerated by `npm ci` from the fork's package.json.
  // Resolution: keep the fork's lockfile; upstream lockfile sections for packages not in the
  // fork's package.json are not applicable.
  'package-lock.json': 'keep the fork lockfile canonical; regenerate from fork package.json via npm ci if ever needed',
  // Fork changed three curl calls to the `printf | curl -H @-` token-argv-safe pattern (security
  // fix: token never appears in process argv). Upstream replaced the main kanban heartbeat curl
  // command with a Python one-liner (HBHEREDOC819/HBKANBANDRIFT819 incident hardening: no pipe,
  // no heredoc, counts come from counts.* not from list length). Two independent changes on
  // partially-overlapping lines. Resolution: adopt upstream's Python one-liner + all accompanying
  // incident documentation for the kanban section; keep the fork's printf|curl pattern for the
  // OTHER curl calls in the file (the ones upstream did not replace with Python).
  'src/web/heartbeat-agent-scaffold.ts':
    'two-way merge: adopt upstream Python one-liner + HBHEREDOC819/HBKANBANDRIFT819 docs for kanban section; keep fork printf|curl token-argv-safe pattern for the remaining curl calls (quota park + inter-agent message section) that upstream did not touch',
  // Fork made runPreCheck async (spawnSync → execFile) with improved timeout/SIGTERM detection
  // via child.killed (card 68bfbff2). Upstream added SCHEDULE_JANITOR_PARKED_MIN_AGE_MS constant
  // + quota gate imports + quota work-class types for scheduled tasks. Changes are in non-
  // overlapping regions of the file. Resolution: keep both -- fork's async runPreCheck and
  // upstream's quota-gate additions sit in separate hunks and can be merged cleanly.
  'src/web/schedule-runner.ts':
    'two independent non-overlapping changes: keep fork async runPreCheck + child.killed SIGTERM fix; adopt upstream SCHEDULE_JANITOR_PARKED_MIN_AGE_MS + quota gate imports + quota work-class definitions',
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
        try {
          git(
            ['merge', '--no-commit', '--no-ff', `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`],
            worktree,
          )
          // Clean merge, nothing conflicted anywhere.
        } catch {
          conflicted = git(['diff', '--name-only', '--diff-filter=U'], worktree)
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        } finally {
          try {
            git(['merge', '--abort'], worktree)
          } catch {
            // Nothing to abort (merge did not start / already clean) -- fine.
          }
        }

        const conflictedGuardedFiles = conflicted.filter((f) =>
          (GUARDED_FILES as readonly string[]).includes(f),
        )
        expect(
          conflictedGuardedFiles,
          `upstream/develop now conflicts on fork-owned web file(s): ${conflictedGuardedFiles.join(', ')}. ` +
            'The "zero-conflict" claim in the README\'s "Upstream-owned vs fork-owned fájlok" section no ' +
            'longer holds -- re-run the card 641aca3f investigation (measure whether an overlay extraction ' +
            'is now justified) before the next upstream integration.',
        ).toEqual([])

        // The check the original guard could not make (card f085fd44). Watching four named files
        // means a conflict anywhere else is invisible: three files -- one of them behaviour-critical
        // -- had been conflicting with nothing watching, and were found only because a human ran
        // the dry-run by hand. So this asserts on the WHOLE conflict set: every conflicting file
        // must be one someone has already decided how to resolve.
        const unwatched = conflicted.filter(
          (f) =>
            !(GUARDED_FILES as readonly string[]).includes(f) &&
            !Object.prototype.hasOwnProperty.call(ACKNOWLEDGED_CONFLICTS, f),
        )
        expect(
          unwatched,
          `upstream/develop conflicts on file(s) nobody has decided how to resolve: ${unwatched.join(', ')}. ` +
            'Decide the rule NOW, while there is time to look at both sides, and record it in ' +
            'ACKNOWLEDGED_CONFLICTS above -- not during the merge, when the cheap move is to take one ' +
            'side wholesale. If the file is fork-owned and should never conflict, it belongs in ' +
            'GUARDED_FILES instead.',
        ).toEqual([])
      } finally {
        try {
          git(['worktree', 'remove', '--force', worktree], REPO_ROOT)
        } catch {
          rmSync(worktree, { recursive: true, force: true })
        }
      }
    },
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

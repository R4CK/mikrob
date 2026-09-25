// Fork/upstream conflict acknowledgements: the DATA and the pure decisions, with no test harness
// and no network around them (card 99c2eb09, parent 1f276349).
//
// This block used to live inside src/__tests__/fork-upstream-conflict-guard.test.ts, which meant the
// only way to ask "does upstream still merge the way we decided it does" was to run the vitest
// suite -- and that suite IS the landing gate. The check fetches upstream at runtime, so it made
// every agent's landing depend on what an unrelated upstream commit did in the last few minutes.
// Measured from that file's own re-measure notes: 41 "landing-block" mentions, 32 re-measure rounds
// in five days, five agents, eight cards, one card hit thirteen times.
//
// MikroB's decision (24642, direction "C"): the NETWORK-dependent check moves out of the landing
// gate into a scheduled drift watcher, while the OFFLINE structural assertions stay in the suite,
// where they are deterministic and are genuinely about our own tree. Both sides read this ONE
// module, so the acknowledgements cannot drift into two disagreeing copies -- the same failure the
// shared agent_messages DDL exists to prevent (card 26ad5302).
//
// Nothing here reads the filesystem, spawns a process, or talks to a remote. Everything that does
// lives in the runner beside it.


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
// web/lang/hu.js + web/lang/en.js moved OUT to ACKNOWLEDGED_CONFLICTS (card 368b77f7, measured
// 2026-09-04): upstream's BRIDGEHU813 (#1170) appended pairing-error strings to the same tail the
// fork appends its own keys to. Third instance of the same pattern, same resolution as the two
// above. The measurement is in the entry below and says why an overlay was NOT extracted.
//
// THE LIST IS NOW EMPTY, and that is a real state, not a gap: every file it ever held is watched by
// the stricter `unwatched` check instead, which asserts on the WHOLE conflict set rather than a
// hand-picked few. MIGRATED_FROM_GUARDED below keeps that honest -- an empty list would otherwise
// make the guarded assertion pass by having nothing to check.
// The ACKNOWLEDGED_UPSTREAM_BLOBS value for a delete/modify conflict: upstream has genuinely deleted
// the file, so there is no real blob to pin at all. The map type requires a string for every
// ACKNOWLEDGED_CONFLICTS key, so this sentinel is the only type-safe way to say "not applicable" --
// but it must be a SHARED constant, not a literal repeated at each site that needs to recognise it
// (card b5b7eb6b follow-up, backend3, 2026-09-25): drift-check.ts's corrupted-pin detector
// (findCorruptedPins) ran `git cat-file -e` against EVERY recorded value with no exemption for this
// one, so the one legitimate use of it (src/__tests__/telegram-urlencode-guard.test.ts, below) was
// reported as a corrupted pin every round -- a false positive from the exact class of bug this
// session already found once today in agent-worktree.sh (a hardcoded literal two places needed to
// agree on, silently drifting apart).
export const ABSENT_UPSTREAM_BLOB = '(absent upstream -- delete/modify conflict, no blob to pin)'

export const GUARDED_FILES = [] as const

// Every file that was ever in GUARDED_FILES. Each must still be ACKNOWLEDGED, with a written rule:
// migrating a file out of the zero-conflict claim is a decision, and dropping one entirely -- which
// would silence it in both lists at once -- must not be possible by deleting a single line.
export const MIGRATED_FROM_GUARDED = [
  'web/app.js',
  'web/style.css',
  'web/lang/hu.js',
  'web/lang/en.js',
] as const

// Files that DO conflict today, deliberately, and whose resolution rule is written down (card
// f085fd44). This list is not a second copy of the one above: those files must never conflict,
// these are KNOWN to, and the point of naming them is that the resolution is a decision someone
// already made rather than one improvised mid-merge.
//
// They are listed here for one reason -- so the check below can be about the WHOLE conflict set
// rather than four hand-picked files. Before this, a manual list of four could only ever see what
// it already knew about: three files conflicted for weeks with nothing watching them, and the only
// reason anyone noticed was a human running the dry-run by hand.
export const ACKNOWLEDGED_CONFLICTS = {
  // Card 2a653b4b, self-created 2026-09-04. Converting the module-level `const TMUX =
  // resolveFromPath('tmux')` to a lazy resolver collided with upstream, which had already deleted
  // that const -- and gone FURTHER than this card asks: upstream routes every tmux call through
  // `tmuxInvocationFor` (agent-process.ts) because an agent owning its own OS user runs its own tmux
  // server, so a cross-user connection is refused and the bare binary made /keys and /login answer
  // 500 for exactly the agents most likely to need one. Upstream measured that twice on this install
  // (2026-08-26, 2026-08-27).
  //
  // Resolution: TAKE UPSTREAM WHOLESALE for this file -- it removes the eager const (this card's
  // goal) AND fixes a bug the fork still has. NOT adopted here on purpose: `tmuxInvocationFor` does
  // not exist in the fork at all, so adopting it means pulling from agent-process.ts, whose upstream
  // reconciliation is deliberately deferred (card e80c011a -- 22 hunks on a 1600-line
  // security-critical file, explicitly not to be hand-merged under time pressure). Until that lands,
  // the fork's lazy resolver is the INTERIM fix: strictly better than the import-time throw it
  // replaced, strictly worse than upstream's. Do not resolve this by keeping the fork side.
  'src/web/routes/agent-terminal.ts':
    "take UPSTREAM wholesale -- it deletes the eager TMUX const AND routes through tmuxInvocationFor, which fixes the own-OS-user tmux-server 500s the fork still has; the fork's lazy resolver is only an interim fix until agent-process.ts is reconciled (card e80c011a)",
  // Card 684dda18, self-created 2026-09-02: adopting upstream's resolveKanbanDispatch()
  // (session-down is no longer a silent no-op) appended the fork's own isSelfAdvanceMove/
  // isGenuineSelfAdvanceSwitch below it -- the fork's file is now a strict superset of upstream's
  // (verified: diffing the shared prefix shows zero divergence, the only delta is the fork-only
  // tail). Resolution: keep the fork version wholesale, it already contains everything upstream
  // has plus the fork-only additions.
  // Card 4f15966e (the upstream merge), conflict measured 2026-09-06. NEW entry: this file did not
  // conflict until card dbba0424 landed the fork's own detectsPermissionDialog the same day.
  //
  // BOTH SIDES BUILT THE SAME THING, from the same upstream report (PERMDENY905): the two
  // detectsPermissionDialog implementations are byte-identical apart from ONE line, and even the
  // three regex constants match name for name. So this is convergence, not divergence, and the
  // question is only which of the two footer readings to keep.
  //
  //   fork      const footerRegion = lines.slice(-MENU_FOOTER_REGION_LINES).join('\n')   // 8 lines
  //   upstream  const footerRegion = liveTailRegion(lines, LIVE_FOOTER_REGION_LINES)      // 5 lines
  //
  // Each side fixed a DIFFERENT half, and each still carries the other's gap:
  //   * upstream added liveTailRegion(), which skips a blank tail. That closes the blind spot the
  //     fork filed as card 11b04357 and deliberately did NOT fix in dbba0424 -- measured live: a
  //     real consent prompt with an 18-line blank tail read false on BOTH detectors.
  //   * the fork widened the refinement to 8 lines to match detectsBlockingMenu, because a
  //     refinement that inspects a NARROWER region than the gate it refines re-opens the very gap
  //     it exists to close. Upstream still reads 5 here while its own detectsBlockingMenu reads 8,
  //     so that asymmetry survives upstream.
  //
  // RESOLUTION: NEITHER SIDE WHOLESALE -- take upstream's file, then set this one line to
  // `liveTailRegion(lines, MENU_FOOTER_REGION_LINES)`. That is upstream's blank-tail fix at the
  // fork's region width, and it is the only combination where both measured defects are closed.
  // Everything else in upstream's version of this file is adopted unchanged.
  //
  // Card 11b04357 should be deduped against this: the merge brings its fix.
  'src/pane-state.ts':
    "take upstream wholesale EXCEPT detectsPermissionDialog's footer line, which becomes" +
    " liveTailRegion(lines, MENU_FOOTER_REGION_LINES) -- upstream's blank-tail fix at the fork's" +
    " region width. Upstream reads 5 there while its own detectsBlockingMenu reads 8; a refinement" +
    " narrower than the gate it refines re-opens the gap (fork measurement, card dbba0424). The" +
    " blank-tail half is card 11b04357, which upstream fixes and this merge therefore closes.",

  'src/kanban-dispatch.ts':
    "keep the fork version wholesale -- it is upstream's resolveKanbanDispatch verbatim plus the fork-only isSelfAdvanceMove appended after, zero divergence on the shared part." +
    " Card 7debd869 (2026-09-05): the tail lost isGenuineSelfAdvanceSwitch when Peti had CLAUDE.md's /clear-between-cards rule deleted and its code removed. isSelfAdvanceMove (dispatch-echo suppression) is untouched, so the resolution above is unchanged -- only the symbol list narrowed. The comment block above records the state at the time of the merge and is left as written.",
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
  // Card 0c66be37/74181db2, self-created 2026-09-04: a pure ADD/ADD at the tail of
  // KNOWN_HOOK_SCRIPTS. The fork appended 'outgoing-copy-gate.py' (this app now registers that
  // gate into ROLE agents' settings, not only the main agent's); upstream appended
  // 'skill-usage-capture.py' and the /clear continuity pair 'clear-capture.py' + 'clear-replay.py'.
  // Measured by reading BOTH hunks in the failing guard's own output: there is no semantic tension
  // -- the list is "hook script filenames THIS app registers", and each side names different, real
  // hooks that its own side registers.
  //
  // Resolution: UNION, all four names. Taking either side wholesale loses real entries. Which way
  // it fails is worth stating, because the two directions differ: dropping upstream's names leaves
  // ITS hook entries unprunable (they read as foreign, so a missing-file entry is kept forever),
  // while dropping the fork's un-registers a gate this fork actively wires. Neither is acceptable,
  // and neither is the "cheap move" the guard exists to prevent.
  'src/web/hook-registration-guard.ts':
    "union of both tails -- keep the fork's 'outgoing-copy-gate.py' AND upstream's 'skill-usage-capture.py' + 'clear-capture.py' + 'clear-replay.py'; the list is additive by construction and neither side may be taken wholesale" +
    " Re-measured 2026-09-06 (backend3, card 58ebcdc9 landing-block, bcd6ad71..9b3bae69): upstream added ONE more name to its half of the union, 'tool-log-capture.py'. Unlike clear-capture.py/clear-replay.py (still not listed, still do not exist in this checkout -- checked again this round, unchanged), this one is SAFE to add now under the exact test KNOWN_HOOK_SCRIPTS' own comment states: scripts/hooks/tool-log-capture.py EXISTS here, so fileExists is true and the pruner will never treat a registered entry for it as stale. ADOPTED this round -- 'tool-log-capture.py' added to the array, right after 'skill-usage-capture.py'.",
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
    "Re-measured 2026-09-03 (backend2, card 934dc104 landing-block, 24e46f990c7b..c98efe359fd0): upstream reworked its SINGLE-repo checker -- parseGitHubRemote() now prefers an `upstream` remote over `origin` (a fork otherwise asks itself about itself and stays silent forever), branchOnRemote()/remoteIsOwnOrigin() pick the right branch to query, and upstreamMergeBase() takes a base the queried remote actually knows instead of reporting fork-distance. The rule is unchanged and now has concrete work behind it: these are exactly the 'single-result features' to port onto the fork's aggregate shape. Blob bumped." +
    " RE-MEASURED 2026-09-04 (card f27c999b, B-wave 4/6) and the sentence above is MISLEADING, so read this before porting anything: the fork already achieves BOTH of upstream's outcomes, by a different and more general mechanism. (a) 'a fork otherwise asks itself about itself and stays silent forever' does not happen here -- repoConfigs() checks TWO repos explicitly, Szotasz/marveen AND the local origin, and the upstream-update banner reads the marveen entry; upstream's parseGitHubRemote remote-preference is a heuristic for finding the one right repo, which the fork does not need. (b) upstreamMergeBase is already covered: computeStatus tries the raw HEAD compare and, on the measured 404 that a customised fork always produces, falls back to mergeBaseWith(cfg.trackingRef) -- the fork point, which IS a commit the remote knows -- and marks status.fork. Its own comment says this is how the behind-count against Szotasz/marveen@main is measured. Porting upstream's machinery on top would duplicate working logic with a narrower version of it. " +
    "THE ONE GENUINE RESIDUE -- CLOSED 2026-09-05 (card 1140a745), recorded here because a ledger that still calls a fixed thing a follow-up is a ledger nobody trusts. repoConfigs() USED TO HARDCODE branch 'main' for the upstream repo; if Szotasz/marveen ever renamed its default, our upstream check would turn into a permanent error string and the banner would go quiet -- the same silent-blindness shape this entry is about, one level over. It now asks GitHub for the default branch (upstreamDefaultBranch(), fail-soft to 'main' on any failure) and derives BOTH the API branch and the local trackingRef from that one resolved value. The second half was NOT in the original note and matters more than the first: mergeBaseWith() returns '' for an absent ref and computeStatus reads that as behind = 0 with NO error, so fixing only the branch would have swapped one silent blindness for another. Upstream's own branchOnRemote()/fetchDefaultBranch() machinery is STILL not ported, for the reason above -- its remote-preference heuristic solves a problem this fork does not have." +
    " RE-MEASURED 2026-09-05 (mikrob, landing-block on card 75c2dbb7/efaf8926's worktree): upstream c98efe359fd0..b4dffa346e8f hardens ITS OWN branchOnRemote()/upstreamMergeBase() -- two new exported helpers (branchExistsOnOrigin, originHasTrackingRefs) so 'origin is ours' is verified against real remote-tracking refs instead of assumed from the naming convention, closing two bugs upstream's own comments describe measuring (a branch-name mismatch silently read as behind:0 for nine days, and a merge-base candidate-order bug that reported 161 commits of fork-distance against a real backlog of 4). All of it lives inside the exact machinery the entry above already decided NOT to port -- the fork's parallel mechanism (repoConfigs' two explicit repos, computeStatus's raw-compare-then-mergeBaseWith(cfg.trackingRef) fallback) never relies on the origin/upstream naming convention this fixes, so neither bug can occur here. No exec/network/credential/eval pattern in the diff (execFileSync calls are git show-ref/for-each-ref against local refs, same trust level as the merge-base call already in this file). Nothing to port, nothing to re-open. Blob bumped." +
    " ROUND 2026-09-06, card 50af1a27 (3c cluster). Pin current, one three-way conflict, and it is the standing one this entry has always been about: the fork's consolidated USAGE_LIMIT_FRAGMENTS array (card 115c21e7) against upstream's inline regex. KEEP OURS, for two independent reasons, and BOTH were re-measured rather than quoted. (a) Upstream's alternation still carries 'upgrade to increase your usage limit', the STARTUP-HINT false positive this fork removed on 2026-06-30 -- a theirs-merge downgrades every freshly-booted agent. (b) Upstream's SHAPE is not ERE-safe: it uses (?:...) and \\d, and `grep -E` warns '? at start of expression' on it (measured). That breaks the load-bearing property behind store/session-limit-pattern.json, which six non-TS consumers compile with bash grep -E and Python re. THE ONE THING UPSTREAM HAS THAT WE DO NOT is the extra '(?:\\w+ )?' term in the 'approaching' alternative, and I nearly adopted it before reading far enough: the JSON's own _comment records that card f27c999b (2026-09-04) considered and DECLINED exactly that term, because no MEASURED banner string needs it and an unbounded word wildcard in this detector can cause a false model downgrade -- the same class as the excluded /upgrade hint. My discriminating example ('approaching your weekly usage limit') is SYNTHETIC, invented to probe the regex, not observed in production, so it is not evidence that overturns a decision made on the absence of measured strings. The prior decision stands; reopen it only with a captured banner. Blob unchanged.",
  // The TEST-SIDE MIRROR of the entry above, conflicting for the same reason (measured 2026-09-05,
  // card 1140a745). Both sides appended a new describe block at the tail of a file that ended at
  // line 60, so the two tails collide, and the import line a few lines above collides with them.
  //
  // Upstream's appended block exercises remoteIsOwnOrigin(), branchOnRemote() and a
  // parseGitHubRemote(root) that takes a directory argument. NONE of those are takeable here, and
  // that was measured rather than assumed: grep finds no remoteIsOwnOrigin and no branchOnRemote
  // anywhere in this fork, and the fork's parseGitHubRemote takes no arguments. Upstream's cases
  // would not compile against this tree. So this is not a preference between two working
  // alternatives -- it is the same deliberate non-port the entry above records, seen from the
  // test side.
  //
  // Resolution: KEEP THE FORK SIDE WHOLESALE for both hunks -- the fork's tail block (upstream
  // default-branch resolution, card 1140a745) and the fork's widened '../web/update-checker.js'
  // import. Upstream's `afterAll` addition to the vitest import belongs to its block and is unused
  // without it, so it drops out with it. This entry is BOUND to the one above: if that machinery is
  // ever ported, port upstream's cases in the same change. Do not resurrect them alone -- a test
  // file is the one place where taking the other side wholesale looks harmless and silently deletes
  // coverage.
  'src/__tests__/update-checker-branch.test.ts':
    "keep the fork side wholesale -- upstream's appended block tests remoteIsOwnOrigin/branchOnRemote/parseGitHubRemote(root), none of which exist in this fork (the deliberate non-port recorded on src/web/update-checker.ts), so it cannot compile here; the fork's own tail block and widened import stay, and upstream's unused afterAll import drops with its block. Revisit ONLY together with the src/web/update-checker.ts entry." +
    " RE-MEASURED 2026-09-05 (mikrob, same landing-block round as the update-checker.ts re-read above): upstream 71a277dd1ffa..8084721190d9 adds tests for branchExistsOnOrigin/originHasTrackingRefs/upstreamMergeBase (UPDATEBRANCH904) -- none of which the fork imports, for the same reason recorded on src/web/update-checker.ts (the fork's parallel two-repo mechanism never relies on the origin/upstream naming convention these functions verify). Still cannot compile here; still keep the fork side wholesale. Blob bumped.",
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
    "three import lines: { listAgentNames, agentDir } from './agent-config.js' (fork's agentDir stays, still used), { resolveAgentConfigDirForRead } from './claude-plans.js' (upstream, replaces the now-dead readAgentClaudeConfigDir -- fixed a stale-transcript bug), { agentSessionName, capturePane, sendPromptToSession } from './agent-process.js' (upstream's sendPromptToSession, used at the wake-delivery call site) -- drop readAgentClaudeConfigDir entirely, zero remaining call sites Re-read 2026-09-03 (card 3bd18e70, blob 268fc2e6): upstream replaced sendPromptToSession with sendSystemDirective from './system-directive.js' at the wake-delivery call site (GUARDHITELES903); that import line and the call site sit outside the conflict hunk and auto-merge, so the only conflicting hunk is still the agent-config/claude-plans import pair -- resolve as above, drop readAgentClaudeConfigDir." +
    " ROUND 17, 2026-09-06 (card 26ab08a2's landing-block, 268fc2e6 -> 83b90ef1, +42/-2). THIS ONE IS DIFFERENT FROM THE USUAL BUMP, AND SAYING SO IS THE POINT: the increment lands ON the import block this rule decides, not outside it. Upstream #1202 (LEDGERACK905) swaps hasOpenInboundQuestion for openInboundQuestionMessageId in that very import list, and adds two things below it -- drainSurfacedMessageId(), which reads store/.ledger-drain-<agent>, and a PURE openQuestionBlocks(openMessageId, surfacedMessageId) holding the gate only until the drain has actually SHOWN the agent the message. The fork side measured, not assumed: this file imports hasOpenInboundQuestion (line 18) and calls it once (line 410), and the fork's own agentDir import that this rule protects is untouched by the change. NOT ADOPTED this round, and the reason is mechanical rather than a judgement: it is HALF of a two-file change whose other half is the new db.ts export, and db.ts here has zero occurrences of openInboundQuestionMessageId (measured). Adopt-together-or-neither, on a card with a gate. The import-pair resolution above is unchanged; what changes is that a future merger will now see a THIRD line moving in the same hunk. *** THE STATED GROUND IS NO LONGER TRUE, MEASURED 2026-09-12 (card 66ad1f95). This round refused the change because \'db.ts here has zero occurrences of openInboundQuestionMessageId\'. db.ts now DECLARES it (export function openInboundQuestionMessageId), context-restart-gate-runner.ts imports AND calls it, and drainSurfacedMessageId / openQuestionBlocks are present too -- so upstream #1202 IS adopted here, whole. Nothing announced that: it arrived while the git history no longer showed it as a difference (see the agent-scaffold entry for why). The CODE is not in question; this sentence was. Do not re-refuse it on the strength of the paragraph above -- reverting an adopted, working two-file change would be a fresh decision on its own card. An ACKNOWLEDGED_FORK_ANCHORS entry now watches the symbol, so a silent reversal in either direction fires on the next landing.",
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
    "Re-measured 2026-09-03 (backend2, card 934dc104 landing-block, 6ed7224c0882..a515f9c8750b): upstream added a desktop-lock route (its own import line, one route-chain call, one 60s TTL sweeper). None of it touches the agent-scaffold import line this rule is about; all three hunks are additive and auto-merge. Resolution unchanged; blob bumped." +
    " Re-measured 2026-09-05 (mikrob, landing-block): upstream a515f9c8750b..1906c636641e adds a top-level import (isMalformedBodyError from a new web/malformed-body.js, which the fork does not have) and hardens the request-handler's catch block to answer 400 with route/method/bytes in the log instead of a bare 500 for a malformed JSON body -- a real, reasonable fix (measured against two live incidents in upstream's own log), but a new file + a new response shape is its own decision, not a rider on unblocking every other fork's landing. Does not touch the agent-scaffold import line or either BEGIN/END section-writer block this entry decides. Not adopted this round; candidate for a future round. Blob bumped." +
    " Re-measured 2026-09-06 (backend3, card 79bb0364 landing-block, round 15). Upstream added ensureTelegramCopyGate to the same agent-scaffold import line this rule is about, plus one call in the hook-backfill loop and its log line (GATECOPY828). NOT adopted, and this one needs a WARNING rather than a plain skip: it is the SAME capability the fork already wires in that loop as ensureOutgoingCopyGate (card 74181db2, line 620), so a future merge that takes upstream's name IN ADDITION would wire outgoing-copy-gate.py twice into every sub-agent, under two different matchers. One or the other, never both. Everything else this rule decides (the import-line union, watchEgressAllowlistForReaderRender, listAllAgentNames, ensureAgentProvenanceHook, ensureSystemDirectiveAuthSection) is untouched. Resolution unchanged; blob bumped.",
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
    "Re-measured 2026-09-03 (backend2, card 6500e1d3 landing-block, 2a72fb5c7f38..936cdac15d5c): upstream threaded a new AGENT_API_ORIGIN through resolveDashboardOrigin, giving it a third parameter and the precedence AGENT_API_ORIGIN > DASHBOARD_PUBLIC_URL > localhost. Its reason is measured, not stylistic: on a single-host install behind hairpin NAT the public name resolved but its 443 was unreachable FROM THE HOST, so 73 generated curl examples across 18 agent CLAUDE.md files pointed at a dead address and returned curl exit 7 -- nothing the agent could even surface. An empty AGENT_API_ORIGIN keeps the old behaviour byte-for-byte. None of it touches the section-writers, the kanban-write gate or the quarantineReader scope that this rule decides. Resolution unchanged; blob bumped. The 'not safe to hand-merge under time pressure' warning above STILL STANDS and is not weakened by this bump. FORK-ONLY additions to keep across any future reconciliation (cards ab4c85f2 + 5c5d7bc4, not upstream's): the ensureSystemDirectiveAuthSection section-writer with its BEGIN/END markers and buildSystemDirectiveAuthBody, plus the import of SYSTEM_DIRECTIVE_SENDER from './system-directive-id.js' that body interpolates. That import is the point, not decoration: the scaffold recipe must name the SAME id routes/messages.ts reserves, or agents are sent to verify a field nobody rejects. Upstream has neither the section nor the const module." +
    " Re-measured 2026-09-06 (backend3, card 79bb0364 landing-block, round 15). Upstream added the GATECOPY828 half of the same feature: TELEGRAM_COPY_GATE_MATCHER (the two Telegram MCP tools), agentGetsTelegramCopyGate/injectTelegramCopyGate/ensureTelegramCopyGate, and a new pythonHookCommand(). The gate itself is NOT adopted -- the fork built it under card 74181db2 with different names, a `Bash` matcher and a kill switch that DEFAULTS OFF, and taking upstream's alongside it double-wires the same script (see the src/web.ts entry). BUT ONE PIECE OF THIS DIFF IS WORTH ADOPTING ON ITS OWN, AND IT WAS MEASURED, NOT ASSUMED: pythonHookCommand() probes `command -v python3` and exits 2 when it is missing, because Claude Code treats 127 as NON-BLOCKING -- the exact failure this file's own hookCommand() header calls 'the non-blocking status this whole file exists to stop'. The fork applies that lesson to node only. Every python guard here is wired as a bare `python3 \"...\"` (git-protect, npm-protect, blast-radius, cd-chain, noisy-command, symlinked-node-modules, pentest-install), so a python3 that leaves the PATH turns all of them into silent no-ops. WORSE, and measured by reading the call site: injectOutgoingCopyGate builds its command with hookCommand(), i.e. it wires NODE to run a .py file -- latent only because the kill switch defaults off, a guaranteed no-op the moment it is turned on. Not fixed here (a landing-unblock is not the place); carded separately. Resolution otherwise unchanged; blob bumped." +
    " SUPERSEDES THE ROUND-15 PYTHON NOTE ABOVE (card d2b881ab landed, backend2): pythonHookCommand() IS NOW ADOPTED in this fork and every python guard plus injectOutgoingCopyGate is wired through it, so the sentence above about bare `python3 \"...\"` wiring describes the state BEFORE that card, not now. Do not re-open it as an unadopted upstream difference at the next conflict: the correct resolution is to KEEP the fork's pythonHookCommand and take upstream's only if it has diverged. The rest of the round-15 entry (Telegram copy gate NOT adopted, different names, kill switch defaults off) stands unchanged." +
    " ROUND 17, 2026-09-06 (545991551c70 -> 5b168b5afc24, +82/-5). Upstream #1201 adds hookScriptAlreadyEffectiveInOtherScope() and wires it into ensureAgentHooks -- inside this rule's area, not beside it. What it fixes is real and measured on THEIR side: Claude Code merges the user scope with the project scope and runs BOTH without deduping, so one prompt produced two identical PROVENANCE-KAPU blocks, a doubled spawn and a doubled ~1.4KB context injection, and removing the entry by hand did not hold because ensureAgentHooks merged the template back in on the next dashboard start. It compares SCRIPT BASENAME rather than the command string, because the two scopes spell the same gate differently, and it is deliberately ONE-WAY (only suppresses a write into the shared user scope). RELEVANT TO US, measured: this fork already has _hookScriptBasename (line 181) and uses it inside ensureAgentHooks, so the primitive the fix is built on is present here; what is absent is the cross-scope check itself. NOT ADOPTED this round -- it changes which hooks get written for every fleet agent, which is precisely the security-critical wiring this entry has refused to take wholesale for many rounds. Resolution unchanged; blob bumped. *** THAT REFUSAL NO LONGER DESCRIBES THE TREE, AND THIS CORRECTION IS THE POINT (card ec7bdad8, measured 2026-09-12 by the same agent who caused it). hookScriptAlreadyEffectiveInOtherScope IS NOW PRESENT AND ACTIVE HERE: declared in agent-scaffold.ts and wired at THREE call sites inside ensureAgentHooks. It arrived with the B-wave merge (card 42938a74, merge b92a5b66) -- it auto-merged AROUND the conflicts being resolved, and nobody compared the result against this written refusal. Upstream's own test came with it (src/__tests__/hook-cross-scope-dedupe.test.ts), which is why the suite was green and nothing complained. So: the CODE is adopted and tested; what was broken is this RECORD. DO NOT 'restore' the fork behaviour by deleting the function -- that would remove a working, covered gate on the strength of a sentence that is now out of date. If it is ever to be reverted, that is a fresh decision on its own card, not a cleanup. WHY THIS MATTERS BEYOND THIS ONE LINE: after that merge, git considers upstream's contributions merged even where the resolution deliberately kept the fork's side, so a drift-check can no longer SEE what was refused -- measured on the same file, git reports +3/-1 of drift while the two contents differ by 38 hunks. History stopped being evidence here; only the TREE is. Re-verify every 'NOT ADOPTED' line in this entry against the tree after any upstream merge (card 66ad1f95 carries the structural fix)." +
    " ROUND 18, 2026-09-06 (5b168b5afc24 -> 526dcf56aaf3, +78/-3), card 494fad0f -- a DEDICATED card with a gate, which is why this round ADOPTS. Upstream closes three SSRF bypasses in isPublicFetchHost(), and all three were OPEN HERE TOO: this fork's copy of that function was BYTE-IDENTICAL to upstream's pre-fix version (measured on the region between isPublicFetchHost and ownerAllowedDomains), so nothing fork-specific had to be preserved through the change. (1) inet_aton parsing: the resolvers behind the wildcard-DNS services read a leading 0 as OCTAL and 0x as HEX, so 0177.0.0.1.nip.io answers 127.0.0.1 while a decimal-only parser sees four harmless labels. (2) A packed single label: 2130706433.nip.io and 7f000001.nip.io are the same address in one token, which neither the dotted-quad nor the dash-quad check ever looks at. (3) sslip.io's dashed IPv6, 0--1.sslip.io = ::1, which is neither form. Adopted wholesale together with upstream's own three cases in quarantine-allowlist-render.test.ts, and REACHABILITY PROVEN BY MUTATION rather than by reading upstream's claim: with the adopted tests against this fork's PRE-fix function, exactly two cases fail (the packed/inet_aton one and the dashed-IPv6 one) and the third -- 'leaves public names alone in every encoding' -- passes in both directions, which is correct, because it is the negative control for the 2^24 lower bound that keeps 123.example.com reachable. Why the whole-region take is safe where this entry normally refuses one: the refusals above are about ensureAgentHooks and the section-writers, the fleet-wide hook wiring; this is a self-contained pure predicate with no fork divergence in it at all. Everything this rule otherwise decides is untouched. Blob bumped. ROUND 2026-09-11 (backend3, card 9c665470, 69213257de12..a7f750a7c967, +87/-11): zero hits on ensureLocalFirstSection, ensureSkillsPathTrapSection, pythonHookCommand or ensureSystemDirectiveAuthSection -- every point this rule decides is untouched. Resolution unchanged; blob bumped. The not-safe-to-hand-merge-under-time-pressure warning above STILL STANDS." +
    " Re-measured 2026-09-15 (backend3, card 3602c2ae, 334faa970f7d..c5dd9bc6042d): the not-safe warning is now UNDERSTATED, not just still-standing -- this round explains the .claude/settings.json entry elsewhere in this file. Two substantial NEW pieces, neither overlapping the previously-decided points (section-writers, kanban-write gate, quarantineReader scope, pythonHookCommand, ensureSystemDirectiveAuthSection, hookScriptAlreadyEffectiveInOtherScope, isPublicFetchHost -- all untouched in this diff). (1) #1305: agentSettingsPath()/ensureAgentHooks/ensureAgentStalenessHook/ensureAgentProvenanceHook/ensureEgressGate now REFUSE to write the main agent's hooks into the user-global ~/.claude/settings.json at all (new refuseMainAgentHookWrite() gate) -- upstream's own reasoning is measured on THEIR side: writing fleet hooks into the user-global file made them fire in the owner's own, unrelated Claude Code sessions (blocked WebFetch there, plus a prompt-injection surface and foreign content reaching fleet memory). The main agent's hooks are now expected to be repo-shipped in the tracked <PROJECT_ROOT>/.claude/settings.json instead -- which is EXACTLY the file this repo's own root .claude/settings.json is, and exactly why that file's entry (below) cannot be decided independently of this one: adopting #1305 here is what would make hand-editing that file the wrong move (ensureAgentHooks would stop writing it, so the content has to come from wiring this function correctly, not a manual sync). (2) readAgentToolDeny(): a NEW per-agent tool-name deny list (agent-config.json 'toolDeny'), merged into writeAgentSettingsFromProfile's deny list on every spawn (must be on every spawn because that function replaces the deny list wholesale) -- lets a sub-agent's schema drop tools it never needs (Artifact/Workflow/etc.), a genuine context-budget feature the fork lacks. NEITHER IS PORTED HERE: #1305 changes which file 15+ live fleet agents' hooks are written into (the single highest-blast-radius kind of change this entry has refused all year), and readAgentToolDeny is a real feature needing its own review. Raised together as one follow-up card (the two are logically linked: #1305 decides WHERE hooks live, which is a precondition for deciding what .claude/settings.json's content should be) rather than hand-merged inside a drift re-decision. Resolution at every previously-decided point unchanged; blob bumped." +
    " FOLLOW-UP CARD RESOLVED (card 21597530, MikroB plan-grilling VERDIKT: RETHINK, kanban komment 6020, 2026-09-25): the 'NEITHER IS PORTED HERE' line above no longer describes the tree, on BOTH counts. (1) #1305 was ALREADY adopted, and had been since 2026-09-13 -- commit adf2c30a ('fix(hooks): fleet hooks leave the user-global settings.json -- repo-shipped project scope + write-refusal (#1305...)') landed refuseMainAgentHookWrite() and agentSettingsPath() before this card was even opened; the card's own premise ('EGYIK SEM PORTOLVA') was measured and found partly false. #1305's own follow-on gap -- the tracked project-root .claude/settings.json still missing the security PreToolUse guards every sub-agent had -- was carded separately (c00d5429) and closed there, not here. (2) readAgentToolDeny() IS NOW PORTED, in this same card: agent-config.ts exports it (missing/malformed 'toolDeny' -> [], matching today's behaviour), and writeAgentSettingsFromProfile PUSHES its result onto the deny array it already builds -- additive by construction, so it cannot drop SELF_PACE_TOOL_DENY/BASH_EGRESS_DENY/profile.filesystem.deny the way the old 'replaces wholesale' phrasing above might read. Covered by src/__tests__/agent-tool-deny.test.ts (union-not-replace pinned by mutation). Gate: QA + Cybersec per MikroB's verdict (Cybered not required -- the fleet-wide hook-rewiring risk that warranted it belonged to #1305, already resolved)." +
    " CORRECTION (QA, 21597530 komment, 2026-09-25): the sentence above says c00d5429 'closed there' -- that was premature at the time it was written. c00d5429 QA FAILED (missing DECISIONS.md entry, kanban komment 6079) and separately drew a Cybersec F1 MEDIUM (the PreToolUse contract only pinned script presence, not matcher, komment 6081/6100) on its first Gate-SHA bedac5dffe9223ad21a5c975323ad6082b46e79d -- it was still in_progress, not closed, at the moment this file said so. Both are fixed on the card's delta-gate round (commits da349fed, DECISIONS.md entry; cbf6cfd3, PreToolUse (script,matcher) pair pinning with mutation proof) and re-gated QA+Cybersec against the NEW landed Gate-SHA -- see that card's own REVIEW comments for the actual closing sha, not this file.",
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
    "Re-measured 2026-09-04 (backend, card 5bee4b22 landing-block, 6a71eab9ab67..cf4c1052f7ef): upstream made saveMemory() fire-and-forget an embedding after the INSERT (mirroring saveAgentMemory), so rows written through that path -- the nightly daily-log digest among them -- stop being left unvectorised. 13 lines added inside saveMemory(), one turned into `const info =`. moveKanbanCard() does not appear in the diff at all. Resolution unchanged; blob bumped." +
    " Re-measured 2026-09-06 (backend3, card 58ebcdc9 landing-block, c554b375..94e032f9): four new regions, none touching moveKanbanCard(). (1) kanban_card_blockers + blockerWouldCycle/addCardBlocker/removeCardBlocker/getBlockersForCard/getBlockedByCard/getBlockersForAllCards -- a generic card-blocking link with cycle detection. NOT a gap: the fork already has this, as kanban_dependencies (from_card_id/to_card_id, cycle-checked via the reachability walk feeding dependencyBlockers()), matching src/web/routes/kanban.ts's own entry below. (2) idea_box gains a `scope` column ('munka'/'szemelyes') and a new idea_attachments table -- genuinely new, the fork has neither, and the backend route carrying POST /api/ideas/upload + /api/ideas/:id/attachments is NOT in this round's 8-file set, so adopting only this half would be incomplete. (3) `last_status_at` (KanbanCard, derived from kanban_card_events, falling back to created_at) answers a REAL gap: the fork's own redispatch-guard.sh DENY:progress check reads `updated_at`, which a comment bumps without the card actually moving. (4) getAgentToolActivity/getAgentMessageActivity/getAgentCurrentCards, paired with a new GET /api/agents/status (src/web/routes/agents.ts, its own entry below) and a new src/web/agent-status.ts module -- neither exists here; a different axis from the fork's own agent-hud (context/model percentage, not tool-activity/current-card). (2)-(4) are ADOPTION decisions, not passive conflict resolutions -- raised on card 6c6d471a for triage, the same treatment MiniMax (48565f81) and the context-guard settings UI (740551e6) got. Resolution at moveKanbanCard() unchanged; blob bumped.",
  // Card 2e634e5c. Both sides independently fixed the SAME ghost-session bug (agent DELETE leaving
  // an orphaned tmux session), but the fork's fix is strictly more correct: it AWAITS
  // stopAgentProcess(), tracks the result, and logs on failure; upstream's is a floating (un-awaited)
  // call to the same async function -- the exact race its own comment warns against ("must run while
  // the dir still exists"), since rmSync(dir) right after can start before the un-awaited stop
  // finishes reading the config. Measured 2026-08-16. Resolution: keep the fork's version wholesale,
  // upstream adds nothing the fork lacks here.
  'src/web/routes/agents.ts':
    'keep the fork version wholesale -- it already awaits stopAgentProcess() and tracks/logs the result; upstream is an un-awaited (racy) reimplementation of the same fix' +
    "Re-measured 2026-09-03 (backend2, card 934dc104 landing-block, 7711d18a7752..4b7a61e33448) and the rule needed SHARPENING, not just a bump. 'Keep the fork version wholesale' was written about ONE hunk (the awaited stopAgentProcess()), and read literally against today's blob it would now discard an unrelated upstream addition: the freshness/supersession annotation on the main-agent inbox-drain path (the same feature acknowledged in src/web/message-router.ts and src/db.ts). Corrected rule: at the stopAgentProcess conflict point keep the FORK side (it awaits and logs; upstream's is an un-awaited reimplementation of the same fix); everywhere else in this file the sides are additive -- keep both, WITH ONE NAMED EXCEPTION: upstream's MiniMax direct-API gating in /api/models/available is NOT to be taken (Peti NO-GO, card 48565f81). An earlier version of this entry listed that gating among the additions a literal reading would wrongly discard, i.e. it argued FOR bringing it in -- corrected 2026-09-04 (card e80c011a, Cybered comment 19877), because the launcher-side exclusion is worthless if the route side walks back in through a different rule." +
    " Re-measured 2026-09-05 (backend2, card efaf8926, 4b7a61e33448..0d1f69001596): ONE line, and it changes no behaviour -- upstream restored the Hungarian accents on the auth-init timeout message: 'masodpercen belul. Probald ujra' became 'másodpercen belül. Próbáld újra'. The fork still carries the unaccented form. Every point this rule decides is untouched: the stopAgentProcess conflict, the MiniMax gating and the inbox-drain freshness annotation do not appear in the diff. The accent fix needs no decision of its own -- this rule already says the non-stopAgentProcess hunks are additive and both sides are kept, so it arrives with that half at the next reconciliation, and it is the direction CLAUDE.md's Hungarian spelling rule asks for anyway. Resolution unchanged; blob bumped." +
    " Re-measured 2026-09-06 (backend3, card 58ebcdc9 landing-block, 0d1f6900..c68b0a3e): a new GET /api/agents/status route (paneActivityLabel extracted from the existing /api/agents/activity handler and shared between the two) plus its own new src/web/agent-status.ts module (deriveAgentStatus, AGENT_STATUS_THRESHOLDS, AgentStatusSignals/AgentStatusRow), consuming the three new src/db.ts helpers acknowledged in that file's own entry (getAgentToolActivity/getAgentMessageActivity/getAgentCurrentCards). Zero hits on stopAgentProcess, MiniMax or /api/models/available -- every point this rule decides is untouched. This is a coherent new capability, not a passive conflict: raised on card 6c6d471a alongside the db.ts entry, not folded in here. Resolution unchanged; blob bumped. ROUND 2026-09-11 (backend3, card 9c665470, 4af3b8721f4e..44349c36dc6b, +14/-2): zero hits on stopAgentProcess, MiniMax or /api/models/available -- the conflict point and both named exceptions are untouched. Resolution unchanged; blob bumped.",
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
  // ROUND 16, 2026-09-06 (card a6b5fea3, QA's finding on the 1d7b51aa gate -- URGENT because a
  // red entry here blocks EVERY agent's landing). A brand-new three-way conflict, not a blob bump.
  'src/web/routes/updates.ts':
    "Keep the FORK's spawnUpdateScript helper wholesale. The conflict is structural, not a " +
    "disagreement: upstream 31d1e94f (#1189, AUTOUPDNODEENV905) patched the INLINE update.sh spawn " +
    "inside tryHandleUpdates, and this fork had already lifted that same spawn into the shared " +
    "helper spawnUpdateScript(res, extraEnv, pidfileContent, releaseLock), called from BOTH the " +
    "fork-pull path and the post-upstream-merge rebuild+restart path. Upstream's hunk therefore " +
    "lands on code we moved; there is no line-level pick to make. UPSTREAM'S FIX IS NOT ADOPTED " +
    "THIS ROUND, and that is a scope decision, not a judgement that it is wrong: a landing-unblock " +
    "is not the place for a behaviour change on the update path (same line drawn in rounds 12, 13 " +
    "and 14). THE ARGUMENT AGAINST MY OWN CHOICE, MEASURED, because it is stronger than usual " +
    "here: this fork IS exposed to the bug upstream fixed. update.sh has bare `npm ci --silent` at " +
    "both install sites (no --include=dev), and nothing deletes NODE_ENV before the spawn, so " +
    "under NODE_ENV=production npm omits dev deps, the pruned tree loses tsc, the build fails, the " +
    "rollback reverts the freshly pulled update.sh along with everything else, the old dist keeps " +
    "serving, and every health check stays green while the loop repeats -- upstream measured five " +
    "rollbacks over ten days on a customer install, and the fix cannot arrive through the update " +
    "path on its own. WHAT KEEPS IT DORMANT HERE IS THE ENVIRONMENT, NOT THE CODE: nothing in this " +
    "fork sets NODE_ENV=production (grepped the tree -- logger.ts only READS it, the only writers " +
    "are tests setting 'test'), and five sampled live marveen processes carry no NODE_ENV at all. " +
    "One operator env line, one systemd unit, one container image default, and this fork reproduces " +
    "the same self-sustaining loop with no guard in place. Raised with MikroB for its own card " +
    "rather than ridden in here. IF IT IS ADOPTED LATER, the fix belongs INSIDE spawnUpdateScript " +
    "so both call paths get it -- upstream only had one to protect -- plus --include=dev on both " +
    "npm ci sites in update.sh, which is the half that is environment-independent and final. The " +
    "fork anchor below fires the moment that second half lands, so this note cannot keep claiming " +
    "an exposure that has been closed." +
    " ROUND 17, 2026-09-06 (0e3ae734 -> 7755cd0e, +28/-8), and it is a SECOND upstream commit on this " +
    "file one round after the first. #1199 rebuilds the GitRunner that tryHandleUpdates injects: " +
    "aheadCount's inline body becomes a shared countRevs(range) helper, a behindCount is added, and " +
    "originHasBranch(branch) returns yes/no/UNKNOWN from `git ls-remote --exit-code --heads` -- " +
    "distinguishing exit 2 (no such branch, evidence) from 128 (transport/auth failure, an unknown " +
    "that must not block), which is the same absent-is-not-zero discipline this fork keeps arriving " +
    "at independently. It is ADJACENT to this rule, not on it: the fork side still carries the " +
    "pre-#1199 shape (GitRunner at line 519, aheadCount's inline try/catch at 530, measured), and the " +
    "spawnUpdateScript helper this rule is about is not touched by either side. Resolution unchanged; " +
    "blob bumped. The NODE_ENV half of #1189 remains unadopted and the fork anchor above still guards " +
    "that claim." +
    " RE-DECIDED 2026-09-06, card 50af1a27 (3c cluster) -- the fork anchor above FIRED, exactly as its author " +
    "intended, and this is the re-reading it demanded rather than an edit to make it quiet. HALF (2) IS NOW " +
    "ADOPTED: --include=dev is on BOTH npm ci sites in update.sh. The exposure claim above is therefore no " +
    "longer whole, and the sentence 'update.sh has bare npm ci --silent at both install sites' describes the " +
    "state BEFORE that card, not now. HALF (1) IS STILL OPEN: nothing deletes NODE_ENV inside " +
    "spawnUpdateScript, so both call paths remain unprotected against the environment itself, and the " +
    "structural conflict this rule is about (upstream patched an inline spawn the fork had already lifted " +
    "into a helper) is unchanged -- there is still no line-level pick to make. WHY ONLY HALF: half (2) lives " +
    "in update.sh, a file of the 3c cluster, and the prior note itself calls it 'the half that is " +
    "environment-independent and final'; half (1) lives in THIS file, which 3c does not own, and it is a " +
    "behaviour change on the update path that the prior round deliberately kept for its own card. That card " +
    "EXISTS and is open: c116696f (backend2, HIGH), which plans both halves -- commented there with what " +
    "landed and what remains, rather than silently absorbing another agent's card. MEASURED while adopting, " +
    "with a REAL install into a throwaway temp tree (npm 10.9.8): NODE_ENV=production + plain ci PRUNES the " +
    "dev dep, + --include=dev keeps it. The environment claim also still holds: NODE_ENV is set nowhere in " +
    "this install, so what closed is a latent hole. The anchor below is re-aimed at the half that is still " +
    "open, so it keeps doing the same job for the remaining claim." +
    " DONE 2026-09-06, card c116696f (backend2) -- HALF (1) NOW ADOPTED TOO: a new exported " +
    "buildUpdateScriptEnv(extraEnv) deletes NODE_ENV from a LOCAL COPY of process.env before " +
    "returning it, protecting BOTH call paths (fork-pull and post-upstream-merge rebuild+restart) " +
    "from the one thing --include=dev cannot fix on its own: this process itself inheriting " +
    "NODE_ENV=production from whatever launched it. CORRECTED once during gate (Cybersec NO-GO): " +
    "the first version mutated the REAL process.env, which a child process does not need -- its own " +
    "env is an OS-level copy taken at ITS spawn(), not a live view of the parent -- and which would " +
    "have left NODE_ENV permanently deleted from THIS long-running process if update.sh exits before " +
    "its restart step, reproducing the exact no-restart failure shape AUTOUPDNODEENV905 already hit " +
    "five times. Both halves of upstream 31d1e94f (#1189, AUTOUPDNODEENV905) are adopted now, by the " +
    "fork's own route rather than upstream's line-level patch -- the STRUCTURAL conflict this rule " +
    "opened with (upstream patched an inline spawn the fork had already lifted into a shared helper) " +
    "remains the reason there is still no line-level pick to make, so the rule stays acknowledge-only " +
    "rather than being deleted. The fork anchor below fired exactly as its 50af1a27 author intended " +
    "and is now re-aimed to expect:'present', " +
    "guarding against a future revert instead of watching for the fix's arrival.",
  'src/web/routes/kanban.ts':
    "dispatch-text hunk: keep the fork's waiting-text wholesale (fork rule 4, no self-close-to-done). Other two hunks: adopt upstream's resolveKanbanDispatch + reportUndeliveredDispatch (session-down is no longer a silent no-op), keep the fork's self-advance suppression + /clear-before-switch wholesale alongside it -- non-overlapping concerns, not a fork-vs-upstream pick. Re-measured 2026-09-02 (Cybersec, card 9dc0fba8 landing-block, 00ec734f520d..89423d29b8af): upstream moved, entirely outside all three recorded hunks -- it fixed the POST handler so a caller-supplied card id wins in the row AND in the response (it used to store the supplied id and echo the generated one, HTTP 200 pointing at a card that does not exist), and it lifts `actor` out of the field set for db.ts\'s new audit event. Zero hits on resolveKanbanDispatch, reportUndeliveredDispatch, the waiting-text hunk, the self-advance suppression or the /clear-before-switch block. Resolution at the conflict points unchanged; blob bumped." +
    " DONE 2026-09-04 (card f27c999b, B-wave 4/6), and TWO of the three items turned out to be already-solved rather than pending. (1) The POST id bug WAS live here and is fixed: `createKanbanCard({ id, ...normalized })` let a caller-supplied id win in the ROW while the response echoed the generated one -- HTTP 200 naming a card that does not exist. Now one id is resolved first and used for both; kanban-post-id-echo.test.ts pins the property for every shape, and 3 of its 4 cases fail on the old spread order. (2) resolveKanbanDispatch: already adopted -- kanban-dispatch.ts is upstream's verbatim plus two fork-only functions, measured. (3) reportUndeliveredDispatch: NOT adopted, because the fork already closed the same hole its own way. resolveKanbanDispatchTarget returning null no longer goes quiet: the failure lands on the card AND in the main agent's inbox, with four contract tests in kanban-dispatch-silent-noop.test.ts, and that file documents why the stricter 'message first, in_progress after delivery' contract is not available here (createAgentMessage only ENQUEUES, so 'after successful delivery' is not knowable at move time). Adopting upstream's version would be a second mechanism for a closed hole. The waiting-text hunk and the self-advance / clear-before-switch blocks are untouched, as the rule requires." +
    " Card 7debd869 (2026-09-05): the /clear-before-switch block named throughout this entry NO LONGER EXISTS in this file -- Peti had CLAUDE.md's /clear-between-cards rule deleted and its code removed with it. A future merger must keep only the fork's self-advance dispatch-echo suppression and the waiting-text hunk; there is no /clear call left to preserve." +
    " Re-measured 2026-09-06 (backend2, card 1b4cd700 landing-block, 89423d29b8af..e5d2e792c36f): upstream added a pre-flight to the dispatch instruction text -- a `statusProbe` curl the receiving agent is told to run before starting, because the dispatch message can sit in a busy session's queue while the card moves on, and a late second attempt produces parallel work on one target (their example: a SECOND test file for one controller). The problem is real and this fork has it too. It is NOT A GAP HERE, and the reason is a mechanism upstream does not have: src/web/kanban-state-stamp.ts stamps `[card-state @send]` at send time AND `[card-state @delivery]` at delivery, each carrying the card's status/updated_at and the instruction to re-read the card before working -- measured live in this session, on this very card. That is strictly stronger than upstream's probe on the axis that decides the outcome: the stamp arrives WITH the message and needs no cooperation, whereas a probe the reader must compose and run is a step the reader can skip, and the likeliest reaction to an unclear pre-flight is exactly to skip it (upstream's own comment says as much about its isinstance branch). Adopting it would be a second mechanism for a hole the fork already closed. Nothing else in the diff: the waiting-text hunk, resolveKanbanDispatch and the self-advance suppression are untouched. Resolution unchanged; blob bumped." +
    " Re-measured 2026-09-06 (backend3, card 58ebcdc9 landing-block, e5d2e792..bbe255c1): upstream added /api/kanban/<id>/blockers (GET/POST/DELETE), a generic card-blocking link with cycle detection (blockerWouldCycle). NOT a gap: the fork already has this exact capability as /api/kanban/<id>/dependencies (kanban_dependencies, its own cycle check via dependencyBlockers()/the reachability walk in src/db.ts) -- see that file's own entry for the matching db.ts-side conclusion. Zero hits on resolveKanbanDispatch, reportUndeliveredDispatch, the waiting-text hunk or the self-advance suppression. Resolution unchanged; blob bumped." +
    " CORRECTION 2026-09-25 (card 2f1cbaf1, backend3, ACKNOWLEDGED_FORK_ANCHORS backlog): the /blockers route IS present -- GET/POST/DELETE at lines ~689-724, blockerWouldCycle (db.ts:4795), getBlockersForCard/getBlockedByCard, all verified directly. Landed by commit 7e9a7362 (gaborusa2010-ai, PR #1115) on 2026-09-06 14:43 -- the SAME DAY as this round's own measurement, which likely ran before that commit landed rather than missing an older one (a narrower version of the same class as the schedule-runner.ts/notify.sh/github-pr-monitor.sh corrections from this audit). PRACTICAL IMPACT CHECKED: web/app-kanban.js calls ONLY /dependencies (3 call sites, grep-verified) -- /blockers is live, tested-by-nobody-in-the-UI backend surface, not a second mechanism actively fighting the fork's own one. Not urgent, but it is dead-or-parallel code sitting in production that nobody decided to keep; worth a small follow-up card to either wire it in or remove it, not a silent status quo. Resolution retracted as 'not a gap' (it IS present, whether or not it is used); the fork's own /dependencies remains the one thing actually driving the UI." +
    " Re-measured 2026-09-15 (backend3, card 3602c2ae, 2424a3c4842f..83ab8067d408): purely additive, +7/-1 -- getTokenPruneLag/TokenPruneLag imported from db.ts and threaded through buildHeartbeatSummaryResponse as a new `token_prune` field on the heartbeat-summary response, alongside the existing db_size_mb health signal. Zero hits on the dispatch-text hunk, resolveKanbanDispatch, reportUndeliveredDispatch or the self-advance suppression -- every point this rule decides is untouched. A genuinely small, low-risk NEW health metric (not a behaviour change to anything existing), but still a backend port (needs db.ts's getTokenPruneLag too) and a frontend consumer decision -- not folded in here; flagged for a small follow-up card rather than hand-merged inside a drift re-decision. Resolution unchanged; blob bumped.",
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
    "merge both sides in one egressDecision() -- fork Firecrawl namespace-default-deny + param-allowlist (91c4a369) run BEFORE upstream's not-webfetch early-return (which would otherwise reopen 91c4a369), then upstream's tier-based decision + quarantine tier + audit logging, with the quarantine tier extended to the two URL-bearing Firecrawl tools ROUND 2026-09-11 (backend3, card 9c665470, 229076d5812e..5a74712f1484, +149/-3). THIS ONE NEEDED REAL READING: the keyword pass flagged egressDecision and 26 quarantine hits, i.e. inside the area this rule decides, so a bump on its own would have been a guess. Upstream #1179 turns the quarantine READER POSTURE into an operator switch: store/egress-allowlist.json gains quarantine_reader_posture, and ONLY the literal string denylist opens it -- a missing file, a typo or a wrong type all resolve to allowlist, the stricter default. Under the default posture the decision path is byte-identical to before. In the open posture a new step 0 runs deny-only rules (QUARANTINE_DENY_HOSTS, QUARANTINE_DENY_SUFFIXES, isPrivateIPv4/isPrivateIPv6, isQuarantineDenied) ahead of every allow path. MEASURED AGAINST THIS RULE'S OWN POINTS: the only Firecrawl/WebFetch occurrences in the entire diff are in COMMENTS -- the fork namespace-default-deny + param-allowlist block and the not-webfetch early-return are untouched as code, and so is the quarantine tier's extension to the two URL-bearing Firecrawl tools. Resolution unchanged; blob bumped. Ordering note for whoever adopts: upstream's step 0 is DENY-ONLY, and a deny-only gate ahead of another deny gate cannot re-open what the later one closes, so it does not threaten this rule's ordering invariant. WHETHER TO ADOPT THE SWITCH IS NOT A CONFLICT RESOLUTION: its purpose is to let an operator open the quarantine reader to the whole internet minus a denylist, which is a security-posture decision for Peti/MikroB, not something to fold in while re-pinning a blob.",
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
    " SHARPENED 2026-09-03 (backend2, card 6500e1d3 landing-block, b17ba4f630db..2876a41d1fb2) -- NOT a plain blob bump: upstream moved AT one of the two points this rule names. configDirFor() now calls resolveAgentConfigDirForRead() instead of readAgentClaudeConfigDir(), because an agent whose config dir was auto-provisioned by the launcher has no field to read and the old call silently returned the host default, i.e. ANOTHER agent's absence. That is a real bug fix and it does not conflict with 'keep the fork's async configDirFor': the two sides change different things about the same function, so keep the fork's async shape and adopt upstream's resolver INSIDE it. Second upstream change, additive and to be adopted: the request-handoff branch of checkAgent now goes through sendSystemDirective instead of a bare sendPromptToSession (GUARDHITELES903) -- a message telling an agent to drop work and stop is indistinguishable from a prompt injection without a queue anchor, and an agent correctly refused one on 2026-09-03." +
    " Re-measured 2026-09-06 (backend3, card 79bb0364 round-2 landing-block, upstream round 16). The other half of DANICTXHUROK906 above: one import and one markAgentRestartPending(name) call before the stop in performRestart(). Six lines, none of them near the agent-config/claude-plans import pair this rule decides. Same verdict as its twin -- the two must be adopted TOGETHER or neither, since the call without the export does not compile and the export without the call is dead. Resolution unchanged; blob bumped.",
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
    'STUB scaffold + 36 extracted web/app-*.js slices are authoritative; a conflicting upstream hunk must be diffed against its named slice file and only genuinely-new upstream behavior ported forward, never taken wholesale -- proven on the i18n-nav hunk (found + fixed one real gap: missing renderUpdatesVersion re-apply on language switch). Re-audited 2026-08-25 (card 9ef96512, blob c8c11f94): 3 upstream hunks, all in the loadOllamaModels / resetWizard / startup-init region (app-settings.js). Ported: (1) loadOllamaModels refactored to populate both optgroups (ollamaModelGroup edit-panel + agentModelOllamaGroup wizard -- wizard was missing local-model option entirely); (2) agentModelOllamaGroup added to wizard HTML (index.html); (3) resetWizard() now calls loadOllamaModels() (app-wizard.js); (4) loadOllamaModels() added to startup init (app-settings.js). No behavioral gap found in any other region. Re-audited 2026-09-02 (card 684dda18, blob e8c74d15): upstream diff since c8c11f94 has 3 hunks -- (1) activity-badge "thinking orb" spinner for state===working (app-activity.js): NOT a gap, the fork already signals "working" via a different mechanism (activity-badge.act-working has its own "breathing" pulse animation in style.css, card predates this) -- adding the orb on top would double-animate the same signal, skipped as redundant. (2) /api/context-guard-fed static badge on Agents-grid cards (app-agents.js): NOT a gap, the fork already has a strictly superior LIVE-POLLED per-agent context HUD (agentHudBlockHtml + GET /api/agent-hud poll, card e9504aba) with a bar + percentage + color tiers, upstream\'s is a page-load-only static badge -- fork mechanism supersedes it. (3) MiniMax direct-API model option (loadAvailableModels, mirrors the existing DeepSeek pattern, gated behind MINIMAX_API_KEY): a genuinely NEW, not-yet-adopted upstream feature needing a backend port too (src/web/routes/agents.ts models endpoint) -- this is an ADOPTION decision, not a passive conflict resolution, so it is NOT folded in here; opened as its own low-priority follow-up card (48565f81) for Peti to decide on. No further behavioral gap found in this increment. Remaining ~11k lines (other regions, prior to c8c11f94) still not yet hand-audited slice-by-slice.' +
    " Re-audited 2026-09-04 (card 740551e6, blob 102cd901): the increment since 1e87b1d9 is " +
    "+282/-119 across 21 hunks, landed as two upstream commits on 2026-09-04 16:53 (c118ede2 #902 " +
    "context-guard UI, 4408754b #882 agent-card + Activity retirement), and is ONE coherent upstream " +
    "change -- it DELETED the Activity page (nav entry, " +
    "PAGE_HEADER_I18N row, startActivityPoll/stopActivityPoll/loadActivity, and the 8 activity.* " +
    "locale keys) and merged that content into the Team page, then added (a) agentActivityBodyHtml, " +
    "(b) a per-agent context-guard SETTINGS UI (setupContextGuardUI / updateContextGuardLiveStatus / " +
    "startContextGuardPoll, backed by the new agents.settings.ctx_guard_* keys), (c) a live " +
    ".team-node-active working state plus a run-state line on the team graph, (d) onAgentCardClick. " +
    "RESOLUTION: do NOT take the deletion -- the fork keeps its own Activity page and its locale " +
    "keys, so taking upstream wholesale would remove a live fork feature. (c) is redundant with the " +
    "fork's existing running indicator (.team-node.main.agent-card-running::after), the same " +
    "reasoning that skipped the thinking-orb last round: two animations for one signal. (b) is a " +
    "genuinely new capability the fork lacks -- its own agent-hud DISPLAYS context, this EDITS the " +
    "config -- and needs a backend port, so it is an ADOPTION decision rather than a passive " +
    "conflict resolution: NOT folded in here, raised on card 740551e6 for triage, the same " +
    "treatment MiniMax got last round (card 48565f81)." +
    " Re-measured 2026-09-06 (backend3, card 58ebcdc9 landing-block, 102cd901..b7ba2cf5): two new regions. (1) A blockers UI (kanban-card-blocked badge, renderCardBlockersSection, i18n kanban.blocker.* keys) for the same card-blocking-link feature src/db.ts and src/web/routes/kanban.ts's entries decide is superseded by the fork's own kanban_dependencies -- NOT a gap, not adopted, matching those entries. Its aging-badge hunk (agingBasis = card.last_status_at ?? card.updated_at) is paired with db.ts's last_status_at field and IS a real improvement candidate (updated_at gets bumped by comments, last_status_at would not) -- flagged there, not resolved here since the frontend half alone does nothing without the backend field. (2) A large idea-box scope (munka/szemelyes) + attachments UI (upload button, per-idea attachment list, scope filter/move) -- genuinely new, pairs with db.ts's idea_box.scope/idea_attachments entry; the backend route for /api/ideas/upload and /api/ideas/:id/attachments is not in this round's 8-file set, so this frontend half cannot be adopted alone either. Both (1)'s aging half and (2) are ADOPTION decisions, raised on card 6c6d471a alongside the db.ts entry. No hits on the Activity-page deletion, context-guard settings UI, MiniMax, thinking-orb or static-badge conflict points this rule already decided -- all untouched. Resolution unchanged; blob bumped." +
    " CORRECTION 2026-09-25 (card 2f1cbaf1, backend3, ACKNOWLEDGED_FORK_ANCHORS backlog): PARTIALLY reversed on item (1) above, verified directly, and worth stating precisely rather than as a flat yes/no. renderCardBlockersSection as a JS function is genuinely ABSENT from app.js and app-kanban.js (zero hits) -- that half of the refusal holds. But the i18n-tagged HTML markup DID land: web/index.html has a kanban.modal.blockers_title / kanban.blocker.add_placeholder / kanban.modal.blocking_title block (a modal section), and nothing in any JS file calls the backend's live /api/kanban/:id/blockers route (grep-verified, zero call sites) to populate or wire it. Net effect today: dead markup, static HTML referencing live i18n keys with no code path that ever fills it in or responds to it -- not a working feature, but not simply absent either. Matches the src/web/routes/kanban.ts correction from this same audit (the backend route is live and unused); together they describe one feature whose backend + static frontend scaffolding both landed piecemeal via unrelated upstream syncs while the actual JS wiring never did. Item (2), the idea-box scope/attachments UI, is untouched by this correction." +
    " Re-audited 2026-09-15 (backend3, card 3602c2ae, b960001e70c4..f375962cebdd): +85/-1, no overlap with any previously-decided conflict point. Two genuinely new regions, and they are NOT the same kind of gap. (1) A quota strip on the overview page (renderQuotaStrip, formatDurationShort, quotaLevelClass, consuming a new d.quota field from /api/overview): measured this fork's OWN src/web/routes/overview.ts already imports readQuotaSnapshot and already returns a `quota` field on GET /api/overview (present before this round, unrelated card) -- so unlike the usual case, the backend half is ALREADY THERE; this is a close-to-zero-risk adoption candidate PENDING one check not done here (that readQuotaSnapshot's return shape actually matches what this JS expects: fiveHour/sevenDay/status/ageSec/resetsAt/expired). (2) A full 'Claude Plans' settings tab (renderClaudePlansPanel + the claude-plans module tab wiring, PR2b/PR2c) reading/writing a plan-list and calling GET /api/claude-plans/state + POST /api/claude-plans/rotate: this fork DOES already have src/web/claude-plans.ts (card 272361eb) but NOT those two routes (checked: zero hits in src/web/routes/*.ts) -- a real two-piece adoption (route + UI), same character as the MiniMax/context-guard-UI/idea-box precedents this entry already defers. Also unrelated to either: `handoff: false` dropped from the auto-restart save payload (the field is not read; harmless either way) and one new known-module label ('claude-plans') for settingsModuleLabel. Neither region ported here -- (1) is flagged as a near-zero-risk follow-up, (2) as a real adoption decision, both on the same follow-up card as the paired en.js/hu.js key additions below. Resolution at every previously-decided point unchanged; blob bumped.",
  // Two independent additive hunks with no behavioral overlap. Fork adds: HEARTBEAT.md ignore,
  // Ingatlan/ runtime data exclusions, and per-extension keep-tracked exceptions for operational
  // scripts (store/*.sh, store/*.py, store/stitch-tools/gen.mjs) by switching store/ → store/*
  // with negation rules. Upstream adds: .pre-ship-evidence/, evidence/, transcripts/,
  // .session-capture/ (EVIDGUARD818 -- captured output never belongs in repo). Resolution: union
  // of both sides -- keep the fork's store/* + negation lines (the fork's more nuanced pattern
  // supersedes upstream's bare store/ line), and append upstream's evidence/transcript ignores.
  '.gitignore':
    'union of both additive sides: keep fork store/* + !store/*.sh/py/stitch negation structure + Ingatlan/ + HEARTBEAT.md, AND append upstream EVIDGUARD818 evidence/transcript/session-capture ignores -- both sides add to non-overlapping regions. ' +
    'Re-decided 2026-09-25 (card c2aeefa5, backend, upstream f3ce19ed..0db7ac66): three more upstream-only additive lines since the last pin -- tmp.* (test-artifacts section), .fakehome (already adopted verbatim in an earlier round, untouched here), supabase/.temp (CLI scratch state, same no-trailing-slash symlink caveat as .fakehome, measured by upstream on 2026-09-17). Adopted the two missing ones (tmp.*, supabase/.temp) into the fork file at the matching sections; no removals on either side, still the same union pattern, resolution unchanged.',
  // Measured 2026-09-01, heartbeat reconciliation ahead of card 0f7f7fe9's land: single hunk, both
  // sides purely additive at the same insertion point in the file, zero semantic overlap. Fork adds
  // .agent-hud* rules (per-agent live HUD: context-pct + active-model, kanban f07c5b7c). Upstream
  // adds .agent-ctx-badge rules (context-window-used badge on the Agents grid card, tiers mirror
  // context-guard's actPct/hardPct). Different class names, different features, neither references
  // or overrides the other. Resolution: keep BOTH blocks verbatim, in either order -- not a
  // wholesale-one-side pick, same "two independent additive hunks" character as the .gitignore
  // entry above, just CSS instead of ignore-patterns.
  'web/style.css':
    'two independent additive hunks, no overlap: keep fork .agent-hud* rules AND upstream ' +
    '.agent-ctx-badge rules verbatim, both blocks, either order. ' +
    "RE-MEASURED 2026-09-04 (card 740551e6, upstream blob a7fc0f2b): +65/-1, and the single removed " +
    "line is a COMMENT -- no CSS rule was taken away, which is what makes the union safe here rather " +
    "than merely convenient. A naive selector count still looks alarming and a " +
    ".team-node appears 16x on the fork side, 18x upstream. " +
    "It is NOT a collision: the shared .team-node{} body is BYTE-IDENTICAL on both sides (extracted " +
    "and diffed), i.e. merge-base heritage, and every differing selector is additive on exactly one " +
    "side. Fork-only: .team-node.main.agent-card-running::after. Upstream-only: " +
    ".team-node.team-node-active, its :hover, and .team-node-status. Resolution unchanged (union, " +
    "both blocks); this note exists so the next reader does not re-derive the same scare from the " +
    "same count." +
    " Re-measured 2026-09-06 (backend3, card 58ebcdc9 landing-block, a7fc0f2b..fb4ae675): +73/-0, purely additive, all new selectors (.blocker-list/.blocker-row/.blocker-link/.blocker-state/.blocker-remove/.blocker-cleared/.blocker-empty/.kanban-card-blocked) for the card-blockers UI src/web/routes/kanban.ts's entry decides is superseded by the fork's own kanban_dependencies. No overlap with .agent-hud*/.agent-ctx-badge or any .team-node selector -- every point this rule decides is untouched. Union stays safe (zero collisions, nothing removed); the new rules sit unused unless/until the blockers UI is adopted, which it is not. Resolution unchanged; blob bumped.",
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
  // Resolution: keep the fork's version (references the /clear-between-cards practice + the model-fallback respawn,
  // both fork-specific), drop upstream's duplicate case -- not a wholesale-theirs, a same-assertion
  // dedup.
  'src/__tests__/agent-taskstate.test.ts':
    "duplicate `replays on clear too` case on both sides (same assertion, different framing) -- keep fork's version (cites CLAUDE.md the /clear-between-cards practice + model-fallback respawn), drop upstream's duplicate",
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
  // if stop.sh removes the pidfile ONLY AFTER the process is confirmed gone (the other half of
  // 9d3b77f4, 43 insertions in scripts/stop.sh).
  //
  // PREMISE CORRECTED (card 4276708e, Cybersec finding 4b). This comment used to say "OUR stop.sh is
  // still the merge-base version ... it does `kill` and then `rm -f` the pidfile immediately". That
  // is BACKWARDS, measured against the merge base: scripts/stop.sh is +43/-2 on the fork side, a
  // strict SUPERSET that ALREADY carries both halves -- the system-scope-first branch and the
  // wait-for-exit loop -- and the single most important line it REMOVES is exactly the dangerous
  // early `rm -f "$pidfile"`. In other words the fork independently fixed the race upstream fixed.
  //
  // The conclusion (treat the pair as one protocol) survives the correction; the reasoning does not,
  // and leaving it inverted was the actual hazard: a later reader acting on "our stop.sh is
  // unmodified, align it to upstream" would overwrite the confirmed-exit block with whatever
  // upstream has, reintroducing the double-poller race this pair exists to prevent. scripts/stop.sh
  // does NOT conflict, so nothing forces anyone to look at it -- which is why it is named here.
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
    "additive, non-colliding imports on both sides -- keep fork's estimateCostUsd/stripDateSuffix (model-pricing.js) AND upstream's listAgentNames (agent-config.js) + resolveAgentConfigDirForRead (claude-plans.js), all four together. DONE 2026-09-04 (card f27c999b, B-wave 4/6): all four imports present, and upstream's isolated-config-dir discovery loop in discoverAgentSources adopted with it. Measured first -- it does not currently bite here, because provisioning symlinks agents/<name>/.claude-config/projects back to ~/.claude/projects, so both roots are one tree; what it buys is independence from that provisioning detail, and the UNIQUE INDEX + INSERT OR IGNORE makes the overlap a no-op. " +
    "ADOPTED 2026-09-04 (card 607254fb, B-wave step 1) -- upstream's `AND NOT EXISTS (child.parent_id = ...)` filter in correlateWithKanban, which skips PARENT cards. THIS CLAUSE PREVIOUSLY READ 'DELIBERATELY NOT ADOPTED', on the stated ground that this fork had NO touchAncestorChain. That ground is gone: card 4b03a88d adopted ancestor stamping (db.ts touchAncestorChain, four call sites), and the filter came with it -- exactly the condition the old clause named as its own trigger ('REVISIT IF the fork ever adopts ancestor stamping: at that moment this filter becomes right, and this note is the trigger'). The trigger fired; this is the revision it asked for. Both halves are present on develop and must stay together: the filter is only correct BECAUSE a parent now carries its child's updated_at, so removing ancestor stamping without removing the filter would start discarding correct attribution. WHY THIS WENT STALE, which matters more than the entry itself: ACKNOWLEDGED_UPSTREAM_BLOBS pins each rule to an UPSTREAM blob, so a re-measure round bumps the pin whenever UPSTREAM moves. Nothing pins the FORK side, and this note went wrong because WE moved -- the pin was fresh the whole time it was asserting a fact about our own tree that had stopped being true. A stale exemption is worse than a missing entry: a missing one gets noticed at the next conflict, while this one would have told the next merger, with a '-- checked', to delete a filter that is now correct." +
    " Re-measured 2026-09-05 (mikrob, landing-block): upstream 346fa63739d8..82ebcf785cd0 adds resolvesToSharedProjectsRoot() + a skip check in discoverAgentSources, closing a measured triple-count on upstream's own install (the SAME transcript reached their cost parser under three symlinked paths, because their cursor table is keyed by file path). I claimed this fork's own dedup key was content-based and therefore immune -- WRONG, and CYBERED CORRECTED IT (efaf8926, comment 20898) with a live measurement: idx_token_usage_dedup is `(agent, session_id, timestamp, input_tokens, output_tokens)` -- `agent` is the FIRST column, so two rows attributed to DIFFERENT agent names never collide no matter how identical the rest of the tuple is. Measured on the main clone's own store/claudeclaw.db: jogasz/penzugy/qa2/teszter/videooo report byte-identical totals (245129 calls, 681208 input, 137512828 output, 92918639201 cache-read, 486 sessions each), one session id appears under 16 different agent names, and 3,891,748 rows dedupe by content to 389,642 distinct rows -- 90% of the table is the same bug upstream measured at 73% on theirs. This DOES bite here, live, right now: costops/ledger.ts's per-(agent, day, model) pricing is inflated roughly tenfold and smeared across every isolated agent, model-suggest.ts's tier recommendations are built on it, and a compromised or runaway agent's consumption cannot stand out in a table where every agent's row is identical. NOT adopted this round (a real fix + a ~3.5M-row backfill cleanup are their own card, not a rider on a landing-guard unblock); resolution for the six ACKNOWLEDGED_CONFLICTS entries otherwise unchanged, blob bumped. The lesson this note itself named one round earlier -- 'nothing pins the FORK side, and this note went wrong because WE moved' -- repeated on the SAME entry, because I read the surrounding prose comment instead of the actual CREATE INDEX statement. Read the schema, not the comment about the schema. ROUND 2026-09-11 (backend3, card 9c665470, 5ddd9df0c824..67edd340c70b, +6/-1): a six-line upstream change with zero hits on quarantine-stray, flock or pidfile -- none of the three things this rule decides (the OS-dispatch adoption, the kept rollback-guard block, the stop.sh pairing) appears in it. Resolution unchanged; blob bumped. THE MANDATORY PAIR ABOVE STILL STANDS and is not weakened by this bump: adopting start.sh without stop.sh from the same upstream commit remains worse than adopting neither.",
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
    'dependency list + scripts stay fork-canonical (superset of upstream: react/recharts/vite/eslint/google-auth/newer claude-agent-sdk/overrides; shared-dep version bumps need case-by-case evaluation); the top-level `version` field is the ONE exception -- its X.Y.Z tracks upstream on every sync-merge per rule 12783b1e, fork keeps only its own +mikrob.N counter' +
    " Re-measured 2026-09-06 (backend3, card 79bb0364 landing-block, round 15). Upstream bumped the vitest devDependency from ^2.1.0 to ^4.1.10 -- one line, nothing else in the file. NOT adopted: a vitest major across a 15k-test suite is its own card with its own baseline run, not a rider on a landing-unblock, and it travels with the vitest.config.ts testTimeout line (see that entry) -- adopt them together or neither. The dependency-list rule and the version-field exception are untouched by this diff. Resolution unchanged; blob bumped." +
    " Re-decided 2026-09-25 (card c2aeefa5, backend, c932fc322865..f8e8153101835187): two changes. (1) version 1.37.0 -> 1.39.0: the version-field exception already covers this -- tracked at the next actual sync-merge, not hand-edited here. (2) `\"build\": \"tsc\"` -> `\"build\": \"tsc && node scripts/write-built-commit.cjs\"` (BUILTSTAMPKEZI920): DIFFERENT from the usual 'scripts stay fork-canonical, do not take upstream's' stance, adopted directly rather than deferred, because this closes a gap already described by the fork's OWN existing mechanism, not a new upstream feature -- this fork's update.sh (BUILT_COMMIT_FILE / BUILT_COMMIT comparison, ~line 904-909) and install-linux.sh (~line 1030-1039) already read/write dist/.built-commit as the self-heal staleness marker, but nothing wrote it after a plain `npm run build`, so every manual build left a stale-looking stamp. Ported scripts/write-built-commit.cjs from upstream verbatim (fail-soft: no dist/ or no readable git HEAD -> writes nothing, exits 0, never fails the build), with one comment correction (the upstream comment's update.sh:747-751 line reference does not hold on this fork's file; corrected to name the actual BUILT_COMMIT/NEW_VERSION_FULL comparison block instead of copying a wrong line number). Sanity-checked directly: run against this tree, wrote dist/.built-commit with the current HEAD sha, exit 0. dist/ is gitignored so the stamp itself is never committed. Zero conflict surface with the scripts-stay-fork-canonical rule since the fork had no competing 'build' script content to preserve.",
  // Lock-file conflict from independently added/updated dependencies. The fork manages its own
  // package set; upstream its own. Regenerated by `npm ci` from the fork's package.json.
  // Resolution: keep the fork's lockfile; upstream lockfile sections for packages not in the
  // fork's package.json are not applicable.
  'package-lock.json':
    'keep the fork lockfile canonical; regenerate from fork package.json via npm ci if ever needed' +
    " Re-measured 2026-09-06 (backend3, card 79bb0364 landing-block, round 15). Lockfile churn only, and it follows the package.json vitest 2->4 bump this round declines (see that entry). Nothing to decide separately: the lockfile is regenerated from the fork's own package.json, never merged. Resolution unchanged; blob bumped." +
    " ROUND 2026-09-06, card 50af1a27 (3c cluster). Measured for completeness rather than assumed: the three-way merge of this file produces 40 conflicts (upstream +799/-911, fork +3087/-544). That number is not a reason to hand-merge anything -- it is the reason NOT to. The standing resolution holds and is the whole point: a lockfile is REGENERATED from the fork's package.json, never reconciled hunk by hunk, and the regeneration is a MAIN-CLONE operation (a worktree's dependency dir is a symlink into the shared tree, so an install there rewrites every agent's node_modules mid-work). So this belongs to the merge step, not to the hand-resolution step: do not resolve it here. Blob unchanged." +
    " Re-decided 2026-09-25 (card c2aeefa5, backend, f891372ec7e6..873217a2ea50): trivial diff this round -- only the top-level/package `version` field, 1.37.0 -> 1.39.0, mirroring the same field in package.json (see that entry). Same standing resolution: regenerated from package.json via npm ci at merge time, never hand-resolved. Blob bumped.",
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
    "Re-measured 2026-09-03 (backend2, card 6500e1d3 landing-block, bb4a7bc74200..ad28ed576466): upstream threaded the same AGENT_API_ORIGIN into currentHeartbeatIdentity's resolveDashboardOrigin call, and REWROTE the 'Collect the four data sources' prose plus the calendar wording (now HEARTBEAT_CALENDAR_ID rather than 'whatever account the MCP server is authenticated as'). The metrics-script contract this rule adopts is untouched, and so is the fork's printf|curl token-argv-safe pattern it keeps. NOTE for whoever executes the merge: this rule says to take upstream's report format 'verbatim' -- that word now refers to TODAY's block, not the one it was written against, so copy from this blob rather than from memory." +
    " CORRECTION 2026-09-25 (card ea86a362, backend3 retrospective B-wave audit): the 'NOT yet applied to live develop, deferred to F5' framing above is stale. The metrics-script contract WAS adopted -- scripts/heartbeat-metrics.sh, HeartbeatIdentity.metricsScript and HEARTBEAT_AGENT_ID are wired in the current tree (card HBMETRICSWIRE910, landed 2026-09-11, commits 01d28977/e02b5977), verified directly at this file's lines 44/55/103/108/121/189, not from git history. This was never a B-wave auto-merge regression -- the adoption landed on its own card after this entry was written, and the entry was simply never updated to say so. Resolution unchanged in substance (the fork's printf|curl pattern still applies where upstream did not touch it); the 'not yet applied' status is retracted.",
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
    "Re-measured 2026-09-03 (backend2, card 6500e1d3 landing-block, 9736ea673775..a7c10a08f1fa): upstream added a desktop-lock gate (decideDesktopGate/readDesktopLock/recordDesktopSkip), owner-escalation for pending retries (markPendingTaskRetryOwnerAlert + OWNER_ESCALATION_EXTRA_MS, classifyTelegramSendError generalised to classifySendError), and channel-provider imports. All of it is elsewhere in the file; the fork's async runPreCheck signature and its try/catch around startAgentProcess -- the two things this rule decides -- are untouched. Resolution unchanged; blob bumped." +
    " Re-measured 2026-09-06 (backend3, card 79bb0364 round-2 landing-block, upstream round 16). Two upstream changes. (1) readAgentClaudeConfigDir replaced by resolveAgentConfigDirForRead from claude-plans.js -- the SAME swap this file's sibling rule (context-restart-gate-runner.ts) already records as adopted, so the direction is settled if this one is taken. (2) TASK_FIRE_TIMEOUT_MS raised from 5 to 45 minutes, with a measured reason: five minutes measures 'the session is busy', not 'the task is wedged', and those coincide only when nobody talks to the agent -- the owner got four or five false 'possible hang' alerts in one morning. That is an alerting-threshold change on a watchdog, i.e. exactly the kind of number that deserves its own decision rather than a rider. NOT adopted; the window-size fixture rule this entry is about is untouched by either. Resolution unchanged; blob bumped. ROUND 2026-09-11 (backend3, card 9c665470, 3bb55c7c3390..e5393ace227f, +4/-2): a four-line change with zero hits on runPreCheck or startAgentProcess -- neither of the two independent points this rule decides is touched. Resolution unchanged; blob bumped." +
    " CORRECTION 2026-09-25 (card 2f1cbaf1, backend3, ACKNOWLEDGED_FORK_ANCHORS backlog): the 2026-09-06 'NOT adopted' verdict on TASK_FIRE_TIMEOUT_MS is stale. The file's current value is `export const TASK_FIRE_TIMEOUT_MS = 2_700_000` (45 minutes, verified directly), landed by commit 3496bff1 (Vlbbtabs, PR #1175) on 2026-09-05 18:26 -- ONE DAY BEFORE this round's own 2026-09-06 refusal note was written. The refusal missed a same-day-prior upstream commit rather than being silently reversed by a later auto-merge; either way the code has carried the 45-minute value since before the refusal was recorded. This is an alerting-threshold change (fewer false 'possible hang' owner alerts), not a trust-boundary regression. Resolution retracted for this item; it is adopted, not open. The runPreCheck/startAgentProcess decisions this entry is actually about are unaffected.",
  // Fork added agents/** to the exclude list (with explanatory comment: live-install agent SDK
  // tests would otherwise drown the real suite). Upstream added assert-supported-node.ts to
  // setupFiles and updated the comment above setupFiles to list both gates. Both changes are
  // independently valuable. Resolution: keep fork's agents/** exclusion + its comment; adopt
  // upstream's assert-supported-node.ts setup file (porting the file itself from upstream) and
  // update the comment to mention both setup files.
  'vitest.config.ts':
    'keep fork agents/** exclusion + comment; adopt upstream assert-supported-node.ts in setupFiles (port the file from upstream) + updated comment listing both setup-file gates' +
    " Re-measured 2026-09-06 (backend3, card 79bb0364 landing-block, round 15). Upstream added one line, testTimeout: 60000, with its reason measured: vitest 4 enforces the 5s default that vitest 2 did not, and three subprocess-spawning tests legitimately take 15-30s. It is a consequence of the vitest 2->4 bump in package.json and is meaningless without it. NOT adopted this round for that reason -- the two move together. The recorded rule (keep the fork agents/** exclusion, port upstream assert-supported-node.ts into setupFiles) is untouched by this diff. Resolution unchanged; blob bumped." +
    " Re-decided 2026-09-25 (card c2aeefa5, backend, 6444aa74e7d4..062cdb6530f4): two new hunks. (1) `dist/**` added to exclude (upstream measured 888/10723 tests instead of 444/5633, 67 files RED with zero real failures, because `npm run build` compiles src/__tests__/*.test.ts into dist/__tests__/*.test.js and vitest was collecting both copies): ADOPTED VERBATIM, and not just by analogy -- measured on THIS fork's own tree that dist/__tests__ already holds 785 compiled .test.js files from a prior build, so the exact same double-collection defect was live here too. Sanity-checked directly: config still loads and a targeted single-file run stays green after the addition. (2) `default-ssh-dir-seam.ts` added to setupFiles (ENROLL813, 2026-09-15 upstream incident -- a route test hitting a real ~/.ssh/authorized_keys because MARVEEN_SSH_DIR was not set before the call): NOT adopted here. Investigated because it looked like a trivial third setup-file line, and it is not one: upstream's own comment on that file says the seam ALONE is insufficient without (a) the source test file's afterEach RESTORING the previous MARVEEN_SSH_DIR value instead of deleting it, and (b) fail-closed guards in src/ssh-dir.ts/src/remote-enroll-fs.ts. Checked THIS fork's own src/__tests__/bridge-enroll.test.ts and found it carries the SAME vulnerable shape independently (the 'JANKBRIDGE803' test's positive-control call reaches the live route with no MARVEEN_SSH_DIR set, and the file's afterEach unconditionally deletes the var after every test) -- a live, pre-existing, unpatched finding on this fork, not something this round introduced or is fixing. Escalated separately (msg 4146 to MikroB, 2026-09-25) as a request for a dedicated HIGH-priority security card (Cybersec review) rather than hand-fixed inside this drift re-decision, because porting the seam alone -- without the afterEach change and the fail-closed guards -- would be documented-insufficient by upstream's own words. Resolution at the assert-supported-node.ts point (still adopted) and the testTimeout deferral (still declined, still tied to the undecided vitest 2->4 bump) both unchanged; blob bumped for the dist/** adoption above." +
    " Re-decided 2026-09-25 (card 2564e877, backend, HIGH, ENROLL813 port): `default-ssh-dir-seam.ts` NOW ADOPTED into setupFiles, together with the afterEach restore fix in bridge-enroll.test.ts + bridge-service-ports.test.ts, the fail-closed guards (src/ssh-dir.ts, new; src/remote-enroll-fs.ts assertSafeSshDir chokepoint), and the new enroll-seam-fail-closed.test.ts regression -- the full combination the c2aeefa5 deferral above named as required, ported verbatim from upstream 86b2e461/e7bed5c8. Resolution otherwise unchanged.",
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
  // (2) provider-env building -- ADOPTED 2026-09-04 (card e80c011a), MINUS the minimax branch.
  //     Upstream refactored the inline ollama/deepseek/openrouter export-string building into a
  //     shared resolveProviderEnv(). It reproduces the fork's ollama/deepseek/openrouter strings
  //     byte-for-byte (SAME shSingleQuote sink-escaping, card b7fa5281), and that is now measured
  //     rather than eyeballed: provider-env-adoption.test.ts reimplements the pre-refactor inline
  //     expressions and asserts byte equality.
  //     THE MINIMAX BRANCH IS NOT ADOPTABLE -- Peti NO-GO, card 48565f81, CLAUDE.md rule 17. This
  //     comment used to read "net additive, safe to adopt wholesale", which is the sentence a
  //     future merger would act on, and acting on it lands a declined feature.
  //     WATCH THE SHAPE OF THE CONFLICT (Cybered, comment 19877): before the adoption this was one
  //     big "new function replaces inline code" hunk -- loud, obviously a decision. Afterwards it
  //     is TWO SMALL HUNKS that look purely additive: an `isMinimax` line in the discriminator and
  //     an `if (isMinimax)` block. The natural reflex on those is union, and union is WRONG here.
  //     The exclusion is pinned behaviourally and at source level in provider-env-adoption.test.ts,
  //     but a red test loses an argument with a written rule, which is why this prose had to change
  //     too.
  // (3) cmd assembly -- NOT ADOPTED. MikroB decision 2026-09-04 (cards bd450735 / e80c011a).
  //     Upstream adds a `umask 002` prefix and routes the tmux call through agentTmuxTarget(name)
  //     instead of a bare `null` host. This comment used to call both "no-ops for every agent as
  //     configured today ... not a live architecture switch that needs a decision now". The OUTPUT
  //     is a no-op; the DEPENDENCIES are a feature, and that distinction is the whole point.
  //     *** SUPERSEDED 2026-09-07 by card 4f15966e, recorded here 2026-09-12 (card 66ad1f95).
  //     agent-process.ts NOW carries the umask prefix (`const umaskPrefix = agentTmuxTarget(name)
  //     .runAsUser ? 'umask 002 && ' : ''`). That was a DELIBERATE, announced deviation: the
  //     dependency this paragraph said was missing -- agentTmuxTarget -- has since been built, and
  //     the call site says so in full, flagged for QA/Cybersec review. Unlike the
  //     context-restart-gate-runner entry above, nothing about this one was silent; what was
  //     missing is that the refusal was never struck from HERE, which is where a future merger
  //     reads. An ACKNOWLEDGED_FORK_ANCHORS entry now watches the prefix.
  //     Measured: it needs readAgentRunAsUser(), a 5th runAsUser parameter plus a sudo branch in
  //     buildTmuxInvocation (ssh-tmux.ts), sessionRunAsUserMap() with a TTL cache,
  //     runAsUserForTmuxArgs(), resolveTarget(), a HOST-LEVEL SUDOERS RULE (upstream says so in its
  //     own comment), and generalising 23 runTmux( call sites in the fleet's most startup-critical
  //     file -- while the fork has NO runAsUser consumer at all (the word appears nowhere in src/).
  //     umask 002 is dead without it: it fires only when runAsUser is set. Per-agent OS-user
  //     isolation is its OWN card with its own plan-grilling if the fleet ever wants it.
  'src/web/agent-process.ts':
    'union all three: (1) ISOLATED_CONFIG_SKIP keeps BOTH \'skills\' (fork) and \'projects\' (upstream) entries; (2) ADOPTED 2026-09-04 (card e80c011a): upstream\'s resolveProviderEnv() refactor, MINUS the minimax branch. Byte-identical output for claude/ollama/deepseek/openrouter incl. the b7fa5281 shSingleQuote fix, measured -- provider-env-adoption.test.ts reimplements the pre-refactor inline expressions and asserts byte equality. THE MINIMAX BRANCH IS NOT ADOPTABLE (Peti NO-GO, card 48565f81, CLAUDE.md rule 17); the exclusion is pinned behaviourally AND at source level so an upstream sync cannot bring it back quietly. After the adoption the remaining conflict is two SMALL hunks that look purely additive (an isMinimax discriminator line and an if(isMinimax) block) -- do NOT union them, that is the declined feature arriving by reflex; (3) DO NOT adopt upstream\'s umask 002 + agentTmuxTarget(name)/startTarget change. MikroB decision 2026-09-04 (cards bd450735/e80c011a). The OUTPUT is a no-op, the DEPENDENCIES are a feature: readAgentRunAsUser(), a 5th runAsUser parameter plus a sudo branch in buildTmuxInvocation, sessionRunAsUserMap(), runAsUserForTmuxArgs(), resolveTarget(), a HOST-LEVEL SUDOERS RULE, and 23 runTmux( call sites -- with NO runAsUser consumer in the fork. umask 002 is dead without it. Own card, own plan-grilling, if ever -- the fork\'s *Unlocked/withLifecycleLock split (card 74ba7c78) is UNRELATED to this hunk set and already correctly merged, do not touch it (4) Re-read 2026-09-03 (card 3bd18e70, blob 4c439228): the agent-scaffold import line now conflicts too -- union the fork ensureLocalFirstSection with upstream ensureSystemDirectiveAuthSection (GUARDHITELES903) on one line; the ensureSystemDirectiveAuthSection(name) call in startAgentProcess auto-merges (additive).' +
    "Re-measured 2026-09-03 (backend2, card 934dc104 landing-block, 4c43922809b2..45e20624c63f): upstream replaced the identity slash command `/name` with `/rename` (identitySlashCommands + three comments + two log messages), because `/name` does not exist and the rejected line sits parked in the input box, which the router then reads as busy. Untouched: ISOLATED_CONFIG_SKIP, resolveProviderEnv(), the umask/agentTmuxTarget assembly and the agent-scaffold import line -- i.e. every point this rule decides. Resolution unchanged; blob bumped." +
    " Re-measured 2026-09-05 (MikroB, card efaf8926 landing-block, 45e20624c63f..31758af9d36f): upstream made clearInputBuffer() retry up to 3 times with a post-clear verification read (stuckInputSignature), returning boolean instead of void, to fix a documented incident where a fire-and-forget clear left a leftover fragment and wedged a session 25.4h (machineOrigin read false forever). The fork's copy of this function is UNCHANGED since the pinned blob -- this is a clean, isolated, adoptable safety fix, not a conflict with fork-side work. PORTED 2026-09-05 (backend3, card b34fa678, commit 8a898970): the fork's clearInputBuffer now carries the same retry+verify and returns boolean, so this half is no longer a divergence. Measured while porting, and worth keeping here because the next re-read will meet it: the fork has FIVE call sites, not two -- channel-monitor 378/393 re-inject, 413/417 do not, and agent-process's own pre-flight clear. Only the two no-re-inject sites were adapted, matching upstream, which likewise leaves its internal call byte-identical: after a re-inject sendPromptToSession replaces the box contents and carries its own delivery verification, so the boolean adds nothing there. Upstream's THIRD re-inject branch (reinject-recorded, the STUCKINPUT827 registry work) does not exist in this fork and was deliberately not invented. Everything else this rule decided (ISOLATED_CONFIG_SKIP, resolveProviderEnv, the umask/agentTmuxTarget assembly, the agent-scaffold import line, the /rename change) is untouched by this diff. Resolution unchanged for those; blob bumped." +
    " Re-measured 2026-09-06 (backend3, card 79bb0364 landing-block, round 15). Upstream fixed a measured 12-hour outage in reconcileMcpServers/provisionIsolatedConfigDir: Claude Code resolves LOCAL scope (.claude.json) BEFORE PROJECT scope (<cwd>/.mcp.json), so copying a shared MCP server whose name the agent already defines in its own .mcp.json does not fill a gap, it SHADOWS the agent's definition, credentials included -- silently, with zero tools registered and a healthy-looking backend. The fix adds projectScopedServerNames(cwd), a skip in the gap-fill and stripProjectScopedCollisions() on the first-seed path. THIS FORK IS EXPOSED AND IT IS ALREADY BITING: reconcileMcpServers here takes (cur, sharedDot, name) with no cwd, and measured on this install, `teszter` defines `playwright` in its own .mcp.json AND carries a copy at local scope -- the browser-testing agent's core server, shadowed right now. Not adopted inside a landing-unblock (it is a behavioural fix to agent provisioning and deserves a card with a gate), carded separately; this note is the evidence for that card. Everything this rule already decided (ISOLATED_CONFIG_SKIP, resolveProviderEnv, the umask/agentTmuxTarget assembly, the agent-scaffold import line, /rename, the ported clearInputBuffer retry+verify) is untouched by this diff. Resolution unchanged; blob bumped. ROUND 2026-09-11 (backend3, card 9c665470, 6cced18cecdc..46155ebb33fe, +132/-17): zero hits on ISOLATED_CONFIG_SKIP, resolveProviderEnv, minimax, agentTmuxTarget or clearInputBuffer -- every point this rule decides is untouched. Resolution unchanged; blob bumped. Read the src/web/session-send-lock.ts entry alongside this one: upstream's pane-writer work from this round is recorded there, and it names a gap that is OPEN in THIS file -- scheduleIdentitySetup still sends the identity /rename with a bare runTmux(send-keys) on a fire-and-forget setTimeout, outside any lock.",
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
    'keep both additive blocks -- the fork stripDataPayloads() literal-payload blanking (card 132fc28c false-positive fix) AND upstream MANAGE_EMAIL_SEND_OPS; neither side taken wholesale' +
    " Round 2026-09-25 (backend3, card b5b7eb6b child 09d54e88, fac936d4aa39..dfb13dd2fa30): a DIFFERENT conflict location than the point above -- the Bash-tool isSendInvocation() call. The fork's OWN source comment at this exact call site documents an already-landed prior decision (card 72f5f13b, resolved by card c7401c5f): isSendInvocation() is composed with heredocFeedsSend so a heredoc-fed interpreter send (e.g. `python3 <<'PY' ... smtplib.SMTP(...) ... PY`) still denies -- that composition is NOT recorded here in acknowledged-conflicts.ts, only in the source comment, and this round leaves it untouched either way. ADOPT upstream's refinement: `wrapperDepthHit(cmd) ? { deny: true, kind: 'wrapper-depth' } : { deny: true }` -- verified wrapperDepthHit is a REAL function, merged in cleanly elsewhere in this same file with zero conflict (an already-adopted upstream addition), so this is purely a diagnostic `kind` classification on top of an unchanged `deny: true` outcome. `isSendInvocation(cmd)` is called FIRST, identically to the fork's current code -- the heredoc-composition fix this entry already won is untouched, not weakened or bypassed. Resolution at the point below (stripDataPayloads/MANAGE_EMAIL_SEND_OPS) unchanged." +
    " CORRECTED same round, same day (self-caught while re-verifying after a qa2 QA FAIL found the same conflict-marker-blind-spot class on scripts/watchdog.sh and scripts/install-prod-tree-guard-hook.sh): the ADOPT above was scoped correctly, but this entry did not say what ELSE arrived in the SAME old-pin..new-upstream range, non-conflicting and therefore invisible to a merge-marker-only read. Diffing the full range directly shows a SUBSTANTIAL new upstream feature, NOT adopted, NOT decided here, and security-relevant enough to flag rather than silently skip: a recipient-ledger verification system (new dependency `./recipient-ledger.mjs`, `loadLedger`/`isVerifiedIn`/`splitAddresses`; `unverifiedRecipients()` checks every to/cc/bcc/recipient(s) field on a draft or manage_email call against the ledger and denies with kind 'unverified-recipient' if any address has no recorded source) PLUS a Gmail-connector-specific gate (`gmail__(reply|reply_all|send_message|forward)` denied with kind 'connector-send', upstream's own comment stating 'before this line a sub-agent could send through the connector with no gate at all' -- GMAILCONNECTOR914). Verified NEITHER exists in the fork today (`recipient-ledger.mjs` absent, zero hits for `gmail__`/`GMAILCONNECTOR` anywhere in src/ or scripts/). Also present, not separately assessed: a `commandHeads`/`WRAPPERS`/`CMD_POSITION_KEYWORDS` rewrite of the Bash-detection internals (segmentIsSend's replacement), explicitly paired with its python twin in outgoing-copy-gate.py via a shared send-invocation-cases.json -- given outgoing-copy-gate.py's OWN entry is separately escalated to Cybersec this same round, this rewrite should be assessed TOGETHER with that escalation, not piecemeal here, so the two copies do not drift out of the parity their own shared test file exists to enforce. NOT adopted, acknowledge-only: whether the Gmail-connector gap is live and exploitable depends on whether this fork actually exposes that connector to sub-agents (not verified here), which is exactly the kind of question a dedicated card with a gate should answer, not a drift re-decision guessing at it. Resolution at the two already-decided points (stripDataPayloads/MANAGE_EMAIL_SEND_OPS, wrapperDepthHit) unchanged.",
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
    " Round 12 (2026-09-02, MikroB landing-block, QA stale-blob catch 4deba6bb7214..c724df596611): upstream refactored (EMAILKAPU901 PR1) -- collect_bash_body()/collect_mcp_body() moved VERBATIM out to a new sibling module scripts/hooks/email_extract.py (a level-2 approval gate elsewhere now hashes the same letter this gate audits, so upstream wants exactly one extraction implementation, parity-pinned by its own test), imported behind a guarded try/except that fails CLOSED for the email path (stub returns an unreadable-reason, same as today's unreadable branch) if the import breaks, and leaves telegram (which never calls these) untouched. NOT adopted this round: the fork's file still has the inline functions verbatim (recorded resolution unchanged, still a strict superset via the sentinel fix), so this round is acknowledge-only. The extraction-module split is a real, reasonable refactor and a candidate for a future round -- but splitting a security-audited function across a new file is exactly the kind of change that wants its own dedicated review (parity test included), not a rider on an unrelated landing-unblock." + " Round 13 (2026-09-03, backend2, fleet-wide landing block, standing authority from MikroB msg 19101): upstream rewrote load_bad_name() itself (CLCOPYGATEHIANY902, c724df596611..d35afdd048eb) -- the exact function this entry's resolution is about. It now returns (regex, state) and SPLITS what the fork treats as one case: a MISSING or EMPTY rules file becomes fail-OPEN for email with a loud systemMessage on every send, while only an INVALID file (present but unparseable/bad schema/uncompilable regex) stays fail-CLOSED. Upstream's reason is a fresh customer install, where the file is deliberately not shipped (it names a private person) and the old behaviour left a paying customer unable to send mail at all. NOT adopted, acknowledge-only. Two reasons, and neither is 'we did not look': (1) it is a security-POSTURE change, not a refactor -- adopting it would relax this fork from fail-closed to fail-open on the email path, which is a decision for a card with a gate, not a rider on a landing-unblock; (2) not adopting keeps this fork on the STRICTER side, so the acknowledge-only choice cannot lose protection. Measured while deciding, and worth its own card: on THIS install store/outgoing-copy-gate-rules.json exists but has ZERO bad_name_patterns. CORRECTED 2026-09-03 (card 934dc104, backend2, measured by running the gate rather than reading it): zero patterns returns the card-3ec64c96 SENTINEL, not None, so the email branch was NOT fail-closed from the main clone -- it passed silently. The fail-closed reading came from a WORKTREE copy, where the script-relative rules path resolved to a file that checkout can never have; card 934dc104 made that path checkout-independent. The state upstream is responding to (a fresh install with no rules file at all) is still real and still not adopted here, for the two reasons above. That is an operational finding for the owner, not a reason to take upstream's relaxation blind." +
    " Round 14 (2026-09-05, backend2, fleet-wide landing block, same standing authority): upstream " +
    "merged CLCOPYGATEHIANY902 with GATEPERSIST816/3 (d35afdd048eb..0d21a60005cd), taking load_bad_name() " +
    "from four states to FIVE. The new one is 'sanctioned': a rules file that EXISTS and explicitly " +
    "carries no_name_rule:true is treated as a TAKEN DECISION rather than a loss, and is silent " +
    "everywhere -- no log line, no systemMessage, no block, via an early return that skips the logging " +
    "tail. An ordinary empty list WITHOUT the flag does not reach it, so a file emptied by accident " +
    "cannot masquerade as sanctioned. NOT adopted, acknowledge-only, for the same reason as rounds 12 " +
    "and 13: it is a security-POSTURE change to the exact function this entry is about, and a posture " +
    "change belongs on a card with a gate, not on a landing-unblock. " +
    "THE ARGUMENT AGAINST THAT CHOICE, recorded here so the next round does not have to rediscover it " +
    "and so this entry does not read as one-sided: rounds 12 and 13 justified acknowledge-only partly " +
    "with 'not adopting keeps this fork on the STRICTER side'. For THIS state that is no longer clearly " +
    "true. This install's store/outgoing-copy-gate-rules.json exists with ZERO bad_name_patterns and no " +
    "flag, and card 934dc104 measured that the fork's zero-pattern path returns the card-3ec64c96 " +
    "SENTINEL and passes SILENTLY. Under upstream's merged policy that same state is 'empty', which is " +
    "fail-open but LOUD on every send. So on the configuration this install actually runs, upstream is " +
    "the more visible behaviour, not the weaker one, and 'stricter' is the wrong axis to decide it on. " +
    "That is a genuine reason to adopt, and it is still not a reason to do it inside a landing-unblock " +
    "with no gate. It is the strongest argument for the adoption card, and it should be quoted there." +
    " Re-measured 2026-09-06 (backend3, card 79bb0364 landing-block, round 15). Round 15, three upstream changes. (1) load_bad_name() accepts a SECOND spelling of the sanctioned state (name_check_disabled alongside no_name_rule) because two installs each documented one before the branches met -- the same security-POSTURE family this entry has declined in rounds 12, 13 and 14, and declined again here for the same reason: a posture change belongs on a card with a gate. (2) main()'s dispatch widened to telegram edit_message (an edit can replace a working code block with a broken one) and to a named set of outbound email operations. (3) GATECOPY827: telegram_gate() now BLOCKS a reply containing a triple-backtick code block unless format=markdownv2, because Telegram gives no copy button in plain text. Measured on the fork's file: NONE of the three is present here -- this fork's copy gate has no code-block check at all, while the fleet's own telegram-copy-gomb skill describes that check as existing. That gap is a real finding and it is the owner's Telegram path, not this card's; reported rather than patched inside a landing-unblock. Resolution unchanged (keep the fork file wholesale, re-adopt sections deliberately); blob bumped." +
    " Round 16 (2026-09-06, backend, card b4404ed2 -- a DEDICATED card with a gate, not a landing-unblock, which is why this round ADOPTS instead of acknowledging). Upstream 03ca5262 (d97e9683..3ba1db43) answers four false positives in the accent audit with four new TECHNICAL alternatives plus the removal of the bare 'level' HU marker. This fork took the 'level' half (both parts) and DECLINED the other three, and the split is measured, not stylistic: all four upstream false positives were run against this fork's own audit() first. Three of them -- number+suffix (8:09-es, 17:06-kor), propername+suffix (Chrome-ot, Drive-ra) and lowercase hyphenated identifiers (folyamatos-ellenorzes) -- ALREADY PASS here, because this fork solved that class in a DIFFERENT layer: HYPHEN_WORD tokenises the hyphenated form WHOLE, so 'chrome-ot' never decays into 'ot', backed by DIGIT_HYPHEN_SUFFIX_ALLOWLIST and IDENTIFIER_ALLOWLIST. Those two allowlists are the OUTPUT of two Cybersec NO-GOs (fbb36b41 rounds 7/8 and 11) that rejected precisely upstream's UNCONDITIONAL shape -- an unbounded \"word after a digit-hyphen\" or \"lowercase hyphenated form\" mask hides its span from the homoglyph check as well as the accent check. Adopting them would buy zero measured benefit at the cost of re-widening what two gates narrowed. The FOURTH is a real hole here too, and one this fork is more exposed to than upstream: our own CLAUDE.md defines \"Level 1/2/3\" autonomy tiers, so any Hungarian message quoting them blocked. Measured on flawless Hungarian prose: BLOCKED on 'level -> level' alone. Separately, a pure-English sentence (\"The new access level lands in the advance market build\") reached three HU markers -- van inside \"advance\", level, mar inside \"market\" -- so is_hungarian() returned true for English and the audit ran at all. Both halves adopted; the mask is deliberately narrow (digit-only), so 'level' as a genuine misspelling of 'levelet' still blocks. Four selftest cases pin it, and each half was mutation-tested separately: reverting either one kills exactly its own case and no other, so neither half is redundantly covered by the other's test. Resolution unchanged; blob bumped. ROUND 2026-09-11 (backend3, card 9c665470, abaaedc4d0e9..fac936d4aa39, +172/-8). READ, not keyword-counted, and the distinction mattered: a grep for MANAGE_EMAIL_SEND_OPS reports a hit, but it is the @@ HUNK HEADER naming the enclosing declaration, not a change to it. What upstream actually added is a self-contained thread-membership deny path (extractAddress, threadReplyRequest, threadMembershipDecision, extractParticipants, fetchThreadParticipants, buildThreadDenyMsg) refusing replies to addresses outside the thread's participants. Neither point this rule decides -- the fork stripDataPayloads() literal-payload blanking, nor upstream's MANAGE_EMAIL_SEND_OPS set -- is modified. Resolution unchanged; blob bumped. ADOPTION QUESTION, deliberately not folded in here: the thread-membership deny is a new outbound-email control and looks desirable, but it fetches thread participants at hook time (a network read on the send path), so it deserves its own card and gate rather than arriving as a conflict resolution. *** ANSWERED AND ADOPTED (card e3f0e4ed, 2026-09-12), so this paragraph is history, not a pending question -- do not re-open it as an unadopted upstream difference. It landed WHOLE, which was the point of the separate card: the six hook-side functions, the scaffold capability plumbing (EMAIL_THREAD_REPLY_CAPABILITY/_FLAG, hasThreadReplyCapability, injectEmailSendGate's second parameter) AND the repair pass's expectation, together -- half of it would have made the repair sweep rewrite the hook command on every pass, for ever. The network-read concern is answered by ordering rather than by removing it: both requests carry AbortSignal.timeout(3500) against this hook's registered `timeout: 10`, so the deadline is hit INSIDE the script, where it becomes a deny; letting the hook itself time out would be a non-blocking error, i.e. fail-OPEN on the send path. MEASURED SIDE EFFECT, SINCE FIXED -- kept because the reasoning is the useful part: the capability tag WAS spelled with a colon ('email:thread-reply') while CAPABILITY_TAG_RE is /^[a-z0-9][a-z0-9-]{0,31}$/ in BOTH trees, so sanitizeCapabilityTag DROPPED it. That sanitiser sits only on the FLEET ROSTER render, not on the grant path (hasThreadReplyCapability reads readAgentCapabilities raw), so the gate worked and only the roster line was affected: peers could not see that an agent holds it. Widening the regex was NOT the fix -- the DROP-instead-of-normalise rule there is a deliberate prompt-injection defence. Card bf2bf691 renamed the VALUE to 'email-thread-reply' instead, while the cost was still zero (measured: no agent held it). If this file is ever reconciled against upstream's spelling again, the fork's hyphenated value is the decided one and upstream's colon form must NOT be taken back." +
    " Round 17 (2026-09-25, backend3, card b5b7eb6b child 09d54e88): re-measured, ESCALATED, NOT resolved solo -- consistent with rounds 12-15's own standard for this file (a security-POSTURE-adjacent change to the accent/homoglyph masking apparatus belongs on a dedicated card with a Cybersec gate, not a landing-unblock or drift re-decision). Found: GATENEVSTRIP921 (external report 2026-09-21, upstream re-measure 2026-09-22) splits the TECHNICAL mask into _TECH_COMMON (safe for both the name-check and the accent/token-check) and _TECH_SUFFIXED (accent/token-check ONLY, never the name-check) -- upstream's stated reason is that the name-check running on raw, unmasked text let a name embedded in a URL/code-span/path stop a whole message, and the naive fix (run the name-check after the SAME masking the accent-check uses) opens a hole because two of the suffix patterns (proper-name+suffix forms like 'Nev-val'/'Nev-nak') would delete the name itself along with its suffix before the name-check ever saw it. THE UNVERIFIED QUESTION, and why this is escalated rather than decided: _TECH_SUFFIXED still feeds TECHNICAL (the accent-check mask), and Round 16's own two Cybersec NO-GOs (fbb36b41 rounds 7/8 and 11) rejected upstream's PRIOR proposal for exactly this shape -- an unconditional suffix mask hiding content from the accent/homoglyph check. Whether GATENEVSTRIP921's split reintroduces that same class of hole for the accent-check path, or genuinely avoids it because the fork's own separate HYPHEN_WORD/DIGIT_HYPHEN_SUFFIX_ALLOWLIST/IDENTIFIER_ALLOWLIST layer already covers what _TECH_SUFFIXED would otherwise need to, requires tracing the full control flow (which functions actually consume TECHNICAL vs NAME_MASK vs the allowlists) -- not done here, deliberately, rather than guessed on a file with two prior live-reproduced bypasses (rounds 10-11) on this exact class of change. The remaining 7 conflict hunks in this round (of 8 total) were NOT individually reviewed either, for the same reason: hunks 1-2 alone already establish this file needs a dedicated Cybersec-reviewed pass this round, and reviewing the rest under a solo-backend read would not change that conclusion. NOT adopted, pin NOT bumped (the file should keep reporting as needing attention until a dedicated card actually resolves it). Resolution at all previously-decided points (rounds 1-16) unchanged.",
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
    "adopt upstream wholesale -- the new scripts/lib/send-telegram.sh shared honesty-check subsumes the fork's b43d6dfd --data-urlencode fix, and upstream's file keeps the fork's TMUX-guarded sender-attribution block unchanged" +
    " Re-measured 2026-09-06 (backend3, card 79bb0364 round-2 landing-block, upstream round 16). Upstream shipped the CHATID0 guard: `[ -z \"$CHAT_ID\" ] || [ \"$CHAT_ID\" = \"0\" ]`, plus the file becoming executable. This is the exact fix the round-15 note on src/__tests__/notify-delivery-honesty.test.ts predicted would be needed -- that entry already says the four CHATID0 test cases and this guard must be adopted TOGETHER, on their own card, because the tests go red on arrival without the guard. Both halves are now visible upstream, which strengthens that card rather than changing this rule. NOT adopted here (a landing-unblock is not where a fallback-channel behaviour change lands); blob bumped." +
    " CORRECTION 2026-09-25 (card 2f1cbaf1, backend3, ACKNOWLEDGED_FORK_ANCHORS backlog): the CHATID0 guard IS present -- `[ -z \"$CHAT_ID\" ] || [ \"$CHAT_ID\" = \"0\" ]` (verified directly in the current file). Landed by commit 3e807fe4 (Prezsi, PR #1193) on 2026-09-05 21:39, the day BEFORE this round's 2026-09-06 refusal note. Same pattern as the schedule-runner.ts and github-pr-monitor.sh corrections from this same audit: a same-day-prior upstream commit the 09-06 measurement pass missed, not a later silent reversal. This closes the exact gap the round-15 note on notify-delivery-honesty.test.ts predicted -- the four CHATID0 test cases that entry describes should now be checked against this file for real, not assumed pending. Resolution retracted for the CHATID0 guard; it is adopted, not open.",
  'scripts/lib/send-telegram.sh': 'adopt upstream wholesale (round 2 adds telegram_api_call, the method-agnostic sibling send_telegram_message now calls)',
  'scripts/disk-space-guard.sh': 'adopt upstream wholesale -- honest-send-via-lib replaces an unchecked inline curl, no fork-specific logic in this file',
  'scripts/unit-fail-notify.sh': 'adopt upstream wholesale -- honest-send-via-lib replaces an unchecked inline curl (best-effort exit-0 contract unchanged), no fork-specific logic in this file',
  'scripts/limit-monitor.sh': "keep the fork's session-limit-pattern.sh sourcing (canonical regex, card 115c21e7) + its own extra-signal regex, graft upstream's honest-send-via-lib + stamp-dedupe-hash-only-on-confirmed-success onto the alert block. Round 2 (MD5SUMHIANY826, QA fbb36b41 round-8 stale-blob catch): upstream replaced the bare `md5sum | awk` dedupe hash (empty string on macOS, silently swallowing every alert) with the shared scripts/lib/content-hash.sh dedupe_check() -- fail-open on no hashing tool, no stamp written on an empty hash. Grafted onto the same alert block, fork logic unchanged. Round 3 (2026-09-02, fron-ted, landing 5dd4a211, 61c0d229af89..8a34f0936860): upstream added a MEASURED quota path (scripts/lib/quota-check.py over .claude-rate-limits.json, warn at 90%, stale-skip) ahead of the text scan, a send_alert() wrapper over scripts/lib/send-telegram.sh, and a fleet-wide pane scan. Resolution principle unchanged -- fork logic stays; graft ONLY the honest-send wrapper (already the recorded rule). The measured-quota path is deliberately NOT grafted: the fork already alerts from its own quota monitor (store/quota-check.sh + quota-bridge), a second measured alerter would double-notify Peti. If MikroB wants the upstream measured path instead, that is a separate decision, not this ack.",
  'scripts/lib/content-hash.sh': 'adopt upstream wholesale -- brand-new shared hashing helper (MD5SUMHIANY826), no fork-specific logic to preserve',
  'src/__tests__/content-hash.test.ts': "adopt upstream wholesale -- upstream's own unit test for the new content-hash.sh, no fork-specific logic to preserve",
  'scripts/host-restart-watchdog.sh': "keep the fork's prior-shutdown cause classifier wholesale (classify_shutdown_from_log/prev_boot_log/HOST_RESTART_WATCHDOG_LIB test hook, card RELIA-A, upstream never had it), graft upstream's HOSTWD_PROC_STAT test hook + honest-send-via-lib + stamp-btime-baseline-only-on-confirmed-delivery",
  'scripts/fleet-memory-gate.sh': 'adopt upstream wholesale -- honest-send-via-lib + cooldown-stamp-only-on-success, no fork-specific logic in this file',
  'scripts/github-pr-monitor.sh': 'adopt upstream wholesale -- honest-send-via-lib + snapshot-not-persisted-on-failed-alert + an unrelated REPO-parsing regex fix (ERE has no lazy quantifier), no fork-specific logic in this file' +
    " Re-measured 2026-09-06 (backend3, card 79bb0364 round-2 landing-block, upstream round 16). Upstream closed a silent-zero in the PR list query: a FAILED `gh pr list` and a genuinely empty list both reduced to an empty PRS, after which the script said 'nothing to watch' and exited 0 -- expired auth or no network left the monitor looking healthy while it watched nothing. It now keeps the exit status, alerts the owner at most once per six hours, and exits 1. Same class as this fork's own repeated finding that an absent measurement must not be reported as a zero measurement, so the direction is one this fork already agrees with. NOT adopted this round (it adds a Telegram alert path and a stamp file, which is its own decision); blob bumped." +
    " CORRECTION 2026-09-25 (card 2f1cbaf1, backend3, ACKNOWLEDGED_FORK_ANCHORS backlog): `AUTH_ALERT_COOLDOWN=21600` (6h) and the `exit 1` on the silent-zero path ARE present, verified directly in the current file. Landed by commit 99b3b149 (Vlbbtabs, PR #1185) on 2026-09-05 18:26, the day BEFORE this round's 2026-09-06 refusal note -- the same same-day-prior-commit pattern as the schedule-runner.ts and notify.sh corrections from this same audit (all three landed 2026-09-05, all three refused 2026-09-06, likely one measurement pass that did not re-check for commits from the previous day). Resolution retracted; it is adopted, not open.",
  'scripts/set-bot-menu.sh': 'adopt upstream wholesale -- honest telegram_api_call() replaces a silent fire-and-forget curl for setMyCommands, no fork-specific logic in this file',
  'scripts/stuck-modal-guard.sh': 'adopt upstream wholesale -- honest-send-via-lib + backoff-stamp-only-on-success, no fork-specific logic in this file',
  'src/__tests__/notify-delivery-honesty.test.ts': 'adopt upstream wholesale -- trivial test-scaffolding update to stage the new scripts/lib/send-telegram.sh alongside notify.sh' +
    " Re-measured 2026-09-06 (backend3, card 79bb0364 landing-block, round 15). The recorded rule called this 'trivial test-scaffolding'; it is not any more. Upstream parameterised the chat id through stageScript/runNotify and added four CHATID0 cases: notify.sh is the FALLBACK channel, its guard was `[ -z \"$CHAT_ID\" ]`, and the installer's ALLOWED_CHAT_ID=0 placeholder is not empty -- so on an install with no chat bound both the primary path and the fallback posted to chat_id=0. Each case hands the script a curl stub that would report SUCCESS, so passing proves the send was PREVENTED rather than merely failing downstream. The fork's scripts/notify.sh carries the same `[ -z \"$CHAT_ID\" ]` guard, so the test is not adoptable on its own -- it would go red on arrival. Adopt the notify.sh guard and these cases TOGETHER, on their own card. Resolution changed from 'adopt wholesale' to that; blob bumped.",
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
    "Re-measured 2026-09-03 (backend2, card 934dc104 landing-block, f1c6939e42b1..f3bafcfaa0aa): upstream moved ONE line, `/name` -> `/rename` in the post-start identity send-keys (line ~849). The recorded conflict is at the two guard-alert POSTs; zero overlap. Resolution unchanged; blob bumped. Worth flagging for the next merge, not for this resolution: `/name` is not a real Claude Code command, so the fork is sending a line that parks in the input box -- an adoption question, not a conflict. ROUND 2026-09-11 (backend3, card 9c665470, 7ecf7064d7b6..b916c8305e1b, +65/-0): purely additive upstream growth. Zero hits on _hdr_file, guard alert, NOTIFYVAKSWEEP or Authorization in the whole diff -- none of the four points this rule decides appears in it. Resolution unchanged; blob bumped." +
    " Round 2026-09-25 (backend3, card b5b7eb6b child 09d54e88, b916c8305e1b..e67a45c5d588): UNION, not a plain blob bump -- this round's conflict is a DIFFERENT location than the four points above, the CHWATCHDOG1079 plugin-alive pgrep fallback. Both sides independently converged on the SAME underlying fix (narrowing a host-wide `ps eww -e` grep to this session's own process tree, both citing kanban c0390130) but differ in two ways that are BOTH worth keeping, not a pick-one-side choice: (1) the fork RE-FETCHES `_watchdog_claude_pid` inside the loop on every iteration -- the fork's own comment explains why: the if-block unsets it after each use, so upstream's copy (assigned once, before the loop) 'starves after one unset' on a second pass; (2) upstream ADDS `&& [ \"$_bot_hijacked\" != \"true\" ]` to the fallback condition -- verified `_bot_hijacked` is a REAL, live variable, set at two OTHER points in this same file that merge in cleanly with zero conflict (an already-adopted upstream hijack-detection feature), so gating the pgrep fallback on it is a meaningful, correct guard, not a dangling reference. Resolution: keep the fork's per-iteration re-fetch AND add upstream's `_bot_hijacked` guard to the same `if`. The four original points remain unchanged." +
    " AMENDED same round, same day (self-caught while re-verifying scripts/watchdog.sh and scripts/install-prod-tree-guard-hook.sh after a qa2 QA FAIL found the same class of gap there): a conflict-marker-only read misses PURE-ADDITIVE upstream changes that auto-merge without a marker. Diffing the full old-pin..new-upstream range for this file directly (not just the merge-simulation's conflict boundaries) surfaced two more non-conflicting upstream changes, both ADOPTED: (1) `respawn_log` on the plugin-dead-after-up path now appends an MCP-log tail (`mcp_plugin_log_tail()`) to the log line -- purely additive diagnostic detail, no behaviour change. (2) The rapid-exit FAIL_COUNT counter changed from `wc -l` on the whole channels-failures.log (counting every line, including unrelated WARN entries) to `grep -c \"rapid-exit after\"` (counting only genuine rapid-exit events) -- a real bug fix (card c5296a52): the old form let ordinary startup warnings inflate the count toward the backoff thresholds, punishing a healthy start. Neither touches the five points already decided above.",
  // Independent-additive, same class as the src/web.ts import-line conflicts: fork's {{CHAT_ID}}
  // and upstream's {{PROJECT_ROOT}} both added to the SAME sed chain in render_seed_template().
  // {{PROJECT_ROOT}} is the node seeder's alias for {{INSTALL_DIR}} -- ledger-live-drain uses that
  // form, and without it the historical-blob match never fires, so that task stays permanently
  // classified "touched" and never refreshes. Keep both. (Also required adding {{PROJECT_ROOT}} to
  // install-linux.sh/install-macos.sh's own seed-scheduled-tasks loops to satisfy the fork's own
  // seed-render-parity guard, card d041760b -- done alongside this fix, see update.sh/install-*.sh
  // diffs.)
  // DECIDED 2026-09-11 (backend3, card 9c665470). Both files arrived as UNWATCHED conflicts --
  // nobody had recorded a resolution -- so these entries come from reading both sides.
  //
  // A WARNING ABOUT THE TOOL THAT REPORTED THEM, because the next reader will meet it: the drift
  // report offered '(absent upstream -- delete/modify conflict, no blob to pin)' as the pin for
  // BOTH files. That is false -- upstream has both blobs (git rev-parse upstream/develop:<path>) --
  // and pasting it creates an entry that can never stop being stale, because the recorded string
  // can never equal a real blob. Root cause found and fixed in this same change: drift-check.ts
  // called readyToPasteEntry(f, null) with a hardcoded null for every unwatched file. The pins
  // below are the real blobs.
  'src/web/session-send-lock.ts':
    "KEEP the fork CRON-SHELL WRITERS block (card 7560bb6a); do NOT take upstream's 'Since then, brought under the lane one by one' paragraph wholesale. Both sides document the same question -- which pane writers this lock does NOT serialize -- but they answer it about DIFFERENT TREES. The fork block is measured and fork-specific, with no upstream counterpart: it inventories store/fleet-nudger.sh, store/context-compact-monitor.sh, store/quota-resume.sh and the three store/weekly-usage-*.sh scripts, each with what it actually sends. MEASURED 2026-09-11 against THIS fork, which is why upstream's paragraph is not adoptable as prose: of the writers it says are now under the lane, scheduleIdentitySetup (the identity /rename, IDENTLANE910), clearStaleParkedInput and clearFeedbackModalAndRecheck were NOT under the lock here AT THAT MOMENT -- scheduleIdentitySetup still did runTmux(send-keys) on a fire-and-forget setTimeout. RE-MEASURED 2026-09-13 (card 1d421873): all three are under the lane now. The upstream commits this note was measured against, db4e4723 (IDENTLANE910) and ad76037f (PANEWRITERS910), landed here in merge b92a5b66 on 2026-09-12, ONE DAY after this sentence was written -- so the paragraph that was correct when recorded became false about our own tree the next morning, and a security review dispatched from it went looking for a defect that was no longer there. Leaving the original wording above rather than deleting it: the dated claim is the evidence for why this entry now carries a re-measurement date, and the lesson is that a note asserting a GAP ages exactly as badly as one asserting a FIX. Installing that sentence would assert something false about our own tree, the exact failure the token-usage.ts incident records. What IS true on both sides and may be merged as prose: routes/agent-terminal.ts (operator keystrokes) and the cross-process channel-plugin delivery remain uncovered. THE GAP IS REAL AND SECURITY-RELEVANT, raised as its own card rather than fixed inside a drift re-decision: upstream measured /rename landing in the MIDDLE of a chunk-pasted prompt, so the reading agent saw an unprovenanced self-rename command inside its own instructions -- the same prompt-injection shape as the fleet-nudger incident the fork block already documents.",
  'src/__tests__/session-send-lock.test.ts':
    "KEEP the fork test (stopAgentProcessUnlocked's kill-session runs inside withSessionSendLock, card 28eb8340) -- it pins fork behaviour that exists. Do NOT adopt upstream's two tests (the identity /rename inside a send-lane acquisition, and a busy lane deferring it) AS-IS: they are source-contract tests that grep agent-process.ts for a lock acquisition around the /rename send, and this fork has no such acquisition, so they would go RED on arrival. They are the right tests for a fix this fork has not made. ADOPT THEM TOGETHER WITH THAT FIX, never before it -- taking them earlier offers a choice between a red suite and weakening the assertion, and weakening it is how a guard becomes decoration. The sides are otherwise additive: both add cases at the same point and neither edits the other's.",
  'update.sh':
    "independent-additive: keep both sed -e lines in render_seed_template() -- {{CHAT_ID}} from the fork (4 fleet-orchestration prompts) and {{PROJECT_ROOT}} from upstream (ledger-live-drain, node-seeder alias for {{INSTALL_DIR}}). SECOND hunk added 2026-09-02 (Cybersec/MikroB, card 9dc0fba8's landing-block triage): upstream fixed the ahead-vs-diverged bug in the AHEAD-detect block (d9cfd076, refuse only when AHEAD AND BEHIND, not ahead alone) -- ported that BEHIND-aware check into the fork's `else` branch of the POST_MERGE_MODE conditional, the POST_MERGE_MODE if-branch itself is untouched (that special-case already has its own reasoning for skipping the check entirely)" +
    " ROUND 2026-09-06, card 50af1a27 (3c cluster) -- the blob pin was ALREADY CURRENT and the three-way merge STILL CONFLICTS in four places, which is the distinction this whole file exists to record: a current pin means the decision was reviewed against exactly this upstream content, NOT that the merge is clean. Simulated with git merge-file on the three blobs (read-only, no worktree): 4 conflicts. Resolutions, in file order. (1) POST_MERGE_MODE structure vs upstream's plain divergence-detect: KEEP OURS -- the fork's else-branch already contains upstream's block verbatim, so ours is a strict superset. (2) The {{CHAT_ID}} substitution in render_seed_template, which upstream does not have there: KEEP OURS -- dropping it reintroduces a Cybered finding (the rendered template keeps the literal placeholder while the installed file carries the real id, so the two renderings diverge and the escalation line loses its destination). (3) The SEEDREFRESH826 comment: KEEP OURS -- same adoption, re-measured on this host (6/6 drifted). (4) The rollback's `npm ci`: UNION, and this is the only one that changed a file. Upstream adds --include=dev (AUTOUPDNODEENV905) because under NODE_ENV=production a plain ci PRUNES the compiler; the fork lacked the flag at BOTH call sites. Adopted at both, keeping the fork's rollback_guard_check wrapper (upstream has no equivalent). MEASURED on this host with a REAL install into a throwaway temp tree, npm 10.9.8 / node v22.23.2: NODE_ENV=production + plain ci PRUNES the dev dep, + --include=dev keeps it, --omit=dev prunes it (control). SCOPE, so nobody overclaims: NODE_ENV is set nowhere in this install (.env, scripts/start.sh, install-linux.sh, update.sh -- all measured empty), so this closes a LATENT hole, not a live outage. INSTRUMENT WARNING for the next reader: `npm ci --dry-run` reports the dev dep as added in BOTH directions -- it does not honour the NODE_ENV pruning it is being asked about, and a dry-run would have concluded the mechanism does not exist here. Pinned by src/__tests__/update-npm-ci-dev-deps.test.ts, both sites mutation-tested. Blob unchanged (upstream has not moved). ROUND 2026-09-11 (backend3, card 9c665470) -- NOT AN UPSTREAM MOVE, A CORRUPTED PIN, and the report could not show it. The recorded pin read ...de132f729... while upstream's blob is ...de132b729...: one character at position 21, with the first twelve identical, so the drift report's 12-char display printed 9b7c57205a47 -> 9b7c57205a47 and read as nothing changed. PROVEN, not assumed: git cat-file -e on the recorded hash fails -- it is not an object in this repository at all, so it cannot be any upstream state, past or present. It entered in 56ebe3be (card 9812ee33, a bulk re-pin of 25 blobs), which is where a transcription error would be expected. The resolution this rule records was reviewed against the real blob on 2026-09-06 (card 50af1a27) and is unchanged; only the pin string is corrected. Worth keeping: a corrupted pin makes an entry permanently stale -- every drift round re-reports it, and the truncated display invites the reader to dismiss it as a no-op." +
    " Re-decided 2026-09-25 (card c2aeefa5, backend, 9b7c57205a47..9a91cfef7d76): NOT a plain blob bump -- a large batch of genuinely new upstream additions, none touching the two points this rule decides (POST_MERGE_MODE structure stays fork-owned superset; the {{CHAT_ID}} substitution stays fork-owned -- confirmed by grep against today's upstream content: zero POST_MERGE_MODE hits, CHAT_ID still handled via a separate REGEN_CHAT_ID sed outside render_seed_template, matching the existing decision). What is new, grouped, none adopted here (each is a real behaviour/UX change to a live install, same deferral reasoning as install-linux.sh's KEEPALIVE_UNIT entry below): (1) NODEPINMAC921 -- resolve_service_node_dir now returns a <dir>-tab-<source> pair so the printed 'matches the running dashboard' claim is made only for the exe-detected case, not the .nvmrc/brew fallbacks; a correctness/honesty fix, cheap to adopt later, zero overlap with anything decided here. (2) SHALLOWGUARD921 -- the 'git checkout main' advice on a detached-HEAD/missing-branch refusal now detects a shallow clone (Docker-image install shape) and prints a working set-branches+fetch--unshallow+checkout sequence instead of a command proven to fail there; also threads MARVEEN_LANG for an EN/HU-consistent screen (UPDATEENHU921). (3) UPDATE_AUTO_REBASE -- an opt-in (env-gated, default off) auto-rebase for the ahead+behind diverged-history case; #1112's refusal stays the default, this only adds an opt-in path -- a real new capability, not a passive fix. (4) install_keepalive_probe_timer / install_main_inbox_observer_unit / park_morning_timer -- three new systemd unit-maintenance functions for EXISTING hosts. The keepalive one is the SAME adoption install-linux.sh's entry below already flagged as a follow-up candidate (this fork's own scripts/channel-keepalive-probe.sh sits unwired on disk); the inbox-observer and morning-timer-park functions are new to this round. (5) ZAKARFELUGY921 -- post-restart _unit_drift detection (enabled-but-not-active units are reported, not silently trusted just because the port answers) plus a setsid-wrapped systemd-run finalizer (a bare --scope does not detach the controlling tty, so stop.sh's tmux kill-session could kill the finalizer mid-flight) and a persistent update-finalize.log. This is a genuine reliability fix with no fork-side equivalent and no conflict surface -- the strongest single adoption candidate of the batch, but still a behavioural change to the restart/rollback path, so not taken inside a drift re-decision. All five named here as follow-up candidates rather than five fresh cards, per rule 6b dedup discipline (item 4's keepalive half already has a named target in the install-linux.sh entry). Resolution at the two decided points unchanged; blob bumped.",
  // A REAL security-regression risk unlike the two files above: THIS conflict hunk has the fork's
  // -H @"$hdr_file" 0600-temp-file call INSIDE the conflicting region (not shared context), and
  // upstream's replacement uses a bare `-H "Authorization: Bearer $(cat "$TOKEN_FILE")"` --
  // exactly the token-in-argv vulnerability (/proc/<pid>/cmdline is world-readable) the fork's own
  // comment warns about. Taking upstream wholesale here would have been a real regression.
  // Resolution: keep the fork's hdr_file call, graft upstream's GUARD_HTTP status-capture +
  // stderr-on-non-2xx logging on top (same NOTIFYVAKSWEEP826 pattern as channels.sh).
  // Card b5b7eb6b / child 09d54e88 (2026-09-25, backend3): four hooks/watchdog scripts arrived as
  // UNWATCHED conflicts -- nobody had recorded a resolution -- so these four entries come from
  // reading both sides directly (real 3-way merge in a disposable worktree, not the report's
  // truncated hunk preview).
  'scripts/install-channel-image-hook.sh':
    'KEEP the fork\'s one-time migration block (removes a leftover ~/.claude/hooks/telegram-image-resize.sh from a pre-#1305 install) -- upstream has nothing there at all (this whole file is a deprecated no-op on both sides, #1305/ISSUE1305HOOKSCOPE). Pure addition, no upstream content to reconcile against; harmless backward-compat cleanup.',
  'scripts/install-telegram-progress-hook.sh':
    "ADOPT upstream's provider-gate + retire_provider() addition in full (all four hunks: header comment, self-retire-if-inactive-provider block, reciprocal retire_provider('slack') call, final RETIRE_RC exit-code check). This fork is ALREADY multi-provider (CHANNEL_PROVIDER is used throughout src/ -- channel-provider.ts, discord-group-bootstrap.ts, slack-half-configured-onboarding.test.ts, etc.), just not yet in THIS one installer, so this is wiring an already-adopted fork capability into a script that lagged behind, not a new architecture decision. Upstream's own retire-progress-watchdog.sh (the script retire_provider() shells out to) merges in with ZERO conflict -- already a clean addition, not part of this decision. The fork has no install-slack-progress-hook.sh (this progress-watchdog feature is Telegram-only today), so the reciprocal retire is currently a no-op / idempotent safety net rather than solving a live leak -- still correct to adopt, since it costs nothing and future-proofs the day a second provider's progress-watchdog exists. Every HEAD-side hunk is empty (nothing removed), so this is a strict superset, not a replacement.",
  'scripts/__tests__/install-telegram-progress-hook.test.sh':
    "ADOPT upstream in full, paired with the implementation decision above -- not optional, since shipping the provider-gate code without its test would leave it unexercised. Verified this is a superset, not a narrower replacement: upstream's rewritten case (g) parametrises the SAME assertions (no ~/.claude write, daemon unit references the repo watchdog path, correct service-manager shim invoked) across BOTH platforms (Linux+Darwin -- the fork's original only covered one), and ADDS case (h) covering the new provider-gate retire behaviour. No fork-specific assertion is dropped.",
  'scripts/watchdog.sh':
    'CORRECTED 2026-09-25 (qa2 QA FAIL, komment 6736, on card b5b7eb6b child 09d54e88): the original version of this entry (below the strikethrough note) had two errors -- (1) it called this a plain ADOPT, which would have also REMOVED the fork\'s -H @"$HDR_FILE" 0600-temp-file security pattern (the ONLY use site of $HDR_FILE in this file) in favour of upstream\'s bare -H "Authorization: Bearer $TOKEN" -- the exact token-in-argv vulnerability (/proc/<pid>/cmdline is world-readable) the b267df80 pattern exists to close, verified live to still apply here (grep for HDR_FILE shows exactly one consumer, this call site); (2) it attributed the adjacent Hungarian bug-explanation comment ("agent, nem to...") to the fork, when `grep` against the fork\'s live file returns ZERO hits -- the comment is UPSTREAM\'s own, arriving WITH the fix it explains. CORRECT RESOLUTION: UNION, not ADOPT -- take upstream\'s agent=${AGENT_ID} query-param fix, the -w \'\\n%{http_code}\' capture and the HTTP_CODE!=200 early return (with upstream\'s own explanatory comment, correctly attributed), but KEEP the fork\'s -H @"$HDR_FILE" call instead of upstream\'s argv-embedded token. The underlying bug claim itself is independently confirmed real (KNOWN_PARAMS at this API route accepts agent/status/limit/before, not to; an unrecognised param 400s with a non-empty JSON body that curl-without-*-f* returns as if it were data) -- only the security side-effect of taking upstream\'s http call VERBATIM was missed.',
  'scripts/install-prod-tree-guard-hook.sh':
    'keep the fork\'s -H @"$hdr_file" 0600-temp-file security pattern (upstream\'s replacement would have leaked the token via curl argv), graft upstream\'s GUARD_HTTP status-capture + non-2xx stderr logging (NOTIFYVAKSWEEP826) on top' +
    " Re-measured 2026-09-15 (backend3, card 3602c2ae, 9647c9658a5e..9abea4ee17d6): NOT a plain blob bump -- two NEW security fixes, neither touching the two points this rule decides (the hdr_file pattern and the GUARD_HTTP capture, both untouched). (1) HOOK_DIR resolution bug: `git -C \"$ROOT\" rev-parse --git-common-dir` answers RELATIVE TO THE REPO, and the old code resolved that answer against the CALLER's cwd via a bare `cd` -- measured: run from another checkout, the installer silently wrote the guard into THAT repo and printed success, leaving the intended tree unguarded. (2) JSON-injection in the branch-switch alert: the old code hand-assembled the POST body with double-quoted shell interpolation of $TOPLEVEL/$BRANCH; git allows a double quote in a branch name (only space/colon/backslash/'[' are rejected) and a directory name has no such restriction, so a crafted branch or path could close the `content` field early and open a second `to` key that a JSON parser takes over the first -- attacker-written text delivered to an attacker-named agent. Fixed by building the body with python3 json.dumps over environment variables (same discipline as scripts/agent-msg.sh), exiting loudly if python3 is unavailable rather than falling back to the vulnerable shell-assembled form. Both are genuine security fixes on a hook that already runs with the committer's git privileges; NOT ported here -- raised as a dedicated HIGH-priority security follow-up card (Cybersec review before landing) rather than hand-merged inside a drift re-decision. Resolution at the two decided points unchanged; blob bumped." +
    " Re-measured 2026-09-25 (backend3, card b5b7eb6b child 09d54e88, 9abea4ee17d6..68232de630af), CORRECTED same day (qa2 QA FAIL, komment 6736): the first version of this round claimed 'both hunks land on the two already-decided points, plain blob bump' -- FALSE, caught by qa2 diffing the full old-pin..new-upstream range directly rather than trusting a merge-simulation's conflict-marker boundaries (which only show WHERE fork and upstream text collide, not everything upstream added -- a lesson this file's own history should have already taught, see the escalated outgoing-copy-gate.py entry). The two ALREADY-decided points are confirmed unchanged: (1) JSON-encoding comment wording (cosmetic, upstream's text minus the fork's retrospective citation) and (2) the hdr_file Authorization header (upstream's side still drops it; fork keeps -H @\"$hdr_file\", same reasoning as always -- dropping it would send the POST unauthenticated, or with upstream's replacement, leak the token via curl argv). BUT a THIRD, genuinely NEW, previously undiscussed change sits in the SAME diff, non-conflicting (auto-merges cleanly, which is exactly why it produced no conflict marker and was missed): upstream detects an IN-PROGRESS git operation (rebase-merge/rebase-apply dir, CHERRY_PICK_HEAD, MERGE_HEAD or BISECT_LOG in git-dir) and SKIPS the auto-revert-to-home-branch when one is found, still alerting but not fighting the operation. Upstream's own comment cites a real, documented incident (msg 3042-3045: four rebase attempts, each failing 'index contains uncommitted changes' against a provably clean index, because THIS GUARD was yanking the tree back to the home branch mid-rebase -- a rebase's first step checks out to detached HEAD, which matches none of the develop/main/master cases, so an in-progress multi-step git operation looked exactly like an unnoticed switch). ADOPTED: purely additive, does not touch either of the two decided points, fixes a real and reproduced reliability bug in a guard that already runs with the committer's git privileges. Resolution: keep the two decided points AND adopt the rebase/cherry-pick/merge/bisect detection. Blob bumped.",
  // Card 9dc0fba8, Cybersec measured + MikroB decided 2026-09-02: upstream rewrote its silent
  // Ollama-install step (OLLAMA_URL precedence, probe, embedding-pull, PR merged as c23fde9a). The
  // fork does NOT have that step -- Peti's directive (2026-08-13, EPIC ebc7b4dd, see the header of
  // store/first-run-llm.sh) intentionally removed the silent pre-install: the runtime is now
  // offered-never-silent, the embedding model is a separate automatic dependency, and the coding
  // model comes from an explicit user-picked catalogue. Upstream's rewrite improves a step that no
  // longer exists on this side, so there is nothing to graft. Resolution: keep the fork version
  // wholesale.
  'install-linux.sh':
    "GRAFT, not wholesale (updated 2026-09-02, card 9dc0fba8, MikroB approval): the Ollama half is unchanged -- upstream's OLLAMA_URL precedence/probe/embedding-pull rewrite still targets the silent auto-install step Peti's 2026-08-13 directive (EPIC ebc7b4dd) removed, so there is still nothing to graft THERE. But upstream then changed a DIFFERENT part of the same file, and that part applies here: the Telegram-pairing liveness check now asks three ways (user unit / system unit / channels.pid + kill -0) instead of `systemctl --user is-active` alone, because the installer's own no-systemd branch starts the bridge with nohup and the old check then called it 'not started', skipped pairing and left ALLOWED_CHAT_ID=0. Upstream's own comment names our platform: \"WSL is a documented supported platform and has no systemd user session by default, so this is not an exotic shape.\" This fork runs on WSL and has that same nohup fallback, so the fix is adopted (_bridge_is_up + the more precise failure message) while the fork's Ollama removal stays" +
    " Re-measured 2026-09-15 (backend3, card 3602c2ae, fb05a0f72820..066bb24bf8bc): NOT a plain blob bump -- upstream added a new KEEPALIVE_UNIT (channel-keepalive-probe.sh) systemd .service/.timer pair and stopped auto-enabling MORN_UNIT.timer (the morning briefing already ships via the seeded reggeli-napindito scheduled task, so the timer would double-send). Neither point touches the two this rule decides (Ollama removal stays gone; Telegram-pairing liveness stays adopted) -- zero hits on OLLAMA_URL, _bridge_is_up or the three-way liveness check. GENUINELY NEW AND WORTH ADOPTING, NOT decided here: this fork's own scripts/channel-keepalive-probe.sh ALREADY EXISTS on disk (present, unwired, dated 2026-09-12) but nothing installs its systemd units -- matches upstream's own measured failure mode verbatim (13 service restarts one night, ~50min apart, because the dashboard's 45-minute liveness ceiling aged out on a quiet channel and channel-monitor 'recovered' a healthy session). Adopting the KEEPALIVE_UNIT wiring is a real behaviour change to what a re-run of install-linux.sh enables on a live host, so it is not taken here -- raised as its own follow-up card rather than folded into a drift re-decision. Resolution at the two decided points unchanged; blob bumped." +
    " Re-decided 2026-09-25 (card c2aeefa5, backend, fb05a0f72820..066bb24bf8bc -> 66db4ab4d010, i.e. the ALREADY-corrected pin above to today's upstream): three more changes, none touching the two decided points (verified: zero hits on OLLAMA_URL, _bridge_is_up, the three-way liveness check). (1) INBOX_OBSERVER_UNIT -- the fresh-install systemd wiring for scripts/main-inbox-observer.sh. This is the SAME feature update.sh's entry above already named as a follow-up candidate for EXISTING hosts (install_main_inbox_observer_unit); this is its counterpart for a NEW install. Not adopted here for the same reason -- named together with the update.sh item rather than opening a second card for one feature. (2) CLIRUNSVERZIO923 -- _claude_runs rewritten from a bare `claude --version` probe to an auth-free `-p 'ping'` real-prompt probe (measured on an AVX-less pilot VPS: a 2.1.200+ Bun ELF answers --version with exit 0 and then hangs on a real prompt, so the old probe would pass a host that cannot actually run an agent turn), plus a new _shelve_broken_claude that moves a PATH-shadowing non-launching claude binary aside so the pinned Node fallback is not shadowed by it. This fork's own _claude_runs (line 520, checked directly) is still the OLD `--version`-only probe -- a real, unfixed correctness gap on this fork if it is ever re-run on an AVX-less host, but a substantial rewrite (new helper function, new shelving behaviour) rather than a passive line-swap, so not taken here; named as a follow-up alongside the two items above. (3) Two `Environment=TELEGRAM_ENV=$HOME/.claude/channels/telegram/.env` lines dropped from the host-watchdog.service and unit-fail-notify@.service unit templates -- this fork's own copies of both (checked directly, lines ~2015/2036) still carry the line, and nothing in this file alone says whether the corresponding scripts (host-restart-watchdog.sh, unit-fail-notify.sh) stopped reading TELEGRAM_ENV upstream or whether the line became dead weight for another reason; not investigated further here (out of this round's 8-file scope) and not adopted -- worth a look whenever the KEEPALIVE_UNIT/INBOX_OBSERVER_UNIT follow-up is picked up, since it touches the same systemd-template region. Resolution at the two decided points unchanged; blob bumped.",
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
    "both sides added the SAME GET /api/messages/:id handler (identical code, comments differ) -- keep either side's code and the FORK's comment, which records the ab4c85f2 incident that made the endpoint necessary; the fork's other additions in this file (reserved-sender guard, JSON-parse hardening, to-validation, card-state stamping) live in separate regions and are not part of this decision" +
    " CORRECTION 2026-09-06 (backend3, upstream round 18, landing-block; 98710db9e171..5f84469418f8). THE SENTENCE ABOVE IS NO LONGER TRUE FOR THE JSON-PARSE HARDENING, and that is the whole finding -- read this before resolving. There are now TWO conflict hunks in this file, not one. Hunk 1 is the GET-handler comment the rule above decides, unchanged: code identical on both sides, keep the FORK's comment. Hunk 2 IS NEW and sits exactly where the rule said nothing could: upstream added a `notify?: boolean` field to PUT /api/messages/:id (it lets a closer suppress the reverse [Eredmeny] ack, with a measured reason about ack traffic lengthening the very queue whose delay made a report late) and its validation landed INSIDE the fork's try/catch region. RESOLUTION FOR HUNK 2 -- KEEP BOTH, and the order matters: the fork's `try { ... } catch { json(res, {error:'Invalid JSON body'}, 400); return true }` stays, and upstream's notify type-check nests INSIDE it. DO NOT take upstream's side wholesale here: measured on 5f84469418f8, upstream's version is a BARE `JSON.parse(body.toString())` with no try/catch at all, so adopting it verbatim deletes the fork's hardening and turns a malformed request body from a 400 into an unhandled throw in a request handler. Upstream's notify check is itself worth adopting and is written fail-closed (it rejects a non-boolean BEFORE the status write rather than coercing, so a truthy `\"false\"` string cannot send the very ack the caller asked to skip) -- the point is that it must be nested, not swapped in. Nothing in hunk 1 changed; the reserved-sender guard, to-validation and card-state stamping remain outside both hunks and are still not part of this decision. AND YOU WILL NOT BE RELYING ON THIS NOTE ALONE (Cybersec, verified independently and re-measured here before adopting it): the fork's hardening has a BEHAVIOURAL pin, not just prose. src/__tests__/messages-invalid-json-400.test.ts covers both handlers; on origin/develop it is 6/6 green, and replacing the PUT try/catch with upstream's bare parse -- exactly what 'take upstream wholesale' does to hunk 2 -- turns 2 of them red, with an inserted-comment control staying green. So a merger who ignores this paragraph runs into failing tests rather than a silent capability loss. That is the state Cybered's doctrine asks for (prose AND a red test, never prose alone), and it is why the refuted sentence above is LABELLED rather than deleted: the next merger will go looking for the sentence they followed last time.",
  'src/web/channel-monitor.ts':
    "both sides made the SAME change to triggerMarveenMemorySave (bare sendPromptToSession -> sendSystemDirective(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, prompt)), so take either for that hunk -- they are semantically equal. Everything ELSE in this file is long-standing fork divergence unrelated to this card: resolve those on their own merits, they are not part of the ab4c85f2 decision. CORRECTION 2026-09-04 (card 272361eb, B-wave): this entry used to say 'lazy bin resolver vs upstream's eager resolveFromPath consts' and had the two sides BACKWARDS -- upstream was the lazy one, WE had the eager module-level consts, which throw at IMPORT time and take every importer of this module down on a PATH gap. That half is no longer a divergence at all: the fork adopted upstream's tmuxBin()/claudeBin() shape, matching platform.ts's own documented rule and agent-process.ts's existing use. What REMAINS undecided here is upstream's STUCKINPUT827 injected-prompt-registry work and its subagent-overdue alert (shouldAlertStuckSubAgent, SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS), neither of which this fork has." +
    " Re-measured 2026-09-05 (MikroB, card efaf8926 landing-block, d1c642f669ff..84c4a56ef94e): upstream's performStuckInputAction now reads clearInputBuffer()'s new boolean return (see agent-process.ts entry, same date) at both call sites (clear-preamble, clear-scheduled) and logs a warning naming the leftover-fragment risk when the clear fails -- this is the caller-side half of the SAME clearInputBuffer robustness fix, not a new independent divergence. PORTED 2026-09-05 (backend3, card b34fa678, commit 8a898970) together with the agent-process.ts half -- they had to land in one commit, since porting one file without the other would not type-check. The fork adapted the same two no-re-inject call sites upstream did (clear-preamble, clear-scheduled), each logging the leftover case; the three re-inject sites keep ignoring the boolean, as upstream's own do. Everything else this rule decided (STUCKINPUT827, the tmuxBin/claudeBin adoption) is untouched. Resolution unchanged; blob bumped." +
    " ROUND 2 THE SAME DAY (2026-09-05, backend2, card efaf8926, 84c4a56ef94e..ab96c868f316). That there IS a round two is itself the finding: this one file moved three times inside a single re-pin round -- d1c642f669ff when the card was written, 84c4a56ef94e when the paragraph above was measured, 754c4f801891 forty minutes later, ab96c868f316 four minutes after that. The pin went stale before the commit carrying it could land. Everything the paragraph above records is still present; the increment is +10/-1 and it is not a passive divergence. PERMDENY905: upstream inserted a detectsPermissionDialog() branch between the model-consent branch and the menu-Escape branch, because a tool-permission prompt footer ALSO reads 'Esc to cancel', so detectsBlockingMenu matches it -- and Escape on that dialog is NO, not a dismiss. THE TRIGGER IS PRESENT ON THE FORK SIDE, checked here rather than taken from upstream's note: MENU_ESC_RX matches the phrase 'esc to cancel' case-insensitively in the footer region, grep finds no detectsPermissionDialog anywhere in this tree, and channel-monitor's menu-recovery branch sends Escape with no permission check ahead of it. Two smaller items ride along: sendRoutineAlert() (new module web/routine-alert.js, absent here) replaces sendAlert on five routine paths, and several Hungarian operator alerts gained their accents, which is what CLAUDE.md's spelling rule asks for. NOT PORTED HERE, deliberately: who may answer a permission prompt on the operator's behalf is an ADOPTION decision for a card with a gate, not a rider on a landing-unblock. Card dbba0424 (HIGH) carries it, and its FIRST step is to reproduce the match against a real captured pane from THIS install -- the reasoning above says the trigger is present, which is not the same as having watched it fire. Resolution unchanged; blob bumped." +
    " Re-measured 2026-09-06 (backend3, card 79bb0364 round-2 landing-block, upstream round 16). Upstream added DANICTXHUROK906: markAgentRestartPending() and isWithinRestartGrace(), and reconcileDesiredAgents now calls the predicate instead of inlining it. The measured bug is real and specific -- the context guard's own stop was INVISIBLE to the reconcile loop, so in the ~1s window between its stop and its fresh start the loop re-launched the agent with no opts (fresh=false, i.e. --continue), the guard's fresh start then no-op'd as 'already running', and the saturated context it existed to drop was resumed (one agent back to 94% in 25 minutes on zero inbound). It touches neither the triggerMarveenMemorySave hunk this rule decides nor the STUCKINPUT827 work named as still undecided. NOT adopted this round -- it is half of a two-file change whose other half is context-guard-runner.ts, and a cross-file restart-race fix belongs on a card with a gate rather than inside a landing-unblock; it is a strong candidate and the reason is recorded here so the next round does not have to re-derive it. Resolution unchanged; blob bumped." +
    " CORRECTION 2026-09-25 (card ea86a362, backend3 retrospective B-wave audit, triggered by the agent-scaffold.ts B-wave incident -- this file was checked for the same blind spot). Three items the paragraphs above record as 'not adopted'/'undecided'/'NOT PORTED' are in fact present and correctly wired in the current tree, verified directly against the source, not from git history. (1) markAgentRestartPending()/isWithinRestartGrace() (DANICTXHUROK906, said NOT adopted above) -- present at lines 113/120, called at line 2412, pairing with context-guard-runner.ts's own call per that file's own entry. (2) detectsPermissionDialog (PERMDENY905, said 'NOT PORTED HERE, deliberately', pending card dbba0424) -- present in the import list (line 39) and called at line 1966 ahead of the menu-Escape branch, exactly the placement the finding asked for. (3) shouldAlertStuckSubAgent (STUCKINPUT827, said at the top of this entry that the fork has 'neither of which') -- present at line 1458, called at line 1469, gated by SUBAGENT_OVERDUE_ALERT_MIN_INTERVAL_MS. None of this is dangerous drift -- the code is present, correctly wired, alert-only where the finding asked for alert-only -- but a RECORD saying already-adopted work is absent is itself the hazard ea86a362 was opened to find: a future reader trusting this entry would not know to credit or re-verify it. Resolution retracted for these three items; they are DONE, not open.",
  // Card 368b77f7 (URGENT: this conflict blocked EVERY marveen landing -- marveen-land.sh refuses on
  // any non-zero fleet-test, with no baseline-delta comparison to fall back on).
  // Card 73cf0a22 (the BRIDGEHU813 adoption itself). Add/add: upstream created this file in
  // 1df099be and the fork adopted it in the same shape, so there is no merge base for it and
  // git shows every fork edit as a conflict. Both differences are structural, not drift, and
  // neither will ever go away on its own -- which is why this is a written rule rather than a
  // one-off resolution.
  'src/__tests__/bridge-pairing-i18n.test.ts':
    "KEEP THE FORK'S SIDE for exactly two things, take upstream's for everything else. (1) The " +
    "file it reads is web/app-settings-auth.js, not web/app.js -- this fork extracted the auth " +
    "panel into that slice, and this file's own web/app.js rule already says an upstream app.js " +
    "hunk is diffed against the named slice. Taking upstream's path here would make the suite " +
    "read a file that no longer contains the function; the `start > -1` assertion is what would " +
    "report it, so the failure would at least be loud. (2) The fork-only test 'the error branch " +
    "actually CALLS it'. Upstream pins the wiring with tests/browser/**, which this fork " +
    "deliberately did not adopt (the fleet gate runs vitest and never invokes playwright), so " +
    "dropping this test in a merge would silently give up the one guarantee that the translator " +
    "is reached at all -- every other assertion in the file stays green with the call site " +
    "reverted. Measured on adoption: reverting it fails this test and only this test. " +
    "EVERYTHING ELSE -- new codes, new cases, changed expectations -- take from upstream on its " +
    "merits: the coverage test RUNS the real validators, so upstream adding a pairing error " +
    "shows up here as a missing hu/en key rather than as silently absent coverage.",
  // Card ec7bdad8 (2026-09-04): the fork adopted upstream's AGENT_API_ORIGIN key, and BOTH sides
  // now declare it at the same point in the file, which is what git reports as a conflict.
  'src/config.ts':
    "TEXTUAL ONLY, and measured as such: the declaration is BYTE-IDENTICAL on both sides " +
    "(`export const AGENT_API_ORIGIN = cfg('AGENT_API_ORIGIN') ?? ''`), and a real merge produces " +
    "exactly ONE conflict region, covering the COMMENT above it and nothing else. Take either " +
    "side's const -- they are the same characters -- and keep ONE comment; the fork's is kept " +
    "because it records the measurement in the fork's own words (hairpin NAT, curl exit 7, dead " +
    "address in every generated CLAUDE.md example) and the fork's other config entries are " +
    "documented the same way. There is NO semantic decision here: if this file ever conflicts on " +
    "something other than adjacent comment prose, that is a different question and needs its own " +
    "entry rather than this one being stretched to cover it.",
  'web/lang/en.js':
    "keep BOTH key blocks -- this is a union, not a pick. MEASURED 2026-09-04 at the key level, not " +
    "the line level: 1590 keys at the merge base, the fork ADDED 516 (the outgoing-copy gate's " +
    "names.* rules UI, card 98dbbcc9, among others), upstream ADDED 27 (auth.bridge.err.*, " +
    "BRIDGEHU813 #1170), the two sets COLLIDE ON ZERO KEYS, and NEITHER SIDE REMOVED ANY. The " +
    "CORRECTION 2026-09-04 (card 73cf0a22): that 27 is 26. The upstream hunk adds 29 lines, three " +
    "of which are its comment header, and upstream's own commit message says 26. The union rule is " +
    "unaffected -- it turns on the collision count, not on the size of either side -- but the figure " +
    "is now measured rather than eyeballed. Those 26 keys are ALSO ON THE FORK SIDE as of that " +
    "card, byte-identical to upstream's, so they are common content now, not an upstream-only " +
    "addition waiting to be merged. " +
    "conflict is textual, not semantic: both appended at the same tail. Same shape and same " +
    "resolution as web/style.css. " +
    "OVERLAY EXTRACTION CONSIDERED AND DECLINED, which is what the guard's failure message asks for: " +
    "the fork owns 516 of 2106 keys (24.5%), so an overlay would be a real split, and the argument " +
    "against it is the tooling -- the i18n key-insert path would have to know which of two files a " +
    "key belongs in, and this fork has already been bitten by an insert script writing to the wrong " +
    "place. A union conflict with zero key collisions costs one merge decision; a two-file layout " +
    "costs a loader change plus a permanent correctness question on every key added. REVISIT IF the " +
    "collision count is ever non-zero -- that is the point where a union stops being mechanical. " +
    "RE-MEASURED 2026-09-04 (card 740551e6, upstream blob 702bdb07): 1618 base keys, fork +525, " +
    "upstream +46, COLLISIONS STILL ZERO -- but the premise 'NEITHER SIDE REMOVED ANY' above is NO " +
    "LONGER TRUE, and that is the part worth reading. Upstream REMOVED 8 activity.* keys because it " +
    "DELETED its Activity page and merged that content into the Team page. Of the +46, NINETEEN " +
    "arrived in this increment alone (14 of them agents.settings.ctx_guard_*) -- the rest predate the " +
    "previous pin; both figures are correct, they just answer different questions, and the +46 is the " +
    "one this union rule is about. The fork still HAS that page and still references all 8 removed " +
    "keys: ALL EIGHT are still referenced by live fork code, in web/index.html, web/app-activity.js " +
    "and web/app-i18n-nav.js. Stated as coverage rather than as a count on purpose -- a count goes " +
    "stale on any refactor, while 'every removed key is still used' is both durable and the stronger " +
    "argument. (Two earlier versions of this note carried a NUMBER and both were wrong: the first " +
    "quoted a four-key sample as if it were a total, the second said 16 because `grep` was given the " +
    "key as a PATTERN -- the dot is a wildcard, so activity.empty also matched the CSS class " +
    "activity-empty. Measured with -F the total is 10. Dotted i18n keys are exactly the case where " +
    "that bites; backend caught it, card comment 19707.) Direction unchanged, but the union is no longer symmetric: KEEP the fork's activity.* " +
    "keys explicitly. Taking upstream's deletions would leave a LIVE fork page rendering raw key " +
    "names. NOTE THE SCOPE: whether the fork should ALSO retire its Activity page is NOT a merge " +
    "question and must not be settled inside a conflict resolution -- it is a working fork feature, " +
    "so code-quality rule 5 makes it Peti's call. This entry only records that the merge does not " +
    "decide it by default." +
    " Re-measured 2026-09-06 (backend3, card 58ebcdc9 landing-block, 702bdb07..6dddbb9c): +37/-0. All new keys for the (not-adopted) blockers UI (kanban.blocker.*, kanban.modal.blockers_title, kanban.modal.blocking_title, kanban.toast.blocker_*) and the (not-adopted) idea-box scope/attachments UI (ideas.scope.*, ideas.upload.*, ideas.detail.attach.*) -- see web/app.js's entry. Zero collisions with any existing fork key, checked by name. Union rule holds; the 37 keys sit unused until/unless those features are adopted (card 6c6d471a), the same posture the ctx_guard_* keys sat in after the previous round. Resolution unchanged; blob bumped." +
    " Re-measured 2026-09-15 (backend3, card 3602c2ae, 2515b8f5fe9d..264f299002df): +10 keys (overview.quota.*), 0 collisions with any existing fork key, checked by name -- pairs with web/app.js's renderQuotaStrip entry above (the near-zero-risk quota-strip candidate). Union rule holds; the keys sit unused until the strip is wired in. Resolution unchanged; blob bumped." +
    " Re-decided 2026-09-25 (card 2564e877, backend, HIGH, ENROLL813 port, 264f299002df..f84bceee): +1 key, auth.bridge.err.enroll813 (upstream 86b2e461, part of the ENROLL813 fail-closed guard series -- see src/fork-upstream/acknowledged-conflicts.ts's vitest.config.ts entry). 0 collisions. ADOPTED verbatim -- this route's error codes carry a coverage contract (bridge-pairing-i18n.test.ts), and the new code without a matching key is exactly how that route's error UI falls back to English. This is a NARROW, single-commit diff for this one file, not a full re-review of everything upstream has added to it since the pin -- the next scheduled drift round should still do the full measurement. Blob bumped to the reviewed commit's target only.",
  'web/lang/hu.js':
    "same as web/lang/en.js, measured identically (1590 base, +516 fork, +27 upstream -- 26, see " +
    "the en.js entry's 2026-09-04 correction, and both sides carry those keys now, 0 collisions, " +
    "0 removals on either side). The two locale files are edited in lockstep by both sides, so a " +
    "resolution that applied to one and not the other would leave the pair out of sync -- which the " +
    "i18n parity test would then report as a fork defect rather than as half a merge. " +
    "RE-MEASURED 2026-09-04 (card 740551e6, upstream blob 5a1ba174): identical numbers to en.js " +
    "(1618 base, +525 fork, +46 upstream, 0 collisions) and the SAME 8 activity.* removals upstream " +
    "-- so the '0 removals on either side' written at the TOP of this entry is NO LONGER TRUE, and " +
    "is kept only as the record of what the earlier round measured. Keep the fork's activity.* keys " +
    "here too: dropping them in one locale and not the other is exactly the half-merge this entry " +
    "exists to prevent. MikroB's decision, 2026-09-04: hold the union for these eight keys, do NOT " +
    "take the upstream removal -- the fork's Activity page is live, and retiring it would be a " +
    "separate call under code-quality rule 5, not a merge outcome." +
    " Re-measured 2026-09-06 (backend3, card 58ebcdc9 landing-block, 5a1ba174..749a1b74): identical shape to en.js this round too (+36 keys, 0 collisions, same blockers/idea-scope/attachments key set, verified by NAME to match en.js's addition exactly -- the lockstep this entry requires holds). Resolution unchanged; blob bumped." +
    " Re-measured 2026-09-15 (backend3, card 3602c2ae, 99c96d5c92f0..a354f8b080d0): identical shape to en.js this round too (+10 keys, 0 collisions, same overview.quota.* set verified by NAME to match). Lockstep holds. Resolution unchanged; blob bumped." +
    " Re-decided 2026-09-25 (card 2564e877, backend, HIGH, ENROLL813 port, a354f8b080d0..8d0ec7dd): identical shape to en.js this round too (+1 key, auth.bridge.err.enroll813, 0 collisions, same lockstep pairing). Resolution unchanged; blob bumped to the same narrowly-reviewed commit target.",
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
  // New conflict, measured 2026-09-06 (backend3, card 79bb0364 landing-block; PRE-EXISTING -- it
  // reproduces with that card's own diff stashed, so it is not caused by it). Pure tail ADD/ADD:
  // both sides appended a new `describe` at the end of the file. Upstream's addition is 68 lines,
  // `telegram copy gate wiring` (GATECOPY828), asserting that outgoing-copy-gate.py is actually
  // BOUND to a tool -- a gate whose script passes its own unit tests is not evidence that the gate
  // runs. The fork's side is its own governance-gate coverage grown over many cards.
  //
  // WHY UPSTREAM'S BLOCK IS NOT ADOPTED, and this is a design difference rather than a rename: it
  // imports agentGetsTelegramCopyGate / injectTelegramCopyGate / TELEGRAM_COPY_GATE_MATCHER, and
  // the fork has none of the three. The fork built the SAME capability under card 74181db2 with
  // agentGetsOutgoingCopyGate / injectOutgoingCopyGate / OUTGOING_COPY_GATE_MATCHER, and the two
  // differ in the two things upstream's block actually asserts: upstream binds the gate to the
  // Telegram MCP tools (`mcp__plugin_telegram_telegram__reply` + `edit_message`) and covers every
  // sub-agent unconditionally, while the fork binds it to `Bash` behind a kill switch that
  // DEFAULTS OFF (deliberately the inverse of the `<GUARD>=off` convention -- it changes the cost
  // profile of every Bash call in the fleet, so a typo must leave us where we are). Adopting
  // upstream's block verbatim would not compile, and adopting it after renaming would assert
  // properties this fork deliberately does not have.
  //
  // The equivalent coverage is present and was checked rather than assumed:
  // src/__tests__/outgoing-copy-gate-role-wiring.test.ts holds the fork's versions of all six of
  // upstream's cases -- main-agent exemption, one entry on the matcher, idempotence on respawn,
  // other PreToolUse entries left alone -- plus the two the fork needs and upstream does not
  // (removal actually taking effect, and the boot backfill disarming).
  //
  // Resolution: UNION at the tail -- keep both sides' describes -- and do NOT pull upstream's
  // block until the fork adopts upstream's MCP-matcher design; it comes with that change, not
  // before. THE TRIGGER TO REVISIT: upstream's fifth case ("keeps the SAME script wired under a
  // different matcher") is a real property the fork's injectOutgoingCopyGate does not have -- its
  // dedupe filter drops every entry naming outgoing-copy-gate.py regardless of matcher. That is
  // harmless while the fork wires exactly one matcher, and becomes a live defect the moment a
  // second one is added. If that happens, adopt upstream's case with it.
  'src/__tests__/governance-gates.test.ts':
    "tail ADD/ADD -- UNION both sides' appended describes. Do NOT adopt upstream's `telegram copy gate wiring` block: it imports agentGetsTelegramCopyGate/injectTelegramCopyGate/TELEGRAM_COPY_GATE_MATCHER, none of which exist here, and it asserts an MCP-tool matcher plus unconditional sub-agent coverage, while the fork (card 74181db2) binds the same gate to `Bash` behind a default-OFF kill switch. The fork's equivalent coverage is in outgoing-copy-gate-role-wiring.test.ts, checked case by case. Revisit if the fork ever wires this script under a SECOND matcher: upstream's 'keeps the SAME script wired under a different matcher' case is a property injectOutgoingCopyGate does not have, and it stops being harmless at that moment.",
  // NEW CONFLICT 2026-09-09 (measured, backend, card 9812ee33). Upstream added a "gmail-v2" catalog
  // entry (a parallel test fork of ArtyMcLabin/Gmail-MCP-Server vendored at a pinned commit).
  // The fork's array ends before this entry -- this is purely an upstream addition.
  // Resolution: keep fork side (omit gmail-v2 -- not vendored/needed in this fork).
  'mcp-catalog.json':
    'keep fork side -- upstream adds a gmail-v2 parallel-test catalog entry not present or needed in this fork' +
    " Re-decided 2026-09-25 (card c2aeefa5, backend, d110e062c9df..de20a2adfdc4): DIFFERENT from the gmail-v2 point above -- this round's diff does not touch it (checked: no gmail-v2 hunk in this range) and is not about a new upstream-only entry at all, it is upstream's own supply-chain identity-verification pass over FIVE existing entries this fork already ships, adopted directly rather than deferred (a plain JSON data correction, no conflict surface, and two of the five were live, exploitable-grade defects on this fork RIGHT NOW). (1) gmail: the fork's args pointed at npm package `gmail-mcp-server` -- checked directly, still present pre-fix -- which upstream's verification found has NO repository.url, NO homepage, maintainer uhbarp-ayis (does not match ArtyMcLabin, the infoUrl's owner), last published 2025-09-29, AND carries a postinstall script (`node install.js`). The 2026-08-27 verifiedNote only proved the package EXISTED, never that it was the SAME project as the infoUrl -- exactly the class of gap rule 10 (GitHub-first due diligence) exists to catch. Corrected to `@artymclabin/gmail-mcp`, verified matching repository.url/maintainer/no-postinstall. (2) elevenlabs: the fork's `npx -y elevenlabs-mcp` pointed at an UNPUBLISHED npm name (E404 since 2026-03-08, confirmed with a positive control against other catalog packages) -- every ElevenLabs connector attempt on this fork was failing outright, and a future republish of that abandoned name would have been a silent takeover risk sitting behind an unmodified default. Corrected to the real PyPI distribution (`uvx elevenlabs-mcp`), identity confirmed from the wheel's own METADATA (author emails, license, entry point) without executing any code, authNote updated to state the new `uv` prerequisite. (3) google-drive, google-calendar, fireflies: no functional change, only verifiedNote/verifiedAt strengthened with the same identity-match methodology (repository.url vs infoUrl, maintainer, postinstall presence) -- fireflies' note additionally flags that its package is a GENERIC proxy (mcp-remote) rather than a Fireflies-published one, so the usual repository-matches-infoUrl check does not apply there by design. Applied verbatim from upstream's own verification text (already measured, no re-verification re-run here); mcp-catalog.json parses as valid JSON after the edit. Resolution: adopted, not merely acknowledged -- this entry's standing rule is now 'upstream's identity-verification corrections for existing entries are adopted on sight, gmail-v2 (a new entry, not needed) stays declined'." +
    " CORRECTED 2026-09-25 (card c2aeefa5, Cybersec NO-GO, comment 6737, Gate-SHA b550fb01): the gmail identity swap above is REVERTED, the elevenlabs pin below is ADDED -- the two points are not treated alike, because only one of them changed this fork's attack surface. Cybersec found the gmail swap brings in TWO SENDING tools (send_draft, reply_all -- v1.2.3's tarball registers 31 tools total) that none of the three email-approval matchers (outgoing-copy-gate.py, email-approval-gate.py, email-send-gate.mjs) recognise by name; the OLD package's only sending tool was gmail_send_email, which the existing matcher DID catch. So the swap, on its own, silently opened a hook-bypass path for outbound email the moment anyone installed the connector (verified live: zero agents have it installed today, so the gap is latent, not yet exploited). Reverted the gmail entry to its pre-c2aeefa5 content verbatim (command npx/gmail-mcp-server, verifiedAt 2026-08-27) -- the known-worse package IDENTITY (no repository.url, maintainer mismatch, a postinstall script) is deliberately re-accepted here, because its sending surface is the one the gate already covers; the swap is NOT lost, it moves to a dedicated card that lands the matcher/gateDecision extension in the SAME commit, per MikroB's decision (msg 4162). The elevenlabs point is UNCHANGED in kind (still adopted) but gets Cybersec's F2 fix: `uvx elevenlabs-mcp` pinned to `elevenlabs-mcp==0.12.2` -- unpinned, a future release from that maintainer (including after an account takeover) would run with the operator's ELEVENLABS_API_KEY on the next install, and the verifiedNote only ever verified 0.12.2's identity, not 'whatever is newest'. Pin unchanged (de20a2adfdc4801dab7b6b177a40825ee288868f): this correction does not re-compare against a newer upstream state, it revises the fork's OWN adoption decision against the same already-measured upstream content.",
  // NEW CONFLICT 2026-09-09 (measured, backend, card 9812ee33). Upstream adds a minimax-m3 1M-window
  // test case (contextLimitForModel). Fork side is empty here -- no minimax-m3 test because minimax-m3
  // is excluded (Peti NO-GO, card 48565f81). Resolution: keep fork side (omit upstream's test case).
  'src/__tests__/context-guard.test.ts':
    "keep fork side -- upstream's minimax-m3 1M-window test case is for the MiniMax integration (Peti NO-GO, card 48565f81), not adopted in this fork",
  // NEW CONFLICT 2026-09-09 (measured, backend, card 9812ee33). Fork adds two test cases for the
  // correlateWithKanban attribution fix (parent-untied / parent-tied, card 9005b6a0). Upstream side
  // at this point is empty. Resolution: keep fork side wholesale.
  'src/__tests__/token-usage.test.ts':
    'keep fork side wholesale -- fork adds parent-untied/parent-tied attribution test cases (card 9005b6a0); upstream side of this conflict region is empty',
  // NEW CONFLICT 2026-09-09 (measured, backend, card 9812ee33). Upstream adds
  // `if (m.startsWith('minimax-')) return 1_000_000` for MiniMax context window. Fork side has a
  // comment explaining this is NOT adopted (Peti NO-GO, card 48565f81, paired with
  // agent-process.ts resolveProviderEnv override also not adopted). Resolution: keep fork side.
  'src/context-guard.ts':
    "keep fork side -- upstream's minimax-m3 1M-window branch requires the matching resolveProviderEnv override in agent-process.ts, both excluded (Peti NO-GO, card 48565f81)",
  // NEW CONFLICT 2026-09-09 (measured, backend, card 9812ee33). Upstream adds writeGateConfig()
  // to context-restart-gate-store.ts -- the backend half of the context-guard settings UI
  // (card 740551e6, raised as adoption decision but not yet adopted). Resolution: keep fork side for
  // now (ADOPTION decision deferred to card 740551e6 -- the UI half in web/app.js's entry).
  'src/web/context-restart-gate-store.ts':
    'keep fork side -- upstream writeGateConfig() is the backend half of the context-guard settings UI (card 740551e6, raised as adoption decision not yet taken, same treatment as web/app.js entry for that feature)',
  // NEW CONFLICT 2026-09-09 (measured, backend, card 9812ee33). Two independent hunks:
  // (1) Fork adds max_chars progressive retrieval (card 0c5423fc), upstream adds offset support.
  // (2) Further down, both sides touch the response formatting area.
  // Resolution: keep BOTH -- fork max_chars AND upstream offset (additive concerns, different params).
  // The second hunk needs the same union treatment.
  'src/web/routes/memories.ts':
    'union of both sides -- fork max_chars progressive retrieval (card 0c5423fc) AND upstream offset pagination support; neither conflicts with the other in function or parameter namespace. Apply the same union at any further hunks in this file.',
  // NEW CONFLICT 2026-09-09 (measured, backend, card 9812ee33). Upstream trimmed the tools: list
  // to only WebFetch, removing the Firecrawl and Context7 tools the fork explicitly added (the
  // quarantine-reader sub-agent's tools: line includes mcp__firecrawl__* and mcp__context7__* for
  // the fleet's fetch infrastructure). Resolution: keep fork version wholesale.
  'templates/sub-agents/quarantine-reader.md':
    "keep fork version wholesale -- upstream narrowed tools: to WebFetch-only, but the fork's quarantine-reader is the fleet's isolated fetch sub-agent and must keep Firecrawl + Context7 tools it was built with ROUND 2026-09-11 (backend3, card 9c665470, 55e629c3c982..22bbd9e4e0e1, +39/-1): zero hits on the tools: line, Firecrawl or Context7 -- the single point this rule decides (keep the fork's wider tool set against upstream's WebFetch-only narrowing) is untouched. Resolution unchanged; blob bumped.",
  // NEW CONFLICT 2026-09-09 (measured, backend, card 9812ee33). Upstream adds MiniMax optgroup(s)
  // in the model selector HTML (agentModelMinimaxGroup in wizard, minimaxModelGroup in edit panel).
  // Fork side has no MiniMax optgroups -- excluded (Peti NO-GO, card 48565f81).
  // Resolution: keep fork side (omit upstream's MiniMax optgroups).
  'web/index.html':
    "keep fork side -- upstream's MiniMax optgroup additions pair with the excluded MiniMax direct-API integration (Peti NO-GO, card 48565f81); taking them would add a visible but non-functional UI element",

  // SIX NEW ENTRIES BELOW, card 3602c2ae (backend3, 2026-09-15). All were reported UNWATCHED --
  // no rule existed for any of them, not even a stale one -- surfaced by the fork-upstream-drift-watch
  // scheduled task after upstream moved substantially since the last full sweep.

  // README.md is the fork's own identity page: title, banner, badge row, and the "why a separate
  // fork" framing (MikroB CEO/CTO fleet, Kanban-driven risk-gated workflow, Mission Control
  // dashboard). Upstream's side is the SAME sections describing the base project's own generic
  // framework pitch. This is not a content conflict to reconcile line-by-line -- it is the same
  // slot each side fills with its own project's identity, same character as the
  // MIGRATED_FROM_GUARDED web/app.js branding calls elsewhere. Measured: the "Jelenlegi
  // fejlesztések" / fork-specific-developments section this repo's own top-level CLAUDE.md already
  // mandates (README maintenance rule) lives ONLY on the fork side and has no upstream counterpart
  // to merge against.
  'README.md':
    "keep the fork's own identity/branding text wholesale (title, banner, badge row, 'why a separate fork' framing) -- this is the same project-identity slot the MIGRATED_FROM_GUARDED web/app.js-family entries already decide for other files, not a line-by-line content merge. If a FUTURE upstream hunk in this region adds a genuinely new, project-agnostic section (an install/prerequisites table, a doc-index link) rather than base-project branding, port that specific addition forward -- but nothing in this round's hunk is that; it is upstream's own branding paragraph." +
    " Round 2026-09-25 (backend3, card b5b7eb6b child 61817eb9, 2ec43e13eae8..27eccf3fd286): two MORE hunks this round, both prose/doc-structure, no security stakes. (1) Dashboard/Channel section ordering: UNION -- keep the fork's dashboard-URL line, the shared '### Csatorna' heading (once, not duplicated), upstream's short intro sentence, then the fork's own five-provider paragraph (unchanged, outside this hunk). (2) Discord walkthrough: upstream's hunk rewrites the fork's terse '-> Details: docs/channels.md' pointer into a SECOND, more detailed Discord walkthrough -- but the fork ALREADY has a complete Discord walkthrough moments earlier in the same file (outside this hunk, non-conflicting), so taking upstream's version wholesale would leave TWO 'Discord (alternatív)' sections. KEEP the fork's terse pointer (avoids the duplicate); NOT decided here, worth a follow-up doc-quality pass: upstream's version names one real setup step the fork's existing section omits (Privileged Gateway Intents -> MESSAGE CONTENT INTENT), which could cause a genuinely confused Discord setup if skipped. Folding that one detail into the fork's EXISTING (non-conflicting) section is out of scope for a conflict resolution and belongs in its own small doc edit.",

  // .claude/settings.json (repo root, tracked): LINKED to the src/web/agent-scaffold.ts entry's
  // #1305 finding above, not independently decidable. Upstream's #1305 change makes the MAIN
  // agent's hooks repo-shipped in the tracked <PROJECT_ROOT>/.claude/settings.json (this exact
  // file) instead of the user-global ~/.claude/settings.json -- which is why upstream's diff here
  // adds ten-plus new hooks (staleness-guard, channel-inbox-drain, voice-reply-directive,
  // telegram_progress(.py)/_reply_clear/_clear, claude-usage, skill-usage-capture,
  // channel-image-resize, taskstate-replay, clear-replay, clear-capture, an egress-gate matcher on
  // WebFetch) and REPLACES the fork's Stop-hook `touch mikrob-alive.heartbeat` liveness marker with
  // telegram_progress_clear.py. Measured before deciding: EVERY ONE of those upstream script names
  // already exists on disk in this fork's scripts/hooks/ (all 12, checked individually), and
  // templates/settings.json.template (the actual generation source ensureAgentHooks writes from,
  // per hook-registration-completeness.test.ts's own REGISTRATION_SURFACES list) already carries 8
  // of them defensively-wrapped (`[ -f ... ] && exec ...`). So this is NOT a branding/identity
  // question like README.md -- it looks like a genuine, mostly-already-supported wiring gap in this
  // one specific file. NOT resolved here anyway: hand-editing this file now, before agent-scaffold.ts's
  // #1305 refusal gate is adopted, would fight whatever ensureAgentHooks does or does not write here
  // next, and the mikrob-alive.heartbeat -> telegram_progress_clear.py swap is a real behaviour
  // change to MikroB's own liveness signal that deserves the same review #1305 itself needs. Decide
  // both together, on the same follow-up card as the agent-scaffold.ts #1305 finding.
  '.claude/settings.json':
    "UNDECIDED, deliberately -- linked to the src/web/agent-scaffold.ts entry's #1305 finding (main-agent hooks move to be repo-shipped in this exact tracked file instead of ~/.claude/settings.json). All ten-plus new upstream hooks already exist as scripts on disk here and most are already wired defensively in templates/settings.json.template, so this is a real, mostly-supported wiring gap -- but hand-editing it before #1305's write-target change is reviewed would fight the next ensureAgentHooks write, and swapping the Stop-hook liveness marker (touch mikrob-alive.heartbeat -> telegram_progress_clear.py) is its own behaviour-change decision. Raised together with #1305 on one follow-up card, not resolved here." +
    " STATUS UPDATE (card 21597530 / c00d5429, MikroB verdikt komment 6020, 2026-09-25): #1305 IS adopted (adf2c30a, 2026-09-13 -- see the corrected agent-scaffold.ts entry above), so the 'before #1305 is reviewed' precondition no longer blocks touching this file. The specific gap that precondition was protecting against -- this tracked file missing the PreToolUse security guards every sub-agent's settings.json already carried (git-protect/secret-write/npm-protect/cd-chain/noisy-command/bash-egress/blast-radius/big-file/pentest-tool-install/symlinked-node-modules) -- was measured live by MikroB and closed on its OWN card, c00d5429 (Gate-SHA bedac5dffe9223ad21a5c975323ad6082b46e79d), not this one. This entry stays UNDECIDED for what it was never about: whether the REMAINING upstream hooks/behaviour changes this comment lists (the Stop-hook liveness-marker swap, and a full line-by-line audit of which of the ten-plus channel/telegram hooks this file already carries vs. still needs) should be adopted -- that is a separate, narrower follow-up someone should open if it still matters, not assumed done by either card above." +
    " CORRECTION (QA, 21597530 komment, 2026-09-25): 'closed on its OWN card, c00d5429 (Gate-SHA bedac5df...)' above was premature -- that Gate-SHA drew a QA FAIL (missing DECISIONS.md entry) and a Cybersec F1 MEDIUM (script-only contract, matcher unpinned), so the card was still in_progress, not closed, when this file said so. Fixed on the delta-gate round (da349fed + cbf6cfd3) and re-gated against the new landed sha -- see the card's own REVIEW comments for that sha, not this file." +
    " Re-decided 2026-09-25 (card c2aeefa5, backend, 4d5ddf273e76..7c692deff999): verified the two already-closed points first -- this fork's live .claude/settings.json (checked directly, not from history) still carries all 19 PreToolUse entries from c00d5429 (secret-write-guard, big-file-guard, and the seven governance-kapu Bash entries covering cd-chain/npm-protect/git-protect/noisy-command/bash-egress/blast-radius/pentest-tool-install/symlinked-node-modules), and the Stop block is exactly what the entry above already describes (telegram-reply-guard.py, touch mikrob-alive.heartbeat, telegram_progress_clear.py -- the heartbeat-swap decision is STILL not made, not silently resolved by either prior card). Still genuinely UNDECIDED, and this round's diff makes the undecided surface BIGGER, not smaller: upstream added a second channel provider's hook set wholesale (slack_progress.py / slack_progress_reply_clear.py / slack_progress_clear.py, mirroring every telegram_progress* hook one-for-one) plus a broadened PostToolUse reply matcher (`mcp__plugin_[^_]+_[^_]+__reply` instead of the telegram-only literal) and Discord copy-gate matchers -- all Slack/Discord-specific, and this fork is Telegram-only per its own root CLAUDE.md ('A Telegram kommunikációt a Claude Code Channels kezeli'), so NONE of the multi-channel additions are adopted here; they are out of scope for a drift re-decision the same way the Stop-hook swap always was. Separately, and NOT Slack-specific, four more additions were NOT investigated far enough to decide: a new PostToolUseFailure hook stage (tool-log-capture.py), memory-lookup-nudge.py (new UserPromptSubmit entry), memory-frontmatter-gate.py (new PreToolUse entry on Write|Edit|MultiEdit), and broadened email-related matchers (`.*[Gg]mail.*__.*`, `.*draft_email.*`) added to both outgoing-copy-gate.py and email-approval-gate.py sites -- whether this fork's disk already carries the two new script files, and whether the broadened matchers still make sense given this fork's own gmail MCP wiring, is exactly the 'full line-by-line audit' the original entry deferred, still deferred. Resolution unchanged (UNDECIDED); blob bumped to record this round's re-read.",

  // Card 4f15966e (backend, 2026-09-07) already decided this file's EXEMPT list in-code, this
  // entry just records it. Upstream's diff REPLACES all 14 of the fork's EXEMPT entries (9
  // *.selftest.py companions + 5 pre-existing-unwired hooks: activity_memory_capture.py,
  // big-file-guard.py, secret-write-guard.py, shared-memory-inject.py, plus that selftest's own
  // companion) with 2 DIFFERENT entries the fork does not need: telegram_fallback_send.py (upstream
  // says #1305 stopped its old installer from naming it) and telegram-image-resize.sh (upstream's
  // legacy predecessor to a hook this fork calls channel-image-resize.sh instead). Measured before
  // deciding, not assumed: all 4 of the fork's "pre-existing-unwired" .py files and all 9
  // selftest.py companions still exist on disk; telegram_fallback_send.py also exists here but the
  // suite is GREEN without an explicit EXEMPT entry for it (run 2026-09-15: 4/4 pass), meaning this
  // fork's registrationCorpus() already finds a reference to it through a broader scan than
  // upstream's; telegram-image-resize.sh does not exist in this fork at all (replaced by
  // channel-image-resize.sh, which already has its own registration). Resolution: keep the fork's
  // 14-entry EXEMPT list wholesale; upstream's 2 replacement entries do not apply to this tree.
  'src/__tests__/hook-registration-completeness.test.ts':
    "keep the fork's 14-entry EXEMPT list wholesale (9 *.selftest.py companions + activity_memory_capture.py/big-file-guard.py/secret-write-guard.py/shared-memory-inject.py + their own selftest, all verified still present on disk) -- upstream's 2 replacement entries (telegram_fallback_send.py, telegram-image-resize.sh) do not apply here: the suite is already green without them (the first is found through a broader corpus scan than upstream's, the second's file does not exist in this fork at all).",

  // Both decided in-code already (card ec7bdad8), this entry and the next two just record them --
  // see src/web/tmp-root-prefixes.ts's own header comment for the full three-part reasoning this
  // rule inherits. This file specifically: upstream's side makes the suite gate REFUSE to run from
  // a checkout rooted under one of the transient prefixes (measuring the running root against
  // TMP_ROOT_PREFIXES); the fork's side only WARNS about /tmp in its remedy text and does not
  // measure anything. Adopting the refusal is a real behaviour change for every agent (a scratchpad
  // is tmp-rooted) and was deliberately NOT taken -- carded separately rather than smuggled in
  // behind the tmp-root-prefixes.ts list extraction.
  'src/__tests__/setup/assert-not-live-install.ts':
    "keep the fork's warn-only remedy text; do NOT adopt upstream's isTmpRootedPath/TMP_ROOT_PREFIXES-based refusal to run from a tmp-rooted checkout -- a real behaviour change (every scratchpad is tmp-rooted) already decided against inline adoption in src/web/tmp-root-prefixes.ts's own header comment (card ec7bdad8) and carded separately rather than taken here.",

  'src/__tests__/tmp-root-prefixes.test.ts':
    "keep the fork's own test suite wholesale -- it pins the SAME shared TMP_ROOT_PREFIXES list src/web/tmp-root-prefixes.ts's entry decides (adopted from upstream), plus a fork-only third pin (scripts/boot-hook-prune.py's Python copy of the same four prefixes, which an import cannot reach) and the isUnsafeHookCommand consumer test. Upstream has no counterpart for the Python cross-language pin or the isUnsafeHookCommand consumer test, both fork-specific.",

  'src/web/tmp-root-prefixes.ts':
    "ADOPT upstream's shared TMP_ROOT_PREFIXES list wholesale (card ec7bdad8) -- the file's own header comment already documents the full reasoning: it consolidates a list that had already been copied once (isUnsafeHookCommand in agent-scaffold.ts), pins a THIRD copy an import cannot reach (scripts/boot-hook-prune.py, Python), and explicitly declines the ONE further thing upstream does with the list -- making assert-not-live-install.ts REFUSE to run from a tmp-rooted checkout (see that file's own entry above) -- because that is a real behaviour change, not a list-consolidation, and is carded separately.",

  // Card 2564e877, 2026-09-25 (backend, HIGH, ENROLL813 port). Three files new to this fork,
  // ported VERBATIM from upstream 86b2e461/e7bed5c8 with zero fork-side divergence -- there is no
  // conflict to resolve, only a decision that the fork now carries this file and will treat a
  // future upstream edit to it as an ordinary re-decision, same as any other tracked file.
  'src/ssh-dir.ts':
    "ADOPTED VERBATIM from upstream (the ENROLL813 single-source-of-truth resolver: sshDirOverride, realSshDir, resolveSshDir with the fail-closed throw under isTestRun(), SshDirGuardError/isSshDirGuardError). Depends only on src/test-run-marker.ts's isTestRun(), which the fork already carried byte-identical to upstream (diffed directly, zero delta) -- so the port required no adaptation. If upstream changes this file again, re-diff and re-decide normally; nothing here is fork-specific.",
  'src/__tests__/setup/default-ssh-dir-seam.ts':
    "ADOPTED VERBATIM from upstream (the setupFiles seam: per-worker scratch MARVEEN_SSH_DIR default, bounded/reused directory keyed on VITEST_POOL_ID, cleared on entry not exit). Wired into vitest.config.ts's setupFiles list alongside the fork's own assert-not-live-install / assert-supported-node / isolate-local-llm-state gates (see that file's entry). The header's own SSHSEAMKOMMENT916 correction (e7bed5c8) is included: the seam gives reach, not sufficiency -- the afterEach restore fix and the fail-closed guards in src/ssh-dir.ts / src/remote-enroll-fs.ts are what actually close the hole.",
  'src/__tests__/enroll-seam-fail-closed.test.ts':
    "ADOPTED VERBATIM from upstream: the ENROLL813 regression suite (test-mode refusal for all three remote-enroll-fs.ts writers, resolveSshDir's throw/override behaviour, and a PRODUCTION branch that strips VITEST/NODE_ENV and drives the real writers end-to-end against a HOME-redirected scratch path to prove the guards stay INERT outside a test run). No fork-specific adaptation needed -- the imports (remote-enroll-fs.js exports, ssh-dir.js exports, test-run-marker.js's isTestRun, remote-enroll-core.js's restrictOptions/COMMENT_PREFIX) all matched the fork's existing exports byte-for-byte, verified before porting.",
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

export const ACKNOWLEDGED_UPSTREAM_BLOBS: Readonly<Record<keyof typeof ACKNOWLEDGED_CONFLICTS, string>> = {
  'src/web/routes/agent-terminal.ts': 'cf57ba1065272a7bde9723865d5709faaf05ed21',
  // Card 4f15966e: pinned at the upstream blob whose detectsPermissionDialog this resolution
  // compares against. If upstream edits this file again, the rule above is re-read before the merge
  // rather than assumed to still describe what is there.
  'src/pane-state.ts': 'b59475899e2fa352e9cfb4dbda2c847205bccd3d',
  'src/__tests__/governance-gates.test.ts': 'cbebd61b28a48a8ced6935329aa9d7c36e2f13fe',
  'src/kanban-dispatch.ts': '7fffc38f78b99573fb88fd797ac67b3593ffb872',
  'src/__tests__/kanban-dispatch-rearm.test.ts': 'd9a186a0af48c44c14299c284dbe0caf45d8feaa',
  'src/auto-restart.ts': 'a1f2d75ed063a78eb5be23acb2c4138ca14fff19',
  'src/web/hook-registration-guard.ts': '9b3bae69bfd4dcf098b3c5726ed303717df8079a',
  'src/model-fallback.ts': '93ea8f17a6c9608003f047c1c9b5f8defe0f1da8',
  'src/__tests__/model-fallback.test.ts': '09bc3bf772d195be0980f4bec929eed4ecfadc67',
  'src/web/update-checker.ts': 'b4dffa346e8f60bec6466b6c9b0ca9b48202971b',
  'src/__tests__/update-checker-branch.test.ts': '517c85905023c900f85dc33d6027ee427d339279',
  'src/web/context-restart-gate-runner.ts': '83b90ef1572908bb8b325f435aea8aa6534bacb9',
  'src/web.ts': '03bd955d395bc9df84a83a2e9262fa6fac123b77',
  'src/web/keychain.ts': '1e1730ee0d8f6b1d4b51c5c254f3fab56acfa376',
  'src/web/agent-scaffold.ts': 'c5dd9bc6042d35e8ea2b55bfb3b31d8fcc137f3b',
  'src/db.ts': '13a467614857e02891b63e37fbb65e4c7b7dc71a',
  'src/web/routes/agents.ts': '44349c36dc6b84be298c507b85c3172951954415',
  // ROUND 17 BLOB BUMPS, 2026-09-06 (card 26ab08a2's landing-block; upstream tip 14028011). Seven
  // pins went stale at once -- the fifth drift in one day. Three of them carry their reasoning in
  // the RULE above, because the increment lands on or beside the hunk the rule decides:
  // context-restart-gate-runner.ts, agent-scaffold.ts and routes/updates.ts.
  //
  // The four below are the ordinary kind: upstream moved, ENTIRELY outside the recorded conflict,
  // each read against its own rule rather than waved through as a set.
  //
  //   db.ts (cf4c1052 -> c554b375, +27): the other half of #1202 -- a new
  //     openInboundQuestionMessageId() beside hasOpenInboundQuestion(), returning WHICH message is
  //     open so a caller can ask whether the agent has been shown it, and '' (not null) when the
  //     row carries no id, so "unknown" reads as "not seen". This rule decides a COMMENT-ONLY
  //     collision at moveKanbanCard(); zero overlap. Pairs with the runner entry above:
  //     adopt-together-or-neither.
  //   channel-monitor.ts (8e6eeb28 -> 8195748c, +79/-0, purely additive): #1194's recovery brief
  //     after a watchdog restart -- a fresh session comes back with the plugin reloaded and the
  //     conversation gone, so the agent sits at an empty prompt while its uncommitted branch and
  //     in_progress card wait. It imports restart-recovery-brief.js, a module that does NOT exist
  //     in this fork (measured), so adopting it would be a two-file port, not a merge. This rule
  //     decides triggerMarveenMemorySave; zero overlap.
  //   scripts/channels.sh (f3bafcfa -> 287de06e, +33/-5): #1206 names every resolve_main_model
  //     failure to store/channels-failures.log instead of returning a silent empty, and searches
  //     node's standard install paths under a thin launchd PATH. This rule decides the two
  //     guard-alert POSTs and the -H @"$_hdr_file" 0600-temp-file pattern; zero overlap.
  //   scripts/hooks/outgoing-copy-gate.py (6a6224cd -> d97e9683, +53/-16): #1195/#1200 add a
  //     _gate_log() that TIMESTAMPS every line and route the existing writes through it. Their own
  //     note is worth reading rather than summarising away: 8005 log lines, four distinct messages,
  //     one of them recording a FAIL-OPEN pass-through on the Telegram branch, with no way to place
  //     it in time. One of the rewritten call sites is the load_bad_name() sentinel line this rule
  //     protects -- the SENTINEL LOGIC is untouched, only how its message reaches the log. Round 14
  //     already recorded that this fork's zero-pattern rules file passes silently under the fork's
  //     sentinel path while upstream's merged policy makes the same state loud; that argument is
  //     unchanged and still belongs on a gated card, not here.
  'src/web/routes/updates.ts': '7755cd0e260fe60fc274d1475afd31f9e4503419',
  'src/web/routes/kanban.ts': '83ab8067d408a9f33ed8878446a91bfd1a65d25c',
  'scripts/hooks/egress-gate.mjs': '5a74712f1484d6a80fbdf7c4e19b47ae2fae6433',
  'src/__tests__/egress-gate.test.ts': 'c24ca54ffc49de70d602790fa1d6b80e3aea4156',
  'src/web/context-guard-runner.ts': '55de54e0f360995dfc05ed5c7720a76953b1cb61',
  // BLOB BUMP 2026-09-04 (card 368b77f7, the URGENT landing block) for web/app.js, package.json and
  // vitest.config.ts. Upstream moved 5c9a9252 -> 1df099be, and all three pins went stale for ONE
  // commit: BRIDGEHU813 (#1170), "the pairing errors speak the install's language". The recorded
  // RESOLUTION RULES ARE UNCHANGED -- only the upstream side moved, and it moved for a feature this
  // fork has not adopted:
  //   package.json      + a `browser-verify` npm script
  //   vitest.config.ts  + tests/browser/** added to the exclude list
  //   web/app.js        + bridgeEnrollErrorText(), translating pairing errors on the server's stable
  //                       `code` instead of its English sentence
  //   web/lang/*.js     + the auth.bridge.err.* keys those two consume (see their entries above)
  //
  // Diffed against the named slice, as web/app.js's own rule requires: this fork HAS bridge pairing
  // (bridgeEnrollFromUi lives in the extracted web/app-settings-auth.js) but NOT the code-based error
  // translation, and it has neither playwright.browser.config.ts nor tests/browser/**. So BRIDGEHU813
  // is a real, applicable adoption decision -- and it is taken on its own card, NOT folded into this
  // pin refresh. A feature adoption hidden inside a blob bump is exactly what this map exists to stop.
  //
  // ADOPTED 2026-09-04 on that separate card (73cf0a22), so the paragraph above is the record of what
  // was true at the pin refresh, not a description of today. Taken: the server-side stable `code`
  // (src/remote-enroll-core.ts, src/web/bridge-enroll.ts, src/web/routes/security.ts -- all three
  // were byte-identical to upstream's parent, so they now equal upstream's post-image exactly and
  // conflict on nothing), the 26 auth.bridge.err.* keys in both locales, and bridgeEnrollErrorText()
  // into web/app-settings-auth.js, which is the slice this file's own app.js rule names.
  //
  // NOT taken, and this is the deliberate half: playwright.browser.config.ts, tests/browser/**, the
  // `browser-verify` script, and the vitest.config.ts exclusion that exists only to serve them. The
  // fleet gate (store/fleet-test.sh) runs vitest and never invokes playwright, so an adopted browser
  // suite would be a suite nobody runs -- and an unrun suite reads as coverage while guarding
  // nothing. The guarantee it carries upstream (that the error branch actually CALLS the translator)
  // was NOT dropped with it: it is asserted directly in the adopted unit test, and that assertion
  // was measured to fail when the call site is reverted. Revisit if the fleet gate grows a
  // playwright stage.
  'web/app.js': 'f375962cebdddb697564c8716db0854f176bdc35',
  'web/style.css': '4e5fa4600e3ec074307e6953db6ff9727ad3fbf7',
  'src/web/agent-taskstate.ts': '625d03282bb75b554ce23822f67cc4e51b0706c1',
  'src/__tests__/agent-taskstate.test.ts': '82dc411aa813d66c0800e7f8007dfdcd2a42e43f',
  // 2026-09-02 (fron-ted, landing 5dd4a211): upstream moved 346fa637 -- body-only change in
  // correlateWithKanban() (skips parent cards via NOT EXISTS + comment), import hunk untouched,
  // the four-imports rule above still holds; additive, no collision with the fork's edits.
  'src/web/message-router.ts': 'f962c8be8716f124809c6de8f53cbfbdc2dac484',
  'scripts/start.sh': '67edd340c70b91662f3a057c42686c53b7ca7c1f',
  'src/web/token-usage.ts': '82ebcf785cd0d988b2f8146b6049ad078fe521c0',
  'src/__tests__/schedule-runner-autostart.test.ts': '678cbb42e4447b206598bfbb9bc271602a3f896b',
  '.gitignore': '7b32528432bd14d89baf968cb58b669d2c121ebc',
  'package.json': 'f8e8153101835187343a1eb1f289725c438cec6a',
  'package-lock.json': '873217a2ea50d23dce25511c702c010e4ca6fc5f',
  'src/web/heartbeat-agent-scaffold.ts': 'ad28ed576466d9a591209c501ced06998ec1a505',
  'src/web/schedule-runner.ts': 'e5393ace227f3ca47ba8047c990e7a2d41b19fa7',
  'vitest.config.ts': '062cdb6530f40e253657c02358ad41655dfb2e05',
  // Card 2564e877, 2026-09-25: three files new to the fork, ported verbatim.
  'src/ssh-dir.ts': '2ef3435e6eeab3030027f715c646649a372a9b53',
  'src/__tests__/setup/default-ssh-dir-seam.ts': 'e32118e5358b39fd550e68872da3134a1b217a78',
  'src/__tests__/enroll-seam-fail-closed.test.ts': 'bfdf838422e452c69f25a97372e1cd6730282893',
  'src/web/agent-process.ts': '46155ebb33fed1af56438b1e90ff5443a82c9a40',
  'src/web/auto-restart-runner.ts': '044dde0ad94f5a57ff8e611656f288b25fecdaff',
  'src/web/model-fallback-runner.ts': '681fcaefd6588fc2f6f3db880238b8288d1dcd15',
  'src/web/routes/skills.ts': '34c1e440bd5009e79546d686ec9fbc481ba0af7e',
  'src/web/routes/agents-skills.ts': '23a380b7d40b5cd70885d9205c6fb4cc1fe9dbfe',
  'scripts/email-send-gate.mjs': 'dfb13dd2fa302e31ab182421fcb369ff46cedfd2',
  'src/__tests__/hook-command-quoting.test.ts': '1048b1988e6c8554754900c62570d76d455f1057',
  'src/__tests__/installer-start-and-fallback.test.ts': '9017ce4fcfe808b73fdcd1389ebf1c9eaf374f7e',
  'scripts/hooks/outgoing-copy-gate.py': '3ba1db4381dcf52682872ab8f7b6ddbfbfd08221',
  'scripts/notify.sh': '0b349a43558d33de521f07390ce86d60f40ce92a',
  'scripts/lib/send-telegram.sh': '293aecf24507b6d56bda99e5a4ff937e1491ab97',
  'scripts/disk-space-guard.sh': 'd3f693c01d607952a8165cc4d8106024008f22e4',
  'scripts/unit-fail-notify.sh': 'ada00f95a7b3665feac1305bb5287698b81839de',
  'scripts/limit-monitor.sh': '31a0c0dcb3ef3e1b534a9c787fc653904ea6a357',
  'scripts/lib/content-hash.sh': 'a2fc1103d635bd7602229447cb299f4540cd3d22',
  'src/__tests__/content-hash.test.ts': '57cbbd6ffa36d800c3c9b9e8649acba17b960949',
  'scripts/host-restart-watchdog.sh': '07948350e336ec02d58d952df016ab6b07d7d052',
  'src/__tests__/notify-delivery-honesty.test.ts': 'fbeb2e331581d5e843d70b55ecc08ca5f5f9c04b',
  // Upstream deleted this file (delete/modify conflict against the fork's still-modified copy) --
  // there is no upstream blob to pin. This is the documented sentinel for that case (see
  // readyToPasteEntry's blobLine fallback below): if upstream's side of the pair ever changes
  // (e.g. a file with this path reappears upstream), the guard trips again and this needs a fresh
  // decision rather than silently comparing against a phantom blob.
  'src/__tests__/telegram-urlencode-guard.test.ts': ABSENT_UPSTREAM_BLOB,
  'scripts/fleet-memory-gate.sh': 'ce2e49d6460c56cc49c7637dc0073d0172d5520f',
  'scripts/github-pr-monitor.sh': 'aca5a51b633457795328412d522db3d02778e8d7',
  'scripts/set-bot-menu.sh': 'b45aca69c59f9b69748592df70d0a9ea77189206',
  'scripts/stuck-modal-guard.sh': '5bf19fc208ac41c204ae007189553efcb1d2790d',
  'src/__tests__/send-honesty-sweep.test.ts': 'afc17a2222a86a7645343f837618ebe74516dacc',
  // ROUND 19 BLOB BUMP, 2026-09-06 (backend, card 99c2eb09's own landing-block -- the 33rd
  // re-measure round on this file today, on the very card that removes this check from the landing
  // gate; 287de06e -> d0ca55bd, +23/-6).
  //
  // The recorded conflict is at the two guard-alert POST call sites (the fork's `-H @"$_hdr_file"`
  // 0600-temp-file pattern plus upstream's HTTP-status capture). Upstream's diff does not touch
  // them: it replaces the watchdog's plugin-liveness FALLBACK, a host-wide
  // `ps eww -e | grep CLAUDE_PLUGIN_ROOT`, with a `pgrep -P <this session's pane_pid> bun` scoped
  // to the session's own process tree. Zero hits on _hdr_file, guard alert, NOTIFYVAKSWEEP or
  // Authorization in the whole diff. Resolution unchanged; blob bumped.
  //
  // AND THE THING THAT MATTERS MORE THAN THE BUMP, recorded here because this is where the next
  // merger looks: THIS FORK IS EXPOSED TO THE BUG UPSTREAM JUST FIXED. Their measurement is that on
  // a multi-agent host the host-wide grep matches ANY agent's telegram plugin process, so the
  // liveness fallback is always true and the watchdog silently stops catching a dead channel (their
  // case: 14 plugin processes, one agent's channel dead from 07:40 to 08:30 with nobody told). Our
  // scripts/channels.sh line 1079 still carries that exact host-global grep, and this host had 2
  // matching processes when I measured. NOT adopted here: a behavioural fix to the channel watchdog
  // does not belong inside a landing-unblock, and it deserves a gate of its own. This note is the
  // evidence for that card, in the same shape as the token-usage entry above.
  'scripts/channels.sh': 'e67a45c5d58882d0155ba1345b30e739ecf5664c',
  // THE EXPOSURE THE ROUND 19 NOTE ABOVE FLAGGED IS NOW CLOSED (2026-09-06, backend2, card
  // 4c34f201). That note said the fork's line 1079 still carried the host-wide
  // `ps eww -e | grep CLAUDE_PLUGIN_ROOT` and deserved a gate of its own rather than being adopted
  // inside a landing-unblock -- this is that gate. NOT a blob merge: the fork did not pull
  // upstream's diff verbatim, it independently applies the SAME technique upstream's fix uses
  // (`pgrep -P <this session's own pane_pid> bun`, scoped to the session's own process tree),
  // matching the pattern the fork's own post-init unlock Check 1 already carried a few hundred
  // lines above the fallback (`pgrep -P "$CLAUDE_PID" bun`) -- proven and known on this fork
  // already, just unapplied on this one branch until now. Blob pin unchanged (upstream has not
  // moved since the round 19 measurement); this note records that the exposure itself, not the
  // diff, is resolved. Pinned by src/__tests__/channels-watchdog-fallback-scope.test.ts, which runs
  // the real extracted snippet against real process trees (a foreign bun child under a DIFFERENT
  // pid no longer counts as alive).
  // ROUND 16 BLOB BUMP, 2026-09-06 (card a6b5fea3): abca56b7 -> 1110d32d, one upstream commit,
  // 31d1e94f (#1189, AUTOUPDNODEENV905) -- the same commit that opened the new updates.ts
  // conflict above. This entry was masked by that one and surfaced the moment it was recorded.
  // Read the diff: three hunks, all of them --include=dev on an npm ci (the lock-strict install,
  // the finalize health-check rollback) plus a NEW npm ci in the build-failure rollback that
  // previously ran none. ZERO hits on either recorded hunk -- render_seed_template's two sed -e
  // lines and the AHEAD-vs-BEHIND detect block are untouched. Resolution unchanged, blob bumped.
  'src/web/session-send-lock.ts': 'd877b32e5a35b9da9800e6d2bbb089376e040726',
  'src/__tests__/session-send-lock.test.ts': 'e0564f101fed813785acbb161c6c019acf9fae52',
  // Card c2aeefa5 (2026-09-25, backend) re-decided update.sh and install-linux.sh this round --
  // pins here are the c2aeefa5 values, newer than the ones these two carried at 09d54e88's base.
  'update.sh': '9a91cfef7d76ee3824581029385ff2fff6a8789d',
  'install-linux.sh': '66db4ab4d010e84684cc3a5e1ad15660c654d30b',
  // scripts/install-prod-tree-guard-hook.sh: card b5b7eb6b child 09d54e88 (2026-09-25, backend3)
  // re-measured this one FORWARD of c2aeefa5's base (9abea4ee -> 68232de630af) -- their pin wins.
  'scripts/install-prod-tree-guard-hook.sh': '68232de630afff0a82b4dc25b237de06213df687',
  // Card b5b7eb6b child 09d54e88 (2026-09-25, backend3): four new resolutions above.
  'scripts/install-channel-image-hook.sh': 'b30cb769a08c93e7a34680c88974a196e37eb4fd',
  'scripts/install-telegram-progress-hook.sh': '048e24260614150979437821bb93a0895f22d284',
  'scripts/__tests__/install-telegram-progress-hook.test.sh': '18bdfe43712ca7d4cee8966e94ad7c9e39a2a316',
  'scripts/watchdog.sh': '5b207c328859fee3404dfadd6719d9048ccb588d',
  'src/__tests__/installer-ollama-nonfatal.test.ts': '7467d0dc6674099a5af6b65d4388d18ff1f99f78',
  // Card ab4c85f2, 2026-09-03 (adopting GUARDHITELES903 into a fork that had neither half).
  'src/web/system-directive.ts': '7b69015ec8f1942349f9f912bfda228fb01ee771',
  'src/__tests__/system-directive.test.ts': '08409868f5f889240baceba1c4a240ac17d2c138',
  'src/__tests__/system-directive-auth-section.test.ts': '80d65e4651601d320447bf188d53548a5ef5f8ba',
  'src/web/channel-monitor.ts': 'e3ec92b6ea7be1a21d62e785e07c3389d2e356ae',
  'src/web/routes/messages.ts': 'b0160f69bc54ebceed4389111277c2c7df495eaf',
  // Card 368b77f7, 2026-09-04.
  'src/__tests__/bridge-pairing-i18n.test.ts': '5da8970e4ff27f4d9b1fef46b179ed26e9063ea0',
  'src/config.ts': '02c6ff722fe731e1ea6c1e4180b82f379ce8e622',
  'web/lang/en.js': 'f84bceee034389346aef02ef75ce18eb2eb30427',
  'web/lang/hu.js': '8d0ec7dd2aaace180ed41c773fbde7b8449d4b51',
  // Card 272361eb, 2026-09-04 (B-wave 3/6).
  'src/web/claude-plans.ts': '548f996dbe82ae1062e94ced4acb5a670bfd2bf9',
  'src/__tests__/channel-monitor-resume-recovery.test.ts': 'e7850cae42ac213af8bcb18dfc9d8c72acae9370',
  // Card 39b32ac6, 2026-09-04 (B-wave 2/6): both sides appended a SEEDREFRESH826 block at the tail.
  'src/__tests__/seed-refresh-untouched-only.test.ts': 'db592152fd319865336fe07aa0ee184d1790a192',
  // NEW 2026-09-09 (card 9812ee33 upstream re-pin):
  'mcp-catalog.json': 'de20a2adfdc4801dab7b6b177a40825ee288868f',
  'src/__tests__/context-guard.test.ts': 'eb72d23420fda9f45deb49af3a0394c238c693d7',
  'src/__tests__/token-usage.test.ts': '387783047a9631c41b9cb4ad9c202a39ae73e8e3',
  'src/context-guard.ts': '52208a6e6bc1084d1070f02de2ce13ffc075735c',
  'src/web/context-restart-gate-store.ts': 'f00ecccbc027deb26ec68be562168e870600f48c',
  'src/web/routes/memories.ts': 'b4f97117dd221ceb153943c41cf6ef9409d00996',
  'templates/sub-agents/quarantine-reader.md': '22bbd9e4e0e134ba91b95a8cb170b546774f0884',
  'web/index.html': '014925c8cb09992ff59a4b57931f95aad3a0330f',
  // Six new pins, card 3602c2ae (backend3, 2026-09-15) -- see the matching ACKNOWLEDGED_CONFLICTS
  // entries above for the reasoning each was read against.
  'README.md': '27eccf3fd2869e59360e3a7e3230546ecd61b4c3',
  '.claude/settings.json': '7c692deff999b0c72dffa59545629f46c1b0a0c5',
  'src/__tests__/hook-registration-completeness.test.ts': '78bead60e06c5bcd935103ab4fbf7e85a19671b8',
  'src/__tests__/setup/assert-not-live-install.ts': '2e85acf6f9ee83b33159d66025b345cd0fc8ccf2',
  'src/__tests__/tmp-root-prefixes.test.ts': '88f3e11b6b3228466b996bdf55ea53c7c9982d82',
  'src/web/tmp-root-prefixes.ts': 'a0bfea934912e62783f161cb978952bb3d6a99b4',
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
  blobOf: (file: string) => string | null,
  // The guarded list is a PARAMETER (card 368b77f7) so the guarded branch stays unit-testable even
  // while the live list is empty. It went empty when web/lang/* migrated to ACKNOWLEDGED_CONFLICTS,
  // and an untested branch is exactly what would break the day someone re-populates the list.
  guardedFiles: readonly string[] = GUARDED_FILES
): { guarded: string[]; unwatched: string[]; stale: StaleAcknowledgement[] } {
  const guarded = conflicted.filter((f) => guardedFiles.includes(f))
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

// ---------------------------------------------------------------------------------------------
// FORK-SIDE ANCHORS (card a14812e8)
//
// THE GAP THIS CLOSES. ACKNOWLEDGED_UPSTREAM_BLOBS pins every rule to an UPSTREAM blob, so a rule
// goes stale when UPSTREAM moves. Nothing pinned OUR side, and the token-usage.ts entry went wrong
// for exactly that reason: it asserted "this fork had NO touchAncestorChain" long after card
// 4b03a88d added it. WE moved, upstream did not, so the pin stayed fresh the whole time the rule
// was asserting something false about our own tree -- and the re-measure tool reported 0 stale out
// of 23. A stale exemption is worse than a missing one: a missing entry gets caught at the next
// conflict, while that one would have told the next merger, with a "-- checked", to delete a filter
// that had become correct.
//
// WHY NOT A FORK-SIDE BLOB PIN, which is the obvious symmetry. Measured on this repo over 14 days:
// 404 fork-side commits across the 72 pinned files, and 67 of 72 files moved at all. A blob pin on
// our side would go stale roughly 29 times a day, almost always on an edit that never touches the
// region the rule is about. The upstream pin can afford whole-file granularity precisely because
// upstream moves rarely; our side does not have that property, and a gate that cries ~29 times a
// day is a gate that gets rubber-stamped.
//
// WHY OPTIONAL, AND WHY IT STAYS OPTIONAL. Of the 73 rules, 9 make any fork-side factual claim at
// all, and most of those are ADOPTION HISTORY ("not adopted this round") rather than a live,
// checkable statement about the tree. Forcing every entry into a predicate would mean rewriting
// prose into a formalism that does not fit it -- so an entry without an anchor behaves exactly as
// before, and only a DECLARED anchor is enforced.
//
// UNLIKE the blob check, this runs ALWAYS, not only for files that conflict in this run. The
// token-usage failure happened with no conflict in play: the rule was simply no longer true. Making
// it conditional on a conflict would reproduce the hole it exists to close.
//
// AN ANCHOR MUST NOT BE SATISFIABLE BY A COMMENT. Measured while choosing these: the natural anchor
// for the installer-ollama-nonfatal rule ("the fork has no code left for this test to exercise") is
// `ollama_pull`, which still appears once in install-linux.sh -- inside a comment explaining that
// the call was REMOVED. A fixed-string anchor there would assert the comment, not the code, and
// would go green for the wrong reason forever. That entry therefore gets NO anchor rather than a
// misleading one; the exclusion is deliberate and is the reason this map is Partial.

/** A named, checkable fact about OUR tree that an acknowledgement's rule rests on. */
export interface ForkAnchor {
  /** Searched as a FIXED string, never a regex: these come from prose and would otherwise have to
   *  be escaped by every future editor. */
  readonly needle: string
  /** Repo-relative file the needle is expected in (or absent from). One file, not a glob: an anchor
   *  that ranges over a tree answers a different question every time the tree grows. */
  readonly file: string
  readonly expect: 'present' | 'absent'
  /** Why this fact is load-bearing for the rule -- carried into the failure message, for the same
   *  reason StaleAcknowledgement carries `rule`: the reader is being asked to re-decide, not to
   *  bump a number. */
  readonly because: string
}

export const ACKNOWLEDGED_FORK_ANCHORS: Partial<Record<keyof typeof ACKNOWLEDGED_CONFLICTS, ForkAnchor>> = {
  // --- card 66ad1f95: anchors for the NOT-ADOPTED decisions ----------------------------------
  //
  // WHY THESE EXIST AT ALL. When an integration merges upstream's HISTORY (rather than cherry-picking),
  // the merge-base moves to the upstream tip, and from then on everything upstream added earlier and
  // this fork deliberately DID NOT take stops being visible to a git-based drift check -- not because
  // the two agree, but because the history now books it as merged. So a refusal recorded in prose can
  // reverse silently, and nothing fires.
  //
  // MEASURED, NOT FEARED (2026-09-12, on the four NOT-ADOPTED decisions that name a checkable symbol):
  //   openInboundQuestionMessageId  refused  -> PRESENT today, and nothing announced it. Silent.
  //   umask 002 / agentTmuxTarget   refused  -> PRESENT today, deliberately (card 4f15966e) and said
  //                                             so at the call site -- reversed, but announced.
  //   hookScriptAlreadyEffectiveInOtherScope  refused -> PRESENT today, arrived in the B-wave
  //                                             auto-merge (card ec7bdad8 corrected that record).
  //   injectTelegramCopyGate        refused  -> still ABSENT. The decision holds.
  // Three of four reversed; one of those with nobody noticing. The mechanism to catch it already
  // existed and ran on every landing -- it simply had no entry for any of them.
  //
  // A CAUTION FOR WHOEVER ADDS THE NEXT ONE: a raw count is not a measurement. TELEGRAM_COPY_GATE_MATCHER
  // reads as three occurrences tree-wide and looks adopted; all three are inside a TEST that declares
  // its OWN const of that name and states in its header that the export is not adopted. The anchor
  // below therefore names injectTelegramCopyGate and points at the production file, not at the symbol
  // that a test is free to re-declare.
  'src/web/context-restart-gate-runner.ts': {
    needle: 'openInboundQuestionMessageId',
    file: 'src/web/context-restart-gate-runner.ts',
    expect: 'present',
    because:
      "Upstream #1202 (LEDGERACK905) was refused as HALF of a two-file change, on the measured " +
      "ground that db.ts had zero occurrences of this symbol. It is adopted NOW -- db.ts declares " +
      "it, this file imports and calls it, drainSurfacedMessageId and openQuestionBlocks came with " +
      "it -- and NOTHING ANNOUNCED THAT. This anchor is the tripwire the silent arrival got past: " +
      "if the symbol ever disappears again, that is a revert of a working two-file change and needs " +
      "a decision, not a merge resolution.",
  },
  'src/web/agent-scaffold.ts': {
    needle: 'hookScriptAlreadyEffectiveInOtherScope',
    file: 'src/web/agent-scaffold.ts',
    expect: 'present',
    because:
      "ROUND 17 refused upstream #1201 because it changes which hooks get written for every fleet " +
      "agent. The B-wave merge (card 42938a74) auto-merged it in around the conflicts being " +
      "resolved, and its own upstream test came with it, so the suite stayed green and the written " +
      "refusal stood unchallenged for days (corrected on card ec7bdad8). The code is adopted and " +
      "covered; if it vanishes, someone is 'restoring' the fork behaviour on the strength of a " +
      "sentence -- which is exactly what that entry now forbids.",
  },
  'vitest.config.ts': {
    needle: 'umask 002',
    file: 'src/web/agent-process.ts',
    expect: 'present',
    because:
      "The cmd-assembly refusal (MikroB, cards bd450735 / e80c011a) rested on agentTmuxTarget having " +
      "no runAsUser consumer here. Card 4f15966e built that dependency and adopted upstream's form " +
      "DELIBERATELY, saying so at the call site -- announced, unlike the entry above. The prefix is " +
      "load-bearing on a per-user agent: without it the agent writes 0600 files the router can no " +
      "longer stamp, which is how korall lost its onboarding flag on every restart. If it is removed, " +
      "that is a live regression, not a cleanup of an old deviation.",
  },
  'src/__tests__/seed-refresh-untouched-only.test.ts': {
    needle: 'injectTelegramCopyGate',
    file: 'src/web/agent-scaffold.ts',
    expect: 'absent',
    because:
      "This is the one refusal of the four that still HOLDS, and it is anchored so it keeps holding: " +
      "the fork ships the same capability under its own names (card 74181db2) with a Bash matcher and " +
      "a kill switch that defaults OFF. Taking upstream's alongside it double-wires the same script. " +
      "Pointed at the PRODUCTION file on purpose -- TELEGRAM_COPY_GATE_MATCHER appears three times in " +
      "a test that declares its own const of that name, so anchoring on the matcher would have read " +
      "as adopted while nothing of the sort had happened.",
  },
  // card c2aeefa5, 2026-09-25: the install-linux.sh entry records THREE separate not-adopted items
  // from the same upstream re-read (INBOX_OBSERVER_UNIT wiring, the CLIRUNSVERZIO923 _claude_runs
  // rewrite, the TELEGRAM_ENV line removal), but one ACKNOWLEDGED_FORK_ANCHORS entry watches one
  // symbol per key -- INBOX_OBSERVER_UNIT chosen because it is the cleanest single checkable token
  // (a literal shell variable name, not a rewritten function whose absence/presence is fuzzier to
  // state as one needle) and because it is the one already named as a concrete follow-up target
  // (shared with update.sh's install_main_inbox_observer_unit entry). The other two items are NOT
  // separately watched by this anchor; if either is later investigated and settled, its own record
  // should say so explicitly rather than relying on this anchor to have covered it.
  'install-linux.sh': {
    needle: 'INBOX_OBSERVER_UNIT',
    file: 'install-linux.sh',
    expect: 'absent',
    because:
      "The 2026-09-25 re-read (card c2aeefa5) declined to wire the main-agent inbox-observer systemd " +
      "unit into a fresh install, matching update.sh's parallel refusal for an EXISTING host (same " +
      "feature, two install-time paths) -- a real behaviour change to what install-linux.sh enables " +
      "on a live host, deferred to its own follow-up rather than taken inside a drift re-decision. If " +
      "this symbol appears, the refusal was lifted (or the feature arrived via an unrelated merge) " +
      "and needs a decision recorded, not a silent pin bump.",
  },
  // Not a textual "NOT ADOPTED" match (the correction note above phrases it as "reverted"), but the
  // same live-security shape the anchor mechanism exists for: a future re-adoption of the identity
  // swap WITHOUT the matcher/gateDecision extension landing in the same change would silently reopen
  // the hook-bypass Cybersec found (comment 6737, card c2aeefa5, 2026-09-25) -- send_draft/reply_all
  // reaching a live Gmail install with none of the three email-approval matchers recognising them.
  'mcp-catalog.json': {
    needle: '@artymclabin/gmail-mcp',
    file: 'mcp-catalog.json',
    expect: 'absent',
    because:
      "This package identity was reverted OUT of the gmail catalog entry (back to gmail-mcp-server) " +
      "because its tool set (31 tools incl. send_draft, reply_all) is not recognised by any of the " +
      "three email-approval matchers (outgoing-copy-gate.py, email-approval-gate.py, " +
      "email-send-gate.mjs), while the old package's only sending tool (gmail_send_email) already was. " +
      "If this string reappears in mcp-catalog.json, it must land together with the matcher + " +
      "gateDecision extension MikroB scoped into a dedicated card (msg 4162) -- never as a bare " +
      "identity swap again.",
  },
  // Round 16 (card a6b5fea3). The updates.ts rule's central factual claim is about a file the
  // conflict does not touch: that upstream's script-side half of AUTOUPDNODEENV905 is still
  // ABSENT here, which is what makes 'not adopted' a live exposure rather than a shrug. If a
  // later card lands --include=dev, the rule stops being true about our own tree while the
  // upstream pin stays perfectly fresh -- exactly the token-usage.ts failure mode this map was
  // built for. Needle is the flag alone, not upstream's whole `npm ci --silent --include=dev`
  // line: an adopter is free to write the flags in the other order, and a needle that missed
  // that would go green for the wrong reason. An 'absent' anchor cannot be defeated by a
  // comment the way rule 12 warns a 'present' one can -- a comment merely NAMING the flag trips
  // it, which costs one re-read and never hides a closed exposure.
  'src/web/routes/updates.ts': {
    // RE-AIMED A THIRD TIME 2026-09-06 (card c116696f, Cybersec NO-GO on backend2's first version).
    // The first fix mutated the REAL process.env ('delete process.env.NODE_ENV'), which Cybersec
    // NO-GO'd: a child's env is an OS-level copy taken at ITS OWN spawn(), not a live view of the
    // parent's object, so a LOCAL copy protects update.sh and everything it spawns just as well --
    // and mutating the real one instead leaves OUR OWN long-running process's NODE_ENV deleted,
    // unbounded, if update.sh exits before its restart step (several early-exit paths exist), which
    // is the exact "repeated failed update, no restart" shape AUTOUPDNODEENV905 already produced
    // five times. The corrected code deletes from a LOCAL copy: 'delete env.NODE_ENV'. Needle
    // re-aimed to that literal string, expect stays 'present' -- the guarantee being watched (both
    // halves of AUTOUPDNODEENV905 stay adopted) is unchanged, only the exact text proving it is.
    needle: 'delete env.NODE_ENV',
    file: 'src/web/routes/updates.ts',
    expect: 'present',
    because:
      "Both halves of upstream's AUTOUPDNODEENV905 are adopted now: --include=dev on both npm ci " +
      "sites in update.sh (card 50af1a27) and NODE_ENV deleted from the LOCAL env copy inside " +
      "buildUpdateScriptEnv before spawnUpdateScript hands it to update.sh (card c116696f, " +
      "corrected per Cybersec NO-GO to not mutate the real process.env). If the delete is ever " +
      "removed, this fires and the exposure claim needs re-reading, not a silent revert.",
  },
  // The entry this card came from. Its rule says the two halves "must stay together: the filter is
  // only correct BECAUSE a parent now carries its child's updated_at". So the anchor is the half
  // that lives OUTSIDE the conflicting file -- removing ancestor stamping while the parent-skip
  // filter stays would silently start discarding correct attribution, and nothing else would notice.
  'src/web/token-usage.ts': {
    needle: 'touchAncestorChain',
    file: 'src/db.ts',
    expect: 'present',
    because:
      "token-usage.ts keeps upstream's parent-skip filter ONLY because db.ts stamps a parent with " +
      'its child updated_at. Drop the stamping and the filter starts discarding real attribution.',
  },
  // "the fork's file still has the inline functions verbatim (recorded resolution unchanged, still a
  // strict superset via the sentinel fix), so this round is acknowledge-only". A def line cannot be
  // satisfied by prose the way a bare identifier can.
  'scripts/hooks/outgoing-copy-gate.py': {
    needle: 'def is_send_invocation',
    file: 'scripts/hooks/outgoing-copy-gate.py',
    expect: 'present',
    because:
      'the rule is acknowledge-only on the ground that the fork keeps its inline send-detection ' +
      'functions; if they are extracted or removed, the "strict superset" claim needs re-deciding.',
  },
  // --- card 2f1cbaf1: backfilling the remaining 6 of the original 10 unanchored refusals ---------
  //
  // MEASURED 2026-09-25, same method as the four above: read the rule, find the concrete symbol it
  // rejects, grep the PRODUCTION tree on an identifier boundary. Of the original ten, FOUR were
  // reversed (kanban.ts/db.ts's blockers route, schedule-runner.ts's TASK_FIRE_TIMEOUT_MS,
  // notify.sh's CHATID0 guard, github-pr-monitor.sh's AUTH_ALERT_COOLDOWN) and channel-monitor.ts's
  // three items were already found and corrected under card ea86a362 earlier the same day -- see
  // the CORRECTION paragraphs on each entry rather than an anchor here, since a reversed refusal is
  // "now adopted", and a refusal that is already known-reversed does not need a tripwire, it needs
  // its own entry read as saying so. The three schedule-runner.ts/notify.sh/github-pr-monitor.sh
  // reversals share an exact pattern: an upstream commit landed 2026-09-05, and the refusal that
  // missed it was written the very next day, 2026-09-06 -- one measurement round that did not
  // re-check for same-day-prior commits, not four unrelated accidents.
  //
  // The remaining four HOLD, and are anchored below.
  'src/web.ts': {
    needle: 'ensureTelegramCopyGate',
    file: 'src/web.ts',
    expect: 'absent',
    because:
      "Upstream's ensureTelegramCopyGate (GATECOPY828) would double-wire outgoing-copy-gate.py " +
      "alongside the fork's own ensureOutgoingCopyGate (card 74181db2) under two different " +
      "matchers -- refused 2026-09-06. Same shape as the seed-refresh-untouched-only.test.ts anchor " +
      "above (injectTelegramCopyGate in agent-scaffold.ts): two names for one capability, and " +
      "adopting the second one is a duplicate wire, not an addition.",
  },
  'package.json': {
    needle: '4.1.10',
    file: 'package.json',
    expect: 'absent',
    because:
      "Upstream bumped the vitest devDependency ^2.1.0 -> ^4.1.10; refused 2026-09-06 as its own " +
      "card with its own baseline run across a 15k-test suite, travelling together with " +
      "vitest.config.ts's testTimeout line (vitest 4 enforces the 5s default that vitest 2 did " +
      "not). If this version ever appears, the pairing decision needs to be made for real, not " +
      "inherited as a side effect of an unrelated dependency bump.",
  },
  'src/web/agent-process.ts': {
    needle: 'isMinimax',
    file: 'src/web/agent-process.ts',
    expect: 'absent',
    because:
      "Peti NO-GO on the MiniMax direct-API branch in resolveProviderEnv (card 48565f81, CLAUDE.md " +
      "rule 17). This is the security-relevant half of this file's own entry; the umask/" +
      "agentTmuxTarget half is separately anchored under 'vitest.config.ts' above (that one is a " +
      "deliberate, announced adoption -- opposite direction, do not confuse the two). Pinned at " +
      "source level per that entry's own words, because after the resolveProviderEnv refactor the " +
      "declined branch is two small hunks (an isMinimax discriminator line, an if(isMinimax) " +
      "block) that read as purely additive -- exactly the shape a reflexive union would restore.",
  },
  'scripts/email-send-gate.mjs': {
    needle: "from './recipient-ledger.mjs'",
    file: 'scripts/email-send-gate.mjs',
    expect: 'absent',
    because:
      "Card b5b7eb6b child 09d54e88 (2026-09-25): NOT adopted, acknowledge-only -- upstream's " +
      "recipient-ledger verification system (unverifiedRecipients(), a new gmail__ connector-send " +
      "gate closing a documented no-gate-at-all path, GMAILCONNECTOR914) requires this new " +
      "dependency file, which the fork does not have. If this import ever appears, someone adopted " +
      "the ledger system piecemeal -- the Gmail-connector gate and the commandHeads/WRAPPERS " +
      "detection rewrite (paired with outgoing-copy-gate.py's escalated Round 17) need the SAME " +
      "real decision, not a side effect of one import landing first.",
  },
  // NOT ANCHORED, deliberately, and left in UNANCHORED_BACKLOG (fork-upstream-conflict-guard.test.ts)
  // rather than pointed anywhere: this refusal is ABOUT a test file's own content (whether upstream's
  // minimax-m3 test case was adopted), and 'an anchor points at a PRODUCTION file, not at a test'
  // is enforced absolutely by this module's own test suite -- a test can declare its own copy of
  // anything, so a needle aimed at src/__tests__/context-guard.test.ts itself would prove nothing.
  // The decision this entry restates is the SAME one the 'src/web/agent-process.ts' anchor above
  // already watches (isMinimax, absent) -- if MiniMax is ever adopted for real, that anchor fires
  // first, on the production side, which is where the fact that matters actually lives.
  // The five below are the REVERSED half of the same backfill (see the CORRECTION paragraphs on
  // each file's own ACKNOWLEDGED_CONFLICTS entry for the evidence): each was refused, and each is
  // in fact already adopted. Anchored `present`, same as context-restart-gate-runner.ts and
  // agent-scaffold.ts above -- the point of these five is not "prove it landed" (the correction
  // paragraph already does that with a commit sha), it is to catch a FUTURE accidental reversion
  // back toward the refused state, which nothing else in this file would notice.
  'src/web/routes/kanban.ts': {
    needle: 'blockerWouldCycle',
    file: 'src/db.ts',
    expect: 'present',
    because:
      "The /api/kanban/:id/blockers route (kanban.ts) and its cycle guard blockerWouldCycle " +
      "(db.ts) landed via commit 7e9a7362, the same day this entry's 2026-09-06 measurement round " +
      "said the feature was 'not a gap'. It is present and functional, just unused by the " +
      "dashboard (web/app-kanban.js calls only the fork's own /dependencies route, verified). If " +
      "blockerWouldCycle disappears while the route stays, the cycle guard silently stops -- a " +
      "correctness regression on a route that is live even though the UI does not exercise it.",
  },
  'src/web/schedule-runner.ts': {
    needle: 'TASK_FIRE_TIMEOUT_MS = 2_700_000',
    file: 'src/web/schedule-runner.ts',
    expect: 'present',
    because:
      "Raising the stuck-task alert threshold from 5 to 45 minutes was refused 2026-09-06 as its " +
      "own alerting-threshold decision; commit 3496bff1 had already landed it the day before, " +
      "measured and corrected under card 2f1cbaf1. If this reverts to a 5-minute (or otherwise " +
      "much shorter) value, the owner is back to the false 'possible hang' alerts the 45-minute " +
      "value was measured to fix.",
  },
  'scripts/notify.sh': {
    needle: '$CHAT_ID" = "0"',
    file: 'scripts/notify.sh',
    expect: 'present',
    because:
      "The CHATID0 guard (refuse a chat_id of \"0\", the installer placeholder) was refused " +
      "2026-09-06 as its own fallback-channel-behaviour decision; commit 3e807fe4 had already " +
      "landed it the day before, measured and corrected under card 2f1cbaf1. Without this guard a " +
      "placeholder install's fallback alert path posts to chat_id=0 instead of failing loudly.",
  },
  'scripts/github-pr-monitor.sh': {
    needle: 'AUTH_ALERT_COOLDOWN=21600',
    file: 'scripts/github-pr-monitor.sh',
    expect: 'present',
    because:
      "Keeping gh's exit status (instead of reading a failed `gh pr list` the same as a genuinely " +
      "empty one) and alerting the owner at most once per 6h was refused 2026-09-06 as its own " +
      "decision; commit 99b3b149 had already landed it the day before, measured and corrected " +
      "under card 2f1cbaf1. Reverting this brings back the silent-zero: expired auth or no network " +
      "reads as 'nothing to watch' and the monitor exits 0 while watching nothing.",
  },
  'src/web/channel-monitor.ts': {
    needle: 'shouldAlertStuckSubAgent',
    file: 'src/web/channel-monitor.ts',
    expect: 'present',
    because:
      "Card ea86a362 (2026-09-25, the same day as this backfill) found three items this file's own " +
      "entry recorded as not-adopted/undecided -- markAgentRestartPending/isWithinRestartGrace " +
      "(DANICTXHUROK906), detectsPermissionDialog (PERMDENY905), and this symbol " +
      "(shouldAlertStuckSubAgent, STUCKINPUT827) -- all three present and correctly wired, verified " +
      "directly. Anchored on the STUCKINPUT827 item specifically because it was the one the entry " +
      "stated most flatly ('neither of which this fork has'); if it disappears, re-read the entry's " +
      "2026-09-25 correction paragraph before assuming a revert is safe.",
  },
  'web/app.js': {
    // The PARTIALLY-reversed one. renderCardBlockersSection as a function is genuinely absent
    // (zero hits in app.js and app-kanban.js) -- that half of the 2026-09-06 refusal holds and is
    // what this anchor watches. The i18n-tagged HTML markup for the same feature DID land in
    // web/index.html (kanban.modal.blockers_title etc.), and nothing calls the backend's live
    // /api/kanban/:id/blockers route to populate it -- dead markup, not a working UI. See this
    // file's own CORRECTION paragraph for the full picture; anchored on the function's absence
    // because that is the checkable fact that decides whether a user can ever reach this feature,
    // which the markup alone does not.
    needle: 'renderCardBlockersSection',
    file: 'web/app.js',
    expect: 'absent',
    because:
      "Upstream's card-blockers UI is superseded by the fork's own kanban_dependencies UI (see " +
      "src/web/routes/kanban.ts's entry) -- refused 2026-09-06. If this function appears, someone " +
      "has wired the dead HTML markup up for real, which is an adoption decision (does the fleet " +
      "want two parallel card-blocking UIs, or should the dependencies one absorb this one's " +
      "markup?), not something that should happen as a side effect of an unrelated merge.",
  },
}

/** An acknowledgement whose rule rests on a fork-side fact that is no longer true. */
export interface DriftedForkAnchor {
  readonly file: string
  readonly anchor: ForkAnchor
  readonly found: boolean
}

/**
 * Substring containment is NOT enough, and this was measured rather than reasoned: renaming
 * `touchAncestorChain` to `touchAncestorChainRENAMED` -- a rename is one of the ways the anchored
 * fact stops being true -- left `content.includes(needle)` perfectly green, because the new name
 * CONTAINS the old one. The anchor would have gone on asserting a symbol that no longer exists
 * under that name.
 *
 * So a match must sit on identifier boundaries: no `[A-Za-z0-9_$]` immediately either side. The
 * needle itself stays a plain fixed string -- authors write these from prose and must not have to
 * escape anything -- the boundary is applied here instead of being pushed into the declaration.
 */
export function containsAsToken(content: string, needle: string): boolean {
  const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c)
  let from = 0
  for (;;) {
    const at = content.indexOf(needle, from)
    if (at === -1) return false
    if (!isWordChar(content[at - 1]) && !isWordChar(content[at + needle.length])) return true
    from = at + 1
  }
}

/**
 * Strip line comments so a `present` anchor cannot be satisfied by a comment merely NAMING the
 * needle (card 232e01e2, Cybersec measurement on this file's own re-measure history: the needle
 * also matched inside a comment describing what the code used to do, so editing away only the CODE
 * half of a rule -- the ordinary shape of a re-measure round, see the file header above -- left the
 * anchor green for the wrong reason; a control run that also cleared the comment DID go red, proving
 * the pin had a tooth, just not where it needed one). Keyed off the anchor's own file extension
 * (`.py` -> `#`, everything else -> `//`) rather than scanning for both markers unconditionally,
 * because ACKNOWLEDGED_FORK_ANCHORS spans both TS and Python files and stripping `#` inside a TS
 * string (a URL fragment, say) or `//` inside a Python one would silently eat real content neither
 * comment style owns there. Deliberately line-comment-only, not block comments: every needle
 * anchored today sits in a line-commented region (measured against the three live anchor files),
 * and a block-comment stripper is real complexity (nesting, a `/*` inside a string) this map does
 * not need yet.
 */
function stripLineComments(content: string, file: string): string {
  const marker = file.endsWith('.py') ? /#.*$/ : /\/\/.*$/
  return content
    .split('\n')
    .map((line) => line.replace(marker, ''))
    .join('\n')
}

/**
 * Pure and injectable (`readFile`) for the same reason classifyConflicts is: the live test reads the
 * real tree, and a classification exercised only there would be untested wherever the tree happens
 * not to trip it. `readFile` returns null for a missing file, which is DRIFT for a 'present' anchor
 * -- a rule resting on a file that is gone is exactly as stale as one resting on deleted code.
 *
 * A `present` anchor matches on the COMMENT-STRIPPED text; an `absent` one stays on the RAW text on
 * purpose (card 232e01e2) -- a statement reverted but left behind as a comment is still a prose
 * claim worth re-deciding, the same reasoning CLAUDE.md's code-quality rule 12 gives for a `present`
 * check one level up: the two directions are not symmetric, so neither can share one code path.
 */
export function classifyForkAnchors(
  anchors: Readonly<Record<string, ForkAnchor>>,
  readFile: (file: string) => string | null
): DriftedForkAnchor[] {
  const drifted: DriftedForkAnchor[] = []
  for (const [file, anchor] of Object.entries(anchors)) {
    const content = readFile(anchor.file)
    const searched =
      content !== null && anchor.expect === 'present' ? stripLineComments(content, anchor.file) : content
    const found = searched !== null && containsAsToken(searched, anchor.needle)
    if ((anchor.expect === 'present') !== found) drifted.push({ file, anchor, found })
  }
  return drifted
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
  const blobLine = upstreamBlob ?? ABSENT_UPSTREAM_BLOB
  return (
    `  '${file}':\n` +
    `    'TODO -- decide what to keep from each side',\n` +
    `  // ACKNOWLEDGED_UPSTREAM_BLOBS:\n` +
    `  '${file}': '${blobLine}',`
  )
}

#!/usr/bin/env node
// PreToolUse hard-gate: blocks SELF-PACE for sub-agents.
//
// Governance control (2026-06-26, after the autonom-kor incident: a sub-agent
// scheduled its own wakeups via ScheduleWakeup, fed itself prompts, and acted
// on a SELF-GENERATED "A) zárjuk le" decision -- dispatching real development
// -- while the operator slept. Two independent adversarial audits confirmed the
// root cause is the agent's own self-pace loop, not an external vector).
//
// A sub-agent must be INPUT-DRIVEN: it acts on operator / peer messages, never
// on prompts it scheduled for itself. This gate blocks every self-pace path:
//   - the Claude Code runtime tools ScheduleWakeup / CronCreate / CronList /
//     CronDelete / RemoteTrigger (the autonomous-loop machinery), AND
//   - the Bash escape routes that achieve the same self-injection: writing the
//     Claude scheduled_tasks.json directly, tmux send-keys into a session, or
//     POSTing a new schedule to the dashboard.
//
// Why a hook and not only a permissions deny-list: permissive profiles launch
// with --dangerously-skip-permissions. A whole-tool-name deny DOES survive that
// (deny is checked before the bypass allow), so the scaffold also adds these
// names to permissions.deny -- but the Bash-command routes can ONLY be caught
// by a PreToolUse hook, which runs regardless of permission mode. Defense in
// depth: deny-list for the tool names, this hook for the Bash routes (+ the
// names again, redundantly fail-closed).
//
// Wired into every sub-agent's .claude/settings.json by
// writeAgentSettingsFromProfile() (agent-scaffold.ts), guarded by
// name !== MAIN_AGENT_ID, re-applied on every spawn (respawn-safe).

import { readFileSync, appendFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { allow, deny, isInvokedDirectly } from './hook-lib.mjs'
import { heredocOwnerSpans } from './bash-ast.mjs'

// AST CUTOVER FLAG (card f16b3165, plan-grilling change 3 -- feature flag, not a direct swap).
//   'shadow' (default) -- run both recognisers, record disagreements, let the WALKER decide.
//                         Costs nothing until the optional tree-sitter dependency is installed:
//                         heredocOwnerSpans returns null and the comparison is skipped.
//   'on'                -- the AST answer decides where it has one (walker still covers null).
//   'off'               -- do not parse at all; byte-for-byte today's behaviour.
// Rollback is an env var, not a revert.
//
// WHAT LICENSES THE CUTOVER TO 'on' -- corrected, because the first answer was wrong in a way that
// mattered (Cybersec F-2, card f16b3165). The shipped criterion was "run shadow until the
// divergence log shows zero disagreements". That is structurally blind to a false NEGATIVE: the
// attacker chooses the shape, and none of the fourteen compound-redirect bypasses F-1 found occurs
// in good-faith fleet traffic. A week of empty log would have delivered exactly the confidence
// needed to enable them.
//
// Dark launch is the right instrument for FALSE POSITIVES -- it genuinely caught a `git commit -F -`
// regression before it shipped -- and the wrong instrument for false negatives. So the criterion is:
// the ADVERSARIAL battery in src/__tests__/bash-ast-boundary.test.ts is green with SELF_PACE_AST=on,
// which is an executable assertion rather than a claim about a log. The divergence log keeps its
// job, which is watching for availability regressions in real traffic.
//
// READ PER CALL, not captured at module load. In production each hook invocation is a fresh
// process, so either would do -- but a load-time constant cannot be exercised by a test that flips
// the variable, and a "shadow mode changes nothing" assertion written against one would compare
// shadow with shadow and pass no matter what the flag did. The cost is one env lookup per command.
function astMode() {
  const v = String(process.env.SELF_PACE_AST ?? '').trim().toLowerCase()
  return v === 'on' || v === 'off' ? v : 'shadow'
}

const AST_DIVERGENCE_LOG =
  process.env.SELF_PACE_AST_LOG ??
  join(dirname(dirname(fileURLToPath(import.meta.url))), 'store', 'ast-divergence.log')

// Record a walker/AST disagreement for the dark-launch review.
//
// DELIBERATELY SHAPE-ONLY, NEVER THE COMMAND TEXT. Agent commands routinely carry bearer tokens
// (`printf 'Authorization: Bearer %s' ... | curl -H @-`), so writing `src` or either span to a log
// file would turn a diagnostic into a credential sink -- the exact trade the fleet's redaction
// rules exist to prevent. A digest identifies a recurring case across runs, and the leading WORD of
// each side names the disagreement class (`curl` vs `python3`), which is what a fix needs.
//
// THE INTENT ABOVE WAS RIGHT AND THE FIRST IMPLEMENTATION STILL LEAKED (Cybersec F-3, card
// f16b3165). "The leading word" is not the binary when the command carries an inline environment
// assignment -- and CURL_LEADING_RX itself lists `[A-Za-z_]\w*=\S*` as an allowed leading form, so
// `DASHBOARD_TOKEN=<secret> curl -d @- ...` put the secret VALUE in the log as the head. Measured
// with a synthetic value. Leading assignments are therefore reduced to their NAME, and only the
// first non-assignment word is reported.
const ASSIGNMENT_WORD_RX = /^([A-Za-z_]\w*)=/
const AST_LOG_MAX_BYTES = 1_048_576

export function divergenceHead(span) {
  for (const word of String(span ?? '').trim().split(/\s+/)) {
    if (!word) continue
    const assigned = ASSIGNMENT_WORD_RX.exec(word)
    // `NAME=` keeps the diagnostic (which variable prefixed the command) and drops the value.
    if (assigned) return `${assigned[1]}=`
    return word.slice(0, 32)
  }
  return ''
}

function recordAstDivergence(src, walkerSpan, astSpan, walkerSays, astSays) {
  try {
    // An attacker can manufacture divergences at will, so the log is capped rather than unbounded.
    // Dropping records is the right failure here: this is a dark-launch diagnostic, not an audit
    // trail, and it must never be the reason a disk fills.
    try {
      if (statSync(AST_DIVERGENCE_LOG).size > AST_LOG_MAX_BYTES) return
    } catch {
      // no log yet -- nothing to cap
    }
    appendFileSync(
      AST_DIVERGENCE_LOG,
      JSON.stringify({
        at: new Date().toISOString(),
        digest: createHash('sha256').update(src).digest('hex').slice(0, 16),
        bytes: src.length,
        walker: { head: divergenceHead(walkerSpan), exempt: walkerSays },
        ast: { head: divergenceHead(astSpan), exempt: astSays },
      }) + '\n',
      // Mode applies at CREATION only; without it the fleet's 0002 umask made this 0664, i.e.
      // group-writable and world-readable for a file whose whole purpose is to be conservative.
      { mode: 0o600 }
    )
  } catch {
    // A logging failure must never change a gate decision, and must never wedge a Bash call.
  }
}

// Claude Code runtime self-pace / scheduling tools. A sub-agent has no
// legitimate need to schedule its own future turns -- it is input-driven.
const SELF_PACE_TOOLS = new Set([
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
])

// Bash command patterns that achieve self-pace by another route. These are
// tested per COMMAND SEGMENT (see splitSegments), so a token in one part of a
// compound command never trips a pattern that belongs to another part.
const SELF_PACE_BASH_PATTERNS = [
  // tmux pane injection -- every write-subcommand that can push keys/text/commands
  // into a pane (the actual incident vector), not just send-keys. [\s\S] (not
  // [^\n]) so an intra-segment newline cannot split the match.
  /\btmux\b[\s\S]*\b(send-keys|paste-buffer|run-shell|set-buffer)\b/i,
  // self-backgrounding that relaunches claude (nohup/setsid/disown + claude)
  /\b(nohup|setsid|disown)\b[\s\S]*\bclaude\b/i,
  // the loop slash-skill driven from a shell. `/loop` must be in SLASH-COMMAND
  // position -- a standalone token (segment-start / whitespace / quote before it,
  // whitespace / quote / end after it) -- never a PATH segment. The old
  // `\/loop\b` fired on any `loop`-prefixed path component whenever `.claude` was
  // in the same command (\bclaude\b matches the `.claude` in every memory/skill
  // path), so reading `.../memory/loop-stop-...md` or `~/.claude/skills/loop/...`
  // was denied (measured 2026-07-26, found by pg: Heli denied a harmless memory
  // read). Same bug class as the at/batch and launchctl fixes below: a keyword in
  // a PATH collided with a call pattern; the fix is to match the invocation SHAPE.
  // Every real form stays denied: `claude /loop 5m`, `claude -p "/loop x"`,
  // `claude '/loop'`, bare `claude /loop`.
  /\bclaude\b[\s\S]*(?:^|[\s'"])\/loop(?=[\s'"]|$)/i,
]

// OS-level schedulers + delayed exec (cron / launchd / systemd / at / batch): the
// shell route to the same self-pace the CronCreate tool-deny blocks at the runtime
// layer. Anchored to command position (segment start), but a leading wrapper is
// allowed before the binary -- sudo/env/command/nice, a VAR=val environment, and
// an absolute/relative path -- so `sudo crontab -r`, `/usr/bin/at now`,
// `PATH=/bin crontab -` are all caught. Trailing \b(?!-) so it never fires on
// "netstat" / "crontab-helper.sh"; (?!\s*=) so a bare NAME=value assignment
// (`at=$(...)`) is not mistaken for the `at` binary.
// A leading PATH on a command word (`/usr/local/bin/bash`, `./tools/sh`). Written with a BOUNDED
// character class, not `\S*`, and that is a security fix rather than a tidy-up (card fa5ef179).
//
// `(?:\S*\/)?` is unanchored and greedy over "any non-space", so on input that contains NO spaces --
// `:|:|:|...` is the measured example -- it scans to the end of the string at EVERY start position
// looking for a `/`, then backtracks. That is O(n^2): measured 36 ms at 8 KB, 2304 ms at 64 KB,
// exactly 4x per doubling, while the bounded form is 0 ms at every size. Since the hook is
// registered with `timeout: 10` and the caller treats a timeout as NON-blocking, a large enough
// inert filler pushed the whole gate past its deadline and the real payload was allowed
// unexamined -- the governance control bypassed by input size alone.
//
// NOTHING IS LOST BY THE NARROWER CLASS, measured rather than assumed: `| ; & < > ( )` cannot
// appear UNESCAPED in an unquoted command path in bash -- they are separators. On every shape where
// the two forms differ, both still FIND the shell; the bounded one merely starts the match after
// the separator, which is where the command actually begins (`/tmp/a|b/bash` -> `b/bash`). So
// detection is unchanged and the span is more accurate.
//
// ESCAPED, THOUGH, THOSE SAME CHARACTERS ARE ORDINARY WORD CHARACTERS -- Cybered NO-GO, card
// fa5ef179 round 3, live-executed: `\<` and `\>` inside an unquoted word are the literal characters
// `<`/`>`, not redirection, so `bash -c '/tmp/a\<b/crontab -r'` runs the binary in a directory named
// with an escaped `<`, and the first draft of the bounded class -- a plain negated char class with
// no escape awareness -- named the shell but stopped scanning right at the escaped separator and
// missed it. Same lesson this file already documents for scanBashWord: a bash WORD is a sequence of
// runs, not a character class. `(?:\\.|[^...])*` is that same idiom applied here: an escaped pair
// consumes two characters as one unit before the negated class gets another turn, so a `\<`/`\>`
// can no longer look like a boundary.
//
// MY OWN REGRESSION, caught before landing (card ec20dd23/fa5ef179 land attempt, 2026-08-24): the
// negated class must ALSO exclude the backslash itself, or the two alternatives overlap on every
// literal `\` -- `\\.` can consume it paired with the next character, or the class can consume it
// alone and let the star continue. That is the identical ambiguous-star shape this file's other
// escape-aware patterns are written to avoid (see the double-quote body a few hundred lines down:
// `(?:\\.|[^"\\])*`, which DOES exclude the backslash). Without it, a run of consecutive backslashes
// with no `\/` ever following -- exactly what deep `bash -c "..."` nesting produces once each level
// escapes the last -- makes the engine try every partition of the run before giving up empty, which
// is exponential in the run length. MEASURED: HERESTRING_RX.test() on a 6-deep nested wrapper (183
// chars, ~30 consecutive backslashes near the payload) never returned; the fix below returns in 0ms
// on the same input, with no change to any matched/non-matched outcome (checked against plain,
// absolute, and relative paths, and the escaped-separator shape fa5ef179 was fixed for).
//
// ROUND 2 (Cybersec, card 39cc3460, found while running ccc2c742's own mandatory 5-regex sweep):
// `\\.` still consumed an ESCAPED PIPE (`\|`) as an ordinary path character. That matters because
// CMD_POSITION (used by WRAPPER_POSITION) and STDIN_SHELL_RX's pipe branch both treat a bare `|`
// as its own valid anchor -- so a run of escaped-pipe pairs (`\|\|\|...`) gives ~n such anchor
// positions in the SAME input. At every one of them, PATH_PREFIX's `\\.` happily consumes the rest
// of the run (it is nothing but more `\|` pairs, each matching `\\.`), finds no closing `/`, and
// backtracks the whole way back out -- O(remaining length) for ONE anchor attempt, times ~n anchor
// attempts, is O(n^2) again, just reached through the anchor density rather than through an
// external lazy filler. Measured (Cybersec, through the real gateDecision()): n=16000 pairs ->
// 1679ms, clean n^2 scaling. `\\.` narrows to `\\[^|]`: escaping a pipe specifically is no longer
// "just another path character", so PATH_PREFIX's optional group stops there instead of consuming
// it -- the same disjoint-alternation shape as ROUND 1 above and as XARGS_FILLER (ccc2c742 round
// 6), narrowed one notch further. No existing test exercises an escaped pipe as a deliberate path
// character (checked before narrowing this), and the bare `|` the scan now stops in front of is
// still its own independent anchor for the surrounding regex to retry from -- verified empirically
// (path-prefix-escaped-pipe-quadratic.test.ts), not assumed.
const PATH_PREFIX = String.raw`(?:(?:\\[^|]|[^\s|;&<>()\\])*\/)?`

const SCHED_PREFIX = String.raw`(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*${PATH_PREFIX}`
// The command-boundary anchor includes `(` so a $(...) command substitution
// (`X=$(crontab -)`) is caught, AND a backtick so a legacy `...` substitution
// (`X=`crontab -r``) is caught too -- both run the enclosed command in a shell
// context, so a scheduler binary immediately inside either is a real self-pace.
// Card ec20dd23 (Cybersec, live-measured on the installed binaries): this class named only the
// punctuation separators, so every shell KEYWORD that introduces a command was a bypass --
// `if true; then <binary> -; fi`, `for i in 1; do ... done`, and the `else` arm were reported;
// `while`, `until`, `elif` and a brace group turned up in the same class while fixing it. A
// keyword sits exactly where a separator would and the shell runs what follows it as a command,
// so it IS a command position -- the class simply did not say so. Same enumeration as
// LINE_CMD_POSITION below, and for the same reason: an incomplete list of positions is a hole.
// --- ONE COMMAND-POSITION GRAMMAR, USED BY BOTH BRANCHES ---------------------------------------
//
// WHY THIS IS ONE CONSTANT (card 442f3289 round 2, Cybered NO-GO + Cybersec revoking its own GO).
// There used to be two lists -- SCHED_BOUNDARY for the anchored scan and LINE_CMD_POSITION for the
// heredoc-body scan -- both trying to describe the same thing: where a shell starts a command. They
// DIVERGED IN BOTH DIRECTIONS. The anchored one had `{` `!` and if/while/until but no quotes and no
// case-arm; the heredoc one had the quotes but no `{`, no `!`, no case-arm and only half the
// keywords. Each fix taught one list and left the other, and the measured result was six gaps at
// once: five real positions missing from one branch, one from the other.
//
// Two of those were a REGRESSION I introduced: the previous round narrowed the heredoc branch from
// "anywhere on the line" to this grammar, and an incomplete grammar silently dropped positions the
// unanchored match had been catching. That is the exact failure mode that round's own comment
// warned about ("this denies LESS, so the enumeration must be COMPLETE rather than tolerant") --
// written down, and then not lived up to, because the list was built from what the patch touched
// instead of from the shell's grammar.
//
// So: one list, derived once, consumed twice. A position added here is added to both branches by
// construction, which is the only version of this that stays true.
//
// WHAT IS IN IT, and each entry is a position bash genuinely runs a command from -- verified by
// marker, not by reading:
//   ;  &  |     separators (and && / || via `&` and `|`)
//   (           subshell and $( ) substitution
//   )           a case ARM: `case $x in y) <cmd> ;; esac`
//   {           a brace group: `{ <cmd>; }`
//   !           negation: `! <cmd>`
//   `           legacy command substitution
//   keywords    if / then / else / elif / while / until / do each introduce a command
//
// `}` is deliberately NOT here: bash needs a separator after it, so nothing starts a command there.
//
// `)` IS here, and it is not free -- stated as a trade rather than found later (Cybersec F-3 on
// card 442f3289). It has to be here because a case arm (`case $x in y) <cmd> ;;`) and a closing
// subshell both really do put a command after it. The cost is prose: an ordinary parenthetical
// followed by a time expression -- "the run finished (see note) <binary> 16:13 sharp" -- is denied
// in a heredoc body. Measured, and pinned by its own test so the choice stays visible, exactly as
// the `!` choice below is.
//
// A QUOTE IS DELIBERATELY NOT HERE EITHER, and the reason is worth keeping. An earlier round put
// `"` and `'` in, reasoning that `bash -c "<cmd>"` starts its command exactly at the quote. True,
// but it is a PROXY for "a shell runs this text", and card ec20dd23 replaced the proxy with the
// thing itself: executableStrings extracts what a shell would execute and the gate scans that as
// its own command, where the binary sits at line start.
//
// WHAT THE MEASUREMENT ACTUALLY SAYS -- stated exactly, because the previous wording did not.
// It used to read "every wrapper vector is still denied". Cybersec's NO-GO on this card (comment
// 15685) showed that sentence was true only of the PATCH'S OWN five wrapper shapes and false as a
// statement about how a shell can receive a program at all: at the time, extraction did not cover
// here-strings or process substitution, while the quote in this class had covered them. Two of
// those five shapes were still live-executable on the develop head when they measured.
//
// So the claim is now scoped to what was re-measured on THIS head (card 442f3289 round 3), after
// ec20dd23 extended extraction to here-strings and process substitution. Across 21 shapes, with
// the quote in this class versus out of it, the verdicts are identical for every route by which a
// shell receives a program -- `-c`, `eval`, here-string (both quotings), process substitution
// (`<( )` and `< <( )`), a pipe into a shell, xargs, and a nested `-c`, each also measured buried
// in a heredoc body that bash executes. ZERO of them lose a denial when the quote comes out, and
// four prose false positives are bought back by removing it.
//
// AND THE LIMIT OF THAT CLAIM, named rather than implied: three routes are ALLOWED either way, so
// the quote never protected them and removing it takes nothing -- `python3 -c`, `script -qec`, and
// a program produced by a runtime substitution. Those are the file's standing known residuals; the
// sentence above is not a statement about them.
//
// Keeping it was not free: a quote is also how ordinary text quotes things. Measured false
// positives it caused, both now gone -- a JSON payload in a heredoc whose value opens with a time
// expression, and a sentence quoting one. Cybersec flagged the first while gating the previous
// round (comment 15642) as "a new false positive, in the right direction"; it turns out it did not
// have to be traded at all.
// `!` IS here, as a deliberate fail-closed choice (Cybered's recommendation, MikroB's open
// question): `! <scheduler>` really does run the scheduler, and the cost is a prose line whose
// exclamation mark lands immediately before a time expression. Pinned by its own test so the choice
// is visible rather than incidental.
const CMD_POSITION = String.raw`(?:[;&|(){!\`]|\b(?:if|then|else|elif|while|until|do)\b)`
const SCHED_BOUNDARY = CMD_POSITION
// `at` and `batch` are also ordinary English words, and splitSegments splits on
// NEWLINES -- so a PROSE line inside a multi-line commit body ("at least 80% of
// entries", "batch size is 50") lands at a segment start and looked exactly like
// the at(1)/batch(1) binaries. Measured 2026-07-25 (found by JogAsz): a heredoc
// commit message was denied for the words "at least"; the identical command
// passed after rewording that one line. The `-m "$(...)"` form is deliberately
// NOT blanked by stripGitCommitMessages (a real substitution could hide there),
// so the body does reach the splitter -- the fix belongs here, not there.
//
// For these two words ONLY, also require something that looks like an actual
// invocation: end of segment (a bare `batch` reads stdin -- still a real vector),
// a flag, an input redirect, or an at(1) TIMESPEC (which at(1) requires anyway,
// so a real submit can never omit it). crontab/launchctl/systemd-run keep the
// plain match: they are not English words, so prose cannot collide with them.
// Card eae5d6fd (QA, real repro): the day-of-week and month alternatives below had no trailing
// boundary, unlike `next\b` right next to them -- so ANY English word starting with those 3
// letters right after "at " false-denied, e.g. "at declared trivial difficulty" (declared ->
// "dec"). Same bug class as the documented >=80% substring collision above. `\b` added after
// both alternations, matching the convention `next\b` already uses in this same lookahead.
// QUOTE TOLERANCE, and the direction principle behind it (card 4fa31f31, Cybersec's live
// finding). The shell removes quotes before it decides what the command word and its arguments
// are, so `at "now + 5 minutes"` and `launchctl "submit" -l self` are the SAME invocations as the
// unquoted forms. The two guards below are WHITELIST-shaped -- they positively enumerate what may
// follow the binary -- and a quote is not in the enumeration, so the whole match failed and the
// call was ALLOWED. That is the direction that makes a whitelist guard dangerous here: when the
// enumeration is incomplete the branch PASSES THROUGH instead of denying.
//
// The other two scheduler binaries were measured UNAFFECTED by the same input, and the reason is
// exactly this direction: SCHED_BARE_SHAPE below is a NEGATIVE lookahead ("deny unless an English
// word follows"), so an unforeseen character such as a quote does not break it -- it still denies.
// DIRECTION PRINCIPLE for any binary added here later: prefer the negative shape. If a positive
// enumeration is genuinely needed, every character the shell strips before exec (quote, backslash,
// $IFS) has to be tolerated explicitly, or it becomes a bypass.
//
// `["']*` rather than `["']?`: `at"" now` is also a working invocation, and a quantifier that
// only allows one quote is the same incomplete-enumeration mistake one level down.
const AT_INVOCATION = String.raw`(?=["']*\s*$|["']*\s+["']*-|["']*\s*<|["']*\s+["']*(?:now|noon|midnight|teatime|today|tomorrow|next\b|\+\s*\d|\d{1,2}:\d{2}|\d{3,4}\b|\d{1,2}\s*(?:am|pm)\b|\d{1,2}[./]\d{1,2}|(?:mon|tue|wed|thu|fri|sat|sun)\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b))`
// `launchctl` needed the SAME narrowing, for a different reason than at/batch, and
// the comment above ("not English words, so prose cannot collide") was measured
// wrong on 2026-07-26 (found by Hacker). It is not an English word -- but the
// fleet's own heartbeats ORDER every agent to report `launchctl list | grep
// com.jarvis.channels` output, so a launchd JOB LABEL appears in prose constantly.
// splitSegments splits on `;`, so a report line "...; launchctl com.jarvis.channels
// PID 555" put `launchctl <label>` at a segment start and it read as a real
// invocation. His status message was denied; the finding is systemic, not his.
//
// The narrowing mirrors AT_INVOCATION: instead of enumerating dangerous
// subcommands (a denylist -- miss one and it is a hole), require the SHAPE of a
// real invocation. Every launchctl self-pace vector (load/bootstrap/submit/
// kickstart/start/enable/...) takes a SUBCOMMAND word first, so demand that the
// next token could be one: a bare lowercase word, no dot and no slash. A job
// label (`com.jarvis.channels`) and a path both fail that and pass through as
// prose. End-of-segment and a flag stay DENIED -- a bare `launchctl` is
// interactive, still a real vector.
// Quote-tolerant on BOTH sides, and the two sides are needed for different reasons (card
// 4fa31f31, Cybersec measured the asymmetry): a LEADING quote covers `launchctl "submit"`,
// where the quote sits between the binary and the subcommand, and also `"launchctl" submit`,
// where it sits right after the binary. A TRAILING one is needed because this alternative --
// unlike the at(1) timespec list -- closes on a word BOUNDARY `(?:\s|$)`, and a closing quote
// is neither. Fixing only the leading side leaves every quoted-subcommand form still passing.
const LAUNCHCTL_SUBCOMMAND = String.raw`(?=["']*\s*$|["']*\s+["']*-|["']*\s+["']*[a-z][a-z-]*["']*(?:\s|$))`
const SCHEDULER_RX = new RegExp(
  String.raw`(^|${SCHED_BOUNDARY}\s*)${SCHED_PREFIX}(?:(?:crontab|systemd-run)\b(?!-)(?!\s*=)|launchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|(?:batch|at)\b(?!-)(?!\s*=)${AT_INVOCATION})`,
  'i',
)
// ...but allow a pure READ-listing of one's own schedule (parity with the store /
// schedule-API read exemptions): crontab -l, launchctl list/print, atq.
// Quote-tolerant for the same reason the write guards are (card 4fa31f31): tightening the write
// side alone would turn a quoted `launchctl "list"` -- a pure read -- into a false deny.
const SCHEDULER_READ_RX = new RegExp(String.raw`(^|${SCHED_BOUNDARY}\s*)${SCHED_PREFIX}(crontab["']*\s+["']*-l\b|launchctl["']*\s+["']*(?:list|print|dumpstate|blame|examine)\b|atq\b)`, 'i')

// --- COMMAND-WORD MODEL (card 4f32f1f9) -------------------------------------------------------
//
// THE CLASS THIS CLOSES. Every pattern above matches the text BEFORE the shell expands it; the
// shell runs the words AFTER expansion. So every construct the shell removes on the way -- a quote
// INSIDE a word, $IFS, a backslash, $'...', ${x} -- hides an invocation from a pattern looking for
// a literal binary name. Measured on the real gateDecision path (Cybersec's finding, re-measured
// independently here): `cr"o"ntab -r`, `at$IFS"now"`, `$'at' now`, `${x}at now`, `"crontab" -r`,
// `\at now`, `launchctl "load" x` and `at n""ow` each run the real binary and each passed.
//
// The three previous fixes in this file (12f80902, eae5d6fd, 4fa31f31) each tolerated ONE more
// character in ONE more branch. That does not converge, because the shell's word expansion is not
// a character set. This models the expansion instead -- approximately, and only far enough to name
// the COMMAND WORD.
//
// WHY IT DOES NOT OPEN A FALSE-POSITIVE CLASS, and this is the load-bearing part: the
// approximation removes quotes, and quotes are exactly what makes prose inert to the checks above.
// So the normalised text is NEVER given a boundary anchor -- `^` only, i.e. a command position the
// MASKED view already established, which prose cannot fake. Quoted text INSIDE a segment therefore
// never reaches the position this looks at. Every documented false positive in this file (">= 80%",
// the launchd job label, the bar-separated grep pattern, "at declared trivial difficulty") sits in
// ARGUMENT position behind an `echo`/`grep` command word, so this check does not examine it at all
// -- structurally, not by luck. It is also purely ADDITIVE: it runs alongside the raw checks and
// can only ever deny more, so no existing denial depends on the approximation being complete.
//
// RESIDUAL, STATED RATHER THAN IMPLIED (Cybersec's decision on this card, option (a)): a command
// SUBSTITUTION or a bare parameter EXPANSION standing in command-word position -- `$(echo at) now`,
// `${CMD} -r` -- is NOT closed, and cannot be without running the substitution to learn the name.
// The reasoning first offered for accepting it ("the heredoc branch backstops it") was MEASURED
// FALSE and must not be repeated: `$(echo at) now` and `${CMD} -r` pass both branches, and the
// shape that matters is a plain command, which the heredoc branch never scans at all. What this
// gate defends is stated in the deny message and holds: a sub-agent must not CASUALLY self-pace,
// and a deliberate evasion must not pass UNNOTICED. It is not a defence against a determined
// evader, and widening it to attempt one was measured to cost legitimate forms (`$(npm bin)/eslint`
// in command-word position, `ls $(which node)` in argument position) while `${CMD}` would still
// pass -- a race that cannot be won by matching text.
const SCHEDULER_CMDWORD_RX = new RegExp(
  String.raw`^\s*${SCHED_PREFIX}(?:(?:crontab|systemd-run)\b(?!-)(?!\s*=)|launchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|(?:batch|at)\b(?!-)(?!\s*=)${AT_INVOCATION})`,
  'i',
)
// The read exemption needs no quote tolerance here: the expansion approximation already removed
// the quotes this same text used to carry.
const SCHEDULER_CMDWORD_READ_RX = new RegExp(
  String.raw`^\s*${SCHED_PREFIX}(crontab\s+-l\b|launchctl\s+(?:list|print|dumpstate|blame|examine)\b|atq\b)`,
  'i',
)

// UNANCHORED companion to SCHEDULER_RX (card 46c4ad4a, Cybered's finding on 4638c14c): the
// anchored check above only sees segments AFTER maskInertLiterals blanks every heredoc body
// entirely, so a crontab/launchctl/at/systemd-run/batch invocation hidden inside a heredoc -- the
// EXACT vector this gate exists to catch for tmux (measured 2026-08-05, this gate's founding
// incident) -- was invisible to BOTH the anchored check (masked away) AND the unanchored one
// (the scheduler group was never added there, only tmux/nohup/loop). Tested against the NAIVE
// segments (heredoc bodies included, since splitSegments' newline split turns each heredoc body
// line into its own segment), same treatment as SELF_PACE_BASH_PATTERNS.
//
// Reuses SCHEDULER_RX's own per-binary shape guards (AT_INVOCATION/LAUNCHCTL_SUBCOMMAND) so the
// SAME prose-collision classes already fixed there (measured: "at least 80%", a launchd job
// label in a status report) do not reopen here.
//
// crontab/systemd-run get a NARROWER guard here than SCHEDULER_RX gives them, unlike the other
// two. SCHEDULER_RX's crontab/systemd-run branch is bare (no shape check) because it is ANCHORED
// to a command-start position, which prose essentially never occupies. This check is NOT
// anchored, so ordinary prose reaches it too -- measured directly while building this fix:
// `echo "the crontab entries need review"` false-denied with a plain end-of-segment-or-flag
// guard (rejected because "entries" is neither). The guard actually used instead is a NEGATIVE
// lookahead: reject only when the binary is followed by whitespace then a lowercase word
// character -- i.e. reject the ENGLISH-SENTENCE shape specifically, accept everything else
// (a flag, end-of-segment, or being immediately followed by a quote/comma/bracket with NO
// whitespace, e.g. the adversarial `subprocess.run(["crontab","-r"])` shape -- Cybered's own
// example for this exact card). A plain end-of-segment-or-flag guard would have missed that
// python-list form entirely, since a `","` follows with no space and no leading `-`.
// The UNANCHORED at(1)/batch(1) guard drops AT_INVOCATION's end-of-segment branch (card 12f80902,
// Cybersec's corrected diagnosis). AT_INVOCATION's first alternative is `\s*$` -- "the token sits at
// the end of the segment" -- which is sound for the ANCHORED check, where the word already had to
// occupy a command-start position that prose essentially never occupies. Here there is no anchor:
// every heredoc body LINE is tested whole, so any prose line that happens to END in that word
// matched. Measured on a real blocked message: a Hungarian sentence whose verb-prefix was typed
// without its accent fell at a line break, and an ordinary status report was refused as an attempt
// to schedule a future turn.
//
// Dropping it costs no coverage. at(1) REQUIRES a timespec -- the bare binary with nothing after it
// exits with a usage error and schedules nothing -- so the end-of-segment shape never described a
// working invocation in the first place. Every shape that can actually submit a job is still
// matched: a flag, an input redirect, or any of the timespec forms.
//
// ONLY at(1) LOSES THE BRANCH -- batch(1) KEEPS IT, and that distinction is load-bearing. at(1)
// requires a timespec, so "nothing follows it" never described a working invocation. batch(1) takes
// NO timespec: a bare `batch` reads commands from stdin and runs them when the load average allows,
// so for batch the end-of-segment shape IS a working submit. Measured while building this fix --
// applying the change to both binaries allowed `echo x | batch` inside a heredoc body, which the
// previous version denied. The card's own wording ("delete the end-of-segment branch") would have
// opened that hole; the two binaries are only spelled alike.
//
// This is the THIRD member of the same collision class in this file: ">= 80%" and the
// "declared trivial difficulty" case are both already documented above. Each previous fix narrowed
// WHAT may follow the word; this one removes the branch where NOTHING follows it.
const AT_INVOCATION_UNANCHORED = String.raw`(?=["']*\s+["']*-|["']*\s*<|["']*\s+["']*(?:now|noon|midnight|teatime|today|tomorrow|next\b|\+\s*\d|\d{1,2}:\d{2}|\d{3,4}\b|\d{1,2}\s*(?:am|pm)\b|\d{1,2}[./]\d{1,2}|(?:mon|tue|wed|thu|fri|sat|sun)\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b))`
const SCHED_BARE_SHAPE = String.raw`(?!\s+[a-z])`
// COMMAND POSITION WITHIN ONE LINE -- the axis all previous fixes in this class missed
// (card 442f3289). at(1) and batch(1) are ordinary English words, and in THIS regex, unlike the
// anchored SCHEDULER_RX, the word alone matched them anywhere on a heredoc-body line. The only
// thing separating prose from a denial was the lookahead at what FOLLOWS -- and what follows the
// word in English prose about schedules and measurements is exactly what at(1) accepts as a
// timespec: a clock time, a date, noon, today, a weekday name, a 3-4 digit number. Measured on the
// pre-fix file, all of these ordinary sentences were denied inside a heredoc body:
//     the nudger found the pane ... 16:13 and did nothing
//     the call was retried ... 1200 ms and then gave up
//     the last landing happened ... 5pm yesterday
//     the digest runs ... noon for every tenant
//     measured ... 08/14 on the shared clone
//     the counter resets ... mon boundary
//
// So each earlier fix removed one alternative from that lookahead (0229c844, eae5d6fd, 46c4ad4a,
// and the end-of-segment branch documented above), and the class kept regenerating -- because
// "what may follow the word" is precisely where prose and at(1) genuinely overlap. Narrowing that
// axis cannot converge. What prose does NOT have is command POSITION, which is where the anchored
// branch has always got its safety; this gives the two English words the same requirement, applied
// inside the line.
//
// DIRECTION, per this file's own stated principle: this makes the branch deny LESS, so it is the
// shape that can open a hole, and the enumeration it uses must be COMPLETE rather than merely
// tolerant. The first version of this was NOT -- it named the positions the patch had thought
// about, and dropped the case-arm, brace-group, negation, `while` and `until` positions that the
// old unanchored match had been catching. That is why the grammar now lives in ONE constant shared
// with the anchored branch (see CMD_POSITION above) instead of being written out again here.
// `(` in the class already covers a `$(` substitution opener -- `$(` cannot occur without it -- so
// there is no separate alternative for it. Measured: adding one changed no verdict.
// Derived from the ONE grammar above -- see its header for why there is no second list here.
const LINE_CMD_POSITION = String.raw`(?:^|${CMD_POSITION})\s*`
const UNANCHORED_SCHEDULER_RX = new RegExp(
  String.raw`\b(?:crontab|systemd-run)\b(?!-)(?!\s*=)${SCHED_BARE_SHAPE}|\blaunchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|${LINE_CMD_POSITION}${SCHED_PREFIX}batch\b(?!-)(?!\s*=)${AT_INVOCATION}|${LINE_CMD_POSITION}${SCHED_PREFIX}at\b(?!-)(?!\s*=)${AT_INVOCATION_UNANCHORED}`,
  'i',
)
const UNANCHORED_SCHEDULER_READ_RX = new RegExp(
  String.raw`crontab["']*\s+["']*-l\b|launchctl["']*\s+["']*(?:list|print|dumpstate|blame|examine)\b|atq\b`,
  'i',
)
// Same pattern, global: used to REMOVE the read forms from a line before asking whether anything
// schedule-WRITING is left. See the heredoc loop below for why matching is not enough.
const UNANCHORED_SCHEDULER_READ_RX_G = new RegExp(UNANCHORED_SCHEDULER_READ_RX.source, 'gi')

// The Claude self-schedule store. Blocked for WRITE on any route (a Bash write,
// or the native Write/Edit/NotebookEdit tool); a read/grep is legit diagnostics.
const SCHEDULE_STORE_RX = /scheduled_tasks\.json/i
// Write-intent shell tokens (redirect / tee / in-place edit / dd / copy-move).
const WRITE_INTENT_RX = /(>>?|\btee\b|\bsed\b[\s\S]*\s-i|\bdd\b|\bcp\b|\bmv\b)/i
// Dashboard schedule API. A WRITE method (POST/PUT/PATCH/DELETE) creates/edits a
// self-paced cron; a GET (list / pending / agents) is legit diagnostics -> allowed.
const SCHEDULE_API_RX = /\/api\/schedules\b/i
const HTTP_WRITE_RX = /(-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|(^|\s)(--data\b|--data-\w+\b|-d\b))/i

// Split a compound command into individual simple commands, so a token in one
// segment cannot trip a check anchored in another (e.g. `cat store && cp a b`).
// Line-continuations (backslash-newline) are collapsed FIRST so a single command
// continued across lines stays ONE segment (this is what keeps the
// tmux\<newline>send-keys vector closed); only real separators split.
//
// KNOWN LIMITATIONS (accepted, defense-in-depth -- the runtime tool-deny is the
// primary guard, this Bash hook is a second layer; a sub-agent is not adversarial
// to its own gate, it just must not casually self-pace):
//   - Not quote-aware: a separator INSIDE quotes (e.g. a commit message
//     `git commit -m "fix; crontab -r"`) splits and could false-deny. Rare
//     enough (the quoted ; must be immediately followed by a blocked binary at a
//     segment start) that a full shell-tokenizer is not warranted here.
//   - A $(...) or backtick substitution that assigns a scheduler result
//     (`X=$(crontab -)`, `X=`crontab -``) is caught by SCHEDULER_RX's boundary
//     anchor, which now includes both `(` and the backtick.
export function splitSegments(command) {
  return String(command ?? '')
    .replace(/\\\r?\n/g, ' ')
    .split(/&&|\|\||[;&|]|\r?\n/)
    // trim so a leading-separator segment (" at now") anchors at ^ correctly
    .map((s) => s.trim())
}

// Split like splitSegments, but ONLY on separators the shell would actually
// treat as separators -- never on one that sits inside a quoted string or a
// heredoc body. Returns null when the quoting cannot be resolved with
// confidence, and every caller must then fall back to the naive splitter.
//
// WHY THIS EXISTS (measured 2026-08-05, five denials in one morning -- three
// mine, two taric's): splitSegments is not quote-aware, so PROSE can manufacture
// a command position that never existed. All five denials had the same cause: a
// grep pattern quoted inside an inter-agent message,
//   Minta: stop.sh <bar> launchctl <bar> com.janna.dashboard
// The `<bar>` split it, the middle piece trimmed down to the bare word
// `launchctl`, and SCHEDULER_RX's end-of-segment branch reads a bare `launchctl`
// as a real (interactive) invocation -- correctly, for a real command line.
// Nothing was scheduled; five messages simply never went out. From outside, a
// hard-gate denial is indistinguishable from an agent that stayed silent.
//
// The route decided it: the SAME text passes as `curl -d '<json>'` (the payload
// is blanked by stripDataPayloads) and is denied when sent from a python
// heredoc, which has no -d argument to blank. Choosing how to send a message
// had quietly become a security decision. stripDataPayloads' own comment names
// this false-positive class as its target -- it is implemented for exactly one
// route, so the gap is unfinished work, not an oversight.
//
// SCOPE, and this is the part that matters: the result feeds ONLY the anchored
// scheduler check. The unanchored patterns (tmux+send-keys, nohup+claude,
// claude+/loop) keep scanning naive segments, quoted regions included, because
// they do NOT depend on a command position that prose can fake -- and because
// measurement showed the naive scan is what catches a real
// `subprocess.run(['tmux','send-keys',...])` hidden in a heredoc body. Handing
// them quote-aware segments would have removed the detection of the very
// incident vector this gate was built for, under the banner of a structural fix.
//
// FAIL-CLOSED in three places, because "could not parse" must mean "scan more",
// never "scan less":
//   - unterminated quote or heredoc -> null (caller uses the naive split)
//   - a double-quoted region containing $(...) or a backtick -> null; the shell
//     runs what is inside, so a `;` in there IS a real separator
//   - a heredoc with an UNQUOTED tag whose body contains $(...) or a backtick
//     -> null, same reason (an unquoted tag expands the body)
// NOTE ON THE SHAPE OF THIS FIX. The first attempt made the SEGMENTER
// quote-aware and left the regexes alone. It failed one corpus case:
//   echo 'grep: foo <bar> crontab <bar> bar'
// stayed denied, because SCHEDULER_RX carries its OWN boundary anchor
// (SCHED_BOUNDARY includes the bar), so it re-finds a command position INSIDE a
// segment. Keeping the quoted text in the segment at all was the mistake. The
// `launchctl` cases passed only by luck -- LAUNCHCTL_SUBCOMMAND's lookahead
// happened to reject the following bar. So the primitive is not "split more
// carefully", it is "the inert text must not be there": mask it out, then let
// the existing splitter and regexes run unchanged on what remains.
export function maskInertLiterals(command) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  let cur = ''
  let i = 0

  // Inert regions collapse to spaces: the text is gone, and with it every
  // separator inside it -- which is precisely what prose was faking.
  const blank = (s) => ' '.repeat(s.length)

  while (i < src.length) {
    const c = src[i]

    // backslash escape outside quotes: consumes the next character
    if (c === '\\' && i + 1 < src.length) { cur += src.slice(i, i + 2); i += 2; continue }

    // heredoc: <<TAG / <<-TAG / <<'TAG' / <<"TAG"
    const here = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(src.slice(i))
    if (here) {
      const tag = here[1] ?? here[2] ?? here[3]
      const quotedTag = here[1] != null || here[2] != null
      cur += here[0]
      i += here[0].length
      // the body starts after the rest of THIS line
      const nl = src.indexOf('\n', i)
      if (nl === -1) return null // heredoc announced but no body -> cannot resolve
      cur += src.slice(i, nl + 1)
      i = nl + 1
      // find the terminator line (leading tabs allowed for <<-)
      const endRx = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
      const rel = endRx.exec(src.slice(i))
      if (!rel) return null // unterminated heredoc
      const body = src.slice(i, i + rel.index)
      if (!quotedTag && /\$\(|`/.test(body)) return null // unquoted tag expands the body
      cur += blank(body) + rel[0]
      i += rel.index + rel[0].length
      continue
    }

    if (c === "'") { // literal until the next ' -- a backslash is NOT special here
      const end = src.indexOf("'", i + 1)
      if (end === -1) return null
      cur += blank(src.slice(i, end + 1)); i = end + 1; continue
    }

    if (c === '$' && src[i + 1] === "'") { // ANSI-C: \' does escape
      let j = i + 2
      while (j < src.length && src[j] !== "'") { j += src[j] === '\\' ? 2 : 1 }
      if (j >= src.length) return null
      cur += blank(src.slice(i, j + 1)); i = j + 1; continue
    }

    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') { j += src[j] === '\\' ? 2 : 1 }
      if (j >= src.length) return null
      const inner = src.slice(i + 1, j)
      if (/\$\(|`/.test(inner)) return null // may run a command -> not inert
      cur += blank(src.slice(i, j + 1)); i = j + 1; continue
    }

    cur += c; i++
  }
  return cur
}

// Collects the text of every heredoc BODY in the command (card 46c4ad4a, Cybered's finding on
// 4638c14c). maskInertLiterals above blanks these to nothing FOR THE ANCHORED SCHEDULER CHECK --
// this is the counterpart that surfaces them instead, for the UNANCHORED scheduler scan
// specifically (see its call site). Mirrors maskInertLiterals' own heredoc-tag matching (this
// file already accepts each function having its own narrowly-scoped heredoc walk -- see
// stripHeredocDataPayloads below -- rather than a shared state machine multiple call sites would
// have to agree on). Best-effort: an unterminated heredoc or one with no body yet simply stops
// collecting further bodies, matching this file's fail-open-on-parse, fail-closed-on-content
// stance (the naive/anchored checks elsewhere still cover whatever this could not resolve).
export function extractHeredocBodies(command) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  const bodies = []
  let i = 0
  while (i < src.length) {
    const here = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(src.slice(i))
    if (!here) { i++; continue }
    const tag = here[1] ?? here[2] ?? here[3]
    i += here[0].length
    const nl = src.indexOf('\n', i)
    if (nl === -1) break // heredoc announced but no body yet
    i = nl + 1
    const endRx = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
    const rel = endRx.exec(src.slice(i))
    if (!rel) break // unterminated
    bodies.push(src.slice(i, i + rel.index))
    i += rel.index + rel[0].length
  }
  return bodies
}

// Blank out curl/HTTP DATA-PAYLOAD arguments before self-pace matching. A -d /
// --data body is data sent over the wire, NEVER a shell invocation, so a trigger
// token that only appears INSIDE the payload must not false-deny. The classic
// false-positive: an /api/messages inter-agent dispatch (a legit peer message in
// a green, operator-authorised review-loop) whose JSON body happens to mention
// "/api/schedules", "tmux send-keys", "scheduled_tasks.json" or "/loop" -- pure
// text, not an invocation. Only PROVABLY-LITERAL payloads are stripped:
// single-quoted '...', ANSI-C $'...', and double-quoted "..." WITHOUT
// $(...)/backtick. A payload that can run a command substitution (double-quoted
// with $(...) / backticks) is left intact so a real command-substitution payload
// is not blanked. Such a payload is then still denied by SCHEDULER_RX, whose
// boundary anchor recognises both `$(` and the backtick as a command boundary,
// so a scheduler binary inside either substitution form is caught. The data FLAG
// itself is kept, so HTTP-write detection (-d /
// --data) is unchanged; the URL and method args live OUTSIDE the payload, so a
// real WRITE to /api/schedules is still denied.
//
// Quote classes match BASH parsing, not C. Inside a plain '...' a backslash is
// LITERAL and the FIRST following ' always closes the string, so the class is
// '[^']*'. A C-style '(?:[^'\\]|\\.)*' would treat \' as an escaped quote and
// scan PAST bash's real closing quote -- e.g. `curl -d 'x\' ; crontab -r` would
// blank the out-of-band `; crontab -r` and let a real self-pace command slip.
// ANSI-C $'...' DOES process \', so that branch keeps the \\. escape form; "..."
// keeps it too (backslash is special inside bash double quotes).
export function stripDataPayloads(seg) {
  return String(seg ?? '').replace(
    /((?:^|\s)(?:-d|--data(?:-(?:raw|binary|ascii|urlencode))?)(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi,
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full // may substitute -> keep
      return flag + (dq ? '""' : "''") // literal payload -> blank the content
    },
  )
}

// Blank a heredoc body that feeds curl's OWN `-d @-` / `--data-binary @-` stdin-read
// (card ce159d2b's sibling, 4638c14c; incidents msg 8746/8796/8881 -- three denials in
// one day, all mid security-report). The fleet builds long, accented JSON payloads with
// `python3 - <<'PY' | curl ... -d @- ...` to dodge curl's own UTF-8/quoting traps
// (stripDataPayloads' own header names this exact gap: exempted for `-d '...'`, not for
// a payload PRODUCED via heredoc). splitSegments splits on bare newlines, so each LINE
// of the heredoc body becomes its own "segment" before any of this runs -- a report
// LINE that merely mentions "tmux send-keys" as prose reads as a real invocation.
//
// WHY THIS IS SAFE WHERE maskInertLiterals' heredoc-blanking deliberately is NOT
// (see that function's header, "founding incident" 2026-08-05): its blanking is scoped
// OFF the unanchored checks on purpose, because a heredoc feeding an INTERPRETER
// (`python3 -`, `bash`, `sh`) is CODE -- a real `subprocess.run(['tmux','send-keys'])`
// can hide inside it, indistinguishable by text alone from an inert string literal.
// This function does the opposite of "exempt heredocs generally": it ONLY blanks a
// heredoc whose OWN redirect feeds curl's `-d @-`-shaped stdin-read, i.e. a heredoc
// curl reads and SENDS as HTTP body bytes -- curl never executes what it is given as
// -d/--data, so there is no code path through this heredoc that could run tmux/cron/
// claude at all. A `python3 - <<PY ... PY | curl -d @-` PIPELINE is NOT this shape --
// python3, not curl, reads that heredoc as its OWN program, so it stays fully scanned
// (unfixed, on purpose; flagged in the card's REVIEW rather than guessed at).
//
// PER-HEREDOC, NOT WHOLE-COMMAND: the check is scoped to the text SINCE THE LAST
// command boundary (`;`, `&`, `|`, or a bare newline -- the same separators
// splitSegments treats as boundaries), not "does -d @- appear ANYWHERE in the
// command". A whole-command check would ALSO blank the python3-heredoc-piped-into-
// curl shape above (curl's `-d @-` sits AFTER the pipe, so it technically appears in
// the same command STRING) -- exactly the interpreter-executed heredoc this function
// must NOT touch. Scoping to "since the last boundary" means a preceding `python3 -`
// with no `-d @-` in ITS OWN span leaves that heredoc fully exposed to the scan,
// while `curl ... -d @- <<TAG` (same simple command, no boundary in between) blanks.
//
// SECURITY REGRESSION FOUND BY CYBERSEC BEFORE LANDING (card 4638c14c, NO-GO on
// commit 3e5fe07, fixed here): the boundary span was checked ONLY for the `-d @-`
// FLAG SHAPE, never for the simple command actually BEING curl. `python3 - -d @-
// <<'PY' ... PY` has "-d @-" sitting in python3's own (ignored) argv, matched
// CURL_STDIN_DATA_RX, and blanked a heredoc body that python3 -- not curl --
// genuinely EXECUTES as a program, hiding a real tmux/scheduler call from the
// unanchored scan (deny:false on a live payload proving it). CURL_LEADING_RX now
// pins the span's OWN leading binary to curl (mirroring SCHED_PREFIX's wrapper
// handling below, so `sudo curl ...` / `env curl ...` / `/usr/bin/curl ...` still
// count); `feedsCurlStdin` requires BOTH the leading-curl match AND the flag shape,
// so a decoy `-d @-` sitting in some OTHER binary's own argv can no longer curl-y
// launder a heredoc it does not read as its data.
const CURL_LEADING_RX = new RegExp(
  String.raw`^\s*(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*${PATH_PREFIX}curl\b`,
  'i',
)
const CURL_STDIN_DATA_RX = /(?:^|\s)(?:-d|--data(?:-(?:raw|binary|ascii))?)(?:\s+|=)@-(?=\s|$)/i
// SECOND STDIN-DATA SHAPE: `git commit -F -` (card 0229c844). Same class as curl's `-d @-`, found
// the same way -- twice, mid-report: a commit message that DESCRIBED a scheduling primitive was
// denied, while the identical text passed once written to a file and given as `-F <file>`. Which
// way an agent chooses to hand git its message had become a security decision, and the workaround
// (write the prose to a temp file first) makes the record no safer, only more roundabout.
//
// Safe for exactly the reason the curl branch is: git reads these bytes as a MESSAGE and never
// executes them. `git commit -F -` cannot run tmux/cron/claude no matter what the body says, so
// blanking removes no detection -- unlike a heredoc feeding python3/bash, which stays fully scanned.
// The same three guards still apply and are the load-bearing part: the span's OWN leading binary
// must be git (a decoy `-F -` in some other argv launders nothing, per Cybersec's 4638c14c
// finding), the subcommand must be one that takes a message file, and an unquoted tag whose body
// can command-substitute is left intact because bash expands it before git ever sees it.
const GIT_LEADING_RX = new RegExp(
  String.raw`^\s*(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*${PATH_PREFIX}git\b`,
  'i',
)
// commit/tag/notes are the subcommands that read a message from a file; `-F` means something else
// entirely elsewhere in git (e.g. `git branch -F` does not exist, but `git grep -F` is fixed-string
// matching), so the subcommand check is what keeps this from becoming a general `-F -` exemption.
const GIT_MSG_SUBCMD_RX = /(?:^|\s)(?:commit|tag|notes)(?:\s|$)/i
// -F-, -F -, --file -, --file=-
const GIT_STDIN_MSG_RX = /(?:^|\s)(?:-F\s*-|--file(?:\s+|=)-)(?=\s|$)/
// Skip a balanced parenthesised run starting AT `start` (which must index a `(`), returning the
// index just past its matching `)`. Quoting is honoured, because a `)` inside '...' closes nothing.
// Used by the two constructs the walker consumes WHOLE rather than treating as command contexts.
function skipBalancedParens(src, start) {
  let j = start
  let depth = 0
  while (j < src.length) {
    const ch = src[j]
    if (ch === '\\') { j += 2; continue }
    if (ch === "'") { const k = src.indexOf("'", j + 1); j = k === -1 ? src.length : k + 1; continue }
    if (ch === '(') { depth++; j++; continue }
    if (ch === ')') { depth--; j++; if (depth === 0) return j; continue }
    j++
  }
  return src.length
}

// Skip a `${ ... }` PARAMETER EXPANSION whole, returning the index just past its closing `}`.
// Cybered's sixth-round finding: the walker gained quoting awareness but not bash-grammar awareness,
// and a parameter expansion may carry an UNQUOTED `)` in its default or replacement part
// (`${x:-)}`, `${x/a/)}`) -- which the walker then read as a closer and used to pop a frame bash
// never opened, dropping the boundary back onto the outer curl. All three reported shapes were
// measured executing from inside the blanked body.
//
// Nesting is depth-handled rather than "to the first `}`", because `${x:-$(true))}` puts a REAL
// substitution inside the braces: that `$( )` still has to be consumed as a unit, while the brace's
// OWN `)` must not pop anything. Ending this scan too LATE is fail-closed (a heredoc inside the
// braces is then simply left scanned); ending too EARLY is the bug being fixed, so every construct
// that can carry a `}` is skipped rather than counted through.
function skipParamExpansion(src, start) {
  let j = start + 2 // past `${`
  let depth = 1
  while (j < src.length) {
    const ch = src[j]
    if (ch === '\\') { j += 2; continue }
    if (ch === "'") { const k = src.indexOf("'", j + 1); j = k === -1 ? src.length : k + 1; continue }
    if (ch === '`') { const k = src.indexOf('`', j + 1); j = k === -1 ? src.length : k + 1; continue }
    if (ch === '$' && src[j + 1] === '{') { depth++; j += 2; continue }
    if (ch === '$' && src[j + 1] === '(') { j = skipBalancedParens(src, j + 1); continue }
    if (ch === '}') { depth--; j++; if (depth === 0) return j; continue }
    j++
  }
  return src.length
}

// `case`, `in` and `esac` are RESERVED WORDS, and a case PATTERN's `)` is a separator, not a
// closer (Cybersec F-8). Recognition has to be strict rather than generous: over-recognising the
// keyword is NOT fail-closed, because the pattern rule moves the boundary FORWARD, and an attacker
// who gets a fake pattern recognised gets to choose where the next span starts. `python3 - $(: case
// in x) curl -d @- <<'PY'` is a real bash command where `case` is an argument to `:` -- treating it
// as the keyword would blank a body python3 owns. So the keyword counts only in COMMAND POSITION.
const CASE_KEYWORD_RX = /^(?:case|in|esac)(?![\w-])/
// Everything that may stand between the START of a simple command and the command itself. Bash runs
// the command AFTER these, so the span a heredoc is measured over starts past them. This is also what
// makes the command-position test above work after `then`/`do`, and it removes a standing false
// positive: `for f in a b; do curl ... -d @- <<'JSON'` measured its span from `do`, failed the
// leading-binary check, and denied a legitimate payload. `for`/`select`/`case` are NOT here: the word
// after those is a variable name or a subject, not a command.
//
// ONE alternation on purpose. Cybered's round-9 NO-GO found `coproc` and `function NAME` missing from
// the earlier keyword-only list, and measurement on top of that report found eight more live shapes in
// the same family -- all of them the same idea ("what establishes command position") kept in a second
// place. The set below is enumerated from the BASH GRAMMAR and each member was validated with `bash -n`;
// the words that FEEL like they belong but are not reserved (`sudo`, `command`, `exec`, `env`, `nice`,
// a `FOO=1` assignment, a leading redirection) are all syntax errors in front of a compound command, so
// they are deliberately absent -- a walker ALLOW on a string bash refuses to parse is not a bypass.
//
// Over-recognition here is NOT fail-closed: the rule moves the boundary FORWARD, so a forged member
// would let an attacker choose where the next simple command starts. Hence every alternative is
// anchored at command position by the caller, and the two that can swallow a following WORD are
// pinned to bash's own rule for when that word is a name rather than the command:
//
//   * `coproc [NAME] command` -- NAME is a name only when a COMPOUND command follows it. In
//     `coproc python3 curl -d @- <<'PY'` the command is SIMPLE, so bash takes `python3` as the command
//     word; consuming it as a name would hand the span to the curl standing behind it and blank a body
//     python3 runs.
//   * `function NAME [()]` / the POSIX `NAME ()` form -- both require the compound-command opener
//     (`{` or `(`) to actually be there. `{` was already listed, but the `function NAME ` in front of it
//     left the boundary un-advanced, so the `{` itself then failed the command-position test.
//
// A function BODY, and the command after `coproc [NAME]`, are the SAME production in bash's grammar
// (parse.y `shell_command`): a COMPOUND command, never a simple one. That set is written once, below,
// and reused by all three alternatives that need it -- the first draft of this fix listed only `{`
// and `(`, the two forms one actually writes, and mutation testing separated it immediately:
// `f() case x in x) python3 <<'PY' ... esac` and `function f case ...` are valid definitions whose
// body IS the case statement, so the walker still lost the boundary on both. The members below come
// from the production and each was validated with `bash -n`; `function` is NOT among them (a nested
// definition is a syntax error there), and neither is a simple command -- which is exactly what makes
// `coproc python3 curl -d @- <<'PY'` a coproc with NO name, leaving python3 as the command word.
//
// MEASURED, so the list is not mistaken for one that is fully pinned: only `{` and `case` change any
// verdict today. Mutation testing killed those two and left `(`, `[[`, `if`, `while`, `until`, `for`
// and `select` alive, and a 11232-shape differential sweep found ZERO valid-bash disagreements for
// each -- because every one of them reaches the inner command through a path that already resets the
// boundary (`(` opens a frame of its own; the loops and conditionals carry their own `; do` / `; then`;
// `[[ ]]` cannot contain a heredoc). The same sweep finds 65 / 26 / 42 disagreements when `case`, `{`
// or the whole coproc alternative is removed, so it is not a sweep that cannot detect. They stay in
// the list anyway: it is the grammar's production, and trimming it to whatever the walker happens to
// need today is how the round-9 finding got in.
const COMPOUND_OPENER = String.raw`(?:\{|\(|\[\[|(?:case|if|while|until|for|select)(?![\w-]))`
// The NAME slot -- for both function-definition syntaxes and for `coproc`.
//
// This started as a character class and was wrong three rounds running, each time on a different
// axis: identifier-only (round 10, `deploy-prod` and 24 others live), then the metacharacter set
// (`f{g`), then quoting (`coproc f""`). The reason it kept being wrong is that a bash WORD is not a
// character class at all. It is a sequence of runs, and four of those runs NEST: `$( )`, `${ }`,
// `$(( ))` and backticks. Cybersec reported 4 live shapes here; measuring the space found 10, and 6
// of them -- `f$(y $(z))`, `f$(echo $(echo))`, `` f$(echo `g`) ``, `` f`echo $(y)` ``, `f${u:-$(y)}`,
// `f$((0))` -- are out of reach of ANY single-level regex, which is what a wider character class
// would have been.
//
// So it is a scanner, reusing the depth-correct helpers this file already has for exactly these
// constructs. Ending the scan too LATE is the fail-closed direction here (the boundary lands further
// into the command, so the span starts at something that is not the outer curl); ending too EARLY is
// the bug, because the boundary then never leaves the NAME and the `case` behind it stops counting
// as command position.
//
// WHY THE NAME MATTERS AT ALL, given bash rejects most of these as identifiers: `coproc` validates
// its NAME after EXPANSION and quote removal, so `coproc f$(y) { ... }` really does start a coproc
// called `f`. The function forms do not expand (`f$(y)() { ... }` is "not a valid identifier"), but
// they share the scanner anyway -- one slot, one reader. Consuming a word bash then rejects costs
// nothing: that command does not run, so there is no payload to blank.
function scanBashWord(src, start) {
  let j = start
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') { j += 2; continue }
    if (c === "'") { const k = src.indexOf("'", j + 1); if (k === -1) return -1; j = k + 1; continue }
    if (c === '"') {
      j++
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      if (j >= src.length) return -1
      j++
      continue
    }
    if (c === '`') { const k = src.indexOf('`', j + 1); if (k === -1) return -1; j = k + 1; continue }
    // `$((`, `$(` and `${` all nest, and all three already have a depth-correct reader here.
    if (c === '$' && src[j + 1] === '(') { j = skipBalancedParens(src, j + 1); continue }
    if (c === '$' && src[j + 1] === '{') { j = skipParamExpansion(src, j); continue }
    // Bash METACHARACTERS are the only characters that end a word. `{` and `}` are not among them --
    // they are reserved words only when they stand alone -- which is why `f{g` is a legal name.
    if (c === ' ' || c === '\t' || c === '\n' || c === '|' || c === '&' || c === ';' ||
        c === '(' || c === ')' || c === '<' || c === '>') break
    j++
  }
  return j > start ? j : -1
}
const CMD_PREFIX_KEYWORD_RX = new RegExp(
  '^(?:' +
    String.raw`(?:if|then|elif|else|while|until|do|!|\{)(?=\s|$)` +
    String.raw`|time(?:[ \t]+-p)?(?:[ \t]+--)?(?=\s|$)` +
    String.raw`|coproc(?=\s|$)` +
    ')',
)
const COMPOUND_OPENER_RX = new RegExp('^' + COMPOUND_OPENER)
const WS_RX = /^[ \t]*/

// How far past `src[i]` the CURRENT simple command's prefix reaches, or -1 for "no prefix here".
// Three of the forms take a NAME, and a NAME needs the scanner rather than a class -- see above.
function matchCmdPrefix(src, i) {
  const rest = src.slice(i)
  const kw = CMD_PREFIX_KEYWORD_RX.exec(rest)
  if (kw) {
    let end = i + kw[0].length
    // `coproc [NAME] command`. The NAME is a name only when a COMPOUND command follows it: in
    // `coproc python3 curl -d @- <<'PY'` the command is SIMPLE, so bash takes `python3` as the
    // command word, and consuming it would hand the span to the curl standing behind it.
    if (kw[0] === 'coproc') {
      const ws = WS_RX.exec(src.slice(end))[0].length
      const w = ws > 0 ? scanBashWord(src, end + ws) : -1
      if (w !== -1) {
        const ws2 = WS_RX.exec(src.slice(w))[0].length
        if (ws2 > 0 && COMPOUND_OPENER_RX.test(src.slice(w + ws2))) end = w
      }
    }
    return end
  }
  // `function NAME [()] compound-command`
  const fkw = /^function[ \t]+/.exec(rest)
  if (fkw) {
    const w = scanBashWord(src, i + fkw[0].length)
    if (w !== -1) {
      const after = withOptionalEmptyParens(src, w)
      if (after !== -1) return after
    }
    return -1
  }
  // The POSIX `NAME () compound-command` form, with no `function` keyword.
  const w = scanBashWord(src, i)
  if (w !== -1 && w > i) {
    const after = withOptionalEmptyParens(src, w, true)
    if (after !== -1) return after
  }
  return -1
}

// Past optional whitespace, an optional `()`, and more whitespace -- provided a compound-command
// opener really stands there. `requireParens` is what separates the POSIX form (where the `()` IS
// the syntax) from the `function` keyword form (where it is decoration).
function withOptionalEmptyParens(src, j, requireParens = false) {
  let k = j + WS_RX.exec(src.slice(j))[0].length
  let sawParens = false
  if (src[k] === '(' && src[k + 1] === ')') { k += 2; sawParens = true }
  if (requireParens && !sawParens) return -1
  k += WS_RX.exec(src.slice(k))[0].length
  return COMPOUND_OPENER_RX.test(src.slice(k)) ? k : -1
}
// A word starts here only after whitespace, a separator, or an opener.
const WORD_START_RX = /[\s;&|()`]/

export function stripHeredocDataPayloads(command) {
  const src = String(command ?? '')
  // Computed ONCE per call, not per heredoc: the parse is the expensive half (~8 ms p50 over the
  // current gate) and the answer covers every heredoc in the command at once.
  const mode = astMode()
  const astSpans = mode === 'off' ? null : heredocOwnerSpans(src)
  let out = ''
  let i = 0
  let boundary = 0 // index where the CURRENT simple command started
  // Bash QUOTING state for the context being walked: null (unquoted), "'", '"', or "$'"
  // (ANSI-C). A walker that tracks parentheses but not quoting disagrees with bash exactly
  // where the attacker gets to choose the shape -- see F-5 below.
  let quote = null
  // One frame per OPEN nested command context. A `$( )` / `<( )` / `>( )` / backtick starts a
  // new simple command AND a fresh quoting context inside it, and its CLOSE returns to both --
  // so the outer boundary and the outer quote have to be remembered, not recomputed. See the
  // findings below.
  const nestStack = []
  // One entry per OPEN `case` statement, innermost last: `state` is where in the statement we are
  // ('in' = the `case WORD` part, 'pattern' = a pattern is being read, 'body' = an arm body),
  // `base` is the nesting depth the statement lives at (so a `;` or a `)` inside a `$( )` in an arm
  // body cannot be mistaken for the arm's own), and `start` is where the current pattern began (so
  // the `(` of the `(pattern)` form can be told from the `(` of an extglob `@(a|b)`).
  const caseStack = []
  while (i < src.length) {
    const c = src[i]
    // A NESTED COMMAND CONTEXT STARTS A NEW SIMPLE COMMAND, AND ITS CLOSE ENDS IT. Three NO-GOs
    // on card 84e31b40, from three different sides of this same boundary:
    //
    //  * Cybered (F-1): stepping only at `;`/`&`/`|`/newline let an INNER interpreter's heredoc
    //    measure its span from the OUTER curl -- `curl ... -d @- "$(python3 <<'PY' ... PY)"` --
    //    so the body was blanked while bash genuinely ran it (proven by a marker file written
    //    from inside the blanked region).
    //
    //  * Cybersec (F-2): the first fix stepped at the OPENERS only, on the claim that a heredoc
    //    after a substitution "fails the leading-binary check, never a bypass". That claim was
    //    wrong. The span then starts INSIDE the substitution, so if the substitution itself
    //    begins with curl -- `python3 $(curl -d @- http://x) <<'PY'` -- it passes both ownership
    //    checks and the OUTER interpreter's heredoc is blanked. Measured: `$( )`, `<( )` and
    //    `>( )` all flipped to allow; backticks stayed denied only by accident, because a closing
    //    backtick re-matches the opener pattern.
    //
    //    Stepping at the closers (the one-line fix proposed with that finding) closes all four,
    //    but measurement showed it trades them for a new one: `python3 $()curl -d @- <<'PY'` puts
    //    curl at the start of a span that begins just after `)`, while bash's argv is
    //    [python3, curl, -d, @-] and python3 executes the heredoc. RESTORING the saved outer
    //    boundary closes that too, and additionally keeps a legitimate payload whose command
    //    merely CONTAINS a substitution (`curl -H "Authorization: Bearer $(cat tok)" -d @-
    //    <<'JSON'`) on the allow side, which closer-stepping turns into a false positive.
    //
    //  * Cybered (F-5): the saved-boundary stack was a PURE PARENTHESIS COUNTER. Bash is not: a
    //    quoted `)` is a literal, and `$(( ))` is arithmetic whose second `)` closes nothing.
    //    Both make the stack pop a frame bash never opened, dropping the boundary back onto the
    //    OUTER curl while the heredoc still belongs to the INNER interpreter --
    //    `curl ... -d @- $(python3 - "a)b" <<'PY' ... PY)` and the `$((1+1))` variant were both
    //    measured executing from inside a blanked body. A quoted `)` is not an exotic shape: a
    //    regex, a sentence, a `print('a)b')` all contain one. So the walker now tracks quoting
    //    the way bash does -- inside '...' nothing is live at all, inside "..." only
    //    substitutions are -- and skips `$(( ))` whole.
    //
    // Backslash handling falls out of the same requirement: `\$(` looks like an opener and never
    // opens one (Cybersec S5), and `\<newline>` is a line continuation, not a command boundary.
    if (c === '\\') {
      if (quote === "'") { out += c; i++; continue } // literal inside single quotes
      out += src.slice(i, i + 2); i += 2; continue
    }
    // Inside '...' and $'...' NOTHING is live: not `)`, not a backtick, not a separator.
    if (quote === "'" || quote === "$'") {
      out += c; i++
      if (c === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (c === '"') { out += c; i++; quote = null; continue }
      // inside "..." only substitutions stay live -- fall through to those checks
    } else {
      if (c === "'") { out += c; i++; quote = "'"; continue }
      if (c === '"') { out += c; i++; quote = '"'; continue }
      if (c === '$' && src[i + 1] === "'") { out += "$'"; i += 2; quote = "$'"; continue }
    }
    // BASH GRAMMAR: RESERVED WORDS. `curl ... -d @- $(case x in x) python3 <<'PY' ... PY ;; esac)`
    // had the case PATTERN's `)` pop the frame `$(` opened, handing the boundary back to the OUTER
    // curl while bash gave the heredoc to python3 (Cybersec F-8) -- the same miscount as F-5/F-6/F-7,
    // reached through a third construct, and measured executing from inside the blanked body.
    // Measurement on top of the reported shape found four more live ones in the same family
    // (alternation `a|x)`, extglob `@(a|x))`, a nested `case`, and a newline between `in` and the
    // pattern), plus two that only reach the keyword through another reserved word (`then`, `do`).
    if (quote === null && (i === 0 || WORD_START_RX.test(src[i - 1]))) {
      const rest = src.slice(i)
      const kw = CASE_KEYWORD_RX.exec(rest)
      const ct = caseStack[caseStack.length - 1]
      if (kw && kw[0] === 'in') {
        // `in` closes the `case WORD` part. Gated on the state, not on position, so the `in` of a
        // `for`/`select` header cannot start a pattern.
        if (ct && ct.state === 'in') { ct.state = 'pattern'; ct.base = nestStack.length; ct.start = i + 2 }
      } else if (src.slice(boundary, i).trim() === '') {
        if (kw && kw[0] === 'case') caseStack.push({ state: 'in', base: nestStack.length, start: i })
        else if (kw && kw[0] === 'esac') { if (caseStack.length) caseStack.pop() }
        else {
          const pre = matchCmdPrefix(src, i)
          if (pre !== -1) boundary = pre
        }
      }
    }
    // `$(( ... ))` is ARITHMETIC, not a command context. Consume it whole so its closing `))`
    // cannot pop a frame it never pushed (Cybered N2, Cybersec S1).
    if (c === '$' && src[i + 1] === '(' && src[i + 2] === '(') {
      const j = skipBalancedParens(src, i + 1)
      out += src.slice(i, j); i = j; continue
    }
    // `${ ... }` is a PARAMETER EXPANSION, not a command context either, and its default/replace
    // part may carry an unquoted `)` (Cybered F-7). Consume it whole, at any quoting level -- it is
    // a pure text skip, so it cannot move the boundary or the stack.
    if (c === '$' && src[i + 1] === '{') {
      const j = skipParamExpansion(src, i)
      out += src.slice(i, j); i = j; continue
    }
    // Command separators separate only OUTSIDE quotes -- a `;` or a newline inside "..." is text.
    if (quote === null && (c === ';' || c === '&' || c === '|' || c === '\n')) {
      out += c; i++; boundary = i
      // `;;`, `;&` and `;;&` end a case ARM, so what follows is a pattern again. Only at the case's
      // OWN nesting depth: a `;` inside a `$( )` in the arm body belongs to that substitution, and
      // treating it as an arm terminator would make the substitution's closing `)` look like a
      // pattern terminator -- which would leave a legitimate `curl -H "X: $(case y in a) date; echo
      // 1 ;; esac)" -d @- <<'JSON'` measuring its span from the wrong place.
      const ct = caseStack[caseStack.length - 1]
      if (c === ';' && ct && ct.state === 'body' && nestStack.length === ct.base) {
        ct.state = 'pattern'; ct.start = i
      }
      continue
    }
    if (c === '`') {
      out += c; i++
      // One character, two meanings: it closes the context it opened, otherwise it opens one.
      const top = nestStack[nestStack.length - 1]
      if (top && top.tick) {
        nestStack.pop(); boundary = top.at; quote = top.quote; caseStack.length = top.caseDepth
      } else {
        nestStack.push({ at: boundary, quote, tick: true, caseDepth: caseStack.length })
        boundary = i; quote = null
      }
      continue
    }
    if (c === ')' && quote === null) {
      const ct = caseStack[caseStack.length - 1]
      // The `)` that ENDS A PATTERN closes nothing -- it separates the pattern from the arm body,
      // which is a new simple command. Popping here is the F-8 bug.
      if (ct && ct.state === 'pattern' && nestStack.length === ct.base) {
        out += c; i++; ct.state = 'body'; boundary = i; continue
      }
      if (nestStack.length && !nestStack[nestStack.length - 1].tick) {
        out += c; i++
        const frame = nestStack.pop()
        boundary = frame.at; quote = frame.quote; caseStack.length = frame.caseDepth
        continue
      }
    }
    // Process substitution does not happen inside double quotes; command substitution does. A BARE
    // `(` is a subshell -- a command context bash opens just like the others (Cybersec F-6): before
    // this, its `)` popped a frame it had never pushed, so `$(python3 - $( (:) ) <<'PY' ... PY )`
    // handed the boundary back to the outer curl and blanked a body bash ran. Unquoted `(` cannot
    // appear as ordinary argument text in bash (it is a syntax error), so opening a frame for it
    // costs no legitimate shape: an array assignment, a function header and a subshell all balance,
    // and a balanced frame restores exactly the boundary it saved.
    const nested = (quote === '"' ? /^\$\(/ : /^(?:\$\(|<\(|>\(|\()/).exec(src.slice(i))
    if (nested) {
      const ct = caseStack[caseStack.length - 1]
      // `case x in (a) ...` -- the `(` that OPENS a pattern is grammar, not a subshell, so it must
      // not push a frame its `)` would then have to pop. Only the opener: an extglob `@(a|b)` INSIDE
      // a pattern still balances as a frame, which is what keeps `@(a|x))` from losing one `)`.
      if (nested[0] === '(' && ct && ct.state === 'pattern' && nestStack.length === ct.base &&
          src.slice(ct.start, i).replace(/[;&\s]/g, '') === '') {
        out += '('; i++; continue
      }
      nestStack.push({ at: boundary, quote, tick: false, caseDepth: caseStack.length })
      out += nested[0]; i += nested[0].length; boundary = i; quote = null
      continue
    }
    // A heredoc redirect is a redirect only outside quotes; inside a string `<<TAG` is text.
    const here =
      quote === null ? /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(src.slice(i)) : null
    if (!here) { out += c; i++; continue }
    const span = src.slice(boundary, i)
    // DARK LAUNCH (card f16b3165, plan-grilling change 3). `span` above is this walker's answer to
    // "which simple command owns this heredoc"; astSpans holds tree-sitter-bash's answer to the
    // same question. Both are computed, the two DECISIONS are compared, and any disagreement is
    // recorded -- but the walker still drives behaviour unless SELF_PACE_AST=on. The ownership
    // CHECKS below are shared by both paths and are not touched: only the span they read changes.
    // The AST supplies only the BOUNDARY; the span is sliced from the same source, the same way,
    // so both recognisers hand the checks below identical units.
    const astBoundary = astSpans === null ? undefined : astSpans.get(i)
    const astSpan = astBoundary === undefined ? null : src.slice(astBoundary, i)
    const decide = (s) => {
      const curl = CURL_LEADING_RX.test(s) && CURL_STDIN_DATA_RX.test(s)
      const git = GIT_LEADING_RX.test(s) && GIT_MSG_SUBCMD_RX.test(s) && GIT_STDIN_MSG_RX.test(s)
      return curl || git
    }
    const walkerSays = decide(span)
    // An absent key is a real answer from a successful parse ("no heredoc owner here"), which for
    // these checks is indistinguishable from an empty span -- both decide false.
    const astSays = astSpans === null ? null : decide(astSpan ?? '')
    if (astSays !== null && astSays !== walkerSays) recordAstDivergence(src, span, astSpan ?? '', walkerSays, astSays)
    // Fail-closed cutover: the AST answer is only allowed to drive when it EXISTS. A null (absent
    // dependency, oversized input, parse error) keeps the current behaviour rather than defaulting
    // to "not an exempt payload", which would turn every parser hiccup into a false deny.
    const feedsStdinData = mode === 'on' && astSays !== null ? astSays : walkerSays
    const tag = here[1] ?? here[2] ?? here[3]
    const quotedTag = here[1] != null || here[2] != null
    out += here[0]
    i += here[0].length
    const nl = src.indexOf('\n', i)
    if (nl === -1) { out += src.slice(i); break } // heredoc announced, no body yet -- leave as-is
    out += src.slice(i, nl + 1)
    i = nl + 1
    const endRx = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
    const rel = endRx.exec(src.slice(i))
    if (!rel) { out += src.slice(i); break } // unterminated -- leave as-is, naive scan still covers it
    const body = src.slice(i, i + rel.index)
    // unquoted tag -> bash itself expands $(...)/backtick in the body BEFORE curl ever
    // sees it, so a real command could run there regardless of curl's own semantics --
    // same fail-closed rule maskInertLiterals uses, for the same reason.
    const substitutable = !quotedTag && /\$\(|`/.test(body)
    if (feedsStdinData && !substitutable) out += ' '.repeat(body.length)
    else out += body
    out += rel[0]
    i += rel.index + rel[0].length
    boundary = i
  }
  return out
}

// Blank out git commit/tag/stash -m/--message LITERAL text before self-pace
// matching. A commit message is prose, NEVER a shell invocation, so a trigger
// token that only appears INSIDE the message must not false-deny (2026-07-13,
// DrCode: a long `git commit -m "...batch...; at..."` blocked twice, the short
// one passed -- the message text was split as shell segments). Same principle
// and same literal-only quote handling as stripDataPayloads: single-quoted,
// ANSI-C $'...', and double-quoted WITHOUT $(...)/backtick are blanked; a
// double-quoted message that CAN command-substitute (`git commit -m "$(crontab
// -r)"`) is left intact so SCHEDULER_RX still catches the real substitution.
// Scoped to git commit/tag/stash so a `-m` on an unrelated binary is untouched.
export function stripGitCommitMessages(command) {
  const cmd = String(command ?? '')
  if (!/\bgit\b[\s\S]*\b(commit|tag|stash)\b/i.test(cmd)) return cmd
  return cmd.replace(
    /((?:^|\s)(?:-m|--message)(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi,
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full // may substitute -> keep
      return flag + (dq ? '""' : "''") // literal message -> blank the content
    },
  )
}

// Normalise two shell-level obfuscations that bash resolves at EXEC time, so an
// invocation whose SHAPE is a real self-pace cannot dodge the slash-command match
// with quoting the shell undoes anyway. Measured end-to-end through the gate hook
// (upstream review, 2026-07-27): `claude \/loop` and `claude$IFS/loop` BOTH run
// `claude /loop` in bash but slipped the `(?:^|[\s'"])\/loop` match -- the char
// before `/loop` was `\` and `S` (end of `$IFS`), neither in the [\s'"] class.
// The fix is NOT to widen that class (that would let more prose through); it is to
// resolve what the shell resolves before matching: `$IFS`/`${IFS}` word-splits to
// a space, and a backslash escape `\X` collapses to `X`. Side effect: also closes
// `claude /lo\op`. Applied ONLY to the self-pace bash patterns below; the
// scheduler/store/API checks keep the raw segment (upstream measured them clean,
// and this PR is scoped to these two loop regressions). This cannot introduce a
// false positive: collapsing escapes / dropping `$IFS` never synthesises the
// literal `tmux`+send-keys, `nohup`+claude, or `claude`+`/loop` tokens out of
// prose -- it only removes an evasion.
export function normalizeShellEvasion(seg) {
  return String(seg ?? '')
    .replace(/\$\{IFS\}|\$IFS\b/g, ' ') // $IFS / ${IFS} -> the space it expands to
    .replace(/\\(.)/g, '$1') // \X -> X (bash unescape of a backslash-escaped char)
}

// Approximate the shell's WORD EXPANSION far enough to name a command word (card 4f32f1f9). This
// is deliberately not a tokenizer -- see this file's own note on why a full one is not warranted --
// it resolves only the constructs measured to hide an invocation, and leaves alone the one that
// cannot be resolved without executing it ($(...) / backticks, the stated residual).
//
// ORDER IS LOAD-BEARING, twice. $IFS is itself a parameter, so it has to become a SPACE before the
// generic ${x} rule erases it (otherwise `at${IFS}now` collapses to the single word `atnow` and the
// invocation disappears). And $'...' has to give up its content before the blanket quote removal
// eats its quotes and leaves a stray `$` glued to the binary name.
//
// ${x} is erased rather than replaced with a space: the shell drops an unset/empty parameter and
// JOINS what surrounds it, which is exactly how `${x}at now` runs at(1).
//
// This is a superset-of-truth transform -- it can turn text into an invocation that the shell would
// not run (e.g. it cannot know `${x}` was non-empty). That is safe HERE only because every caller
// uses it additively, next to the raw check, never instead of it.
export function approximateWordExpansion(text) {
  return String(text ?? '')
    .replace(/\$\{IFS\}|\$IFS\b/g, ' ') // field separator -> the space it expands to
    .replace(/\$'((?:[^'\\]|\\.)*)'/g, '$1') // ANSI-C quoting -> its content
    .replace(/\$\{[A-Za-z_]\w*\}/g, '') // ${x} -> unknown; erased, so the surrounding word joins
    .replace(/\\(.)/g, '$1') // \X -> X (bash unescape)
    .replace(/['"]/g, '') // quote removal, which the shell performs before exec
}

// Pair every segment's MASKED view with the ORIGINAL text at the same offsets (card 4f32f1f9).
//
// The two views answer different halves of one question, and neither can answer both. The masked
// view knows WHERE a command position is -- that is the whole point of maskInertLiterals, and prose
// cannot fake one there. The original knows WHAT WORD sits at that position -- the masked view
// blanked the quotes and with them the binary's own letters (`cr"o"ntab` reads as `cr ntab`).
//
// This works only because maskInertLiterals is LENGTH-PRESERVING over the line-continuation-
// collapsed source: it blanks a region to exactly as many spaces as it removed. One index range
// therefore describes both strings. The length equality is ASSERTED rather than assumed -- if a
// future change to the masker breaks it, this returns null and the caller falls back, instead of
// silently slicing the original at offsets that no longer line up.
//
// Returns null when the quoting could not be resolved at all (the masker's own fail-closed cases),
// leaving the caller to decide; every caller here then scans the naive segments, i.e. strictly more
// text, never less.
// Blank every heredoc BODY, length-preservingly, leaving the redirect and the terminator in place
// (card 4f32f1f9). Yet another narrowly-scoped heredoc walk, which this file already prefers over a
// shared state machine several call sites would have to agree on.
//
// WHY THE COMMAND-WORD VIEW MUST NOT SEE A HEREDOC BODY -- measured, not assumed. maskInertLiterals
// blanks a body but keeps the terminator word, and it blanks the body's newlines too, so the body
// stops being a separator: the segment that begins after the redirect line is masked to
// `             PY` -- which does NOT trim to empty, so the inert-segment skip does not catch it --
// while its ORIGINAL text is the body's first line. The command-word check then read that line as
// if it stood at a command position. It denied the right things for the wrong reason, and the proof
// is that a negative control disabling the heredoc branch entirely stayed GREEN: the heredoc tests
// were passing through the anchored path. Body lines belong to the heredoc branch, which scans
// every line rather than only the first, so blanking them here loses no coverage and restores the
// two checks to testing what they claim to test.
export function blankHeredocBodies(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const here = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(src.slice(i))
    if (!here) { out += src[i]; i++; continue }
    const tag = here[1] ?? here[2] ?? here[3]
    out += here[0]
    i += here[0].length
    const nl = src.indexOf('\n', i)
    if (nl === -1) { out += src.slice(i); break }
    out += src.slice(i, nl + 1)
    i = nl + 1
    const endRx = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
    const rel = endRx.exec(src.slice(i))
    if (!rel) { out += src.slice(i); break }
    out += ' '.repeat(rel.index) + rel[0]
    i += rel.index + rel[0].length
  }
  return out
}

export function pairedSegments(command) {
  const collapsed = blankHeredocBodies(String(command ?? '').replace(/\\\r?\n/g, ' '))
  const masked = maskInertLiterals(command)
  if (masked == null || masked.length !== collapsed.length) return null
  const pairs = []
  const sep = /&&|\|\||[;&|]|\r?\n/g
  let start = 0
  let m
  while ((m = sep.exec(masked)) !== null) {
    pairs.push({ masked: masked.slice(start, m.index), raw: collapsed.slice(start, m.index) })
    start = m.index + m[0].length
  }
  pairs.push({ masked: masked.slice(start), raw: collapsed.slice(start) })
  return pairs
}

// Pure decision: does this tool call set up self-pace / self-injection?
// --- STRINGS A SHELL WILL EXECUTE (card ec20dd23) ----------------------------------------------
//
// THE HOLE. maskInertLiterals blanks quoted regions before the anchored scan, and that is exactly
// what makes prose inert -- load-bearing everywhere else in this file. But a quoted string handed
// to `bash -c` / `sh -c` / `eval` is not inert: it IS the program. So the one construct whose
// quotes mean "run this" was the one construct the gate refused to look inside, and
// `bash -c "<scheduler> -"` passed while the identical bare command was denied.
//
// One step further out the same holds with a different trigger: `echo "<scheduler> -" | bash` and
// `... | xargs bash -c` put the program in ANOTHER command's argv. There it is not the quoting that
// matters but the CONSUMER -- a shell taking its program from stdin.
//
// Rather than teach each check about wrappers, this returns the extra command-strings a shell would
// end up executing; gateDecision then runs its WHOLE existing scan over each. Recursing that way
// rather than duplicating the checks is deliberate: a second copy of a security scan is how one of
// them silently stops matching, which is the reason hook-lib.mjs exists. It is also the shape the
// sibling hook scripts/hooks/noisy-command-guard.py already uses (_WRAPPER_RX +
// _unwrapped_variants) -- ported, not reinvented.
//
// DIRECTION: this can only ever deny MORE, so nothing that is allowed today depends on the
// extraction being complete, and an unforeseen wrapper shape leaves the gate exactly as strong as
// it is now rather than weaker. The opposite risk -- prose inside a `-c` string -- does not
// materialise, because the extracted text is scanned by the SAME anchored checks: in
// `bash -c "echo the <scheduler> entry"` the binary sits in argument position behind `echo`, which
// those checks already ignore. Measured, not assumed.
// The wrapper grammar reads the SAME command-position constant as the other two branches (card
// ec20dd23 round 2, MikroB asking for the third time). It is deliberately WIDER by one thing --
// plain whitespace -- and that is not a second list: a `-c` shell can legitimately sit in another
// command's argv (`xargs -I{} bash -c ...`), where no separator precedes it. Everything else it
// knows about command position now arrives from CMD_POSITION, so a position added there is
// inherited here instead of being remembered a third time.
const WRAPPER_POSITION = String.raw`(?:^|\s|${CMD_POSITION})`
// The option run before `-c`. Built from the SHAPE of an option rather than a list of them
// (Cybered F-2): the old `(?:\s+-[a-zA-Z]+)*` knew only bare short flags, so `bash --norc -c`,
// `--noprofile -c`, `--rcfile /tmp/x -c` and `-O extglob -c` all walked straight past it -- each
// measured running the payload. An option token is anything starting with `-` or `+` that is NOT
// itself the `-c` we are looking for, optionally followed by ONE non-option argument (`--rcfile
// FILE`, `-O optname`). Negative shape on purpose, per this file's direction principle: an option
// nobody thought of is still consumed, rather than ending the match and hiding the payload.
const OPTION_RUN = String.raw`(?:\s+(?!-[a-zA-Z]*c\b)[-+]\S*(?:\s+(?![-+])\S+)?)*`
// After `-c`, POSIX shells still accept a `--` end-of-options marker before the program string
// (`sh -c -- "<prog>"`, measured running). Skipping it is what keeps the program in view.
const POST_C = String.raw`(?:\s+--)?`
// THE PROGRAM ARGUMENT IS A SHELL WORD, NOT ONE QUOTED PIECE (Cybersec F-2, round 3, every shape
// below measured executing). The previous `(?:'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+))` assumed the
// program is either a single quoted string or a bare word. bash disagrees twice over: it JOINS
// ADJACENT pieces into one word, and it has two more quoting forms. So `bash -c "cron""tab -"`
// handed the matcher `cron`, `bash -c $'crontab -'` handed it `$'crontab`, and both walked.
//
// A word is therefore a RUN of pieces, and the run must be followed by a real word boundary. The
// lookahead is the load-bearing half, and it is easy to get wrong: without it the run happily stops
// after the first piece, which is exactly the `"cron"` failure again -- adding the run alternative
// ALONE does not close these shapes. Measured both ways before and after.
// THE SHAPE OF THIS PATTERN IS A DoS FIX, NOT A STYLE CHOICE. The first version was the obvious
// `(?:QUOTED|BARE+)+`, and I measured it hanging INDEFINITELY on `bash -c ` + 30 000 bare
// characters that never reach an accepting word boundary: two adjacent BARE runs can always be
// re-split, so the engine retries every partition of the run before failing. That is a denial of
// service in a hook that runs on every Bash call -- my own fix would have opened a hole while
// closing fourteen. (The round-2 DoS numbers did not cover it: they exercised a long OPTION run,
// which is a different quantifier.)
//
// So the grammar is written the way bash actually reads a word -- alternating bare runs and quoted
// runs -- with the quoted piece MANDATORY between two bare runs. Adjacent BAREs then cannot exist,
// the partition is unique, and there is nothing to backtrack over. `$` is kept out of BARE when a
// quote follows it for the same reason: otherwise `$'...'` could be split two ways.
// The ANSI-C alternative comes FIRST and allows `\'`: inside `$'...'` an escaped quote does not
// end the string, so the plain `'[^']*'` alternative would stop at it and truncate the word --
// measured against real bash, which yields `a'b` for `$'a\\'b'` while the old pattern extracted
// nothing at all. The two inner alternatives are disjoint (one starts with a backslash, the
// other excludes it), so this adds no ambiguity for the engine to backtrack over.
//
// AND THE PLAIN ALTERNATIVE LOST ITS `\$?` FOR THE SAME REASON. With both `\$'...'` and
// `\$?'...'` present, `$'a'` matched TWO ways, and a long run of them followed by a character
// that fails the word boundary backtracked forever -- measured: 20 000 pieces did not finish,
// while every other pathological body stayed under 160 ms. That is the identical mistake this
// pattern was rewritten to remove one round earlier, reintroduced by adding an overlapping
// alternative. `$'...'` now belongs solely to the ANSI-C branch and `'...'` solely to the
// plain one, so the partition stays unique.
const Q_PIECE = String.raw`\$'(?:\\.|[^'\\])*'|'[^']*'|\$?"(?:\\.|[^"\\])*"`
// Quantified with `*`, NOT written as `+` and then made optional at the use site: `${X}?` where X
// already ends in `+` yields `+?`, a LAZY plus rather than an optional one, which silently stops the
// run after one character. That mistake cost a full measurement cycle here -- the DoS was fixed and
// ten shapes quietly reopened, with the correctness battery the only thing that noticed.
const BARE_RUN = String.raw`(?:[^\s'"|;&<>()$]|\$(?!['"]))*`
const QUOTED_OR_WORD =
  String.raw`(?=[^\s|;&<>)])(${BARE_RUN}(?:(?:${Q_PIECE})${BARE_RUN})*)(?=[\s|;&<>)]|$)`

// Undo shell quoting across a whole word, concatenating the pieces the way bash does. Returns the
// text the inner shell actually receives, which is what the gate then scans.
// Decode an ANSI-C (`$'...'`) body starting at `start` (just past the opening quote), returning
// [decodedText, indexPastClosingQuote].
//
// FIDELITY MATTERS IN BOTH DIRECTIONS. Under-decoding leaves a bypass -- that is the bug being
// fixed. Over-decoding invents characters bash never produces and could manufacture a binary name
// out of benign text, i.e. a false positive. Every rule below was checked against real bash output,
// including the one people forget: an UNRECOGNISED escape keeps its backslash (`$'\z'` is `\z`,
// not `z`).
//
// `\'` is why this cannot reuse the plain single-quote branch: inside ANSI-C an escaped quote does
// not end the string, so scanning to the next `'` would stop early and truncate the payload.
const ANSI_SIMPLE = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }

// STICKY, and matched against the WHOLE string with lastIndex -- never against a fresh slice.
// The first version called src.slice(i) once per character and ran five regexes on the result,
// which is quadratic in the body length: a 40 000-escape body did not finish. That is the same
// mistake this file already recorded once (a fix that closes a bypass while opening a DoS in a hook
// that runs on every Bash call), so it is worth the extra care rather than the extra allocation.
const ANSI_HEX = /\\x([0-9a-fA-F]{1,2})/y
const ANSI_U16 = /\\u([0-9a-fA-F]{1,4})/y
const ANSI_U32 = /\\U([0-9a-fA-F]{1,8})/y
const ANSI_CTRL = /\\c(.)/y
const ANSI_OCT = /\\([0-7]{1,3})/y

function stickyAt(rx, src, i) {
  rx.lastIndex = i
  return rx.exec(src)
}

function readAnsiC(src, start) {
  let out = ''
  let i = start
  while (i < src.length) {
    const c = src[i]
    if (c === "'") return [out, i + 1]
    if (c !== '\\') { out += c; i++; continue }
    const e = src[i + 1]
    if (e === undefined) { out += c; i++; continue }
    if (e in ANSI_SIMPLE) { out += ANSI_SIMPLE[e]; i += 2; continue }
    let m = stickyAt(ANSI_HEX, src, i)
    if (m) { out += String.fromCharCode(parseInt(m[1], 16)); i += m[0].length; continue }
    m = stickyAt(ANSI_U16, src, i)
    if (m) { out += String.fromCodePoint(parseInt(m[1], 16)); i += m[0].length; continue }
    m = stickyAt(ANSI_U32, src, i)
    if (m) {
      const cp = parseInt(m[1], 16)
      // Above the Unicode maximum bash emits nothing usable; skipping is the conservative read.
      out += cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
      i += m[0].length
      continue
    }
    m = stickyAt(ANSI_CTRL, src, i)
    if (m) { out += String.fromCharCode(m[1].toUpperCase().charCodeAt(0) ^ 0x40); i += m[0].length; continue }
    m = stickyAt(ANSI_OCT, src, i)
    if (m) {
      const code = parseInt(m[1], 8) & 0xff
      // A NUL TRUNCATES the argument -- measured: `bash -c $'ec\0ho NULTEST'` reports
      // `ec: command not found`, it does not join the halves. Emitting the NUL and continuing would
      // splice `cron` and `tab` into a name bash never runs (a false positive), and dropping it
      // silently would do the same. Truncating matches bash and stays correct in both directions:
      // `$'<binary>\0 -'` still exposes the binary, because the truncation happens after it.
      if (code === 0) { const q = src.indexOf("'", i); return [out, q === -1 ? src.length : q + 1] }
      out += String.fromCharCode(code)
      i += m[0].length
      continue
    }
    // Unrecognised: bash keeps the backslash AND the character.
    out += c + e
    i += 2
  }
  return [out, i] // unterminated -- treat the rest as body
}

function unquoteWord(word) {
  const src = String(word ?? '')
  let out = ''
  let i = 0
  while (i < src.length) {
    // `$'...'` IS DIFFERENT FROM EVERY OTHER QUOTING FORM, and an earlier version of this comment
    // asserted the opposite -- it said ANSI-C and locale quoting "differ from the plain forms only
    // in ways that cannot hide a binary name". That claim was wrong and QA proved it with live bash
    // (card ec20dd23 round 4): `$'...'` is the ONE bash quoting form that performs real escape
    // decoding, so `bash -c $'\x63rontab -'` runs the binary while the literal name never appears
    // in the text the anchored checks scan. Twelve shapes measured open -- hex, octal, \u, \U,
    // every-character-encoded, mid-word, and the same on the here-string, eval and sh -c branches.
    //
    // Ground-truthed before fixing: `$'\x74ouch'` yields `touch`, while `$"\x74ouch"` and
    // `'\x74ouch'` both stay literal. So the decoding belongs HERE and must NOT be applied to the
    // locale form -- `$"..."` performs a gettext lookup and otherwise follows double-quote rules.
    if (src[i] === '$' && src[i + 1] === "'") {
      const [text, next] = readAnsiC(src, i + 2)
      out += text
      i = next
      continue
    }
    // Locale form: the `$` is decoration, the body follows ordinary double-quote rules.
    if (src[i] === '$' && src[i + 1] === '"') { i++; continue }
    if (src[i] === "'") {
      const j = src.indexOf("'", i + 1)
      if (j === -1) { out += src.slice(i + 1); break }
      out += src.slice(i + 1, j) // single quotes are literal -- never unescape here
      i = j + 1
      continue
    }
    if (src[i] === '"') {
      let j = i + 1
      let body = ''
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { body += src.slice(j, j + 2); j += 2; continue }
        body += src[j]; j++
      }
      // The OUTER shell already removed one level of escaping before the inner shell sees it
      // (Cybersec H-3): without undoing it, a wrapper nested three deep stops one level short of
      // the payload. Single-quoted bodies above must NOT get this treatment.
      out += body.replace(/\\(["\\$`])/g, '$1')
      i = j + 1
      continue
    }
    const bare = /^[^\s'"|;&<>()]+/.exec(src.slice(i))
    if (!bare) break
    out += bare[0]
    i += bare[0].length
  }
  return out
}
// Card 14b573f3 (Cybered): bash removes a backslash before any non-special character during word
// expansion, so a shell name with a backslash inserted before ANY of its letters resolves to the
// real binary -- verified against real bash, not assumed (`bash -c 'command -v ba\sh'` prints
// /usr/bin/bash; so do `\bash`, `b\ash`, `bas\h`, and combinations). Cybered's own repro used only
// the position right before the trailing "sh" pair; enumerating from the grammar rather than the
// one reported position (this file's own standing lesson) turned up that EVERY position needs the
// same tolerance, and that the xargs branch's round-6 filler fix (ccc2c742) only accidentally
// covers most of them by consuming stray backslashes as ordinary filler characters -- it misses a
// backslash right before the FINAL letter (`bas\h`, `das\h`), because by then there is nothing left
// for the filler to consume and too little literal text left for the plain alternation to match.
// One shared, escape-tolerant alternation, used everywhere the plain list previously was (SHELL_NAME
// below, and both of STDIN_SHELL_RX's own copies) rather than three separately-patched copies --
// this file's standing lesson about duplicated grammar knowledge diverging in both directions.
const SHELL_ALTERNATION = String.raw`(?:\\?b\\?a\\?s\\?h|\\?s\\?h|\\?z\\?s\\?h|\\?d\\?a\\?s\\?h|\\?k\\?s\\?h)`
const SHELL_NAME = String.raw`${PATH_PREFIX}${SHELL_ALTERNATION}\b`
const SHELL_C_RX = new RegExp(
  `${WRAPPER_POSITION}(?:sudo\\s+|env\\s+|command\\s+|exec\\s+)*${SHELL_NAME}${OPTION_RUN}\\s+-[a-zA-Z]*c${POST_C}\\s+${QUOTED_OR_WORD}`,
  'g',
)
const EVAL_RX = new RegExp(`${WRAPPER_POSITION}eval\\s+${QUOTED_OR_WORD}`, 'g')
// A shell fed its program on a HERE-STRING (Cybersec H-2): `bash <<< "<prog>"`, and the same via
// `source /dev/stdin <<< ...` / `. /dev/stdin <<< ...`. No `-c` anywhere, so neither of the two
// above sees it, and the program never appears in argv -- but the shell runs it just the same.
// The filler between the shell name and `<<<` must tolerate a REDIRECTION (Cybersec F-3): the old
// `[^|;&\n]*?` excluded `&`, so the single most ordinary redirection in the world --
// `bash 2>&1 <<< "<prog>"` -- was not recognised while bash ran it. `bash 2>/dev/null <<< ...`
// (no `&`) was already caught, which is what made the gap look like a shape rather than a class.
//
// A BARE `&` still ends the filler: only an `&` PRECEDED BY `>` is admitted. Written as a lookbehind
// rather than as `\d*>&\d*` on purpose -- that form overlaps `[^|;&\n]` on the `>` and the digits,
// giving the engine two ways to match the same characters inside a lazy quantifier, which is how
// backtracking blowups are built. Here the two alternatives are disjoint by construction: the first
// can never match `&`, the second matches nothing else.
const HERESTRING_FILLER = String.raw`(?:[^|;&\n]|&(?<=>&))*?`
const HERESTRING_RX = new RegExp(
  `${WRAPPER_POSITION}(?:sudo\\s+|env\\s+)*(?:${SHELL_NAME}|(?:source|\\.)\\s+\\/dev\\/stdin)${HERESTRING_FILLER}<<<\\s*${QUOTED_OR_WORD}`,
  'g',
)
// A shell that takes its PROGRAM from stdin rather than from argv: a bare `| sh`, xargs handing one
// a -c string, or -- Cybersec F-1, round 3 -- a PROCESS SUBSTITUTION standing in for the script
// file (`bash <(echo '<prog>')`, `bash < <(echo '<prog>')`, both measured executing).
//
// This is the same situation the `| bash` branch already handles, reached by a third route, so it
// gets the same treatment rather than a new one: when a shell is not given its program in argv, every
// quoted literal in the command becomes suspect and is scanned. It is deliberately NOT a fourth
// hand-written command-position list -- it reuses WRAPPER_POSITION, so a position added to
// CMD_POSITION is inherited here too instead of being remembered in one more place. That is the
// standing lesson from this file's own history: two lists for one idea diverge in both directions.
//
// Extra weight on this one: the sibling card 442f3289 removed the quote from its position grammar
// citing precisely this handling, so leaving the hole open would have cost two cards' protection.
const PROC_SUB_SHELL = String.raw`${WRAPPER_POSITION}(?:sudo\s+|env\s+)*${SHELL_NAME}${HERESTRING_FILLER}<\(`
// The xargs branch used to run `[^|]*?${PATH_PREFIX}` -- an unbounded lazy filler immediately
// followed by PATH_PREFIX's own independently-backtracking optional group. On a long run with no
// `/` (so PATH_PREFIX's group can never close), PATH_PREFIX fails at EVERY one of the ~n positions
// the filler tries, each failure itself costing O(remaining length) to determine -- O(n^2) total
// (card ccc2c742, backend measured n=100000 -> 8.7s through the real gateDecision() entry point,
// within MAX_COMMAND_BYTES=1MB). Wrapping PATH_PREFIX atomically does NOT fix this (measured,
// unchanged): atomicity only avoids re-trying an already-successful match, not the cost of a single
// failed scan. Flipping the filler from lazy to greedy does not fix it either -- it only relocates
// the same quadratic cost to a different adversarial shape (shell name mid-string, long trailing
// non-pipe text after it), which was measured to reproduce the identical blowup.
// The actual fix: for a `.test()`-only boolean check, PATH_PREFIX is redundant here in the first
// place. Its consumable characters (everything but `\s|;&<>()\\`, plus an escaped-any-char via
// `\\.`) are already a subset of what the plain filler `[^|]` accepts -- with the single exception
// of an escaped pipe (`\|`), which the filler's `[^|]` alone can never cross. So PATH_PREFIX's own
// nested attempt-and-backtrack cycle is folded into ONE disjoint filler.
//
// ROUND 6 (Cybered, same card, live NO-GO): the first cut of that fold routed EVERY backslash
// through `\\.` exclusively (`[^|\\]` excluded backslash from the single-char side), pairing it
// with whatever followed. bash/sh/zsh/dash/ksh all end in the two literal characters `s`,`h` --
// so a backslash placed directly before that `s` (`ba\sh`, `\sh`, `z\sh`, `da\sh`, `k\sh`) got
// force-paired with the `s` as one `\\.` atom, consuming the very character the shell-name
// alternation needed next, with no other path back to a match. Cybered proved this is not a
// theoretical regex artifact: `bash -c 'echo ba\sh'` prints `bash` (the shell drops a backslash
// before a non-special char during word expansion), so the string a policy-shaped `deny` had to
// catch and the string bash actually runs were identical -- and the fix above turned that `deny`
// into a silent `allow`. The fold's premise was still right (PATH_PREFIX's charset, minus the
// escape, is a subset of `[^|]`); it was scoped one notch too wide. Only an ACTUALLY escaped pipe
// (`\|`) needs the 2-char atom -- that is the one sequence `[^|]` alone can never cross. Every
// other character, including a bare backslash, now goes through the plain single-char class, so a
// backslash is free to leave the very next character (the `s` of a shell name) available to the
// next alternative -- restoring the OLD behavior for that boundary while keeping the escaped-pipe
// crossing PATH_PREFIX used to provide. This is still the same disjoint-alternation shape already
// proven safe for PATH_PREFIX (ae6e80ea): the two alternatives never compete for the same
// character, so there is nothing for the engine to retry at each outer position -- still O(n)
// (n=1000000 -> see stdin-shell-rx-xargs-quadratic.test.ts).
const XARGS_FILLER = String.raw`(?:\\\||[^|])*?`
const STDIN_SHELL_RX = new RegExp(
  String.raw`\|\s*(?:sudo\s+|env\s+)*${PATH_PREFIX}${SHELL_ALTERNATION}\b(?!\s*-[a-zA-Z]*c\b)` +
    String.raw`|\bxargs\b${XARGS_FILLER}${SHELL_ALTERNATION}\b` +
    `|${PROC_SUB_SHELL}`,
)
// `$'...'` gets its own alternative rather than a fourth capture group (Cybersec, card ec20dd23
// round 5, live repro): of the four extraction paths in executableStrings, three go through
// unquoteWord -- which already decodes ANSI-C escapes (round 4) -- but this one reads quoted
// literals directly, so `bash <(echo $'\x63rontab -')` and `echo $'\x63rontab -' | bash` reached
// the shell's real argument while the scan only ever saw the raw, still-escaped text. The `$'`
// marker is matched as its own alternative and its body decoded with readAnsiC -- the SAME
// function unquoteWord already calls, not a second decoder, per this file's own standing lesson
// that duplicated grammar knowledge is where the two copies drift apart. `$"..."` (locale form)
// needs no change here: its body already falls through to the plain `"..."` alternative below,
// exactly as unquoteWord leaves it literal.
const QUOTED_LITERAL_RX = /\$'|'([^']*)'|"((?:\\.|[^"\\])*)"/g

/** One level of "what would a shell run that is not this text itself": the argument of a `-c` shell
 *  or of `eval`, and -- only when something in the pipeline runs a program from stdin -- the quoted
 *  literals that would be fed to it. Every result is a proper substring of the input, so the caller
 *  can recurse on them without a depth guard. */
export function executableStrings(command) {
  const text = String(command ?? '')
  const out = []
  for (const rx of [SHELL_C_RX, EVAL_RX, HERESTRING_RX]) {
    rx.lastIndex = 0
    let m
    while ((m = rx.exec(text)) !== null) {
      // m[1] is now the WHOLE shell word (a run of adjacent quoted/bare pieces), so the quoting is
      // undone by unquoteWord rather than by picking one of three alternative groups -- that
      // three-group form is what let `"cron""tab -"` and `$'crontab -'` through (Cybersec F-2).
      // The per-piece rules (double-quoted bodies unescaped one level, single-quoted left literal)
      // live in unquoteWord and are unchanged in effect.
      const inner = unquoteWord(m[1])
      if (inner && inner !== text) out.push(inner)
    }
  }
  if (STDIN_SHELL_RX.test(text)) {
    QUOTED_LITERAL_RX.lastIndex = 0
    let q
    while ((q = QUOTED_LITERAL_RX.exec(text)) !== null) {
      if (q[0] === "$'") {
        const [lit, next] = readAnsiC(text, QUOTED_LITERAL_RX.lastIndex)
        QUOTED_LITERAL_RX.lastIndex = next
        if (lit && lit !== text) out.push(lit)
        continue
      }
      const lit = q[1] ?? q[2]
      if (lit && lit !== text) out.push(lit)
    }
  }
  return out
}

// A hard ceiling on how much text the gate will examine, ABOVE WHICH IT DENIES (card fa5ef179).
//
// This is a backstop, not the fix. The measured bypass was an accidental quadratic in the path
// prefix (see PATH_PREFIX): a 96 KB inert filler took 10.36 s, past the hook's registered
// `timeout: 10`, and the caller treats a timed-out hook as non-blocking -- so the payload was
// allowed unexamined. That amplification is gone; the same input is now 85 ms and the curve is
// linear out to 520 KB.
//
// The ceiling exists because "no amplification today" is not "no amplification ever". If some
// future pattern reintroduces one, this bounds what an attacker may feed it. FAIL-CLOSED is the
// whole point: a command too large to examine is refused rather than waved through, which is the
// opposite of what the timeout does.
//
// 1 MiB is chosen from the measured rate (~0.7 ms/KB), so even a hypothetical 10x regression stays
// inside the 10 s deadline. Real agent commands are orders of magnitude smaller -- a Bash call
// carrying a megabyte of text is anomalous in its own right -- so the ceiling costs nothing that
// legitimately happens, and a caller who genuinely needs to move that much data has file
// redirection and stdin.
const MAX_COMMAND_BYTES = 1048576

export function gateDecision(toolName, toolInput) {
  const name = String(toolName ?? '')
  if (SELF_PACE_TOOLS.has(name)) return { deny: true }
  // Measured on the BYTE length, not String.length: a non-ASCII command can be up to three times
  // its UTF-16 length in bytes, and the thing being bounded is work over bytes.
  const rawCommand = name === 'Bash' ? String(toolInput?.command ?? '') : ''
  if (rawCommand && Buffer.byteLength(rawCommand, 'utf8') > MAX_COMMAND_BYTES) {
    return { deny: true, reason: 'oversized' }
  }
  // Native file tools writing the self-schedule store would bypass any Bash regex.
  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
    const fp = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
    if (SCHEDULE_STORE_RX.test(fp)) return { deny: true }
  }
  if (name === 'Bash') {
    // Card ec20dd23: whatever a shell would execute out of a `-c` string, an `eval`, or a pipe into
    // a stdin-reading shell gets the SAME scan as the command itself. Recursion terminates because
    // every extracted string is a proper substring of its source.
    for (const inner of executableStrings(String(toolInput?.command ?? ''))) {
      if (gateDecision('Bash', { command: inner }).deny) return { deny: true }
    }
    // Strip -d/--data payloads on the WHOLE command BEFORE splitting. A payload is
    // data, not an invocation; and since splitSegments is NOT quote-aware, a shell
    // separator (; && | &) INSIDE a dispatch body would otherwise orphan a fragment
    // that false-matches. Stripping first blanks the body (incl. any separators in
    // it), so the URL/method args still match but the body text never does. A
    // separator OUTSIDE the payload still splits, so `curl -d '' x ; crontab -r`
    // is still caught. stripHeredocDataPayloads (card 4638c14c) covers the SAME
    // class produced via `curl -d @- <<TAG ... TAG` instead of an inline quote --
    // also newline-safe BEFORE splitSegments' newline-based split ever sees it.
    const safeCommand = stripHeredocDataPayloads(
      stripDataPayloads(stripGitCommitMessages(String(toolInput?.command ?? ''))),
    )
    // Per-segment so an unrelated token elsewhere in a compound command cannot
    // turn a legit read (store inspection, schedule-API GET) into a false deny.
    const naiveSegs = splitSegments(safeCommand)
    for (const seg of naiveSegs) {
      // Match the self-pace bash patterns against the shell-normalised segment so a
      // `\/loop` / `$IFS/loop` evasion (which bash resolves to `/loop` at exec) is
      // still caught; the scheduler/store/API checks below use the RAW seg (scoped).
      //
      // These stay on the NAIVE segments ON PURPOSE. They are unanchored, so a
      // quoted region is not a hiding place for them -- and the naive scan is
      // what catches a real `subprocess.run(['tmux','send-keys',...])` inside a
      // heredoc body (measured 2026-08-05). Quote-aware segments here would have
      // dropped the detection of this gate's own founding incident vector.
      if (SELF_PACE_BASH_PATTERNS.some((re) => re.test(normalizeShellEvasion(seg)))) return { deny: true }
      // self-schedule store: block WRITE only (a read/grep is legit diagnostics)
      if (SCHEDULE_STORE_RX.test(seg) && WRITE_INTENT_RX.test(seg)) return { deny: true }
      // dashboard schedule API: block WRITE methods only (GET list/pending is legit)
      if (SCHEDULE_API_RX.test(seg) && HTTP_WRITE_RX.test(seg)) return { deny: true }
    }
    // The scheduler check is the ANCHORED one -- it fires on what sits at a
    // segment START -- so it is the one a fake segment boundary can mislead, and
    // the only one that gets quote-aware segments. Null (unresolvable quoting)
    // falls back to the naive split, i.e. to scanning strictly more.
    const masked = maskInertLiterals(safeCommand)
    for (const seg of (masked == null ? naiveSegs : splitSegments(masked))) {
      // scheduler binaries: deny the exec/submit forms, allow pure read-listing
      if (SCHEDULER_RX.test(seg) && !SCHEDULER_READ_RX.test(seg)) return { deny: true }
    }
    // Command-word check (card 4f32f1f9), ADDITIVE to the raw scan above and using the same
    // segment boundaries -- but reading the word from the ORIGINAL text with the shell's word
    // expansion approximated, so a quote/$IFS/backslash INSIDE the binary name no longer hides it.
    // Additive on purpose: it can only deny more, so nothing above depends on the approximation
    // being complete, and a negative control can switch it off and watch the bypasses return.
    for (const pair of pairedSegments(safeCommand) ?? naiveSegs.map((s) => ({ masked: s, raw: s }))) {
      // A segment whose MASKED view is empty is inert text end to end -- a wholly quoted segment
      // like `'at now'`, which names a binary literally called "at now" and schedules nothing.
      // Skipping it is what keeps maskInertLiterals' quoted-prose fix intact here. No measured
      // bypass is lost to it: each one leaves an unquoted character behind (`a""t now` masks to
      // `a   t now`, `"at" now` to `      now`), and `'at' now` -- which DOES run at(1) -- masks to
      // `     now`, so it is still examined.
      //
      // THE LIMIT OF THAT CLAIM, STATED (Cybersec G2, card 230e9884): it holds for ONE quoted run.
      // From TWO adjacent runs it does not, and the gap is real rather than theoretical -- `'at'
      // 'now'` and `'crontab' '-r'` mask to nothing but ONE space between two blanked regions, so
      // the segment still trims to empty and is skipped here, while the shell strips each run
      // separately and executes the command. Measured passing on the landed gate. It stays open
      // deliberately for now: closing it means deciding what an all-quoted segment MEANS rather
      // than widening a character class, which is 230e9884's job. Read the sentence above as "no
      // measured SINGLE-RUN bypass", not as a general guarantee.
      if (pair.masked.trim() === '') continue
      const expanded = approximateWordExpansion(pair.raw)
      if (SCHEDULER_CMDWORD_RX.test(expanded) && !SCHEDULER_CMDWORD_READ_RX.test(expanded)) return { deny: true }
    }
    // scheduler binaries hidden in a heredoc BODY (card 46c4ad4a): maskInertLiterals blanks
    // every heredoc body before the anchored check above ever sees it (by design, see its own
    // header comment), so this is the ONE place such a body is genuinely invisible. Scoped
    // specifically to extracted heredoc body text -- NOT every naive segment broadly -- because
    // that broader attempt regressed a pre-existing false-positive fix (measured while building
    // this: `echo 'foo | crontab | bar'`, a single quoted argument, pipe-split by the naive
    // segmenter into a bare `crontab` segment with nothing around it, false-denied).
    //
    // Split on NEWLINES ONLY here -- NOT splitSegments (which also splits on `;`/`&`/`|`).
    // A second, DEEPER instance of the same false-positive class surfaced while fixing the
    // first: a heredoc body can itself contain a double-quoted PROSE string with a literal `|`
    // inside it (the exact measured 2026-08-05 pattern, `"... stop.sh | launchctl | ..."`),
    // and splitSegments would fake a boundary around "launchctl" there too. Testing each whole
    // line directly instead works because every shape guard below (AT_INVOCATION,
    // LAUNCHCTL_SUBCOMMAND, SCHED_BARE_SHAPE) only inspects what immediately FOLLOWS the
    // keyword -- trailing content after a real OR fake separator on the same line cannot make a
    // non-invocation look like one. A genuine multi-command line inside a heredoc body (e.g.
    // `crontab -r; echo done`) is still caught: the guard only cares that a flag/end-shape
    // follows "crontab", not that nothing else follows it on the line.
    for (const body of extractHeredocBodies(safeCommand)) {
      for (const line of body.split(/\r?\n/)) {
        const seg = line.trim()
        // SUBTRACT the read forms, then ask whether a scheduler WRITE is still there (card
        // f7b10fec). The previous shape asked "does this line contain a read?" and exempted the
        // whole line if so -- but this loop tests each line WHOLE (deliberately: see the block
        // comment above), so one line can hold both. Measured on the pre-fix file, all three
        // read forms carried the same bypass:
        //   `(crontab -l; echo "* * * * * ...") | crontab -`      -> exempted by `crontab -l`
        //   `launchctl list; launchctl submit -l self -- ...`      -> exempted by `launchctl list`
        //   `atq; echo go | at now + 5 minutes`                    -> exempted by `atq`
        // Each one genuinely schedules, and each one passed. The anchored check is NOT affected:
        // splitSegments cuts on `;`/`|`/`&`, so there the read and the write land in separate
        // segments and the write is judged on its own.
        //
        // Subtraction, not a "does it also contain a write" test: a pure read must stay allowed,
        // and after removing the reads a pure read line has nothing left to match.
        const writeOnly = seg.replace(UNANCHORED_SCHEDULER_READ_RX_G, ' ')
        if (UNANCHORED_SCHEDULER_RX.test(writeOnly)) return { deny: true }
        // The same line with the shell's word expansion approximated (card 4f32f1f9). A quote
        // inside the binary name (`cr"o"ntab -r`) or a `$IFS` between it and its argument hides the
        // call from the raw match above -- measured passing on this branch, not only the anchored
        // one. ADDITIVE, and that matters in this direction too: the raw test keeps its own
        // coverage, so an accidental denial that only the RAW text produces is not traded away.
        // (`crontab "foo"` is the concrete one: the quote defeats SCHED_BARE_SHAPE's
        // English-sentence lookahead and the raw line denies, while the expanded `crontab foo` is
        // indistinguishable from prose and would not.)
        const expandedLine = approximateWordExpansion(seg).replace(UNANCHORED_SCHEDULER_READ_RX_G, ' ')
        if (UNANCHORED_SCHEDULER_RX.test(expandedLine)) return { deny: true }
      }
    }
  }
  return { deny: false }
}

const GATE_MSG =
  'Self-pace TILTOTT (governance hard-gate). Sub-agentkent NEM utemezhetsz sajat ' +
  'jovobeli turn-t: se ScheduleWakeup/Cron*/RemoteTrigger, se tmux send-keys, se ' +
  'scheduled_tasks.json iras, se /api/schedules POST, se /loop self-pace. Input-vezerelt ' +
  'vagy: csak az operator (channel) vagy egy peer (inter-agent) uzenete inditson. Ha varakozol, ' +
  'maradj idle a prompt-on -- a beerkezo uzenet majd ujrainditja a turn-t. SOHA ne valaszolj ' +
  'magadnak es SOHA ne dontsd el az operator helyett egy hozza intezett kerdest.'

const OVERSIZE_MSG =
  'Tul nagy parancs (governance hard-gate, fail-closed). A kapu legfeljebb 1 MiB parancsszoveget ' +
  'vizsgal at; ezen felul NEM engedi at ellenorizetlenul, hanem tiltja -- kulonben eleg lenne ' +
  'eleg nagy bemenettel tulfutni a hook hataridejen, es a kapu megkerulheto lenne. ' +
  'Mit tegyel: ne a parancssorban vidd az adatot. Ird fajlba es hivatkozz ra (`< fajl`, ' +
  '`-d @fajl`, heredoc), vagy bontsd tobb hivasra. Ha tenyleg egyetlen, egy megabajtnal nagyobb ' +
  'parancsra van szukseged, az operator dontese -- szolj neki, ne kerulgesd.'

// allow()/deny()/isInvokedDirectly() are shared with the other PreToolUse
// gates -- see hook-lib.mjs.
if (isInvokedDirectly(import.meta.url)) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow() // malformed/empty input must never break the agent's tool calls
  }
  const { deny: shouldDeny, reason } = gateDecision(payload?.tool_name, payload?.tool_input)
  // A refusal has to say what actually happened. The self-pace message would be baffling here --
  // the command was never examined for scheduling at all, it was refused for its size -- and a
  // message that misdescribes the cause sends the reader looking for the wrong bug.
  if (shouldDeny) deny(reason === 'oversized' ? OVERSIZE_MSG : GATE_MSG)
  allow()
}

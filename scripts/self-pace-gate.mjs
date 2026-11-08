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
//     creating/changing a dashboard schedule -- through /api/schedules with ANY
//     client, or by writing the scheduled-tasks store it lives in (Bash or the
//     native Write/Edit/NotebookEdit tools). See scheduleSurfaceDeny.
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

import { readFileSync, appendFileSync, statSync, realpathSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
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

// The allowlist this install's egress-gate.mjs reads (scripts/ -> repo root -> store/).
const DEFAULT_ALLOWLIST_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'store', 'egress-allowlist.json')

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
//
// ROUND 3 (Cybersec NO-GO, card 39cc3460 round 2): round 2 above excluded only `|` from both
// alternatives, because that was the one anchor character the round's own repro used. But
// WRAPPER_POSITION/CMD_POSITION (defined further down, and hoisted into CMD_POSITION_CHARS just
// below so this constant can be BUILT FROM it instead of duplicating it) treats SEVEN OTHER
// characters (`;` `&` `(` `)` `{` `!` a backtick) as equally valid command-position anchors --
// every one of them gives the identical O(n^2): a dense run of the escaped pair (`\;\;\;...` etc.)
// yields ~n anchor positions, and at each one PATH_PREFIX's escape-tolerant alternative still
// happily consumed the rest of the run looking for `/`, exactly the round-2 bug with a different
// character. Cybersec measured all seven live through gateDecision(): n=32000 pairs (64 KB, far
// below MAX_COMMAND_BYTES) took up to 13.3s on `;`/`&`/`(`/`)`/`{`/`!`/backtick -- already past the
// hook's own 10s timeout, which the file's own header documents as fail-open (the caller treats a
// timed-out hook as non-blocking). Narrowing only `|` was the same mistake this file's own standing
// lesson warns against: enumerating from the one reported repro instead of from the grammar that
// produced it -- here, literally CMD_POSITION's own character class.
// Two exclusion sets now both derive from CMD_POSITION_CHARS: the escape-tolerant alternative
// (`\\[^...]`) so an escaped anchor character stops the scan instead of being consumed as an
// ordinary path character, AND the plain literal alternative (`[^\s...]`) -- because `{`, `!` and
// backtick were ALSO anchors CMD_POSITION recognizes UNescaped, and the old literal-char class did
// not exclude them either, so a bare (non-backslash) run of any of those three was an equally live
// route to the same blowup that the round-2 fix never touched. `<` `>` stay excluded too (never
// part of CMD_POSITION, but excluded here since round 1 -- an unescaped redirection operator is
// never a legitimate path character either).
const CMD_POSITION_CHARS = ';&|(){!`'
const PATH_PREFIX = String.raw`(?:(?:\\[^${CMD_POSITION_CHARS}]|[^\s${CMD_POSITION_CHARS}<>\\])*\/)?`

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
// The character class is CMD_POSITION_CHARS (hoisted above PATH_PREFIX, card 39cc3460 round 2):
// one list, consumed here AND by PATH_PREFIX's exclusion sets, so a future addition to this class
// is inherited by PATH_PREFIX by construction instead of needing a second, easily-forgotten edit.
const CMD_POSITION = String.raw`(?:[${CMD_POSITION_CHARS}]|\b(?:if|then|else|elif|while|until|do)\b)`
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
//
// THE TIMESPEC LIST AND THE SHAPES BUILT ON IT ARE NAMED ONCE AND SHARED (card 79bb0364). Before
// this they were one inline alternation written out twice, and the redirect alternative inside
// them read `["']*\s*<` -- "anything after a `<` is a real submit". That is true for batch(1) and
// FALSE for at(1), and that difference is this card's whole defect: an ordinary comparison of a
// variable named `at` was read as `at < FILE` and denied. Measured by backend2 while gating
// 51273fc0 -- three blocked Bash calls in three languages, the common line being a `<=` comparison
// against zero -- with the difference test that settles the diagnosis instead of guessing at it:
// the SAME code with the variable renamed `pos` passes. `at` is not an exotic name for an index.
//
// CYBERSEC'S INDEPENDENT REPORT (23941, filed as a second false-positive class on the same card)
// IS THE SAME ROOT, seen through a markdown code span: a backtick is a command-position character,
// so quoting that condition inside a code span in a heredoc body put the word in command position
// too. Their diagnosis named the or-operator in the quoted condition as half the trigger; measured
// here it is not part of it at all -- the same code span WITHOUT the or-operator denies
// identically, and the same span with the variable renamed passes. That matters because the remedy
// they proposed for it -- skip a heredoc body whose delimiter is QUOTED, "since there is no
// substitution there" -- would have opened four measured holes at once. A quoted delimiter stops
// the OUTER shell from substituting; it does not stop `bash <<'EOF'` or `python3 <<'PY'` from
// EXECUTING that body, which is exactly how the tmux/crontab/schedule-API vectors this branch was
// built for (card 46c4ad4a) are written.
//
// WHY at(1) LOSES THE BARE REDIRECT AND batch(1) KEEPS IT -- the same distinction, and the same
// argument, that already licensed dropping the end-of-segment branch for at(1) alone (card
// 12f80902, documented at AT_INVOCATION_UNANCHORED below). at(1) REQUIRES a timespec: `at < job`
// exits with a usage error and schedules nothing, so that shape never described a working submit
// in the first place. batch(1) takes NO timespec, so `batch < job` IS a working submit and keeps
// the bare form. at(1)'s redirect alternative instead demands what a real one always carries: the
// file word, then a timespec. This keeps `at < job now + 5 minutes` denied, and it also keeps the
// adversarial `at <=0 now` denied -- a redirect from a file literally named `=0` -- which the
// narrower fix the card proposed (reject a `<` followed by `=` or `<`) would have let through.
//
// RESIDUAL, STATED RATHER THAN IMPLIED: `at < job "$WHEN"`, a redirect whose timespec is a
// variable, was denied before and is allowed now. That is less "coverage lost" than "arbitrary
// coverage made consistent" -- `at "$WHEN" < job`, the same invocation with the words in the other
// order, was ALREADY allowed, because every branch here only inspects what immediately follows the
// binary. A variable timespec is not matchable as text either way; this file's own stated residual
// about `$(echo at) now` is the same limit.
const AT_TIMESPEC = String.raw`(?:now|noon|midnight|teatime|today|tomorrow|next\b|\+\s*\d|\d{1,2}:\d{2}|\d{3,4}\b|\d{1,2}\s*(?:am|pm)\b|\d{1,2}[./]\d{1,2}|(?:mon|tue|wed|thu|fri|sat|sun)\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b)`
const AT_BARE = String.raw`["']*\s*$`
const AT_FLAG = String.raw`["']*\s+["']*-`
const AT_TIMESPEC_ARG = String.raw`["']*\s+["']*${AT_TIMESPEC}`
// batch(1) takes no timespec, so an input redirect IS already a working submit -- with ONE shape
// carved out, and the carve-out is the QA FAIL on the first round of this card (comment 21161).
//
// THE ASYMMETRY THAT WAS SHIPPED. The first fix hardened at(1)'s redirect and left batch(1)'s alone,
// so `at <= 0` passed while `batch <= 0` -- the same ordinary comparison, the same collision class --
// still denied. The card's title promised BOTH binaries; only one had been done. QA reproduced it
// independently against gateDecision rather than from this file's fixtures.
//
// WHY at(1)'s FIX DOES NOT TRANSPLANT. at(1) could be closed by demanding a timespec after the file
// word, because at(1) requires one. batch(1) requires none, so that lever does not exist here. The
// lever it DOES have is the mirror image: batch(1) accepts NO OPERANDS. `batch <= 0` is, to bash,
// a redirect from a file named `=` plus the operand `0` -- and an operand makes batch exit with a
// usage error, so that shape never described a working submit either.
//
// So the carve-out is exactly `<` `=` whitespace OPERAND, and nothing wider:
//     batch <= 0        -> redirect from `=`, operand `0`  -> usage error   -> allowed (the FP)
//     batch <=          -> redirect from `=`, no operand    -> WORKING      -> still denied
//     batch <=0         -> redirect from `=0`, no operand   -> WORKING      -> still denied
//     batch << EOF      -> a heredoc into batch's stdin     -> WORKING      -> still denied
//     batch < n         -> redirect from `n`, no operand    -> WORKING      -> still denied
// The last row is a residual and is named as one: `batch < n` is a genuine comparison in code AND a
// genuine submit in bash, indistinguishable as text, so it stays fail-closed.
//
// The inner `(?![0-9]*[<>&])` keeps the carve-out from being a door: what follows must be a WORD, so
// `batch <= 2>/dev/null` / `<= >out` / `<= &1` are redirections rather than operands, still leave
// batch with none, and stay denied.
//
// THE CARVE-OUT'S PREMISE HELD FOR ONE CLASS OF TOKEN AND NOT ANOTHER (Cybersec, comment 21227 --
// they attacked the exact expression I asked them to). The premise is "if something follows the `=`
// after a space, batch got an OPERAND, therefore a usage error". That is false for any token bash
// CONSUMES rather than passes on: a named-fd redirect (`{fd}>out`, `{fd}<in`, bash 4.1+) leaves
// batch with argv(0) and the job body on stdin, byte-identical to the bare `<=` form the gate still
// denies. The first enumeration listed the redirect SPELLINGS it had thought of -- numeric fds,
// `>`, `&` -- rather than asking whether the token survives word-splitting as an operand, which is
// the same shape of mistake as the class this whole card is about.
//
// `\{[A-Za-z_]\w*\}[<>]` closes the two named-fd forms at zero measured cost (Cybersec's 20-case
// battery: 4 divergences before, 2 after, and both remaining ones are the residual below).
//
// WHAT IS NOT CLOSED, AND WHY IT IS A RESIDUAL RATHER THAN A MISSING BRANCH: a substitution or an
// unquoted variable that expands to ZERO words -- `batch <= $(echo)`, `batch <= $EMPTY` -- also
// leaves batch operandless, and is indistinguishable AS TEXT from `batch <= $count`, an ordinary
// comparison this round exists to allow. Measured, all three read identically. Any `$`-aware
// extension would re-open the false positive this round removed, so it goes on the stated residual
// list next to `batch < n` instead of into the pattern.
const BATCH_REDIRECT = String.raw`["']*\s*<(?!=\s+(?![0-9]*[<>&]|\{[A-Za-z_]\w*\}[<>])\S)`
// at(1): the redirect has to be followed by a file word and then a timespec. `[^\s;&|<]` on the
// ADJACENT branch keeps a file name that STARTS with `=` matchable (that is the `at <=0 now`
// bypass), and the run stops at a command separator so the timespec it finds has to belong to THIS
// invocation rather than to a later command on the same line.
//
// THE SENTENCE THAT USED TO STAND HERE SAID THAT CLASS "REFUSES THE HEREDOC OPERATOR `<<`", AND IT
// WAS FALSE IN THE DANGEROUS DIRECTION (Cybersec F-2, comment 21173). `[^\s;&|<]` does not MATCH a
// `<`, and in a denying regex not matching is PERMITTING -- so what read as a guard was a hole, and
// `at <<'EOF' now` went through. The concrete assertion written under that name was fine (`at << JOB`
// with no timespec really cannot submit); the NAME and the comment generalised it into a claim about
// the operator that the very next probe disproved. Corrected rather than deleted, because the wrong
// sentence is the useful part: it is why the operator is now spelled `<{1,3}` below.
// at(1)'s redirect branch is a UNION of two readings, not one pattern (Cybersec R-5, comment 21173,
// measured on a 34-case battery across five variants). The first round's single pattern demanded
// that the timespec sit IMMEDIATELY after the file word, and it spelled the redirect operator as a
// character class that `<<` and `<<<` do not match. In a DENYING regex a non-match is a PERMIT, so
// both of those were holes rather than guards, and seven working submits changed from denied to
// allowed. Each was measured with an argv/stdin-printing stub, not inferred: X1 (`<<'EOF' now`) and
// X4 (`< job 2>/dev/null now`) produce argv and stdin BYTE-IDENTICAL to the `at < job now` form that
// stayed denied. The rest put a flag, a flag with its own argument, a second redirect, or a quoted
// filename containing a space between the file word and the timespec.
//
// WHY A UNION AND WHY THE WIDE BRANCH GETS A NARROWER WORD LIST. The wide branch alone, carrying the
// full timespec list, false-denies ordinary code: `if (at < len - 1500) return` matches, because a
// bare four-digit number is a valid at(1) timespec. Dropping the bare `\d{3,4}` and `\d{1,2}[./]\d{1,2}`
// alternatives from the WIDE branch removes that, and the ADJACENT branch keeps its full list, so
// `at < job 1530` and `at < job 12.25` stay denied. Neither branch alone reaches 34/34; the union
// does, and Cybersec's own five-variant table is what shows the intermediate candidates do not.
//
// AND THE MEASUREMENT THAT MATTERS MORE THAN THE MUTATION SCORE, in Cybersec's words: R-5 changes
// behaviour on seven shapes and the 169 shipped tests notice NONE of them. A suite that stays green
// across a real behaviour change is not evidence of coverage; the seven shapes are pinned below.
const AT_TIMESPEC_WORDY = String.raw`(?:now|noon|midnight|teatime|today|tomorrow|next\b|\+\s*\d|\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm)\b|(?:mon|tue|wed|thu|fri|sat|sun)\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b)`
const AT_REDIRECT_ADJACENT = String.raw`["']*\s*<{1,3}\s*["']*[^\s;&|<]\S*\s+["']*${AT_TIMESPEC}`
const AT_REDIRECT_ANYWHERE = String.raw`["']*\s*<{1,3}[^;&|\n]*?\s["']*${AT_TIMESPEC_WORDY}`
const AT_REDIRECT = String.raw`(?:${AT_REDIRECT_ADJACENT}|${AT_REDIRECT_ANYWHERE})`
const AT_INVOCATION = String.raw`(?=${AT_BARE}|${AT_FLAG}|${AT_REDIRECT}|${AT_TIMESPEC_ARG})`
const BATCH_INVOCATION = String.raw`(?=${AT_BARE}|${AT_FLAG}|${BATCH_REDIRECT}|${AT_TIMESPEC_ARG})`
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
  String.raw`(^|${SCHED_BOUNDARY}\s*)${SCHED_PREFIX}(?:(?:crontab|systemd-run)\b(?!-)(?!\s*=)|launchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|batch\b(?!-)(?!\s*=)${BATCH_INVOCATION}|at\b(?!-)(?!\s*=)${AT_INVOCATION})`,
  'i',
)
// ...but allow a pure READ-listing of one's own schedule (parity with the store /
// schedule-API read exemptions): crontab -l, launchctl list/print, atq.
// Quote-tolerant for the same reason the write guards are (card 4fa31f31): tightening the write
// side alone would turn a quoted `launchctl "list"` -- a pure read -- into a false deny.
//
// CRONTAB_NO_WRITE_FLAG_FOLLOWS (card f35b8d92, Cybersec HIGH): `-l\b` alone is a PREFIX match --
// it says nothing about what follows. crontab(1) (cronie source, Cybersec's own read of it) parses
// its flags with getopt in a chain where every flag OVERWRITES the same mode variable and the LAST
// one wins -- so `crontab -l -r` (or the combined-cluster form `-lr`) genuinely DELETES the
// crontab, not lists it, and "starts with -l" is not "is a read". Requires no `-r`/`-e`/`-i`
// (remove/edit/interactive-remove -- crontab's own write-shaped flags, alone or combined in a
// getopt cluster like `-er`) anywhere before the next real command boundary (`;`/`&`/`|`/backtick/
// newline) -- bounded there so this cannot reach past the CURRENT invocation into an unrelated
// later command on the same line (`crontab -l; rm -rf /` must still read "-l" as a real, unrelated
// read, not treat "rm -rf /" as if it were more crontab flags). Scoped to crontab only: launchctl's
// read subcommands (list/print/...) are a single POSITIONAL argv[1], not a getopt flag chain --
// `launchctl list load` passes "load" as an ARGUMENT to `list`, it does not invoke `load` as a
// second operation -- and `atq` takes no mode-flipping flag at all, so neither shares this
// mechanism.
const CRONTAB_NO_WRITE_FLAG_FOLLOWS = String.raw`(?![^;&|\`\n]*-[a-z]*[rei][a-z]*\b)`
const SCHEDULER_READ_RX = new RegExp(String.raw`(^|${SCHED_BOUNDARY}\s*)${SCHED_PREFIX}(crontab["']*\s+["']*-l\b${CRONTAB_NO_WRITE_FLAG_FOLLOWS}|launchctl["']*\s+["']*(?:list|print|dumpstate|blame|examine)\b|atq\b)`, 'i')

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
  String.raw`^\s*${SCHED_PREFIX}(?:(?:crontab|systemd-run)\b(?!-)(?!\s*=)|launchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|batch\b(?!-)(?!\s*=)${BATCH_INVOCATION}|at\b(?!-)(?!\s*=)${AT_INVOCATION})`,
  'i',
)
// The read exemption needs no quote tolerance here: the expansion approximation already removed
// the quotes this same text used to carry.
const SCHEDULER_CMDWORD_READ_RX = new RegExp(
  String.raw`^\s*${SCHED_PREFIX}(crontab\s+-l\b${CRONTAB_NO_WRITE_FLAG_FOLLOWS}|launchctl\s+(?:list|print|dumpstate|blame|examine)\b|atq\b)`,
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
const AT_INVOCATION_UNANCHORED = String.raw`(?=${AT_FLAG}|${AT_REDIRECT}|${AT_TIMESPEC_ARG})`
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
  String.raw`\b(?:crontab|systemd-run)\b(?!-)(?!\s*=)${SCHED_BARE_SHAPE}|\blaunchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|${LINE_CMD_POSITION}${SCHED_PREFIX}batch\b(?!-)(?!\s*=)${BATCH_INVOCATION}|${LINE_CMD_POSITION}${SCHED_PREFIX}at\b(?!-)(?!\s*=)${AT_INVOCATION_UNANCHORED}`,
  'i',
)
const UNANCHORED_SCHEDULER_READ_RX = new RegExp(
  String.raw`crontab["']*\s+["']*-l\b${CRONTAB_NO_WRITE_FLAG_FOLLOWS}|launchctl["']*\s+["']*(?:list|print|dumpstate|blame|examine)\b|atq\b`,
  'i',
)
// Same pattern, global: used to REMOVE the read forms from a line before asking whether anything
// schedule-WRITING is left. See the heredoc loop below for why matching is not enough.
const UNANCHORED_SCHEDULER_READ_RX_G = new RegExp(UNANCHORED_SCHEDULER_READ_RX.source, 'gi')

// The Claude self-schedule store. Two formats are guarded:
//   legacy:    scheduled_tasks.json  (single flat file)
//   directory: scheduled-tasks/<name>/<file>  (e.g. task-config.json, SKILL.md)
// Blocked for WRITE on any route (a Bash write, or the native Write/Edit/NotebookEdit
// tool); a read/grep is legit diagnostics. The directory branch is fail-closed: ANY
// file under a named task subdirectory is blocked, not only task-config.json.
const SCHEDULE_STORE_RX = /(?:scheduled_tasks\.json|[\\/]scheduled-tasks[\\/][^\\/]+[\\/])/i
// Write-intent shell tokens (redirect / tee / in-place edit / dd / copy-move).
// The redirect branch excludes ONLY fd 2 (2>, 2>>, 2>&1): that duplicates or redirects
// STDERR, it never writes the referenced path -- `cat ref 2>/dev/null` is a read, not a
// write, and a bare `>>?` without this exclusion denied it (measured: card 4f3c0287
// merge, governance-gates.test.ts "ALLOWS reads... " + "does NOT over-fire..." both
// failed on this exact shape before the first fix). A blanket `(?<!\d)` also excluded
// every OTHER digit-prefixed fd -- 1>, 3>, 9> -- so `echo ... 1> ~/.claude/scheduled_tasks.json`
// was allowed again (Cybersec M1, card 4f3c0287 comment 29313): those ARE stdout writes.
// `(?<!\b2)` excludes only a literal "2" immediately before the redirect, leaving every
// other digit-prefixed fd (a real write target) covered.
const WRITE_INTENT_RX = /((?<!\b2)>>?|\btee\b|\bsed\b[\s\S]*\s-i|\bdd\b|\bcp\b|\bmv\b)/i
// Dashboard schedule API, curl spelling only. A WRITE method (POST/PUT/PATCH/
// DELETE) creates/edits a self-paced cron; a GET is legit diagnostics. This pair
// never saw any other HTTP client -- see scheduleSurfaceDeny,
// which covers the API and its on-disk store for every client.
const SCHEDULE_API_RX = /\/api\/schedules\b/i
const HTTP_WRITE_RX = /(-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|(^|\s)(--data\b|--data-\w+\b|-d\b))/i

// THE EGRESS ALLOWLIST IS A GATE ON THE SUB-AGENT ITSELF (EGRESSSELFEDIT824).
// store/egress-allowlist.json decides which hosts egress-gate.mjs lets through, and it
// was a plain writable file in the sub-agent's own tree: on 2026-08-24 a nested
// sub-agent added a domain to reach it and removed it afterwards. Its legitimate
// writers are the MAIN agent (on the owner's go) and the owner by hand -- neither runs
// this gate (it is wired for sub-agents only), so neither is affected.
//
// Native file tools: denied on the file name AND on the resolved real path, so a
// relative path or a symlink created earlier does not walk past the name check.
// Bash: FAIL-CLOSED. A segment that mentions the file may only be a plain READ
// (cat/grep/jq/...), and an output redirect in it may not point at the file. An
// interpreter (python/node/...), cp/mv/tee/sed/ln/... or anything else that names the
// file is denied, because whether it writes cannot be read off the command string.
//
// What this gate CANNOT see -- a script that builds the path at runtime, a glob that
// does not spell the name -- is written down, not hidden: the dashboard keeps a hash
// baseline of the file and reports every change, whoever made it, by whatever route
// (src/egress-allowlist-baseline.ts). This gate narrows the casual route; that one
// catches the rest after the fact.
const ALLOWLIST_BASENAME = 'egress-allowlist.json'
// Card 86c1372a (RedHat GO F-RH1/F-RH3, 1f4c046b follow-up): the Bash-side check below already
// fail-closes on the history dir and this second file by NAME (ALLOWLIST_MENTION_RX), but the
// NATIVE file-tool check further down used to compare only against ALLOWLIST_BASENAME --
// Write/Edit/MultiEdit/NotebookEdit on a file under the history dir, or on this file, were
// allowed (measured: "a fajl-eszkoz kapu nem fedi az elozmeny-konyvtarat ... es a
// store/bash-egress-allowlist.json-t"). Both are now covered below.
const BASH_ALLOWLIST_BASENAME = 'bash-egress-allowlist.json'
// Keep in step with HISTORY_DIRNAME in src/web/egress-allowlist-baseline.ts.
const HISTORY_DIRNAME = 'egress-allowlist.history'
// The STORE objects, not the concept: the file and its history directory, or a glob that
// starts on the name (egress-allow*, egress-allowlist.*). A plain /egress[-_]?allow/ also
// matched this gate's own source and test names (egress-allowlist-baseline.ts), so no
// sub-agent could run, stage or diff them -- review on #1678.
const ALLOWLIST_MENTION_RX = /egress[-_]?allowlist(?:\.json|\.history)|egress[-_]?allow[\w.]*[*?[]/i
const ALLOWLIST_READERS = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'wc', 'ls', 'stat',
  'file', 'shasum', 'sha256sum', 'md5', 'md5sum', 'diff', 'cmp', 'echo', 'printf',
])
// Output redirects: `>`, `>>`, `>|`, `&>`, `&>>`, `N>`. The target is the next word.
const OUTPUT_REDIRECT_RX = /(?:&>>?|\d*>>?\|?)\s*([^\s;&|<>]+)/g

export function allowlistBashSegmentAllowed(seg) {
  const s = String(seg ?? '').trim()
  if (!ALLOWLIST_MENTION_RX.test(s)) return true
  const words = s.split(/\s+/)
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++ // leading VAR=x
  const cmd = (words[i] ?? '').replace(/^.*\//, '')
  if (!ALLOWLIST_READERS.has(cmd)) return false
  for (const m of s.matchAll(OUTPUT_REDIRECT_RX)) {
    const target = m[1]
    if (/^&?\d+$/.test(target) || target === '/dev/null') continue // 2>&1, >/dev/null
    if (ALLOWLIST_MENTION_RX.test(target) || /[$`]/.test(target)) return false
  }
  return true
}

function expandHome(p) {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}
function realOrSelf(p) {
  try { return realpathSync(p) } catch {
    // Card 0e5bbc65 F3: a NEW (never-seen) leaf name has no realpath of its own, and the old
    // bare fallback (return p unresolved) let a symlinked PARENT directory hide behind that
    // new leaf -- a file-tool call naming a fresh file under the history dir, reached through
    // a symlinked alias of the store dir, resolved to a path that never matched the (fully
    // resolved) historyDir. Walk up to the nearest existing ancestor, resolve THAT, and
    // reattach the still-unresolved tail.
    const parent = dirname(p)
    if (parent === p) return p // reached the filesystem root; nothing left to resolve
    return join(realOrSelf(parent), basename(p))
  }
}

// Does a native file-tool call target the allowlist, its history dir, or the Bash-side
// allowlist? `allowlistPath` is the real egress-allowlist.json this install's egress-gate
// reads (tests pass a tmp one); the other two objects live next to it in the same store dir.
export function fileToolTargetsAllowlist(toolInput, allowlistPath = DEFAULT_ALLOWLIST_PATH, cwd = process.cwd()) {
  const raw = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
  if (!raw) return false
  const base = basename(raw).toLowerCase()
  if (base === ALLOWLIST_BASENAME || base === BASH_ALLOWLIST_BASENAME) return true
  const abs = resolve(cwd, expandHome(raw))
  const realAbs = realOrSelf(abs)
  if (realAbs === realOrSelf(allowlistPath)) return true
  const storeDir = dirname(allowlistPath)
  if (realAbs === realOrSelf(join(storeDir, BASH_ALLOWLIST_BASENAME))) return true
  const historyDir = realOrSelf(join(storeDir, HISTORY_DIRNAME))
  return realAbs === historyDir || realAbs.startsWith(historyDir + sep)
}

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
// `heredocs` (optional): when an array is passed, every heredoc the scan resolved
// is pushed onto it as { opStart, bodyStart, bodyEnd, end, quotedTag } in the coordinates
// of the continuation-joined source (which has the same length as the returned
// mask). shellSegments uses it to hand a heredoc body back to the command that
// owns it; the scan itself is unchanged.
// Index of the `)` closing a `$(` whose body starts at `from`, or -1. Quotes
// and nested substitutions inside the body are skipped as bash reads them, so
// `"$(grep -o '"x": "[^"]*"' f)"` closes where bash closes it.
function substEnd(src, from) {
  let depth = 1
  for (let k = from; k < src.length; k++) {
    const c = src[k]
    if (c === '\\') { k++; continue }
    if (c === "'") { const e = src.indexOf("'", k + 1); if (e === -1) return -1; k = e; continue }
    if (c === '"') { const e = dquoteEnd(src, k + 1); if (e === -1) return -1; k = e; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return k
  }
  return -1
}
// Index of the `"` closing a double-quoted string whose body starts at `from`.
function dquoteEnd(src, from) {
  for (let k = from; k < src.length; k++) {
    const c = src[k]
    if (c === '\\') { k++; continue }
    if (c === '"') return k
    if (c === '$' && src[k + 1] === '(') { const e = substEnd(src, k + 2); if (e === -1) return -1; k = e; continue }
    if (c === '`') { const e = src.indexOf('`', k + 1); if (e === -1) return -1; k = e; continue }
  }
  return -1
}

export function maskInertLiterals(command, heredocs, lenient = false) {
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
      const opStart = i
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
      if (!quotedTag && !lenient && /\$\(|`/.test(body)) return null // unquoted tag expands the body
      cur += blank(body) + rel[0]
      if (Array.isArray(heredocs)) heredocs.push({ opStart, bodyStart: i, bodyEnd: i + rel.index, end: i + rel.index + rel[0].length, quotedTag })
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
      if (lenient) { j = dquoteEnd(src, i + 1); if (j === -1) return null } // nested $( ... ) understood
      else while (j < src.length && src[j] !== '"') { j += src[j] === '\\' ? 2 : 1 }
      if (j >= src.length) return null
      const inner = src.slice(i + 1, j)
      if (!lenient && /\$\(|`/.test(inner)) return null // may run a command -> not inert
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
// Human prose in a command-argument position is DATA, not commands. The heredoc
// fix closed one wrapper; this closes the rest of the family: a PR body, a PR
// comment, a release note. The failure mode is identical -- a sentence like
// "runs at the same time" reads as the `at` scheduler at a segment start, and
// the better the prose, the likelier it contains words like at / cron /
// schedule. Same literal-only rule as the other strippers: a double-quoted
// value with $( or ` may substitute, so it is left alone.
const PROSE_FLAGS = String.raw`--body|--message|--notes|--title|--subject|-b|-m|-t`

export function stripProseArguments(seg) {
  const s = String(seg ?? '')
  // Scoped to the tools these prose flags were written for: gh, git, glab (a PR
  // body, a PR comment, a release note). A short flag means different things to
  // different binaries (`tar -t`, `cut -b`, `sort -t`), so blanking it on an
  // unrelated tool would hide real data from the gate (PR #770 review, Szotasz).
  // Same coarse command-word guard as stripGitCommitMessages just below.
  if (!/\b(?:gh|git|glab)\b/i.test(s)) return s
  return s.replace(
    new RegExp(String.raw`((?:^|\s)(?:${PROSE_FLAGS})(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`, 'gi'),
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full
      return flag + (dq ? '""' : "''")
    },
  )
}

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
export const CURL_LEADING_RX = new RegExp(
  String.raw`^\s*(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*${PATH_PREFIX}curl\b`,
  'i',
)
const CURL_STDIN_DATA_RX = /(?:^|\s)(?:-d|--data(?:-(?:raw|binary|ascii))?)(?:\s+|=)@-(?=\s|$)/i
// DECOY-ALONGSIDE-REAL-FLAG BYPASS (card 0f7f7fe9, Cybersec INFO on c7401c5f comment #16876):
// CURL_STDIN_DATA_RX only asks "does `-d @-`/`--data... @-` appear ANYWHERE in the owner span" --
// it says nothing about whether that flag is the ONE that actually consumes the heredoc's stdin.
// `curl -d @- -K - <<'CFG' ... CFG` matches it (the literal text `-d @-` is right there), but curl
// parses `-K`/`--config` and consumes stdin as CONFIG DIRECTIVES (url=/request=/data=@file -- a
// complete outbound send curl assembles itself, exactly the SEND_CONFIG shape
// stdin-consumer-list-narrowness.test.ts already proved dangerous for `-K -` ALONE, card 0ecff3ae)
// before it ever reaches the deferred `-d @-` data-read -- so the REAL consumer of the body is the
// config parser, not the harmless data flag whose presence is being read as proof of safety. Measured
// live: `curl -d @- -K - <<'CFG'` with a `url = "https://api.resend.com/emails" / data = "{}"` body
// blanked the body and passed both email-send-gate.mjs and self-pace-gate.mjs as allow. Same class as
// 4638c14c (a flag SHAPE match standing in for "this command is safe"), just reachable this time
// through a second REAL flag on the correctly-identified curl binary, not a decoy binary. Fix: the
// curl branch also requires the ABSENCE of a stdin-fed config flag -- the same `-K -`/`--config -`/
// `--config=-` shape OPTION_CONSUMERS already pins as "reads OPTIONS, not data" in that test file.
//
// ROUND 2 (QA FAIL on the round-1 fix, same card 0f7f7fe9): the round-1 regex only matched `-K`/
// `--config` with a SEPARATOR (space or `=`) before the trailing `-`. curl's getopt-style short
// option syntax also accepts an ATTACHED value with NO separator at all -- `-K-` -- and real curl
// 8.18.0 confirms `curl -K- < file` and `curl -K - < file` are IDENTICAL (both read config
// directives from stdin); QA proved `curl -d @- -K- <<'CFG'` still passed as allow. Re-deriving
// from curl's actual short-option grammar (not just the one reported shape) surfaced a second,
// same-class hole while building the fix: curl also clusters boolean short flags onto the same
// token as a value-taking one (`-sK-` behaves exactly like `-s -K -`), which a bare `-K-` match
// (anchored to start only at a preceding space) does not catch either. Both are closed here in one
// pass so a third round doesn't have to rediscover the same grammar. `--config-` (no separator) and
// `-K=-` are confirmed NOT valid curl syntax (curl errors before reading anything) -- deliberately
// left unmatched/matched respectively per the measurements in this card's test file, since a
// non-match here only means "stays scanned as ordinary content," never "treated as safe."
const CURL_CONFIG_STDIN_RX = /(?:^|\s)(?:-[A-Za-z]*K-|-K(?:\s+|=)-|--config(?:\s+|=)-)(?=\s|$)/i
// ROUND 3 (Cybered NO-GO, same card 0f7f7fe9): rounds 1-2 closed curl's OWN getopt grammar (attached,
// clustered, separated, `=`) but CURL_CONFIG_STDIN_RX still runs on the RAW owner-span text, before
// shell quote-removal. Any quoting or backslash-escaping around the flag survives byte-for-byte in
// that raw text and breaks the regex while curl (which sees the argv AFTER the shell removes it)
// still reads stdin as config. Live-confirmed with real curl 8.18.0: `"-K" -`, `-"K" -`, `'-K' -`,
// `--"config" -` and `\-K -` all resolve to the identical argv as the already-closed `-K -`, and
// `heredocIsStdinDataSink` returned true (safe to blank) on every one of them pre-fix -- an end-to-end
// gateDecision() on a real api.resend.com send-config heredoc came back allow:true through each.
//
// Per this file's own standing lesson (`build-an-enumeration-from-the-grammar-not-from-the-patch`),
// the fix is not a sixth regex alternative for a sixth quoting spelling -- it is closing the AXIS:
// the flag is checked on the raw span AND on a de-quoted view of the same span, so no future spelling
// of "the same bytes, minus shell quoting" needs its own round. `dequoteCurlSpan` below undoes single
// quotes, double quotes, `$'...'` (via the SAME `readAnsiC` decoder `unquoteWord` already uses -- not
// a second decoder), `$"..."` (locale-quoting, bash manual 3.1.2.5 -- Cybersec r4 NO-GO: this round's
// own "the four mechanisms" framing missed this fifth one, and `curl -d @- $"-K" -` bypassed to
// allow:true pre-fix, 56/245 grammar-derived cases, all this one mechanism, 0 others) and a bare
// backslash-escape, exactly the way bash's own word expansion would.
//
// SCOPED ON PURPOSE: this only widens the CONFIG-FLAG check (the one axis a decoy attacker benefits
// from hiding). `CURL_LEADING_RX` and `CURL_STDIN_DATA_RX` are left reading the raw span -- an
// attacker who quotes the curl binary name or the `-d @-` decoy only defeats their OWN exemption
// (the heredoc stays scanned either way), so there is no bypass incentive on those two axes and no
// reason to touch code this file's history says stays safer the less it moves per round.
//
// ACCEPTED TRADE-OFF, same direction as the pre-existing `-oK-` false positive QA already pinned:
// de-quoting can also unwrap an UNRELATED quoted argument that merely CONTAINS the text `-K -` (e.g.
// a quoted header value), causing a legitimate `-d @-` send to stay scanned instead of being blanked.
// That is over-caution, not a bypass -- the body still gets scanned normally, nothing is silently
// allowed -- and is pinned as a test below so it stays a deliberate choice rather than a surprise.
//
// OUT OF SCOPE, NOT TOUCHED: `GIT_STDIN_MSG_RX` (`-F -`/`--file -`) reads the same kind of raw span
// and is plausibly reachable by the identical quoting trick (`git commit "-F" -`) -- flagged in this
// card's REVIEW as a follow-up, not fixed here, because Cybered's NO-GO and this round's live repro
// are both curl-only and a git-side change would be unreviewed scope creep in a security-critical file.
function dequoteCurlSpan(span) {
  const src = String(span ?? '')
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      const n = src[i + 1]
      if (n === undefined) { out += c; i++; continue }
      out += n
      i += 2
      continue
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      if (j === -1) { out += src.slice(i + 1); break }
      out += src.slice(i + 1, j)
      i = j + 1
      continue
    }
    if (c === '$' && src[i + 1] === "'") {
      const [text, next] = readAnsiC(src, i + 2)
      out += text
      i = next
      continue
    }
    // `$"..."` (locale-quoting): same body-parsing rules as a plain `"..."` (bash strips the `$`
    // and translates the string at runtime, but the byte content curl/git ultimately see is
    // identical) -- skip just the `$` and let the existing `"` branch below do the rest.
    if (c === '$' && src[i + 1] === '"') { i += 1; continue }
    if (c === '"') {
      let j = i + 1
      let body = ''
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { body += src[j + 1] ?? ''; j += 2; continue }
        body += src[j]; j++
      }
      out += body
      i = j + 1
      continue
    }
    out += c
    i++
  }
  return out
}
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
export const GIT_LEADING_RX = new RegExp(
  String.raw`^\s*(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*${PATH_PREFIX}git\b`,
  'i',
)
// commit/tag/notes are the subcommands that read a message from a file; `-F` means something else
// entirely elsewhere in git (e.g. `git branch -F` does not exist, but `git grep -F` is fixed-string
// matching), so the subcommand check is what keeps this from becoming a general `-F -` exemption.
const GIT_MSG_SUBCMD_RX = /(?:^|\s)(?:commit|tag|notes)(?:\s|$)/i
// -F-, -F -, --file -, --file=-
const GIT_STDIN_MSG_RX = /(?:^|\s)(?:-F\s*-|--file(?:\s+|=)-)(?=\s|$)/

// The SAME two-shape exemption stripHeredocDataPayloads's callback decides with, extracted so a
// second consumer (email-send-gate.mjs, card c7401c5f) can ask the identical question about an
// owner span without redefining curl's/git's stdin-data shape a second time. True only for curl's
// OWN `-d @-`/`--data-binary @-`-shaped stdin read or git's OWN `commit|tag|notes -F -` message
// read -- the two shapes that are proven to never execute what they are given, see the CURL_LEADING_RX
// and GIT_LEADING_RX headers above for the incidents that pinned each guard individually. The curl
// branch also requires the ABSENCE of `-K -`/`--config -`/`--config=-` (CURL_CONFIG_STDIN_RX, card
// 0f7f7fe9) -- a `-d @-` shape match proves nothing about who actually reads the heredoc's stdin when
// a real stdin-config flag sits in the same span; see that regex's header for the measured bypass.
// The config check runs on BOTH the raw span and its de-quoted view (`dequoteCurlSpan`, round 3,
// same card) -- see that function's header for why only this one axis needs it.
export function heredocIsStdinDataSink(ownerSpan) {
  const curl =
    CURL_LEADING_RX.test(ownerSpan) &&
    CURL_STDIN_DATA_RX.test(ownerSpan) &&
    !CURL_CONFIG_STDIN_RX.test(ownerSpan) &&
    !CURL_CONFIG_STDIN_RX.test(dequoteCurlSpan(ownerSpan))
  const git =
    GIT_LEADING_RX.test(ownerSpan) && GIT_MSG_SUBCMD_RX.test(ownerSpan) && GIT_STDIN_MSG_RX.test(ownerSpan)
  return curl || git
}
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
//
// Card 1fec67e9 (backend, live-profiled with --prof, not just theorized -- an earlier draft of this
// fix targeted the wrong line entirely): a dense run of literal backticks makes THIS function the
// O(n^2) driver of stripHeredocDataPayloads's DoS. Backtick is not a word terminator (by design, for
// the six nested shapes documented above), so the `c === '`'` branch below just keeps pairing
// backticks and continuing the loop -- for a run of n adjacent backticks it walks to the end of the
// WHOLE remaining run. matchCmdPrefix (the caller) gets invoked at roughly every other position
// across that same run (an artifact of the boundary push/pop ping-pong in stripHeredocDataPayloads,
// untouched by this fix), so the same near-full-length scan repeats ~n/2 times -- O(n^2) total.
// Profiled: n=32000 backticks, scanBashWord/matchCmdPrefix were >40% of total ticks.
//
// SCAN_BASH_WORD_MAX_LEN bounds a single call's work to a constant, which is what actually closes
// the DoS (O(n) calls x O(1) capped cost = O(n), not O(n) x O(n)). Chosen generously against the six
// real shapes this scanner exists for (all under 30 chars: `f$(y $(z))`, `` f`echo $(y)` ``, etc.) --
// no legitimate bash function/coproc NAME is anywhere near 1024 chars, so the cap changes the answer
// for exactly zero shapes bash itself could execute. Past the cap this returns -1 same as an
// unterminated quote/backtick a few lines below -- the file's own established "no answer" value for
// "this cannot be resolved as a word", not a new failure mode.
const SCAN_BASH_WORD_MAX_LEN = 1024
function scanBashWord(src, start) {
  let j = start
  while (j < src.length) {
    if (j - start > SCAN_BASH_WORD_MAX_LEN) return -1
    const c = src[j]
    if (c === '\\') { j += 2; continue }
    // ANSI-C $'...' (card 5c9c15c0, Cybered 84e31b40 round 11): a plain `indexOf("'", ...)` below
    // stops at the FIRST apostrophe, including an ESCAPED one (\') -- wrong only for this form,
    // where bash treats \' as a literal quote inside the string, not the terminator. Not exploitable
    // today (every NAME position this function is called for rejects an apostrophe outright before
    // the body ever runs, so a real `$'...'` word can never reach here as a NAME) -- fixed anyway for
    // the same reason ec20dd23 fixed the QUOTED_LITERAL_RX/unquoteWord copy of this exact blindness:
    // consistency now is cheaper than a live repro later. Reuses readAnsiC (the ONE decoder this file
    // already has) purely for its end-of-string index -- the decoded text itself is not needed here,
    // scanBashWord only ever returns a span.
    if (c === '$' && src[j + 1] === "'") { j = readAnsiC(src, j + 2)[1]; continue }
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

// Card c7401c5f: the OWNERSHIP walk below (quote/nesting/case-statement aware -- the state machine
// stripHeredocDataPayloads has exercised through ~150 adversarial cases) used to be inlined into
// stripHeredocDataPayloads itself, hard-wired to a curl/git-only exemption decision. Extracted here
// so the SAME walk can answer a second, differently-scoped question (email-send-gate.mjs: "which
// heredocs feed an INTERPRETER") without a second copy of the parser -- the anti-duplication rule
// this file already states for `extractHeredocBodies`/`blankHeredocBodies` cuts the other way for
// THIS walk specifically, because those two are deliberately naive (no nesting/case tracking) while
// this one is the hardened one every consumer actually needs. `onHeredoc(record)` is called once per
// heredoc, in source order, with `{ atIndex, ownerSpan, body, quotedTag, substitutable }` --
// `atIndex` is the index of the heredoc's own `<<` token (the same unit bash-ast.mjs's
// heredocOwnerSpans keys its Map by), `ownerSpan` is this walker's answer for "which simple command
// owns it" (`src.slice(boundary, atIndex)`), and the rest mirror what stripHeredocDataPayloads always
// computed inline. The callback returns `true` to blank the body in `out` (length-preserving, spaces)
// or `false` to leave it verbatim -- stripHeredocDataPayloads's own callback reproduces its previous
// inline decision EXACTLY, so this extraction changes nothing about its behaviour or output.
function heredocWalk(command, onHeredoc) {
  const src = String(command ?? '')
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
    //    guard-allow: documented-anti-pattern illustrative example of a command shape this
    //    parser must classify correctly, never executed -- not the fleet's own curl recipe.
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
    const atIndex = i
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
    const blank = onHeredoc({ atIndex, ownerSpan: span, body, quotedTag, substitutable })
    if (blank) out += ' '.repeat(body.length)
    else out += body
    out += rel[0]
    i += rel.index + rel[0].length
    boundary = i
  }
  return out
}

export function stripHeredocDataPayloads(command) {
  const src = String(command ?? '')
  // Computed ONCE per call, not per heredoc: the parse is the expensive half (~8 ms p50 over the
  // current gate) and the answer covers every heredoc in the command at once.
  const mode = astMode()
  const astSpans = mode === 'off' ? null : heredocOwnerSpans(src)
  return heredocWalk(src, ({ atIndex, ownerSpan, substitutable }) => {
    // DARK LAUNCH (card f16b3165, plan-grilling change 3). `ownerSpan` is the walker's answer to
    // "which simple command owns this heredoc"; astSpans holds tree-sitter-bash's answer to the
    // same question. Both are computed, the two DECISIONS are compared, and any disagreement is
    // recorded -- but the walker still drives behaviour unless SELF_PACE_AST=on. The ownership
    // CHECKS below are shared by both paths and are not touched: only the span they read changes.
    // The AST supplies only the BOUNDARY; the span is sliced from the same source, the same way,
    // so both recognisers hand the checks below identical units.
    const astBoundary = astSpans === null ? undefined : astSpans.get(atIndex)
    const astSpan = astBoundary === undefined ? null : src.slice(astBoundary, atIndex)
    const walkerSays = heredocIsStdinDataSink(ownerSpan)
    // An absent key is a real answer from a successful parse ("no heredoc owner here"), which for
    // these checks is indistinguishable from an empty span -- both decide false.
    const astSays = astSpans === null ? null : heredocIsStdinDataSink(astSpan ?? '')
    if (astSays !== null && astSays !== walkerSays) {
      recordAstDivergence(src, ownerSpan, astSpan ?? '', walkerSays, astSays)
    }
    // Fail-closed cutover: the AST answer is only allowed to drive when it EXISTS. A null (absent
    // dependency, oversized input, parse error) keeps the current behaviour rather than defaulting
    // to "not an exempt payload", which would turn every parser hiccup into a false deny.
    const feedsStdinData = mode === 'on' && astSays !== null ? astSays : walkerSays
    return feedsStdinData && !substitutable
  })
}

// The general-purpose form of the same walk (card c7401c5f): every heredoc's owner span and body,
// with NO blank/keep decision baked in -- unlike stripHeredocDataPayloads, this never mutates the
// command text, it only reports. email-send-gate.mjs uses this to find heredocs owned by an
// INTERPRETER (a heredoc HEREDOC_RE necessarily strips before tokenizing in isSendInvocation, since
// a heredoc body is not shell syntax) and scan just those bodies -- a different consumer of the same
// ownership answer, not a second parser.
export function heredocOwnerRecords(command) {
  const records = []
  heredocWalk(command, (record) => {
    records.push(record)
    return false // this consumer never blanks -- it only wants to see every record
  })
  return records
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
// Heredoc bodies are DATA, not commands. A worker writing a real commit message
// through `git commit -F - <<EOF … EOF` had the turn denied because one prose
// line happened to start with "at " -- which SCHEDULER_RX reads as the `at`
// scheduler at a segment start. A heredoc body is data, so blank it before any
// pattern runs. Handles <<- for tab-indented bodies.
//
// EXCEPT when the body can still run something. A QUOTED marker (<<'EOF' or
// <<"EOF") is literal: the shell performs no expansion inside it, so blanking is
// safe. An UNQUOTED marker (<<EOF) is not -- the shell expands $(...) and
// backticks in that body at exec time, so blanking one would hide a live
// command substitution from SCHEDULER_RX and the gate would stop seeing
// something that really runs:
//
//     git commit -m "$(cat <<EOF
//     fix
//     $(at now)
//     EOF
//     )"
//
// This is the same rule the other strippers already apply: stripDataPayloads,
// stripGitCommitMessages and stripProseArguments all leave a double-quoted
// value alone when it contains `$(` or a backtick. An unquoted heredoc is the
// same category; it was simply missing the guard. Reported on PR #770.
// Whether the command word owning a heredoc redirect EXECUTES the body. The
// shell-literal guard above is not enough: a quoted marker (<<'EOF') is literal
// to the SHELL, so blanking looks safe, but `bash <<'EOF'`, `sh`, `ssh box`,
// `python - <<'EOF'` feed the body to an interpreter that runs it -- blanking
// would hide a live scheduler command from the gate (PR #770 review, Szotasz).
// `git commit -F - <<'EOF'` feeds the body to git as DATA, so that stays safe to
// blank. So: keep the body visible when its redirect owner is an interpreter or
// remote/container executor.
const HEREDOC_INTERPRETER_RX = /^(?:bash|sh|zsh|dash|ksh|ash|python[0-9.]*|node|nodejs|ruby|perl|php|ssh)$/

function heredocOwnerRunsBody(before) {
  // `before` is the command text up to the << redirect; the owner is the first
  // word of the last command segment.
  const seg = before.split(/\n|;|\|\|?|&&?|\(|\{/).pop() ?? ''
  const tokens = seg.trim().split(/\s+/).filter(Boolean)
  // Pass-through prefixes that do not change what runs the body.
  while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) ||
    ['sudo', 'env', 'nice', 'time', 'exec', 'command', 'nohup', 'stdbuf'].includes(tokens[0]))) {
    tokens.shift()
  }
  if (!tokens.length) return false
  const word = tokens[0].split('/').pop()
  if (HEREDOC_INTERPRETER_RX.test(word)) return true
  // docker/podman/kubectl exec run the body through a shell in the target.
  if (['docker', 'podman', 'kubectl'].includes(word) && tokens.slice(1).includes('exec')) return true
  return false
}

export function stripHeredocBodies(command) {
  const cmd = String(command ?? '')
  if (!/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*/.test(cmd)) return cmd
  return cmd.replace(
    /(<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2)([\s\S]*?)(^\s*\3\s*$)/gm,
    (full, open, quote, _marker, body, close, offset, string) => {
      const literal = quote === "'" || quote === '"'
      if (!literal && (body.includes('$(') || body.includes('`'))) return full
      // A quoted body the shell will not expand is still executed when an
      // interpreter/remote-executor owns the redirect -- keep it visible then.
      if (heredocOwnerRunsBody(string.slice(0, offset))) return full
      return `${open}\n${close}`
    },
  )
}

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

// ---------------------------------------------------------------------------
// Dashboard schedule surface: the /api/schedules API and the on-disk store it
// writes (~/.claude/scheduled-tasks/).
//
// Measured on a live install: a sub-agent created four schedules with a python
// urllib POST, four times HTTP 200. The per-segment check below this block only
// knew the CURL spelling of a write (-X POST / -d / --data), so every other
// HTTP client -- python urllib/requests, node fetch, wget --post-data, httpie,
// nc -- was a write the gate could not see. Adding those spellings one by one
// is a losing blacklist (miss one client and it is a hole), so this block
// inverts the question:
//
//   1. Does the command REFERENCE the schedule surface at all, in any spelling?
//      (path /api/schedules through any host/port, the scheduled-tasks
//      directory, the schedule-registry-cli tool by name, or an SQL write on
//      a scheduled_task* table; the database file has its own narrower rule,
//      see DASHBOARD_DB_REF_RX; also after the shell's own quote and backslash removal, after
//      \xHH / \uHHHH / octal / %HH decoding, after string concatenation glued to
//      a slash, after brace expansion, and through any glob or bracket segment
//      that could expand onto the store or the route -- see globRefs.)
//   2. If it does, the command is judged by FLAT, fail-closed invariants -- no
//      shell-state modelling (an earlier cwd/shadow-tracking draft had bypasses:
//      cd -/OLDPWD/failed-cd, a function shadowing an allowed name):
//      - ANY cd/pushd/popd whose argument references the store denies the whole
//        command (a sub-agent has no reason to enter the store);
//      - ANY function/alias/shadow definition (name(), function, alias, enable,
//        builtin, command, exec) denies;
//      - a variable that carries a reference may not reach a program's
//        environment (export, declare -x, set -a), and the builtins that
//        assign a variable without a NAME=value word (printf -v, read,
//        mapfile, a nameref) deny;
//      - a command is trusted (below) only by a bare name or an exact system
//        binary path, so `/tmp/cat` and `./curl` do not pass.
//      Then every segment that carries the reference must be one of a few forms
//      that are PROVABLY unable to write it:
//        a. a plain curl GET: `curl -q [-s -S -f -L -i -k -v ...] [-H v] [-m n]
//           URL` -- -q FIRST (no curlrc), no -w/-X/-d/--data*/--json/-F/-T/-K/
//           -o/-D/--url, exactly one URL, a literal http(s):// scheme, no
//           unquoted $ expansion (word splitting can inject -X POST), and
//           header values that cannot carry a line break (curl sends one
//           verbatim, so a smuggled second request could ride along). The one
//           file-content a header may carry is the fleet token file, injected as
//           a NUL nonce that shell source cannot express -- a literal
//           `${DASHBOARD_TOKEN}` (or any surviving $) in a header denies;
//        b. a read-only file command (ls, cat, grep, head, tail, wc, stat, ...;
//           find without -exec/-delete/-fprint) whose output, if piped, only
//           reaches plain text filters -- `cat <<EOF | python3` stays denied;
//        c. a carrier whose reference sits ONLY in literal message data: a curl
//           -d/--data value (or a quoted heredoc fed to --data-binary @-), a git
//           commit/tag/stash -m message (or -F - heredoc), a gh/glab prose
//           argument (--body/--title/--notes/... or a --body-file - heredoc,
//           any subcommand but `api`: the same scope stripProseArguments
//           blanks), the content argument of scripts/agent-msg.sh. The value
//           is identified by PARSING the command's own option grammar, not by
//           a regex over the text, so `curl -H -d 'http://.../api/schedules'`
//           (where the "payload" is the URL) is not mistaken for data.
//      Anything else -- any interpreter, any other client, a redirect, cp/mv/
//      tee, an unknown curl option, quoting that cannot be resolved -- is
//      denied. A segment that does NOT reference the surface is judged exactly
//      as it would be on its own, so a pipe consumer like `| python3 -c ...`
//      after a plain curl GET stays allowed.
//
// What this does NOT close, stated so nobody mistakes it for more:
//   - a script FILE the agent wrote in an EARLIER call (the Write tool, or a
//     Bash call that never mentions the surface) and then runs -- allowed on
//     purpose, since the Write tool can write any file. In the SAME command a
//     heredoc that carries a reference may not be redirected to a file
//     (`cat <<'EOF' > /tmp/x.py ... EOF; python3 /tmp/x.py` is denied);
//   - a list of store paths written to a file in one segment and consumed in
//     another (`ls -d <store>/*/SKILL.md > /tmp/l; while read f; do echo x >>
//     "$f"; done < /tmp/l`): the write segment's path comes from `read`, not
//     from the command text;
//   - a reference assembled at run time (chr(), base64, `$(echo sch)edules`, a
//     variable split across segments, a symlink to the store), or a URL/config
//     taken from the environment;
//   - a curlrc: ~/.curlrc can turn ANY curl, even one with no reference, into a
//     write; only form (a) is protected, by requiring -q;
//   - a cd into the store whose effect PERSISTS to a LATER Bash call, IF Claude
//     Code keeps the cwd across calls (unverified): a per-command gate cannot
//     see the earlier cd. Rule 1 still denies that cd in the command where it
//     appears.
// None of these are provable from a single command's text. They belong to the
// server side (a per-agent dashboard token the schedule routes can refuse) and
// the runner side (a registry the runner checks before it fires a task), both
// separate changes. The gate stays what its header says: a hard stop for the
// casual self-pace, not a sandbox.
// ---------------------------------------------------------------------------

// The route, as the dashboard router resolves it. Up to three intermediate path
// segments are tolerated because the router's URL parser resolves dot segments
// (`/api/./schedules`, `/api/x/../schedules`) onto the same route; a lookalike
// that is not a real route is denied as well, which costs nothing.
// Intermediate segments are NON-empty ({1,64}): with {0,64} a run of slashes
// could be split between the \/+ groups in O(n^4) ways, and a hook that times
// out is a hook that did not block.
const SCHEDULE_API_REF_RX = /api\/+(?:[^\s/]{1,64}\/+){0,3}schedules/i
// The store the schedule runner reads. Matched by NAME, not by the
// ~/.claude/ prefix, on purpose: the same directory is reachable through
// links (the isolated config dirs .claude-config / .channels-config link
// their scheduled-tasks entry to ~/.claude/scheduled-tasks), and the repo's
// scheduled-tasks/ and seed-scheduled-tasks/ are copied INTO it by the dashboard
// start and update.sh. The lookahead keeps files that merely share the prefix
// (scheduled-tasks-io.ts, docs/scheduled-tasks.md) out of it.
const SCHEDULE_DIR_REF_RX = /scheduled-tasks(?![\w-]|\.\w)/i
const SCHEDULE_DIR_NAME = 'scheduled-tasks'
// Directories the store is reachable under (the home config dir and the two
// symlinked config dirs, see SCHEDULE_DIR_REF_RX).
const STORE_PARENTS = ['.claude', '.claude-config', '.channels-config']
// Names a glob or bracket segment is checked against: if it can expand to one
// of them, it is read as that name.
// The registry operator tool (and the module behind it), matched by NAME in
// any path, extension and runner form: it opens the database directly, so a
// task registered through it never passes the dashboard's routes. Only its
// read-only subcommands are accepted (isRegistryCliRead). The lookahead keeps
// test files that share the prefix (schedule-registry-shell-paths.test.ts)
// out of it. The tool may not exist on a given install; the rule does not
// depend on it.
const SCHEDULE_CLI_REF_RX = /schedule-registry(?:-cli)?(?:\.[cm]?[jt]s)?(?![\w.-])/i
const SCHEDULE_CLI_NAMES = ['schedule-registry-cli.js', 'schedule-registry-cli.ts', 'schedule-registry.js', 'schedule-registry.ts']
// An SQL write on a schedule table (scheduled_tasks, scheduled_task_registry,
// ...), whatever program runs it: the sqlite3 CLI, python, node, a heredoc.
const SCHEDULE_SQL_WRITE_RX = /\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|delete\s+from|update(?:\s+or\s+\w+)?|drop\s+(?:table|trigger|view)(?:\s+if\s+exists)?|alter\s+table|create\s+(?:temp\w*\s+)?(?:table|view)(?:\s+if\s+not\s+exists)?)\s+(?:\w+\.)?scheduled_task|\bcreate\s+(?:temp\w*\s+)?trigger\b[\s\S]{0,300}?\bon\s+(?:\w+\.)?scheduled_task/i
// The dashboard database file (and its WAL/SHM/journal). Reads by any program
// stay allowed (a worker reads the board with sqlite3 SELECT); a FILE-level
// write -- a redirect onto it, cp/mv/tee/dd/rm/ln/... naming it, or a sqlite3
// dot-command that replaces or runs files -- is denied (dbSegmentWrites).
const DASHBOARD_DB_REF_RX = /claudeclaw\.db(?:-wal|-shm|-journal)?(?![\w.-])/i
const GLOB_TARGETS = [SCHEDULE_DIR_NAME, 'schedules', 'api', ...STORE_PARENTS, ...SCHEDULE_CLI_NAMES, 'claudeclaw.db']
const FILE_GLOB_TARGETS = new Set([...SCHEDULE_CLI_NAMES, 'claudeclaw.db'])
// Brace expansion is enumerated up to this many words; beyond it, a word that
// could still spell a reference is treated as one (fail closed).
const BRACE_EXPANSION_CAP = 1024

function codePoint(n) {
  try { return String.fromCodePoint(n) } catch { return '' }
}

// Escapes that a shell (printf/echo -e/$'...') or the interpreter the command
// runs (python, node, perl) resolves before the text becomes a URL or a path.
function decodeEscapes(s) {
  return s
    .replace(/\\x([0-9a-f]{2})/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/\\([0-7]{3})/g, (_, o) => codePoint(parseInt(o, 8)))
    .replace(/%([0-9a-f]{2})/gi, (_, h) => codePoint(parseInt(h, 16)))
}

// Spellings of the same text that the matchers run against. Each one can only
// ADD matches (it removes or decodes characters), so it can never let a
// reference through that the raw text would have caught.
export function scheduleSurfaceVariants(text) {
  const joined = String(text ?? '').replace(/\\\r?\n/g, '')
  const decoded = decodeEscapes(decodeEscapes(joined)) // twice: %5cx73 -> \x73 -> s
  // quotes, backslashes and $IFS are shell syntax: gone before the program runs
  const unquoted = decoded.replace(/\$\{IFS\}|\$IFS\b/g, '').replace(/[\\'"`]/g, '')
  // string concatenation in any language ('/api/' + 'schedules', "/api/"."x",
  // implicit "a" "b", ','.join): separators glued to a slash disappear...
  // (the lookbehind starts a match only at the beginning of a separator run, so
  // a long run with no slash is scanned once, not once per character)
  const glued = unquoted.replace(/(?<![\s+,.])[\s+,.]*\/[\s+,.]*/g, '/')
  // ...and a literal split mid-word ('sch' + 'edules', "sch"."edules") closes up
  const joinedLiterals = decoded.replace(/(['"`])\s*(?:[+.,]\s*)?(['"`])/g, '')
    .replace(/\$\{IFS\}|\$IFS\b/g, '').replace(/[\\'"`]/g, '')
  return [joined, unquoted, glued, joinedLiterals]
}

function globMatchesName(glob, name) {
  let rx = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') rx += '.*'
    else if (c === '?') rx += '.'
    else if (c === '[') {
      const j = glob.indexOf(']', i + 1)
      if (j === -1) { rx += '\\['; continue }
      rx += '[' + glob.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'
      i = j
    } else rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  try { return new RegExp(`^${rx}$`, 'i').test(name) } catch { return true } // unreadable glob: fail closed
}

// Bash brace expansion of one word: `api/sch{e,}dules` -> [api/schedules,
// api/schdules]; `{a..c}` sequences too. Returns null past `cap` words. `${`
// is a parameter expansion, not a brace group, and is left alone.
function findBraceGroup(w) {
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== '{' || w[i - 1] === '$') continue
    let depth = 0
    let last = i + 1
    const parts = []
    for (let j = i; j < w.length; j++) {
      if (w[j] === '{') depth++
      else if (w[j] === ',' && depth === 1) { parts.push(w.slice(last, j)); last = j + 1 }
      else if (w[j] === '}' && --depth === 0) {
        parts.push(w.slice(last, j))
        if (parts.length > 1) return { start: i, end: j, alts: parts }
        const seq = /^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])$/.exec(parts[0])
        if (!seq) break
        const num = /^-?\d+$/.test(seq[1]) && /^-?\d+$/.test(seq[2])
        const [a, b] = num ? [Number(seq[1]), Number(seq[2])] : [seq[1].charCodeAt(0), seq[2].charCodeAt(0)]
        if (!num && /^-?\d+$/.test(seq[1]) !== /^-?\d+$/.test(seq[2])) break
        if (Math.abs(b - a) > BRACE_EXPANSION_CAP) return { start: i, end: j, alts: null }
        const alts = []
        for (let k = a; a <= b ? k <= b : k >= b; k += a <= b ? 1 : -1) alts.push(num ? String(k) : String.fromCharCode(k))
        return { start: i, end: j, alts }
      }
    }
  }
  return null
}
function expandBraces(word, cap) {
  const out = []
  const todo = [word]
  while (todo.length) {
    const w = todo.pop()
    const g = findBraceGroup(w)
    if (!g) { out.push(w); continue }
    if (!g.alts) return null
    for (const alt of g.alts) todo.push(w.slice(0, g.start) + alt + w.slice(g.end + 1))
    if (todo.length + out.length > cap) return null
  }
  return out
}

// Is `needle` a subsequence of `hay`? Every brace expansion of a word is a
// subsequence of that word with `{`, `}` and `,` removed, so a word that fails
// this for every target cannot expand to a reference -- no enumeration needed.
function isSubsequence(needle, hay) {
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++
  return i === needle.length
}

// Shell words of `text` with a per-character quoted flag: [[{ c, q }]]. Heredoc
// bodies are dropped (they are data for the program that reads them, never
// expanded as words). A command substitution inside double quotes, $(...) or
// `...`, is a fresh unquoted context in bash, so its text is scanned again as
// words of its own. Returns null when the quoting cannot be resolved.
export function quotedWords(text, depth = 0) {
  if (depth > 8) return null
  const src = String(text ?? '').replace(/\\\r?\n/g, ' ')
  const heredocs = []
  if (maskInertLiterals(src, heredocs, true) == null) return null
  let s = src
  for (const h of heredocs) s = s.slice(0, h.bodyStart) + ' '.repeat(h.end - h.bodyStart) + s.slice(h.end)
  const words = []
  let cur = []
  const flush = () => { if (cur.length) words.push(cur); cur = [] }
  const inner = (from, close) => (close === '`' ? s.indexOf('`', from) : substEnd(s, from))
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'") {
      const e = s.indexOf("'", i + 1)
      if (e === -1) return null
      for (const ch of s.slice(i + 1, e)) cur.push({ c: ch, q: true })
      i = e; continue
    }
    if (c === '"') {
      let j = i + 1
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && j + 1 < s.length) { j++; cur.push({ c: s[j], q: true }); continue }
        const sub = s[j] === '`' ? '`' : (s[j] === '$' && s[j + 1] === '(' ? ')' : '')
        if (sub) {
          const from = j + (sub === '`' ? 1 : 2)
          const e = inner(from, sub)
          if (e === -1) return null
          const nested = quotedWords(s.slice(from, e), depth + 1)
          if (nested == null) return null
          words.push(...nested)
          cur.push({ c: '\u0002', q: true }) // the substituted output: unknown, literal
          j = e; continue
        }
        cur.push({ c: s[j], q: true })
      }
      if (j >= s.length) return null
      i = j; continue
    }
    if (c === '\\' && i + 1 < s.length) { cur.push({ c: s[i + 1], q: true }); i++; continue }
    if (/\s/.test(c) || ';&|<>()`'.includes(c)) { flush(); continue }
    cur.push({ c, q: false })
  }
  flush()
  return words
}

// Words the shell (brace expansion, pathname globbing) or curl (URL globbing:
// {a,b} and [a-z], even inside quotes) turns into OTHER words. Each is expanded
// and every glob or bracket segment is read as the target name it can match, so
// `api/sch{e,}dules`, `api/sch[e]dules`, `~/.c*/sch*`, `.channels-config/sched*`
// and `cd sched*` all count. Only UNQUOTED metacharacters count -- bash expands
// nothing inside quotes, and a python regex like '[a-z]*' is not a path --
// except in a URL word, where curl globs quoted text too. A pure `*` segment
// only counts under a store parent (`~/.claude/*`, or after a cd into one:
// opts.parentCtx), otherwise every `ls src/*` would. A bracket segment counts
// on ANY match: rare in paths, and it fails closed.
const NEUTRAL = '\u0002' // stands in for a quoted metacharacter: literal, matches no target
function globRefs(text, opts) {
  const out = { api: false, dir: false, cli: false, db: false }
  const words = quotedWords(text)
  const list = words
    ? words.map((w) => {
      // a real URL (scheme://host...): curl globs {a,b} and [x-y] in it even
      // when quoted. A grep pattern like 'https\?://[^ ]*' is not one.
      const url = /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.\-[\]:$]+(?:\/|$)/i.test(w.map((x) => x.c).join(''))
      return w.map((x) => (x.q && '*?[]{},'.includes(x.c) && !(url && '[]{},'.includes(x.c)) ? NEUTRAL : x.c)).join('')
    })
    : scheduleSurfaceVariants(text)[1].split(/[\s;&|<>()]+/) // unresolvable quoting: read every metachar (fail closed)
  for (const raw of list) {
    const word = raw.replace(/[\\'"`]/g, '')
    if (!/[*?[\]{}]/.test(word)) continue
    const flat = word.replace(/[{},]/g, '').toLowerCase()
    // a glob character can stand for any letters, so then always enumerate
    const mayBrace = /[*?[]/.test(word) || ['schedules', 'scheduled-tasks', 'schedule-registry', 'claudeclaw.db'].some((t) => isSubsequence(t, flat))
    const exps = /[{}]/.test(word) ? (mayBrace ? expandBraces(word, BRACE_EXPANSION_CAP) : [word.replace(/[{}]/g, '')]) : [word]
    if (!exps) return { api: true, dir: true, cli: true, db: true } // too many expansions to prove harmless
    for (const e of exps) {
      if (SCHEDULE_API_REF_RX.test(e)) out.api = true
      if (SCHEDULE_DIR_REF_RX.test(e)) out.dir = true
      const segs = normalizePathSegments(e)
      const mapped = segs.map((seg, i) => {
        if (!/[*?[]/.test(seg)) return seg
        const bracket = /\[[^\]]*\]/.test(seg)
        const literal = seg.replace(/\[[^\]]*\]|[*?]/g, '').length
        // the parent segment must name a store parent with some literal text
        // (`.claude`, `.c*`): a bare `*/*` is not evidence of anything
        const prev = segs[i - 1] ?? ''
        const parent = i > 0
          ? prev.replace(/\[[^\]]*\]|[*?]/g, '').length >= 2 && STORE_PARENTS.some((p) => globMatchesName(prev, p))
          : !!opts?.parentCtx
        // a file name target needs literal text beyond its extension: `*.ts`
        // or `*.db` alone is every such file, not evidence of this one
        const stem = seg.replace(/\.[cm]?[jt]s$|\.db$/i, '').replace(/\[[^\]]*\]|[*?]/g, '').length
        for (const name of GLOB_TARGETS) {
          if (!globMatchesName(seg, name)) continue
          if (FILE_GLOB_TARGETS.has(name) && !bracket && stem < 3) continue
          if (bracket || literal >= 3 || (name === SCHEDULE_DIR_NAME && parent)) return name
        }
        return seg
      }).join('/')
      if (SCHEDULE_API_REF_RX.test(mapped)) out.api = true
      if (SCHEDULE_DIR_REF_RX.test(mapped)) out.dir = true
      if (SCHEDULE_CLI_REF_RX.test(e) || SCHEDULE_CLI_REF_RX.test(mapped)) out.cli = true
      if (DASHBOARD_DB_REF_RX.test(e) || DASHBOARD_DB_REF_RX.test(mapped)) out.db = true
    }
  }
  return out
}

// Lexical path normalisation before a word is read segment by segment: `//`
// and `/./` collapse and `x/..` resolves, exactly as the kernel would walk
// them, so `~/.claude//sc*` and `~/.claude/./sc*` still show `.claude` as the
// parent of `sc*`. (A `..` after a symlink can differ from the lexical result;
// that is inside the stated symlink limit.)
function normalizePathSegments(word) {
  const out = []
  for (const seg of String(word).split('/')) {
    if (seg === '.' || (seg === '' && out.length)) continue
    if (seg === '..' && out.length && out[out.length - 1] !== '..' && out[out.length - 1] !== '') { out.pop(); continue }
    out.push(seg)
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
// ROUND 8 (Cybersec delta-gate, card ec20dd23): `source <(...)` and `. <(...)` run the FIFO's
// contents in the CURRENT shell, so the proc-sub branch has to recognise those two builtins as a
// command position exactly as it recognises a shell name. That this was an oversight rather than a
// decision is settled by HERESTRING_RX one screen up: it ALREADY carries the same two builtins on
// the `<<<` path. Same builtins, same exec class, one branch simply missed them -- the asymmetry
// between the two lines was the evidence, and this file's standing lesson is that duplicated
// grammar knowledge drifts apart in exactly this way. Unlike the herestring form there is no
// `/dev/stdin` here: the process substitution IS the argument.
const PROC_SUB_SHELL = String.raw`${WRAPPER_POSITION}(?:sudo\s+|env\s+)*(?:${SHELL_NAME}|(?:source|\.)\s+)${HERESTRING_FILLER}<\(`
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
  String.raw`\|\s*(?:sudo\s+|env\s+)*(?:${PATH_PREFIX}${SHELL_ALTERNATION}\b(?!\s*-[a-zA-Z]*c\b)` +
    String.raw`|(?:source|\.)\s+\/dev\/stdin)` +
    String.raw`|\bxargs\b${XARGS_FILLER}${SHELL_ALTERNATION}\b` +
    `|${PROC_SUB_SHELL}`,
)
// ROUND 4 (card 1a609c01, Cybersec): the pipe branch above anchors on a single LITERAL `\|`, with
// no alternative retry position -- unlike PROC_SUB_SHELL (and SHELL_C_RX/HERESTRING_RX elsewhere
// in this file), which use WRAPPER_POSITION and can retry from ANY CMD_POSITION_CHARS occurrence,
// including the bare character round 3's own DoS fix (PATH_PREFIX's `\\[^${CMD_POSITION_CHARS}]`)
// deliberately leaves behind when it stops at an ESCAPED one. A single fixed anchor has no such
// fallback: for `some\;dir/bash` after a real pipe, PATH_PREFIX correctly stops at the escaped
// `;` (that is the round-3 DoS fix working as intended), and -- because there is no OTHER `|` to
// retry the pipe-branch's own anchor from -- the whole alternative silently fails. Live-measured,
// all seven round-3 anchors (`;` `&` `(` `)` `{` `!` a backtick), 7/7 bypass with a real dangerous
// payload piped to a bare (non `-c`) shell.
//
// FIX: an INDEPENDENT second existence check, not a rewrite of the pipe branch itself -- a bare
// `|` occurs SOMEWHERE in the text, AND (a completely separate scan, no shared backtracking state
// with the first) a bare shell name occurs in ANY WRAPPER_POSITION-recognised command position.
// Reuses WRAPPER_POSITION (the SAME already-proven retry mechanism PROC_SUB_SHELL/SHELL_C_RX rely
// on) instead of inventing a new one, and keeps the two checks independent -- two plain,
// non-backtracking O(n) scans ANDed as booleans -- specifically so this does not reintroduce the
// lazy-filler-plus-backtracking shape rounds 1-3 spent three rounds closing (a single combined
// regex trying to require "a pipe, THEN eventually a WRAPPER_POSITION anchor, THEN a shell name"
// would need an unbounded filler between the pipe and the retry anchor -- exactly the shape that
// already produced O(n^2) here twice). Deliberately broader than the exact reported shape (it does
// not require the pipe and the shell name to be adjacent, or even related) -- safe because the
// actual DENY decision still depends on a quoted literal SEPARATELY matching a recognised
// dangerous pattern; this only widens when literal-extraction is attempted, never widens what
// counts as dangerous once extracted. Verified (not assumed): 7/7 previously-bypassed shapes now
// caught with a real dangerous inner payload (not a placeholder -- card 39cc3460's own standing
// lesson), the full pre-existing self-pace-gate test family (543+ tests) stays green, and a
// 32000-pair adversarial stress on this exact new construct stays under the same time budget the
// sibling quadratic tests already enforce.
const HAS_PIPE_RX = /\|/
const WRAPPER_POSITION_BARE_SHELL_RX = new RegExp(
  String.raw`${WRAPPER_POSITION}(?:sudo\s+|env\s+)*${PATH_PREFIX}${SHELL_ALTERNATION}\b(?!\s*-[a-zA-Z]*c\b)`,
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

// ROUND 7 (Cybersec, card ec20dd23, delta-gate NO-GO): the block below extracted only QUOTED
// literals, so the very same payload walked past it by simply DROPPING the quotes. Measured, same
// payload, same shapes: `echo <sched> -r | sh` ALLOW vs `echo '<sched> -r' | sh` DENY -- and the
// same split on `| bash` and on `bash <(echo ...)`. `echo`/`printf` write their ARGUMENTS to
// stdout whether or not those arguments are quoted, so the argument tail is executable text by
// exactly the reasoning the quoted-literal path already accepts. The quoting was never the thing
// that made it dangerous; it was only the thing the scan happened to be able to see.
//
// The option run is stripped rather than kept because SCHEDULER_RX anchors at a COMMAND position:
// measured, `<sched> -r` denies but `-n <sched> -r` ALLOWS. Capturing echo's own flags verbatim
// would therefore have left `echo -n <sched> -r | sh` open as a fresh bypass OF THIS VERY FIX.
// bash drops those flags before writing, so the scan has to as well. Stripping happens AFTER
// unquoteWord, so a quoted flag (`echo '-n' <sched> -r`) is stripped too -- bash's echo builtin
// tests the argument's VALUE, not its quoting.
//
// Terminators are the characters that end echo's argument list in the shapes this block guards
// (`|` for the pipe, `)` for the process substitution, plus the ordinary separators). A quote
// containing one of them truncates the tail; deliberately not worked around, because the
// quoted-literal path above already covers quoted content -- this path exists for the BARE word.
//
// The round-4 invariant is untouched: this only widens what gets EXTRACTED, never what counts as
// dangerous once extracted. The DENY still requires the extracted string to match a recognised
// pattern on its own, which is why `echo hello world | sh` stays allowed.
//
// DoS: one anchor plus ONE greedy pass over a disjoint negated class -- no nested quantifier, no
// lazy filler, nothing for the engine to retry per position. Same shape rounds 1-3 and 6
// converged on for this file, not a new construct. ECHO_OPTION_RUN's alternatives each consume at
// least one character (a space run, or a literal `-`), so its outer `*` cannot spin on empty.
const ECHO_TAIL_RX = new RegExp(
  String.raw`${WRAPPER_POSITION}(?:sudo\s+|env\s+|command\s+|exec\s+)*(echo|printf)\b([^|;&()<>\n` + '`' + String.raw`]*)`,
  'g',
)
// The tail is split into WORDS and unquoted PER WORD, then rejoined with single spaces -- which is
// what echo actually writes. unquoteWord is a single-WORD unquoter (its bare branch is a run of
// non-space, non-quote, non-operator characters, and it BREAKS at the first character that branch
// rejects), so handing it the whole space-separated tail returns the EMPTY STRING and silently
// extracts nothing. Measured during this fix, not reasoned about afterwards: the first cut did
// exactly that, and every one of the reported bypasses stayed ALLOW while the code looked patched.
//
// Splitting per word is also what makes the mixed forms fall out for free -- a binary name spelled
// with an adjacent quoted piece, or with an ANSI-C-quoted piece, reaches unquoteWord as ONE word,
// which is the input shape it was built for (adjacent-piece joining, escape decoding) rather than
// a second copy of that grammar living here.
//
// The word pattern's three alternatives are disjoint on their first character, so no position has
// two ways to match and there is nothing to retry -- the same non-backtracking shape as the
// quoted-literal scanner above.
const ECHO_ARG_WORD_RX = /(?:[^\s'"]|'[^']*'|"(?:\\.|[^"\\])*")+/g
// bash's echo accepts ONLY -n/-e/-E and their combinations; printf also takes `--`. Deliberately
// NOT "any dash-word": bash prints an unrecognised flag such as -x verbatim, so stripping that
// would invent an over-block, while stripping the real ones is REQUIRED -- measured, a bare
// scheduler word denies but the same word behind an echo flag allows, so a kept flag would be a
// live bypass of this very fix.
const ECHO_OPTION_WORD_RX = /^(?:-[neE]+|--)$/

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
  if (STDIN_SHELL_RX.test(text) || (HAS_PIPE_RX.test(text) && WRAPPER_POSITION_BARE_SHELL_RX.test(text))) {
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
    ECHO_TAIL_RX.lastIndex = 0
    let e
    while ((e = ECHO_TAIL_RX.exec(text)) !== null) {
      const words = (e[2].match(ECHO_ARG_WORD_RX) ?? []).map(unquoteWord)
      while (words.length > 0 && ECHO_OPTION_WORD_RX.test(words[0])) words.shift()
      const tail = words.join(' ')
      if (tail && tail !== text) out.push(tail)
      // ROUND 8 (Cybersec delta-gate): printf is NOT echo. Its first remaining word is the FORMAT
      // and every later argument is substituted INTO it, reusing the format until the arguments run
      // out -- so the arguments ALONE are a line printf can emit, with the format's own text (a
      // conversion like %s, a newline) never appearing between them. Round 7 pushed only the whole
      // tail, which leaves the conversion sitting in command position and the real binary in
      // argument position, where the anchored check correctly ignores it.
      //
      // ADDITIVE, not a replacement: the format itself is emitted too, so `printf <binary>` (format
      // only, no arguments) must stay denied -- dropping the first word unconditionally would have
      // turned that existing DENY into an ALLOW. Both readings are pushed and each is judged on its
      // own. Not applied to echo, where every argument is written verbatim: there, dropping the
      // first word would invent an over-block for text the shell never runs as a command.
      if (e[1] === 'printf' && words.length > 1) {
        const substituted = words.slice(1).join(' ')
        if (substituted && substituted !== text) out.push(substituted)
      }
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

// Does this text reference the schedule surface? { api, dir, cli, sql, db }
// (route, store, registry tool, schedule-table SQL write, database file).
// opts.parentCtx: the command cd's into a store parent, so a bare glob word
// (`s*`) may be resolved relative to it.
export function scheduleSurfaceRefs(text, opts) {
  const vs = scheduleSurfaceVariants(text)
  const r = {
    api: vs.some((v) => SCHEDULE_API_REF_RX.test(v)),
    dir: vs.some((v) => SCHEDULE_DIR_REF_RX.test(v)),
    cli: vs.some((v) => SCHEDULE_CLI_REF_RX.test(v)),
    sql: vs.some((v) => SCHEDULE_SQL_WRITE_RX.test(v)),
    db: vs.some((v) => DASHBOARD_DB_REF_RX.test(v)),
  }
  if (!r.api || !r.dir || !r.cli || !r.db) {
    const g = globRefs(text, opts)
    r.api ||= g.api
    r.dir ||= g.dir
    r.cli ||= g.cli
    r.db ||= g.db
  }
  return r
}
// Everything except the database file, which has its own, narrower rule.
const strongRef = (r) => r.api || r.dir || r.cli || r.sql

// Does the command cd/pushd into a store PARENT (~/.claude, a config dir)?
// Then a relative glob anywhere in it may land on the store.
function cdsIntoStoreParent(command) {
  const unquoted = scheduleSurfaceVariants(command)[1]
  for (const m of unquoted.matchAll(/(?:^|[\s;&|(])(?:cd|pushd)\s+(\S+)/g)) {
    const last = normalizePathSegments(m[1]).filter(Boolean).pop() ?? ''
    if (STORE_PARENTS.some((p) => globMatchesName(last, p))) return true
  }
  return false
}

// `"$(cat <<'EOF' ... EOF)"` -- the canonical multi-line commit message -- is a
// LITERAL string: a quoted tag expands nothing and cat prints the body verbatim.
// Rewrite it to the single-quoted literal it evaluates to, so the parser below
// can see it as a plain word. If the body contains a line equal to the tag, the
// shell would have ended the heredoc THERE and run the rest; that case is left
// untouched, and maskInertLiterals then fails closed on it.
const LITERAL_HEREDOC_SUBST_RX = /"\$\(\s*cat\s+<<-?\s*(['"])([A-Za-z_]\w*)\1[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\2[ \t]*\r?\n\s*\)"/g
function resolveLiteralHeredocSubst(cmd) {
  return cmd.replace(LITERAL_HEREDOC_SUBST_RX, (full, _q, tag, body) => {
    if (new RegExp(`^[ \\t]*${tag}[ \\t]*$`, 'm').test(body)) return full
    return `'${body.replace(/'/g, '')}'`
  })
}

// `$(cat PATH)` / `$(< PATH)` only reads a file -- the dashboard token header
// `-H "Authorization: Bearer $(cat store/.dashboard-token)"` is the fleet's own
// documented form. It becomes a marker: harmless inside double quotes, and
// rejected unquoted by the word parser (an unquoted substitution word-splits,
// so `curl -H $(cat args) URL` could smuggle -X POST in). Only when the path
// itself does not reference the surface. The TOKEN path gets a distinct marker
// because its file content is the ONLY thing form (a) accepts inside a header
// (isPlainCurlGet). That marker MUST NOT be expressible in shell source: an
// earlier draft used the literal `${DASHBOARD_TOKEN}`, which an agent can
// itself write as a real expansion -- `DASHBOARD_TOKEN=$'...\r\n...'; curl -H
// "X: ${DASHBOARD_TOKEN}"` -- reopening CR/LF smuggling. So it is a per-run
// nonce fenced by NUL, which cannot occur in a shell command's argv.
const CAT_SUBST_RX = /\$\(\s*(?:cat\s+|<\s*)((?:[\w./~@+-]|\$\w+|\$\{\w+\})+)\s*\)/g
const TOKEN_NONCE = `\u0000SPTOK${randomBytes(9).toString('hex')}\u0000`
const NONCONTENT_MARKER = '\u0000SPVAL\u0000' // any other $(...) whose output is opaque
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// The token files a header may read, as LITERAL absolute paths (the form the
// scaffold writes into every sub-agent's CLAUDE.md: tokenPath is
// join(PROJECT_ROOT, 'store', '.dashboard-token')):
//   - <root>/store/.dashboard-token, the shared dashboard token;
//   - <root>/agents/<self>/.dashboard-token, a per-agent token file, for the
//     calling agent only (opts.selfAgent, see selfAgentFromProjectDir). On an
//     install without per-agent tokens that file does not exist, so it is
//     refused by the content check below.
// No relative path (a sub-agent runs in agents/<name>/ and could create its
// own store/.dashboard-token there), no ~ or $HOME (an expansion the command
// can redefine). And the file's CONTENT must look like a token, read when the
// gate decides: a token file with a CR/LF in it would put a second, pipelined
// request (a POST) inside the "GET". Missing or unreadable = refused.
const TOKEN_CONTENT_RX = /^[A-Za-z0-9._~+/=-]+\n?$/
export function tokenFileContentOk(path) {
  try { return TOKEN_CONTENT_RX.test(readFileSync(path, 'utf-8')) } catch { return false }
}
export function acceptedTokenFile(path, opts = {}) {
  const root = opts.projectRoot ?? PROJECT_ROOT
  const allowed = [join(root, 'store', '.dashboard-token')]
  if (opts.selfAgent && /^[A-Za-z0-9_-]+$/.test(opts.selfAgent)) allowed.push(join(root, 'agents', opts.selfAgent, '.dashboard-token'))
  return allowed.includes(path) && tokenFileContentOk(path)
}
// The calling agent: the hook's CLAUDE_PROJECT_DIR (the directory the agent's
// session was launched in, set by Claude Code for every hook process; a Bash
// `cd` does not change it) when it is exactly <root>/agents/<name>. Anything
// else -- unset, the repo root, a deeper or outside path -- is no agent, so
// only the shared token file is accepted.
export function selfAgentFromProjectDir(dir, root = PROJECT_ROOT) {
  if (!dir) return undefined
  const rel = relative(join(root, 'agents'), resolve(String(dir)))
  if (!rel || rel.startsWith('..') || rel.includes(sep) || !/^[A-Za-z0-9_-]+$/.test(rel)) return undefined
  return rel
}
function resolveCatSubst(cmd, opts) {
  return cmd.replace(CAT_SUBST_RX, (full, path) => {
    if (strongRef(scheduleSurfaceRefs(path, opts))) return full
    return acceptedTokenFile(path, opts) ? TOKEN_NONCE : NONCONTENT_MARKER
  })
}

// Any other flat `$(CMD)` -- no quotes, no nesting, no expansion inside, and no
// reference in CMD -- becomes NONCONTENT_MARKER (NUL-fenced, see above). CMD
// itself would be allowed on its own (it references nothing), and its OUTPUT is
// run-time data, which this gate cannot see in any spelling. Without this, one
// `"$(date -Iseconds)"` anywhere in a command made the whole quoting
// unresolvable and denied an unrelated read of the store (replay of real
// sub-agent tool calls). readWord treats an unquoted marker as an expansion (unknown word
// count), and headerValueIsInert rejects it in a header, so the curl checks
// still refuse it there and as a URL's start. There is no "inside the store"
// case to guard any more: a cd/pushd/popd into the store denies the whole
// command (scheduleSurfaceDeny, rule 1).
const FLAT_SUBST_RX = /\$\(([^()'"`$\\]*)\)/g
function resolveFlatSubst(cmd, opts) {
  return cmd.replace(FLAT_SUBST_RX, (full, inner) => {
    return strongRef(scheduleSurfaceRefs(inner, opts)) ? full : NONCONTENT_MARKER
  })
}

// Split a command into the segments the SHELL would see: separators inside
// quotes or heredoc bodies do not split (maskInertLiterals decides that), and
// a heredoc body is handed back to the segment whose `<<` owns it. Returns null
// when the quoting cannot be resolved -- the caller then denies.
const SEGMENT_SEP_RX = /\|\||&&|\|&|;;|[;|\n]|(?<![<>])&(?!>)/g
export function shellSegments(command, opts) {
  const src = resolveFlatSubst(resolveCatSubst(resolveLiteralHeredocSubst(String(command ?? '')), opts), opts)
    .replace(/\\\r?\n/g, ' ')
  const heredocs = []
  const masked = maskInertLiterals(src, heredocs)
  if (masked == null || masked.length !== src.length) return null
  const ranges = []
  let start = 0
  for (const m of masked.matchAll(SEGMENT_SEP_RX)) {
    ranges.push({ start, end: m.index, sep: m[0] })
    start = m.index + m[0].length
  }
  ranges.push({ start, end: src.length, sep: '' })
  const segs = []
  for (const r of ranges) {
    // a range that lies inside a heredoc body/terminator belongs to its owner
    if (heredocs.some((h) => r.start >= h.bodyStart && r.end <= h.end)) continue
    const own = src.slice(r.start, r.end)
    // an empty range (`a |<newline>b`) is skipped WITHOUT touching the previous
    // separator: the pipe before it still connects to the next real command
    if (!own.trim()) continue
    const bodies = heredocs
      .filter((h) => h.opStart >= r.start && h.opStart < r.end)
      .map((h) => src.slice(h.bodyStart, h.bodyEnd))
    segs.push({ own: own.trim(), bodies, text: [own.trim(), ...bodies].join('\n'), sep: r.sep })
  }
  return segs
}

// Plain-word parser for one segment. Returns [{ value, dollar, star, ansi }] or
// null when the segment is not a plain word list: a command or process
// substitution, grouping, brace expansion, a here-string. Redirections are
// parsed, not rejected: an output target lands on `words.redirects` (the caller
// decides whether it may be written); an fd dup (2>&1/0<&3) and an input
// redirect's target are dropped, but their mere PRESENCE is recorded on
// `words.hasInputRedirect` (card 0120d19a NO-GO F1) -- isPlainCurlGet needs to
// know whether curl's own stdin is still the pipe it was trusted for.
const HEREDOC_OP_RX = /<<-?\s*(?:'[^']*'|"[^"]*"|[A-Za-z_]\w*)/g
const REDIRECT_OP_RX = /^(?:\d|&)?(?:>>|>\||>|<(?![<(]))/

function readWord(s, i) {
  let value = ''
  let dollar = false // an UNQUOTED expansion: word splitting can turn it into several words
  let star = false // an unquoted * or [ glob
  let ansi = false // a $'...' part: its \r \n escapes become real control characters
  while (i < s.length && !/\s/.test(s[i])) {
    const c = s[i]
    if (c === "'") {
      const e = s.indexOf("'", i + 1)
      if (e === -1) return null
      value += s.slice(i + 1, e); i = e + 1; continue
    }
    if (c === '$' && s[i + 1] === "'") {
      let j = i + 2
      while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1
      if (j >= s.length) return null
      value += s.slice(i + 2, j); ansi = true; i = j + 1; continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '`' || (s[j] === '$' && s[j + 1] === '(')) return null
        // inside "..." bash drops the backslash only before $ ` " \ and newline
        if (s[j] === '\\' && j + 1 < s.length) {
          value += '$`"\\\n'.includes(s[j + 1]) ? s[j + 1] : s.slice(j, j + 2)
          j += 2; continue
        }
        value += s[j]; j++
      }
      if (j >= s.length) return null
      i = j + 1; continue
    }
    if (c === '\\') {
      if (i + 1 >= s.length) return null
      value += s[i + 1]; i += 2; continue
    }
    if (c === '$' && s[i + 1] === '{') { // ${NAME...}: an expansion, unless it nests a command
      const e = s.indexOf('}', i + 2)
      if (e === -1 || /[`{]|\$\(/.test(s.slice(i + 2, e))) return null
      value += s.slice(i, e + 1); dollar = true; i = e + 1; continue
    }
    if ('`(){}<>;&|'.includes(c)) return null
    if (c === '$' || c === '\u0000') dollar = true // $ or a NUL substitution marker
    if (c === '*' || c === '[') star = true
    value += c; i++
  }
  return { word: { value, dollar, star, ansi }, i }
}

function shellWords(text) {
  const s = String(text).replace(HEREDOC_OP_RX, ' ')
  const words = []
  words.redirects = []
  // card 0120d19a, WhiteHat F1 / RedHat F1 (both NO-GO on the same gap): an INPUT redirect
  // (`< file`, `0< file`, `<&N`) was parsed (so it never broke tokenising) but never recorded
  // anywhere -- isPlainCurlGet's trustedStdin check only ever asked what feeds the PIPE into curl,
  // never whether curl's own stdin was then overridden by a later redirect on the same segment.
  // That let `printf TRUSTED | curl -q -s -H @- URL < evil-headers` read `-H @-`'s header lines
  // from the redirect instead of the proven printf, measured live to inject an attacker-chosen
  // Authorization value and extra headers. Tracked as a bare boolean, not the target: the mere
  // presence of a non-default stdin source is disqualifying here, the target text is irrelevant.
  words.hasInputRedirect = false
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    const op = REDIRECT_OP_RX.exec(s.slice(i))
    if (op) {
      i += op[0].length
      const isOutput = op[0].includes('>')
      if (s[i] === '&' && /\d/.test(s[i + 1] ?? '')) { // 2>&1 / 0<&3: fd dup, no file
        if (!isOutput) words.hasInputRedirect = true
        i += 2; continue
      }
      while (i < s.length && /\s/.test(s[i])) i++
      const t = readWord(s, i)
      if (!t || !t.word.value) return null
      if (isOutput) words.redirects.push(t.word) // output: a file gets written
      else words.hasInputRedirect = true // input: stdin no longer comes from the pipe/terminal
      i = t.i
      continue
    }
    const r = readWord(s, i)
    if (!r) return null
    words.push(r.word)
    i = r.i
  }
  return words
}

// System directories a tool's real binary lives in. A command word is trusted
// (forms a/b/c) only as a BARE name (`curl`) or as an EXACT absolute path in one
// of these (`/usr/bin/curl`). `./curl`, `/tmp/cat`, `$X/curl`, a relative path:
// not trusted -> commandName returns '' -> neither form matches -> deny.
const SYSTEM_BIN_DIRS = ['/usr/bin/', '/bin/', '/usr/local/bin/', '/usr/sbin/', '/sbin/', '/opt/homebrew/bin/']
function commandName(words) {
  const w = words[0]
  if (!w || w.dollar || w.value.includes('$')) return ''
  const v = w.value
  if (!v.includes('/')) return v // bare name
  const base = v.slice(v.lastIndexOf('/') + 1)
  return SYSTEM_BIN_DIRS.some((d) => v === d + base) ? base : ''
}

// curl's option grammar, as far as this gate needs it. An option not listed
// here makes parseCurl return null: unknown means not provable.
const CURL_NOARG = new Set([
  '-s', '--silent', '-S', '--show-error', '-f', '--fail', '--fail-with-body', '-L', '--location',
  '-i', '--include', '-I', '--head', '-k', '--insecure', '-v', '--verbose', '-g', '--globoff',
  '-G', '--get', '--compressed', '--no-progress-meter', '-N', '--no-buffer', '-4', '-6',
])
const CURL_SHORT_NOARG = 'sSfLiIkvgGN46'
const CURL_ARG_OPTS = new Map([
  ['-H', 'header'], ['--header', 'header'],
  // 'safe' = checked against the installed curl 8.5.0 man page (2026-09-28):
  // no file written, no config read, no change to the request. -w/--write-out
  // is NOT safe: its %output{file} / %output{>>file} (curl >= 8.3.0) writes a
  // file of the caller's choosing.
  ['-m', 'safe'], ['--max-time', 'safe'], ['--connect-timeout', 'safe'],
  ['-w', 'file'], ['--write-out', 'file'],
  ['-A', 'header'], ['--user-agent', 'header'], ['-e', 'header'], ['--referer', 'header'],
  ['--retry', 'safe'], ['--retry-delay', 'safe'], ['--retry-max-time', 'safe'],
  ['-X', 'method'], ['--request', 'method'],
  ['-d', 'data'], ['--data', 'data'], ['--data-raw', 'data'], ['--data-binary', 'data'],
  ['--data-ascii', 'data'], ['--data-urlencode', 'data'], ['--json', 'data'],
  ['-F', 'body'], ['--form', 'body'], ['-T', 'body'], ['--upload-file', 'body'],
  ['-K', 'config'], ['--config', 'config'],
  ['-o', 'file'], ['--output', 'file'], ['-D', 'file'], ['--dump-header', 'file'], ['-c', 'file'], ['--cookie-jar', 'file'],
  ['-u', 'auth'], ['--user', 'auth'], ['-b', 'auth'], ['--cookie', 'auth'],
  ['--url', 'url'],
  ['-x', 'route'], ['--proxy', 'route'], ['--resolve', 'route'], ['--connect-to', 'route'], ['--unix-socket', 'route'],
])

function parseCurl(words) {
  const out = { urls: [], kinds: new Set(), dataIdx: new Set(), stdinData: false, sent: [], noCurlrc: false }
  const record = (kind, idx, value) => {
    out.kinds.add(kind)
    if (kind === 'header') out.sent.push({ value, ansi: words[idx].ansi })
    if (kind === 'data') {
      out.dataIdx.add(idx)
      if (value === '@-') out.stdinData = true
    }
    if (kind === 'url') out.urls.push(words[idx])
  }
  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    const v = w.value
    if (w.dollar) return null // unquoted expansion: its word count is unknown
    // -q / --disable skips the curlrc, but ONLY as the very first argument
    if (i === 1 && (v === '-q' || v === '--disable')) { out.noCurlrc = true; continue }
    if (v === '--') return null
    if (v.startsWith('--')) {
      const eq = v.indexOf('=')
      const name = eq >= 0 ? v.slice(0, eq) : v
      if (eq < 0 && CURL_NOARG.has(name)) continue
      const kind = CURL_ARG_OPTS.get(name)
      if (!kind) return null
      if (eq >= 0) { record(kind, i, v.slice(eq + 1)); continue }
      if (i + 1 >= words.length) return null
      i++; record(kind, i, words[i].value); continue
    }
    if (v.startsWith('-') && v.length > 1) {
      if (v.includes('$')) return null
      for (let j = 1; j < v.length; j++) {
        if (CURL_SHORT_NOARG.includes(v[j])) continue
        const kind = CURL_ARG_OPTS.get('-' + v[j])
        if (!kind) return null
        const rest = v.slice(j + 1)
        if (rest) record(kind, i, rest)
        else { if (i + 1 >= words.length) return null; i++; record(kind, i, words[i].value) }
        break
      }
      continue
    }
    out.urls.push(w)
  }
  return out
}

// Form (a): a plain curl GET. The scheme must be literal: a URL that STARTS with
// an expansion (`"$D/api/schedules"`) can carry gopher:// or dict://, which let
// curl write raw bytes -- a POST -- to the port.
//
// Header values (-H, -A, -e) must not be able to carry a line break. Measured
// 2026-09-28 against a raw socket: curl 8.5.0 sends `-H $'X: a\r\n\r\nPOST
// /api/schedules HTTP/1.1...'` VERBATIM, i.e. a second, pipelined POST rides
// inside the "GET". (A CR/LF in the URL is refused by curl itself, exit 3,
// measured the same way.) So a header value may contain no control character,
// no $'...' part, and no expansion other than the dashboard token file; and
// not the `@file` form in general, which reads header lines from a file this
// gate cannot see. The ONE exception is `@-` (stdin), and ONLY when the caller
// has already proven (trustedStdin) that stdin is fed by nothing but the
// fork's own canonical token-printf (isTrustedTokenPrintf, below) -- the
// fork's token-in-argv-guard forbids the alternative (the token typed into
// curl's own argv), so this form has to be trusted some other way, not
// rejected outright (card 0120d19a, MikroB decision 2026-11-07: the fork's
// argv-leak rule wins, fix the allowlist instead of exempting the inline
// form). `@` followed by anything else (a real file, `@-` without a proven
// source) stays rejected, same as before. The token nonce (the resolved
// `$(cat store/.dashboard-token)`) is stripped FIRST; then any control char --
// a NUL from a non-token substitution, or a real CR/LF -- and any surviving
// `$` (a literal `${DASHBOARD_TOKEN}` the agent wrote, or any other
// expansion) make the value non-inert.
function headerValueIsInert(h, trustedStdin = false) {
  if (h.ansi) return false
  if (h.value.startsWith('@')) return trustedStdin && h.value === '@-'
  const stripped = h.value.split(TOKEN_NONCE).join('')
  if (/[\x00-\x1f\x7f]/.test(stripped)) return false
  return !stripped.includes('$')
}

// The fork's own sanctioned shape for feeding curl a Bearer header without
// ever putting the token in curl's argv (card 0120d19a): the token read from
// an ACCEPTED file, formatted, and piped to stdin -- nothing else in the
// printf, nothing else in the pipe. Checked on the RAW segment text, which by
// the time shellSegments runs has already had an accepted `$(cat <file>)`
// replaced by TOKEN_NONCE (resolveCatSubst, above) -- so this never reads a
// file itself, it only recognises that substitution already happened.
// Exactly 3 words (printf, format, value): a 4th word -- an extra flag, an
// extra argument, trailing junk -- is refused by construction, not by a
// separate check.
// Literal backslash+n (2 chars), NOT an actual newline: a single-quoted shell word's VALUE is the
// raw text between the quotes, unescaped by the shell -- printf interprets \n as a newline only
// when IT runs, at which point this gate has already made its decision on the raw characters.
const TRUSTED_PRINTF_FORMAT = 'Authorization: Bearer %s\\n'
function isTrustedTokenPrintf(segOwn) {
  const words = shellWords(segOwn)
  if (!words || words.length !== 3 || words.redirects.length) return false
  if (commandName(words) !== 'printf') return false
  return words[1].value === TRUSTED_PRINTF_FORMAT && words[2].value === TOKEN_NONCE
}

// curl reads ~/.curlrc (or $CURL_HOME/.curlrc, $XDG_CONFIG_HOME/curlrc) before
// its command line, and a curlrc can say `request = POST` / `data = ...` /
// `output = ...`. Form (a) therefore requires -q as the FIRST argument (the
// only position where curl honours it) instead of guessing at run time whether
// a curlrc exists: that guess could not see one written earlier in the same
// command. The scheme must be a literal http(s)://: without one, curl guesses
// the protocol from the host name (ftp., dict., ...).
function isPlainCurlGet(words, trustedStdin = false) {
  // card 0120d19a NO-GO F1: a plain GET never needs its own stdin source, trusted or not -- the
  // ONLY reason stdin matters at all is `-H @-` consuming the PIPE that fed this segment, and an
  // extra `< file`/`<&N` redirect on the curl segment itself replaces that pipe's stdin silently.
  if (words.hasInputRedirect) return false
  const p = parseCurl(words)
  if (!p || !p.noCurlrc) return false
  for (const k of p.kinds) if (k !== 'header' && k !== 'safe') return false
  if (!p.sent.every((h) => headerValueIsInert(h, trustedStdin))) return false
  if (p.urls.length !== 1) return false
  const u = p.urls[0]
  if (u.star) return false
  return /^https?:\/\//i.test(u.value)
}

// Form (b): commands that can neither write a file (other than through a
// redirect, which the caller checks) nor open a socket, and -- for their output
// -- the only consumers allowed on a pipe. No tee, awk, xargs, tree (-o), file
// (-C); sed and sort only in a shape whose options cannot write or exec.
const READ_ONLY_FS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'stat', 'du', 'readlink', 'realpath',
  'basename', 'dirname', 'test', '[', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'find', 'echo', 'printf',
  'date', 'pwd', 'true', 'false', 'sed', 'sort', 'cut', 'tr', 'nl', 'uniq', 'column',
])
const TEXT_FILTERS = new Set(['grep', 'egrep', 'fgrep', 'head', 'tail', 'wc', 'cut', 'tr', 'nl', 'cat', 'uniq', 'column', 'sort', 'sed'])
const FIND_ACTION_RX = /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/
// sed: only -n/-E/-r and line-range print/delete scripts (`1,60p`, `$d`) -- no
// `w file`, no `e command`, no -i.
const SED_SCRIPT_RX = /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?[pd];?)+$/
function sedIsPrintOnly(words) {
  let script = 0
  for (const w of words.slice(1)) {
    if (/^-[nEr]+$/.test(w.value) || w.value === '--quiet') continue
    if (w.value.startsWith('-')) return false
    if (!script++) { if (!SED_SCRIPT_RX.test(w.value)) return false }
  }
  return script > 0
}
// sort: -o writes a file, --compress-program runs one
function sortIsReadOnly(words) {
  return words.slice(1).every((w) => !w.value.startsWith('-') || /^-[bdfghinMRrsuVz]+$/.test(w.value) || /^-[kt]/.test(w.value))
}

function isReadOnlyFsCommand(words, name) {
  if (!READ_ONLY_FS.has(name)) return false
  // uniq's SECOND operand is an output file
  if (name === 'uniq') return words.slice(1).filter((w) => !w.value.startsWith('-')).length <= 1
  if (name === 'find') return !words.some((w) => w.dollar || w.star || FIND_ACTION_RX.test(w.value))
  if (name === 'rg') return !words.some((w) => w.value.startsWith('--pre'))
  if (name === 'sed') return sedIsPrintOnly(words)
  if (name === 'sort') return sortIsReadOnly(words)
  return true
}

const AGENT_MSG_RX = /(?:^|\/)scripts\/agent-msg\.sh$/
function isPipeSink(words, name) {
  if (TEXT_FILTERS.has(name)) return isReadOnlyFsCommand(words, name)
  // the inter-agent helper: its stdin becomes message content, nothing else
  const script = (name === 'bash' || name === 'sh') ? words[1] : words[0]
  return !!script && AGENT_MSG_RX.test(script.value) && words.every((w) => !w.dollar)
}

function pipesOnlyIntoSinks(segs, k, redirectsOk) {
  for (let j = k; j < segs.length - 1 && (segs[j].sep === '|' || segs[j].sep === '|&'); j++) {
    const next = segs[j + 1]
    const words = shellWords(next.own)
    if (!words || !isPipeSink(words, commandName(words)) || next.bodies.length || !redirectsOk(words)) return false
  }
  return true
}

// gh/glab prose flags (the set stripProseArguments blanks), and the flags that
// read the same prose from a file (`-` = stdin, i.e. a heredoc on the segment).
const GH_PROSE_FLAGS = new Set(['--body', '--message', '--notes', '--title', '--subject', '-b', '-m', '-t'])
const GH_PROSE_FILE_FLAGS = new Set(['--body-file', '--notes-file', '-F'])

// Form (c): the segment's text with its LITERAL message data removed. The data
// words are found by the carrier's own grammar; anything not recognised keeps
// the full text, so the reference stays and the segment is denied.
function dataResidue(seg, words, name) {
  const keep = (drop) => words.filter((_, i) => !drop.has(i)).map((w) => w.value).join(' ')
  if (name === 'curl') {
    const p = parseCurl(words)
    if (!p || p.kinds.has('config')) return seg.text
    return [keep(p.dataIdx), ...(p.stdinData ? [] : seg.bodies)].join('\n')
  }
  if (name === 'git') {
    let i = 1
    while (i < words.length && words[i].value.startsWith('-')) {
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(words[i].value)) i++
      i++
    }
    if (!['commit', 'tag', 'stash'].includes(words[i]?.value)) return seg.text
    const drop = new Set()
    let stdinMsg = false
    for (let j = i + 1; j < words.length; j++) {
      const v = words[j].value
      if (v === '--message' || /^-[a-zA-Z]*m$/.test(v)) { drop.add(j + 1); j++; continue }
      if (/^-m./.test(v) || v.startsWith('--message=')) { drop.add(j); continue }
      if ((v === '-F' || v === '--file') && words[j + 1]?.value === '-') { stdinMsg = true; j++; continue }
      if (v === '-F-' || v === '--file=-') stdinMsg = true
    }
    return [keep(drop), ...(stdinMsg ? [] : seg.bodies)].join('\n')
  }
  if (name === 'gh' || name === 'glab') {
    // `gh api` sends a request of the caller's choosing: never message data
    if (words.slice(1).some((w) => w.value === 'api')) return seg.text
    const drop = new Set()
    let stdinMsg = false
    for (let j = 1; j < words.length; j++) {
      const v = words[j].value
      const eq = v.indexOf('=')
      const flag = v.startsWith('--') && eq > 0 ? v.slice(0, eq) : v
      if (GH_PROSE_FLAGS.has(flag)) {
        if (flag !== v) drop.add(j) // --body=TEXT
        else { drop.add(j + 1); j++ }
        continue
      }
      if (GH_PROSE_FILE_FLAGS.has(flag)) {
        const val = flag !== v ? v.slice(eq + 1) : words[j + 1]?.value
        if (val === '-') stdinMsg = true
        if (flag === v) j++
      }
    }
    return [keep(drop), ...(stdinMsg ? [] : seg.bodies)].join('\n')
  }
  const helperAt = (name === 'bash' || name === 'sh') ? 1 : 0
  if (words[helperAt] && AGENT_MSG_RX.test(words[helperAt].value) && !words.some((w) => w.dollar)) {
    // <from> <to> <content | -> ; stdin content comes from a heredoc or a pipe
    const contentIdx = helperAt + 3
    const drop = new Set([contentIdx])
    const stdinMsg = words[contentIdx]?.value === '-'
    return [keep(drop), ...(stdinMsg ? [] : seg.bodies)].join('\n')
  }
  return seg.text
}

// The registry tool's read-only use: `node|tsx <path>/schedule-registry-cli.(js|ts)
// status|verify ...` or `npx [--no-install|-y] tsx <path> status|verify ...`.
// No runner option before the script (`node --import X`, `-e`), no expansion
// in any word. register / unregister / no subcommand / anything else: denied.
const SCHEDULE_CLI_SCRIPT_RX = /(?:^|\/)schedule-registry-cli\.(?:[cm]?js|[cm]?ts)$/
const SCHEDULE_CLI_READ_SUBCOMMANDS = new Set(['status', 'verify'])
function isRegistryCliRead(words, name) {
  let i = 1
  if (name === 'npx') {
    while (['--no-install', '--yes', '-y'].includes(words[i]?.value)) i++
    if (words[i]?.value !== 'tsx') return false
    i++
  } else if (name !== 'node' && name !== 'tsx') return false
  const script = words[i]
  if (!script || script.dollar || script.star || !SCHEDULE_CLI_SCRIPT_RX.test(script.value)) return false
  if (!SCHEDULE_CLI_READ_SUBCOMMANDS.has(words[i + 1]?.value)) return false
  return words.every((w) => !w.dollar && !w.star)
}
// A developer sub-agent may stage, diff or log the tool's SOURCE: git index and
// history commands that never execute it, without -c (an alias or a pager is a
// command) and without an external diff driver.
const GIT_SOURCE_SUBCOMMANDS = new Set(['add', 'diff', 'log', 'show', 'status', 'blame', 'ls-files', 'grep', 'restore'])
function isGitSourceCommand(words, name) {
  if (name !== 'git') return false
  if (words.some((w) => w.dollar || /^(?:-c|--exec-path(?:=.*)?|--ext-diff|--textconv|-p|--paginate)$/.test(w.value))) return false
  return GIT_SOURCE_SUBCOMMANDS.has(words[1]?.value)
}

// The database file: a FILE-level write. Reads by any program pass; an SQL
// write on a schedule table is caught separately (SCHEDULE_SQL_WRITE_RX), and
// an SQL write through a script file is a stated limit.
const DB_FILE_WRITERS = new Set(['cp', 'mv', 'tee', 'dd', 'rm', 'ln', 'truncate', 'install', 'rsync', 'shred', 'unlink', 'touch', 'scp', 'tar', 'unzip', 'patch'])
const SQLITE_FILE_DOT_RX = /(?:^|[\s'"])\.(?:read|restore|import|load|shell|system|clone|backup|save)\b|(?:^|\s)-init\b/
function dbSegmentWrites(words, name, text) {
  if (DB_FILE_WRITERS.has(name)) return true
  if (name === 'sed' && words.some((w) => /^-[a-zA-Z]*i/.test(w.value) || w.value.startsWith('--in-place'))) return true
  if ((name === 'perl' || name === 'ruby') && words.some((w) => /^-[a-zA-Z]*i/.test(w.value))) return true
  if (/^sqlite3?$/.test(name) && SQLITE_FILE_DOT_RX.test(text)) return true
  return name === '' // an untrusted command path (./x, $X/x) naming the database
}

// Shell grammar around a command that this check steps over: a loop/branch
// keyword in front of it, or a keyword standing alone.
const CONTROL_PREFIX_RX = /^(?:(?:do|then|else|elif|if|while|until|!|\{)\s+)+/
const CONTROL_ALONE_RX = /^(?:done|fi|esac|\}|else|then|do)$/
const ASSIGN_RX = /^([A-Za-z_]\w*)=/
const DECLARE_WORDS = new Set(['export', 'local', 'declare', 'readonly', 'typeset'])

// The names an assignment-only segment (`D=~/.claude/scheduled-tasks/x`,
// `export U=...`) assigns, or null when the segment does anything else.
function assignedNames(words) {
  const rest = DECLARE_WORDS.has(words[0]?.value) ? words.slice(1).filter((w) => !/^-\w+$/.test(w.value)) : words
  if (!rest.length || !rest.every((w) => ASSIGN_RX.test(w.value))) return null
  return rest.map((w) => ASSIGN_RX.exec(w.value)[1])
}

// Words that name/shadow a command: a definition (`function`), a builtin that
// runs or redefines one (`alias`, `enable`, `builtin`, `command`, `exec`). When
// the command touches the surface, ANY of these in command position denies --
// they exist to make an allowed name (`ls`, `curl`) do something else.
const SHADOW_WORDS = new Set(['alias', 'enable', 'builtin', 'command', 'exec', 'function'])
// A function definition in command position: `name()` / `name ()` / `function name`.
const FUNCTION_DEF_RX = /^(?:function\s+[\w-]+|[\w-]+\s*\(\s*\))/

// The same invariants, applied to the WHOLE command with quoted text and
// heredoc bodies blanked, at every command position -- after `(`, `{`, `;`,
// `&`, `|`, a backtick or a newline, past `!`/keywords/env assignments -- so a
// definition opening a subshell or group (`(ls(){ cp ...; }; ls <store>)`) is
// seen too. A `name()` anywhere in unquoted shell text is a definition (or a
// syntax error), so that one needs no position at all.
const CMD_POS = String.raw`(?:^|[;&|(){}\n\x60])\s*(?:(?:!|do|then|else|elif|if|while|until|time)\s+|[A-Za-z_]\w*=\S*\s+)*(?:\S*/)?`
const ANY_FUNCTION_DEF_RX = /[\w.:-]+\s*\(\s*\)/
const SHADOW_ANYWHERE_RX = new RegExp(`${CMD_POS}(?:alias|enable|builtin|command|exec|function)(?=\\s|$)`)
// Builtins that assign a variable the taint tracking cannot see (their NAME is
// not a `NAME=value` word): printf -v, read, mapfile/readarray, getopts, and a
// nameref (declare/local/typeset -n). Once the command references the surface,
// any of them denies -- flat, instead of modelling each one's assignment.
const VAR_WRITER_RX = new RegExp(`${CMD_POS}(?:printf\\s+(?:-[^\\s]*\\s+)*-v\\b|read\\b|mapfile\\b|readarray\\b|getopts\\b|(?:declare|local|typeset)\\s+(?:-\\w+\\s+)*-\\w*n)`)
function wholeCommandShadows(command) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  const masked = maskInertLiterals(src, [], true)
  if (masked == null) return true // unresolvable: fail closed
  return ANY_FUNCTION_DEF_RX.test(masked) || SHADOW_ANYWHERE_RX.test(masked) || VAR_WRITER_RX.test(masked)
}

// The definition/shadow half of wholeCommandShadows, without the variable writers.
function wholeCommandDefines(command) {
  const masked = maskInertLiterals(String(command ?? '').replace(/\\\r?\n/g, ' '), [], true)
  return masked == null || ANY_FUNCTION_DEF_RX.test(masked) || SHADOW_ANYWHERE_RX.test(masked)
}

// Builtins that put a shell variable into the ENVIRONMENT of later commands:
// export, declare/typeset/local -x, and set -a / set -o allexport. A program
// reads its environment without spelling `$NAME` on the command line
// (`os.environ['U']`, `process.env.U`), so the taint tracking below cannot see
// that use. Once a variable carries a reference, any of these denies (flat).
const ENV_EXPORT_RX = new RegExp(`${CMD_POS}(?:export(?=\\s|$)|(?:declare|local|typeset)\\s+(?:-\\w+\\s+)*-\\w*x|set\\s+(?:-\\w*a|-o\\s+allexport))`)
function wholeCommandExports(command) {
  const masked = maskInertLiterals(String(command ?? '').replace(/\\\r?\n/g, ' '), [], true)
  return masked == null || ENV_EXPORT_RX.test(masked)
}

// The decision for one Bash command. true = deny.
//
// Once the command references the API or the store surface (raw or decoded),
// the check is FLAT and fail-closed -- it does NOT model shell state:
//   1. ANY cd/pushd/popd whose argument references the store denies the whole
//      command. A sub-agent has no reason to enter the schedule store, and this
//      removes the working-directory state machine (and its cd -/OLDPWD/failed-cd
//      bypasses) entirely. (A cd whose effect PERSISTS to a LATER Bash call, if
//      Claude Code keeps the cwd across calls, is outside a per-command gate;
//      rule 1 still denies the cd itself when it appears.)
//   2. ANY function/alias/shadow definition anywhere denies -- it can make an
//      allowed name write.
//   3. Forms (a)/(b)/(c) trust a command only by a bare name or an exact system
//      binary path (commandName), so `/tmp/cat` and `./curl` do not pass.
// The only cross-segment state left is a tainted VARIABLE (`F=<store path>;
// cat >> $F`): a value carrying a reference taints its name, and a later use of
// it counts as a reference. That only ADDS denials.
export function scheduleSurfaceDeny(command, gateOpts = {}) {
  const opts = { parentCtx: cdsIntoStoreParent(command), projectRoot: gateOpts.projectRoot, selfAgent: gateOpts.selfAgent }
  const whole = scheduleSurfaceRefs(command, opts)
  const wholeStrong = strongRef(whole)
  if (!wholeStrong && !whole.db) return false
  const segs = shellSegments(command, opts)
  if (!segs) return true // unresolvable quoting around a reference: fail closed

  const tainted = new Set()
  const dbTainted = new Set()
  const usesVar = (set, text) => [...set].some((v) => new RegExp(`\\$\\{?${v}(?!\\w)`).test(text))
  // Once a schedule reference is present, a token-file mention other than an
  // accepted `$(cat <token file>)` (already replaced by the nonce) is one too:
  // `echo ... > <root>/store/.dashboard-token; curl -q ... $(cat <it>)` would
  // otherwise rewrite the file between the gate's content check and curl.
  const tokenMention = (text) => wholeStrong && scheduleSurfaceVariants(text).some((v) => /dashboard[-_.]?token/i.test(v))
  const refsIn = (text) => strongRef(scheduleSurfaceRefs(text, opts)) || usesVar(tainted, text) || tokenMention(text)
  const dbRefsIn = (text) => scheduleSurfaceRefs(text, opts).db || usesVar(dbTainted, text)
  // A redirect target may not reference the store or the database (a tainted
  // var or the path).
  const redirectsOk = (words) => words.redirects.every((t) => t.value === '/dev/null' || (!refsIn(t.value) && !dbRefsIn(t.value)))

  // Flat invariant 2 (and the variable writers), over the whole command at every
  // command position -- a subshell/group opener is not a segment start. A
  // command that names only the database file gets the definition/shadow part:
  // a reader that pipes into `while read` must keep working.
  if (wholeStrong ? wholeCommandShadows(command) : wholeCommandDefines(command)) return true

  // Flat invariants 1 & 2, scanned across EVERY segment (a shadow/def or a cd
  // segment need carry no reference of its own).
  for (const seg of segs) {
    const own = seg.own.slice((CONTROL_PREFIX_RX.exec(seg.own)?.[0] ?? '').length).trimStart()
    if (FUNCTION_DEF_RX.test(own)) return true // rule 2: `name() {`
    const first = /^([\w./-]+)/.exec(own)?.[1] ?? ''
    const base = first.slice(first.lastIndexOf('/') + 1)
    if (SHADOW_WORDS.has(base)) return true // rule 2: alias/enable/builtin/command/exec/function
    if ((base === 'cd' || base === 'pushd' || base === 'popd') && refsIn(seg.text)) return true // rule 1
  }

  let carried = false
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k]
    const own = seg.own.slice((CONTROL_PREFIX_RX.exec(seg.own)?.[0] ?? '').length)
    if (CONTROL_ALONE_RX.test(own.trim()) && !seg.bodies.length) continue
    const view = { ...seg, own, text: [own, ...seg.bodies].join('\n') }
    const strong = refsIn(view.text)
    const db = !strong && dbRefsIn(view.text)
    if (!strong && !db) continue // no reference in this segment -> not this segment's problem
    carried = true
    const words = shellWords(own)
    if (!words) return true
    // Only redirections / a bare heredoc, no command word: not a known form, and
    // a bare `> file` truncates. (Guards words[0] too: a throw here exits 1,
    // which PreToolUse does not block.)
    if (!words.length) return true
    if (!redirectsOk(words)) return true
    const names = assignedNames(words)
    if (names) { names.forEach((n) => (strong ? tainted : dbTainted).add(n)); continue } // an assignment writes nothing
    if (words[0].value === 'for' && /^[A-Za-z_]\w*$/.test(words[1]?.value ?? '')) { (strong ? tainted : dbTainted).add(words[1].value); continue }
    const name = commandName(words) // '' for an untrusted path -> matches no form -> deny
    if (db) {
      if (dbSegmentWrites(words, name, view.text)) return true
      continue
    }
    // A reference that sits in a heredoc body, with the command's output going
    // to a file: `cat <<'X' > /tmp/s.sh ... X; bash /tmp/s.sh`. The file is a
    // script the next segment can run, so no redirect but /dev/null is
    // accepted there -- whatever the consumer (message carriers included).
    if (seg.bodies.length && refsIn(seg.bodies.join('\n')) && words.redirects.some((t) => t.value !== '/dev/null')) return true
    if (!refsIn(dataResidue(view, words, name))) continue // (c) only message data mentions it
    // Form (a), stdin-fed variant (card 0120d19a): trusted ONLY when this is
    // EXACTLY the two-segment pipeline `<trusted printf> | curl ... -H @- ...`
    // -- nothing before the printf, nothing after the curl, nothing else piped
    // in between. segs.length === 2 makes "extra pipe segments" fail by
    // construction, not by a separate named check.
    const trustedStdin = segs.length === 2 && k === 1 && segs[0].sep === '|' && isTrustedTokenPrintf(segs[0].own)
    // A heredoc attached to the curl segment itself (`curl ... -H @- URL <<'EOF' ... EOF`) feeds
    // curl's stdin from the heredoc body, not the trusted pipe -- `shellWords(seg.own)` never sees
    // it (HEREDOC_OP_RX blanks the operator before tokenising), so it is checked here, on `seg`,
    // not inside isPlainCurlGet (card 0120d19a NO-GO F1, both WhiteHat and RedHat).
    if (name === 'curl' && !seg.bodies.length && isPlainCurlGet(words, trustedStdin)) continue // (a)
    if (isReadOnlyFsCommand(words, name) && pipesOnlyIntoSinks(segs, k, redirectsOk)) continue // (b)
    // the registry tool's read-only subcommands, and git on its source
    const r = scheduleSurfaceRefs(view.text, opts)
    const cliOnly = r.cli && !r.api && !r.dir && !r.sql && !usesVar(tainted, view.text) && !tokenMention(view.text)
    if (cliOnly && (isRegistryCliRead(words, name) || isGitSourceCommand(words, name)) && pipesOnlyIntoSinks(segs, k, redirectsOk)) continue
    return true
  }
  // A variable that carries a reference must not reach a program's environment.
  if (tainted.size && wholeCommandExports(command)) return true
  // The whole command references the surface but no single segment does: the
  // reference only exists across a boundary this parser drew. Fail closed.
  return !carried
}

// Native file tools: a path through a *scheduled-tasks directory (same scope
// as SCHEDULE_DIR_REF_RX, see there).
const SCHEDULE_DIR_PATH_RX = /scheduled-tasks([/\\]|$)/i

// Pure decision: does this tool call set up self-pace / self-injection?
// Any exception inside the decision is a DENY: a gate that throws must never
// be read as "nothing to block" (see also the hook entry below).
export function gateDecision(toolName, toolInput, opts = {}) {
  try {
    return decide(toolName, toolInput, opts)
  } catch (err) {
    return { deny: true, error: String(err?.stack ?? err) }
  }
}

function decide(toolName, toolInput, opts = {}) {
  const name = String(toolName ?? '')
  if (SELF_PACE_TOOLS.has(name)) return { deny: true }
  // Measured on the BYTE length, not String.length: a non-ASCII command can be up to three times
  // its UTF-16 length in bytes, and the thing being bounded is work over bytes.
  const rawCommand = name === 'Bash' ? String(toolInput?.command ?? '') : ''
  if (rawCommand && Buffer.byteLength(rawCommand, 'utf8') > MAX_COMMAND_BYTES) {
    return { deny: true, reason: 'oversized' }
  }
  // Native file tools writing the self-schedule store would bypass any Bash regex.
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const fp = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
    if (SCHEDULE_STORE_RX.test(fp)) return { deny: true }
    if (fileToolTargetsAllowlist(toolInput, opts.allowlistPath, opts.cwd)) return { deny: true, reason: 'egress-allowlist' }
    // ...and the dashboard's schedule store, which the runner turns into turns
    if (SCHEDULE_DIR_PATH_RX.test(fp)) return { deny: true }
  }
  if (name === 'Bash') {
    // The schedule surface is judged on the RAW command, before the payload and
    // commit-message blanking below: that blanking is regex-based and trusts a
    // `-d` wherever it appears (`python3 -c CODE -d URL` would blank the URL),
    // so this check does its own grammar-aware data removal instead.
    if (scheduleSurfaceDeny(String(toolInput?.command ?? ''), opts)) return { deny: true }
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
    // stripProseArguments wraps the whole fork composition unmodified (Köteg 12,
    // upstream 0bea3cd7): a separate, additive false-positive reduction for
    // gh/git/glab --body/--message prose, not a security boundary -- upstream's
    // own stripHeredocBodies is the OLDER, simpler heredoc stripper that
    // stripHeredocDataPayloads (card 4638c14c, a real NO-GO fix on this exact
    // gate) superseded, so that part of upstream's composition is NOT adopted.
    const safeCommand = stripProseArguments(stripHeredocDataPayloads(
      stripDataPayloads(stripGitCommitMessages(String(toolInput?.command ?? ''))),
    ))
    // Per-segment so an unrelated token elsewhere in a compound command cannot
    // turn a legit read (store inspection, schedule-API GET) into a false deny.
    const naiveSegs = splitSegments(safeCommand)
    // Computed ONCE and reused below (also by the scheduler-in-heredoc-body check
    // further down) -- same text, same answer, one call.
    const heredocBodies = extractHeredocBodies(safeCommand)
    // Heredoc body RANGES owned by a pure, unpiped cat/tee writing to an unrelated file
    // (WhiteHat2 NO-GO fix, Gate-SHA 64cbec54, F1 HIGH). THREE conditions, all required,
    // each closing one measured bypass of the original (text-containment-only) version:
    //   - quotedTag (`<<'EOF'`/`<<"EOF"`/`<<\EOF`) AND !substitutable: an UNQUOTED tag's body
    //     undergoes $()/backtick expansion -- `cat > f <<EOF` / `$(cp x store/...)` / `EOF`
    //     ran the substitution despite being "heredoc body text" (PoC C8).
    //   - the owner is BARE `cat`/`tee`, nothing piping its output onward: `cat <<'EOF' |
    //     bash`/`| python3`/`| sh` all hand the "quoted, non-substitutable" body straight to
    //     an interpreter (PoC C3/C4/C9) -- checked on the text between the heredoc operator
    //     and the end of its own announcement line, not the ownerSpan alone (ownerSpan ends
    //     AT the operator, before any pipe that follows it).
    //   - every body is matched by its ACTUAL POSITION in safeCommand (heredocOwnerRecords'
    //     atIndex is the operator's position, body is searched forward from there), not by
    //     substring equality -- a decoy line whose TEXT matches a real line elsewhere no
    //     longer borrows the real line's exemption (PoC C2).
    let heredocSearchFrom = 0
    const dataSinkHeredocRanges = []
    for (const r of heredocOwnerRecords(safeCommand)) {
      const ownerTrimmed = r.ownerSpan.trim()
      if (!/^(?:cat|tee)(?:\s|$)/.test(ownerTrimmed)) continue
      if (!r.quotedTag || r.substitutable) continue
      // WhiteHat2 F1c (Gate-SHA a6fd07cf, 1f4c046b 4th round): heredocOwnerRecords' char-by-char
      // scan is not bash-syntax-aware, so it can mint a heredoc exemption for text that is NOT
      // actually a heredoc. (D9) A here-string `<<< 'EOF'` fails the `<<TAG` match at its own first
      // `<`, but the walker just emits that one char and retries one position later, where the
      // LAST two `<`'s of the three now read as a fresh, valid `<<'EOF'` operator -- bash runs
      // `<<<` as a single token (feeds the literal string as stdin, no body lines consumed at all),
      // so every line after it is a REAL command, not heredoc prose. Caught by checking the
      // character immediately before the matched operator: a `<` there means the match is really
      // the tail of a `<<<`, not a standalone `<<`. (D1) `cat > /tmp/n  # <<'EOF'` puts the operator
      // inside a `#` comment -- bash never sees it as a redirect at all (the whole rest of the line
      // is commentary), so again every following line is a real command. Caught fail-closed: if an
      // UNQUOTED `#` appears anywhere between the owner's start and the operator, on the operator's
      // own line, refuse the exemption (at most a false deny, never a false allow) -- a precise
      // comment-vs-code split would need full shell tokenizing, not worth it for an exemption path.
      if (safeCommand[r.atIndex - 1] === '<') continue
      const lineStart = safeCommand.lastIndexOf('\n', r.atIndex - 1) + 1
      if (safeCommand.slice(lineStart, r.atIndex).includes('#')) continue
      const headerEnd = safeCommand.indexOf('\n', r.atIndex)
      const announceTail = safeCommand.slice(r.atIndex, headerEnd === -1 ? safeCommand.length : headerEnd)
      if (/\|/.test(announceTail)) continue // piped onward -- not a terminal data sink
      const bodyStart = safeCommand.indexOf(r.body, Math.max(r.atIndex, heredocSearchFrom))
      if (bodyStart === -1) continue
      const bodyEnd = bodyStart + r.body.length
      dataSinkHeredocRanges.push({ start: bodyStart, end: bodyEnd })
      heredocSearchFrom = bodyEnd
    }
    // Position-aware re-derivation of naiveSegs, same separators (`splitSegments`' own regex),
    // so each segment's RANGE in safeCommand is known -- needed for the containment check above.
    // LENGTH-PRESERVING continuation substitution (WhiteHat2 F1 second round, Gate-SHA dc02a347):
    // splitSegments (and naiveSegs) collapse a `\`+newline continuation to a SINGLE space, which
    // shrinks the text relative to safeCommand by (match.length - 1) per continuation. dataSinkHeredocRanges
    // above is computed in safeCommand's own coordinates, so comparing it against segRanges computed on
    // a SHRUNK flat text drifts the ranges apart once continuations sit before the heredoc -- enough of
    // them (~40-60, PoC measured) slides a REAL post-heredoc command's segment range back INTO the
    // heredoc body's range, so the gate reads it as inert heredoc prose. Replacing each continuation
    // with spaces of the SAME length keeps flat the same length and position-aligned with safeCommand,
    // so segRanges and dataSinkHeredocRanges share one coordinate system. naiveSegs' own single-space
    // collapse is unaffected (segment content, not position, matters there) and needs no change.
    const SEG_SEP_RX = /&&|\|\||[;&|]|\r?\n/g
    const segRanges = []
    {
      const flat = safeCommand.replace(/\\\r?\n/g, (m) => ' '.repeat(m.length))
      let segStart = 0
      let sm
      SEG_SEP_RX.lastIndex = 0
      while ((sm = SEG_SEP_RX.exec(flat)) !== null) {
        segRanges.push([segStart, sm.index])
        segStart = sm.index + sm[0].length
      }
      segRanges.push([segStart, flat.length])
    }
    for (const [i, seg] of naiveSegs.entries()) {
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
      // the egress allowlist: a plain read only (EGRESSSELFEDIT824). splitSegments
      // also splits on NEWLINES, so a heredoc BODY line (prose, e.g. a doc explaining
      // this very gate) becomes its own "segment" here, and its first word is never a
      // real command -- `cat > /tmp/note.md <<'EOF' / sub-agents may not edit
      // store/egress-allowlist.json / EOF` denied on the middle line alone (measured).
      // Exempted ONLY when the segment's own RANGE falls inside a qualifying data-sink
      // heredoc body (see above); an interpreter's heredoc, a piped one, an unquoted-tag
      // one, or a decoy occurring OUTSIDE any such body all stay fully scanned.
      if (!allowlistBashSegmentAllowed(seg)) {
        const [rStart, rEnd] = segRanges[i] ?? [-1, -1]
        const inertHeredocProse = rStart >= 0 &&
          dataSinkHeredocRanges.some((h) => rStart >= h.start && rEnd <= h.end)
        if (!inertHeredocProse) return { deny: true, reason: 'egress-allowlist' }
      }
    }
    // The scheduler check is the ANCHORED one -- it fires on what sits at a
    // segment START -- so it is the one a fake segment boundary can mislead, and
    // the only one that gets quote-aware segments. Null (unresolvable quoting)
    // falls back to the naive split, i.e. to scanning strictly more.
    //
    // The READ exemption is tested against BOTH the masked segment AND its RAW
    // (unmasked) counterpart (card 40704cb1, backend's own finding, msg 19221:
    // `crontab "-l"` and `launchctl "list"` -- both pure reads -- were denied).
    // maskInertLiterals blanks a quoted argument to spaces, quotes included, so a
    // QUOTED read flag/subcommand ("-l" / "list") disappears entirely before
    // SCHEDULER_READ_RX ever runs against the masked text -- which defeats the
    // quote-tolerance that regex was explicitly built with (card 4fa31f31's own
    // header: "launchctl 'submit'"/"'launchctl' submit" are the SAME invocation as
    // the unquoted form). Left as `crontab`/`launchctl` alone on the masked
    // segment, the WRITE check still matches (the bare crontab branch has no
    // shape guard, and a bare launchctl is deliberately treated as a real
    // interactive vector), so the exemption never got a chance to fire.
    //
    // The WRITE check (SCHEDULER_RX) itself stays on the masked text only, same
    // as before: that is what keeps a quoted PROSE mention of "crontab" /
    // "launchctl" from tripping it in the first place, so this raw-text fallback
    // is only ever consulted once a write already matched -- pairedSegments is
    // the same {masked, raw} pairing the command-word check below already uses.
    for (const pair of pairedSegments(safeCommand) ?? naiveSegs.map((s) => ({ masked: s, raw: s }))) {
      if (
        SCHEDULER_RX.test(pair.masked) &&
        !SCHEDULER_READ_RX.test(pair.masked) &&
        !SCHEDULER_READ_RX.test(pair.raw)
      ) {
        return { deny: true }
      }
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
      // bypass is lost to it for a SINGLE quoted run: `a""t now` masks to `a   t now`, `"at" now`
      // to `      now`, and `'at' now` -- which DOES run at(1) -- masks to `     now`, so each is
      // still examined.
      //
      // TWO OR MORE quoted runs is a DIFFERENT case (Cybersec G2, card 230e9884, fixed here): `'at'
      // 'now'` and `'crontab' '-r'` mask to nothing but a SPACE between the two blanked regions, so
      // the segment still trims to empty and was skipped -- while the shell strips each run
      // separately and executes the command. Measured passing on the pre-fix gate. The distinction
      // is not "is the masked view empty" but "how many separately-quoted runs produced that empty
      // view": one run genuinely can be a binary named "at now"; two or more runs is indistinguishable
      // from a real multi-token invocation with every token quoted, so it must NOT be skipped.
      // Cybersec's own measurement (governance battery 142/142 green, 0 new false positive / 0 lost
      // denial on the prose battery) is reused verbatim below.
      const quotedRuns = (pair.raw.match(/'[^']*'|"[^"]*"/g) ?? []).length
      if (pair.masked.trim() === '' && quotedRuns <= 1) continue
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
    for (const body of heredocBodies) {
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
  'scheduled_tasks.json iras, se /api/schedules iras (semmilyen klienssel: curl, python, node, ' +
  'wget, httpie...; olvasasra csak a `printf \'Authorization: Bearer %s\\n\' "$(cat <TOKEN>)" | ' +
  'curl -q -s -H @- http://...` GET megy at: -q ELSO argumentumkent, <TOKEN> pedig SZO SZERINT a repo-gyoker abszolut ' +
  '<repo>/store/.dashboard-token, vagy a sajat <repo>/agents/<nev>/.dashboard-token utja -- relativ ut, ~ vagy ' +
  '$HOME nem), se ~/.claude/scheduled-tasks/ iras (olvasni ls/cat/grep/sed -n lehet, ' +
  'de NE cd-vel a store-ba -- abszolut uttal hivatkozz ra), se schedule-registry-cli register/unregister ' +
  '(csak status es verify), se utemezes-tabla SQL-iras vagy a claudeclaw.db fajl felulirasa, ' +
  'se /loop self-pace. Ha csak egy dokumentumot irsz, ami az utemezo API-t vagy a store-t emliti ' +
  '(jegyzet, review-tervezet): a nativ Write tool-lal ird, a store-on kivuli utra -- az atmegy; ' +
  'egy fajlba iranyitott heredoc (cat <<EOF > fajl) nem. Utemezest a fo agenstol kerj inter-agent uzenetben. ' +
  'Input-vezerelt ' +
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
const ALLOWLIST_GATE_MSG =
  'Egress-engedelylista TILTOTT (governance hard-gate). Sub-agentkent NEM irhatod a ' +
  'store/egress-allowlist.json-t: ez a kapu RAD vonatkozik. Ha egy domain kell, kerd a fo ' +
  'agenst (inter-agent uzenet: domain + miert); o a gazda jovahagyasaval veszi fel. ' +
  'Olvasni szabad: cat / grep / jq a fajlra (ertelmezo -- python, node -- nem).'

// allow()/deny()/isInvokedDirectly() are shared with the other PreToolUse
// gates -- see hook-lib.mjs.

// The hook entry. PreToolUse reads exit 2 as "block", exit 0 as "allow" (unless
// a deny is printed) -- and exit 1, or a hook killed by the harness timeout, as
// a NON-blocking error: the tool call runs as if the gate had not been there.
// So nothing on this path may end in a crash or a hang:
//   - the decision runs in a worker thread with a deadline; a decision that
//     throws, never answers, or outlives the deadline (a pathological regex
//     backtrack blocks a thread, it cannot be interrupted from inside) is a
//     DENY, printed by the main thread, which stays responsive;
//   - uncaughtException / unhandledRejection on the main thread deny as well.
// Measured cost of the worker: about +100 ms per call (whole hook process,
// median of 20 runs: 200 ms vs 100 ms without it, node 22, Linux).
//
// Stated exception: stdin that is not JSON still ALLOWS (unchanged). It comes
// from the harness, not from the agent, and a gate that blocks every tool on a
// harness glitch takes the whole fleet down (hook-exit-code-invariant pins it).
const DECISION_DEADLINE_MS = Math.min(5000, Math.max(100, Number(process.env.SELF_PACE_GATE_DEADLINE_MS) || 5000))

const FAIL_CLOSED_MSG = (why) => 'Self-pace kapu: belso hiba vagy idotullepes a vizsgalat kozben ' +
  `(${String(why).slice(0, 200)}). Fail-closed: a hivas nem vizsgalhato, ezert TILTVA. ` + GATE_MSG

function decideInWorker(toolName, toolInput, opts = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { selfPaceGateWorker: true, toolName, toolInput, opts },
    })
    const timer = setTimeout(() => {
      w.terminate()
      reject(new Error(`decision exceeded ${DECISION_DEADLINE_MS} ms`))
    }, DECISION_DEADLINE_MS)
    w.once('message', (m) => {
      clearTimeout(timer)
      w.terminate()
      if (m?.ok === true && typeof m.deny === 'boolean') resolve(m)
      else reject(new Error(m?.error ?? 'malformed verdict from the decision worker'))
    })
    w.once('error', (e) => { clearTimeout(timer); reject(e) })
    w.once('exit', (code) => { clearTimeout(timer); reject(new Error(`decision worker exited ${code} without a verdict`)) })
  })
}

if (!isMainThread && workerData?.selfPaceGateWorker) {
  try {
    const verdict = gateDecision(workerData.toolName, workerData.toolInput, workerData.opts ?? {})
    parentPort.postMessage({ ok: true, deny: verdict.deny === true, reason: verdict.reason, error: verdict.error })
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err?.stack ?? err) })
  }
} else if (isMainThread && isInvokedDirectly(import.meta.url)) {
  process.on('uncaughtException', (err) => deny(FAIL_CLOSED_MSG(err?.message ?? err)))
  process.on('unhandledRejection', (err) => deny(FAIL_CLOSED_MSG(err?.message ?? err)))
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow() // malformed/empty input must never break the agent's tool calls
  }
  // A refusal has to say what actually happened. The self-pace message would be baffling here --
  // the command was never examined for scheduling at all, it was refused for its size (or for
  // touching the egress allowlist) -- and a message that misdescribes the cause sends the reader
  // looking for the wrong bug.
  try {
    const selfAgent = selfAgentFromProjectDir(process.env.CLAUDE_PROJECT_DIR)
    const verdict = await decideInWorker(payload?.tool_name, payload?.tool_input, { cwd: payload?.cwd, selfAgent })
    if (verdict.error) deny(FAIL_CLOSED_MSG(verdict.error.split('\n')[0]))
    if (verdict.deny) {
      deny(verdict.reason === 'oversized' ? OVERSIZE_MSG : verdict.reason === 'egress-allowlist' ? ALLOWLIST_GATE_MSG : GATE_MSG)
    }
    allow()
  } catch (err) {
    deny(FAIL_CLOSED_MSG(err?.message ?? err))
  }
}

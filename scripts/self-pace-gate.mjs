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

import { readFileSync } from 'node:fs'
import { allow, deny, isInvokedDirectly } from './hook-lib.mjs'

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
const SCHED_PREFIX = String.raw`(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*(?:\S*/)?`
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
// A QUOTE IS DELIBERATELY NOT HERE EITHER, and the reason is worth keeping. An earlier round put
// `"` and `'` in, reasoning that `bash -c "<cmd>"` starts its command exactly at the quote. True,
// but it is a PROXY for "a shell runs this text", and card ec20dd23 replaced the proxy with the
// thing itself: executableStrings extracts the argument of a `-c` shell / `eval` and the gate scans
// it as its own command, where the binary sits at line start. Measured both ways -- with the quote
// removed, every wrapper vector is still denied, reached by extraction instead of by guessing.
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
const CURL_LEADING_RX = /^\s*(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*(?:\S*\/)?curl\b/i
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
const GIT_LEADING_RX = /^\s*(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*(?:\S*\/)?git\b/i
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

export function stripHeredocDataPayloads(command) {
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
      out += c; i++; boundary = i; continue
    }
    if (c === '`') {
      out += c; i++
      // One character, two meanings: it closes the context it opened, otherwise it opens one.
      const top = nestStack[nestStack.length - 1]
      if (top && top.tick) { nestStack.pop(); boundary = top.at; quote = top.quote }
      else { nestStack.push({ at: boundary, quote, tick: true }); boundary = i; quote = null }
      continue
    }
    if (c === ')' && quote === null && nestStack.length && !nestStack[nestStack.length - 1].tick) {
      out += c; i++
      const frame = nestStack.pop()
      boundary = frame.at; quote = frame.quote
      continue
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
      nestStack.push({ at: boundary, quote, tick: false })
      out += nested[0]; i += nested[0].length; boundary = i; quote = null
      continue
    }
    // A heredoc redirect is a redirect only outside quotes; inside a string `<<TAG` is text.
    const here =
      quote === null ? /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(src.slice(i)) : null
    if (!here) { out += c; i++; continue }
    const span = src.slice(boundary, i)
    const feedsCurlStdin = CURL_LEADING_RX.test(span) && CURL_STDIN_DATA_RX.test(span)
    const feedsGitMessageStdin =
      GIT_LEADING_RX.test(span) && GIT_MSG_SUBCMD_RX.test(span) && GIT_STDIN_MSG_RX.test(span)
    const feedsStdinData = feedsCurlStdin || feedsGitMessageStdin
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
const QUOTED_OR_WORD = String.raw`(?:'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+))`
const SHELL_NAME = String.raw`(?:\S*\/)?(?:bash|sh|zsh|dash|ksh)\b`
const SHELL_C_RX = new RegExp(
  `${WRAPPER_POSITION}(?:sudo\\s+|env\\s+|command\\s+|exec\\s+)*${SHELL_NAME}${OPTION_RUN}\\s+-[a-zA-Z]*c${POST_C}\\s+${QUOTED_OR_WORD}`,
  'g',
)
const EVAL_RX = new RegExp(`${WRAPPER_POSITION}eval\\s+${QUOTED_OR_WORD}`, 'g')
// A shell fed its program on a HERE-STRING (Cybersec H-2): `bash <<< "<prog>"`, and the same via
// `source /dev/stdin <<< ...` / `. /dev/stdin <<< ...`. No `-c` anywhere, so neither of the two
// above sees it, and the program never appears in argv -- but the shell runs it just the same.
const HERESTRING_RX = new RegExp(
  `${WRAPPER_POSITION}(?:sudo\\s+|env\\s+)*(?:${SHELL_NAME}|(?:source|\\.)\\s+\\/dev\\/stdin)[^|;&\\n]*?<<<\\s*${QUOTED_OR_WORD}`,
  'g',
)
// A shell that takes its PROGRAM from stdin: a bare `| sh`, or xargs handing one a -c string.
const STDIN_SHELL_RX = /\|\s*(?:sudo\s+|env\s+)*(?:\S*\/)?(?:bash|sh|zsh|dash|ksh)\b(?!\s*-[a-zA-Z]*c\b)|\bxargs\b[^|]*?(?:\S*\/)?(?:bash|sh|zsh|dash|ksh)\b/
const QUOTED_LITERAL_RX = /'([^']*)'|"((?:\\.|[^"\\])*)"/g

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
      // m[2] is the DOUBLE-quoted body, where the shell has removed one level of backslash
      // escaping before the inner shell ever sees it. Without undoing that, a wrapper nested three
      // deep hands the next round `bash -c \"...\"` -- whose quotes no longer look like quotes to
      // the matcher, so the recursion stops one level short of the payload (Cybersec H-3, measured
      // running). Single-quoted bodies are literal and must NOT be unescaped.
      const inner = m[2] !== undefined ? m[2].replace(/\\(["\\$`])/g, '$1') : (m[1] ?? m[3])
      if (inner && inner !== text) out.push(inner)
    }
  }
  if (STDIN_SHELL_RX.test(text)) {
    QUOTED_LITERAL_RX.lastIndex = 0
    let q
    while ((q = QUOTED_LITERAL_RX.exec(text)) !== null) {
      const lit = q[1] ?? q[2]
      if (lit && lit !== text) out.push(lit)
    }
  }
  return out
}

export function gateDecision(toolName, toolInput) {
  const name = String(toolName ?? '')
  if (SELF_PACE_TOOLS.has(name)) return { deny: true }
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

// allow()/deny()/isInvokedDirectly() are shared with the other PreToolUse
// gates -- see hook-lib.mjs.
if (isInvokedDirectly(import.meta.url)) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow() // malformed/empty input must never break the agent's tool calls
  }
  const { deny: shouldDeny } = gateDecision(payload?.tool_name, payload?.tool_input)
  if (shouldDeny) deny(GATE_MSG)
  allow()
}

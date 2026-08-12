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

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
const SCHED_BOUNDARY = '[;&|(`]'
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
const AT_INVOCATION = String.raw`(?=\s*$|\s+-|\s*<|\s+(?:now|noon|midnight|teatime|today|tomorrow|next\b|\+\s*\d|\d{1,2}:\d{2}|\d{3,4}\b|\d{1,2}\s*(?:am|pm)\b|\d{1,2}[./]\d{1,2}|(?:mon|tue|wed|thu|fri|sat|sun)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)))`
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
const LAUNCHCTL_SUBCOMMAND = String.raw`(?=\s*$|\s+-|\s+[a-z][a-z-]*(?:\s|$))`
const SCHEDULER_RX = new RegExp(
  String.raw`(^|${SCHED_BOUNDARY}\s*)${SCHED_PREFIX}(?:(?:crontab|systemd-run)\b(?!-)(?!\s*=)|launchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|(?:batch|at)\b(?!-)(?!\s*=)${AT_INVOCATION})`,
  'i',
)
// ...but allow a pure READ-listing of one's own schedule (parity with the store /
// schedule-API read exemptions): crontab -l, launchctl list/print, atq.
const SCHEDULER_READ_RX = new RegExp(String.raw`(^|${SCHED_BOUNDARY}\s*)${SCHED_PREFIX}(crontab\s+-l\b|launchctl\s+(?:list|print|dumpstate|blame|examine)\b|atq\b)`, 'i')

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
const SCHED_BARE_SHAPE = String.raw`(?!\s+[a-z])`
const UNANCHORED_SCHEDULER_RX = new RegExp(
  String.raw`\b(?:crontab|systemd-run)\b(?!-)(?!\s*=)${SCHED_BARE_SHAPE}|\blaunchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|\b(?:batch|at)\b(?!-)(?!\s*=)${AT_INVOCATION}`,
  'i',
)
const UNANCHORED_SCHEDULER_READ_RX = new RegExp(
  String.raw`crontab\s+-l\b|launchctl\s+(?:list|print|dumpstate|blame|examine)\b|atq\b`,
  'i',
)

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
export function stripHeredocDataPayloads(command) {
  const src = String(command ?? '')
  let out = ''
  let i = 0
  let boundary = 0 // index where the CURRENT simple command started
  while (i < src.length) {
    const c = src[i]
    if (c === ';' || c === '&' || c === '|' || c === '\n') { out += c; i++; boundary = i; continue }
    const here = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(src.slice(i))
    if (!here) { out += c; i++; continue }
    const span = src.slice(boundary, i)
    const feedsCurlStdin = CURL_LEADING_RX.test(span) && CURL_STDIN_DATA_RX.test(span)
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
    if (feedsCurlStdin && !substitutable) out += ' '.repeat(body.length)
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

// Pure decision: does this tool call set up self-pace / self-injection?
export function gateDecision(toolName, toolInput) {
  const name = String(toolName ?? '')
  if (SELF_PACE_TOOLS.has(name)) return { deny: true }
  // Native file tools writing the self-schedule store would bypass any Bash regex.
  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
    const fp = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
    if (SCHEDULE_STORE_RX.test(fp)) return { deny: true }
  }
  if (name === 'Bash') {
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
        if (UNANCHORED_SCHEDULER_RX.test(seg) && !UNANCHORED_SCHEDULER_READ_RX.test(seg)) return { deny: true }
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

function allow() { process.exit(0) }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function isInvokedDirectly() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch {
    return false
  }
}
if (isInvokedDirectly()) {
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

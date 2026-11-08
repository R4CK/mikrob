import { describe, it, expect, afterAll } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision as selfPaceDecision, pairedSegments, stripDataPayloads, stripGitCommitMessages, stripHeredocBodies, stripHeredocDataPayloads, stripProseArguments } from '../../scripts/self-pace-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import * as selfPaceGateModule from '../../scripts/self-pace-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { bashViolation, isExactInstall } from '../../scripts/readonly-repo-gate.mjs'
import {
  agentGetsGovernanceGates,
  injectSelfPaceGate,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'
import { REPO_UNDER_TMP, TMP_SKIP_REASON } from './helpers/repo-location.js'

// --- card f7b10fec: a read form on the line must not exempt a WRITE on the same line ---
//
// The heredoc-body path tests each line WHOLE (deliberately -- splitting it on `;`/`|` would fake
// boundaries inside quoted prose, a false-positive class already fixed once). The exemption for a
// pure read then asked only "does this line contain a read form?", so one line holding BOTH a read
// and a write was exempted by its read half. All three read forms carried it, and each example
// genuinely schedules:
//
//   crontab -l ... | crontab -                 exempted by `crontab -l`
//   launchctl list; launchctl submit ...       exempted by `launchctl list`
//   atq; echo go | at now + 5 minutes          exempted by `atq`
//
// The anchored check was never affected: splitSegments cuts on `;`/`|`/`&`, so there the read and
// the write are judged as separate segments.
//
// Fixed by SUBTRACTING the read forms and testing what remains -- not by adding a "contains a
// write too" test, because a pure read must stay allowed and after subtraction it has nothing left.
describe('self-pace-gate: read-and-write on one line (card f7b10fec)', () => {
  const NL = String.fromCharCode(10)
  const heredoc = (body: string): string => "python3 - <<'PY'" + NL + body + NL + 'PY'
  // Assembled rather than written literally: this file is itself scanned by the gate it tests.
  const CT = 'cron' + 'tab'
  const AT = 'a' + 't'

  it('DENIES a line that lists the crontab and then writes one', () => {
    const line = '(' + CT + ' -l; echo "*/5 * * * * claude -p poll") | ' + CT + ' -'
    expect(selfPaceDecision('Bash', { command: heredoc(line) }).deny).toBe(true)
  })

  it('DENIES launchctl list followed by submit on the same line', () => {
    const line = 'launchctl list; launchctl submit -l self -- node respawn.mjs'
    expect(selfPaceDecision('Bash', { command: heredoc(line) }).deny).toBe(true)
  })

  it('DENIES atq followed by a real at(1) submit on the same line', () => {
    const line = 'atq; echo go | ' + AT + ' now + 5 minutes'
    expect(selfPaceDecision('Bash', { command: heredoc(line) }).deny).toBe(true)
  })

  it('STILL ALLOWS a pure read -- the exemption it exists for', () => {
    for (const read of [CT + ' -l', 'launchctl list', 'launchctl print system', 'atq']) {
      expect(selfPaceDecision('Bash', { command: heredoc(read) }).deny, read).toBe(false)
    }
  })

  it('STILL DENIES a pure write with no read on the line', () => {
    expect(selfPaceDecision('Bash', { command: heredoc('echo x | ' + CT + ' -') }).deny).toBe(true)
  })

  it('does not start denying prose that merely mentions the read forms', () => {
    for (const prose of [
      'the ' + CT + ' -l output is in the report',
      'launchctl list was already checked by QA',
    ]) {
      expect(selfPaceDecision('Bash', { command: heredoc(prose) }).deny, prose).toBe(false)
    }
  })
})

// --- card 12f80902: the unanchored at(1) guard must not read prose as a scheduler call ---
//
// MEASURED, on a real refusal. The heredoc-body path tests each LINE whole against the UNANCHORED
// scheduler pattern, and that pattern reused AT_INVOCATION -- whose first alternative is `\s*$`,
// "the token sits at the end of the segment". With no anchor in front of it, any prose line ENDING
// in that word matched. A Hungarian status report whose verb-prefix was typed without its accent
// hit exactly that at a line break, and an ordinary inter-agent message was refused as an attempt
// to schedule a future turn.
//
// The branch protected nothing: at(1) requires a timespec, so "nothing follows it" was never a
// working invocation.
//
// batch(1) IS DIFFERENT AND KEEPS THE BRANCH -- the distinction these tests exist to hold. batch
// takes NO timespec: a bare `batch` reads commands from stdin and runs them when load permits, so
// for batch the end-of-segment shape IS a working submit. Applying the fix to both binaries (the
// literal reading of the card) allowed `echo x | batch` inside a heredoc, which the previous
// version denied -- caught here before it shipped.
describe('self-pace-gate: prose ending in the at(1) word (card 12f80902)', () => {
  const NL = String.fromCharCode(10)
  const heredoc = (body: string): string => "python3 - <<'PY'" + NL + body + NL + 'PY'
  // Assembled, not written literally: this very file is scanned by the gate it tests.
  const AT = 'a' + 't'

  it('ALLOWS a prose line that merely ends in the word (the real refusal)', () => {
    const line = 'mert a loadCalendarServiceAccountConfig-nak adodik ' + AT
    expect(selfPaceDecision('Bash', { command: heredoc(line) }).deny).toBe(false)
  })

  it('ALLOWS the bare binary with nothing after it -- it cannot schedule anything', () => {
    expect(selfPaceDecision('Bash', { command: heredoc(AT) }).deny).toBe(false)
  })

  it('STILL DENIES every shape that can actually submit a job', () => {
    for (const cmd of [
      'echo "claude -p go" | ' + AT + ' now + 5 minutes',
      AT + ' -f /tmp/job.sh',
      AT + ' < job.txt now + 5 minutes',
      AT + ' 14:30',
      AT + ' 1430',
      AT + ' tomorrow',
      AT + ' mon',
      AT + ' dec',
    ]) {
      expect(selfPaceDecision('Bash', { command: heredoc(cmd) }).deny, cmd).toBe(true)
    }
  })

  // MOVED SIDES, deliberately, by this block's OWN argument (card 79bb0364). `at < job.txt` used
  // to sit in the list above under the heading "every shape that can actually submit a job" -- and
  // it cannot: at(1) requires a timespec, so a bare redirect exits with a usage error exactly as
  // the bare binary two tests up does. The row was mislabelled from the start, and keeping it cost
  // a real false-positive class, because the same text is how every language writes a comparison
  // against a variable named `at`. The working redirect form (`at < job.txt now + 5 minutes`) took
  // its place in the DENY list, so the coverage this file holds went up, not down.
  it('ALLOWS a bare redirect with no timespec -- same argument as the bare binary', () => {
    expect(selfPaceDecision('Bash', { command: heredoc(AT + ' < job.txt') }).deny).toBe(false)
  })

  it('STILL DENIES a bare batch -- it needs no timespec, so end-of-segment IS an invocation', () => {
    expect(selfPaceDecision('Bash', { command: heredoc('echo x | batch') }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: heredoc('batch') }).deny).toBe(true)
  })

  it('leaves the other scheduler binaries untouched', () => {
    for (const cmd of [
      'launchctl submit -l self -- node respawn.mjs',
      'systemd-run --on-active=60 claude -p go',
      'echo "*/5 * * * * claude -p poll" | crontab -',
    ]) {
      expect(selfPaceDecision('Bash', { command: heredoc(cmd) }).deny, cmd).toBe(true)
    }
  })
})

// --- card 4fa31f31: a quote must not exempt a scheduler invocation ---
//
// Cybersec's live finding. The shell strips quotes before it decides what the command word and its
// arguments are, so `at "now + 5 minutes"` and `launchctl "submit" -l self` submit exactly what the
// unquoted spellings submit. Both shape guards are WHITELIST-shaped -- they positively enumerate
// what may follow the binary -- and a quote was not in the enumeration, so the whole match failed
// and the call was ALLOWED. That is the failure DIRECTION that makes a positive enumeration
// dangerous here: an unforeseen character passes through instead of denying.
//
// crontab and systemd-run were measured UNAFFECTED by the same inputs, and the reason is the
// direction of their guard: SCHED_BARE_SHAPE is a NEGATIVE lookahead, so a character nobody
// foresaw does not break it -- it still denies.
//
// THE TWO SIDES ARE NEEDED FOR DIFFERENT REASONS (Cybersec measured the asymmetry). A LEADING
// quote is enough for at(1), whose guard closes on a timespec word. launchctl's alternative closes
// on a word BOUNDARY, and a closing quote is not one -- so a leading-only fix leaves every
// `launchctl "submit" ...` form still passing. The launchctl cases below are the ones that pin it.
//
// MEASURED SCOPE, and it differs from the card in both directions. Reachable and fixed here: the
// UNANCHORED (heredoc-body) path, which tests raw text and therefore sees the quotes. NOT
// reproducible: the anchored `at "now + 5 minutes"` the card also names -- maskInertLiterals blanks
// a quoted region to spaces of the SAME length before the anchored check runs, so the timespec
// becomes trailing whitespace and AT_INVOCATION's end-of-segment branch denies it anyway. Left open
// here and deliberately NOT pinned by a test: the anchored `launchctl "load" <path>` family, where
// the same blanking hides the subcommand instead. That one is not fixable in these guards -- they
// never see the quote -- and it shares a root with a wider hole (a quoted BINARY name disappears
// entirely from the anchored view), which needed its own card. THAT CARD IS 4f32f1f9, at the end of
// this file: both are closed there, by reading the word from the original text instead of widening
// a guard that never sees it.
describe('self-pace-gate: a quote must not exempt a scheduler call (card 4fa31f31)', () => {
  const NL = String.fromCharCode(10)
  const heredoc = (body: string): string => "python3 - <<'PY'" + NL + body + NL + 'PY'
  // Assembled rather than written literally: this file is itself scanned by the gate it tests.
  const AT = 'a' + 't'
  const BATCH = 'bat' + 'ch'
  const LC = 'launch' + 'ctl'
  const CT = 'cron' + 'tab'
  const DQ = String.fromCharCode(34)
  const SQ = String.fromCharCode(39)

  it('DENIES at(1) with a double-quoted timespec', () => {
    const line = AT + ' ' + DQ + 'now + 5 minutes' + DQ
    expect(selfPaceDecision('Bash', { command: heredoc(line) }).deny).toBe(true)
  })

  it('DENIES at(1) with a single-quoted timespec', () => {
    const line = AT + ' ' + SQ + 'now + 5 minutes' + SQ
    expect(selfPaceDecision('Bash', { command: heredoc(line) }).deny).toBe(true)
  })

  it('DENIES at(1) when the BINARY carries the quotes, not the timespec', () => {
    for (const line of [DQ + AT + DQ + ' now + 5 minutes', AT + DQ + DQ + ' now + 5 minutes']) {
      expect(selfPaceDecision('Bash', { command: heredoc(line) }).deny, line).toBe(true)
    }
  })

  it('DENIES batch(1) with a quoted flag and with a quoted binary', () => {
    for (const line of [BATCH + ' ' + DQ + '-f' + DQ + ' job.sh', DQ + BATCH + DQ]) {
      expect(selfPaceDecision('Bash', { command: heredoc(line) }).deny, line).toBe(true)
    }
  })

  it('DENIES launchctl with a quoted subcommand -- the TRAILING-quote case', () => {
    // A leading-only tolerance passes this one: the subcommand alternative closes on a word
    // boundary, which the closing quote is not. This is the test that pins both sides.
    for (const sub of ['submit', 'load', 'bootstrap', 'kickstart', 'start', 'enable', 'bootout']) {
      const line = LC + ' ' + DQ + sub + DQ + ' -l self -- node respawn.mjs'
      expect(selfPaceDecision('Bash', { command: heredoc(line) }).deny, line).toBe(true)
    }
  })

  it('DENIES launchctl with a quoted subcommand followed by a path, not a flag', () => {
    const line = LC + ' ' + SQ + 'load' + SQ + ' ~/Library/LaunchAgents/self.plist'
    expect(selfPaceDecision('Bash', { command: heredoc(line) }).deny).toBe(true)
  })

  it('DENIES launchctl when the BINARY carries the quotes', () => {
    const line = DQ + LC + DQ + ' submit -l self -- node respawn.mjs'
    expect(selfPaceDecision('Bash', { command: heredoc(line) }).deny).toBe(true)
  })

  it('STILL ALLOWS a quoted pure READ -- tightening the write side must not deny a listing', () => {
    // `crontab "-l"` was a FALSE DENY before this change: the write guard already matched it while
    // the read exemption, quote-blind, did not. Both sides gained the same tolerance.
    for (const read of [
      LC + ' ' + DQ + 'list' + DQ,
      LC + ' ' + SQ + 'print' + SQ + ' system',
      CT + ' ' + DQ + '-l' + DQ,
    ]) {
      expect(selfPaceDecision('Bash', { command: heredoc(read) }).deny, read).toBe(false)
    }
  })

  it('does not start denying prose that merely quotes these words', () => {
    for (const prose of [
      'the ' + DQ + AT + DQ + ' keyword needs no timespec',
      AT + ' least 80% of the ' + DQ + 'entries' + DQ + ' were checked',
      BATCH + ' ' + DQ + 'size' + DQ + ' is 50 in the report',
    ]) {
      expect(selfPaceDecision('Bash', { command: heredoc(prose) }).deny, prose).toBe(false)
    }
  })

  it('keeps batch(1) denied on the end-of-segment shape (card 12f80902 must not regress)', () => {
    expect(selfPaceDecision('Bash', { command: heredoc('echo x | ' + BATCH) }).deny).toBe(true)
  })

  // Cybersec G2 (card 230e9884): when EVERY word of a segment is separately quoted, both the
  // masked and raw views trimmed to a single space -- `'crontab' '-r'` and `'at' 'now'` masked to
  // nothing but the gap between the two blanked runs, so the CMDWORD check's own
  // `pair.masked.trim() === ''` skip (meant for a single quoted word naming a nonexistent binary,
  // e.g. `'at now'`) also swallowed a genuine two-token invocation with every token quoted. The
  // fix only skips when at most ONE quoted run produced the empty view.
  it('DENIES a scheduler WRITE where every word is separately quoted (card 230e9884)', () => {
    for (const line of [
      DQ + CT + DQ + ' ' + DQ + '-r' + DQ,
      SQ + AT + SQ + ' ' + SQ + 'now' + SQ,
      DQ + LC + DQ + ' ' + DQ + 'load' + DQ + ' x.plist',
    ]) {
      expect(selfPaceDecision('Bash', { command: line }).deny, line).toBe(true)
    }
  })
  it('STILL ALLOWS a genuinely inert single quoted-word segment (no regression from the G2 fix)', () => {
    expect(selfPaceDecision('Bash', { command: SQ + AT + ' now' + SQ }).deny).toBe(false)
  })
  it('STILL ALLOWS a fully-quoted scheduler READ (every word quoted, still a pure read)', () => {
    for (const line of [DQ + CT + DQ + ' ' + DQ + '-l' + DQ, SQ + LC + SQ + ' ' + SQ + 'list' + SQ]) {
      expect(selfPaceDecision('Bash', { command: line }).deny, line).toBe(false)
    }
  })
})

import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// --- self-pace-gate: blocks the agent from scheduling its own future turns ---
describe('self-pace-gate gateDecision', () => {
  it('denies the ScheduleWakeup runtime tool', () => {
    expect(selfPaceDecision('ScheduleWakeup', { prompt: 'x' }).deny).toBe(true)
  })
  it('denies CronCreate / CronDelete / CronList / RemoteTrigger', () => {
    for (const t of ['CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger']) {
      expect(selfPaceDecision(t, {}).deny).toBe(true)
    }
  })
  it('denies tmux pane injection: send-keys / paste-buffer / run-shell / set-buffer', () => {
    for (const sub of ['send-keys -t agent-dev2 Enter', 'paste-buffer -t agent-dev2', 'run-shell "claude -p hi"', 'set-buffer "x"']) {
      expect(selfPaceDecision('Bash', { command: `tmux ${sub}` }).deny).toBe(true)
    }
  })
  it('denies tmux injection split across a newline (no [^newline] escape hatch)', () => {
    expect(selfPaceDecision('Bash', { command: 'tmux \\\n  send-keys -t agent-dev2 Enter' }).deny).toBe(true)
  })
  it('denies OS-level schedulers: crontab / at / launchctl', () => {
    expect(selfPaceDecision('Bash', { command: '(crontab -l; echo "*/5 * * * * claude -p poll") | crontab -' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'echo "claude -p go" | at now + 5 minutes' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'launchctl submit -l self -- node respawn.mjs' }).deny).toBe(true)
  })
  it('denies nohup/setsid self-respawn of claude', () => {
    expect(selfPaceDecision('Bash', { command: 'nohup claude -p "keep going" &' }).deny).toBe(true)
  })
  it('does NOT misfire "at" on a substring (netstat / cat)', () => {
    expect(selfPaceDecision('Bash', { command: 'cat file.txt && netstat -an' }).deny).toBe(false)
  })
  // Regression (2026-07-25, found by JogAsz): splitSegments splits on NEWLINES, so
  // every prose line of a multi-line commit body became its own "segment". A line
  // starting with the English words "at" / "batch" then looked like the at(1) /
  // batch(1) binaries and false-denied a plain `git commit`. The `-m "$(...)"`
  // form is deliberately NOT blanked by stripGitCommitMessages (a real command
  // substitution could hide there), so the body does reach the splitter.
  it('does NOT misfire on PROSE starting with "at"/"batch" in a heredoc commit body', () => {
    const body = (line: string) => `git commit -m "$(cat <<'EOF'\nfix(lib): parser tweak\n\n${line}\nEOF\n)"`
    for (const line of [
      'at least 80% of parsed entries must carry a date',
      'at most 3 retries before giving up',
      'at runtime the parser reads the header',
      'at the same time we clear the cache',
      'batch size is 50 by default',
    ]) {
      expect(selfPaceDecision('Bash', { command: body(line) }).deny).toBe(false)
    }
  })
  // Regression (card eae5d6fd, QA repro): the day-of-week and month TIMESPEC alternatives in
  // AT_INVOCATION had no trailing word boundary (unlike `next\b` right next to them), so any
  // English word starting with those 3 letters right after "at " false-denied -- QA's repro was
  // "at declared trivial difficulty" ("declared" starts with "dec"). Same bug class as the
  // >=80% collision above, one case per alternative so the whole list is covered, not just "dec".
  it('does NOT misfire "at" on prose starting with a day/month abbreviation (card eae5d6fd)', () => {
    // Bare commands, matching QA's own repro ("the sentence's direct invocation") -- "at" must sit
    // at a real segment start (^) for AT_INVOCATION to even be evaluated, which an echo-wrapped
    // quoted string does not give it.
    for (const cmd of [
      'at declared trivial difficulty', // "dec"
      'at monitor the deploy for errors', // "mon"
      'at tuesdays we usually deploy', // "tue"
      'at wednesday-shaped release cadence', // "wed"
      'at thursdays only', // "thu"
      'at friction points in the pipeline', // "fri"
      'at satisfies the contract', // "sat"
      'at sundries left in the cart', // "sun"
      'at january-scale traffic', // "jan"
      'at february release window', // "feb"
      'at marginal cost', // "mar"
      'at aprons for the kitchen', // "apr"
      'at junction boxes', // "jun"
      'at julienne the carrots', // "jul"
      'at augmented reality demo', // "aug"
      'at september-like traffic', // "sep"
      'at octopus card top-up', // "oct"
      'at november-shaped forecast', // "nov"
    ]) {
      expect(selfPaceDecision('Bash', { command: cmd }).deny).toBe(false)
    }
  })
  it('STILL denies a real at/batch submit (timespec, flag, redirect, bare batch)', () => {
    for (const cmd of [
      'at now + 1 minute',
      'at 14:00',
      'at tomorrow',
      'at -f /tmp/x.sh now',
      'batch',
      'batch < /tmp/x.sh',
      'echo hi ; at now + 5 min',
      '/usr/bin/at now',
      'at mon', // real day-of-week TIMESPEC, boundary must not swallow this too
      'at dec',
    ]) {
      expect(selfPaceDecision('Bash', { command: cmd }).deny).toBe(true)
    }
  })
  it('STILL denies a real command substitution hidden in a commit message', () => {
    expect(selfPaceDecision('Bash', { command: 'git commit -m "$(crontab -r)"' }).deny).toBe(true)
    // unquoted heredoc delimiter DOES expand -> must stay caught
    expect(selfPaceDecision('Bash', { command: 'git commit -m "$(cat <<EOF\nfix\n$(at now)\nEOF\n)"' }).deny).toBe(true)
  })
  it('denies a WRITE to the self-schedule store (redirect)', () => {
    expect(selfPaceDecision('Bash', { command: 'echo "{}" > ~/.claude/scheduled_tasks.json' }).deny).toBe(true)
  })
  it('ALLOWS a read-only inspection of the self-schedule store (F4)', () => {
    expect(selfPaceDecision('Bash', { command: 'cat ~/.claude/scheduled_tasks.json' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'grep poll ~/.claude/scheduled_tasks.json' }).deny).toBe(false)
  })
  // Cybersec M1 (card 4f3c0287 comment 29313) + RedHat's follow-up (comment, msg
  // 17335/17336): the Koteg-23b merge's own WRITE_INTENT_RX fix (excluding a
  // digit-prefixed redirect so `cat ref 2>/dev/null` reads as a read, not a write) first
  // tried a blanket `(?<!\d)` (allowed 1>/3>/9>, Cybersec M1), then a narrower
  // "fd-2-only" exclusion (?<!\b2) (STILL wrong: RedHat showed `2> <real file>`
  // truncates/creates the target in real bash even though nothing is written to it --
  // reproduced independently, a 19-byte fixture file becomes 0 bytes after `true 2>
  // file`). The only provably-safe shapes are an fd-to-fd dup (no file touched) or
  // `2>/dev/null` (stderr to the null sink); every other `>`, on any fd, is write intent.
  it('denies a WRITE to the self-schedule store via a digit-prefixed STDOUT redirect (M1)', () => {
    expect(selfPaceDecision('Bash', { command: 'echo "{}" 1> ~/.claude/scheduled_tasks.json' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'echo "{}" 1>~/.claude/scheduled_tasks.json' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'echo "{}" 3> ~/.claude/scheduled_tasks.json' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'echo "{}" 9> ~/.claude/scheduled_tasks.json' }).deny).toBe(true)
    // absolute $HOME and relative spellings, not only the tilde form
    expect(selfPaceDecision('Bash', { command: 'echo "{}" 1> $HOME/.claude/scheduled_tasks.json' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'echo "{}" 1> /home/agent/.claude/scheduled_tasks.json' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'cd /tmp && echo "{}" 1> ../home/agent/.claude/scheduled_tasks.json' }).deny).toBe(true)
  })
  it('denies "true/exec/heredoc through fd 2 (or any digit fd) into a REAL path" -- RedHat F1', () => {
    // RedHat's core finding: a redirect through fd 2 still opens the target for
    // writing (O_WRONLY|O_CREAT|O_TRUNC) even though nothing is ever WRITTEN to it --
    // "2> <real path>" is write intent, unlike "2>/dev/null".
    expect(selfPaceDecision('Bash', { command: 'true 2> ~/.claude/scheduled_tasks.json' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'true 3> ~/.claude/scheduled_tasks.json' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'exec 1> ~/.claude/scheduled_tasks.json' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: "cat 1> ~/.claude/scheduled_tasks.json <<'EOF'\nx\nEOF" }).deny).toBe(true)
  })
  it('ALLOWS only the provably-safe redirect shapes around the self-schedule store (F4 control)', () => {
    expect(selfPaceDecision('Bash', { command: 'cat ~/.claude/scheduled_tasks.json 2>/dev/null' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'cat ~/.claude/scheduled_tasks.json 2> /dev/null' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'cat ~/.claude/scheduled_tasks.json 2>&1 | grep name' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'grep name ~/.claude/scheduled_tasks.json 2>&1' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'cat ref 2>/dev/null' }).deny).toBe(false)
  })
  it('denies a WRITE method to the dashboard schedule API', () => {
    expect(selfPaceDecision('Bash', { command: 'curl -X POST http://localhost:3420/api/schedules -d @x.json' }).deny).toBe(true)
  })
  it('ALLOWS a GET read of the schedule API (F2 -- diagnostics, not self-pace)', () => {
    // -q first: without it curl reads ~/.curlrc, which can turn the GET into a
    // write, so the bare form is no longer provably a read
    expect(selfPaceDecision('Bash', { command: 'curl -q http://localhost:3420/api/schedules' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'curl -q http://localhost:3420/api/schedules/pending' }).deny).toBe(false)
  })
  it('denies writing the schedule store via the native Write/Edit tool (F5)', () => {
    expect(selfPaceDecision('Write', { file_path: '/home/agent/.claude/scheduled_tasks.json', content: '{}' }).deny).toBe(true)
    expect(selfPaceDecision('Edit', { file_path: '~/.claude/scheduled_tasks.json' }).deny).toBe(true)
  })
  // Directory-format scheduled-tasks store (card 1cd9fa94): the new store layout
  // uses ~/.claude/scheduled-tasks/<name>/task-config.json; SCHEDULE_STORE_RX must
  // cover both the legacy single-file form and any file under a named task subdir.
  it('denies WRITE to directory-format task-config.json (F5-dir)', () => {
    expect(selfPaceDecision('Write', {
      file_path: '/home/neon/.claude/scheduled-tasks/local-llm-worker-poke/task-config.json',
      content: '{}',
    }).deny).toBe(true)
    expect(selfPaceDecision('Edit', {
      file_path: '~/.claude/scheduled-tasks/agent-skill-drift-sync-heartbeat/task-config.json',
    }).deny).toBe(true)
  })
  it('denies WRITE to any file under a named task subdir -- fail-closed for unknown paths (F5-dir-fc)', () => {
    expect(selfPaceDecision('Write', {
      file_path: '/home/neon/.claude/scheduled-tasks/my-task/SKILL.md',
      content: '# skill',
    }).deny).toBe(true)
    expect(selfPaceDecision('NotebookEdit', {
      notebook_path: '/home/neon/.claude/scheduled-tasks/my-task/notebook.ipynb',
    }).deny).toBe(true)
  })
  it('denies a Bash WRITE to the directory-format store (redirect)', () => {
    expect(selfPaceDecision('Bash', {
      command: 'echo "{}" > ~/.claude/scheduled-tasks/local-llm-worker-poke/task-config.json',
    }).deny).toBe(true)
    expect(selfPaceDecision('Bash', {
      command: 'tee ~/.claude/scheduled-tasks/my-task/task-config.json <<EOF\n{}\nEOF',
    }).deny).toBe(true)
  })
  it('ALLOWS read-only inspection of the directory-format store (F4-dir)', () => {
    expect(selfPaceDecision('Bash', {
      command: 'cat ~/.claude/scheduled-tasks/local-llm-worker-poke/task-config.json',
    }).deny).toBe(false)
    expect(selfPaceDecision('Bash', {
      command: 'grep schedule ~/.claude/scheduled-tasks/my-task/task-config.json',
    }).deny).toBe(false)
  })
  it('ALLOWS unrelated paths that happen to contain "scheduled" (no false-positive)', () => {
    expect(selfPaceDecision('Write', {
      file_path: '/home/agent/project/scheduled-reports/q1/report.json',
      content: '{}',
    }).deny).toBe(false)
  })
  it('denies a shell-driven /loop', () => {
    expect(selfPaceDecision('Bash', { command: 'claude /loop "keep polling"' }).deny).toBe(true)
  })
  // Two forms the slash-command-position match regressed on (upstream review,
  // 2026-07-27): both EXECUTE `claude /loop` in bash but the char before `/loop`
  // was `\` / end-of-`$IFS`, not in the [\s'"] class. Fixed by normalising the
  // segment (resolve `\X`->`X`, `$IFS`->space) before the pattern runs.
  it('denies a /loop hidden by a backslash-escaped slash (claude \\/loop)', () => {
    expect(selfPaceDecision('Bash', { command: 'claude \\/loop "keep polling"' }).deny).toBe(true)
  })
  it('denies a /loop hidden by $IFS word-splitting (claude$IFS/loop)', () => {
    expect(selfPaceDecision('Bash', { command: 'claude$IFS/loop 5m' }).deny).toBe(true)
  })
  it('denies the /lo\\op mid-token backslash form (side effect of the same fix)', () => {
    expect(selfPaceDecision('Bash', { command: 'claude /lo\\op' }).deny).toBe(true)
  })
  it('ALLOWS reading a memory path with a loop- prefix (normalisation keeps prose through)', () => {
    // `.claude` matches \bclaude\b and the name starts `loop-`, but `/loop` is not
    // in slash-command position (a `-` follows), so it must still pass.
    expect(selfPaceDecision('Bash', { command: 'cat ~/.claude/memory/loop-stop-vs-truncation.md' }).deny).toBe(false)
  })
  it('ALLOWS a normal Bash command', () => {
    expect(selfPaceDecision('Bash', { command: 'git status && ls -la' }).deny).toBe(false)
  })
  it('ALLOWS a legitimate inter-agent message (not self-schedule)', () => {
    expect(selfPaceDecision('Bash', { command: 'curl -X POST http://localhost:3420/api/messages -d \'{"to":"dev4"}\'' }).deny).toBe(false)
  })
  it('ALLOWS read-only tools', () => {
    expect(selfPaceDecision('Read', {}).deny).toBe(false)
    expect(selfPaceDecision('Grep', {}).deny).toBe(false)
  })
})

// --- stripDataPayloads: a curl -d/--data body is DATA sent over the wire, never
// a shell invocation, so a trigger token INSIDE the payload must not false-deny a
// legit dispatch. Only provably-literal payloads are blanked; a payload that can
// command-substitute ($(...)/backtick) is kept so a real substitution still trips. ---
describe('self-pace-gate stripHeredocBodies (quoted vs unquoted marker)', () => {
  // A heredoc body is data -- unless the shell will expand it. A quoted marker
  // is literal, an unquoted one is not, and blanking an unquoted body would
  // hide a live command substitution from the scheduler patterns. Reported on
  // PR #770; the gate-level assertion for the same hole lives above.
  const PROSE = 'at the same time we fixed the parser'

  it('blanks a QUOTED heredoc body (the false positive this strip exists for)', () => {
    const cmd = `git commit -F - <<'EOF'\n${PROSE}\nEOF`
    expect(stripHeredocBodies(cmd)).not.toContain(PROSE)
  })

  it('blanks a double-quoted marker too', () => {
    const cmd = `git commit -F - <<"EOF"\n${PROSE}\nEOF`
    expect(stripHeredocBodies(cmd)).not.toContain(PROSE)
  })

  it('blanks an UNQUOTED body that has nothing to expand', () => {
    const cmd = `git commit -F - <<EOF\n${PROSE}\nEOF`
    expect(stripHeredocBodies(cmd)).not.toContain(PROSE)
  })

  it('KEEPS an unquoted body containing $( ) -- the shell would run it', () => {
    const cmd = 'git commit -m "$(cat <<EOF\nfix\n$(at now)\nEOF\n)"'
    expect(stripHeredocBodies(cmd)).toContain('$(at now)')
  })

  it('KEEPS an unquoted body containing a backtick', () => {
    const cmd = 'git commit -F - <<EOF\nfix `at now`\nEOF'
    expect(stripHeredocBodies(cmd)).toContain('`at now`')
  })

  it('still blanks a QUOTED body that merely mentions $( ) as text', () => {
    // Quoted marker: the shell does not expand, so the text is data even when
    // it looks like a substitution.
    const cmd = "git commit -F - <<'EOF'\nwe replaced $(at now) with cron\nEOF"
    expect(stripHeredocBodies(cmd)).not.toContain('$(at now)')
  })

  it('the <<- variant follows the same rule', () => {
    expect(stripHeredocBodies(`git commit -F - <<-'EOF'\n\t${PROSE}\n\tEOF`)).not.toContain(PROSE)
    expect(stripHeredocBodies('git commit -F - <<-EOF\n\t$(at now)\n\tEOF')).toContain('$(at now)')
  })

  // PR #770 review (Szotasz): a QUOTED body is literal to the SHELL, but an
  // interpreter/remote-executor that OWNS the redirect runs it -- blanking would
  // hide a live scheduler command. Keep the body visible for those owners.
  const RUNS = 'crontab -r; at now'

  it('KEEPS a quoted heredoc body owned by bash (it executes the body)', () => {
    expect(stripHeredocBodies(`bash <<'EOF'\n${RUNS}\nEOF`)).toContain(RUNS)
  })

  it('KEEPS a quoted heredoc body owned by sh / bash -s', () => {
    expect(stripHeredocBodies(`sh <<"EOF"\n${RUNS}\nEOF`)).toContain(RUNS)
    expect(stripHeredocBodies(`bash -s <<'EOF'\n${RUNS}\nEOF`)).toContain(RUNS)
  })

  it('KEEPS a quoted heredoc body owned by ssh / python / docker exec', () => {
    expect(stripHeredocBodies(`ssh box <<'EOF'\n${RUNS}\nEOF`)).toContain(RUNS)
    expect(stripHeredocBodies(`python3 - <<'EOF'\n${RUNS}\nEOF`)).toContain(RUNS)
    expect(stripHeredocBodies(`docker exec c bash <<'EOF'\n${RUNS}\nEOF`)).toContain(RUNS)
  })

  it('sees through a sudo/env prefix to the interpreter owner', () => {
    expect(stripHeredocBodies(`sudo bash <<'EOF'\n${RUNS}\nEOF`)).toContain(RUNS)
  })

  it('still blanks when a non-interpreter (git/tee) owns the redirect', () => {
    expect(stripHeredocBodies(`git commit -F - <<'EOF'\n${RUNS}\nEOF`)).not.toContain(RUNS)
    expect(stripHeredocBodies(`tee f <<'EOF'\n${RUNS}\nEOF`)).not.toContain(RUNS)
  })
})

describe('self-pace-gate stripProseArguments (scoped to gh/git/glab)', () => {
  // PR #770 review (Szotasz): the prose-flag blanking is for a PR/issue body or
  // release note, so it must be scoped to gh/git/glab. A short flag means
  // something else to other tools, and blanking it there hides real data.
  it('blanks a prose flag on gh', () => {
    expect(stripProseArguments("gh pr create --body 'runs at midnight, cron style'"))
      .not.toContain('midnight')
  })

  it('leaves a same-named flag on an unrelated tool alone', () => {
    // tar -t is "list", cut -b is "bytes" -- not prose, must not be blanked.
    const tar = "tar -t 'archive at now.tar'"
    expect(stripProseArguments(tar)).toBe(tar)
    const cut = "cut -b '1-3 at now'"
    expect(stripProseArguments(cut)).toBe(cut)
  })
})

describe('self-pace-gate stripDataPayloads (data-payload false-positive guard)', () => {
  it('blanks a single-quoted -d payload but keeps the flag', () => {
    expect(stripDataPayloads(`curl -d '{"x":"/api/schedules"}' u`)).toBe(`curl -d '' u`)
  })
  it('blanks a double-quoted -d payload without substitution', () => {
    expect(stripDataPayloads(`curl -d "{tmux send-keys}" u`)).toBe(`curl -d "" u`)
  })
  it("blanks an ANSI-C $'...' payload", () => {
    expect(stripDataPayloads(`curl -d $'{"a":"/loop"}' u`)).toBe(`curl -d '' u`)
  })
  it('KEEPS a payload that can command-substitute ($(...))', () => {
    const cmd = `curl -d "$(crontab -r)" u`
    expect(stripDataPayloads(cmd)).toBe(cmd)
  })
  it('KEEPS a payload with a backtick substitution', () => {
    const cmd = 'curl -d "`crontab -r`" u'
    expect(stripDataPayloads(cmd)).toBe(cmd)
  })
  it('handles --data / --data-raw / --data-binary / --data-urlencode long forms', () => {
    for (const flag of ['--data', '--data-raw', '--data-binary', '--data-urlencode']) {
      expect(stripDataPayloads(`curl ${flag} '/api/schedules' u`)).toBe(`curl ${flag} '' u`)
    }
  })
  it('supports the --data=VALUE equals form', () => {
    expect(stripDataPayloads(`curl --data='{"/loop":1}' u`)).toBe(`curl --data='' u`)
  })
  it('leaves URL/method args outside the payload untouched', () => {
    expect(stripDataPayloads(`curl -X POST /api/schedules -d '{}'`)).toBe(`curl -X POST /api/schedules -d ''`)
  })
  it('is a no-op when there is no -d/--data flag', () => {
    expect(stripDataPayloads('git status && ls -la')).toBe('git status && ls -la')
  })
  it('matches bash single-quote parsing: backslash is literal, first quote closes', () => {
    // bash: the -d value is `x\`; a C-style escape regex would scan PAST the real
    // closing quote and blank the out-of-band `; crontab -r`.
    expect(stripDataPayloads(`curl -d 'x\\' ; crontab -r`)).toBe(`curl -d '' ; crontab -r`)
  })
})

// --- integration: the payload-blanking must NOT weaken real WRITE/substitution
// detection; only the false-deny on a legit dispatch body is removed ---
describe('self-pace-gate: data-payload guard does not weaken real detection', () => {
  it('ALLOWS a dispatch whose JSON body merely MENTIONS /api/schedules', () => {
    expect(selfPaceDecision('Bash', { command: `curl -X POST http://localhost:3420/api/messages -d '{"to":"dev4","content":"please read the /api/schedules docs"}'` }).deny).toBe(false)
  })
  it('ALLOWS a dispatch body mentioning tmux send-keys / scheduled_tasks.json / /loop as text', () => {
    expect(selfPaceDecision('Bash', { command: `curl -X POST http://localhost:3420/api/messages -d '{"to":"dev3","content":"the tmux send-keys path writes scheduled_tasks.json on /loop"}'` }).deny).toBe(false)
  })
  it('STILL denies a real WRITE to /api/schedules (URL/method live outside the payload)', () => {
    expect(selfPaceDecision('Bash', { command: `curl -X POST http://localhost:3420/api/schedules -d '{"schedule":"*/5 * * * *"}'` }).deny).toBe(true)
  })
  it('STILL denies a command-substitution payload ($(...) is kept, not blanked)', () => {
    expect(selfPaceDecision('Bash', { command: `curl -d "$(crontab -r)" http://x` }).deny).toBe(true)
  })
  it('STILL denies a blocked binary outside the payload after a separator', () => {
    expect(selfPaceDecision('Bash', { command: `curl -d '{}' http://x ; crontab -r` }).deny).toBe(true)
  })
  it('STILL denies a self-pace after a bash single-quote close (backslash-literal parity)', () => {
    // regression for the C-vs-bash single-quote desync: the -d value is `x\`, then
    // the real `; <blocked>` executes -- must still deny for every self-pace route.
    for (const tail of ['crontab -r', "tmux send-keys -t s 'go' Enter", 'curl -X POST http://h/api/schedules', 'claude /loop 5m foo']) {
      expect(selfPaceDecision('Bash', { command: `curl -d 'x\\' ; ${tail} ; echo 'z'` }).deny).toBe(true)
    }
  })
})

// --- compound-command false-positives: a token in one segment must NOT trip a
// check anchored in another (per-segment matching -- round-2 hardening) ---
describe('self-pace-gate compound-command false-positives', () => {
  it('ALLOWS a store read followed by an unrelated cp/mv in another segment', () => {
    expect(selfPaceDecision('Bash', { command: 'cat ~/.claude/scheduled_tasks.json && cp other.txt backup.txt' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'grep poll scheduled_tasks.json; mv a.log b.log' }).deny).toBe(false)
  })
  it('ALLOWS a schedule-API GET with an unrelated -d flag in another segment', () => {
    expect(selfPaceDecision('Bash', { command: 'curl -q http://localhost:3420/api/schedules && date -d yesterday' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'curl -q http://localhost:3420/api/schedules | grep -d' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'ls -d */ && curl -q http://localhost:3420/api/schedules' }).deny).toBe(false)
  })
  it('ALLOWS "batch"/"crontab" as a word in a script name or commit message', () => {
    expect(selfPaceDecision('Bash', { command: 'npm run batch:migrate' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'git commit -m "add batch endpoint + crontab docs"' }).deny).toBe(false)
  })
  it('ALLOWS a legit tmux read with the injected word merely mentioned elsewhere', () => {
    expect(selfPaceDecision('Bash', { command: 'tmux list-sessions && echo "send-keys docs"' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'tmux ls && grep send-keys notes.md' }).deny).toBe(false)
  })
  it('STILL denies the real binary when it IS the command in a segment', () => {
    expect(selfPaceDecision('Bash', { command: 'echo "claude -p go" | at now + 5 minutes' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'ls; tmux send-keys -t agent-dev2 Enter' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'echo cmd | batch' }).deny).toBe(true)
  })
  it('ALLOWS at/batch as a shell variable assignment, not the binary', () => {
    expect(selfPaceDecision('Bash', { command: 'at=$(git rev-parse HEAD); echo $at' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'start=1; batch=2; end=3' }).deny).toBe(false)
  })
  it('ALLOWS read-listing of schedulers (crontab -l / launchctl list / atq)', () => {
    expect(selfPaceDecision('Bash', { command: 'crontab -l' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'crontab -l | grep claude' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'launchctl list | grep agent' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'atq' }).deny).toBe(false)
  })
  it('STILL denies scheduler WRITE forms (crontab - / crontab -r / launchctl submit)', () => {
    expect(selfPaceDecision('Bash', { command: '(crontab -l; echo job) | crontab -' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'crontab -r' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'launchctl submit -l self -- node x.mjs' }).deny).toBe(true)
  })
  // Backend's own finding (msg 19221, card 40704cb1): a QUOTED read flag/subcommand was denied even
  // though SCHEDULER_READ_RX is explicitly quote-tolerant (card 4fa31f31). maskInertLiterals blanks
  // a quoted argument to spaces -- quotes included -- BEFORE the read-exemption regex ever saw it,
  // so `crontab "-l"` left only bare `crontab` on the masked text, which the WRITE check (no shape
  // guard on the crontab branch) still matched, while the READ check had nothing left to match.
  it('ALLOWS a QUOTED read flag/subcommand (crontab "-l" / launchctl "list")', () => {
    expect(selfPaceDecision('Bash', { command: 'crontab "-l"' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: "crontab '-l'" }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'launchctl "list"' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: "launchctl 'list'" }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: '"crontab" -l' }).deny).toBe(false)
  })
  it('STILL denies a QUOTED scheduler WRITE form (the raw-text exemption fallback does not loosen this)', () => {
    expect(selfPaceDecision('Bash', { command: 'crontab "-r"' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: "crontab '-r'" }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'launchctl "submit" -l self' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: "launchctl 'load' x.plist" }).deny).toBe(true)
  })
  // Measured false positive, 2026-07-26 (found by Hacker): the heartbeats ORDER every
  // agent to report `launchctl list | grep com.jarvis.channels` output, so a launchd
  // job LABEL shows up in prose constantly. splitSegments splits on `;`, which put
  // `launchctl <label>` at a segment start and it read as a real invocation -- a status
  // report was denied. Same shape as the at/batch "at least" case, different binary.
  // The narrowing requires the SHAPE of an invocation (a bare lowercase subcommand
  // word), not a denylist of subcommands.
  it('does NOT deny a launchd job LABEL appearing in prose (no subcommand follows)', () => {
    expect(selfPaceDecision('Bash', { command: 'echo hello; launchctl com.jarvis.channels PID 555' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'launchctl com.marveen.dashboard is up' }).deny).toBe(false)
  })
  it('STILL denies every real launchctl form after that narrowing', () => {
    // a subcommand word follows -> real invocation
    expect(selfPaceDecision('Bash', { command: 'launchctl load ~/Library/LaunchAgents/x.plist' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'launchctl kickstart -k gui/501/com.jarvis.channels' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'launchctl bootout gui/501' }).deny).toBe(true)
    // a bare `launchctl` is interactive, and a flag form is an invocation: both stay denied
    expect(selfPaceDecision('Bash', { command: 'launchctl' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'launchctl -h' }).deny).toBe(true)
  })
  it('denies scheduler WRITE behind a sudo/env/PATH/absolute-path wrapper', () => {
    expect(selfPaceDecision('Bash', { command: 'sudo crontab -r' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: '/usr/bin/at now + 1 minute' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'PATH=/usr/bin crontab cronfile' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'env crontab -' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'sudo launchctl bootstrap gui/501 x.plist' }).deny).toBe(true)
  })
  it('ALLOWS a wrapped scheduler READ, and a crontab-prefixed script name', () => {
    expect(selfPaceDecision('Bash', { command: 'sudo crontab -l' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: './scripts/crontab-helper.sh status' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'at=$(date +%s); echo $at' }).deny).toBe(false)
  })
})

// --- scaffold wiring: main-exempt + idempotent ---
describe.skipIf(REPO_UNDER_TMP)('governance gate scaffold wiring', () => {
  it('applies to sub-agents, exempts the main agent', () => {
    expect(agentGetsGovernanceGates('dev2')).toBe(true)
    expect(agentGetsGovernanceGates('dev3')).toBe(true)
    expect(agentGetsGovernanceGates(MAIN_AGENT_ID)).toBe(false)
  })
  it('injectSelfPaceGate is idempotent (no duplicate on respawn)', () => {
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    injectSelfPaceGate(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.filter((e) => JSON.stringify(e).includes('self-pace-gate.mjs')).length).toBe(1)
  })
  it('the hook MATCHER fires on native file tools too (not just Bash)', () => {
    // Regression guard: gateDecision blocks a Write/Edit to the schedule store,
    // but that branch only runs in production if the hook MATCHER covers those
    // tool names. A Bash-only matcher would leave the native-file route open
    // while the unit test (which calls gateDecision directly) still passes.
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as Array<{ matcher: string }>)
    const entry = pre.find((e) => JSON.stringify(e).includes('self-pace-gate.mjs'))
    const re = new RegExp(`^(?:${entry!.matcher})$`)
    for (const t of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'ScheduleWakeup', 'CronCreate']) {
      expect(re.test(t)).toBe(true)
    }
    expect(re.test('Read')).toBe(false)
  })
  it('self-pace gate survives a respawn re-run, and NO operator-gate is wired', () => {
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    injectSelfPaceGate(s) // respawn re-run
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.some((e) => JSON.stringify(e).includes('self-pace-gate.mjs'))).toBe(true)
    // operator-confirmation-gate is intentionally NOT wired: merge/deploy is
    // operator-authorized autonomously; the self-decide vector is covered above.
    expect(pre.some((e) => JSON.stringify(e).includes('operator-confirmation-gate.mjs'))).toBe(false)
  })
})


// --- stripGitCommitMessages: a `git commit -m` message is PROSE, never a shell
// invocation, so a trigger token inside it must not false-deny (2026-07-13 DrCode
// report: long commit blocked, short passed). Same literal-only quote handling as
// stripDataPayloads; a $()/backtick double-quoted message is kept so a REAL
// substitution stays gated. ---
describe('self-pace-gate stripGitCommitMessages (commit-message false-positive guard)', () => {
  it('blanks a single-quoted commit message', () => {
    expect(stripGitCommitMessages(`git commit -m 'batch queue; at offset'`)).toBe(`git commit -m ''`)
  })
  it('blanks a double-quoted commit message with trigger words', () => {
    expect(stripGitCommitMessages(`git commit -m "orchestration: tmux send-keys nem"`)).toBe(`git commit -m ""`)
  })
  it('keeps a $()-substituting double-quoted message intact (still gated downstream)', () => {
    const cmd = `git commit -m "$(crontab -r)"`
    expect(stripGitCommitMessages(cmd)).toBe(cmd)
  })
  it('leaves non-git -m flags untouched', () => {
    const cmd = `mkdir -m 755 dir`
    expect(stripGitCommitMessages(cmd)).toBe(cmd)
  })
  it('gateDecision: legit commit with trigger words in the message is ALLOWED', () => {
    expect(selfPaceDecision('Bash', { command: `git commit -m "ETA; at offset; batch observe"` }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: `git commit -m "gui token-auth /api/schedules read-only"` }).deny).toBe(false)
  })
  it('gateDecision: a REAL self-pace after the commit (outside the message) is still DENIED', () => {
    expect(selfPaceDecision('Bash', { command: `git commit -m "ok" ; crontab -r` }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: `git commit -m "$(crontab -r)"` }).deny).toBe(true)
  })
})

// --- stripHeredocDataPayloads: the fleet builds long/accented JSON with
// `curl -d @- <<'EOF' ... EOF` to dodge curl's own inline-quoting traps (card
// 4638c14c, incidents msg 8746/8796/8881 -- three denials in one day, all mid
// security-report). Same principle as stripDataPayloads (a payload is data, never
// an invocation), narrower syntax match, PER-HEREDOC scoped: only a heredoc curl
// itself reads via -d @- is blanked; a heredoc feeding an INTERPRETER (python3/
// bash/sh) that happens to be piped toward a LATER curl -d @- stays fully exposed
// to the scan, because that heredoc is CODE, not HTTP-body bytes. ---
describe('self-pace-gate stripHeredocDataPayloads (heredoc data-payload false-positive guard)', () => {
  it('blanks a heredoc body feeding `curl -d @-` (quoted tag)', () => {
    const out = stripHeredocDataPayloads(
      `curl -X POST u -d @- <<'EOF'\n{"content":"tmux send-keys demo"}\nEOF\n`,
    )
    expect(out).not.toContain('tmux send-keys')
    expect(out).toContain(`-d @- <<'EOF'`)
    expect(out).toContain('EOF\n') // terminator kept
  })

  it('blanks a heredoc body feeding `--data-binary @-` (unquoted tag, no substitution)', () => {
    const out = stripHeredocDataPayloads(
      'curl -X POST u --data-binary @- <<EOF\n{"content":"tmux send-keys demo"}\nEOF\n',
    )
    expect(out).not.toContain('tmux send-keys')
  })

  it('is a no-op when there is no `-d @-`/`--data* @-` flag at all', () => {
    const cmd = `python3 - <<'PY'\nprint('tmux send-keys')\nPY\n`
    expect(stripHeredocDataPayloads(cmd)).toBe(cmd)
  })

  // THE SAFETY BOUNDARY: a heredoc feeding python3 (CODE), later piped to a curl
  // that DOES use -d @-, must NOT be blanked -- the flag lives in the command
  // string, but not on the SAME simple command as this heredoc's redirect.
  it('does NOT blank a heredoc feeding an INTERPRETER, even when -d @- appears LATER via a pipe', () => {
    const cmd = `python3 - <<'PY' | curl -X POST u -d @-\nimport subprocess\nsubprocess.run(['tmux','send-keys'])\nPY\n`
    expect(stripHeredocDataPayloads(cmd)).toBe(cmd) // fully unchanged -- still scannable
  })

  // CYBERSEC NO-GO on commit 3e5fe07 (card 4638c14c): the boundary span was checked
  // ONLY for the "-d @-" flag SHAPE, never for the simple command actually BEING
  // curl. `python3 - -d @- <<'PY'` reads as its OWN program regardless of the
  // "-d @-" tokens sitting unused in python3's argv -- but they matched the flag
  // regex and blanked a heredoc python3 genuinely EXECUTES, hiding a real
  // scheduling primitive from the unanchored scan (gateDecision returned deny:false
  // on a live payload proving it). MUST DENY.
  it('SECURITY REGRESSION (Cybersec 4638c14c): a decoy "-d @-" in a NON-curl command must not launder its heredoc', () => {
    const cmd = `python3 - -d @- <<'PY'\nimport subprocess\nsubprocess.run(['tmux', 'send-keys', '-t', 'some-agent-session', '/api/schedules POST', 'Enter'])\nPY\n`
    const out = stripHeredocDataPayloads(cmd)
    expect(out).toBe(cmd) // fully unchanged -- python3 is not curl, decoy flag ignored
    expect(selfPaceDecision('Bash', { command: cmd }).deny).toBe(true) // MUST DENY
  })

  it('CONTROL for the regression above: the SAME payload without the decoy flag was already denied', () => {
    const cmd = `python3 - <<'PY'\nimport subprocess\nsubprocess.run(['tmux', 'send-keys', '-t', 'some-agent-session', '/api/schedules POST', 'Enter'])\nPY\n`
    expect(selfPaceDecision('Bash', { command: cmd }).deny).toBe(true)
  })

  it('a genuinely wrapped curl (sudo/env/absolute path) still gets the exemption', () => {
    for (const lead of ['sudo curl', 'env curl', '/usr/bin/curl']) {
      const out = stripHeredocDataPayloads(`${lead} -X POST u -d @- <<'EOF'\n{"content":"tmux send-keys demo"}\nEOF\n`)
      expect(out).not.toContain('tmux send-keys')
    }
  })

  it('a decoy "-d @-" inside ANOTHER real binary (bash, not curl) is still fully scanned', () => {
    const cmd = `bash -d @- <<'X'\ntmux send-keys real-attack\nX\n`
    expect(stripHeredocDataPayloads(cmd)).toBe(cmd)
    expect(selfPaceDecision('Bash', { command: cmd }).deny).toBe(true)
  })

  it('does NOT blank a heredoc that PRECEDES an unrelated curl -d @- after a `;` boundary', () => {
    const cmd = `bash <<'X'\ntmux send-keys real-attack\nX\n; curl -d @- u <<'Y'\nfine\nY\n`
    const out = stripHeredocDataPayloads(cmd)
    expect(out).toContain('tmux send-keys real-attack') // NOT this one -- bash executes it
    expect(out).not.toContain('fine') // this one IS curl's own payload -- blanked
  })

  it('fail-closed: an UNQUOTED tag whose body can command-substitute is NOT blanked even for -d @-', () => {
    const cmd = 'curl -d @- <<EOF\n$(crontab -r) tmux send-keys\nEOF\n'
    expect(stripHeredocDataPayloads(cmd)).toBe(cmd)
  })

  it('a QUOTED tag with a literal $(...)-looking string IS blanked (bash never expands it)', () => {
    const out = stripHeredocDataPayloads("curl -d @- <<'EOF'\n$(literal) tmux send-keys\nEOF\n")
    expect(out).not.toContain('tmux send-keys')
  })

  // --- SECOND STDIN-DATA SHAPE: `git commit -F -` (card 0229c844) ---------------------------
  // Found the same way as the curl one and twice over: a commit message that DESCRIBED a
  // scheduling primitive was denied, while the identical prose passed once written to a file and
  // passed as `-F <file>`. Same reasoning as -d @-: git reads these bytes as a MESSAGE and never
  // executes them, so blanking removes no detection. The guards below are the load-bearing part.
  it('blanks a heredoc body feeding `git commit -F-` -- prose about a primitive is not a call', () => {
    const cmd = `git commit -F- <<'EOF'\nthis fix stops tmux send-keys prose from denying\nEOF\n`
    expect(stripHeredocDataPayloads(cmd)).not.toContain('tmux send-keys')
    expect(selfPaceDecision('Bash', { command: cmd }).deny).toBe(false)
  })

  it('covers the spaced and long-flag spellings git actually accepts', () => {
    for (const flag of ['-F -', '--file -', '--file=-']) {
      const cmd = `git commit ${flag} <<'EOF'\ntmux send-keys in prose\nEOF\n`
      expect(selfPaceDecision('Bash', { command: cmd }).deny, flag).toBe(false)
    }
  })

  it('SECURITY: a decoy "-F-" on a NON-git command launders nothing', () => {
    // The 4638c14c finding, re-run for this flag: python3 EXECUTES the body it is handed, and an
    // unused "-F-" sitting in its argv must not make that body invisible to the scan.
    const cmd = `python3 - -F- <<'PY'\nimport subprocess\nsubprocess.run(['tmux', 'send-keys', '-t', 'a', 'x', 'Enter'])\nPY\n`
    expect(stripHeredocDataPayloads(cmd)).toBe(cmd)
    expect(selfPaceDecision('Bash', { command: cmd }).deny).toBe(true)
  })

  it('SECURITY: `-F` on a git subcommand that does not take a message file is not exempt', () => {
    // `git grep -F -` is fixed-string matching, not a message. Without the subcommand check this
    // would have become a general "git ... -F -" exemption.
    const cmd = `git grep -F - <<'EOF'\ntmux send-keys demo\nEOF\n`
    expect(stripHeredocDataPayloads(cmd)).toBe(cmd)
    expect(selfPaceDecision('Bash', { command: cmd }).deny).toBe(true)
  })

  it('SECURITY: a real invocation AFTER the exempted heredoc is still denied', () => {
    // The exemption is scoped to the heredoc body, not to the command that contains it.
    const cmd = `git commit -F- <<'EOF'\nmsg\nEOF\ntmux send-keys -t agent-x hello Enter`
    expect(selfPaceDecision('Bash', { command: cmd }).deny).toBe(true)
  })

  it('SECURITY: fail-closed on an unquoted tag whose body can command-substitute', () => {
    const cmd = 'git commit -F- <<EOF\n$(tmux send-keys -t a x Enter)\nEOF\n'
    expect(stripHeredocDataPayloads(cmd)).toBe(cmd)
    expect(selfPaceDecision('Bash', { command: cmd }).deny).toBe(true)
  })

  // NOT part of this card's scope, corrected here after the author's own test caught it:
  // a BARE POSITIONAL argument (no -d/-m/heredoc flag at all) has never been exempted by
  // any stripping function, old or new -- stripDataPayloads/stripGitCommitMessages/
  // stripHeredocDataPayloads each target one SPECIFIC flag's own argument, not arbitrary
  // quoted text elsewhere on the line. This shape genuinely has no heredoc for
  // stripHeredocDataPayloads to touch, so it is correctly, unconditionally still denied.
  it('gateDecision: a bare quoted POSITIONAL argument (no recognized flag) is STILL DENIED -- out of scope, not a heredoc case', () => {
    expect(
      selfPaceDecision('Bash', {
        command:
          `python3 -c "import json,sys; print(json.dumps({'content':sys.argv[1]}))" ` +
          `'the tmux send-keys path writes scheduled_tasks.json on /loop' | ` +
          `curl -X POST http://localhost:3420/api/messages -d @-`,
      }).deny,
    ).toBe(true)
  })

  it('gateDecision: a heredoc-built curl report mentioning trigger words as prose is ALLOWED', () => {
    expect(
      selfPaceDecision('Bash', {
        command:
          `curl -X POST http://localhost:3420/api/messages -d @- <<'EOF'\n` +
          `{"to":"mikrob","content":"root cause: tmux send-keys writes scheduled_tasks.json on /loop"}\n` +
          `EOF\n`,
      }).deny,
    ).toBe(false)
  })

  it('gateDecision: a REAL tmux self-pace hidden in a python heredoc piped to curl -d @- is STILL DENIED', () => {
    expect(
      selfPaceDecision('Bash', {
        command:
          `python3 - <<'PY' | curl -X POST http://localhost:3420/api/messages -d @-\n` +
          `import subprocess\n` +
          `subprocess.run(['tmux', 'send-keys', '-t', 'self', 'go'])\n` +
          `PY\n`,
      }).deny,
    ).toBe(true)
  })

  it('gateDecision: STILL denies a real WRITE to /api/schedules sent via the heredoc idiom', () => {
    expect(
      selfPaceDecision('Bash', {
        command:
          `curl -X POST http://localhost:3420/api/schedules -d @- <<'EOF'\n{"schedule":"*/5 * * * *"}\nEOF\n`,
      }).deny,
    ).toBe(true)
  })
})

// --- backtick command substitution: the boundary anchor recognises `...` the
// same as $(...), so a scheduler binary inside a legacy backtick substitution is
// caught (was a documented pre-existing denylist gap: $() denied, backtick not).
describe('self-pace-gate backtick command-substitution boundary', () => {
  it('denies a bare backtick scheduler substitution', () => {
    expect(selfPaceDecision('Bash', { command: 'git status `crontab -r`' }).deny).toBe(true)
  })
  it('denies an assignment via backtick substitution', () => {
    expect(selfPaceDecision('Bash', { command: 'X=`crontab -r`' }).deny).toBe(true)
  })
  it('denies a backtick substitution after a commit message (message blanked, op remains)', () => {
    expect(selfPaceDecision('Bash', { command: 'git commit -m "a" `crontab -r`' }).deny).toBe(true)
  })
  it('denies a backtick launchctl load', () => {
    expect(selfPaceDecision('Bash', { command: 'echo `launchctl load x`' }).deny).toBe(true)
  })
  it('parity with $(): both substitution forms of the same op are denied', () => {
    expect(selfPaceDecision('Bash', { command: 'git status $(crontab -r)' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'git status `crontab -r`' }).deny).toBe(true)
  })
  it('does not over-fire: a backtick substitution of a NON-scheduler binary is allowed', () => {
    expect(selfPaceDecision('Bash', { command: 'echo `date`' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'FILES=`ls -1`' }).deny).toBe(false)
  })
  it('still allows a legit read-listing inside a substitution (crontab -l)', () => {
    expect(selfPaceDecision('Bash', { command: 'echo `crontab -l`' }).deny).toBe(false)
  })
})

// Always runs: a CI log must never be ambiguous about whether the tmp-sensitive suites above were
// armed or skipped (card 252e36d3 -- 13 phantom "failures" were once tracked as a real red baseline).
describe('tmp-checkout env gate (always runs)', () => {
  it('reports whether the hook-registration suites in this file were armed or skipped', () => {
    if (REPO_UNDER_TMP) {
      console.log(`[${'governance-gates.test.ts'}] SKIPPED hook-registration suites -- ${TMP_SKIP_REASON}`)
    } else {
      console.log(`[${'governance-gates.test.ts'}] ARMED -- checkout is outside /tmp, hook-registration assertions ran.`)
    }
    expect(typeof REPO_UNDER_TMP).toBe('boolean')
  })
})

// --- inert quoted / heredoc text must not be able to fake a command position ---
//
// Five denials in one morning (2026-08-05, three jayce + two taric), all one
// cause: an inter-agent message quoting the grep pattern
//   Minta: stop.sh | launchctl | com.janna.dashboard
// The bars split it, the middle piece trimmed to the bare word `launchctl`, and
// the anchored scheduler check read that as a real interactive invocation. The
// messages never went out, and from outside a denial looks like an agent that
// simply stayed silent.
//
// What made it a design bug rather than a bad pattern: the SAME text passed as
// `curl -d '<json>'` (payload blanked) and was denied from a python heredoc
// (nothing to blank). The send route had become a security decision.
const BAR = String.fromCharCode(124)
const Q = String.fromCharCode(39)
const heredoc = (body: string) => `python3 - <<${Q}PY${Q}\n${body}\nPY`
const PATTERN = `Minta: stop.sh ${BAR} launchctl ${BAR} com.janna.dashboard`

describe('self-pace-gate: quoted prose cannot fake a command position', () => {
  it('allows the measured pattern inside a heredoc body', () => {
    expect(selfPaceDecision('Bash', { command: heredoc(`t = "${PATTERN}"`) }).deny).toBe(false)
  })
  it('allows it in single quotes, double quotes, and a python triple-quote', () => {
    expect(selfPaceDecision('Bash', { command: `echo ${Q}${PATTERN}${Q}` }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: `echo "${PATTERN}"` }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: heredoc(`t = """${PATTERN}"""`) }).deny).toBe(false)
  })
  it('allows a bar-separated pattern naming crontab too', () => {
    // This is the case that proved masking is the right primitive: with only a
    // quote-aware SPLITTER this stayed denied, because SCHEDULER_RX carries its
    // own boundary anchor and re-found a command position inside the segment.
    expect(selfPaceDecision('Bash', { command: `echo ${Q}foo ${BAR} crontab ${BAR} bar${Q}` }).deny)
      .toBe(false)
  })

  // --- and the whole point: none of the above may cost real detection ---
  it('still denies a real scheduler call after a genuine separator', () => {
    expect(selfPaceDecision('Bash', { command: `echo ${Q}harmless${Q} ; crontab -r` }).deny).toBe(true)
  })
  it('still denies tmux injection hidden inside a heredoc body', () => {
    // The unanchored patterns deliberately keep scanning the RAW segments.
    // Handing them masked text would have removed the detection of this gate's
    // founding incident vector -- measured before the change, not assumed.
    expect(selfPaceDecision('Bash', {
      command: heredoc(`subprocess.run([${Q}tmux${Q},${Q}send-keys${Q},${Q}-t${Q},${Q}x${Q}])`),
    }).deny).toBe(true)
  })
  it('fails CLOSED on an unterminated quote', () => {
    // Unresolvable quoting must mean "scan more", never "scan less".
    expect(selfPaceDecision('Bash', { command: `echo ${Q}oops ; crontab -r` }).deny).toBe(true)
  })
  it('fails CLOSED when a double-quoted region can command-substitute', () => {
    expect(selfPaceDecision('Bash', { command: 'echo "$(date)" ; crontab -r' }).deny).toBe(true)
  })
  it('fails CLOSED on an UNQUOTED heredoc tag whose body substitutes', () => {
    // <<PY (no quotes) expands the body, so its contents are not inert.
    expect(selfPaceDecision('Bash', { command: 'cat <<PY\n$(crontab -r)\nPY' }).deny).toBe(true)
  })
})

// --- scheduler binaries hidden in a heredoc body (card 46c4ad4a, Cybered's finding on 4638c14c) ---
// --- the dashboard schedule surface, for EVERY client ---
//
// Measured on a live install: a sub-agent created four schedules with a python
// urllib POST, 4x HTTP 200. The old check only knew curl's spelling of a write
// (-X POST / -d / --data). The fix is not a longer list of spellings: any
// command that references the schedule API or its store is denied unless every
// segment carrying the reference is provably unable to write it.
// A disposable project root with the token files form (a) may read in a header:
// the shared <root>/store/.dashboard-token and per-agent <root>/agents/<name>/
// .dashboard-token files (agent-c's carries a CR/LF request-smuggling payload).
const GATE_ROOT = mkdtempSync(join(tmpdir(), 'selfpace-root-'))
mkdirSync(join(GATE_ROOT, 'store'), { recursive: true })
for (const a of ['agent-a', 'agent-b', 'agent-c']) mkdirSync(join(GATE_ROOT, 'agents', a), { recursive: true })
writeFileSync(join(GATE_ROOT, 'store', '.dashboard-token'), 'example-token_0123.~+/=\n')
writeFileSync(join(GATE_ROOT, 'agents', 'agent-a', '.dashboard-token'), 'agent-a-token\n')
writeFileSync(join(GATE_ROOT, 'agents', 'agent-b', '.dashboard-token'), 'agent-b-token\n')
writeFileSync(join(GATE_ROOT, 'agents', 'agent-c', '.dashboard-token'), 'x\r\n\r\nPOST /api/schedules HTTP/1.1\r\nHost: localhost\r\n')
afterAll(() => rmSync(GATE_ROOT, { recursive: true, force: true }))
const GATE_OPTS = { projectRoot: GATE_ROOT, selfAgent: 'agent-a' }
const deny = (command: string, opts: Record<string, unknown> = GATE_OPTS) => selfPaceDecision('Bash', { command }, opts).deny
// the shared token file, absolute: the file form (a) accepts in a header
const TOKEN_PATH = join(GATE_ROOT, 'store', '.dashboard-token')
const TOKEN_H = `-H "Authorization: Bearer $(cat ${TOKEN_PATH})"`
const tokenHeader = (path: string) => `-H "Authorization: Bearer $(cat ${path})"`

describe('self-pace-gate: schedule API writes through any HTTP client', () => {
  it('denies the measured python urllib POST (heredoc form)', () => {
    expect(deny([
      `python3 - <<${Q}PY${Q}`,
      'import json, urllib.request',
      `tok = open(${Q}/srv/app/store/.dashboard-token${Q}).read().strip()`,
      `req = urllib.request.Request(${Q}http://localhost:3420/api/schedules${Q}, data=json.dumps({${Q}name${Q}: ${Q}x${Q}, ${Q}schedule${Q}: ${Q}0 9 * * *${Q}}).encode(), headers={${Q}Authorization${Q}: ${Q}Bearer ${Q} + tok}, method=${Q}POST${Q})`,
      'print(urllib.request.urlopen(req).status)',
      'PY',
    ].join('\n'))).toBe(true)
  })
  it('denies python requests', () => {
    expect(deny(`python3 -c "import requests; requests.post('http://127.0.0.1:3420/api/schedules', json={'name':'x'})"`)).toBe(true)
  })
  it('denies node fetch', () => {
    expect(deny(`node -e "fetch('http://[::1]:3420/api/schedules',{method:'POST',body:JSON.stringify({name:'x'})})"`)).toBe(true)
  })
  it('denies wget --post-data', () => {
    expect(deny(`wget -qO- --post-data='{"name":"x"}' http://0.0.0.0:3420/api/schedules`)).toBe(true)
  })
  it('denies httpie', () => {
    expect(deny(`http POST localhost:3420/api/schedules name=x schedule='*/5 * * * *'`)).toBe(true)
  })
  it('denies a variable host (the path is the reference, not the host)', () => {
    expect(deny(`python3 -c "import os,urllib.request as u; h=os.environ['DASH_HOST']; u.urlopen(u.Request(f'http://{h}/api/schedules', data=b'{}'))"`)).toBe(true)
    expect(deny(`curl -X POST "http://$HOST:$PORT/api/schedules" --data-binary @x.json`)).toBe(true)
  })
  it('denies perl, nc, bash -c, and a pipe into an interpreter', () => {
    expect(deny(`perl -MHTTP::Tiny -e 'HTTP::Tiny->new->post("http://localhost:3420/api/schedules")'`)).toBe(true)
    expect(deny(`printf 'POST /api/schedules HTTP/1.1\\r\\n\\r\\n' | nc localhost 3420`)).toBe(true)
    expect(deny(`bash -c "curl -X POST localhost:3420/api/schedules -d x"`)).toBe(true)
    expect(deny(`cat <<${Q}EOF${Q} | python3\nimport urllib.request as u\nu.urlopen(u.Request('http://localhost:3420/api/schedules', data=b'{}'))\nEOF`)).toBe(true)
  })
  it('denies spellings the shell or the interpreter resolves: quotes, concatenation, escapes, dot segments', () => {
    expect(deny(`python3 -c "import urllib.request as u; u.urlopen(u.Request('http://localhost:3420/api/' + 'schedules', data=b'{}'))"`)).toBe(true)
    expect(deny(`python3 -c "import urllib.request as u; u.urlopen(u.Request('http://localhost:3420/api/\\x73chedules', data=b'{}'))"`)).toBe(true)
    expect(deny(`node -e "fetch('http://localhost:3420/api/sch'+'edules',{method:'POST'})"`)).toBe(true)
    expect(deny(`curl -X POST http://localhost:3420/api/%2e/schedules -d x`)).toBe(true)
  })
  it('STILL denies a curl POST', () => {
    expect(deny(`curl -s -X POST http://localhost:3420/api/schedules ${TOKEN_H} -d '{"name":"x"}'`)).toBe(true)
  })
  it('ALLOWS the plain curl GET, with the token header, and with a pipe consumer', () => {
    expect(deny(`curl -q -s ${TOKEN_H} http://localhost:3420/api/schedules`)).toBe(false)
    expect(deny(`curl -q -s ${TOKEN_H} "http://localhost:$PORT/api/schedules/pending"`)).toBe(false)
    expect(deny(`curl -q -s ${TOKEN_H} http://localhost:3420/api/schedules | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"`)).toBe(false)
  })
  it('does NOT accept a "GET" that is not provably one', () => {
    // the scheme comes from a variable -> gopher:// would write raw bytes
    expect(deny(`curl -q -s "$D/api/schedules"`)).toBe(true)
    expect(deny(`curl -q -s gopher://localhost:3420/_POST%20/api/schedules`)).toBe(true)
    // unquoted substitution word-splits into -X POST -d ...
    expect(deny(`curl -q -s -H $(cat /tmp/args) http://localhost:3420/api/schedules`)).toBe(true)
    // a CR/LF header smuggles a second, pipelined request (curl sends it verbatim)
    expect(deny(`curl -q -s -H $'X: a\\r\\n\\r\\nPOST /api/schedules HTTP/1.1' http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -q -s -H "X: $V" http://localhost:3420/api/schedules`)).toBe(true)
    // the "payload" is really the URL: -H swallowed the -d
    expect(deny(`curl -X POST -H -d 'http://localhost:3420/api/schedules' --data x`)).toBe(true)
    // a separator INSIDE a quoted argv string is not a real command boundary
    expect(deny(`python3 -c 'import sys,urllib.request as u; u.urlopen(u.Request(sys.argv[1], data=b"{}"))' 'a;curl -s http://localhost:3420/api/schedules;b'`)).toBe(true)
  })
  it('ALLOWS the reference when it is only message data (curl -d body, heredoc @-, git -m, agent-msg.sh)', () => {
    expect(deny(`curl -s -X POST http://localhost:3420/api/messages ${TOKEN_H} --data-binary @- <<${Q}JSON${Q}\n{"from":"agent-a","to":"agent-b","content":"wanted POST /api/schedules"}\nJSON`)).toBe(false)
    expect(deny(`git commit -m "$(cat <<${Q}EOF${Q}\nfix: /api/schedules gate\n\nsee ~/.claude/scheduled-tasks\nEOF\n)"`)).toBe(false)
    expect(deny(`bash scripts/agent-msg.sh agent-a agent-b "cannot create /api/schedules entries"`)).toBe(false)
  })
  it('ALLOWS read-only file commands that mention the path', () => {
    expect(deny(`grep -rn "/api/schedules" src/web | head -20`)).toBe(false)
  })
})

// Card 0120d19a: upstream's own GET-allowlist (isPlainCurlGet/headerValueIsInert, above) accepts
// only the INLINE `-H "Authorization: Bearer $(cat <TOKEN>)"` form, verified via TOKEN_NONCE
// substitution, and rejects `-H @file`/`-H @-` outright (its own stated reason: it cannot verify
// what such a file/stdin contains). The fork's OWN token-in-argv-guard.test.ts forbids that exact
// inline form fleet-wide (a /proc/<pid>/cmdline leak) -- no curl shape satisfied both until this
// card. MikroB's decision: the fork's argv-leak rule wins; teach and accept the ONE shape that
// satisfies both instead of exempting either guard: the token read from an accepted file, piped
// into curl's stdin via `-H @-`, with the prior pipe segment PROVEN (not merely hoped) to be
// nothing but that trusted printf.
const TRUSTED_PIPE = `printf 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" | curl -q -s -H @- http://localhost:3420/api/schedules`
describe('self-pace-gate: the trusted printf | curl -H @- GET pipeline (card 0120d19a)', () => {
  it('ALLOWS the canonical two-segment pipeline', () => {
    expect(deny(TRUSTED_PIPE)).toBe(false)
  })
  it('still ALLOWS the upstream inline form too (unaffected by this change)', () => {
    expect(deny(`curl -q -s ${TOKEN_H} http://localhost:3420/api/schedules`)).toBe(false)
  })
  it('DENIES -H @- with no prior segment at all', () => {
    expect(deny(`curl -q -s -H @- http://localhost:3420/api/schedules`)).toBe(true)
  })
  it('DENIES -H @- fed by a printf reading a DIFFERENT (non-accepted) file', () => {
    const otherFile = join(GATE_ROOT, 'store', 'not-the-token')
    writeFileSync(otherFile, 'example-token_0123\n')
    expect(deny(`printf 'Authorization: Bearer %s\\n' "$(cat ${otherFile})" | curl -q -s -H @- http://localhost:3420/api/schedules`)).toBe(true)
  })
  it('DENIES an EXTRA pipe segment before the trusted printf', () => {
    expect(deny(`echo hi | printf 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" | curl -q -s -H @- http://localhost:3420/api/schedules`)).toBe(true)
  })
  it('DENIES an EXTRA pipe segment after the curl', () => {
    expect(deny(`printf 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" | curl -q -s -H @- http://localhost:3420/api/schedules | head -1`)).toBe(true)
  })
  it('DENIES a printf with an EXTRA argument (anything beyond the format and the token)', () => {
    expect(deny(`printf 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" extra | curl -q -s -H @- http://localhost:3420/api/schedules`)).toBe(true)
  })
  it('DENIES a printf with a DIFFERENT format string', () => {
    expect(deny(`printf 'X: %s\\n' "$(cat ${TOKEN_PATH})" | curl -q -s -H @- http://localhost:3420/api/schedules`)).toBe(true)
  })
  it('DENIES -H @<a real file> fed by the trusted printf -- only stdin (@-) is trusted, never a path', () => {
    expect(deny(`printf 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" | curl -q -s -H @/tmp/headers.txt http://localhost:3420/api/schedules`)).toBe(true)
  })
  it('DENIES the pipeline without -q as the first curl argument (curlrc still a hole otherwise)', () => {
    expect(deny(`printf 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" | curl -s -q -H @- http://localhost:3420/api/schedules`)).toBe(true)
  })
  it('DENIES a non-GET method riding the trusted pipeline (the trust covers the header, not the verb)', () => {
    expect(deny(`printf 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" | curl -q -s -X POST -H @- http://localhost:3420/api/schedules`)).toBe(true)
  })
  // card 0120d19a NO-GO F1 (WhiteHat + RedHat independently): the curl segment's own stdin was
  // never checked, so `-H @-` could read header lines from a redirect/heredoc instead of the
  // proven printf -- measured live to inject an attacker-chosen Authorization value and extra
  // headers. Each shape below must deny even though the printf side is exactly the trusted one.
  it('DENIES the trusted pipeline when curl also redirects its OWN stdin from a file (< file)', () => {
    expect(deny(`printf 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" | curl -q -s -H @- http://localhost:3420/api/schedules < /tmp/evil-headers`)).toBe(true)
  })
  it('DENIES the trusted pipeline with an explicit fd-0 input redirect (0< file)', () => {
    expect(deny(`printf 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" | curl -q -s -H @- http://localhost:3420/api/schedules 0< /tmp/evil-headers`)).toBe(true)
  })
  it('DENIES the trusted pipeline with an fd duplication onto stdin (<&N)', () => {
    expect(deny(`printf 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" | curl -q -s -H @- http://localhost:3420/api/schedules <&3`)).toBe(true)
  })
  it('DENIES the trusted pipeline with a heredoc attached to the curl segment', () => {
    expect(deny(`printf 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" | curl -q -s -H @- http://localhost:3420/api/schedules <<${Q}EOF${Q}\nX-Injected: yes\nEOF`)).toBe(true)
  })
  it('still ALLOWS the trusted pipeline with no redirect at all (control for the four cases above)', () => {
    expect(deny(TRUSTED_PIPE)).toBe(false)
  })
  // MikroB dispatch 17164 on Cybersec's T1 finding (comment 29073): three checks already in the
  // code had no named test that would fail if they were removed -- mutating each away left the
  // suite green. Each case below pins exactly one of them.
  it('DENIES the printf and curl joined by ";" instead of "|" (kills the segs[0].sep === "|" mutant)', () => {
    expect(deny(`printf 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" ; curl -q -s -H @- http://localhost:3420/api/schedules`)).toBe(true)
  })
  it('DENIES the trusted printf when IT ALSO redirects its own stdout (kills the printf words.redirects mutant)', () => {
    expect(deny(`printf 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" > /tmp/pf-out | curl -q -s -H @- http://localhost:3420/api/schedules`)).toBe(true)
  })
  it('DENIES a non-printf command producing the identical two words (kills the commandName !== "printf" mutant)', () => {
    expect(deny(`echo 'Authorization: Bearer %s\\n' "$(cat ${TOKEN_PATH})" | curl -q -s -H @- http://localhost:3420/api/schedules`)).toBe(true)
  })
})

describe('self-pace-gate: the scheduled-tasks store', () => {
  it('denies Bash writes into the store: cp, redirect, tee, python open, a glob', () => {
    expect(deny(`cp /tmp/t.json ~/.claude/scheduled-tasks/x/task-config.json`)).toBe(true)
    expect(deny(`mkdir -p ~/.claude/scheduled-tasks/x && echo '{}' > ~/.claude/scheduled-tasks/x/task-config.json`)).toBe(true)
    expect(deny(`echo hi | tee ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`python3 -c "open('/home/agent/.claude/scheduled-tasks/x/SKILL.md','w').write('x')"`)).toBe(true)
    expect(deny(`cp x.json ~/.claude/sched*/x/`)).toBe(true)
    expect(deny(`curl -s -o ~/.claude/scheduled-tasks/x/SKILL.md http://example.com/x`)).toBe(true)
  })
  it('denies a read whose output is piped into an interpreter', () => {
    expect(deny(`cat ~/.claude/scheduled-tasks/x/SKILL.md |\npython3 -c 'x'`)).toBe(true)
  })
  it('denies the native Write / Edit / NotebookEdit tools on the store', () => {
    expect(selfPaceDecision('Write', { file_path: '/home/agent/.claude/scheduled-tasks/x/SKILL.md', content: 'x' }).deny).toBe(true)
    expect(selfPaceDecision('Edit', { file_path: '/srv/app/.channels-config/scheduled-tasks/x/task-config.json' }).deny).toBe(true)
    expect(selfPaceDecision('NotebookEdit', { notebook_path: '/home/agent/.claude/scheduled-tasks/x/n.ipynb' }).deny).toBe(true)
  })
  // Shapes from a replay of real sub-agent tool calls: the store path travels
  // in a VARIABLE or in the WORKING DIRECTORY, not in the segment that writes.
  // The first is a measured SKILL.md append by a sub-agent.
  it('denies a write through a variable or a cd that holds the store path', () => {
    expect(deny(`F=~/.claude/scheduled-tasks/x/SKILL.md; cat >> $F <<${Q}EOF${Q}\nmore\nEOF`)).toBe(true)
    expect(deny(`cd ~/.claude/scheduled-tasks && echo x > a/SKILL.md`)).toBe(true)
    expect(deny(`cd ~/.claude/scheduled-tasks/x && sed -i 's/a/b/' SKILL.md`)).toBe(true)
    expect(deny(`for f in ~/.claude/scheduled-tasks/*/SKILL.md; do echo x >> $f; done`)).toBe(true)
  })
  it('ALLOWS reads through a variable and a loop (no cd into the store)', () => {
    expect(deny(`D=~/.claude/scheduled-tasks/x; ls $D 2>/dev/null && cat $D/task-config.json`)).toBe(false)
    expect(deny(`for t in a b; do sed -n '1,60p' ~/.claude/scheduled-tasks/$t/SKILL.md; done`)).toBe(false)
    // reading the store from the repo root, by absolute path, is fine
    expect(deny(`cd /srv/app && cat ~/.claude/scheduled-tasks/x/task-config.json`)).toBe(false)
  })
  it('ALLOWS a literal note that mentions the API written to an unrelated file', () => {
    expect(deny(`echo '- /api/schedules write is forbidden for sub-agents' >> MEMORY.md; cat MEMORY.md`)).toBe(false)
  })
  it('ALLOWS reads, and source files that only share the name', () => {
    expect(deny(`ls ~/.claude/scheduled-tasks/`)).toBe(false)
    expect(deny(`cat ~/.claude/scheduled-tasks/*/task-config.json 2>/dev/null | grep agent`)).toBe(false)
    expect(deny(`sed -n 1,40p src/web/scheduled-tasks-io.ts`)).toBe(false)
    expect(selfPaceDecision('Write', { file_path: '/home/x/src/web/scheduled-tasks-io.ts', content: 'x' }).deny).toBe(false)
  })
})

// --- review holes in a first draft of the check. Each case below was allowed
// (or crashed the gate open) there. ---
describe('self-pace-gate schedule surface: parser holes', () => {
  // 1) A zero-word segment (only redirects / a bare heredoc) made words[0]
  // throw. A throwing gate exits 1, which PreToolUse does NOT block: the whole
  // command ran, and every pre-existing denial after it was skipped too.
  it('a redirect-only or bare-heredoc segment denies instead of crashing', () => {
    expect(deny(`< /api/schedules; tmux send-keys -t x 'hi' Enter`)).toBe(true)
    expect(deny(`cd ~/.claude/scheduled-tasks; >/dev/null; python3 -c 'open("x/SKILL.md","w")'`)).toBe(true)
    expect(deny(`<<${Q}E${Q}\n/api/schedules\nE\npython3 -c "print(1)"`)).toBe(true)
  })

  // 2) -w %output{file} / %output{>>file} writes a file (curl >= 8.3.0; 8.5.0
  // measured), and a GET without -q first reads ~/.curlrc.
  it('form (a) refuses -w/--write-out, and requires -q as the first argument', () => {
    expect(deny(`curl -q -s -w '%output{>>/home/agent/.claude/scheduled-tasks/x/SKILL.md}new' http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -q -s --write-out '%output{/tmp/x}' http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -s http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -s -q http://localhost:3420/api/schedules`)).toBe(true) // -q only counts first
    expect(deny(`curl -q -s localhost:3420/api/schedules`)).toBe(true) // no literal scheme
  })

  // 3) Brace expansion and curl URL globbing spell the path without spelling it.
  it('brace expansion and bracket globs count as a reference', () => {
    expect(deny(`curl -s -X POST http://localhost:3420/api/sch{e,}dules -d x`)).toBe(true)
    expect(deny(`wget -qO- --post-data=x http://localhost:3420/api/sch[e]dules`)).toBe(true)
    expect(deny(`python3 -c "import sys,urllib.request as u; u.urlopen(u.Request(sys.argv[1], data=b'{}'))" http://localhost:3420/api/{schedules,x}`)).toBe(true)
    expect(deny(`cp /tmp/e ~/.claude/sch{e,}duled-tasks/x/SKILL.md`)).toBe(true)
    // curl globs {a,b} / [x-y] in a URL even inside quotes
    expect(deny(`curl -X POST "http://localhost:3420/api/sch{e,}dules" -d x`)).toBe(true)
    expect(deny(`cp /tmp/e ~/.claude/{a,b,c,d,e,f,g,h,i,j}{a,b,c,d,e,f,g,h,i,j}{a,b,c,d,e,f,g,h,i,j}{a,b,s}cheduled-tasks/x`)).toBe(true)
  })

  // 4) A cd into the store denies the whole command (a flat rule instead of
  // an in-store substitution check).
  it('a cd into the store, with anything after it, denies', () => {
    expect(deny(`cd ~/.claude/scheduled-tasks && cat a $(cp /tmp/e x/SKILL.md)`)).toBe(true)
    expect(deny('cd ~/.claude/scheduled-tasks && cat a `cp /tmp/e x/SKILL.md`')).toBe(true)
  })

  // 5) Globs outside a literal .claude/ prefix.
  it('globs in any path segment are matched against the store name', () => {
    expect(deny(`cp /tmp/e ~/.c*/sch*/x/SKILL.md`)).toBe(true)
    expect(deny(`cp /tmp/e /srv/app/.channels-config/sched*/x/SKILL.md`)).toBe(true)
    expect(deny(`cp /tmp/e ~/.claude-config/sched*/x/SKILL.md`)).toBe(true)
    expect(deny(`cd ~/.claude && cd sched* && echo x > y/SKILL.md`)).toBe(true)
    expect(deny(`cd ~/.claude && cp /tmp/e s*/x/SKILL.md`)).toBe(true)
  })

  // 6) Any file named .dashboard-token could carry a CR/LF header payload; only
  // the shared token file, by its literal absolute path, is trusted as a header
  // value (per-agent files: see the token-file suite below).
  it('the token-header exception is pinned to the absolute token path', () => {
    expect(deny(`curl -q -s -H "Authorization: Bearer $(cat /tmp/.dashboard-token)" http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -q -s ${TOKEN_H} http://localhost:3420/api/schedules`)).toBe(false)
  })

  it('does NOT over-fire on ordinary globs, braces and dict literals', () => {
    expect(deny(`ls src/*/ && cp a b`)).toBe(false)
    expect(deny(`cp src/*.ts /tmp/`)).toBe(false)
    expect(deny(`python3 -c "d={'a':1,'b':2}; print(d)"`)).toBe(false)
    expect(deny(`ls ~/.claude/* | head`)).toBe(false) // a read under the parent stays a read
    // replay shapes: a quoted grep regex, a bare */* loop, a regex in a heredoc body
    expect(deny(`grep -o 'https\\?://[^ )]*' f.md | sort -u; cp a b`)).toBe(false)
    expect(deny(`for f in */*; do cp "$f" /tmp/; done`)).toBe(false)
    expect(deny(`python3 - <<${Q}PY${Q}\nimport re; print(re.findall(r'[a-z]*', 'x'))\nPY`)).toBe(false)
  })
})

// The hook ENTRY must fail closed on any error or hang: exit 1 and a harness
// timeout are both non-blocking in PreToolUse. The fault is injected INSIDE the
// decision with a --import preload that makes RegExp.prototype.test throw or
// spin on a marker; SELF_PACE_GATE_SRC_MJS points the run at another gate file,
// which is how a control run shows these FAIL on the previous gate.
describe('self-pace-gate hook entry: an internal error or hang denies, never exits 1', () => {
  const SRC = process.env.SELF_PACE_GATE_SRC_MJS ?? join(__dirname, '..', '..', 'scripts', 'self-pace-gate.mjs')
  const PRELOAD = [
    'const orig = RegExp.prototype.test',
    'RegExp.prototype.test = function (s) {',
    "  const t = String(s)",
    "  if (t.includes('FAULT_INJECT_THROW')) throw new Error('injected fault')",
    "  if (t.includes('FAULT_INJECT_HANG')) { for (;;) {} }",
    '  return orig.call(this, s)',
    '}',
  ].join('\n')
  const run = (command: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'selfpace-fault-'))
    try {
      const preload = join(dir, 'fault.mjs')
      writeFileSync(preload, PRELOAD)
      return spawnSync(process.execPath, ['--import', preload, SRC], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf-8',
        timeout: 8_000,
        env: { ...process.env, SELF_PACE_GATE_DEADLINE_MS: '300' },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const denied = (r: ReturnType<typeof run>) => r.status === 0
    && JSON.parse(r.stdout || '{}')?.hookSpecificOutput?.permissionDecision === 'deny'

  it('a thrown error inside the decision is a DENY', () => {
    const r = run('echo FAULT_INJECT_THROW')
    expect(r.status, r.stderr.slice(-300)).not.toBe(1)
    expect(denied(r), `status=${r.status} stdout=${r.stdout} stderr=${r.stderr.slice(-300)}`).toBe(true)
  })
  it('a decision that never returns is a DENY within the deadline', () => {
    const r = run('echo FAULT_INJECT_HANG')
    expect(denied(r), `status=${r.status} signal=${r.signal} stdout=${r.stdout}`).toBe(true)
  })
  it('control: the same preload leaves an ordinary command allowed', () => {
    const r = run('ls -la')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })
  it('gateDecision itself returns deny on a throw (in-process callers)', () => {
    const bomb = { get command(): string { throw new Error('boom') } }
    expect(selfPaceDecision('Bash', bomb).deny).toBe(true)
  })
})

// --- bypasses of a cwd/shadow-modelling draft. The fix replaced the modelling
// with flat, fail-closed invariants. ---
describe('self-pace-gate schedule surface: flat invariants', () => {
  // A shell function or alias shadowing an allowed read-only / GET name.
  it('denies a function or alias that shadows an allowed command', () => {
    expect(deny(`ls() { cp "$@"; }; ls /tmp/e ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`cat() { cp /tmp/e "$1"; }; cat ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`function ls { cp "$@"; }; ls /tmp/e ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`curl() { python3 -c 'x' "$2"; }; curl -q http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`alias ls=cp; ls /tmp/e ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`command cp /tmp/e ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`exec cp /tmp/e ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`builtin cd ~/.claude/scheduled-tasks`)).toBe(true)
  })

  // Trust a command only by a bare name or an exact system-binary path.
  it('denies a command given by a non-system path (basename spoof)', () => {
    expect(deny(`/tmp/cat ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(true)
    expect(deny(`./curl -q http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`/tmp/curl -q -s http://localhost:3420/api/schedules`)).toBe(true)
    // an exact system path stays trusted
    expect(deny(`/usr/bin/curl -q -s http://localhost:3420/api/schedules`)).toBe(false)
    expect(deny(`/bin/cat ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(false)
  })

  // Any cd/pushd/popd whose argument references the store denies the whole
  // command -- no cwd state machine, so cd -/OLDPWD/failed-cd/popd cannot lose it.
  it('denies any cd/pushd/popd into the store, and the return-to-store shapes', () => {
    expect(deny(`cd ~/.claude/scheduled-tasks`)).toBe(true)
    expect(deny(`cd ~/.claude/scheduled-tasks/x && cd /tmp && cd - && cp /tmp/e SKILL.md`)).toBe(true)
    expect(deny(`cd ~/.claude/scheduled-tasks/x; cd /nonexistent; echo x > SKILL.md`)).toBe(true)
    expect(deny(`pushd ~/.claude/scheduled-tasks; pushd /tmp; popd; echo x > a/b`)).toBe(true)
    expect(deny(`cd "$OLDPWD/.claude/scheduled-tasks" && echo x > a`)).toBe(true)
    // a cd to somewhere else, reading the store by an explicit path, is fine
    expect(deny(`cd /tmp && cat ~/.claude/scheduled-tasks/x/task-config.json`)).toBe(false)
  })

  // The token marker is a per-run NUL nonce, not the literal ${DASHBOARD_TOKEN},
  // so an agent cannot forge it with a real shell expansion (CR/LF smuggling).
  it('denies a ${DASHBOARD_TOKEN}-style expansion in a header, even self-assigned', () => {
    expect(deny(`DASHBOARD_TOKEN=$'x\r\n\r\nPOST /api/schedules HTTP/1.1'; curl -q -s -H "X: \${DASHBOARD_TOKEN}" http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -q -s -H "X: \${DASHBOARD_TOKEN}" http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`curl -q -s -H "X: $(printf 'a\r\nb')" http://localhost:3420/api/schedules`)).toBe(true)
  })

  it('does NOT over-fire: the shadow words as arguments, a plain read', () => {
    expect(deny(`grep command ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(false)
    expect(deny(`ls ~/.claude/scheduled-tasks/`)).toBe(false)
  })
})

// --- three more holes in the flat-invariant draft. Each case below was
// ALLOWED there. ---
describe('self-pace-gate schedule surface: subshells, variable writers, path normalisation', () => {
  // 1) A definition opening a subshell/group is not at a segment start, so the
  // segment-start test missed it; the shadowed `ls` then passed as form (b).
  it('denies a function/alias definition at any command position (subshell, group)', () => {
    expect(deny(`(ls(){ cp /tmp/x "$1"; }; ls ~/.claude/scheduled-tasks/a/SKILL.md; )`)).toBe(true)
    expect(deny(`(ls(){ cp /tmp/x "$1"; }\nls ~/.claude/scheduled-tasks/a/SKILL.md\n)`)).toBe(true)
    expect(deny(`(alias ls=cp\nls /tmp/x ~/.claude/scheduled-tasks/a/SKILL.md\n)`)).toBe(true)
  })

  // 2) Builtins that assign a variable without a NAME=value word escape the
  // taint tracking; once the command references the surface they deny (flat).
  it('denies printf -v, read, mapfile and a nameref next to a surface reference', () => {
    expect(deny(`printf -v D %s ~/.claude/scheduled-tasks; mkdir -p "$D/x"; cp /tmp/s "$D/x/SKILL.md"`)).toBe(true)
    expect(deny(`ls -d ~/.claude/scheduled-tasks > /tmp/l; read D < /tmp/l; cp /tmp/s "$D/x/SKILL.md"`)).toBe(true)
    expect(deny(`ls -d ~/.claude/scheduled-tasks > /tmp/l; mapfile -t A < /tmp/l; cp /tmp/s "\${A[0]}/x/SKILL.md"`)).toBe(true)
    expect(deny(`ls -d ~/.claude/scheduled-tasks > /tmp/l; while read f; do cp /tmp/s "$f/x"; done < /tmp/l`)).toBe(true)
    expect(deny(`declare -n R=X; X=~/.claude/scheduled-tasks; cp /tmp/s "$R/x"`)).toBe(true)
  })

  // 3) An empty or dot segment hid the store parent from a short glob.
  it('normalises // /./ and .. before reading a glob segment', () => {
    expect(deny(`cd ~/.claude//sc* && cp /tmp/s x/SKILL.md`)).toBe(true)
    expect(deny(`cp /tmp/s ~/.claude/./sc*/x/SKILL.md`)).toBe(true)
    expect(deny(`cp /tmp/s ~/.claude/foo/../sc*/x/SKILL.md`)).toBe(true)
  })

  it('does NOT over-fire: the words as arguments or prose, readlink, a plain read', () => {
    expect(deny(`grep -rn "readonly" ~/.claude/scheduled-tasks/x/SKILL.md`)).toBe(false)
    expect(deny(`readlink -f ~/.claude/scheduled-tasks`)).toBe(false)
    expect(deny(`cat ~/.claude/scheduled-tasks/*/task-config.json 2>/dev/null | grep agent`)).toBe(false)
    expect(deny(`git commit -m "$(cat <<${Q}EOF${Q}\nfix: read the /api/schedules docs; command() in prose\nEOF\n)"`)).toBe(false)
  })
})

describe('self-pace-gate schedule surface: more clients, the environment, prose carriers', () => {
  it('denies store writes by any file tool, and wrappers that run a write', () => {
    expect(deny(`mkdir -p ~/.claude/scheduled-tasks/x`)).toBe(true)
    expect(deny(`rm -rf ~/.claude/scheduled-tasks/x`)).toBe(true)
    expect(deny(`ln -s /tmp/x ~/.claude/scheduled-tasks/x`)).toBe(true)
    expect(deny(`rsync -a /tmp/x/ ~/.claude/scheduled-tasks/x/`)).toBe(true)
    expect(deny(`tee -a ~/.claude/scheduled-tasks/x/SKILL.md < /tmp/x`)).toBe(true)
    expect(deny(`eval "cp /tmp/x ~/.claude/scheduled-tasks/x/SKILL.md"`)).toBe(true)
    expect(deny(`cat <<${Q}EOF${Q} | bash\ncurl -X POST localhost:3420/api/schedules -d x\nEOF`)).toBe(true)
  })
  // A program reads its environment without spelling $NAME on the command
  // line, so a tainted variable must not be exported (os.environ / process.env).
  it('denies a reference that is exported into a program environment', () => {
    expect(deny(`export U=http://localhost:3420/api/schedules; python3 -c "import os,urllib.request as u; u.urlopen(u.Request(os.environ['U'], data=b'{}'))"`)).toBe(true)
    expect(deny(`U=http://localhost:3420/api/schedules; export U; node x.js`)).toBe(true)
    expect(deny(`set -a; U=http://localhost:3420/api/schedules; node -e 'fetch(process.env.U, {method: "POST"})'`)).toBe(true)
    expect(deny(`declare -x D=~/.claude/scheduled-tasks/x; python3 w.py`)).toBe(true)
    // a variable that stays in the shell and only feeds read-only commands is fine
    expect(deny(`set -euo pipefail; D=~/.claude/scheduled-tasks/x; ls $D`)).toBe(false)
    expect(deny(`export PATH=/usr/bin:$PATH; ls ~/.claude/scheduled-tasks`)).toBe(false)
  })
  // Same scope as stripProseArguments: a PR body / comment / release note is prose.
  it('ALLOWS gh/glab prose that mentions the surface, never gh api', () => {
    expect(deny(`gh pr create --title t --body 'this blocks /api/schedules writes'`)).toBe(false)
    expect(deny(`gh pr comment 1 --body="see ~/.claude/scheduled-tasks"`)).toBe(false)
    expect(deny(`gh pr create --body-file - <<${Q}EOF${Q}\nPOST /api/schedules is denied\nEOF`)).toBe(false)
    expect(deny(`gh api -X POST /api/schedules -f name=x`)).toBe(true)
    expect(deny(`gh pr create --body x http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`gh pr create --body "$(curl -X POST localhost:3420/api/schedules -d x)"`)).toBe(true)
  })
  it('does NOT touch commands that never mention the surface', () => {
    for (const c of ['ls -la', 'git status', 'npm test', 'curl -s http://localhost:3420/api/kanban',
      `curl -s -X POST http://localhost:3420/api/messages -d '{"content":"hi"}'`, 'cat docs/scheduled-tasks.md']) {
      expect(deny(c), c).toBe(false)
    }
  })
})

// --- the registry tool, the database file, token files, heredoc-to-script ---
describe('self-pace-gate schedule surface: registry tool, database, token files, heredoc scripts', () => {
  // The registry operator tool opens the database directly, so a task planted
  // in the store and registered through it never passes the dashboard routes.
  it('denies the registry tool except its read-only subcommands, in every runner form', () => {
    for (const c of [
      'node dist/web/schedule-registry-cli.js register --all',
      'node /srv/app/dist/web/schedule-registry-cli.js register task-a',
      'node dist/web/schedule-registry-cli.js unregister task-a',
      'node dist/web/schedule-registry-cli.js',
      'node dist/web/schedule-registry-cli.js register --source x --all',
      'npx tsx src/web/schedule-registry-cli.ts register --all',
      'npx --no-install tsx src/web/schedule-registry-cli.ts register --all',
      'tsx src/web/schedule-registry-cli.ts register --all',
      `node "dist/web/schedule-registry-cli.js" register --all`,
      `node 'dist/web/schedule-'registry-cli.js register --all`,
      'C=dist/web/schedule-registry-cli.js; node $C register --all',
      'node dist/web/schedule-reg*-cli.js register --all',
      `node -e "import('./dist/web/schedule-registry.js').then((m) => m.registerAllScheduledTasks())"`,
      'cd dist/web && node schedule-registry-cli.js register --all',
      'node --import x dist/web/schedule-registry-cli.js status',
      `git -c alias.x="!node dist/web/schedule-registry-cli.js register --all" x`,
    ]) expect(deny(c), c).toBe(true)
    for (const c of [
      'node dist/web/schedule-registry-cli.js status',
      'node dist/web/schedule-registry-cli.js verify task-a task-b',
      'npx tsx src/web/schedule-registry-cli.ts status | head -20',
      'cat src/web/schedule-registry-cli.ts',
      'git diff -- src/web/schedule-registry-cli.ts',
      'npx vitest run src/__tests__/schedule-registry-shell-paths.test.ts',
    ]) expect(deny(c), c).toBe(false)
  })

  it('denies file-level writes to the database file and SQL writes on schedule tables', () => {
    for (const c of [
      'cp /tmp/x.db store/claudeclaw.db',
      'echo x > store/claudeclaw.db-wal',
      'tee store/claudeclaw.db-shm < /tmp/x',
      `sqlite3 store/claudeclaw.db ".restore /tmp/x.db"`,
      `sqlite3 store/claudeclaw.db "INSERT INTO scheduled_task_registry VALUES (1)"`,
      `python3 -c "import sqlite3; sqlite3.connect('store/claudeclaw.db').execute('UPDATE scheduled_tasks SET enabled=1')"`,
      `sqlite3 /tmp/a.db "ATTACH 'store/claudeclaw.db' AS m; DELETE FROM m.scheduled_task_registry"`,
    ]) expect(deny(c), c).toBe(true)
    // reads of the database stay allowed (a worker reads the board this way)
    for (const c of [
      `sqlite3 store/claudeclaw.db "SELECT id, status FROM kanban_cards" | while read l; do echo "$l"; done`,
      `python3 -c "import sqlite3; print(sqlite3.connect('store/claudeclaw.db').execute('select 1').fetchall())"`,
      'ls -la store/claudeclaw.db',
      `grep -n "INSERT INTO scheduled_tasks" src/db.ts`,
    ]) expect(deny(c), c).toBe(false)
  })

  // A sub-agent runs in agents/<name>/: a RELATIVE store/.dashboard-token there
  // is a file it can create itself, with a CR/LF in it, and curl sends a header
  // value verbatim -- a second, pipelined POST rides inside the allowed GET.
  it('accepts only the literal absolute token path, never a relative or ~/$HOME one', () => {
    const get = (h: string) => `curl -q -s ${h} http://localhost:3420/api/schedules`
    expect(deny(get(TOKEN_H))).toBe(false)
    for (const p of ['store/.dashboard-token', './store/.dashboard-token', '~/app/store/.dashboard-token', '$HOME/app/store/.dashboard-token']) {
      expect(deny(get(tokenHeader(p))), p).toBe(true)
    }
  })
  it('the token file content must look like a token (a CR/LF payload, a missing file: deny)', () => {
    const ok = (selfPaceGateModule as Record<string, unknown>).tokenFileContentOk as (p: string) => boolean
    expect(ok(TOKEN_PATH)).toBe(true)
    expect(ok(join(GATE_ROOT, 'agents', 'agent-c', '.dashboard-token'))).toBe(false)
    expect(ok(join(GATE_ROOT, 'no-such-file'))).toBe(false)
    const crlf = join(GATE_ROOT, 'agents', 'agent-c', '.dashboard-token')
    expect(deny(`curl -q -s ${tokenHeader(crlf)} http://localhost:3420/api/schedules`, { projectRoot: GATE_ROOT, selfAgent: 'agent-c' })).toBe(true)
  })
  it('a token file rewritten in the same command is refused', () => {
    expect(deny(`echo x > ${TOKEN_PATH}; curl -q -s ${TOKEN_H} http://localhost:3420/api/schedules`)).toBe(true)
    expect(deny(`cp /tmp/t ${TOKEN_PATH} && curl -q -s ${TOKEN_H} http://localhost:3420/api/schedules`)).toBe(true)
  })
  // Per-agent token files: the calling agent's own, never another agent's.
  it('accepts the calling agent own per-agent token file, not another agent one', () => {
    const own = join(GATE_ROOT, 'agents', 'agent-a', '.dashboard-token')
    const other = join(GATE_ROOT, 'agents', 'agent-b', '.dashboard-token')
    const get = (p: string) => `curl -q -s ${tokenHeader(p)} http://localhost:3420/api/schedules`
    expect(deny(get(own))).toBe(false)
    expect(deny(get(other))).toBe(true)
    // no calling agent known: only the shared file
    expect(deny(get(own), { projectRoot: GATE_ROOT })).toBe(true)
    const derive = (selfPaceGateModule as Record<string, unknown>).selfAgentFromProjectDir as (d: string | undefined, r: string) => string | undefined
    expect(derive(join(GATE_ROOT, 'agents', 'agent-a'), GATE_ROOT)).toBe('agent-a')
    expect(derive(join(GATE_ROOT, 'agents', 'agent-a', 'sub'), GATE_ROOT)).toBe(undefined)
    expect(derive(GATE_ROOT, GATE_ROOT)).toBe(undefined)
    expect(derive('/elsewhere/agents/agent-a', GATE_ROOT)).toBe(undefined)
    expect(derive(undefined, GATE_ROOT)).toBe(undefined)
  })

  // A heredoc that carries a reference, written to a file and run afterwards.
  it('denies a heredoc or here-string carrying a reference that is redirected to a file', () => {
    for (const c of [
      `cat <<${Q}X${Q} > /tmp/s.sh\ncurl -X POST localhost:3420/api/schedules -d x\nX\nbash /tmp/s.sh`,
      `cat > /tmp/f <<${Q}X${Q}\ncurl -X POST localhost:3420/api/schedules -d x\nX\nsh /tmp/f`,
      `grep -h . <<${Q}X${Q} > /tmp/s.py\nimport urllib.request as u; u.urlopen(u.Request("http://localhost:3420/api/schedules", data=b"{}"))\nX\npython3 /tmp/s.py`,
      `grep -h . <<<${Q}curl -X POST localhost:3420/api/schedules -d x${Q} > /tmp/s.sh; bash /tmp/s.sh`,
    ]) expect(deny(c), c).toBe(true)
    // the same heredoc fed to a message or commit, with no file redirect, is data
    expect(deny(`curl -s -X POST http://localhost:3420/api/messages --data-binary @- <<${Q}J${Q}\n{"content":"wanted POST /api/schedules"}\nJ`)).toBe(false)
    expect(deny(`git commit -F - <<${Q}EOF${Q}\nfix /api/schedules docs\nEOF`)).toBe(false)
  })
})

// --- telegram copy gate: the outgoing-copy-gate must actually be WIRED ---
//
// maskInertLiterals blanks every heredoc body BY DESIGN before the anchored SCHEDULER_RX check
// ever sees it (that check exists to stop a QUOTED-PROSE fake command position, not to read
// heredoc contents). So crontab/launchctl/at/systemd-run/batch hidden in a heredoc body -- the
// exact vector this gate exists to catch for tmux (its own founding incident) -- were invisible
// to BOTH the anchored check (masked away) and the unanchored one (the scheduler group was never
// added there, only tmux/nohup/loop). extractHeredocBodies + a per-line unanchored scan closes
// this without reopening the quote-fakery class: two regressions were measured and fixed while
// building it (see the code comments at the call site) -- a bare `echo 'foo | crontab | bar'`
// argument, and a heredoc body containing a QUOTED prose sentence with the same shape.
describe('self-pace-gate: scheduler binaries hidden in a heredoc BODY (card 46c4ad4a)', () => {
  it('denies crontab -r hidden in a bash heredoc body', () => {
    expect(selfPaceDecision('Bash', { command: `bash <<${Q}TAG${Q}\ncrontab -r\nTAG` }).deny).toBe(true)
  })
  it('denies systemd-run hidden in a bash heredoc body', () => {
    expect(selfPaceDecision('Bash', { command: `bash <<${Q}TAG${Q}\nsystemd-run --user echo hi\nTAG` }).deny).toBe(true)
  })
  it('denies launchctl bootstrap hidden in a bash heredoc body', () => {
    expect(selfPaceDecision('Bash', { command: `bash <<${Q}TAG${Q}\nlaunchctl bootstrap gui/501 x.plist\nTAG` }).deny).toBe(true)
  })
  it('denies "at now" hidden in a bash heredoc body', () => {
    expect(selfPaceDecision('Bash', { command: `bash <<${Q}TAG${Q}\nat now\nTAG` }).deny).toBe(true)
  })
  it('REGRESSION (Cybered\'s own adversarial example): a python list-literal subprocess.run(["crontab","-r"]) is still denied', () => {
    expect(selfPaceDecision('Bash', {
      command: heredoc(`import subprocess\nsubprocess.run([${Q}crontab${Q},${Q}-r${Q}])`),
    }).deny).toBe(true)
  })
  it('a multi-command heredoc LINE is still caught (trailing content after the real invocation)', () => {
    expect(selfPaceDecision('Bash', { command: `bash <<${Q}TAG${Q}\ncrontab -r; echo done\nTAG` }).deny).toBe(true)
  })
  it('allows a pure read-listing (crontab -l) hidden in a heredoc body', () => {
    expect(selfPaceDecision('Bash', { command: `bash <<${Q}TAG${Q}\ncrontab -l\nTAG` }).deny).toBe(false)
  })
  it('allows ordinary, non-scheduler heredoc content', () => {
    expect(selfPaceDecision('Bash', { command: `bash <<${Q}TAG${Q}\nnpm test\nTAG` }).deny).toBe(false)
  })

  // --- both regressions measured and fixed while building this, pinned so they cannot return ---
  it('REGRESSION GUARD 1: a single quoted argument naming crontab (no heredoc at all) is still allowed', () => {
    // `splitSegments` is not quote-aware and splits on a bare `|` -- this is the SAME
    // 2026-08-05 finding (PATTERN/BAR above), re-checked here because the first draft of this
    // fix applied the new scheduler scan to every naive top-level segment and regressed exactly
    // this case (a single quoted echo argument, pipe-split into a bare `crontab` segment).
    expect(selfPaceDecision('Bash', { command: `echo ${Q}foo ${BAR} crontab ${BAR} bar${Q}` }).deny).toBe(false)
  })
  it('REGRESSION GUARD 2: a heredoc body containing the SAME quoted-prose pattern is still allowed', () => {
    // A second, deeper instance of the same class: the measured PATTERN (real incident text)
    // placed INSIDE a heredoc body as a quoted python string. The first fix for this card split
    // heredoc bodies with splitSegments too, which re-faked a boundary around "launchctl" here.
    expect(selfPaceDecision('Bash', { command: heredoc(`t = "${PATTERN}"`) }).deny).toBe(false)
  })
})

// --- card 4f32f1f9: the shell expands a word BEFORE running it; this gate matched before ---
//
// ROOT CAUSE (Cybersec's finding, re-measured independently through the real gateDecision path
// before any code was written). Every pattern in this gate matched the command as WRITTEN. bash
// removes quotes, expands $IFS, unescapes backslashes and substitutes $'...' / ${x}, and only THEN
// decides which binary to exec. So any of those placed INSIDE the binary name -- or between it and
// its argument -- made a real, working invocation invisible to a pattern hunting for the literal
// name. Eleven forms were measured; the ones below ran the scheduler and passed the gate.
//
// THE FIX IS A MODEL CHANGE, NOT ONE MORE TOLERATED CHARACTER. The three previous cards
// (12f80902, eae5d6fd, 4fa31f31) each widened one branch by one character, and this card is the
// evidence that that does not converge -- word expansion is not a character set. The gate now also
// reads the word at each command position with the expansion APPROXIMATED, ADDITIVELY: alongside
// the raw checks, never instead of them, so no existing denial rests on the approximation being
// complete and a negative control can switch it off and watch these tests redden.
//
// MEASURED COST, on 1898 real fleet message/comment/log/memory lines containing a colliding word,
// each run through the gate in the three shapes the fleet actually sends text in (bare command,
// heredoc body, git commit body): ZERO denials lost, and in the two realistic shapes exactly four
// lines newly denied -- all four being fleet messages that QUOTE these bypass strings while
// discussing them. No prose class was newly caught: the check is anchored to a command position the
// masked view already established, and every documented false positive in this file sits in
// ARGUMENT position behind an `echo`/`grep` command word, where this check never looks.
//
// NOT CLOSED, ON PURPOSE (Cybersec's decision on this card, option (a)): a command substitution or
// a bare parameter expansion standing in command-word position -- `$(echo at) now`, `${CMD} -r` --
// cannot be named without executing it. It is deliberately NOT pinned by a test in EITHER
// direction: asserting that it passes would nail the defect in place. The reasoning first offered
// for accepting it, that the heredoc branch backstops it, was measured FALSE and is recorded as
// such in DECISIONS.md so nobody builds on it.
describe('self-pace-gate: word expansion must not hide an invocation (card 4f32f1f9)', () => {
  const NL = String.fromCharCode(10)
  const heredoc = (body: string): string => "python3 - <<'PY'" + NL + body + NL + 'PY'
  // Assembled rather than written literally: this file is itself scanned by the gate it tests.
  const AT = 'a' + 't'
  const LC = 'launch' + 'ctl'
  const CT = 'cron' + 'tab'
  const SR = 'systemd' + '-run'
  const DQ = String.fromCharCode(34)
  const SQ = String.fromCharCode(39)
  const BS = String.fromCharCode(92)

  it('DENIES a quote inside the BINARY NAME (the name itself vanished from every view)', () => {
    for (const cmd of [
      'cr' + DQ + 'o' + DQ + 'ntab -r', // quote in the middle
      'a' + DQ + DQ + 't now', // empty quote pair in the middle
      DQ + 'a' + DQ + 't now', // quote pair at the front
      DQ + CT + DQ + ' -r', // whole name quoted
      DQ + AT + DQ + ' now',
      DQ + SR + DQ + ' --on-active=5m x',
      DQ + LC + DQ + ' submit -l self -- x',
    ]) {
      expect(selfPaceDecision('Bash', { command: cmd }).deny, cmd).toBe(true)
    }
  })

  it('DENIES $IFS standing in for the space between the binary and its argument', () => {
    for (const cmd of [AT + '$IFS' + DQ + 'now' + DQ, LC + '$IFS' + DQ + 'submit' + DQ + ' -l self -- x']) {
      expect(selfPaceDecision('Bash', { command: cmd }).deny, cmd).toBe(true)
    }
  })

  it('DENIES $-quoting, a parameter PREFIX and a backslash-escaped binary', () => {
    for (const cmd of [
      '$' + SQ + AT + SQ + ' now', // ANSI-C quoting: $'at'
      '${x}' + AT + ' now', // an empty parameter JOINS what surrounds it
      BS + AT + ' now',
      BS + CT + ' -r',
    ]) {
      expect(selfPaceDecision('Bash', { command: cmd }).deny, cmd).toBe(true)
    }
  })

  it('DENIES a quoted SUBCOMMAND and a quoted TIMESPEC', () => {
    for (const cmd of [
      LC + ' ' + DQ + 'load' + DQ + ' /tmp/x.plist',
      LC + ' ' + DQ + 'bootstrap' + DQ + ' gui/501 x',
      AT + ' n' + DQ + DQ + 'ow',
    ]) {
      expect(selfPaceDecision('Bash', { command: cmd }).deny, cmd).toBe(true)
    }
  })

  // DELIBERATELY NOT THE FIRST LINE OF THE BODY. A single-line body is the wrong probe for this
  // branch: maskInertLiterals blanks a body's newlines along with its text, so the segment that
  // begins after the redirect line carries the body's FIRST line as its original text, and the
  // anchored command-word check answers for it. A negative control that disabled this branch
  // entirely stayed GREEN against a single-line body -- the test was measuring the other path. A
  // later line is reachable only by the branch that scans every line, which is this one.
  it('DENIES the same obfuscation on a LATER line of a heredoc BODY (the per-line branch)', () => {
    for (const line of ['cr' + DQ + 'o' + DQ + 'ntab -r', AT + '$IFS' + DQ + 'now' + DQ, 'a' + DQ + DQ + 't now']) {
      const body = 'import os' + NL + 'print(1)' + NL + line
      expect(selfPaceDecision('Bash', { command: heredoc(body) }).deny, line).toBe(true)
    }
  })

  // FOUND WHILE BUILDING THIS, not in the card: the masker gives up (returns null) when a
  // double-quoted region can command-substitute, and the anchored check then falls back to the
  // naive segments. That fallback is reachable ON PURPOSE by an author -- one harmless `"$(date)"`
  // earlier in the line -- so if the new check ran only on resolved segments, appending that prefix
  // would restore every bypass above. It runs on the fallback segments too, and this pins it.
  it('DENIES an obfuscated call even when an earlier $(...) forces the masker to give up', () => {
    for (const cmd of [
      'echo ' + DQ + '$(date)' + DQ + ' ; cr' + DQ + 'o' + DQ + 'ntab -r',
      'echo ' + DQ + '$(date)' + DQ + ' ; ' + DQ + AT + DQ + ' now',
    ]) {
      expect(selfPaceDecision('Bash', { command: cmd }).deny, cmd).toBe(true)
    }
  })

  // The pair that shows the rule is about EXECUTABILITY, not about quoting. A segment that is
  // quoted end to end names a binary literally called "at now" and schedules nothing, so it stays
  // inert -- that is maskInertLiterals' whole purpose and this fix must not undo it. Move the
  // closing quote one word left and it becomes a real at(1) call, and it is denied.
  it('leaves a WHOLLY quoted segment inert, but denies a quoted BINARY with a live argument', () => {
    expect(selfPaceDecision('Bash', { command: 'echo x ; ' + SQ + AT + ' now' + SQ }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'echo x ; ' + SQ + AT + SQ + ' now' }).deny).toBe(true)
  })

  it('does NOT deny the documented prose classes, which sit in argument position', () => {
    for (const cmd of [
      'echo ' + DQ + 'the ' + CT + ' entries need review' + DQ,
      'echo ' + SQ + 'Minta: stop.sh | ' + LC + ' | com.janna.dashboard' + SQ,
      AT + ' least 80% of the entries were checked',
      AT + ' declared trivial difficulty',
      'cat ~/.claude/memory/loop-stop-vs-truncation.md',
    ]) {
      expect(selfPaceDecision('Bash', { command: cmd }).deny, cmd).toBe(false)
    }
  })

  it('does NOT deny legitimate command substitution, in either position', () => {
    for (const cmd of ['ls $(which node)', 'echo $(which python3)', 'PATH=$(dirname $(which git)):$PATH ls', '$(npm bin)/eslint .']) {
      expect(selfPaceDecision('Bash', { command: cmd }).deny, cmd).toBe(false)
    }
  })

  it('keeps a pure READ allowed once expansion is approximated', () => {
    for (const cmd of [CT + ' -l', LC + ' list', 'atq']) {
      expect(selfPaceDecision('Bash', { command: cmd }).deny, cmd).toBe(false)
    }
  })

  // ADDITIVITY, pinned. The expanded view of `crontab "foo"` is `crontab foo`, which the unanchored
  // guard cannot tell from an English sentence -- so if the expanded text REPLACED the raw text
  // here, this denial would silently disappear. It does not, because both are tested.
  // THE ONE FAILURE THAT WOULD BE SILENT. The command-word check reads the ORIGINAL text at offsets
  // the MASKED view chose, which is only valid while both views stay the same length. If a future
  // change to either blanking function breaks that, pairedSegments returns null and the check
  // quietly degrades to the naive segments -- strictly weaker, and NOTHING else in this suite would
  // redden, because the naive path still denies the plain forms. So the alignment is pinned here
  // directly, on a command that exercises every blanking branch at once.
  it('keeps the masked and original views index-aligned (a silent fallback would weaken the check)', () => {
    const cmd =
      'echo ' + SQ + 'x; y' + SQ + ' ; python3 - <<' + SQ + 'PY' + SQ + NL + 'print(1)' + NL + 'PY' + NL + 'echo ' + DQ + 'done' + DQ
    const pairs = pairedSegments(cmd) as Array<{ masked: string; raw: string }> | null
    expect(pairs, 'the masker must resolve this command, not give up').not.toBeNull()
    for (const p of pairs ?? []) expect(p.raw.length, JSON.stringify(p)).toBe(p.masked.length)
  })

  it('keeps a denial that ONLY the raw text produces (the expansion is additive, not a swap)', () => {
    const body = 'import os' + NL + CT + ' ' + DQ + 'foo' + DQ
    expect(selfPaceDecision('Bash', { command: heredoc(body) }).deny).toBe(true)
  })
})

// --- readonly-repo-gate: only the EXACT install command is exempt ---
//
// Maintainer decision on #770 (2026-09-25): package installs are allowed, but
// only the exact install command with nothing appended -- `npm install`,
// `npm ci`, `yarn install`, bare `yarn`, `pnpm install`. The yarn branch used
// to read `yarn\s+(install)?\b`, which matched `yarn ` + anything, so
// `yarn add left-pad` and `yarn exec rm -rf src` skipped the gate. INSTALL_RX
// is now anchored to the whole segment, and an appended form is judged (and,
// inside a protected root, refused) like any other package-manager call.
describe('readonly-repo-gate: only the exact install command is exempt', () => {
  // ROOTS defaults to <home>/projects, resolved when the module loads.
  const repo = join(homedir(), 'projects', 'app')
  const outside = join(homedir(), 'agents', 'qa-worker')

  const EXACT = ['npm install', 'npm ci', 'yarn install', 'yarn', 'pnpm install']

  it('recognises exactly the five decided install commands', () => {
    for (const cmd of EXACT) expect(isExactInstall(cmd), cmd).toBe(true)
    for (const cmd of [
      'yarn add left-pad',
      'yarn exec rm -rf src',
      'yarn dlx some-codemod',
      'npm install evil-pkg',
      'npm ci --prefix=src',
      'npm i',
      'pnpm install left-pad',
      'pnpm add left-pad',
      'yarn install --modules-folder=src',
      'yarn --cwd src',
      'npm ci --include=../src',
      'npm ci --silent>src/x',
      'CI=1 npm ci',
      'pip install -r requirements.txt',
    ]) {
      expect(isExactInstall(cmd), cmd).toBe(false)
    }
  })

  it('an install followed only by allowlisted flags is still the exact install', () => {
    // Review question on #770 (2026-09-26): the updater runs `npm ci` with
    // flags. An allowlist, not "anything starting with -": the flags that
    // matter are the ones that move where the install writes.
    for (const cmd of [
      'npm ci --include=dev',
      'npm ci --ignore-scripts --no-audit --no-fund',
      'yarn install --frozen-lockfile',
      'yarn --frozen-lockfile',
      'pnpm install --frozen-lockfile',
      'npm install --legacy-peer-deps',
    ]) {
      expect(isExactInstall(cmd), cmd).toBe(true)
      expect(bashViolation(cmd, repo), cmd).toBeNull()
    }
  })

  it('allows the exact installs inside a protected repo', () => {
    for (const cmd of EXACT) {
      expect(bashViolation(`cd ${repo} && ${cmd}`), cmd).toBeNull()
      expect(bashViolation(cmd, repo), `${cmd} (session cwd)`).toBeNull()
    }
  })

  it('refuses yarn add and yarn exec inside a protected repo', () => {
    for (const cmd of ['yarn add left-pad', 'yarn exec rm -rf src', 'yarn exec tsx build.ts', 'yarn dlx some-codemod']) {
      expect(bashViolation(`cd ${repo} && ${cmd}`), cmd).not.toBeNull()
      expect(bashViolation(cmd, repo), `${cmd} (session cwd)`).not.toBeNull()
    }
  })

  it('refuses an install with anything appended', () => {
    for (const cmd of [
      'npm install evil-pkg',
      'npm install --save left-pad',
      'npm ci --prefix=src',
      'npm ci --include=dev --cwd=src',
      'yarn --cwd src',
      'yarn --cwd src add left-pad',
      'npm --prefix src install left-pad',
      'pnpm -C src add left-pad',
      'pnpm install left-pad',
      'yarn install --modules-folder src',
      'npm i left-pad',
    ]) {
      expect(bashViolation(`cd ${repo} && ${cmd}`), cmd).not.toBeNull()
    }
  })

  it('an appended redirect is no longer hidden behind the install', () => {
    expect(bashViolation(`npm ci > ${repo}/src/index.ts`)).not.toBeNull()
    expect(bashViolation(`yarn install > ${repo}/src/index.ts`)).not.toBeNull()
  })

  it('the exemption is per-segment, so a chained non-install is still judged', () => {
    expect(bashViolation(`cd ${repo} && yarn install && yarn add left-pad`)).not.toBeNull()
    expect(bashViolation(`cd ${repo} && npm ci && yarn exec rm -rf src`)).not.toBeNull()
  })

  it('judges from the session cwd the hook payload carries', () => {
    // `cd <repo>` in one Bash call, `yarn add x` in the next: the shell kept
    // the cwd, so the second call must be judged from the repo.
    expect(bashViolation('yarn add left-pad', repo)).not.toBeNull()
    expect(bashViolation('yarn add left-pad', outside)).toBeNull()
  })

  it('leaves read-only package-manager use alone', () => {
    for (const cmd of ['npm test', 'npm run build', 'yarn test', 'pnpm run lint']) {
      expect(bashViolation(`cd ${repo} && ${cmd}`), cmd).toBeNull()
    }
  })
})

// --- readonly-repo-gate: the artifact exemption is decided PER TARGET ---
//
// Review on #770 (2026-09-26): the exemption used to test the whole segment,
// so one artifact-looking word (`node_modules/...`) exempted a command that
// also named source. Every word that resolves into a protected root must now
// itself be an artifact path, resolved the way the kernel resolves it.
describe('readonly-repo-gate: artifact exemption per target', () => {
  const home = homedir()
  const repo = join(home, 'projects', 'app')
  const outside = join(home, 'agents', 'qa-worker')

  it('refuses the two shapes the review measured', () => {
    expect(bashViolation('rm -rf src node_modules/.cache', repo)).not.toBeNull()
    expect(bashViolation(`cd ${repo} && rm -rf src node_modules/.cache`)).not.toBeNull()
    expect(bashViolation('./node_modules/.bin/yarn add x', repo)).not.toBeNull()
    expect(bashViolation(`rm -rf ${repo}/src ${repo}/node_modules/.cache`)).not.toBeNull()
  })

  it('refuses a source target hidden among artifact targets, in any spelling', () => {
    for (const cmd of [
      'rm -rf -- src node_modules',
      `rm -rf "src" 'node_modules/.cache'`,
      'rm -rf node_modules/* src/*',
      'rm -rf {src,node_modules}',
      'mv src node_modules/x',
      'mv dist src',
      'cp node_modules/x/a.ts src/a.ts',
      'cp -r dist/. src/',
      'cp -t src node_modules/x',
      'cp -tsrc node_modules/x',
      'cp --target-directory=src node_modules/x',
      'install -Dm644 node_modules/x src/y',
      'echo x | tee src/a.ts node_modules/.cache/x',
      'git rm -r src node_modules',
      'sed -i s/a/b/ src/a.ts node_modules/x',
      'sudo rm -rf src node_modules',
      'env rm -rf src node_modules',
      'FOO=1 rm -rf src node_modules',
      '(rm -rf src node_modules)',
      'bash -c "rm -rf src node_modules"',
      'rm -rf node_modules && rm -rf src',
      'rm -rf node_modules; rm -rf src',
    ]) {
      expect(bashViolation(cmd, repo), cmd).not.toBeNull()
    }
  })

  it('an artifact directory is not a way out through .. or shell expansion', () => {
    for (const cmd of [
      'rm -rf node_modules/../src',
      'rm -rf node_modules/.cache/../../src',
      'rm -rf ./dist/.././src',
      `rm -rf ${repo}/node_modules/../src`,
      'echo x > node_modules/../src/a.ts',
      `echo x > ${repo}/dist/../src/a.ts`,
      'rm -rf node_modules/{..,x}/src',
      'rm -rf node_modules/[.][.]/src',
      'rm -rf node_modules/.?/src',
      'rm -rf node_modules/$X/src',
      'rm -rf node_modules/`echo ..`/src',
      "rm -rf $'node_modules/../src'",
    ]) {
      expect(bashViolation(cmd, repo), cmd).not.toBeNull()
    }
  })

  it('a safe-looking tail no longer exempts the segment', () => {
    // GIT_SAFE_RX was unanchored: the segment was skipped if it merely ENDED
    // in a branch switch or CONTAINED `git worktree list`.
    expect(bashViolation('rm -rf src git checkout main', repo)).not.toBeNull()
    expect(bashViolation('rm -rf src # git worktree list', repo)).not.toBeNull()
    expect(bashViolation('echo x > src/a.ts # git worktree list', repo)).not.toBeNull()
    expect(bashViolation('git checkout main', repo)).toBeNull()
    expect(bashViolation('git worktree list', repo)).toBeNull()
  })

  it('finds the repo behind ~, $HOME and relative paths from outside it', () => {
    for (const cmd of [
      'rm -rf ~/projects/app/src',
      'rm -rf $HOME/projects/app/src',
      'rm -rf ${HOME}/projects/app/src',
      '(cd ~/projects/app && rm -rf src node_modules)',
      `cd ${home} && rm -rf projects/app/src node_modules`,
      `cd ${home} && cd projects/app && rm -rf src`,
      `echo ${repo}/src | xargs rm -rf`,
    ]) {
      expect(bashViolation(cmd, outside), cmd).not.toBeNull()
    }
    expect(bashViolation('rm -rf ../../projects/app/src', outside)).not.toBeNull()
    expect(bashViolation('rm -rf projects/app/src', home)).not.toBeNull()
  })

  it('refuses package-manager writes with the flags in front of the subcommand', () => {
    for (const cmd of [
      'yarn --cwd src add left-pad',
      'npm --prefix src install left-pad',
      'pnpm -C src add left-pad',
      'yarn --cwd src',
    ]) {
      expect(bashViolation(cmd, repo), cmd).not.toBeNull()
    }
  })

  it('still allows commands whose every repo target is an artifact', () => {
    for (const cmd of [
      'rm -rf node_modules',
      'rm -rf node_modules/.cache dist',
      'rm -rf node_modules/*',
      'rm -rf node_modules /tmp/x',
      'mkdir -p node_modules/.cache',
      'mv node_modules/x dist/y',
      'touch dist/x',
      'cp /tmp/x.txt dist/x.txt',
      'echo x > dist/out.txt',
      'echo x > node_modules/.cache/x',
      'rm -rf /tmp/x',
      'grep -rn foo src',
      'cat src/a.ts | grep x',
    ]) {
      expect(bashViolation(cmd, repo), cmd).toBeNull()
    }
    expect(bashViolation(`rm -rf ${repo}/node_modules ${repo}/dist`)).toBeNull()
    expect(bashViolation(`cat ${repo}/a | tee /tmp/out`, outside)).toBeNull()
    expect(bashViolation('rm -rf src', outside)).toBeNull()
  })
})

// The hook as the runtime calls it: a real root on disk (READONLY_REPO_ROOTS),
// a JSON payload on stdin. This is where a symlinked workspace package counts:
// `node_modules/@ws/core` pointing back at `packages/core` is SOURCE.
describe('readonly-repo-gate: the hook end to end', () => {
  const script = join(__dirname, '..', '..', 'scripts', 'readonly-repo-gate.mjs')
  const root = mkdtempSync(join(tmpdir(), 'rorg-'))
  const repo = join(root, 'app')
  mkdirSync(join(repo, 'packages', 'core', 'src'), { recursive: true })
  mkdirSync(join(repo, 'node_modules', '@ws'), { recursive: true })
  mkdirSync(join(repo, 'node_modules', '.cache'), { recursive: true })
  symlinkSync(join(repo, 'packages', 'core'), join(repo, 'node_modules', '@ws', 'core'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const run = (payload: Record<string, unknown>) => {
    const r = spawnSync(process.execPath, [script], {
      input: JSON.stringify(payload),
      env: { ...process.env, READONLY_REPO_ROOTS: root },
      encoding: 'utf-8',
    })
    return r.stdout.includes('"permissionDecision":"deny"') ? 'deny' : 'allow'
  }

  it('refuses a write through a symlinked workspace package', () => {
    expect(run({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'rm -rf node_modules/@ws/core/src' } })).toBe('deny')
    expect(run({ tool_name: 'Write', cwd: repo, tool_input: { file_path: join(repo, 'node_modules', '@ws', 'core', 'src', 'a.ts') } })).toBe('deny')
  })

  it('refuses a Write whose artifact directory is climbed out of with ..', () => {
    expect(run({ tool_name: 'Write', tool_input: { file_path: join(repo, 'node_modules') + '/../packages/core/src/a.ts' } })).toBe('deny')
    expect(run({ tool_name: 'Edit', tool_input: { file_path: join(repo, 'packages', 'core', 'src', 'a.ts') } })).toBe('deny')
  })

  it('allows real artifact writes and the review shapes are denied', () => {
    expect(run({ tool_name: 'Write', tool_input: { file_path: join(repo, 'node_modules', '.cache', 'x') } })).toBe('allow')
    expect(run({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'rm -rf node_modules/.cache' } })).toBe('allow')
    expect(run({ tool_name: 'Bash', cwd: repo, tool_input: { command: 'rm -rf packages node_modules/.cache' } })).toBe('deny')
    expect(run({ tool_name: 'Bash', cwd: repo, tool_input: { command: './node_modules/.bin/yarn add x' } })).toBe('deny')
  })
})

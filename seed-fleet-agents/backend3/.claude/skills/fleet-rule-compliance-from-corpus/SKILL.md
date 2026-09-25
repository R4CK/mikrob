---
name: fleet-rule-compliance-from-corpus
description: Measure whether a fleet rule is ACTUALLY being followed, from the agent session transcripts (the real command corpus), instead of arguing from anecdote. Use before any "the rule is being bypassed, build a hook" decision, and before reporting a zero.
---

# Measuring fleet-rule compliance from the real command corpus

## When to use

- A rule says "always do X through script Y" and someone claims it is being bypassed.
- A scheduled review is due on whether to escalate prose -> PreToolUse hook (rule 14/15/16/17 shape).
- Before reporting "zero violations" on anything.

CLAUDE.md rule 17 says it outright: *"a hook eseteinek a VALÓDI parancs-korpuszból kell jönniük, nem
a fenyegetés-modellből"*. This skill is how you get that corpus.

## Where the corpus is

`/home/neon/marveen/agents/backend/.claude-config/projects/*/` -- one dir per agent project, each
holding `<session-uuid>.jsonl`. Every agent's sessions are visible from here, not just your own.

Each line is a JSON record; a command lives at
`message.content[] -> {"type":"tool_use","name":"Bash"} -> input.command`, with `timestamp` and `cwd`
on the record.

**`find` returns nothing here** (the path crosses a symlink boundary and silently yields 0). Use
`glob.glob` in Python, or a shell `*` glob. Do not conclude the corpus is empty.

## Procedure

1. Extract INVOCATIONS, not mentions (see Pitfalls -- this is where the number gets inflated 10x).
2. Split the timeline on **when the tool became available**, not when the rule was announced.
   Runs made while the script did not yet exist are not bypasses; counting them manufactures a
   worsening trend out of nothing.
3. Classify exempt cases out. (Rule 17 exempts targeted runs; only FULL suites are covered.)
4. **Run the detector against its founding cases before reporting a zero.** Name the specific
   incidents the rule was written from and confirm your tool finds them. If it cannot see them,
   your zero is a blind tool, not a clean corpus.
5. Enumerate the SUPERSET when a filter could hide cases: drop the repo/scope filter, list every
   remaining hit by hand, and confirm each is genuinely out of scope. A filter you cannot audit is
   an assumption.

`scripts/suite-bypass-measure.py` is the worked implementation for rule 17; adapt the regexes.

## Pitfalls

- **Substring `vitest` is not an invocation.** It also matches `pgrep -f vitest`,
  `cat vitest.config.ts`, `ls | grep vitest`, and Hungarian prose inside a heredoc body being
  written to a file. Measured: 2244 of 12195 hits were pure mentions. Require an executable token
  plus the subcommand (`(?:\S*/)?vitest(?:\.mjs)?\s+run\b`), and strip heredoc bodies first.
- **Positional args mean targeted.** `vitest run proof-storage-adapters.test` has no path and no
  `.test.ts` suffix but is still a filter, so it is exempt. Full = after `run`, only flags. Getting
  this wrong reported 30 violations where there were 5.
- **The per-agent project dirs are SYMLINKS to one corpus -- globbing them counts every session
  once per agent.** `agents/*/.claude-config/projects/*/*.jsonl` returned 7560 files and a tidy 268
  hits for each of 15 agents, with identical timestamps: that is the same 504 files read 15 times.
  Dedupe on `os.path.realpath` before counting anything. Identical per-agent totals are the tell.
- **A redirection is not a positional argument.** `npx vitest run 2>&1 | tail -15` is a FULL suite,
  but a naive "first non-flag token means a filter" reads `2>&1` as the filter and files it as
  targeted. That one bug turned 89 full-suite bypasses into 1, i.e. it inverted the conclusion.
  Strip `2>&1`, `>`, `>>`, `&>`, `<` before deciding, and assert the classifier on a hand-written
  case of each shape before trusting its counts.
- **`cwd` is not the target repo.** An agent sitting in its CleanCore worktree can run another
  project's suite (measured: Ingatlan). Let an explicit path in the command win over `cwd`.
- **Path-keyed repo detection is blind to disposable worktrees.** Gates correctly run in
  `/home/neon/qa-priv-<card>-<sha>` or `/home/neon/cc-gate-<card>-<sha>`, which contain neither
  repo's normal path. Resolve those by the CARD (look the id up on the board) or by the files being
  edited, never by the directory name.
- **A signature-keyed search finds the RULE that names the signature.** Searching command output
  for `Timeout calling "onTaskUpdate"` returned 8 hits; 7 were real failures and the 8th was the
  text of rule 17 itself, quoted inside a test diff (a doc-vs-generator test prints the whole rule).
  Any rule that documents its own failure signature poisons a grep for that signature. Open each
  hit; do not report the count.
- **Prose hits swamp output hits.** The same signature matched 1500+ times across transcripts,
  almost all agents discussing the problem. Command OUTPUT (here `/tmp/claude-noisy-logs/*.log`) is
  the population of actual occurrences; the transcripts are the population of actual commands. Do
  not mix the two.
- **`/tmp/claude-noisy-logs/` is written by EVERY agent, so a log is not yours because it is the
  newest.** Picking with `ls -t | head` handed me another agent's landing failure, which I then
  reported as my own; the test named in it did not exist in any ref I could reach. Key on a value
  only your run produced (its exact test-count line, your card id, your sha) and `grep -l` for it.
  If nothing matches, your log is not there -- say so rather than taking the nearest one.
- Disposable worktrees are deleted after use, so `git -C <dir> remote` gets you nothing after the
  fact. The card id embedded in the directory name is the durable evidence.

## Verification

- [ ] Mentions separated from invocations, and the mention count reported (a zero mention count on
      a prose-heavy corpus means the stripper is broken).
- [ ] Timeline split on tool availability, with the creating commit's date quoted.
- [ ] Exempt category counted, not silently dropped -- if exempt is also zero, the agents may simply
      not have been working in that repo, and your compliance number means nothing.
- [ ] Founding cases located by the tool, by name.
- [ ] Superset enumerated and each out-of-scope hit accounted for individually.

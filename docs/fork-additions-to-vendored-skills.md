# Fork additions to vendored skills

Three skills we vendor from an external repo carry content this fork wrote. This file records
which passages those are, so a future re-vendoring does not delete them by accident.

Origin: card `4a3c75a5`, from a Cybersec measurement on the `4276708e` gate (2026-09-04).

## Where the content lives, and where it does not

The fork-owned, git-tracked copies are:

    seed-skills/sp-receiving-code-review/SKILL.md
    seed-skills/sp-verification-before-completion/SKILL.md
    seed-skills/sp-test-driven-development/writing-good-tests.md

Those are the source of truth and they are safe: they are in this repo, tracked and pushed.

The **delivered** copies the agents actually read are not in this repo. `~/.claude/skills/sp-*` are
symlinks into a vendored third-party checkout (`~/.claude/external/superpowers`), and the additions
exist there only as uncommitted modifications to that checkout, written by `update.sh`. A
`git checkout` or a vendor refresh in that repo reverts them until the next `update.sh` run
re-merges. That delivery mechanism is a separate question, deliberately not changed here.

## What was added (measured against the vendor's own HEAD: 70 lines, zero deletions)

### `sp-receiving-code-review/SKILL.md` (+8)

A closing **The Bottom Line** section: external feedback is suggestions to evaluate, not orders to
follow -- verify, question, then implement; no performative agreement.

Why it is ours: the fleet's gates produce a lot of review feedback, and an agent that implements
every suggestion verbatim launders a reviewer's guess into a change nobody verified.

### `sp-verification-before-completion/SKILL.md` (+30)

Three additions:

1. An opening line: claiming work is complete without verification is dishonesty, not efficiency.
2. **The bare-`grep` trap** -- an agent's interactive shell defines `grep` as a function that
   prepends `--ignore-files -I`, so a typed `grep` silently skips `.gitignore`d paths and
   binary-looking files. On a secret sweep that is exactly the wrong half to skip, since `.env`,
   `store/` and `agents/` are usually gitignored. Measured on a 3-file probe: bare `grep -rl` found
   1 of 3, `grep -ral` 2 of 3, `command grep -ral` 3 of 3. Scripts run as subprocesses are not
   affected; what you TYPE is. Plus the matching entry in the "not verification" list.
3. A **Why This Matters** section drawn from 24 failure memories.

Why it is ours: the measured numbers are the substance. Without them the section is an opinion, and
this fork has had real incidents where a bare-`grep` zero-hit was accepted as proof of absence.

### `sp-test-driven-development/writing-good-tests.md` (+32)

A **Short-circuit operator vacuous fixture trap** section: when the code under test uses `??`, `||`
or a ternary, a fixture can make two distinct code paths produce the same output, so the test
cannot catch a mutation. Worked example with the fix (`completionRate: 73` instead of `0`).

Why it is ours: it came out of a real vacuous test in this codebase, and it is the reasoning behind
the mutation-testing discipline the gates apply.

## If you are taking a vendor update

Re-copying these three files from upstream drops all 70 lines in one commit, and nothing in the
vendor's history will mention them. Merge instead of copying, then run:

    npx vitest run src/__tests__/vendored-skill-fork-additions.test.ts

That test pins a distinctive phrase from every added passage. If it fails after a re-vendoring, the
re-copy lost fork content -- restore the passages rather than deleting the expectation.

---
name: guards-that-pin-behaviour
description: Write a guard test that pins the OPERATION, not its spelling. Use when adding or reviewing a test that reads source text, greps for a symbol or literal, or asserts that some shape is present/absent in a file. Triggers - "guard test", "assert the pattern is not reintroduced", "check the source for", "regression guard", "or-teszt", "ne jojjon vissza a bypass", a gate finding that a mutant kept the suite green.
---

# Guards that pin behaviour, not spelling

Distilled from FIVE measured failures of the same class in one day (2026-09-05, cards a14812e8,
06d36307-F1, 43ecdbe6, f698828b, 05864b8a). In every one, a guard test looked correct, ran green,
and could be walked past by writing the same thing differently. Three of the five were my own.

Extended 2026-09-11 (card 7bb39672 / d77424c1) after the same class cost the fleet eleven hours of
blocked landings, and after THREE INDEPENDENT AGENTS wrote a vacuous version of the same guard on
the same day -- each found it by mutation, none by reading.

## When to use
Any test whose evidence is the CONTENT of a file: a regex over source, a "the symbol is present"
check, a "this shape must not come back" guard, a config-file scan. Not for ordinary behavioural
tests that call the code.

## Procedure

1. **Ask the tool for the resolved VALUE first.** Before matching source text, check whether the
   thing under test can just be asked. Adding a read-only flag that prints what the code would
   actually use is usually a few lines, and nothing a person writes can answer it wrongly.
   *Measured*: `fleet-test.sh` gained `--lock-path`; the guard now asserts the lock file the run
   resolves instead of pattern-matching the assignment.

2. **Then vary the input until right and wrong DIVERGE.** A value assertion inherits a new way to be
   vacuous. *Measured*: on the default tree the correct (`${ROOT}-test.lock`) and broken
   (`${TEST_TREE}.lock`) formulas print the SAME string, so the assertion passed on the mutant.
   Only an overridden `FLEET_TEST_TREE` separated them -- plus a control proving the variable is
   read at all, or a script ignoring the environment would satisfy the invariance perfectly.

3. **If you must read text, strip comments first, and ANCHOR to the line that does the work.** A
   presence check is satisfied by a COMMENT quoting the shape it wants. *Measured*: a per-tree lock
   plus one commented-out canonical line produced `problems() === []` -- total silence on a
   reintroduced bypass.
   *The sharper form of this, measured 2026-09-11*: the comment that vouches is often **the guard's
   own explanation**. You write "--minWorkers must travel with --maxWorkers, because vitest 2.x
   rejects a lone --maxWorkers", then check `if (/--maxWorkers/.test(src) && !/--minWorkers/)`. Delete
   the flag from the line that actually reaches the tool and the guard stays green: your rationale
   still contains the word. Three agents hit exactly this on one file in one day. Fix: strip comment
   lines AND match the assignment/invocation line itself
   (`lines.filter(l => /WORKER_ARGS=\(/.test(l))`), never the file.

4. **Prefer INVERSION over enumerating syntaxes.** If the guard lists the shapes it knows
   (`new Set([...])`), tomorrow brings the shape it does not. Forbid the thing every shape needs --
   usually the literal itself -- outside the one module allowed to have it. *Measured*: an array
   copy and an `===` chain both kept a file 7/7 green; forbidding the literal covers Set, array,
   `===`, `switch` and `case` at once without naming any.

5. **Make exceptions a CATEGORY, not a list of filenames.** "Tests may spell it out" does not rot;
   four filenames do. Measure the exception set before choosing: if it is huge, the inversion is
   wrong for this case.

6. **Measure where the line sits against the REAL corpus, not against the threat model.** A stricter
   rule that fires on honest code is the guard people switch off. *Measured*: matching the bare word
   instead of the quoted literal would have covered a regex form AND turned two honest occurrences
   (a generated-section marker, a log-message prefix) into false positives. The regex form is a
   STATED gap instead.

7. **Mutation-test in BOTH directions whenever the fix splits a predicate.** Narrower (the branch is
   gone) is the one you think of; WIDER is the one that silently deletes real signal. *Measured*:
   `&&` widened to `||` turned three cases red, including a pre-existing one, where the narrow
   mutant turned one.

8. **Assert non-vacuity in the guard itself.** A walker that silently stops parsing, or a reader
   that finds zero files, looks exactly like a clean tree. Assert the counted population
   (files scanned, services found, tests run) so an inert reader fails instead of passing.

9. **"Passed" is not "accepted".** A guard can prove an argument is computed, derived from the right
   source, and present on every call site -- and the tool can still REFUSE it and do nothing.
   *Measured*: `fleet-test.sh` gained a worker cap (`--maxWorkers $((CORES / CPU_SLOTS))`); its
   contract test asserted the cap was computed, derived from CORES/CPU_SLOTS, and carried by every
   invocation, and stayed fully green while vitest 2.1.9 threw at pool construction
   ("options.minThreads and options.maxThreads must not conflict") and ran ZERO tests -- 136ms,
   non-zero exit, every landing for every agent refused with what looked like a test regression.
   The same flag was safe in the sibling repo, which is on vitest 3.x and clamps: the pattern had
   been copied across a major version.
   Ask the acceptance question explicitly: *does the runner take these arguments?* When the answer
   cannot be automated cheaply, say so in the test rather than implying coverage --
   **and think about what you would be spawning.** Here the honest call was NOT to launch the test
   runner from inside the test suite: a shell-spawn check false-reds under exactly the CPU
   contention the cap exists to prevent, so guarding the landing gate with it trades one false red
   for another. A stated gap ("the shape is pinned; acceptance is not, and here is why") is the
   right answer more often than it feels.

## Pitfalls
- **Do not add negation or quote filters to silence a false positive.** Measured on a real corpus:
  8 of 61 matches sat on negated or quoted lines and REAL findings were among them. Report an
  ADDITIVE category instead ("header false" vs "not covered anywhere"); classification shrinks the
  human's pile, filtering hides findings.
- **Do not claim coverage you did not measure.** Run the mutant. Twice today a constant of mine
  looked like a control and was dead: raising it to `MAX_SAFE_INTEGER` changed no test. Either
  remove it, or keep it with a comment saying it is NOT a control.
- **A stated gap beats a widened pattern.** Writing "the regex form is not covered, and here is the
  measurement that stopped me widening" is worth more to a gate than silent over-reach.
- **Do not grill trivial guards.** This costs effort; spend it where the guard is load-bearing.

## Verification
- [ ] The mutant that motivated the guard turns it RED (run it, do not reason about it).
- [ ] For a split predicate, BOTH the narrower and the wider mutant turn something red.
- [ ] A control case proves the guard is not blanket-failing (an honest input stays green).
- [ ] The guard asserts its own population, so an inert reader cannot pass.
- [ ] Every limitation is written down in the test, in the words a reader would need.

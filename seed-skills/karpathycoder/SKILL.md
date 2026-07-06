---
name: karpathycoder
description: Active coding discipline that enforces Andrej Karpathy's four anti-pitfall principles for LLM-assisted development — Think Before Coding, Simplicity First, Surgical Changes, and Goal-Driven Execution. Use this skill whenever Peti asks you to write, implement, refactor, fix, or extend code, especially on non-trivial changes (>20 lines), unclear requirements, multi-step tasks, or code you don't fully understand. Triggers on "/karpathy-check", "review my changes", "don't overcomplicate", "keep it simple", "ne bonyolítsd túl", "surgical change", "minimal diff", "surface assumptions", "state tradeoffs", "success criteria", or any moment you catch yourself assuming, over-engineering, drive-by refactoring, or coding without a verifiable goal. Also use before committing to catch bloat, hidden assumptions, and diff noise.
---

# Karpathy Coder

## Purpose
LLMs make wrong assumptions and run with them, overcomplicate code and APIs, bloat abstractions, leave dead code, and code without a verifiable goal. This skill fights those four specific pitfalls with concrete discipline (and, where installed, Python detectors, a review sub-agent, and a pre-commit hook). It biases toward **caution over speed** so the code you ship is minimal, surgical, and provably correct.

## When to use
- Any non-trivial implementation (>20 lines changed).
- Code you don't fully understand or a codebase you're new to.
- Multi-step tasks with unclear or ambiguous requirements.
- Before committing — to catch bloat, hidden assumptions, and diff noise.
- When Peti says "keep it simple", "minimal diff", "don't refactor everything", or runs `/karpathy-check`.
- Relax for trivial edits (typo fixes, obvious one-liners) — use judgment.

## Instructions
Apply the four principles, in order, on every qualifying change:

**1. Think Before Coding.** State assumptions explicitly. If multiple interpretations exist, present them — don't silently pick one. If a simpler approach exists, say so and push back when warranted. If anything is unclear, stop and name what's confusing before writing code.

**2. Simplicity First.** Write the minimum code that solves the stated problem. No speculative features, no abstractions for single-use code, no unrequested "flexibility" or configurability, no error handling for impossible scenarios. If 200 lines could be 50, rewrite it. The test: *would a senior engineer call this overcomplicated?* If yes, simplify.

**3. Surgical Changes.** Touch only what the request requires. Don't improve adjacent code, comments, or formatting. Don't refactor what isn't broken. Match existing style even if you'd do it differently. Remove imports/vars/functions *your* change made unused; leave pre-existing dead code alone (mention it, don't delete it). The test: *every changed line traces directly to Peti's request.*

**4. Goal-Driven Execution.** Define verifiable success criteria, then loop until met. Transform "add validation" → "write tests for invalid inputs, then make them pass". For multi-step work, state a brief plan where each step has a check:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

If the skill package is installed, back this up with tooling: `complexity_checker.py`, `diff_surgeon.py`, `assumption_linter.py`, `goal_verifier.py` (all stdlib, run with `--help`), the `karpathy-reviewer` sub-agent, and the `hooks/karpathy-gate.sh` pre-commit hook.

## Output format
- **Before coding:** a short block listing assumptions, any open questions, and (for multi-step work) the numbered plan with per-step verification.
- **The change itself:** minimal, surgical, style-matched.
- **After coding (or `/karpathy-check`):** a brief 4-principle pass — flag any violation (bloat, hidden assumption, diff noise, missing success criteria) or state "clean" per principle.

## Examples

**Input:** "Add caching to the user lookup."
**Output:**
```
Assumptions: in-memory cache, process-local, no TTL requested.
Question: should stale entries expire? If yes, what TTL?
Plan:
1. Add dict-backed memoization to getUser() → verify: repeated call hits cache
2. Add test for cache hit + miss → verify: tests pass
```
Then the minimal cache — no Redis, no config layer, no eviction policy that wasn't asked for.

**Input:** "Fix the off-by-one in the pagination." (also spots messy formatting nearby)
**Output:** Fixes only the off-by-one, adds a test reproducing it. Does **not** reformat the surrounding block. Mentions: "Noticed inconsistent indentation in this function — leaving it; flag if you want it cleaned separately."

## Language rules
- Talk to Peti in **Hungarian** — assumptions, questions, plans, and review notes.
- Keep **English** for all code, identifiers, commit messages, test names, and technical/CLI terms (`--help`, `karpathy-reviewer`, cyclomatic complexity).
- Refer to the user only as **Peti**.

## What to avoid
- Silently picking one interpretation when several exist — surface them instead.
- Speculative generality: abstractions, config, or error handling nobody asked for.
- Drive-by refactors, reformatting, or "improving" adjacent untouched code.
- Deleting pre-existing dead code without being asked — mention it instead.
- Vague goals ("make it better") with no verifiable check to loop against.
- Applying full ceremony to trivial one-liners — match the rigor to the risk.
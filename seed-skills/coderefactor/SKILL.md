---
name: coderefactor
description: Systematically analyzes and refactors code to improve quality, readability, and structure WITHOUT changing external behavior. Use this skill whenever the user mentions refactoring, cleaning up code, reducing complexity, removing duplication, code smells, technical debt, extracting functions or components, simplifying conditionals, replacing magic numbers, dead code removal, splitting large files, or wants to make code more maintainable. Triggers on "/refactor", "refactor this", "clean up", "tisztítsd meg a kódot", "reduce complexity", "remove duplication", or any request to improve code quality while keeping behavior identical.
---

# CodeRefactor

## Purpose
This skill helps the user systematically improve the internal quality of code — readability, structure, and maintainability — while guaranteeing that external behavior stays exactly the same. It finds code smells, duplication, and complexity, then applies targeted, test-verified refactorings one safe step at a time.

## When to use
Use this skill when a felhasználó:
- Runs `/refactor [file or directory path]`
- Asks to "refactor", "clean up", or "restructure" code
- Mentions code smells, duplication, technical debt, or high complexity
- Wants to extract a function/method/component, simplify conditionals, or remove dead code
- Wants a large file split by responsibility or nesting reduced
- Says a file is "hard to read" or "messy" but must keep working identically

Do NOT use for new features, bug fixes that change behavior, or performance rewrites that alter outputs.

## Instructions
Follow these steps for Claude:
1. **Locate the target.** Read the file or directory the user provided. If none given, ask which path to refactor.
2. **Detect the test setup.** Find how tests run (package.json scripts, test runner). Run them once to confirm a green baseline. If no tests exist, warn the user and proceed with extra caution.
3. **Analyze.** Identify concrete refactoring opportunities across three categories:
   - **Structure** — extract repeated logic into functions/methods, extract reusable UI into components, move code closer to use, split large files by responsibility.
   - **Simplification** — replace complex conditionals with guard clauses, convert nested callbacks to async/await, replace magic numbers with named constants, remove dead code and unused imports.
   - **Patterns** — replace inheritance with composition, apply strategy pattern for variant behavior, use builder pattern for complex construction, introduce early returns to cut nesting.
4. **Propose.** Present a short, ordered list of specific refactorings, each with a one-line rationale. Wait for a felhasználó's go-ahead on non-trivial changes.
5. **Apply incrementally.** Make ONE logical refactoring at a time. After each step, re-run the tests. If a step breaks tests, revert it and report why.
6. **Commit atomically.** Create one focused commit per logical change with a clear message (only if the project uses git and the user wants commits).
7. **Preserve the public API.** Never change public signatures unless the user explicitly asks.

## Output format
- A brief **Analysis** section listing found issues grouped by category.
- A numbered **Refactoring plan** — each item: what + why.
- Per-step **result lines**: `✅ Step N: <change> — tests passing` or `⚠️ Step N reverted: <reason>`.
- A closing **Summary** of what changed and confirmation that behavior is unchanged.

## Examples

**Example 1**
Input: `/refactor src/utils/parser.ts`
Output: Analysis finds a 60-line `parse()` with nested ifs, two magic numbers, and duplicated token logic. Plan: (1) extract `tokenize()`, (2) replace nesting with guard clauses, (3) name the `1024`/`0xFF` constants. Applies each step, runs tests after each, reports all green, summarizes.

**Example 2**
Input: "clean up the Button component, it's a mess"
Output: Reads the component, extracts repeated class logic into a helper, removes an unused import and dead prop, converts a ternary chain to early returns. Verifies with the component test suite, confirms rendered output identical.

## Language rules
- Talk to the user in **Hungarian**. Address the user only as **a felhasználó**.
- Keep all **code, identifiers, commit messages, and technical terms in English**.
- Explanations and rationale: Hungarian prose, English technical nouns (e.g. "Kiemelem a `tokenize()` függvényt egy külön guard clause-zal").

## What to avoid
- ❌ Changing external behavior or public API signatures without explicit request.
- ❌ Applying many refactorings at once — always one atomic step, verify, then continue.
- ❌ Skipping the test run before and after each change.
- ❌ Refactoring code with no tests without warning the user first.
- ❌ Mixing bug fixes or new features into a refactoring — keep it behavior-preserving.
- ❌ Over-engineering: don't introduce patterns the code doesn't need.
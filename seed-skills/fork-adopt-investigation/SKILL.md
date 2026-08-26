---
name: fork-adopt-investigation
description: Investigate an upstream/sibling fork (or any community/open-source repo) for a reusable solution BEFORE building your own, and reach an evidence-backed adopt / adapt / build-from-scratch / no-op decision. Use whenever a task says "check fork X for feature Y", "adopt the fix from repo X", "is there a community solution", or the GitHub-first rule applies before implementing a non-trivial capability. Grep-first, fetch read-only (never merge), decide with proof. Triggers on "adopt from fork", "check the fork", "GitHub-first", "grep-first", "is there an existing solution", "port from upstream", "RULE-10".
---

# Fork / community adopt investigation

## When to use
- A task asks you to look at another fork/repo for a solution to adopt or adapt (e.g. "fork X has a fix for Y -- bring it in").
- Before building any non-trivial capability, when a "community/GitHub-first, don't reinvent" rule applies.
- Deciding between adopt (take as-is), adapt (take the idea, rewrite for your context), build-from-scratch (nothing suitable), or no-op (you already have it / it doesn't apply).

## Procedure
1. **Fetch read-only, never merge.** `git remote add <name> <url>` then `git fetch <name>`. Only read/diff. Never `git merge`/`git pull` the fork into your working branch.
2. **Locate candidates.** List branches (`git branch -r | grep <name>`), and grep the fork for the capability across likely files: `git grep -l -i "<keywords>" <name>/<branch> -- '<path globs>'`. Check commit subjects too: `git log --oneline <name>/<branch> --grep="<term>" -i`.
3. **Diff from the MERGE-BASE, not from your HEAD.** To see what the fork ACTUALLY changed, diff `git merge-base <yourbranch> <name>/<branch>` against the fork branch -- NOT your current HEAD. A large diff vs your HEAD is often just YOUR branch being ahead (their file is simply older), not a real change. This is the single most common false signal.
4. **Read the real content, not the branch name.** A branch named for feature Y often bundles UNRELATED changes; and the headline "fix" may live in a subsystem you don't have. Confirm the specific novel hunk that implements the capability.
5. **Check you don't already have it.** Diff the fork's version of the target file against yours; grep your own repo for the capability. "Already present -> no-op" is a valid, honest outcome. So is "the fix targets a file/subsystem we don't ship".
6. **Due diligence before adopting** (community-first rule): license compatibility, maintenance (last commit, stars/issues), security (known CVEs, supply-chain), size/dependency weight. When comparing MULTIPLE competing candidates, license is a FIRST-PASS filter, not a closing footnote -- check it before investing any real evaluation time, and keep it the first evaluated column in the comparison table (immediately after the candidate name, ahead of stars):

   ```markdown
   | jelölt | licenc | csillag | utolsó push | verdikt |
   |---|---|---|---|---|
   | `owner/repo` | MIT | 200 | 2026-08-18 (aktív) | ... |
   | `owner2/repo2` | **NINCS (`license: null`)** | 6 | 2026-03-09 (5.5 hónap) | **NEM -- licenc** |
   ```

   A candidate with an incompatible or missing license is eliminated at this step, before the maintenance/security/size columns are even filled in for it -- do not let it advance into a full evaluation on the strength of a compelling feature match alone (measured twice in a row, cards `e7510a83` and `ef9a7bf1`: the most-wanted candidate in each was disqualified on license, discovered late).
7. **Decide with evidence and record it.** State `adopt` / `adapt` / `build` / `no-op` + the concrete proof (diff output, grep result, commit SHA). If adapting an artifact tied to a specific person/tenant/product, DE-PERSONALIZE it. If build-from-scratch or no-op, document WHY.
8. **Integrate safely.** Shared checkout: stage only your files (never `git add -A`); keep it update-safe (runtime data in gitignored dirs, additive fork files, no upstream-core edits that would break an ff-only pull). End the card `waiting` + REVIEW stating the decision + commit (or "no code change" for a no-op).

## Pitfalls
- **Stale-merge-base diff trap** (step 3): diffing vs HEAD instead of the merge-base makes your own advancement look like the fork's change. Always merge-base.
- **Misleading branch names / bundled changes**: verify the actual hunk; the branch may also carry a separate feature already in your tree.
- **Fix targets a subsystem you lack**: the "fix" may be for a path/feature your fork doesn't have -- adopting it means pulling a whole separate epic; that is a different card, not this one.
- **Already-satisfied**: the improvement may already be in your code (e.g. you already use the correct dependency/config) -> no-op; do NOT fabricate a change to look busy.
- **Never merge the fork**; cherry-pick the idea/hunk deliberately. Remotes added are local-only and read-only.
- **De-personalize** adopted docs/configs (drop the source's person/tenant/product specifics).
- **License-last trap** (step 6): don't let the license check sit at the end of a candidate write-up as an afterthought line -- put it in the table right after the candidate name, before stars/maintenance, so an incompatible candidate is filtered out before real evaluation work (or worse, real integration work) goes into it.

## Verification
- The decision (adopt/adapt/build/no-op) is stated with reproducible evidence a gate can re-run (the exact diff/grep commands + a commit SHA, or "empty diff" for no-op).
- No fabricated code change; a no-op card carries the proof it is already satisfied / not applicable.
- Integration is shared-checkout-safe (only your files staged) and update-safe (no ff-only-breaking edits).

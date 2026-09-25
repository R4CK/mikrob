---
name: cleancore-landing-conflict-dedup
description: Use when landing a CleanCore worktree fix via cherry-pick onto fresh origin/main and the cherry-pick CONFLICTS. Before resolving the conflict by hand, check whether origin/main already carries an equal-or-better fix for the same problem (another agent landed first while you were building). If so, abort and dedup instead of force-landing redundant/inferior work.
---

# CleanCore landing conflict = dedup checkpoint, not just a merge to resolve

## When to use
Mid-landing (see the CleanCore landing pattern: worktree commit -> shared main clone ->
`git fetch origin main` -> `git checkout -b fix/<slug>-<card-id> origin/main` -> `git cherry-pick
<worktree-sha>`), the cherry-pick produces a CONFLICT. Default instinct is "resolve the conflict
and land my version." Do that ONLY after checking the alternative below -- resolving blind risks
landing a redundant or inferior fix over a better one another agent already shipped.

## Why this matters
Multiple engineering agents share one CleanCore problem space and dispatch independently. A
conflict on landing does not always mean "two unrelated changes touch the same lines" -- it
often means "someone else already fixed THIS EXACT problem" while you were building your own
version in your worktree. Measured 3x in one session (cards c0a0e94d, d4c3f427, and a
delete-privilege-guard e2e fix): in every case the conflict was caused by another agent's
already-landed, equal-or-better fix for the identical underlying bug.

## Procedure
1. On cherry-pick conflict, do NOT immediately resolve hunks by hand.
2. First read what's actually on origin/main now for the conflicting file/region:
   `git diff origin/main -- <file>` or just read the file at `origin/main` (`git show
   origin/main:<file>`).
3. Ask: does origin/main's current version already solve the SAME underlying problem the card
   asked for (even if implemented differently)? Compare against the card's actual acceptance
   criteria, not just "is there a diff here."
4. If YES, origin/main's fix is equal or better:
   - `git cherry-pick --abort`
   - `git checkout main && git branch -D fix/<slug>-<card-id>` (delete the throwaway branch)
   - VERIFY the already-landed fix live (run the actual test, don't just read the code) --
     this is the proof you report, not "I assume it's fine because it merged."
   - Your own worktree commit stays local/unpushed, nothing to clean up there (it was never
     pushed to the shared worktree remote in this flow).
   - Report in the card's REVIEW comment: "mar megoldva, jobb/egyenerteku megoldassal, nem sajat
     munkambol -- eldobtam a sajat commitomat, nem en zarom le kod-valtoztatassal" + the live
     verification evidence + the Gate-SHA of the ALREADY-LANDED fix (not yours).
5. If NO, origin/main's version does NOT solve the same problem (genuinely unrelated conflict,
   or a partial/inferior fix):
   - Resolve the conflict normally, keeping your fix's actual behavior.
   - Proceed with the normal landing sequence (merge --no-ff, push, verify).
6. Either way, do not silently drop the finding -- if you're aborting because someone beat you to
   it, that's worth a one-line note to MikroB if it's the 2nd+ occurrence in a session (signals a
   dispatch-overlap pattern worth surfacing, not just an individual coincidence).

## Pitfalls
- Don't judge "already fixed" by file-level diff alone -- a file can differ for unrelated reasons
  while the actual bug is still open, or vice versa (different code, same fix). Compare against
  the card's acceptance criteria.
- Don't skip live verification of the already-landed fix just because it merged cleanly on
  origin/main -- "landed" is not "landed correctly" ([[committed-is-not-landed]]-adjacent: here
  it's "merged is not verified").
- Don't force-push or override the conflict resolution to prefer your version "because you did
  the work" -- if origin/main's fix is equal-or-better, redundant code is a cost (review burden,
  drift risk), not a contribution.

## Verification
- [ ] Compared origin/main's current state against the card's actual acceptance criteria, not
      just diff noise.
- [ ] If deduping: cherry-pick aborted, throwaway branch deleted, already-landed fix verified
      LIVE (test run, not just read).
- [ ] REVIEW comment states clearly which SHA is the real fix and that no new code landed from
      you.

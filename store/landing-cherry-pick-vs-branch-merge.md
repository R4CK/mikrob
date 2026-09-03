# Landing: cherry-pick or branch-merge?

`store/cleancore-land.sh` and `store/marveen-land.sh` merge a **branch**. They do not land
a card. Everything sitting on that branch below the commit you care about goes with it,
gated or not.

## What the lander already checks, and what it does not

As of card dfff9b37 both landers check this themselves -- see "Built" below. The rest of this file
explains what they check, and the cherry-pick recipe they cannot perform for you.

`cleancore-land.sh` refuses if the gated SHA is not the branch **tip**
(it dies with `branch ... tip is ... but the GATED sha is ... -- the extra commits are ungated`).
That closes
one half of the problem: a branch that moved on after its verdicts cannot be landed at its
tip.

It did **not** look **downwards** until card dfff9b37. Nothing checked what sat between
`origin/main` and the gated SHA. So the case it could not see was the one that actually happens: the gated SHA *is*
the tip, and underneath it sit other cards' commits that were never gated — because the
agent finished a card, self-advanced, and kept building on the same branch.

## The rule

Before landing, ask what else rides along:

```bash
git log --oneline origin/main..<gate-sha>      # CleanCore
git log --oneline origin/develop..<gate-sha>   # marveen
```

- **Exactly the commits of the card you are landing → branch-merge.** Use the lander.
- **Anything else in that list → cherry-pick.** Put the card's own commit(s) on a fresh
  branch off current `origin/main` (or `origin/develop`) and land that. The lander has no
  cherry-pick mode; this step is manual.

"Anything else" includes a commit already landed by another route. It will not corrupt
anything, but it makes the merge harder to read and to revert.

## Re-gating the cherry-pick (minutes, not a new round)

A cherry-pick produces a new SHA, so the verdict has to be carried over. Do not re-review;
**measure that the content is identical**:

1. **Ancestry** — the unwanted commit must be gone, and the new commit list must be what you
   expect:
   ```bash
   git merge-base --is-ancestor <unwanted-sha> <new-sha> && echo "STILL THERE"
   git log --oneline origin/main..<new-sha>
   ```
2. **Blob identity, per file** — stronger than "the diff is empty", because it compares the
   stored objects rather than a rendering of them:
   ```bash
   git rev-parse <old-sha>:<path>
   git rev-parse <new-sha>:<path>
   ```
3. **For a file that does differ** — diff each commit against **its own base**, not against
   the other commit. A rebase moves the surrounding context, so a differing blob is usually a
   neighbouring line belonging to a card you deliberately left behind, not a change to the
   work under review:
   ```bash
   git diff <old-base> <old-sha> -- <path>
   git diff <new-base> <new-sha> -- <path>
   ```
   Identical hunks mean the card's own change survived intact.

If all three hold, the verdict transfers. Say so in the card comment, naming both SHAs.

## The consequence people miss

**Asking a lower card for an amendment rewrites every SHA above it.** If a gate asks card A
for a one-line fix while card B is stacked on A's commit, amending A destroys the gate SHA
B was reviewed at — the commit the verdict names stops existing. Say this at verdict time,
not at landing time. The usual resolution is to cherry-pick B and land it independently,
since B's content rarely depends on A's.

## Built (card dfff9b37) -- the landers now ask this for you

The downward check is no longer a habit this file has to remind anyone of. Both landers read the
range themselves and print what rides along, grouped by the card each commit names:

```bash
cleancore-land.sh <cardId> <sha>          # REFUSES when a commit names a DIFFERENT card
marveen-land.sh <agent>                   # REPORTS the same listing
marveen-land.sh <agent> --card <id>       # ...and refuses, once you claim a card
```

Escape hatch, kill switch, and the reasoning behind every judgement call live in
`store/landing-downward-check.sh` (shared verbatim by both landers so they cannot drift):

- `--allow-stacked <cardId>[,<cardId>...]` -- take the foreign cards ON PURPOSE. It requires you to
  NAME them; there is deliberately no blanket `--force`.
- `LANDING_DOWNWARD_CHECK=off` -- turn the check off entirely, without a commit.
- A commit naming **no** card is not judged, only listed. Measured: 5 of CleanCore's last 40
  non-merge commits and the majority of marveen's carry no card reference, so fail-closed there
  would have fired on the guard's own blind spot rather than on the defect.
- The unit of judgement is the **commit**, not the card id: `1a61865f` is one commit reading
  `(card e90505bb / 96ff46d4)` and belongs to both.

**What this file is still for.** The check tells you a foreign card is in the range; it does not
cherry-pick for you. The recipe below -- the fresh branch, and the three-step re-gating that carries
the verdict across the new sha -- is the part that stays manual. So is the consequence at the end,
which the landers cannot see at all.

Replayed over the last 14 landings in each repo before it was trusted: it would have refused 5 of
14 on CleanCore (one of them `13a73c82`, carrying `d284193f` -- literally one of the three cases
below) and 1 of 14 on marveen. The rest passed untouched.

## Why this file exists

Measured on 2026-09-02, three cards in a row on one branch (`agent/backend/work`):

- **19c4684a** — gated at a SHA that *was* the tip, so the existing check passed, while its
  history carried an ungated commit (45b29528). Caught in the tsc phase, before the push.
  Landed by cherry-pick instead.
- **d284193f** — by then the same branch stacked four cards' work: one ungated, one still
  awaiting a verdict, one already landed by cherry-pick, and the card being landed.
- **45b29528** — the card whose requested amendment would have rewritten the base under both
  of the above.

Nothing was lost in any of the three, because the question was asked before the merge and not
after. That is the whole point of the file.

---
name: shared-checkout-safe-commit
description: Safe git commit procedure for the fleet's shared working tree. Prevents staging contamination when multiple agents modify files concurrently. Use whenever committing in a shared CleanCore/marveen checkout.
---
# Shared Checkout Safe Commit

## When to use
Any `git commit` on a shared working tree where multiple fleet agents could have staged files
(CleanCore: `fron-ted`, `backend-architect`, `fullstack-mvp-builder`, etc. share one checkout).

## The contamination risk
If another agent ran `git add <their files>` before your commit, those files are already in the
index. Your `git commit` sweeps them in even if you never staged them. This is the `2047b6e`
incident: fron-ted committed 8 files instead of 2 because the backend agent had pre-staged
`crew-statistics-http.ts` and friends. The SAME class recurred the other way round in the marveen
repo itself (card dc185b52): backend2 staged its own files, QA committed in the same checkout before
backend2 could, and QA's commit swept backend2's staged files in and pushed them -- landing
backend2's work with no gate of its own.

**marveen's fix (final, card dc185b52) is full per-agent worktree isolation, the SAME pattern
CleanCore already proved out** -- not the branch-only Step 0 tried first. That attempt (`store/
agent-branch.sh`, retired) ran `git checkout` on the ONE shared working tree every agent's ordinary
Read/Edit/Write tool calls also target; Cybersec live-reproduced a TOCTOU race where a checkout
landing mid-way through a DIFFERENT agent's Read-old -> think -> Write-new sequence silently (no git
error, no conflict) overwrote that agent's already-committed branch content in the working tree --
worse than the original incident, which only misattributed work under the wrong SHA rather than
losing it. A branch switch on ground other tools can write into at any moment cannot be made safe by
a point-in-time dirty check; the ground itself has to stop being shared. A worktree closes that
structurally: its own index, its own checked-out files, nothing here ever runs `git checkout`
against a path any other agent's tools might be touching.

## Safe procedure (always follow this order)

### Step 0 (marveen repo -- for the WHOLE work session, not just before commit)
```bash
bash store/agent-worktree-marveen.sh <your-agent-name>
# prints: path:   /home/neon/marveen-agent-worktrees/<you>
```
Idempotent -- creates (or tops up) your own worktree on `agent/<you>/work` the first time, confirms
it the rest of the time. **From here on, every Read/Edit/Write/Bash you do against a marveen repo
FILE targets that path, not `/home/neon/marveen` directly** -- this is the actual isolation, and it
has to hold for the whole session touching this repo, not just the commit step. Running the script
once and then continuing to edit `/home/neon/marveen/...` paths anyway defeats it completely; the
race Cybersec found was never about the script call itself, it was about which directory your edits
land in. Resolve the path via the script every time -- never hardcode it, the root is configurable
(`MARVEEN_WORKTREES`) and a stale hardcoded guess is how this kind of fix quietly stops applying.

### Step 1 -- check what is already staged BEFORE you add anything
```bash
git diff --staged --name-only
```
If ANY of these files are NOT yours: DO NOT git add yet. Wait for the other agent to commit,
or coordinate (notify MikroB via inter-agent message).

### Step 2 -- stage ONLY your specific files by name
```bash
git add apps/web/src/features/workforce/crewStatsApi.ts \
        apps/web/src/features/workforce/CrewOwnPerformancePage.tsx
# etc. -- NEVER git add -A or git add .
```

### Step 3 -- verify staging area after add
```bash
git status
git diff --staged --name-only
```
Confirm: only your files appear in the staged section. If foreign files appeared (another agent
staged them between your Step 1 check and your `git add`), unstage theirs:
```bash
git restore --staged apps/api/src/some-other-agents-file.ts
```

### Step 4 -- check for index.lock before committing
```bash
ls .git/index.lock 2>/dev/null && echo "LOCK EXISTS -- another git process is running"
```
If the lock exists and no git process is actively running (stale lock from a crash):
```bash
rm -f .git/index.lock
# Then re-run git add + verify staging (Step 2+3 again -- the rm clears all staged changes)
```
Note: `rm -f .git/index.lock` clears ALL staged changes (the index is wiped). Always redo
`git add <your files>` after removing the lock.

**For marveen specifically, once you are actually working inside your own worktree (Step 0), Steps
1-4 are redundant -- your worktree has its OWN index (`.git/worktrees/<you>/index`), so no peer's
`git add` can land in it and no peer's commit can sweep your files. Keep doing them anyway: they are
cheap, and they are the last line of defense on any repo (CleanCore's shared `$CLEANCORE_MAIN`
included) where the isolation assumption turns out to be wrong for a reason nobody's found yet.**

### Step 5 -- commit with an in-the-same-Bash-call pattern
`git add` and `git commit` MUST be in the SAME Bash tool call. If split across calls, the shell
state resets and the staged files are gone.

```bash
git add file1.ts file2.tsx && git commit -m "$(cat <<'EOF'
feat(fe): your commit message

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

### Step 6 -- land BEFORE posting REVIEW (marveen's landing step: store/marveen-land.sh, card dc185b52)
`git commit` on Step 5 only committed to YOUR branch (`agent/<you>/work`, in your own worktree from
Step 0) -- develop hasn't moved yet, so a REVIEW naming that commit as a Gate-SHA on develop would be
a false claim, same failure class as `2a3d06a6` (a REVIEW claimed landed when the commit only
existed locally). Land it yourself right after committing -- do not wait for MikroB's periodic sweep,
that exists as a backstop for anyone who didn't, not as the primary path. Run this from ANYWHERE
(it operates on `$MARVEEN_MAIN`, default `/home/neon/marveen`, and its own throwaway worktree -- not
your worktree, not the shared checkout):
```bash
bash store/marveen-land.sh <your-agent-name>
```
This merges your branch into develop in a throwaway detached worktree (never yours, never the shared
checkout), checks BOTH sides' lines survived the merge (a clean merge is not proof nothing was
dropped), runs `store/fleet-test.sh` on the MERGE RESULT (not your branch alone -- it can catch a
break that only shows up combined with what another agent already landed), and only then pushes to
origin and reports `LANDED <branch> -> origin/develop (<sha>)`. **That reported sha is your
Gate-SHA.** A refusal (conflict, seam loss, or a failing fleet-test) means nothing was pushed and
your branch/worktree are untouched -- fix it and re-run, never force past it. You do not need to
`git push` your own branch separately; `marveen-land.sh` pushes the MERGE to develop, not your
branch. Your own worktree is NOT auto-reset after landing (same as CleanCore's landing script) --
sync it yourself when you want to (`git fetch origin develop && git merge --ff-only origin/develop`
inside your worktree), there is no requirement to before starting your next card.

Then confirm it actually landed before writing REVIEW:
```bash
git -C /home/neon/marveen rev-parse origin/develop
# Must match the sha marveen-land.sh printed after LANDED. If it doesn't, don't post REVIEW yet.
```

## Shared files (i18n, global.css, rbac.ts)
Files edited by multiple agents simultaneously (e.g. all 7 locale JSONs, `global.css`,
`rbac.ts`) are the highest contamination risk. See `[[shared-file-commit-entanglement]]`
memory for the full pattern. Short version: whoever is committing first gets a clean diff;
the second agent's `git add` will include the first agent's already-committed changes in the
diff if they re-edited the same file.

Solution: if you share a file with another agent, SEQUENCE commits:
1. Check if the other agent has pending (uncommitted) edits to the shared file: `git diff <file>`
2. If they do: notify MikroB, have them commit first
3. Then you commit (your delta is clean in `git diff` after their commit)

## Buktatók
- `rm -f .git/index.lock` clears the ENTIRE index, not just the lock. All staged files must be
  re-added after this.
- `git add -A` or `git add .` in a shared checkout = certain contamination. Never.
- Checking `git diff --staged` AFTER adding but BEFORE committing is the last safety gate.
- If you detect your commit swept in foreign files (check `git show --stat HEAD`), immediately
  notify MikroB so the affected agent's card stays correctly staged for their own commit.
- `store/fleet-test.sh` with no `--ref` tests the local git HEAD, NEVER your uncommitted working
  tree. Running it "before I commit" as a pre-flight check silently tests the OLD code and can
  report a false "N/N green" for a fix that isn't in HEAD yet (2026-08-12 incident, card 4638c14c:
  a security-fix review claimed green based on the pre-commit run, but Cybersec's independent
  test on the actual commit found a real bypass the stale run never exercised). Correct order:
  commit first, THEN `store/fleet-test.sh --ref <the new SHA>` to verify what actually landed.
- Committing is not landing (card 2a3d06a6). `git commit` never pushes on its own. In the marveen
  repo, committing lands you on YOUR branch, inside YOUR worktree (Step 0) -- develop only moves once
  `store/marveen-land.sh` merges, verifies and pushes it (Step 6). A REVIEW comment with a Gate-SHA
  that only exists on your branch, not on origin/develop, is a false claim.
- Skipping Step 0 (or running it once and then going back to editing `/home/neon/marveen/...` paths
  directly) re-opens exactly the entanglement this skill exists to close -- see card dc185b52. A
  point-in-time script call is not the protection; working inside your own worktree for the WHOLE
  session is. This is why the earlier branch-only fix (`store/agent-branch.sh`, retired) failed: it
  positioned itself as a pre-commit step, but the race it needed to close happens during ordinary
  Read/Edit/Write, long before any commit is attempted.
- `store/agent-branch.sh` and `store/agent-branch-land.sh` are RETIRED (card dc185b52, Cybersec
  NO-GO with a live-reproduced TOCTOU race on the former). If you see either referenced anywhere
  (an old card, a stale note), that reference is stale -- use `store/agent-worktree-marveen.sh` +
  `store/marveen-land.sh` instead.

## Ellenőrzés
After commit, in this order (avoids the stale-HEAD test trap above):
```bash
git -C <your worktree path> show --stat HEAD    # file list must contain ONLY your changed files
bash store/marveen-land.sh <your-agent-name>     # Step 6 -- merges, verifies, pushes
git -C /home/neon/marveen rev-parse origin/develop   # must equal the sha marveen-land.sh reported LANDED
```
Any extra file in the first command = contamination, notify MikroB. A mismatch in the last check =
your work is not on origin yet -- do not post REVIEW / move the card to `waiting` until it matches.
(CleanCore keeps its own separate `cleancore-land.sh` step, unrelated to this -- do not conflate the
two repos' landing scripts.)

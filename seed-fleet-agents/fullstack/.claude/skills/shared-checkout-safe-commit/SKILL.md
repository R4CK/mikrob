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
`crew-statistics-http.ts` and friends.

## Safe procedure (always follow this order)

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

### Step 6 -- push BEFORE posting REVIEW (marveen has no per-agent worktree, nothing else pushes for you)
`git commit` alone leaves the change LOCAL ONLY. Unlike CleanCore (per-agent worktrees, landed via
`cleancore-land.sh`), the marveen repo is a single shared checkout with no separate landing step --
if you don't push, nobody does. A REVIEW comment naming a Gate-SHA before that SHA is pushed claims a
state that isn't true yet: the card just says "landed", the commit sits local-only, and whoever
gates it either can't find the SHA on origin or is silently reviewing local state that could vanish
(card 2a3d06a6 -- a REVIEW claimed a commit had landed when it only existed locally; MikroB had to
push it later, bundled with an unrelated commit that had piled up on top in the meantime).

```bash
git push
```

Then confirm it actually landed before writing REVIEW -- don't trust the push command's own exit
code alone (a `[rejected]`/non-fast-forward can still exit non-zero loudly, but check anyway):
```bash
git rev-parse HEAD
git rev-parse @{u}
# The two SHAs must match. If they don't, the push did not land your commit -- do not post REVIEW yet.
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
- Committing is not landing (card 2a3d06a6). `git commit` never pushes on its own, and in the
  marveen repo (no per-agent worktree, no landing script) nothing else will push for you -- a
  REVIEW comment with a Gate-SHA that only exists locally is a false claim, even if you fully
  intend to push it "in a minute". Push BEFORE writing REVIEW, not after.

## Ellenőrzés
After commit, in this order (avoids the stale-HEAD test trap above):
```bash
git show --stat HEAD                                    # file list must contain ONLY your changed files
bash store/fleet-test.sh --ref $(git rev-parse HEAD)     # verifies the commit you just made, not stale HEAD
git push                                                 # Step 6 -- do this BEFORE posting REVIEW
git rev-parse HEAD; git rev-parse @{u}                   # must match, or REVIEW would claim a local-only state
```
Any extra file in the first command = contamination, notify MikroB. A mismatch in the last check =
your commit is not on origin yet -- do not post REVIEW / move the card to `waiting` until it matches.

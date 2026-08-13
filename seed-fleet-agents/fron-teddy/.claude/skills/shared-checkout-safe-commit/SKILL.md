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

## Ellenőrzés
After commit, in this order (avoids the stale-HEAD test trap above):
```bash
git show --stat HEAD                                    # file list must contain ONLY your changed files
bash store/fleet-test.sh --ref $(git rev-parse HEAD)     # verifies the commit you just made, not stale HEAD
```
Any extra file in the first command = contamination, notify MikroB.

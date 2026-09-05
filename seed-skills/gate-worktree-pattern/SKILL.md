---
name: gate-worktree-pattern
description: Create a disposable, SHA-pinned worktree for a gate or a bug repro without corrupting the shared clone. Use whenever you need to run tests, a dev server or a repro at a specific commit -- QA/Cybersec/Cybered gates, delta-reviews, "does this land?" checks. Covers the node_modules trap that took the fleet down for 38 minutes.
---

# Gate worktree pattern

## When to use

Any time you need a checkout at a SPECIFIC commit that is not your own working tree:

- a QA / Cybersec / Cybered gate on a Gate-SHA
- a delta-review (build the same tree twice, at two SHAs)
- reproducing a bug at the commit that introduced it
- running a dev server against a pinned commit

Never gate inside another agent's worktree -- live, half-finished work lives there. Never commit
in the shared clone.

## Procedure

```bash
# create (idempotent; prints the path) -- --agent (or CC_GATE_AGENT) is REQUIRED (card a7da80d6):
# the agent name is now PART OF THE PATH, so two gates reviewing the same card at the same sha never
# collide on one directory (see "The trap this replaces" below for what that collision used to do).
WT=$(bash store/cc-gate-worktree.sh --agent <you> --path <card> <sha>)
bash store/cc-gate-worktree.sh --agent <you> <card> <sha>

# work in it
cd "$WT" && bash {{INSTALL_DIR}}/scripts/noisy-run.sh npx vitest run --root apps/web <files>

# tear down (stops anything still running there, removes, prunes, sweeps the cache skeleton) --
# --agent scopes the kill/removal to YOUR own worktree; a bare 2-argument call now dies loudly.
bash store/cc-gate-worktree.sh --agent <you> --remove "$WT"
```

That is the whole procedure. Do not hand-roll the setup inline; the script exists because the
inline version caused an outage (below).

## The trap this replaces

The inline pattern gates used before looked local and safe:

```bash
ln -s "$CC_MAIN/apps/web/node_modules" "$WT/apps/web/node_modules"   # directory symlink
...
rm    "$WT/apps/web/node_modules/@cleancore/i18n"                    # "just my worktree"
ln -s "$WT/packages/i18n" "$WT/apps/web/node_modules/@cleancore/i18n"
```

Both writes name paths under `$WT`. Neither names the shared clone. But `apps/web/node_modules`
IS the symlink, so the kernel resolved both operations inside `$CC_MAIN` and rewrote the SHARED
clone's workspace link to an absolute path inside the worktree. Twenty minutes later
`git worktree remove` deleted that worktree, the shared link dangled, and every agent's
vite/vitest answered `Failed to resolve import @cleancore/i18n` for 38 minutes (card 9dc0fba8,
2026-09-02 11:11-11:49). The same block ran again 32 minutes later, so it had to be fixed twice.

`store/cc-gate-worktree.sh` gives the worktree a REAL `node_modules` directory whose ENTRIES are
symlinks. A write inside it stays inside it: the escaping path does not exist any more.

**A second collision, fixed the same way (card a7da80d6).** The path used to be card+sha ONLY, so
two gates reviewing the SAME card at the SAME sha -- the normal case, since a card is gated by QA and
Cybersec/Cybered together -- were handed the SAME directory. `--remove` by whichever gate finished
first then killed every process whose cwd was inside it and deleted the tree, taking a peer's
running vitest with it SILENTLY: no error to the victim, just a suite that stops and a checkout that
is gone. The agent name is now PART OF THE PATH (`cc-gate-<card>-<agent>-<sha>`) and is REQUIRED --
`--agent <you>` or `CC_GATE_AGENT` -- so this cannot be forgotten the way a prose reminder can.

## Pitfalls

- **A path under `$WT` is not proof the write lands under `$WT`.** Only `readlink -f` on the
  PARENT directory tells you where a write actually goes. If any component is a symlink, you are
  writing somewhere else. The `symlinked-node-modules-guard.py` PreToolUse hook now blocks this
  shape (and blocks it too when the path still holds an unexpanded `$VAR`, since then it cannot
  be checked at all) -- if it fires, use this script, do not reach for the escape hatch.
- **Never run an installer in a worktree** (`pnpm install`, `npm ci`, `pnpm add`). The entries are
  links into the shared store. Install in `$CLEANCORE_MAIN`, then re-run this script to top up.
- **`ln -s A B` when B already exists as a symlink-to-directory creates the link INSIDE B**, not
  at B. That is how `apps/api/node_modules/node_modules -> .../apps/api/node_modules` (a
  self-referential loop) ended up in the shared clone. Use `ln -sfn` for links you intend to
  replace, and check with `readlink` afterwards.
- **A dev server outlives the worktree.** `git worktree remove` deletes the checkout while vite
  keeps running, holding a port and recreating `.vite` cache directories at the deleted path --
  three such skeletons were left behind by the incident. `--remove` kills by the process's own
  cwd (never by a command-line pattern, which would catch a peer's server).
- **`"$src"/*` skips dotfiles.** In a node_modules the two entries that matter most are dotted:
  `.pnpm` (where every real package lives) and `.bin` (vitest, tsc). A first cut of the script
  used a glob and produced a worktree whose `npx vitest` said "vitest: not found". Use
  `find -mindepth 1 -maxdepth 1`.
- **Workspace packages should resolve to the WORKTREE's sources**, or your tests read the shared
  clone's code and quietly validate the wrong commit. The script points `@cleancore/*` at the
  worktree; for a bundler, an alias in `vitest.config.ts` does the same job.

## Verification

After creating a gate worktree, before trusting any result:

```bash
readlink "$CC_MAIN/apps/web/node_modules/@cleancore/i18n"     # must still be ../../../../packages/i18n
find "$WT" -maxdepth 4 -type l -name node_modules             # must print nothing
readlink -f "$WT/apps/web/node_modules/@cleancore/i18n"       # must point INSIDE $WT
git -C "$WT" rev-parse HEAD                                   # must equal the Gate-SHA
```

And after tearing down, confirm the shared link is still relative. A gate that corrupts the tree
it measured has not measured anything.

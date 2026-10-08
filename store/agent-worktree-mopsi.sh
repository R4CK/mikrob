#!/usr/bin/env bash
# agent-worktree-mopsi.sh -- thin wrapper: give a fleet agent its own git worktree of the Mopsi
# repo (R4CK/Mopsi), reusing the already-proven, already-generic store/agent-worktree.sh (card
# 7feb477b, parent 430466de).
#
# WHY A THIN WRAPPER HERE AND NOT A STANDALONE SCRIPT (unlike agent-worktree-marveen.sh, which IS
# standalone because marveen's own repo/hooks shape genuinely differs from CleanCore/mopsion's).
# agent-worktree.sh already parameterizes everything that differs between mopsion and Mopsi:
#   - MAIN/ROOT come from CLEANCORE_MAIN/CLEANCORE_WORKTREES (env, not a literal)
#   - SCOPE is a variable set to "@mopsion" -- which Mopsi's own packages/*/package.json ALSO
#     declare under (confirmed: apps/api, apps/web, packages/database, packages/offline-sync,
#     packages/rules-engine, packages/shared all read "name": "@mopsion/...")
#   - the package-list glob (apps/*/package.json packages/*/package.json packages/modules/*/
#     package.json) matches Mopsi's actual layout (apps/*, packages/*; the modules/ glob simply
#     matches nothing there, which is fine -- `ls ... 2>/dev/null` on a non-existent glob is empty,
#     not an error)
#   - the base ref it tries first, origin/main, is ALSO Mopsi's integration branch (its only
#     branch, confirmed via `git ls-remote`: refs/heads/main, HEAD -> main)
# So there is nothing left for a Mopsi variant to do differently -- just point it at the Mopsi
# clone and worktree root and call through. A real difference (e.g. Mopsi adopting a workspace
# scope other than @mopsion, or a packages/modules/* layer) is still visible to this wrapper
# because it inherits the pointed-at repo's actual structure, not a copy frozen at write time.
#
#   store/agent-worktree-mopsi.sh <agent>            # create (or top up) the agent's worktree
#   store/agent-worktree-mopsi.sh <agent> --path     # print the path and exit (for scripting)
#   store/agent-worktree-mopsi.sh --check-links      # verify the Mopsi main clone's own links
#
# Env: MOPSI_MAIN (default /mnt/h/LM_Studio_Workdir/Mopsi-main)
#      MOPSI_WORKTREES (default /mnt/h/LM_Studio_Workdir/Mopsi-worktrees)
# Exit: whatever agent-worktree.sh exits (0 ok | 2 bad usage | 3 setup failed)
set -euo pipefail

export CLEANCORE_MAIN="${MOPSI_MAIN:-/mnt/h/LM_Studio_Workdir/Mopsi-main}"
export CLEANCORE_WORKTREES="${MOPSI_WORKTREES:-/mnt/h/LM_Studio_Workdir/Mopsi-worktrees}"

exec "$(dirname "$0")/agent-worktree.sh" "$@"

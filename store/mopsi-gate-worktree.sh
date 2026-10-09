#!/usr/bin/env bash
# mopsi-gate-worktree.sh -- thin wrapper: a disposable, PINNED Mopsi worktree for a gate, reusing
# the already-proven, already-generic store/mopsion-gate-worktree.sh (card 7feb477b, parent
# 430466de).
#
# WHY A THIN WRAPPER. Same reasoning as agent-worktree-mopsi.sh: mopsion-gate-worktree.sh already
# takes its main clone from CLEANCORE_MAIN, its tree root from CC_GATE_ROOT, and its agent name
# from CC_GATE_AGENT/--agent -- none of that is Mopsi-vs-mopsion specific, and its SCOPE constant
# (@mopsion) matches Mopsi's own workspace scope (confirmed against Mopsi's packages/*/package.json
# below). Nothing here duplicates logic; this just points the generic script at Mopsi.
#
# COSMETIC WRINKLE, now narrowed rather than just called out (WhiteHat L2, card 7feb477b comment
# 13178): the created directory is still named "cc-gate-<card>-<agent>-<sha>" (the prefix is a
# literal in the wrapped script, not derived from CLEANCORE_MAIN) -- a rename would belong in
# mopsion-gate-worktree.sh itself (a GATE_PREFIX variable), not as a hack here. What IS fixed here:
# the default ROOT. It used to fall back to the wrapped script's own bare $HOME, the SAME default
# mopsion's own gates use -- so a Mopsi gate tree and a mopsion gate tree could sit side by side
# under identical names if a card/agent/sha ever coincided, and WhiteHat's probe showed the
# consequence is not benign: this wrapper's --remove happily accepts a PATH that turns out to be a
# mopsion gate worktree (the owner-file check only verifies the AGENT matches, not which clone the
# tree was built from), `git -C Mopsi-main worktree remove` on it fails silently (`|| true` in the
# wrapped script) because that tree was never one of Mopsi-main's, and the subsequent `rm -rf`
# deletes it anyway -- leaving mopsion's own clone with dangling worktree metadata (needs `git
# worktree prune` to notice). Defaulting MOPSI_GATE_ROOT to its OWN directory removes the
# possibility of ever handing this wrapper a mopsion path by accident, structurally rather than by
# relying on an operator to always pass the right one.
#
#   store/mopsi-gate-worktree.sh --agent <you> <card> <sha>     # create or top up; prints the path
#   store/mopsi-gate-worktree.sh --agent <you> --path <card> <sha>
#   store/mopsi-gate-worktree.sh --agent <you> --remove <path>   # stop YOUR strays there, then remove
#
# Env: MOPSI_MAIN (default /mnt/h/LM_Studio_Workdir/Mopsi-main)
#      MOPSI_GATE_ROOT (default $HOME/mopsi-gates, its OWN root -- NOT the wrapped script's bare
#      $HOME default, so it can never collide with a mopsion gate worktree by name)
# Exit: whatever mopsion-gate-worktree.sh exits (0 ok | 2 bad usage | 3 setup failed)
set -euo pipefail

export CLEANCORE_MAIN="${MOPSI_MAIN:-/mnt/h/LM_Studio_Workdir/Mopsi-main}"
export CC_GATE_ROOT="${MOPSI_GATE_ROOT:-$HOME/mopsi-gates}"
mkdir -p "$CC_GATE_ROOT"

exec "$(dirname "$0")/mopsion-gate-worktree.sh" "$@"

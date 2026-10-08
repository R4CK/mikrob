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
# ONE COSMETIC WRINKLE, called out rather than silently patched: the created directory is still
# named "cc-gate-<card>-<agent>-<sha>" (the prefix is a literal in the wrapped script, not derived
# from CLEANCORE_MAIN), so a Mopsi gate worktree and a mopsion gate worktree under the same
# CC_GATE_ROOT look alike by name. This is harmless in practice -- kanban card ids are unique
# across the whole board regardless of project, so two gates can never collide on the same
# directory -- but if it ever becomes confusing in practice, the fix belongs in
# mopsion-gate-worktree.sh itself (a GATE_PREFIX variable), not as a rename hack here.
#
#   store/mopsi-gate-worktree.sh --agent <you> <card> <sha>     # create or top up; prints the path
#   store/mopsi-gate-worktree.sh --agent <you> --path <card> <sha>
#   store/mopsi-gate-worktree.sh --agent <you> --remove <path>   # stop YOUR strays there, then remove
#
# Env: MOPSI_MAIN (default /mnt/h/LM_Studio_Workdir/Mopsi-main)
#      MOPSI_GATE_ROOT (default $HOME, same default as the wrapped script's CC_GATE_ROOT)
# Exit: whatever mopsion-gate-worktree.sh exits (0 ok | 2 bad usage | 3 setup failed)
set -euo pipefail

export CLEANCORE_MAIN="${MOPSI_MAIN:-/mnt/h/LM_Studio_Workdir/Mopsi-main}"
[ -n "${MOPSI_GATE_ROOT:-}" ] && export CC_GATE_ROOT="$MOPSI_GATE_ROOT"

exec "$(dirname "$0")/mopsion-gate-worktree.sh" "$@"

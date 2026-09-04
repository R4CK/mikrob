#!/usr/bin/env bash
# Where the local-LLM scripts read the RUNNING INSTALL's state from (card b536501e, Cybersec finding
# on the 5d151091 gate, comment 18585).
#
# THE DEFECT THIS CLOSES. store/local-llm.sh and store/local-llm-rag.sh are version-controlled, so a
# runnable copy of both lands in every agent worktree. They resolved their state files from their OWN
# location (`HERE=$(dirname "$BASH_SOURCE")`), while the dashboard writes state into the store of the
# INSTALL it runs from. Call the copy in your own worktree -- a natural move, the file is right there
# -- and the per-model kill switch reads a file that does not exist in that tree. A missing file
# correctly means "nothing is disabled", so a model the operator switched OFF keeps running, and
# nothing anywhere says a word. The prescribed call path (/home/neon/marveen/store/local-llm-rag.sh)
# enforces correctly today, which is exactly why this stayed invisible: the failure needs a future
# kill switch AND a worktree-local invocation to show itself, and by then it is a silent bypass of a
# control someone believed was on.
#
# THE FIX IS NOT "REMEMBER TO CALL THE RIGHT PATH". State location is derived, in one place, from
# what the checkout actually is. The origin is reported alongside the path, because two of the cases
# below produce the SAME directory for opposite reasons and only the origin tells them apart:
#
#   env            LOCAL_LLM_STATE_DIR was set -- wins outright, for tests and any future layout.
#   worktree       `.git` is a FILE reading `gitdir: <main>/.git/worktrees/<n>`, so the install is
#                  derivable exactly, with no hardcoded machine path. -> <main>/store
#   install        `.git` is a DIRECTORY: this IS the install, and its own store is the right one.
#   unknown        neither -- a loose copy of the script outside any checkout. Falls back to its own
#                  directory, WHICH MAY HAVE NO STATE FILES AT ALL.
#
# `install` and `unknown` both return the script's own directory. That is correct for one and a
# silent kill-switch bypass for the other, so announce_local_llm_state_dir() keys on the ORIGIN, not
# on comparing paths -- a path comparison would stay quiet in exactly the case worth hearing about.
# "Deliberately correct" and "not looking at the right place" have to look different; the same
# reasoning fixed the outgoing-copy-gate rules-path (card 934dc104).

# resolve_local_llm_state_dir <script-dir>
#   Sets LOCAL_LLM_STATE_RESOLVED (the directory) and LOCAL_LLM_STATE_ORIGIN
#   (env|worktree|install|unknown). It does NOT print the path.
#
# WHY IT SETS INSTEAD OF PRINTS. The obvious shape -- print the directory, let the caller do
# `d="$(resolve ...)"` -- puts the function in a COMMAND SUBSTITUTION, which is a subshell: the
# origin it sets there dies with that subshell, and the caller reads an empty one. Since
# announce_local_llm_state_dir() keys on the origin, every caller would have taken the `unknown`
# branch and warned on every call, including in the install. Caught by the test below this file, not
# by reading -- the printed path was right, so it looked fine.
resolve_local_llm_state_dir() {
  local here="$1"

  LOCAL_LLM_STATE_ORIGIN=unknown
  LOCAL_LLM_STATE_RESOLVED="$here"

  if [ -n "${LOCAL_LLM_STATE_DIR:-}" ]; then
    LOCAL_LLM_STATE_ORIGIN=env
    LOCAL_LLM_STATE_RESOLVED="${LOCAL_LLM_STATE_DIR%/}"
    return 0
  fi

  # store/ -> the checkout root that contains it.
  local checkout dotgit gitdir common main
  checkout="$(dirname "$here")"
  dotgit="$checkout/.git"

  if [ -f "$dotgit" ]; then
    gitdir="$(sed -n 's/^gitdir: *//p' "$dotgit" | head -1)"
    case "$gitdir" in
      */.git/worktrees/*)
        common="${gitdir%%/worktrees/*}"   # <main>/.git
        main="${common%/.git}"             # <main>
        if [ -d "$main/store" ]; then
          LOCAL_LLM_STATE_ORIGIN=worktree
          LOCAL_LLM_STATE_RESOLVED="$main/store"
          return 0
        fi
        ;;
    esac
    # A .git FILE we could not follow: not the install, and we could not find one either.
    return 0
  fi

  [ -d "$dotgit" ] && LOCAL_LLM_STATE_ORIGIN=install
  return 0
}

# announce_local_llm_state_dir <script-name> <script-dir> <state-dir>
#   Says which install's switches are in force, on stderr, in the two cases where a reader could
#   otherwise be misled. Silent when running from the install itself, so it does not become noise.
announce_local_llm_state_dir() {
  local who="$1" here="$2" state="$3"
  case "${LOCAL_LLM_STATE_ORIGIN:-unknown}" in
    install) return 0 ;;
    env|worktree)
      [ "$here" = "$state" ] && return 0
      echo "$who: reading dashboard state from $state (this copy lives in $here)" >&2
      ;;
    *)
      echo "$who: WARNING -- could not locate the install's store from $here, so dashboard switches (model kill switch, category toggles) may NOT be in force for this call. Set LOCAL_LLM_STATE_DIR or call the install's copy." >&2
      ;;
  esac
}

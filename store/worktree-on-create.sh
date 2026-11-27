#!/usr/bin/env bash
# worktree-on-create.sh -- run a project's configured on_create hook right after a worktree
# creator makes a NEW worktree, fail-closed (card 60e5a40e, F6.2, consumes F6.1's
# store/project-config-schema.py + store/projects/<project>.json, and F4.2's --card mode).
#
# Sourced, not executed, from a worktree creator (agent-worktree-marveen.sh today; a future
# project's creator can reuse it the same way once it gets its own store/projects/<project>.json
# -- this card wires marveen only, per its own stated assumption).
#
# WHY "no config file at all" is a silent no-op but "config file exists and is invalid" is NOT:
# a project with nothing configured yet (every project but marveen, for now) must behave exactly
# as it did before this card existed. A project that DOES have a config file, but that file is
# malformed, path-escaping, or otherwise refused by project-config-schema.py, is a real problem
# (misconfiguration or tampering) -- continuing past it silently would mean the invariants CYBERED
# asked for (comment 28158) are enforced in the schema but ignored by every caller.
#
# Usage (call AFTER the worktree directory itself exists, i.e. right after `git worktree add`
# succeeds -- never on a worktree that was merely reused):
#   project_worktree_on_create <project> <main> <tree> <branch_preexisted 0|1> <branch>
# Returns 0 if the worktree should proceed (no hook configured, or the hook ran and passed).
# Returns 1 and REMOVES "$tree" (plus, only if branch_preexisted=0, the branch THIS call's caller
# just created) if the project has a config that is refused, or a configured hook exits non-zero.
# The caller must treat a non-zero return as fatal (die) -- this function never half-rolls-back.
set -u

_worktree_on_create_rollback() {
  local main="$1" tree="$2" branch_preexisted="$3" branch="$4"
  git -C "$main" worktree remove --force "$tree" >/dev/null 2>&1 || true
  if [ "$branch_preexisted" = "0" ] && [ -n "$branch" ]; then
    git -C "$main" branch -D "$branch" >/dev/null 2>&1 || true
  fi
}

# F-2 fix, CORRECTED (card c16cd98e; the first shape of this fix was CYBERSEC NO-GO 39444 /
# CYBERED NO-GO 39445 on be3b70680). The first attempt used a COMPLETION marker: "absent" meant
# "not complete", so a worktree created by any version of this script before the marker existed
# -- i.e. every single one of the 176 live worktrees at NO-GO time -- looked identical to a
# genuinely interrupted one, and the caller's recovery path force-removed whichever got picked up
# next, discarding uncommitted/untracked work on 7 of them (both gates' live, read-only census).
#
# This is now an IN-PROGRESS SENTINEL instead, and the logic is inverted: "absent" means complete.
# project_worktree_on_create writes it as its OWN first action and removes it on every successful
# return. A tree this function has never been called for -- a legacy tree, or one created before
# this mechanism existed at all -- never had a sentinel written and reads as complete, exactly
# like one that finished normally; only a tree where the sentinel survives (this function started
# and never reached a `return 0`) is treated as interrupted. Written inside the worktree's own
# git-dir, never inside the checked-out working tree itself, so it can't show up as an untracked
# file or collide with repo content -- a linked worktree's git-dir is private per-worktree storage
# (git -C "$tree" rev-parse --git-dir resolves to "$main/.git/worktrees/<name>"), unlike the
# checked-out files, which are ordinary tracked/untracked content an agent could legitimately touch.
_worktree_on_create_sentinel_path() {
  local tree="$1" gitdir
  gitdir="$(git -C "$tree" rev-parse --git-dir 2>/dev/null)" || return 1
  printf '%s/worktree-on-create.in-progress\n' "$gitdir"
}

worktree_on_create_is_complete() {
  local tree="$1" sentinel
  sentinel="$(_worktree_on_create_sentinel_path "$tree")" || return 1
  [ ! -f "$sentinel" ]
}

_worktree_on_create_begin() {
  local tree="$1" sentinel
  sentinel="$(_worktree_on_create_sentinel_path "$tree")" || return 1
  : > "$sentinel"
}

_worktree_on_create_end() {
  local tree="$1" sentinel
  sentinel="$(_worktree_on_create_sentinel_path "$tree")" || return 1
  rm -f "$sentinel"
}

project_worktree_on_create() {
  local project="$1" main="$2" tree="$3" branch_preexisted="$4" branch="${5:-}"
  local config_file cfg_json rc on_create on_create_rc stderr_file

  _worktree_on_create_begin "$tree"

  config_file="$main/store/projects/$project.json"
  # No config for this project at all: nothing to do (yet) -- same as before this mechanism
  # existed. Only a project that HAS opted in via a config file is held to the invariants below.
  if [ ! -f "$config_file" ]; then
    _worktree_on_create_end "$tree"
    return 0
  fi

  # F-4 fix (card c16cd98e): stderr is captured SEPARATELY, never merged into cfg_json (2>&1
  # would corrupt the JSON with whatever the step wrote to stderr even on a successful run, and a
  # corrupted cfg_json made the NEXT step fail silently instead of loudly -- see below).
  stderr_file="$(mktemp)"
  cfg_json="$(python3 -I "$main/store/project-config-schema.py" "$project" 2>"$stderr_file")"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "project-config: REFUSED for project '$project': $(cat "$stderr_file")" >&2
    rm -f "$stderr_file"
    _worktree_on_create_rollback "$main" "$tree" "$branch_preexisted" "$branch"
    return 1
  fi
  rm -f "$stderr_file"

  # F-4 fix, second half: the parse step's own exit status is checked explicitly -- previously
  # `on_create="$(... | python3 ...)"` discarded a nonzero rc from the pipeline, so a config that
  # (for whatever reason) failed to parse here came back as an EMPTY on_create and the hook was
  # skipped with no error at all, instead of being treated as the misconfiguration it is.
  on_create="$(printf '%s' "$cfg_json" | python3 -I -c 'import json,sys; v=json.load(sys.stdin).get("on_create_script"); print(v or "")')"
  on_create_rc=$?
  if [ "$on_create_rc" -ne 0 ]; then
    echo "project-config: could not read on_create_script from the validated config for '$project' -- treating as a misconfiguration" >&2
    _worktree_on_create_rollback "$main" "$tree" "$branch_preexisted" "$branch"
    return 1
  fi
  if [ -z "$on_create" ]; then
    _worktree_on_create_end "$tree"
    return 0
  fi

  # CYBERED NO-GO 39445, INFO: fd 9 (the per-branch creation lock held by the caller across this
  # whole call) is closed for the hook child so a hook that daemonizes a background process can
  # never hold the lock past this script's own exit.
  if ! bash "$main/$on_create" "$tree" 9>&-; then
    echo "project-config: on_create ($on_create) failed for $tree -- removing half-made worktree" >&2
    _worktree_on_create_rollback "$main" "$tree" "$branch_preexisted" "$branch"
    return 1
  fi
  _worktree_on_create_end "$tree"
  return 0
}

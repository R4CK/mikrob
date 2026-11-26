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

project_worktree_on_create() {
  local project="$1" main="$2" tree="$3" branch_preexisted="$4" branch="${5:-}"
  local config_file cfg_json rc on_create

  config_file="$main/store/projects/$project.json"
  # No config for this project at all: nothing to do (yet) -- same as before this mechanism
  # existed. Only a project that HAS opted in via a config file is held to the invariants below.
  [ -f "$config_file" ] || return 0

  if ! cfg_json="$(python3 -I "$main/store/project-config-schema.py" "$project" 2>&1)"; then
    echo "project-config: REFUSED for project '$project': $cfg_json" >&2
    _worktree_on_create_rollback "$main" "$tree" "$branch_preexisted" "$branch"
    return 1
  fi

  on_create="$(printf '%s' "$cfg_json" | python3 -I -c 'import json,sys; v=json.load(sys.stdin).get("on_create_script"); print(v or "")')"
  [ -n "$on_create" ] || return 0

  if ! bash "$main/$on_create" "$tree"; then
    echo "project-config: on_create ($on_create) failed for $tree -- removing half-made worktree" >&2
    _worktree_on_create_rollback "$main" "$tree" "$branch_preexisted" "$branch"
    return 1
  fi
  return 0
}

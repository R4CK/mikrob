#!/usr/bin/env python3
"""store/project-config-schema.py -- F6.1 project config schema + loader (card c661ace4, Fazis
ed332869).

t3code (pingdotgg/t3code @37481f04, MIT, ideas only, no code copied) keeps a per-repo t3.json with
scripts flagged runOnWorktreeCreate. This fleet's equivalent: store/projects/<project>.json, one
file per project, describing where its repo lives, its base branch, its land script and (future)
an on_create hook (F6.2) a worktree creator runs right after making a new worktree.

Loads and validates ONLY -- it does not run anything. F6.2 (card 60e5a40e) is the consumer that
calls on_create_script after worktree creation; this card does not move existing per-project setup
logic (agent-worktree-marveen.sh, agent-worktree.sh) into a hook.

Usage:
  python3 project-config-schema.py <project>    # prints the validated config as one JSON line on
                                                 # stdout, exit 0; or "REFUSED: <reason>" on stderr,
                                                 # exit 1 -- a bad config must never look like a good
                                                 # one to a caller that does `cfg=$(... ) || exit`.
"""
import json
import os
import sys

REQUIRED_STRING_FIELDS = ("repo", "base_branch", "land_script")
OPTIONAL_STRING_FIELDS = ("on_create_script",)
ALL_FIELDS = REQUIRED_STRING_FIELDS + OPTIONAL_STRING_FIELDS


class ProjectConfigError(ValueError):
    pass


def validate_project_config(data, config_path="<config>"):
    """Raises ProjectConfigError naming the FIRST problem found; returns `data` unchanged on success.

    Checks shape first (so a type error reports as a type error, not a confusing path error), then
    filesystem existence -- a config pointing at a path that is not there is exactly as "bad" as one
    with the wrong shape, and a consumer (F6.2) needs both caught before it ever tries to run
    anything.
    """
    if not isinstance(data, dict):
        raise ProjectConfigError(f"{config_path}: top level must be a JSON object")

    unknown = set(data) - set(ALL_FIELDS)
    if unknown:
        raise ProjectConfigError(f"{config_path}: unknown field(s): {', '.join(sorted(unknown))}")

    for field in REQUIRED_STRING_FIELDS:
        if field not in data:
            raise ProjectConfigError(f"{config_path}: missing required field '{field}'")
        if not isinstance(data[field], str) or not data[field]:
            raise ProjectConfigError(f"{config_path}: field '{field}' must be a non-empty string")

    for field in OPTIONAL_STRING_FIELDS:
        if field in data and data[field] is not None:
            if not isinstance(data[field], str) or not data[field]:
                raise ProjectConfigError(
                    f"{config_path}: field '{field}' must be a non-empty string or null"
                )

    if not data["repo"].startswith("/"):
        raise ProjectConfigError(f"{config_path}: 'repo' must be an absolute path, got {data['repo']!r}")

    if not os.path.isdir(data["repo"]):
        raise ProjectConfigError(
            f"{config_path}: 'repo' does not exist or is not a directory: {data['repo']}"
        )

    land_script_path = os.path.join(data["repo"], data["land_script"])
    if not os.path.isfile(land_script_path):
        raise ProjectConfigError(f"{config_path}: 'land_script' does not exist: {land_script_path}")

    on_create = data.get("on_create_script")
    if on_create:
        on_create_path = os.path.join(data["repo"], on_create)
        if not os.path.isfile(on_create_path):
            raise ProjectConfigError(
                f"{config_path}: 'on_create_script' does not exist: {on_create_path}"
            )

    return data


def load_project_config(project, projects_dir=None):
    if projects_dir is None:
        projects_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "projects")
    config_path = os.path.join(projects_dir, f"{project}.json")
    if not os.path.isfile(config_path):
        raise ProjectConfigError(f"no config for project '{project}': {config_path} does not exist")
    with open(config_path, encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as exc:
            raise ProjectConfigError(f"{config_path}: invalid JSON: {exc}") from exc
    return validate_project_config(data, config_path)


def main(argv):
    if len(argv) != 2:
        print("usage: project-config-schema.py <project>", file=sys.stderr)
        return 2
    try:
        config = load_project_config(argv[1])
    except ProjectConfigError as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(config))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

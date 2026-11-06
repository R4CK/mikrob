#!/usr/bin/env python3
"""Selftest for project-config-schema.py (card c661ace4, F6.1).

Auto-discovered by store-selftests-all-run.test.ts (the `.selftest.py` suffix). Never writes under
the real store/projects/ -- every bad-config case uses its own mktemp projects dir, so a failing
case cannot leave the tracked tree dirty (card 99a4a2d4's guard would catch it anyway).
"""
import json
import os
import shutil
import sys
import tempfile

import importlib.util

# The module file is hyphenated (project-config-schema.py), which is not a valid Python identifier
# for `import`, so load it by path instead of by name.
_spec = importlib.util.spec_from_file_location(
    "project_config_schema", os.path.join(os.path.dirname(os.path.abspath(__file__)), "project-config-schema.py")
)
project_config_schema = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(project_config_schema)

validate_project_config = project_config_schema.validate_project_config
load_project_config = project_config_schema.load_project_config
ProjectConfigError = project_config_schema.ProjectConfigError

STORE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(STORE)

passed = 0
failed = 0


def check(label, fn):
    global passed, failed
    try:
        fn()
        print(f"ok   {label}")
        passed += 1
    except AssertionError as exc:
        print(f"FAIL {label}: {exc}")
        failed += 1
    except Exception as exc:  # noqa: BLE001 -- an unexpected exception IS a failure here
        print(f"FAIL {label}: unexpected {type(exc).__name__}: {exc}")
        failed += 1


def expect_refused(data, needle, config_path="<config>"):
    try:
        validate_project_config(data, config_path)
    except ProjectConfigError as exc:
        assert needle in str(exc), f"expected '{needle}' in error, got: {exc}"
        return
    raise AssertionError("expected ProjectConfigError, got none")


# --- The real marveen.json, loaded for real -----------------------------------------------------
check(
    "the real store/projects/marveen.json loads and validates",
    lambda: load_project_config("marveen", os.path.join(STORE, "projects")),
)

GOOD = {
    "repo": REPO_ROOT,
    "base_branch": "develop",
    "land_script": "store/marveen-land.sh",
    "on_create_script": None,
}
check("a good config (shape of the real one) validates", lambda: validate_project_config(dict(GOOD)))

check(
    "on_create_script may be omitted entirely (optional field)",
    lambda: validate_project_config({k: v for k, v in GOOD.items() if k != "on_create_script"}),
)

# --- Bad configs: shape ---------------------------------------------------------------------------
check("not an object is refused", lambda: expect_refused(["not", "an", "object"], "top level must be"))
check("missing repo is refused", lambda: expect_refused({k: v for k, v in GOOD.items() if k != "repo"}, "missing required field 'repo'"))
check("missing base_branch is refused", lambda: expect_refused({k: v for k, v in GOOD.items() if k != "base_branch"}, "missing required field 'base_branch'"))
check("missing land_script is refused", lambda: expect_refused({k: v for k, v in GOOD.items() if k != "land_script"}, "missing required field 'land_script'"))
check("empty-string repo is refused", lambda: expect_refused({**GOOD, "repo": ""}, "non-empty string"))
check("non-string base_branch (int) is refused", lambda: expect_refused({**GOOD, "base_branch": 7}, "non-empty string"))
check("unknown field is refused", lambda: expect_refused({**GOOD, "typo_field": "x"}, "unknown field(s): typo_field"))
check("non-absolute repo path is refused", lambda: expect_refused({**GOOD, "repo": "relative/path"}, "must be an absolute path"))
check(
    "null on_create_script is accepted (explicit null, not omitted)",
    lambda: validate_project_config({**GOOD, "on_create_script": None}),
)
check(
    "empty-string on_create_script is refused (use null, not empty)",
    lambda: expect_refused({**GOOD, "on_create_script": ""}, "non-empty string or null"),
)

# --- Bad configs: filesystem -----------------------------------------------------------------------
check(
    "repo pointing at a nonexistent directory is refused",
    lambda: expect_refused({**GOOD, "repo": "/no/such/directory/at/all"}, "does not exist or is not a directory"),
)
check(
    "land_script pointing at a nonexistent file is refused",
    lambda: expect_refused({**GOOD, "land_script": "store/no-such-script-xyz.sh"}, "'land_script' does not exist"),
)
check(
    "on_create_script pointing at a nonexistent file is refused",
    lambda: expect_refused({**GOOD, "on_create_script": "store/no-such-hook-xyz.sh"}, "'on_create_script' does not exist"),
)


def _repo_as_file_not_dir():
    tmp = tempfile.mkdtemp()
    try:
        repo_file = os.path.join(tmp, "repo-is-a-file")
        with open(repo_file, "w", encoding="utf-8") as f:
            f.write("not a directory")
        expect_refused({**GOOD, "repo": repo_file}, "does not exist or is not a directory")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


check("repo pointing at a FILE (not a directory) is refused", _repo_as_file_not_dir)


def _load_missing_project():
    tmp = tempfile.mkdtemp()
    try:
        try:
            load_project_config("no-such-project", tmp)
        except ProjectConfigError as exc:
            assert "no config for project" in str(exc), exc
            return
        raise AssertionError("expected ProjectConfigError")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


check("loading a project with no config file is refused", _load_missing_project)


def _load_bad_json():
    tmp = tempfile.mkdtemp()
    try:
        with open(os.path.join(tmp, "broken.json"), "w", encoding="utf-8") as f:
            f.write("{ not valid json")
        try:
            load_project_config("broken", tmp)
        except ProjectConfigError as exc:
            assert "invalid JSON" in str(exc), exc
            return
        raise AssertionError("expected ProjectConfigError")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


check("invalid JSON in a config file is refused", _load_bad_json)


def _cli_good():
    import subprocess

    script = os.path.join(STORE, "project-config-schema.py")
    p = subprocess.run(
        [sys.executable, script, "marveen"], cwd=STORE, capture_output=True, text=True, timeout=10
    )
    assert p.returncode == 0, f"exit {p.returncode}, stderr: {p.stderr}"
    parsed = json.loads(p.stdout.strip())
    assert parsed["repo"] == "/home/neon/marveen", parsed


check("CLI: `project-config-schema.py marveen` exits 0 and prints JSON", _cli_good)


def _cli_bad():
    import subprocess

    script = os.path.join(STORE, "project-config-schema.py")
    p = subprocess.run(
        [sys.executable, script, "no-such-project-xyz"],
        cwd=STORE,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert p.returncode == 1, f"expected exit 1, got {p.returncode}"
    assert p.stdout.strip() == "", f"a refused config must print NOTHING on stdout, got: {p.stdout!r}"
    assert p.stderr.strip().startswith("REFUSED:"), p.stderr


check("CLI: an unknown project exits 1, empty stdout, REFUSED: on stderr", _cli_bad)

print(f"selftest: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)

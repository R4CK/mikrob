#!/usr/bin/env python3
"""Is $ROOT/node_modules stale relative to $ROOT/package-lock.json? (cards d1641163, 508153a9)

Exit 0 = stale (caller must not trust node_modules as-is, must install/rebuild instead).
Exit 1 = fresh (every applicable declared package matches what is actually installed, on disk).

ONE implementation, two callers: store/fleet-test.sh's root_node_modules_is_stale() (the
symlink-vs-npm-ci decision, card d1641163) and update.sh's npm-ci-vs-skip decision (card 508153a9,
RedHat R1 follow-up on d1641163's own GO). Before 508153a9, update.sh instead compared
`git diff OLD_VERSION..NEW_VERSION` for package(-lock).json changes -- empty after a lander
fast-forward, so a stale $ROOT/node_modules (lock moved, node_modules didn't) could survive an
update.sh run untouched. A single state-based helper closes the gap for both callers at once and
keeps a future fix from landing on only one of them (the exact failure mode gate_scan_lib.py's own
docstring names for its own two-callers-one-rule split).

Usage: python3 node-modules-stale-check.py <root-dir>
"""
import json
import os
import platform
import sys


def is_stale(root: str) -> bool:
    try:
        with open(os.path.join(root, "package-lock.json")) as f:
            declared = json.load(f).get("packages", {})
    except (OSError, json.JSONDecodeError):
        return True  # no lockfile to compare against -- treat as unverifiable/stale

    node_modules_dir = os.path.join(root, "node_modules")
    if not os.path.isdir(node_modules_dir):
        # never installed at all -- not this check's job, the caller's own "nothing to
        # symlink from" / "always npm ci on a fresh install" path covers it.
        return False

    installed_lock_path = os.path.join(node_modules_dir, ".package-lock.json")
    try:
        with open(installed_lock_path) as f:
            installed = json.load(f).get("packages", {})
    except (OSError, json.JSONDecodeError):
        # F1 (card 508153a9, fail-open fix): node_modules EXISTS -- something was installed -- but
        # its own install-state record is missing or corrupt, so there is nothing to verify against.
        # The pre-fix code treated a missing file here the same as "node_modules never existed" and
        # trusted the tree as fresh; that is fail-open. An existing, unverifiable install is stale.
        return True

    node_os = "linux" if sys.platform.startswith("linux") else sys.platform
    node_cpu = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine(), platform.machine())

    for key, entry in declared.items():
        if key == "":  # the root package entry itself; npm's install-state file never carries it
            continue
        os_list = entry.get("os")
        if os_list is not None and node_os not in os_list:
            continue  # optional dep for a different platform -- legitimately absent from installed
        cpu_list = entry.get("cpu")
        if cpu_list is not None and node_cpu not in cpu_list:
            continue
        inst = installed.get(key)
        if inst is None or inst.get("version") != entry.get("version"):
            return True  # stale: npm's own bookkeeping disagrees with the lock
        # F2 (card 508153a9): the install-state record claiming the right version says nothing
        # about whether the package is actually present on disk -- a hand-deleted or half-removed
        # package directory still satisfies the .package-lock.json check above. Confirm it too.
        if not os.path.isfile(os.path.join(root, key, "package.json")):
            return True  # stale: bookkeeping and disk disagree

    return False  # every applicable declared package matches what is actually installed, on disk


if __name__ == "__main__":
    sys.exit(0 if is_stale(sys.argv[1]) else 1)

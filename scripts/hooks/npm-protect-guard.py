#!/usr/bin/env python3
"""PreToolUse hook: stop an agent from wiping the SHARED node_modules (card 0e135261).

THE INCIDENT (twice in one day, both near-outages). An agent ran `npm ci` in the shared
/home/neon/marveen checkout to verify a dependency, and a context-restart landed mid-run. `npm ci`
DELETES node_modules first and installs second, so the interrupted run left node_modules EMPTY. The
running dashboard survived only because its modules were already resident in memory; the next
restart -- or the watchdog's health loop -- would have found an unbootable install, which is exactly
the hours-long crash loop the fleet already lived through once (see the update-dirty-build-crashloop
and oneshot-deploy-script-is-a-rerun-landmine memories).

WHAT THIS BLOCKS
  `npm ci`, `npm install`/`i`/`add`/`update`/`dedupe`/`prune`, `pnpm install`/`add`, `yarn install`
  /`add`, and `rm -rf node_modules` -- but ONLY when the node_modules they would touch resolves
  INTO the shared checkout.

WHY THE TEST IS "WHICH node_modules", NOT "WHICH DIRECTORY"
A private worktree is not automatically safe. Every worktree here symlinks node_modules at the
shared one (that is how the fleet avoids a second 1 GB install), so `npm ci` inside a worktree
follows the symlink and wipes the SHARED tree just the same. Conversely an agent that made itself a
REAL node_modules in its own worktree is doing the right thing and must not be blocked. So the guard
resolves the target directory's node_modules and asks where it actually lands. A directory INSIDE
the shared root counts too, because npm walks up to the nearest package.json -- `npm ci` from
agents/backend2 operates on the root install.

THE ESCAPE HATCH
`MARVEEN_ALLOW_NPM_WRITE=1 npm ci` is allowed, in that inline form only. Deliberately explicit and
greppable: the deploy path (update.sh) does not run through the Bash tool at all and is therefore
never affected, so this exists purely for a human-authorized, deliberate one-off.

WHAT THIS IS NOT. Like its sibling git-protect-guard.py this is a regex over the command STRING: a
seatbelt for tired agents, not a security boundary. It does not survive variable indirection
(`n=npm; $n ci`), string splitting, a command written to a file and then executed, or two levels of
wrapper nesting. Any guard error FAILS OPEN -- wedging the fleet on a guard bug would be worse than
the footgun.
"""
import json
import os
import re
import sys
from pathlib import Path

# The shared checkout is derived from this file's own location (<root>/scripts/hooks/<this>), never
# hardcoded: the fleet ships these scripts to other installs, and a baked-in /home/neon path would
# make the guard silently inert there.
SHARED_ROOT = Path(__file__).resolve().parents[2]

ALLOW_ENV = "MARVEEN_ALLOW_NPM_WRITE"

# --- command-shape helpers -----------------------------------------------------------------------
# Deliberately duplicated from git-protect-guard.py rather than extracted into a shared module: that
# guard is a live security control with its own gate history, and refactoring it to import from here
# would put it back through review for no behavioural gain. The duplication is small and the two
# copies are pinned by their own selftests; consolidating them is a separate, gateable change.

_ENV_PREFIX = r"(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]*\s+)*"
_CMD = r"(?:^|[\n;&|(])\s*" + _ENV_PREFIX + r"(?:sudo\s+)?(?:time\s+)?"

# npm/pnpm/yarn subcommands that MUTATE node_modules. `npm run`, `npm test`, `npm ls`, `npx` and
# friends are untouched -- agents build and test in the shared tree all day and must keep doing so.
_MUTATING_NPM = r"(?:ci|install|i|add|update|up|upgrade|dedupe|prune|rebuild|link)"
NPM_WRITE_RX = re.compile(_CMD + r"(?:npm|pnpm|yarn)\s+(?:[-\w]+\s+)*?" + _MUTATING_NPM + r"\b")

# `rm -rf node_modules`, `rm -fr ./node_modules`, `rm -r -f some/path/node_modules`.
RM_NODE_MODULES_RX = re.compile(
    _CMD + r"rm\b(?=[^\n&|;]*(?:-[a-zA-Z]*r|--recursive))[^\n&|;]*?(?<![\w./-])([^\s;&|]*node_modules)/?(?:\s|$)"
)

_WRAPPER_RX = re.compile(
    r"(?:^|[\n;&|(])\s*(?:bash|sh|zsh)\s+-c\s+(['\"])(.*?)\1|(?:^|[\n;&|(])\s*eval\s+(['\"])(.*?)\3",
    re.S,
)
_HEREDOC_RX = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1.*?^\s*\2\s*$", re.S | re.M)
_QUOTED_RX = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", re.S)


def _unwrapped_variants(cmd):
    out = [cmd]
    for m in _WRAPPER_RX.finditer(cmd):
        inner = m.group(2) if m.group(2) is not None else m.group(4)
        if inner:
            out.append(inner)
    return out


def _strip_heredoc_bodies(cmd):
    return _HEREDOC_RX.sub("<<HEREDOC-BODY-STRIPPED", cmd)


def _strip_quoted_literals(cmd):
    return _QUOTED_RX.sub(lambda m: "''" if m.group(0)[0] == "'" else '""', cmd)


# --- where would this command's node_modules land? -----------------------------------------------

_PREFIX_RX = re.compile(r"--prefix(?:=|\s+)([^\s;&|]+)")
_CD_RX = re.compile(r"(?:^|[\n;&|(])\s*cd\s+([^\s;&|]+)")


def _target_dir(cmd, cwd):
    """The directory the package manager would operate in: an explicit --prefix, else a leading
    `cd`, else the tool call's cwd."""
    m = _PREFIX_RX.search(cmd)
    if m:
        return Path(os.path.expanduser(m.group(1)))
    m = _CD_RX.search(cmd)
    if m:
        base = Path(os.path.expanduser(m.group(1)))
        return base if base.is_absolute() else Path(cwd or ".") / base
    return Path(cwd or ".")


def _resolves_into_shared(path):
    """True if `path` (after following symlinks) lies inside the shared checkout."""
    try:
        resolved = path.resolve()
    except OSError:
        return False
    return resolved == SHARED_ROOT or SHARED_ROOT in resolved.parents


def _hits_shared_node_modules(target_dir):
    """True when a package-manager write in `target_dir` would touch the shared install.

    Three ways it can:
      - the directory itself is inside the shared checkout (npm walks up to the root package.json);
      - its node_modules is a symlink pointing back into the shared checkout (the fleet's worktree
        pattern) -- this is the case a naive cwd check misses entirely;
      - neither exists yet, in which case npm would create it wherever the nearest package.json is,
        and we only block if that search lands in the shared tree.
    """
    if _resolves_into_shared(target_dir):
        return True
    nm = target_dir / "node_modules"
    if nm.exists() or nm.is_symlink():
        return _resolves_into_shared(nm)
    # No node_modules yet: follow the package.json search upward, as npm does.
    try:
        cur = target_dir.resolve()
    except OSError:
        return False
    for d in [cur, *cur.parents]:
        if (d / "package.json").exists():
            return _resolves_into_shared(d)
    return False


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if (payload.get("tool_name") or "") != "Bash":
        sys.exit(0)

    ti = payload.get("tool_input") or {}
    raw = ti.get("command") if isinstance(ti, dict) else None
    if not isinstance(raw, str):
        sys.exit(0)
    # Cheap pre-filter: nothing here can match without one of these tokens.
    if not any(tok in raw for tok in ("npm", "pnpm", "yarn", "node_modules")):
        sys.exit(0)

    cwd = payload.get("cwd") or os.getcwd()

    try:
        cmd = _strip_heredoc_bodies(raw)
        for variant in (_strip_quoted_literals(v) for v in _unwrapped_variants(cmd)):
            if f"{ALLOW_ENV}=1" in variant:
                continue

            rm_match = RM_NODE_MODULES_RX.search(variant)
            if rm_match:
                nm_arg = Path(os.path.expanduser(rm_match.group(1)))
                nm_path = nm_arg if nm_arg.is_absolute() else Path(cwd) / nm_arg
                # A symlinked node_modules is the fleet's worktree pattern: deleting the LINK is
                # harmless and sometimes necessary, so only a resolve into the shared tree blocks --
                # and `rm -rf` on the link itself (no trailing slash) does not follow it.
                if nm_path.is_symlink() and not rm_match.group(1).endswith("/"):
                    continue
                if _resolves_into_shared(nm_path):
                    sys.stderr.write(
                        "NPM-PROTECT-GUARD: `rm -rf node_modules` blokkolva -- ez a KOZOS "
                        f"checkout ({SHARED_ROOT}) fuggosegeit torolne, amin az ELO dashboard fut. "
                        "Egy felbeszakadt torles/ujratelepites unbootable installt hagy (ma "
                        "ketszer volt majdnem outage ebbol). Ha tenyleg kell, MikroB deploy-utjan "
                        f"menjen, vagy egyszeri, tudatos futashoz: `{ALLOW_ENV}=1 rm -rf ...`."
                    )
                    sys.exit(2)

            if NPM_WRITE_RX.search(variant):
                target = _target_dir(variant, cwd)
                if _hits_shared_node_modules(target):
                    sys.stderr.write(
                        "NPM-PROTECT-GUARD: `npm/pnpm/yarn install|ci|add` blokkolva -- ez a KOZOS "
                        f"checkout ({SHARED_ROOT}) node_modules-at irna, amin az ELO dashboard fut. "
                        "Az `npm ci` ELOSZOR TOROL: ha a futas felbeszakad (context-restart, "
                        "timeout), ures node_modules marad es a kovetkezo restart unbootable -- ma "
                        "ketszer volt majdnem outage ebbol. Fuggoseg-verifikaciohoz hasznalj PRIVAT "
                        "worktree-t SAJAT node_modules-szal. Buildhez/teszthez nem kell install: "
                        f"`npm run build`, `npx vitest` engedelyezett. Tudatos egyszeri futas: "
                        f"`{ALLOW_ENV}=1 npm ci`."
                    )
                    sys.exit(2)
    except Exception:
        sys.exit(0)  # any guard error -> fail open

    sys.exit(0)


if __name__ == "__main__":
    main()

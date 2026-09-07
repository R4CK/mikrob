#!/usr/bin/env python3
"""Attribute shared auto-memory files to their real author agent (card 0c335d59).

THE PROBLEM (Cybersec measurement, 2026-09-06, message 24311). Every agent's
`agents/<name>/.claude-config/projects` is a symlink into the single, shared
`~/.claude/projects/` tree (the same pattern CLAUDE.md's "Skill-utvonal csapda"
section already documents for `skills`). Claude Code's file-based auto-memory
therefore lands every agent's `memory/*.md` writes in ONE shared pool (the
`-home-neon-marveen` project key) -- an entry any agent wrote looks, to every
OTHER agent reading the pool, exactly like its own ("MY OWN"). Measured: 95 of
174 first-person memory files did not belong to their apparent agent.

GROUND TRUTH ALREADY EXISTS ON DISK. Each memory file's frontmatter carries
`metadata.originSessionId`. Session TRANSCRIPTS, unlike the memory pool, are
per-agent-keyed (`-home-neon-marveen-agents-<name>/<sessionId>.jsonl`) because
agent sessions run with cwd=agents/<name> -- so the sessionId mechanically
names its owner, without guessing.

WHAT THIS SCRIPT DOES, per run (idempotent -- see the selftest's "second sweep
is a no-op" cases -- so it is safe to schedule repeatedly, not just run once):
  1. For every *.md file in the memory pool (except MEMORY.md, the pure
     index-of-indexes with no content of its own to attribute) whose
     frontmatter lacks `metadata.agent`, resolve `originSessionId` against the
     per-agent project-key directories.
  2. On a UNIQUE match under an agent-specific key, inject `agent: <name>`
     into that file's frontmatter (every other byte of the file, content
     included, is left untouched) and append a `` `[agent]` `` marker to the
     end of every list line, in every *.md file in the pool, that links to it.
  3. Anything that resolves to the SHARED `-home-neon-marveen` key (a session
     NOT run under agents/<name> -- e.g. MikroB's own) or has no matching
     transcript at all (rotated/deleted) is left untouched. Cybersec's
     clarification (card 0c335d59, comment 21248) measured 13/95 of the
     retrospective set as genuinely undecidable this way -- this script never
     guesses; the bulk RETROSPECTIVE re-attribution of those 13 stays the
     separate, later, content-based step the card describes. It only ever
     writes what a transcript directory proves.

CONCURRENCY (Cybered NO-GO, card 0c335d59, comment 22227, on the first version):
this runs against a LIVE pool ~15 fleet agents write to concurrently, and the
per-file frontmatter edit (step 2's `agent:` field) is a single-file write with
no other writer -- but the hub-file marker append (also step 2) touches files
EVERY agent's index writes land in. That earlier version was a plain read-
modify-write there, independently reproduced to silently drop a concurrent
agent's freshly-added bullet line whenever its write landed mid-sweep. Fixed
with a compare-and-swap per hub file (re-read immediately before writing;
retry against fresh content if it moved) -- this is `_apply_marker_cas`, not
plain idempotency. The two are DIFFERENT guarantees: idempotent means a second
sweep of this script is a no-op (true, see the selftest); safe-under-
concurrent-OTHER-writers means someone else's write in the same instant is not
silently lost (now also true, within CAS's bounded-retry limits -- no OS-level
lock, so a sustained-contention hub file can still exhaust its retries and get
picked up on the next scheduled run instead).

Run manually:
  python3 store/memory-attribution-sweep.py [--dry-run]

Scheduled: the `memory-attribution-sweep` heartbeat task runs this regularly
(msg_id:25228) -- new un-attributed entries keep appearing every session that
writes to the shared pool, so a one-shot pass is not enough.
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import sys

FRONTMATTER_RE = re.compile(r'\A---\n(.*?\n)---\n', re.DOTALL)
ORIGIN_SESSION_RE = re.compile(r'^  originSessionId:[ \t]*(\S+)[ \t]*$', re.MULTILINE)
AGENT_FIELD_RE = re.compile(r'^  agent:[ \t]*\S+[ \t]*$', re.MULTILINE)
AGENTS_PROJECT_PREFIX = '-home-neon-marveen-agents-'


def default_pool_dir() -> str:
    return '/home/neon/.claude/projects/-home-neon-marveen/memory'


def default_projects_root() -> str:
    return '/home/neon/.claude/projects'


def list_memory_files(pool_dir: str) -> list[str]:
    return sorted(
        f for f in os.listdir(pool_dir)
        if f.endswith('.md') and f != 'MEMORY.md' and os.path.isfile(os.path.join(pool_dir, f))
    )


def split_frontmatter(text: str) -> tuple[str, str] | tuple[None, None]:
    """Returns (frontmatter_body_without_delimiters, rest_of_file), or (None, None)
    if `text` does not start with a `---`-delimited frontmatter block."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return None, None
    return m.group(1), text[m.end():]


def already_has_agent(frontmatter: str) -> bool:
    return bool(AGENT_FIELD_RE.search(frontmatter))


def extract_origin_session_id(frontmatter: str) -> str | None:
    m = ORIGIN_SESSION_RE.search(frontmatter)
    return m.group(1) if m else None


# Session ids are UUIDs (see every real example in this file's own docstring/selftest).
# Cybered's kill-chain 1 (card 0c335d59, comment 22227): origin_session_id came from a
# memory file's OWN frontmatter -- content any agent's Write tool can produce, not a value
# this script controls -- and went straight into a glob.glob() pattern unescaped. A value
# like '*' would match every transcript in every agent directory; if EXACTLY ONE existed
# anywhere at sweep time, the old code took that as an "authoritative" match and minted a
# GROUND-TRUTH-LOOKING `agent:` label from zero real session evidence. Rejecting anything
# that is not a plain UUID closes this before the value ever reaches glob(); glob.escape()
# is kept too as defense in depth for a future format change that loosens the regex.
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.IGNORECASE)


def resolve_agent(origin_session_id: str, projects_root: str) -> str | None:
    """UUID -> agent name, or None if it does not resolve to EXACTLY ONE
    agent-specific project-key directory (ambiguous, shared-key, or no
    transcript at all are all treated the same: unresolved, never guessed)."""
    if not UUID_RE.match(origin_session_id):
        return None
    pattern = os.path.join(projects_root, AGENTS_PROJECT_PREFIX + '*', glob.escape(origin_session_id) + '.jsonl')
    matches = glob.glob(pattern)
    if len(matches) != 1:
        return None
    project_dir = os.path.basename(os.path.dirname(matches[0]))
    return project_dir[len(AGENTS_PROJECT_PREFIX):]


def inject_agent_field(frontmatter: str, agent: str) -> str:
    """Adds `  agent: <name>` right after the `originSessionId` line. Requires
    that line to be present (callers only reach here once resolve_agent has
    already proven it exists)."""
    m = ORIGIN_SESSION_RE.search(frontmatter)
    assert m, 'inject_agent_field requires an originSessionId line'
    return frontmatter[:m.end()] + f'\n  agent: {agent}' + frontmatter[m.end():]


MAX_CAS_RETRIES = 5


def _marked_lines(text: str, target: str, marker: str) -> tuple[str, bool]:
    lines = text.splitlines(keepends=True)
    touched = False
    for i, line in enumerate(lines):
        if target in line and marker not in line:
            lines[i] = line.rstrip('\n') + f' {marker}\n'
            touched = True
    return ''.join(lines), touched


def _apply_marker_cas(hub_path: str, target: str, marker: str, _test_hook=None) -> bool:
    """Compare-and-swap update of ONE hub file (Cybered kill-chain 2, card 0c335d59,
    comment 22227): a naive read-modify-write here silently dropped a concurrent
    agent's freshly-written bullet line whenever its write landed between this
    function's own read and write -- independently reproduced against this exact
    write logic, not just read from source. On every attempt, re-read the file
    IMMEDIATELY before writing; if its content moved since the read this attempt's
    edit was computed from, the edit is stale -- retry against the fresh content
    instead of overwriting it. This shrinks the unguarded window from "the whole
    compute" to "one reread+write", not to zero (no OS-level lock here, matching
    Cybered's own offered remedy: flock OR compare-and-swap).

    `_test_hook`, if given, runs once per attempt right after the first read --
    the selftest's only way to deterministically land a write inside the race
    window instead of relying on real thread timing."""
    for _ in range(MAX_CAS_RETRIES):
        with open(hub_path, 'r', encoding='utf-8') as f:
            before = f.read()
        new_text, touched = _marked_lines(before, target, marker)
        if not touched:
            return False
        if _test_hook is not None:
            _test_hook()
        with open(hub_path, 'r', encoding='utf-8') as f:
            current = f.read()
        if current != before:
            continue  # someone else wrote in between -- retry against fresh content
        with open(hub_path, 'w', encoding='utf-8') as f:
            f.write(new_text)
        return True
    return False  # exhausted retries under sustained contention -- next sweep tries again


def add_attribution_markers(pool_dir: str, filename: str, agent: str) -> list[str]:
    """Appends a `` `[agent]` `` marker to every list line, in every *.md file
    in the pool (MEMORY.md included -- it links some entries directly), that
    references `filename` via a markdown link and does not already carry the
    marker. Returns the list of files actually changed."""
    marker = f'`[{agent}]`'
    target = f']({filename})'
    changed = []
    for hub_name in os.listdir(pool_dir):
        if not hub_name.endswith('.md'):
            continue
        hub_path = os.path.join(pool_dir, hub_name)
        if not os.path.isfile(hub_path):
            continue
        if _apply_marker_cas(hub_path, target, marker):
            changed.append(hub_name)
    return changed


def sweep(pool_dir: str, projects_root: str, dry_run: bool = False) -> dict:
    resolved: list[tuple[str, str]] = []
    unresolved: list[tuple[str, str]] = []
    already: list[str] = []
    for fname in list_memory_files(pool_dir):
        path = os.path.join(pool_dir, fname)
        with open(path, 'r', encoding='utf-8') as f:
            text = f.read()
        fm, body = split_frontmatter(text)
        if fm is None:
            unresolved.append((fname, 'no frontmatter'))
            continue
        if already_has_agent(fm):
            already.append(fname)
            continue
        origin = extract_origin_session_id(fm)
        if not origin:
            unresolved.append((fname, 'no originSessionId'))
            continue
        agent = resolve_agent(origin, projects_root)
        if not agent:
            unresolved.append((fname, 'originSessionId does not resolve to one agent'))
            continue
        if not dry_run:
            new_text = '---\n' + inject_agent_field(fm, agent) + '---\n' + body
            with open(path, 'w', encoding='utf-8') as f:
                f.write(new_text)
            add_attribution_markers(pool_dir, fname, agent)
        resolved.append((fname, agent))
    return {'resolved': resolved, 'unresolved': unresolved, 'already': already}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dry-run', action='store_true', help='report what would change, write nothing')
    ap.add_argument('--pool', default=default_pool_dir(), help='memory pool directory (default: the real shared pool)')
    ap.add_argument('--projects-root', default=default_projects_root(), help='~/.claude/projects (default: the real one)')
    args = ap.parse_args()

    if not os.path.isdir(args.pool):
        print(f'memory-attribution-sweep: no such pool directory: {args.pool}', file=sys.stderr)
        return 1

    result = sweep(args.pool, args.projects_root, dry_run=args.dry_run)
    by_agent: dict[str, int] = {}
    for _, agent in result['resolved']:
        by_agent[agent] = by_agent.get(agent, 0) + 1
    prefix = 'memory-attribution-sweep (dry-run)' if args.dry_run else 'memory-attribution-sweep'
    print(
        f'{prefix}: {len(result["resolved"])} newly attributed'
        f' ({", ".join(f"{a}={n}" for a, n in sorted(by_agent.items())) or "none"}),'
        f' {len(result["already"])} already labelled,'
        f' {len(result["unresolved"])} left unresolved (shared-key session or no transcript).'
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())

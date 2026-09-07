#!/usr/bin/env python3
"""Controls for memory-attribution-sweep.py (card 0c335d59).

Runs offline against throwaway tmp directories -- NEVER the real shared memory pool
at ~/.claude/projects/-home-neon-marveen/memory. Every case here is either a shape
measured on the real pool (Cybersec message 24311, card comment 21248: 82/95
mechanically resolvable, 13/95 genuinely undecidable -- 11 shared-key, 2 no
transcript) or a negative control guarding against the two failure modes a sweep
like this can have: writing an attribution that ISN'T proven (over-eager), or
re-writing on every run instead of being idempotent (unsafe to schedule).
"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util

_spec = importlib.util.spec_from_file_location(
    'memory_attribution_sweep', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'memory-attribution-sweep.py')
)
mas = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mas)

FAILS = []


def check(name, got, want):
    if got == want:
        print(f'  ok   {name}')
    else:
        FAILS.append(name)
        print(f'  FAIL {name}\n       got:  {got!r}\n       want: {want!r}')


def make_memory_file(pool_dir, name, origin_session_id=None, extra_metadata='', body='\n# stub\n\n- one line\n'):
    lines = ['---', f'name: {name[:-3]}', 'description: "stub"', 'metadata:']
    if origin_session_id is not None:
        lines.append('  node_type: memory')
        lines.append('  type: reference')
        lines.append(f'  originSessionId: {origin_session_id}')
        lines.append('  modified: 2026-09-07T00:00:00.000Z')
    if extra_metadata:
        lines.append(extra_metadata)
    lines.append('---')
    text = '\n'.join(lines) + body
    with open(os.path.join(pool_dir, name), 'w', encoding='utf-8') as f:
        f.write(text)
    return text


def make_transcript(projects_root, agent_project_key, session_id):
    d = os.path.join(projects_root, agent_project_key)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, session_id + '.jsonl'), 'w', encoding='utf-8') as f:
        f.write('{}\n')


print('memory-attribution-sweep.py controls (card 0c335d59)')

tmp = tempfile.mkdtemp(prefix='mas-selftest-')
try:
    pool = os.path.join(tmp, 'memory')
    projects = os.path.join(tmp, 'projects')
    os.makedirs(pool)
    os.makedirs(projects)

    # ------------------------------------------------------------- the resolvable case
    sid_qa = '11111111-1111-1111-1111-111111111111'
    make_transcript(projects, '-home-neon-marveen-agents-qa', sid_qa)
    make_memory_file(pool, 'a-resolvable-entry.md', origin_session_id=sid_qa)

    # ---------------------------------------------------------- shared-key: undecidable
    sid_shared = '22222222-2222-2222-2222-222222222222'
    make_transcript(projects, '-home-neon-marveen', sid_shared)
    make_memory_file(pool, 'b-shared-key-entry.md', origin_session_id=sid_shared)

    # ------------------------------------------------------- no transcript: undecidable
    sid_ghost = '33333333-3333-3333-3333-333333333333'
    make_memory_file(pool, 'c-no-transcript-entry.md', origin_session_id=sid_ghost)

    # --------------------------------------------------- no originSessionId at all
    make_memory_file(pool, 'd-no-origin-entry.md', origin_session_id=None)

    # ----------------------------------------------------- already labelled: untouched
    sid_backend = '44444444-4444-4444-4444-444444444444'
    make_transcript(projects, '-home-neon-marveen-agents-backend', sid_backend)
    make_memory_file(pool, 'e-already-labelled.md', origin_session_id=sid_backend,
                      extra_metadata='  agent: backend2')

    # hub files that link the resolvable entry, in the two real bullet shapes seen in
    # the actual pool (plain `- [text](file.md)` and bold `- **[text](file.md)**`)
    with open(os.path.join(pool, 'MEMORY.md'), 'w', encoding='utf-8') as f:
        f.write('- Tool gotchas: [list](topic-tool-gotchas.md)\n')
    with open(os.path.join(pool, 'topic-tool-gotchas.md'), 'w', encoding='utf-8') as f:
        f.write(
            '---\nname: topic-tool-gotchas\ndescription: "stub"\nmetadata:\n  type: reference\n---\n\n'
            '- [a resolvable entry](a-resolvable-entry.md) -- some description text\n'
            '- **[bold-style entry](a-resolvable-entry.md)**\n'
            '- [unrelated entry](something-else.md)\n'
        )

    result = mas.sweep(pool, projects)

    resolved_names = sorted(n for n, _ in result['resolved'])
    check('exactly the one resolvable entry is attributed',
          resolved_names, ['a-resolvable-entry.md'])
    check('it resolves to the right agent (qa, from the transcript dir)',
          dict(result['resolved'])['a-resolvable-entry.md'], 'qa')

    unresolved_names = sorted(n for n, _ in result['unresolved'])
    check('shared-key / no-transcript / no-origin entries are ALL left unresolved '
          '(topic-tool-gotchas.md is itself a valid target here too -- it has frontmatter '
          'but, like d-no-origin-entry.md, no originSessionId in this fixture)',
          unresolved_names,
          ['b-shared-key-entry.md', 'c-no-transcript-entry.md', 'd-no-origin-entry.md', 'topic-tool-gotchas.md'])

    check('an already-labelled entry is reported separately, not re-resolved',
          result['already'], ['e-already-labelled.md'])

    with open(os.path.join(pool, 'a-resolvable-entry.md'), encoding='utf-8') as f:
        attributed_text = f.read()
    check('the injected field is exactly "  agent: qa"',
          '  agent: qa' in attributed_text.splitlines(), True)
    check('the field sits on its OWN line (not glued to originSessionId)',
          any(line.strip() == 'agent: qa' for line in attributed_text.splitlines()), True)
    check('the body content is untouched (still ends with the stub bullet)',
          attributed_text.endswith('\n# stub\n\n- one line\n'), True)

    with open(os.path.join(pool, 'e-already-labelled.md'), encoding='utf-8') as f:
        already_text = f.read()
    check('an already-labelled file is BYTE-IDENTICAL after the sweep (no re-write)',
          already_text.count('agent:'), 1)

    # -------------------------------------------------------------- attribution markers
    with open(os.path.join(pool, 'MEMORY.md'), encoding='utf-8') as f:
        memory_md = f.read()
    check('MEMORY.md itself is never scanned as an attributable memory FILE (no frontmatter added)',
          memory_md.startswith('- Tool gotchas'), True)

    with open(os.path.join(pool, 'topic-tool-gotchas.md'), encoding='utf-8') as f:
        hub_text = f.read()
    hub_lines = hub_text.splitlines()
    plain_line = next(l for l in hub_lines if 'a resolvable entry' in l)
    bold_line = next(l for l in hub_lines if 'bold-style entry' in l)
    unrelated_line = next(l for l in hub_lines if 'unrelated entry' in l)
    check('the PLAIN-link bullet gets the `[qa]` marker appended',
          plain_line.endswith('`[qa]`'), True)
    check('the plain-link marker sits AFTER the existing description text (content untouched)',
          'some description text' in plain_line and plain_line.index('some description text') < plain_line.index('`[qa]`'),
          True)
    check('the BOLD-link bullet ALSO gets the marker (both shapes covered)',
          bold_line.endswith('`[qa]`'), True)
    check('an UNRELATED bullet (different target file) gets no marker',
          '`[qa]`' in unrelated_line, False)

    # --------------------------------------------------------------------- idempotency
    text_before_second = attributed_text
    hub_before_second = hub_text
    result2 = mas.sweep(pool, projects)
    with open(os.path.join(pool, 'a-resolvable-entry.md'), encoding='utf-8') as f:
        text_after_second = f.read()
    with open(os.path.join(pool, 'topic-tool-gotchas.md'), encoding='utf-8') as f:
        hub_after_second = f.read()

    check('SECOND sweep resolves zero NEW entries (already labelled now)',
          result2['resolved'], [])
    check('SECOND sweep reports the entry under "already", not "resolved"',
          'a-resolvable-entry.md' in result2['already'], True)
    check('the memory file is BYTE-IDENTICAL after a second sweep (idempotent)',
          text_after_second, text_before_second)
    check('the hub file is BYTE-IDENTICAL after a second sweep (marker not duplicated)',
          hub_after_second, hub_before_second)

    # ------------------------------------------------------------------------ dry-run
    dry_pool = os.path.join(tmp, 'memory-dry')
    shutil.copytree(pool, dry_pool)
    with open(os.path.join(dry_pool, 'c-no-transcript-entry.md'), encoding='utf-8') as f:
        before_dry = f.read()
    # give it a resolvable session so dry-run has something it WOULD change
    sid_dry = '55555555-5555-5555-5555-555555555555'
    make_transcript(projects, '-home-neon-marveen-agents-cybered', sid_dry)
    make_memory_file(dry_pool, 'f-dry-run-entry.md', origin_session_id=sid_dry)
    dry_result = mas.sweep(dry_pool, projects, dry_run=True)
    with open(os.path.join(dry_pool, 'f-dry-run-entry.md'), encoding='utf-8') as f:
        after_dry = f.read()
    check('CONTROL: dry-run still REPORTS what it would resolve',
          dict(dry_result['resolved']).get('f-dry-run-entry.md'), 'cybered')
    check('dry-run writes NOTHING to disk',
          'agent:' in after_dry, False)

finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
if FAILS:
    print(f'controls: FAIL ({len(FAILS)}): ' + '; '.join(FAILS))
    sys.exit(1)
print('controls: PASS')

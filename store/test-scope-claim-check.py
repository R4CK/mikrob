#!/usr/bin/env python3
"""test-scope-claim-check.py -- does a test file's header claim a scope it never reaches?

WHY THIS EXISTS (card e5b7ff19)
-------------------------------
Twice on 2026-09-04 the fleet hit the same class: a test file's header claims to cover an API
route, the file is green, and nothing in it ever reaches that route.

  1. otel-distributed-tracing.test.ts says "Scope: ... API route (POST/GET /api/spans, ...)".
     It creates its own otel_spans table and re-implements the queries with db.prepare(). Zero
     tests touch tryHandleSpans. A green suite carried the route's name.
  2. CleanCore card 555e4466: a card's guarantee was never exercised end to end -- the control
     was in the module, the call path never reached it, and narrowing the route back to its
     pre-card shape still left the file 26/26 green.

Both are silent empty coverage: nothing fails, and the file's NAME is the only thing asserting
the guarantee.

WHAT IT DOES. Maps each `/api/...` literal to the tryHandle* function whose BODY contains it,
reads each test file's leading comment block for `/api/...` claims, and reports the claims whose
serving module is never imported and whose handler is never called.

WHAT IT IS NOT. A gate. Measured over 611 test files: 61 header claims resolve to an owner, 33
do not reach it, and hand-verification found exactly ONE real mismatch -- the rest are
source-contract guards (they read app.js/a shell script/a SKILL.md as text and assert fragments)
whose headers name the route as the CONTEXT of the fix, not as their own scope. That is a
legitimate and common shape here, so a blocking gate would be ~23 false positives against 1 find.
Run this in an audit, read the output, and judge each line.

REACHABILITY IS TOKEN-BASED, NOT SUBSTRING. The first version of this script matched the module
basename as a substring, and 'spans' occurs throughout a test about spans (table names, locals,
SQL) -- so routes/spans.ts read as "reached" by a file importing only vitest and better-sqlite3.
It missed the very case it was written for. Reachability now means an IMPORT of the module or a
CALL of the handler by name.

USAGE
  store/test-scope-claim-check.py [--repo <dir>] [--json] [--selftest]
Exit: 0 no unreached claims | 1 unreached claims reported | 2 usage/error
"""
import re, os, sys, json

def fn_bodies(src):
    """(handler, body) for each exported tryHandle*; body runs to the next top-level export."""
    marks = [(m.group(1), m.start()) for m in
             re.finditer(r'^export (?:async )?function (tryHandle[A-Za-z0-9]+)', src, re.M)]
    nexts = [m.start() for m in re.finditer(r'^export ', src, re.M)]
    for name, s in marks:
        after = [x for x in nexts if x > s]
        yield name, src[s:(after[0] if after else len(src))]

def build_owner_map(repo):
    serves = {}
    web = os.path.join(repo, 'src', 'web')
    for root, _, files in os.walk(web):
        for f in files:
            if not f.endswith('.ts'):
                continue
            p = os.path.join(root, f)
            rel = os.path.relpath(p, repo)
            src = open(p, encoding='utf-8', errors='replace').read()
            for name, body in fn_bodies(src):
                for pa in set(re.findall(r"['\"`](/api/[a-zA-Z0-9/_.:-]+)", body)):
                    serves.setdefault(pa, set()).add((rel, name))
    return serves

def header(src):
    """The leading comment block, up to the first line of code."""
    out = []
    for ln in src.split('\n'):
        s = ln.strip()
        if s.startswith('//') or s.startswith('/*') or s.startswith('*') or s == '':
            out.append(ln)
            continue
        break
    return '\n'.join(out)

def strip_comments(src):
    out, inblk = [], False
    for ln in src.split('\n'):
        s = ln.strip()
        if inblk:
            if '*/' in s:
                inblk = False
            continue
        if s.startswith('//'):
            continue
        if s.startswith('/*'):
            if '*/' not in s:
                inblk = True
            continue
        out.append(ln)
    return '\n'.join(out)

def owner_of(serves, path):
    if path in serves:
        return serves[path]
    cands = [(k, v) for k, v in serves.items() if path.startswith(k)]
    return max(cands, key=lambda kv: len(kv[0]))[1] if cands else None

def sweep(repo):
    serves = build_owner_map(repo)
    tests = os.path.join(repo, 'src', '__tests__')
    rows = []
    for f in sorted(os.listdir(tests)):
        if not f.endswith('.test.ts'):
            continue
        src = open(os.path.join(tests, f), encoding='utf-8', errors='replace').read()
        code = strip_comments(src)
        claims = {c.rstrip('.,;:)`') for c in re.findall(r'(/api/[a-zA-Z0-9/_.:-]+)', header(src))}
        for c in sorted(claims):
            o = owner_of(serves, c)
            if not o:
                continue
            mods = sorted({m for m, _ in o})
            hs = sorted({h for _, h in o})
            imported = any(re.search(r"from\s+['\"][^'\"]*" + re.escape(os.path.basename(m)[:-3]) + r"\.js['\"]", code)
                           for m in mods)
            called = any(re.search(r'\b' + re.escape(h) + r'\b', code) for h in hs)
            rows.append({'test': f, 'claim': c, 'modules': mods, 'handlers': hs,
                         'reached': imported or called})
    return rows

def main(argv):
    repo = '/home/neon/marveen'
    as_json = False
    i = 1
    while i < len(argv):
        if argv[i] == '--repo':
            repo = argv[i + 1]; i += 2
        elif argv[i] == '--json':
            as_json = True; i += 1
        elif argv[i] == '--selftest':
            here = os.path.dirname(os.path.abspath(__file__))
            os.execv('/usr/bin/env', ['env', 'bash', os.path.join(here, 'test-scope-claim-check.selftest.sh')])
        else:
            sys.stderr.write(__doc__); return 2
    if not os.path.isdir(os.path.join(repo, 'src', '__tests__')):
        print(f'ERROR:no-tests-dir-under-{repo}'); return 2
    rows = sweep(repo)
    un = [r for r in rows if not r['reached']]
    if as_json:
        print(json.dumps(rows, indent=2))
    else:
        print(f'header claims with a resolvable owner: {len(rows)} '
              f'in {len({r["test"] for r in rows})} files')
        print(f'UNREACHED: {len(un)} in {len({r["test"] for r in un})} files\n')
        for r in un:
            print(f'  {r["test"]}\n      {r["claim"]}  ->  {r["modules"]} / {r["handlers"]}')
    return 1 if un else 0

if __name__ == '__main__':
    sys.exit(main(sys.argv))

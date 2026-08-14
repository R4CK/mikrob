#!/usr/bin/env bash
# Two-directional merge-seam sweep for a worktree that has just merged two histories.
#
# WHY THIS EXISTS. A three-way merge can drop a line that NEITHER side's diff shows, so reviewing
# each branch on its own cannot find it. Measured twice on 2026-08-14:
#   * batch v3/v4: the merge kept edb721ec's USE of `config.stockLevels` and lost both the import and
#     the ServerConfig field it reads. tsc caught that one only because it happened to be a type
#     error -- the same seam dropping a runtime line would have been silent.
#   * b43f7f0e: 27 names left UNTRIAGED_500_BASELINE, which looked like loss and was not -- they were
#     the branch's own triage deletions applied to a list main grew in the meantime.
# So the sweep reports BOTH directions and leaves the judgement to a human: a reported line is a
# question ("did you mean to drop this?"), not a verdict.
#
# Usage:
#   cleancore-seam-sweep.sh <worktree> <ref-a> <ref-b> [<ref-c> ...]
#     <worktree>  the merged tree to check (its working files are what gets searched)
#     <ref-*>     every history that went INTO the merge -- typically origin/main plus each branch
#
# Exit 0 when nothing is missing, 1 when something is, 2 on usage error. The exit code is a prompt to
# look, not proof of a defect.
set -uo pipefail

MAIN="${CLEANCORE_MAIN:-/mnt/h/LM_Studio_Workdir/CleanCore}"
WT="${1:-}"; shift || true
[ -n "$WT" ] && [ -d "$WT" ] || { echo "usage: cleancore-seam-sweep.sh <worktree> <ref> <ref> [...]" >&2; exit 2; }
[ "$#" -ge 2 ] || { echo "need at least two refs -- a seam has two sides" >&2; exit 2; }

REFS=("$@")
export SWEEP_WT="$WT" SWEEP_MAIN="$MAIN" SWEEP_REFS="${REFS[*]}"

python3 - <<'PY'
import os, subprocess, sys
from collections import Counter

WT   = os.environ['SWEEP_WT']
MAIN = os.environ['SWEEP_MAIN']
REFS = os.environ['SWEEP_REFS'].split()

def git(*a):
    return subprocess.run(['git', *a], cwd=MAIN, capture_output=True, text=True).stdout

def interesting(body):
    """Lines worth reporting. Braces, commas and comment prose produce noise, not findings: a lost
    `}` shows up as a syntax error anyway, and a comment moving is not a lost behaviour."""
    if len(body) < 8: return False
    return not (body.startswith('//') or body.startswith('*') or body.startswith('/*'))

def head_of(wt):
    return subprocess.run(['git','rev-parse','HEAD'],cwd=wt,capture_output=True,text=True).stdout.strip()

HEAD = head_of(WT)
# A ref that is NOT an ancestor of the merged tree did not go into this merge, and sweeping against it
# reports every commit it has since gained as a "loss". Measured: sweeping batch v4 (built on
# 0c6c41e7) against a moved origin/main (610408d6) produced 104 phantom findings -- a flood that
# would train anyone to ignore the tool. Name the ref you actually merged, not the branch pointer.
stale = []
for ref in REFS:
    full = git('rev-parse', ref).strip()
    if subprocess.run(['git','merge-base','--is-ancestor',full,HEAD],cwd=MAIN).returncode != 0:
        stale.append((ref, git('rev-parse','--short',ref).strip()))
if stale:
    print('REF NOT IN THIS MERGE -- the sweep would report its newer commits as losses:')
    for ref, short in stale:
        print(f'    {ref} ({short}) is not an ancestor of the merged tree ({HEAD[:8]})')
    print('Pass the sha this tree actually merged. Nothing swept.')
    sys.exit(2)

# Being an ancestor is NOT enough. A ref that is an OLDER ancestor of what the tree actually merged
# passes the check above and then reports every line the newer commits REMOVED as a loss. Measured:
# sweeping this batch against a remembered origin/main (610408d6) while the tree had merged effb863c
# gave 120 findings, all of them phantom -- 50e5bfc9 had landed in between and rewritten the file.
# The merge's own parents are the ground truth, so print them and say which passed ref is behind one.
PARENTS = git('rev-list', '--parents', '-n', '1', HEAD).split()[1:]
if PARENTS:
    print(f'merged tree {HEAD[:8]} merged: ' +
          ', '.join(git('rev-parse', '--short', p).strip() for p in PARENTS))
# Printed, not warned per-ref. Every card branch in a batch is legitimately BEHIND the first parent
# -- that is what a batch IS -- so a per-ref note fires on all of them and becomes the noise this
# tool already refuses to produce. One line naming what the tree actually merged is enough to catch
# the real mistake: passing a remembered origin/main that main has since moved past.

total = 0
for i, ref in enumerate(REFS):
    others = [r for r in REFS if r != ref]
    # The merge-base against the OTHER sides is what makes "this side added it" meaningful.
    mb = git('merge-base', ref, *others).strip() or git('merge-base', ref, others[0]).strip()
    if not mb:
        print(f'{ref}: no merge-base with the other refs -- skipped'); continue
    # Only files that still EXIST at `ref`. A file the range DELETED also shows up in --name-only, and
    # reporting it as "absent from the merge" is backwards: the merge is absent of it on purpose.
    at_ref = set(git('ls-tree', '-r', '--name-only', ref).split('\n'))
    files = [f for f in git('diff', '--name-only', f'{mb}..{ref}').split('\n')
             if f.strip() and f in at_ref]
    missing = []
    reflowed = 0
    for f in files:
        p = os.path.join(WT, f)
        if not os.path.exists(p):
            missing.append((f, '<FILE ABSENT FROM THE MERGE>')); continue
        # COUNT, not membership. The first version asked `body not in merged` over the whole file,
        # which is blind whenever the same text appears twice -- and it does constantly: an import
        # member, a field name, a repeated call. Mutation proved it: deleting `ExpectedConsignmentStatus,`
        # from the merged file left the sweep at 0, because the symbol also occurs further down. A line
        # is missing when the merge holds FEWER copies of it than the side that added it.
        merged_lines = [l.strip() for l in
                        open(p, encoding='utf-8', errors='replace').read().split('\n')]
        ref_lines = [l.strip() for l in git('show', f'{ref}:{f}').split('\n')]
        mc, rc = Counter(merged_lines), Counter(ref_lines)
        # A formatter run between the ref and the merged tree reflows lines, and a line-for-line
        # comparison calls every reflowed line a loss. Measured: 21 such findings on 3e224b35, all of
        # them prettier joining an `expect(` call the branch had split -- the pin was completely
        # intact. Unreported noise on that scale teaches people to ignore the tool, so the two cases
        # are separated: LOST (gone even when all whitespace is ignored) drives the exit code,
        # REFLOWED is counted and named but is not a finding.
        squashed = ''.join(merged_lines).replace(' ', '').replace('\t', '')
        for ln in git('diff', f'{mb}..{ref}', '--', f).split('\n'):
            if ln.startswith('+') and not ln.startswith('+++'):
                body = ln[1:].strip()
                if not interesting(body) or mc[body] >= rc[body]:
                    continue
                sq = body.replace(' ', '').replace('\t', '')
                # A joined call moves the trailing comma: `foo,` on its own line becomes `foo)` when
                # it is the last argument. Six of 3e224b35's findings were exactly this, and every one
                # was present in the merged file.
                #
                # But the relaxation is NOT safe for a bare identifier line. `ExpectedConsignmentStatus,`
                # is an import member, and without its comma it matches the type's every other use, so
                # deleting the import reads as a reflow -- the exact mutation this tool must catch, and
                # the relaxed rule swallowed it. A line earns the comma relaxation only if it carries
                # something that pins it to a position: a call, an assignment, a string, a key.
                # ...and the reflow check only applies to a line long enough to be unambiguous. The
                # squash concatenates the whole file, so a SHORT token matches almost anywhere:
                # `ExpectedConsignmentStatus,` is an import member that also occurs in a type list, so
                # deleting the import read as a reflow -- the very mutation this tool exists to catch.
                # Short lines are judged by COUNT alone, which is the strict, blind-spot-free path.
                distinctive = any(c in body for c in '()=\'":')
                long_enough = len(sq) >= 40
                if long_enough and (sq in squashed or (distinctive and sq.rstrip(',') in squashed)):
                    reflowed += 1
                else:
                    missing.append((f, f'{body[:90]}  [{rc[body]}x on the branch, {mc[body]}x merged]'))
    short = git('rev-parse', '--short', ref).strip() or ref
    tail = f', {reflowed} reflowed by a formatter (not a loss)' if reflowed else ''
    print(f'{ref} ({short}): {len(files)} file(s) touched, {len(missing)} added line(s) NOT in the merge{tail}')
    for f, b in missing[:25]:
        print(f'    {f}: {b}')
    if len(missing) > 25:
        print(f'    ... and {len(missing)-25} more')
    total += len(missing)

print(f'SEAM SWEEP: {total} line(s) to look at')
sys.exit(1 if total else 0)
PY

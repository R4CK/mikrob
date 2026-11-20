#!/usr/bin/env python3
"""Self-test for sha_content_equivalence.py (card ec34c025).

Builds two tiny throwaway git repos (standing in for the marveen/mopsion clones) and exercises
content_verdict() against real git history -- not mocks -- the same discipline
gate-closure-check.selftest.py already uses for the landed-check. shas_agree/sha_sets_agree are
pure string logic and get direct unit cases.
"""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# _CLONES is built at import time from these env vars, so they must be set BEFORE the import --
# setting them afterwards (as the test repo's path becomes known) would be silently ignored.
_TMPROOT = tempfile.mkdtemp()
_REPO = os.path.join(_TMPROOT, "repo")
os.makedirs(_REPO)
os.environ["MARVEEN_MAIN"] = _REPO
os.environ["MOPSION_MAIN"] = "/nonexistent-clone-for-selftest"

import sha_content_equivalence as sce  # noqa: E402

failures = []
n = 0


def check(label, got, want):
    global n
    n += 1
    ok = got == want
    print("%s %-55s got=%r want=%r" % ("OK  " if ok else "FAIL", label, got, want))
    if not ok:
        failures.append((label, want, got))


def check_startswith(label, got, want_prefix_in):
    global n
    n += 1
    ok = got[0] == want_prefix_in[0] and want_prefix_in[1] in got[1]
    print("%s %-55s got=%r" % ("OK  " if ok else "FAIL", label, got))
    if not ok:
        failures.append((label, want_prefix_in, got))


check("shas_agree exact", sce.shas_agree("abc1234", "abc1234"), True)
check("shas_agree short-prefixes-long", sce.shas_agree("abc1234", "abc1234567890"), True)
check("shas_agree differ", sce.shas_agree("abc1234", "def5678"), False)
check("sha_sets_agree intersecting", sce.sha_sets_agree(("a1", "b2"), ("c3", "b2x")), True)
check("sha_sets_agree disjoint", sce.sha_sets_agree(("a1",), ("b2",)), False)


def run(*args):
    subprocess.run(args, check=True, capture_output=True, text=True)


def git(repo, *args):
    p = subprocess.run(("git", "-C", repo) + tuple(args), capture_output=True, text=True)
    return p.stdout.strip()


if True:
    repo = _REPO
    run("git", "-C", repo, "init", "-q")
    run("git", "-C", repo, "config", "user.email", "t@t.t")
    run("git", "-C", repo, "config", "user.name", "t")

    with open(os.path.join(repo, "a.txt"), "w") as f:
        f.write("base\n")
    run("git", "-C", repo, "add", "a.txt")
    run("git", "-C", repo, "commit", "-q", "-m", "base")
    base = git(repo, "rev-parse", "HEAD")

    # Commit X: the "work commit" -- adds a real change.
    with open(os.path.join(repo, "a.txt"), "w") as f:
        f.write("base\nreal change\n")
    run("git", "-C", repo, "add", "a.txt")
    run("git", "-C", repo, "commit", "-q", "-m", "work commit")
    work_sha = git(repo, "rev-parse", "HEAD")

    # Commit Y: the "landing" -- same file content as X, plus a version bump (package.json),
    # simulating a work-commit-vs-landing-merge pair.
    run("git", "-C", repo, "checkout", "-q", base)
    with open(os.path.join(repo, "a.txt"), "w") as f:
        f.write("base\nreal change\n")
    with open(os.path.join(repo, "package.json"), "w") as f:
        f.write('{"version":"1.0.1"}\n')
    run("git", "-C", repo, "add", "a.txt", "package.json")
    run("git", "-C", repo, "commit", "-q", "-m", "landing: same content + version bump")
    landing_sha = git(repo, "rev-parse", "HEAD")

    # Commit Z: genuinely different content.
    run("git", "-C", repo, "checkout", "-q", base)
    with open(os.path.join(repo, "a.txt"), "w") as f:
        f.write("base\nDIFFERENT change\n")
    run("git", "-C", repo, "add", "a.txt")
    run("git", "-C", repo, "commit", "-q", "-m", "a different commit")
    differs_sha = git(repo, "rev-parse", "HEAD")

    check("content_verdict same (work vs landing, churn ignored)",
          sce.content_verdict([work_sha], [landing_sha])[0], "same")
    check("content_verdict differs (real content diverges)",
          sce.content_verdict([work_sha], [differs_sha])[0], "differs")
    check_startswith("content_verdict unresolved (neither sha exists anywhere)",
                      sce.content_verdict(["deadbeef1234567"], ["deadbeef1234567"]),
                      ("unresolved", "could not resolve"))
    check("_is_version_bump true on a bump subject",
          sce._is_version_bump(repo, work_sha), False)

import shutil  # noqa: E402
shutil.rmtree(_TMPROOT, ignore_errors=True)

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for f in failures:
    print("  - %s: expected %s, got %s" % f)
sys.exit(1 if failures else 0)

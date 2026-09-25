#!/usr/bin/env python3
"""Self-test for suite-sha-check.py (card 08eb6402).

Runs against a REAL scratch git repository, the same reason gate-closure-check.selftest.py's
landing block does: content-equivalence between two shas is a question only git can answer, so a
simulated diff would test the simulation, not the tool. `MARVEEN_MAIN` is pointed at the scratch
repo for every case, so this never reads the real marveen/CleanCore checkouts.
"""
import json
import os
import subprocess
import sys
import tempfile

CHECK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "suite-sha-check.py")

failures = []
n = 0

REPO = tempfile.mkdtemp(prefix="suite-sha-check-selftest-")


def _g(*args):
    subprocess.run(("git", "-C", REPO) + args, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _rev(ref="HEAD"):
    return subprocess.run(("git", "-C", REPO, "rev-parse", ref),
                          capture_output=True, text=True, check=True).stdout.strip()


def _write(rel, text):
    with open(os.path.join(REPO, rel), "w") as f:
        f.write(text)


print("suite-sha-check selftest")

try:
    _g("init", "-q", "-b", "main", ".")
    _g("config", "user.email", "s@s")
    _g("config", "user.name", "s")
    _write("a.txt", "base\n")
    _write("README.md", "readme v1\n")
    _g("add", "-A"); _g("commit", "-qm", "base")

    # WORK_SHA: the pre-merge branch tip a gate actually reviewed and full-suite-tested.
    _write("a.txt", "work content\n")
    _g("commit", "-qam", "the work a gate reviewed")
    WORK_SHA = _rev()

    # From WORK_SHA, three different "what the merge turned out to be" shapes:
    _g("branch", "same-branch", WORK_SHA)
    _g("checkout", "-q", "same-branch")
    _write("c.txt", "unrelated addition\n")  # a.txt untouched
    _g("add", "-A"); _g("commit", "-qm", "merge added something unrelated")
    MERGE_SAME = _rev()

    _g("checkout", "-q", WORK_SHA)
    _g("checkout", "-q", "-b", "harmless-branch")
    _write("README.md", "readme v2, unrelated churn\n")  # only README.md moved
    _g("commit", "-qam", "merge moved README (per-landing churn)")
    MERGE_HARMLESS = _rev()

    _g("checkout", "-q", WORK_SHA)
    _g("checkout", "-q", "-b", "stale-branch")
    _write("a.txt", "DIFFERENT content the suite never saw\n")
    _g("commit", "-qam", "merge substantively changed the reviewed file")
    MERGE_STALE = _rev()

    _g("checkout", "-q", "main")
    _repo_ok = True
except Exception as exc:  # noqa: BLE001
    _repo_ok = False
    print("FAIL      could not build the fixture repo: %s" % exc)
    failures.append(("fixture repo", "built", str(exc)))

ENV = dict(os.environ)
ENV["MARVEEN_MAIN"] = REPO
ENV["CLEANCORE_MAIN"] = "/nonexistent-cleancore-for-this-selftest"


def run(comments, merge_sha, env=None):
    e = dict(ENV)
    if env:
        e.update(env)
    p = subprocess.run([sys.executable, CHECK, merge_sha],
                       input=json.dumps(comments), capture_output=True, text=True, env=e)
    return p.stdout.strip(), p.returncode


def c(author, content, created_at=None):
    d = {"author": author, "content": content}
    if created_at is not None:
        d["created_at"] = created_at
    return d


def case(label, comments, merge_sha, expect_kind, env=None):
    global n
    n += 1
    out, rc = run(comments, merge_sha, env)
    kind = out.split("|", 1)[0]
    ok = kind == expect_kind and rc == 0
    print("%s %-10s <- %-10s %s" % ("OK  " if ok else "FAIL", expect_kind, kind, label))
    if not ok:
        failures.append((label, expect_kind, "%s (rc=%s)" % (out, rc)))
    return out


if _repo_ok:
    case("no Suite-SHA line anywhere -> MISSING",
         [c("qa", "QA PASS\nGate-SHA: %s" % WORK_SHA)], MERGE_SAME, "MISSING")

    case("merge added only unrelated content -> PRESENT",
         [c("qa", "QA PASS\nSuite-SHA: %s 786/786 zold" % WORK_SHA)], MERGE_SAME, "PRESENT")

    case("merge moved only a per-landing-churn file (README.md) -> still PRESENT",
         [c("qa", "QA PASS\nSuite-SHA: %s 786/786 zold" % WORK_SHA)], MERGE_HARMLESS, "PRESENT")

    case("merge substantively changed the reviewed file -> STALE, fail-closed",
         [c("qa", "QA PASS\nSuite-SHA: %s 786/786 zold" % WORK_SHA)], MERGE_STALE, "STALE")

    case("Suite-SHA cites a commit no known clone holds -> UNRESOLVED, fail-closed",
         [c("qa", "QA PASS\nSuite-SHA: aaaa1111aaaa1111 786/786 zold")], MERGE_SAME, "UNRESOLVED")

    case("ANY gate's evidence counts, not just QA",
         [c("cybersec", "CYBERSEC GO\nSuite-SHA: %s 786/786 zold" % WORK_SHA)],
         MERGE_SAME, "PRESENT")

    out = case(
        "the LATEST Suite-SHA line wins when there are several (chronological order)",
        [c("qa", "QA PASS\nSuite-SHA: aaaa1111aaaa1111 stale evidence", created_at=100),
         c("cybersec", "CYBERSEC GO\nSuite-SHA: %s 786/786 zold" % WORK_SHA, created_at=200)],
        MERGE_SAME, "PRESENT",
    )
    assert WORK_SHA in out, "expected the LATER (WORK_SHA) evidence to be the one reported"

    # Fail-closed on the merge_sha side too: the two failure directions must stay distinguishable.
    n += 1
    out, rc = run([c("qa", "QA PASS\nSuite-SHA: %s 786/786 zold" % WORK_SHA)],
                  "0000000000000000000000000000000000000")
    ok = out.startswith("UNRESOLVED|") and rc == 0
    print("%s %-10s <- %-10s %s" % ("OK  " if ok else "FAIL", "UNRESOLVED", out.split("|", 1)[0],
                                     "merge sha argument does not resolve in any clone"))
    if not ok:
        failures.append(("merge sha does not resolve", "UNRESOLVED", "%s (rc=%s)" % (out, rc)))

    n += 1
    out, rc = run([c("qa", "QA PASS\nSuite-SHA: %s 786/786 zold" % WORK_SHA)], "not-a-sha")
    ok = out.startswith("UNRESOLVED|") and rc == 0
    print("%s %-10s <- %-10s %s" % ("OK  " if ok else "FAIL", "UNRESOLVED", out.split("|", 1)[0],
                                     "a non-hex merge sha argument never crashes the check"))
    if not ok:
        failures.append(("non-hex merge sha argv", "UNRESOLVED", "%s (rc=%s)" % (out, rc)))

# Malformed stdin must never crash the check -- a landing script depends on this exiting 0 with a
# safe answer, not tracebacking and leaving the caller to guess what REFUSED means.
n += 1
p = subprocess.run([sys.executable, CHECK, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
                   input="not json at all", capture_output=True, text=True, env=ENV)
ok = p.returncode == 0 and p.stdout.strip().startswith("UNRESOLVED|")
print("%s %-10s <- %-10s %s" % ("OK  " if ok else "FAIL", "UNRESOLVED",
                                 p.stdout.strip().split("|", 1)[0] or "(nothing)",
                                 "malformed stdin JSON never crashes the check"))
if not ok:
    failures.append(("malformed stdin", "UNRESOLVED (rc=0)", "%r (rc=%s)" % (p.stdout, p.returncode)))

print()
print("selftest: %d case(s), %s" % (n, "PASS" if not failures else "FAIL"))
for label, expect, got in failures:
    print("  - %s: expected %s, got %s" % (label, expect, got))
sys.exit(1 if failures else 0)

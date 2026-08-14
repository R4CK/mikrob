#!/usr/bin/env python3
"""Resolve the ONE conflict shape this batch produces: two branches adding INDEPENDENT wiring to
the same composition-root region. Keep both sides, HEAD first.

The trap this exists to avoid: several of these hunks are a ternary whose closing `: undefined`
sits OUTSIDE the conflict block and is shared by both sides. Stripping the markers naively leaves
the HEAD side's last const without its else-branch, which either fails to compile or -- worse, if
the shapes line up -- quietly binds one wiring's fallback to the other.

TWO HEURISTICS HAVE ALREADY BEEN WRONG HERE, so this one counts instead of pattern-matching:

  v1 "both sides end in a `?` line"  -- missed a MULTI-LINE call, `? createX(\n args,\n)`, which
     ends in `)`, not in the `?` line.
  v2 "`: undefined` does not appear in the HEAD side" -- missed a HEAD side containing THREE
     wirings, the first two closed with their own `: undefined` and only the third left open. The
     substring was present, so the rule concluded nothing was needed.

The invariant that actually holds: inside a side, every line-initial `?` then-branch must be
answered by a line-initial `: undefined`. If the HEAD side has one more then-branch than
else-branch, its last ternary is the one the shared trailing line was going to close -- so HEAD
gets its own copy and the original closes the incoming side.

Anything that is NOT this shape is left conflicted on purpose: it must be read by a human.
"""
import re
import sys

CONFLICT = re.compile(
    r"^<<<<<<< [^\n]*\n(?P<ours>.*?)^=======\n(?P<theirs>.*?)^>>>>>>> [^\n]*\n",
    re.S | re.M,
)
THEN = re.compile(r"^\s*\?\s", re.M)      # `? createX(...)` -- never matches a mid-line `??`
ELSE = re.compile(r"^\s*:\s", re.M)          # ANY line-initial else-branch, not just `: undefined`
TAIL_ELSE = re.compile(r"^\s*:\s*undefined\s*$", re.M)   # the shape that can be SHARED below a hunk


def unclosed(side):
    """How many line-initial ternary then-branches are left without their `: undefined`."""
    return len(THEN.findall(side)) - len(ELSE.findall(side))


def code_of(line):
    """The line without its trailing `//` comment, so two sides that differ ONLY in an added
    attribution comment still compare equal.

    This exists because the first version of the duplication guard compared raw lines and did NOT
    fire on the real case it was written for: the two sides carried the SAME
    `await pool.query(controlMig('0065_...sql'))`, one of them with ` // 76058b11 ...` appended. My
    selftest used two byte-identical lines and passed vacuously. The `//` is only treated as a
    comment when the quotes before it are balanced, so a `https://` inside a string survives.
    """
    i = line.find("//")
    while i != -1:
        head = line[:i]
        if head.count("'") % 2 == 0 and head.count('"') % 2 == 0 and head.count("`") % 2 == 0:
            return head.strip()
        i = line.find("//", i + 2)
    return line.strip()


def significant(line):
    """A line whose duplication would change behaviour. Comments and lone punctuation would not."""
    s = code_of(line)
    return bool(s) and not s.startswith("*") and len(s.strip("{}()[],;")) > 3


def overlaps(ours, theirs):
    """Lines both sides contain. Keeping both would EXECUTE them twice.

    Found the hard way: two cards independently added the same
    `await pool.query(controlMig('0065_...sql'))` line to an e2e setup -- two fixes for one defect.
    "Keep both" duplicated the migration, and because the whole file is env-gated it would have
    skipped green without PG_E2E_URL rather than failing. An identical line on both sides is a sign
    the two changes are the SAME change, which is a decision, not a merge.
    """
    a = {code_of(l) for l in ours.splitlines() if significant(l)}
    b = {code_of(l) for l in theirs.splitlines() if significant(l)}
    return sorted(a & b)


def resolve(text):
    out = []
    pos = 0
    stats = {"kept_both": 0, "duplicated_tail": 0, "shared_line": 0}
    for m in CONFLICT.finditer(text):
        out.append(text[pos:m.start()])
        ours, theirs = m.group("ours"), m.group("theirs")
        tail = text[m.end():].split("\n", 1)[0] + "\n"
        dup = overlaps(ours, theirs)
        if dup:
            out.append(m.group(0))
            stats["shared_line"] += 1
            for d in dup[:3]:
                print(f"    both sides contain: {d[:90]}")
        # The shared closing line can only be shared if BOTH sides are one `: undefined` short of
        # balance -- ours because it ends open, theirs because the tail below was written for it.
        elif TAIL_ELSE.match(tail) and unclosed(ours) == 1 and unclosed(theirs) == 1:
            out.append(ours + tail + theirs)
            stats["duplicated_tail"] += 1
        elif unclosed(ours) != 0 or unclosed(theirs) != 0:
            # Unbalanced in some other way -- exactly the case a wrong guess breaks silently.
            out.append(m.group(0))
        else:
            out.append(ours + theirs)
            stats["kept_both"] += 1
        pos = m.end()
    out.append(text[pos:])
    return "".join(out), stats


def _selftest():
    cases = [
        ("balanced additive", "<<<<<<< a\n  x: 1,\n=======\n  y: 2,\n>>>>>>> b\n  z: 3,\n",
         "  x: 1,\n  y: 2,\n  z: 3,\n"),
        ("shared tail, single-line then on each side",
         "<<<<<<< a\nconst p = e\n    ? f()\n=======\nconst q = e\n    ? g()\n>>>>>>> b\n    : undefined\n",
         "const p = e\n    ? f()\n    : undefined\nconst q = e\n    ? g()\n    : undefined\n"),
        # v2's blind spot: two closed wirings then one open one, in the SAME side.
        ("shared tail, HEAD already contains other `: undefined` lines",
         "<<<<<<< a\nconst p = e\n    ? f()\n    : undefined\nconst r = e\n    ? h(\n        arg,\n      )\n=======\nconst q = e\n    ? g()\n>>>>>>> b\n    : undefined\n",
         "const p = e\n    ? f()\n    : undefined\nconst r = e\n    ? h(\n        arg,\n      )\n    : undefined\nconst q = e\n    ? g()\n    : undefined\n"),
    ]
    fails = 0
    for name, src, want in cases:
        got, _ = resolve(src)
        if got != want:
            print(f"  FAIL {name}\n    got:  {got!r}\n    want: {want!r}")
            fails += 1
    # An identical significant line on both sides must NOT be duplicated.
    same = ("<<<<<<< a\n      await pool.query(controlMig('0065_x.sql'))\n"
            "=======\n      await pool.query(controlMig('0065_x.sql'))\n"
            "      await pool.query(controlMig('0094_y.sql'))\n>>>>>>> b\n")
    got, _ = resolve(same)
    if "<<<<<<<" not in got:
        print("  FAIL a line present on BOTH sides was duplicated instead of left for a human")
        fails += 1
    # The REAL shape: same statement, one side carrying an extra attribution comment.
    commented = ("<<<<<<< a\n      await pool.query(controlMig('0065_x.sql'))\n"
                 "=======\n      await pool.query(controlMig('0065_x.sql')) // 76058b11 sha256\n"
                 "      await pool.query(controlMig('0094_y.sql')) // due_at\n>>>>>>> b\n")
    got, _ = resolve(commented)
    if "<<<<<<<" not in got:
        print("  FAIL a shared line differing only by a trailing comment was duplicated")
        fails += 1
    # A ternary closed with a REAL else-branch (not `: undefined`) is balanced, so an otherwise
    # additive hunk must still resolve. This was a false refusal until ELSE stopped insisting on
    # the literal `undefined`.
    other_else = ("<<<<<<< a\n  const t = e.R\n    ? makeRedis(e.R)\n    : makeMemory()\n"
                  "=======\n  const u = e.D\n    ? makePg(e.D)\n    : undefined\n>>>>>>> b\n")
    got, _ = resolve(other_else)
    if "<<<<<<<" in got:
        print("  FAIL an additive hunk whose ternary closes with a real value was left conflicted")
        fails += 1
    # A `//` inside a string must not be mistaken for a comment.
    urls = "<<<<<<< a\n  const a = 'https://one.example'\n=======\n  const b = 'https://two.example'\n>>>>>>> b\n"
    got, _ = resolve(urls)
    if "<<<<<<<" in got:
        print("  FAIL two DIFFERENT string literals containing // were treated as the same line")
        fails += 1

    # A purely additive hunk with no shared line must still resolve.
    add = "<<<<<<< a\n  alphaStore: makeAlpha(),\n=======\n  betaStore: makeBeta(),\n>>>>>>> b\n"
    got, _ = resolve(add)
    if "<<<<<<<" in got:
        print("  FAIL an additive hunk was left conflicted")
        fails += 1

    # An unbalanced shape must stay conflicted rather than be guessed at.
    odd = "<<<<<<< a\nconst p = e\n    ? f()\n=======\n  plain: 1,\n>>>>>>> b\n"
    got, _ = resolve(odd)
    if "<<<<<<<" not in got:
        print("  FAIL unbalanced shape was resolved instead of left for a human")
        fails += 1
    print(f"selftest: {len(cases) + 6} case(s), {'PASS' if fails == 0 else 'FAIL'}")
    return fails


if __name__ == "__main__":
    if sys.argv[1:2] == ["--selftest"]:
        sys.exit(_selftest())
    rc = 0
    for path in sys.argv[1:]:
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        new, stats = resolve(src)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(new)
        left = new.count("<<<<<<<")
        print(f"  {path}: kept both on {stats['kept_both']}, duplicated a shared tail on "
              f"{stats['duplicated_tail']}, LEFT FOR A HUMAN: {left}")
        if left:
            rc = 2
    sys.exit(rc)

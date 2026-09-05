#!/usr/bin/env python3
"""Narrow auto-resolution for ONE README conflict shape: both branches appended a
fork-feature bullet at the same point in the same bullet run.

WHY A SEPARATE TOOL, not a widening of store/decisions-append-union.sh (card 8b73953c,
plan-grilling verdict 20512 + MikroB's decision 20555, variant (b)):

  - MEASURED, not assumed: of the ways two branches can add a README bullet, only ONE
    conflicts at all. Insertions far apart merge cleanly; insertions into ADJACENT positions
    also merge cleanly; only two insertions at the SAME position conflict. The whole value of
    automating this therefore sits in a single shape, and (b) covers 100% of the measured
    conflicting cases with a fraction of the surface of a general region-union.
  - The DECISIONS function collected three gate findings on card b7e57877, every one of them
    from widening its boundary logic. Touching it again -- while it is in gate -- to serve a
    different file with a different structure would repeat that exactly.

WHY PYTHON rather than more bash: that card lost three review rounds to byte-versus-character
indexing (`cmp` reports bytes; bash `${#v}` counts characters unless LC_ALL=C). That entire
class does not exist here, and this is list-of-lines work. The landing script calls it as a
subprocess.

CONTRACT
  resolve <base> <ours> <theirs> <name> <out>   <name> is the repo-relative path checked
                                                against the allowlist. exit 0 = resolved and
                                                <out> written; exit 1 = refused, <out> is left
                                                untouched so a refusal can never leave a
                                                half-resolved file behind.
  explain <base> <ours> <theirs> <name>         prints the decision and its reason, writes
                                                nothing. This is the dry-run mode the plan
                                                required before anything is wired live.

The caller must already be holding a real merge conflict on exactly this one file; deciding
that is the caller's job, not this tool's.
"""
import sys

# EXPLICIT ALLOWLIST, in code, hand-maintained (verdict item (c)). Auto-detecting which files
# are "append-only" was rejected in the plan-grilling: a wrong positive would silently corrupt
# a file that is not append-only, and the blast radius here is a landing tool.
ALLOWED_FILES = ("README.md",)

# The entry form, measured on the WHOLE file rather than on a sample (verdict assumption 1):
# the fork section holds 92 bullets, every one a single line of 140-654 characters, with ZERO
# indented continuation lines. So "one entry = one line starting with '- **'" is a fact about
# this corpus rather than a guess -- but it is still checked per line, never assumed.
ENTRY_PREFIX = "- **"

# Lines that may differ from the merge-base inside the shared surround without making the
# merge ambiguous. Same reasoning as the DECISIONS union: blank lines and horizontal rules
# carry no content that could be silently glued to something else.
FILLER = ("", "---", "***", "___")


def _common_prefix_len(a, b):
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n]:
        n += 1
    return n


def _common_suffix_len(a, b, floor):
    """Length of the shared tail, never eating into the shared head.

    `floor` is the prefix length. Without it, two sides that agree everywhere would have
    prefix and suffix overlap and the "middle" would come out negative; bounding here is what
    keeps the two middles disjoint by construction rather than by luck.
    """
    n = 0
    while n < len(a) - floor and n < len(b) - floor and a[len(a) - 1 - n] == b[len(b) - 1 - n]:
        n += 1
    return n


def decide(base, ours, theirs, filename):
    """Return (ok, reason, union_or_None). Every refusal names itself."""
    if filename not in ALLOWED_FILES:
        return False, "%s is not on the allowlist %s" % (filename, list(ALLOWED_FILES)), None

    b, o, t = base.split("\n"), ours.split("\n"), theirs.split("\n")
    p = _common_prefix_len(o, t)
    s = _common_suffix_len(o, t, p)
    o_mid, t_mid = o[p:len(o) - s], t[p:len(t) - s]

    # Both sides must actually have added something. If one middle is empty git would not have
    # conflicted this region, so reaching here means an assumption above is wrong: refuse
    # rather than answer for a state that should not exist.
    if not o_mid or not t_mid:
        return False, "one side added nothing in the diverging region", None

    # THE STRUCTURAL GUARANTEE, deliberately STRICTER than the DECISIONS one. There, the shared
    # prefix may legitimately drift from the merge-base (both sides made the same edit
    # elsewhere). Here the entire claim is "both sides only inserted bullets at one point", so
    # the text around that point must be exactly the merge-base. A reworded bullet, a touched
    # doc table, an edited intro paragraph -- all different situations, all manual resolution.
    #
    # This is what makes the tool safe without knowing what a README "means": it never has to
    # recognise an entry boundary by shape, because the boundary is wherever the two sides
    # stopped agreeing, and everything outside it has to be untouched. Same lesson as card
    # b7e57877's third round -- ask about the merge, not about what a line looks like.
    surround = o[:p] + (o[len(o) - s:] if s else [])
    if surround != b:
        # The one benign difference: filler lines both sides added identically.
        if [x for x in surround if x.strip() not in FILLER] != [x for x in b if x.strip() not in FILLER]:
            return False, "the text around the insertion point is not the merge-base", None

    # Each middle must be whole bullet entries and nothing else. A continuation line, a
    # heading, a table row or a paragraph here means the region is not a bullet run, and the
    # union would splice unrelated prose together.
    for label, mid in (("ours", o_mid), ("theirs", t_mid)):
        for line in mid:
            if line.strip() == "":
                continue
            if not line.startswith(ENTRY_PREFIX):
                return False, "%s added a non-bullet line: %r" % (label, line[:60]), None

    union = o[:p] + o_mid + t_mid + (o[len(o) - s:] if s else [])
    return True, "both sides appended bullet entries at the same point", "\n".join(union)


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def main(argv):
    if len(argv) == 7 and argv[1] == "resolve":
        ok, reason, union = decide(_read(argv[2]), _read(argv[3]), _read(argv[4]), argv[5])
        if not ok:
            print("refused: %s" % reason, file=sys.stderr)
            return 1
        with open(argv[6], "w", encoding="utf-8") as fh:
            fh.write(union)
        return 0
    if len(argv) == 6 and argv[1] == "explain":
        ok, reason, _ = decide(_read(argv[2]), _read(argv[3]), _read(argv[4]), argv[5])
        print("%s: %s" % ("RESOLVED" if ok else "refused", reason))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

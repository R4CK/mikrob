#!/usr/bin/env python3
"""claude-md-split-reachability-check.py <old-claude-md-git-ref> <new-claude-md-path> <docs-rules-dir>

Card c60e229a: proves that the CLAUDE.md -> docs/rules/ split did not drop any binding
sentence. Reads the OLD CLAUDE.md at <old-claude-md-git-ref> (ground truth, pre-split),
extracts every LINE containing (case-insensitively) KOTELEZ, TILOS or MUST, and checks each
is a substring of the concatenation of the NEW CLAUDE.md and every docs/rules/*.md file.

Also checks that every machine-generated BEGIN/END marker pair (<!-- BEGIN GENERATED: name -->
... <!-- END GENERATED: name -->) that exists in the OLD CLAUDE.md has BOTH its BEGIN and its
END present in the NEW CLAUDE.md file itself -- not merely "somewhere in the corpus". QA FAIL
30388 (card c60e229a) found a boundary bug the plain substring check could not: a moved
section's text ran directly into the next block's BEGIN marker with no blank line between them,
so the move script swept that marker into the moved file, leaving CLAUDE.md with an END marker
and no matching BEGIN -- a line the substring check still finds (so "0 missing"), but in the
WRONG file, which breaks the marker-pair idempotency contract every ensureXSection() writer
relies on (a missing BEGIN reads as "no block yet", so a future non-no-op writer would append a
second, duplicate block instead of recognizing the existing one).

Also runs a full non-empty-LINE MULTISET conservation check (WhiteHat2 NO-GO 30400, L1): every
non-empty line of the OLD CLAUDE.md must occur in the new corpus (new CLAUDE.md + docs/rules/*.md)
at least as many times as it did in the old file. This is strictly stronger than the keyword
check -- it catches ANY line dropped during the split, not only ones containing a gating word --
and was measured against mutants WhiteHat2's keyword-only version missed: a whole default-deny
sentence deleted from a docs/rules file (missed by keyword-substring, caught here because the
exact line vanishes from the corpus multiset).

Exit 0 if every gating line is found, every marker pair matches, the line-multiset
conservation check is clean, AND the index-structure check below is clean. 1 otherwise.

KOTELEZ/TILOS/MUST/MEGSZEGHETETLEN/SOHA/MINDIG are ALL gating now (card c60e229a QA/WhiteHat2
NO-GO round: SOHA/MEGSZEGHETETLEN/MINDIG used to be informational-only, which L1 flagged as a
real gap -- promoted to gating here; the line-conservation check below also does not care which
specific word a line contains, so this mainly affects what the per-word report prints).

Card cc72cb3e (CYBERED GO 30478 on c60e229a, Gate-SHA b9ee959cb): the checks above are a
one-way "was anything REMOVED" conservation proof -- RedHat ran 10 additive/structural mutants
through them that all exit 0 ("0 missing") while weakening a binding rule, because none of them
remove the old line, they add/hide/misdirect around it. check_index_structure() below adds
checks that do not depend on the old-ref diff at all, closing each of the 10 (A1-A10, RedHat's
own numbering, comment 30478):
  - A3/A10 (wrap a bullet in an HTML comment / code fence to hide it from a rendered read):
    strip_inert_markup() removes both before anything below looks at the text, so a hidden
    bullet simply does not exist for this check -- same effect as A6 (delete it outright).
  - A6 (delete the whole index bullet) / A3 / A10: the bullet count check requires >= 64
    VISIBLE numbered per-rule bullets (37 + 15 + 12, the three indexed sections).
  - A1 (append a contradicting exception into the index bullet itself) / A2 (prepend a
    qualifying sentence to the index bullet) / A5 (invert the index bullet's meaning): the
    verbatim-substring check requires each bullet's bold lead sentence to be found, unchanged,
    inside its OWN linked rule file -- added or inverted text does not exist there.
  - A4 (move the rule to an unlinked docs/rules file): the orphan-file check requires every
    docs/rules/*.md file to be linked from somewhere in CLAUDE.md; an unlinked file is flagged.
    The verbatim check also fails independently, since the bullet's own linked file no longer
    contains the (moved-away) text.
  - A7 (corrupt a protocol token in the index): a protocol-token floor check requires each of
    the 14 H1 tokens to occur at least once in CLAUDE.md -- this catches a corruption of the
    LAST remaining occurrence of a token (what RedHat's probe actually hit); it is a floor, not
    a full per-occurrence diff, and says so below.
  - A8 (link to a file that does not exist) / A9 (a relative link instead of the repo-root-
    absolute convention): checked directly per bullet.
Residual, NOT claimed closed: a contradiction or qualifier added as its own SEPARATE bullet or
paragraph (not touching the original bullet's own text) is still invisible to every check here,
same as to the one-way conservation check -- this is RedHat's own stated limit (memory:
a-one-way-conservation-check-proves-nothing-was-lost-not-that-nothing-was-weakened), not
something this card closes.
"""
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

GATING_TOKENS = ["KOTELEZ", "KÖTELEZ", "TILOS", "MUST", "MEGSZEGHETETLEN", "SOHA", "MINDIG"]


def normalize(s: str) -> str:
    return re.sub(r"[ \t]+", " ", s).strip()


def git_show(ref: str, path: str) -> str:
    out = subprocess.run(
        ["git", "show", f"{ref}:{path}"],
        capture_output=True, text=True, encoding="utf-8", check=True,
    )
    return out.stdout


def extract_lines(text: str, tokens: list[str]) -> list[tuple[int, str]]:
    hits = []
    for i, line in enumerate(text.split("\n"), start=1):
        upper = line.upper()
        if any(tok in upper for tok in tokens):
            norm = normalize(line)
            if norm:
                hits.append((i, norm))
    return hits


# Protocol tokens (WhiteHat2 H1, komment 30400): must stay verbatim, inline, in CLAUDE.md
# itself. A floor check (>=1 occurrence), not a full per-occurrence diff -- see module docstring.
H1_TOKENS = [
    "QA PASS", "CYBERSEC GO", "CYBERSEC NO-GO", "CYBERED GO", "CYBERED NO-GO",
    "Gate-SHA:", "Fix-Direction:", "Pair-FE:", "Pair-BE:", "BLOKKOLT-",
    "ELUTASÍTVA", "Kész, ha:", "allowFrom", "DEFAULT-DENY",
]

# Per-rule index bullets whose lead sentence is a hand-written paraphrase, not a verbatim
# substring of the rule file (RedHat F3, comment 30478) -- accepted, not re-opened here.
VERBATIM_ALLOWLIST = {"8a", "19"}

RULE_BULLET_RE = re.compile(
    r"^\s*-\s+\*\*([0-9]+[a-z]?)\.\*\*\s+\*\*(.+?)\*\*(.*)\((/home/neon/marveen/docs/rules/[^)]+\.md)\)\s*$"
)


def strip_inert_markup(text: str) -> str:
    """Remove HTML comments and fenced code blocks: a bullet hidden inside either renders as
    invisible to an agent reading the file, so it must also be invisible to every check below
    (RedHat A3/A10) -- the raw text being technically still in the file is not enough."""
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    return text


def find_rule_bullets(visible_claude_md: str) -> list[tuple[str, str, str, str]]:
    """Returns (rule_num, lead_sentence, rest_of_bullet, link_path) for every VISIBLE numbered
    per-rule index bullet (the "- **N.** **Lead.** rest ... (path)" lines under the three
    indexed sections)."""
    out = []
    for line in visible_claude_md.split("\n"):
        m = RULE_BULLET_RE.match(line)
        if m:
            out.append((m.group(1), m.group(2), m.group(3), m.group(4)))
    return out


def check_index_structure(new_text: str, rules_dir: Path) -> list[str]:
    problems = []
    visible = strip_inert_markup(new_text)

    bullets = find_rule_bullets(visible)
    # 37 munkavegzesi (1-22 + letters) + 5 (22a-22e, card cc72cb3e F1) + 15 kodminosegi +
    # 12 ellenorizheto-munka + 2 szemelyiseg (card cc72cb3e F1) = 71. A floor, not an exact
    # count: a future card adding MORE bullets should not need to touch this number, only one
    # removing/hiding a bullet without replacing it should.
    MIN_BULLETS = 71
    if len(bullets) < MIN_BULLETS:
        problems.append(
            f"only {len(bullets)} visible numbered per-rule index bullets found, want >= {MIN_BULLETS}"
        )

    linked_files = set()
    for num, lead, rest, link in bullets:
        linked_files.add(Path(link).name)
        if not link.startswith("/home/neon/marveen/docs/rules/"):
            problems.append(f"rule {num}: link is not repo-root-absolute under docs/rules/: {link}")
            continue
        target = Path(link)
        if not target.is_file():
            problems.append(f"rule {num}: link target does not exist: {link}")
            continue
        if num in VERBATIM_ALLOWLIST:
            continue
        # Check the WHOLE bullet (lead + the rest of the line up to the link), not only the
        # bold lead: RedHat A5 inverted "Peti jóváhagyása kell" to "...NEM kell" in the
        # NON-bold tail of an index bullet, which a lead-only check never looks at. Many
        # bullets deliberately truncate with a trailing ellipsis (RedHat F3) -- that is a
        # legitimate cut, not new content, so it is stripped before comparing, never treated
        # as part of the text that must match.
        full = (lead + rest).strip()
        full = re.sub(r"[…]+\s*$", "", full)  # trailing "…"
        full = re.sub(r"\.{3,}\s*$", "", full)  # trailing "..."
        # Strip bold markers before comparing: a bullet's bold span does not have to start/end
        # at the exact same character offset in CLAUDE.md as in the source rule file (e.g. the
        # index bullet bolds a longer lead-in than the rule file does), which would otherwise
        # plant a stray "**" inside an otherwise-matching run of text and break a literal
        # substring match for no semantic reason -- bold markers are invisible to a reader either way.
        full_norm = normalize(full.replace("**", ""))
        rule_text_norm = normalize(target.read_text(encoding="utf-8").replace("**", ""))
        if full_norm not in rule_text_norm:
            problems.append(
                f"rule {num}: index bullet text is not a verbatim substring of {link}: "
                f"{full_norm!r}"
            )

    for tok in H1_TOKENS:
        if tok not in visible:
            problems.append(f"protocol token has 0 occurrences in CLAUDE.md: {tok}")

    # Every docs/rules/*.md file must be linked from SOMEWHERE in CLAUDE.md -- not only from a
    # numbered bullet (several sections, e.g. Szemelyiseg/Inter-agent, link via their own single
    # pointer line rather than a per-rule bullet).
    for m in re.finditer(r"/home/neon/marveen/docs/rules/[^)\s`]+\.md", visible):
        linked_files.add(Path(m.group(0)).name)
    if rules_dir.is_dir():
        for f in sorted(rules_dir.glob("*.md")):
            if f.name not in linked_files:
                problems.append(f"docs/rules file is not linked from anywhere in CLAUDE.md: {f.name}")

    return problems


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    old_ref, new_claude_md_path, docs_rules_dir = sys.argv[1:4]

    old_text = git_show(old_ref, "CLAUDE.md")

    new_text = Path(new_claude_md_path).read_text(encoding="utf-8")
    rules_dir = Path(docs_rules_dir)
    rule_files = sorted(rules_dir.glob("*.md")) if rules_dir.is_dir() else []
    corpus_parts = [new_text] + [f.read_text(encoding="utf-8") for f in rule_files]
    corpus = normalize("\n".join(corpus_parts))

    gating_hits = extract_lines(old_text, GATING_TOKENS)

    missing = [(ln, line) for ln, line in gating_hits if line not in corpus]

    print(f"{len(gating_hits)} lines checked, {len(missing)} missing")
    if missing:
        print("\nMISSING (present in old CLAUDE.md, not found in new corpus):", file=sys.stderr)
        for ln, line in missing:
            print(f"  L{ln}: {line}", file=sys.stderr)

    # --- full non-empty-line multiset conservation (WhiteHat2 L1) ---
    old_lines_norm = [normalize(l) for l in old_text.split("\n") if normalize(l)]
    old_counts = Counter(old_lines_norm)
    corpus_lines_norm = [normalize(l) for l in "\n".join(corpus_parts).split("\n") if normalize(l)]
    new_counts = Counter(corpus_lines_norm)
    conservation_missing = []
    for line, cnt in old_counts.items():
        have = new_counts.get(line, 0)
        if have < cnt:
            conservation_missing.append((cnt - have, line))
    print(f"\nline-conservation: {len(old_counts)} distinct non-empty lines in the old file, "
          f"{len(conservation_missing)} short in the new corpus")
    if conservation_missing:
        print("\nCONSERVATION SHORTFALL (old file had more copies than the new corpus has):",
              file=sys.stderr)
        for short_by, line in conservation_missing[:50]:
            print(f"  -{short_by}: {line}", file=sys.stderr)

    old_begins = set(re.findall(r"BEGIN GENERATED:\s*(\S+)", old_text))
    old_ends = set(re.findall(r"END GENERATED:\s*(\S+)", old_text))
    old_names = old_begins | old_ends
    new_begins = set(re.findall(r"BEGIN GENERATED:\s*(\S+)", new_text))
    new_ends = set(re.findall(r"END GENERATED:\s*(\S+)", new_text))

    marker_problems = []
    for name in sorted(old_names):
        if name not in new_begins:
            marker_problems.append(f"{name}: BEGIN marker missing from CLAUDE.md (in old file)")
        if name not in new_ends:
            marker_problems.append(f"{name}: END marker missing from CLAUDE.md (in old file)")

    print(f"\n{len(old_names)} generated marker names checked for a matched BEGIN/END pair "
          f"in the new CLAUDE.md, {len(marker_problems)} problem(s)")
    if marker_problems:
        print("\nMARKER PAIR PROBLEMS:", file=sys.stderr)
        for p in marker_problems:
            print(f"  {p}", file=sys.stderr)

    # --- index structure (card cc72cb3e, closes RedHat's A1-A10, see module docstring) ---
    index_problems = check_index_structure(new_text, rules_dir)
    print(f"\nindex structure: {len(index_problems)} problem(s)")
    if index_problems:
        print("\nINDEX STRUCTURE PROBLEMS:", file=sys.stderr)
        for p in index_problems:
            print(f"  {p}", file=sys.stderr)

    return 1 if (missing or marker_problems or conservation_missing or index_problems) else 0


if __name__ == "__main__":
    sys.exit(main())

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

Exit 0 if every gating line is found AND every marker pair matches, 1 otherwise.

KOTELEZ/MEGSZEGHETETLEN/SOHA/MINDIG are also extracted and reported, informationally only
(not gating): several existing section titles already use those words in a non-rule sense,
so they are not a reliable substring signal on their own.
"""
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

GATING_TOKENS = ["KOTELEZ", "KÖTELEZ", "TILOS", "MUST"]
INFO_TOKENS = ["MEGSZEGHETETLEN", "SOHA", "MINDIG"]


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
    info_hits = extract_lines(old_text, INFO_TOKENS)

    missing = [(ln, line) for ln, line in gating_hits if line not in corpus]

    print(f"{len(gating_hits)} lines checked, {len(missing)} missing")
    if missing:
        print("\nMISSING (present in old CLAUDE.md, not found in new corpus):", file=sys.stderr)
        for ln, line in missing:
            print(f"  L{ln}: {line}", file=sys.stderr)

    if info_hits:
        print(f"\n{len(info_hits)} informational lines (MEGSZEGHETETLEN/SOHA/MINDIG, not gating):")
        info_missing = [(ln, line) for ln, line in info_hits if line not in corpus]
        print(f"  {len(info_missing)} of those not found in the new corpus (informational only)")

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

    return 1 if (missing or marker_problems) else 0


if __name__ == "__main__":
    sys.exit(main())

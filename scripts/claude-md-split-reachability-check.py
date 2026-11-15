#!/usr/bin/env python3
"""claude-md-split-reachability-check.py <old-claude-md-git-ref> <new-claude-md-path> <docs-rules-dir> [baseline-file]

--update-baseline <old-ref> <claude-md> <docs-rules-dir> [baseline-file] [--yes]
    [--accept <hash>]... [--allow-removal <hash>]... [--allow-pin-change <rule-id>]...
  Records an intentional edit so the checks above do not flag it forever. Lists what it would
  accept (classified REWORD or REMOVED, by similarity to the current corpus) and writes nothing
  without --yes. --yes alone accepts NOTHING classified REWORD or REMOVED (QA2 FAIL 31319: --yes
  alone used to bless every REWORD silently, which blessed a meaning-inverting edit -- "Soha ne
  mondd" -> "Neha mondhatod" -- exactly as readily as a harmless rewording, since both keep most
  of the sentence and read as similar). Every REWORD now prints its own short hash (OLD vs NEW
  text) and is refused unless that hash is named via --accept, same mechanism as removals. A
  REMOVED line (card cc72cb3e delta, RedHat NO-GO on 6f5045341) is refused unless its own printed
  short hash is named via --allow-removal. A pinned bullet (19/8a) whose text differs from what
  the baseline already recorded prints OLD and NEW and is refused the same way, unless named via
  --allow-pin-change <rule-id>. --yes is only the final "I reviewed what's printed above" step;
  it never substitutes for naming each line.

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

cc72cb3e delta (MikroB hold 31268 + QA FAIL 31269 on CYBERED GO 9300adbb): three more gaps.
  - QA1 (bullet-COUNT floor defeated by delete+duplicate): deleting one rule's index bullet and
    duplicating an adjacent one keeps the >=71 floor satisfied. Fixed by tracking rule NUMBERS
    per section (not a raw count): a number appearing twice in one section is a duplicate; a
    number present in the section's own docs/rules file but absent from CLAUDE.md's bullets for
    that section is a gap (rule without an index line) -- both independent of the total count.
  - RedHat gap (duplicate heading): each of the 4 section-heading anchors must appear exactly
    once in CLAUDE.md.
  - RedHat gap (inverted allowlisted bullet 19/8a): these two bypass the verbatim-substring
    check (hand paraphrase, RedHat F3), so an inversion of THEM specifically was invisible to
    everything else. PINNED_BULLETS stores their current exact text (baseline-tracked, see
    below) and requires byte-for-byte equality, not just "skip".
  - MikroB's operational hold: the conservation check (old_ref vs current corpus) has no path
    for accepting an INTENTIONAL rewording of a line that existed in the original pre-split
    file -- every future edit to one of those 661 lines turns the standing control red forever,
    with no documented fix. `--update-baseline` (below) is the one command: it records the
    CURRENT set of conservation-missing lines and the CURRENT text of the 19/8a pinned bullets
    into docs/rules/.reachability-baseline.json, to be run in the SAME commit as an intentional
    rule edit (after a human/agent has confirmed the newly-missing lines are a deliberate
    rewording, not an accidental drop -- it does not judge that for you).
"""
import difflib
import hashlib
import json
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
# substring of the rule file (RedHat F3, comment 30478) -- accepted, not re-opened here. Their
# exact text is instead pinned via the baseline file (PINNED_BULLET_KEYS, see check_pinned_bullets).
VERBATIM_ALLOWLIST = {"8a", "19"}
PINNED_BULLET_KEYS = VERBATIM_ALLOWLIST

RULE_BULLET_RE = re.compile(
    r"^\s*-\s+\*\*([0-9]+[a-z]?)\.\*\*\s+\*\*(.+?)\*\*(.*)\((/home/neon/marveen/docs/rules/[^)]+\.md)\)\s*$"
)

# Every top-level rule-number marker a docs/rules file uses for ITS OWN numbering: either
# "N. **Title**" (number outside the bold, flush left) or "   **Na. Title**" (number inside a
# bold span that opened before it, indented sub-rule style -- e.g. 4a-4f under rule 4). Anchored
# to the start of a line so it never matches an inline cross-reference like "(4b. szabály)"
# inside running prose.
SOURCE_RULE_NUM_RE = re.compile(r"(?:^([0-9]+[a-z]?)\.\s*\*\*|^\s*\*\*([0-9]+[a-z]?)\.\s)", re.M)

# (section key, heading anchor as it appears in CLAUDE.md, the docs/rules file that section's
# OWN numbering should be cross-checked against -- None where the file has no such numbering of
# its own, e.g. Szemelyiseg's two bullets are CLAUDE.md-only additions).
SECTION_ANCHORS = [
    ("munkavegzesi", "**Munkavégzési szabályok", "munkavegzesi-szabalyok.md"),
    ("kodminosegi", "**Kódminőségi alapelvek", "kodminosegi-alapelvek.md"),
    ("ellenorizheto", "**Ellenőrizhető munka", "ellenorizheto-munka.md"),
    ("szemelyiseg", "**Személyiség**", None),
]


def strip_inert_markup(text: str) -> str:
    """Remove HTML comments and fenced code blocks: a bullet hidden inside either renders as
    invisible to an agent reading the file, so it must also be invisible to every check below
    (RedHat A3/A10) -- the raw text being technically still in the file is not enough."""
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    return text


def find_rule_bullets(visible_claude_md: str) -> list[tuple[str, str, str, str, str]]:
    """Returns (section, rule_num, lead_sentence, rest_of_bullet, link_path) for every VISIBLE
    numbered per-rule index bullet (the "- **N.** **Lead.** rest ... (path)" lines), tagged with
    which of SECTION_ANCHORS it last saw a heading for."""
    out = []
    section = None
    for line in visible_claude_md.split("\n"):
        for key, anchor, _ in SECTION_ANCHORS:
            if anchor in line:
                section = key
                break
        m = RULE_BULLET_RE.match(line)
        if m:
            out.append((section, m.group(1), m.group(2), m.group(3), m.group(4)))
    return out


def find_full_bullet_line(visible_claude_md: str, rule_num: str) -> str | None:
    """The raw, normalized text of the index bullet LINE for a given rule number (used to pin
    the exact text of allowlisted bullets like 8a/19, which skip the verbatim-substring check)."""
    target = f"**{rule_num}.**"
    for line in visible_claude_md.split("\n"):
        m = RULE_BULLET_RE.match(line)
        if m and m.group(1) == rule_num and target in line:
            return normalize(line)
    return None


def check_pinned_bullets(visible: str, baseline: dict) -> list[str]:
    """RedHat gap (inverted allowlisted bullet): 8a/19 skip the verbatim-substring check
    entirely (hand paraphrase, F3), so an inversion of THEM is invisible to everything else.
    Pins their exact current text via the baseline file instead."""
    problems = []
    pinned = baseline.get("pinned_bullets", {})
    for num in sorted(PINNED_BULLET_KEYS):
        current = find_full_bullet_line(visible, num)
        if current is None:
            problems.append(f"pinned bullet {num}: not found in CLAUDE.md at all")
            continue
        expected = pinned.get(num)
        if expected is None:
            problems.append(
                f"pinned bullet {num}: no baseline entry yet -- run --update-baseline once to record it"
            )
        elif current != expected:
            problems.append(
                f"pinned bullet {num}: text changed from the baseline (inverted/edited without "
                f"--update-baseline): now {current!r}"
            )
    return problems


def check_section_numbering(bullets: list, rules_dir: Path) -> list[str]:
    """QA FAIL 31269 (QA1): a disguised delete+duplicate swap keeps the raw bullet-count floor
    satisfied. Tracks rule NUMBERS per section instead: a number appearing twice in one section
    is a duplicate/renumbering; a number the section's own rule file defines but that has no
    CLAUDE.md bullet is a gap (a rule with no index line at all)."""
    problems = []
    by_section: dict[str, list[str]] = {}
    for section, num, _lead, _rest, _link in bullets:
        by_section.setdefault(section, []).append(num)

    for key, _anchor, rule_file in SECTION_ANCHORS:
        nums_here = by_section.get(key, [])
        for num, cnt in Counter(nums_here).items():
            if cnt > 1:
                problems.append(f"section {key}: rule {num} has {cnt} index bullets (duplicate or renumbered)")

        if rule_file is None:
            continue
        rule_path = rules_dir / rule_file
        if not rule_path.is_file():
            continue
        # Only the GAP direction is checked (a numbered rule the source file defines but that
        # has no CLAUDE.md bullet) -- not the reverse. An index bullet with NO matching source
        # number is not inherently a problem: card cc72cb3e's own 22a-22e bullets deliberately
        # index rules that were previously UNNUMBERED prose in the source file (that absence of
        # native numbering is exactly why they had no index line before), so a bullet having no
        # source-side counterpart is a legitimate, additive pattern, not a defect.
        source_nums = {
            m.group(1) or m.group(2) for m in SOURCE_RULE_NUM_RE.finditer(rule_path.read_text(encoding="utf-8"))
        }
        claude_nums = set(nums_here)
        for num in sorted(source_nums - claude_nums):
            problems.append(f"section {key}: rule {num} exists in {rule_file} but has no CLAUDE.md index bullet")

    return problems


def check_duplicate_headings(visible: str) -> list[str]:
    """RedHat gap (duplicate heading): two copies of a section heading would make bullets
    between them ambiguous about which section (and which rule file) they belong to."""
    problems = []
    for _key, anchor, _rule_file in SECTION_ANCHORS:
        cnt = visible.count(anchor)
        if cnt == 0:
            problems.append(f"section heading not found in CLAUDE.md: {anchor!r}")
        elif cnt > 1:
            problems.append(f"section heading appears {cnt} times (duplicate heading): {anchor!r}")
    return problems


def load_baseline(baseline_path: Path) -> dict:
    if baseline_path.is_file():
        return json.loads(baseline_path.read_text(encoding="utf-8"))
    return {"accepted_missing_lines": [], "pinned_bullets": {}}


def short_hash(text: str) -> str:
    """A stable, short identifier for a line, used by --allow-removal so the caller names the
    EXACT line they are blessing, not just "yes to everything currently missing"."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


# RedHat NO-GO (comment on cc72cb3e, re-gate after CYBERED NO-GO on 6f5045341): --update-baseline
# used to accept EVERY currently-missing/short line uncritically, which blesses an outright
# REMOVED binding rule exactly as readily as a genuine REWORDING -- U2 in RedHat's own probe
# (deleted "Nincs AI klisé..." from szemelyiseg.md, no index bullet covers it, --yes accepted it
# silently). REWORD_SIMILARITY_THRESHOLD: a missing line is a REWORD if the CURRENT corpus still
# contains a line at least this similar to it (difflib ratio) -- a rewording keeps much of the
# original sentence; an outright removal leaves nothing resembling it behind.
REWORD_SIMILARITY_THRESHOLD = 0.6


def classify_missing_line(line: str, corpus_lines: list[str]) -> tuple[str, str | None, float]:
    """Returns (kind, best_match_or_None, ratio) where kind is "reword" (a similar line still
    exists) or "removed" (nothing close to it does)."""
    best_line, best_ratio = None, 0.0
    for candidate in corpus_lines:
        ratio = difflib.SequenceMatcher(None, line, candidate).ratio()
        if ratio > best_ratio:
            best_line, best_ratio = candidate, ratio
    if best_ratio >= REWORD_SIMILARITY_THRESHOLD:
        return "reword", best_line, best_ratio
    return "removed", None, best_ratio


def check_index_structure(new_text: str, rules_dir: Path, baseline: dict) -> list[str]:
    problems = []
    visible = strip_inert_markup(new_text)

    bullets = find_rule_bullets(visible)
    # 37 munkavegzesi (1-22 + letters) + 5 (22a-22e, card cc72cb3e F1) + 15 kodminosegi +
    # 12 ellenorizheto-munka + 2 szemelyiseg (card cc72cb3e F1) = 71. A floor, not an exact
    # count: a future card adding MORE bullets should not need to touch this number, only one
    # removing/hiding a bullet without replacing it should. QA FAIL 31269: this floor alone can
    # be satisfied by a delete+duplicate swap -- check_section_numbering() below is what
    # actually catches that, this is just a cheap first-pass sanity floor.
    MIN_BULLETS = 71
    if len(bullets) < MIN_BULLETS:
        problems.append(
            f"only {len(bullets)} visible numbered per-rule index bullets found, want >= {MIN_BULLETS}"
        )

    problems.extend(check_duplicate_headings(visible))
    problems.extend(check_section_numbering(bullets, rules_dir))
    problems.extend(check_pinned_bullets(visible, baseline))

    linked_files = set()
    for section, num, lead, rest, link in bullets:
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
        # Read the CONTENT from rules_dir's own copy (the tree actually under test), not the
        # repo-root-absolute `target` path above -- that path is only a CONVENTION check (links
        # must be repo-root-absolute so a sub-agent's relative cwd never breaks them, rule 1b),
        # not a promise that THIS run's docs/rules tree lives at that literal path. A detached
        # worktree or fleet-test's $TEST_TREE has its OWN docs/rules/*.md beside its OWN CLAUDE.md;
        # reading the live /home/neon/marveen copy instead would silently grade the tested tree's
        # bullet against a DIFFERENT file's content whenever the two have diverged (measured:
        # card cc72cb3e's own rebase onto a fresh develop land this verbatim check against the
        # live install while testing a worktree, passing or failing on content the worktree does
        # not even contain). `target` (used above only to confirm the link's named file exists)
        # and `rules_dir / target.name` are byte-identical on a synced install; they differ only
        # mid-edit, which is exactly when this check must grade the tree being tested.
        rule_file = rules_dir / target.name
        if not rule_file.is_file():
            rule_file = target
        rule_text_norm = normalize(rule_file.read_text(encoding="utf-8").replace("**", ""))
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


def _parse_args(argv: list[str]):
    update = "--update-baseline" in argv
    yes = "--yes" in argv
    accept: set[str] = set()
    allow_removal: set[str] = set()
    allow_pin_change: set[str] = set()
    pos: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--update-baseline", "--yes"):
            i += 1
            continue
        if a == "--accept":
            i += 1
            if i < len(argv):
                accept.add(argv[i])
            i += 1
            continue
        if a == "--allow-removal":
            i += 1
            if i < len(argv):
                allow_removal.add(argv[i])
            i += 1
            continue
        if a == "--allow-pin-change":
            i += 1
            if i < len(argv):
                allow_pin_change.add(argv[i])
            i += 1
            continue
        pos.append(a)
        i += 1
    if len(pos) not in (3, 4):
        return None
    old_ref, new_claude_md_path, docs_rules_dir = pos[:3]
    baseline_path = Path(pos[3]) if len(pos) == 4 else Path(docs_rules_dir) / ".reachability-baseline.json"
    return old_ref, new_claude_md_path, docs_rules_dir, baseline_path, update, yes, accept, allow_removal, allow_pin_change


def _compute(old_ref: str, new_claude_md_path: str, docs_rules_dir: str):
    """Shared by the normal check and --update-baseline: everything that does not depend on
    the baseline file itself."""
    old_text = git_show(old_ref, "CLAUDE.md")
    new_text = Path(new_claude_md_path).read_text(encoding="utf-8")
    rules_dir = Path(docs_rules_dir)
    rule_files = sorted(rules_dir.glob("*.md")) if rules_dir.is_dir() else []
    corpus_parts = [new_text] + [f.read_text(encoding="utf-8") for f in rule_files]
    corpus = normalize("\n".join(corpus_parts))

    gating_hits = extract_lines(old_text, GATING_TOKENS)
    missing = [(ln, line) for ln, line in gating_hits if line not in corpus]

    old_lines_norm = [normalize(l) for l in old_text.split("\n") if normalize(l)]
    old_counts = Counter(old_lines_norm)
    corpus_lines_norm = [normalize(l) for l in "\n".join(corpus_parts).split("\n") if normalize(l)]
    new_counts = Counter(corpus_lines_norm)
    conservation_missing = []
    for line, cnt in old_counts.items():
        have = new_counts.get(line, 0)
        if have < cnt:
            conservation_missing.append((cnt - have, line))

    return new_text, rules_dir, missing, conservation_missing, corpus_lines_norm


def _update_baseline(
    old_ref, new_claude_md_path, docs_rules_dir, baseline_path: Path, confirmed: bool,
    accept: set[str], allow_removal: set[str], allow_pin_change: set[str],
) -> int:
    """The one command MikroB's hold (31268) asked for: run this in the SAME commit as an
    intentional edit to a binding rule's wording.

    RedHat NO-GO (re-gate on 6f5045341): the first version accepted EVERY currently-missing line
    uncritically, which blessed an outright REMOVED binding rule exactly as readily as a genuine
    REWORDING (his U2), and silently re-pinned an INVERTED bullet 19/8a with no visible diff
    (his U3). Then QA2 FAIL 31319: even after U2/U3, a REWORD was still accepted by bare --yes
    with no per-line confirmation -- a similarity-classified "reword" is not the same as a
    SAFE rewording, and a meaning-inverting edit ("Soha ne mondd" -> "Neha mondhatod") keeps
    most of the sentence, so it classifies as REWORD exactly like a harmless wording tweak.
    Now: each candidate line is classified reword/removed by similarity to the current corpus
    (classify_missing_line); EVERY reword prints its own short_hash (OLD vs NEW) and is refused
    unless that hash is named via --accept -- the same per-line mechanism REMOVED already had
    via --allow-removal. A pinned bullet whose text differs from what the baseline already has
    on record prints OLD and NEW and is refused unless its rule number is named via
    --allow-pin-change -- there is no reliable way to tell a legitimate rewording from an
    inversion by similarity alone, so EVERY reword and EVERY pin change needs its own explicit
    flag, never just --yes. Nothing is written unless every line that needed a flag got one.
    """
    new_text, rules_dir, missing, conservation_missing, corpus_lines_norm = _compute(
        old_ref, new_claude_md_path, docs_rules_dir
    )
    visible = strip_inert_markup(new_text)
    corpus_set = set(corpus_lines_norm)

    candidate_lines = sorted({line for _, line in missing} | {line for _, line in conservation_missing})
    rewords: list[tuple[str, str]] = []  # (line, hash)
    removals: list[tuple[str, str]] = []  # (line, hash)
    for line in candidate_lines:
        others = [c for c in corpus_lines_norm if c != line] or corpus_lines_norm
        kind, best_match, ratio = classify_missing_line(line, others if line in corpus_set else corpus_lines_norm)
        if kind == "reword":
            h = short_hash(line)
            print(f"  REWORD (hash {h}, {ratio:.2f} similar to): {best_match!r}\n    <- was: {line!r}")
            rewords.append((line, h))
        else:
            h = short_hash(line)
            removals.append((line, h))
            print(f"  REMOVED (hash {h}, no similar line found): {line!r}")

    blocked_rewords = [(line, h) for line, h in rewords if h not in accept]
    blocked_removals = [(line, h) for line, h in removals if h not in allow_removal]

    if blocked_rewords:
        print(
            f"\n{len(blocked_rewords)} REWORD line(s) -- refusing without --accept <hash> for each "
            f"one you intend (a similarity match is not proof the meaning survived):",
            file=sys.stderr,
        )
        for line, h in blocked_rewords:
            print(f"  --accept {h}   # {line!r}", file=sys.stderr)

    pin_changes: list[tuple[str, str, str]] = []  # (num, old, new)
    pins_to_write = dict(load_baseline(baseline_path).get("pinned_bullets", {}))
    for num in sorted(PINNED_BULLET_KEYS):
        current = find_full_bullet_line(visible, num)
        if current is None:
            continue
        previous = pins_to_write.get(num)
        if previous is not None and previous != current:
            pin_changes.append((num, previous, current))
        pins_to_write[num] = current

    blocked_pins = [(num, old, new) for num, old, new in pin_changes if num not in allow_pin_change]
    if blocked_pins:
        print("\nPINNED BULLET CHANGED -- refusing without --allow-pin-change <rule-id> (shown so you can judge it, not accepted silently):")
        for num, old, new in blocked_pins:
            print(f"  rule {num}\n    OLD: {old!r}\n    NEW: {new!r}")

    if blocked_removals:
        print(
            f"\n{len(blocked_removals)} line(s) have NO similar replacement in the corpus -- refusing as "
            f"possible accidental removals. Re-run with --allow-removal <hash> for each one you intend:",
            file=sys.stderr,
        )
        for line, h in blocked_removals:
            print(f"  --allow-removal {h}   # {line!r}", file=sys.stderr)

    if blocked_rewords or blocked_removals or blocked_pins:
        print("\nNothing written.", file=sys.stderr)
        return 1

    if not confirmed:
        print("\nNothing written -- pass --yes after reviewing the classification above.", file=sys.stderr)
        return 1

    baseline_path.write_text(
        json.dumps(
            {
                "accepted_missing_lines": sorted(
                    {line for line, _ in rewords} | {line for line, _ in removals}
                ),
                "pinned_bullets": pins_to_write,
            },
            ensure_ascii=False, indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\nwrote {baseline_path}")
    return 0


def main() -> int:
    parsed = _parse_args(sys.argv[1:])
    if parsed is None:
        print(__doc__, file=sys.stderr)
        return 2
    old_ref, new_claude_md_path, docs_rules_dir, baseline_path, update, confirmed, accept, allow_removal, allow_pin_change = parsed

    if update:
        return _update_baseline(
            old_ref, new_claude_md_path, docs_rules_dir, baseline_path, confirmed,
            accept, allow_removal, allow_pin_change,
        )

    baseline = load_baseline(baseline_path)
    accepted = set(baseline.get("accepted_missing_lines", []))

    new_text, rules_dir, missing, conservation_missing, _corpus_lines_norm = _compute(
        old_ref, new_claude_md_path, docs_rules_dir
    )

    accepted_count = sum(1 for _, line in missing if line in accepted)
    missing = [(ln, line) for ln, line in missing if line not in accepted]
    print(f"{accepted_count} previously-accepted line(s) skipped (see {baseline_path})" if accepted_count else "", end="")
    print(f"{'; ' if accepted_count else ''}{len(missing)} missing (keyword check)")
    if missing:
        print("\nMISSING (present in old CLAUDE.md, not found in new corpus):", file=sys.stderr)
        for ln, line in missing:
            print(f"  L{ln}: {line}", file=sys.stderr)

    conservation_missing = [(short, line) for short, line in conservation_missing if line not in accepted]
    print(f"\nline-conservation: {len(conservation_missing)} short in the new corpus (after baseline exceptions)")
    if conservation_missing:
        print("\nCONSERVATION SHORTFALL (old file had more copies than the new corpus has):",
              file=sys.stderr)
        for short_by, line in conservation_missing[:50]:
            print(f"  -{short_by}: {line}", file=sys.stderr)

    old_text = git_show(old_ref, "CLAUDE.md")
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
    index_problems = check_index_structure(new_text, rules_dir, baseline)
    print(f"\nindex structure: {len(index_problems)} problem(s)")
    if index_problems:
        print("\nINDEX STRUCTURE PROBLEMS:", file=sys.stderr)
        for p in index_problems:
            print(f"  {p}", file=sys.stderr)

    return 1 if (missing or marker_problems or conservation_missing or index_problems) else 0


if __name__ == "__main__":
    sys.exit(main())

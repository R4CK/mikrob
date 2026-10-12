#!/usr/bin/env python3
"""decompose-sample-context.py -- real codebase sample for a decomposed mechanical-fragment draft
(card d39fc5e7, requirement 1).

WHY. card-decompose-templates.sh's four types (test-scaffold, type-def, i18n-keys, doc-update) hand
the local 7B a GENERIC templated task sentence ("Write the unit test scaffolding this card names"),
with no concrete file to anchor against. Measured failure mode (card-build-route-24h-measure.sh,
2026-09-30): a test scaffold written against a framework (Express/supertest) the repo does not use at
all (card 825d7657) -- a BLIND draft, not a wrong one; it had nothing real to copy the house style
from. This finds the ONE real, nearest sibling file the card's own text names (or a repo-wide
fallback for doc-update) and prints a token-capped excerpt of it, so the draft has a concrete style
to match instead of inventing one.

WHEN THERE IS NO SAMPLE: print nothing and exit 1. This is deliberate, not a degraded-but-proceeding
path -- the card's own wording is "a hianyzo minta eseten NE draftoljon" (on a missing sample, do
NOT draft), because a template sentence with no anchor is exactly the blind-draft failure mode this
script exists to prevent, and finding nothing is strictly better than drafting on a guess.

Reads {"type": str, "text": str, "repo": str} as JSON on stdin. Prints "SAMPLE FILE (<relative
path>):\\n<excerpt>" on a hit, nothing on a miss. Exit 0 on a hit, 1 on a miss. No network calls;
only reads files already on disk under `repo`.
"""
import json
import os
import re
import sys

TOKEN_CAP = 1500
SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo", "out"}

# A file-looking token in the card's own title+description: the ONE concrete anchor this script has
# to work with. Deliberately narrow (a real extension, a real-looking path) -- a bare word match
# would pick up prose and anchor the search on nothing.
FILE_TOKEN_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_\-./]*\.(?:ts|tsx|json|md)\b")

TEST_SUFFIXES = (".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")


def find_target_token(text: str) -> str | None:
    tokens = [m.group(0) for m in FILE_TOKEN_RE.finditer(text)]
    with_slash = [t for t in tokens if "/" in t]
    if with_slash:
        return with_slash[0]
    return tokens[0] if tokens else None


def walk_skip(repo: str):
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        yield root, dirs, files


def resolve_in_repo(repo: str, token: str) -> str | None:
    rel = token.lstrip("./")
    direct = os.path.join(repo, rel)
    if os.path.isfile(direct):
        return direct
    base = os.path.basename(rel)
    for root, _dirs, files in walk_skip(repo):
        if base in files:
            return os.path.join(root, base)
    return None


def sample_for_test_scaffold(repo: str, target: str | None) -> str | None:
    if not target:
        return None
    d = os.path.dirname(target)
    stem = re.sub(r"\.(ts|tsx)$", "", os.path.basename(target))
    for suffix in TEST_SUFFIXES:
        p = os.path.join(d, stem + suffix)
        if os.path.isfile(p):
            return p
    try:
        for f in sorted(os.listdir(d)):
            if f.endswith(TEST_SUFFIXES):
                return os.path.join(d, f)
    except OSError:
        pass
    return None


def sample_for_type_def(repo: str, target: str | None) -> str | None:
    if not target:
        return None
    candidates = [target]
    d = os.path.dirname(target)
    try:
        candidates += [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith((".ts", ".tsx"))]
    except OSError:
        pass
    for p in candidates:
        if not os.path.isfile(p):
            continue
        try:
            with open(p, encoding="utf-8", errors="ignore") as fh:
                content = fh.read()
        except OSError:
            continue
        if re.search(r"\b(interface|type)\s+\w+", content):
            return p
    return None


def sample_for_i18n_keys(repo: str, target: str | None) -> str | None:
    search_dirs = []
    if target:
        search_dirs.append(os.path.dirname(target))
    for root, _dirs, _files in walk_skip(repo):
        if os.path.basename(root).lower() in ("locales", "locale", "i18n", "lang"):
            search_dirs.append(root)
    for d in search_dirs:
        try:
            for f in sorted(os.listdir(d)):
                if f.endswith(".json"):
                    return os.path.join(d, f)
        except OSError:
            continue
    return None


def sample_for_doc_update(repo: str, _target: str | None) -> str | None:
    p = os.path.join(repo, "README.md")
    return p if os.path.isfile(p) else None


SAMPLE_FINDERS = {
    "test-scaffold": sample_for_test_scaffold,
    "type-def": sample_for_type_def,
    "i18n-keys": sample_for_i18n_keys,
    "doc-update": sample_for_doc_update,
}


def excerpt(path: str, type_: str, cap: int = TOKEN_CAP) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            content = fh.read()
    except OSError:
        return None
    if type_ == "doc-update":
        m = re.search(r"## Egyedi fork-fejleszt[eé]sek.*", content, re.DOTALL)
        if m:
            content = m.group(0)
    content = content.strip()
    if not content:
        return None
    return content[:cap]


def main() -> int:
    try:
        data = json.loads(sys.stdin.read())
    except Exception:
        return 1
    type_ = str(data.get("type") or "")
    text = str(data.get("text") or "")
    repo = str(data.get("repo") or "")

    finder = SAMPLE_FINDERS.get(type_)
    if finder is None or not repo or not os.path.isdir(repo):
        return 1

    target_token = find_target_token(text)
    target_path = resolve_in_repo(repo, target_token) if target_token else None
    sample_path = finder(repo, target_path)
    if not sample_path:
        return 1

    body = excerpt(sample_path, type_)
    if not body:
        return 1

    rel = os.path.relpath(sample_path, repo)
    print(f"SAMPLE FILE ({rel}, real existing file from this repo -- match its style, do not invent a different framework/shape):")
    print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())

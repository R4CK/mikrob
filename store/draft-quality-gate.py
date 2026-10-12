#!/usr/bin/env python3
"""draft-quality-gate.py -- deterministic pre-post quality gate for a local-LLM draft
(card d39fc5e7, requirement 2).

MEASURED BASELINE (card-build-route-24h-measure.sh, 2026-09-30 05:20): 27 content decisions, 17
drafted, 2 ELFOGADVA/RESZBEN, 14 ELUTASITVA (12.5% usable). The Draft-Review comments named three
recurring, MECHANICAL defect shapes: (a) a test scaffold written against a framework the repo does
not use (Express/supertest vs. mopsion's raw RawRequest/RawResponse + jsonRes, card 825d7657); (b) a
draft that just repeats the card's own title/description back (card 05404690); (c) truncated output
(card 18055f83). None of the three needs a model call to catch -- they are exactly the kind of thing
a deterministic check can reject BEFORE it costs anyone an online review.

Reads {"draft": str, "task": str, "repo": str} as JSON on stdin. Prints exactly one line:
  OK                    -- the draft passed every check
  FAIL\t<reason>        -- the draft failed; <reason> is human-readable, no secrets
Exit code mirrors the verdict (0 = OK, 1 = FAIL). No network, no model call, no side effects --
every check here is a pure function of its input, which is what makes it mutation-testable at all
(a model call is not, see local-llm-offload skill).

`repo` is best-effort: a missing or unreadable repo path skips ONLY the import-existence check
(case (a) above cannot be judged without a file tree to check against), it does not fail the draft.
The other two checks (length, repetition) never depend on the repo.
"""
import difflib
import json
import os
import re
import sys

MIN_NONWHITESPACE_CHARS = 40
MAX_REPETITION_RATIO = 0.6

SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo", "out"}

# Node built-ins a draft may always import without a repo lookup (card d39fc5e7 only cares about
# whether a NAMED PACKAGE/FILE exists in the repo, not about re-deriving Node's own module list).
NODE_BUILTINS = {
    "fs", "path", "http", "https", "crypto", "os", "url", "util", "events", "stream",
    "child_process", "assert", "buffer", "querystring", "zlib", "net", "tls", "dns",
    "readline", "timers", "process", "module", "vm", "worker_threads", "perf_hooks",
}


def strip_fences(text: str) -> str:
    """Drop ``` fence lines, keep everything between them (same shape as offload-dispatch.sh's own
    strip_fence awk helper, reimplemented here because this runs as a standalone script)."""
    out = []
    fenced = False
    for line in text.splitlines():
        if re.match(r"^\s*```", line):
            fenced = not fenced
            continue
        out.append(line)
    return "\n".join(out)


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def extract_import_specs(code: str) -> set[str]:
    specs: set[str] = set()
    for m in re.finditer(r"""\bfrom\s+['"]([^'"]+)['"]""", code):
        specs.add(m.group(1))
    for m in re.finditer(r"""\brequire\(\s*['"]([^'"]+)['"]\s*\)""", code):
        specs.add(m.group(1))
    for m in re.finditer(r"""^\s*import\s+['"]([^'"]+)['"]""", code, re.MULTILINE):
        specs.add(m.group(1))
    return specs


def is_builtin(spec: str) -> bool:
    bare = spec[5:] if spec.startswith("node:") else spec
    return bare in NODE_BUILTINS


def repo_has_basename(repo: str, basename: str) -> bool:
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        if basename in files:
            return True
    return False


def repo_has_package(repo: str, pkg_root: str) -> bool:
    return os.path.isdir(os.path.join(repo, "node_modules", pkg_root))


def package_root(spec: str) -> str:
    parts = spec.split("/")
    if spec.startswith("@") and len(parts) > 1:
        return "/".join(parts[:2])
    return parts[0]


def import_check(code: str, repo: str) -> str | None:
    """Returns a failure reason, or None when every import resolves (or the repo cannot be checked
    at all, which is a skip, not a pass-by-default -- see module docstring)."""
    if not repo or not os.path.isdir(repo):
        return None
    for spec in extract_import_specs(code):
        if is_builtin(spec):
            continue
        if spec.startswith("."):
            base = os.path.basename(spec)
            candidates = [base] if "." in base else [base + ext for ext in (".ts", ".tsx", ".js", ".json")]
            if not any(repo_has_basename(repo, c) for c in candidates):
                return f"import '{spec}' does not resolve to any file in the repo"
            continue
        if not repo_has_package(repo, package_root(spec)):
            return f"import '{spec}' names a package not present in node_modules"
    return None


# Secret-shaped assignment in generated code: key-name word + '=' or ':' + long opaque value.
# Same pattern as decompose-sample-context.py; duplicated here so both gates are independent.
_SECRET_LINE_RE = re.compile(
    r"""(?i)(password|secret|token|key|auth|credential|private|bearer)\s*[=:]\s*['""]?[A-Za-z0-9+/._\-]{20,}['""]?""",
)


def check_secret_leak(code: str) -> str | None:
    """Reject drafts that contain a secret-shaped hardcoded value.

    A local-LLM sometimes copies a value verbatim from the sample-context
    excerpt.  Even though the excerpt is already filtered by decompose-sample-
    context.py, a residual value may survive if the excerpt filtering was
    bypassed, or if the model invented one from the card text itself.
    (F2 fix, card d39fc5e7, WhiteHat finding.)
    """
    for line in code.splitlines():
        # skip comment lines -- a test that asserts the pattern is NOT present
        # would legitimately contain the keyword without being a real secret
        stripped = line.lstrip()
        if stripped.startswith(("//", "#", "*", "/*")):
            continue
        if _SECRET_LINE_RE.search(line):
            return "secret-shaped value in draft (key-name + long opaque string outside a comment)"
    return None


def check(draft: str, task: str, repo: str) -> str | None:
    code = strip_fences(draft)
    stripped_len = len(re.sub(r"\s+", "", code))
    if stripped_len < MIN_NONWHITESPACE_CHARS:
        return f"too-short ({stripped_len} non-whitespace chars after stripping code fences, need >= {MIN_NONWHITESPACE_CHARS})"

    ratio = difflib.SequenceMatcher(None, normalize(code), normalize(task)).ratio()
    if ratio > MAX_REPETITION_RATIO:
        return f"repeats-card-text (similarity {ratio:.2f} to the card's own title+description, threshold {MAX_REPETITION_RATIO})"

    reason = import_check(code, repo)
    if reason:
        return reason

    reason = check_secret_leak(code)
    if reason:
        return reason

    return None


def main() -> int:
    try:
        data = json.loads(sys.stdin.read())
    except Exception:
        print("FAIL\tunreadable input (not valid JSON on stdin)")
        return 1
    draft = str(data.get("draft") or "")
    task = str(data.get("task") or "")
    repo = str(data.get("repo") or "")

    reason = check(draft, task, repo)
    if reason:
        print("FAIL\t" + reason)
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""llm-skill-pack-build.py -- compile short rule+pitfall packs from SKILL.md / rule docs,
keyed by F3 mechanical task type (card 2746165b, phase 82a113ba).

Reads store/llm-skill-pack-map.json (task-type -> source files + extraction mode),
extracts only the rule/pitfall sections (or the whole body for mode "all"), and writes
each pack to <out-dir>/<task>.txt -- clean prose only, no filesystem paths or hostnames,
so a pack is safe to send over the freellm cloud route (card F8 constraint: "a pack that
names an internal path or host goes local-only"). Source provenance (paths + per-source
sha256) is written to a sidecar <task>.meta.json that is never sent to a model -- it is
local build metadata only, used for versioning (rebuild changes the pack sha whenever a
source changes).

Usage:
  llm-skill-pack-build.py [--map FILE] [--out-dir DIR] [--check]

--check: build nothing, verify every pack in the map exists, is non-empty, and the
token-cap estimate (len/chars_per_token) is within token_cap. Exit 1 on any violation.
Without --check: (re)builds every pack and prints "pack=<task>@<sha12>" per line.
"""
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MAP = os.path.join(ROOT, "store", "llm-skill-pack-map.json")
DEFAULT_OUT = os.path.join(ROOT, "store", "llm-skill-packs")

HEADER_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
# A markdown link's URL is not instructional content and is exactly the kind of noise that can
# accidentally look like a secret or PII to a content gate -- card 2746165b delta (QA-reproduced
# live: a source skill's attribution link's numeric tweet ID matched freellm-call.sh's PII
# cc_number pattern, 13-19 consecutive digits, refusing every real call that used the "default"
# pack). Keep the anchor text, drop the destination.
MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")


def _strip_markdown_links(text):
    return MARKDOWN_LINK_RE.sub(r"\1", text)

# QA FAIL 31746 (card 2746165b): a source path had no containment check (plain abspath,
# symlinks followed uninspected) and the extracted text had no secret scan at all, so a bad
# map entry -- typo'd path, copy-paste mistake, or a bad-faith edit, same filesystem access
# every agent already has to store/llm-skill-pack-map.json -- could silently ship an arbitrary
# file's contents to the freellm cloud route. Both checks below are fail-closed: refuse to
# build, never write a partial or redacted pack. ALLOWED_ROOTS is resolved with realpath (not
# a string prefix on the raw path) so a symlink that points OUT of an allowed root is refused
# the same way card ff7ecc74 fixed for this fleet's other skill-sync code.
ALLOWED_ROOTS = [
    os.path.realpath(os.path.expanduser("~/.claude/skills")),
    os.path.realpath(os.path.join(ROOT, "docs", "rules")),
]
# Test-only escape hatch: a selftest fixture cannot live under ~/.claude/skills (that directory
# is shared, live, fleet-wide) and cannot live under docs/rules either (tracked repo content).
# No production caller (freellm-call.sh, local-llm.sh) ever sets this; it only exists so
# llm-skill-pack-build.selftest.sh can point at a disposable temp directory.
if os.environ.get("LLM_SKILL_PACK_EXTRA_ROOT"):
    ALLOWED_ROOTS.append(os.path.realpath(os.environ["LLM_SKILL_PACK_EXTRA_ROOT"]))

# Ported from store/freellm-call.sh's content gate (same SECRET_PATTERNS alternations) rather
# than imported, matching this fleet's existing convention of a second copy for one small
# check (that script's own header documents the same tradeoff against gemini-offload-call.sh).
# Deliberately WITHOUT that gate's homoglyph-folding: these sources are trusted, non-adversarial
# fleet-authored SKILL.md/rule-doc text, not attacker-controlled input trying to evade detection
# -- the threat modeled here is an accidental secret landing in a doc, not an adversary hiding
# one past a scanner.
SECRET_PATTERNS = [
    (r'-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|OPENSSH PRIVATE KEY)-----', 'privkey'),
    (r'\bssh-(rsa|ed25519|dss) [A-Za-z0-9+/]{40,}={0,2}', 'ssh_pubkey'),
    (r'\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}', 'sk_live'),
    (r'\bsk[-_][A-Za-z0-9_-]{24,}', 'sk_generic'),
    (r'\bsk-proj-[A-Za-z0-9_-]{20,}', 'sk_proj'),
    (r'\bsk-ant-[A-Za-z0-9_-]{20,}', 'anthropic'),
    (r'(?i)xi-api-key["\'\s:=]+[A-Za-z0-9_-]{16,}', 'elevenlabs'),
    (r'(?i)\bBearer\s+[A-Za-z0-9_\-.=+/]{4,}', 'bearer'),
    (r'\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}', 'jwt'),
    (r'\bgh[pousr]_[A-Za-z0-9]{30,}', 'github'),
    (r'\bxox[baprs]-[A-Za-z0-9-]{10,}', 'slack'),
    (r'\bAKIA[0-9A-Z]{16}\b', 'aws'),
    (r'(?i)aws_secret_access_key["\'\s:=]+[A-Za-z0-9/+=]{30,}', 'aws_secret'),
    (r'\bsbp_[0-9a-f]{40}\b', 'supabase'),
    (r'\bAIza[0-9A-Za-z_-]{20,}', 'google'),
    (r'\b[0-9]+-[0-9A-Za-z_-]{32}\.apps\.googleusercontent\.com\b', 'google_oauth'),
    (r'\b\d{8,12}:[A-Za-z0-9_-]{35,}\b', 'telegram'),
    (r'\bSK[0-9a-f]{32}\b', 'twilio'),
    (r'\bAC[0-9a-f]{32}\b', 'twilio_sid'),
    (r'\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}', 'sendgrid'),
    (r'\bnpm_[A-Za-z0-9]{36}\b', 'npm'),
    (r'\bdckr_pat_[A-Za-z0-9_-]{20,}\b', 'dockerhub'),
    (r'\bdop_v1_[a-f0-9]{64}\b', 'digitalocean'),
    (r'\b[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b', 'discord'),
    (r'(?i)cloudflare[_-]?(api[_-]?)?token["\'\s:=]+[A-Za-z0-9_-]{30,}', 'cloudflare'),
    (r'(?i)AccountKey=[A-Za-z0-9+/]{40,}={0,2}', 'azure'),
    (r'(?m)^[ \t]*(export[ \t]+)?[A-Za-z_][A-Za-z0-9_]+=\S{8,}', 'env'),
    (r'((?<![A-Za-z0-9])|(?<=[a-z0-9])(?=[A-Z]))(?i:password|passwd|secret|token|api[_-]?key|auth[_-]?key|access[_-]?key)["\']?[=:\s]+'
     r'(?:"[^"\n]{8,}"|\'[^\'\n]{8,}\'|[A-Za-z0-9_\-.=+/]{8,})', 'cred'),
    (r'(?i)(postgres|mysql|mongodb|redis)://[^:]+:[^@]{4,}@', 'dburl'),
    (r'(?i)\bBasic\s+[A-Za-z0-9+/=]{8,}', 'basic'),
    (r'\bASIA[0-9A-Z]{16}\b', 'aws_asia'),
    (r'\b1//0[A-Za-z0-9_-]{20,}\b', 'google_refresh'),
    (r'(?i)\bcookie:\s*[^\n]*?session[A-Za-z0-9_]*=[A-Za-z0-9%_.\-]{8,}', 'cookie_session'),
    (r'\bwhsec_[A-Za-z0-9]{16,}\b', 'stripe_whsec'),
]


class PackBuildRefused(Exception):
    """Raised to refuse a build outright (path escape or a detected secret shape) --
    never caught by anything that would let a partial/tainted pack get written."""


def assert_contained(resolved_path):
    for root in ALLOWED_ROOTS:
        if resolved_path == root or resolved_path.startswith(root + os.sep):
            return
    raise PackBuildRefused(
        f"source path '{resolved_path}' is outside every allowed root ({ALLOWED_ROOTS}) -- refusing to read it"
    )


def assert_no_secret(text, source_label):
    for pattern, label in SECRET_PATTERNS:
        if re.search(pattern, text, re.DOTALL):
            raise PackBuildRefused(
                f"source '{source_label}' matched secret pattern '{label}' -- refusing to build "
                "(nothing was written; this pack would have left the machine over the freellm "
                "cloud route)"
            )


def strip_frontmatter(text):
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            nl = text.find("\n", end + 1)
            return text[nl + 1 :] if nl != -1 else ""
    return text


def parse_sections(text):
    """Return list of (level, header_text, body_text) for every header in the doc."""
    lines = text.splitlines()
    sections = []
    cur_level = None
    cur_header = None
    buf = []

    def flush():
        if cur_header is not None:
            sections.append((cur_level, cur_header, "\n".join(buf).strip()))

    for line in lines:
        m = HEADER_RE.match(line)
        if m:
            flush()
            cur_level = len(m.group(1))
            cur_header = m.group(2)
            buf = []
        else:
            if cur_header is not None:
                buf.append(line)
    flush()
    return sections


def extract(source_text, mode, rule_kw, pitfall_kw):
    body = strip_frontmatter(source_text)
    if mode == "all":
        # drop the first H1 title line, keep the rest
        sections = parse_sections(body)
        parts = [body for _ in [0]]  # placeholder, replaced below
        # find index of first level-1 header and cut it out, keep everything after
        lines = body.splitlines()
        for i, line in enumerate(lines):
            if HEADER_RE.match(line) and HEADER_RE.match(line).group(1) == "#":
                return "\n".join(lines[i + 1 :]).strip()
        return body.strip()
    # mode == "sections"
    keywords = [k.lower() for k in (rule_kw + pitfall_kw)]
    out = []
    for level, header, text in parse_sections(body):
        h = header.lower()
        if any(k in h for k in keywords):
            out.append(f"{header}\n{text}".strip())
    return "\n\n".join(out).strip()


def expand(path):
    # A relative path (no leading '~' or '/') resolves against ROOT (this script's own repo
    # checkout), not the process cwd -- so a map entry like "docs/rules/x.md" is portable across
    # every agent's own worktree instead of hardcoding one agent's absolute clone path.
    expanded = os.path.expanduser(path)
    if not os.path.isabs(expanded):
        expanded = os.path.join(ROOT, expanded)
    # realpath (not abspath) so a symlink pointing outside an allowed root is resolved to its
    # real target BEFORE the containment check below ever runs -- an unresolved symlink would
    # let assert_contained see only the in-root symlink path and miss where it actually reads from.
    resolved = os.path.realpath(expanded)
    assert_contained(resolved)
    return resolved


def build_one(task, cfg, map_cfg):
    rule_kw = map_cfg.get("rule_keywords", [])
    pitfall_kw = map_cfg.get("pitfall_keywords", [])
    chunks = []
    manifest_sources = []
    for src in cfg["sources"]:
        path = expand(src["path"])
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
        extracted = _strip_markdown_links(extract(raw, src.get("mode", "sections"), rule_kw, pitfall_kw))
        if extracted:
            assert_no_secret(extracted, f"{task}:{src['path']}")
            chunks.append(extracted)
        manifest_sources.append(
            {
                "path": path,
                "mode": src.get("mode", "sections"),
                "sha256_12": hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12],
            }
        )

    body = "\n\n---\n\n".join(chunks).strip()

    chars_per_token = map_cfg.get("chars_per_token", 4)
    token_cap = map_cfg.get("token_cap", 1500)
    char_cap = token_cap * chars_per_token
    truncated = False
    if len(body) > char_cap:
        cut = body.rfind("\n", 0, char_cap)
        if cut < char_cap // 2:
            cut = char_cap
        body = body[:cut].rstrip() + "\n[...]"
        truncated = True

    return body, manifest_sources, truncated, len(body) // chars_per_token, token_cap


def main():
    args = sys.argv[1:]
    map_path = DEFAULT_MAP
    out_dir = DEFAULT_OUT
    check_only = False
    i = 0
    while i < len(args):
        if args[i] == "--map":
            map_path = args[i + 1]
            i += 2
        elif args[i] == "--out-dir":
            out_dir = args[i + 1]
            i += 2
        elif args[i] == "--check":
            check_only = True
            i += 1
        else:
            print(f"unknown arg: {args[i]}", file=sys.stderr)
            return 2

    with open(map_path, "r", encoding="utf-8") as f:
        map_cfg = json.load(f)

    os.makedirs(out_dir, exist_ok=True)
    token_cap = map_cfg.get("token_cap", 1500)
    chars_per_token = map_cfg.get("chars_per_token", 4)

    violations = []
    for task, cfg in map_cfg["types"].items():
        pack_path = os.path.join(out_dir, f"{task}.txt")
        if check_only:
            if not os.path.isfile(pack_path):
                violations.append(f"{task}: missing {pack_path}")
                continue
            size = os.path.getsize(pack_path)
            if size == 0:
                violations.append(f"{task}: empty pack")
                continue
            est_tokens = size // chars_per_token
            if est_tokens > token_cap:
                violations.append(f"{task}: {est_tokens} est. tokens > cap {token_cap}")
            continue

        try:
            body, sources, truncated, est_tokens, cap = build_one(task, cfg, map_cfg)
        except PackBuildRefused as e:
            print(f"REFUSED: {task}: {e}", file=sys.stderr)
            return 3
        if not body:
            print(f"WARNING: {task} produced an empty pack (check keywords/sources)", file=sys.stderr)
        with open(pack_path, "w", encoding="utf-8") as f:
            f.write(body + "\n")
        sha12 = hashlib.sha256((body + "\n").encode("utf-8")).hexdigest()[:12]
        meta = {
            "task": task,
            "sha256_12": sha12,
            "est_tokens": est_tokens,
            "token_cap": cap,
            "truncated": truncated,
            "sources": sources,
        }
        with open(os.path.join(out_dir, f"{task}.meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
            f.write("\n")
        print(f"pack={task}@{sha12} est_tokens={est_tokens}/{cap} truncated={truncated}")

    if check_only and violations:
        for v in violations:
            print(f"CHECK FAIL: {v}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

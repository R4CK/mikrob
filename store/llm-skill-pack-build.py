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
    return os.path.abspath(os.path.expanduser(path))


def build_one(task, cfg, map_cfg):
    rule_kw = map_cfg.get("rule_keywords", [])
    pitfall_kw = map_cfg.get("pitfall_keywords", [])
    chunks = []
    manifest_sources = []
    for src in cfg["sources"]:
        path = expand(src["path"])
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
        extracted = extract(raw, src.get("mode", "sections"), rule_kw, pitfall_kw)
        if extracted:
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

        body, sources, truncated, est_tokens, cap = build_one(task, cfg, map_cfg)
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

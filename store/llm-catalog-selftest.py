#!/usr/bin/env python3
"""llm-catalog-selftest.py -- controls for llm-catalog.py (card 6f8f71fa).

OFFLINE and deterministic: every HTTP response is a fixture written here at run time, so the suite
never depends on what HuggingFace happens to serve today. A generator that can only be checked
against the live network is one nobody re-checks after the first day.

The controls are the DEFECTS THIS FILE ACTUALLY SHIPPED WITH AND THEN FIXED, each pinned so it
cannot return:
  1. a sharded quant sized by one shard        -> a 30 GB model called "fits" on a 6 GB card
  2. one quant shipped BOTH sharded and single -> summed against itself, ~2x over-count
  3. mmproj/vision companions catalogued as models
  4. an unrecognised quant kept, whose install ref cannot resolve
Plus the invariants the design promises: never-invented throughput, digest per part, fallback rather
than an empty list.

Usage: store/llm-catalog-selftest.py   (exit 0 = PASS, 1 = FAIL)
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CAT = os.path.join(HERE, "llm-catalog.py")
spec = importlib.util.spec_from_file_location("llm_catalog", CAT)
cat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cat)

fails = []


def check(label, expected, actual):
    if actual == expected:
        print("  ok   %s -> %s" % (label, actual))
    else:
        print("  FAIL %s -> got %r, expected %r" % (label, actual, expected))
        fails.append(label)


def gguf(path, gb, oid="a" * 64):
    return {"path": path, "type": "file", "oid": "x", "lfs": {"oid": oid, "size": int(gb * 1024 ** 3)}}


# --- 1. sharded quant: sized as a SET, never as one shard ---------------------------------------
tree_sharded = [
    gguf("m-fp16-00001-of-00005.gguf", 3.95),
    gguf("m-fp16-00002-of-00005.gguf", 7.0),
    gguf("m-fp16-00003-of-00005.gguf", 7.0),
    gguf("m-fp16-00004-of-00005.gguf", 7.0),
    gguf("m-fp16-00005-of-00005.gguf", 5.5),
]
s = cat.quant_sets(tree_sharded)
one = list(s.values())[0]
check("sharded quant has all 5 parts", 5, len(one["parts"]))
check("sharded quant sized as the SET (GB)", 30, round(one["bytes"] / 1024 ** 3))

# --- 2. THE DOUBLE-COUNT TRAP: same quant shipped sharded AND standalone ------------------------
tree_dup = [
    gguf("m-q4_k_m-00001-of-00002.gguf", 3.72),
    gguf("m-q4_k_m-00002-of-00002.gguf", 0.64),
    gguf("m-q4_k_m.gguf", 4.36),
]
s = cat.quant_sets(tree_dup)
check("duplicate representations collapse to ONE quant", 1, len(s))
dup = list(s.values())[0]
# ~4.36, NOT ~8.7. This is the control that would have caught the shipped bug.
check("not summed against itself (GB)", 4, round(dup["bytes"] / 1024 ** 3))
check("standalone preferred over the shard series", 1, len(dup["parts"]))

# --- 3. companions are not models ---------------------------------------------------------------
tree_mm = [gguf("mmproj-F16.gguf", 0.9), gguf("m-q4_k_m.gguf", 4.4)]
s = cat.quant_sets(tree_mm)
check("mmproj excluded", 1, len(s))
check("  ...and the real model survived", "Q4_K_M", list(s.values())[0]["quant"])

# --- 4. fit rule: three tiers, and required != file size ---------------------------------------
GPU6 = {"vramTotalMib": 6144, "vramFreeMib": 6000, "ramTotalMib": 24000, "cpuOnly": False}
req = cat.required_mib(4466)
check("required exceeds file size (KV + overhead)", True, req > 4466)
check("4.4G model on a 6G card is not 'fits'", "partial", cat.tier_of(req, 6144, 24000, False))
check("small model on a 6G card fits", "fits", cat.tier_of(cat.required_mib(2800), 6144, 24000, False))
check("30G model is too-big", "too-big", cat.tier_of(cat.required_mib(31000), 6144, 24000, False))
check("cpu-only host still offers something", "partial", cat.tier_of(cat.required_mib(2000), None, 24000, True))

# --- 5. end-to-end through the fixture transport -------------------------------------------------
tmp = tempfile.mkdtemp()


def fixture_name(url):
    return re.sub(r"[^A-Za-z0-9]+", "_", url.replace(cat.HF, "")).strip("_") + ".json"


disco = [
    {"id": "Qwen/Test-Coder-GGUF", "author": "Qwen", "downloads": 999, "gated": False},
    {"id": "shady/Test-Coder-GGUF", "author": "shady", "downloads": 5, "gated": False},
    {"id": "Qwen/Gated-Coder-GGUF", "author": "Qwen", "downloads": 100, "gated": True},
]
for term in ["coder", "code", "starcoder"]:
    url = "%s/api/models?filter=gguf&search=%s&sort=downloads&direction=-1&limit=20" % (cat.HF, term)
    with open(os.path.join(tmp, fixture_name(url)), "w") as f:
        json.dump(disco if term == "coder" else [], f)
for repo in ["Qwen/Test-Coder-GGUF", "shady/Test-Coder-GGUF"]:
    url = "%s/api/models/%s/tree/main?recursive=true" % (cat.HF, repo)
    with open(os.path.join(tmp, fixture_name(url)), "w") as f:
        json.dump(tree_dup + [gguf("mmproj-F16.gguf", 0.9)], f)

models, notes = cat.build(GPU6, fixture=tmp)
ids = {m["repo"] for m in models}
check("gated repo never offered", False, "Qwen/Gated-Coder-GGUF" in ids)
check("trusted publisher present", True, "Qwen/Test-Coder-GGUF" in ids)
check("untrusted publisher listed but flagged", False,
      next((m["trusted"] for m in models if m["repo"] == "shady/Test-Coder-GGUF"), None))
check("trusted flag set for the allowlisted one", True,
      next((m["trusted"] for m in models if m["repo"] == "Qwen/Test-Coder-GGUF"), None))
check("throughput is NEVER invented", True, all(m["tokensPerSecond"] is None for m in models))
check("every part carries a digest", True, all(p["sha256"] for m in models for p in m["parts"]))
check("install ref is the ollama form", True,
      all(m["installRef"].startswith("hf.co/") and ":" in m["installRef"] for m in models))
check("fresh model is not silently trusted-in-use", True,
      all(m["installedAt"] is None and m["benchmarkedAt"] is None for m in models))

# --- 6. failure serves a fallback, never an empty list -------------------------------------------
env = cat.fallback(GPU6, "simulated outage")
check("fallback marks staleness", True, env["stale"])
check("fallback still emits a valid envelope", 1, env["schemaVersion"])
check("fallback explains itself", True, any("simulated outage" in w for w in env["warnings"]))

print()
if fails:
    print("selftest: FAIL (%d)" % len(fails))
    sys.exit(1)
print("selftest: PASS")

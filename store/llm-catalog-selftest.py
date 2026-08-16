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

# --- 7. the SHIPPED fallback catalogue, and the host-dependence it must not carry (card e35bc379) --
# The bundled file is the last resort: no cache, no network, first run. It was REFERENCED by the code
# from the start and never existed, so that path returned an empty list -- the one outcome this
# design says must never happen. It exists now, and these controls pin both halves.
#
# The second half is the part that is easy to get wrong: a catalogue entry mixes FACTS (repo, quant,
# parts, size -- true anywhere) with HOST-DEPENDENT fit (tier, requiredMib -- computed against the
# VRAM of the machine that produced the file). Shipping stored tiers would tell a 4 GB card that a
# 12 GB model fits, which is worse than shipping nothing, because fit filtering is what this document
# is FOR. So the fallback recomputes them for the reading host, and these checks compare two hosts.
BUNDLED_DOC = None
try:
    with open(cat.BUNDLED) as f:
        BUNDLED_DOC = json.load(f)
except Exception as exc:
    fails.append("bundled")
    print("  FAIL bundled catalogue is readable -> %s" % exc)

if BUNDLED_DOC is not None:
    check("bundled catalogue ships models", True, len(BUNDLED_DOC.get("models") or []) > 0)
    check("bundled document satisfies the consumer contract", [], cat.validate(BUNDLED_DOC))
    check("every bundled part carries a digest", True,
          all(p.get("sha256") for m in BUNDLED_DOC["models"] for p in m.get("parts") or []))

    TINY = {"vramTotalMib": 4096, "vramFreeMib": 4096, "ramTotalMib": 8000, "cpuOnly": False}
    BIG = {"vramTotalMib": 24576, "vramFreeMib": 24576, "ramTotalMib": 64000, "cpuOnly": False}
    tiny = cat.retier(BUNDLED_DOC["models"], TINY)
    big = cat.retier(BUNDLED_DOC["models"], BIG)
    check("a big host is offered every bundled entry", len(BUNDLED_DOC["models"]), len(big))
    check("  ...and they all read as 'fits' there", True, all(m["tier"] == "fits" for m in big))
    # THE CONTROL THAT MATTERS: the same file, a smaller card, a different answer. If retier were a
    # no-op (stored tiers served as-is) these two lists would be identical.
    check("a small host is offered strictly fewer", True, len(tiny) < len(big))
    check("  ...and nothing it cannot run", True, all(m["tier"] != "too-big" for m in tiny))
    biggest = max(BUNDLED_DOC["models"], key=lambda m: m.get("fileMib") or 0)
    check("  ...specifically not the largest entry", True,
          all(m["repo"] != biggest["repo"] or m["quant"] != biggest["quant"] for m in tiny))

# --- ORDER IS AN OFFER (card 51ad7c7c) --------------------------------------------------------
# first-run-llm.sh prints models[:5] numbered and retier() never re-sorts, so position 1 is what an
# operator installs. The key used to be (fits, trusted, downloads) with quantisation absent, which
# put the most DOWNLOADED quant of a model first -- Q2_K ahead of the same repo's Q4_0.
print("\n-- offer order --")
check("a better quant outranks a weaker one", True, cat.quant_rank("Q4_0") > cat.quant_rank("Q2_K"))
check("  ...across families too (IQ4_XS beats Q2_K)", True,
      cat.quant_rank("IQ4_XS") > cat.quant_rank("Q2_K"))
check("  ...and IQ1 is the floor it should be", True, cat.quant_rank("IQ1_S") < cat.quant_rank("Q2_K"))
# An unranked quant must sort LAST within its repo, never be guessed upward: 24 of the 40 quants in
# the live catalogue were unranked by the first version of the table, IQ4_XS among them.
check("an unknown quant ranks below every known one", True, cat.quant_rank("Q9_NOPE") < 0)

_rows = [
    {"repo": "A/x", "quant": "Q2_K", "tier": "fits", "trusted": True, "downloads": 100},
    {"repo": "A/x", "quant": "Q4_K_M", "tier": "fits", "trusted": True, "downloads": 100},
    {"repo": "A/x", "quant": "Q3_K_M", "tier": "fits", "trusted": True, "downloads": 100},
    {"repo": "B/y", "quant": "Q8_0", "tier": "fits", "trusted": True, "downloads": 500},
]
_sorted = sorted(_rows, key=lambda m: (m["tier"] != "fits", not m["trusted"],
                                       -(m["downloads"] or 0), -cat.quant_rank(m["quant"])))
check("within one repo the best quant leads", ["Q4_K_M", "Q3_K_M", "Q2_K"],
      [m["quant"] for m in _sorted if m["repo"] == "A/x"])
# THE COST CONTROL. The quant key is deliberately LAST so it only breaks a tie -- downloads are a
# repo-level number, so entries reach it only when they are the same repo. A popular model must not
# lose its place to a niche one with a fancier quant.
check("  ...and the more popular REPO still leads", "B/y", _sorted[0]["repo"])

# --- 8. Cybered LOW-1: a malformed repo id must not survive to the offline cache (card d7220a73) --
print("\n-- Cybered LOW-1: repo shape --")
check("a normal owner/repo passes", True, bool(cat.HF_REPO_RX.match("Qwen/Qwen2.5-Coder-7B-GGUF")))
check("no slash is rejected", False, bool(cat.HF_REPO_RX.match("justarepo")))
check("two slashes are rejected", False, bool(cat.HF_REPO_RX.match("a/b/c")))
check("a segment starting with a dot is rejected", False, bool(cat.HF_REPO_RX.match("../etc")))
check("an empty repo is rejected", False, bool(cat.HF_REPO_RX.match("")))

# The malformed id must contain a relevance keyword ("coder") itself, so the ONLY thing that can
# exclude it is the shape guard under test -- otherwise the ordinary relevance filter would drop it
# too, and the control would pass even with the guard removed (checked with a mutation: it did).
MALFORMED_REPO = ".hidden/coder-model"
tmp2 = tempfile.mkdtemp()
for term in ["coder", "code", "starcoder"]:
    url = "%s/api/models?filter=gguf&search=%s&sort=downloads&direction=-1&limit=20" % (cat.HF, term)
    with open(os.path.join(tmp2, fixture_name(url)), "w") as f:
        json.dump(disco + [{"id": MALFORMED_REPO, "author": "Qwen", "downloads": 1, "gated": False}]
                   if term == "coder" else [], f)
for repo in ["Qwen/Test-Coder-GGUF", "shady/Test-Coder-GGUF", MALFORMED_REPO]:
    url = "%s/api/models/%s/tree/main?recursive=true" % (cat.HF, repo)
    with open(os.path.join(tmp2, fixture_name(url)), "w") as f:
        json.dump(tree_dup, f)
models2, notes2 = cat.build(GPU6, fixture=tmp2)
check("the malformed repo id is dropped, not catalogued", False, MALFORMED_REPO in {m["repo"] for m in models2})
check("its rejection is stated, not silent", True, any("malformed repo id" in n for n in notes2))

# --- 9. Cybered LOW-2: pinned is DERIVED from every part, not just parts[0] (card d7220a73) --------
print("\n-- Cybered LOW-2: pinned --")
tree_partial = [gguf("m-q4-00001-of-00002.gguf", 3.72), gguf("m-q4-00002-of-00002.gguf", 0.64)]
s = cat.quant_sets(tree_partial)
one = list(s.values())[0]
one["parts"][1]["sha256"] = None  # part 0 pinned, part 1 is not -- the exact shape LOW-2 named
check("a set with one unpinned part is not fully pinned", False, all(p["sha256"] for p in one["parts"]))

# THE control that would have caught the shipped bug: run it through the real build(), part 0 pinned
# and part 1 NOT, and check the field build() actually WRITES -- not a hand-set dict. `models` from
# section 5 is all single-part, so it cannot exercise this: part 0 IS every part there.
tmp3 = tempfile.mkdtemp()
for term in ["coder", "code", "starcoder"]:
    url = "%s/api/models?filter=gguf&search=%s&sort=downloads&direction=-1&limit=20" % (cat.HF, term)
    with open(os.path.join(tmp3, fixture_name(url)), "w") as f:
        json.dump([{"id": "Qwen/Partial-Coder-GGUF", "author": "Qwen", "downloads": 1, "gated": False}]
                   if term == "coder" else [], f)
url = "%s/api/models/Qwen/Partial-Coder-GGUF/tree/main?recursive=true" % cat.HF
with open(os.path.join(tmp3, fixture_name(url)), "w") as f:
    json.dump([gguf("p-fp16-00001-of-00002.gguf", 2.0), gguf("p-fp16-00002-of-00002.gguf", 2.0, oid=None)], f)
models3, _ = cat.build(GPU6, fixture=tmp3)
check("build() produced exactly one partial-digest model", 1, len(models3))
check("its pinned field is False -- part 0 alone must not read as pinned", False, models3[0]["pinned"])

# `models` (section 5's e2e fixture build) is a real, fully-valid document -- reused here for the
# validate()-agrees case, which the single-part shape above cannot exercise on its own.
_env = {"schemaVersion": 1, "generatedAt": "x", "source": "x", "warnings": [], "host": {}, "models": models}
check("a correctly-built catalogue's pinned fields all agree with their parts", [],
      [e for e in cat.validate(_env) if "pinned" in e])
_bad = dict(models[0])
_bad["pinned"] = not _bad["pinned"]
check("validate() catches a pinned flag that disagrees with its own parts", True,
      any("pinned" in e for e in cat.validate({**_env, "models": [_bad]})))

print()
if fails:
    print("selftest: FAIL (%d)" % len(fails))
    sys.exit(1)
print("selftest: PASS")

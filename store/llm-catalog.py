#!/usr/bin/env python3
"""llm-catalog.py -- build the local-LLM model catalogue from HuggingFace.

Card 6f8f71fa (EPIC ebc7b4dd, T1 Alfeladat 2). Design: docs/local-llm-model-catalog.md.
Consumers: the installer/first-run step (T2, fbbb4015) and the selector UI (T4, 61a4a85f).

THREE THINGS THIS FILE EXISTS TO GET RIGHT, all of them measured rather than assumed:

1. A QUANT IS A FILE SET, NOT A FILE. Measured on Qwen/Qwen2.5-Coder-7B-Instruct-GGUF: the fp16
   quant is FIVE shards totalling 30.48 GB, and shard one alone is 3.95 GB. Sizing by a single
   file would call a 30 GB model "fits" on a 6 GB card -- the exact false promise the tier system
   exists to prevent, produced by the tier system itself. The trap is that every shard is ~4 GB, so
   the wrong number looks precisely like a real 7B q4 file.

2. FILE SIZE IS NOT VRAM NEED. required = set size + KV cache + runtime overhead. Measured on this
   host, a 7B q4_K_M (~4.4 GB) never fully fits 6144 MiB -- 16-27% of layers stay on CPU even tuned.
   Hence THREE tiers: a binary fits/does-not-fit would have hidden the model the fleet actually uses.

3. TRUST IS NOT RELEVANCE. Relevance answers "is this a coding model" and stays a cheap data edit.
   Trust answers "may this be INSTALLED" and must not inherit that looseness -- the installed weights
   become the fleet's code-suggesting oracle. Two lists, two lifetimes (Cybered, card 87d7c86f).

NEVER INVENTED: tokensPerSecond is null unless measured on this hardware class. A guessed throughput
rendered next to a real one is indistinguishable from it.

Usage:
  store/llm-catalog.py                     # fetch, write cache, print JSON
  store/llm-catalog.py --offline           # cache or bundled fallback only, never the network
  store/llm-catalog.py --fixture <dir>     # read api responses from files (selftest, no network)
  store/llm-catalog.py --gpu <file>        # GPU json (default: run store/gpu-detect.sh)
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_VERSION = 1
HF = "https://huggingface.co"
CACHE = os.environ.get("LLM_CATALOG_CACHE", os.path.join(HERE, "llm-catalog-cache.json"))
BUNDLED = os.path.join(HERE, "llm-catalog-bundled.json")
TRUST_FILE = os.environ.get("LLM_CATALOG_TRUST", os.path.join(HERE, "llm-catalog-trust.json"))

# Runtime overhead beyond weights + KV: load scratch, compute buffers, and whatever the display and
# driver already hold. CALIBRATED FROM THE ONE MEASUREMENT WE HAVE, not chosen for roundness.
#
# The measurement (card 7041c165, 3 runs per point): qwen2.5-coder 7B q4_K_M -- a 4466 MiB weight
# set -- does NOT fully fit this 6144 MiB card; 16-27% of layers stay on CPU even with flash
# attention and a q8_0 KV cache. So the honest constraint is:
#
#     required(4466) MUST exceed 0.90 * 6144 = 5530     ->  overhead > 5530 - 4466 - 119 = 945
#
# At the initial 600 the rule called that model "fits", i.e. it contradicted the only hard data
# point available -- and it would have promised full residency for exactly the model this fleet runs
# and has measured as partial. 1024 satisfies the constraint with a little margin.
#
# ONE data point, on ONE GPU. It is a floor derived from a real failure to fit, not a law: a card
# with a different driver/display baseline will differ, so this should be re-derived per hardware
# class once a second measurement exists (store/local-llm-bench.sh produces the input).
OVERHEAD_MIB = 1024
DEFAULT_CTX = 4096
# Measured (card 7041c165) with flash-attention + q8_0 KV: 119 MiB at ctx 4096, 476 at 16384,
# 714 at 24576 -- close enough to linear to interpolate, and stated as measured, not derived.
KV_MIB_PER_1K_CTX = 119.0 / 4.0

SHARD_RX = re.compile(r"-\d{5}-of-\d{5}(?=\.gguf$)", re.I)
QUANT_RX = re.compile(r"[.\-_]((?:IQ|Q)\d+[_A-Za-z0-9]*|f16|fp16|bf16)(?=\.gguf$)", re.I)

# NOT MODELS, even though they are .gguf files in a model repo. Caught by inspecting real output
# rather than by trusting it: unsloth/Kimi-K2.7-Code-GGUF ships mmproj-F16.gguf (908 MiB) beside a
# 594 GB model, and without this filter the catalogue offered "Kimi-K2.7-Code BF16, 909 MiB, fits"
# on a 6 GB card. That entry is not merely mis-sized -- it is not a model at all, so installing it
# would produce nothing runnable. A multimodal projector accompanies a model; it never replaces one.
COMPANION_RX = re.compile(r"(^|/)(mmproj|mmproj-model|clip|vision)[-_.]", re.I)


def _get(url, fixture=None, timeout=30):
    """One JSON GET. With --fixture, read a file instead -- the selftest must not touch the network,
    and a generator that can only be tested online is a generator nobody re-tests."""
    if fixture is not None:
        name = re.sub(r"[^A-Za-z0-9]+", "_", url.replace(HF, "")).strip("_") + ".json"
        path = os.path.join(fixture, name)
        if not os.path.exists(path):
            raise FileNotFoundError(path)
        with open(path) as f:
            return json.load(f)
    req = urllib.request.Request(url, headers={"User-Agent": "mikrob-llm-catalog/1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def load_trust():
    """Trust and relevance are SEPARATE lists in one file, on purpose: keeping them in one place
    makes the distinction visible to whoever edits it, and the schema forces a choice of which one
    they are touching."""
    try:
        with open(TRUST_FILE) as f:
            d = json.load(f)
    except Exception:
        d = {}
    return (
        [s.lower() for s in d.get("trustedPublishers", [])],
        [s.lower() for s in d.get("relevantFamilies", [])],
        [s.lower() for s in d.get("relevanceKeywords", ["coder", "code", "starcoder", "deepseek"])],
    )


def quant_of(path):
    m = QUANT_RX.search(path)
    return m.group(1).upper() if m else "UNKNOWN"


def quant_sets(tree):
    """Group .gguf entries into QUANT SETS, stripping the -NNNNN-of-NNNNN shard suffix.

    Returns {setKey: {"quant", "parts": [{path, sizeMib, sha256}], "bytes"}}. The digest is kept PER
    PART because a set is only pinned when every shard is -- one unverified shard is enough to swap
    the weights (Cybered, card 87d7c86f)."""
    grouped = {}
    for e in tree:
        path = str(e.get("path", ""))
        if not path.lower().endswith(".gguf"):
            continue
        if COMPANION_RX.search(path):
            continue
        lfs = e.get("lfs") or {}
        size = lfs.get("size") or e.get("size") or 0
        base = SHARD_RX.sub("", path)
        # A SHARDED SERIES AND A STANDALONE FILE OF THE SAME QUANT ARE ALTERNATIVES, NOT PARTS.
        # Measured on Qwen/Qwen2.5-Coder-7B-Instruct-GGUF, which ships BOTH:
        #     ...-q4_k_m-00001-of-00002.gguf   3808 MiB
        #     ...-q4_k_m-00002-of-00002.gguf    657 MiB
        #     ...-q4_k_m.gguf                  4466 MiB   <- the same model, unsharded
        # Keying on the shard-stripped name alone summed all three to 9.37 GB -- double counting the
        # model against itself. The true size is ~4.4 GB, which is exactly what this fleet runs, so
        # the error was visible only by checking against a model whose real size we already knew.
        # Over-counting is the safer direction than under-counting, but it still mis-tiers, and here
        # it would have mis-tiered the fleet's own daily driver.
        variant = "sharded" if SHARD_RX.search(path) else "single"
        g = grouped.setdefault((base, variant), {"quant": quant_of(base), "parts": [], "bytes": 0})
        g["parts"].append(
            {
                "path": path,
                "sizeMib": int(size / (1024 * 1024)),
                # None, not "", when absent: a missing digest must be visibly missing so the
                # install-time check can refuse rather than compare against an empty string.
                "sha256": lfs.get("oid") or None,
            }
        )
        g["bytes"] += int(size)

    # Collapse the alternatives: one entry per quant. The standalone file wins when present -- fewer
    # objects to verify at install time, and `ollama pull hf.co/<repo>:<QUANT>` resolves the artifact
    # itself, so the catalogue only has to report the right SIZE.
    sets = {}
    for (base, variant), g in grouped.items():
        cur = sets.get(base)
        if cur is None or (variant == "single" and len(cur["parts"]) > 1):
            sets[base] = g
    for g in sets.values():
        g["parts"].sort(key=lambda p: p["path"])
    return sets


def required_mib(file_mib, ctx=DEFAULT_CTX):
    return int(file_mib + (ctx / 1024.0) * KV_MIB_PER_1K_CTX + OVERHEAD_MIB)


def tier_of(required, vram_total_mib, ram_total_mib, cpu_only):
    """Three tiers. `partial` exists because this host's daily driver IS a partial-offload model at a
    perfectly usable 27-32 tok/s -- a binary filter would hide exactly the model in use."""
    if cpu_only or not vram_total_mib:
        # No GPU: RAM is the ceiling, and far more conservatively -- everything runs on CPU.
        if ram_total_mib and required <= ram_total_mib * 0.5:
            return "partial"
        return "too-big"
    if required <= vram_total_mib * 0.90:
        return "fits"
    headroom = (ram_total_mib or 0) * 0.5
    if required <= vram_total_mib * 0.90 + headroom:
        return "partial"
    return "too-big"


def build(gpu, limit=20, fixture=None, keywords=None):
    trusted_pubs, relevant_families, relevance_kw = load_trust()
    kw = keywords or relevance_kw
    seen, models, notes = set(), [], []
    for term in kw[:3]:
        url = (
            "%s/api/models?filter=gguf&search=%s&sort=downloads&direction=-1&limit=%d"
            % (HF, term, limit)
        )
        try:
            found = _get(url, fixture)
        except Exception as exc:
            notes.append("discovery failed for '%s': %s" % (term, type(exc).__name__))
            continue
        for m in found:
            repo = m.get("id")
            if not repo or repo in seen:
                continue
            seen.add(repo)
            # A gated repo needs a token the first-run flow does not have -- offering it would
            # produce an install that fails at the download, which is worse than not listing it.
            if m.get("gated") or m.get("private"):
                continue
            owner = (m.get("author") or repo.split("/")[0] or "").strip()
            try:
                tree = _get("%s/api/models/%s/tree/main?recursive=true" % (HF, repo), fixture)
            except Exception:
                notes.append("tree unavailable: %s" % repo)
                continue
            relevant = any(k in repo.lower() for k in kw) or owner.lower() in relevant_families
            if not relevant:
                continue
            trusted = owner.lower() in trusted_pubs
            for key, s in quant_sets(tree).items():
                file_mib = int(s["bytes"] / (1024 * 1024))
                if file_mib <= 0:
                    continue
                # An unrecognised quant cannot be reasoned about -- not its memory behaviour and not
                # its install ref, since `ollama pull hf.co/<repo>:<QUANT>` needs the exact tag. A
                # guessed tag produces a 400 at install time, so drop it here instead.
                if s["quant"] == "UNKNOWN":
                    continue
                req = required_mib(file_mib)
                tier = tier_of(req, gpu.get("vramTotalMib"), gpu.get("ramTotalMib"), gpu.get("cpuOnly", True))
                if tier == "too-big":
                    continue
                models.append(
                    {
                        "id": "%s:%s" % (repo.replace("/", "_").lower(), s["quant"].lower()),
                        "repo": repo,
                        "repoOwner": owner,
                        "displayName": repo.split("/")[-1].replace("-GGUF", "").replace("-gguf", ""),
                        "quant": s["quant"],
                        "parts": s["parts"],
                        "partCount": len(s["parts"]),
                        "fileMib": file_mib,
                        "requiredMib": req,
                        "kvCacheMib": int((DEFAULT_CTX / 1024.0) * KV_MIB_PER_1K_CTX),
                        "contextTokens": DEFAULT_CTX,
                        "tier": tier,
                        # NEVER predicted -- only a real bench fills this in.
                        "tokensPerSecond": None,
                        "downloads": m.get("downloads"),
                        "gated": bool(m.get("gated")),
                        "installRef": "hf.co/%s:%s" % (repo, s["quant"]),
                        "sizeOnDiskMib": file_mib,
                        "trusted": trusted,
                        "trustReason": "allowlisted-publisher" if trusted else "unverified",
                        "installedAt": None,
                        "benchmarkedAt": None,
                        "notes": (
                            ["some layers stay on CPU at this VRAM -- slower, still usable"]
                            if tier == "partial"
                            else []
                        ),
                    }
                )
    models.sort(key=lambda m: (m["tier"] != "fits", not m["trusted"], -(m["downloads"] or 0)))
    return models, notes


def envelope(gpu, models, source, notes, stale=False):
    warn = list(notes)
    free = gpu.get("vramFreeMib")
    total = gpu.get("vramTotalMib")
    if free and total and free < total * 0.8:
        warn.append("%d MiB of VRAM is currently in use by another process" % (total - free))
    if gpu.get("cpuOnly"):
        warn.append("no GPU sized -- entries are filtered against system RAM and will be slow")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": source,
        "stale": stale,
        "host": {"gpu": gpu, "ramTotalMib": gpu.get("ramTotalMib")},
        "models": models,
        "warnings": warn,
    }


def read_gpu(path=None):
    if path:
        with open(path) as f:
            return json.load(f)
    out = subprocess.run(
        ["bash", os.path.join(HERE, "gpu-detect.sh")], capture_output=True, text=True, timeout=60
    )
    try:
        return json.loads(out.stdout)
    except Exception:
        # A detector that could not speak is NOT a machine without a GPU. Say cpuOnly with an
        # explicit detectedBy so the difference is visible downstream.
        return {"vendor": "none", "cpuOnly": True, "detectedBy": "detector-failed",
                "vramTotalMib": None, "vramFreeMib": None, "ramTotalMib": None}


def fallback(gpu, why):
    """A failed refresh serves the cache or the bundled copy WITH a staleness flag -- never an empty
    list. First-run on a machine with no internet must still offer something."""
    for path, src in ((CACHE, "cache"), (BUNDLED, "bundled-fallback")):
        try:
            with open(path) as f:
                d = json.load(f)
            return envelope(gpu, d.get("models", []), src, [why], stale=True)
        except Exception:
            continue
    return envelope(gpu, [], "none", [why, "no cache and no bundled catalogue available"], stale=True)


def main(argv):
    fixture = None
    gpu_path = None
    offline = "--offline" in argv
    if "--fixture" in argv:
        fixture = argv[argv.index("--fixture") + 1]
    if "--gpu" in argv:
        gpu_path = argv[argv.index("--gpu") + 1]
    gpu = read_gpu(gpu_path)

    if offline:
        print(json.dumps(fallback(gpu, "offline requested"), indent=2))
        return 0
    try:
        models, notes = build(gpu, fixture=fixture)
    except Exception as exc:
        print(json.dumps(fallback(gpu, "refresh failed: %s" % type(exc).__name__), indent=2))
        return 0
    if not models:
        print(json.dumps(fallback(gpu, "refresh returned no usable model"), indent=2))
        return 0
    env = envelope(gpu, models, "huggingface", notes)
    try:
        with open(CACHE, "w") as f:
            json.dump(env, f, indent=2)
    except Exception:
        env["warnings"].append("cache not writable")
    print(json.dumps(env, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

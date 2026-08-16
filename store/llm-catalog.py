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

# The HF repo-id shape: owner/name, each segment starting alnum, then alnum/dot/dash/underscore.
# `repo` comes RAW from the discovery API response and is embedded verbatim into `installRef`
# ("hf.co/%s:%s") -- which is written to the on-disk cache and read back in --offline mode without
# ever touching the network again, so a malformed value here survives past the moment it was fetched
# (Cybered LOW-1, card d7220a73). Checked at catalogue-build time; the consumer that turns installRef
# into an actual `ollama pull` re-checks the same shape before running it (src/web/routes/local-llm.ts).
HF_REPO_RX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")

# Ollama's public library is flat-namespaced (registry.ollama.ai/library/<name>/<tag>) -- no
# owner/name split the way an HF repo id has one. See OLLAMA_LIBRARY_PUBLISHERS below.
OLLAMA_LIBRARY_NAME_RX = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
OLLAMA_TAG_RX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


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


# Ascending quality, in the order GGUF quantisations are conventionally understood. Only used to
# break a tie BETWEEN QUANTS OF ONE REPO -- see the sort below for why that is the whole scope.
#
# THE IQ FAMILY IS IN HERE FOR A MEASURED REASON. The first version of this table listed only the
# classic Q/F names, and 24 of the 40 distinct quants in the live 435-model catalogue fell outside
# it -- IQ4_XS alone appears 15 times. Unranked entries sort last within their repo, so IQ4_XS (a
# Q4-class artefact) would have been offered BELOW Q2_K: the exact inversion this card exists to
# remove, reintroduced by an incomplete list. Measured before writing the table, not after.
QUANT_QUALITY = [
    "IQ1_S", "IQ1_M",
    "IQ2_XXS", "IQ2_XS", "IQ2_XS_H", "IQ2_S", "IQ2_M",
    "Q2_K", "Q2_K_L", "Q2_K_XL",
    "IQ3_XXS", "IQ3_XS", "IQ3_S", "IQ3_M",
    "Q3_K_S", "Q3_K", "Q3_K_M", "Q3_K_L", "Q3_K_XL",
    "IQ4_XS", "IQ4_NL", "IQ4_K_M",
    # The _4_4 / _4_8 / _8_8 suffixes are ARM-repacked Q4_0: same precision, different layout.
    "Q4_0", "Q4_0_4_4", "Q4_0_4_8", "Q4_0_8_8", "Q4_1",
    "Q4_K_S", "Q4_K", "Q4_K_M", "Q4_K_L",
    "Q5_0", "Q5_1", "Q5_K_S", "Q5_K", "Q5_K_M",
    "Q6_K", "Q8_0",
    "F16", "FP16", "BF16", "F32",
]


def quant_rank(quant):
    """Higher is better. An unrecognised quant ranks BELOW every known one (-1) rather than being
    guessed at: this decides which model an operator is offered first, and a quant nobody has
    characterised should not be promoted over one that has been. A catalogue containing one also
    carries a WARNING (see build below) -- ranking last silently is how an incomplete table hides."""
    try:
        return QUANT_QUALITY.index((quant or "").upper())
    except ValueError:
        return -1


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


# --- Ollama-library provenance (card bb919fae, MikroB/Peti decision 2026-08-16) --------------------
#
# HuggingFace is not the only reviewed source. Peti deliberately runs the fleet's draft/routing model,
# qwen2.5-coder:7b-instruct-q4_K_M, from Ollama's own official library (ollama.com/library) rather
# than hf.co -- a reputable, curated distribution channel this file simply never recognised. Before
# this the model showed owner=unverified with digest check not-possible: no catalogue entry existed
# for it at all, so a blob swapped on disk would go unnoticed (Cybersec residual finding, card
# d297f26f/eb843c46).
#
# EXPLICIT, REVIEWED, NOT DISCOVERED. The Ollama library has no owner/publisher field the way an HF
# repo id does (models are flat-namespaced under registry.ollama.ai/library/<name>), so "who actually
# publishes this" cannot be read off an API -- it is a human decision, same as every other entry in
# llm-catalog-trust.json. This table names ONLY the models the fleet actually installs through this
# channel; it is not a general Ollama-library scanner. Add an entry here (with a reason) the same way
# a new HF publisher gets added to trustedPublishers -- a security-relevant, reviewed change.
OLLAMA_LIBRARY_PUBLISHERS = {
    # Qwen (Alibaba) publishes qwen2.5-coder upstream; Ollama's library mirrors/hosts the GGUF build
    # under its own flat name. "qwen" is already a trustedPublisher (card 6f8f71fa's catalogue), so
    # naming the real publisher here REUSES that existing decision instead of inventing a new one.
    "qwen2.5-coder": "Qwen",
}


def ollama_blobs_dir():
    # Same env override + default as the TS consumer (src/web/routes/local-llm.ts OLLAMA_BLOBS_DIR /
    # store/first-run-llm.sh FIRST_RUN_BLOBS) -- one source of truth for where the blobs live.
    return os.environ.get("FIRST_RUN_BLOBS", os.path.join(os.path.expanduser("~"), ".ollama", "models", "blobs"))


def ollama_manifests_dir():
    # Sibling of the blobs dir under the same "models" parent -- .../models/blobs and
    # .../models/manifests/registry.ollama.ai/library are how ollama itself lays the tree out, so
    # deriving one from the other keeps a single override point (FIRST_RUN_BLOBS) instead of two.
    models_dir = os.path.dirname(ollama_blobs_dir())
    return os.path.join(models_dir, "manifests", "registry.ollama.ai", "library")


def ollama_tag_quant(tag):
    """The quant suffix of an Ollama tag, e.g. '7b-instruct-q4_K_M' -> 'Q4_K_M'. Reuses
    QUANT_QUALITY's own vocabulary (via quant_rank) so an ollama-sourced entry sorts and displays
    exactly like an hf.co one when its quant is recognised."""
    m = re.search(r"((?:IQ|Q)\d+[_A-Za-z0-9]*|f16|fp16|bf16)$", tag, re.I)
    return m.group(1).upper() if m else tag.upper()


def ollama_library_entries(trusted_pubs, gpu, fixture=None):
    """Catalogue entries for locally-installed Ollama-library models with a reviewed publisher
    (OLLAMA_LIBRARY_PUBLISHERS). Read straight from the on-disk manifest + blob store -- no network,
    no `ollama` CLI dependency -- so this works the same whether build() is online or was reached
    from --offline (retier() recomputes tier/requiredMib from the stored fileMib either way, exactly
    as it already does for hf.co entries).

    `fixture`, when given, reads from <fixture>/ollama/{manifests,blobs} instead of the real
    ~/.ollama tree -- same reason build()'s HF calls take a fixture dir: this file's own selftest is
    OFFLINE and deterministic by design, and reading the real host's Ollama install unconditionally
    would make every build() call in that suite depend on whatever happens to be installed on the
    machine running it."""
    entries = []
    if fixture is not None:
        manifests_root = os.path.join(fixture, "ollama", "manifests", "registry.ollama.ai", "library")
        blobs_dir = os.path.join(fixture, "ollama", "blobs")
    else:
        manifests_root = ollama_manifests_dir()
        blobs_dir = ollama_blobs_dir()
    for name, owner in OLLAMA_LIBRARY_PUBLISHERS.items():
        model_dir = os.path.join(manifests_root, name)
        if not os.path.isdir(model_dir):
            continue
        for tag in sorted(os.listdir(model_dir)):
            manifest_path = os.path.join(model_dir, tag)
            if not os.path.isfile(manifest_path):
                continue
            try:
                with open(manifest_path) as f:
                    manifest = json.load(f)
            except Exception:
                continue
            cfg = manifest.get("config") or {}
            layers = ([cfg] if cfg.get("digest") else []) + list(manifest.get("layers") or [])
            parts, total_bytes = [], 0
            for layer in layers:
                digest = str(layer.get("digest") or "")
                if not digest.startswith("sha256:"):
                    continue
                sha = digest.split(":", 1)[1]
                blob_path = os.path.join(blobs_dir, "sha256-" + sha)
                # A part not actually present on disk cannot be a verified part of THIS install, and
                # listing it would give the digest check something to fail on that was never real to
                # begin with -- dropped rather than recorded as missing.
                if not os.path.isfile(blob_path):
                    continue
                media = str(layer.get("mediaType") or "").rsplit(".", 1)[-1] or "blob"
                size = int(layer.get("size") or os.path.getsize(blob_path))
                parts.append({"path": media, "sizeMib": int(size / (1024 * 1024)), "sha256": sha})
                total_bytes += size
            if not parts:
                continue
            file_mib = int(total_bytes / (1024 * 1024))
            req = required_mib(file_mib)
            tier = tier_of(req, gpu.get("vramTotalMib"), gpu.get("ramTotalMib"), gpu.get("cpuOnly", True))
            # Same rule as the hf.co path: nothing offers a model this host cannot run.
            if tier == "too-big":
                continue
            quant = ollama_tag_quant(tag)
            trusted = owner.lower() in trusted_pubs
            entries.append(
                {
                    "id": "ollama-library_%s:%s" % (name, tag.lower()),
                    "repo": name,
                    "repoOwner": owner,
                    "displayName": "%s (%s, Ollama library)" % (name, tag),
                    "quant": quant,
                    "parts": parts,
                    "partCount": len(parts),
                    "pinned": all(p["sha256"] for p in parts),
                    "fileMib": file_mib,
                    "requiredMib": req,
                    "kvCacheMib": int((DEFAULT_CTX / 1024.0) * KV_MIB_PER_1K_CTX),
                    "contextTokens": DEFAULT_CTX,
                    "tier": tier,
                    "tokensPerSecond": None,  # NEVER predicted -- only a real bench fills this in.
                    "downloads": None,  # the Ollama library API does not expose this figure.
                    "gated": False,
                    "installRef": "%s:%s" % (name, tag),
                    "sizeOnDiskMib": file_mib,
                    "trusted": trusted,
                    "trustReason": "allowlisted-publisher" if trusted else "unverified",
                    "installedAt": None,
                    "benchmarkedAt": None,
                    "notes": [],
                    # Distinguishes this entry's shape from an hf.co one for validate() -- installRef
                    # has no "hf.co/" prefix and `repo` is flat (no owner/name slash).
                    "source": "ollama-library",
                }
            )
    return entries


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
            if not HF_REPO_RX.match(repo):
                notes.append("dropped catalogue entry with a malformed repo id: %r" % repo)
                continue
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
                        # DERIVED, not a principle left implicit: a set is pinned only when EVERY part
                        # carries a digest. A consumer that checked just parts[0] would look identical
                        # to one that checked them all when part 0 happens to be pinned and the rest
                        # are not (Cybered LOW-2, card d7220a73) -- this field is the one true answer,
                        # kept honest by validate() re-deriving and comparing it below.
                        "pinned": all(p["sha256"] for p in s["parts"]),
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
    # ORDER IS AN OFFER, not a listing: first-run-llm.sh prints models[:5] numbered for the operator
    # and retier() drops what does not fit on the reading host but never re-sorts, so position 1 is
    # what gets installed on a machine with no network.
    #
    # The last key is new (card 51ad7c7c). Without it the order was (fits, trusted, downloads) and
    # quantisation appeared nowhere, so the most DOWNLOADED quant of a model led -- which put
    # Qwen2.5-Coder-7B Q2_K, a weak coder, ahead of the same repo's Q4_0 on a host where both fit.
    # That contradicted the rule the catalogue work was written under: the better quantisation wins
    # over the more popular one.
    #
    # DELIBERATELY THE LAST KEY, so its effect is confined to a tie. `downloads` is a REPO-level
    # number -- every quant of one repo carries the same value -- so entries only reach this key when
    # they are the same repo at the same tier. Cross-repo ordering is therefore untouched: this does
    # not let a niche model outrank a popular one, it only picks the better artefact of the model
    # already chosen.
    #
    # Ollama-library entries are appended here, AFTER discovery/relevance filtering and BEFORE the
    # sort, so they participate in the same ordering as every hf.co entry (card bb919fae) instead of
    # being bolted on as a separate, unsorted list.
    models.extend(ollama_library_entries(trusted_pubs, gpu, fixture=fixture))
    models.sort(
        key=lambda m: (
            m["tier"] != "fits",
            not m["trusted"],
            -(m["downloads"] or 0),
            -quant_rank(m["quant"]),
        )
    )
    # An unranked quant sorts last within its repo, which is the safe default but an INVISIBLE one:
    # a table that has fallen behind the ecosystem looks exactly like a table that is complete. Say
    # it instead, so the gap is a line in the output rather than a quiet mis-ordering.
    unranked = sorted({m["quant"] for m in models if quant_rank(m["quant"]) < 0})
    if unranked:
        notes.append(
            "quantisations not in QUANT_QUALITY, ordered last within their repo: %s"
            % ", ".join(unranked)
        )
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


def retier(models, gpu):
    """Recompute the HOST-DEPENDENT fields of stored entries, and drop what cannot run here.

    A stored catalogue mixes two kinds of field. The FACTS -- repo, owner, quant, parts, digests,
    fileMib, downloads -- are true wherever the file is read. `requiredMib` and `tier` are not: they
    were computed against the VRAM of whatever machine produced the file. The bundled catalogue ships
    in the repo and is read on machines it has never seen, so serving its stored tiers would tell a
    6 GB card that a 12 GB model "fits" -- worse than no catalogue, because the fit filter is the
    entire point of this document.

    The cache goes through the same recompute rather than being trusted as-is: it was written on this
    machine, but a GPU can be added, removed or reassigned between two runs, and a stale "fits" reads
    exactly like a fresh one.
    """
    out = []
    for m in models:
        m = dict(m)
        file_mib = m.get("fileMib") or 0
        if file_mib > 0:
            m["requiredMib"] = required_mib(file_mib)
            m["tier"] = tier_of(
                m["requiredMib"], gpu.get("vramTotalMib"), gpu.get("ramTotalMib"), gpu.get("cpuOnly", True)
            )
        # Same rule as the live path: an entry that cannot run on this machine is not offered.
        if m.get("tier") == "too-big":
            continue
        out.append(m)
    return out


def fallback(gpu, why):
    """A failed refresh serves the cache or the bundled copy WITH a staleness flag -- never an empty
    list. First-run on a machine with no internet must still offer something."""
    for path, src in ((CACHE, "cache"), (BUNDLED, "bundled-fallback")):
        try:
            with open(path) as f:
                d = json.load(f)
        except Exception:
            continue
        models = retier(d.get("models", []), gpu)
        notes = [why]
        if not models:
            # An empty list HERE means something different from "no catalogue": every stored entry
            # was measured against this machine and none of them fits. Saying so is the honest
            # answer -- offering a model that cannot load would not help anyone.
            notes.append("no %s entry fits this machine (all above its memory)" % src)
        return envelope(gpu, models, src, notes, stale=True)
    return envelope(gpu, [], "none", [why, "no cache and no bundled catalogue available"], stale=True)


# --- the CONSUMER CONTRACT ---------------------------------------------------------------------
# T2 (the installer/first-run step) and T4 (the selector UI) both read this document. A schema is
# only a contract if something FAILS when it drifts, so this validator is the enforceable half and
# `--validate` is how a shell consumer checks a document before trusting it.
#
# It checks DERIVED facts, not just presence. `fileMib` being an integer proves nothing; `fileMib`
# equalling the sum of its parts is the property that was actually wrong once and shipped
# (a quant summed against itself, and before that sized by one shard of five).
REQUIRED_MODEL_FIELDS = (
    "id", "repo", "repoOwner", "quant", "parts", "partCount", "fileMib", "requiredMib",
    "kvCacheMib", "contextTokens", "tier", "tokensPerSecond", "installRef", "trusted",
    "trustReason", "installedAt", "benchmarkedAt", "pinned",
)


def validate(doc):
    """Return a list of contract violations. Empty list = usable by both consumers."""
    errs = []
    if not isinstance(doc, dict):
        return ["document is not an object"]
    v = doc.get("schemaVersion")
    if v != SCHEMA_VERSION:
        # A consumer that reads fields from a version it does not know is reading fields that may
        # have moved. Refusing is the only safe answer, so it is a hard error, not a warning.
        errs.append("unsupported schemaVersion %r (this build understands %d)" % (v, SCHEMA_VERSION))
    for key in ("generatedAt", "source", "models", "warnings", "host"):
        if key not in doc:
            errs.append("missing top-level '%s'" % key)
    for i, m in enumerate(doc.get("models") or []):
        where = "models[%d]" % i
        for f in REQUIRED_MODEL_FIELDS:
            if f not in m:
                errs.append("%s missing '%s'" % (where, f))
        if errs and any(e.startswith(where) for e in errs):
            continue
        parts = m.get("parts") or []
        if not parts:
            errs.append("%s has no parts" % where)
            continue
        if m.get("partCount") != len(parts):
            errs.append("%s partCount %r != len(parts) %d" % (where, m.get("partCount"), len(parts)))
        summed = sum(int(p.get("sizeMib") or 0) for p in parts)
        # Tolerate rounding across parts, nothing more. This is the check that would have caught
        # both shipped sizing defects.
        if abs(summed - int(m.get("fileMib") or 0)) > len(parts):
            errs.append("%s fileMib %r is not the sum of its parts (%d)" % (where, m.get("fileMib"), summed))
        if any(not p.get("sha256") for p in parts):
            errs.append("%s has a part with no sha256 -- the set is not pinned" % where)
        # `pinned` must be RE-DERIVED and compared, not merely present -- the same rule this file
        # already applies to fileMib (checked against the sum of its parts) and partCount (checked
        # against len(parts)). A stored boolean that drifts from its parts is worse than no field.
        if bool(m.get("pinned")) != all(p.get("sha256") for p in parts):
            errs.append("%s pinned=%r does not match whether every part has a sha256" % (where, m.get("pinned")))
        # Ollama-library entries (card bb919fae) have a DIFFERENT valid shape: a flat name (no
        # owner/name slash) and an installRef with no "hf.co/" prefix -- the library itself has no
        # such prefix. Checked as its own branch rather than loosening the hf.co rule, so a malformed
        # hf.co entry still fails exactly as before.
        ref = str(m.get("installRef") or "")
        repo = str(m.get("repo") or "")
        if m.get("source") == "ollama-library":
            if not OLLAMA_LIBRARY_NAME_RX.match(repo):
                errs.append("%s repo %r is not a valid Ollama-library name" % (where, repo))
            if ref.startswith("hf.co/") or ":" not in ref:
                errs.append("%s installRef %r is not a valid ollama-library reference" % (where, ref))
            else:
                name, _, tag = ref.partition(":")
                if name != repo or not OLLAMA_TAG_RX.match(tag):
                    errs.append("%s installRef %r does not match repo:tag shape" % (where, ref))
        else:
            if not HF_REPO_RX.match(repo):
                errs.append("%s repo %r is not a valid HF repo id" % (where, m.get("repo")))
            if not ref.startswith("hf.co/") or ":" not in ref:
                errs.append("%s installRef %r is not an installable reference" % (where, ref))
        if int(m.get("requiredMib") or 0) <= int(m.get("fileMib") or 0):
            errs.append("%s requiredMib must exceed fileMib (KV cache + overhead)" % where)
        if m.get("tier") not in ("fits", "partial"):
            errs.append("%s tier %r is not offerable" % (where, m.get("tier")))
        tps = m.get("tokensPerSecond")
        if tps is not None and not isinstance(tps, (int, float)):
            errs.append("%s tokensPerSecond must be null or a number" % where)
    return errs


def main(argv):
    if "--validate" in argv:
        target = argv[argv.index("--validate") + 1]
        try:
            with open(target) as f:
                doc = json.load(f)
        except Exception as exc:
            print("INVALID: cannot read %s (%s)" % (target, type(exc).__name__))
            return 1
        errs = validate(doc)
        if errs:
            print("INVALID: %d violation(s)" % len(errs))
            for e in errs[:20]:
                print("  " + e)
            return 1
        print("VALID: schemaVersion %d, %d model(s)" % (doc.get("schemaVersion"), len(doc.get("models") or [])))
        return 0
    return _main(argv)


def _main(argv):
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

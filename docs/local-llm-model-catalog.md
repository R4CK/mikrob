# Local-LLM model catalogue: GPU detection + HuggingFace selection

Design for card 9632b4d6 (EPIC ebc7b4dd, T1). Peti's directive, 2026-08-13: the installer must
**not** pre-install Ollama or pull a model. After boot/first-run the user picks a coding model from
a catalogue filtered to what their GPU can actually run, and starts the install themselves.

This document is the contract T2 (`fbbb4015`, installer rework) and T4 (`61a4a85f`, Fron Ted
selector UI) both build against. Everything below marked **measured** was run on this host on
2026-08-13; everything marked **assumption** is not, and says so.

---

## 0. What the measurements changed

Three things I intended to write are wrong, and the design below reflects the measurement instead:

1. **`nvidia-smi` is not on `PATH` on this host, and `lspci` is not installed at all.** A detector
   built on either would have failed on the very machine that motivated the card.
   **Measured:** the working binary is `/usr/lib/wsl/lib/nvidia-smi`, a WSL-only location.
2. **File size is not VRAM need.** A `fits if file_size <= VRAM` rule would promise fits that do not
   exist. **Measured earlier** (card 7041c165, 3 runs/point): qwen2.5-coder 7B q4_K_M — a ~4.4 GB
   file — never fully fits this 6144 MiB card; 16–27 % of layers stay on CPU even after KV-cache
   tuning. The catalogue must model KV cache and runtime overhead, not just the download.
3. **No downloader needs writing.** **Measured:** `ollama pull hf.co/<repo>:<QUANT>` resolves
   against HuggingFace directly — a bogus tag returns `400 The specified tag is not a valid
   quantization scheme`, i.e. the host and repo resolved and only the quant name was rejected. So
   "install the chosen model" is one existing command, not a GGUF fetch-and-assemble step (rule 10).

---

## 1. GPU / VRAM detection

### 1.1 Probe chain

Detection is an **ordered chain that stops at the first probe that yields a total-VRAM number**, not
a single command. Each probe is independently testable and each may legitimately be absent.

| # | Probe | Yields | Notes |
|---|---|---|---|
| 1 | `/usr/lib/wsl/lib/nvidia-smi` | name, total, free, driver | WSL2 + NVIDIA. **Measured here.** Not on `PATH` |
| 2 | `nvidia-smi` on `PATH` | same | native Linux + NVIDIA, and Windows |
| 3 | `rocm-smi --showmeminfo vram --json` | total, free | AMD ROCm. **Assumption** — no AMD host to test on |
| 4 | `system_profiler SPDisplaysDataType -json` | name, unified memory | macOS. **Assumption** — see §1.4 |
| 5 | `lspci -nn \| grep -i vga` | name only, **no VRAM** | last resort identification; cannot size a model |
| 6 | none of the above | CPU-only | a real, supported outcome — not an error |

`nvidia-smi` query used (**measured** output on this host):

```
$ /usr/lib/wsl/lib/nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version \
    --format=csv,noheader
NVIDIA GeForce GTX 1660 Ti, 6144 MiB, 4436 MiB, 610.88
```

### 1.2 Total vs free VRAM — both, for different jobs

The reading above shows 6144 MiB total but only 4436 MiB free, because Ollama already had a model
resident. The two numbers answer different questions and the catalogue keeps both:

- **total** decides *capability* — what this machine can ever run. Filtering the catalogue on `free`
  would hide models from a user merely because something was loaded at that moment, and the list
  would change between two page loads.
- **free** decides *right now* — it drives a warning ("2.1 GB is currently in use by another model"),
  never the filter.

### 1.3 CPU-only is a supported outcome, not a failure

If no probe yields VRAM, the catalogue is still produced, filtered against **system RAM** with a
much more conservative headroom, and every entry is flagged `cpuOnly: true`. A first-run wizard that
dead-ends on a machine without a GPU would be worse than one that offers a slow-but-working 3B.

### 1.4 What is not verifiable here

Probes 3 and 4 are written from documentation, not run. Neither an AMD nor an Apple host is
available to me. They must be marked as unverified in T2's acceptance criteria, and the chain must
**fail soft**: an unrecognised probe output yields "no VRAM number", which falls through to the next
probe, never a crash or a fabricated number.

---

## 2. HuggingFace catalogue

### 2.1 Two calls, both verified live

**Discovery** (**measured**, HTTP 200 in 0.19 s):

```
GET https://huggingface.co/api/models?filter=gguf&search=coder&sort=downloads&direction=-1&limit=N
-> [{ id, downloads, tags, ... }]
```

**Sizing** — the API that makes VRAM filtering possible at all (**measured**, 29 GGUF entries for
one repo):

```
GET https://huggingface.co/api/models/<repo>/tree/main?recursive=true
-> [{ path: "...-IQ2_M.gguf", size|lfs.size: 12066000000 }, ...]
```

Per-quantisation file sizes come from the tree call; the discovery call alone cannot size anything.

### 2.2 Candidate filtering, and why the query alone is not enough

`search=coder` is a **string match on the model id**, so it is a starting point, not a definition of
"coding model". The top results measured today include several 30B+ MoE models that no 6 GB card can
run, and the ranking is by downloads, which tracks popularity rather than fitness.

The catalogue therefore applies, in order:

1. `gguf` in tags (the runtime can consume it)
2. not `gated` and not `private` — a gated repo needs a token the first-run flow does not have
3. at least one `.gguf` file whose computed requirement fits the tier rules in §3
4. coding relevance: id or tags matching `coder|code|starcoder|deepseek|qwen.*coder`, **plus** an
   explicit curated allowlist of families known to be instruction-tuned for code

Point 4 is deliberately hybrid. A pure keyword rule mislabels; a pure allowlist goes stale the week
a new family lands. The allowlist lives in the catalogue config, not in code, so refreshing it is a
data edit that T2 and T4 pick up without a release.

### 2.3 Rate limits and offline

Unauthenticated HF API calls are rate-limited (**assumption** — I did not probe the limit, and
probing it means deliberately tripping it). The generator therefore: caches the produced catalogue
JSON on disk, ships a **bundled fallback catalogue** in the repo, and treats a failed refresh as
"serve the cached/bundled copy plus a staleness timestamp", never an empty list. First-run on a
machine with no internet must still offer something.

---

## 3. The fit rule

### 3.1 Requirement, not file size

```
required_mib = file_mib
             + kv_cache_mib(ctx, kv_quant)
             + runtime_overhead_mib      (~600, weights-load scratch + compute buffers)
```

`kv_cache_mib` is measurable per model rather than guessable: **measured** on qwen2.5-coder 7B with
`OLLAMA_FLASH_ATTENTION=1` + `OLLAMA_KV_CACHE_TYPE=q8_0`, the KV cache was 119 MiB at ctx 4096,
476 MiB at 16384 and 714 MiB at 24576 — roughly linear in context, and halved by q8_0 versus f16.

### 3.2 Three tiers, because "fits / does not fit" is a lie

| Tier | Rule | Meaning for the user |
|---|---|---|
| `fits` | `required <= vram_total * 0.90` | fully GPU-resident, fastest |
| `partial` | `required <= vram_total * 0.90 + ram_headroom` | runs, some layers on CPU, slower |
| `too-big` | otherwise | not offered |

The `partial` tier exists because of the measurement in §0.2: this host's daily driver **is** a
partial-offload model, at a perfectly usable 27–32 tok/s. A binary filter would have hidden the one
model the fleet actually uses. `partial` entries carry an explicit expected-slowdown note.

### 3.3 The number that must not be invented

`tokensPerSecond` is **not** predicted. The catalogue carries it only when it was actually measured
on this hardware class (`store/local-llm-bench.sh` produces it), and `null` otherwise. A guessed
throughput shown next to a real one is indistinguishable from it in the UI.

---

## 3.4 A quant is a FILE SET, not a file (defect found in this design, 2026-08-13)

The fit rule above says "at least one `.gguf` file whose computed requirement fits". **That is
wrong for any model published in shards, and it fails in the dangerous direction.** Measured on
`Qwen/Qwen2.5-Coder-7B-Instruct-GGUF`:

| quant | parts | total | part 1 alone |
|---|---|---|---|
| fp16 | 5 | **30.48 GB** | 3.95 GB |
| q8_0 | 4 | 16.20 GB | 3.98 GB |
| q6_k | 3 | 12.51 GB | 3.95 GB |

Taking a single file's size would size the 30 GB fp16 model at 3.95 GB and mark it **`fits` on a
6 GB card** -- exactly the promise the three-tier rule exists to prevent, produced by the rule
itself. The trap is that every shard is ~4 GB, so the wrong number looks precisely like a genuine
7B q4 file: nothing about it reads as wrong.

**Rule:** group `.gguf` entries by stripping the `-NNNNN-of-NNNNN` shard suffix, and size the
QUANT SET (`sum(lfs.size)` over its parts). `fileMib` is the set total; `parts` and `partCount`
belong in the schema so a consumer can show "5 files, 30.5 GB" instead of one misleading number.

---

## 3.5 Trust is a separate axis from fit and relevance (Cybered, card 87d7c86f)

The catalogue as designed models **fit** (VRAM) and **relevance** (is it a coding model). It does
not model **trust** -- and the installed weights become the fleet's code-suggesting oracle, so a
backdoored model is a supply-chain attack that arrives through agent integration. Three
requirements, all closed before T2 starts:

**(1) Provenance in the schema.** The tree call already in use carries it -- no extra request:

```
GET /api/models/<repo>/tree/main?recursive=true
-> { path, size, oid, xetHash, lfs: { oid: "<64-hex sha256>", size, pointerSize } }
```

**Measured:** `lfs.oid` is a sha256 per file. Record it **per part** (see 3.4 -- a sharded quant has
one digest per shard, and a set is only pinned when all of them are), plus `repoOwner` from the
model API's `author` field (**measured**: `author: "Qwen"`).

**(2) Trust allowlist separate from the relevance allowlist.** 2.2's curated list answers "is this
a coding model" and must stay easy to refresh -- a data edit, no release. Trust answers a different
question, "may this be INSTALLED", and must not inherit that looseness. Two lists, two lifetimes,
two review bars. Anything outside the trust list installs only on **explicit operator confirmation**,
and the confirmation prompt must show what the decision rests on: repo owner, download count, and
the digest. A confirmation that shows only a name is a click-through, not a decision.

**(3) A new model never becomes the default silently.** Installing must not write
`store/local-llm-model` as a side effect. That write is its own explicit, logged step, and a
freshly installed model carries `trusted: false` until it has been benchmarked
(`store/local-llm-bench.sh`) -- because "it downloaded" is not evidence that it produces usable code.
The catalogue therefore also carries `installedAt` and `benchmarkedAt`, and the UI must distinguish
*installed* from *in use*.

Schema additions for all of the above:

```jsonc
{
  "quant": "Q4_K_M",
  "parts": [
    { "path": "...-00001-of-00003.gguf", "sizeMib": 3768, "sha256": "2da8da61..." }
  ],
  "partCount": 3,
  "fileMib": 10390,          // SUM over parts -- never one part
  "repoOwner": "Qwen",
  "trusted": true,           // from the TRUST list, not the relevance list
  "trustReason": "allowlisted-publisher",   // or "operator-confirmed" / "unverified"
  "installedAt": null,
  "benchmarkedAt": null
}
```

---

## 4. The shared data structure

One versioned JSON document, written by the generator, read by **both** consumers. Bash (T2) reads
it with `python3 -c`; the UI (T4) gets it from a dashboard endpoint.

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-13T19:20:00Z",
  "source": "huggingface",         // or "bundled-fallback" / "cache"
  "stale": false,
  "host": {
    "gpu": {
      "vendor": "nvidia",          // nvidia | amd | apple | none
      "name": "NVIDIA GeForce GTX 1660 Ti",
      "vramTotalMib": 6144,
      "vramFreeMib": 4436,
      "driver": "610.88",
      "detectedBy": "wsl-nvidia-smi",   // which probe answered -- diagnosable
      "cpuOnly": false
    },
    "ramTotalMib": 24576
  },
  "models": [
    {
      "id": "qwen2.5-coder-7b-instruct-q4km",     // stable key for the UI
      "repo": "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
      "displayName": "Qwen2.5 Coder 7B Instruct",
      "family": "qwen2.5-coder",
      "params": "7B",
      "quant": "Q4_K_M",
      "fileMib": 4480,
      "requiredMib": 5199,          // fileMib + kvCacheMib + overhead
      "kvCacheMib": 119,            // at contextTokens, with the assumed kv quant
      "contextTokens": 4096,
      "tier": "partial",            // fits | partial
      "tokensPerSecond": 31.7,      // measured, or null -- never predicted
      "downloads": 1234567,
      "gated": false,
      "installRef": "hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M",
      "sizeOnDiskMib": 4480,
      "notes": ["~16-27% of layers stay on CPU on a 6 GiB card"]
    }
  ],
  "warnings": ["2.1 GB of VRAM is currently in use by another model"]
}
```

Field notes that exist for a reason:

- **`installRef`** is the whole point of the structure. T2 never parses a repo id or builds a URL; it
  runs `ollama pull "$installRef"`. If the runtime is ever swapped, this one field changes shape and
  both consumers keep working.
- **`detectedBy`** turns "it says CPU-only and I have a GPU" from a mystery into one grep.
- **`tier` + `notes`** carry the honesty of §3.2 into the UI, so T4 shows *why* a model is slower
  rather than silently ranking it lower.
- **`tokensPerSecond: null`** is meaningful and must render as "not measured", never as 0.
- **`schemaVersion`** so T2 and T4 can refuse a document they do not understand instead of reading
  fields that moved.

---

## 5. Model-agnostic seam (the EPIC's hard requirement)

The EPIC requires the agent↔local-LLM flow to work with **whatever** model the user picked. That
seam already exists and must be the only thing selection writes to:

- `store/local-llm-model` — a one-line file, today `qwen2.5-coder:7b-instruct-q4_K_M`
- read by **four** places: `store/local-llm.sh`, `store/local-llm-bench.sh`,
  `src/web/routes/local-llm.ts` and `store/quota-bridge.py`

  **Corrected 2026-08-13 by card 87e0e197 (T3).** This originally said "exactly three places
  (measured)". The measurement behind it was a grep restricted to `--include="*.sh" --include="*.ts"`,
  so it could not see the Python reader. A file-type-filtered grep answers only for those file
  types, and "exactly N" is precisely the claim such a filter breaks silently. T3 also found that
  the fallbacks in those readers **disagree** (`local-llm.sh` falls back to the non-coder
  `qwen2.5:7b`), and that `nomic-embed-text` is a second, separate hardcoded model dependency for
  memory embeddings — see `docs/local-llm-model-agnostic-routing.md` §A.

So "apply the user's choice" = write the chosen `installRef` (or its local tag) to that file. No
call site learns a new model name, and nothing in the dispatch path hardcodes one.

**Related constraint that must not be lost in T2:** the GPU serialisation `flock` currently wraps
Ollama's `/api/generate` call inside `store/local-llm.sh`. Peti's 2026-08-06 requirement is that the
dxgkrnl crash guard stay backend-agnostic. If T2 makes the runtime pluggable, the lock has to move
with the seam, not stay bound to Ollama's API shape.

---

## 6. Open questions for T2/T4 (stated, not silently assumed)

1. **Runtime installation.** The catalogue is runtime-agnostic, but *something* must run the model.
   If Ollama is no longer pre-installed, first-run has to offer to install it (or an alternative)
   before any model pull. The EPIC removes the automatic install; it does not say the runtime is
   never installed. **Needs Peti's or MikroB's call** — it changes T2's shape.
2. **Where first-run lives.** Dashboard panel, installer post-step, or both. T4 assumes a UI; T2
   assumes a shell step. They must agree on one trigger, or a user meets the wizard twice.
3. **Disk budget.** Model files land on `/` (**measured** earlier: ~933 GB free), not `/mnt/h` (94 %
   full). The catalogue should still show `sizeOnDiskMib` and check free space before a pull.
4. **AMD/Apple probes are unverified** (§1.4) and need a host or an explicit "not supported yet".

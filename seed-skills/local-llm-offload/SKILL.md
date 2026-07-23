---
name: local-llm-offload
description: Offload a cheap, FUZZY, well-scoped sub-task to the LOCAL GPU-hosted LLM (Ollama on the WSL GTX 1660 Ti) instead of burning online Anthropic tokens. Use for short summaries, classification/triage, rewrite/reformat, dedup, i18n draft strings. NOT for deterministic transforms (escaping/regex/arithmetic -> use code), high-stakes reasoning, security gates, or unreviewed shipping output. Triggers: "reformat", "classify/triage", "dedupe these", "quick summary", "rewrite this", "save tokens", "lokalis modell", "offload".
---

# Local LLM offload

## When to use
Any fleet agent can hand a **bounded, low-stakes** sub-task to the locally-hosted
model to avoid spending online quota. Good fits:
- Reformatting or restructuring text (not generating new logic)
- Email / message / log triage + classification
- Deduplicating or clustering a short list
- Short factual summaries of text you already have
- Draft i18n strings / boilerplate copy (still reviewed before ship)

**Do NOT** offload: security-gate judgements, code correctness decisions,
anything that ships to prod unreviewed, or reasoning where a wrong answer is
costly. Treat output as a first-draft from a junior, and verify anything that matters.

**Do NOT** use the LLM for DETERMINISTIC transforms (MarkdownV2/JSON escaping,
regex, arithmetic, sorting): a small model gets these subtly wrong (validated:
the 3B mis-escaped MarkdownV2). Use code for those (e.g. the `fleet-helper`
Python escaper). The local model is for FUZZY bounded work: summarize, classify,
triage, rewrite, draft — where "roughly right" is acceptable and then reviewed.

**One model** (Peti 2026-07-19: a single local LLM, coding-focused). It is
`qwen2.5-coder:7b-instruct-q4_K_M` (in `store/local-llm-model`), fits the 6GB GPU
(4.7GB Q4), ~15s. Serves everything: code snippets, fuzzy offload, and Ghost
comms. Chosen from research (best code model in the ≤7B / 6GB tier, 2026) +
validated (wrote a correct keyset-pagination fn in 15s where Ornith-9B rambled
100s with no code). Ornith-9B and the 3B were deleted.
- Best at: isolated, well-specified CODE snippets (a function/regex/test/transform),
  and English/structured offload. It has NO tools/codebase access, so it CANNOT
  carry a real multi-file card — output is DRAFT, re-checked by MikroB + gates
  ([[local-llm-work-must-be-rechecked]]).
- Weaker at: Hungarian free-form conversation (coder-model tradeoff). Acceptable
  for the degraded Ghost fallback, but do not expect fluent HU prose from it.

## Procedure
The shared client is `store/local-llm.sh` (in the marveen repo root). It reads the
**active model** from `store/local-llm-model` at call time, so the model is
swappable centrally.

```bash
# simplest: prompt as arg or stdin
store/local-llm.sh "Classify this message as spam/promo/personal/work"
echo "long text..." | store/local-llm.sh --task summarize

# named task templates live in store/local-llm-skills/<task>.txt ({{INPUT}} placeholder)
store/local-llm.sh --task escape  "raw (text) with #chars."
store/local-llm.sh --task triage  "Subject: You won a prize! Click here"

# health / available models
store/local-llm.sh --health
store/local-llm.sh --list
```

Adding a new "skill" for the local model = drop a `store/local-llm-skills/<name>.txt`
file: everything before a lone `---` line is the system prompt, everything after is
the user template (with `{{INPUT}}` replaced by the caller's input).

## Offloading WITH context + memory (RAG) -- PREFERRED for fleet tasks
`store/local-llm.sh` is a bare client: it sends only your prompt, the model has
NO memory of the project or the agent. Peti's rule: an offloaded task must carry
the **proper context + the relevant memory chunks**. Use the RAG wrapper
`store/local-llm-rag.sh` instead of the bare client whenever the task needs
project/agent knowledge. It retrieves the most-relevant memories (dashboard
memory API, salience-ranked; multi-term recall so a natural-language task still
matches), prepends them + any inline context, then calls `local-llm.sh`.

```bash
# a fleet agent offloads a bounded task WITH its own memory scope + inline context
store/local-llm-rag.sh --agent backend \
  --context "file: apps/api/src/customers-read.ts; tenant-scope by ctx.tenantId" \
  "Draft a 1-line JSDoc for the listCustomers read port"

# focus the retrieval with --query (keywords beat the full task string; the q=
# search NARROWS as terms are added, so short salient keywords recall best)
store/local-llm-rag.sh --agent qa --query "touch target rule 13 mobile" \
  "Summarize our rule-13 QA-fail pattern in 2 sentences"

# inspect what memory would be attached WITHOUT calling the model
store/local-llm-rag.sh --agent mikrob --query "calendar sync" --show-context "..."
```
Flags: `--agent <id>` (memory scope, default mikrob), `--k <N>` (top-N memories,
default 5), `--query <kw>` (retrieval query, default = task text), `--context
"..."` (inline context), `--no-shared` (skip cross-agent shared tier),
`--show-context` (print assembled context, no model call). Passes `--task`,
`--system`, `--model` through to `local-llm.sh`. The shared tier is included by
default so a fleet agent also gets cross-agent context ([[fleet-agents-memory-read-model]]).
Output is still DRAFT and re-checked ([[local-llm-work-must-be-rechecked]]).

## Updating / swapping the model
The model must stay updatable (Peti requirement). To change or refresh it:
```bash
ollama pull <model>                 # download / update (e.g. qwen2.5:3b-instruct-q4_K_M)
echo "<model>" > store/local-llm-model   # point the fleet at it (one line)
```
GGUF models from HuggingFace pull directly: `ollama pull hf.co/<user>/<repo-GGUF>`.
On the GTX 1660 Ti (6GB VRAM, ~5GB usable) keep the resident model <=5GB to stay
fully on GPU: a 3B at Q4 fits with room; a 7B is tight; a 9B (~5.6GB) partially
spills to CPU (much slower). Requires Ollama >= ~0.10 for newer archs (Ornith-9B
needs the `qwen35` arch; 0.5.13 could not load it — we run 0.32.1).

## Pitfalls
- Exit codes: 2 = Ollama down (`systemctl --user start ollama`), 3 = model not
  pulled (`ollama pull <model>`), 4 = bad usage, 5 = API error/timeout. Check
  `$?` and fall back to doing the task yourself if the local model is unavailable
  (fail-open to the online path, never block the fleet on it).
- Only one model is resident in VRAM at a time; first call after idle reloads it
  (a few seconds). Default keep-alive is 5m.
- The model is small: for anything requiring judgement, review its output. Never
  let local-model output pass a gate or ship unverified.

## Validation
- `store/local-llm.sh --health` prints `ollama: UP` and whether the active model
  is present locally.
- A round-trip: `store/local-llm.sh "Reply with just the word: ok"` returns `ok`.

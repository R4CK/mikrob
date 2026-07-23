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
`qwen2.5-coder:7b-instruct-q4_K_M` (in `/home/neon/marveen/store/local-llm-model`), fits the 6GB GPU
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
The shared client is `/home/neon/marveen/store/local-llm.sh`. It reads the
**active model** from `/home/neon/marveen/store/local-llm-model` at call time, so the model is
swappable centrally.

**ALWAYS call by ABSOLUTE path** (as shown). Fleet agents run from their own
working dir (e.g. `/mnt/h/LM_Studio_Workdir/CleanCore`), NOT the marveen repo, so
a relative `store/local-llm.sh` would be "file not found". The absolute path works
from any cwd (both scripts resolve their own directory for the token + model).
Verified: both `local-llm.sh` and `local-llm-rag.sh` run correctly from the
CleanCore working dir.

```bash
# simplest: prompt as arg or stdin
/home/neon/marveen/store/local-llm.sh "Classify this message as spam/promo/personal/work"
echo "long text..." | /home/neon/marveen/store/local-llm.sh --task summarize

# named task templates live in /home/neon/marveen/store/local-llm-skills/<task>.txt ({{INPUT}} placeholder)
/home/neon/marveen/store/local-llm.sh --task escape  "raw (text) with #chars."
/home/neon/marveen/store/local-llm.sh --task triage  "Subject: You won a prize! Click here"

# health / available models
/home/neon/marveen/store/local-llm.sh --health
/home/neon/marveen/store/local-llm.sh --list
```

Adding a new "skill" for the local model = drop a `/home/neon/marveen/store/local-llm-skills/<name>.txt`
file: everything before a lone `---` line is the system prompt, everything after is
the user template (with `{{INPUT}}` replaced by the caller's input).

## Offloading WITH context + memory (RAG) -- PREFERRED for fleet tasks
`/home/neon/marveen/store/local-llm.sh` is a bare client: it sends only your prompt, the model has
NO memory of the project or the agent. Peti's rule: an offloaded task must carry
the **proper context + the relevant memory chunks**. Use the RAG wrapper
`/home/neon/marveen/store/local-llm-rag.sh` instead of the bare client whenever the task needs
project/agent knowledge. It retrieves the most-relevant memories (dashboard
memory API, salience-ranked; multi-term recall so a natural-language task still
matches), prepends them + any inline context, then calls `local-llm.sh`.

```bash
# a fleet agent offloads a bounded task WITH its own memory scope + inline context
/home/neon/marveen/store/local-llm-rag.sh --agent backend \
  --context "file: apps/api/src/customers-read.ts; tenant-scope by ctx.tenantId" \
  "Draft a 1-line JSDoc for the listCustomers read port"

# focus the retrieval with --query (keywords beat the full task string; the q=
# search NARROWS as terms are added, so short salient keywords recall best)
/home/neon/marveen/store/local-llm-rag.sh --agent qa --query "touch target rule 13 mobile" \
  "Summarize our rule-13 QA-fail pattern in 2 sentences"

# inspect what memory would be attached WITHOUT calling the model
/home/neon/marveen/store/local-llm-rag.sh --agent mikrob --query "calendar sync" --show-context "..."
```
Flags: `--agent <id>` (memory scope, default mikrob), `--k <N>` (top-N memories,
default 5), `--query <kw>` (retrieval query, default = task text), `--context
"..."` (inline context), `--no-shared` (skip cross-agent shared tier),
`--show-context` (print assembled context, no model call). Passes `--task`,
`--system`, `--model` through to `local-llm.sh`. The shared tier is included by
default so a fleet agent also gets cross-agent context ([[fleet-agents-memory-read-model]]).
Output is still DRAFT and re-checked ([[local-llm-work-must-be-rechecked]]).

## PROACTIVELY offload -- don't wait to be told (Peti 2026-07-23)
The local model exists to SAVE Claude tokens. By DEFAULT, offload the genuinely
mechanical, low-value sub-steps of your task instead of writing them inline -- you
do NOT need MikroB to tell you each time. Reach for it whenever you hit one of:
a test scaffold, boilerplate, an enum/type union, a regex, a pure-function body
from an exact spec, a data-shape transform, or a summary/triage of text you have.
Then review + integrate the draft (it stays draft-only, you own correctness).
Keep judgment: if the sub-task is subtle, security-sensitive, or you'd spend more
time reviewing than writing it, do it inline. But the mechanical bits -> offload.
A completed task with zero offload of its boilerplate is a missed token saving.
Usage is metered (dashboard "Használat"); `--caller <youragent>` attributes it.

**AGGRESSIVE by default (Peti 2026-07-23): push volume + size, tolerate ≤20% draft failure.**
Being too conservative (offloading one tiny enum) wastes the model's headroom. Per card,
offload MANY units and BIGGER ones — every validator, WHOLE test files, type/DTO sets,
docstrings, i18n draft strings, data transforms, isolated functions — aim for several
calls, not one. A draft that's wrong ~1 in 5 is FINE: discard it and write that one by
hand; the token saving on the other 4 still wins. TUNE per task-type, not globally: if a
specific TYPE fails >20% (e.g. the model keeps botching complex async logic), pull that
type back and keep pushing the types it nails (tests/validators/types/regex/transforms/
enums/boilerplate). The ONLY hard exclusions stay: decision/authz/isolation/architecture/
multi-file-wiring logic — those are net-negative to offload. Everything mechanical: offload.

## Coding offload -- give the local model CODE tasks (Peti 2026-07-23)
The active model is `qwen2.5-coder:7b`, a CODE model: it writes correct isolated
snippets fast (verified: a generic `chunk<T>`, a length-prefixed `compositeKey`
matching our convention). Offload MECHANICAL, self-contained coding to it and save
Claude tokens -- then review + integrate the output yourself.

GOOD coding-offload fits (fully specifiable, single unit):
- A pure function / helper from an exact signature + constraints.
- A regex, a data transform, a type/interface, a small algorithm.
- A unit-test scaffold for a given function.
- A boilerplate conversion (one shape -> another).

NOT for offload: multi-file changes, architecture, anything needing to READ the
codebase (the model has NO tools/repo access), security-sensitive logic, or a
whole card. It only sees what you put in the prompt.

HOW (the model is blind to the repo -- you must hand it everything):
1. Use `--task code` (system prompt: senior engineer, output only code).
2. Give the EXACT contract: signature, param/return types, constraints, edge cases,
   and "return only the function/code".
3. Paste any needed context -- types, a convention, an example -- via `--context`
   (or use `local-llm-rag.sh` so project conventions come from memory too).

```bash
# self-contained function from a precise spec
/home/neon/marveen/store/local-llm.sh --task code \
  "TypeScript: function chunk<T>(arr: T[], size: number): T[][] -- split into chunks of size, throw RangeError if size<1. Return only the function."

# coding WITH a project convention pulled from memory + inline context
/home/neon/marveen/store/local-llm-rag.sh --task code --agent backend \
  --context "types: interface Shift { id: string; tenantId: string; startMinute: number }" \
  "TS: function shiftKey(s: Shift): string -- length-prefixed cc:<len>:<tenantId>:<len>:<id>. Return only the function."
```

OUTPUT HANDLING (mandatory):
- The model often wraps code in ```fences -- STRIP them before use.
- The output is a DRAFT from a junior: you READ it, integrate it, then run
  `tsc --noEmit` + lint + the tests. Never paste it blind into a card.
- It stays draft-only and is re-checked by MikroB + gates
  ([[local-llm-work-must-be-rechecked]]). It cannot self-close a card.

## Updating / swapping the model
The model must stay updatable (Peti requirement). To change or refresh it:
```bash
ollama pull <model>                 # download / update (e.g. qwen2.5:3b-instruct-q4_K_M)
echo "<model>" > /home/neon/marveen/store/local-llm-model   # point the fleet at it (one line)
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
- `/home/neon/marveen/store/local-llm.sh --health` prints `ollama: UP` and whether the active model
  is present locally.
- A round-trip: `/home/neon/marveen/store/local-llm.sh "Reply with just the word: ok"` returns `ok`.

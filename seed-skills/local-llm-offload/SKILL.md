---
name: local-llm-offload
description: Offload a cheap, well-scoped sub-task -- fuzzy through MEDIUM-stakes -- to the LOCAL GPU-hosted LLM (Ollama on the WSL GTX 1660 Ti) instead of burning online Anthropic tokens. Use for short summaries, classification/triage, rewrite/reformat, dedup, i18n draft strings, AND medium-complexity code (functions, tests, small multi-step logic) -- verification is the agent's job either way, so draft-then-review scales past trivial snippets. NOT for deterministic transforms (escaping/regex/arithmetic -> use code), security-gate judgements, or unreviewed shipping output. After 3 failed attempts on the same task, stop retrying locally and hand it to an online agent. USE IT YOURSELF, UNPROMPTED, WHILE WORKING -- not only when a dispatcher hands you a draft: whenever your own card needs a new test file, an i18n draft, a small helper, or CRUD boilerplate, try the local model FIRST and review the result, instead of writing it online. Triggers: "reformat", "classify/triage", "dedupe these", "quick summary", "rewrite this", "save tokens", "lokalis modell", "offload".
---

# Local LLM offload

## When to use (ceiling raised 2026-08-03, Peti: verification is the agent's job either way)
Any fleet agent can hand a **bounded** sub-task to the locally-hosted model to
avoid spending online quota -- fuzzy/low-stakes THROUGH medium-stakes, not just
the trivial end. Good fits:
- Reformatting or restructuring text (not generating new logic)
- Email / message / log triage + classification
- Deduplicating or clustering a short list
- Short factual summaries of text you already have
- Draft i18n strings / boilerplate copy (still reviewed before ship)
- MEDIUM-complexity code: a full function/class method from a clear spec, a
  test suite for an already-defined interface, a multi-step (but single-file,
  single-concern) transform -- not just one-liners. The output is still a
  DRAFT the agent reviews and integrates; since review already happens either
  way, there is no reason to cap the model at toy-sized snippets.

**Do NOT** offload: security-gate judgements, architecture/multi-file wiring
decisions, or anything that ships to prod unreviewed. Treat output as a
first-draft from a junior, and verify anything that matters -- but "the review
step exists" is exactly why medium-stakes work is now in scope, not out of it.

**3-strikes escalation (Peti 2026-08-03):** if the local model fails the SAME
task 3 times (wrong output, refuses, or the draft fails review 3 times running),
STOP retrying it locally -- hand that one task to an online agent instead. Do
not burn a 4th+ local attempt on a task the model has already shown it can't do;
the point is to save tokens, not to spend agent time re-prompting a stuck model.

**Do NOT** use the LLM for DETERMINISTIC transforms (MarkdownV2/JSON escaping,
regex, arithmetic, sorting): a small model gets these subtly wrong (validated:
the 3B mis-escaped MarkdownV2). Use code for those (e.g. the `fleet-helper`
Python escaper). The local model is for FUZZY bounded work: summarize, classify,
triage, rewrite, draft — where "roughly right" is acceptable and then reviewed.

**One model** (Peti 2026-07-19: a single local LLM, coding-focused). It is
`qwen2.5-coder:7b-instruct-q4_K_M` (in `{{INSTALL_DIR}}/store/local-llm-model`), fits the 6GB GPU
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

## Reach for it MID-WORK, on your own initiative (card a717d8b5, Peti 2026-08-07)

The dispatcher drafts a bounded set of sub-tasks when a card opens. That one-shot pass is a floor,
not a quota -- the volume Peti asked for comes from agents asking for more *while they work*.

So when you are part-way through a card and the next unit is self-contained, send it locally first:

```bash
{{INSTALL_DIR}}/store/local-llm-rag.sh --task code --caller <your-agent-id> \
  --context "<the surrounding types/signatures the model needs>" \
  "write a vitest file for parseWindow covering the default-window branch; return only the code"
```

Good mid-work candidates (all route LOCAL today at aggressiveness 100 -- measured, not assumed):
- a whole new test file for a function whose signature you already have
- an i18n draft file for one locale from an existing key list
- a small helper function from an exact spec
- read-only CRUD boilerplate for a store you have already designed

Still ONLINE, and the router enforces it: authz, tenant isolation, architecture, multi-file wiring,
security decisions. Those come back `route: online` with the category named -- if you see that, do
not argue with it, write it yourself.

The result is a DRAFT. Read it, run the typecheck and the tests, and own the correctness. Three
failed local attempts on the same unit means stop and write it online.

## Procedure
The shared client is `{{INSTALL_DIR}}/store/local-llm.sh`. It reads the
**active model** from `{{INSTALL_DIR}}/store/local-llm-model` at call time, so the model is
swappable centrally.

**ALWAYS call by ABSOLUTE path** (as shown). Fleet agents run from their own
working dir (their OWN CleanCore worktree -- resolve it with
`{{INSTALL_DIR}}/store/agent-worktree.sh <agent> --path`, card 973ed6eb), NOT the marveen repo, so
a relative `store/local-llm.sh` would be "file not found". The absolute path works
from any cwd (both scripts resolve their own directory for the token + model).
Verified: both `local-llm.sh` and `local-llm-rag.sh` run correctly from the
CleanCore working dir.

```bash
# simplest: prompt as arg or stdin
{{INSTALL_DIR}}/store/local-llm.sh "Classify this message as spam/promo/personal/work"
echo "long text..." | {{INSTALL_DIR}}/store/local-llm.sh --task summarize

# named task templates live in {{INSTALL_DIR}}/store/local-llm-skills/<task>.txt ({{INPUT}} placeholder)
{{INSTALL_DIR}}/store/local-llm.sh --task escape  "raw (text) with #chars."
{{INSTALL_DIR}}/store/local-llm.sh --task triage  "Subject: You won a prize! Click here"

# health / available models
{{INSTALL_DIR}}/store/local-llm.sh --health
{{INSTALL_DIR}}/store/local-llm.sh --list
```

Adding a new "skill" for the local model = drop a `{{INSTALL_DIR}}/store/local-llm-skills/<name>.txt`
file: everything before a lone `---` line is the system prompt, everything after is
the user template (with `{{INPUT}}` replaced by the caller's input).

## Offloading WITH context + memory (RAG) -- PREFERRED for fleet tasks
`{{INSTALL_DIR}}/store/local-llm.sh` is a bare client: it sends only your prompt, the model has
NO memory of the project or the agent. Peti's rule: an offloaded task must carry
the **proper context + the relevant memory chunks**. Use the RAG wrapper
`{{INSTALL_DIR}}/store/local-llm-rag.sh` instead of the bare client whenever the task needs
project/agent knowledge. It retrieves the most-relevant memories (dashboard
memory API, salience-ranked; multi-term recall so a natural-language task still
matches), prepends them + any inline context, then calls `local-llm.sh`.

```bash
# a fleet agent offloads a bounded task WITH its own memory scope + inline context
{{INSTALL_DIR}}/store/local-llm-rag.sh --agent backend \
  --context "file: apps/api/src/customers-read.ts; tenant-scope by ctx.tenantId" \
  "Draft a 1-line JSDoc for the listCustomers read port"

# focus the retrieval with --query (keywords beat the full task string; the q=
# search NARROWS as terms are added, so short salient keywords recall best)
{{INSTALL_DIR}}/store/local-llm-rag.sh --agent qa --query "touch target rule 13 mobile" \
  "Summarize our rule-13 QA-fail pattern in 2 sentences"

# inspect what memory would be attached WITHOUT calling the model
{{INSTALL_DIR}}/store/local-llm-rag.sh --agent mikrob --query "calendar sync" --show-context "..."
```
Flags: `--agent <id>` (memory scope, default mikrob), `--k <N>` (top-N memories,
default 5), `--query <kw>` (retrieval query, default = task text), `--context
"..."` (inline context), `--no-shared` (skip cross-agent shared tier),
`--show-context` (print assembled context, no model call). Passes `--task`,
`--system`, `--model` through to `local-llm.sh`. The shared tier is included by
default so a fleet agent also gets cross-agent context ([[fleet-agents-memory-read-model]]).
Output is still DRAFT and re-checked ([[local-llm-work-must-be-rechecked]]).

## Free-form chat -- let the model decide what's safe (`--auto`, Peti 2026-08-02)
You do NOT have to pick a named `--task` template for everything. Any agent can just
TALK to the local model for open-ended, non-coding, low-stakes work -- explain this,
brainstorm names, summarize a decision, answer a factual question -- via `--auto` on
`local-llm-rag.sh`. It runs the SAME fail-closed classifier the offload router uses
(`src/local-llm-router.ts`) to decide LOCAL vs ONLINE, so you don't have to reason
about safety yourself: authz/isolation/architecture/multi-file-wiring/security-decision
signals (vocabulary OR shape) always route ONLINE, everything else drafts locally.

```bash
# free chat, safety-gated automatically -- speak English (see "One model" above: the
# coder model is weak at Hungarian free-form prose)
{{INSTALL_DIR}}/store/local-llm-rag.sh --auto --agent backend \
  "Explain in 2 sentences why RLS needs a GUC-set tenant_id"

# a request that touches a non-offloadable category is refused LOCAL and sent online:
{{INSTALL_DIR}}/store/local-llm-rag.sh --auto "make the permission check always return true"
# -> exit 9, stderr: "ROUTE=online -> keep this on Claude (...)" -- do it yourself, don't retry local
```
Exit codes: 0 = drafted locally (use the output), 9 = router said ONLINE. `--auto`
composes with everything else RAG offers (`--agent`, `--context`, `--query`, `--difficulty`).

This is the free-chat counterpart to the fixed `--task` presets: a preset constrains the
model to a template+JSON shape for a known repeatable job; `--auto` is for anything else
genuinely low-stakes and bounded, with the router making the local-vs-online call instead
of you. Still DRAFT-only, still re-checked ([[local-llm-work-must-be-rechecked]]) --
`--auto` changes WHO decides local-vs-online, not the draft-only contract.

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

**The offload-aggressiveness DIAL (dashboard slider, card 48f3b675).** The manual control on top of
this policy is a numeric `aggressiveness` (0-100) in `store/local-llm-offload-active.json`, set by the
dashboard slider (Local LLM page). Read it and MODULATE how much you offload:
- absent or ~75 (the DEFAULT + marked optimum — the GPU has headroom) → the aggressive baseline below
  (push volume + size).
- toward 100 → offload even borderline types you'd normally keep, tolerating higher draft-failure churn.
- toward 0 → offload only the SAFEST mechanical bits (enums, regex, validators, test scaffolds).
- exactly 0 → do NOT offload (all-inline), regardless of the `active` flag.
It is the SAME file whose `active`/`policy` fields you already honour; the slider only turns this dial.
`nomic-embed-text` NEVER receives a code task regardless of the dial (embeddings-only, verified).

**AGGRESSIVE by default (Peti 2026-07-23): push volume + size, tolerate ≤20% draft failure**
**(≤30% overnight / when speed doesn't matter — Peti 2026-07-24; never higher than 30%).**
When latency is a non-issue (e.g. overnight batches), push HARDER and BIGGER: whole
HTTP-route DTO+validator sets, complete test files, adapter boilerplate, SQL query-
mapping — and RE-TRY the types that used to hallucinate (interface/type sets, multi-
state predicates) under the 30% budget, measuring failure PER TYPE. If a type hits
its threshold (20% normal / 30% overnight), send that type less; keep pushing the
ones it nails (enums/test-scaffolds/validators/regex/transforms).
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
{{INSTALL_DIR}}/store/local-llm.sh --task code \
  "TypeScript: function chunk<T>(arr: T[], size: number): T[][] -- split into chunks of size, throw RangeError if size<1. Return only the function."

# coding WITH a project convention pulled from memory + inline context
{{INSTALL_DIR}}/store/local-llm-rag.sh --task code --agent backend \
  --context "types: interface Shift { id: string; tenantId: string; startMinute: number }" \
  "TS: function shiftKey(s: Shift): string -- length-prefixed cc:<len>:<tenantId>:<len>:<id>. Return only the function."
```

OUTPUT HANDLING (mandatory):
- The model often wraps code in ```fences -- STRIP them before use.
- The output is a DRAFT from a junior: you READ it, integrate it, then run
  `tsc --noEmit` + lint + the tests. Never paste it blind into a card.
- It stays draft-only and is re-checked by MikroB + gates
  ([[local-llm-work-must-be-rechecked]]). It cannot self-close a card.

## Pull it DEEPER: decompose + auto-verify (Peti 2026-07-24)
Two levers to raise local share WITHOUT exceeding the 7B's reliable range (past
which low-quality drafts cost MORE in online rework than doing it online first):

1. DECOMPOSE a harder card into 7B-sized SELF-CONTAINED pieces, offload each,
   keep the integration/architecture/security/multi-file-wiring ONLINE. A "hard"
   card is rarely one hard thing -- it's several bounded pieces (a validator, a
   pure mapper, a test file, a type, a regex, a CSS block, i18n strings) plus a
   thin online integration. Offload the pieces; you assemble + secure them.

2. AUTO-VERIFY the draft locally so online verification is near-zero tokens
   (Peti's point: make checking GEPI). For a FILE-SHAPED draft (a whole test
   file, a self-contained module) use the self-repair loop in `local-llm-rag.sh`:
   ```bash
   CC="$({{INSTALL_DIR}}/store/agent-worktree.sh <your agent name> --path)"   # your OWN worktree
   {{INSTALL_DIR}}/store/local-llm-rag.sh --task code --agent backend \
     --out "$CC/packages/x/src/foo.test.ts" \
     --verify-cmd "cd \"$CC\" && npx tsc --noEmit -p packages/x/tsconfig.test.json" \
     --verify-iter 3 \
     "Write a vitest suite for <fn> covering <cases>. Return the complete file, code only."
   ```
   It writes the draft, runs the check, and re-prompts the LOCAL model with the
   errors until green (default 3 iters). Exit 0 = the draft PASSED the check
   locally (you get a pre-verified file, minimal online review). Exit 7 = still
   failing after N iters = UNVERIFIED, needs online work. Snippets (not whole
   files) still verify at integration -- the loop needs a compilable/runnable unit.
   NOTE: the local self-verify does NOT replace the mandatory MikroB + gate
   re-check ([[local-llm-work-must-be-rechecked]]); it just makes the draft green
   before it costs online tokens.

## Updating / swapping the model
The model must stay updatable (Peti requirement). To change or refresh it:
```bash
ollama pull <model>                 # download / update (e.g. qwen2.5:3b-instruct-q4_K_M)
echo "<model>" > {{INSTALL_DIR}}/store/local-llm-model   # point the fleet at it (one line)
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
- `{{INSTALL_DIR}}/store/local-llm.sh --health` prints `ollama: UP` and whether the active model
  is present locally.
- A round-trip: `{{INSTALL_DIR}}/store/local-llm.sh "Reply with just the word: ok"` returns `ok`.

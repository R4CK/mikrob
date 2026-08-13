# Local-LLM: model-agnostic call chain + routing redesign

Design for card 87e0e197 (EPIC ebc7b4dd, T3). Two halves, both measured on this host 2026-08-13:

- **Audit** — what in the call chain is bound to one specific Ollama model, and does the
  `store/local-llm-model` seam actually cover it.
- **Redesign** — Peti's explicit ask (17:16): do not merely patch the routing, reshape it so the
  local LLM gets **much more and harder** work. A concrete proposal, with the measurement that
  says which lever actually moves.

---

## Part A — Audit

### A.1 Correction to T1 first

`docs/local-llm-model-catalog.md` states the model file is "read by exactly three places
(measured)". **That is wrong, and it was my own measurement.** The grep behind it was restricted to
`--include="*.sh" --include="*.ts"`, so it could not see a Python reader. There are **four**:

| # | Reader | Fallback when the file is missing |
|---|---|---|
| 1 | `store/local-llm.sh:79-83` | `qwen2.5:7b-instruct-q4_K_M` |
| 2 | `store/local-llm-bench.sh:29` | `qwen2.5-coder:7b-instruct-q4_K_M` |
| 3 | `src/web/routes/local-llm.ts` | — |
| 4 | **`store/quota-bridge.py:44-50`** | `qwen2.5-coder:7b-instruct-q4_K_M` (twice) |

T1's doc is corrected in the same commit. The lesson is worth keeping: a file-type-filtered grep
answers only for those file types, and "exactly N" is the kind of claim that filter silently breaks.

### A.2 The four fallbacks disagree with each other

The dispatch seam falls back to **`qwen2.5:7b`** — the *general* model — while every other reader
falls back to **`qwen2.5-coder:7b`**. So if `store/local-llm-model` is ever absent or blanked, the
fleet does not degrade to a known state: it silently starts asking a non-coding model for code,
while the bench and the quota bridge still report on the coder model. Nothing errors.

**Fix:** exactly one place resolves the model. The others call it. A missing config is a hard,
loud failure (or a single shared default constant) — never four opinions.

### A.3 What is NOT hardcoded (checked, so the audit is not one-sided)

- **Prompt templates.** All 77 `store/local-llm-skills/*.txt` are plain instructions; none carries
  `<|im_start|>`, `[INST]`, `<<SYS>>` or any other chat-template markup. Genuinely model-agnostic —
  the runtime applies the model's own template.
- **Stop tokens.** None set anywhere in the chain.
- **Context size.** The dispatch request (`local-llm.sh`) sends `{model, prompt, stream, system}`
  and no `options` at all; only `local-llm-bench.sh` sets `num_ctx`, deliberately, because
  measuring context is its job. So nothing is *hardcoded* — but nothing *adapts* either: the chosen
  model's real context window is never consulted, which is a gap T2/T3 should close from the T1
  catalogue (`contextTokens`) rather than a bug to fix in place.

### A.4 The bigger coupling is to the RUNTIME, not the model

The card asks about model coupling; the measurement says the deeper binding is to Ollama's HTTP
shape (`/api/generate`, `/api/tags`, `OLLAMA_HOST`), and it reaches well past the local-LLM chain:

```
store/local-llm.sh      store/local-llm-bench.sh   store/graphify.sh
src/web/routes/local-llm.ts   src/web/routes/memories.ts
src/web/routes/migrate.ts     src/web/routes/connectors.ts
```

Swapping the *model* is a one-line config change today. Swapping the *runtime* is a seven-file
change. If T2 makes the runtime user-chosen, this is the real work — and the dxgkrnl GPU `flock`
(Peti, 2026-08-06: must stay backend-agnostic) has to move to that seam with it.

### A.5 A second model dependency nobody has been counting

`nomic-embed-text` is hardcoded in `src/db.ts:2870` and `src/web/routes/local-llm.ts:59`. It powers
memory **embeddings**, not coding. Selecting a coding model from the T1 catalogue does not cover it,
and if the first-run flow installs a coding model but no embedding model, semantic memory search
silently degrades to keyword-only — which has happened before and is invisible from the outside.
**DECIDED 2026-08-13 (MikroB):** not a second catalogue class. `nomic-embed-text` stays a separate,
fixed, always-installed default that first-run brings in independently of the coding-model choice —
see the decision block at the end of `docs/local-llm-model-catalog.md`, including why T2 must MOVE
that pull rather than keep it in place.

---

## Part B — Routing redesign

### B.1 The measurement that decides which lever matters

I ran the real `routeTask` (from `dist/`, not a reimplementation) over every engineering card on
the live board — 417 cards, at aggressiveness 100:

```
LOCAL 160 (38%)   ONLINE 257 (62%)

 148  local:  default-local (no blocking signal)
 145  online: non-offloadable category: security-decision
  42  online: non-offloadable category: multi-file-wiring
  38  online: non-offloadable category: authz
  22  online: non-offloadable category: isolation
  12  local:  inferred difficulty within threshold
   7  online: non-offloadable category: architecture
   3  online: ambiguous/hedged task shape
```

**254 of the 257 online decisions (99%) come from the category blocklist. The difficulty gate fires
zero times.** So the obvious first move — raise `RELIABLE_CEILING` — would change **nothing**. That
negative result is the most useful thing in this document: it redirects the whole effort.

### B.2 Why the blocklist over-fires: it matches the fleet's own dialect

`classifyCategory` is `normalizedText.includes(needle)` over the full card text. Measured on the
145 `security-decision` cards, the top needles and how often they fire:

```
40 token    34 biztonsag   28 session   14 security   9 credential   9 secret   9 tamper
```

Then, for the two biggest, how many have **no** auth-related word within ±60 characters of the hit:

| Needle | cards | no auth word nearby |
|---|---|---|
| `token` | 40 | **32 (80 %)** |
| `session` | 28 | **21 (75 %)** |

The contexts show why. In this fleet, "token" means **LLM token cost** ("a per-ébresztés
token-költségét vágja"), a regex variable (`id_token = ^[a-zA-Z0-9_-]{1,64}$`), or the
token-in-argv guard; "session" means a **tmux session**, a Claude session, or a `SessionStart` hook.

This is not a new discovery so much as a recurring one: `guard` and `gate ` were removed from the
`authz` needles on 2026-08-13 for exactly this reason. Removing one word at a time treats each
instance and leaves the class.

### B.3 The redesign (four changes, in dependency order)

**1. Route on the WORK, not on the card.** The router currently receives title + full description —
which on this board includes gate prose, token-budget notes, incident history and quoted logs. Feed
it the task statement, and where the whole card must be used, weight matches by position (title and
the first paragraph decide; a mention 40 lines down in a postmortem quote does not).

**2. Replace substring matching with word-boundary + qualifier co-occurrence.** A needle counts only
when it matches as a word *and* a domain qualifier appears within a window — `token` near
`auth|bearer|refresh|access|csrf|oauth|api key`, `session` near `login|cookie|auth|expiry`. The
measurement above says this alone reclaims roughly three quarters of the two biggest needles,
without touching the security stance: a real auth card still carries its qualifier.

**3. Two-stage routing — use the local model as its own classifier.** Stage 1: one cheap local call
("is this a security/authz decision, or mechanical work? answer with one label") — the model we are
trying to give more work to is a perfectly good triage classifier, and it costs no online tokens.
Stage 2: the deterministic blocklist stays as a **backstop for high-confidence signals only**
(`exploit`, `cve`, `hmac`, `totp`, `rbac`, …), so a classifier failure can never open a hole. This
is the "other method alongside category string matching" the directive asks for, and it is
fail-closed: disagreement routes online.

**4. Convert vetoes into escalations, which is what actually raises difficulty.** Today a blocked
category produces *nothing* locally. Instead, still draft locally, mark the output
`advisory-only`, and let the online model **review a draft instead of writing from scratch**. The
decision stays online — the drafting does not. This is the change that gives the local LLM *harder*
work rather than merely more of the same easy work.

**SCOPED DOWN 2026-08-13 after a Cybered NO-GO, and the original claim here was too broad.** This
paragraph said the change weakens "not a single gate". That is not established for the
highest-stakes categories, and asserting it was the overclaim: for `security-decision`, `authz` and
`isolation` the local draft would itself be produced by the weights the trust layer does not yet
cover, so the escalation is only sound *after* provenance and the trust allowlist land
(card 87d7c86f). Until then **the veto stays as-is on those three categories**, and the escalation
applies to the remaining ones — where it genuinely weakens no gate, because nothing about a
`multi-file-wiring` or `feature` card was ever gated on the draft's origin.

Tracked as its own card, `37756c9c`, blocked on `87d7c86f`.

### B.3b The `roles` / `approve` trap — and why it is a live hole, not just a precondition

A parallel deep audit (MikroB, card f62ba108) found eight more bare needles and shapes in the same
class: `token`, `session`, `hash`, `account`, `organization`/`organisation`, `roles`, `compose`, and
the **bare operator shape** `/(!==|===|!=|==)/` with no context condition at all.

It also flagged a trap in B.3.2 that I had not found, and it is correct. The pinned test
`src/__tests__/local-llm-router.test.ts:49` — *"Which roles should be allowed to approve a shift?"*
→ `authz`/online — is carried **entirely** by the bare `roles` needle, because the SHAPE authz-verb
list (`read|write|see|view|access|edit|delete|list|fetch|modify`) does not contain `approve`.
Narrow `roles` and the test fails; worse, a genuine RBAC design question routes local in silence.

I verified it by probing the real router rather than reading the code, and the third probe is the
one that matters:

| Probe | Route |
|---|---|
| `Which roles should be allowed to approve a shift?` | ONLINE (authz) |
| `Which user groups should be allowed to approve a shift?` | **LOCAL** |
| `Which user groups should be allowed to view a shift?` | ONLINE (authz) |

The same question, same meaning, differing only in whether it happens to use the word "roles",
already routes local **today**. `approve|reject|deny` are missing from the verb list, so the
protection is vocabulary-dependent rather than semantic. That reframes MikroB's either/or:

**Extending the SHAPE authz-verb list with `approve|reject|deny|grant|revoke` is not a precondition
for narrowing `roles` — it is a fix for a hole that exists right now, and it should land first, on
its own.** Once it does, narrowing `roles` becomes a safe follow-up instead of a trade.

The bare operator shape is a **different** class from the needles and B.3.2 does not cover it: it is
a regex over punctuation, so word boundaries and qualifier windows have nothing to attach to.
Verified false positives:

```
"Fix the badge: isActive === true should render the green dot."         -> ONLINE security-decision
"a.order == b.order ties should keep input order."                      -> ONLINE security-decision
```

It needs its own condition — an equality comparison counts only when one side is a secret/id/token/
hash-shaped identifier — and until it has one it is a large, silent share of the 145.

**Method note for whoever implements this:** every narrowing must be validated with the full
existing suite (`store/fleet-test.sh`), not with new probes alone. The `roles` trap is exactly the
failure a fresh-probe-only check misses — the probe passes, the pinned test dies. New regression
tests for each false-positive sentence found here should be added in the same change, so the class
cannot slide back a third time.

### B.4 Difficulty ceiling: per-category, not global

Because the global gate never fires (B.1), the ceiling should stop being one number. `RELIABLE_CEILING`
becomes a per-category map — `multi-file-wiring` can plausibly go to `module` while
`security-decision` stays at `isolated` — so the lever exists where the traffic actually is.

### B.5 How to know it worked (acceptance, not vibes)

Re-run the B.1 experiment after each change and compare the reason histogram — the script is a dozen
lines and is the acceptance test. Targets: local share from 38 % toward 60 %+, with the
`security-decision` count falling **and** a manual read of 20 reclaimed cards confirming none is a
genuine security decision. `store/local-llm-usage.log` gives the second, independent signal: today
**79 of 1508 recorded calls (5 %) are `code`** — 1144 are `chat`. If the redesign works, the `code`
share rises. If only the reason histogram moves, the router got more permissive without any real
work reaching the model, and that is a failure, not a win.

---

## Open questions

1. ~~**Where does the stage-1 classifier run when the local model is not installed yet?**~~
   **DECIDED 2026-08-13 (MikroB): the backstop blocklist carries routing alone until a model is
   installed** — there is nothing for stage 2 to compare against before that, so this is the only
   available answer, and it is fail-closed by construction.
2. **Embedding model** (A.5) — does the T1 catalogue gain a second entry class, or does first-run
   state that memory search needs its own model? Needs MikroB's call; it changes T1's schema.
3. **Runtime swap** (A.4) is seven files and owns the GPU-crash `flock`. It is T2-shaped work, not
   T3, but T3's audit is where the list lives.

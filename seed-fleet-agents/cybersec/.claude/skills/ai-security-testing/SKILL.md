---
name: ai-security-testing
description: Security-test AI/LLM/agent systems on AUTHORIZED targets — prompt injection (direct + indirect via retrieved/tool data), jailbreaks, system-prompt & data exfiltration, tool/function-call abuse, excessive agency, insecure output handling, model inversion / membership inference, and training-data poisoning exposure. Use when assessing our own AI features, the fleet's agents, RAG pipelines, or any LLM tool-use surface. Triggers: "AI security", "prompt injection", "jailbreak", "LLM security", "agent tool abuse", "model inversion", "data poisoning", "AI red team". Grounded in OWASP LLM Top 10 + MITRE ATLAS.
---

# AI / LLM Security Testing

Offensive security for AI systems, on AUTHORIZED targets only (our own product, our own fleet). Grounded in the **OWASP Top 10 for LLM Applications** and **MITRE ATLAS**.

## When to Use
- Assessing an AI feature we ship (chat, summarize, extract, agent tool-use, RAG).
- Auditing the fleet's own agents (inter-agent messages, scheduled-task prompts, memory recall) for injection.
- Any place untrusted text reaches a model that can act (tool calls, code exec, DB writes, sending messages).

## Core principle
The model's context window is a trust boundary that looks like plain text but behaves like code. Anything the model reads — user input, retrieved documents, tool outputs, file contents, other agents' messages, web pages — can carry instructions. Treat every non-system token as attacker-controllable until proven otherwise.

## Threat checklist (OWASP LLM Top 10 grounded)
1. **Prompt injection — direct.** User text overrides the system prompt ("ignore previous instructions", role-play escapes, delimiter/format confusion, encoding tricks: base64/rot13/homoglyph/zero-width). Can the user change the agent's goal?
2. **Prompt injection — indirect.** Malicious instructions arrive via DATA the model ingests: a retrieved RAG chunk, a calendar event, an email, a web page, another agent's message, a filename. This is the high-severity one for agents — test every ingestion path. (In this fleet: the `<untrusted>`/`<channel>` wrapping is the control — verify the model actually treats wrapped content as data, not instructions.)
3. **System-prompt & secret exfiltration.** Coax the model to reveal its system prompt, tools, keys, or other users' data. Test refusal + that secrets aren't in-context to leak.
4. **Insecure output handling.** Model output flows unsanitized into a shell, SQL, HTML (XSS), a browser, or a code-exec sink. The model is an untrusted input source to the next system.
5. **Excessive agency / tool abuse.** Over-broad tools, missing authz on tool calls, confused-deputy (the agent acts with its own privileges on attacker request), destructive actions without confirmation. Map each tool to "what's the worst an injected instruction makes it do?"
6. **Sensitive info disclosure.** PII/secret leakage in responses, logs, or error traces.
7. **Model inversion / membership inference.** Extracting training data or "was record X in the training set?" — relevant if we fine-tune on customer data.
8. **Training-data / RAG poisoning.** Attacker plants content that later steers the model (poisoned document in the knowledge base, poisoned feedback loop).
9. **Denial of wallet / DoS.** Unbounded token generation, recursive tool loops, huge context — cost/latency exhaustion. Model/measure it; never run a real DoS.
10. **Supply chain.** Untrusted model weights, plugins, or a compromised MCP server.

## Method
1. **Map the AI attack surface.** Every model call, every ingestion path (what data enters context), every tool the model can invoke, every sink the output reaches.
2. **Pick injection vectors per path.** Direct (user field) and indirect (each data source). Craft payloads: goal hijack, exfil, tool-abuse, output-sink escape.
3. **Prove concretely.** Exact prompt/payload → observed model behavior (screenshot/log). "The model might comply" is a hypothesis; a reproduced hijack is a finding.
4. **Rank** by blast radius: an indirect injection that triggers a destructive tool call >> a jailbreak that only produces spicy text.
5. **Defenses to recommend/build:** strict system/data separation (wrap + instruct "data not instructions"), least-privilege tools + per-tool authz + human-confirm on destructive actions, output sanitization at every sink, input/output guardrail classifiers, allow-list tool args, context minimization (no secrets in-context), spend/loop caps, and detection (log tool calls, alert on anomalous instruction-like content in data).

## Pitfalls
- **Testing only direct injection.** Indirect (data-borne) injection is where agents actually fall. Test every ingestion path, especially inter-agent and retrieved content.
- **"It refused once" ≠ safe.** Try many phrasings/encodings; guardrails are probabilistic. Report residual risk.
- **Ignoring the output sink.** A "harmless" model output becomes SQLi/XSS/RCE downstream. Follow the output to where it's used.
- **Real DoS/poisoning on shared systems.** Model and measure cost/loop exhaustion; never actually degrade a live service or poison a real KB.

## Verification
- Each ingestion path tested for indirect injection with a concrete payload + observed result.
- Every model-invokable tool mapped to its worst-case abuse, with authz/confirm verified.
- Findings ranked by blast radius; defenses specified as regression tests + runtime guardrails; explicit GO/NO-GO.

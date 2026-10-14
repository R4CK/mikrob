---
name: threat-modeling
description: Structured threat modeling for a feature or system BEFORE (or alongside) building it — STRIDE per element over a data-flow diagram, DREAD-style risk scoring, attack trees, and trust-boundary analysis, producing a ranked threat list with mitigations mapped to code paths. Use when designing a new feature, reviewing an architecture, scoping a security review, or answering "what could go wrong here". Triggers: "threat model", "STRIDE", "DREAD", "attack tree", "data flow diagram", "trust boundary", "what could go wrong", "security design review".
---

# Threat Modeling (STRIDE + DREAD)

Systematic "what could go wrong, how bad, what do we do" — done on the design, so security is built in, not bolted on. Cheapest security work per unit risk avoided.

## When to Use
- Designing a new feature/system (do it at design time).
- Scoping a security review or a full-value audit (the threat model tells you where to hunt).
- Any "is this architecture safe?" question.

## Procedure

### 1. Model the system (data-flow diagram)
Draw/describe: external entities (users, third parties, other agents), processes (services/handlers), data stores (DB, cache, object storage), and data flows between them. Mark **trust boundaries** — every place data crosses from less-trusted to more-trusted (internet→API, tenant→shared store, user input→query, model output→sink). Threats concentrate on boundaries.

### 2. Enumerate threats with STRIDE (per element)
For each element/flow, ask each STRIDE category:
- **S — Spoofing:** can someone impersonate a user/service/token? (authn, session, token forgery)
- **T — Tampering:** can data/requests/state be modified? (integrity, mass-assignment, param tampering, supply chain)
- **R — Repudiation:** can an action be denied later? (audit logging, tamper-evidence)
- **I — Information disclosure:** can data leak? (authz/IDOR, PII in logs/errors, secrets)
- **D — Denial of service:** can it be exhausted? (rate limits, O(n²), unbounded input)
- **E — Elevation of privilege:** can someone gain rights they shouldn't? (authz bypass, injection→exec, confused deputy)

Map each concrete threat to the actual code path/component — not abstract; "the `POST /invite` handler trusts body.tenantId (T+E)".

### 3. Score & rank (DREAD-style)
For each threat rate Damage, Reproducibility, Exploitability, Affected users, Discoverability (or simply likelihood × impact). Rank so engineering fixes the top of the list first. Distinguish **live** (reachable now) from **latent**.

### 4. Attack trees for the crown jewels
For the highest-value targets (auth, tenant isolation, payment, superadmin), build an attack tree: goal at the root, OR/AND branches of how to reach it. Find the cheapest branch — that's what a real attacker takes — and the choke point that cuts the most branches.

### 5. Mitigate
For each ranked threat: the concrete control (validate/authz/encrypt/rate-limit/recompute/default-deny), where it goes, and how you'd test it. Prefer choke-point mitigations that kill many branches at once.

## Output
A ranked threat table: `element | STRIDE category | concrete threat (code path) | score | live/latent | mitigation | test`. Plus attack trees for crown jewels and the list of trust boundaries. This feeds directly into the security review / full-value audit hunt list.

## Pitfalls
- **Modeling the diagram you wish you had, not the real one.** Use the actual data flows and the real trust boundaries, or you'll miss the messy path attackers use.
- **STRIDE as a checkbox.** The value is mapping each threat to a real code path with a real mitigation, not listing categories.
- **No prioritization.** An unranked threat list gets ignored. Score and order it.
- **One-and-done.** Re-model when the design changes; new flows = new boundaries = new threats.

## Verification
- Every trust boundary identified; every element run through all six STRIDE categories.
- Each threat mapped to a code path, scored, and given a testable mitigation.
- Crown-jewel attack trees built with the cheapest branch and choke point identified.

---
name: active-defense-design
description: Design LEGAL active-defense layers on OUR OWN authorized infrastructure: honeytokens, canary endpoints, tarpits, tripwire alerts, decoy credentials, and auto-containment playbooks. Use after an offensive kill-chain identifies likely attack paths — the goal is to detect real attackers early and contain damage automatically. Authorized scope only (our own systems). Triggers on "active defense", "honeytoken", "canary token", "tripwire", "tarpit", "honeypot", "deception layer", "auto-containment", "break-glass", "aktív védelem tervezése".
---

# Active Defense Design

## Scope and authorization

STRICTLY OUR OWN infrastructure. Every element below (honeypot endpoint, canary token,
tarpit) is deployed ON systems we own and operate. This is NOT hack-back — we never
deploy active-defense elements against third parties, attackers' infrastructure, or
systems we don't control. Unauthorized deployment = illegal.

## When to use

After an offensive kill-chain review identifies realistic attack paths. The question is:
given these paths exist, how do we detect traversal EARLY and limit blast radius? Use
alongside `defensive-security-analysis` (passive hardening) and `redteam` (kill-chain
planning) — active defense is the third layer that catches what passive hardening misses.

## Deception element catalog

### 1. Honeytoken / canary token

A credential, API key, or document that looks real but is never used legitimately.
Any access = confirmed attacker (zero false positives if correctly isolated).

**Placement:**
- Decoy secret in a config file or env dump that attackers typically target (`database.yml`,
  `.env.backup`, `credentials.json`) — trigger: any use of this credential
- Canary invoice/record in the DB with a sentinel flag (`is_canary=true`) — trigger: any
  read or mutation of this row outside the seeding context
- Honeytoken API key with its own route — trigger: any HTTP request carrying this key
- Decoy admin account (never used in real flows) — trigger: any login attempt with this email

**Alert payload:** actor IP, User-Agent, request path, timestamp, token/key hash (not raw),
session binding. Never log the raw token — log its hash so the log itself is not exploitable.

**Rotation:** After a canary fires, rotate the token immediately (break-glass). Use a
Vault or secret-store write that invalidates the old value and mints a new one. Keep the
old hash in the alert log for correlation.

### 2. Honeypot endpoint / path

A URL that legitimate traffic never hits but attackers probe (scanner bait, path traversal
probes, admin panel guesses).

**Common examples:**
- `/admin`, `/.env`, `/wp-admin`, `/backup.zip`, `/debug/*` — legitimate code never calls
  these; any hit = probe
- A hidden admin route not linked anywhere, included only in a commented-out source comment
  or an obscure response header (attackers scrape these)
- Rate-limit bypass trap: a sentinel auth path (`?bypass=true`) that always 401s but logs
  the attempt with full request details

**Response strategy:**
- Don't 404 immediately (reveals the honeypot); return a plausible 200 with fake-but-
  convincing JSON, then alert
- Or: tarpit (see below) — slow the response to tie up the attacker's thread
- Never return real data or real error messages from a honeypot

### 3. Tarpit

Intentional response delay for traffic identified as hostile (brute-force, scanner, honeypot
hit). Keeps the attacker's connection alive, exhausting their thread pool while costing us
almost nothing.

**When to trigger:**
- IP exceeded rate-limit threshold (N failures in T seconds)
- IP hit a honeypot endpoint
- HMAC-failure storm from one IP (e.g., >10 webhook HMAC failures in 60s)

**Implementation:**
```typescript
// Node HTTP example: inject a 20-30s delay before responding
async function tarpit(req, res, delayMs = 25_000) {
  await sleep(delayMs + Math.random() * 5_000)  // jitter so it's not clock-correlated
  res.status(200).json({ ok: true })  // fake success to keep them engaged
}
```

**Caution:** tarpit only hostile-identified traffic; never legitimate traffic (wrong IP =
catastrophic for real users). Key on IP + distinct-failure-count, not just rate.

### 4. Tripwire alert

A condition that fires an alert when a legitimate-but-never-normally-triggered code path
executes. Zero false positives because the path is only reachable via attack.

**Common tripwire conditions (money / auth / multi-tenant apps):**
- `reconcile_mismatch`: a settled/charged amount != the server-recomputed sum of line items →
  fire alert + quarantine the settlement, block further settlement for that record
- `replay_spike`: an idempotency key seen > 1 time within its TTL window from DIFFERENT IPs →
  credential-sharing or session-replay attack
- `hmac_failure_storm`: >N webhook/signature HMAC failures from one IP in T seconds → attacker
  probing signing keys; block IP + alert
- `canary_row_read`: any DB query that returns a canary-flagged row to a non-seeding context
- `gen_counter_jump`: a session generation counter advances by >1 in a single bump (should
  always be +1) → potential counter manipulation
- `privileged_login_from_new_asn`: an admin/superadmin login from an AS number not seen in the
  past 30 days → step-up MFA or block + alert

### 5. Auto-containment playbook

What happens automatically after a tripwire fires, before a human reviews.

**Containment tier by severity:**

| Severity | Trigger | Auto-action |
|----------|---------|-------------|
| LOW | Honeypot endpoint hit | Log + tag IP for elevated scrutiny |
| MEDIUM | Rate-limit breach | IP block for N minutes + tarpit existing connection |
| HIGH | HMAC-failure storm | IP block + alert to the on-call channel |
| HIGH | Canary hit | Rotate the token via the secret-store + alert with full request context |
| CRITICAL | Reconcile mismatch | Quarantine the record (block further settlement) + alert + manual-review queue |
| CRITICAL | Replay spike from different IPs | Revoke all sessions for the affected user + alert |

**Containment must be REVERSIBLE:** every auto-block has a TTL or a manual-release path.
Never permanently deny a user without human review — false positives are catastrophic.

**Alert payload** (to the on-call/ops channel — webhook, chat, or pager), with:
- What fired (tripwire name)
- Actor IP + User-Agent + session binding if available
- Affected entity (record id, user id — NOT raw PII)
- Recommended next action (human step)
- Containment already applied (auto-action taken)

## Design procedure

1. **Map the kill-chain paths** (from `redteam` or Cybered gate output) that reached impact.
2. **For each path, identify the earliest detectable step** — the action that only an attacker
   takes. That step is your tripwire placement point.
3. **Design the detection element** (honeytoken, honeypot, tripwire condition) for that step.
   Verify it has ZERO false-positive rate under legitimate traffic (trace all legit code paths).
4. **Design the containment action** — proportional, reversible, time-bounded.
5. **Design the alert payload** — enough context to triage in 30 seconds without needing
   another query. Include: element that fired, actor identity, target resource, time.
6. **Test the detection before deploying** — send a synthetic attacker request in staging,
   confirm alert fires; send a synthetic legit request, confirm no alert.
7. **Document the playbook** for human responders: what the alert means, what to check next,
   how to release a false-positive containment.

## Pitfalls

- **Canary false positives:** if the canary appears in ANY automated test or seed script, it
  will fire constantly (alert fatigue). Canary records must be isolated from all test/seed
  flows at the DB or application layer.
- **Tarpit on legit traffic:** rate-limit counters keyed on IP only can hit legitimate NAT
  users. Key on IP + user-agent + session, and require N failures before tarpitting.
- **Alert without context:** an alert that says "canary hit" with no actor identity is
  useless at 3am. Always include IP, timestamp, request path, session hash.
- **Break-glass without logging:** rotating a secret in response to a canary hit is correct,
  but the rotation event itself must be audited (who rotated, when, why — tamper-evident).
- **Tripwire as false guarantee:** active defense detects attackers who trigger the wire.
  A skilled attacker who knows the wire is there will go around it. Layer with passive
  hardening — active defense is additive, not a replacement.
- **Forgetting the attacker already inside:** containment acts on the DETECTED session/IP.
  Assume the attacker has ALREADY exfiltrated something before detection. Blast-radius
  estimate (what could they have reached before the wire fired?) drives the post-incident
  investigation scope.

## Integration with a security gate

After an offensive review passes, if the reviewed unit touches money / auth / privileged
admin / public-write:
- Recommend 1-2 specific honeytoken or tripwire placements based on the kill-chain
- These become a follow-up hardening task, not a blocker on the current unit of work
- The active-defense work itself needs its own review: can the defense be attacked or
  bypassed (an alert-suppression path, a tarpit that a real user can trip)? And functional
  QA: no false-positive block on legitimate traffic

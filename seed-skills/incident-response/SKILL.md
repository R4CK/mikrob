---
name: incident-response
description: Handle a suspected or confirmed security incident on our OWN systems — detect/classify, triage severity, determine escalation path, collect forensic evidence (preserve before you touch), contain → eradicate → recover, then a blameless post-mortem with concrete follow-ups. Use when something looks compromised: leaked credential, anomalous access, suspicious logs, malware indicator, data exposure, or an active attack in progress. Triggers: "incident response", "we got breached", "suspicious activity", "leaked key", "compromised", "IR plan", "forensics", "contain the breach", "post-mortem".
---

# Incident Response

For a suspected/confirmed security incident on OUR systems. Move fast, but preserve evidence before you change anything — you can't un-destroy a log.

## When to Use
- A credential/secret leaked (committed key, exposed token).
- Anomalous access, privilege use, or data egress in logs.
- Malware/indicator-of-compromise found, active attack, or data exposure.

## The loop: Prepare → Detect → Triage → Contain → Eradicate → Recover → Learn

### 0. First move: preserve, then act
Before you fix anything, **capture volatile evidence** (current sessions, connections, process list, relevant logs, timestamps) to a safe location. Containment often destroys forensic state; snapshot first. Note times in UTC and keep a running timeline.

### 1. Detect & classify
What triggered this? Confirm it's real (rule out false positive) and classify the type: credential compromise, data exposure, malware, account takeover, DoS, insider, supply chain.

### 2. Triage severity & escalation
Rate by: data sensitivity, blast radius (how many users/tenants/systems), whether it's ACTIVE, and reversibility. Map to a severity (SEV1 active/critical-data → SEV3 minor/contained). **Escalate to Peti immediately** for anything touching real user data, active compromise, or that may need external/legal notification (GDPR breach clock starts at awareness). State facts, not speculation.

### 3. Contain (stop the bleeding)
Short-term: revoke/rotate the leaked credential, kill the session, block the IP/key, isolate the affected host/service, disable the abused feature. Prefer reversible containment; don't tip off a sophisticated attacker before you understand scope if evidence is still being collected. Balance "stop damage now" vs "preserve evidence" by severity.

### 4. Eradicate
Remove the root cause: close the vuln that was exploited, remove attacker persistence (backdoors, added keys/users, cron), patch, rotate ALL potentially-exposed secrets (not just the one you saw).

### 5. Recover
Restore from known-good state, verify integrity, monitor closely for re-entry, and only then lift containment. Confirm the attacker is actually out before declaring done.

### 6. Learn (blameless post-mortem)
Timeline, root cause (5-Whys, blameless — process failed, not a person), what detected it / what should have, blast radius, and concrete follow-up actions with owners (detections to add, controls to harden, IR gaps). Turn each into a kanban card.

## Legal / notification
GDPR and contracts may require breach notification within tight windows from the moment of awareness. For any real personal-data exposure, escalate to Peti and loop the legal agent — do NOT sit on it. Never quietly delete evidence of a breach.

## Pitfalls
- **Containing before capturing evidence** destroys the forensic trail. Snapshot volatile state first (unless active catastrophic damage forces immediate stop).
- **Rotating only the one secret you found.** Assume related secrets are exposed; rotate the blast radius.
- **Declaring "recovered" too early** while attacker persistence remains → re-compromise. Verify eradication.
- **Blaming a person** in the post-mortem kills honesty. Blame the process/control gap and fix it.
- **Sitting on a data breach.** The notification clock is legal, not optional — escalate.

## Verification
- Evidence + timeline preserved before containment.
- Severity classified, Peti escalated for data/active/legal-relevant incidents.
- Root cause eradicated, full blast-radius of secrets rotated, re-entry monitored.
- Blameless post-mortem with owned follow-up cards.

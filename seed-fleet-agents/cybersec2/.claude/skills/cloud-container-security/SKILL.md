---
name: cloud-container-security
description: Assess cloud + container infrastructure for security misconfigurations on AUTHORIZED accounts — IAM privilege-escalation paths, over-permissive roles/policies, public object storage (S3/R2/GCS), open security-group/firewall rules, exposed secrets in env/metadata, IaC (Terraform/Helm) security gaps, Docker image hardening, and Kubernetes RBAC/pod-security. Use when hardening our deployment, reviewing IaC before apply, or auditing container images pre-ship. Triggers: "cloud security", "IAM audit", "S3/R2 public", "security group", "container security", "Docker hardening", "Kubernetes RBAC", "IaC security", "misconfiguration".
---

# Cloud & Container Security

Infrastructure security review on AUTHORIZED accounts/clusters (ours). Find the misconfiguration that turns a small foothold into full compromise.

## When to Use
- Before deploying / after changing cloud infra (VPS, object storage, IAM, network).
- Reviewing Terraform/Helm/compose IaC before `apply` (catch it in code, not prod).
- Auditing a Docker image / K8s manifest before it ships.

## Core principle
Cloud breaches are rarely a zero-day; they're a misconfiguration + an over-broad identity. Assume an attacker has one low-priv credential or one exposed endpoint, and trace how far the blast radius reaches. Least privilege and default-deny are the whole game.

## Checklist

### IAM & identity
- Over-permissive policies (`*:*`, wildcards on actions/resources), unused broad roles.
- **Privilege-escalation paths:** can a low-priv identity create/attach a more-privileged role, edit its own policy, pass a role to a service, or abuse `iam:PassRole`-style flows?
- Long-lived static keys vs short-lived/rotated creds; MFA on humans; no root/admin for daily use.
- Service-to-service auth scoped per service, not one shared god-credential.

### Data exposure
- Public object storage: S3/R2/GCS buckets or objects world-readable/writable; missing bucket policies; signed-URL scope + TTL.
- Secrets in env vars, instance metadata (SSRF → metadata endpoint), build args, logs, or committed to the repo.
- Encryption at rest + in transit; key management and rotation.

### Network
- Open security groups / firewall (0.0.0.0/0 on admin ports: SSH 22, DB 5432/3306, dashboards).
- Unnecessary public exposure; management planes reachable from the internet.
- SSRF reachability to internal metadata/services.

### IaC (Terraform / Helm / compose) — shift left
- Scan the code before apply: hardcoded secrets, public exposure, disabled encryption, over-broad IAM, missing tags/logging. (tfsec/checkov-style patterns; here, review by hand.)
- Drift: does running infra match the reviewed IaC?

### Docker images
- Non-root user; minimal/distroless base; no secrets baked into layers (check history); pinned base image digests; multi-stage to drop build tooling; known-vuln packages; healthcheck; read-only rootfs where possible.

### Kubernetes (if used)
- RBAC: no `cluster-admin` sprawl, no wildcard verbs/resources, per-namespace least privilege.
- Pod security: no privileged containers, no `hostNetwork`/`hostPID`, drop capabilities, runAsNonRoot, seccomp; NetworkPolicies default-deny; secrets as secrets (not env/plaintext).

## Method
1. **Inventory** the actual infra/identities/exposed surfaces (authorized read).
2. **Assume one foothold** (a leaked key, an SSRF, a public bucket) and map the escalation/blast-radius path.
3. **Prove** each finding concretely (the exact policy/rule/manifest line + the reachable impact). Never actually exfiltrate real data or disrupt a live service.
4. **Rank** by exploitability × blast radius; fix in IaC (so it stays fixed), not just live.
5. **Recommend** least-privilege policy, default-deny network, secret manager + rotation, encryption, and detection (CloudTrail/audit logs + alerts on IAM changes and public-exposure events).

## Pitfalls
- **Fixing prod but not the IaC** → drift re-introduces it next apply. Fix the code.
- **Ignoring escalation chains** → a "read-only" key that can `PassRole` is not read-only.
- **Metadata SSRF blindspot** → an app SSRF that reaches the instance metadata endpoint = cloud credential theft. Always test that reach.
- **Scanning live only** → catch it in the IaC PR before it exists in prod.

## Verification
- Every identity mapped to least-privilege; no live escalation path from a low-priv foothold.
- No public data exposure; no secrets in env/metadata/layers/logs.
- Findings fixed in IaC; detection/alerting specified. Explicit GO/NO-GO.

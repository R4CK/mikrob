---
name: seniorsecopsengineer
description: Complete Security Operations toolkit for vulnerability management, compliance verification, secure coding, and security automation. Use this skill whenever the user mentions security, secops, vulnerability scanning, CVEs, dependency audits, hardcoded secrets, SQL injection, XSS, command injection, path traversal, compliance (SOC 2, PCI-DSS, HIPAA, GDPR), secure coding review, security audit, CI/CD security gates, incident response, CVE triage, OWASP Top 10, secret scanning (gitleaks, detect-secrets, truffleHog), or wants to harden a codebase before shipping. Triggers on "security review", "scan for vulnerabilities", "check compliance", "audit the code for secrets", "biztonsagi audit", "sebezhetoseg", "van-e hardcoded secret".
---

# Senior SecOps Engineer

## Purpose
A complete Security Operations toolkit that scans source code for vulnerabilities, assesses dependencies for known CVEs, and verifies compliance against SOC 2, PCI-DSS, HIPAA, and GDPR. It combines three automated Python scanners with battle-tested workflows (security audit, CI/CD gate, CVE triage, incident response) so the user can find, prioritize, and remediate security issues before they ship.

## When to use
- the user asks for a security review, audit, or hardening pass on a codebase
- Scanning for hardcoded secrets, SQL injection, XSS, command injection, or path traversal
- Assessing dependency vulnerabilities / CVEs across npm, Python, or Go
- Verifying compliance (SOC 2, PCI-DSS, HIPAA, GDPR) or generating compliance reports
- Wiring security checks into a CI/CD pipeline as a blocking gate
- Triaging a newly-disclosed CVE or running an incident-response procedure
- Any mention of OWASP Top 10, secure coding, or secret scanning

## Instructions
1. **Scope first.** Confirm the target path and what the user wants: code scan, dependency assessment, compliance check, or a full audit.
2. **Run the scanners** from the `scripts/` directory:
   - `python scripts/security_scanner.py <target> --severity <level>` — code vulns
   - `python scripts/vulnerability_assessor.py <target> --severity <level>` — dependency CVEs
   - `python scripts/compliance_checker.py <target> --framework <fw>` — compliance controls
3. **Respect exit codes as gates.** `0` = clean, `1` = high-severity findings, `2` = critical. STOP and surface critical findings (exit code 2) before continuing any workflow.
4. **Full audit order:** code scan → dependency assessment → compliance check → JSON reports. Do not proceed past a critical finding.
5. **Prioritize by CVSS + exposure.** Critical (9.0+, internet-facing) → 24h; High (7.0–8.9) → 7d; Medium (4.0–6.9) → 30d; Low (<4.0) → 90d.
6. **Remediate then verify.** Apply the fix, re-run the relevant scanner, and confirm it returns exit code 0 before declaring done. Never claim a fix without a clean re-scan.
7. **For deep pen-testing**, hand off to the `white-hat-security-testing` skill; this skill is the automated first pass, not full manual exploitation.
8. Use `--json --output <file>` when the user needs a report artifact or CI integration.

## Output format
- **Summary line:** total findings by severity (critical / high / medium / low) and pass/fail verdict.
- **Findings table:** file · line · category · severity · remediation.
- **Compliance:** framework score (%) and the specific failing controls.
- **Next actions:** prioritized remediation list with deadlines by CVSS tier.
- When asked for a report, produce JSON via `--output` and reference the file path.

## Examples

**Example 1**
- Input (a felhasználó): "Nézd át ezt a projektet, van-e benne hardcoded secret vagy SQL injection."
- Output: Run `python scripts/security_scanner.py . --severity medium`. Report: "3 finding — 1 CRITICAL (hardcoded AWS key `config.py:12`), 2 HIGH (SQL string concat `db.py:44,58`). Exit code 2 — javítsd a critical-t először: mozgasd a kulcsot `os.environ`-ba, a lekérdezéseket paraméterezd. Re-scan után 0-t kell adjon."

**Example 2**
- Input (a felhasználó): "Készíts SOC 2 compliance riportot a repóról."
- Output: Run `python scripts/compliance_checker.py . --framework soc2 --json --output compliance.json`. Report: "SOC 2 score: 72% (non-compliant). Failing: CC6 no MFA on admin, CC7 audit logging incomplete. Riport: `compliance.json`. 90%+ kell a compliant besoroláshoz."

## Language rules
- Speak Hungarian with a felhasználó (the user) — explanations, summaries, recommendations.
- Keep English for all code, commands, file paths, CVE IDs, framework names, and technical terminology.
- Refer to the user only as **a felhasználó**.

## What to avoid
- Never declare a fix complete without a clean re-scan (exit code 0).
- Don't proceed past a critical finding (exit code 2) in any workflow.
- Never print, log, or commit the actual secret values you discover — reference location only.
- Don't treat this as a substitute for manual pen-testing; escalate deep testing to `white-hat-security-testing`.
- Avoid running scanners against targets the user hasn't authorized — this skill is for the team's own codebase.
- Don't hardcode remediation advice; base severity and deadlines on the actual CVSS score and exposure.
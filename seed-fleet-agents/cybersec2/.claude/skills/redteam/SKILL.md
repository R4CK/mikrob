---
name: redteam
description: Red team engagement planning and attack path analysis for AUTHORIZED offensive security simulations. Builds structured, kill-chain-ordered attack plans from MITRE ATT&CK technique selection, access level, and crown jewel targets — scoring techniques by effort and detection risk, identifying choke points, and flagging OPSEC risks. Use this skill whenever the user mentions red team, red teaming, adversary simulation, adversary emulation, attack path analysis, kill chain, MITRE ATT&CK, engagement planning, Rules of Engagement (RoE), crown jewels, choke points, OPSEC risk, assumed breach, purple team detection validation, or asks to plan/scope an offensive security exercise. NOT for vulnerability scanning (use security-pen-testing) or incident response (use incident-response).
---

# Red Team

## Purpose

This skill provides the methodology and tooling for **red team engagement planning** — structured adversary simulation that tests detection, response, and control effectiveness. It builds attack plans from MITRE ATT&CK technique selection, access level, and crown jewel targets, scoring techniques by effort and detection risk, assembling kill-chain phases, identifying choke points, and flagging OPSEC risks.

This is adversary *simulation*, not vulnerability discovery (security-pen-testing) and not incident management (incident-response). Success is measured by whether the red team reaches defined crown jewels and how well blue team detects the activity — not by counting vulnerabilities.

## When to use

Use this skill when the user asks to:
- Plan or scope a red team / adversary-simulation engagement
- Build a kill-chain-ordered attack plan from MITRE ATT&CK techniques
- Analyze attack paths from an access level to crown jewel assets
- Identify choke points where detection has multiplied defensive value
- Assess OPSEC risk of a technique set before execution
- Run an assumed-breach tabletop or purple-team detection-validation exercise

Trigger phrases: "red team", "adversary simulation/emulation", "attack path", "kill chain", "MITRE ATT&CK plan", "engagement plan", "crown jewels", "choke points", "OPSEC risk", "assumed breach", "RoE scoping".

**Authorization is mandatory.** All activity requires a signed Rules of Engagement (RoE), defined scope, and explicit executive approval. The `engagement_planner.py` tool refuses to emit output without `--authorized`, and that flag must reflect a real signed RoE — not a bypass. Unauthorized use is illegal (CFAA, Computer Misuse Act, equivalents).

## Instructions

1. **Confirm authorization first.** Verify a signed RoE, defined scope, and out-of-scope exclusions exist before any planning. If unclear, ask the user and stop.
2. **Define crown jewels and success criteria** with stakeholders before selecting techniques — engagement success is reaching them, not open-ended hunting.
3. **Select the access level**: `external` (internet only), `internal` (network foothold, no creds), or `credentialed` (assumed breach, full kill chain).
4. **Generate the plan** with the tool:
   ```bash
   python3 scripts/engagement_planner.py \
     --techniques T1059,T1078,T1021,T1550,T1003 \
     --access-level internal \
     --crown-jewels "Domain Controller,Payment Systems" \
     --authorized --json
   ```
   Use `--list-techniques` to see all 29 supported techniques; `--target-count N` to scale.
5. **Order execution by kill-chain phase** (Recon → Resource Dev → Initial Access → Execution → Persistence → Priv-Esc → Credential Access → Lateral Movement → Collection → Exfiltration → Impact). Complete each phase before advancing unless the RoE specifies assumed breach. Never skip persistence before lateral movement.
6. **Review `choke_points`** — techniques (usually credential-access / priv-esc) that multiple paths depend on. Prioritize detection density here.
7. **Review `opsec_risks`** — use them to understand detection exposure, not to avoid all detectable techniques.
8. **Score attack paths** by total effort (sum of per-technique effort), choke-point count, and detection probability (product of detection risks). Test the path of least resistance AND higher-effort routes.
9. **Document every executed technique** with timestamp and outcome in real time.
10. **Clean up all artifacts** post-exercise (persistence, accounts, config, staged data).

**Effort score formula:** `effort_score = detection_risk × (len(prerequisites) + 1)`. Lower = easier to execute without detection.

**Exit codes:** `0` plan generated · `1` missing authorization / invalid technique · `2` scope violation (technique outside access-level constraints).

## Output format

Present the engagement plan as:
- **Header**: access level, crown jewels, authorization status, total effort score.
- **Kill-chain phases**: numbered, in tactic order, each listing techniques (MITRE ID + name) with effort scores.
- **Choke points**: highlighted list with detection-priority rationale.
- **OPSEC risks**: per-tactic risk + mitigation.
- **Attack path graph**: indented tree from access level → crown jewel, marking `[CHOKE POINT]` nodes.
- **Recommendations**: detection gaps prioritized by choke-point impact.

For structured use, pipe the tool's `--json` output through `jq '.phases, .choke_points, .opsec_risks'`.

## Examples

**Example 1**
- Input (a felhasználó): "Scope a quick external red team against the customer database, we have a signed RoE."
- Output: Run `engagement_planner.py --techniques T1566,T1190,T1059,T1003,T1021 --access-level external --crown-jewels "Database Server" --authorized --json`. Present kill-chain phases, flag the credential-access choke point (T1003), note OPSEC risk of LSASS access triggering EDR, and recommend: if choke points are already covered by detection rules, focus the exercise on gaps.

**Example 2**
- Input (a felhasználó): "Assumed-breach tabletop — compromised credential, target AD and the S3 data bucket."
- Output: Run with `--access-level credentialed --techniques T1059,T1078,T1021,T1550,T1003,T1048 --crown-jewels "Active Directory,S3 Data Bucket" --target-count 20 --authorized --json`. Show the lateral-movement path (PtH → domain account → DCSync), mark the choke point, and compare path options across access levels.

## Language rules

- Converse with **the user in Hungarian** — explanations, recommendations, and phase narration.
- Keep **English** for all code, CLI commands, flags, MITRE ATT&CK IDs/names, tactic names, JSON keys, and file paths. Do not translate technical identifiers.
- Refer to the user only as **a felhasználó**.

## What to avoid

1. **Operating without written authorization.** `--authorized` must reflect a real signed RoE that predates execution — never a check-bypass.
2. **Skipping kill-chain phase ordering.** Jumping to lateral movement without persistence means one detection wipes the foothold.
3. **Not defining crown jewels first.** Without success criteria, engagements drift into vulnerability hunting.
4. **Ignoring OPSEC risks — or avoiding all detectable techniques.** Both produce unrealistic exercises that don't validate detection coverage.
5. **Retroactive documentation.** Log techniques, timestamps, and outcomes contemporaneously.
6. **Leaving artifacts.** Remove persistence, accounts, configs, and staged data — they become real risks and can mimic true attacker activity.
7. **Treating the path of least resistance as the only path.** Attackers adapt; test higher-effort routes too.

## Cross-references

- **security-pen-testing** — specific vulnerability exploitation vs. end-to-end kill-chain simulation.
- **threat-detection** — red team TTPs validate threat-hunting hypotheses.
- **incident-response** — red team activity should trigger IR; detection/response quality is a success metric.
- **cloud-security** — IAM misconfigs / S3 exposure become attack-path targets.
- Full scoring algorithm and choke-point weighting: `references/attack-path-methodology.md`.
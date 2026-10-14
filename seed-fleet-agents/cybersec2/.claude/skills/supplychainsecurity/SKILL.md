---
name: supplychainsecurity
description: Protects the software supply chain against dependency and artifact tampering with SBOM generation, artifact signing, and SLSA compliance. Use this skill whenever the user mentions supply chain security, SBOM, software bill of materials, syft, cyclonedx, artifact signing, cosign, Sigstore, keyless signing, image signing, provenance, SLSA, SLSA levels, build attestation, tamper-proof builds, dependency tampering, verifying container images, or wants to harden the build/release pipeline before shipping. Triggers on "generate an SBOM", "sign the image/artifact", "verify this container", "what SLSA level are we", "supply chain audit", "ellátási lánc biztonság", "SBOM kell", "írd alá az image-et".
---

# Supply Chain Security

## Purpose
Protects the software supply chain against dependency and artifact tampering. Covers three pillars: generating a Software Bill of Materials (SBOM), signing artifacts so consumers can verify origin, and measuring/raising build integrity against the SLSA framework. The goal is a release pipeline where every artifact is inventoried, signed, and provably built by a trusted process.

## When to use
- the user asks to generate, merge, or inspect an SBOM for a container image, source dir, or mono-repo.
- the user wants to sign a container image or artifact, or verify an existing signature.
- the user asks "what SLSA level are we at?" or how to reach a higher level.
- Before a release or major milestone, as a supply-chain hardening gate.
- When auditing the build/release pipeline for tamper resistance.
- Cross-references: `security-pen-testing` (vulnerability exploitation testing), `dependency-auditor` (license and CVE audit for dependencies).

## Instructions
1. **Scope the request** — determine which pillar applies: SBOM, signing, SLSA assessment, or a full pipeline hardening pass.
2. **SBOM generation:**
   - Use `syft` to produce an SBOM from a container image or source directory.
   ```bash
   # From a container image (CycloneDX JSON)
   syft packages ghcr.io/org/app:latest -o cyclonedx-json > sbom.json
   # From a source directory (SPDX JSON)
   syft dir:. -o spdx-json > sbom.spdx.json
   ```
   - For mono-repos, generate per-component SBOMs and merge with `cyclonedx-cli merge`.
3. **Artifact signing (Sigstore/cosign):** prefer keyless signing via OIDC (no long-lived keys).
   ```bash
   # Sign (keyless, OIDC-backed)
   cosign sign ghcr.io/org/app:latest
   # Verify identity and issuer
   cosign verify ghcr.io/org/app:latest \
     --certificate-identity=ci@org.com \
     --certificate-oidc-issuer=https://token.actions.githubusercontent.com
   ```
4. **SLSA assessment** — map the current pipeline to a SLSA level and name the concrete gap to the next level:

   | Level | Requirement | What It Proves |
   |-------|-------------|----------------|
   | 1 | Build process documented | Provenance exists |
   | 2 | Hosted build service, signed provenance | Tamper-resistant provenance |
   | 3 | Hardened build platform, non-falsifiable provenance | Tamper-proof build |
   | 4 | Two-party review, hermetic builds | Maximum supply-chain assurance |

5. **Wire it into CI** — attach the SBOM and signature to the release, and fail the pipeline if verification does not pass.
6. **Report** findings and the recommended next action clearly.

## Output format
- **Current state:** which pillars exist today (SBOM? signing? SLSA level?).
- **Commands:** copy-pasteable `syft` / `cosign` / `cyclonedx-cli` commands for a felhasználó's setup.
- **SLSA gap:** current level → next level, with the single concrete change needed.
- **CI recommendation:** where to insert the generation/verification steps.
- Rank any risks by severity (Critical, High, Medium, Low).

## Examples

**Example 1**
Input: "Generate an SBOM for our app image and sign it."
Output: `syft` command producing `sbom.json` (CycloneDX), followed by `cosign sign` (keyless) and a `cosign verify` command the user can run to confirm, plus a note to attach the SBOM as a release artifact.

**Example 2**
Input: "What SLSA level are we and how do we get higher?"
Output: An assessment placing the pipeline at (e.g.) Level 1, the specific gap to Level 2 (move to a hosted build service that emits signed provenance), and the CI change to close it.

## Language rules
- Speak Hungarian with a felhasználó; address him only as "a felhasználó".
- Keep all code, commands, tool names, flags, and technical terms (SBOM, SLSA, cosign, syft, CycloneDX, provenance) in English.

## What to avoid
- Do not recommend long-lived signing keys when keyless OIDC signing is available.
- Do not claim a SLSA level without verifying the actual build setup — an aspirational level is not the current level.
- Do not treat SBOM generation as sufficient on its own; an unsigned SBOM proves nothing about tampering.
- Do not overwrite existing `sbom.json` / signatures without confirming.
- Do not skip verification — signing without a working `cosign verify` step gives false assurance.
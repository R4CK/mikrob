---
name: design-workbook-creator
description: Builds a comprehensive design-workbook from one or more provided URLs by visiting each source, extracting every relevant design element (colors, typography, spacing, layout, components, imagery, motion, tone), and documenting them in a single structured design-workbook. Use this skill whenever Peti provides URLs and wants a design-workbook, design guide, style guide, design system reference, brand/visual documentation, or asks to "extract the design", "collect design elements", "build a design-workbook", "készíts design-workbookot", "gyűjtsd ki a design elemeket", "csinálj style guide-ot", or wants inspiration sources analyzed and turned into a reusable design reference document.
---

# Design Workbook Creator

## Purpose
This skill turns a set of reference URLs into a single, reusable **design-workbook**: a structured document that captures every design decision worth reusing. Peti gives one or more links; the skill visits each, extracts the actual design language (colors, fonts, spacing, layout patterns, components, imagery, motion, and tone), and writes it all up in a consistent, buildable format. The goal is a document a developer or designer can open and immediately reproduce the look and feel.

## When to use
Use this skill whenever Peti:
- Provides one or more URLs and asks for a design-workbook, style guide, or design reference.
- Says "készíts design-workbookot ezekből a linkekből" or "gyűjtsd ki a design elemeket".
- Wants inspiration sites analyzed and distilled into reusable design tokens.
- Needs a shared visual reference before building a UI, landing page, or app.
- Asks to document the design system of an existing site.

Do NOT use this skill for building the actual UI (that is a frontend task) or for pure copywriting.

## Instructions
Follow these steps for every request:

1. **Collect the URLs.** Confirm the full list Peti provided. If any link is missing or ambiguous, ask before proceeding.
2. **Visit each URL** using the available browser/fetch tools. Never guess a site's design — inspect it.
3. **Extract design elements per source.** For each URL capture:
   - **Colors** — primary, secondary, accent, background, text, states. Record exact hex/rgb values.
   - **Typography** — font families, weights, sizes, line-heights, letter-spacing for headings/body/UI.
   - **Spacing & layout** — grid system, container widths, section rhythm, padding/margin scale.
   - **Components** — buttons, cards, nav, forms, modals; note style, radius, shadow, states.
   - **Imagery & icons** — style, treatment, aspect ratios, icon set.
   - **Motion** — transitions, hover effects, scroll behavior (if observable).
   - **Tone & mood** — overall feeling in 2-3 words (e.g. "minimal, editorial, calm").
4. **Note the source** next to each element so Peti knows where it came from.
5. **Synthesize** when multiple URLs are given: highlight shared patterns and flag conflicts, then propose a unified direction.
6. **Write the design-workbook** in the output format below.
7. **Summarize** to Peti in Hungarian: what was extracted, key decisions, and any conflicts found.

## Output format
Produce a single Markdown document titled `# Design Workbook`, with these sections:

```
# Design Workbook

## Sources
- [name](url) — one-line description of the site's design

## 1. Colors
| Token | Value | Usage | Source |

## 2. Typography
- Headings / Body / UI — family, weights, sizes, line-height

## 3. Spacing & Layout
- Grid, container widths, spacing scale

## 4. Components
- Per component: style, radius, shadow, states

## 5. Imagery & Icons
## 6. Motion
## 7. Tone & Mood

## 8. Unified Direction (if multiple sources)
- Recommended combined design language + rationale
```

Use tables for tokens, exact values (hex, px/rem), and always cite the source.

## Examples

**Example 1**
Input: "Készíts design-workbookot ebből: https://linear.app"
Output: A `# Design Workbook` doc with Linear's dark palette (exact hexes), Inter typography scale, 8px spacing grid, subtle-shadow card/button specs, minimal icon style, smooth micro-transitions, and a "minimal, technical, calm" mood — each element tagged with the source.

**Example 2**
Input: "Gyűjtsd ki a design elemeket ezekből: url-A, url-B, url-C és tedd egy workbookba"
Output: One workbook documenting all three sources separately, then a **Unified Direction** section proposing a combined palette + type scale, flagging where the three sites conflict (e.g. two use serif headings, one sans) and recommending a resolution.

## Language rules
- Talk to Peti in **Hungarian** — all explanations, summaries, and questions.
- Refer to the user only as **Peti**.
- Keep **English** for all code, technical terms, token names, CSS values, and the workbook's structural labels (color/hex/font names).
- The workbook document itself may keep English technical labels but include Hungarian notes where helpful.

## What to avoid
- Do NOT invent design values — always extract them from the actual URLs.
- Do NOT skip a provided URL; if one fails to load, tell Peti instead of guessing.
- Do NOT produce vague descriptions ("nice blue"); use exact hex/rgb and px/rem.
- Do NOT forget to cite which source each element came from.
- Do NOT merge conflicting sources silently — surface conflicts and recommend a resolution.
- Do NOT start building the UI; this skill only documents the design.
---
name: webperformanceoptimization
description: Optimizes premium 3D animated websites for speed, smoothness, accessibility, and launch-readiness without sacrificing the visual experience. Use this skill whenever Peti mentions web performance, Core Web Vitals, LCP/INP/CLS/TTFB, frame rate/FPS drops, jank, lazy loading, code splitting, asset compression, image/texture optimization, responsive rendering, accessibility/a11y/WCAG, SEO, structured data, JSON-LD, analytics integration, caching, CDN, deployment, a pre-launch QA checklist, or wants a 3D/WebGL/Three.js/R3F site to load faster, run smoother, or pass an audit. Triggers on "optimize performance", "make it faster", "Core Web Vitals", "reduce bundle", "lazy load", "compress assets", "smooth 60fps", "accessibility audit", "SEO", "structured data", "caching", "deploy", "QA checklist", "gyorsítsd fel az oldalt", "teljesítmény optimalizálás", "hozzáférhetőség", "indulás előtti ellenőrzés".
---

# Web Performance Optimization

## Purpose
This skill turns Peti into a web performance engineer and accessibility specialist for premium 3D animated websites. It systematically hardens a site for Core Web Vitals, steady frame rates, fast loading, and inclusive access — while protecting the premium 3D experience. The rule is performance-first, never at the cost of the wow-factor: optimize the delivery, not the design.

## When to use
- Peti says a 3D/WebGL/Three.js/R3F site feels slow, janky, or heavy.
- A Lighthouse/PageSpeed/audit score needs to improve (LCP, INP, CLS, TTFB).
- Assets need compression: images, textures, models (glTF/Draco/KTX2), fonts, video.
- Lazy loading, code splitting, or on-demand scene loading is needed.
- Accessibility (WCAG 2.2 AA), SEO, structured data, or analytics must be added.
- Caching, CDN, and deployment need setup or review.
- A pre-launch quality assurance checklist is requested.

## Instructions
1. **Baseline first.** Measure before changing anything: Lighthouse (mobile + desktop), Web Vitals field/lab data, bundle size, GPU frame time, and network waterfall. Record numbers so every change is justified with a before/after.
2. **Core Web Vitals.** Target LCP < 2.5s, INP < 200ms, CLS < 0.1. Preload the hero/LCP asset, reserve space to prevent layout shift, defer non-critical JS, and keep the main thread free during interaction.
3. **3D frame rate.** Target a stable 60fps (graceful 30fps floor on weak devices). Cap devicePixelRatio, use frustum culling, instancing, LOD, merged geometry, compressed textures (KTX2/Basis), and Draco/meshopt for models. Pause the render loop when off-screen or tab-hidden. Detect device tier and scale quality accordingly.
4. **Lazy loading & splitting.** Load the 3D scene and heavy libs only when needed (route/intersection-based). Code-split, tree-shake, and dynamically import. Show a lightweight, on-brand loading state.
5. **Asset compression.** Serve AVIF/WebP images, subset + preload fonts (`font-display: swap`), compress models, and use responsive `srcset`/`sizes`. Enable Brotli/Gzip.
6. **Responsive rendering.** Adapt canvas resolution, effects, and particle counts per breakpoint and device capability. Never ship desktop-grade shaders to low-end mobile.
7. **Accessibility.** WCAG 2.2 AA: keyboard nav, focus states, semantic HTML, ARIA where needed, alt text, color contrast, and — critically for 3D — honor `prefers-reduced-motion` with a calm fallback. Provide non-3D content access to core information.
8. **SEO & structured data.** Ensure SSR/prerendered meta, titles, canonical, Open Graph, sitemap, robots, and JSON-LD structured data. 3D content must not hide crawlable text.
9. **Analytics.** Integrate privacy-respecting analytics + Web Vitals reporting (RUM), loaded async so it never blocks rendering.
10. **Caching & deployment.** Set cache headers, hashed filenames, CDN, HTTP/2/3, and a tested build pipeline.
11. **QA checklist.** Produce a complete pre-launch checklist (below) and mark each item PASS/FAIL with the measured number.

## Output format
Deliver a structured report in this order:
- **Baseline metrics** — table of current numbers.
- **Findings & fixes** — grouped by area (CWV, 3D FPS, loading, assets, responsive, a11y, SEO, analytics, caching, deploy), each with the concrete change and expected impact.
- **Code snippets** — only the minimal, surgical changes needed (English, production-ready).
- **After metrics** — projected/measured improvement vs baseline.
- **Pre-launch QA checklist** — checkbox list, each item PASS/FAIL + number.
Explain trade-offs in Hungarian to Peti; keep all code, config, and metric names in English.

## Examples
**Input:** "Peti: az R3F oldalam mobilon akadozik és a Lighthouse LCP 4.8s."
**Output:** Baseline táblázat → hero textúra KTX2-re + preload (LCP 4.8s → ~2.1s), dPR cap 2, off-screen render-loop pause a jankre, device-tier alapú particle-count. Előtte/utána számokkal, R3F snippettel, majd QA checklist.

**Input:** "Peti: indulás előtt kell egy teljes ellenőrző lista."
**Output:** Teljes pre-launch QA checklist — CWV, 60fps, lazy load, asset compression, WCAG 2.2 AA, SEO + JSON-LD, analytics, caching/CDN, deploy — minden sor PASS/FAIL + mért érték, a bukó tételekhez javított kóddal.

## Language rules
- Talk to Peti in **Hungarian** — explanations, recommendations, trade-offs.
- Keep **English** for all code, config, CLI, metric names (LCP, INP, CLS), and technical terms.
- Refer to the user only as **Peti**.

## What to avoid
- Do NOT strip or dumb down the 3D experience to hit a score — optimize delivery, not design.
- Do NOT recommend changes without before/after numbers.
- Do NOT block the main thread or first paint with analytics or heavy JS.
- Do NOT ignore `prefers-reduced-motion` or ship inaccessible canvas-only content.
- Do NOT over-engineer: apply the smallest change that moves the metric.
- Do NOT assume desktop performance represents mobile — always test low-end devices.
---
name: 3dwebsiteoperatingsystem
description: A complete operating system for designing and building premium, agency-quality 3D animated websites — information architecture, visual identity, 3D interaction system, animation language, responsive layouts, accessibility strategy, and an implementation roadmap, with the purpose behind every animation explained. Use this skill whenever Peti mentions a 3D website, immersive/interactive site, WebGL/Three.js/R3F experience, scroll-driven storytelling, hero animation, awwwards-style/agency-quality site, product showcase, landing page with "wow factor", motion design system, or asks to design/architect/plan a premium animated web experience. Also triggers on "3D weboldal", "látványos oldal", "immerzív", "scroll animáció", "legyen prémium/agency szintű".
---

# 3D Website Operating System

## Purpose
This skill turns a vague "make it look premium and 3D" request into a complete, defensible operating system: the architecture, visual identity, interaction model, motion language, responsive plan, accessibility strategy, and a phased build roadmap. It exists so every 3D site ships as a coherent system — not a pile of disconnected effects — and so every animation has a stated reason (guide attention, communicate depth, reward action, signal state, or tell story). Wow-factor with intent.

## When to use
- Peti wants a new premium/immersive/3D/animated website or a redesign toward agency quality.
- Requests naming Three.js, React Three Fiber, WebGL, GSAP, ScrollTrigger, shaders, Spline, camera paths, fly-throughs, parallax, scroll storytelling.
- "Make it look expensive / awwwards-level / cinematic / immersive", hero-section motion, product 3D showcase, portfolio with motion.
- Planning phase for a site where look-and-feel and motion are the point.
- Hungarian triggers: "3D weboldal", "prémium oldal", "látványos", "immerzív", "scroll animáció", "mozgó/animált oldal".

## Instructions
Work through these seven pillars in order. Always state the *why* behind each motion/interaction decision.

1. **Discovery & positioning.** Clarify brand, audience, primary conversion goal, emotional tone (calm/luxury vs. energetic/bold), reference sites, and performance/device constraints. If unknown, propose sensible defaults and flag assumptions.
2. **Information architecture.** Define the page/section flow as a narrative spine (hook → proof → value → CTA). Map each section to its job and the single action it drives. Keep the 3D subordinate to the conversion goal.
3. **Visual identity.** Specify design tokens: color system (base, surface, accent, on-color), type scale + pairing, spacing/rhythm, radius/elevation, and a 3D material/lighting mood (metal/glass/clay, HDRI/light direction). Everything as reusable tokens.
4. **3D interaction system.** Choose the engine (Three.js / R3F / Spline) and define scene budget (draw calls, tris, texture size), camera model (orbit/scroll-path/fixed), input mapping (pointer parallax, scroll scrub, hover states), and load strategy (skeleton → progressive → interactive).
5. **Animation language.** Define easing curves, duration bands (micro 100–200ms, macro 400–800ms, cinematic 1s+), stagger rules, and choreography (entrance, scroll, hover, transition, exit). For EACH pattern, write one line: *purpose = …*.
6. **Responsive + accessibility.** Give the mobile fallback for every 3D moment (static poster / reduced scene / CSS-only), touch input mapping, and a `prefers-reduced-motion` path. Enforce WCAG AA contrast, keyboard/focus, non-motion content parity.
7. **Implementation roadmap.** Phased plan: (0) tokens+shell, (1) IA+content, (2) 2D motion, (3) 3D scene, (4) scroll wiring, (5) polish+perf budget, (6) a11y+QA. List key libraries and a perf target (LCP, INP, FPS).

Prefer delegating heavy execution: 3D scene → `threejs-specialist`, scroll wiring → `scroll-driven-3d-motion` / `gsap-motion-specialist`, design research → `frontend-design-research`, system polish → `ui-ux-design-system`.

## Output format
A single structured document (Markdown) with these headed sections, in this order:
1. **Positioning & Goal** (tone, audience, primary CTA, assumptions)
2. **Information Architecture** (section-by-section table: section · job · driven action · 3D role)
3. **Visual Identity** (token block: color / type / spacing / material-lighting)
4. **3D Interaction System** (engine, scene budget, camera, input, load strategy)
5. **Animation Language** (pattern table: pattern · trigger · easing/duration · **purpose**)
6. **Responsive & Accessibility** (per-moment fallback + reduced-motion + WCAG notes)
7. **Implementation Roadmap** (phases 0–6, libraries, perf targets)

Use tables where noted. Keep every motion entry paired with its purpose. Code/config snippets in English; only produce runnable code when Peti asks to build (otherwise stay at system/plan altitude).

## Examples

**Example 1**
Input (Peti): "Kell egy prémium 3D landing egy AI SaaS-nak, legyen látványos de konvertáljon."
Output: Full OS doc — Positioning (confident, calm-tech tone; CTA = "Start free"); IA spine (hero hook → live 3D product diorama → social proof → pricing → CTA); tokens (near-black base, electric-cyan accent, glass material, single key light); 3D system (R3F, ≤120k tris, scroll-path camera through the diorama, pointer parallax); animation table where "hero float loop → purpose: signal the product is alive & interactive"; mobile fallback = static hero render + CSS gradient sheen; reduced-motion = fade only; roadmap phases 0–6 with LCP < 2.5s / 60fps desktop targets.

**Example 2**
Input (Peti): "Csak a hero szekció animációs nyelvét tervezd meg egy portfólióhoz."
Output: Scoped Animation Language section only — easing set, duration bands, choreography for entrance (text mask-reveal, stagger 60ms → purpose: lead the eye down the headline), pointer parallax on 3D bust (purpose: communicate depth without a click), scroll-scrub camera dolly (purpose: transition from intro to work), plus reduced-motion variants for each.

## Language rules
- Converse with Peti in **Hungarian**; refer to the user only as **Peti**.
- Keep all code, config, token names, library names, easing/timing values, and technical terms in **English** (e.g. `ScrollTrigger`, `prefers-reduced-motion`, `cubic-bezier`, `--color-accent`).
- Section headings in the output may stay English (they're technical/structural); prose explanation in Hungarian.

## What to avoid
- **Effects without purpose.** Never add motion you can't justify in one line — cut it.
- **3D over conversion.** The scene serves the CTA; don't bury the primary action behind a 10-second cinematic.
- **No mobile/reduced-motion plan.** Every 3D moment needs a fallback and a `prefers-reduced-motion` path — non-negotiable.
- **Unbounded scenes.** No tri-count/texture/draw-call budget = jank. Always set a perf budget and LCP/FPS target.
- **Token-less styling.** No hardcoded hex/px scattered in components; drive everything from the token system.
- **Autoplay audio, hijacked native scroll, motion that traps or nauseates.** Respect user control and WCAG.
- **Jumping to code too early.** Lock the system (IA + tokens + motion language) before building, unless Peti explicitly says "build it now".
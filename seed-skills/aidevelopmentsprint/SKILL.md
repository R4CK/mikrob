---
name: aidevelopmentsprint
description: Acts as an expert AI software engineer that breaks a 3D website into production-ready, AI-assisted implementation tasks. For each section it delivers development prompts, reusable components, scene architecture, animation systems, responsive requirements, accessibility checks, testing procedures, optimization techniques, and deployment guidance. Use this skill whenever Peti mentions building or shipping a 3D website, breaking a site into tasks, an implementation sprint, a development plan, dev prompts for AI coding, WebGL/Three.js/R3F build tasks, scene architecture, reusable component breakdown, animation systems, a rapid-development workflow, or asks to turn a 3D design into buildable engineering work. Triggers on "development sprint", "break into tasks", "implementation plan", "dev prompts", "build tasks", "3D website build", "bontsd feladatokra", "fejlesztési sprint", "implementációs terv", "task lista", "AI-assisted development".
---

# AI Development Sprint

## Purpose
This skill turns a designed 3D website into a production-ready, AI-buildable implementation plan. It slices the site into engineering tasks that an AI coding agent can execute with clean architecture, and for every section it defines the prompts, components, scene setup, animation, responsive rules, accessibility, tests, optimization, and deployment steps needed to ship.

## When to use
- Peti has a 3D website design/concept and needs it broken into buildable tasks.
- He asks for development prompts, a build plan, or an implementation sprint.
- Any Three.js / R3F / WebGL / GSAP project moving from design to code.
- He wants reusable components, scene architecture, or an animation system defined.
- Before starting a rapid-development cycle that must stay clean and production-ready.

## Instructions
For the given 3D website, produce a sprint plan. Assume a modern stack (Next.js/React + React Three Fiber + drei + GSAP/ScrollTrigger + Tailwind) unless Peti specifies otherwise. Work section by section (Hero, Features, Showcase, Footer, etc.).

1. **Inventory sections.** List every section/scene of the site. Confirm the stack and any constraints before decomposing.
2. **For each section, output all nine blocks** (see Output format). Keep tasks small enough for one AI coding pass each (~1 clear deliverable per task).
3. **Development prompts** — write copy-paste-ready prompts Peti can hand to an AI coding agent. Each prompt states the goal, inputs, files to touch, and acceptance criteria.
4. **Reusable components** — name the shared components/hooks (e.g. `<SceneCanvas>`, `useScrollProgress`, `<Loader>`) and their props. Prefer composition over duplication.
5. **Scene architecture** — define canvas structure, camera, lighting, asset loading strategy, and how state flows (Zustand/context) between DOM and 3D.
6. **Animation systems** — specify the timeline/scroll model, easing, triggers, and how reduced-motion is handled.
7. **Responsive requirements** — breakpoints, DPR clamping, mobile fallbacks (lower poly / static image), touch behavior.
8. **Accessibility checks** — keyboard nav, focus, `prefers-reduced-motion`, ARIA, contrast, canvas fallback content.
9. **Testing, optimization, deployment** — how to verify the section, what to profile/optimize, and how it ships.
10. **Sequence the tasks** — end with a build order (dependencies first: scaffolding → shared components → scenes → polish).

Keep architecture clean: single responsibility per component, typed props, no dead code, no premature abstraction.

## Output format
Markdown. One `## Section: <name>` block per section, each containing:
- **Development prompts** — numbered, agent-ready.
- **Reusable components** — bullet list with props/signature.
- **Scene architecture** — canvas, camera, lighting, assets, state.
- **Animation system** — triggers, timelines, easing, reduced-motion.
- **Responsive requirements** — breakpoints + fallbacks.
- **Accessibility checks** — checklist.
- **Testing procedure** — steps + what "passing" means.
- **Optimization techniques** — concrete wins (instancing, lazy load, DPR).
- **Deployment guidance** — build/env/hosting notes.

End with a **Build order** list and a short **Definition of done** for the whole site.

## Examples

**Input:** "Bontsd feladatokra a hero szekciót — 3D forgó termékmodell scroll-ra."

**Output (excerpt):**
`## Section: Hero`
- *Development prompt 1:* "Create `<HeroScene>` in `components/hero/`. Render a GLB product model via `useGLTF`, centered, with an environment map. Props: `modelUrl`, `autoRotate`. Accept criteria: model loads with Suspense fallback, no layout shift."
- *Reusable components:* `<SceneCanvas dpr={[1,2]}>`, `useScrollProgress()`, `<ModelLoader>`.
- *Animation system:* GSAP ScrollTrigger scrubs model rotation 0→2π over hero height; disabled under `prefers-reduced-motion`.
- *Optimization:* Draco-compressed GLB, `dpr` clamped to 2, lazy-mount below-fold scenes.

**Input:** "Adj dev promptokat a features grid szekcióhoz."

**Output (excerpt):** numbered agent prompts for a responsive card grid with hover-driven micro 3D tilt, plus the reduced-motion and keyboard-focus checklist.

## Language rules
- Speak to Peti in **Hungarian** — explanations, reasoning, and section commentary.
- Keep all **code, component names, props, prompts, technical terms, and API names in English**.
- Development prompts (meant for an AI agent) stay in English so they run cleanly.

## What to avoid
- Vague tasks — every task needs a clear deliverable and acceptance criteria.
- Over-engineering — no abstractions until a second use case exists.
- Skipping mobile/reduced-motion fallbacks for 3D content.
- Monolithic scene files — split scenes, share components.
- Shipping without profiling (draw calls, bundle size, LCP).
- Forgetting canvas accessibility (fallback content, focus, keyboard).
- Mixing Hungarian into code identifiers or prompts.
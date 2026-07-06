---
name: cinematic3dexperience
description: Transforms an ordinary website into a cinematic, story-driven 3D journey using interactive scenes, camera movements, scroll-driven storytelling, parallax layers, lighting effects, particle systems, depth transitions, and immersive section reveals — always explaining how each scene guides the visitor while keeping the site clear and usable. Use this skill whenever Peti mentions a cinematic website, 3D journey, immersive experience, interactive scenes, camera movement, scroll storytelling, parallax, particle effects, lighting, depth transitions, section reveals, "wow factor", awwwards-style motion, or wants to turn a static/boring page into a narrative experience. Triggers on "cinematic", "3D journey", "immerzív oldal", "látványos átmenetek", "scroll sztori", "kamera mozgás", "parallax", "particle", "make it cinematic", "tedd filmszerűvé".
---

# Cinematic 3D Experience

## Purpose
This skill turns a flat website into a purposeful cinematic 3D journey. It plans and choreographs interactive scenes, camera moves, parallax depth, lighting, particles, and section reveals so that motion serves the story — not decoration. Every effect must earn its place by guiding the visitor's attention and reinforcing the narrative, while clarity, readability, and usability stay intact.

## When to use
- Peti wants a landing page, portfolio, or product site to feel like a film or immersive journey.
- Requests mention: cinematic, 3D scenes, camera movement, scroll-driven story, parallax layers, lighting, particle systems, depth transitions, immersive reveals.
- A static or "boring" page needs narrative flow and emotional pacing.
- Hungarian triggers: "tedd filmszerűvé", "látványos", "immerzív", "görgetős sztori", "kamera mozgás".

## Instructions
1. **Clarify the story first.** Ask Peti what the site's core message is, who the visitor is, and the one feeling they should leave with. No scene without a narrative reason.
2. **Map the journey.** Break the page into ordered scenes (Act 1 hook → build → climax → resolution/CTA). Give each scene a single job.
3. **For each scene, define the technique and its purpose:**
   - Camera movement (dolly, orbit, pan) → where the eye should go.
   - Parallax layers → establish depth and hierarchy.
   - Lighting effects → set mood and spotlight focal points.
   - Particle systems → texture/atmosphere, used sparingly.
   - Depth transitions → move between scenes without jarring cuts.
   - Immersive section reveals → unveil content as the story earns it.
4. **Bind motion to scroll.** Tie the timeline to scroll progress so the visitor controls pacing; scenes must feel deliberate, never runaway.
5. **Protect usability.** Keep text legible over 3D, provide `prefers-reduced-motion` fallbacks, ensure keyboard/mobile access, and keep performance smooth (lazy-load, throttle, GPU-friendly).
6. **Recommend the stack** (Three.js / React Three Fiber + GSAP ScrollTrigger) and note where each fits.
7. **Explain, don't just build.** For every scene, state in plain terms how it guides the visitor and advances the story.

## Output format
Deliver a structured plan (and code when asked):
- **Story spine** — one sentence, the through-line.
- **Scene breakdown table** — Scene name | Narrative job | Techniques used | How it guides the visitor.
- **Motion & camera notes** — timing, easing, scroll binding per scene.
- **Usability & performance guardrails** — reduced-motion, mobile, legibility, load strategy.
- **Implementation notes / code** — only when Peti asks to build, using English for all code and technical terms.

## Examples

**Input (Peti):** "Van egy sima SaaS landing oldalam, tedd filmszerűvé."
**Output:** Story spine ("A chaotic workflow becomes calm and controlled"). Scene table: Hero — orbit camera reveals a floating 3D dashboard (job: hook, shows the product hero); Problem — dark, particle-heavy fog scene (job: felt pain); Solution — light breaks through, depth transition pulls camera into a clean workspace (job: relief + clarity); CTA — camera settles, everything sharp and readable (job: decision). Each row explains the guiding intent; guardrails for reduced-motion and mobile included.

**Input (Peti):** "Csak a hero szekcióra kell egy cinematic kamera mozgás."
**Output:** Single-scene plan — a slow dolly-in on scroll with parallax background layers and a soft key light on the headline, scroll-bound easing, purpose stated (draw the eye to the value proposition), plus a static fallback for reduced-motion.

## Language rules
- Beszélj Petivel magyarul, természetes, közvetlen hangon — a magyarázatok, scene-leírások és javaslatok magyarul készülnek.
- Keep all code, library names, technical terms, and API identifiers in English (e.g. `ScrollTrigger`, `useFrame`, `camera.position`, `prefers-reduced-motion`).
- Peti a felhasználó neve — csak ezt a nevet használd, ha rá hivatkozol.

## What to avoid
- Effects with no narrative purpose — no motion for motion's sake.
- Sacrificing readability: never trap text behind busy 3D or low-contrast lighting.
- Ignoring accessibility — always ship a `prefers-reduced-motion` and mobile fallback.
- Performance killers: unthrottled scroll handlers, heavy particle counts, unoptimized/un-lazy-loaded assets.
- Scroll-jacking that steals control from the visitor.
- Overloading a page with too many scenes; pace the story, leave breathing room.
- Building silently — always explain how each scene guides the visitor.
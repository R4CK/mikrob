---
name: scroll-driven-3d-motion
description: Build creative, high-end motion and 3D web experiences -- scroll storytelling, Three.js/WebGL scenes, GSAP + ScrollTrigger scrubbed timelines, camera paths, fly-throughs and room/site walkthroughs, plus modern CSS animation (scroll-driven animations, View Transitions, clip-path/mask reveals). Use for landing/marketing/onboarding/hero and product showcases where wow-factor matters. Triggers: "scroll animation", "3D", "Three.js", "WebGL", "GSAP", "ScrollTrigger", "fly-through", "walkthrough", "scroll storytelling", "parallax", "camera path", "make it creative", "legyen kreatív", "látványos", "animáció".
---

# Scroll-Driven 3D & Creative Motion

The spectacle layer of Fron Ted's toolkit. Use AFTER the visual language
([[ui-visual-design-styles]]) and research ([[frontend-design-research]]) are set. For
*data* use [[d3-data-visualization]]; this is for *story and immersion*.

## When to use (and when NOT)
- **Use on:** marketing/landing pages, "how it works", onboarding hero, feature reveals,
  product/site showcases. A field-service SaaS fits: landing hero, a 3D site/zone **walkthrough**
  ("see how proof-of-work flows"), a scrolly explainer of the evidence chain.
- **Do NOT use on:** the daily operational surfaces — the field PWA core flows, dense
  Manager dashboards, forms, tables. Heavy WebGL drains battery and jank low-end phones;
  operational speed and clarity beat spectacle there. Motion serves the story, never the
  data-entry path.
- Rule: every effect must earn its weight in attention, load, and battery.

## Library map (pick the LIGHTEST tool that does the job)
Default order: native CSS → drop-in component → GSAP/Three only when the story needs it.
- **core-3d-animation** (engines + timeline core): **Three.js** (low-level WebGL 3D),
  **R3F / React Three Fiber** (Three.js declaratively in React — prefer in a React app),
  **Babylon.js** (batteries-included engine for complex/interactive scenes), **GSAP**
  (the timeline/scrub standard), **Motion** (motion.dev / Framer Motion — React-first
  declarative UI animation).
- **extended-3d-scroll** (scroll + specialized): **A-Frame** (declarative WebXR/VR),
  **Vanta.js** (instant animated backgrounds), **PlayCanvas** (full 3D game engine),
  **PixiJS** (fast 2D WebGL — particles, 2D FX), **Locomotive Scroll** (smooth-scroll +
  parallax), **Barba.js** (SPA page-transitions). Note: smooth-scroll hijacking can hurt
  a11y/perf — prefer native scroll-timeline; use Locomotive only when truly needed.
- **animation-components** (drop-in UI motion, cheapest wins): **React Spring** (physics
  springs in React), **Magic UI** (prebuilt animated React/Tailwind components), **AOS**
  (animate-on-scroll, simplest), **Anime.js** (lightweight JS timeline), **Lottie** (play
  After-Effects/JSON vector animations — great for icons/illustrations, watch payload).
- **authoring-motion** (asset tools, NOT runtime libs — they export, you embed): **Blender**
  (3D model/animate → glTF/Draco), **Spline** (web-first 3D design → embed/export),
  **Rive** (interactive vector animation → tiny runtime, ideal for stateful micro-anim).

Picking fast: React app → R3F + Motion/React Spring. Quick win → AOS / Vanta / Lottie /
Rive. Heavy showcase/walkthrough → Three.js (or Babylon) + GSAP ScrollTrigger. Authoring →
Spline/Rive/Blender export to glTF. Whatever you pick: code-split it, keep it OFF the
operational PWA bundle, and request the dep via MikroB's lockfile batch.

## Modern CSS first (no JS, no libs — reach here before Three.js)
Often the "creative" ask is achievable with pure CSS — cheaper and accessible:
```css
/* Scroll-driven animation: progress tied to scroll, no JS */
@keyframes reveal { from { opacity:0; translate:0 40px } to { opacity:1; translate:0 0 } }
.card{ animation: reveal linear both; animation-timeline: view(); animation-range: entry 0% cover 40%; }
/* Sticky scroll "scene" + clip-path/mask reveals, gradient/mesh backdrops, 3D transforms */
.panel{ transform: perspective(1000px) rotateY(8deg); transition: transform var(--dur) var(--ease); }
```
- **Scroll-driven animations** (`animation-timeline: scroll()/view()`) — native, GPU,
  honors reduced-motion. Progressive-enhance with `@supports (animation-timeline: scroll())`.
- **View Transitions API** for smooth route/state morphs.
- Composite-only props (`transform`, `opacity`, `clip-path`) — never animate layout.

## GSAP + ScrollTrigger (scrubbed timelines, the workhorse)
For choreographed, scrubbed-to-scroll sequences and pinning:
```js
gsap.registerPlugin(ScrollTrigger);
const tl = gsap.timeline({ scrollTrigger: {
  trigger: '#scene', start: 'top top', end: '+=2000', scrub: 1, pin: true } });
tl.to(camera.position, { z: 4, x: 1 })        // drive a Three.js camera along scroll
  .to('.caption', { opacity: 1 }, '<');
```
- `scrub` ties progress to scroll position; `pin` holds a section while the scene plays.
- Use `gsap.matchMedia()` to disable/replace heavy timelines on mobile + reduced-motion.
- `ScrollTrigger.refresh()` after layout/async content changes.

## Three.js / WebGL (3D scenes, camera paths, walkthroughs, fly-through)
```js
const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));         // cap DPR (perf)
// camera path: sample a CatmullRom curve, position camera by scroll progress t∈[0,1]
const curve = new THREE.CatmullRomCurve3(points);
function frame(t){ camera.position.copy(curve.getPointAt(t)); camera.lookAt(target); }
```
- **Room/site walkthrough & fly-through:** move the camera along a `CatmullRomCurve3`
  with `getPointAt(progress)`; drive `progress` from ScrollTrigger `scrub` or a scroll %.
  Add `lookAt` targets per segment for "look around the room" beats.
- **Load discipline:** lazy-import Three.js + load glTF (Draco/Meshopt compressed) only
  when the section nears viewport (IntersectionObserver). Show a poster image until ready.
- **Lifecycle:** one `requestAnimationFrame` loop; PAUSE it when the canvas is offscreen
  (IntersectionObserver) to save battery; `dispose()` geometries/materials/textures on
  unmount to avoid GPU leaks; handle context-loss.
- **Perf budget:** cap DPR ≤2, keep draw calls low, frustum-cull, bake lighting, compress
  textures (KTX2/Basis); target 60fps desktop / graceful 30fps mobile, or fall back.

## Accessibility & fallback (non-negotiable)
- `prefers-reduced-motion: reduce` → DISABLE scrubbed/auto motion; render the final/poster
  state. Provide a static image or short muted video as the no-WebGL / low-power fallback.
- Never trap scroll; the page must read and navigate with motion fully off.
- Keep text in real DOM (not baked into canvas) for SR/contrast; captions for any narrated 3D.
- `@supports`/feature-detect WebGL + scroll-timeline; degrade cleanly, never blank screen.
- Don't autoplay anything that flashes/strobes; respect data-saver where detectable.

## Dependencies (IMPORTANT in this repo)
Three.js, GSAP, ScrollTrigger are new deps — in a shared multi-agent checkout they go
through MikroB's lockfile batch. Do NOT add them yourself; request them, code-split them,
and keep them OFF the operational PWA bundle (separate marketing/landing entry).

## Pitfalls
- WebGL on operational/data screens → battery + jank; keep it to marketing/showcase.
- Animating layout props or uncapped DPR → dropped frames.
- No reduced-motion / no WebGL fallback → blank or unusable for some users.
- Loading a 30MB glTF up front → kills LCP; lazy-load + compress + poster.
- Not disposing Three.js objects / not pausing rAF offscreen → memory + battery drain.
- Effect with no narrative purpose ("3D because we can") → cut it.

## Verification (QA sign-off)
- [ ] Used only on marketing/onboarding/showcase, NOT operational PWA/dashboards.
- [ ] `prefers-reduced-motion` fully disables motion → clean static/poster state.
- [ ] WebGL/scroll-timeline feature-detected; graceful fallback, never a blank screen.
- [ ] Composite-only animation; DPR capped; 60fps desktop / acceptable mobile or degrade.
- [ ] 3D assets lazy-loaded + compressed + poster; rAF paused offscreen; objects disposed.
- [ ] Text stays in DOM (a11y/contrast); no scroll-trap; captions for narrated scenes.
- [ ] Three.js/GSAP code-split, off the operational bundle; deps via lockfile batch.

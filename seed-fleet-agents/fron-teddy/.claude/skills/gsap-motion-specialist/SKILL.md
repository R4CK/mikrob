---
name: gsap-motion-specialist
description: Deep GSAP motion engineering -- tweens, timelines, eases, stagger, ScrollTrigger (scrub/pin/snap), SVG animation (stroke draw, morph, motion path), text reveals, sequencing, and responsive/reduced-motion handling via matchMedia. Use for choreographed, production-grade web animation and scroll sequencing. Triggers: "GSAP", "ScrollTrigger", "timeline", "tween", "stagger", "SVG animation", "morph", "motion path", "animation sequence", "scroll sequence", "micro-interaction choreography".
---

# GSAP Motion Specialist

The choreography engine. [[scroll-driven-3d-motion]] covers when/where motion belongs and
the library map; THIS skill is GSAP depth. Prefer native CSS for simple cases
([[ui-visual-design-styles]]); reach for GSAP when you need sequenced, scrubbed, or
cross-element choreography CSS can't express.

## When to use
- Multi-step sequences, pinned scroll scenes, scrubbed timelines, SVG draw/morph.
- Driving a Three.js camera/timeline from scroll ([[threejs-specialist]]).
- Polished micro-interaction choreography beyond a single CSS transition.

## Core model: tween + timeline
```js
gsap.to('.box', { x:200, rotate:15, duration:0.6, ease:'power3.out' });
const tl = gsap.timeline({ defaults:{ ease:'power2.out', duration:0.5 } });
tl.from('.title', { y:40, opacity:0 })
  .from('.card', { y:30, opacity:0, stagger:0.08 }, '-=0.2')  // overlap with prev
  .to('.cta', { scale:1 }, '<');                              // start with prev
```
- **Timelines** sequence and overlap tweens; position params (`'<'`, `'-=0.2'`, labels)
  control timing. Build complex motion as one timeline, not scattered tweens.
- **Eases** carry the feel: `power`, `back`, `elastic`, `expo`, custom `CustomEase`.
- **Stagger** animates collections with cascade; use small values (0.05–0.1s).

## ScrollTrigger (scroll-linked motion)
```js
gsap.registerPlugin(ScrollTrigger);
gsap.timeline({ scrollTrigger:{
  trigger:'#scene', start:'top top', end:'+=1500',
  scrub:1, pin:true, snap:1/3 } })            // scrub ties progress to scroll
  .to('.layer', { yPercent:-30 });
```
- `scrub` = progress follows scroll; `pin` holds a section; `snap` clicks to steps;
  `toggleActions` for play/reverse on enter/leave (non-scrub).
- Call `ScrollTrigger.refresh()` after async content / layout shifts.
- Avoid stacking many heavy ScrollTriggers; batch with `ScrollTrigger.batch()`.

## SVG animation
- **Line draw:** animate `stroke-dashoffset` (native) or DrawSVGPlugin for robustness.
- **Morph:** MorphSVGPlugin tweens one path's `d` into another (logo morphs, shape change).
- **Motion path:** MotionPathPlugin moves an element along an SVG path (icons, particles).
- Keep SVGs optimized (SVGO); animate transforms/opacity, not layout-affecting attrs.

## Responsive + reduced-motion (REQUIRED)
```js
gsap.matchMedia().add({
  motionOk:'(prefers-reduced-motion: no-preference)',
  isDesktop:'(min-width: 768px)'
}, (ctx) => {
  const { motionOk, isDesktop } = ctx.conditions;
  if (!motionOk) return;                 // reduced-motion → no animation, final state shows
  if (isDesktop) { /* heavy timeline */ } else { /* lighter mobile variant */ }
});
```
- `matchMedia` auto-reverts animations when conditions change — the clean way to do
  responsive + reduced-motion. Always provide the reduced-motion no-op branch.

## Cleanup (SPA / React)
- Wrap in `gsap.context(() => {...}, scopeEl)` and `ctx.revert()` on unmount; `kill()`
  ScrollTriggers. Leaked triggers cause jank and memory growth across route changes.
- React: do setup in `useLayoutEffect`/`useGSAP`, revert in cleanup.

## Performance
- Animate compositor props (`x/y/scale/rotate/opacity` → transforms), not `top/left/width`.
- Let GSAP manage `will-change`; don't pin it globally. Use `gsap.ticker` not nested rAF.
- Lazy-load GSAP + plugins (dynamic import) on the surfaces that use them.

## Dependencies
GSAP + plugins (ScrollTrigger, and Club plugins DrawSVG/MorphSVG/MotionPath where
licensed) are new deps → request via MikroB's lockfile batch; code-split; keep off the
operational PWA bundle.

## Pitfalls
- No reduced-motion branch; animating layout props; leaked ScrollTriggers on route change.
- Forgetting `ScrollTrigger.refresh()` after async layout → misaligned triggers.
- Scrub timelines fighting native smooth-scroll libs; too many triggers → scroll jank.
- Using GSAP where one CSS transition would do (overkill + bundle weight).

## Verification (QA sign-off)
- [ ] `matchMedia` reduced-motion branch present → motion fully off renders final state.
- [ ] Compositor-only props; 60fps; no layout thrash.
- [ ] `gsap.context().revert()` / triggers killed on unmount; no leaks across routes.
- [ ] `ScrollTrigger.refresh()` after async content; triggers aligned at all breakpoints.
- [ ] GSAP/plugins code-split, off operational bundle; deps via lockfile batch.
- [ ] No scroll-trap; page usable with motion disabled.

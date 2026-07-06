---
name: threejs-specialist
description: Deep Three.js / WebGL engineering -- scene graph, cameras, lights & shadows, PBR materials, geometry, textures, the render loop, raycasting/interaction, GLTF/GLB loading, custom shaders, React Three Fiber, plus mobile/game-style architecture (ECS, instancing, LOD) and product configurators / 3D viewers. Use when BUILDING the actual 3D scene (not just scroll-wiring -- that's scroll-driven-3d-motion). Triggers: "Three.js", "WebGL", "R3F", "React Three Fiber", "shader", "GLTF", "GLB", "3D model", "3D configurator", "3D viewer", "Babylon", "mesh", "material", "lighting".
---

# Three.js Specialist (engine fundamentals + R3F)

The 3D-engine layer. [[scroll-driven-3d-motion]] wires scenes to scroll/story; THIS skill
builds the scene itself well. Sits on the visual language ([[ui-visual-design-styles]]).
Same hard rule: 3D belongs on marketing/showcase/configurator surfaces, NOT the operational
PWA core.

## When to use
- Building a Three.js scene: site/zone 3D walkthrough, product/equipment configurator,
  3D viewer for assets, landing hero geometry.
- Loading and presenting glTF/GLB models with correct lighting and materials.
- Writing or debugging custom shaders; optimizing a heavy scene for mobile.

## The five pillars
1. **Scene graph:** `Scene` → `Object3D`/`Group` → `Mesh(geometry, material)`. Transforms
   inherit down the tree. Keep a flat-ish hierarchy; name objects for traversal.
2. **Camera:** `PerspectiveCamera(fov, aspect, near, far)` for realism; `OrthographicCamera`
   for isometric/CAD. Update `aspect` + `updateProjectionMatrix()` on resize. Tight
   near/far improves depth precision.
3. **Lights & shadows:** `Ambient`/`Hemisphere` (fill) + `Directional` (sun, shadows) +
   `Point`/`Spot` (local). Shadows are expensive — enable per-light, cap `shadow.mapSize`,
   set the shadow camera frustum tight. Prefer baked lighting / lightmaps for static scenes.
4. **Materials (PBR):** `MeshStandardMaterial`/`MeshPhysicalMaterial` with metalness/
   roughness + an environment map (IBL) for realistic reflections. `MeshBasicMaterial`
   for unlit/UI. Reuse material instances; they're not free.
5. **Render loop:** one `requestAnimationFrame`; advance with a `THREE.Clock` delta (don't
   assume 60fps). PAUSE the loop when the canvas is offscreen (IntersectionObserver).

```js
const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));   // cap DPR — biggest mobile win
renderer.outputColorSpace = THREE.SRGBColorSpace;
const clock = new THREE.Clock();
function tick(){ const dt = clock.getDelta(); update(dt); renderer.render(scene, camera);
  raf = requestAnimationFrame(tick); }
```

## Interaction (raycasting)
```js
const ray = new THREE.Raycaster();
function onPointer(e){ ray.setFromCamera(ndc(e), camera);
  const hit = ray.intersectObjects(pickables, true)[0]; /* hover/select */ }
```
- Maintain a `pickables` list (don't raycast the whole scene). Throttle on pointermove.
- For configurators: raycast to select a part, swap its material/variant, animate the change.

## Loading assets (glTF is the standard)
- `GLTFLoader` + **DracoLoader/Meshopt** for compressed geometry; **KTX2** for textures.
- Lazy-load models only when the section nears viewport; show a poster until ready.
- Budget: keep models small (compress, decimate in Blender); a 30MB GLB kills LCP.
- Authoring pipeline: Blender/Spline → glTF/GLB → optimize (gltf-transform) → load.

## React Three Fiber (R3F) — when the app is React
Declarative Three.js: `<Canvas>` + JSX meshes; `useFrame` for the loop; `@react-three/drei`
for helpers (OrbitControls, Environment, useGLTF, Bounds). Cleanup is automatic on unmount.
Prefer R3F in a React codebase — it composes with state and is easier to maintain than
imperative Three. Babylon.js is the alternative when you need a heavier built-in engine.

## Performance & mobile (the part that ships or doesn't)
- Cap DPR ≤2; reduce shadow/AA on mobile via feature/perf detection.
- **Instancing** (`InstancedMesh`) for many repeated objects; **LOD** for distance.
- Merge geometries, minimize draw calls and material switches; frustum-cull (default on).
- **Dispose** geometries/materials/textures on teardown; handle WebGL context-loss.
- Game-style scale: an **ECS** (entities/components/systems) + TypeScript keeps large
  interactive scenes maintainable; keep systems pure and data-oriented.

## Accessibility & fallback (non-negotiable)
- `prefers-reduced-motion` → freeze auto-motion, render a static frame.
- No-WebGL / low-power → poster image or video fallback; never a blank canvas.
- Keep labels/captions in real DOM (not baked into the canvas) for SR + contrast.

## Dependencies
Three.js / R3F / drei / Babylon are new deps — request via MikroB's lockfile batch,
code-split, and keep OFF the operational PWA bundle (separate showcase entry).

## Pitfalls
- Uncapped DPR / overusing shadows → mobile jank. Not disposing → GPU memory leak.
- Huge uncompressed GLB → terrible load. Wrong color space → washed-out look.
- Raycasting the whole scene each move; re-creating materials per frame.
- 3D on operational screens; effect with no purpose.

## Verification (QA sign-off)
- [ ] DPR capped; 60fps desktop / acceptable mobile or graceful degrade.
- [ ] glTF compressed (Draco/KTX2), lazy-loaded + poster; LCP not harmed.
- [ ] rAF paused offscreen; all objects disposed on teardown; context-loss handled.
- [ ] `prefers-reduced-motion` + no-WebGL fallbacks; DOM text for a11y.
- [ ] Correct color space / tone mapping; reused materials; low draw calls.
- [ ] Used only on showcase/configurator surfaces; deps code-split via lockfile batch.

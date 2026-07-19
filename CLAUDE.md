# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A WebGL2 art piece simulating a faceted cola glass on a sunlit table, with photon-traced caustics, a raymarched glass render, and procedural cicada audio. No build system, no dependencies, no tests. Three files, loaded as plain scripts (no modules):

- `index.html` — markup, CSS, the slider UI, and the two script tags
- `shaders.js` — all GLSL sources as JS template strings (kept in `.js` rather than `.glsl` files so the page works over `file://`, where `fetch()` is blocked)
- `main.js` — GL plumbing, UI reading, audio synthesis, and the render loop

`glass-caustics-sim_33.html` is the original single-file version, kept as a reference/backup; don't edit it.

**Run it:** open `index.html` in a browser (`open index.html`). Requires WebGL2 with `EXT_color_buffer_float`. Debug via the browser console — shader compile errors are thrown with line-numbered source.

## Architecture

The critical design idea: **one shared glass model drives every pass**, so the photon tracing, the visible render, and the shadows all agree about the glass geometry.

- **`SHARED`** (GLSL string in `shaders.js`): the glass model — a **parameterized surface of revolution**: `profileR(y)` is a Catmull-Rom spline through 8 radius knots (`u_prof[8]`, spanning `u_y0..u_H`) with an analytic stem+foot below `u_y0` for stemware. On top of it: the pattern height field (`facetPattern`, dispatched by `u_pat`: diamond/ribs/spiral/hobnail), `outerRadius`/`outerNormal`, wall thickness (`wallAt`), inner-surface helpers (`innerR`, `innerNormal`, `innerChord` — iterated cylinder chord against the revolved profile), condensation, wall bubbles (`bubbleAt`), and the 3 lights with leaf-dapple masks (`dapple`). It is string-interpolated into **both** the photon vertex shader and the composite fragment shader. Any change to the glass shape must go here, or the caustics and the rendered glass will disagree.

- **Preset tables in `main.js`** drive the generative diversity: `SHAPES` (radius knots + stem/foot per glass family), `TIMES` (full light environments: sun angle/colour, sky/leaf/ground palette, penumbra; `night` preset = string-light bulbs + stars instead of a sun), `LIQUIDS` (absorption hex, turbidity, fizz, refractive index, scatter colour). The `randomize()` function deals coherent combinations (shape→liquid compatibility, ice only in tumblers with a ≥50% cold pour) by **setting the DOM controls** — `frame()` reads controls every frame, so there is no parallel state, except a few seed variables (`spillSeed`, `canRot`, `tabRot`) rolled per deal. `#randtest` in the URL hash hammers it 60× for smoke-testing.

- **Environment**: `canopyField()` in SHARED defines what hangs overhead (broadleaf / fine leaf / palm / pergola / parasol via `u_canopy`); the dapple and the visible sky canopy both read it, so shade always matches reflections. Palm/parasol anchor to `u_canopyC` (the glass projected up the sun ray) so their shade lands on the glass. Table surfaces (stone/wood/tiles/concrete via `u_table`) are procedural albedo in the COMP table branch. Caustic exposure is auto-compensated in `main.js` (window-area dilution + expected liquid/mist absorption, capped 5×).

- **`PHOTON_VS`**: attribute-less vertex shader; each of the 512×288×3 vertices (`gl_VertexID`) is one photon from one light, refracted through entry facet → wall → interior (cola with Beer–Lambert absorption, or air) → far wall → exit facet, landing as a point splat on the table. Runs twice per frame: `u_mode 0` = transmitted caustic, `u_mode 1` = Fresnel-reflected arc. Per-photon wavelength gives dispersion. `kill()` discards a photon by moving it off-clip.

- **Render pipeline per frame** (in `frame()`): the previous frame's 1024² RGBA16F caustic buffer is copied with ~0.90 decay into its ping-pong partner (`FADE_FS`), then this frame's photons are additively splatted on top — a rolling accumulation of ~10 frames that denoises the caustic; the photon hashes take a per-frame `u_seed` so each frame samples new photons. Then: separable Gaussian blur into a 512² buffer (soft halo) → `COMP_FS` full-screen composite (raymarches the glass SDF `sdGlass`, shades cola/table/courtyard `envColor`, samples both caustic textures) into a full-res HDR scene target → bloom (`BRIGHT_FS` threshold at quarter res, blurred with `BLUR_FS`) → `FINAL_FS` adds bloom and applies the camera artifacts (handheld wobble, corner chromatic aberration, far-field depth of field) plus vignette/tonemap/grain to screen. `COMP_FS` outputs linear HDR with the hit distance in alpha (the DoF pass depends on that); all finishing lives in `FINAL_FS`.

- **Caustic texture mapping**: photons splat into a table window mapped by `clip = (hit.xz - u_caustC)/u_caustS`; the composite reverses this exact mapping when sampling `u_caust`. Both sides use the same shared uniforms (computed in `main.js` from the main sun direction — a low sun gets a longer window), so they stay in sync by construction.

- **JS side** (`main.js`): UI sliders are read every frame and pushed as uniforms (`setShared` for values needed by both programs). Color pickers become absorption spectra via Beer–Lambert (`sigFrom`). Lights sway with a procedural wind/gust system (`snz` 1D noise) shared with the audio. `buildAudio()` synthesizes cicadas with Web Audio (band-passed noise gated by ~112 Hz click trains); the leaf-rustle gain is driven from the render loop's gust envelope.

## Conventions

- `shaders.js` and `main.js` are classic scripts sharing top-level globals; `shaders.js` must load first (script order in `index.html`).
- GLSL uniforms are prefixed `u_`; uniform locations are fetched lazily via a Proxy (`U(prog)`), so a typo'd uniform name fails silently — check names carefully.
- Comments in the shaders explain physical intent (why, not what); keep that style.

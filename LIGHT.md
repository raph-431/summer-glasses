# How the light works

A tour of the rendering in `shaders.js` — the light transport only, not the
glassware generation. (For the shape model — the spline profile, patterns,
stems — see `SHARED` in `shaders.js` and the CLAUDE.md architecture notes.)

**Short answer to "is this an SDF renderer?": only half of it.** The photons
never march an SDF — they use closed-form geometry. The camera does march one,
but it is built from the same analytic surface the photons refracted through.
The two systems meet at a texture.

## Two directions of light

Every frame runs light in both directions:

1. **Forward** — photons leave the lights, refract through the glass, and land
   on the table. This builds the caustic.
2. **Backward** — one eye ray per pixel raymarches the scene and *reads* what
   the photons wrote.

## 1. The photon pass (`PHOTON_VS`)

The unusual part: a **vertex shader with no geometry**. Each draw call issues
512×288 points per light slot with no attributes at all; `gl_VertexID` *is*
the photon. The vertex shader computes where that photon lands and places the
point there; the fragment side just splats its colour.

Each photon:

- **Starts at a light.** In paint mode, slots 0/1 pick a random point on the
  neon hoop's tube (the jitter along the tube IS the penumbra — a tight
  emission arc gives lace, a wide one gives glow); slot 2 is the distant sun,
  a plain direction with a little angular softness. `u_mode 2` is a separate
  pass for the bulb: a true point source inside the vessel.
- **Refracts analytically.** Entry point and normal come from the
  surface-of-revolution functions (`outerPos` / `outerNormal` — spline profile
  plus facet relief). Then it is textbook optics: Fresnel at entry (mode 1
  keeps the reflected energy and bounces it to the floor as the bright arc;
  mode 0 keeps the transmitted part), `refract()` into the glass, a chord
  across the wall thickness, `refract()` again at the inner wall, across the
  interior, out the far wall. The solid base is one thick chord with
  Beer–Lambert absorption. Anything that goes wrong — total internal
  reflection, an upward exit, the metal skin, the gilded rim — calls `kill()`,
  which just moves the point off-clip.
- **Carries one wavelength.** A per-photon random hue-shifted colour (`chCol`)
  means red and blue photons bend slightly differently — dispersion emerges
  statistically instead of being painted on.
- **Lands on the table plane** (`y = 0`, a line–plane intersection — no
  marching) and is written to clip space via a fixed mapping:
  `clip = (hit.xz − u_caustC)/u_caustS`. It renders as a 1.5 px additive point
  into a 2048² float buffer.

There is no SDF anywhere in this pass: every intersection is either
closed-form (plane, cylinder chord, quadratic) or a one-step wall-thickness
estimate.

## 2. The long exposure

Each frame, the previous caustic buffer is copied into its ping-pong twin
multiplied by `PAINT_DECAY = 0.997`, then the new photons splat on top. That
is an exponential moving average with a time constant of ~333 frames — about
5.5 s at 60 fps (≈ 63% charged; ~90% by 13 s, ~99% by 25 s). It is the "film"
that lets a noisy 442k-photon frame accumulate into smooth filaments.

Photon launch positions are re-jittered every frame (`u_seed`), so successive
frames sample *different* photons and the average converges rather than
repeats. A Gaussian-blurred copy of the buffer provides the soft halo layer,
and a small CPU-side readback (48×48, every 20 frames) drives the
auto-exposure servo in `main.js` that scales photon energy — it projects the
still-charging buffer forward (`1 − decayⁿ`) so a fresh deal doesn't start
dark and bloom late.

(Realistic mode uses the same machinery with `CAUST_DECAY = 0.90` — a
~10-frame window that only denoises. `steadyFix` in `main.js` rescales photon
energy so both decays settle to comparable brightness.)

## 3. The eye pass (`COMP_FS`) — where the SDF lives

Each pixel shoots one camera ray. The glass is intersected by
**sphere-tracing `sdGlass`**: a genuine signed distance field, but built from
*the same* profile functions the photons used — distance to the revolved
outer surface (with a slope correction that keeps the field ~Lipschitz on
steep profiles), rounded-intersected with the top and bottom planes, minus
the inner cavity. A bounding-cylinder test culls rays before the march. That
shared geometry is the core design guarantee of the whole piece: the caustic
on the floor and the glass you see were computed from one shape and cannot
disagree.

The table needs no marching — it is the `y = 0` plane — and once hit, the
shader **inverts the exact splat mapping** to sample the caustic textures:
sharp filaments ×1.45 plus a whisper of the blurred halo (×0.35, then a 0.88
gamma lift). In paint mode that pool *is* the subject.

The visible glass itself is deliberately not physical refraction (no
recursive marching through the wall). It is a "ghost" — Fresnel edge glow ×
facet pattern — plus a stack of analytic light responses:

- **Bottom lens.** On upward-facing base surfaces the view ray is refracted
  once into the slab and the caustic texture is re-sampled where the bent ray
  meets the table — warped, magnified filaments seen *through* the base,
  tinted by the glass body. (One knowing lie: the slab's underside interface
  is skipped.) A faint striated "glow-floor whisper" in the deal's own hue
  keeps any bottom from reading as pure void.
- **Mirrored hoops.** Reflect the view ray, intersect it with each hoop's
  plane analytically, glow by distance to the circle (hot core + halo
  Gaussians). On top, **diamond fire**: three slightly offset radii give RGB
  fringes that only the cut facets carry, flashing as a facet's reflection
  sweeps the tube.
- **Fill-hoop wash.** Slot 1 casts no caustics; it only models the vessel — a
  Lambert wash plus a Fresnel-weighted gleam from its side of the void.
- **Bulb glints and the sun glint.** Phong-style terms against the reflected
  ray; the metal skin swaps the response to an opaque mirror in the metal's
  own colour and blocks the pool shining through.

Lights seen *directly* (the bulb) are also analytic — closest approach of the
view ray to a point, mapped through a Gaussian for a hot core plus halo.
Nothing about a light source is ever marched.

## 4. Finishing

`COMP_FS` writes linear HDR with the hit distance in alpha. Then: bright-pass
at quarter res → blur → bloom add in `FINAL_FS`, which also does tonemap,
vignette, grain, and the paper negative (`col = u_paperCol × (1 − col)`).
When the camera holds still, a sub-pixel jitter (`u_jit`, 8-point pattern)
plus a full-res accumulator supersamples the frame temporally; any camera
motion resets it.

## The one-line summary

**One analytic glass model, used three ways**: closed-form refraction for the
forward photons, an SDF wrapper around the same surface for the backward eye
rays, and a shared table-space mapping that lets the second pass read the
first one's light.

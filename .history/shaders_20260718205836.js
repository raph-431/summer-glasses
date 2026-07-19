'use strict';
// ---------------------------------------------------------------------------
// All GLSL lives here, as template strings. Kept in .js (not .glsl files)
// so the page still works over file:// where fetch() is blocked.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared GLSL: 1) THE GLASS MODEL — a cut tumbler with a diamond-quilted wall.
// The same surface functions drive photon refraction, the raymarched render,
// and the shadows, so everything agrees about what the glass is.
// ---------------------------------------------------------------------------
const SHARED = `
precision highp float;

const float NGLASS = 1.50;  // refractive index of the glass
const float CANOPY = 2.6;   // height of the leaf canopy casting dapple

// ---- the glass PROFILE: a surface of revolution ---------------------------
// Outer radius over height comes from 8 spline knots (the bowl), with an
// analytic stem + foot below u_y0 for stemware. Every consumer — photon
// tracer, raymarcher, shadows — reads this one function, so they always
// agree about what the glass is.
uniform float u_prof[8];    // outer radius knots, y in [u_y0 .. u_H]
uniform float u_H;          // rim height
uniform float u_y0;         // bowl bottom (0 for tumblers)
uniform float u_stemR;      // stem radius (stemware only)
uniform float u_footR;      // foot radius
uniform float u_footH;      // foot thickness
uniform float u_cavY;       // cavity floor: top of the solid base / bowl base
uniform float u_maxR;       // widest radius incl. foot
uniform float u_baseR;      // radius at the table (contact shadow, puddle)

// the caustic accumulation window on the table: the photon pass splats into
// it and the composite samples out of it with the SAME mapping, so it can
// follow the sun (low sun = long window thrown down-light)
uniform vec2  u_caustC;     // window center on the table (xz)
uniform float u_caustS;     // window half-width

uniform float u_facet;      // facet depth multiplier
uniform float u_wall;       // wall thickness scale (adjustable glassware depth)
uniform float u_liq;        // cola fill height
uniform float u_diam;       // diamond aspect: height vs width
uniform float u_diamN;      // diamonds around the circumference
uniform float u_cond;       // condensation intensity
uniform float u_irr;        // manufacturing irregularity
uniform vec3  u_liqSig;     // liquid absorption spectrum (from the colour picker)
uniform vec3  u_liqGlow;    // liquid forward-scatter colour (derived)
uniform vec3  u_glassSig;   // glass absorption spectrum (from the tint picker)
uniform float u_turb;       // liquid turbidity: 0 clear cola .. 1 opaque juice
uniform vec3  u_scatCol;    // body colour a turbid liquid scatters back
uniform float u_nLiq;       // liquid refractive index
uniform float u_fizz;       // carbonation intensity
uniform float u_iceN;       // ice cubes in the drink (0..3)
uniform vec3  u_icePos[3];  // cube centers
uniform float u_iceR[3];    // cube half-sizes
uniform float u_iceRot[3];  // cube y-rotations
uniform float u_bub;        // bubbles seeded in the glass wall (0..1)
uniform float u_bubSize;    // seed size scale (cell scales too: big = fewer)
uniform float u_rim;        // metallic painted rim: 0 off, 1 on
uniform vec3  u_rimCol;     // rim metal colour (gold by default)

float hash12(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453123); }
vec2  hash22(vec2 p){
  return fract(sin(vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3))))*43758.5453);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x),
             mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x), f.y);
}
float fbm(vec2 p){
  float v=0.0, a=0.5;
  for(int i=0;i<4;i++){ v+=a*vnoise(p); p=p*2.03+vec2(17.3,9.1); a*=0.5; }
  return v;
}

// Catmull-Rom through the radius knots: C1, passes through every knot
float profileR(float y){
  y = max(y, 0.0);
  float x = clamp((y - u_y0)/max(u_H - u_y0, 1e-3), 0.0, 1.0)*7.0;
  int i = int(min(floor(x), 6.0));
  float f = x - float(i);
  float p0 = u_prof[max(i-1,0)], p1 = u_prof[i];
  float p2 = u_prof[min(i+1,7)], p3 = u_prof[min(i+2,7)];
  float bowl = 0.5*(2.0*p1 + (-p0+p2)*f + (2.0*p0-5.0*p1+4.0*p2-p3)*f*f
             + (-p0+3.0*p1-3.0*p2+p3)*f*f*f);
  if(u_y0 < 0.01) return bowl;    // tumblers sit straight on the table
  // the foot: a thin disc whose top is slightly domed, sweeping smoothly
  // into the stem — no hard ledge for the raymarcher to alias on
  float t = y/max(u_footH, 1e-3);
  float k = pow(smoothstep(0.30, 3.0, t), 1.4);
  float disc = u_footR * (1.0 - 0.05*clamp(t, 0.0, 1.0));
  float stem = max(mix(disc, u_stemR, k), u_stemR);
  // blown in one piece: the stem flares smoothly into the bowl underside
  // instead of meeting it at a hard step
  float h = smoothstep(u_y0 - 0.09, u_y0 + 0.09, y);
  return mix(stem, bowl, h);
}
float profileSlope(float y){ return (profileR(y+0.01) - profileR(y-0.01))*50.0; }

// real tumblers taper: chunky at the base, a fine thin lip at the top.
// The thickness also wanders a little around the glass, like moulded or
// hand-finished ware — nothing about a real wall is perfectly even.
float wallAt(float th, float y){
  float base = u_wall * mix(1.30, 0.25, smoothstep(u_y0, u_H, y));
  // sampled on the unit circle so the noise tiles seamlessly around the glass
  vec2 c1 = vec2(cos(th), sin(th));
  float irr = (vnoise(c1*1.4 + vec2(2.0 + y*1.1, y*2.4)) - 0.5)
      + 0.5*(vnoise(c1*3.1 + vec2(8.3, y*5.1)) - 0.5);
  // clamped so extreme irregularity (or a tiny wall slider) can never thin
  // the shell below what the raymarcher can resolve — the glass would vanish
  return max(base * max(1.0 + 0.28*u_irr*irr, 0.25), 0.012);
}

// tiny air bubbles trapped in the wall during manufacture:
// mask + in-bubble offset, seeded on the wall-coordinate grid
// one layer of seeds: cell grid, presence clustered into drifts by low-freq
// noise, radii drawn from a power law (mostly small, the odd large one)
vec3 bubbleLayer(vec2 s, float cell, float seed, float rare){
  vec2 id = floor(s/cell);
  vec2 rnd = hash22(id*2.13 + seed);
  float clump = fbm(id*cell*3.1 + seed*1.7) - 0.5;
  float present = step(rare - 0.75*u_bub, hash12(id + seed*3.7) + 0.45*clump);
  vec2 c = (id + 0.3 + 0.4*rnd)*cell;
  vec2 dd2 = s - c;
  // seeds stretch along the draw direction while the glass is worked
  dd2.x *= 1.0 + 2.2*hash12(id*4.3 + seed + 7.9);
  float h2 = hash12(id*3.7 + seed + 1.1);
  float rmin = cell*0.10, rmax = cell*0.34;
  float k = pow(rmin/rmax, 1.3);
  float r = rmin * pow(1.0 - h2*(1.0 - k), -1.0/1.3);
  float mask = present * smoothstep(r, r*0.55, length(dd2));
  return vec3(mask, dd2/max(r, 1e-5));
}
// the full population: rare large seeds, a mid layer, sub-pixel dust —
// a size continuum like real seeded glass, not one stamp
vec3 bubbleAt(vec2 s){
  if(u_bub < 0.01) return vec3(0.0);
  float cs2 = 0.022*u_bubSize;
  vec3 bb = bubbleLayer(s, cs2*2.6, 3.1, 1.22);
  vec3 b2 = bubbleLayer(s + 13.7, cs2, 17.0, 0.95);
  vec3 b3 = bubbleLayer(s + 41.3, cs2*0.45, 29.0, 0.80);
  if(b2.x > bb.x) bb = b2;
  if(b3.x > bb.x) bb = b3;
  return bb;
}

// --- condensation on the wall ------------------------------------------
// s = (arc length around the glass, height). One droplet per grid cell,
// randomly present, random size/offset -> mask + in-drop coords.
vec4 dropLayer(vec2 s, float cell, float seed, float rare){
  vec2 id = floor(s/cell);
  float h1 = hash12(id + seed*3.17);
  float h2 = hash12(id*2.3 + seed + 7.7);
  vec2 rnd = hash22(id*1.71 + seed);
  vec2 hh  = hash22(id*3.7 + seed + 4.2);

  // clustered presence: patchy clumps, not a uniform sprinkle
  float clump = fbm(id*cell*2.8 + seed) - 0.5;
  float present = step(rare, h1 + 0.45*clump);

  // power-law radii: p(r) ~ r^-2.2 between rmin..rmax (inverse-CDF sample)
  float rmin = cell*0.075, rmax = cell*0.44;
  float k = pow(rmin/rmax, 1.2);            // alpha-1 = 1.2
  float r = rmin * pow(1.0 - h2*(1.0 - k), -1.0/1.2);

  vec2 c = (id + 0.25 + 0.5*rnd)*cell;
  vec2 dd = s - c;
  // irregular blob: random aspect, gravity sag, lobed outline (merged drops)
  dd.x *= 1.0 + 0.5*(hh.x - 0.5);
  dd.y *= 0.72 + 0.35*hh.y;
  float ang = atan(dd.y, dd.x);
  float lump = 1.0 + 0.16*sin(ang*3.0 + hh.x*6.2831)
                   + 0.11*sin(ang*5.0 + hh.y*6.2831);
  float dist = length(dd)*lump;

  float mask = present * smoothstep(r, r*0.66, dist);
  return vec4(mask, dd/max(r,1e-5), r);
}
// misty film: strongest around the middle of the glass, patchy
float mistAmount(vec2 s){
  float band = smoothstep(u_y0 + 0.02, u_y0 + 0.20, s.y) * smoothstep(u_H*0.83, u_H*0.48, s.y);
  float thm = s.x/0.27;                     // recover the angle; tile the fog
  float blotch = 0.65 + 0.55*fbm(vec2(cos(thm), sin(thm))*1.6 + vec2(2.2, s.y*4.5));
  return 0.62 * band * blotch * u_cond;
}
// trails where drops ran down and wiped the fog
float rivulet(vec2 s){
  float laneW = 0.075;
  float lane = floor(s.x/laneW);
  float on = step(0.45, hash12(vec2(lane, 3.3)));
  float wig = (fbm(vec2(lane*7.7, s.y*2.4)) - 0.5)*laneW*1.1;
  float cx = (lane + 0.5)*laneW + wig;
  float w = laneW*(0.10 + 0.10*hash12(vec2(lane, 9.1)));
  float tr = exp(-pow((s.x - cx)/w, 2.0));
  float ys = (0.35 + 0.55*hash12(vec2(lane, 5.7))) * (u_H/1.15);   // trail head; runs down from here
  tr *= smoothstep(ys, ys - 0.08, s.y);
  return on*tr;
}

// Surface pattern height field on the wall. u_pat selects the cut:
// 0 smooth, 1 diamond quilt, 2 vertical optic ribs, 3 spiral ribs,
// 4 hobnail bead grid. All share the count/aspect sliders.
uniform float u_pat;
float facetPattern(float th, float y){
  if(u_pat < 0.5) return 0.0;
  float m = u_diamN;             // repeats around the circumference
  // rows track the count so the aspect slider keeps its meaning
  float rows = (3.0 * u_diamN/16.0) / max(u_diam, 0.2);
  float band = smoothstep(u_y0 + 0.06, u_y0 + 0.18, y) * (1.0 - smoothstep(u_H - 0.35, u_H - 0.18, y));
  if(u_pat < 1.5){
    // diamond quilt: two triangle waves in helical coordinates make a
    // lattice of little pyramids = the cut facets
    float a = th*(m/6.2831853) + y*rows;
    float b = th*(m/6.2831853) - y*rows;
    float ta = 1.0 - abs(fract(a)-0.5)*2.0;   // 1 at ridge, 0 at groove
    float tb = 1.0 - abs(fract(b)-0.5)*2.0;
    return min(ta, tb) * band;               // flat faces, sharp ridges
  }
  if(u_pat < 2.5){
    // vertical optic ribs (max() keeps pow off negative bases -> no NaN)
    return pow(max(0.5 + 0.5*cos(th*m), 0.0), 1.6) * band;
  }
  if(u_pat < 3.5){
    // spiral ribs: twisted optic, twist rate rides the aspect slider
    return pow(max(0.5 + 0.5*cos(th*m + y*rows*3.5), 0.0), 1.6) * band;
  }
  // hobnail: hemispherical beads on a grid
  vec2 g = vec2(fract(th*(m/6.2831853)), fract(y*rows)) - 0.5;
  return sqrt(max(0.25 - dot(g,g)*2.4, 0.0)) * 1.9 * band;
}
float patAmp(){
  // cut depth per pattern: beads bulge more than cut facets
  if(u_pat < 1.5) return 0.010;
  if(u_pat < 3.5) return 0.014;
  return 0.020;
}
// manufacturing irregularity, shared by BOTH wall surfaces (a slumped glass
// deforms as a whole): wobble wisps + past irr = 1 a gentle ovality. Keeping
// inner and outer in step means irregularity can never thin the wall.
float irrOffset(float th, float y){
  vec2 cw = vec2(cos(th), sin(th));
  float wob = (vnoise(cw*1.6 + vec2(3.0 + y*0.9, y*2.6)) - 0.5)
            + 0.5*(vnoise(cw*3.3 + vec2(9.2, y*5.3)) - 0.5);
  return 0.0035*u_irr*wob + 0.010*max(u_irr - 1.0, 0.0)*sin(2.0*th + 1.7);
}
float outerRadius(float th, float y){
  // smaller/denser cuts are shallower, like real glassware
  return profileR(y) + u_facet*patAmp()*sqrt(16.0/u_diamN)*facetPattern(th, y)
       + irrOffset(th, y);
}
vec3 outerPos(float th, float y){
  float r = outerRadius(th, y);
  return vec3(cos(th)*r, y, sin(th)*r);
}
// numeric surface normal (outward)
vec3 outerNormal(float th, float y){
  float e = 0.006;
  vec3 p0 = outerPos(th, y);
  vec3 dth = outerPos(th+e, y) - p0;
  vec3 dy  = outerPos(th, y+e) - p0;
  return normalize(cross(dy, dth));
}
vec3 smoothNormal(float th, float y){
  // local cone normal ignoring facets
  vec3 rad = vec3(cos(th), 0.0, sin(th));
  return normalize(rad - vec3(0.0, profileSlope(y), 0.0));
}
float innerR(float th, float y){ return max(profileR(y) + irrOffset(th, y) - wallAt(th, y), 0.03); }
vec3 innerNormal(vec3 P){
  // inner-wall normal, pointing into the cavity
  vec3 rad = normalize(vec3(P.x, 0.0, P.z));
  return normalize(rad - vec3(0.0, profileSlope(P.y), 0.0));
}
// far intersection of a ray with the inner surface of revolution: solve a
// cylinder at the endpoint's height, re-evaluate there, iterate — converges
// fast because interior chords span a limited y-range
float innerChord(vec3 P, vec3 d){
  float s = -1.0;
  float rEnd = innerR(atan(P.z, P.x), P.y);
  for(int k=0;k<3;k++){
    float a = dot(d.xz, d.xz);
    float b = 2.0*dot(P.xz, d.xz);
    float c = dot(P.xz, P.xz) - rEnd*rEnd;
    float disc = b*b - 4.0*a*c;
    if(disc <= 0.0 || a < 1e-6) return -1.0;
    s = (-b + sqrt(disc))/(2.0*a);
    vec3 Q = P + d*s;
    rEnd = innerR(atan(Q.z, Q.x), clamp(Q.y, u_cavY, u_H));
  }
  return s;
}

// ---------------------------------------------------------------------------
// 2) THE LIGHTS — a few suns, really: gaps in the foliage. Each has its own
// direction (swaying with the wind), colour, intensity, and its own drifting
// leaf-shadow mask sampled up at the canopy plane.
// ---------------------------------------------------------------------------
const int NL = 3;
uniform vec3  u_lightDir[NL];   // normalized, pointing DOWN into the scene
uniform vec3  u_lightCol[NL];   // colour * intensity
uniform vec2  u_dappleOff[NL];  // canopy drift
uniform float u_leaf;
uniform float u_canopy;         // 0 broadleaf, 1 fine leaf, 2 palm, 3 pergola, 4 parasol
uniform vec2  u_canopyC;        // the glass, projected up the sun ray onto the
                                // canopy plane: anchors palm/parasol so their
                                // shade actually falls on the glass

// what hangs overhead, sampled on the canopy plane. Returns x = openness
// (1 = light through) and y = a detail value used to colour the cover.
// The dapple AND the visible sky both read this one field, so the shade on
// the table always matches the canopy seen in the reflections.
vec2 canopyField(vec2 cp, vec2 off){
  if(u_canopy < 0.5){
    // broadleaf clumps (the original tree)
    float n1 = fbm(cp*0.55 + off);
    float n2 = fbm(cp*1.20 - off*1.4 + 4.7);
    float m = smoothstep(0.42, 0.60, n1*0.62 + n2*0.46);
    return vec2(m, n2);
  }
  if(u_canopy < 1.5){
    // fine-leafed tree (olive, acacia): busier clumps, many small gaps
    float n1 = fbm(cp*1.5 + off*1.3);
    float n2 = fbm(cp*3.1 - off*1.8 + 9.2);
    float m = smoothstep(0.45, 0.56, n1*0.55 + n2*0.52);
    return vec2(m, n2);
  }
  if(u_canopy < 2.5){
    // palm seen from below: two rings of pinnate fronds around a solid
    // crown. Each frond = a thin rib with dense diagonal leaflets and sky
    // slits between them, tapering to a tip at its own random length.
    // The crown sits just off the glass's sun-projection so the feathered
    // shade falls across the glass; the whole tree is scaled up so its
    // fronds dominate the sky like a real palm overhead.
    vec2 q = (cp - u_canopyC - vec2(1.3, 0.9) - off*0.3)/4.2;
    float rr2 = length(q);
    float ang = atan(q.y, q.x);
    float cover = 0.0;
    for(int L=0; L<2; L++){
      float nf = 13.0;
      float a2 = ang + float(L)*(0.24 + 3.14159/nf);   // second ring rotated
      float fsec = 6.2831853/nf;
      float fid = floor((a2 + 3.14159)/fsec) + float(L)*40.0;
      float fa = mod(a2 + 3.14159, fsec) - fsec*0.5;
      float flen = (2.2 + 1.4*hash12(vec2(fid, 5.1))) * (L == 0 ? 1.0 : 0.62);
      float fr2 = rr2/flen;                            // position along the frond
      float lat = abs(fa)*max(rr2, 0.05);              // arc distance to the rib
      float wid = max(0.30*smoothstep(0.05, 0.5, fr2)*(1.0 - smoothstep(0.55, 1.0, fr2)), 1e-3);
      float env = smoothstep(wid, wid*0.72, lat);
      // pinnate leaflets: herringbone slits angling off both sides of the rib
      float leaflet = 0.5 + 0.5*sin(rr2*26.0 + lat*34.0*sign(fa) + fid);
      float rib = smoothstep(0.020, 0.008, lat);
      float fm = env * (0.25 + 0.75*smoothstep(0.25, 0.55, leaflet));
      fm = max(fm*0.9, rib*env);
      cover = max(cover, fm * step(rr2, flen));
    }
    cover = max(cover, smoothstep(0.45, 0.15, rr2));   // the crown is solid
    return vec2(1.0 - cover*0.95, fbm(q*2.2 + off));
  }
  if(u_canopy < 3.5){
    // pergola: fixed slats (only the vine growing over them flutters)
    float sl = 0.5 + 0.5*sin((cp.x + cp.y*0.15)*7.0);
    float slat = smoothstep(0.42, 0.58, sl);
    float vine = smoothstep(0.55, 0.75, fbm(cp*0.9 + off));
    return vec2(max(slat - vine*0.7, 0.0), vine);
  }
  // parasol: one big disc of shade with a scalloped edge, open sky beyond.
  // Anchored so its rim sweeps just past the glass — the glass keeps its sun.
  vec2 q = cp + off*0.15;
  vec2 Cc = u_canopyC + vec2(2.4, 1.4);
  float pang = atan(q.y - Cc.y, q.x - Cc.x);
  float rr2 = length(q - Cc);
  float scallop = 0.12*sin(pang*8.0);
  return vec2(smoothstep(2.1 + scallop, 2.45 + scallop, rr2),
              0.5 + 0.4*sin(pang*8.0));
}

float dapple(vec3 P, int li){
  vec3 up = -u_lightDir[li];                      // toward the sun
  vec2 cp = P.xz + up.xz * ((CANOPY - P.y)/max(up.y, 0.2));
  float m = canopyField(cp, u_dappleOff[li]).x;   // crisp-edged patches
  return mix(1.0, 0.06 + 0.94*m, u_leaf);         // deep shade floor
}
`;

// ---------------------------------------------------------------------------
// 3) PHOTON TRANSPORT — each vertex is one photon from one light. It refracts
// into a facet, crosses the wall, the interior (cola or air, with absorption),
// the far wall, refracts out through the far facets, and lands on the table.
// ---------------------------------------------------------------------------
const PHOTON_VS = `#version 300 es
${SHARED}
uniform float u_time;
uniform float u_soft;      // penumbra (sun angular size + leaf diffraction)
uniform float u_mode;      // 0 = transmitted photons, 1 = Fresnel-reflected
uniform float u_disp;      // dispersion strength
uniform float u_seed;      // per-frame seed: new photon set every frame, so the
                           // temporal accumulation genuinely denoises
const int GW = 512;
const int GH = 288;
const int PER = GW*GH;

out vec3 v_col;

void kill(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; v_col = vec3(0.0); }

void main(){
  int id  = gl_VertexID;
  int li  = id / PER;
  int pid = id - li*PER;
  vec2 uv = (vec2(float(pid % GW), float(pid / GW)) + 0.5) / vec2(float(GW), float(GH));

  // dispersion: each photon carries a continuous wavelength. A wide,
  // overlapping spectral response keeps each splat pastel, so colour only
  // emerges where the folds systematically separate the wavelengths.
  float lam = hash12(uv*991.7 + float(li)*3.3 + u_seed);
  vec3 spec3 = vec3(
    exp(-pow((lam - 0.18)/0.46, 2.0)),
    exp(-pow((lam - 0.50)/0.46, 2.0)),
    exp(-pow((lam - 0.82)/0.46, 2.0)));
  vec3 chCol = spec3 * (3.0 / (spec3.r + spec3.g + spec3.b));
  float nGl = 1.500 + (lam - 0.5)*0.014*u_disp;  // red bends least, blue most
  float nCo = u_nLiq + (lam - 0.5)*0.006*u_disp;

  vec3 L = u_lightDir[li];

  // per-photon jitter, reseeded every frame: fills gaps over the accumulation
  // window + models the sun's angular size
  vec2 j  = hash22(uv*617.0 + float(li)*13.7 + u_seed*1.3) - 0.5;
  vec2 j2 = hash22(uv*233.0 + float(li)*71.3 + u_seed*2.7) - 0.5;
  uv += j / vec2(float(GW), float(GH));
  vec3 Lj = normalize(L + vec3(j2.x, 0.0, j2.y) * u_soft);

  // launch point: the sun-facing part of the wall
  float azL = atan(-L.z, -L.x);
  float th = azL + (uv.x - 0.5) * 2.6;
  float y  = mix(0.02, 0.99*u_H, uv.y);

  vec3 P1 = outerPos(th, y);
  vec3 N1 = outerNormal(th, y);

  // condensation: droplets act as extra little lenses on the entry wall,
  // and the misty film scatters part of the beam away from the sharp caustic
  vec2 cs = vec2(th*0.27, y);
  vec4 Dp  = dropLayer(cs, 0.085, 3.0, 0.72);
  vec4 Dp2 = dropLayer(cs + 13.1, 0.038, 17.0, 0.52);
  vec4 Dp3 = dropLayer(cs + 31.7, 0.017, 41.0, 0.34);
  if(Dp2.x > Dp.x) Dp = Dp2;
  if(Dp3.x > Dp.x) Dp = Dp3;
  Dp.x *= min(u_cond, 1.2) * smoothstep(u_y0, u_y0 + 0.05, y);   // stems stay dry
  if(Dp.x > 0.0){
    vec3 T = normalize(vec3(-sin(th), 0.0, cos(th)));
    N1 = normalize(N1 + (T*Dp.y + vec3(0.0,1.0,0.0)*Dp.z) * 0.35 * Dp.x);
  }
  float mistP = mistAmount(cs) * (1.0 - 0.8*Dp.x) * (1.0 - 0.85*rivulet(cs));

  float face = dot(N1, -Lj);
  if(face <= 0.02){ kill(); return; }

  // occlusion by the leaves above
  float w = face * dapple(P1, li);
  if(w < 0.004){ kill(); return; }
  w *= 1.0 - 0.40*mistP;
  w *= profileR(y)/u_maxR;   // launch grid is uniform in (th,y); weight by area

  // the gilded rim band is opaque metal: it blocks transmission and
  // mirrors the reflection caustic in gold
  vec3 rimTint = vec3(1.0);
  if(u_rim > 0.5 && y > u_H - 0.050){
    if(u_mode < 0.5){ kill(); return; }
    rimTint = u_rimCol;
  }

  // Fresnel at entry
  float c1 = abs(dot(N1, Lj));
  float F = 0.04 + 0.96*pow(1.0 - c1, 5.0);

  if(u_mode > 0.5){
    // ---- the REFLECTION caustic: the energy the wall bounces off,
    // landing as a bright arc on the sun side of the glass
    vec3 dr = reflect(Lj, N1);
    float wr = w * F;
    if(dr.y > -0.03 || wr < 0.002){ kill(); return; }
    float sr = -P1.y / dr.y;
    if(sr > 6.0){ kill(); return; }
    vec3 hitr = P1 + dr*sr;
    gl_Position = vec4((hitr.xz - u_caustC)/u_caustS, 0.0, 1.0);
    gl_PointSize = 1.5;
    v_col = u_lightCol[li] * wr * rimTint;     // mirror bounce (gold on the rim)
    return;
  }
  w *= 1.0 - F;

  // ---- refraction 1: air -> glass, at the faceted outer wall
  vec3 d = refract(Lj, N1, 1.0/nGl);
  if(dot(d,d) < 0.1){ kill(); return; }

  // a bubble trapped in the wall kicks the ray off course: caustic sparkle
  vec3 bb = bubbleAt(cs + 31.0);
  if(bb.x > 0.0){
    vec3 Tb = normalize(vec3(-sin(th), 0.0, cos(th)));
    d = normalize(d + (Tb*bb.y + vec3(0.0, 1.0, 0.0)*bb.z) * 0.18 * bb.x);
  }

  if(y < u_cavY){
    // ---- the solid base (or stem): one thick chord straight through
    float ro2 = profileR(y);
    float a0 = dot(d.xz, d.xz);
    float b0 = 2.0*dot(P1.xz, d.xz);
    float c0 = dot(P1.xz, P1.xz) - ro2*ro2;
    float disc0 = b0*b0 - 4.0*a0*c0;
    if(disc0 <= 0.0 || a0 < 1e-6){ kill(); return; }
    float s0 = (-b0 + sqrt(disc0)) / (2.0*a0);
    vec3 P4b = P1 + d*s0;
    if(P4b.y < 0.005){ kill(); return; }
    vec3 N4b = outerNormal(atan(P4b.z, P4b.x), clamp(P4b.y, 0.0, u_H));
    vec3 db = refract(d, -N4b, nGl);
    if(dot(db,db) < 0.1 || db.y > -0.03){ kill(); return; }
    float sb = -P4b.y / db.y;
    if(sb > 6.0){ kill(); return; }
    vec3 hitb = P4b + db*sb;
    gl_Position = vec4((hitb.xz - u_caustC)/u_caustS, 0.0, 1.0);
    gl_PointSize = 1.5;
    v_col = u_lightCol[li] * exp(-s0*u_glassSig*1.6) * w * chCol;
    return;
  }

  // cross the wall to the inner surface (smooth)
  vec3 Ns = smoothNormal(th, y);
  float t1 = wallAt(th, y) / max(dot(d, -Ns), 0.30);
  vec3 P2 = P1 + d*t1;

  // interior medium at this height
  bool  inLiq = P2.y < u_liq;
  float nIn = inLiq ? nCo : 1.0;

  // ---- refraction 2: glass -> interior, inner wall
  vec3 Nin = innerNormal(P2);
  d = refract(d, Nin, nGl/nIn);
  if(dot(d,d) < 0.1){ kill(); return; }   // total internal reflection

  if(inLiq && u_turb > 0.003){
    // turbid liquid: forward-scatter smears the ray direction, so the
    // caustic diffuses into a soft glow instead of sharp filaments
    vec2 jj = hash22(uv*401.0 + u_seed*3.1) - 0.5;
    d = normalize(d + vec3(jj.x, 0.0, jj.y) * 0.22*u_turb);
  }

  // cross the interior: iterated chord to the far inner wall
  float s = innerChord(P2, d);
  if(s <= 0.0){ kill(); return; }
  vec3 P3 = P2 + d*s;

  vec3 tint = vec3(1.0);
  if(inLiq){
    // Beer-Lambert through the liquid: long chords die, short ones tint
    tint = exp(-s * u_liqSig * 0.45) * 0.6;
    // out-scatter: turbid drinks steal energy from the transmitted beam
    tint *= exp(-s * u_turb * 3.0);
  }
  if(P3.y < u_cavY - 0.02 || P3.y > u_H){ kill(); return; }  // floor hit / open top

  if(inLiq && u_iceN > 0.5){
    // ice as weak spherical lenses along the chord: bend the ray toward or
    // past the cube axis and lose a little energy -> mottled ice caustics
    for(int ii=0;ii<3;ii++){
      if(float(ii) > u_iceN - 0.5) break;
      vec3 oc = u_icePos[ii] - P2;
      float tc = clamp(dot(oc, d), 0.0, s);
      vec3 mm = P2 + d*tc - u_icePos[ii];
      float rr = u_iceR[ii]*1.15;
      float qq = length(mm)/max(rr, 1e-4);
      if(qq < 1.0){
        d = normalize(d - (mm/rr) * 0.35*(1.0 - qq));
        tint *= 0.85;
      }
    }
  }

  // ---- refraction 3: interior -> glass, far inner wall
  vec3 Nin2 = -innerNormal(P3);
  d = refract(d, Nin2, nIn/nGl);
  if(dot(d,d) < 0.1){ kill(); return; }

  // cross the far wall, exit through the faceted outer surface
  float th4 = atan(P3.z, P3.x);
  vec3 Ns2 = smoothNormal(th4, P3.y);
  float t2 = wallAt(th4, P3.y) / max(dot(d, Ns2), 0.30);
  vec3 P4 = P3 + d*t2;
  tint *= exp(-(t1 + t2)*u_glassSig);          // green shift grows with wall depth
  float y4 = clamp(P4.y, 0.0, u_H);
  vec3 N4 = outerNormal(atan(P4.z, P4.x), y4);

  // ---- refraction 4: glass -> air
  vec3 dout = refract(d, -N4, nGl);
  if(dot(dout,dout) < 0.1){ kill(); return; }
  float c4 = abs(dot(N4, dout));
  w *= 1.0 - (0.04 + 0.96*pow(1.0 - c4, 5.0));

  // ---- land on the table
  if(dout.y > -0.03){ kill(); return; }
  float s4 = -P4.y / dout.y;
  if(s4 > 6.0){ kill(); return; }
  vec3 hit = P4 + dout*s4;

  // table region -> caustic-texture clip space
  vec2 clip = (hit.xz - u_caustC)/u_caustS;
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = 1.5;
  v_col = u_lightCol[li] * tint * w * chCol;
}
`;

const PHOTON_FS = `#version 300 es
precision highp float;
in vec3 v_col;
out vec4 o;
uniform float u_gain;
void main(){
  vec2 d = gl_PointCoord*2.0 - 1.0;
  float g = exp(-dot(d,d)*3.0);
  o = vec4(v_col * g * u_gain, 1.0);
}
`;

// ---------------------------------------------------------------------------
// fullscreen helpers: fade (temporal accumulation), blur, bright pass, finish
// ---------------------------------------------------------------------------
const QUAD_VS = `#version 300 es
out vec2 v_uv;
void main(){
  vec2 p = vec2((gl_VertexID<<1 & 2), (gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
}
`;

// decayed copy of last frame's caustic: the accumulation half of the
// ping-pong. New photons are then splatted additively on top, so the buffer
// converges to ~1/(1-decay) frames' worth of photons.
const FADE_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex;
uniform float u_decay;
void main(){ o = vec4(texture(u_tex, v_uv).rgb * u_decay, 1.0); }
`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_dir;
void main(){
  vec3 acc = vec3(0.0);
  float ws[5]; ws[0]=0.227; ws[1]=0.194; ws[2]=0.121; ws[3]=0.054; ws[4]=0.016;
  acc += texture(u_tex, v_uv).rgb * ws[0];
  for(int i=1;i<5;i++){
    vec2 off = u_dir * float(i);
    acc += texture(u_tex, v_uv + off).rgb * ws[i];
    acc += texture(u_tex, v_uv - off).rgb * ws[i];
  }
  o = vec4(acc, 1.0);
}
`;

// bloom bright pass: keep only what outshines the blown-out backdrop
const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex;
void main(){
  vec3 c = texture(u_tex, v_uv).rgb;
  // soft knee starting just above the backdrop level (~1.2): the backdrop
  // halates faintly, sparkles and sun glints bloom hard
  float l = max(max(c.r, c.g), c.b);
  o = vec4(c * smoothstep(1.05, 1.9, l), 1.0);
}
`;

// finishing pass: the camera. Scene + bloom, plus the phone-footage artifacts:
// handheld frame wobble, corner chromatic aberration, far-field defocus —
// then the film look that used to close COMP_FS.
const FINAL_FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_scene;   // linear HDR composite; alpha = hit distance
uniform sampler2D u_bloom;   // quarter-res blurred bright pass
uniform float u_time;
uniform vec2  u_wob;         // handheld frame wobble (uv units)
uniform vec2  u_px;          // one pixel, in uv units
uniform float u_focus;       // camera-to-glass distance: the focal plane
float hash12(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453123); }
void main(){
  vec2 uv = v_uv + u_wob;
  vec2 cvec = uv - 0.5;

  // lateral chromatic aberration: red and blue pulled apart toward corners
  float ca = 0.004*dot(cvec, cvec);
  vec4 sc = texture(u_scene, uv);
  vec3 sharp = vec3(
    texture(u_scene, uv + cvec*ca).r,
    sc.g,
    texture(u_scene, uv - cvec*ca).b);

  // depth of field: the glass holds focus, the far table and the backdrop
  // melt away like a phone lens wide open
  float coc = smoothstep(u_focus + 1.3, u_focus + 7.0, sc.a);
  vec3 col = sharp;
  if(coc > 0.003){
    float r = coc * 9.0;                    // blur radius in pixels
    const vec2 taps[8] = vec2[8](
      vec2( 1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0,  1.0), vec2(0.0, -1.0),
      vec2( 0.6, 0.6), vec2(-0.6, 0.6), vec2(-0.6,-0.6), vec2( 0.6,-0.6));
    vec3 acc = sharp;
    for(int i=0;i<8;i++) acc += texture(u_scene, uv + taps[i]*r*u_px).rgb;
    col = mix(sharp, acc*(1.0/9.0), clamp(coc*1.3, 0.0, 1.0));
  }

  col += texture(u_bloom, uv).rgb * 0.55;   // halation, added in linear light
  // finish: vignette, filmic-ish curve, grain
  vec2 vq = v_uv - 0.5;
  col *= 1.0 - 0.35*dot(vq, vq)*1.6;
  col = col / (1.0 + col*0.35);
  col = pow(max(col, 0.0), vec3(0.90));
  col += (hash12(gl_FragCoord.xy + fract(u_time)*61.7) - 0.5)*0.02;
  o = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// 4) COMPOSITE — raymarch the same glass model, shade the table with the same
// lights (shadow + dapple), and lay the accumulated caustic onto it.
// Outputs linear HDR; vignette/tonemap/grain happen in FINAL_FS after bloom.
// ---------------------------------------------------------------------------
const COMP_FS = `#version 300 es
${SHARED}
uniform vec2  u_res;
uniform float u_time;
uniform sampler2D u_caust;   // sharp
uniform sampler2D u_caustB;  // blurred
uniform float u_sun;
uniform float u_spill;
uniform float u_spillSeed;   // rerolls the puddle outline and drip fingers
uniform vec3  u_ro;
uniform float u_taY;         // camera look-at height, scaled to the glass
// the light environment: time-of-day presets recolour the whole courtyard
uniform vec3  u_skyHor;      // sky at the horizon
uniform vec3  u_skyZen;      // sky overhead
uniform vec3  u_leafD;       // shaded leaf
uniform vec3  u_leafL;       // sunlit leaf
uniform vec3  u_gnd0;        // ground in shade
uniform vec3  u_gnd1;        // ground in sun
uniform vec3  u_ambS;        // table ambient from open sky
uniform vec3  u_ambL;        // table ambient filtered through leaves
uniform vec3  u_backCol;     // blown-out backdrop
uniform float u_pen;         // shadow penumbra scale (noon hard, dusk soft)
uniform float u_night;       // 1 = night: string lights + stars in the sky
uniform float u_table;       // 0 stone, 1 wood planks, 2 glazed tiles, 3 concrete
in vec2 v_uv;
out vec4 o;

// ---- water pooled at the base: ring + drip fingers -----------------------
float finger(vec2 q, vec2 dir, float len, float wdt){
  float t = dot(q, dir);
  vec2 perp = vec2(-dir.y, dir.x);
  float lat = dot(q, perp) + 0.013*sin(t*34.0 + dir.x*20.0);  // squiggle
  float along = smoothstep(u_baseR + len, u_baseR + len*0.25, t)
              * smoothstep(u_baseR - 0.03, u_baseR + 0.02, t);
  return along * exp(-lat*lat/(wdt*wdt));
}
float puddleMask(vec2 q){
  float r = length(q);
  // the seed reshapes the outline and swings the whole drip pattern around
  float w1 = fbm(q*3.3 + 7.1 + u_spillSeed*13.7);
  float ca = cos(u_spillSeed*6.2831853), sa = sin(u_spillSeed*6.2831853);
  mat2 rot = mat2(ca, -sa, sa, ca);
  float outer = u_baseR + 0.005 + (0.030 + 0.150*u_spill)*pow(w1, 1.4);
  float m = smoothstep(outer, outer - 0.040, r) * smoothstep(u_baseR - 0.05, u_baseR + 0.004, r);
  float fs = smoothstep(0.10, 0.55, u_spill);
  m = max(m, finger(q, rot*normalize(vec2(0.55, 0.78)), 0.20, 0.020)*fs);
  m = max(m, finger(q, rot*normalize(vec2(-0.38, 0.86)), 0.13, 0.016)*fs);
  m = max(m, finger(q, rot*normalize(vec2(0.92, 0.30)), 0.10, 0.014)*fs*0.9);
  // a stray drop that fell from the wall
  m = max(m, smoothstep(0.026, 0.010, length(q - rot*vec2(0.34, 0.30)))*fs);
  return m;
}

// intersection with a rounded (filleted) convex edge, radius rc
float roundedIntersect(float a, float b, float rc){
  vec2 v = vec2(a + rc, b + rc);
  return min(max(v.x, v.y), 0.0) + length(max(v, 0.0)) - rc;
}
float sdGlass(vec3 p){
  if(p.y < -0.02 || p.y > u_H + 0.15) return max(p.y - u_H, -p.y) + 0.05;
  float r = length(p.xz);
  float th = atan(p.z, p.x);
  float yc = clamp(p.y, 0.0, u_H);
  float rcT = wallAt(th, u_H)*0.45;        // rim: half-round lip, kind to mouths
  float rcB = 0.015;                       // bottom edge: just eased
  // slope correction keeps the field ~Lipschitz on curved/steep profiles
  float sl = profileSlope(yc);
  float dOut = (r - outerRadius(th, yc)) / sqrt(1.0 + sl*sl);
  float d = roundedIntersect(dOut, p.y - u_H, rcT);
  d = roundedIntersect(d, -p.y, rcB);
  // hollow: carve the interior cavity. The floor meets the wall through a
  // generous fillet — every real glass has a curved inner bottom
  float ri = innerR(th, yc);
  float fRB = clamp(ri*0.45, 0.02, 0.09);
  float dCav = roundedIntersect(r - ri, u_cavY - p.y, fRB);
  return roundedIntersect(d, -dCav, rcT*0.8);
}
vec3 glassNormal(vec3 p){
  const vec2 e = vec2(0.004, 0.0);
  return normalize(vec3(
    sdGlass(p+e.xyy) - sdGlass(p-e.xyy),
    sdGlass(p+e.yxy) - sdGlass(p-e.yxy),
    sdGlass(p+e.yyx) - sdGlass(p-e.yyx)));
}

vec3 envColor(vec3 d){
  // --- procedural courtyard: blue sky, a green tree overhead, warm ground
  float sky_t = smoothstep(-0.05, 0.60, d.y);
  vec3 sky = mix(u_skyHor, u_skyZen, pow(sky_t, 0.55));
  // the canopy overhead: built from the SAME field that casts the dapple,
  // so the reflected cover is the cover shading the table
  if(d.y > 0.08){
    vec2 cp = d.xz / max(d.y, 0.2) * (CANOPY*0.5);
    vec2 cf = canopyField(cp, u_dappleOff[0]);
    float cover = smoothstep(0.10, 0.55, d.y) * (1.0 - cf.x) * u_leaf;
    vec3 leafCol;
    if(u_canopy < 2.5){
      leafCol = mix(u_leafD, u_leafL, cf.y);
    } else {
      // man-made covers keep their own material colours, dimmed to the
      // preset's light level so they don't glow at dusk or night
      float envB = clamp(dot(u_leafL, vec3(0.2126, 0.7152, 0.0722))/0.62, 0.12, 1.15);
      if(u_canopy < 3.5){
        // pergola: warm wooden beams with the vine draped over them
        leafCol = mix(vec3(0.36, 0.25, 0.16)*envB, mix(u_leafD, u_leafL, 0.65), cf.y);
      } else {
        // parasol: classic striped canvas
        leafCol = mix(vec3(0.80, 0.20, 0.17), vec3(0.94, 0.90, 0.82), step(0.5, cf.y))*envB;
      }
    }
    sky = mix(sky, leafCol*1.05, cover*0.85);
  }
  if(u_night > 0.5){
    // NIGHT: a strand of party bulbs swagged across the courtyard, thin
    // stars above — the bulbs are what light the scene
    for(int i=0;i<7;i++){
      float fi = float(i);
      float baz = -1.10 - fi*0.42;
      float bel = 0.42 + 0.10*sin(fi*2.1);           // the swag of the wire
      vec3 bd = vec3(cos(baz)*cos(bel), sin(bel), sin(baz)*cos(bel));
      float a = max(dot(d, bd), 0.0);
      vec3 bc = (i - (i/4)*4 == 0) ? vec3(1.30, 0.75, 0.35) :
                (i - (i/4)*4 == 1) ? vec3(1.20, 0.40, 0.55) :
                (i - (i/4)*4 == 2) ? vec3(0.45, 0.95, 0.60) : vec3(0.45, 0.65, 1.25);
      sky += bc * (pow(a, 9000.0)*6.0 + pow(a, 700.0)*1.2);
    }
    float st = step(0.9985, hash12(floor(d.xz/max(d.y, 0.05)*50.0) + 7.3));
    sky += vec3(0.8, 0.85, 1.0) * st * smoothstep(0.15, 0.5, d.y) * 0.5;
  } else {
    // ONE sun: only the main light burns a disc into the sky. The secondary
    // lights are just gaps in the foliage — a broad soft brightening, no disc.
    float a0 = max(dot(d, -u_lightDir[0]), 0.0);
    sky += u_lightCol[0] * (pow(a0, 3500.0)*10.0 + pow(a0, 90.0)*1.2);
    for(int i=1;i<NL;i++){
      float a = max(dot(d, -u_lightDir[i]), 0.0);
      sky += u_lightCol[i] * pow(a, 8.0)*0.5;
    }
  }
  // below the horizon: the sunlit dappled table, not a dim void
  float gd = fbm(d.xz*2.5 + u_dappleOff[0]*0.5);
  vec3 ground = mix(u_gnd0, u_gnd1, smoothstep(0.35, 0.65, gd));
  return mix(ground, sky, smoothstep(-0.12, 0.04, d.y));
}

// how much sun from light li reaches table point P (glass blocks some)
float glassShadow(vec3 P, int li){
  vec3 up = -u_lightDir[li];
  float occ = 0.0;
  // slice the glass uniformly in HEIGHT and widen each slice's penumbra by
  // the sun's horizontal stretch, so the slices always merge into one
  // continuous shadow (discrete ray samples left a trail of dark discs
  // when a low sun spread them apart)
  float invUy = 1.0/max(up.y, 0.10);
  float stretch = length(up.xz)*invUy;               // cot(elevation)
  float dy = u_H/12.0;
  for(int i=0;i<12;i++){
    float y = (float(i) + 0.5)*dy;
    float s = (y - P.y)*invUy;
    vec3 q = P + up*s;
    float rr = length(q.xz);
    float R = profileR(y);
    float pen = (0.03 + 0.06*s + 0.65*dy*stretch)*u_pen;   // widening penumbra
    float wgt = smoothstep(pen, -0.02, rr - R);
    float dens = (y > u_cavY && y < u_liq) ? 0.95 : 0.70;  // liquid blocks more
    occ = max(occ, wgt*dens);
  }
  return 1.0 - occ;
}

// ---- ice: rounded cubes bobbing in the drink -----------------------------
float iceSDF(vec3 p){
  float dm = 1e5;
  for(int i=0;i<3;i++){
    if(float(i) > u_iceN - 0.5) break;
    float fi = float(i);
    vec3 q = p - u_icePos[i];
    float c = cos(u_iceRot[i]), s = sin(u_iceRot[i]);
    q.xz = mat2(c, -s, s, c)*q.xz;
    // no two cubes from the same tray: each gets its own squashed aspect
    vec3 asp = vec3(0.80) + 0.40*vec3(hash12(vec2(fi, 1.3)),
                                      hash12(vec2(fi, 4.7)),
                                      hash12(vec2(fi, 8.1)));
    vec3 b = abs(q) - u_iceR[i]*0.82*asp;
    float dd = length(max(b, vec3(0.0))) + min(max(b.x, max(b.y, b.z)), 0.0) - u_iceR[i]*0.22;
    // a lumpy, half-melted surface
    dd += (vnoise(q.xy*20.0 + fi*13.1) - 0.5)*0.016
        + (vnoise(q.yz*17.0 + fi*7.7) - 0.5)*0.012;
    dm = min(dm, dd);
  }
  return dm;
}
vec3 iceNormal(vec3 p){
  const vec2 e = vec2(0.004, 0.0);
  return normalize(vec3(
    iceSDF(p+e.xyy) - iceSDF(p-e.xyy),
    iceSDF(p+e.yxy) - iceSDF(p-e.yxy),
    iceSDF(p+e.yyx) - iceSDF(p-e.yyx)));
}
float iceMarch(vec3 o, vec3 dir, float tmax){
  float t2 = 0.01;
  for(int i=0;i<14;i++){
    if(t2 > tmax) return -1.0;
    float d = iceSDF(o + dir*t2);
    if(d < 0.004) return t2;
    t2 += max(d*0.7, 0.006);   // conservative: the lumpy surface adds slope
  }
  return -1.0;
}
// ---- carbonation: bubble chains as VERTICAL columns in world space -------
// evaluated at a 3D point inside the liquid, so chains rise straight up no
// matter how the wall slopes, and parallax with the view ray
float fizzField(vec3 p){
  vec2 cell = floor(p.xz/0.05);
  vec2 rnd = hash22(cell*7.7 + 3.1);
  if(rnd.x > 0.60) return 0.0;              // sparse nucleation columns
  vec2 axis = (cell + 0.2 + 0.6*rnd)*0.05;
  // wobbling ascent
  vec2 dxz = p.xz - axis
           + 0.004*vec2(sin(p.y*35.0 + rnd.y*6.28), cos(p.y*31.0 + rnd.y*6.28));
  float rate = 9.0 + 7.0*rnd.y;             // bubbles per unit height
  float vspd = 0.10 + 0.08*rnd.x;           // rise speed
  float phy = (p.y - u_time*vspd)*rate + rnd.y*13.0;
  float k = floor(phy);
  float bon = step(0.35, hash12(cell + vec2(k*0.61, 9.4)));   // gaps in the chain
  float bsz = 0.0028 + 0.0038*hash12(cell*1.7 + vec2(k*0.37, 2.2));
  float d3 = length(vec3(dxz.x, (fract(phy) - 0.5)/rate, dxz.y));
  return bon * smoothstep(bsz, bsz*0.4, d3);
}

// frosty, cracked, sky-catching: refracted world + Fresnel mirror + glints
vec3 shadeIce(vec3 Q, vec3 dd){
  vec3 Ni = iceNormal(Q);
  vec3 rf = refract(dd, Ni, 0.985);          // liquid->ice: nearly matched
  if(dot(rf,rf) < 0.1) rf = reflect(dd, Ni);
  float crack = fbm(Q.xy*14.0 + Q.z*7.0);    // internal fracture planes
  float fr = 0.02 + 0.98*pow(clamp(1.0 + dot(dd, Ni), 0.0, 1.0), 5.0);
  vec3 icb = envColor(normalize(rf)) * vec3(0.90, 0.96, 1.02) * (0.55 + 0.50*crack);
  vec3 icc = mix(icb, envColor(reflect(dd, Ni)), clamp(fr + 0.15, 0.0, 1.0));
  for(int i=0;i<NL;i++){
    vec3 hr = reflect(u_lightDir[i], Ni);
    icc += u_lightCol[i] * pow(max(dot(hr, -dd), 0.0), 60.0) * 1.5 * dapple(Q, i);
  }
  return icc;
}

void main(){
  vec2 frag = (v_uv*2.0 - 1.0) * vec2(u_res.x/u_res.y, 1.0);

  // orbit camera
  vec3 ro = u_ro;
  vec3 ta = vec3(0.0, u_taY, 0.0);
  vec3 fw = normalize(ta - ro);
  vec3 rt = normalize(cross(fw, vec3(0.0,1.0,0.0)));
  vec3 upv = cross(rt, fw);
  vec3 rd = normalize(fw*1.85 + rt*frag.x + upv*frag.y);

  // does this ray meet the glass? (bounding cylinder first)
  float tGlass = -1.0;
  {
    float rb = u_maxR + 0.06;
    float a = dot(rd.xz, rd.xz);
    float b = 2.0*dot(ro.xz, rd.xz);
    float c = dot(ro.xz, ro.xz) - rb*rb;
    float disc = b*b - 4.0*a*c;
    if(disc > 0.0){
      float s0 = (-b - sqrt(disc))/(2.0*a);
      float s1 = (-b + sqrt(disc))/(2.0*a);
      float t = max(s0, 0.0);
      for(int i=0;i<80;i++){
        if(t > s1) break;
        vec3 p = ro + rd*t;
        float d = sdGlass(p);
        if(d < 0.0015){ tGlass = t; break; }
        t += max(d*0.45, 0.002);
      }
    }
  }

  float tTable = (rd.y < -0.001) ? -ro.y/rd.y : 1e5;

  // the cola's open surface, seen directly through the rim from above
  float tLiq = 1e5;
  if(rd.y < -0.001){
    float tl = (u_liq - ro.y)/rd.y;
    if(tl > 0.0){
      vec3 ql = ro + rd*tl;
      float rL = innerR(atan(ql.z, ql.x), u_liq);
      if(length(ql.xz) < rL) tLiq = tl;
    }
  }

  vec3 col;
  float hitT = 30.0;             // hit distance, written to alpha for the
                                 // depth-of-field pass (backdrop = far)
  if(tGlass > 0.0 && tGlass < min(tTable, tLiq)){
    // ---------- the glass itself ----------
    hitT = tGlass;
    vec3 P = ro + rd*tGlass;
    vec3 N = glassNormal(P);
    float fres = 0.04 + 0.96*pow(clamp(1.0 + dot(rd, N), 0.0, 1.0), 5.0);
    vec3 refl = envColor(reflect(rd, N));

    // ---------- transmission with real wall depth ----------
    vec3 body;
    float th = atan(P.z, P.x);
    float glassLen = 0.0;                       // path length inside glass
    vec3 d1 = refract(rd, N, 1.0/NGLASS);

    vec3 radial = normalize(vec3(P.x, 0.0, P.z));
    bool innerHit = dot(N, radial) < -0.15 && P.y > u_cavY;

    if(dot(d1,d1) < 0.1){
      body = envColor(reflect(rd, N));
    } else if(innerHit){
      // the INSIDE face of the far wall, seen through the opening:
      // thin glass — mostly transmits the world behind it, distorted by
      // its facets; the grazing Fresnel below silvers it toward the edges
      float fp = facetPattern(th, clamp(P.y, 0.0, u_H));
      glassLen = wallAt(th, clamp(P.y, 0.0, u_H))/0.7;
      body = envColor(normalize(d1)) * vec3(0.93, 0.95, 0.93) * (0.72 + 0.30*fp);
    } else if(P.y < u_cavY){
      // the thick solid base slab (or stem/foot): one long chord of glass
      float ro2 = profileR(P.y);
      float a0 = dot(d1.xz, d1.xz);
      float b0 = 2.0*dot(P.xz, d1.xz);
      float c0 = dot(P.xz, P.xz) - ro2*ro2;
      float disc0 = max(b0*b0 - 4.0*a0*c0, 0.0);
      glassLen = (-b0 + sqrt(disc0)) / max(2.0*a0, 1e-4);
      body = envColor(normalize(d1)) * (0.85 + 0.55*fbm(vec2(th*6.0, P.y*20.0)));
      // amber wash where the slab carries light from the cola above it
      body = mix(body, u_liqGlow*0.95, 0.35*smoothstep(u_cavY - 0.05, u_cavY, P.y));
    } else {
      // cross the front wall
      vec3 Ns = smoothNormal(th, P.y);
      float t1 = wallAt(th, P.y) / max(dot(d1, -Ns), 0.25);
      glassLen += t1;
      vec3 P2 = P + d1*t1;
      vec3 Nin = innerNormal(P2);

      if(P2.y < u_liq){
        // The liquid COLUMN sits inside the clear wall. Refract glass->cola
        // and filter the background by the true chord through the liquid.
        vec3 d2 = refract(d1, Nin, NGLASS/u_nLiq);
        if(dot(d2,d2) < 0.1){
          // TIR at the glass/cola interface: neutral clear-glass edge band
          body = envColor(reflect(d1, Nin)) * 0.45;
        } else {
          float chord = max(innerChord(P2, d2), 0.0);
          // the chord may dive onto the CURVED floor before the far wall:
          // flat disc in the middle, quarter-round fillet toward the wall
          float chordL = chord;
          float floorHit = 0.0;
          if(d2.y < -1e-4){
            float s0 = (u_cavY - P2.y)/d2.y;
            vec3 Qb = P2 + d2*max(s0, 0.0);
            float ri0 = innerR(atan(Qb.z, Qb.x), u_cavY + 0.02);
            float fRB = clamp(ri0*0.45, 0.02, 0.09);
            float tq = clamp((length(Qb.xz) - (ri0 - fRB))/fRB, 0.0, 1.0);
            float hFl = u_cavY + fRB*(1.0 - sqrt(max(1.0 - tq*tq, 0.0)));
            float sF = (hFl - P2.y)/d2.y;
            if(sF < chordL){ chordL = max(sF, 0.0); floorHit = 1.0; }
          }
          // absorption: long chords die to the liquid's colour
          vec3 absorb = exp(-chordL * u_liqSig);
          // turbidity: out-scatter swaps transmission for a sunlit body
          // colour — an opaque juice instead of a transparent cola
          float sc = 1.0 - exp(-chordL * u_turb * 7.0);
          vec3 inLight = vec3(0.0);
          for(int i=0;i<NL;i++) inLight += u_lightCol[i] * dapple(P, i);
          vec3 scat = u_scatCol * (0.30 + 0.70*inLight)
                    * (0.55 + 0.45*smoothstep(u_cavY, u_liq, P2.y));
          glassLen += wallAt(atan(P2.z, P2.x), P2.y)/0.7;   // exit far wall
          body = envColor(normalize(d2)) * vec3(0.94, 0.96, 0.94) * absorb * (1.0 - sc)
               + scat * sc + vec3(0.014, 0.007, 0.008);
          for(int i=0;i<NL;i++){
            float fwd = pow(max(dot(rd, u_lightDir[i]), 0.0), 5.0);
            body += u_liqGlow * fwd * u_lightCol[i]
                  * (absorb + 0.12) * 0.8 * (1.0 - 0.7*sc) * dapple(P, i);
          }
          float rimt = pow(clamp(1.0 - abs(dot(rd, N)), 0.0, 1.0), 2.5);
          body += u_liqGlow * 0.42 * rimt * 0.8;
          if(floorHit > 0.5){
            // the liquid mass ends on the glass's rounded bottom: a warm
            // glassy glow instead of the world showing through
            vec3 bot = mix(u_liqGlow*0.8, vec3(0.85, 0.82, 0.75), 0.35)
                     * (0.35 + 0.65*dapple(P, 0));
            body = mix(body, bot*absorb + vec3(0.012, 0.008, 0.007), 0.85);
          }
          if(u_iceN > 0.5){
            // an ice cube interrupting the chord replaces the deep view
            float tIce = iceMarch(P2, d2, chord);
            if(tIce > 0.0){
              vec3 Qi = P2 + d2*tIce;
              body = shadeIce(Qi, d2) * exp(-tIce * u_liqSig * 0.7);
            }
          }
          if(u_fizz > 0.01){
            // carbonation: micro-bubbles clinging to the glass (those DO
            // hug the wall) + free-rising chains sampled in the liquid
            // volume at two depths along the chord
            vec2 fs2 = vec2(th*0.27, P2.y);
            vec4 Fw = dropLayer(fs2*2.0 + 51.3, 0.011, 77.0, 0.62);
            float riser = fizzField(P2 + d2*min(chord*0.35, 0.22))
                        + fizzField(P2 + d2*min(chord*0.75, 0.45))*0.6;
            float fz = (Fw.x*0.45 + riser) * u_fizz
                     * smoothstep(u_cavY, u_cavY + 0.1, P2.y);
            body += vec3(1.0, 0.98, 0.92) * fz * (0.25 + 0.75*dapple(P, 0));
          }
          // bright meniscus line, seen refracted through the front wall;
          // fizz broadens it into a speckled foam collar
          body += vec3(0.95, 0.88, 0.75)
                * exp(-pow((u_liq - P2.y)/0.014, 2.0)) * (0.15 + 0.45*dapple(P, 0));
          body += vec3(0.98, 0.96, 0.90) * u_fizz * 0.55
                * exp(-pow((u_liq - P2.y)/0.045, 2.0))
                * (0.35 + 0.65*fbm(vec2(th*9.0, u_liq*7.0 + u_time*0.15)));
        }
      } else {
        // empty part: cross the air gap and meet the BACK wall
        vec3 d2 = refract(d1, Nin, NGLASS);
        if(dot(d2,d2) < 0.1){
          // total internal reflection in the front wall:
          // the dark mirror band hugging the silhouette edges
          body = envColor(reflect(d1, Nin)) * 0.45;
        } else {
          float chord = max(innerChord(P2, d2), 0.0);
          float sLiq = 1e5;
          if(d2.y < -1e-4 && u_liq > u_cavY + 0.005) sLiq = (u_liq - P2.y)/d2.y;
          glassLen += wallAt(atan(P2.z, P2.x), P2.y)/0.7;   // back wall
          if(sLiq < chord){
            // the ray dips onto the cola's top surface inside the glass.
            // Seen through the wall this is mostly sheen: the surface mirrors
            // the bright sky, and the wall itself scatters — only a soft
            // darkening of the transmitted background remains.
            vec3 rl = reflect(d2, vec3(0.0, 1.0, 0.0));
            float frl = 0.02 + 0.98*pow(clamp(1.0 + d2.y, 0.0, 1.0), 5.0);
            vec3 deep2 = exp(-u_liqSig*0.30)*0.25 + vec3(0.016, 0.010, 0.008);
            deep2 = mix(deep2, u_scatCol*0.5, clamp(u_turb*3.0, 0.0, 0.85));
            vec3 surf = mix(deep2, envColor(rl)*0.90, clamp(frl + 0.22, 0.0, 1.0));
            body = mix(surf, envColor(normalize(d2)) * vec3(0.94, 0.96, 0.94), 0.35);
          } else {
            vec3 P3 = P2 + d2*chord;
            vec3 Nb = -innerNormal(P3);                   // back wall, inner face
            float backFacet = facetPattern(atan(P3.z, P3.x), clamp(P3.y, 0.0, u_H));
            body = envColor(normalize(d2)) * vec3(0.94, 0.96, 0.94)
                 * (0.85 + 0.32*backFacet);     // the far diamonds show through
            // Fresnel off the back wall: the silvery mirror arcs that hug
            // the inner silhouette of a real glass
            float cosb = clamp(dot(-d2, Nb), 0.0, 1.0);
            float Fb = 0.04 + 0.96*pow(1.0 - cosb, 5.0);
            body = mix(body, envColor(reflect(d2, Nb))*0.9, Fb*0.85);
          }
          if(u_iceN > 0.5){
            // ice shouldering above the liquid line, seen through the wall
            float tIceA = iceMarch(P2, d2, min(chord, sLiq));
            if(tIceA > 0.0) body = shadeIce(P2 + d2*tIceA, d2);
          }
        }
      }
    }
    // green-grey shift that grows with the glass path: the depth read
    body *= exp(-glassLen * u_glassSig);

    // ---------- condensation ----------
    vec3 bodyBase = body;                        // the sharp, un-fogged view
    vec2 s = vec2(th*0.27, P.y);                 // wall coordinates

    float wet = smoothstep(u_y0, u_y0 + 0.05, P.y);   // stems and feet stay dry
    float rv  = rivulet(s) * smoothstep(0.05, 0.5, u_cond) * wet;
    vec4 Dr = dropLayer(s, 0.085, 3.0, 0.72);          // rare big blobs
    vec4 Dm = dropLayer(s + 13.1, 0.038, 17.0, 0.52);  // mid drops
    vec4 Df = dropLayer(s + 31.7, 0.017, 41.0, 0.34);  // dense micro-beads
    if(Dm.x > Dr.x) Dr = Dm;
    if(Df.x > Dr.x) Dr = Df;
    float dm = Dr.x;
    dm *= smoothstep(u_H - 0.09, u_H - 0.27, P.y) * (1.0 - 0.7*rv);   // dry near rim & on trails
    dm *= min(u_cond, 1.2) * wet;

    bool onCola = P.y < u_liq + 0.015;
    float mist = mistAmount(s) * (1.0 - 0.85*rv) * (1.0 - 0.80*dm);
    if(onCola) mist *= 0.65;
    mist = clamp(mist, 0.0, 1.0);
    if(innerHit){ mist *= 0.40; dm *= 0.30; }   // the fog sits on the OUTER wall

    // fog film: bright hazy scatter that kills contrast
    float amb = 0.5 + 0.5*dapple(P, 0);
    vec3 frost = mix(vec3(0.83,0.86,0.87), vec3(1.02,1.04,0.99), fbm(s*22.0)*0.7) * amb
               * mix(vec3(1.0), vec3(0.94, 1.02, 0.95), 0.5*u_leaf);
    if(onCola) frost *= vec3(0.52, 0.47, 0.46);           // haze over dark liquid stays dim
    body = mix(body, body*0.30 + frost*0.70, mist);

    // rivulets wipe back to the sharp view — wet glass, slightly darker
    body = mix(body, bodyBase*0.92, rv*0.85);

    // droplets: tiny lenses — bent background, dark rim, sun glint
    vec3 Nd = N;
    if(dm > 0.001){
      vec2 nd = Dr.yz;
      vec3 T = normalize(vec3(-sin(th), 0.0, cos(th)));
      float nz = sqrt(max(1.0 - dot(nd,nd), 0.0));
      Nd = normalize(N*nz + (T*nd.x + vec3(0.0,1.0,0.0)*nd.y)*0.9);
      // a droplet shows a bent view of whatever is actually behind the wall,
      // plus a faint ambient sheen — never brighter than its background allows
      vec3 lens = bodyBase*0.70 + envColor(refract(rd, Nd, 0.75))*0.20
                + vec3(0.10, 0.095, 0.09)*amb;
      float rimd = smoothstep(0.45, 0.95, length(nd));
      lens *= 1.0 - 0.35*rimd;
      body = mix(body, lens, dm*0.80);
    }

    // bubbles trapped in the wall: transparent lens rings — a bright
    // crescent on the lit rim, a faint dark edge opposite, and a center
    // that leaves the background almost untouched
    vec3 bw = bubbleAt(s + 31.0);
    if(bw.x > 0.0){
      float rimb = smoothstep(0.30, 0.95, length(bw.yz));
      vec3 Tb2 = normalize(vec3(-sin(th), 0.0, cos(th)));
      vec2 lp = normalize(vec2(dot(-u_lightDir[0], Tb2), -u_lightDir[0].y) + vec2(1e-4));
      float along = dot(normalize(bw.yz + 1e-5), lp);
      float cres = rimb * smoothstep(0.10, 0.90, along);
      float dark = rimb * smoothstep(0.10, 0.90, -along);
      body *= 1.0 - bw.x*(0.05 + 0.30*dark);
      body += u_lightCol[0] * (0.5 + 0.5*dapple(P, 0)) * bw.x * cres * 0.9;
      // plus the moving mirror glint as the view lines up
      float nz2 = sqrt(max(1.0 - dot(bw.yz, bw.yz), 0.0));
      vec3 Nb2 = normalize(N*nz2 + (Tb2*bw.y + vec3(0.0, 1.0, 0.0)*bw.z)*1.2);
      for(int i=0;i<NL;i++){
        vec3 hb = reflect(u_lightDir[i], Nb2);
        body += u_lightCol[i] * pow(max(dot(hb, -rd), 0.0), 40.0) * 1.2
              * bw.x * dapple(P, i);
      }
    }

    // fog also dulls the mirror reflection
    col = mix(body, refl, fres*(0.85 - 0.45*mist));

    // facet sparkles + droplet glints from each light
    for(int i=0;i<NL;i++){
      vec3 hr = reflect(u_lightDir[i], N);
      col += u_lightCol[i] * pow(max(dot(hr, -rd), 0.0), 90.0) * 2.0 * dapple(P, i) * (1.0 - 0.6*mist);
      vec3 hd = reflect(u_lightDir[i], Nd);
      col += u_lightCol[i] * pow(max(dot(hd, -rd), 0.0), 160.0) * 5.0 * dm * dapple(P, i);
    }

    // metallic painted rim on the lip
    if(u_rim > 0.5){
      float bandm = smoothstep(u_H - 0.050, u_H - 0.034, P.y);
      vec3 met = u_rimCol * (envColor(reflect(rd, N))*0.85 + vec3(0.15));
      for(int i=0;i<NL;i++){
        vec3 hr = reflect(u_lightDir[i], N);
        met += u_rimCol * u_lightCol[i] * pow(max(dot(hr, -rd), 0.0), 40.0) * 2.5 * dapple(P, i);
      }
      col = mix(col, met, bandm*0.92);
    }
  }else if(tLiq < tTable){
    // ---------- the open cola surface ----------
    hitT = tLiq;
    vec3 Pl = ro + rd*tLiq;
    vec2 rip = vec2(fbm(Pl.xz*26.0 + u_time*0.5), fbm(Pl.xz*26.0 + 9.0 - u_time*0.4)) - 0.5;
    vec3 Nl = normalize(vec3(rip.x*0.06, 1.0, rip.y*0.06));
    float frl = 0.02 + 0.98*pow(clamp(1.0 + dot(rd, Nl), 0.0, 1.0), 5.0);
    // transmission: refract into the liquid and look down at the sunlit base
    // through it — seen from above the cola is a lit amber column, only
    // turning mirror-like toward grazing angles (Fresnel)
    vec3 rd2 = refract(rd, Nl, 1.0/u_nLiq);
    float hL = max(u_liq - u_cavY, 0.02);              // depth to the cavity floor
    float path = hL / max(-rd2.y, 0.25);               // slanted rays travel further
    vec3 Pb = Pl + rd2*path;
    // the base glows with the sun pooling under the glass; the ripples above
    // make its light shimmer
    vec3 sunIn = vec3(0.0);
    for(int i=0;i<NL;i++) sunIn += u_lightCol[i] * dapple(Pl, i);
    vec3 bottom = (vec3(0.07, 0.065, 0.06) + 0.90*sunIn)
                * (0.80 + 0.40*fbm(Pb.xz*9.0 + rip*3.0));
    // Beer-Lambert alone carries the colour — no extra glow tint, which
    // used to drag pale liquids green-dark when seen from above
    vec3 deep = bottom * exp(-path * u_liqSig)
              + vec3(0.018, 0.011, 0.009);
    // turbid liquids: the depths are opaque — sunlit body colour instead
    float scS = 1.0 - exp(-path * u_turb * 7.0);
    deep = mix(deep, u_scatCol * (0.25 + 0.75*sunIn), scS);
    if(u_fizz > 0.01){
      // rising chains seen from above: bright pinpricks down in the liquid
      deep += vec3(0.9, 0.88, 0.82) * u_fizz * (0.3 + 0.7*dapple(Pl, 0))
            * fizzField(Pl + rd2*min(path*0.5, 0.2));
    }
    if(u_iceN > 0.5){
      // submerged ice seen down through the surface
      float tI = iceMarch(Pl, rd2, path);
      if(tI > 0.0) deep = shadeIce(Pl + rd2*tI, rd2) * exp(-tI * u_liqSig * 0.5);
    }
    col = mix(deep, envColor(reflect(rd, Nl))*0.85, clamp(frl + 0.02, 0.0, 1.0));
    for(int i=0;i<NL;i++){
      vec3 hr = reflect(u_lightDir[i], Nl);
      col += u_lightCol[i] * pow(max(dot(hr, -rd), 0.0), 300.0) * 2.0 * dapple(Pl, i);
    }
    // bright meniscus ring where the surface climbs the inner wall
    float rL = innerR(atan(Pl.z, Pl.x), u_liq);
    col += vec3(0.55, 0.50, 0.42)*exp(-pow((rL - length(Pl.xz))/0.012, 2.0))*0.5;
    if(u_fizz > 0.01){
      // foam collar hugging the wall + drifting bubble rafts mid-surface
      float edge = exp(-pow((rL - length(Pl.xz))/0.05, 2.0));
      float raft = smoothstep(0.62, 0.85, fbm(Pl.xz*14.0 + vec2(u_time*0.03, 0.0)));
      col += vec3(0.90, 0.87, 0.80) * (edge*0.8 + raft*0.35) * u_fizz
           * (0.3 + 0.7*dapple(Pl, 0));
    }
    if(u_iceN > 0.5){
      // the shoulders of the cubes ride above the surface — catch them
      // on the last stretch of the ray before it met the liquid
      float tIa = iceMarch(Pl - rd*0.45, rd, 0.44);
      if(tIa > 0.0) col = shadeIce(Pl - rd*0.45 + rd*tIa, rd);
    }
  }else if(tTable < 1e4){
    // ---------- the table ----------
    hitT = tTable;
    vec3 P = ro + rd*tTable;

    // ---------- procedural table surface ----------
    vec3 albedo = vec3(0.88, 0.87, 0.865);
    float sheen = 0.0;
    if(u_table < 0.5){
      // honed stone: stronger mottle + a fine-scale fbm layer + grain speckle
      albedo *= 0.93 + 0.12*fbm(P.xz*2.6);
      albedo *= 0.94 + 0.11*fbm(P.xz*11.0 + 3.3);
      albedo *= 0.985 + 0.03*(hash12(floor(P.xz*220.0)) - 0.5);
      float vein = smoothstep(0.014, 0.0, abs(fbm(P.xz*1.9 + 4.2) - 0.52));
      albedo += vec3(0.028, 0.027, 0.024)*vein;
    } else if(u_table < 1.5){
      // wood planks: per-plank tone, long grain, dark seams. The seams
      // waver a little — sawn boards, not a ruled grid
      float pw = 0.34;
      float wx = P.x + 0.020*(fbm(vec2(P.z*1.8, 7.7)) - 0.5);
      float plank = floor(wx/pw);
      vec3 wood = vec3(0.72, 0.55, 0.40)*(0.82 + 0.14*hash12(vec2(plank, 3.7)));
      wood *= 0.88 + 0.20*fbm(vec2(P.x*30.0, P.z*2.4) + plank*11.0);
      float edgeD = (0.5 - abs(fract(wx/pw) - 0.5))*pw;
      albedo = wood * mix(0.55, 1.0, smoothstep(0.004, 0.022, edgeD));
    } else if(u_table < 2.5){
      // glazed tiles: grid, grout, per-tile hue jitter, glossy faces —
      // domain-warped so the grout lines wander like handmade zellige
      float tw = 0.42;
      vec2 wq = P.xz + 0.014*(vec2(fbm(P.xz*2.3 + 5.1), fbm(P.xz*2.3 + 11.7)) - 0.5);
      vec2 tid = floor(wq/tw);
      vec2 tuv = fract(wq/tw) - 0.5;
      vec2 h2t = hash22(tid*3.1 + 9.7);
      vec3 tileC = vec3(0.90, 0.89, 0.87)*(0.94 + 0.10*h2t.x)
                 * mix(vec3(1.0), vec3(0.92, 0.97, 1.02), h2t.y*0.35);
      float tile = smoothstep(0.47, 0.44, max(abs(tuv.x), abs(tuv.y)));
      albedo = mix(vec3(0.62, 0.60, 0.57), tileC, tile);
      sheen = tile*0.5;
    } else {
      // cast concrete: broad blotches, pinprick air holes, faint trowel arcs
      albedo = vec3(0.78, 0.775, 0.765);
      albedo *= 0.93 + 0.10*fbm(P.xz*1.1 + 2.7);
      vec2 pid = floor(P.xz*90.0);
      vec2 pof = hash22(pid*1.9 + 3.3);
      float pr = 0.20 + 0.22*pof.y;              // hole size varies
      float pd = length(fract(P.xz*90.0) - 0.25 - 0.5*pof);
      float pin = step(0.958, hash12(pid)) * smoothstep(pr, pr*0.4, pd);
      albedo *= 1.0 - 0.30*pin;
      float arc = fbm(vec2(length(P.xz - vec2(1.3, -0.8))*4.0,
                           atan(P.z + 0.8, P.x - 1.3)*1.5));
      albedo *= 0.97 + 0.05*arc;
    }

    // ambient: skylight filtered through the leaves
    vec3 light = mix(u_ambS, u_ambL, 0.55*u_leaf);
    for(int i=0;i<NL;i++){
      light += u_lightCol[i] * dapple(P, i) * glassShadow(P, i) * 1.10;
    }
    col = albedo * light * u_sun;
    if(sheen > 0.0){
      // glazed faces catch a whisper of the sky at grazing angles
      float frt = pow(clamp(1.0 + rd.y, 0.0, 1.0), 3.0);
      col += envColor(reflect(rd, vec3(0.0, 1.0, 0.0))) * frt * sheen * 0.18;
    }

    // contact occlusion at the base
    float rr = length(P.xz);
    col *= 1.0 - 0.42*exp(-max(rr - u_baseR, 0.0)*9.0);

    // ---------- water pooled at the base ----------
    float pm = 0.0; vec2 pg = vec2(0.0);
    if(rr < 0.55){
      pm = puddleMask(P.xz);
      if(pm > 0.002){
        float pe = 0.006;
        pg = vec2(puddleMask(P.xz + vec2(pe,0.0)) - puddleMask(P.xz - vec2(pe,0.0)),
                  puddleMask(P.xz + vec2(0.0,pe)) - puddleMask(P.xz - vec2(0.0,pe))) / (2.0*pe);
        col *= 1.0 - 0.20*pm;                    // wet stone is darker
      }
    }

    // ---------- THE CAUSTIC ----------
    vec2 wig = clamp(pg, -3.0, 3.0) * pm * 0.004; // the film bends it slightly
    vec2 cuv = ((P.xz + wig) - u_caustC)/u_caustS * 0.5 + 0.5;
    if(all(greaterThan(cuv, vec2(0.0))) && all(lessThan(cuv, vec2(1.0)))){
      vec3 sharp = texture(u_caust,  cuv).rgb;
      vec3 soft  = texture(u_caustB, cuv).rgb;
      // soft-knee lift: brighten the faint filament structure against the
      // dapple without blowing out the hot cores
      vec3 ca = sharp*0.95 + soft*0.75;
      ca = pow(max(ca, vec3(0.0)), vec3(0.80)) * 0.85;
      col += ca * u_sun;
    }
    // water surface on top: sky mirror at the meniscus, glints, edge caustic
    if(pm > 0.002){
      vec3 Nw = normalize(vec3(-pg.x*0.018, 1.0, -pg.y*0.018));
      float fr = 0.02 + 0.98*pow(clamp(1.0 + dot(rd, Nw), 0.0, 1.0), 5.0);
      col = mix(col, envColor(reflect(rd, Nw)), fr*pm*0.85);
      for(int i=0;i<NL;i++){
        vec3 hr = reflect(u_lightDir[i], Nw);
        col += u_lightCol[i] * pow(max(dot(hr, -rd), 0.0), 240.0) * 4.0 * pm * dapple(P, i);
        // meniscus focuses sun onto the down-sun rim: bright wiggly line
        float ec = max(dot(normalize(pg + 1e-5), -normalize(u_lightDir[i].xz + 1e-5)), 0.0);
        col += u_lightCol[i] * ec * length(pg) * 0.020 * pm * dapple(P, i) * glassShadow(P, i);
      }
    }

    // fade the far table into the blown-out backdrop
    col = mix(col, u_backCol*0.96, smoothstep(4.0, 12.0, tTable));
  }else{
    // the backdrop is the environment, but overexposed like the video
    col = mix(envColor(rd), u_backCol, 0.45);
  }

  o = vec4(col, hitT);  // linear HDR + depth; FINAL_FS applies the film look
}
`;

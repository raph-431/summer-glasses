'use strict';
// GL setup, UI, audio, and the render loop. Shader sources come from
// shaders.js (loaded first as a plain script).

const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias:false, alpha:false });
if(!gl || !gl.getExtension('EXT_color_buffer_float')){
  document.getElementById('err').style.display = 'grid';
  throw new Error('webgl2/float unavailable');
}

// ---------------------------------------------------------------------------
// GL plumbing
// ---------------------------------------------------------------------------
function mkProg(vs, fs){
  const c = (t, s) => {
    const sh = gl.createShader(t);
    gl.shaderSource(sh, s); gl.compileShader(sh);
    if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(sh) + '\n---\n' + s.split('\n').map((l,i)=>`${i+1}: ${l}`).join('\n'));
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, c(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, c(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
function mkTarget(w, h, fmt, type){
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, fmt || gl.RGBA16F, w, h, 0, gl.RGBA, type || gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fb, w, h };
}

const photonProg = mkProg(PHOTON_VS, PHOTON_FS);
const fadeProg   = mkProg(QUAD_VS, FADE_FS);
const blurProg   = mkProg(QUAD_VS, BLUR_FS);
const compProg   = mkProg(QUAD_VS, COMP_FS);
const brightProg = mkProg(QUAD_VS, BRIGHT_FS);
const finalProg  = mkProg(QUAD_VS, FINAL_FS);
const expoProg   = mkProg(QUAD_VS, EXPO_FS);

const CAUST = 2048, BLUR = 512;
// texel-density compensation: 4× the texels share the same photon count,
// so the splat gain scales up to keep both modes' brightness (the finer
// grid is what buys the light painting its filament sharpness)
const CAUST_DENS = (CAUST/1024)*(CAUST/1024);
// ping-pong pair: each frame decays the other into itself, then adds photons
const caustPP = [mkTarget(CAUST, CAUST), mkTarget(CAUST, CAUST)];
let caustFlip = 0;
const CAUST_DECAY = 0.90;            // ~10-frame accumulation window

// LIGHT PAINTING (branch experiment): the render stops pretending to be a
// photograph — black void, and the accumulated caustic is the whole piece.
// The slow decay is a long exposure (~330 frames — five-plus seconds of
// memory) so the swaying light drags spectral trails; the gain is rescaled
// to the same steady state.
let lightPaint = true;               // L toggles live, for A/B against realism
const PAINT_DECAY = 0.997;
// auto-exposure servo: the ring's per-deal pose (offset/tilt) changes how
// many photons survive to the floor, so a fixed gain leaves some deals
// faint. Every 20 frames the accumulated pool's mean luminance is read back
// tiny (16×16) and the gain steered toward a target — slowly, because the
// buffer answers with a ~330-frame lag.
// 48×48 probe: fine enough that a thin scorching annulus (the contact ring
// at the glass base) still registers as a highlight instead of averaging
// away, as it did at 16×16 once the rings stopped moving
const EXPO = 48;
const expoBuf = new Uint8Array(EXPO*EXPO*4);
let expoGain = 1, expoN = 0;
const blurA = mkTarget(BLUR, BLUR);
const blurB = mkTarget(BLUR, BLUR);
const expoT = mkTarget(EXPO, EXPO, gl.RGBA8, gl.UNSIGNED_BYTE);  // readback probe

const GW = 512, GH = 288, NL = 3;
const NPHOT = GW*GH*NL;

const vao = gl.createVertexArray();  // attribute-less; gl_VertexID does the work
gl.bindVertexArray(vao);

const U = p => new Proxy({}, { get: (_, n) => gl.getUniformLocation(p, n) });
const uP = U(photonProg), uF = U(fadeProg), uB = U(blurProg),
      uC = U(compProg), uBr = U(brightProg), uFin = U(finalProg),
      uE = U(expoProg);

// the Proxy lookup hides typos (null location = silent no-op), so verify the
// profile uniforms actually exist in the composite program
for(const n of ['u_prof','u_H','u_y0','u_stemR','u_footR','u_footH','u_cavY','u_maxR','u_baseR','u_taY'])
  if(gl.getUniformLocation(compProg, n) === null) console.warn('missing uniform in comp:', n);

// screen-sized targets: HDR scene (bloom source) + quarter-res bloom pair
let scene = null, bloomA = null, bloomB = null;
function delTarget(t){ if(t){ gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); } }
function resize(){
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width  = Math.floor(innerWidth*dpr);
  canvas.height = Math.floor(innerHeight*dpr);
  delTarget(scene); delTarget(bloomA); delTarget(bloomB);
  scene  = mkTarget(canvas.width, canvas.height);
  const bw = Math.max(canvas.width >> 2, 1), bh = Math.max(canvas.height >> 2, 1);
  bloomA = mkTarget(bw, bh);
  bloomB = mkTarget(bw, bh);
}
addEventListener('resize', resize); resize();

// drag to orbit (drag deltas accumulate into the same smoothed target).
// Azimuth is UNclamped — keep dragging and you keep going around; one
// screen-width of drag is one full turn. SHIFT+drag (or the wheel) zooms.
let mouse = [0.5, 0.5], sm = [0.5, 0.5];
let zoom = 1, zoomSm = 1;
let dragging = false, lastXY = [0, 0];
const orbitTo = (x, y, zoomDrag) => {
  if(zoomDrag){
    zoom = Math.min(Math.max(zoom*Math.exp((y - lastXY[1])/240), 0.45), 2.6);
  } else {
    mouse[0] -= (x - lastXY[0])/innerWidth;
    mouse[1] = Math.min(Math.max(mouse[1] - (y - lastXY[1])/innerHeight, 0), 1);
  }
  lastXY = [x, y];
};
const endDrag = () => { dragging = false; canvas.style.cursor = 'grab'; };

// Mouse / pen via pointer events; touch is handled separately below so we can
// preventDefault it — some mobile browsers ignore touch-action:none inside an
// iframe and otherwise steal a one-finger drag for scrolling.
addEventListener('pointerdown', e => {
  if(e.pointerType === 'touch') return;
  if(e.target.closest('#ui')) return;         // panel clicks don't orbit
  dragging = true; lastXY = [e.clientX, e.clientY];
  canvas.style.cursor = 'grabbing';
});
addEventListener('pointermove', e => {
  if(dragging && e.pointerType !== 'touch') orbitTo(e.clientX, e.clientY, e.shiftKey);
});
addEventListener('wheel', e => {
  if(e.target.closest('#ui')) return;
  zoom = Math.min(Math.max(zoom*Math.exp(e.deltaY*0.0012), 0.45), 2.6);
}, { passive: true });
addEventListener('pointerup', e => { if(e.pointerType !== 'touch') endDrag(); });
addEventListener('pointercancel', e => { if(e.pointerType !== 'touch') endDrag(); });

// one-finger touch drag: preventDefault stops the page/iframe from scrolling
addEventListener('touchstart', e => {
  if(e.target.closest('#ui') || e.touches.length !== 1) return;
  dragging = true; lastXY = [e.touches[0].clientX, e.touches[0].clientY];
}, { passive: true });
addEventListener('touchmove', e => {
  if(!dragging || e.touches.length !== 1) return;
  e.preventDefault();
  orbitTo(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: false });
addEventListener('touchend', endDrag);
addEventListener('touchcancel', endDrag);

// S saves the next frame as PNG. There is no reroll control: a viewer gets
// exactly one deal per load. The #ui panel is never shown — it stays in the
// DOM purely as the state store that frame() reads every frame.
let wantShot = false;

// Snapshot-on-request, for a gallery showing many glasses: an embedder posts
// {type:'summer-glass-snapshot-request', id} and gets a JPEG data URL back
// once the caustic accumulation has settled (~10 frames of decay, so 15 is
// comfortable). Purely a read of already-rendered pixels — it consumes no
// randomness and cannot change which glass was dealt.
const SNAP_AFTER = 15;
let snapReq = null, snapFrames = 0;
addEventListener('message', e => {
  if(e.data && e.data.type === 'summer-glass-snapshot-request'){
    snapReq = e.data; snapFrames = 0;
  }
});
addEventListener('keydown', e => {
  if(e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if(e.key === 's' || e.key === 'S') wantShot = true;
  if(e.key === 'l' || e.key === 'L'){
    lightPaint = !lightPaint;
    expoN = 0;   // restart the exposure servo's charge model with the buffer
  }
});

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------------
// GLASS SHAPES — pure data. 8 outer-radius knots span the bowl from y0 to H
// (Catmull-Rom in the shader); stemware adds an analytic stem + foot below
// y0. cavBase is the glass depth of the cavity floor (the wall slider adds
// to it at runtime). fillMax caps the pour below the rim.
// ---------------------------------------------------------------------------
const SHAPES = {
  highball: { H:1.15, y0:0, knots:[0.240,0.250,0.260,0.270,0.279,0.289,0.299,0.309],
              stemR:0, footR:0, footH:0, cavBase:0.06, wall:0.045, fillMax:0.90 },
  rocks:    { H:0.78, y0:0, knots:[0.300,0.305,0.310,0.315,0.320,0.325,0.330,0.335],
              stemR:0, footR:0, footH:0, cavBase:0.10, wall:0.055, fillMax:0.88 },
  shot:     { H:0.42, y0:0, knots:[0.128,0.133,0.138,0.143,0.148,0.153,0.158,0.163],
              stemR:0, footR:0, footH:0, cavBase:0.09, wall:0.050, fillMax:0.85 },
  barrel:   { H:1.00, y0:0, knots:[0.245,0.285,0.312,0.328,0.330,0.318,0.295,0.268],
              stemR:0, footR:0, footH:0, cavBase:0.07, wall:0.045, fillMax:0.88 },
  flared:   { H:1.10, y0:0, knots:[0.205,0.210,0.218,0.230,0.248,0.272,0.305,0.345],
              stemR:0, footR:0, footH:0, cavBase:0.07, wall:0.040, fillMax:0.90 },
  wine:     { H:1.38, y0:0.60, knots:[0.055,0.150,0.225,0.258,0.256,0.242,0.226,0.214],
              stemR:0.032, footR:0.230, footH:0.022, cavBase:0.050, wall:0.028, fillMax:0.88 },
  martini:  { H:1.22, y0:0.70, knots:[0.045,0.105,0.165,0.225,0.285,0.345,0.405,0.465],
              stemR:0.028, footR:0.240, footH:0.020, cavBase:0.025, wall:0.024, fillMax:0.93 },
  flute:    { H:1.60, y0:0.55, knots:[0.050,0.095,0.125,0.138,0.142,0.140,0.132,0.122],
              stemR:0.028, footR:0.210, footH:0.020, cavBase:0.040, wall:0.022, fillMax:0.88 },
  goblet:   { H:1.15, y0:0.42, knots:[0.100,0.190,0.245,0.272,0.278,0.272,0.258,0.245],
              stemR:0.055, footR:0.250, footH:0.028, cavBase:0.050, wall:0.045, fillMax:0.85 },
  // the odd ones out: a near-spherical bulb that closes to a small mouth
  // (a genuine ball lens — its caustic is a blazing focal point), and a
  // laboratory cone with a slim neck and a tiny lip flare
  fishbowl: { H:1.24, y0:0, knots:[0.230,0.405,0.527,0.578,0.567,0.493,0.365,0.230],
              stemR:0, footR:0, footH:0, cavBase:0.08, wall:0.050, fillMax:0.80 },
  alembic:  { H:1.55, y0:0, knots:[0.475,0.406,0.338,0.269,0.200,0.131,0.110,0.120],
              stemR:0, footR:0, footH:0, cavBase:0.07, wall:0.036, fillMax:0.85 },
  // a full-size wine bottle: straight body, curved shoulder, slim neck with
  // a small lip. The tall cavBase stands in for the punt. Nothing fits
  // through that neck, hence noIce.
  bottle:   { H:2.05, y0:0, knots:[0.300,0.302,0.304,0.305,0.230,0.105,0.082,0.086],
              stemR:0, footR:0, footH:0, cavBase:0.12, wall:0.030, fillMax:0.78,
              noIce:true, patTop:1.10 },
};
let shape = null;
function applyShape(name){
  const s = SHAPES[name];
  shape = { ...s, prof: s.knots.slice() };
  $('wall').value = s.wall;
}
applyShape('highball');
$('shape').addEventListener('change', e => applyShape(e.target.value));

// ---------------------------------------------------------------------------
// TIME OF DAY — each preset is a full light environment: sun angle and
// colour, the two secondary foliage-gap lights, sky/leaf/ground palette for
// envColor, table ambient, backdrop, penumbra hardness.
// ---------------------------------------------------------------------------
const TIMES = {
  goldenAfternoon: {
    az:-1.95, el:0.60, soft:0.012, pen:1.0, leaf:0.85, amb:{cic:1.00, cri:0.00, bird:0.25},
    spec:[
      { daz: 0.00, del: 0.00, int: 1.00, col:[1.06,1.00,0.90], ph:0.0 },
      { daz: 0.38, del:-0.08, int: 0.22, col:[0.97,1.01,0.92], ph:3.1 },
      { daz:-0.45, del: 0.10, int: 0.15, col:[0.94,0.98,1.04], ph:7.4 },
    ],
    skyHor:[1.24,1.23,1.20], skyZen:[0.578,0.777,1.155],
    leafD:[0.10,0.26,0.06], leafL:[0.42,0.72,0.18],
    gnd0:[0.88,0.86,0.82], gnd1:[1.18,1.15,1.08],
    ambS:[0.24,0.28,0.37], ambL:[0.20,0.31,0.17], back:[1.20,1.19,1.16],
  },
  dawn: {
    az:-2.40, el:0.20, soft:0.010, pen:0.8, leaf:0.75, amb:{cic:0.15, cri:0.25, bird:1.00},
    spec:[
      { daz: 0.00, del: 0.00, int: 0.85, col:[1.18,0.86,0.74], ph:0.0 },
      { daz: 0.38, del:-0.04, int: 0.16, col:[1.05,0.90,0.86], ph:3.1 },
      { daz:-0.45, del: 0.08, int: 0.12, col:[0.90,0.92,1.06], ph:7.4 },
    ],
    skyHor:[1.32,1.08,1.02], skyZen:[0.46,0.60,0.98],
    leafD:[0.09,0.20,0.07], leafL:[0.40,0.58,0.18],
    gnd0:[0.80,0.78,0.80], gnd1:[1.06,1.00,1.00],
    ambS:[0.26,0.27,0.38], ambL:[0.20,0.26,0.18], back:[1.16,1.08,1.08],
  },
  morning: {
    az:-2.10, el:0.85, soft:0.010, pen:0.75, leaf:0.80, amb:{cic:0.50, cri:0.00, bird:0.70},
    spec:[
      { daz: 0.00, del: 0.00, int: 1.05, col:[1.03,1.01,0.95], ph:0.0 },
      { daz: 0.38, del:-0.08, int: 0.20, col:[0.98,1.01,0.94], ph:3.1 },
      { daz:-0.45, del: 0.10, int: 0.14, col:[0.93,0.98,1.06], ph:7.4 },
    ],
    skyHor:[1.24,1.25,1.24], skyZen:[0.50,0.70,1.12],
    leafD:[0.10,0.26,0.06], leafL:[0.44,0.74,0.20],
    gnd0:[0.87,0.87,0.84], gnd1:[1.16,1.15,1.10],
    ambS:[0.26,0.30,0.40], ambL:[0.21,0.32,0.18], back:[1.20,1.20,1.18],
  },
  noon: {
    az:-1.95, el:1.15, soft:0.008, pen:0.5, leaf:0.85, amb:{cic:1.00, cri:0.00, bird:0.12},
    spec:[
      { daz: 0.00, del: 0.00, int: 1.15, col:[1.05,1.02,0.97], ph:0.0 },
      { daz: 0.38, del:-0.08, int: 0.22, col:[0.99,1.01,0.95], ph:3.1 },
      { daz:-0.45, del: 0.10, int: 0.16, col:[0.95,0.99,1.05], ph:7.4 },
    ],
    skyHor:[1.28,1.28,1.26], skyZen:[0.42,0.62,1.05],
    leafD:[0.10,0.27,0.06], leafL:[0.45,0.76,0.20],
    gnd0:[0.90,0.89,0.86], gnd1:[1.20,1.18,1.12],
    ambS:[0.28,0.32,0.42], ambL:[0.22,0.33,0.19], back:[1.24,1.23,1.20],
  },
  sunset: {
    az:-2.30, el:0.16, soft:0.007, pen:0.85, leaf:0.80, amb:{cic:0.70, cri:0.15, bird:0.35},
    spec:[
      { daz: 0.00, del: 0.00, int: 1.10, col:[1.55,0.72,0.35], ph:0.0 },
      { daz: 0.38, del:-0.03, int: 0.18, col:[1.30,0.80,0.50], ph:3.1 },
      { daz:-0.45, del: 0.06, int: 0.10, col:[0.85,0.80,0.95], ph:7.4 },
    ],
    skyHor:[1.55,0.95,0.55], skyZen:[0.50,0.55,0.85],
    leafD:[0.10,0.20,0.06], leafL:[0.50,0.58,0.15],
    gnd0:[0.92,0.83,0.74], gnd1:[1.24,1.04,0.84],
    ambS:[0.24,0.24,0.34], ambL:[0.22,0.26,0.16], back:[1.30,1.10,0.90],
  },
  dusk: {
    az:-2.30, el:0.12, soft:0.014, pen:1.4, leaf:0.70, amb:{cic:0.25, cri:0.80, bird:0.08},
    spec:[
      { daz: 0.00, del: 0.00, int: 0.40, col:[0.95,0.62,0.55], ph:0.0 },
      { daz: 0.38, del:-0.02, int: 0.10, col:[0.70,0.65,0.80], ph:3.1 },
      { daz:-0.45, del: 0.05, int: 0.08, col:[0.55,0.60,0.85], ph:7.4 },
    ],
    skyHor:[0.78,0.70,0.86], skyZen:[0.28,0.33,0.62],
    leafD:[0.06,0.11,0.06], leafL:[0.22,0.28,0.14],
    gnd0:[0.54,0.54,0.62], gnd1:[0.70,0.69,0.78],
    ambS:[0.30,0.32,0.46], ambL:[0.24,0.28,0.26], back:[0.86,0.82,0.96],
  },
  night: {
    az:-1.95, el:0.45, soft:0.030, pen:1.6, leaf:0.55, night:true, amb:{cic:0.00, cri:1.00, bird:0.00},
    spec:[
      { daz: 0.00, del: 0.00, int: 0.70, col:[1.30,0.80,0.40], ph:0.0 },
      { daz: 0.42, del:-0.06, int: 0.32, col:[1.10,0.42,0.55], ph:3.1 },
      { daz:-0.42, del: 0.04, int: 0.28, col:[0.42,0.62,1.15], ph:7.4 },
    ],
    skyHor:[0.16,0.13,0.20], skyZen:[0.03,0.04,0.09],
    leafD:[0.02,0.03,0.02], leafL:[0.10,0.12,0.08],
    gnd0:[0.10,0.09,0.11], gnd1:[0.16,0.14,0.15],
    ambS:[0.06,0.07,0.12], ambL:[0.05,0.06,0.08], back:[0.14,0.12,0.18],
  },
};
$('tod').addEventListener('change', e => { $('leaf').value = TIMES[e.target.value].leaf; });

// ---------------------------------------------------------------------------
// LIQUIDS — hex feeds the colour picker (absorption), turb the turbidity
// slider, fizz the carbonation slider; scat is the body colour a turbid
// liquid scatters back; n the refractive index.
// ---------------------------------------------------------------------------
const LIQUIDS = {
  soda:      { hex:'#541c17', turb:0.04, n:1.34, fizz:0.80, scat:'#8a4a28' },
  oj:        { hex:'#e08a1e', turb:0.95, n:1.35, fizz:0.00, scat:'#f2a83c' },
  water:     { hex:'#f2f6f8', turb:0.00, n:1.33, fizz:0.00, scat:'#ffffff' },
  sparkling: { hex:'#f0f4f6', turb:0.02, n:1.33, fizz:1.20, scat:'#f4f6f8' },
  whiteWine: { hex:'#e8d68a', turb:0.03, n:1.36, fizz:0.00, scat:'#efe3a8' },
  redWine:   { hex:'#7a1622', turb:0.10, n:1.36, fizz:0.00, scat:'#a8323f' },
  rose:      { hex:'#f2c2a4', turb:0.05, n:1.36, fizz:0.00, scat:'#f6d8c2' },
  whiskey:   { hex:'#b05e14', turb:0.02, n:1.36, fizz:0.00, scat:'#d08428' },
  chartreuse:{ hex:'#bcd12e', turb:0.10, n:1.34, fizz:0.00, scat:'#d6e85a' },
  blueLagoon:{ hex:'#1e6fd8', turb:0.08, n:1.34, fizz:0.60, scat:'#4a9ae8' },
  icedTea:   { hex:'#8a4514', turb:0.06, n:1.34, fizz:0.00, scat:'#b06a2a' },
  champagne: { hex:'#eedc9a', turb:0.03, n:1.34, fizz:1.35, scat:'#f5ecb4' },
  spritz:    { hex:'#e8781a', turb:0.30, n:1.34, fizz:0.70, scat:'#f5a44e' },
  pastis:    { hex:'#ece0a6', turb:0.85, n:1.34, fizz:0.00, scat:'#f4ecc0' },
  appleJuice:{ hex:'#d8a428', turb:0.30, n:1.34, fizz:0.00, scat:'#ecc45e' },
  shirleyTemple:{ hex:'#cc2440', turb:0.10, n:1.34, fizz:0.85, scat:'#e8637a' },
  lemonade:  { hex:'#f6ecb4', turb:0.50, n:1.34, fizz:0.30, scat:'#faf4d0' },
  gin:       { hex:'#f2f6f4', turb:0.00, n:1.36, fizz:0.00, scat:'#ffffff' },
  ginFizz:   { hex:'#edeed6', turb:0.40, n:1.34, fizz:1.10, scat:'#f5f5e2' },
  empty:     { hex:'#f2f6f4', turb:0.00, n:1.33, fizz:0.00, scat:'#ffffff', empty:true },
};
let liquid = LIQUIDS.soda;
$('liquid').addEventListener('change', e => {
  liquid = LIQUIDS[e.target.value];
  $('colaCol').value = liquid.hex;
  $('turb').value = liquid.turb;
  $('fizz').value = liquid.fizz;
});

// ---- ice cubes: float at the surface, bob, drift, slowly spin -------------
const ICE = { pos:new Float32Array(9), r:new Float32Array(3), rot:new Float32Array(3),
              ang:[0.4, 2.5, 4.6], size:[0.100, 0.085, 0.075] };
// linear profile read for placement (the shader does the real spline)
function profR(y){
  const s = shape;
  if(y < s.y0) return Math.max(s.stemR, s.footR);
  const x = Math.min(Math.max((y - s.y0)/(s.H - s.y0), 0), 1)*7;
  const i = Math.min(Math.floor(x), 6), f = x - i;
  return s.prof[i]*(1-f) + s.prof[i+1]*f;
}

// ---------------------------------------------------------------------------
// RANDOMIZE — deal one coherent random glass. Every choice is applied by
// setting the DOM controls, so the panel always reflects the real state and
// frame()'s per-frame reads pick everything up with no parallel state.
// ---------------------------------------------------------------------------
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.min(Math.floor(r()*arr.length), arr.length - 1)];
const rng  = (r, a, b) => a + r()*(b - a);

// what belongs in what: no soda martinis, no ice in the wine
const SHAPE_LIQUIDS = {
  highball: ['soda','oj','water','sparkling','chartreuse','blueLagoon','icedTea',
             'pastis','lemonade','shirleyTemple','ginFizz','appleJuice'],
  rocks:    ['whiskey','soda','icedTea','empty','blueLagoon','gin'],
  shot:     ['whiskey','empty','water','gin'],
  barrel:   ['soda','oj','icedTea','water','chartreuse','appleJuice','lemonade','shirleyTemple'],
  flared:   ['oj','water','sparkling','rose','icedTea','lemonade','appleJuice','pastis','ginFizz'],
  wine:     ['redWine','whiteWine','rose','empty','spritz'],
  martini:  ['blueLagoon','rose','whiteWine','empty','gin'],
  flute:    ['sparkling','rose','whiteWine','champagne'],
  goblet:   ['redWine','chartreuse','blueLagoon','soda','water','spritz','appleJuice'],
  fishbowl: ['chartreuse','blueLagoon','water','soda','lemonade','shirleyTemple','ginFizz'],
  alembic:  ['water','pastis','blueLagoon','icedTea','lemonade','empty'],
  bottle:   ['redWine','whiteWine','rose','water'],
};
const SHAPE_PATTERNS = {
  highball: ['1','2','3','0','4','5','6'], rocks: ['1','0','2','4','5','6'], shot: ['3','2','0','1'],
  barrel: ['0','2','4','1','5','6'], flared: ['0','2','1','6'], wine: ['0','2','3','6'],
  martini: ['0','2','1','6'], flute: ['0','2','3','6'], goblet: ['1','4','2','3','5','6'],
  fishbowl: ['0','2','5','1'], alembic: ['0','2','3','6'],
  bottle: ['0','1','2','3','4','5','6'],
};
const GLASS_TINTS = ['#eefbf1','#eefbf1','#eefbf1','#e8f2fa','#f8ece8','#eaf6e2',
                     '#d8ecf6','#f6e6d8','#e6dcf2','#d2e9e4','#f2dede','#dfe8c9'];
// the occasional boldly coloured glass, like a mixed vintage set
const SAT_TINTS = ['#2e62c9','#1f8f8a','#c98a2e','#c02e48','#7a8f2e',
                   '#7a4fc0','#5a5a60','#d06a8a'];
const RIM_ODDS = { wine:0.35, martini:0.35, flute:0.40, goblet:0.30 };
const COLD_LIQS = ['soda','water','icedTea','chartreuse','blueLagoon','oj','sparkling','whiskey',
                   'gin','lemonade','shirleyTemple','ginFizz'];

// ---------------------------------------------------------------------------
// TOKEN HASH — the single entropy source of a deal. Priority: an injected
// window.TOKEN_HASH (set by the minted token's bootstrap) → #seed=<hex> in
// the URL (reproduce a specific deal) → fresh randomness (dev). Everything
// that defines the piece's identity flows from this one string through
// randomize(); per-frame photon sampling and the audio stay Math.random() —
// they are temporal dither and ambience, not identity.
// ---------------------------------------------------------------------------
const TOKEN_MODE = typeof window.TOKEN_HASH === 'string';
const tokenHash = (() => {
  if(TOKEN_MODE) return window.TOKEN_HASH.toLowerCase();
  const m = location.hash.match(/seed=([0-9a-fx]+)/i);
  if(m) return m[1].toLowerCase();
  let h = '0x';
  for(let i = 0; i < 64; i++) h += '0123456789abcdef'[(Math.random()*16)|0];
  return h;
})();
console.log('deal seed: ' + tokenHash + ' — reproduce with index.html#seed=' + tokenHash.slice(2));

// xmur3 string hash: folds the token hash into the 32-bit seed mulberry32
// wants. Any hex string works — length and content both change the outcome.
function xmur3(str){
  let h = 1779033703 ^ str.length;
  for(let i = 0; i < str.length; i++){
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = h << 13 | h >>> 19;
  }
  return () => {
    h = Math.imul(h ^ h >>> 16, 2246822507);
    h = Math.imul(h ^ h >>> 13, 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
let seed = xmur3(tokenHash)()|0;
let glassN = 1.51;      // refractive index; crystal deals raise it
let isCrystal = false;  // labels the info panel
let spillSeed = 0;      // puddle outline        — rolled per deal in randomize()
let canRot = 0;         // palm/pergola bearing  — ditto
let tabRot = 0;         // wood plank direction  — ditto
// light painting: THREE neon rings, one per light slot, each in its own
// colour and its own pose — offset from the glass axis, tilted out of
// level, its own radius. All rolled per deal; each precesses slowly.
const ringOffA = [0, 0, 0], ringOffR = [0.3, 0.3, 0.3];   // offset bearing + distance (× maxR)
const ringTiltA = [0, 0, 0], ringTilt = [0.15, 0.15, 0.15]; // tilt bearing + angle (rad)
const ringRF = [1, 1, 1];                                 // per-ring radius jitter
const ringHF = [1, 1, 1];  // height fraction: 0 = hanging low beside the bowl
const ringArc = [0.4, 0.4, 0.4];  // emission arc: how much tube a wall point
                                  // sees — the ring's optical softness
// ONE colored hoop per deal now (slot 0 — the other slots' poses are rolled
// but dormant); its colour comes from this neon palette
const NEONS = [
  [1.05, 0.12, 0.62],   // magenta
  [0.10, 0.85, 1.05],   // cyan
  [1.00, 0.62, 0.10],   // amber
  [0.55, 1.00, 0.12],   // acid green
  [1.05, 0.22, 0.15],   // red-orange
  [0.55, 0.25, 1.10],   // violet
  [0.35, 0.65, 1.10],   // ice blue
  [1.05, 0.45, 0.75],   // pink
];
let ringCol = NEONS[0];
// curated companion per NEONS entry (by index): the LONE BULB wears the
// hoop's duo colour — pairings chosen by eye, not derived, so none land
// on a muddy in-between
const DUOS = [
  [0.15, 0.95, 0.75],   // magenta    → teal
  [1.00, 0.62, 0.10],   // cyan       → amber
  [0.35, 0.65, 1.10],   // amber      → ice blue
  [1.05, 0.12, 0.62],   // acid green → magenta
  [0.10, 0.85, 1.05],   // red-orange → cyan
  [1.05, 0.52, 0.10],   // violet     → warm orange
  [1.05, 0.45, 0.75],   // ice blue   → pink
  [0.10, 0.85, 1.05],   // pink       → cyan
];
// a bare distant sun over the void (slot 2): classical parallel-ray caustic
// cutting across the hoop's mandala. Warm white; pose rolled per deal.
let paintSunAz = 0.8, paintSunEl = 0.9;
// splashed-metal skin over the glass (light painting): noise blotches of
// opaque mirror — they block the caustic light and bounce it instead
let metal = 0, metalSeed = 0, metalCol = [0.92, 0.94, 0.98];
let metalScale = 3, metalWarp = 1;   // blotch size + how stringy they smear
let metalType = 1;   // 0 winding bands, 1 splashes, 2 spots, 3 filaments
const METALS = [[0.92, 0.94, 0.98],   // silver
                [1.00, 0.78, 0.38],   // gold
                [0.98, 0.55, 0.38]];  // copper
// the small WHITE ring inside the glass — free to tilt hard and to pierce
// the wall; deliberately unphysical
let wOffA = 0, wOffR = 0.2;   // centre offset bearing + distance (× maxR)
let wTiltA = 0, wTilt = 0.3;  // tilt bearing + angle (rad)
let wRF = 0.6, wHF = 0.5;     // radius (× maxR) and height fraction
let wN = 8, wSpan = 3.0, wPh0 = 0;  // it's a STRING OF BULBS along an arc:
                                    // count, span (rad), start phase
let bulbCol = [1, 1, 0.96];         // the bulb's colour: the hoop's duo
const BULBS = true;   // back on — but as a single bulb (see the roll)
const RING_R = [2.1, 2.6, 3.1];      // base radii (× maxR): nested hoops
// (precession parked: everything holds still while we study the detail —
// restore by adding a slow per-ring drift back onto ringTiltA in frame())
const ringCArr = new Float32Array(9), ringUArr = new Float32Array(9),
      ringVArr = new Float32Array(9);
function randomize(){
  const r = mulberry32(seed = (seed*1664525 + 1013904223)|0);
  const set = (id, v) => { $(id).value = v; };

  const shapeName = pick(r, Object.keys(SHAPES));
  $('shape').value = shapeName; applyShape(shapeName);
  // jitter the knots ±5%, delta-clamped so the raymarcher stays stable.
  // The clamp is relative to each shape's own base deltas (an absolute cap
  // would flatten deliberately steep profiles like the fishbowl's bulb)
  shape.prof = shape.prof.map(k => k*(0.95 + 0.10*r()));
  for(let i=1;i<8;i++){
    const d0 = SHAPES[shapeName].knots[i] - SHAPES[shapeName].knots[i-1];
    const d = shape.prof[i] - shape.prof[i-1];
    shape.prof[i] = shape.prof[i-1] + Math.min(Math.max(d, d0 - 0.05), d0 + 0.05);
  }
  // EXPERIMENT: wall thickness thrown wide too — from near-lab-glass thin
  // to half-solid slabs (thick walls are giant lenses: long glass chords,
  // heavy refraction, the fattest caustic folds in the piece)
  set('wall', (shape.wall*rng(r, 0.50, 2.20)).toFixed(3));
  set('irr', (r() < 0.25 ? rng(r, 1.0, 1.45) : rng(r, 0.2, 0.9)).toFixed(2));
  const hasBub = r() < 0.10;                 // seeded glass is the exception
  set('bub', (hasBub ? rng(r, 0.6, 1.0) : 0).toFixed(2));
  set('bubSz', hasBub && r() < 0.5 ? 2 : 1); // half normal seeds, half chunky
  $('rim').checked = r() < (RIM_ODDS[shapeName] ?? 0.08);
  set('glassCol', r() < 0.10 ? pick(r, SAT_TINTS) : pick(r, GLASS_TINTS));

  // EXPERIMENT: any pattern on any shape — the curated SHAPE_PATTERNS
  // pairing is parked with realism — and the pattern dials thrown wide:
  // deeper cuts, giant-to-hairline repeat counts, squashed-to-stretched
  // aspects. Extremes may flirt with raymarch artifacts; that's the deal.
  set('pat', String(Math.floor(r()*7)));
  set('facet', rng(r, 0.3, 2.4).toFixed(2));
  set('diam', rng(r, 0.3, 3.0).toFixed(2));
  set('diamN', Math.round(rng(r, 5, 48)));
  set('disp', rng(r, 0.1, 1.4).toFixed(2));

  // crystal: harder refraction, real fire, deep cuts. EXPERIMENT: half of
  // ALL bodies are crystal (no stemware bias), and COLOURED crystal is
  // allowed — the body keeps whatever tint it rolled, so cobalt or amber
  // crystal with deep cuts is a real deal now
  const crystal = r() < 0.50;
  isCrystal = crystal;
  glassN = crystal ? rng(r, 1.55, 1.58) : rng(r, 1.50, 1.52);
  if(crystal){
    set('disp', rng(r, 1.2, 1.9).toFixed(2));
    set('facet', rng(r, 1.1, 2.4).toFixed(2));
    // (no pattern re-pick and no water-clear override: only the optics
    // say crystal)
  }

  // A brimful glass — a generous pour right up near the rim — is a deliberate
  // rarity, the counterpart to the ordinary pour. Its odds are set here rather
  // than left to fall out of how many drinks each shape happens to allow. The
  // glass is never left empty: there is always a drink in it.
  const FULL_ODDS = 0.05;
  const pours = SHAPE_LIQUIDS[shapeName].filter(l => l !== 'empty');
  const liqName = pick(r, pours);
  $('liquid').value = liqName;
  liquid = LIQUIDS[liqName];
  set('colaCol', liquid.hex);
  set('turb', Math.min(1, liquid.turb*rng(r, 0.7, 1.3)).toFixed(2));
  set('fizz', (liquid.fizz*rng(r, 0.6, 1.3)).toFixed(2));
  const brimful = r() < FULL_ODDS;
  const fillV = brimful ? rng(r, 0.92, 1.0) : rng(r, 0.4, 0.88);
  set('liq', fillV.toFixed(2));

  // ice belongs in tumblers holding a cold drink, with at least a half pour —
  // but never in a brimful glass, where a floating cube would crest the rim
  const iceOK = shape.y0 === 0 && !shape.noIce && !liquid.empty && fillV >= 0.5
             && !brimful && COLD_LIQS.includes(liqName);
  $('ice').value = iceOK ? pick(r, ['0','1','1','2','2','3']) : '0';

  // condensation follows the cold: iced or fizzy sweats, wine stays dry
  const cold = (iceOK && $('ice').value !== '0') || liquid.fizz > 0.3;
  set('cond', (cold ? rng(r, 0.6, 1.3) : rng(r, 0.0, 0.25)).toFixed(2));

  const todName = pick(r, Object.keys(TIMES));
  $('tod').value = todName;
  const tPick = r();
  $('table').value = tPick < 0.45 ? '0' : tPick < 0.60 ? '1' : tPick < 0.75 ? '4'
                   : tPick < 0.90 ? '2' : '3';
  const cPick = r();
  $('canopy').value = cPick < 0.40 ? '0' : cPick < 0.60 ? '1' : cPick < 0.75 ? '2'
                    : cPick < 0.90 ? '3' : '4';
  set('leaf', Math.min(1, TIMES[todName].leaf*rng(r, 0.8, 1.15)).toFixed(2));
  set('wind', rng(r, 0.2, 1.15).toFixed(2));
  set('sun', rng(r, 0.65, 1.0).toFixed(2));
  spillSeed = r();
  canRot = r()*6.2832;
  tabRot = r()*6.2832;
  // neon ring poses (appended after the older rolls so existing seeds keep
  // dealing the same glass): never perfectly centred, never perfectly flat
  for(let i=0;i<3;i++){
    ringRF[i] = rng(r, 0.88, 1.14);          // rolled first: it caps the offset
    ringOffA[i] = r()*6.2832;
    // centres pushed well off-axis — but a hoop that hangs low must never
    // pass through the glass, so the reach scales with this ring's radius
    ringOffR[i] = rng(r, 0.35, Math.min(1.4, RING_R[i]*ringRF[i] - 1.25));
    ringTiltA[i] = r()*6.2832;
    ringTilt[i] = rng(r, 0.08, 0.28);
    ringHF[i] = Math.pow(r(), 1.5);          // height, biased toward LOW
    // emission arc, log-uniform 0.08–0.9 rad: lace ↔ glow reads evenly
    ringArc[i] = 0.08*Math.exp(r()*2.42);
  }
  // the lone hoop reclaims the radius range the three used to span; its
  // reach cap must follow so a low hoop still clears the glass
  ringRF[0] = rng(r, 0.90, 1.55);
  ringOffR[0] = Math.min(ringOffR[0], RING_R[0]*ringRF[0] - 1.25);
  const hoopIdx = Math.floor(r()*NEONS.length);
  ringCol = NEONS[hoopIdx];
  paintSunAz = r()*6.2832;
  paintSunEl = rng(r, 0.26, 1.05);     // 15°–60°: low rakes to high noon-ish,
                                       // always steep enough to land a fan
  // splashed metal: nearly every deal wears some
  metal = r() < 0.95 ? rng(r, 0.15, 0.65) : 0;
  metalSeed = r()*100;
  metalCol = pick(r, METALS);
  metalScale = 1.8*Math.exp(r()*1.5);  // log-uniform 1.8–8: islands..speckle
  metalWarp = rng(r, 0.0, 2.2);        // 0 round blobs .. stringy splatter
  metalType = Math.floor(r()*4);       // bands / splashes / spots / filaments
  // the lone bulb wears the hoop's curated duo colour (metals stay metals)
  bulbCol = DUOS[hoopIdx];
  // the white bulb circle: pushed well off-centre — often halfway out the
  // wall — and slanted anywhere from a polite tip to a hard ~64° keel
  // (pow-biased: usually moderate, sometimes steep)
  // radius first — the offset scales with it. Log-uniform 0.30–1.60 × maxR:
  // from a tight coronet deep in the bowl to a wide halo ringing the
  // outside of the glass entirely
  wRF = 0.30*Math.exp(r()*1.674);
  wOffA = r()*6.2832;
  // offset proportional to the circle's own radius so big halos actually
  // READ as off-centre (an offset small relative to the radius still looks
  // concentric no matter its absolute size)
  wOffR = rng(r, 0.50, 1.10) * Math.max(wRF, 0.55);
  wTiltA = r()*6.2832;
  wTilt = 0.10 + 1.02*Math.pow(r(), 1.6);
  wHF = rng(r, 0.30, 0.80);
  // ONE white bulb: a lone point of light hanging somewhere on the rolled
  // circle — all the string's photons pour into it, so its single caustic
  // fan is the crispest light in the piece. (Restore 5 + floor(r()*8) for
  // the full string.)
  wN = 1;
  wSpan = 6.2831853;
  wPh0 = r()*6.2832;                         // where on the circle it hangs
  // machine-readable deal summary for marketplaces/indexers (same wording
  // as the info panel)
  window.$features = {
    drink:     selText('liquid'),
    glassware: (isCrystal ? 'crystal ' : '') + selText('shape'),
    pattern:   selText('pat'),
    timeOfDay: selText('tod'),
    canopy:    selText('canopy'),
    table:     selText('table'),
    ice:       +$('ice').value,
  };
  window.onDeal?.();   // optional hook — haiku.js captions the deal if loaded
  if(infoPanel.style.display === 'block') fillInfo();
}

// ---- info panel: what's on the table right now ----------------------------
const infoPanel = $('infoPanel');
const selText = id => { const s = $(id); return s.options[s.selectedIndex].text; };
function fillInfo(){
  infoPanel.innerHTML =
    `<div><span>drink</span>${selText('liquid')}</div>` +
    `<div><span>glassware</span>${isCrystal ? 'crystal ' : ''}${selText('shape')}</div>` +
    `<div><span>pattern</span>${selText('pat')}</div>` +
    `<div><span>time of day</span>${selText('tod')}</div>`;
}
// same capture the S key uses — the frame has to be grabbed inside the
// render loop, so this only raises the flag
$('shotBtn').addEventListener('click', () => { wantShot = true; });

$('infoBtn').addEventListener('click', () => {
  const open = infoPanel.style.display === 'block';
  if(!open) fillInfo();
  infoPanel.style.display = open ? 'none' : 'block';
});
// dev hook: load index.html#randtest to hammer the randomizer for errors.
// Inert in token mode — a minted token shows exactly its one deal.
if(!TOKEN_MODE && location.hash === '#randtest'){ for(let i=0;i<60;i++) randomize(); }

// dev hooks: #fps shows a frame-rate meter; #perftest also loads the
// heaviest combination we ship (ice + fizz + night bulbs + hobnail + tiles)
const fpsEl = (location.hash.includes('fps') || location.hash.includes('perftest'))
  ? document.body.appendChild(Object.assign(document.createElement('div'), {
      textContent: '… fps',
      style: 'position:fixed;top:10px;right:12px;z-index:3;font:13px monospace;' +
             'color:#fff;background:rgba(0,0,0,.55);padding:4px 8px;border-radius:6px;',
    }))
  : null;
let fpsAcc = 0, fpsN = 0, fpsLast = performance.now();
if(location.hash.includes('perftest')){
  $('shape').value = 'highball'; applyShape('highball');
  $('liquid').value = 'sparkling'; liquid = LIQUIDS.sparkling;
  $('colaCol').value = liquid.hex;
  $('turb').value = 0.3; $('fizz').value = 1.5; $('liq').value = 0.85;
  $('ice').value = '3'; $('cond').value = 1.3;
  $('bub').value = 0.9; $('bubSz').value = 2;
  $('pat').value = '4'; $('diamN').value = 32;
  $('tod').value = 'night'; $('leaf').value = 0.9;
  $('table').value = '2'; $('rim').checked = true;
}

// hex colour -> linear rgb -> Beer-Lambert absorption spectrum
function hexLin(hex){
  return [1,3,5].map(i => Math.pow(Math.max(parseInt(hex.slice(i,i+2),16)/255, 0.02), 2.2));
}
function sigFrom(hex, refLen){
  return hexLin(hex).map(v => -Math.log(v)/refLen);
}

// smooth 1D noise: incommensurate sines, roughly in [-1, 1]
const snz = (t, s) => 0.55*Math.sin(t + s) + 0.30*Math.sin(t*2.17 + s*1.7 + 1.3)
                    + 0.15*Math.sin(t*4.71 + s*0.9 + 4.1);

// ---------------------------------------------------------------------------
// CICADAS — procedural, matched to the video's audio analysis:
// noise band centred ~4.7 kHz, gated by ~200 Hz click trains (several
// insects at slightly different rates beating together), slow chorus swell.
// ---------------------------------------------------------------------------
let AU = null;
function buildAudio(){
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const master = ctx.createGain(); master.gain.value = 0.0;
  const comp = ctx.createDynamicsCompressor();
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000;
  master.connect(comp); comp.connect(lp); lp.connect(ctx.destination);

  // shared looping white-noise buffer
  const nbuf = ctx.createBuffer(1, ctx.sampleRate*2, ctx.sampleRate);
  const nd = nbuf.getChannelData(0);
  for(let i=0;i<nd.length;i++) nd[i] = Math.random()*2 - 1;

  const pulseCurve = new Float32Array(256);   // sine -> spiky click pulses
  for(let i=0;i<256;i++){ const x = i/255*2 - 1; pulseCurve[i] = Math.pow(Math.max(x,0), 6); }
  const trillCurve = new Float32Array(256);   // sine -> on/off trill plateau
  for(let i=0;i<256;i++){ const x = i/255*2 - 1; trillCurve[i] = Math.min(Math.max((x - 0.1)/0.3, 0), 1); }

  // three ambience groups, crossfaded by the time-of-day preset
  const cicG  = ctx.createGain(); cicG.gain.value = 1;  cicG.connect(master);
  const criG  = ctx.createGain(); criG.gain.value = 0;  criG.connect(master);
  const birdG = ctx.createGain(); birdG.gain.value = 0; birdG.connect(master);

  // three near cicadas. Measured: click trains ~112 Hz, energy 4.3-5.3 kHz,
  // and the whole song surging at ~5 Hz (the orni "cha-cha-cha")
  const voices = [
    { rate: 112, freq: 4550, pan: -0.5, lvl: 0.42, lfo: 0.11, surge: 5.1, sph: 0.0 },
    { rate: 108, freq: 5050, pan:  0.4, lvl: 0.34, lfo: 0.07, surge: 4.7, sph: 2.1 },
    { rate: 117, freq: 4800, pan:  0.1, lvl: 0.27, lfo: 0.16, surge: 5.4, sph: 4.2 },
  ];
  const t0 = ctx.currentTime;
  for(const v of voices){
    const src = ctx.createBufferSource(); src.buffer = nbuf; src.loop = true;
    src.playbackRate.value = 0.97 + Math.random()*0.06;
    const bp1 = ctx.createBiquadFilter(); bp1.type='bandpass'; bp1.frequency.value=v.freq; bp1.Q.value=3.0;
    const bp2 = ctx.createBiquadFilter(); bp2.type='bandpass'; bp2.frequency.value=v.freq*1.02; bp2.Q.value=3.4;
    // click-train gate
    const gate = ctx.createGain(); gate.gain.value = 0.05;
    const osc = ctx.createOscillator(); osc.frequency.value = v.rate;
    const shp = ctx.createWaveShaper(); shp.curve = pulseCurve;
    const oscG = ctx.createGain(); oscG.gain.value = 1.3;
    osc.connect(shp); shp.connect(oscG); oscG.connect(gate.gain);
    // the ~5 Hz surge that gives the song its cha-cha-cha pulse
    const surge = ctx.createGain(); surge.gain.value = 0.68;
    const so = ctx.createOscillator(); so.frequency.value = v.surge;
    const soG = ctx.createGain(); soG.gain.value = 0.30;
    so.connect(soG); soG.connect(surge.gain);
    so.start(t0 + v.sph/10);
    // slow individual swell
    const swell = ctx.createGain(); swell.gain.value = 0.75;
    const lfo = ctx.createOscillator(); lfo.frequency.value = v.lfo;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.25;
    lfo.connect(lfoG); lfoG.connect(swell.gain);
    const pan = ctx.createStereoPanner(); pan.pan.value = v.pan;
    const out = ctx.createGain(); out.gain.value = v.lvl;
    src.connect(bp1); bp1.connect(bp2); bp2.connect(gate);
    gate.connect(surge); surge.connect(swell); swell.connect(pan); pan.connect(out); out.connect(cicG);
    src.start(); osc.start(); lfo.start();
  }

  // distant chorus bed: wider band, gentle 30 Hz roughness, no clear clicks
  {
    const src = ctx.createBufferSource(); src.buffer = nbuf; src.loop = true;
    src.playbackRate.value = 1.01;
    const bp = ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=4800; bp.Q.value=0.9;
    const gate = ctx.createGain(); gate.gain.value = 0.75;
    const osc = ctx.createOscillator(); osc.frequency.value = 31;
    const oscG = ctx.createGain(); oscG.gain.value = 0.20;
    osc.connect(oscG); oscG.connect(gate.gain);
    const out = ctx.createGain(); out.gain.value = 0.16;
    src.connect(bp); bp.connect(gate); gate.connect(out); out.connect(cicG);
    src.start(); osc.start();
  }

  // leaf rustle bed, driven by the wind + gusts from the render loop
  const rustle = ctx.createGain(); rustle.gain.value = 0.0;
  {
    const src = ctx.createBufferSource(); src.buffer = nbuf; src.loop = true;
    src.playbackRate.value = 0.5;
    const lp2 = ctx.createBiquadFilter(); lp2.type='lowpass'; lp2.frequency.value=1600;
    const hp = ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=300;
    src.connect(lp2); lp2.connect(hp); hp.connect(rustle); rustle.connect(master);
    src.start();
  }

  // CRICKETS — near-pure tones ~4.5 kHz: a fast pulse inside a slow trill,
  // two voices out of step. The night sound.
  const cvoices = [
    { f: 4300, rate: 24, chirp: 1.10, pan: -0.40, lvl: 0.20 },
    { f: 4750, rate: 27, chirp: 0.83, pan:  0.35, lvl: 0.16 },
  ];
  for(const v of cvoices){
    const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = v.f;
    const g1 = ctx.createGain(); g1.gain.value = 0;         // pulse gate
    const p1 = ctx.createOscillator(); p1.frequency.value = v.rate;
    const s1 = ctx.createWaveShaper(); s1.curve = pulseCurve;
    p1.connect(s1); s1.connect(g1.gain);
    const g2 = ctx.createGain(); g2.gain.value = 0;         // trill envelope
    const p2 = ctx.createOscillator(); p2.frequency.value = v.chirp;
    const s2 = ctx.createWaveShaper(); s2.curve = trillCurve;
    p2.connect(s2); s2.connect(g2.gain);
    const pan = ctx.createStereoPanner(); pan.pan.value = v.pan;
    const out = ctx.createGain(); out.gain.value = v.lvl;
    osc.connect(g1); g1.connect(g2); g2.connect(pan); pan.connect(out); out.connect(criG);
    osc.start(); p1.start(); p2.start();
  }

  // BIRDS — short whistled phrases scheduled at random: a sine that hops
  // and sweeps through a few notes, then silence until the next call
  function birdChirp(){
    if(ctx.state === 'running'){
      const t0 = ctx.currentTime + 0.05;
      const osc = ctx.createOscillator(); osc.type = 'sine';
      const g = ctx.createGain(); g.gain.value = 0;
      const pan = ctx.createStereoPanner(); pan.pan.value = Math.random()*1.4 - 0.7;
      osc.connect(g); g.connect(pan); pan.connect(birdG);
      const base = 2600 + Math.random()*1600;
      const notes = 2 + (Math.random()*4|0);
      let tt = t0;
      for(let i=0;i<notes;i++){
        const f0 = base*(0.9 + Math.random()*0.25);
        const dur = 0.05 + Math.random()*0.09;
        osc.frequency.setValueAtTime(f0, tt);
        osc.frequency.exponentialRampToValueAtTime(f0*(0.8 + Math.random()*0.5), tt + dur);
        g.gain.setValueAtTime(0, tt);
        g.gain.linearRampToValueAtTime(0.20, tt + dur*0.3);
        g.gain.linearRampToValueAtTime(0, tt + dur);
        tt += dur + 0.03 + Math.random()*0.08;
      }
      osc.start(t0); osc.stop(tt + 0.1);
    }
    setTimeout(birdChirp, 1500 + Math.random()*5000);
  }
  birdChirp();

  return { ctx, master, rustle, cicG, criG, birdG };
}
const audioBtn = document.getElementById('audioBtn');
audioBtn.addEventListener('click', () => {
  if(!AU){ AU = buildAudio(); }
  if(AU.ctx.state === 'suspended') AU.ctx.resume();
  const on = audioBtn.classList.toggle('on');
  AU.master.gain.setTargetAtTime(on ? 0.45 : 0.0, AU.ctx.currentTime, 0.4);
});

const start = performance.now();
function frame(){
  const t = (performance.now() - start)/1000;
  if(fpsEl){
    const now = performance.now();
    fpsAcc += now - fpsLast; fpsLast = now; fpsN++;
    if(fpsAcc > 500){
      fpsEl.textContent = (1000*fpsN/fpsAcc).toFixed(0) + ' fps';
      fpsAcc = 0; fpsN = 0;
    }
  }
  sm[0] += (mouse[0]-sm[0])*0.05;
  sm[1] += (mouse[1]-sm[1])*0.05;
  zoomSm += (zoom - zoomSm)*0.08;

  const wind  = parseFloat($('wind').value);
  const facet = parseFloat($('facet').value);
  const wallv = parseFloat($('wall').value);
  // fill slider is a fraction of the usable cavity, so it means the same
  // thing on a shot glass and a highball
  const fillF = parseFloat($('liq').value);
  const cavY  = shape.y0 + shape.cavBase + wallv*1.3;
  // an empty glass parks the surface just below the cavity floor.
  // Light painting pours the drink out: the caustic is pure glass — no
  // absorption, no ember — so the accumulated filaments stay spectral
  const liq   = (liquid.empty || lightPaint) ? cavY - 0.02
              : cavY + fillF*(shape.H*shape.fillMax - cavY);
  const maxR  = Math.max(...shape.prof, shape.footR);
  const baseR = shape.y0 > 0 ? shape.footR : shape.prof[0];

  // ice rides the liquid surface; below a half pour there's no room for it
  const iceN = (liquid.empty || lightPaint || fillF < 0.5) ? 0 : parseInt($('ice').value);
  if(iceN > 0){
    const rIn = Math.max(profR(liq) - wallv, 0.05);
    const shrink = iceN === 1 ? 1.0 : (iceN === 2 ? 0.85 : 0.75);
    // cap so the whole set packs side by side inside the inner radius,
    // with comfortable clearance
    const szCap = rIn * (iceN === 1 ? 0.40 : iceN === 2 ? 0.35 : 0.30);
    const radF = iceN === 1 ? 0.30 : 0.62;     // solo floats mid, sets ring
    for(let i=0;i<iceN;i++){
      const sz = Math.min(ICE.size[i]*(0.65 + 0.45*shape.H)*shrink, szCap);
      const rad = Math.max(rIn - sz*1.2, 0.0) * radF;
      const a = ICE.ang[i] + t*0.03;             // one raft: they drift together
      let cy = liq - sz*0.35 + 0.012*snz(t*0.7, i*3.1);   // ~90% submerged, bobbing
      cy = Math.max(cy, cavY + sz*0.85);
      ICE.pos[i*3+0] = Math.cos(a)*rad;
      ICE.pos[i*3+1] = cy;
      ICE.pos[i*3+2] = Math.sin(a)*rad;
      ICE.r[i] = sz;
      ICE.rot[i] = t*0.05*(1 + i*0.3) + i*2.0;
    }
    // cubes may touch but never merge: push overlaps apart, keep everything
    // inside the wall, and pile whatever still doesn't fit — like real ice
    for(let it=0; it<4; it++){
      for(let ia=0; ia<iceN; ia++) for(let ib=ia+1; ib<iceN; ib++){
        const dx = ICE.pos[ib*3] - ICE.pos[ia*3];
        const dz = ICE.pos[ib*3+2] - ICE.pos[ia*3+2];
        const dist = Math.hypot(dx, dz);
        // boxes reach ~1.6x their half-size at a rotated corner: separate
        // by more than the sphere distance or corners interpenetrate
        const minD = (ICE.r[ia] + ICE.r[ib])*1.35;
        if(dist < minD){
          const nx = dist > 1e-4 ? dx/dist : 1, nz = dist > 1e-4 ? dz/dist : 0;
          const push = (minD - dist)/2;
          ICE.pos[ia*3]   -= nx*push; ICE.pos[ia*3+2] -= nz*push;
          ICE.pos[ib*3]   += nx*push; ICE.pos[ib*3+2] += nz*push;
        }
      }
      for(let ia=0; ia<iceN; ia++){
        const rr = Math.hypot(ICE.pos[ia*3], ICE.pos[ia*3+2]);
        const rMax = Math.max(rIn - ICE.r[ia]*1.15, 0.0);
        if(rr > rMax){
          const f = rr > 1e-4 ? rMax/rr : 0;
          ICE.pos[ia*3] *= f; ICE.pos[ia*3+2] *= f;
        }
      }
    }
    for(let ia=0; ia<iceN; ia++) for(let ib=ia+1; ib<iceN; ib++){
      const dx = ICE.pos[ib*3] - ICE.pos[ia*3];
      const dz = ICE.pos[ib*3+2] - ICE.pos[ia*3+2];
      const dist = Math.hypot(dx, dz);
      const minD = (ICE.r[ia] + ICE.r[ib])*1.25;
      if(dist < minD) ICE.pos[ib*3+1] += (minD - dist)*0.9;   // rides the pile
    }
  }
  const diam  = parseFloat($('diam').value);
  const cond  = parseFloat($('cond').value);
  const colaSig = sigFrom($('colaCol').value, 0.35);
  const colaLin = hexLin($('colaCol').value);
  const colaGlow = [1,
    Math.pow(Math.max(colaLin[1]/colaLin[0], 1e-3), 0.33),
    Math.pow(Math.max(colaLin[2]/colaLin[0], 1e-3), 0.33) * 0.55];
  const glassSig = sigFrom($('glassCol').value, 0.42);
  const setShared = (u) => {
    gl.uniform1fv(u.u_prof, shape.prof);
    gl.uniform1f(u.u_H, shape.H);
    gl.uniform1f(u.u_y0, shape.y0);
    gl.uniform1f(u.u_stemR, shape.stemR);
    gl.uniform1f(u.u_footR, shape.footR);
    gl.uniform1f(u.u_footH, shape.footH);
    gl.uniform1f(u.u_cavY, cavY);
    gl.uniform1f(u.u_maxR, maxR);
    gl.uniform1f(u.u_baseR, baseR);
    gl.uniform2f(u.u_caustC, caustC[0], caustC[1]);
    gl.uniform1f(u.u_caustS, caustS);
    gl.uniform1f(u.u_liq, liq);
    gl.uniform1f(u.u_diam, diam);
    gl.uniform1f(u.u_diamN, parseFloat($('diamN').value));
    gl.uniform1f(u.u_pat, parseFloat($('pat').value));
    gl.uniform1f(u.u_patTop, shape.patTop ?? shape.H - 0.18);
    gl.uniform1f(u.u_cond, cond);
    gl.uniform1f(u.u_irr, parseFloat($('irr').value));
    gl.uniform3f(u.u_liqSig, ...colaSig);
    gl.uniform3f(u.u_liqGlow, ...colaGlow);
    gl.uniform3f(u.u_glassSig, ...glassSig);
    gl.uniform1f(u.u_nGlass, glassN);
    gl.uniform1f(u.u_turb, parseFloat($('turb').value));
    gl.uniform1f(u.u_fizz, liquid.empty ? 0 : parseFloat($('fizz').value));
    gl.uniform1f(u.u_nLiq, liquid.n);
    gl.uniform3f(u.u_scatCol, ...hexLin(liquid.scat));
    gl.uniform1f(u.u_iceN, iceN);
    gl.uniform3fv(u.u_icePos, ICE.pos);
    gl.uniform1fv(u.u_iceR, ICE.r);
    gl.uniform1fv(u.u_iceRot, ICE.rot);
    gl.uniform1f(u.u_bub, parseFloat($('bub').value));
    gl.uniform1f(u.u_bubSize, parseFloat($('bubSz').value));
    gl.uniform1f(u.u_canopy, parseFloat($('canopy').value));
    gl.uniform2f(u.u_canopyC, canopyC[0], canopyC[1]);
    gl.uniform1f(u.u_canRot, canRot);
    gl.uniform1f(u.u_rim, $('rim').checked ? 1 : 0);
    gl.uniform3f(u.u_rimCol, 1.0, 0.78, 0.42);
    gl.uniform1f(u.u_metal, metal);
    gl.uniform1f(u.u_metalSeed, metalSeed);
    gl.uniform3f(u.u_metalCol, ...metalCol);
    gl.uniform1f(u.u_metalScale, metalScale);
    gl.uniform1f(u.u_metalWarp, metalWarp);
    gl.uniform1f(u.u_metalType, metalType);
  };
  const leaf  = parseFloat($('leaf').value);
  const sun   = parseFloat($('sun').value);
  const tw = t*wind;

  // ---- the lights: the time-of-day preset drives one main sun-gap and two
  // secondary gaps in the foliage
  const T = TIMES[$('tod').value];
  const azBase = T.az, elBase = T.el;
  const dirs = [], cols = [], offs = [];
  const spec = T.spec;
  // gusts: a slow irregular envelope that decides how hard the leaves flutter
  const gust = 0.30 + 0.70*Math.pow(0.5 + 0.5*snz(tw*0.16, 2.0), 1.6);
  for(let i=0;i<NL;i++){
    const s = spec[i];
    // the sun itself never moves — only the foliage gaps sway with the wind
    const sway = i === 0 ? 0 : wind;
    const az = azBase + s.daz + sway*(0.055*snz(tw*0.45, s.ph)
                                    + 0.020*gust*snz(tw*1.5, s.ph*2.3));
    const el = elBase + s.del + sway*(0.028*snz(tw*0.33, s.ph*1.7)
                                    + 0.011*gust*snz(tw*2.0, s.ph*3.1));
    // direction FROM sun INTO scene
    const d = [ -Math.cos(az)*Math.cos(el), -Math.sin(el), -Math.sin(az)*Math.cos(el) ];
    const n = Math.hypot(...d);
    dirs.push(d[0]/n, d[1]/n, d[2]/n);
    // brightness: slow occlusion breathing x fast gusty shimmer
    const f = (0.62 + 0.38*(0.5 + 0.5*snz(tw*0.7, s.ph*7.1)))
            * (0.88 + 0.12*gust*snz(tw*2.4, s.ph*3.3));
    cols.push(s.col[0]*s.int*f, s.col[1]*s.int*f, s.col[2]*s.int*f);
    // canopy drift + sway + flutter
    offs.push(
      tw*0.055 + 0.05*snz(tw*0.28, s.ph) + 0.013*gust*snz(tw*1.3, s.ph*1.9) + s.ph*2.0,
      -tw*0.023 + 0.05*snz(tw*0.24, s.ph + 2.0) + 0.013*gust*snz(tw*1.7, s.ph*1.3));
  }

  // NEON RING (light painting): replace the sun + foliage gaps with three
  // tube thirds — the photon shader launches from the ring geometry itself;
  // these dirs are only the stand-ins the ghost's glints reflect. The tube
  // hums with a fast shallow flicker instead of the foliage breathing.
  // ring poses: each hoop's centre is pushed off the glass axis and its
  // plane tilted out of level about the horizontal axis perpendicular to
  // its (slowly precessing) tilt bearing. e1 dips by the tilt, e2 stays
  // level; the shader sweeps C + R(e1 cosφ + e2 sinφ). Each hoop's DIPPED
  // side must stay high enough that its light still dives into the glass
  // (≥ ~25° elevation): sectors lit flatter lose nearly every photon to
  // grazing exits, which read as near-black mandalas.
  for(let i=0;i<NL;i++){
    const Ri = RING_R[i]*ringRF[i]*maxR;
    const Ai = ringTiltA[i];              // still: no precession for now
    const ctl = Math.cos(ringTilt[i]), stl = Math.sin(ringTilt[i]);
    // height: rolled between hanging low beside the bowl and the old safe
    // perch (the ≥25° formula). Low rings light the glass almost side-on —
    // long grazing streaks and dark sectors; the servo carries exposure.
    // Whatever the roll, the dipped side must still clear the table.
    const highH = shape.H + Ri*stl + (Ri - maxR)*0.47;
    const lowH = 0.60*shape.H;
    const Hi = Math.max(lowH + (highH - lowH)*ringHF[i], 0.15 + Ri*stl);
    const ca = Math.cos(Ai), sa = Math.sin(Ai);
    ringUArr[i*3] = Ri*ca*ctl; ringUArr[i*3+1] = -Ri*stl; ringUArr[i*3+2] = Ri*sa*ctl;
    ringVArr[i*3] = -Ri*sa;    ringVArr[i*3+1] = 0;       ringVArr[i*3+2] = Ri*ca;
    ringCArr[i*3] = ringOffR[i]*maxR*Math.cos(ringOffA[i]);
    ringCArr[i*3+1] = Hi;
    ringCArr[i*3+2] = ringOffR[i]*maxR*Math.sin(ringOffA[i]);
  }
  // the white inner ring's basis: same construction, small and crooked,
  // centred inside the cavity
  const wRw = wRF*maxR;
  const wct = Math.cos(wTilt), wst = Math.sin(wTilt);
  const wca = Math.cos(wTiltA), wsa = Math.sin(wTiltA);
  const wU = [wRw*wca*wct, -wRw*wst, wRw*wsa*wct];
  const wV = [-wRw*wsa, 0, wRw*wca];
  const wC = [wOffR*maxR*Math.cos(wOffA),
              cavY + wHF*(0.95*shape.H - cavY),
              wOffR*maxR*Math.sin(wOffA)];
  if(lightPaint){
    // stand-in direction: from the hoop's centre toward mid-glass. Slot 0
    // carries the deal's colour; the other slots go dark.
    const d = [ringCArr[0], ringCArr[1] - 0.5*shape.H, ringCArr[2]];
    const n = -Math.hypot(...d);                      // FROM tube INTO scene
    dirs[0] = d[0]/n; dirs[1] = d[1]/n; dirs[2] = d[2]/n;
    cols[0] = ringCol[0]; cols[1] = ringCol[1]; cols[2] = ringCol[2];
    for(let i=3;i<NL*3;i++) cols[i] = 0;
    // slot 2: the distant sun (parallel rays — the photon shader's
    // directional path), burning in the SAME neon colour as the hoop —
    // one hue owns the whole deal, white stays the bulbs' alone
    const ce = Math.cos(paintSunEl);
    dirs[6] = -Math.cos(paintSunAz)*ce;
    dirs[7] = -Math.sin(paintSunEl);
    dirs[8] = -Math.sin(paintSunAz)*ce;
    cols[6] = ringCol[0]; cols[7] = ringCol[1]; cols[8] = ringCol[2];
  }

  // where the glass projects up the sun ray onto the canopy plane — palm
  // and parasol anchor to this so their shade lands on the glass
  const cupy = Math.max(-dirs[1], 0.2);
  const canopyC = [-dirs[0]*2.6/cupy, -dirs[2]*2.6/cupy];

  // caustic accumulation window: follows the main sun, so a low sun throws
  // the window (and the caustic) far down-light of the glass. The ring is
  // symmetric — its window just sits centred under the glass.
  const chl = Math.hypot(dirs[0], dirs[2]);
  const ccot = chl/Math.max(-dirs[1], 0.08);
  const cdist = lightPaint ? 0 : Math.min(0.5*shape.H*ccot, 1.8);
  const caustC = lightPaint ? [0, 0] : [dirs[0]/chl*cdist, dirs[2]/chl*cdist];
  // paint window ±3.0: room for a 15°-sun fan to run its full length
  // before hitting the recording edge (the gain auto-compensates the area)
  const caustS = lightPaint ? 3.0 : Math.min(Math.max(0.9 + cdist, 1.7), 3.0);

  // audio follows the weather and the hour: rustle rides the gusts, and the
  // cicada / cricket / bird mix crossfades with the time-of-day preset
  if(AU && audioBtn.classList.contains('on')){
    const now = AU.ctx.currentTime;
    AU.rustle.gain.setTargetAtTime(0.030*wind*(0.4 + 0.8*gust), now, 0.15);
    AU.cicG.gain.setTargetAtTime(T.amb.cic, now, 1.2);
    AU.criG.gain.setTargetAtTime(T.amb.cri, now, 1.2);
    AU.birdG.gain.setTargetAtTime(T.amb.bird, now, 1.2);
  }

  // ---- pass 1: trace photons into the caustic accumulation buffer.
  // Decay-copy last frame's accumulation, then splat this frame's photons
  // on top: a rolling average that denoises without losing the light's sway.
  const caust = caustPP[caustFlip], caustPrev = caustPP[1 - caustFlip];
  caustFlip = 1 - caustFlip;
  gl.bindFramebuffer(gl.FRAMEBUFFER, caust.fb);
  gl.viewport(0, 0, CAUST, CAUST);
  gl.useProgram(fadeProg);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, caustPrev.tex);
  gl.uniform1i(uF.u_tex, 0);
  gl.uniform1f(uF.u_decay, lightPaint ? PAINT_DECAY : CAUST_DECAY);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  gl.useProgram(photonProg);
  gl.uniform3fv(uP.u_lightDir, dirs);
  gl.uniform3fv(uP.u_lightCol, cols);
  gl.uniform2fv(uP.u_dappleOff, offs);
  gl.uniform1f(uP.u_leaf, leaf);
  gl.uniform1f(uP.u_facet, facet);
  gl.uniform1f(uP.u_wall, wallv);
  setShared(uP);
  gl.uniform1f(uP.u_time, t);
  // paint mode: a crisp bare sun (tiny angular size, no leaf diffraction)
  gl.uniform1f(uP.u_soft, lightPaint ? 0.015 : T.soft*(1.0 + 0.8*wind));
  // per-frame energy: steady state ≈ gain/(1-decay); smaller splats since
  // accumulation fills the gaps, so the folds stay filament-sharp.
  // Three exposure corrections keep the caustic visible in every deal:
  // (a) a larger low-sun window spreads photons over more texels — undo it;
  // (b) dark/turbid liquids and mist absorb photons — compensate by the
  //     expected average loss, capped so deep drinks stay plausible;
  // (c) contrast tracks the lit table: a caustic is additive light, so a
  //     bright scene (noon, pale stone, thin shade) swallows a fixed-energy
  //     splat while a dim one exaggerates it — scale gain by expected table
  //     luminance, anchored at 1x for the golden-afternoon stone default.
  const windowComp = (caustS/1.7)*(caustS/1.7);
  const turbv = parseFloat($('turb').value);
  const rInTyp = Math.max(profR((cavY + liq)*0.5) - wallv, 0.05);
  const sTyp = 1.4*rInTyp;                    // typical chord through the drink
  const lumOf = c => 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2];
  // 0.075 floor mirrors the photon shader's hue-preserving tint floor
  const tintTyp = Math.max(lumOf(colaSig.map(sg => Math.exp(-sTyp*sg*0.45)))*0.6, 0.075)
                * Math.exp(-sTyp*turbv*3.0);
  const cover = liquid.empty ? 0
              : Math.min(Math.max((liq - cavY)/(0.99*shape.H - 0.02), 0), 1);
  const mistLoss = 1 - 0.10*Math.min(cond, 1.2);
  const expFac = (1 - cover + cover*tintTyp) * mistLoss;
  const boost = Math.min(Math.max(1/Math.max(expFac, 0.05), 1.0), 5.0);
  // expected table luminance: leaf-mixed ambient + the preset lights through
  // the mean dapple gap (0.71 = mean occlusion breathing), times the table's
  // albedo luminance. 0.65 is this estimate for the default anchor deal.
  const TAB_ALB = { 0:0.83, 1:0.49, 2:0.80, 3:0.72, 4:0.73 };
  const ambMix = T.ambS.map((v,i) => v + (T.ambL[i] - v)*0.55*leaf);
  const dirLum = T.spec.reduce((a,s) => a + lumOf(s.col)*s.int, 0)*0.71;
  const Ltab = (lumOf(ambMix) + dirLum*(1 - 0.62*leaf)*1.10)
             * (TAB_ALB[$('table').value] ?? 0.8);
  const brightComp = Math.min(Math.max(Ltab/0.65, 0.85), 2.2);
  // light painting: same steady-state energy under the slow decay, times a
  // lift for the black void (no lit table to compete with — brightComp is
  // moot, its anchor scene no longer exists)
  const steadyFix = lightPaint ? (1 - PAINT_DECAY)/(1 - CAUST_DECAY) * 2.0 * expoGain : 1;
  gl.uniform1f(uP.u_gain, 0.09 * CAUST_DENS * windowComp
    * Math.min(boost*(lightPaint ? 1 : brightComp), 6.0) * steadyFix);
  gl.uniform1f(uP.u_seed, Math.random()*100.0);
  // dispersion pushed harder in light painting: the trails should go spectral
  gl.uniform1f(uP.u_disp, parseFloat($('disp').value) * (lightPaint ? 1.6 : 1));
  gl.uniform1f(uP.u_arty, lightPaint ? 1 : 0);
  gl.uniform3fv(uP.u_ringC, ringCArr);
  gl.uniform3fv(uP.u_ringU, ringUArr);
  gl.uniform3fv(uP.u_ringV, ringVArr);
  gl.uniform3f(uP.u_ringWC, ...wC);
  gl.uniform3f(uP.u_ringWU, ...wU);
  gl.uniform3f(uP.u_ringWV, ...wV);
  gl.uniform1fv(uP.u_ringArc, ringArc);
  gl.uniform1f(uP.u_ringWN, BULBS ? wN : 0);
  gl.uniform1f(uP.u_ringWSpan, wSpan);
  gl.uniform1f(uP.u_ringWPh0, wPh0);
  gl.uniform3f(uP.u_bulbCol, ...bulbCol);
  gl.uniform1f(uP.u_mode, 0);            // transmitted photons
  gl.drawArrays(gl.POINTS, 0, NPHOT);
  gl.uniform1f(uP.u_mode, 1);            // Fresnel-reflected photons
  gl.drawArrays(gl.POINTS, 0, NPHOT);
  if(lightPaint && BULBS){
    gl.uniform1f(uP.u_mode, 2);          // the white bulb string's own pass
    gl.drawArrays(gl.POINTS, 0, GW*GH);
  }
  gl.disable(gl.BLEND);

  // auto-exposure (light painting): project what the still-charging buffer
  // will converge to, compare against the target mean, and nudge the gain.
  // Gentle steps (^0.35, ±35% per measure) because the answer lags ~330
  // frames behind the correction — hard servoing would oscillate.
  if(lightPaint && expoN++ % 20 === 0){
    gl.bindFramebuffer(gl.FRAMEBUFFER, expoT.fb);
    gl.viewport(0, 0, EXPO, EXPO);
    gl.useProgram(expoProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, caust.tex);
    gl.uniform1i(uE.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, EXPO, EXPO, gl.RGBA, gl.UNSIGNED_BYTE, expoBuf);
    let sum = 0, mx = 0;
    for(let i=0;i<expoBuf.length;i+=4){
      sum += expoBuf[i];
      if(expoBuf[i] > mx) mx = expoBuf[i];
    }
    const mean = (sum/(EXPO*EXPO))/255*4;               // undo the ÷4 packing
    const peak = mx/255*4;
    const charge = 1 - Math.pow(PAINT_DECAY, expoN);    // how full the buffer is
    const projM = mean/Math.max(charge, 0.05);
    const projP = peak/Math.max(charge, 0.05);
    // expose FOR the mean, but never PAST the highlights: a compact pool
    // (steep near-centred rings) has a dim mean around a scorching core,
    // and mean-only metering burned those out. Static rings concentrate
    // far more energy per texel than moving ones did, so the gain floor
    // sits low — the servo must be free to pull hard under the old 1×.
    const err = Math.min(0.055/Math.max(projM, 1e-4), 1.3/Math.max(projP, 1e-4));
    const step = Math.pow(err, 0.35);
    expoGain = Math.min(Math.max(expoGain*Math.min(Math.max(step, 1/1.5), 1.5), 0.15), 20.0);
  }

  // ---- pass 2: blur for the soft halo
  gl.useProgram(blurProg);
  gl.bindFramebuffer(gl.FRAMEBUFFER, blurA.fb);
  gl.viewport(0, 0, BLUR, BLUR);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, caust.tex);
  gl.uniform1i(uB.u_tex, 0);
  gl.uniform2f(uB.u_dir, 2.0/BLUR, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindFramebuffer(gl.FRAMEBUFFER, blurB.fb);
  gl.bindTexture(gl.TEXTURE_2D, blurA.tex);
  gl.uniform2f(uB.u_dir, 0, 2.0/BLUR);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // ---- pass 3: composite the scene into an HDR target (bloom source)
  gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fb);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(compProg);
  gl.uniform2f(uC.u_res, canvas.width, canvas.height);
  gl.uniform1f(uC.u_time, t);
  gl.uniform3fv(uC.u_lightDir, dirs);
  gl.uniform3fv(uC.u_lightCol, cols);
  gl.uniform2fv(uC.u_dappleOff, offs);
  gl.uniform1f(uC.u_leaf, leaf);
  gl.uniform1f(uC.u_facet, facet);
  gl.uniform1f(uC.u_wall, wallv);
  setShared(uC);
  gl.uniform1f(uC.u_sun, sun);
  // the puddle is the condensation that ran off: it follows the same slider
  gl.uniform1f(uC.u_spill, cond*0.65);
  gl.uniform1f(uC.u_spillSeed, spillSeed);
  // light-environment palette from the time-of-day preset
  gl.uniform3f(uC.u_skyHor, ...T.skyHor);
  gl.uniform3f(uC.u_skyZen, ...T.skyZen);
  gl.uniform3f(uC.u_leafD, ...T.leafD);
  gl.uniform3f(uC.u_leafL, ...T.leafL);
  gl.uniform3f(uC.u_gnd0, ...T.gnd0);
  gl.uniform3f(uC.u_gnd1, ...T.gnd1);
  gl.uniform3f(uC.u_ambS, ...T.ambS);
  gl.uniform3f(uC.u_ambL, ...T.ambL);
  gl.uniform3f(uC.u_backCol, ...T.back);
  gl.uniform1f(uC.u_pen, T.pen);
  gl.uniform1f(uC.u_night, T.night ? 1 : 0);
  gl.uniform1f(uC.u_table, parseFloat($('table').value));
  gl.uniform1f(uC.u_tabRot, tabRot);
  gl.uniform1f(uC.u_arty, lightPaint ? 1 : 0);
  gl.uniform3fv(uC.u_ringC, ringCArr);
  gl.uniform3fv(uC.u_ringU, ringUArr);
  gl.uniform3fv(uC.u_ringV, ringVArr);
  gl.uniform3f(uC.u_ringWC, ...wC);
  gl.uniform3f(uC.u_ringWU, ...wU);
  gl.uniform3f(uC.u_ringWV, ...wV);
  gl.uniform1f(uC.u_ringWN, BULBS ? wN : 0);
  gl.uniform1f(uC.u_ringWSpan, wSpan);
  gl.uniform1f(uC.u_ringWPh0, wPh0);
  gl.uniform3f(uC.u_bulbCol, ...bulbCol);
  // orbit camera from the mouse, with a slow handheld drift on top;
  // target height and orbit radius scale with the glass so every shape frames
  const taY  = 0.33*shape.H + 0.35*shape.y0;   // aim nearer the bowl on stemware
  const orbR = (1.15 + 0.78*shape.H)*zoomSm;   // SHIFT+drag / wheel zoom
  // light painting locks the tripod: no handheld drift on the orbit.
  // Full-turn azimuth: one screen-width of drag = one revolution.
  const caz = (sm[0]-0.5)*6.2832 + (lightPaint ? 0 : 0.010*snz(t*0.23, 11.0));
  const ch  = 0.30 + (1.0-sm[1])*(1.35 + shape.H)   // table level to top-down
            + (lightPaint ? 0 : 0.012*snz(t*0.19, 7.0));
  const rox = Math.sin(caz)*orbR, roz = Math.cos(caz)*orbR;
  gl.uniform3f(uC.u_ro, rox, ch, roz);
  gl.uniform1f(uC.u_taY, taY);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, caust.tex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, blurB.tex);
  gl.uniform1i(uC.u_caust, 0);
  gl.uniform1i(uC.u_caustB, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // ---- pass 4: bloom — bright pass at quarter res, then separable blur
  gl.useProgram(brightProg);
  gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fb);
  gl.viewport(0, 0, bloomA.w, bloomA.h);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, scene.tex);
  gl.uniform1i(uBr.u_tex, 0);
  gl.uniform1f(uBr.u_arty, lightPaint ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.useProgram(blurProg);
  gl.bindFramebuffer(gl.FRAMEBUFFER, bloomB.fb);
  gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
  gl.uniform1i(uB.u_tex, 0);
  gl.uniform2f(uB.u_dir, 1.6/bloomA.w, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fb);
  gl.bindTexture(gl.TEXTURE_2D, bloomB.tex);
  gl.uniform2f(uB.u_dir, 0, 1.6/bloomA.h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // ---- pass 5: finish — scene + bloom, vignette/tonemap/grain, to screen
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(finalProg);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, scene.tex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
  gl.uniform1i(uFin.u_scene, 0);
  gl.uniform1i(uFin.u_bloom, 1);
  gl.uniform1f(uFin.u_time, t);
  // handheld: slow frame sway + a faint high-frequency tremor (uv units);
  // the light-painting tripod holds the frame dead still
  if(lightPaint) gl.uniform2f(uFin.u_wob, 0, 0);
  else gl.uniform2f(uFin.u_wob,
    0.0016*snz(t*0.50, 1.7) + 0.0005*snz(t*2.9, 9.2),
    0.0013*snz(t*0.44, 4.9) + 0.0005*snz(t*3.3, 2.2));
  gl.uniform2f(uFin.u_px, 1/canvas.width, 1/canvas.height);
  gl.uniform1f(uFin.u_focus, Math.hypot(rox, ch - taY, roz));
  gl.uniform1f(uFin.u_arty, lightPaint ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  if(wantShot){
    // capture must happen in the same task as the render: the drawing
    // buffer is not preserved across frames
    wantShot = false;
    canvas.toBlob(b => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'summer-glass-' + Date.now() + '.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
  }

  // A gallery embedding this piece can ask it for a still (see snapReq
  // below). Same constraint as the screenshot above — the pixels only exist
  // here, inside the render task — so the reply is sent from this point,
  // once the caustics have had time to accumulate.
  if(snapReq && ++snapFrames >= SNAP_AFTER){
    const req = snapReq; snapReq = null;
    try {
      parent.postMessage({
        type: 'summer-glass-snapshot', id: req.id,
        jpeg: canvas.toDataURL('image/jpeg', req.quality ?? 0.72),
      }, '*');
    } catch(e){
      parent.postMessage({ type: 'summer-glass-snapshot', id: req.id, error: String(e) }, '*');
    }
  }

  requestAnimationFrame(frame);
}
// the opening deal: every load is a hash-determined glass (perftest pins its
// own worst-case setup instead)
if(!location.hash.includes('perftest')) randomize();
frame();

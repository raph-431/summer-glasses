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
function mkTarget(w, h){
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
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

const CAUST = 1024, BLUR = 512;
// ping-pong pair: each frame decays the other into itself, then adds photons
const caustPP = [mkTarget(CAUST, CAUST), mkTarget(CAUST, CAUST)];
let caustFlip = 0;
const CAUST_DECAY = 0.90;            // ~10-frame accumulation window
const blurA = mkTarget(BLUR, BLUR);
const blurB = mkTarget(BLUR, BLUR);

const GW = 512, GH = 288, NL = 3;
const NPHOT = GW*GH*NL;

const vao = gl.createVertexArray();  // attribute-less; gl_VertexID does the work
gl.bindVertexArray(vao);

const U = p => new Proxy({}, { get: (_, n) => gl.getUniformLocation(p, n) });
const uP = U(photonProg), uF = U(fadeProg), uB = U(blurProg),
      uC = U(compProg), uBr = U(brightProg), uFin = U(finalProg);

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

// click-drag to orbit (drag deltas accumulate into the same smoothed target)
let mouse = [0.5, 0.5], sm = [0.5, 0.5];
let dragging = false, lastXY = [0, 0];
addEventListener('pointerdown', e => {
  if(e.target.closest('#ui')) return;         // panel clicks don't orbit
  dragging = true; lastXY = [e.clientX, e.clientY];
  canvas.style.cursor = 'grabbing';
});
addEventListener('pointermove', e => {
  if(!dragging) return;
  mouse[0] = Math.min(Math.max(mouse[0] - (e.clientX - lastXY[0])/innerWidth,  0), 1);
  mouse[1] = Math.min(Math.max(mouse[1] - (e.clientY - lastXY[1])/innerHeight, 0), 1);
  lastXY = [e.clientX, e.clientY];
});
const endDrag = () => { dragging = false; canvas.style.cursor = 'grab'; };
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', endDrag);

// H hides the panel for clean shots; S saves the next rendered frame as PNG
let wantShot = false;
addEventListener('keydown', e => {
  if(e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if(e.key === 'h' || e.key === 'H'){
    const ui = document.getElementById('ui');
    ui.style.display = ui.style.display === 'none' ? '' : 'none';
  }
  if(e.key === 's' || e.key === 'S') wantShot = true;
  if(e.key === 'r' || e.key === 'R') randomize();
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
  shot:     { H:0.52, y0:0, knots:[0.160,0.166,0.172,0.178,0.184,0.190,0.196,0.202],
              stemR:0, footR:0, footH:0, cavBase:0.10, wall:0.050, fillMax:0.85 },
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
  water:     { hex:'#f2f6f4', turb:0.00, n:1.33, fizz:0.00, scat:'#ffffff' },
  sparkling: { hex:'#f0f3ea', turb:0.02, n:1.33, fizz:1.20, scat:'#f5f2df' },
  whiteWine: { hex:'#e8d68a', turb:0.03, n:1.36, fizz:0.00, scat:'#efe3a8' },
  redWine:   { hex:'#4a0e18', turb:0.10, n:1.36, fizz:0.00, scat:'#7a1f2c' },
  rose:      { hex:'#e89aa0', turb:0.05, n:1.36, fizz:0.00, scat:'#f0b6ba' },
  whiskey:   { hex:'#b05e14', turb:0.02, n:1.36, fizz:0.00, scat:'#d08428' },
  mojito:    { hex:'#c9e4b4', turb:0.35, n:1.34, fizz:0.55, scat:'#d8eec2' },
  blueLagoon:{ hex:'#1e6fd8', turb:0.08, n:1.34, fizz:0.60, scat:'#4a9ae8' },
  icedTea:   { hex:'#8a4514', turb:0.06, n:1.34, fizz:0.00, scat:'#b06a2a' },
  champagne: { hex:'#eedc9a', turb:0.03, n:1.34, fizz:1.35, scat:'#f5ecb4' },
  spritz:    { hex:'#e0561e', turb:0.30, n:1.34, fizz:0.70, scat:'#f08a46' },
  pastis:    { hex:'#ece0a6', turb:0.85, n:1.34, fizz:0.00, scat:'#f4ecc0' },
  appleJuice:{ hex:'#d8a428', turb:0.30, n:1.34, fizz:0.00, scat:'#ecc45e' },
  shirleyTemple:{ hex:'#cc2440', turb:0.10, n:1.34, fizz:0.85, scat:'#e8637a' },
  lemonade:  { hex:'#f0e8a0', turb:0.50, n:1.34, fizz:0.30, scat:'#f7f0bc' },
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
// LEGEND — a one-line caption composed from the scene state (drink, canopy,
// time of day), shown on load and on every deal, fading after ten seconds.
// ---------------------------------------------------------------------------
const TIME_PHRASES = {
  dawn:            ["at dawn", "at first light", "at sunrise", "in the pale morning haze"],
  morning:         ["in the cool of early morning", "in the fresh morning light", "before the heat sets in"],
  noon:            ["at high noon", "under the midday sun", "in the heat of noon", "in broad daylight"],
  goldenAfternoon: ["during the golden hour", "in the late afternoon", "in the slanting afternoon light", "in the honeyed afternoon light"],
  sunset:          ["at sunset", "as the sun sets", "in the last light of day", "as the light fades"],
  dusk:            ["during the blue hour", "at twilight", "in the violet dusk", "at dusk's first hour", "in the gathering dark"],
  night:           ["at nightfall", "under the stars", "in the warm night air", "at midnight", "in the glow of string lights"],
};
const LOC_PHRASES = {
  0: ["on the terrasse, in dappled shade", "beneath the broad-leafed canopy", "in the tree's mottled shade", "under the leafy awning"],
  1: ["beneath the lace of leaves", "in the fine dappled light", "under the feathery canopy", "beneath the acacia's thin shade"],
  2: ["beneath the palms", "in the shade of the palm fronds", "under swaying palms", "poolside beneath the palms"],
  3: ["under the pergola", "on the terrasse, beneath the pergola", "in the pergola's striped shade", "on the vine-covered terrace"],
  4: ["beneath the parasol", "under the umbrella's shade", "at a shaded table", "beneath the striped parasol"],
};
// each drink: noun-phrases that slot into "Enjoy ___ {location}, {time}."
// "empty" is special-cased below (different verb, no "Enjoy"). Avoid trailing
// appositive commas — the template appends the next clause with just a space.
const DRINK_PHRASES = {
  soda:          ["this soda", "this ice-cold soda", "the fizzing soda", "a glass of soda", "this dark, bubbling soda", "a cold pour of soda"],
  oj:            ["this orange juice", "a glass of fresh orange juice", "the sun-bright orange juice", "this cold-pressed orange juice", "a tall glass of orange juice"],
  water:         ["this water", "a glass of cold water", "this ice water", "the clear water", "a cool glass of water"],
  sparkling:     ["this sparkling water", "the fizzing water", "this glass of bubbles", "the chilled sparkling water", "this bright, bubbling water"],
  whiteWine:     ["this white wine", "a chilled glass of white wine", "the pale white wine", "this crisp white wine", "a cold glass of white wine"],
  redWine:       ["this red wine", "a glass of red wine", "the deep red wine", "this bold red wine", "a dark glass of red wine"],
  rose:          ["this rosé", "a chilled glass of rosé", "the pale pink wine", "this summer rosé", "a cold glass of rosé"],
  whiskey:       ["this whiskey", "a glass of whiskey", "the amber whiskey", "this neat pour of whiskey", "a dram of whiskey"],
  mojito:        ["this mojito", "the minted mojito", "a cold mojito", "this mint-fizzed mojito", "a glass of mojito with clinking ice"],
  blueLagoon:    ["this blue lagoon", "the electric-blue lagoon", "a glass of blue lagoon", "this ocean-blue cocktail", "the vivid blue lagoon"],
  icedTea:       ["this iced tea", "a tall glass of iced tea", "the amber iced tea", "this cold-brewed tea", "a cool glass of iced tea"],
  champagne:     ["this champagne", "a glass of champagne", "the chilled champagne", "this glass of bubbly", "a flute of champagne"],
  spritz:        ["this spritz", "the bittersweet spritz", "a glass of spritz", "this bright orange spritz", "a cold spritz"],
  pastis:        ["this pastis", "a glass of pastis", "the cloudy pastis", "this anise-clouded pastis", "a louche glass of pastis"],
  appleJuice:    ["this apple juice", "a glass of apple juice", "the crisp apple juice", "this cold-pressed apple juice", "a tall glass of apple juice"],
  shirleyTemple: ["this Shirley Temple", "a glass of Shirley Temple", "the pink Shirley Temple", "this cherry-bright Shirley Temple", "a sweet Shirley Temple"],
  lemonade:      ["this lemonade", "a glass of tart lemonade", "the fresh-squeezed lemonade", "this sun-cooled lemonade", "a cold glass of lemonade"],
  gin:           ["this gin", "a glass of gin", "the juniper-bright gin", "a cold gin over ice", "this neat pour of gin"],
  ginFizz:       ["this gin fizz", "a glass of gin fizz", "the frothy gin fizz", "this citrus-bright gin fizz", "a cold gin fizz"],
  empty:         ["this empty glass", "this drained glass", "the last melting ice", "this hollow glass"],
};
const pickCap  = arr => arr[(Math.random()*arr.length)|0];
const capFirst = s => s.charAt(0).toUpperCase() + s.slice(1);
let legendTimer = 0;
function showLegend(){
  const el  = $('legend');
  const liq = $('liquid').value;
  const d   = pickCap(DRINK_PHRASES[liq] || DRINK_PHRASES.water);
  const loc = pickCap(LOC_PHRASES[$('canopy').value] || LOC_PHRASES[0]);
  const t   = pickCap(TIME_PHRASES[$('tod').value] || TIME_PHRASES.goldenAfternoon);
  el.textContent = liq === 'empty'
    ? `${capFirst(d)} sits ${loc}, ${t}.`
    : `Enjoy ${d} ${loc}, ${t}.`;
  el.classList.add('show');
  clearTimeout(legendTimer);
  legendTimer = setTimeout(() => el.classList.remove('show'), 7000);
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
  highball: ['soda','oj','water','sparkling','mojito','blueLagoon','icedTea',
             'pastis','lemonade','shirleyTemple','ginFizz','appleJuice'],
  rocks:    ['whiskey','soda','icedTea','empty','blueLagoon','gin'],
  shot:     ['whiskey','empty','water','gin'],
  barrel:   ['soda','oj','icedTea','water','mojito','appleJuice','lemonade','shirleyTemple'],
  flared:   ['oj','water','sparkling','rose','icedTea','lemonade','appleJuice','pastis','ginFizz'],
  wine:     ['redWine','whiteWine','rose','empty','spritz'],
  martini:  ['blueLagoon','rose','whiteWine','empty','gin'],
  flute:    ['sparkling','rose','whiteWine','champagne'],
  goblet:   ['redWine','mojito','blueLagoon','soda','water','spritz','appleJuice'],
};
const SHAPE_PATTERNS = {
  highball: ['1','2','3','0','4'], rocks: ['1','0','2','4'], shot: ['3','2','0','1'],
  barrel: ['0','2','4','1'], flared: ['0','2','1'], wine: ['0','2','3'],
  martini: ['0','2','1'], flute: ['0','2','3'], goblet: ['1','4','2','3'],
};
const GLASS_TINTS = ['#eefbf1','#eefbf1','#eefbf1','#e8f2fa','#f8ece8','#eaf6e2',
                     '#d8ecf6','#f6e6d8','#e6dcf2','#d2e9e4','#f2dede','#dfe8c9'];
// the occasional boldly coloured glass, like a mixed vintage set
const SAT_TINTS = ['#2e62c9','#1f8f8a','#c98a2e','#c02e48','#7a8f2e',
                   '#7a4fc0','#5a5a60','#d06a8a'];
const RIM_ODDS = { wine:0.35, martini:0.35, flute:0.40, goblet:0.30 };
const COLD_LIQS = ['soda','water','icedTea','mojito','blueLagoon','oj','sparkling','whiskey',
                   'gin','lemonade','shirleyTemple','ginFizz'];

let seed = (Math.random()*2**31)|0;
let spillSeed = Math.random();      // puddle outline: fresh on every load too
let canRot = Math.random()*6.2832;  // palm/pergola orientation: ditto
let tabRot = Math.random()*6.2832;  // wood plank direction: ditto
function randomize(){
  const r = mulberry32(seed = (seed*1664525 + 1013904223)|0);
  const set = (id, v) => { $(id).value = v; };

  const shapeName = pick(r, Object.keys(SHAPES));
  $('shape').value = shapeName; applyShape(shapeName);
  // jitter the knots ±5%, delta-clamped so the raymarcher stays stable
  shape.prof = shape.prof.map(k => k*(0.95 + 0.10*r()));
  for(let i=1;i<8;i++){
    const d = shape.prof[i] - shape.prof[i-1];
    shape.prof[i] = shape.prof[i-1] + Math.max(-0.06, Math.min(0.06, d));
  }
  set('wall', (shape.wall*rng(r, 0.75, 1.35)).toFixed(3));
  set('irr', (r() < 0.25 ? rng(r, 1.0, 1.45) : rng(r, 0.2, 0.9)).toFixed(2));
  const hasBub = r() < 0.10;                 // seeded glass is the exception
  set('bub', (hasBub ? rng(r, 0.6, 1.0) : 0).toFixed(2));
  set('bubSz', hasBub && r() < 0.5 ? 2 : 1); // half normal seeds, half chunky
  $('rim').checked = r() < (RIM_ODDS[shapeName] ?? 0.08);
  set('glassCol', r() < 0.10 ? pick(r, SAT_TINTS) : pick(r, GLASS_TINTS));

  set('pat', pick(r, SHAPE_PATTERNS[shapeName]));
  set('facet', rng(r, 0.4, 1.8).toFixed(2));
  set('diam', rng(r, 0.6, 2.0).toFixed(2));
  set('diamN', Math.round(rng(r, 8, 30)));
  set('disp', rng(r, 0.1, 1.4).toFixed(2));

  const liqName = pick(r, SHAPE_LIQUIDS[shapeName]);
  $('liquid').value = liqName;
  liquid = LIQUIDS[liqName];
  set('colaCol', liquid.hex);
  set('turb', Math.min(1, liquid.turb*rng(r, 0.7, 1.3)).toFixed(2));
  set('fizz', (liquid.fizz*rng(r, 0.6, 1.3)).toFixed(2));
  const fillV = rng(r, 0.25, 0.85);
  set('liq', fillV.toFixed(2));

  // ice belongs in tumblers holding a cold drink, with at least a half pour
  const iceOK = shape.y0 === 0 && !liquid.empty && fillV >= 0.5
             && COLD_LIQS.includes(liqName);
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
  showLegend();
}
$('rand').addEventListener('click', randomize);
showLegend();   // caption the opening scene too
// dev hook: load index.html#randtest to hammer the randomizer for errors
if(location.hash === '#randtest'){ for(let i=0;i<60;i++) randomize(); }

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

  const wind  = parseFloat($('wind').value);
  const facet = parseFloat($('facet').value);
  const wallv = parseFloat($('wall').value);
  // fill slider is a fraction of the usable cavity, so it means the same
  // thing on a shot glass and a highball
  const fillF = parseFloat($('liq').value);
  const cavY  = shape.y0 + shape.cavBase + wallv*1.3;
  // an empty glass parks the surface just below the cavity floor
  const liq   = liquid.empty ? cavY - 0.02
              : cavY + fillF*(shape.H*shape.fillMax - cavY);
  const maxR  = Math.max(...shape.prof, shape.footR);
  const baseR = shape.y0 > 0 ? shape.footR : shape.prof[0];

  // ice rides the liquid surface; below a half pour there's no room for it
  const iceN = (liquid.empty || fillF < 0.5) ? 0 : parseInt($('ice').value);
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
  const glassSig = sigFrom($('glassCol').value, 0.30);
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
    gl.uniform1f(u.u_cond, cond);
    gl.uniform1f(u.u_irr, parseFloat($('irr').value));
    gl.uniform3f(u.u_liqSig, ...colaSig);
    gl.uniform3f(u.u_liqGlow, ...colaGlow);
    gl.uniform3f(u.u_glassSig, ...glassSig);
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

  // where the glass projects up the sun ray onto the canopy plane — palm
  // and parasol anchor to this so their shade lands on the glass
  const cupy = Math.max(-dirs[1], 0.2);
  const canopyC = [-dirs[0]*2.6/cupy, -dirs[2]*2.6/cupy];

  // caustic accumulation window: follows the main sun, so a low sun throws
  // the window (and the caustic) far down-light of the glass
  const chl = Math.hypot(dirs[0], dirs[2]);
  const ccot = chl/Math.max(-dirs[1], 0.08);
  const cdist = Math.min(0.5*shape.H*ccot, 1.8);
  const caustC = [dirs[0]/chl*cdist, dirs[2]/chl*cdist];
  const caustS = Math.min(Math.max(0.9 + cdist, 1.7), 3.0);

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
  gl.uniform1f(uF.u_decay, CAUST_DECAY);
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
  gl.uniform1f(uP.u_soft, T.soft*(1.0 + 0.8*wind));
  // per-frame energy: steady state ≈ gain/(1-decay); smaller splats since
  // accumulation fills the gaps, so the folds stay filament-sharp.
  // Two exposure corrections keep the caustic visible in every deal:
  // (a) a larger low-sun window spreads photons over more texels — undo it;
  // (b) dark/turbid liquids and mist absorb photons — compensate by the
  //     expected average loss, capped so deep drinks stay plausible.
  const windowComp = (caustS/1.7)*(caustS/1.7);
  const turbv = parseFloat($('turb').value);
  const rInTyp = Math.max(profR((cavY + liq)*0.5) - wallv, 0.05);
  const sTyp = 1.4*rInTyp;                    // typical chord through the drink
  const lumOf = c => 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2];
  const tintTyp = lumOf(colaSig.map(sg => Math.exp(-sTyp*sg*0.45)))*0.6
                * Math.exp(-sTyp*turbv*3.0);
  const cover = liquid.empty ? 0
              : Math.min(Math.max((liq - cavY)/(0.99*shape.H - 0.02), 0), 1);
  const mistLoss = 1 - 0.10*Math.min(cond, 1.2);
  const expFac = (1 - cover + cover*tintTyp) * mistLoss;
  const boost = Math.min(Math.max(1/Math.max(expFac, 0.05), 1.0), 5.0);
  gl.uniform1f(uP.u_gain, 0.09 * windowComp * boost);
  gl.uniform1f(uP.u_seed, Math.random()*100.0);
  gl.uniform1f(uP.u_disp, parseFloat($('disp').value));
  gl.uniform1f(uP.u_mode, 0);            // transmitted photons
  gl.drawArrays(gl.POINTS, 0, NPHOT);
  gl.uniform1f(uP.u_mode, 1);            // Fresnel-reflected photons
  gl.drawArrays(gl.POINTS, 0, NPHOT);
  gl.disable(gl.BLEND);

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
  // orbit camera from the mouse, with a slow handheld drift on top;
  // target height and orbit radius scale with the glass so every shape frames
  const taY  = 0.33*shape.H + 0.35*shape.y0;   // aim nearer the bowl on stemware
  const orbR = 1.15 + 0.78*shape.H;
  const caz = (sm[0]-0.5)*2.6 + 0.010*snz(t*0.23, 11.0);
  const ch  = 0.30 + (1.0-sm[1])*(1.35 + shape.H)   // table level to top-down
            + 0.012*snz(t*0.19, 7.0);
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
  // handheld: slow frame sway + a faint high-frequency tremor (uv units)
  gl.uniform2f(uFin.u_wob,
    0.0016*snz(t*0.50, 1.7) + 0.0005*snz(t*2.9, 9.2),
    0.0013*snz(t*0.44, 4.9) + 0.0005*snz(t*3.3, 2.2));
  gl.uniform2f(uFin.u_px, 1/canvas.width, 1/canvas.height);
  gl.uniform1f(uFin.u_focus, Math.hypot(rox, ch - taY, roz));
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

  requestAnimationFrame(frame);
}
frame();

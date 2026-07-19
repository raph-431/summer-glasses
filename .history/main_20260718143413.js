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
const CAUST_DECAY = 0.95;            // ~10-frame accumulation window
const blurA = mkTarget(BLUR, BLUR);
const blurB = mkTarget(BLUR, BLUR);

const GW = 512, GH = 288, NL = 3;
const NPHOT = GW*GH*NL;

const vao = gl.createVertexArray();  // attribute-less; gl_VertexID does the work
gl.bindVertexArray(vao);

const U = p => new Proxy({}, { get: (_, n) => gl.getUniformLocation(p, n) });
const uP = U(photonProg), uF = U(fadeProg), uB = U(blurProg),
      uC = U(compProg), uBr = U(brightProg), uFin = U(finalProg);

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

let mouse = [0.5, 0.5], sm = [0.5, 0.5];
addEventListener('pointermove', e => { mouse = [e.clientX/innerWidth, e.clientY/innerHeight]; });

const $ = id => document.getElementById(id);

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
    gate.connect(surge); surge.connect(swell); swell.connect(pan); pan.connect(out); out.connect(master);
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
    src.connect(bp); bp.connect(gate); gate.connect(out); out.connect(master);
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
  return { ctx, master, rustle };
}
const audioBtn = document.getElementById('audioBtn');
audioBtn.addEventListener('click', () => {
  if(!AU){ AU = buildAudio(); }
  if(AU.ctx.state === 'suspended') AU.ctx.resume();
  const on = audioBtn.classList.toggle('on');
  AU.master.gain.setTargetAtTime(on ? 0.45 : 0.0, AU.ctx.currentTime, 0.4);
  audioBtn.textContent = on ? '🔊 cicadas' : '🔈 cicadas';
});

const start = performance.now();
function frame(){
  const t = (performance.now() - start)/1000;
  sm[0] += (mouse[0]-sm[0])*0.05;
  sm[1] += (mouse[1]-sm[1])*0.05;

  const wind  = parseFloat($('wind').value);
  const facet = parseFloat($('facet').value);
  const wallv = parseFloat($('wall').value);
  const liq   = parseFloat($('liq').value);
  const diam  = parseFloat($('diam').value);
  const cond  = parseFloat($('cond').value);
  const colaSig = sigFrom($('colaCol').value, 0.35);
  const colaLin = hexLin($('colaCol').value);
  const colaGlow = [1,
    Math.pow(Math.max(colaLin[1]/colaLin[0], 1e-3), 0.33),
    Math.pow(Math.max(colaLin[2]/colaLin[0], 1e-3), 0.33) * 0.55];
  const glassSig = sigFrom($('glassCol').value, 0.30);
  const setShared = (u) => {
    gl.uniform1f(u.u_liq, liq);
    gl.uniform1f(u.u_diam, diam);
    gl.uniform1f(u.u_diamN, parseFloat($('diamN').value));
    gl.uniform1f(u.u_cond, cond);
    gl.uniform1f(u.u_irr, parseFloat($('irr').value));
    gl.uniform3f(u.u_colaSig, ...colaSig);
    gl.uniform3f(u.u_colaGlow, ...colaGlow);
    gl.uniform3f(u.u_glassSig, ...glassSig);
  };
  const leaf  = parseFloat($('leaf').value);
  const sun   = parseFloat($('sun').value);
  const tw = t*wind;

  // ---- the lights: one main sun-gap and two secondary gaps in the foliage
  const azBase = -1.95;                             // sun fixed behind the glass
  const elBase = 0.60;                              // and low: long caustic thrown forward
  const dirs = [], cols = [], offs = [];
  const spec = [
    { daz: 0.00, del: 0.00, int: 1.00, col: [1.06, 1.00, 0.90], ph: 0.0 },
    { daz: 0.38, del:-0.08, int: 0.22, col: [0.97, 1.01, 0.92], ph: 3.1 },
    { daz:-0.45, del: 0.10, int: 0.15, col: [0.94, 0.98, 1.04], ph: 7.4 },
  ];
  // gusts: a slow irregular envelope that decides how hard the leaves flutter
  const gust = 0.30 + 0.70*Math.pow(0.5 + 0.5*snz(tw*0.16, 2.0), 1.6);
  for(let i=0;i<NL;i++){
    const s = spec[i];
    // slow branch-sway + fast gust-driven leaf flutter
    const az = azBase + s.daz + wind*(0.055*snz(tw*0.45, s.ph)
                                    + 0.020*gust*snz(tw*1.5, s.ph*2.3));
    const el = elBase + s.del + wind*(0.028*snz(tw*0.33, s.ph*1.7)
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

  // audio follows the weather: rustle rides the gusts
  if(AU && audioBtn.classList.contains('on')){
    AU.rustle.gain.setTargetAtTime(0.030*wind*(0.4 + 0.8*gust), AU.ctx.currentTime, 0.15);
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
  gl.uniform1f(uP.u_soft, 0.012 + 0.010*wind);
  // per-frame energy: steady state ≈ gain/(1-decay); smaller splats since
  // accumulation fills the gaps, so the folds stay filament-sharp
  gl.uniform1f(uP.u_gain, 0.09);
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
  gl.uniform1f(uC.u_spill, parseFloat($('spill').value));
  // orbit camera from the mouse
  const caz = (sm[0]-0.5)*2.6;
  const ch  = 0.30 + (1.0-sm[1])*2.50;   // table level up to a top-down view
  gl.uniform3f(uC.u_ro, Math.sin(caz)*2.05, ch, Math.cos(caz)*2.05);
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
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  requestAnimationFrame(frame);
}
frame();

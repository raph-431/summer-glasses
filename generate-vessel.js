/**
 * generate-vessel.js — turn a vessel-taste-ratings.json (exported from the
 * Vessels taste trainer) into new glassware shapes. Zero dependencies;
 * works in Node (ESM) and in the browser.
 *
 * Usage:
 *   import { generateGlassware, toOBJ } from './generate-vessel.js';
 *   const ratings = JSON.parse(fs.readFileSync('vessel-taste-ratings.json', 'utf8'));
 *   const [shape] = generateGlassware(ratings, { family: 'stem', seed: 42 });
 *   // shape.genome  — the parameters (store this: it fully defines the glass)
 *   // shape.score   — critic's rating of it, 0..1
 *   // shape.profile — [[r, y], ...] 2D silhouette, ready to revolve
 *   // shape.mesh    — { vertices: [[x,y,z]...], faces: [[a,b,c]...] }
 *   fs.writeFileSync('glass.obj', toOBJ(shape.mesh));
 *
 * Options: { family: 'vessel'|'stem', count: 1, pool: 4000,
 *            temperature: 0,   // 0 = strictly best; 0.2–0.5 = trade score for surprise
 *            seed: null,       // set for reproducible output
 *            segments: 64 }    // revolution resolution of the mesh
 *
 * Pipeline: parse ratings -> train a tiny critic (same MLP + features as the
 * trainer page) -> sample `pool` random genomes -> keep the best, filtered
 * for near-duplicates -> build profile curve -> revolve to mesh.
 */

/* ---------------- genome definitions — must mirror the trainer page ---------------- */
const K = 9, H_MIN = 0.9, H_MAX = 2.2;              // vessel family
const NBOWL = 5;                                     // stem family
const SR = {
  height: [1.6, 2.4], footR: [0.28, 0.55], footH: [0.06, 0.24], footCurve: [0.5, 1.8],
  stemR: [0.045, 0.105], taper: [0.6, 1.3], bulge: [0, 0.14], bulgePos: [0.2, 0.8],
  bowlFrac: [0.32, 0.60],
};
const STEM_KEYS = Object.keys(SR);

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* seeded RNG (mulberry32) + gaussian, so `seed` gives reproducible glasses */
function makeRng(seed) {
  if (seed == null) return { random: Math.random };
  let s = seed >>> 0;
  return { random() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }};
}

/* ---------------- random genome generators ---------------- */
function randomVessel(rng) {
  const radii = []; let r = 0.2 + rng.random()*0.5;
  for (let i = 0; i < K; i++) { r = clamp(r + (rng.random()-0.5)*0.36, 0.06, 1.0); radii.push(r); }
  radii[0] = clamp(radii[0], 0.16, 0.7);
  return { radii, height: H_MIN + rng.random()*(H_MAX - H_MIN) };
}
function randomStem(rng) {
  const g = {};
  for (const k of STEM_KEYS) { const [a, b] = SR[k]; g[k] = a + rng.random()*(b - a); }
  if (rng.random() < 0.55) g.bulge = 0;
  let r = 0.08 + rng.random()*0.30;
  g.bowl = [];
  for (let i = 0; i < NBOWL; i++) { g.bowl.push(r); r = clamp(r + (rng.random()-0.3)*0.45, 0.07, 1.0); }
  return g;
}

/* ---------------- feature vectors — must match the trainer exactly ---------------- */
export function featuresVessel(g) {
  const f = g.radii.slice(); f.push(g.height / H_MAX);
  for (let i = 1; i < K; i++) f.push(g.radii[i] - g.radii[i-1]);
  return f;                                          // 18 dims
}
export function featuresStem(g) {
  const f = STEM_KEYS.map(k => {
    const [a, b] = SR[k];
    const v = g[k] === undefined ? (a + b)/2 : g[k]; // older exports may lack footCurve
    return (v - a)/(b - a);
  });
  f.push(...g.bowl);
  for (let i = 1; i < NBOWL; i++) f.push(g.bowl[i] - g.bowl[i-1]);
  return f;                                          // 18 dims
}

/* ---------------- critic: nin -> 16 (tanh) -> 1 (sigmoid) ---------------- */
const NH = 16;
export function trainCritic(X, y, rng = makeRng(null)) {
  const nin = X[0].length;
  const gaussR = () => {
    let u = 0, v = 0;
    while (!u) u = rng.random(); while (!v) v = rng.random();
    return Math.sqrt(-2*Math.log(u)) * Math.cos(2*Math.PI*v);
  };
  const net = {
    W1: Array.from({length: NH}, () => Array.from({length: nin}, () => gaussR()*0.35)),
    b1: new Array(NH).fill(0),
    W2: Array.from({length: NH}, () => gaussR()*0.35),
    b2: 0,
  };
  const forward = x => {
    const h = new Array(NH);
    for (let j = 0; j < NH; j++) {
      let s = net.b1[j];
      for (let i = 0; i < nin; i++) s += net.W1[j][i]*x[i];
      h[j] = Math.tanh(s);
    }
    let z = net.b2;
    for (let j = 0; j < NH; j++) z += net.W2[j]*h[j];
    return { h, p: 1/(1 + Math.exp(-z)) };
  };
  const n = y.length;
  const nPos = y.reduce((s, t) => s + t, 0), nNeg = n - nPos;
  const wPos = nPos ? Math.max(1, nNeg/nPos) : 1, wNeg = nNeg ? Math.max(1, nPos/nNeg) : 1;
  const lr0 = 0.08, epochs = Math.min(500, 150 + n*4);
  const idx = X.map((_, i) => i);
  for (let e = 0; e < epochs; e++) {
    const lr = lr0*(1 - e/epochs*0.7);
    for (let i = idx.length - 1; i > 0; i--) {        // shuffle
      const j = Math.floor(rng.random()*(i+1)); [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    for (const i of idx) {
      const x = X[i], t = y[i];
      const { h, p } = forward(x);
      const dz = (p - t)*(t === 1 ? wPos : wNeg);
      for (let j = 0; j < NH; j++) {
        const dh = dz*net.W2[j]*(1 - h[j]*h[j]);
        net.W2[j] -= lr*dz*h[j];
        for (let i2 = 0; i2 < nin; i2++) net.W1[j][i2] -= lr*dh*x[i2];
        net.b1[j] -= lr*dh;
      }
      net.b2 -= lr*dz;
    }
  }
  let ok = 0;
  for (let i = 0; i < n; i++) if ((forward(X[i]).p > 0.5 ? 1 : 0) === y[i]) ok++;
  return { score: x => forward(x).p, acc: ok/n };
}

/* ---------------- centripetal Catmull-Rom (same as three.js default) ---------------- */
function catmullRom(points, samples) {
  const P = [points[0], ...points, points[points.length-1]];
  const out = [];
  const segN = Math.max(2, Math.floor(samples/(P.length - 3)));
  const dist = (a, b) => Math.max(Math.hypot(b[0]-a[0], b[1]-a[1]), 1e-6);
  for (let i = 0; i < P.length - 3; i++) {
    const [p0, p1, p2, p3] = [P[i], P[i+1], P[i+2], P[i+3]];
    const t0 = 0, t1 = t0 + Math.sqrt(dist(p0, p1)), t2 = t1 + Math.sqrt(dist(p1, p2)), t3 = t2 + Math.sqrt(dist(p2, p3));
    for (let s = 0; s < segN; s++) {
      const t = t1 + (t2 - t1)*s/segN;
      const lerp2 = (a, b, ta, tb) => {
        const w = (t - ta)/(tb - ta);
        return [a[0] + (b[0]-a[0])*w, a[1] + (b[1]-a[1])*w];
      };
      const A1 = lerp2(p0, p1, t0, t1), A2 = lerp2(p1, p2, t1, t2), A3 = lerp2(p2, p3, t2, t3);
      const B1 = lerp2(A1, A2, t0, t2), B2 = lerp2(A2, A3, t1, t3);
      out.push(lerp2(B1, B2, t1, t2));
    }
  }
  out.push([...P[P.length-2]]);
  return out;
}

/* ---------------- profiles: [[r, y], ...] silhouettes ---------------- */
export function profileVessel(g) {
  const cp = g.radii.map((r, i) => [r, g.height*i/(K-1)]);
  const pts = catmullRom(cp, 90).map(([r, y]) => [Math.max(r, 0.012), y]);
  return [[0.012, 0], ...pts];                       // flat closed base
}
export function profileStem(g) {
  const H = g.height, yB = H*(1 - g.bowlFrac);
  const stemBot = g.stemR, stemTop = g.stemR*g.taper;
  const arch = g.footH*0.4;
  const cp = [[0.012, arch], [g.footR*0.6, arch*0.45], [g.footR, 0.01]];
  for (const t of [0.25, 0.5, 0.75, 1.0]) {          // foot: rim -> stem bottom
    const r = g.footR + (stemBot - g.footR)*t;
    cp.push([Math.max(r, 0.03), 0.01 + (g.footH - 0.01)*Math.pow(t, g.footCurve ?? 1.15)]);
  }
  for (const t of [0.12, 0.28, 0.42, 0.56, 0.70, 0.84, 0.94]) {   // stem
    const r = stemBot + (stemTop - stemBot)*t
            + g.bulge*Math.exp(-Math.pow((t - g.bulgePos)/0.16, 2));
    cp.push([Math.max(r, 0.03), g.footH + (yB - g.footH)*t]);
  }
  cp.push([Math.max(stemTop, 0.03), yB]);            // stem top = bowl bottom
  const bowlH = H - yB;
  g.bowl.forEach((r, i) => cp.push([r, yB + bowlH*(i+1)/NBOWL]));
  return catmullRom(cp, 130).map(([r, y]) => [Math.max(r, 0.02), y]);
}

/* ---------------- mesh: revolve a profile around the Y axis ---------------- */
export function revolve(profile, segments = 64) {
  const n = profile.length, vertices = [], faces = [];
  for (let j = 0; j < segments; j++) {
    const a = 2*Math.PI*j/segments, c = Math.cos(a), s = Math.sin(a);
    for (const [r, y] of profile) vertices.push([r*c, y, r*s]);
  }
  for (let j = 0; j < segments; j++) {
    const j2 = (j + 1) % segments;
    for (let i = 0; i < n - 1; i++) {
      const a = j*n + i, b = j2*n + i, c = j2*n + i + 1, d = j*n + i + 1;
      faces.push([a, b, c], [a, c, d]);
    }
  }
  return { vertices, faces };
}
export function toOBJ({ vertices, faces }) {
  const L = ['# generated by generate-vessel.js'];
  for (const [x, y, z] of vertices) L.push(`v ${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)}`);
  for (const [a, b, c] of faces) L.push(`f ${a+1} ${b+1} ${c+1}`);
  return L.join('\n') + '\n';
}

/* ---------------- main entry point ---------------- */
const FAMS = {
  vessel: { random: randomVessel, features: featuresVessel, profile: profileVessel, valid: r => Array.isArray(r.radii) },
  stem:   { random: randomStem,   features: featuresStem,   profile: profileStem,   valid: r => Array.isArray(r.bowl) },
};

/**
 * @param ratingsData parsed JSON of the trainer's export (v1 or v2)
 * @returns array of { genome, score, profile, mesh }
 */
export function generateGlassware(ratingsData, opts = {}) {
  const { family = 'vessel', count = 1, pool = 4000,
          temperature = 0, seed = null, segments = 64 } = opts;
  const F = FAMS[family];
  if (!F) throw new Error(`unknown family '${family}' — use 'vessel' or 'stem'`);
  const rng = makeRng(seed);

  const fams = ratingsData.version === 2 ? ratingsData.families
             : { vessel: { ratings: ratingsData.ratings || [] } };   // v1 = vessels only
  const ratings = ((fams[family] || {}).ratings || [])
    .filter(r => F.valid(r) && (r.label === 0 || r.label === 1));
  if (ratings.length < 12)
    throw new Error(`only ${ratings.length} '${family}' ratings — need at least one full round`);

  const X = ratings.map(F.features), y = ratings.map(r => r.label);
  const critic = trainCritic(X, y, rng);

  const candidates = Array.from({length: pool}, () => F.random(rng));
  const scored = candidates.map(g => ({ g, f: F.features(g), s: 0 }));
  for (const c of scored) c.s = critic.score(c.f);

  let order;
  if (temperature > 0) {                             // soften: sample among the good
    const max = Math.max(...scored.map(c => c.s));
    order = scored
      .map(c => ({ c, key: -Math.log(-Math.log(rng.random() + 1e-12) + 1e-12) + (c.s - max)/temperature }))
      .sort((a, b) => b.key - a.key).map(o => o.c);  // Gumbel top-k sampling
  } else {
    order = scored.slice().sort((a, b) => b.s - a.s);
  }

  const picked = [];
  const dist = (fa, fb) => Math.sqrt(fa.reduce((s, v, i) => s + (v - fb[i])**2, 0));
  for (const c of order) {
    if (picked.every(p => dist(p.f, c.f) > 0.35)) picked.push(c);   // no near-duplicates
    if (picked.length === count) break;
  }
  return picked.map(({ g, s }) => {
    const profile = F.profile(g);
    return { genome: g, score: s, profile, mesh: revolve(profile, segments) };
  });
}
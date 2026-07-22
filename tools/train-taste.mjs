#!/usr/bin/env node
// train-taste.mjs — read vessel-taste-ratings.json, train the two taste
// critics (the SAME math as generate-vessel.js and the trainer page: 18
// features -> 16 tanh -> 1 sigmoid), and bake the resulting weights into
// taste.js, which the piece loads as a classic script (fetch() is blocked
// on file://, so JSON can't be fetched at runtime).
//
// The training rng is FIXED (mulberry32(0xA11CE)) so rerunning on the same
// ratings writes byte-identical weights. Rerun after re-exporting ratings —
// and know that new weights are ARTWORK STATE: they change which shape
// every existing seed deals, exactly like editing the SHAPES table.
//
// The feature functions below are copied from generate-vessel.js on
// purpose (that file is ESM and the repo root is CJS, so importing it from
// here would need a package.json the web/ harnesses must not see). They
// MUST stay byte-for-byte in sync with the trainer's definitions.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---- genome constants — mirror generate-vessel.js ---- */
const K = 9, H_MAX = 2.2;
const NBOWL = 5;
const SR = {
  height: [1.6, 2.4], footR: [0.28, 0.55], footH: [0.06, 0.24], footCurve: [0.5, 1.8],
  stemR: [0.045, 0.105], taper: [0.6, 1.3], bulge: [0, 0.14], bulgePos: [0.2, 0.8],
  bowlFrac: [0.32, 0.60],
};
const STEM_KEYS = Object.keys(SR);

function featuresVessel(g){
  const f = g.radii.slice(); f.push(g.height / H_MAX);
  for (let i = 1; i < K; i++) f.push(g.radii[i] - g.radii[i-1]);
  return f;
}
function featuresStem(g){
  const f = STEM_KEYS.map(k => {
    const [a, b] = SR[k];
    const v = g[k] === undefined ? (a + b)/2 : g[k];
    return (v - a)/(b - a);
  });
  f.push(...g.bowl);
  for (let i = 1; i < NBOWL; i++) f.push(g.bowl[i] - g.bowl[i-1]);
  return f;
}

/* ---- mulberry32, as in generate-vessel.js makeRng ---- */
function makeRng(seed){
  let s = seed >>> 0;
  return { random(){
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }};
}

/* ---- trainer — generate-vessel.js trainCritic, with the net exposed ---- */
const NH = 16;
function train(X, y, rng){
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
    for (let i = idx.length - 1; i > 0; i--) {
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
  return { net, acc: ok/n };
}

/* ---- run ---- */
const rnd = v => Number(v.toPrecision(7));
const data = JSON.parse(fs.readFileSync(path.join(root, 'vessel-taste-ratings.json'), 'utf8'));
const fams = data.version === 2 ? data.families
           : { vessel: { ratings: data.ratings || [] } };

const out = {};
for (const fam of ['vessel', 'stem']) {
  const valid = fam === 'vessel' ? r => Array.isArray(r.radii) : r => Array.isArray(r.bowl);
  const ratings = ((fams[fam] || {}).ratings || [])
    .filter(r => valid(r) && (r.label === 0 || r.label === 1));
  if (ratings.length < 12) {
    console.error(`${fam}: only ${ratings.length} ratings — skipped (need 12+)`);
    continue;
  }
  const F = fam === 'vessel' ? featuresVessel : featuresStem;
  const { net, acc } = train(ratings.map(F), ratings.map(r => r.label), makeRng(0xA11CE));
  console.log(`${fam}: ${ratings.length} ratings, train accuracy ${(acc*100).toFixed(1)}%`);
  out[fam] = {
    W1: net.W1.map(row => row.map(rnd)),
    b1: net.b1.map(rnd),
    W2: net.W2.map(rnd),
    b2: rnd(net.b2),
    acc: rnd(acc),
  };
}

fs.writeFileSync(path.join(root, 'taste.js'),
  '// GENERATED by tools/train-taste.mjs — do not edit. Rerun the tool after\n' +
  '// re-exporting vessel-taste-ratings.json. These weights are ARTWORK STATE:\n' +
  '// regenerating them changes which shape every existing seed deals.\n' +
  'const TASTE = ' + JSON.stringify(out) + ';\n');
console.log('wrote taste.js');

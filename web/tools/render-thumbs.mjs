#!/usr/bin/env node
// Marketplace thumbnails — the `image` field of tokenURI.
//
// The artwork is fully on-chain and its animation_url is a data: URI, which
// marketplaces don't render, so without an image every glass shows as a
// blank card. This renders one: for every minted glass it fetches the token's
// EXACT on-chain artwork (the frozen bytes, not a local build), photographs
// it in headless Chrome, and writes web/thumb/<id>.jpg. The site serves that
// at /thumb/<id> (see the rewrite in web/vercel.json), so the contract only
// needs pointing at it once — the pointer is imageBase + tokenId:
//
//   cast send $CONTRACT "setImageBase(string)" "https://<site>/thumb/"
//
// Re-run after new redemptions: already-rendered ids are skipped. Also
// writes web/thumb/index.json (ids + deal labels) — the gallery reads it to
// show these portraits instead of rendering its own. Plain Node,
// no deps; needs Chrome (Node >= 22 for the built-in WebSocket).
//
// Usage: node web/tools/render-thumbs.mjs [--net base|baseSepolia|anvil]
//        [--ids 3,7,12] [--force] [--secs 6] [--size 1200x750] [--probe]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// the browser pages get keccak from the vendored UMD sha3 via a script tag;
// here it's the same global, same file (as the test harnesses do)
globalThis.keccak_256 = createRequire(import.meta.url)('../vendor/sha3.js').keccak_256;
const networks = await import('../config.js');
const { totalMinted, seedOf, htmlForSeed } = await import('../lib/token.js');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const NET   = arg('net', 'base');
const FORCE = process.argv.includes('--force');
const PROBE = process.argv.includes('--probe');    // log GL renderer, fps, deal
const SECS  = +arg('secs', 6);            // real seconds of rendering before the shot (~10 frames suffice)
const [W, H] = arg('size', '1200x750').split('x').map(Number);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = fileURLToPath(new URL('../thumb/', import.meta.url));

const cfg = networks[NET];
if(!cfg){ console.error(`unknown --net ${NET}; have: ${Object.keys(networks).filter(k => k !== 'default').join(', ')}`); process.exit(1); }
if(!fs.existsSync(CHROME)){ console.error(`Chrome not found at ${CHROME} (set CHROME=)`); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const minted = await totalMinted(cfg);
const ids = arg('ids') ? arg('ids').split(',').map(Number)
                       : Array.from({ length: minted }, (_, i) => i + 1);
console.log(`${NET}: ${minted} minted — ${ids.length} requested`);

// The on-chain bootstrap sets window.TOKEN_HASH, inflates a gzipped payload
// (the whole piece as one file) and document.writes it. Pull the payload out
// once — it's identical for every glass — and rebuild the same page directly:
// the seed goes in as the bootstrap would set it, plus one line of CSS that
// hides the corner buttons in the photograph.
let art = null;
function pageFor(bootstrap){
  const hash = bootstrap.match(/window\.TOKEN_HASH\s*=\s*"([^"]+)"/)?.[1];
  if(!hash) throw new Error('no TOKEN_HASH in bootstrap');
  if(!art){
    const b64 = bootstrap.match(/atob\("([A-Za-z0-9+/=]+)"\)/)?.[1];
    if(!b64) throw new Error('no payload in bootstrap');
    art = zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
    if(!/<head>/i.test(art) || !/<\/head>/i.test(art)) throw new Error('payload has no <head>');
  }
  return art
    .replace(/<head>/i, `<head><script>window.TOKEN_HASH=${JSON.stringify(hash)}</script>`)
    .replace(/<\/head>/i, '<style>#corner{display:none!important}</style></head>');
}

// Headless Chrome, driven over the DevTools protocol: open the page, let it
// render for SECS real seconds (enough frames for the caustic accumulation
// even under software GL), then ask the compositor for a JPEG. A plain
// --screenshot fires at the load event, before the exposure has charged.
function wsUrl(chrome){
  return new Promise((resolve, reject) => {
    let err = '';
    chrome.stderr.on('data', d => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if(m) resolve(m[1]);
    });
    chrome.on('close', () => reject(new Error('Chrome exited before DevTools came up')));
  });
}
async function shoot(html, jpg){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-thumb-'));
  const page = path.join(dir, 'glass.html');
  fs.writeFileSync(page, html);
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--window-size=${W},${H}`, '--remote-debugging-port=0',
    `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const guard = setTimeout(() => chrome.kill('SIGKILL'), SECS*1000 + 60000);
  try {
    const browser = await wsUrl(chrome);
    const port = new URL(browser).port;
    let targets = [];
    for(let i = 0; i < 40 && !targets.length; i++){
      targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page');
      if(!targets.length) await new Promise(r => setTimeout(r, 250));
    }
    if(!targets.length) throw new Error('no page target');
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let nextId = 1; const pending = new Map(); const events = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if(m.id && pending.has(m.id)){ pending.get(m.id)(m); pending.delete(m.id); }
      else if(m.method) events.push(m.method);
    };
    const send = (method, params = {}) => new Promise(res => {
      const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Page.enable');
    // the viewport, not the window: --window-size includes browser chrome
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'file://' + page });
    for(let i = 0; i < 200 && !events.includes('Page.loadEventFired'); i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, SECS*1000));
    // the deal's labels ride along in the manifest: the gallery names rows
    // from $features, which a static JPEG can't supply. --probe also logs
    // the GL renderer and real frame rate.
    const probe = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `
      new Promise(done => { let n = 0; const t0 = performance.now();
        (function f(){ n++; performance.now() - t0 < 1000 ? requestAnimationFrame(f) : done(n); })();
      }).then(fps => { const g = document.querySelector('canvas').getContext('webgl2');
        const d = g && g.getExtension('WEBGL_debug_renderer_info');
        return JSON.stringify({ fps, gl: d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : (g ? g.getParameter(g.RENDERER) : 'none'),
          features: window.$features || null }); })` });
    const info = JSON.parse(probe.result?.result?.value ?? '{}');
    if(PROBE) console.log('  ' + JSON.stringify(info));
    if(!info.features) throw new Error('no $features on the page');
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
    if(!shot.result?.data) throw new Error('no screenshot: ' + JSON.stringify(shot.error || shot));
    fs.writeFileSync(jpg, Buffer.from(shot.result.data, 'base64'));
    ws.close();
    return info.features;
  } catch(e){
    console.log('  ' + e.message);
    return null;
  } finally {
    clearTimeout(guard);
    chrome.kill('SIGKILL');
    await new Promise(r => chrome.on('close', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// web/thumb/index.json — which ids have a portrait, and each deal's labels.
// Bound to one contract so a gallery pointed at anvil never borrows Base's.
const MANIFEST = path.join(OUT, 'index.json');
let manifest = { chainId: cfg.chainId, contract: cfg.contract, glasses: {} };
try {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if(m.chainId === cfg.chainId && m.contract?.toLowerCase() === cfg.contract.toLowerCase()) manifest = m;
} catch {}
const saveManifest = () => fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + '\n');

let done = 0, skipped = 0, failed = [];
for(const id of ids){
  const jpg = path.join(OUT, `${id}.jpg`);
  if(!FORCE && fs.existsSync(jpg) && manifest.glasses[id]){ skipped++; continue; }
  const seed = await seedOf(cfg, id);
  if(/^0x0*$/.test(seed)){ console.log(`#${id}: not minted, skipping`); continue; }
  const t0 = Date.now();
  const html = pageFor(await htmlForSeed(cfg, seed));
  const features = await shoot(html, jpg);
  if(features){ manifest.glasses[id] = features; saveManifest(); done++; console.log(`#${id}: ${(fs.statSync(jpg).size/1024).toFixed(0)} KB in ${((Date.now()-t0)/1000).toFixed(0)}s`); }
  else { failed.push(id); console.log(`#${id}: FAILED`); }
}
console.log(`rendered ${done}, skipped ${skipped} (already there)${failed.length ? ', failed: ' + failed.join(',') : ''}`);
if(failed.length) process.exit(1);

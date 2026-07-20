// ---------------------------------------------------------------------------
// THUMBNAILS — the artwork can't be screenshotted from outside (its WebGL
// context doesn't preserve the drawing buffer), so each glass is asked to
// photograph itself: mount it in an offscreen iframe, post it a snapshot
// request, and it replies with a JPEG once its caustics have settled.
//
// Results are cached in IndexedDB by seed, so a glass is only ever rendered
// once per browser. Requests run five at a time, each batch finishing before
// the next starts — every live glass is a WebGL context, and browsers only
// allow so many at once.
// ---------------------------------------------------------------------------

const DB = 'summer-glasses', STORE = 'thumbs';
const BATCH = 5;
const TIMEOUT_MS = 20000;
const SIZE = { w: 420, h: 300 };   // render size; CSS scales it down

let dbp = null;
function db(){
  if(dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).catch(() => null);           // private mode / blocked storage: no cache
  return dbp;
}

async function cacheGet(seed){
  const d = await db(); if(!d) return null;
  return new Promise(resolve => {
    const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(seed);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function cachePut(seed, jpeg){
  const d = await db(); if(!d) return;
  try { d.transaction(STORE, 'readwrite').objectStore(STORE).put(jpeg, seed); } catch {}
}

/// Render one glass offscreen and return a JPEG data URL.
function capture(html, seed){
  return new Promise((resolve, reject) => {
    const id = seed + ':' + Math.random().toString(36).slice(2);
    const frame = document.createElement('iframe');
    frame.width = SIZE.w; frame.height = SIZE.h;
    // kept in the layout but out of sight: an iframe that is display:none
    // (or has zero size) may never get a rAF tick, and would never render
    frame.style.cssText =
      'position:fixed; left:-9999px; top:0; border:0; ' +
      `width:${SIZE.w}px; height:${SIZE.h}px; pointer-events:none;`;

    let done = false;
    const finish = (fn, arg) => {
      if(done) return;
      done = true;
      clearTimeout(timer);
      removeEventListener('message', onMsg);
      frame.remove();                       // frees the WebGL context
      fn(arg);
    };
    const onMsg = (e) => {
      const d = e.data;
      if(!d || d.type !== 'summer-glass-snapshot' || d.id !== id) return;
      d.jpeg ? finish(resolve, d.jpeg) : finish(reject, new Error(d.error || 'snapshot failed'));
    };
    const timer = setTimeout(() => finish(reject, new Error('snapshot timed out')), TIMEOUT_MS);

    addEventListener('message', onMsg);
    frame.srcdoc = html;
    frame.onload = () => {
      // the request can arrive before the piece has wired its listener up;
      // repeating it is harmless — it only ever sets a pending flag
      const ask = () => frame.contentWindow?.postMessage(
        { type: 'summer-glass-snapshot-request', id, quality: 0.72 }, '*');
      ask();
      const retry = setInterval(() => (done ? clearInterval(retry) : ask()), 700);
      setTimeout(() => clearInterval(retry), TIMEOUT_MS);
    };
    document.body.appendChild(frame);
  });
}

// Work in whole batches: start five, wait for all five to finish (or fail),
// only then start the next five. A rolling queue would keep a trickle of
// renderers alive indefinitely; this way the browser gets clear gaps between
// bursts, and each batch of tiles appears together rather than dribbling in.
const queue = [];
let draining = false;

async function drain(){
  if(draining) return;
  draining = true;
  while(queue.length){
    const batch = queue.splice(0, BATCH);
    await Promise.allSettled(batch.map(job =>
      job.run().then(job.resolve, job.reject)));
  }
  draining = false;
}

/// Cached-or-rendered JPEG for a glass. `getHtml()` is only called on a miss,
/// so cached tiles cost no chain reads at all.
export function thumbnail(seed, getHtml){
  return new Promise((resolve, reject) => {
    queue.push({
      resolve, reject,
      run: async () => {
        const hit = await cacheGet(seed);
        if(hit) return hit;
        const jpeg = await capture(await getHtml(), seed);
        await cachePut(seed, jpeg);
        return jpeg;
      },
    });
    drain();
  });
}

export async function clearThumbCache(){
  const d = await db(); if(!d) return;
  d.transaction(STORE, 'readwrite').objectStore(STORE).clear();
}

// Minimal JSON-RPC + ABI helpers — just enough for the two pages, no library.
import { keccak, bytesToHex } from './claim.js';

// Public RPCs (Base's mainnet endpoint especially) rate-limit aggressively,
// and the gallery fans out many reads at once — owner + seed + the ~60 KB
// on-chain artwork per glass, several rows lighting up together. Funnel every
// request through a small concurrency gate, and retry the ones that come back
// "over rate limit" with exponential backoff, so a busy page degrades to
// slower rather than failing. One shared queue across the whole page.
// Cap both how many requests run at once AND how fast they go out: Base's
// public endpoint limits by rate, not just concurrency, so bursting three
// quick reads still trips a 429. Two in flight, spaced ≥ MIN_GAP_MS apart,
// keeps us under the limit; the retry below mops up the occasional overflow.
const MAX_INFLIGHT = 2;
const MIN_GAP_MS = 120;
const MAX_RETRIES = 6;
let inflight = 0;
let lastDispatch = 0;
let pumpTimer = null;
const queue = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (e) =>
  /rate limit|too many|429|-32005|capacity|throttl/i.test(String((e && (e.message || e)) || ''));
// exponential backoff with jitter: ~0.4s, 0.8s, 1.6s, … capped at 6s
const backoff = (attempt) => Math.min(6000, 400 * 2 ** attempt) + Math.random() * 250;

function pump(){
  if(pumpTimer) return;                       // a spaced dispatch is already pending
  while(inflight < MAX_INFLIGHT && queue.length){
    const wait = lastDispatch + MIN_GAP_MS - Date.now();
    if(wait > 0){                             // too soon — space the next one out
      pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, wait);
      return;
    }
    lastDispatch = Date.now();
    const job = queue.shift();
    inflight++;
    job().finally(() => { inflight--; pump(); });
  }
}

export function rpc(url, method, params){
  return new Promise((resolve, reject) => {
    queue.push(async () => {
      for(let attempt = 0; ; attempt++){
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          });
          if(res.status === 429){
            if(attempt >= MAX_RETRIES){ reject(new Error('over rate limit')); return; }
            await sleep(backoff(attempt)); continue;
          }
          const body = await res.json();
          if(body.error){
            const err = new Error(body.error.message || 'rpc error');
            if(isRateLimit(err) && attempt < MAX_RETRIES){ await sleep(backoff(attempt)); continue; }
            reject(err); return;
          }
          resolve(body.result); return;
        } catch(e){
          // network blips and rate-limit bodies both retry; everything else fails fast
          if(isRateLimit(e) && attempt < MAX_RETRIES){ await sleep(backoff(attempt)); continue; }
          reject(e); return;
        }
      }
    });
    pump();
  });
}

export const selector = (sig) => bytesToHex(keccak(sig)).slice(0, 10);
export const padAddress = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const padUint = (n) => BigInt(n).toString(16).padStart(64, '0');

export const ethCall = (url, to, data) =>
  rpc(url, 'eth_call', [{ to, data }, 'latest']);

// decode a single abi-encoded string return value
export function decodeString(hex){
  const b = hex.replace(/^0x/, '');
  const len = parseInt(b.slice(64, 128), 16);
  const bytes = new Uint8Array(len);
  for(let i = 0; i < len; i++) bytes[i] = parseInt(b.slice(128 + i*2, 130 + i*2), 16);
  return new TextDecoder().decode(bytes);
}

export const fromWei = (wei) => {
  const s = BigInt(wei).toString().padStart(19, '0');
  return (s.slice(0, -18) + '.' + s.slice(-18)).replace(/\.?0+$/, '') || '0';
};

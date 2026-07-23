// The gallery was failing thumbnails with "over rate limit" because rpc.js
// fired every read at once with no retry. These check that rpc() now retries
// rate-limited calls, fails fast on real errors, and caps concurrency.
//
//   node web/test/rpc-throttle.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.keccak_256 = require('../vendor/sha3.js').keccak_256;
const { rpc } = await import('../lib/rpc.js');

let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if(!ok) fails++; };

const ok = (result) => ({ status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
const rateBody = () => ({ status: 200, json: async () => ({ error: { code: -32005, message: 'over rate limit' } }) });
const http429 = () => ({ status: 429, json: async () => ({}) });
const revert = () => ({ status: 200, json: async () => ({ error: { message: 'execution reverted' } }) });

// 1) a rate-limit body is retried, then succeeds
{
  let n = 0;
  globalThis.fetch = async () => (++n < 3 ? rateBody() : ok('0xdead'));
  const t0 = Date.now();
  const r = await rpc('u', 'eth_call', []);
  check('retries a rate-limit body then returns the result', r === '0xdead' && n === 3);
  check('backoff actually waited between tries', Date.now() - t0 >= 400);
}

// 2) an HTTP 429 is retried, then succeeds
{
  let n = 0;
  globalThis.fetch = async () => (++n < 2 ? http429() : ok('0xbeef'));
  const r = await rpc('u', 'eth_call', []);
  check('retries an HTTP 429 then returns the result', r === '0xbeef' && n === 2);
}

// 3) a real contract error is NOT retried — fails fast
{
  let n = 0;
  globalThis.fetch = async () => { n++; return revert(); };
  let threw = null;
  try { await rpc('u', 'eth_call', []); } catch(e){ threw = e.message; }
  check('does not retry a real revert', threw === 'execution reverted' && n === 1);
}

// 4) concurrency is capped AND requests are spaced out (rate-limited), even
//    when 8 calls are fired together
{
  let cur = 0, peak = 0;
  const starts = [];
  globalThis.fetch = async () => {
    starts.push(Date.now());
    cur++; peak = Math.max(peak, cur);
    await new Promise(r => setTimeout(r, 30));
    cur--; return ok('0x1');
  };
  await Promise.all(Array.from({ length: 8 }, () => rpc('u', 'eth_call', [])));
  check('never more than 2 requests in flight at once', peak <= 2 && peak > 0);
  // consecutive dispatches are spaced by roughly the min gap (allow slack)
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  check('requests are spaced out, not bursted', gaps.filter(g => g >= 90).length >= 5);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);

// Reading tokens back out of the chain — shared by redeem.html (the reveal)
// and view.html (the permanent viewer).
import { ethCall, selector, decodeString, padAddress } from './rpc.js';

const padId = (id) => BigInt(id).toString(16).padStart(64, '0');

/// { name, description, animation_url } straight from the on-chain tokenURI
export async function fetchMeta(cfg, tokenId){
  const hex = await ethCall(cfg.rpc, cfg.contract, selector('tokenURI(uint256)') + padId(tokenId));
  const uri = decodeString(hex);
  if(!uri.startsWith('data:application/json;base64,')) throw new Error('unexpected tokenURI format');
  return JSON.parse(atob(uri.slice(uri.indexOf(',') + 1)));
}

export async function seedOf(cfg, tokenId){
  // seeds are fixed forever at redemption, so cache them — a gallery reload
  // then costs nothing per already-seen glass
  const key = `seed:${cfg.chainId}:${cfg.contract}:${tokenId}`;
  try { const c = localStorage.getItem(key); if(c) return c; } catch {}
  const seed = await ethCall(cfg.rpc, cfg.contract, selector('seedOf(uint256)') + padId(tokenId));
  if(!/^0x0*$/.test(seed)){ try { localStorage.setItem(key, seed); } catch {} }
  return seed;
}

/// The artwork HTML for a token, without the JSON wrapper — cheaper than
/// tokenURI (no base64 of the whole page) and what the gallery renders.
export async function fetchHTML(cfg, seed){
  const hex = await ethCall(cfg.rpc, cfg.contract, selector('tokenHTML(bytes32)') + seed.replace(/^0x/, '').padStart(64, '0'));
  const body = hex.slice(2);
  const len = parseInt(body.slice(64, 128), 16);
  const bytes = new Uint8Array(len);
  for(let i = 0; i < len; i++) bytes[i] = parseInt(body.slice(128 + i*2, 130 + i*2), 16);
  return new TextDecoder().decode(bytes);
}

// The artwork bytes are IDENTICAL for every glass — only the 32-byte seed
// differs — yet tokenHTML() re-sends the whole ~60 KB per token. The gallery
// fetches it ONCE with a sentinel seed, splits out the seed slot, and splices
// each glass's own seed in locally: N×60 KB of reads collapse to 1×60 KB plus
// N tiny seed reads. Kept in memory for the page session.
const SEED_SENTINEL = '0x' + 'deadbeef'.repeat(8);
let _artTemplate = null;

async function artTemplate(cfg){
  if(_artTemplate) return _artTemplate;
  const html = await fetchHTML(cfg, SEED_SENTINEL);
  const i = html.indexOf(SEED_SENTINEL);
  if(i < 0 || html.indexOf(SEED_SENTINEL, i + 1) !== -1)
    throw new Error('seed marker not unique');           // fall back per-token
  return (_artTemplate = { prefix: html.slice(0, i), suffix: html.slice(i + SEED_SENTINEL.length) });
}

/// Artwork HTML for a seed, built locally from the once-fetched template.
/// Falls back to a per-token read if the template can't be established.
export async function htmlForSeed(cfg, seed){
  try {
    const t = await artTemplate(cfg);
    return t.prefix + '0x' + seed.replace(/^0x/, '').toLowerCase().padStart(64, '0') + t.suffix;
  } catch {
    return fetchHTML(cfg, seed);
  }
}

export async function ownerOf(cfg, tokenId){
  const hex = await ethCall(cfg.rpc, cfg.contract, selector('ownerOf(uint256)') + padId(tokenId));
  return '0x' + hex.slice(-40);
}

export const shortAddr = (a) => a.slice(0, 8);   // 0x + 6 digits

export async function totalMinted(cfg){
  return Number(BigInt(await ethCall(cfg.rpc, cfg.contract, selector('nextId()')))) - 1;
}

/// Which tokens an address holds. The collection has no ERC721Enumerable, and
/// public RPCs cap eth_getLogs ranges (Base's at 2000 blocks), so scanning
/// ownerOf across the minted range is both simpler and more dependable —
/// supply is capped, and the scan runs in small parallel batches.
export async function tokensOf(cfg, address, onProgress){
  const minted = await totalMinted(cfg);
  const want = address.toLowerCase();
  const found = [];
  const BATCH = 12;
  for(let start = 1; start <= minted; start += BATCH){
    const ids = [];
    for(let id = start; id < start + BATCH && id <= minted; id++) ids.push(id);
    const owners = await Promise.all(ids.map(id => ownerOf(cfg, id).catch(() => null)));
    owners.forEach((owner, i) => { if(owner && owner.toLowerCase() === want) found.push(ids[i]); });
    onProgress?.(Math.min(start + BATCH - 1, minted), minted, found.length);
  }
  return found;
}

/// Drop a token's artwork into an iframe. The HTML is self-contained, so it
/// goes in via srcdoc — no data: URI length limits, no network fetch.
export function renderInto(iframe, meta){
  iframe.srcdoc = atob(meta.animation_url.slice(meta.animation_url.indexOf(',') + 1));
}

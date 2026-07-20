// ---------------------------------------------------------------------------
// CLAIM KEY — the gift code is an ephemeral secp256k1 private key. This
// module generates it, renders it as a human-friendly base58check code
// ("SMR-…"), derives its address (what gift() escrows against), and signs
// the redeem digest that binds the recipient.
//
// ESM. Depends on vendor/secp256k1.js (noble, ESM) and vendor/sha3.js
// (js-sha3, classic script → globalThis.keccak_256; a Node harness must set
// that global before importing this module).
// ---------------------------------------------------------------------------
import * as secp from '../vendor/secp256k1.js';

export const keccak = (input) => new Uint8Array(globalThis.keccak_256.arrayBuffer(input));

export const bytesToHex = (b) => '0x' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
export function hexToBytes(h){
  h = h.replace(/^0x/, '');
  const out = new Uint8Array(h.length/2);
  for(let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i*2, i*2+2), 16);
  return out;
}

// EIP-55 mixed-case checksum, so addresses paste cleanly into wallets
export function checksumAddress(addrHex){
  const lower = addrHex.replace(/^0x/, '').toLowerCase();
  const hash = globalThis.keccak_256(lower);
  let out = '0x';
  for(let i = 0; i < 40; i++)
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

export const newClaimKey = () => secp.utils.randomSecretKey
  ? secp.utils.randomSecretKey() : secp.utils.randomPrivateKey();

export function addressOf(priv){
  const pub = secp.getPublicKey(priv, false);            // 65B uncompressed
  return checksumAddress(bytesToHex(keccak(pub.slice(1)).slice(12)));
}

/// 65-byte r||s||v signature over a raw 32-byte digest (no EIP-191 prefix —
/// the contract's redeemDigest is signed as-is). RFC6979 deterministic.
export async function signDigest(priv, digestHex){
  const sig = await secp.signAsync(hexToBytes(digestHex), priv);
  const out = new Uint8Array(65);
  out.set(sig.toBytes ? sig.toBytes('compact') : sig.toCompactRawBytes());
  out[64] = sig.recovery + 27;                           // ecrecover's v
  return bytesToHex(out);
}

// ---- the code format ------------------------------------------------------
// base58(priv ‖ keccak(priv)[0..4]) in dashed groups of 4: typo-safe (58 has
// no 0/O/I/l), checksummed, compact enough for a gift card.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeCode(priv){
  const check = keccak(priv).slice(0, 4);
  const payload = new Uint8Array(36);
  payload.set(priv); payload.set(check, 32);
  let n = BigInt(bytesToHex(payload));
  let s = '';
  while(n > 0n){ s = B58[Number(n % 58n)] + s; n /= 58n; }
  for(let i = 0; i < payload.length && payload[i] === 0; i++) s = B58[0] + s;
  return s.match(/.{1,4}/g).join('-');
}

/// returns the private key bytes, or null if malformed / checksum fails
export function decodeCode(code){
  const s = code.replace(/[-\s]/g, '');
  let n = 0n;
  for(const c of s){
    const v = B58.indexOf(c);
    if(v < 0) return null;
    n = n*58n + BigInt(v);
  }
  const bytes = new Uint8Array(36);
  for(let i = 35; i >= 0; i--){ bytes[i] = Number(n & 0xffn); n >>= 8n; }
  if(n > 0n) return null;
  const priv = bytes.slice(0, 32), check = keccak(priv).slice(0, 4);
  for(let i = 0; i < 4; i++) if(bytes[32+i] !== check[i]) return null;
  return priv;
}

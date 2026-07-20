// ---------------------------------------------------------------------------
// CLAIM KEY — the gift code. Behind it is an ephemeral secp256k1 private key
// (the thing that actually authorises a redeem), but nobody should have to
// read 62 characters off a card, so the code people see is five words and a
// five-digit number:
//
//     amber cicada glass noon shade 40317
//
// The words and number ARE the secret: the private key is derived from them
// with a deliberately slow KDF. That matters because a gift's claim address
// is public on-chain the moment it is paid for, so an attacker can grind
// guesses offline with nothing to rate-limit them. The sums:
//
//     5 words from 2048   55.0 bits
//     5 digits            16.6 bits
//     -------------------------------
//                        ~71.6 bits, times ~2^18 work per guess (PBKDF2)
//
// which is far past reach even if every outstanding gift is attacked at once.
// Do not shorten this without redoing that arithmetic.
//
// Codes from before this format (base58 of a raw key) still decode, so gifts
// bought under the old scheme remain redeemable.
//
// ESM. Depends on vendor/secp256k1.js, vendor/wordlist.js, and
// vendor/sha3.js (classic script → globalThis.keccak_256; a Node harness
// must set that global before importing this module).
// ---------------------------------------------------------------------------
import * as secp from '../vendor/secp256k1.js';
import { WORDS } from '../vendor/wordlist.js';

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
// 5 words (11 bits each) + a 5-digit number: one integer, base-2048 for the
// words and base-100000 for the tail.

const WORD_INDEX = new Map(WORDS.map((w, i) => [w, i]));
const KDF_SALT = 'summer-glasses/gift-code/v2';
const KDF_ROUNDS = 250000;
const DIGITS = 100000n;

/// A fresh gift secret: five words and a number, as one displayable string.
export function newCode(){
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for(const b of bytes) n = (n << 8n) | BigInt(b);
  n %= (2048n ** 5n) * DIGITS;          // the space the format can represent
  return formatCode(n);
}

function formatCode(n){
  const num = n % DIGITS;
  let rest = n / DIGITS;
  const words = [];
  for(let i = 0; i < 5; i++){ words.unshift(WORDS[Number(rest % 2048n)]); rest /= 2048n; }
  return words.join(' ') + ' ' + String(num).padStart(5, '0');
}

/// Parse a code back to its number, or null if it isn't one. Forgiving about
/// spacing, dashes, case and stray punctuation — people retype these.
function parseCode(code){
  const parts = String(code).toLowerCase().trim().split(/[^a-z0-9]+/).filter(Boolean);
  if(parts.length !== 6) return null;
  const digits = parts[5];
  if(!/^\d{1,5}$/.test(digits)) return null;
  let n = 0n;
  for(let i = 0; i < 5; i++){
    const idx = WORD_INDEX.get(parts[i]);
    if(idx === undefined) return null;
    n = n * 2048n + BigInt(idx);
  }
  return n * DIGITS + BigInt(digits);
}

/// Which words in a code aren't in the list — so the page can point at the
/// typo instead of just refusing the whole thing.
export function badWords(code){
  const parts = String(code).toLowerCase().trim().split(/[^a-z0-9]+/).filter(Boolean);
  return parts.slice(0, 5).filter(w => !/^\d+$/.test(w) && !WORD_INDEX.has(w));
}

/// Stretch the code into a private key. Slow on purpose: this is the only
/// thing standing between a guessable-length code and an offline search.
async function keyFromNumber(n){
  let hex = n.toString(16);
  if(hex.length % 2) hex = '0' + hex;
  const seed = hexToBytes(hex);
  const bits = await crypto.subtle.importKey('raw', seed, 'PBKDF2', false, ['deriveBits']);
  const out = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(KDF_SALT),
      iterations: KDF_ROUNDS, hash: 'SHA-256' }, bits, 256));
  // reduce into the curve order, avoiding the (vanishingly unlikely) zero
  let k = 0n;
  for(const b of out) k = (k << 8n) | BigInt(b);
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  k = (k % (N - 1n)) + 1n;
  let kh = k.toString(16).padStart(64, '0');
  return hexToBytes(kh);
}

/// Code (either format) -> private key, or null if it isn't a valid code.
export async function keyFromCode(code){
  const n = parseCode(code);
  if(n !== null) return keyFromNumber(n);
  return decodeLegacyCode(code);        // gifts bought under the old scheme
}

// ---- legacy: base58(priv ‖ checksum), the pre-words format ----------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeLegacyCode(priv){
  const check = keccak(priv).slice(0, 4);
  const payload = new Uint8Array(36);
  payload.set(priv); payload.set(check, 32);
  let n = BigInt(bytesToHex(payload));
  let s = '';
  while(n > 0n){ s = B58[Number(n % 58n)] + s; n /= 58n; }
  for(let i = 0; i < payload.length && payload[i] === 0; i++) s = B58[0] + s;
  return s.match(/.{1,4}/g).join('-');
}

export function decodeLegacyCode(code){
  const s = String(code).replace(/[-\s]/g, '');
  if(!s || /[^1-9A-HJ-NP-Za-km-z]/.test(s)) return null;
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

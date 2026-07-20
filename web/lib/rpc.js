// Minimal JSON-RPC + ABI helpers — just enough for the two pages, no library.
import { keccak, bytesToHex } from './claim.js';

export async function rpc(url, method, params){
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if(body.error) throw new Error(body.error.message || 'rpc error');
  return body.result;
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

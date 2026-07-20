// Proves the Vercel redeem function (web/api/redeem.mjs) against the LIVE
// Base Sepolia contract — a real gift, a real signed redeem, a real mint.
//
// A broadcast needs a funded key. Rather than touch the real relayer key,
// this generates a throwaway one and asks you to fund it with a little
// testnet ETH; the key is a disposable fixture in a gitignored file.
//
//   node web/test/relayer-viem-sepolia.mjs
//     first run  -> prints an address to fund, then exit
//     after you fund it, run again -> full end-to-end on Sepolia
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import {
  createPublicClient, createWalletClient, http, defineChain, parseEther, formatEther,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const require = createRequire(import.meta.url);
globalThis.keccak_256 = require('../vendor/sha3.js').keccak_256;
const { newCode, keyFromCode, addressOf, signDigest, bytesToHex } = await import('../lib/claim.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = '0xd44395a4832fdb631b3fd3ecb39e94b7da022e07';
const RPC_URL = 'https://sepolia.base.org';
const CHAIN_ID = 84532;
const KEY_FILE = path.join(root, '.test-key');

const chain = defineChain({
  id: CHAIN_ID, name: 'base-sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const pub = createPublicClient({ chain, transport: http(RPC_URL) });

const ABI = [
  { type: 'function', name: 'gift', stateMutability: 'payable', inputs: [{ name: 'claimAddr', type: 'address' }], outputs: [] },
  { type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'gasStipend', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint96' }] },
  { type: 'function', name: 'redeemDigest', stateMutability: 'view', inputs: [{ name: 'to', type: 'address' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'seedOf', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'withdrawable', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

// ---- the throwaway funding key -------------------------------------------
let testKey;
if(fs.existsSync(KEY_FILE)){
  testKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
} else {
  testKey = generatePrivateKey();
  fs.writeFileSync(KEY_FILE, testKey, { mode: 0o600 });
}
const funder = privateKeyToAccount(testKey);
const bal = await pub.getBalance({ address: funder.address });
const need = parseEther('0.0025');   // one gift+redeem cycle ≈ 0.0021 + gas
if(bal < need){
  console.log('\nThrowaway test wallet (gitignored, disposable):');
  console.log('  ' + funder.address);
  console.log(`  balance ${formatEther(bal)} ETH — needs ~0.0025 Base Sepolia ETH`);
  console.log('\nSend it a little Base Sepolia ETH, then run this again.');
  console.log('(It plays both gifter and relayer; the ~0.002 price becomes the');
  console.log(' contract\'s proceeds, which you can withdraw later as owner.)\n');
  process.exit(2);
}

let fails = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if(!ok) fails++; };
console.log(`funded test wallet ${funder.address} — ${formatEther(bal)} ETH\n`);

const wallet = createWalletClient({ account: funder, chain, transport: http(RPC_URL) });

// ---- gift, exactly as the gift page does it ------------------------------
const code = newCode();
const claimPriv = await keyFromCode(code);
const claimAddr = addressOf(claimPriv);
const price = await pub.readContract({ address: CONTRACT, abi: ABI, functionName: 'price' });
const stipend = await pub.readContract({ address: CONTRACT, abi: ABI, functionName: 'gasStipend' });

console.log('gifting…');
const giftHash = await wallet.writeContract({
  address: CONTRACT, abi: ABI, functionName: 'gift', args: [claimAddr], value: price + stipend,
});
await pub.waitForTransactionReceipt({ hash: giftHash });
check('gift landed on Sepolia', true, giftHash);

// ---- recipient signs, exactly as the redeem page does it -----------------
const recipient = addressOf(await keyFromCode(newCode()));
const digest = await pub.readContract({ address: CONTRACT, abi: ABI, functionName: 'redeemDigest', args: [recipient] });
const sig = await signDigest(claimPriv, digest);

// ---- drive the ACTUAL Vercel function ------------------------------------
process.env.RELAYER_PK = testKey;
process.env.CONTRACT = CONTRACT;
process.env.RPC_URL = RPC_URL;
process.env.CHAIN_ID = String(CHAIN_ID);
const { default: handler } = await import('../api/redeem.mjs');

function invoke(payload){
  return new Promise(resolve => {
    const res = {
      statusCode: 200, _body: '',
      setHeader(){}, end(s){ this._body = s || ''; resolve({ status: this.statusCode, json: JSON.parse(this._body || '{}') }); },
    };
    handler({ method: 'POST', body: payload }, res);
  });
}

console.log('redeeming through the function…');
const out = await invoke({ claimAddr, to: recipient, sig });
check('function returned a token id', out.status === 200 && out.json.tokenId > 0, JSON.stringify(out.json).slice(0, 120));

if(!out.json.tokenId){ console.log('aborting — no token id returned'); process.exit(1); }
const id = out.json.tokenId;

// the mint just landed; a read can hit a node still a block behind, so give
// the verification reads a few tries to see it (same lag the function handles)
async function read(fn, args){
  for(let i = 0; i < 6; i++){
    try { return await pub.readContract({ address: CONTRACT, abi: ABI, functionName: fn, args }); }
    catch { await new Promise(r => setTimeout(r, 1500)); }
  }
  return pub.readContract({ address: CONTRACT, abi: ABI, functionName: fn, args });
}
const owner = await read('ownerOf', [BigInt(id)]);
check('token minted to the recipient', owner.toLowerCase() === recipient.toLowerCase());
const seed = await read('seedOf', [BigInt(id)]);
check('seed fixed on chain matches the function', seed === out.json.seed && !/^0x0+$/.test(seed));

// ---- a second call must be rejected as terminal, not retried -------------
const replay = await invoke({ claimAddr, to: recipient, sig });
check('replay rejected (terminal), not retried', replay.status === 400 && /unknown gift/i.test(replay.json.error || ''));

// ---- a garbage request is a clean 400 ------------------------------------
const bad = await invoke({ claimAddr: '0x123', to: recipient, sig });
check('malformed request rejected', bad.status === 400);

console.log(`\nminted Summer Glass #${id} to ${recipient.slice(0, 10)}… via the Vercel function`);
process.exit(fails ? 1 : 0);

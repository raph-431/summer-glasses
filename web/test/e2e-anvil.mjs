// Full local E2E of the gifting stack: spawns anvil, deploys the contract +
// artwork, starts the relayer, then runs the exact flow the pages run (same
// claim.js / rpc.js modules): code round-trip → gift → sign → relayer →
// mint → on-chain accounting asserts.
//
//   node web/test/e2e-anvil.mjs           run and tear down
//   KEEP=1 node web/test/e2e-anvil.mjs    leave anvil+relayer up (browser tests);
//                                         prints CODE2=… (an un-redeemed gift)
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
globalThis.keccak_256 = require('../vendor/sha3.js').keccak_256;
const { newClaimKey, addressOf, encodeCode, decodeCode, signDigest, bytesToHex }
  = await import('../lib/claim.js');
const { rpc, ethCall, selector, padAddress } = await import('../lib/rpc.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RPC = 'http://127.0.0.1:8545';
const RELAYER = 'http://127.0.0.1:8788';
const PK0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // anvil #0: deployer+gifter
const PK1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // anvil #1: relayer
const PRICE = 2000000000000000n, STIPEND = 50000000000000n;

const children = [];
const cleanup = () => children.forEach(c => { try { c.kill(); } catch {} });
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));

let fails = 0;
const check = (name, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if(!ok) fails++; };
const sleep = ms => new Promise(s => setTimeout(s, ms));
async function waitFor(fn, what, tries = 40){
  for(let i = 0; i < tries; i++){ try { return await fn(); } catch { await sleep(500); } }
  throw new Error('timeout waiting for ' + what);
}
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();

// ---- infrastructure up ----------------------------------------------------
children.push(spawn('anvil', ['--silent'], { stdio: 'ignore' }));
await waitFor(() => rpc(RPC, 'eth_chainId', []), 'anvil');

execFileSync('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', RPC,
  '--private-key', PK0, '--broadcast'], { cwd: path.join(root, 'contract'), stdio: 'pipe' });
const run = JSON.parse(fs.readFileSync(path.join(root, 'contract/broadcast/Deploy.s.sol/31337/run-latest.json')));
const CONTRACT = run.transactions.find(t => t.transactionType === 'CREATE').contractAddress;

const cfg = (await import('../config.js')).default;
check('deploy address matches web/config.js', CONTRACT.toLowerCase() === cfg.contract.toLowerCase());

children.push(spawn('node', [path.join(root, 'relayer/relayer.js')], {
  env: { ...process.env, CONTRACT, RELAYER_PK: PK1, RPC_URL: RPC },
  stdio: 'ignore',
}));
const status = await waitFor(async () => (await fetch(RELAYER + '/status')).json(), 'relayer');
check('relayer up against contract', status.contract === CONTRACT);

// ---- the flow, exactly as the pages do it ---------------------------------
const priv = newClaimKey();
const code = encodeCode(priv);
const decoded = decodeCode(code);
check('code round-trip', bytesToHex(decoded) === bytesToHex(priv));
const claimAddr = addressOf(priv);

// gift page: pay gift(claimAddr) — here via cast as the wallet stand-in
cast('send', CONTRACT, 'gift(address)', claimAddr, '--value', (PRICE + STIPEND).toString(),
     '--private-key', PK0, '--rpc-url', RPC);
const slot = await ethCall(RPC, CONTRACT, selector('gifts(address)') + padAddress(claimAddr));
check('gift escrowed', !/^0+$/.test(slot.slice(2 + 24, 2 + 64)));

// redeem page: fresh recipient wallet, sign, relayer
const recipientKey = newClaimKey();
const recipient = addressOf(recipientKey);
const digest = await ethCall(RPC, CONTRACT, selector('redeemDigest(address)') + padAddress(recipient));
const sig = await signDigest(priv, digest);
const res = await fetch(RELAYER + '/redeem', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ claimAddr, to: recipient, sig }),
});
const out = await res.json();
check('relayer accepted redeem', res.ok && out.tokenId === 1);

const owner = await ethCall(RPC, CONTRACT, selector('ownerOf(uint256)') + (1n).toString(16).padStart(64, '0'));
check('token minted to recipient', owner.slice(-40).toLowerCase() === recipient.slice(2).toLowerCase());
const seed = await ethCall(RPC, CONTRACT, selector('seedOf(uint256)') + (1n).toString(16).padStart(64, '0'));
check('seed fixed at redemption', out.seed === seed && !/^0x0+$/.test(seed));
const withdrawable = BigInt(await ethCall(RPC, CONTRACT, selector('withdrawable()')));
check('escrow released to proceeds', withdrawable === PRICE);
const bal = BigInt(await rpc(RPC, 'eth_getBalance', [CONTRACT, 'latest']));
check('stipend left the contract', bal === PRICE);

// a second redeem with the SAME code must be rejected by the relayer
const res2 = await fetch(RELAYER + '/redeem', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ claimAddr, to: recipient, sig }),
});
check('relayer rejects replay', res2.status === 400);

if(process.env.KEEP){
  // leave a fresh un-redeemed gift for browser testing, stay alive
  const priv2 = newClaimKey();
  cast('send', CONTRACT, 'gift(address)', addressOf(priv2), '--value', (PRICE + STIPEND).toString(),
       '--private-key', PK0, '--rpc-url', RPC);
  console.log('CODE2=' + encodeCode(priv2));
  console.log('READY (KEEP=1: anvil + relayer stay up; kill me to tear down)');
} else {
  process.exit(fails ? 1 : 0);
}

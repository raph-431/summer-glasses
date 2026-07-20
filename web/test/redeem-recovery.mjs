// The redeem page must never tell someone their gift failed when it didn't.
// This drives the page's own logic in a headless browser against a local
// anvil, forcing the three interesting failures:
//
//   1. relayer unreachable          -> honest "try again", gift still valid
//   2. already redeemed (2nd click) -> finds the token and reveals it
//   3. relayer errors after the mint landed -> same, reveals it
//
//   node web/test/redeem-recovery.mjs
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import http from 'http';

const require = createRequire(import.meta.url);
globalThis.keccak_256 = require('../vendor/sha3.js').keccak_256;
const { newClaimKey, addressOf, newCode, keyFromCode } = await import('../lib/claim.js');
const { rpc } = await import('../lib/rpc.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RPC = 'http://127.0.0.1:8545';
const PK0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PK1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const PRICE = 2000000000000000n, STIPEND = 50000000000000n;
const RELAY_PORT = 8797, WEB_PORT = 8796;
const SP = process.env.TMPDIR || '/tmp';

const children = [];
process.on('exit', () => children.forEach(c => { try { c.kill(); } catch {} }));
process.on('SIGINT', () => process.exit(1));

let fails = 0;
const check = (n, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if(!ok) fails++; };
const sleep = ms => new Promise(s => setTimeout(s, ms));
const cast = (...a) => execFileSync('cast', a, { encoding: 'utf8' }).trim();
async function waitFor(fn, what, tries = 40){
  for(let i = 0; i < tries; i++){ try { return await fn(); } catch { await sleep(500); } }
  throw new Error('timeout waiting for ' + what);
}

// ---- chain + a stub relayer we can break on demand ------------------------
children.push(spawn('anvil', ['--silent'], { stdio: 'ignore' }));
await waitFor(() => rpc(RPC, 'eth_chainId', []), 'anvil');
execFileSync('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', RPC,
  '--private-key', PK0, '--broadcast'], { cwd: path.join(root, 'contract'), stdio: 'pipe' });
const run = JSON.parse(fs.readFileSync(path.join(root, 'contract/broadcast/Deploy.s.sol/31337/run-latest.json')));
const CONTRACT = run.transactions.find(t => t.transactionType === 'CREATE').contractAddress;

// stub relayer: mode 'ok' really redeems; 'lie' redeems then reports failure;
// 'down' refuses connections
let mode = 'ok';
const relay = http.createServer((req, res) => {
  const H = { 'content-type': 'application/json', 'access-control-allow-origin': '*',
              'access-control-allow-headers': 'content-type' };
  if(req.method === 'OPTIONS'){ res.writeHead(204, H); return res.end(); }
  if(req.url === '/status'){ res.writeHead(200, H); return res.end(JSON.stringify({ contract: CONTRACT, chainId: 31337 })); }
  let body = ''; req.on('data', d => body += d);
  req.on('end', () => {
    const p = JSON.parse(body || '{}');
    try {
      const out = cast('send', CONTRACT, 'redeem(address,address,bytes)', p.claimAddr, p.to, p.sig,
                       '--private-key', PK1, '--rpc-url', RPC, '--json');
      const id = Number(BigInt(cast('call', CONTRACT, 'nextId()(uint256)', '--rpc-url', RPC).split(' ')[0])) - 1;
      if(mode === 'lie'){ res.writeHead(500, H); return res.end(JSON.stringify({ error: 'relayer exploded' })); }
      res.writeHead(200, H); res.end(JSON.stringify({ txHash: JSON.parse(out).transactionHash, tokenId: id }));
    } catch(e){
      const m = String(e.stderr || e.message);
      const r = m.match(/revert(?:ed)?[^']*'([^']*)'/) || m.match(/execution reverted: ([^\n"]*)/);
      res.writeHead(400, H); res.end(JSON.stringify({ error: r ? r[1] : m.slice(0, 120) }));
    }
  });
});
await new Promise(r => relay.listen(RELAY_PORT, r));

// serve the site with config pointed at this stack
const site = spawn('python3', ['-m', 'http.server', String(WEB_PORT), '--bind', '127.0.0.1'],
                   { cwd: root, stdio: 'ignore' });
children.push(site);
const cfgPath = path.join(root, 'web/config.test.js');
fs.writeFileSync(cfgPath, `export default {chainId:31337,chainName:'anvil',rpc:'${RPC}',` +
  `contract:'${CONTRACT}',relayer:'http://127.0.0.1:${RELAY_PORT}',explorerTx:null};\n`);
// the page is meant to be clicked; give the test copy a small driver that
// fills in an address and presses redeem once the code has validated
const pagePath = path.join(root, 'web/redeem.test.html');
const driver = `
<script>
addEventListener('load', () => {
  const $ = id => document.getElementById(id);
  const to = new URLSearchParams(location.search).get('to');
  let pressed = false;
  setInterval(() => {
    if(pressed || $('step-go').style.display !== 'block') return;
    pressed = true;
    $('toIn').value = to;
    $('go').click();
  }, 300);
});
<\/script>`;
fs.writeFileSync(pagePath, fs.readFileSync(path.join(root, 'web/redeem.html'), 'utf8')
  .replace("from './config.js'", "from './config.test.js'")
  .replace('</body>', driver + '</body>'));
process.on('exit', () => { try { fs.unlinkSync(cfgPath); fs.unlinkSync(pagePath); } catch {} });
await sleep(700);

// ---- drive the real page in a browser -------------------------------------
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function runPage(code, label, to){
  const profile = path.join(SP, 'rr-' + label + '-' + process.pid);
  fs.rmSync(profile, { recursive: true, force: true });
  const url = `http://127.0.0.1:${WEB_PORT}/web/redeem.test.html?to=${to}#k=${code}`;
  const probe = spawn(CHROME, ['--headless=new', '--disable-gpu-sandbox', '--virtual-time-budget=25000',
    '--user-data-dir=' + profile, '--dump-dom', url], { encoding: 'utf8' });
  let dom = '';
  probe.stdout.on('data', d => dom += d);
  const killer = setTimeout(() => probe.kill(), 45000);
  await new Promise(r => probe.on('close', r));
  clearTimeout(killer);
  fs.rmSync(profile, { recursive: true, force: true });
  return dom;
}

async function gift(){
  const code = newCode();
  const priv = await keyFromCode(code);
  cast('send', CONTRACT, 'gift(address)', addressOf(priv), '--value', (PRICE + STIPEND).toString(),
       '--private-key', PK0, '--rpc-url', RPC);
  return { priv, code, claimAddr: addressOf(priv) };
}

// 1) relayer down: the page should warn before the user even tries
mode = 'down';
await new Promise(r => relay.close(r));
const g1 = await gift();
const someone = addressOf(newClaimKey());
let dom = await runPage(encodeURIComponent(g1.code), 'down', someone);
check('warns up front when the relayer is unreachable',
      /not responding right now/i.test(dom) && /gift is safe/i.test(dom));
check('does not claim the gift failed', !/redeem failed/i.test(dom));

// bring it back for the remaining cases
await new Promise(r => relay.listen(RELAY_PORT, r));

// 2) already redeemed elsewhere: page should find the token, not error
const g2 = await gift();
const to = addressOf(newClaimKey());
const digest = cast('call', CONTRACT, 'redeemDigest(address)(bytes32)', to, '--rpc-url', RPC);
const sig = cast('wallet', 'sign', '--no-hash', '--private-key',
                 '0x' + Buffer.from(g2.priv).toString('hex'), digest);
cast('send', CONTRACT, 'redeem(address,address,bytes)', g2.claimAddr, to, sig,
     '--private-key', PK1, '--rpc-url', RPC);
dom = await runPage(encodeURIComponent(g2.code), 'already', someone);
// assert on structure, not on wording: the copy on these pages gets rewritten
// often, and a test that fails for a reworded sentence teaches you to ignore it
const revealShown = (d) => /id="reveal"[^>]*display:\s*block/.test(d);
check('recognises an already-redeemed code instead of failing',
      /already been redeemed/i.test(dom) || revealShown(dom));

// 3) mint lands but the relayer reports failure — the worst case
mode = 'lie';
const g3 = await gift();
dom = await runPage(encodeURIComponent(g3.code), 'lie', someone);
const revealed = revealShown(dom) || /<iframe[^>]*srcdoc/i.test(dom);
check('reveals the glass when the mint landed but the reply was lost', revealed);
check('never shows a bare failure after a successful mint',
      !/redeem failed/i.test(dom));

relay.close();
process.exit(fails ? 1 : 0);

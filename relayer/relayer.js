#!/usr/bin/env node
// ---------------------------------------------------------------------------
// REDEEM RELAYER — submits redeem() transactions on behalf of recipients so
// they never need ETH. Self-repaying: the contract forwards the gifter's
// prepaid gas stipend to msg.sender (this relayer) on every redeem.
//
// Plain Node, no npm dependencies — signing and broadcasting go through
// foundry's `cast` (the same signer the E2E tests validated). Convenience,
// not custody: anyone with a funded wallet can call redeem() directly.
//
// The signer is either a raw key (RELAYER_PK, fine for anvil) or — better
// anywhere real — an encrypted foundry keystore account:
//
//   CONTRACT=0x… RELAYER_PK=0x… RPC_URL=http://127.0.0.1:8545 node relayer/relayer.js
//   CONTRACT=0x… RELAYER_ACCOUNT=relayer-sepolia RELAYER_PASSWORD=… \
//     RPC_URL=https://sepolia.base.org node relayer/relayer.js
//
// A keystore account MUST come with its password: cast otherwise opens
// /dev/tty and prompts, which for a background service means every redeem
// hangs on a prompt nobody is watching.
//
//   POST /redeem  {claimAddr, to, sig}  ->  {txHash, tokenId, seed}
//   GET  /status                        ->  {contract, relayer, chainId}
// ---------------------------------------------------------------------------
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const RPC = process.env.RPC_URL || 'http://127.0.0.1:8545';
const CONTRACT = process.env.CONTRACT;
const PK = process.env.RELAYER_PK;
const ACCOUNT = process.env.RELAYER_ACCOUNT;
const PORT = +(process.env.PORT || 8788);
if(!CONTRACT || !(PK || ACCOUNT)){
  console.error('CONTRACT and one of RELAYER_PK / RELAYER_ACCOUNT are required');
  process.exit(1);
}

// how cast is told who signs: a raw key, or a keystore account unlocked
// from a password file. RELAYER_PASSWORD is written to a 0600 temp file
// rather than passed as an argument, which would expose it in `ps` output.
let SIGNER;
if(PK){
  SIGNER = ['--private-key', PK];
} else {
  let pwFile = process.env.RELAYER_PASSWORD_FILE;
  if(!pwFile){
    const pw = process.env.RELAYER_PASSWORD;
    if(!pw){
      console.error('RELAYER_ACCOUNT needs RELAYER_PASSWORD (or RELAYER_PASSWORD_FILE)');
      process.exit(1);
    }
    pwFile = path.join(os.tmpdir(), `relayer-pw-${process.pid}`);
    fs.writeFileSync(pwFile, pw, { mode: 0o600 });
    const rm = () => { try { fs.unlinkSync(pwFile); } catch {} };
    process.on('exit', rm);
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  }
  SIGNER = ['--account', ACCOUNT, '--password-file', pwFile];
}

const cast = (...args) => new Promise((resolve, reject) => {
  execFile('cast', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }, (err, stdout, stderr) =>
    err ? reject(new Error((stderr || stdout || err.message).trim())) : resolve(stdout.trim()));
});

const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);
const isSig = (s) => /^0x[0-9a-fA-F]{130}$/.test(s);

// one redeem at a time: a single-key relayer must not race its own nonce
let queue = Promise.resolve();
const enqueue = (job) => (queue = queue.then(job, job));

// small per-IP rate limit — this endpoint spends relayer gas upfront
const hits = new Map();
function limited(ip){
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 6;
}

let RELAYER_ADDR, CHAIN_ID, REDEEMED_TOPIC;

/// A contract revert is a real answer — the gift is gone, the signature is
/// wrong — and repeating it will not help. Anything else (a dropped
/// connection, a timeout, a rate limit, a node briefly behind its own tip)
/// is worth trying again: public RPC endpoints are load-balanced, and a read
/// can land on a node that has not yet seen the block carrying the gift.
function isTransient(msg){
  if(/revert/i.test(msg) && !/failed to estimate|rate limit/i.test(msg)) return false;
  return /timed out|timeout|socket|connection|network|ECONN|EAI_AGAIN|fetch|429|too many|5\d\d|server error|bad gateway|service unavailable|estimate/i.test(msg);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/// Does the chain still hold this gift? Used to tell a genuinely spent gift
/// apart from a stale read, since both say "unknown gift".
async function giftExists(claimAddr){
  try {
    const out = await cast('call', CONTRACT, 'gifts(address)(address,uint96,uint40,uint96)',
                           claimAddr, '--rpc-url', RPC);
    return !/^0x0{40}\b/.test(out.trim().split(/\s+/)[0]);
  } catch { return false; }
}

async function redeem(claimAddr, to, sig){
  let lastErr;
  for(let attempt = 1; attempt <= 3; attempt++){
    try {
      // simulate first — a reverting call costs nothing and gives a reason
      await cast('call', CONTRACT, 'redeem(address,address,bytes)(uint256)',
                 claimAddr, to, sig, '--from', RELAYER_ADDR, '--rpc-url', RPC);
      const out = await cast('send', CONTRACT, 'redeem(address,address,bytes)',
                             claimAddr, to, sig, ...SIGNER, '--rpc-url', RPC, '--json');
      const receipt = JSON.parse(out);
      if(parseInt(receipt.status) !== 1) throw new Error('transaction reverted');
      const log = (receipt.logs || []).find(l => l.topics && l.topics[0] === REDEEMED_TOPIC);
      if(attempt > 1) console.log(`  recovered on attempt ${attempt}`);
      return {
        txHash: receipt.transactionHash,
        tokenId: log ? parseInt(log.topics[2], 16) : null,
        seed: log ? log.data : null,
      };
    } catch(e){
      lastErr = e;
      const msg = String(e.message || e);
      // "unknown gift" from a node that simply has not caught up yet looks
      // exactly like a spent gift — ask again before believing it
      const staleRead = /unknown gift/i.test(msg) && await giftExists(claimAddr);
      if(!staleRead && !isTransient(msg)) throw e;
      if(attempt === 3) break;
      console.log(`  attempt ${attempt} failed (${staleRead ? 'stale read' : 'transient'}): ${msg.split('\n')[0].slice(0, 140)}`);
      await sleep(attempt * 1200);
    }
  }
  throw lastErr;
}

const server = http.createServer((req, res) => {
  const headers = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
  };
  if(req.method === 'OPTIONS'){ res.writeHead(204, headers); return res.end(); }

  if(req.method === 'GET' && req.url === '/status'){
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ contract: CONTRACT, relayer: RELAYER_ADDR, chainId: CHAIN_ID }));
  }

  if(req.method === 'POST' && req.url === '/redeem'){
    const ip = req.socket.remoteAddress;
    let body = '';
    req.on('data', d => { body += d; if(body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body); } catch { p = null; }
      if(!p || !isAddr(p.claimAddr) || !isAddr(p.to) || !isSig(p.sig)){
        res.writeHead(400, headers);
        return res.end(JSON.stringify({ error: 'expected {claimAddr, to, sig}' }));
      }
      if(limited(ip)){
        res.writeHead(429, headers);
        return res.end(JSON.stringify({ error: 'rate limited, try again in a minute' }));
      }
      console.log(`redeem ${p.claimAddr.slice(0, 10)}… -> ${p.to.slice(0, 10)}…`);
      enqueue(() => redeem(p.claimAddr, p.to, p.sig))
        .then(result => {
          console.log(`  minted #${result.tokenId} (${result.txHash})`);
          res.writeHead(200, headers); res.end(JSON.stringify(result));
        })
        .catch(err => {
          console.error('  FAILED:', String(err.message || err).split('\n')[0].slice(0, 200));
          const msg = String(err.message || err);
          const revert = msg.match(/reverted[^']*'([^']*)'|revert(?:ed)?:? ?(.*)/i);
          res.writeHead(400, headers);
          res.end(JSON.stringify({ error: (revert && (revert[1] || revert[2])) || msg.slice(0, 200) }));
        });
    });
    return;
  }

  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: 'not found' }));
});

(async () => {
  RELAYER_ADDR = await cast('wallet', 'address', ...SIGNER);
  CHAIN_ID = parseInt(await cast('chain-id', '--rpc-url', RPC));
  REDEEMED_TOPIC = await cast('keccak', 'Redeemed(address,uint256,address,bytes32)');
  server.listen(PORT, () =>
    console.log(`relayer ${RELAYER_ADDR} -> ${CONTRACT} (chain ${CHAIN_ID}) on :${PORT}`));
})();

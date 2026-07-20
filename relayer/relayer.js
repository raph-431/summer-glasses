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
//   CONTRACT=0x… RELAYER_PK=0x… RPC_URL=http://127.0.0.1:8545 PORT=8788 \
//   node relayer/relayer.js
//
//   POST /redeem  {claimAddr, to, sig}  ->  {txHash, tokenId, seed}
//   GET  /status                        ->  {contract, relayer, chainId}
// ---------------------------------------------------------------------------
'use strict';
const http = require('http');
const { execFile } = require('child_process');

const RPC = process.env.RPC_URL || 'http://127.0.0.1:8545';
const CONTRACT = process.env.CONTRACT;
const PK = process.env.RELAYER_PK;
const PORT = +(process.env.PORT || 8788);
if(!CONTRACT || !PK){ console.error('CONTRACT and RELAYER_PK are required'); process.exit(1); }

const cast = (...args) => new Promise((resolve, reject) => {
  execFile('cast', args, { encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) =>
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

async function redeem(claimAddr, to, sig){
  // simulate first — a reverting call costs the caller nothing and gives a reason
  await cast('call', CONTRACT, 'redeem(address,address,bytes)(uint256)',
             claimAddr, to, sig, '--from', RELAYER_ADDR, '--rpc-url', RPC);
  const out = await cast('send', CONTRACT, 'redeem(address,address,bytes)',
                         claimAddr, to, sig, '--private-key', PK, '--rpc-url', RPC, '--json');
  const receipt = JSON.parse(out);
  if(parseInt(receipt.status) !== 1) throw new Error('transaction reverted');
  const log = (receipt.logs || []).find(l => l.topics && l.topics[0] === REDEEMED_TOPIC);
  return {
    txHash: receipt.transactionHash,
    tokenId: log ? parseInt(log.topics[2], 16) : null,
    seed: log ? log.data : null,
  };
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
      enqueue(() => redeem(p.claimAddr, p.to, p.sig))
        .then(result => { res.writeHead(200, headers); res.end(JSON.stringify(result)); })
        .catch(err => {
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
  RELAYER_ADDR = await cast('wallet', 'address', '--private-key', PK);
  CHAIN_ID = parseInt(await cast('chain-id', '--rpc-url', RPC));
  REDEEMED_TOPIC = await cast('keccak', 'Redeemed(address,uint256,address,bytes32)');
  server.listen(PORT, () =>
    console.log(`relayer ${RELAYER_ADDR} -> ${CONTRACT} (chain ${CHAIN_ID}) on :${PORT}`));
})();

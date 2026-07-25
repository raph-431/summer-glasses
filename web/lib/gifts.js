// ---------------------------------------------------------------------------
// GIFT LEDGER — enumerate the gifts a wallet has paid for, straight from the
// chain, and tell each one's status. Used by checkgifts.html.
//
// Every gift emits Gifted(claimAddr indexed, payer indexed, paid); a redeem
// emits Redeemed(claimAddr indexed, tokenId indexed, to indexed, seed); a
// refund emits Reclaimed(claimAddr indexed, payer indexed, refunded). So for a
// given payer we can list their gifts and mark each waiting / redeemed /
// reclaimed without any server or saved codes.
//
// One paged scan of all three event types over the contract's history (public
// RPCs cap eth_getLogs ranges, so we page and shrink on error), filtered
// client-side by payer. Results are cached in localStorage so later loads only
// scan new blocks.
// ---------------------------------------------------------------------------
import { rpc } from './rpc.js';
import { keccak, bytesToHex } from './claim.js';

const topicOf = (sig) => bytesToHex(keccak(sig));            // 0x + 64 hex
export const GIFTED    = topicOf('Gifted(address,address,uint256)');
export const REDEEMED  = topicOf('Redeemed(address,uint256,address,bytes32)');
export const RECLAIMED = topicOf('Reclaimed(address,address,uint256)');

const addrFromTopic = (t) => '0x' + t.slice(-40).toLowerCase();

async function getLogsChunked(cfg, fromBlock, toBlock, topics, onProgress){
  const out = [];
  let span = 2000;                     // Base's public eth_getLogs range cap
  let from = fromBlock;
  while(from <= toBlock){
    const to = Math.min(from + span - 1, toBlock);
    try {
      const logs = await rpc(cfg.rpc, 'eth_getLogs', [{
        address: cfg.contract,
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
        topics,
      }]);
      out.push(...logs);
      from = to + 1;
      onProgress?.(from - fromBlock, toBlock - fromBlock + 1);
    } catch(e){
      // range too large / too many results — shrink this window and retry
      if(span > 250){ span = Math.floor(span / 2); continue; }
      throw e;
    }
  }
  return out;
}

const cacheKeyFor = (cfg, payer) => `checkgifts:${cfg.chainId}:${cfg.contract}:${payer}`;

/// Enumerate the gifts `payer` has paid for, newest first. Each entry:
///   { claimAddr, block, timestamp, paidWei, status, tokenId? }
/// status is 'waiting' | 'redeemed' | 'reclaimed'. Pass { fresh: true } to
/// ignore the cache and rescan from the deploy block. Read-only; no signing.
export async function scanGifts(cfg, payer, { onProgress, fresh } = {}){
  payer = payer.toLowerCase();
  const cacheKey = cacheKeyFor(cfg, payer);
  let cache = null;
  if(!fresh){ try { cache = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch {} }

  const start = cache && cache.lastBlock ? cache.lastBlock + 1 : (cfg.deployBlock || 0);
  const latest = Number(BigInt(await rpc(cfg.rpc, 'eth_blockNumber', [])));

  // claimAddr -> record, seeded from cache
  const gifts = new Map(Object.entries((cache && cache.gifts) || {}));

  if(start <= latest){
    const logs = await getLogsChunked(cfg, start, latest, [[GIFTED, REDEEMED, RECLAIMED]], onProgress);
    const redeemed = new Map();        // claimAddr -> tokenId (this window)
    const reclaimed = new Set();       // claimAddr (this window, by this payer)
    for(const lg of logs){
      const t0 = lg.topics[0];
      if(t0 === GIFTED){
        if(addrFromTopic(lg.topics[2]) !== payer) continue;   // topic2 = payer
        const claimAddr = addrFromTopic(lg.topics[1]);         // topic1 = claimAddr
        gifts.set(claimAddr, {
          claimAddr,
          block: Number(BigInt(lg.blockNumber)),
          paidWei: BigInt(lg.data).toString(),
          status: 'waiting',
          timestamp: (gifts.get(claimAddr) || {}).timestamp,
        });
      } else if(t0 === RECLAIMED){
        if(addrFromTopic(lg.topics[2]) !== payer) continue;
        reclaimed.add(addrFromTopic(lg.topics[1]));
      } else if(t0 === REDEEMED){
        // topic1 = claimAddr, topic2 = tokenId, topic3 = recipient
        redeemed.set(addrFromTopic(lg.topics[1]),
          { tokenId: BigInt(lg.topics[2]).toString(), to: addrFromTopic(lg.topics[3]) });
      }
    }
    // apply status transitions seen in this window to our gifts
    for(const g of gifts.values()){
      if(reclaimed.has(g.claimAddr)){ g.status = 'reclaimed'; delete g.tokenId; delete g.to; }
      else if(redeemed.has(g.claimAddr)){
        const r = redeemed.get(g.claimAddr);
        g.status = 'redeemed'; g.tokenId = r.tokenId; g.to = r.to;
      }
    }
  }

  // fill in block timestamps (cached on the record so this is one-time)
  for(const g of gifts.values()){
    if(g.timestamp) continue;
    try {
      const blk = await rpc(cfg.rpc, 'eth_getBlockByNumber', ['0x' + g.block.toString(16), false]);
      if(blk && blk.timestamp) g.timestamp = Number(BigInt(blk.timestamp));
    } catch {}
  }

  try { localStorage.setItem(cacheKey, JSON.stringify({ lastBlock: latest, gifts: Object.fromEntries(gifts) })); } catch {}

  return [...gifts.values()].sort((a, b) => b.block - a.block);   // newest first
}

export function clearGiftCache(cfg, payer){
  try { localStorage.removeItem(cacheKeyFor(cfg, payer.toLowerCase())); } catch {}
}

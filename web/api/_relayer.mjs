// ---------------------------------------------------------------------------
// The redeem relayer, as a viem module shared by the Vercel functions.
//
// Same job as relayer/relayer.js (which stays for anvil + the local test
// harnesses): submit redeem() so a recipient never needs ETH, reimbursed by
// the on-chain stipend. This version signs and broadcasts with viem instead
// of shelling out to `cast`, so it runs in a serverless runtime with no
// Foundry binary — one /api/redeem function on the same domain as the site,
// nothing to host or babysit.
//
// Env: RELAYER_PK, CONTRACT, RPC_URL, CHAIN_ID.
// ---------------------------------------------------------------------------
import { createPublicClient, createWalletClient, http, defineChain,
         BaseError, ContractFunctionRevertedError, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ABI = [
  { type: 'function', name: 'redeem', stateMutability: 'nonpayable',
    inputs: [{ name: 'claimAddr', type: 'address' }, { name: 'to', type: 'address' }, { name: 'sig', type: 'bytes' }],
    outputs: [{ name: 'tokenId', type: 'uint256' }] },
  { type: 'event', name: 'Redeemed', inputs: [
    { name: 'claimAddr', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'seed', type: 'bytes32', indexed: false } ] },
  { type: 'function', name: 'gifts', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: 'payer', type: 'address' }, { name: 'paid', type: 'uint96' },
              { name: 'createdAt', type: 'uint40' }, { name: 'stipend', type: 'uint96' }] },
];

let cached = null;
export function relayer(env = process.env){
  if(cached) return cached;
  const { RELAYER_PK, CONTRACT, RPC_URL, CHAIN_ID } = env;
  if(!RELAYER_PK || !CONTRACT || !RPC_URL || !CHAIN_ID)
    throw new Error('RELAYER_PK, CONTRACT, RPC_URL and CHAIN_ID are all required');

  const chainId = Number(CHAIN_ID);
  const chain = defineChain({
    id: chainId, name: 'base-' + chainId,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const account = privateKeyToAccount(RELAYER_PK.startsWith('0x') ? RELAYER_PK : '0x' + RELAYER_PK);
  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  cached = { account, contract: CONTRACT, chainId, publicClient, walletClient };
  return cached;
}

const isAddr = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
const isSig  = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{130}$/.test(s);
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));

/// Pull the contract revert reason out of a viem error, or null if this
/// wasn't a revert (i.e. it was a transient RPC/network failure worth a retry).
function revertReason(err){
  if(!(err instanceof BaseError)) return null;
  const r = err.walk(e => e instanceof ContractFunctionRevertedError);
  return r ? (r.reason ?? r.shortMessage ?? 'reverted') : null;
}

/// The whole redeem: simulate (free, gives a reason on failure), send, wait,
/// read back the token id.
///
/// Classifying the failure is the subtle part. Most contract reverts are a
/// final answer (bad signature, sold out) — retrying can't help, so they
/// throw immediately with `.terminal`. The exception is "unknown gift": a
/// public RPC pool is load-balanced, and a read can land on a node that
/// hasn't yet seen the block carrying the gift, so a fresh gift can momentarily
/// look spent. That one we retry through the backoff; only if it's STILL
/// unknown after every attempt do we conclude the gift is genuinely gone.
const MAX_ATTEMPTS = 5;
export async function doRedeem(r, claimAddr, to, sig){
  let lastErr;
  for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
    try {
      const { request } = await r.publicClient.simulateContract({
        address: r.contract, abi: ABI, functionName: 'redeem',
        args: [claimAddr, to, sig], account: r.account,
      });
      const hash = await r.walletClient.writeContract(request);
      const receipt = await r.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if(receipt.status !== 'success') throw new Error('transaction reverted');

      let tokenId = null, seed = null;
      for(const log of receipt.logs){
        if(log.address.toLowerCase() !== r.contract.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: ABI, ...log });
          if(ev.eventName === 'Redeemed'){ tokenId = Number(ev.args.tokenId); seed = ev.args.seed; }
        } catch {}
      }
      return { txHash: hash, tokenId, seed };
    } catch(err){
      lastErr = err;
      const reason = revertReason(err);
      const unknownGift = reason && /unknown gift/i.test(reason);

      // a real revert that isn't "unknown gift" can't be fixed by retrying
      if(reason && !unknownGift){ const e = new Error(reason); e.terminal = true; throw e; }

      if(attempt === MAX_ATTEMPTS){
        // out of retries: if it never stopped being "unknown gift", the gift
        // really is spent (terminal 400); otherwise it was infrastructure (502)
        if(unknownGift){ const e = new Error(reason); e.terminal = true; throw e; }
        throw lastErr;
      }
      await sleep(attempt * 1500);   // ~1.5s, 3s, 4.5s, 6s — covers several Base blocks
    }
  }
  throw lastErr;
}

/// One place for the CORS + JSON plumbing both functions share.
export function cors(res){
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
}
export function send(res, code, body){
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export const validate = { isAddr, isSig };

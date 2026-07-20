// POST /api/redeem  {claimAddr, to, sig}  ->  {txHash, tokenId, seed}
//
// Vercel serverless function. Submits a redeem on the recipient's behalf so
// they never need ETH; the gifter's prepaid stipend reimburses the gas. The
// shared viem logic lives in ../lib/relayer-core.mjs — kept OUT of api/ on
// purpose, since Vercel turns every file in api/ into its own function.
import { relayer, doRedeem, cors, send, validate } from '../lib/relayer-core.mjs';

export default async function handler(req, res){
  cors(res);
  if(req.method === 'OPTIONS'){ res.statusCode = 204; return res.end(); }
  if(req.method !== 'POST') return send(res, 405, { error: 'POST only' });

  // Vercel parses JSON bodies for us; fall back to reading the stream when
  // the harness or a raw runtime doesn't.
  let body = req.body;
  if(body === undefined){
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { body = JSON.parse(raw || '{}'); } catch { body = null; }
  } else if(typeof body === 'string'){
    try { body = JSON.parse(body); } catch { body = null; }
  }

  const p = body || {};
  if(!validate.isAddr(p.claimAddr) || !validate.isAddr(p.to) || !validate.isSig(p.sig))
    return send(res, 400, { error: 'expected {claimAddr, to, sig}' });

  let r;
  try { r = relayer(); }
  catch(e){ return send(res, 500, { error: 'relayer not configured: ' + e.message }); }

  try {
    const result = await doRedeem(r, p.claimAddr, p.to, p.sig);
    return send(res, 200, result);
  } catch(e){
    // a contract revert is the recipient's problem to hear about (bad code,
    // already redeemed); anything else is our infrastructure failing
    return send(res, e.terminal ? 400 : 502, { error: String(e.message || e).slice(0, 200) });
  }
}

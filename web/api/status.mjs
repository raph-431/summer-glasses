// GET /api/status -> {contract, relayer, chainId}
// A health check the redeem page hits before someone fills in an address, so
// a misconfigured or down relayer is visible up front.
import { relayer, cors, send } from './_relayer.mjs';

export default function handler(req, res){
  cors(res);
  if(req.method === 'OPTIONS'){ res.statusCode = 204; return res.end(); }
  try {
    const r = relayer();
    return send(res, 200, { contract: r.contract, relayer: r.account.address, chainId: r.chainId });
  } catch(e){
    return send(res, 500, { error: String(e.message || e) });
  }
}

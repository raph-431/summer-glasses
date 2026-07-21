# Launch runbook — Summer Glasses

The full path from this repo to a live series on Base. Everything below
assumes the local stack already passes:

```sh
node build.js                       # fresh dist/ from current art
cd contract && forge test && cd ..  # 32 tests
node web/test/claim-parity.mjs      # browser crypto == cast
node web/test/e2e-anvil.mjs         # full gift→redeem stack on anvil
node web/test/redeem-recovery.mjs   # redeem never reports a false failure
```

## 0 · Decisions to make (once, at launch)

| decision | chosen | where | notes |
|---|---|---|---|
| price | **0.002 ETH** (`2000000000000000`) | constructor / `setPrice` | "the price of a drink"; changeable any time (affects future gifts) |
| gas stipend | **0.00005 ETH** (`50000000000000`) | constructor / `setGasStipend` | snapshot per gift; see sizing below |
| max supply | **deploy a ceiling, do NOT `lockSupply()` yet** | constructor / `setMaxSupply` + `lockSupply()` | staying unlocked keeps the edition size adjustable until demand is known; lock later to make it credible + irreversible |
| royalty | **none** (leave default 0) | `setRoyalty(receiver, bps)` | ERC-2981, default off; can be set any time later |
| reclaim window | 7 days | — | fixed constant (`RECLAIM_AFTER`); a lost/unredeemed gift is reclaimable by its gifter after a week |
| gifts per payer | **set a cap** (e.g. a few % of supply) | `MAX_GIFTS_PER_PAYER` env / `setMaxGiftsPerPayer` | 0 = unlimited; bounds outstanding gifts per address so one payer can't reserve the whole edition and reclaim later. Sybil across addresses still bypasses it — this stops casual squatting, not a funded attacker |

**Stipend sizing:** redeem ≈ 220k gas. On Base (~0.01 gwei typical) that is
~0.000002 ETH execution + L1 data fee. The default 0.00005 ETH covers a
20×+ margin; raise it if Base gas spikes become common. The relayer earns
the stipend per redeem — it needs a small ETH float only to smooth timing.

## 1 · Base Sepolia rehearsal

Use a throwaway funded key (faucet: https://portal.cdp.coinbase.com/products/faucet).

```sh
node build.js
cd contract
PRICE=2000000000000000 STIPEND=50000000000000 MAX_SUPPLY=256 MAX_GIFTS_PER_PAYER=8 \
forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org \
  --private-key $DEPLOYER_PK --broadcast
# optional source verification (needs BASESCAN_API_KEY):
#   add  --verify --etherscan-api-key $BASESCAN_API_KEY  to the command
```

Then wire the pieces:

1. `web/config.js`: fill `baseSepolia.contract`, switch `export default baseSepolia`.
2. **Relayer — deploy `web/` to Vercel** (the recommended path). The pages and
   the redeem function ship together; there is no separate server to run or
   babysit. `web/config.js` already points `relayer: '/api'` (same domain).
   ```sh
   cd web
   vercel                       # first deploy (or connect the git repo in the dashboard)
   # set the function's secrets (Project → Settings → Environment Variables):
   #   RELAYER_PK   0x…   the relayer wallet's private key (holds only a gas float)
   #   CONTRACT     0x…   the deployed contract
   #   RPC_URL      https://sepolia.base.org   (or mainnet)
   #   CHAIN_ID     84532                       (8453 for mainnet)
   vercel --prod
   ```
   The function is `web/api/redeem.mjs` (viem, no Foundry). `RELAYER_PK` is
   stored encrypted by Vercel; the wallet only ever holds the gas float it
   earns back via the stipend. Verify with `curl https://yourdomain/api/status`.
   - *Local preview:* `cd web && vercel dev` runs the pages **and** the function
     together (`serve.js` alone serves only static files, so `/api` would 404).
   - *Alternative (self-hosted):* the older `relayer/relayer.js` still works on a
     box with Foundry — needs `RELAYER_ACCOUNT` + `RELAYER_PASSWORD` (or
     `RELAYER_PASSWORD_FILE`); without a password `cast` blocks on a `/dev/tty`
     prompt and redeems hang. Put it behind HTTPS and set `relayer` to that URL.
3. If not using Vercel for the site, serve `web/` from any static host — but then
   the relayer needs its own home (the self-hosted path above).

**Rehearse the real thing:** gift from a wallet on `gift.html` → open the
redeem link in a private window → fresh-wallet redeem → the reveal should
render the glass live from chain data. Then check the token on testnet
OpenSea (`testnets.opensea.io`) — expect `animation_url` to render; there is
no static `image` in v1, that's a known trade-off.

**Do not `freezeArt()` on Sepolia** — it's a rehearsal, and you may want to
re-upload. Verify `cast call $CONTRACT "tokenURI(uint256)" 1` output renders
(decode: strip `data:application/json;base64,`, base64 -d, take
`animation_url`, base64 -d, open in browser).

## 2 · Mainnet

Same as Sepolia with the real parameters, then the irreversibles — in this
order, only after eyeballing a real minted render:

```sh
cast send $CONTRACT "setRoyalty(address,uint96)" $RECEIVER 500 …   # if wanted
cast send $CONTRACT "lockSupply()" …
cast send $CONTRACT "freezeArt()" …                                # art is now permanent
```

- Owner key = admin (withdraw, price). Use a hardware wallet; the deployer
  can `transferOwnership` to one after setup.
- Relayer key holds only a gas float + earned stipends; sweep it
  periodically. Compromise = lost float, never user funds.
- `withdraw()` pays out proceeds of redeemed gifts only; escrowed
  (unredeemed) gifts can never be withdrawn — no rug surface.

## 3 · After launch

- Point `web/config.js` default at `base`, publish the pages.
- Watch relayer logs; `/status` is a health endpoint.
- Preview images (marketplace `image` field): add any time, even after the
  art freeze — deploy a renderer service and
  `cast send $CONTRACT "setImageBase(string)" "https://render…/glass/"`;
  tokenURI then emits `image: <base><tokenId>`. The pointer is deliberately
  mutable (it's a thumbnail convenience, not the artwork); leaving it unset
  keeps tokens animation_url-only.
- If a gifted code is reported lost: nothing to do — the gifter reclaims
  after the week, on their own.

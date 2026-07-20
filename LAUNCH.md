# Launch runbook — Summer Glasses

The full path from this repo to a live series on Base. Everything below
assumes the local stack already passes:

```sh
node build.js                       # fresh dist/ from current art
cd contract && forge test && cd ..  # 31 tests
node web/test/claim-parity.mjs      # browser crypto == cast
node web/test/e2e-anvil.mjs         # full gift→redeem stack on anvil
```

## 0 · Decisions to make (once, at launch)

| decision | where | notes |
|---|---|---|
| price | constructor / `setPrice` | changeable any time (affects future gifts) |
| gas stipend | constructor / `setGasStipend` | snapshot per gift; see sizing below |
| max supply | constructor / `setMaxSupply` + `lockSupply()` | lock makes it credible + irreversible |
| royalty | `setRoyalty(receiver, bps)` | ERC-2981, default off; changeable any time |
| reclaim window | — | fixed constant: 365 days |

**Stipend sizing:** redeem ≈ 220k gas. On Base (~0.01 gwei typical) that is
~0.000002 ETH execution + L1 data fee. The default 0.00005 ETH covers a
20×+ margin; raise it if Base gas spikes become common. The relayer earns
the stipend per redeem — it needs a small ETH float only to smooth timing.

## 1 · Base Sepolia rehearsal

Use a throwaway funded key (faucet: https://portal.cdp.coinbase.com/products/faucet).

```sh
node build.js
cd contract
PRICE=2000000000000000 STIPEND=50000000000000 MAX_SUPPLY=256 \
forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org \
  --private-key $DEPLOYER_PK --broadcast
# optional source verification (needs BASESCAN_API_KEY):
#   add  --verify --etherscan-api-key $BASESCAN_API_KEY  to the command
```

Then wire the pieces:

1. `web/config.js`: fill `baseSepolia.contract`, switch `export default baseSepolia`.
2. Relayer (any machine with foundry installed — a $5 VPS is plenty):
   ```sh
   CONTRACT=0x… RELAYER_PK=0x… RPC_URL=https://sepolia.base.org PORT=8788 \
   node relayer/relayer.js
   ```
   Put it behind HTTPS (caddy/nginx) and set `baseSepolia.relayer` to that URL.
3. Serve `web/` from any static host (the pages are plain files).

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
  after the year, on their own.

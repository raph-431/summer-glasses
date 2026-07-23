# Launch runbook — Summer Glasses

## STATUS as of 2026-07-23 — LIVE ON BASE MAINNET (v2, with gift receipt)

| | |
|---|---|
| contract (v2) | `0xb5F7C80B98aCFb553b3e01E9fEe0FCa4950CBD6e` (Base, chainId 8453) |
| gift receipt | `0xf3D49De68fCb26be78eFd36DD828cd0206F0400f` (keepsake minted to gifter) |
| owner / deployer | `0xa4Cf6e6bc4264711f107d6fEb60f256Ae0a7055C` (keystore `deployer-base`) |
| relayer | `0xdA5BDb3Cfd7406dFd873D2E983901C0ADDCe9222` (keystore `relayer-base`) |
| site | https://summerdrinks.fun (`/api/status` = health check) |
| params | price 0.002 ETH · stipend 0.00005 ETH · maxSupply 1000 |
| minted | none yet on v2 (`nextId` = 1) |
| wiring | `receipt()`↔`minter()` confirmed on-chain; both owned by deployer |
| v1 (abandoned) | `0x87e957299624dE48285ff420989749760b58a4A8` — 0 outstanding gifts, only test token #1; 0.002 ETH proceeds still withdrawable there |
| Sepolia rehearsal | `0x179a7697554a759acbe5d1913346b6687eC7e504` (v1 art, byte-identical) |

v2 mints the gifter a `GiftReceipt` keepsake inside `gift()`, so wallet
simulators show an asset received and `gift()` no longer reads as a one-way
drain (the reason MetaMask/Blockaid flagged v1). `gift(address)` is unchanged.

**Post-deploy checklist (v2):**
- [x] deploy both contracts + wire (`setMinter`/`setReceipt`) + upload art
- [x] `web/config.js` → v2 `contract` + `receipt`
- [x] Vercel env `CONTRACT` → `0xb5F7…BD6e`; redeployed; `/api/status` confirms v2
- [x] both contracts verified on Basescan (deploy-time `--verify`)
- [ ] live gift→redeem on mainnet; confirm the receipt lands + no MetaMask flag
- [ ] file the Blockaid false-positive report (§2b) if still flagged

**Still open, deliberately:**
- `freezeArt()` — NOT called. Art stays updatable via `UpdateArt.s.sol`.
- `lockSupply()` — NOT called. maxSupply 1000 remains adjustable.
- `transferOwnership` — owner is still the local `deployer-base` keystore;
  move to a hardware wallet before this matters.
- `setRoyalty` — unset (no royalty), by choice.
- `setImageBase` — unset, so marketplace cards have no static image.


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
| reclaim window | 365 days | — | fixed constant |

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

`Deploy.s.sol` now deploys **two** contracts and wires them in one broadcast:
`GiftReceipt` (the gifter's on-chain keepsake) then `SummerGlasses`, followed by
the one-time `receipt.setMinter(glasses)` + `glasses.setReceipt(receipt)` bindings.
The script logs both addresses — record the `GiftReceipt` address too (verify it on
Basescan separately). This receipt is what makes the wallet simulator show the
gifter an asset received, so `gift()` no longer trips MetaMask's "suspicious"
drainer heuristic. Nothing else in the flow changes; `gift(address)` is called
exactly as before.

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

## 2b · Verify source, then clear the MetaMask flag

Two separate things: **verifying** the source on Basescan (public, mechanical)
and **reporting** the false positive to Blockaid (what actually removes the
warning). Do both, verify first.

### Verify both contracts on Basescan

The deploy can self-verify: add `--verify --etherscan-api-key $BASESCAN_API_KEY`
to the `forge script` command and it verifies every contract it created,
constructor args and all. If that step is skipped or fails, verify each by hand
(`--chain base`, or `baseSepolia` for the rehearsal):

```sh
cd contract
# GiftReceipt — no constructor args
forge verify-contract $RECEIPT src/GiftReceipt.sol:GiftReceipt \
  --chain base --etherscan-api-key $BASESCAN_API_KEY --watch

# SummerGlasses — constructor(price, stipend, maxSupply); args must match deploy
forge verify-contract $CONTRACT src/SummerGlasses.sol:SummerGlasses \
  --chain base --etherscan-api-key $BASESCAN_API_KEY --watch \
  --constructor-args $(cast abi-encode \
    "constructor(uint256,uint96,uint256)" 2000000000000000 50000000000000 1000)
# if --chain base isn't recognised, add:
#   --verifier etherscan --verifier-url https://api.basescan.org/api
```

Confirm both read "Contract Source Code Verified" on basescan.org. Verified
source is a prerequisite for the Blockaid review below and a standing reputation
signal.

### Report the false positive to Blockaid

Minting the receipt makes the simulation honest (an asset comes back), but a
brand-new contract can still be flagged until Blockaid's reputation catches up.
Two routes, use both:

1. **Blockaid report portal — https://report.blockaid.io/** — submit the
   contract address + chain (Base, 8453) and explain it's a legitimate gift
   contract: `gift()` escrows a prepaid NFT gift and mints the payer an on-chain
   receipt token (so the simulation shows an asset received), source verified on
   Basescan. This is the channel that gets a wrongly-flagged contract cleared.
2. **In-wallet report** — when MetaMask shows the warning on a real `gift()`,
   expand it with **See details → Report an issue**; that submits the exact
   transaction to MetaMask/Blockaid as a disputed detection.

The warning can persist briefly after Blockaid clears it on their side (client
caches), and reputation also builds on its own with clean usage over time. Keep
`gift.html`'s receipt note (it sets the gifter's expectation that a second token
lands in their wallet).

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

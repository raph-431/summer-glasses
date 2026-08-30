# Blockaid false-positive review — follow-up (2026-08-30)

Second submission for the flagged `gift()` contract, five weeks after the
first report (2026-07-23, see `blockaid-response.md` and `LAUNCH.md`). File
it at https://report.blockaid.io/ — or as a reply on the July thread if that
ticket is still open, referencing it. Fill in `[your name]` and, if you have
one handy, a recent `gift()` transaction hash where the warning appeared.

---

**Subject: Follow-up — false positive on Summer Glasses `gift()` (Base), now with five weeks of on-chain history**

Hello,

I'm following up on a false-positive report first filed on 2026-07-23 for our contract on Base. MetaMask still shows a "you may lose assets" warning on the contract's `gift()` call. The contract has now been in normal use for over a month, and I'd like to ask for both addresses to be reviewed and cleared.

**Project.** Summer Glasses ("Summer in a Glass") — an on-chain generative art series on Base: each token is a WebGL artwork of a cold drink on a sunlit table, stored fully on-chain. Tokens are sold as **gifts**: a buyer prepays a glass for someone, and the recipient redeems it later with a code.

- Website: https://summerdrinks.fun
- Source (contracts, tests, deploy scripts, front-end): https://github.com/raph-431/summer-glasses
- OpenSea: https://opensea.io/collection/summer-glasses-92193256

**Contracts (Base mainnet, chainId 8453), both with verified source on Basescan — please review both together:**
- Flagged: `0xb5F7C80B98aCFb553b3e01E9fEe0FCa4950CBD6e` — Summer Glasses (ERC-721)
  https://basescan.org/address/0xb5F7C80B98aCFb553b3e01E9fEe0FCa4950CBD6e#code
- Companion: `0xf3D49De68fCb26be78eFd36DD828cd0206F0400f` — Gift Receipt (ERC-721)
  https://basescan.org/address/0xf3D49De68fCb26be78eFd36DD828cd0206F0400f#code

`gift()` on the main contract makes an internal call to the Gift Receipt contract to mint the caller's receipt, so a simulation of the flagged transaction necessarily involves both.

**What the flagged function does — `gift(address claimAddr)`, payable.** The caller pays 0.002 ETH (plus a small prepaid gas stipend for the eventual redeemer). The payment is **escrowed** on the contract against an ephemeral claim key. In the **same transaction** the caller is minted a **Gift Receipt NFT** — so the simulation shows the caller receiving an asset, not paying into a void. When the recipient redeems (a separate transaction, submitted by our relayer with the claim key's signature), the artwork NFT is minted to them.

**Why it is not a drainer — with the live numbers as of 2026-08-30:**
- **27 gifts purchased, 17 redeemed, 9 still escrowed awaiting their recipient.** The escrow of those 9 (0.018 ETH) is untouchable by the contract owner: there is no function that can move it. Only the redeemer (via `redeem`) or, after 365 days, the original payer (via `reclaim`) can release it.
- **`withdrawable()` is exactly 0.034 ETH = 17 × 0.002 ETH** — the proceeds of the 17 redeemed gifts and nothing else. This is verifiable on-chain and is the property that distinguishes the contract from a drainer: the owner's only outlet, `withdraw()`, releases precisely what has been delivered.
- Every `gift()` caller received their receipt NFT in the same transaction (27 receipts minted, one per gift), and every redeemed glass went to the address the code was redeemed for. No user has lost funds and no funds have moved anywhere unexpected in five weeks of operation.
- The contract is ERC-721 with a fixed 1,000 maximum supply, `Ownable` admin limited to price, royalty, art-freeze, thumbnail pointer and `withdraw()`; there are no approvals requested from users, no `transferFrom` of user assets, and no upgradeability.
- Both contracts are fully open-source and verified; the front-end that calls them is in the same public repository.

**What we changed after the first report.** The original deployment (`0x87e957299624dE48285ff420989749760b58a4A8`, now unused) had a `gift()` that returned nothing to the caller, which we understood to be what tripped the "pay and receive nothing" heuristic. We redeployed on 2026-07-23 specifically to add the receipt NFT so that the simulation is honest. The warning has nonetheless persisted, which we assume is reputation lag on the fresh addresses — hence this follow-up now that there is history.

Happy to provide anything else: a walkthrough of a sample `gift()` transaction to simulate [optionally: e.g. tx `0x…`], a contact verification, or additional source. Thank you for taking a look.

Best regards,
[your name] — Summer Glasses

# Blockaid false-positive review — documentation reply

Draft reply to Blockaid's request for documentation on the flagged `gift()`
contract. Filed 2026-07-23 (see `LAUNCH.md`). Fill in `[your name]` before
sending; tailor if they ask for a specific artifact (e.g. a sample `gift()` tx
hash to simulate).

---

**Subject: Documentation for false-positive review — Summer Glasses (Base)**

Hello,

Thank you for looking into this. Below is documentation for the flagged contract.

**Project.** Summer Glasses ("Summer in a Glass") is an on-chain generative art project on Base: each token is a WebGL artwork of a cold drink on a sunlit table, stored fully on-chain. Tokens are distributed as **gift codes** — you buy a drink for someone, and they redeem it. Website: https://summerdrinks.fun

**Contracts (Base mainnet, chainId 8453), both with verified source on Basescan:**
- Main (flagged): `0xb5F7C80B98aCFb553b3e01E9fEe0FCa4950CBD6e` — Summer Glasses (ERC-721)
  https://basescan.org/address/0xb5F7C80B98aCFb553b3e01E9fEe0FCa4950CBD6e#code
- Companion: `0xf3D49De68fCb26be78eFd36DD828cd0206F0400f` — Gift Receipt (ERC-721)
  https://basescan.org/address/0xf3D49De68fCb26be78eFd36DD828cd0206F0400f#code

**Full open-source repository** (contract source, tests, deploy scripts, and the front-end): https://github.com/raph-431/summer-glasses — the on-chain artwork and both contracts are built from here.

**These are two contracts that work together, and we'd ask that both be reviewed/cleared.** The main contract's `gift()` makes an internal call to the companion Gift Receipt contract to mint the caller's receipt, so a review of the flagged transaction necessarily involves both addresses.

**Both were newly deployed on 2026-07-23, replacing our previous contract, which is now unused.** The earlier version (`0x87e957299624dE48285ff420989749760b58a4A8`, also on Base) is no longer used by our site and can be considered abandoned. We redeployed **specifically to address the wallet-simulation concern**: the previous version's `gift()` did not return an asset to the caller, so this version adds the Gift Receipt NFT (see below) so that the caller now visibly receives an asset. Because both are fresh deployments with essentially no on-chain history yet, we believe that is why the reputation heuristic flagged the interaction.

**The flagged function — `gift(address claimAddr)`.** The caller prepays a gift (0.002 ETH plus a small prepaid gas stipend for the recipient). The payment is **escrowed** against an ephemeral "claim key." In the **same transaction**, the caller is minted a **Gift Receipt NFT** (from the companion contract above) — so the transaction simulation correctly shows the caller **receiving an asset**, not paying into a void. The recipient later redeems the gift with a signature from the claim key, at which point the artwork NFT is minted to them.

**Why it is safe / not a drainer:**
- The caller receives an on-chain asset (the Gift Receipt NFT) in the same transaction — visible in simulation.
- Escrowed funds cannot be taken by the contract owner. `withdraw()` releases only the proceeds of gifts that have actually been redeemed; unredeemed escrow is untouchable by anyone except the redeemer or, after 365 days, the original payer via `reclaim()`. There is no mechanism to sweep user funds.
- Both contracts are open-source and verified on Basescan (links above).

Please let me know if you need anything further — additional source, a walkthrough of a sample transaction, or contact verification. Happy to provide it.

Best regards,
[your name] — Summer Glasses

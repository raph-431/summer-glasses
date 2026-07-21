# Security

Summer Glasses is a fully on-chain generative art series on Base. This document
describes the security model, the trust boundaries, and how to report a problem.

## Reporting a vulnerability

Please use **GitHub's private vulnerability reporting** on this repository
(Security → Report a vulnerability). That keeps the report private until a fix
is out. Please do not open a public issue for anything exploitable.

If the issue involves funds at risk, say so in the title — those are triaged
first.

## Deployment

| | |
|---|---|
| Contract | `0x87e957299624dE48285ff420989749760b58a4A8` |
| Chain | Base mainnet (8453) |
| Source | Verified on Basescan (exact match) |
| Site | https://summerdrinks.fun |
| Relayer | `0xdA5BDb3Cfd7406dFd873D2E983901C0ADDCe9222` |

The contract is a plain, non-proxy deployment using standard OpenZeppelin
`ERC721` and `Ownable`. **The logic is immutable — there is no upgrade path.**

## How the gift/redeem mechanism works

The piece is sold as a gift rather than a direct mint. Neither party knows which
glass it is until it is opened.

1. **The buyer pays.** Their browser generates a single-use claim keypair
   locally and renders it as a human-readable gift code (five BIP-39 words plus
   a five-digit number). `gift(claimAddr)` stores only the claim key's
   **address** alongside the escrowed payment. The secret is never transmitted
   to or stored on any server.
2. **The buyer passes the code to the recipient.** The code *is* the secret; the
   private key is derived from it with PBKDF2, so nothing in between needs to be
   trusted.
3. **The recipient redeems.** Their browser re-derives the key and signs
   `redeemDigest(to)`, binding their own address. Because the signature (not
   `msg.sender`) authorizes the mint, a relayer can submit the transaction — the
   recipient needs no ETH and no pre-existing wallet.
4. **The artwork is dealt at redemption.** The seed is fixed as
   `keccak256(tokenId, block.prevrandao, to)` inside `redeem()`, so the specific
   glass is determined at that moment and is unknown to everyone beforehand.

This is why funds sit in escrow against an ephemeral address, and why redeems
arrive from a relayer rather than the recipient's own wallet.

## Security properties

Each of these is verifiable in a few lines of the published source.

1. **The dApp never requests token approvals.** `gift(address)` is a plain
   `payable` call. Users sign a value transfer, never an allowance. There is no
   `approve`, `permit`, `setApprovalForAll`, or `transferFrom` flow anywhere in
   the site.

2. **Prepaid funds cannot be taken by the owner.** `withdrawable` is incremented
   in exactly one place — inside `redeem()`, and only by `paid - stipend` for a
   gift that has actually been redeemed. `withdraw()` transfers only
   `withdrawable`. Escrow for unredeemed gifts is unreachable by the owner, by
   construction. There is no rug-pull surface.

3. **Unredeemed funds return only to the original buyer.** `reclaim()` requires
   `gift.payer == msg.sender` and refunds the full amount to that payer after a
   fixed 365-day window. The owner cannot call it on anyone's behalf.

4. **Redemption is signature-bound and not front-runnable.** The claim key signs
   `keccak256(chainid, contract, to)`. The recipient is inside the signed
   digest, so a mempool observer cannot redirect the mint to themselves. This is
   what makes open relaying safe.

5. **The relayer custodies nothing.** It holds only a gas float and is
   structurally unable to alter a redeem — the recipient is fixed inside the
   signature it relays. Compromise of the relayer key costs its float and
   nothing else. It is repaid per redeem by the on-chain stipend.

6. **No external dependencies at render time.** The artwork is stored on-chain
   via SSTORE2 and reassembled by `tokenURI`. No IPFS, no asset host, no oracle,
   and no external call anywhere in the contract.

## Gift code entropy

The gift code is the private key, so its strength is the security of an unclaimed
gift. A gift's claim address is public on-chain from the moment it is paid for,
which makes guessing an offline attack with nothing to rate-limit it. The format
is therefore sized deliberately:

- 5 words from the BIP-39 list of 2048 → ~55 bits
- 5 digits → ~16.6 bits
- **~71.6 bits total**, multiplied by ~2^18 work per guess (PBKDF2, 250k rounds)

**Do not shorten the code format without redoing this arithmetic.**

## Owner capabilities (full disclosure)

The owner can: `setPrice`, `setGasStipend`, `setMaxSupply`, `lockSupply`,
`setRoyalty`, `setImageBase`, `freezeArt`, `withdraw` (proceeds from redeemed
gifts only), and manage art chunks (`setArtWrapper`, `addArtChunk`,
`clearArtChunks`) until `freezeArt()` is called, after which the artwork is
permanent.

The owner **cannot** mint to themselves, transfer anyone's token, take escrowed
funds, or change the logic.

## Testing

The contract has 32 Foundry tests in `contract/test/`, including adversarial
cases: replay of a used gift, an attacker attempting to redirect a redeem to
their own address, redeeming with the wrong key, reclaim before expiry, and
supply accounting with outstanding gifts.

```sh
cd contract && forge test
```

The browser-side cryptography is proven byte-identical to Foundry's `cast` by
`web/test/claim-parity.mjs`, and the full gift→redeem stack runs against a local
anvil in `web/test/e2e-anvil.mjs`.

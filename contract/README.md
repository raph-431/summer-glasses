# Summer Glasses — contract

`SummerGlasses.sol`: ERC-721 on Base with gift-code lazy minting. A gifter
prepays `gift(claimAddr)` against an ephemeral claim key; the recipient (or a
relayer on their behalf — msg.sender earns the prepaid gas stipend) redeems
with the claim key's signature over `redeemDigest(to)`, which mints and fixes
the token's seed. Unredeemed gifts are reclaimable by the gifter after a
year. The artwork itself is stored on-chain (SSTORE2 chunks + bootstrap
wrapper); `tokenURI` reassembles it with the token's seed.

## Setup

```sh
forge install          # restores lib/ at the versions pinned in foundry.lock
forge test
```

## Deploy

Build the artwork first (`node ../build.js`), then:

```sh
PRICE=2000000000000000 STIPEND=50000000000000 MAX_SUPPLY=256 \
forge script script/Deploy.s.sol --rpc-url <rpc> --private-key <pk> --broadcast
```

Art stays mutable until `freezeArt()` — eyeball a real `tokenURI` render
first, then freeze at launch.

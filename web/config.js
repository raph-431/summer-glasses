// Deployment coordinates for the gift/redeem pages. Swap the export when
// moving networks; fill in contract/relayer after each deploy (LAUNCH.md).

// local anvil dev chain (first Deploy.s.sol run from anvil's account 0
// always lands the contract at this address)
export const anvil = {
  chainId: 31337,
  chainName: 'anvil (local)',
  rpc: 'http://127.0.0.1:8545',
  contract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  relayer: 'http://127.0.0.1:8788',
  explorerTx: null, // tx-hash URL prefix; null hides explorer links
  currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
};

export const baseSepolia = {
  chainId: 84532,
  chainName: 'Base Sepolia',
  rpc: 'https://sepolia.base.org',
  explorer: 'https://sepolia.basescan.org',
  currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  contract: '0x179a7697554a759acbe5d1913346b6687eC7e504',
  relayer: '/api',   // Vercel serverless function on the same domain (web/api/redeem.mjs)
  explorerTx: 'https://sepolia.basescan.org/tx/',
};

export const base = {
  chainId: 8453,
  chainName: 'Base',
  rpc: 'https://mainnet.base.org',
  explorer: 'https://basescan.org',
  currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  // v2 (with GiftReceipt keepsake). v1 0x87e957299624dE48285ff420989749760b58a4A8
  // is abandoned — 0 outstanding gifts, only a test token #1 minted there.
  contract: '0xb5F7C80B98aCFb553b3e01E9fEe0FCa4950CBD6e',
  receipt: '0xf3D49De68fCb26be78eFd36DD828cd0206F0400f',
  relayer: '/api',   // Vercel serverless function on the same domain
  explorerTx: 'https://basescan.org/tx/',
};

export default base;

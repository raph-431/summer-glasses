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
  contract: '0xd44395a4832fdb631b3fd3ecb39e94b7da022e07',
  relayer: 'http://127.0.0.1:8788',   // local for the rehearsal; hosted URL for a public testnet
  explorerTx: 'https://sepolia.basescan.org/tx/',
};

export const base = {
  chainId: 8453,
  chainName: 'Base',
  rpc: 'https://mainnet.base.org',
  explorer: 'https://basescan.org',
  currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  contract: '0x_DEPLOYED_CONTRACT_HERE',
  relayer: 'https://your-relayer.example/…',
  explorerTx: 'https://basescan.org/tx/',
};

export default baseSepolia;

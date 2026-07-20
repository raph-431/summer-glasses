// Deployment coordinates for the gift/redeem pages. Swap the export when
// moving networks; fill in contract/relayer after each deploy (LAUNCH.md).

// local anvil dev chain (first Deploy.s.sol run from anvil's account 0
// always lands the contract at this address)
const anvil = {
  chainId: 31337,
  chainName: 'anvil (local)',
  rpc: 'http://127.0.0.1:8545',
  contract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  relayer: 'http://127.0.0.1:8788',
  explorerTx: null, // tx-hash URL prefix; null hides explorer links
};

const baseSepolia = {
  chainId: 84532,
  chainName: 'Base Sepolia',
  rpc: 'https://sepolia.base.org',
  contract: '0x_DEPLOYED_CONTRACT_HERE',
  relayer: 'https://your-relayer.example/…',
  explorerTx: 'https://sepolia.basescan.org/tx/',
};

const base = {
  chainId: 8453,
  chainName: 'Base',
  rpc: 'https://mainnet.base.org',
  contract: '0x_DEPLOYED_CONTRACT_HERE',
  relayer: 'https://your-relayer.example/…',
  explorerTx: 'https://basescan.org/tx/',
};

export default anvil;

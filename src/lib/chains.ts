import type { Address } from "./hex.ts";

/**
 * Canonical contract addresses. They are the same on every supported chain.
 * The fork test checks that code exists at each address and that the
 * pinned code hashes in chronobox.ts match.
 */
export const CONTRACTS = {
  /** SafeProxyFactory 1.4.1 */
  safeProxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  /** SafeL2 1.4.1 singleton */
  safeSingleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  /** MultiSend 1.4.1 (the variant that allows delegatecall into it) */
  multiSend: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526",
  /** Zodiac ModuleProxyFactory */
  moduleProxyFactory: "0x000000000000aDdB49795b0f9bA5BC298cDda236",
  /** Zodiac Delay modifier master copy */
  delayMastercopy: "0xd54895B1121A2eE3f37b502F507631FA1331BED6",
  /**
   * Zodiac Roles modifier 2.1.1 master copy. Used only to allow cancelling.
   * Not 2.1.0 (0x9646…D337): that version is on Zodiac's list of faulty
   * contracts (ERC-1271 authorization bypass, post-mortem of June 2026).
   */
  rolesMastercopy: "0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5",
  /**
   * The owner of a locked Chronobox. Nobody has a key for this address and
   * it has no code, so it can never sign or approve a Safe transaction.
   */
  burn: "0x000000000000000000000000000000000000dEaD",
  /**
   * Multicall3. The app uses it only to read many balances in one request.
   * It never sends a transaction through it.
   */
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const satisfies Record<string, Address>;

export const SENTINEL: Address = "0x0000000000000000000000000000000000000001";
export const ZERO: Address = "0x0000000000000000000000000000000000000000";

export type Token = {
  address: Address;
  symbol: string;
  decimals: number;
};

export type Chain = {
  id: number;
  /** EIP-3770 short name, used in URLs. */
  short: string;
  name: string;
  native: { symbol: string; decimals: 18 };
  explorer: string;
  /** Used only for wallet_addEthereumChain. The page itself never calls it. */
  publicRpc: string;
  testnet?: boolean;
  /**
   * Chainlink price feed of the network's coin in US dollars (8 decimals).
   * Null means the coin is worth one dollar (xDAI). The app reads it through
   * the wallet, only to turn a contribution in dollars into the coin.
   */
  usdFeed: Address | null;
  tokens: Token[];
};

/**
 * Where a voluntary contribution goes. Null means: this build does not ask
 * for one. Set it to an address that the maintainers control on every
 * supported network, for example a Safe with the same address everywhere.
 */
export const CONTRIBUTION_RECEIVER: Address | null = null;

/** The suggested contribution in US dollars, the lower choices, and the hint in the free field. */
export const CONTRIBUTION_USD = { suggested: 50, less: [25, 10], hint: 5 } as const;

export const CHAINS: Chain[] = [
  {
    id: 1,
    short: "eth",
    name: "Ethereum",
    native: { symbol: "ETH", decimals: 18 },
    explorer: "https://etherscan.io",
    publicRpc: "https://ethereum-rpc.publicnode.com",
    usdFeed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    tokens: [
      { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
      { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
      { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18 },
      { address: "0xdC035D45d973E3EC169d2276DDab16f1e407384F", symbol: "USDS", decimals: 18 },
      { address: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD", symbol: "sUSDS", decimals: 18 },
      { address: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c", symbol: "EURC", decimals: 6 },
      { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
      { address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", symbol: "wstETH", decimals: 18 },
      { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8 },
      { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8 },
      { address: "0x45804880De22913dAFE09f4980848ECE6EcbAf78", symbol: "PAXG", decimals: 18 },
      { address: "0x68749665FF8D2d112Fa859AA293F07A622782F38", symbol: "XAUt", decimals: 6 },
      { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", symbol: "LINK", decimals: 18 },
    ],
  },
  {
    id: 8453,
    short: "base",
    name: "Base",
    native: { symbol: "ETH", decimals: 18 },
    explorer: "https://basescan.org",
    publicRpc: "https://base-rpc.publicnode.com",
    usdFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    tokens: [
      { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
      { address: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc", symbol: "USDS", decimals: 18 },
      { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", symbol: "EURC", decimals: 6 },
      { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
      { address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", symbol: "wstETH", decimals: 18 },
      { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", symbol: "cbETH", decimals: 18 },
      { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8 },
    ],
  },
  {
    id: 42161,
    short: "arb1",
    name: "Arbitrum One",
    native: { symbol: "ETH", decimals: 18 },
    explorer: "https://arbiscan.io",
    publicRpc: "https://arbitrum-one-rpc.publicnode.com",
    usdFeed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
    tokens: [
      { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 },
      { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USD₮0", decimals: 6 },
      { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", symbol: "DAI", decimals: 18 },
      { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH", decimals: 18 },
      { address: "0x5979D7b546E38E414F7E9822514be443A4800529", symbol: "wstETH", decimals: 18 },
      { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", symbol: "WBTC", decimals: 8 },
      { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8 },
      { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", symbol: "ARB", decimals: 18 },
    ],
  },
  {
    id: 100,
    short: "gno",
    name: "Gnosis",
    native: { symbol: "XDAI", decimals: 18 },
    explorer: "https://gnosisscan.io",
    publicRpc: "https://rpc.gnosischain.com",
    usdFeed: null,
    tokens: [
      { address: "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0", symbol: "USDC.e", decimals: 6 },
      { address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", symbol: "WXDAI", decimals: 18 },
      { address: "0xaf204776c7245bF4147c2612BF6e5972Ee483701", symbol: "sDAI", decimals: 18 },
      { address: "0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430", symbol: "EURe", decimals: 18 },
      { address: "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1", symbol: "WETH", decimals: 18 },
      { address: "0x6C76971f98945AE98dD7d4DFcA8711ebea946eA6", symbol: "wstETH", decimals: 18 },
      { address: "0x8e5bBbb09Ed1ebdE8674Cda39A0c169401db4252", symbol: "WBTC", decimals: 8 },
      { address: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb", symbol: "GNO", decimals: 18 },
    ],
  },
  {
    id: 11155111,
    short: "sep",
    name: "Sepolia",
    native: { symbol: "ETH", decimals: 18 },
    explorer: "https://sepolia.etherscan.io",
    publicRpc: "https://ethereum-sepolia-rpc.publicnode.com",
    testnet: true,
    usdFeed: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
    tokens: [],
  },
];

export function chainById(id: number): Chain | undefined {
  return CHAINS.find((c) => c.id === id);
}

export function chainByShort(short: string): Chain | undefined {
  return CHAINS.find((c) => c.short === short.toLowerCase());
}

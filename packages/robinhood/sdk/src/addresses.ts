import type { Address } from 'viem'

export const CHAIN_ID = 4663
export const ROBINHOOD_RPC = 'https://rpc.mainnet.chain.robinhood.com'
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address
export const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000' as Address
export const STOCKS = {
  TSLA: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
  AAPL: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  NVDA: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  SPY: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
  AMZN: '0x12f190a9F9d7D37a250758b26824B97CE941bF54',
  MSFT: '0xe93237C50D904957Cf27E7B1133b510C669c2e74',
  GOOGL: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3',
  META: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35',
} as const satisfies Record<string, Address>
export const FEEDS = {
  TSLA: '0x4A1166a659A55625345e9515b32adECea5547C38',
  AAPL: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0',
  NVDA: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15',
  SPY: '0x319724394D3A0e3669269846abE664Cd621f9f6A',
  MSFT: '0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E',
  GOOGL: '0xF6f373a037c30F0e5010d854385cA89185AE638b',
  AMZN: '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C',
  META: '0x7C38C00C30BEe9378381E7B6135d7283356D71b1',
  ETH: '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9',
  USDG: '0x61B7e5650328764B076A108EFF5fa7282a1B9aD2',
} as const satisfies Record<string, Address>
export interface NorenAddresses {
  oracle: Address
  vault: Address
  gateway: Address
  credit: Address
  usdg: Address
  weth: Address
  /** NorenLiquidity (Aqua maker registry and SwapVM routing). */
  liquidity?: Address
  /** NorenAquaSwapVMRouter: SwapVM v1.0.2 AquaSwapVMRouter + NorenOraclePeg, redeployed on the fork. */
  swapRouter?: Address
  /** Official 1inch Aqua registry. */
  aqua?: Address
  deployBlock?: number
  chainId?: number
  rpcUrl?: string
}

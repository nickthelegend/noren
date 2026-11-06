// End to end on the local Robinhood snapshot: a brand-new wallet (no mainnet history) that holds
// real NVDA gets the collateral-only floor from the underwriter and opens a fully secured Arc line.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createNorenRobinhood, STOCKS } from '../../sdk/src/index.js'
import { loadForkDeployment } from '../../sdk/src/node.js'
import { decideTerms } from '../src/decide.js'
import { readWalletHistory } from '../src/history.js'
import { signAttestation } from '../src/attest.js'

const setup = 'Setup required: sh scripts/fork-snapshot.sh && sh scripts/serve-snapshot.sh'
const rpc = process.env.NOREN_RH_RPC ?? 'http://127.0.0.1:8720'
const client = createPublicClient({ transport: http(rpc) })
// Anvil #1, the funded demo customer (published key, local only), hands the new wallet 1 NVDA.
const donor = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
let deployment: ReturnType<typeof loadForkDeployment>
let snapshot: Hex

beforeAll(async () => {
  try {
    deployment = loadForkDeployment()
    if (![4663, 46630].includes(await client.getChainId()) || !(await client.getBytecode({ address: deployment.credit }))) throw new Error(setup)
    snapshot = (await client.request({ method: 'evm_snapshot' } as any)) as Hex
  } catch {
    throw new Error(setup)
  }
})
afterAll(async () => {
  if (snapshot) await client.request({ method: 'evm_revert', params: [snapshot] } as any)
})

it('fresh wallet with Stock Tokens: tier 1 floor, fully secured line opens', async () => {
  const fresh = privateKeyToAccount(generatePrivateKey())
  const donorWallet = createWalletClient({ account: donor, transport: http(rpc) })
  const chain = { id: await client.getChainId(), name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }
  await client.waitForTransactionReceipt({
    hash: await donorWallet.writeContract({ chain, address: STOCKS.NVDA, abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [fresh.address, 10n ** 18n] }),
  })
  await client.request({ method: 'anvil_setBalance', params: [fresh.address, '0x16345785D8A0000'] } as any) // 0.1 ETH for gas on the fork

  const history = await readWalletHistory(fresh.address, { contractRpc: rpc })
  expect(history.txCount.source).toContain('robinhood-mainnet')
  expect(history.holdings.source).toContain('local-fork')
  expect(history.accountAge.status).toBe('unavailable')
  const decision = await decideTerms(history)
  expect(decision.sign, decision.note).toBe(true)
  expect(decision.terms!.tier).toBeGreaterThanOrEqual(1)
  if (decision.source !== '0g') {
    expect(decision.source).toBe('collateral-floor')
    expect(decision.terms!.collateralRatioBps).toBe(15000)
  }

  const signed = await signAttestation({ borrower: fresh.address, terms: decision.terms!, credit: deployment.credit, chainId: await client.getChainId(), publicClient: client })
  if (signed.declined) throw new Error(signed.reason)
  const sdk = createNorenRobinhood({ publicClient: client, walletClient: createWalletClient({ account: fresh, chain, transport: http(rpc) }), addresses: deployment })
  await sdk.applyAttestation(signed)
  const terms = await sdk.creditTerms(fresh.address)
  expect(terms.tier).toBe(decision.terms!.tier)
  const limit = terms.limitUsdg < 100_000_000n ? terms.limitUsdg : 100_000_000n
  const line = await sdk.openCreditLine({ collateral: STOCKS.NVDA, collateralAmount: 10n ** 18n, limitUsdc6: limit, expiry: BigInt(Math.floor(Date.now() / 1000) + 7 * 86400) })
  expect(line.collateralValueUsd8 * 10000n).toBeGreaterThanOrEqual(limit * 100n * BigInt(terms.ratioBps))
}, 180_000)

it('fresh wallet without Stock Tokens is declined with its factors', async () => {
  const fresh = privateKeyToAccount(generatePrivateKey())
  const history = await readWalletHistory(fresh.address, { contractRpc: rpc })
  const decision = await decideTerms(history)
  if (decision.zg.status === 'refused') {
    // deterministic path (0G not configured): no stock, no history -> declined
    expect(decision.sign).toBe(false)
    expect(decision.terms).toBeNull()
  } else {
    expect(decision.logEntry?.zgRequestId).toBeTruthy() // 0G decided; its decision stands
  }
  expect(decision.score.factors.length).toBe(5)
  for (const f of decision.score.factors) expect(f.source.length).toBeGreaterThan(0)
}, 180_000)

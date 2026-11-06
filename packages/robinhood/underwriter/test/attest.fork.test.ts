import { beforeAll, afterAll, it, expect } from 'vitest'
import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createNorenRobinhood } from '../../sdk/src/index.js'
import { loadForkDeployment } from '../../sdk/src/node.js'
import { norenCreditAbi } from '../../sdk/src/abi.js'
import { signAttestation } from '../src/attest.js'
const setup = 'Setup required: sh scripts/fork.sh && sh scripts/deploy-fork.sh'
const rpc = process.env.NOREN_RH_RPC ?? 'http://127.0.0.1:8720'
const client = createPublicClient({ transport: http(rpc) })
const customer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
let deployment: ReturnType<typeof loadForkDeployment>, snapshot: Hex
beforeAll(async () => { try { deployment = loadForkDeployment(); if (await client.getChainId() !== 4663 || !(await client.getBytecode({ address: deployment.credit }))) throw Error(setup); snapshot = await client.request({ method: 'evm_snapshot' } as any) as Hex } catch { throw Error(setup) } })
afterAll(async () => { if (snapshot) await client.request({ method: 'evm_revert', params: [snapshot] } as any) })
it('signs, applies, and rejects replay with BadNonce', async () => {
  const score = { tier: 2, limitUsdg: 1_000_000_000n, collateralRatioBps: 14000 }
  const signed = await signAttestation({ borrower: customer.address, terms: score, credit: deployment.credit, chainId: 4663, publicClient: client })
  expect(signed.declined).toBe(false)
  if (signed.declined) throw Error(signed.reason)
  const sdk = createNorenRobinhood({ publicClient: client, walletClient: createWalletClient({ account: customer, transport: http(rpc) }), addresses: deployment })
  await sdk.applyAttestation(signed)
  expect((await sdk.creditTerms(customer.address)).tier).toBe(2)
  await expect(client.simulateContract({ account: customer, address: deployment.credit, abi: norenCreditAbi, functionName: 'applyAttestation', args: [signed.attestation, signed.signature] })).rejects.toThrow(/BadNonce/)
})

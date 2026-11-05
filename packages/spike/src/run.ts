import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData,
  encodeAbiParameters, http, keccak256, toBytes, parseAbi,
  toHex, type Address, type Hex,
} from 'viem';
import { viem as kohakuViem } from '@kohaku-eth/provider/viem';
import { createPPv1Plugin } from '@kohaku-eth/privacy-pools';
import { writeFoundryFixture } from '../../../scripts/gen-fixtures.ts';

const rpc = 'http://127.0.0.1:8645';
const usdc = '0x3600000000000000000000000000000000000000' as Address;
const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const chain = defineChain({ id: 5042002, name: 'Arc testnet fork', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc), cacheTime: 0 });
const erc20 = parseAbi(['function approve(address spender,uint256 value) returns (bool)', 'function transfer(address to,uint256 value) returns (bool)', 'function balanceOf(address owner) view returns (uint256)']);
const contractsDir = resolve(root, 'packages/contracts');

function artifact(file: string, name: string) {
  return JSON.parse(readFileSync(resolve(contractsDir, `out/${file}.sol/${name}.json`), 'utf8'));
}

function linkedBytecode(a: any, links: Record<string, Address> = {}): Hex {
  let hex: string = a.bytecode.object;
  for (const [file, names] of Object.entries(a.bytecode.linkReferences ?? {})) {
    for (const [name, positions] of Object.entries(names as Record<string, { start: number; length: number }[]>)) {
      const address = links[name];
      if (!address) throw new Error(`Missing library ${file}:${name}`);
      for (const { start, length } of positions) {
        if (length !== 20) throw new Error(`Unexpected link length ${length}`);
        hex = hex.slice(0, 2 + start * 2) + address.slice(2).toLowerCase() + hex.slice(2 + start * 2 + 40);
      }
    }
  }
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error('Unlinked bytecode');
  return hex as Hex;
}

async function main() {
  const chainId = await client.getChainId();
  if (chainId !== 5042002) throw new Error(`Refusing nonlocal/wrong chain ${chainId}`);
  const accounts = await client.request({ method: 'eth_accounts' });
  const deployer = accounts[0] as Address;
  const merchant = accounts[1] as Address;
  const merchant2 = accounts[2] as Address;
  const wallet = createWalletClient({ chain, account: deployer, transport: http(rpc) });
  const deploymentBlock = await client.getBlockNumber();
  async function send(to: Address, data: Hex, from: Address = deployer) {
    const hash = await client.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
    return receipt;
  }
  async function deploy(file: string, name: string, args: any[] = [], links: Record<string, Address> = {}) {
    const a = artifact(file, name);
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: linkedBytecode(a, links), args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`Deploy failed: ${name}`);
    console.log(`${name}: ${receipt.contractAddress}`);
    return receipt.contractAddress;
  }

  const poseidonT3 = await deploy('PoseidonT3', 'PoseidonT3');
  const poseidonT4 = await deploy('PoseidonT4', 'PoseidonT4');
  const withdrawalVerifier = await deploy('WithdrawalVerifier', 'WithdrawalVerifier');
  const commitmentVerifier = await deploy('CommitmentVerifier', 'CommitmentVerifier');
  const implementation = await deploy('Entrypoint', 'Entrypoint');
  const entryAbi = artifact('Entrypoint', 'Entrypoint').abi;
  const init = encodeFunctionData({ abi: entryAbi, functionName: 'initialize', args: [deployer, deployer] });
  const entrypoint = await deploy('ERC1967Proxy', 'ERC1967Proxy', [implementation, init]);
  const pool = await deploy('PrivacyPoolComplex', 'PrivacyPoolComplex', [entrypoint, withdrawalVerifier, commitmentVerifier, usdc], { PoseidonT3: poseidonT3, PoseidonT4: poseidonT4 });
  const poolAbi = artifact('PrivacyPoolComplex', 'PrivacyPoolComplex').abi;
  // Arc's USDC proxy calls a native bridge precompile that stock Anvil cannot execute.
  // Keep the real address and pool, replacing only its token code on this local fork.
  const tokenArtifact = artifact('ForkUSDC', 'ForkUSDC');
  await client.request({ method: 'anvil_setCode', params: [usdc, tokenArtifact.deployedBytecode.object as Hex] });
  const balanceSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [deployer, 0n]));
  await client.request({ method: 'anvil_setStorageAt', params: [usdc, balanceSlot, toHex(20_000_000n, { size: 32 })] });
  const register = encodeFunctionData({ abi: entryAbi, functionName: 'registerPool', args: [usdc, pool, 1_000_000n, 0n, 500n] });
  await send(entrypoint, register);
  const checkout = await deploy('NorenCheckout', 'NorenCheckout', [entrypoint, pool, usdc]);
  const checkoutAbi = artifact('NorenCheckout', 'NorenCheckout').abi;
  await send(checkout, encodeFunctionData({ abi: checkoutAbi, functionName: 'registerMerchant', args: [merchant] }), merchant);
  await send(checkout, encodeFunctionData({ abi: checkoutAbi, functionName: 'registerMerchant', args: [merchant2] }), merchant2);

  await send(usdc, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [entrypoint, 20_000_000n] }));

  let approvedLabel = 0n;
  const state = new Map<string, string>();
  const host: any = {
    network: { fetch },
    storage: { _brand: 'Storage', get: async (key: string) => state.get(key) ?? null, set: async (key: string, value: string) => { state.set(key, value); } },
    keystore: { deriveAt: async (path: string) => keccak256(toBytes(`noren-local-fork-only:${path}`)) },
    provider: kohakuViem(client),
  };
  const protocol: any = createPPv1Plugin(host, {
    accountIndex: 0,
    broadcasterUrl: 'http://127.0.0.1:1',
    entrypoint: { address: BigInt(entrypoint), deploymentBlock },
    aspServiceFactory: () => ({ getAspTree: async () => [[approvedLabel], [approvedLabel]] }),
  });
  const asset = { __type: 'erc20', contract: usdc } as const;
  const { txns } = await protocol.prepareShield({ asset, amount: 10_000_000n });
  const depositReceipt = await send(txns[0].to as Address, txns[0].data as Hex);
  console.log(`depositGas: ${depositReceipt.gasUsed}`);
  await protocol.sync();
  const notes = await protocol.notes([asset]);
  if (notes.length !== 1) throw new Error(`Expected one note, got ${notes.length}`);
  approvedLabel = BigInt(notes[0].label);
  const cid = 'bafybeigdyrzt5norenlocalforkasp000000000000000000000000';
  await send(entrypoint, encodeFunctionData({ abi: entryAbi, functionName: 'updateRoot', args: [approvedLabel, cid] }));
  await protocol.sync();
  const approved = await protocol.balance([asset]);
  console.log(`approvedBalance: ${approved.find((x: any) => !x.tag)?.amount}`);

  const refundState = new Map<string, string>();
  const refundHost = {
    ...host,
    storage: { _brand: 'Storage', get: async (key: string) => refundState.get(key) ?? null, set: async (key: string, value: string) => { refundState.set(key, value); } },
  };
  const refundWallet: any = createPPv1Plugin(refundHost as any, {
    accountIndex: 1,
    broadcasterUrl: 'http://127.0.0.1:1',
    entrypoint: { address: BigInt(entrypoint), deploymentBlock },
    aspServiceFactory: () => ({ getAspTree: async () => [[approvedLabel], [approvedLabel]] }),
  });
  const refundPreparation = await refundWallet.prepareShield({ asset, amount: 2_000_000n });
  const refundPrecommitment = BigInt(`0x${refundPreparation.txns[0].data.slice(-64)}`);
  const invoiceId = keccak256(toBytes('noren-local-invoice-1'));
  const receiptCommitment = keccak256(toBytes('noren-local-receipt-1'));
  const expiry = (await client.getBlock()).timestamp + 3600n;
  const amount = 4_000_000n;
  const invoiceData = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
    [invoiceId, merchant, amount, expiry, refundPrecommitment, receiptCommitment],
  );
  const withdrawal = { processooor: checkout, data: invoiceData };
  const prove = async () => {
    await protocol.sync();
    const t = performance.now();
    const [result] = await protocol.stateManager.getWithdrawalPayloads({
      asset: BigInt(usdc), amount, recipient: BigInt(checkout), checkoutWithdrawal: withdrawal,
    });
    return { result, seconds: (performance.now() - t) / 1000 };
  };
  const cold = await prove();
  console.log(`proveColdSeconds: ${cold.seconds.toFixed(3)}`);
  const warm = await prove();
  console.log(`proveWarmSeconds: ${warm.seconds.toFixed(3)}`);
  if (cold.seconds > 30 || warm.seconds > 30) throw new Error('KILL: proving exceeded 30 seconds');
  const output = warm.result.proofResult;
  const p = output.proof;
  const proof = {
    pA: [BigInt(p.pi_a[0]), BigInt(p.pi_a[1])],
    pB: [[BigInt(p.pi_b[0][1]), BigInt(p.pi_b[0][0])], [BigInt(p.pi_b[1][1]), BigInt(p.pi_b[1][0])]],
    pC: [BigInt(p.pi_c[0]), BigInt(p.pi_c[1])],
    pubSignals: output.publicSignals.map(BigInt),
  };
  writeFoundryFixture({ contractsDir, checkout, pool, entrypoint, usdc, merchant, merchant2,
    invoiceId, receiptCommitment, amount, expiry, refundPrecommitment, proof });
  const tests = execFileSync('forge', ['test', '--fork-url', rpc, '--match-contract', 'NorenCheckoutTest', '-vv'], { cwd: contractsDir, encoding: 'utf8' });
  console.log(tests.trim());
  const testCount = Number(tests.match(/(\d+) tests passed, 0 failed, 0 skipped/)?.[1] ?? 0);
  if (testCount < 8) throw new Error(`Expected at least 8 Foundry passes, got ${testCount}`);

  const receipt = await send(checkout, encodeFunctionData({ abi: checkoutAbi, functionName: 'pay', args: [withdrawal, proof] }), merchant); // the merchant relays its own invoice
  console.log(`withdrawalGas: ${receipt.gasUsed}`);
  await send(usdc, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [checkout, 2_000_000n] }), merchant);
  const refundReceipt = await send(checkout, encodeFunctionData({ abi: checkoutAbi, functionName: 'refund', args: [invoiceId, 2_000_000n] }), merchant);
  console.log(`refundGas: ${refundReceipt.gasUsed}`);
  await refundWallet.sync();
  const refundBalance = await refundWallet.balance([asset]);
  const pendingRefund = refundBalance.find((x: any) => x.tag === 'pending')?.amount ?? 0n;
  if (pendingRefund !== 2_000_000n) throw new Error(`Refund inbox did not discover deposit: ${pendingRefund}`);
  console.log(`refundInboxPending: ${pendingRefund}`);
  console.log(JSON.stringify({ decision: 'GO', addresses: { poseidonT3, poseidonT4, withdrawalVerifier, commitmentVerifier, implementation, entrypoint, pool, checkout }, depositGas: depositReceipt.gasUsed.toString(), withdrawalGas: receipt.gasUsed.toString(), refundGas: refundReceipt.gasUsed.toString(), proveColdSeconds: cold.seconds, proveWarmSeconds: warm.seconds, foundryTests: testCount, refundInboxPending: pendingRefund.toString() }));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });

import { createPPv1Plugin } from '@kohaku-eth/privacy-pools';
import { viem as kohakuViem } from '@kohaku-eth/provider/viem';
import { CommitmentSignalMapper, WithdrawSignalMapper } from '@fatsolutions/privacy-pools-core-circuits';
import * as snarkjs from 'snarkjs';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { ARC_USDC, createReceiptOpening, encodeInvoiceData, localFork, type Deployment, type Invoice } from './index.ts';

export type AspTree = bigint[][];
export function aspServiceFactory(endpoint: string) {
  return () => ({ getAspTree: async (state: any): Promise<AspTree> => {
    const cid = state?.updateRootEvents?.lastUpdateRootEvent?.ipfsCID;
    const url = typeof cid === 'string' && cid.startsWith('http') ? cid : `${endpoint.replace(/\/$/, '')}/asp/tree`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`ASP tree unavailable (${response.status})`);
    return (await response.json()).map((level: string[]) => level.map(BigInt));
  } });
}

const defaultArtifactBase = 'https://raw.githubusercontent.com/0xbow-io/privacy-pools-core/7bc392dad5fa483f53cf74e25d7ad19f0fc6d85f/packages/circuits';
export function artifactProverFactory(baseUrl = defaultArtifactBase) {
  // One prover per factory; browser Cache API or ignored Node cache persists artifacts between runs.
  let loaded: Promise<any> | undefined;
  return () => loaded ??= Promise.resolve({ prove: async (circuit: 'withdraw' | 'commitment', signals: any) => {
    const wasmPath = `build/${circuit}/${circuit}_js/${circuit}.wasm`;
    const zkeyPath = `trusted-setup/final-keys/${circuit}.zkey`;
    const [wasm, zkey] = await Promise.all([loadArtifact(baseUrl, wasmPath), loadArtifact(baseUrl, zkeyPath)]);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(signals, wasm, zkey);
    return { proof, publicSignals, mappedSignals: circuit === 'withdraw' ? WithdrawSignalMapper(publicSignals) : CommitmentSignalMapper(publicSignals) };
  } });
}
const artifactMemory = new Map<string, Promise<Uint8Array>>();
async function loadArtifact(base: string, path: string): Promise<Uint8Array> {
  const key = `${base.replace(/\/$/, '')}/${path}`;
  let promise = artifactMemory.get(key);
  if (!promise) {
    promise = (async () => {
      if (typeof window === 'undefined') {
        const { readFile, writeFile, mkdir } = await import('node:fs/promises');
        const { resolve, dirname } = await import('node:path');
        const target = /^https?:/.test(base) ? resolve('cache/zk', encodeURIComponent(base), path) : resolve(base, path);
        try { return new Uint8Array(await readFile(target)); } catch { /* download below */ }
        if (!/^https?:/.test(base)) throw new Error(`Proving artifact missing: ${target}`);
        const res = await fetch(key); if (!res.ok) throw new Error(`Artifact download failed (${res.status}): ${key}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
        return bytes;
      }
      const cache = 'caches' in globalThis ? await caches.open('noren-zk-v1') : undefined;
      const cached = await cache?.match(key);
      if (cached) return new Uint8Array(await cached.arrayBuffer());
      const res = await fetch(key); if (!res.ok) throw new Error(`Artifact download failed (${res.status}): ${key}`);
      await cache?.put(key, res.clone());
      return new Uint8Array(await res.arrayBuffer());
    })();
    artifactMemory.set(key, promise);
  }
  try { return await promise; } catch (e) { artifactMemory.delete(key); throw e; }
}

export type CustomerOptions = {
  deployment: Deployment; rpcUrl: string; aspUrl: string; accountIndex?: number;
  refundAccountIndex?: number; artifactBaseUrl?: string;
  deriveAt: (path: string) => Promise<Hex>; storage?: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
};
export function createCustomer(options: CustomerOptions) {
  const { deployment: d } = options;
  const chain = localFork(options.rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(options.rpcUrl), cacheTime: 0 });
  const memory = new Map<string, string>();
  const host: any = { network: { fetch }, keystore: { deriveAt: options.deriveAt }, provider: kohakuViem(publicClient), storage: { _brand: 'Storage', get: (k: string) => options.storage?.get(k) ?? Promise.resolve(memory.get(k) ?? null), set: (k: string, v: string) => options.storage?.set(k, v) ?? Promise.resolve(void memory.set(k, v)) } };
  const base = { broadcasterUrl: 'http://127.0.0.1:1', entrypoint: { address: BigInt(d.entrypoint), deploymentBlock: BigInt(d.deploymentBlock) }, aspServiceFactory: aspServiceFactory(options.aspUrl), proverFactory: artifactProverFactory(options.artifactBaseUrl) };
  const main: any = createPPv1Plugin(host, { ...base, accountIndex: options.accountIndex ?? 0 });
  const refundMemory = new Map<string, string>();
  const refundHost = { ...host, storage: { _brand: 'Storage', get: async (k: string) => refundMemory.get(k) ?? null, set: async (k: string, v: string) => { refundMemory.set(k, v); } } };
  const inbox: any = createPPv1Plugin(refundHost, { ...base, accountIndex: options.refundAccountIndex ?? 1 });
  const asset = { __type: 'erc20', contract: d.usdc ?? ARC_USDC } as const;
  const openings = new Map<string, { secret: Hex; commitment: Hex }>();
  return {
    publicClient, main, inbox,
    async shield(amount: bigint) { if (amount <= 0n) throw new Error('amount must be positive'); return (await main.prepareShield({ asset, amount })).txns; },
    async balance() { await main.sync(); return main.balance([asset]); },
    async refundInbox() {
      await inbox.sync();
      const next = await inbox.prepareShield({ asset, amount: 1n });
      const precommitment = BigInt(`0x${next.txns[0].data.slice(-64)}`);
      return { balances: await inbox.balance([asset]), nextPrecommitment: precommitment };
    },
    createReceipt: createReceiptOpening,
    async rememberReceipt(invoice: Invoice, opening: { secret: Hex; commitment: Hex }) { if (opening.commitment.toLowerCase() !== invoice.receiptCommitment.toLowerCase()) throw new Error('Receipt commitment mismatch'); openings.set(invoice.invoiceId.toLowerCase(), opening); await options.storage?.set(`noren:receipt:${invoice.invoiceId.toLowerCase()}`, JSON.stringify(opening)); },
    async receipt(invoice: Invoice) {
      const key = invoice.invoiceId.toLowerCase();
      const opening = openings.get(key) ?? JSON.parse(await options.storage?.get(`noren:receipt:${key}`) ?? 'null');
      if (!opening || opening.commitment.toLowerCase() !== invoice.receiptCommitment.toLowerCase()) throw new Error('Receipt opening unavailable or mismatched');
      return { invoiceId: invoice.invoiceId, amount: invoice.amount, secret: opening.secret, commitment: opening.commitment };
    },
    async proveInvoicePayment(invoice: Invoice) {
      await main.sync();
      const withdrawal = { processooor: d.checkout, data: encodeInvoiceData(invoice) };
      const [result] = await main.stateManager.getWithdrawalPayloads({ asset: BigInt(d.usdc), amount: invoice.amount, recipient: BigInt(d.checkout), checkoutWithdrawal: withdrawal });
      const p = result.proofResult.proof;
      return { withdrawal, proof: { pA: [BigInt(p.pi_a[0]), BigInt(p.pi_a[1])], pB: [[BigInt(p.pi_b[0][1]), BigInt(p.pi_b[0][0])], [BigInt(p.pi_b[1][1]), BigInt(p.pi_b[1][0])]], pC: [BigInt(p.pi_c[0]), BigInt(p.pi_c[1])], pubSignals: result.proofResult.publicSignals.map(BigInt) } };
    },
  };
}

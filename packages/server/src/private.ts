// "Send privately": Noren's server relays Kohaku withdrawals so a customer can pay any address (a merchant or a
// person) from their private balance. The relayer signs Entrypoint.relay, so on-chain the recipient is paid by the
// privacy pool's Entrypoint and the sender's address appears in neither the transaction nor its logs.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPublicClient, createWalletClient, http, isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterRelayFee, decodeRelayData, jsonBigints, localFork, poolScopeAbi, relayAbi, type Deployment } from '@noren/core';

export type PrivateRelayOptions = {
  deployment: Deployment; rpcUrl: string;
  /** Signs Entrypoint.relay and receives the relay fee. */
  relayerKey: Hex;
  /** Fee the relayer asks for, in basis points of the amount (the pool's maxRelayFeeBPS caps it on-chain). Default 0. */
  feeBps?: bigint;
  /** Called with every relayed send (for logs and records). */
  onRelayed?: (r: RelayedSend) => void;
};
export type RelayedSend = { tx: Hex; recipient: Address; amount: bigint; fee: bigint; received: bigint; gasUsed: bigint; block: bigint };

const big = (v: unknown, what: string) => { try { return BigInt(v as any); } catch { throw new Error(`${what} must be an integer`); } };
/** Parses the JSON body of POST /private/send into the Solidity call's arguments; rejects anything malformed. */
export function parsePrivateSend(body: any) {
  const w = body?.withdrawal, p = body?.proof;
  if (!w || !isAddress(w.processooor) || typeof w.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(w.data)) throw new Error('withdrawal must be { processooor, data }');
  if (!p || !Array.isArray(p.pA) || p.pA.length !== 2 || !Array.isArray(p.pB) || p.pB.length !== 2 || !Array.isArray(p.pC) || p.pC.length !== 2 || !Array.isArray(p.pubSignals) || p.pubSignals.length !== 8) throw new Error('proof must be a Groth16 WithdrawProof { pA[2], pB[2][2], pC[2], pubSignals[8] }');
  const proof = { pA: p.pA.map((x: unknown) => big(x, 'pA')) as [bigint, bigint], pB: p.pB.map((row: unknown[]) => { if (!Array.isArray(row) || row.length !== 2) throw new Error('pB must be 2x2'); return row.map(x => big(x, 'pB')); }) as [[bigint, bigint], [bigint, bigint]], pC: p.pC.map((x: unknown) => big(x, 'pC')) as [bigint, bigint], pubSignals: p.pubSignals.map((x: unknown) => big(x, 'pubSignals')) as bigint[] };
  return { withdrawal: { processooor: w.processooor as Address, data: w.data as Hex }, proof, scope: big(body.scope, 'scope') };
}

export function createPrivateRelay(options: PrivateRelayOptions) {
  const chain = localFork(options.rpcUrl);
  const client: any = createPublicClient({ chain, transport: http(options.rpcUrl), cacheTime: 0 });
  const account = privateKeyToAccount(options.relayerKey);
  const wallet: any = createWalletClient({ chain, account, transport: http(options.rpcUrl) });
  const feeBps = options.feeBps ?? 0n;
  const entrypoint = options.deployment.entrypoint;
  let scope: Promise<bigint> | undefined;
  const poolScope = () => scope ??= client.readContract({ address: options.deployment.pool, abi: poolScopeAbi, functionName: 'SCOPE' }).catch((e: unknown) => { scope = undefined; throw e; });

  async function quote() {
    const [, , , maxRelayFeeBPS] = await client.readContract({ address: entrypoint, abi: relayAbi, functionName: 'assetConfig', args: [options.deployment.usdc] }) as [Address, bigint, bigint, bigint];
    return { relayer: account.address, feeRecipient: account.address, feeBps, maxRelayFeeBps: maxRelayFeeBPS, entrypoint, pool: options.deployment.pool, scope: await poolScope(), asset: options.deployment.usdc };
  }

  /** Validates and relays one private send. Throws a readable error for anything the relayer will not sign. */
  async function relay(body: any): Promise<RelayedSend> {
    const { withdrawal, proof, scope: s } = parsePrivateSend(body);
    if (withdrawal.processooor.toLowerCase() !== entrypoint.toLowerCase()) throw new Error('withdrawal.processooor must be the Kohaku Entrypoint (a relayed withdrawal)');
    let data;
    try { data = decodeRelayData(withdrawal.data); } catch { throw new Error('withdrawal.data must be abi.encode(RelayData{recipient, feeRecipient, relayFeeBPS})'); }
    if (/^0x0{40}$/i.test(data.recipient)) throw new Error('recipient must be a non-zero address');
    if (data.feeRecipient.toLowerCase() !== account.address.toLowerCase()) throw new Error(`feeRecipient must be this relayer (${account.address})`);
    if (data.relayFeeBps !== feeBps) throw new Error(`relayFeeBPS must be ${feeBps} (GET /private/relayer)`);
    if (s !== await poolScope()) throw new Error('scope is not the Noren USDC privacy pool');
    const amount = proof.pubSignals[2];
    if (amount <= 0n) throw new Error('withdrawn value must be positive');
    const args = [withdrawal, proof, s] as const;
    // Simulate first: a bad proof, a spent note or a stale ASP root never costs the relayer gas.
    await client.simulateContract({ account: account.address, address: entrypoint, abi: [...relayAbi, ...poolScopeAbi], functionName: 'relay', args });
    const tx = await wallet.writeContract({ address: entrypoint, abi: relayAbi, functionName: 'relay', args });
    const receipt = await client.waitForTransactionReceipt({ hash: tx, timeout: 180_000 });
    if (receipt.status !== 'success') throw new Error(`Entrypoint.relay reverted: ${tx}`);
    const received = afterRelayFee(amount, feeBps);
    const out: RelayedSend = { tx, recipient: data.recipient, amount, fee: amount - received, received, gasUsed: receipt.gasUsed, block: receipt.blockNumber };
    options.onRelayed?.(out);
    return out;
  }

  /** Mount for createMerchantServer({ mounts }): GET /private/relayer and POST /private/send. */
  async function mount(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/private/relayer' && path !== '/private/send') return false;
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(jsonBigints(value)); };
    try {
      if (req.method === 'GET' && path === '/private/relayer') { send(200, await quote()); return true; }
      if (req.method === 'POST' && path === '/private/send') {
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new Error('Request too large'); }
        send(200, await relay(raw ? JSON.parse(raw) : {})); return true;
      }
      send(405, { error: 'Method not allowed' }); return true;
    } catch (e: any) { send(400, { error: e?.shortMessage ?? e?.message ?? String(e) }); return true; }
  }
  return { quote, relay, mount, address: account.address };
}

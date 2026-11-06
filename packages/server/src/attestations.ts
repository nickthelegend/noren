/**
 * Private on-chain attestations besides Reclaim (reclaim.ts records those itself):
 *   GET  /reputation/attestations?address=0x…   the kinds recorded for a wallet, each with its tx (AttestationRecorded logs)
 *   POST /reputation/attest-repayment {address}  the server reads the wallet's repayments on-chain (NorenCredit.history:
 *        3 on-time installments, or NorenBorrow.record: a fully repaid loan) and, if they are there, records an
 *        ONCHAIN_REPAYMENT attestation (kind 5)
 * plus recordWorldId(), which dev:all calls after the World ID server verified a proof (kind 0, the nullifier as proofId).
 * Every record uses reclaim-onchain.ts: one fixed public weight per kind, a salted commitment, the salt kept here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, parseAbiItem, type Address, type Hex } from 'viem';
import { KIND, newSalt, recordKind, type KindName, type OnchainRecord, type OnchainTarget } from './reclaim-onchain.ts';

export type AttestationTarget = OnchainTarget & { credit: Address; borrow?: Address; fromBlock?: bigint };
type Row = { address: string; kind: KindName; proofId: string; salt: Hex; onchain: OnchainRecord; at: number };
const KIND_NAMES = Object.keys(KIND) as KindName[];
const isAddress = (a: unknown): a is Address => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const recorded = parseAbiItem('event AttestationRecorded(address indexed borrower, uint8 indexed kind, bytes32 commitment)');
const historyAbi = parseAbi([
  'function history(address borrower) view returns (uint32 onTime, uint32 late, uint32 completed, uint32 clean, uint32 defaults)',
  'function record(address account) view returns (uint32 repaidLoans, uint32 liquidations)',
]);

async function readRows(file: string): Promise<Row[]> { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; } }
async function appendRow(file: string, row: Row) {
  const rows = [...(await readRows(file)), row];
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(rows, null, 2), { mode: 0o600 });
  await chmod(`${file}.tmp`, 0o600);
  await rename(`${file}.tmp`, file);
}

/** Record one kind with a fresh salt, keep the salt in the 0600 store. */
export async function attest(target: OnchainTarget | undefined, storeFile: string, address: Address, kind: KindName, proofId: string): Promise<OnchainRecord> {
  const salt = newSalt();
  let onchain: OnchainRecord;
  try { onchain = await recordKind(target, address, kind, proofId, salt); } catch (e: any) { onchain = { status: 'unavailable', reason: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) }; }
  if (onchain.status === 'recorded') await appendRow(storeFile, { address: address.toLowerCase(), kind, proofId, salt, onchain, at: Math.floor(Date.now() / 1000) });
  return onchain;
}

/** World ID: the nullifier (already the only thing Noren keeps) is the proof ID behind the commitment. */
export const recordWorldId = (target: OnchainTarget | undefined, storeFile: string, address: Address, nullifierHash: string) =>
  attest(target, storeFile, address, 'worldId', nullifierHash);

/** Repayments the attester read on-chain: 3 on-time Pay-in-3 installments or a fully repaid NorenBorrow loan. */
export async function attestRepayment(t: AttestationTarget, storeFile: string, address: Address): Promise<OnchainRecord & { onTime?: number; repaidLoans?: number }> {
  const pub: any = createPublicClient({ transport: http(t.rpcUrl) });
  const [h, rec, block]: [readonly number[], readonly number[], bigint] = await Promise.all([
    pub.readContract({ address: t.credit, abi: historyAbi, functionName: 'history', args: [address] }),
    t.borrow ? pub.readContract({ address: t.borrow, abi: historyAbi, functionName: 'record', args: [address] }) : Promise.resolve([0, 0] as const),
    pub.getBlockNumber(),
  ]);
  const onTime = Number(h[0]), repaidLoans = Number(rec[0]);
  if (onTime < 3 && repaidLoans < 1) return { status: 'unavailable', reason: `Not yet: ${onTime} of 3 on-time installments and no fully repaid loan on-chain`, onTime, repaidLoans };
  // The proof ID binds what the attester saw (wallet, counts, block); the salt hides it.
  const proofId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint256' }], [address, onTime, repaidLoans, block]));
  return { ...(await attest(t, storeFile, address, 'onchainRepayment', proofId)), onTime, repaidLoans };
}

/** Kinds recorded for a wallet, with the tx of each (from AttestationRecorded logs; no proof data exists on-chain). */
export async function attestationsFor(t: OnchainTarget & { fromBlock?: bigint }, address: Address) {
  const pub = createPublicClient({ transport: http(t.rpcUrl) });
  const logs = await pub.getLogs({ address: t.reputation, event: recorded, args: { borrower: address }, fromBlock: t.fromBlock ?? 0n, toBlock: 'latest' });
  return logs.map((l) => ({ kind: Number(l.args.kind), kindName: KIND_NAMES.find((k) => KIND[k] === Number(l.args.kind)) ?? `kind ${l.args.kind}`, tx: l.transactionHash as Hex, commitment: l.args.commitment as Hex }));
}

const ORIGINS = new Set(['http://localhost:5190', 'http://127.0.0.1:5190']);
function send(req: IncomingMessage, res: ServerResponse, status: number, value: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (req.headers.origin && ORIGINS.has(req.headers.origin)) Object.assign(headers, { 'access-control-allow-origin': req.headers.origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
  res.writeHead(status, headers);
  res.end(status === 204 ? undefined : JSON.stringify(value));
}

export function createAttestationHandler({ target, storeFile }: { target: AttestationTarget | undefined; storeFile: string }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (!url.pathname.startsWith('/reputation/')) return false;
    try {
      if (req.method === 'OPTIONS') return send(req, res, 204, null), true;
      if (!target) return send(req, res, 503, { error: 'Setup required: NorenReputation is not on this stack (pnpm dev:all with packages/robinhood)' }), true;
      if (req.method === 'GET' && url.pathname === '/reputation/attestations') {
        const a = url.searchParams.get('address');
        if (!isAddress(a)) return send(req, res, 400, { error: 'address must be a 0x address' }), true;
        return send(req, res, 200, { attestations: await attestationsFor(target, a) }), true;
      }
      if (req.method === 'POST' && url.pathname === '/reputation/attest-repayment') {
        let s = ''; for await (const c of req) { s += c; if (s.length > 2000) throw new Error('Request too large'); }
        const { address } = s ? JSON.parse(s) : {};
        if (!isAddress(address)) return send(req, res, 400, { error: 'address must be a 0x address' }), true;
        const r = await attestRepayment(target, storeFile, address);
        return send(req, res, r.status === 'recorded' ? 200 : 409, r), true;
      }
      return send(req, res, 404, { error: `No route ${req.method} ${url.pathname}` }), true;
    } catch (e: any) { return send(req, res, 500, { error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 300) }), true; }
  };
}

// MIT. Public JSON-RPC front for the Robinhood Chain mainnet snapshot (Anvil, no upstream).
// Only read methods and signed raw transactions pass: Anvil's unlocked dev accounts and its anvil_*/evm_* cheat
// methods stay reachable from the Noren server on the private network only.
import { createServer } from 'node:http';
const UPSTREAM = process.env.UPSTREAM ?? 'http://anvil:8545';
const ALLOWED = new Set(['eth_chainId', 'net_version', 'web3_clientVersion', 'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_getBalance', 'eth_getCode',
  'eth_getStorageAt', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getLogs', 'eth_sendRawTransaction', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_syncing', 'eth_getBlockReceipts',
  'eth_getTransactionByBlockNumberAndIndex', 'eth_getBlockTransactionCountByNumber', 'eth_blobBaseFee']);
const deny = (m) => ({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32601, message: `Method ${String(m?.method)} is not available on the public Robinhood snapshot RPC` } });
createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method === 'GET') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, chain: 'Robinhood Chain mainnet snapshot (Anvil, no upstream)', post: 'JSON-RPC' })); }
  if (req.method !== 'POST') { res.writeHead(405, cors); return res.end(); }
  let raw = ''; for await (const c of req) { raw += c; if (raw.length > 2_000_000) { res.writeHead(413, cors); return res.end(); } }
  let body; try { body = JSON.parse(raw); } catch { res.writeHead(400, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); }
  const batch = Array.isArray(body), calls = batch ? body : [body];
  if (calls.length > 100) { res.writeHead(413, cors); return res.end(); }
  const out = await Promise.all(calls.map(async (m) => {
    if (m?.method === 'eth_accounts') return { jsonrpc: '2.0', id: m.id, result: [] };
    if (!ALLOWED.has(m?.method)) return deny(m);
    try { const r = await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) }); return await r.json(); }
    catch { return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32603, message: 'Snapshot node unavailable' } }; }
  }));
  res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(batch ? out : out[0]));
}).listen(Number(process.env.PORT ?? 8546), '0.0.0.0', () => console.log('Robinhood snapshot RPC proxy ready'));

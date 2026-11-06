// MIT. Arc testnet JSON-RPC front for the hosted Noren demo. Every browser syncs the Kohaku pool from the same
// deployment block, and the public Arc RPC rate-limits per client, so this proxy (1) spreads calls over Arc's
// public testnet RPC providers, retrying another one on 429/5xx, and (2) caches answers that can no longer change:
// eth_chainId, and eth_getLogs / block reads whose range ends at least 64 blocks below the head. It never signs.
import { createServer } from 'node:http';
const UPSTREAMS = (process.env.UPSTREAMS ?? 'https://rpc.drpc.testnet.arc.io,https://rpc.quicknode.testnet.arc.io,https://arc-testnet.drpc.org,https://rpc.testnet.arc.io').split(',');
const cache = new Map(); const MAX = 20_000;
let head = 0n, headAt = 0, rr = 0;
const put = (k, v) => { if (cache.size >= MAX) cache.delete(cache.keys().next().value); cache.set(k, v); };
async function upstream(body) {
  let last;
  for (let i = 0; i < UPSTREAMS.length * 2; i++) {
    const url = UPSTREAMS[rr++ % UPSTREAMS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (r.status === 429 || r.status >= 500) { last = `HTTP ${r.status} from ${new URL(url).host}`; continue; }
      const j = await r.json();
      if (j?.error && /rate limit|too many|capacity|timeout/i.test(String(j.error.message))) { last = j.error.message; continue; }
      return j;
    } catch (e) { last = String(e?.message ?? e); }
  }
  return { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32005, message: `Arc testnet RPC providers busy: ${last}` } };
}
async function latest() {
  if (Date.now() - headAt < 2000 && head) return head;
  const j = await upstream({ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber' });
  if (j.result) { head = BigInt(j.result); headAt = Date.now(); }
  return head;
}
const num = (x) => { try { return typeof x === 'string' && x.startsWith('0x') ? BigInt(x) : null; } catch { return null; } };
async function cacheable(m) {
  if (m.method === 'eth_chainId' || m.method === 'net_version') return true;
  const h = await latest(); if (!h) return false;
  if (m.method === 'eth_getLogs') { const f = m.params?.[0] ?? {}; if (f.blockHash) return true; const to = num(f.toBlock); return to !== null && to + 64n < h; }
  if (m.method === 'eth_getBlockByNumber' || m.method === 'eth_getBlockReceipts') { const n = num(m.params?.[0]); return n !== null && n + 64n < h; }
  if (m.method === 'eth_getTransactionReceipt' || m.method === 'eth_getTransactionByHash') return false;
  return false;
}
async function one(m) {
  if (!m || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
  const key = JSON.stringify([m.method, m.params ?? []]);
  const hit = cache.get(key); if (hit) return { jsonrpc: '2.0', id: m.id, result: hit };
  const j = await upstream({ jsonrpc: '2.0', id: m.id ?? 1, method: m.method, params: m.params ?? [] });
  if (j && 'result' in j && !j.error && await cacheable(m)) put(key, j.result);
  return { ...j, id: m.id };
}
createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method === 'GET') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, chain: 'Arc testnet (5042002)', upstreams: UPSTREAMS.map(u => new URL(u).host), cached: cache.size })); }
  if (req.method !== 'POST') { res.writeHead(405, cors); return res.end(); }
  let raw = ''; for await (const c of req) { raw += c; if (raw.length > 4_000_000) { res.writeHead(413, cors); return res.end(); } }
  let body; try { body = JSON.parse(raw); } catch { res.writeHead(400, { ...cors, 'content-type': 'application/json' }); return res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}'); }
  const out = Array.isArray(body) ? await Promise.all(body.slice(0, 200).map(one)) : await one(body);
  res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(out));
}).listen(Number(process.env.PORT ?? 8547), '0.0.0.0', () => console.log('Arc testnet RPC proxy ready'));

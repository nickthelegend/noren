// HTTP surface for the credit check (default port 8740, in the 0G block 8740-8749).
//   GET  /health                   setup state (key present or "Setup required"), model, network
//   GET  /v1/zg/provider           live: the TeeML provider for 0GM-1.0, its on-chain record and quote binding (no key needed)
//   POST /v1/credit-check          { features } or { history } -> decision + 0G evidence
//   POST /v1/credit-check/wallet   { address } -> reads history from the Robinhood underwriter, then as above
//   GET  /v1/decisions             stored decisions (decision + request ID + evidence; never features)
// Optional header X-0G-User-Key: the customer's own sk- key, so their own 0G balance pays for the
// inference. It is used for that one request and never stored or logged.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isAddress } from 'viem'
import { creditCheck, type CreditCheckOptions } from './credit-check.ts'
import { featuresFromHistory, type CreditFeatures, type WalletHistoryLike } from './features.ts'
import { appendDecision, readDecisions, toStoredDecision } from './store.ts'
import { readQuoteBinding, readServiceRecord } from './verify.ts'
import { listProviders, resolveConfig, SetupRequiredError } from './zg.ts'

export type ServerOptions = {
  decisionsPath: string
  robinhoodUnderwriterUrl: string
  check?: CreditCheckOptions
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x)

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) { raw += chunk; if (raw.length > 64_000) throw new HttpError(413, 'Request too large') }
  try { return raw ? JSON.parse(raw) : {} } catch { throw new HttpError(400, 'Invalid JSON body') }
}
class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }

export function createCreditServer(opts: ServerOptions) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-0G-User-Key')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    const send = (status: number, v: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(json(v)) }
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      if (req.method === 'OPTIONS') return send(204, {})
      if (req.method === 'GET' && url.pathname === '/health') {
        const cfg = resolveConfig(opts.check)
        return send(200, { ok: true, model: cfg.model, network: cfg.network, trustMode: 'private', setup: cfg.apiKey ? 'ready' : new SetupRequiredError().message })
      }
      if (req.method === 'GET' && url.pathname === '/v1/zg/provider') {
        const cfg = resolveConfig(opts.check)
        const providers = (await listProviders(cfg.model, cfg.network)).filter(p => p.verifiability === 'TeeML')
        if (!providers.length) return send(503, { error: `No TeeML provider listed for ${cfg.model}` })
        const out = []
        for (const p of providers) {
          const service = await readServiceRecord(p.address as `0x${string}`, cfg.network)
          const quote = await readQuoteBinding(service).catch(e => ({ error: (e as Error).message }))
          out.push({ router: p, service, quote })
        }
        return send(200, { model: cfg.model, network: cfg.network, providers: out })
      }
      if (req.method === 'GET' && url.pathname === '/v1/decisions') return send(200, { decisions: await readDecisions(opts.decisionsPath, Number(url.searchParams.get('limit') ?? 50)) })
      if (req.method === 'POST' && (url.pathname === '/v1/credit-check' || url.pathname === '/v1/credit-check/wallet')) {
        const b = await body(req)
        let features: CreditFeatures
        let subject: string | null = null
        if (url.pathname === '/v1/credit-check/wallet') {
          if (typeof b.address !== 'string' || !isAddress(b.address)) throw new HttpError(400, 'Invalid address')
          subject = b.address
          const r = await fetch(`${opts.robinhoodUnderwriterUrl}/score/${b.address}`, { signal: AbortSignal.timeout(60_000) }).catch(e => { throw new HttpError(502, `Robinhood underwriter unreachable at ${opts.robinhoodUnderwriterUrl}: ${(e as Error).message}`) })
          const scored = await r.json() as { history?: WalletHistoryLike; error?: string }
          if (!r.ok || !scored.history) throw new HttpError(502, `Robinhood underwriter: ${scored.error ?? `HTTP ${r.status}`}`)
          features = featuresFromHistory(scored.history)
        } else if (b.history) features = featuresFromHistory(b.history as WalletHistoryLike)
        else if (b.features) features = b.features as CreditFeatures
        else throw new HttpError(400, 'Send { features } or { history }')
        const userKey = req.headers['x-0g-user-key']
        const check: CreditCheckOptions = { ...opts.check, ...(typeof userKey === 'string' && userKey ? { apiKey: userKey } : {}) }
        const result = await creditCheck(features, check)
        await appendDecision(opts.decisionsPath, toStoredDecision(result, subject))
        // Features are returned to the caller (they sent or requested them) but never stored.
        return send(result.status === 'refused' ? (result.setupRequired ? 503 : 422) : 200, { ...result, features })
      }
      send(404, { error: 'Not found' })
    } catch (e) {
      const status = e instanceof HttpError ? e.status : /^Invalid/.test((e as Error).message) ? 400 : 500
      send(status, { error: (e as Error).message })
    }
  })
}

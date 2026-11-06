// Noren underwriter HTTP API (port 8721).
//   GET  /health
//   GET  /score/:address   real Robinhood mainnet history + deterministic score (no signing)
//   POST /attest {borrower} history -> 0G credit check (or the labelled deterministic score when 0G
//                           is not configured) -> limit x NorenReputation multiplier -> EIP-712 CreditAttestation signature
//   Both read the Reclaim proof store (NOREN_RECLAIM_STORE, default data/reclaim-proofs.json): a verified off-chain
//   fact adds the offchainProof factor. /score also answers what the score would be with one ("reclaim.ifVerified").
//   POST /attest-age {account} mainnet first-activity scan -> EIP-712 AccountAge for NorenReputation
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendDecision, toStoredDecision } from '@noren/ai-underwriter'
import { createPublicClient, http, isAddress, type Address } from 'viem'
import { loadForkDeployment } from '../../sdk/src/node.js'
import { reputationMultiplierBps, signAccountAge, signAttestation } from './attest.js'
import { decideTerms } from './decide.js'
import { readWalletHistory } from './history.js'
import { offchainProofOf } from './reclaim.js'
import { OFFCHAIN_PROOF_POINTS, scoreWallet } from './score.js'

const port = Number(process.env.NOREN_RH_UNDERWRITER_PORT ?? 8721)
const decisionsLog = process.env.NOREN_RH_DECISIONS_LOG ?? resolve(fileURLToPath(new URL('../../.fork/credit-decisions.jsonl', import.meta.url)))
const serialize = (value: unknown) => JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(serialize(body))
  }
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`)
  try {
    if (req.method === 'OPTIONS') return send(204, {})
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true })
    if (req.method === 'GET' && req.url?.startsWith('/score/')) {
      const borrower = decodeURIComponent(req.url.slice(7))
      if (!isAddress(borrower)) return send(400, { error: 'Invalid borrower address' })
      const history = await readWalletHistory(borrower)
      const offchain = await offchainProofOf(borrower)
      const score = scoreWallet(history, { offchain })
      const ifVerified = offchain ? score : scoreWallet(history, { offchain: { provider: 'Reclaim', proofId: 'hypothetical' } })
      // When 0G is configured it sets the signed terms (see decide.ts); the score, this factor included, decides only without it.
      const decidedBy = process.env.ZG_PC_API_KEY ? '0g' : 'deterministic-score'
      return send(200, { history, score, reclaim: { verified: !!offchain, ...(offchain ? { provider: offchain.provider, proofId: offchain.proofId } : {}), points: OFFCHAIN_PROOF_POINTS, decidedBy, ifVerified: { score: ifVerified.score, tier: ifVerified.tier, limitUsdg: ifVerified.limitUsdg } } })
    }
    if (req.method === 'POST' && req.url === '/attest') {
      let raw = ''
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > 10_000) throw new Error('Request too large')
      }
      const { borrower } = JSON.parse(raw || '{}') as { borrower?: string }
      if (!borrower || !isAddress(borrower)) return send(400, { error: 'Invalid borrower address' })

      const history = await readWalletHistory(borrower)
      const decision = await decideTerms(history, { offchain: await offchainProofOf(borrower) })
      if (decision.zg.status !== 'refused' || decision.zg.evidence) await appendDecision(decisionsLog, toStoredDecision(decision.zg, borrower))
      if (decision.logEntry) console.log(serialize({ attestationLog: decision.logEntry, borrower }))
      if (decision.source === 'refused') return send(502, { error: decision.note, decision })
      if (!decision.sign || !decision.terms) return send(200, { declined: true, decision })

      let deployment: ReturnType<typeof loadForkDeployment> | undefined
      try {
        deployment = loadForkDeployment()
      } catch {}
      const credit = (process.env.NOREN_RH_CREDIT as Address | undefined) ?? deployment?.credit
      if (!credit) throw new Error('Setup required: NOREN_RH_CREDIT')
      const rpc = process.env.NOREN_RH_RPC ?? deployment?.rpcUrl ?? 'http://127.0.0.1:8720'
      const client = createPublicClient({ transport: http(rpc) })
      // Reputation milestones (World ID, on-time repayments, repaid loans) scale the attested limit.
      const reputation = (process.env.NOREN_RH_REPUTATION as Address | undefined) ?? (deployment as { reputation?: Address } | undefined)?.reputation
      const multiplier = await reputationMultiplierBps(client, reputation, borrower)
      const terms = { ...decision.terms, limitUsdg: (decision.terms.limitUsdg * BigInt(multiplier.bps)) / 10_000n }
      const signed = await signAttestation({ borrower, terms, credit, chainId: await client.getChainId(), publicClient: client })
      if (decision.logEntry) console.log(serialize({ attestationLog: decision.logEntry, borrower, signed: !signed.declined }))
      return send(200, { decisionSource: decision.source, decision, reputationMultiplier: { ...multiplier, baseLimitUsdg: decision.terms.limitUsdg }, ...signed })
    }
    if (req.method === 'POST' && req.url === '/attest-age') {
      let raw = ''
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > 10_000) throw new Error('Request too large')
      }
      const { account } = JSON.parse(raw || '{}') as { account?: string }
      if (!account || !isAddress(account)) return send(400, { error: 'Invalid account address' })
      let deployment: ReturnType<typeof loadForkDeployment> | undefined
      try {
        deployment = loadForkDeployment()
      } catch {}
      const reputation = (process.env.NOREN_RH_REPUTATION as Address | undefined) ?? (deployment as { reputation?: Address } | undefined)?.reputation
      if (!reputation) throw new Error('Setup required: NOREN_RH_REPUTATION')
      const client = createPublicClient({ transport: http(process.env.NOREN_RH_RPC ?? deployment?.rpcUrl ?? 'http://127.0.0.1:8720') })
      const history = await readWalletHistory(account)
      if (history.accountAge.status !== 'available') return send(200, { declined: true, reason: history.accountAge.note, accountAge: history.accountAge })
      const signed = await signAccountAge({ account, ageDays: history.accountAge.days, reputation, publicClient: client })
      return send(200, { accountAge: history.accountAge, reputation, ...signed })
    }
    send(404, { error: 'Not found' })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    send(message.startsWith('Setup required:') ? 503 : message.includes('Invalid') || message.includes('JSON') ? 400 : 500, { error: message })
  }
})

if (process.argv[1]?.endsWith('/server.ts')) server.listen(port, '127.0.0.1', () => console.log(`Noren underwriter listening on http://127.0.0.1:${port}`))
export { server }

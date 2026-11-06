// Independent verification of a 0G Private Computer response, without trusting the Router.
// Follows "Independent verification (advanced) / Without the SDK" in
// https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution
//   1. read the provider's Service record from the on-chain InferenceServing contract
//   2. GET {url}/v1/proxy/signature/{chatID}?model={model} -> { text, signature }
//   3. verify it as EIP-191 personal_sign against the TEE signer
//   4. compare the signed text with the content we received
// It also fetches the provider's TDX quote ({url}/v1/quote) and checks that its report_data
// commits to the same TEE signer address the contract lists. Full quote verification (Intel
// certificate chain, measured image) is dstack-verifier's job; we record the quote hash so
// anyone can run it.
import { createHash } from 'node:crypto'
import { createPublicClient, getAddress, http, verifyMessage, type Address, type Hex } from 'viem'
import { ZG_NETWORKS, type ZgNetwork } from './zg.ts'

export const inferenceServingAbi = [{
  type: 'function', name: 'getService', stateMutability: 'view',
  inputs: [{ name: 'provider', type: 'address' }],
  outputs: [{ name: 'service', type: 'tuple', components: [
    { name: 'provider', type: 'address' }, { name: 'serviceType', type: 'string' }, { name: 'url', type: 'string' },
    { name: 'inputPrice', type: 'uint256' }, { name: 'outputPrice', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' },
    { name: 'model', type: 'string' }, { name: 'verifiability', type: 'string' }, { name: 'additionalInfo', type: 'string' },
    { name: 'teeSignerAddress', type: 'address' }, { name: 'teeSignerAcknowledged', type: 'bool' },
  ] }],
}] as const

export type ServiceRecord = {
  provider: Address
  url: string
  model: string
  verifiability: string
  teeSignerAddress: Address
  teeSignerAcknowledged: boolean
  /** The address whose signature we expect (TargetTeeAddress for separated decentralized providers). */
  signingAddress: Address
  imageDigest: string | null
  teeVerifier: string | null
  contract: Address
  chainId: number
}

export async function readServiceRecord(provider: Address, network: ZgNetwork = 'mainnet'): Promise<ServiceRecord> {
  const net = ZG_NETWORKS[network]
  const client = createPublicClient({ transport: http(net.rpc, { retryCount: 2, timeout: 20_000 }) })
  const s = await client.readContract({ address: net.inferenceServing, abi: inferenceServingAbi, functionName: 'getService', args: [getAddress(provider)] })
  let info: Record<string, unknown> = {}
  try { info = JSON.parse(s.additionalInfo) } catch { throw new Error(`Provider ${provider} has a malformed additionalInfo on-chain`) }
  const separated = info.TargetSeparated === true && (info.ProviderType ?? 'decentralized') !== 'centralized' && typeof info.TargetTeeAddress === 'string' && info.TargetTeeAddress
  return {
    provider: s.provider, url: s.url.replace(/\/$/, ''), model: s.model, verifiability: s.verifiability,
    teeSignerAddress: s.teeSignerAddress, teeSignerAcknowledged: s.teeSignerAcknowledged,
    signingAddress: separated ? getAddress(info.TargetTeeAddress as string) : s.teeSignerAddress,
    imageDigest: typeof info.ImageDigest === 'string' ? info.ImageDigest : null,
    teeVerifier: typeof info.TEEVerifier === 'string' ? info.TEEVerifier : null,
    contract: net.inferenceServing, chainId: net.chainId,
  }
}

export type QuoteBinding = { quoteSha256: string; reportDataSigner: Address | null; bindsSigner: boolean; hasGpuEvidence: boolean }

/** Fetches the provider's TDX quote and checks report_data commits to the on-chain TEE signer. */
export async function readQuoteBinding(svc: ServiceRecord): Promise<QuoteBinding> {
  const res = await fetch(`${svc.url}/v1/quote`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Provider quote endpoint returned HTTP ${res.status}`)
  const raw = await res.text()
  const q = JSON.parse(raw) as { quote?: string; report_data?: string; nvidia_payload?: unknown }
  if (typeof q.quote !== 'string' || typeof q.report_data !== 'string') throw new Error('Provider quote is missing quote/report_data')
  const decoded = Buffer.from(q.report_data, 'base64').toString('latin1')
  const m = /0x[0-9a-fA-F]{40}/.exec(decoded)
  const reportDataSigner = m ? getAddress(m[0]) : null
  return {
    quoteSha256: createHash('sha256').update(q.quote).digest('hex'),
    reportDataSigner,
    bindsSigner: !!reportDataSigner && reportDataSigner.toLowerCase() === svc.teeSignerAddress.toLowerCase(),
    hasGpuEvidence: !!q.nvidia_payload,
  }
}

export type SignatureCheck = { signatureValid: boolean; signedTextSha256: string; contentMatch: boolean | null; signature: Hex }

/** Fetches the enclave's signature for this chat ID and verifies it against the TEE signer. */
export async function checkResponseSignature(svc: ServiceRecord, chatId: string, content: string): Promise<SignatureCheck> {
  if (!chatId) throw new Error('No chat ID (ZG-Res-Key) to verify')
  const res = await fetch(`${svc.url}/v1/proxy/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(svc.model)}`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Provider signature endpoint returned HTTP ${res.status}`)
  const { text, signature } = await res.json() as { text?: string; signature?: string }
  if (typeof text !== 'string' || typeof signature !== 'string') throw new Error('Provider signature response is missing text/signature')
  const signatureValid = await verifyMessage({ address: svc.signingAddress, message: text, signature: signature as Hex })
  const contentHash = createHash('sha256').update(content).digest('hex')
  // The signed text's exact layout is the provider's (often request and response hashes). We report
  // a match only when the content or its SHA-256 appears in it, and null when we cannot tell.
  const contentMatch = text.includes(content) || text.includes(contentHash) ? true : null
  return { signatureValid, signedTextSha256: createHash('sha256').update(text).digest('hex'), contentMatch, signature: signature as Hex }
}

export type IndependentVerification =
  /** verified: every check ran and passed. failed: a check ran and did not pass. partial: none failed but one could not run. */
  | { status: 'verified' | 'failed' | 'partial'; service: ServiceRecord; quote: QuoteBinding | { error: string }; signature: SignatureCheck | { error: string } }
  | { status: 'unavailable'; error: string }

export async function verifyIndependently(input: { provider: string; chatId: string; content: string }, network: ZgNetwork = 'mainnet'): Promise<IndependentVerification> {
  let service: ServiceRecord
  try { service = await readServiceRecord(input.provider as Address, network) } catch (e) { return { status: 'unavailable', error: (e as Error).message.slice(0, 300) } }
  const [quote, signature] = await Promise.all([
    readQuoteBinding(service).catch(e => ({ error: (e as Error).message.slice(0, 300) })),
    checkResponseSignature(service, input.chatId, input.content).catch(e => ({ error: (e as Error).message.slice(0, 300) })),
  ])
  const failed = ('signatureValid' in signature && !signature.signatureValid) || ('bindsSigner' in quote && !quote.bindsSigner) || service.verifiability !== 'TeeML' || !service.teeSignerAcknowledged
  const complete = 'signatureValid' in signature && 'bindsSigner' in quote
  return { status: failed ? 'failed' : complete ? 'verified' : 'partial', service, quote, signature }
}

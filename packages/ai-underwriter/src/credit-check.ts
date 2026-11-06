// The credit check: wallet-history features -> sealed 0GM-1.0 on 0G Private Computer -> a bounded
// decision with 0G evidence. There is no fallback scorer here. Any failure (no key, API error,
// unverified TEE, bad JSON, a cap broken) returns status "refused" and no terms.
import { keccak256, toHex } from 'viem'
import { canonicalJson, featuresSha256, validateFeatures, type CreditFeatures } from './features.ts'
import { enforcePolicy, policyText, type CreditDecision, type PolicyOptions } from './policy.ts'
import { decisionJsonSchema, parseDecision } from './schema.ts'
import { verifyIndependently, type IndependentVerification } from './verify.ts'
import { chatCompletion, resolveConfig, SetupRequiredError, ZG_NETWORKS, ZgApiError, type ChatMessage, type ZgCompletion, type ZgConfig } from './zg.ts'

export type ZgEvidence = {
  requestId: string
  provider: string
  model: string
  chatId: string
  trustMode: 'private'
  teeVerified: boolean | null
  billingNeuron: ZgCompletion['billingNeuron']
  usage: ZgCompletion['usage']
  responseFormat: ZgCompletion['responseFormat']
  network: string
  independent: IndependentVerification | { status: 'skipped' }
}

/** Terms in the units NorenCredit's EIP-712 CreditAttestation uses (limit in USDG 6-decimal base units). */
export type AttestationTerms = { tier: number; limitUsdg: bigint; collateralRatioBps: number }

export type CreditCheckResult =
  | { status: 'approved' | 'declined'; decision: CreditDecision; terms: AttestationTerms; evidence: ZgEvidence; featuresSha256: string; decisionDigest: `0x${string}`; decidedAt: string }
  | { status: 'refused'; reason: string; setupRequired: boolean; evidence: Partial<ZgEvidence> | null; featuresSha256: string; decidedAt: string }

export type CreditCheckOptions = ZgConfig & PolicyOptions & {
  /** Run the on-chain + enclave signature check ourselves (default true). */
  independentVerification?: boolean
}

const SYSTEM = `You are the credit check for Noren's pay-later credit line on Robinhood Chain.
You receive anonymous wallet-history features (no identity) and return one JSON object:
{"tier": int, "limitUsdg": int, "collateralRatioBps": int, "rationale": string, "riskFlags": [string]}
Policy caps you must stay inside (a decision outside them is rejected):
${policyText()}
Guidance: longer account age, more transactions, larger Stock Token holdings and on-time repayments
support a higher tier, a higher limit and a lower collateral ratio. Late payments and liquidations
lower them. Be conservative when data is missing.
rationale: two short plain-language sentences addressed to the customer, citing the main factors,
no addresses, under 400 characters. riskFlags: up to 5 short labels. Output only the JSON object.`

export function buildMessages(features: CreditFeatures): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Features:\n${canonicalJson(features)}` },
  ]
}

export const toAttestationTerms = (d: CreditDecision): AttestationTerms => ({ tier: d.tier, limitUsdg: BigInt(d.limitUsdg) * 1_000_000n, collateralRatioBps: d.collateralRatioBps })

/** keccak256 over the decision and its 0G request: what the signer logs next to its EIP-712 signature. */
export function decisionDigest(d: CreditDecision, e: Pick<ZgEvidence, 'requestId' | 'provider' | 'chatId' | 'model'>, featuresHash: string): `0x${string}` {
  return keccak256(toHex(canonicalJson({ v: 1, zgRequestId: e.requestId, zgProvider: e.provider.toLowerCase(), zgChatId: e.chatId, model: e.model, tier: d.tier, limitUsdg: d.limitUsdg, collateralRatioBps: d.collateralRatioBps, featuresSha256: featuresHash })))
}

const now = () => new Date().toISOString()
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500)

export async function creditCheck(input: CreditFeatures, opts: CreditCheckOptions = {}): Promise<CreditCheckResult> {
  const features = validateFeatures(input)
  const fHash = featuresSha256(features)
  const cfg = resolveConfig(opts)
  const refuse = (reason: string, evidence: Partial<ZgEvidence> | null = null, setupRequired = false): CreditCheckResult => ({ status: 'refused', reason, setupRequired, evidence, featuresSha256: fHash, decidedAt: now() })
  if (!cfg.apiKey) return refuse(new SetupRequiredError().message, null, true)

  let completion: ZgCompletion
  try { completion = await chatCompletion(buildMessages(features), decisionJsonSchema, opts) } catch (e) {
    const ev = e instanceof ZgApiError && e.requestId ? { requestId: e.requestId } : null
    if (e instanceof SetupRequiredError) return refuse(e.message, ev, true)
    if (e instanceof ZgApiError && e.status === 401) return refuse(`Setup required: ZG_PC_API_KEY was rejected by 0G (${e.message})`, ev, true)
    if (e instanceof ZgApiError && e.status === 402) return refuse(`Setup required: deposit 0G to the account behind ZG_PC_API_KEY at https://pc.0g.ai (${e.message})`, ev, true)
    return refuse(message(e), ev)
  }
  const base: Omit<ZgEvidence, 'independent'> = {
    requestId: completion.requestId, provider: completion.provider, model: completion.model, chatId: completion.chatId,
    trustMode: 'private', teeVerified: completion.teeVerified, billingNeuron: completion.billingNeuron, usage: completion.usage,
    responseFormat: completion.responseFormat, network: cfg.network,
  }
  // The Router's check is tee_verified. `false` means it checked and the signature failed: always refuse.
  // `null` means the Router did not check (seen for some TeeML providers): accept only if OUR independent check fully
  // verifies the enclave signature, the quote binding and a TeeML provider record. Never accept an unproven decision.
  if (completion.teeVerified === false) return refuse('0G reported the provider TEE signature as invalid (tee_verified=false)', base)
  const routerUnverified = completion.teeVerified !== true
  if (routerUnverified && opts.independentVerification === false) return refuse(`0G did not verify the provider's TEE signature (tee_verified=${completion.teeVerified}) and independent verification is off`, base)

  const independent = opts.independentVerification === false ? { status: 'skipped' as const } : await verifyIndependently({ provider: completion.provider, chatId: completion.chatId, content: completion.content }, cfg.network)
  const evidence: ZgEvidence = { ...base, independent }
  if (independent.status === 'failed') return refuse('Independent TEE verification failed: the signature, the quote binding or the provider record did not check out', evidence)
  if (independent.status === 'verified' || independent.status === 'partial') {
    if (independent.service.verifiability !== 'TeeML') return refuse(`Provider is ${independent.service.verifiability}, not TeeML (sealed)`, evidence)
  }
  if (routerUnverified && independent.status !== 'verified') return refuse(`0G did not verify the provider's TEE signature (tee_verified=${completion.teeVerified}) and Noren's independent check was ${independent.status}, not fully verified`, evidence)

  let decision: CreditDecision
  try { decision = enforcePolicy(parseDecision(completion.content), features, opts) } catch (e) { return refuse(message(e), evidence) }
  return {
    status: decision.tier === 0 ? 'declined' : 'approved',
    decision, terms: toAttestationTerms(decision), evidence, featuresSha256: fHash,
    decisionDigest: decisionDigest(decision, evidence, fHash), decidedAt: now(),
  }
}

/** What the Robinhood-side signer writes to its log (and CRE report metadata) next to the EIP-712 signature. */
export function attestationLogEntry(result: Extract<CreditCheckResult, { status: 'approved' | 'declined' }>) {
  const ind = result.evidence.independent
  return {
    zgRequestId: result.evidence.requestId,
    zgProvider: result.evidence.provider,
    zgChatId: result.evidence.chatId,
    zgModel: result.evidence.model,
    zgTeeVerified: result.evidence.teeVerified,
    zgIndependent: ind.status,
    zgServiceContract: 'service' in ind ? ind.service.contract : null,
    zgChainId: ZG_NETWORKS[result.evidence.network as keyof typeof ZG_NETWORKS]?.chainId ?? null,
    decisionDigest: result.decisionDigest,
    featuresSha256: result.featuresSha256,
  }
}

// Structured output for the sealed model: the JSON schema sent as response_format, and a strict
// local validator. The local check runs even when the provider honours the schema, because a
// decision that reaches a signature must be proven well-formed on our side.
import { MAX_COLLATERAL_BPS, MAX_RISK_FLAGS, MAX_TIER, RATIONALE_MAX_CHARS, RISK_FLAG_MAX_CHARS, type CreditDecision } from './policy.ts'

export const decisionJsonSchema = {
  name: 'credit_decision',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['tier', 'limitUsdg', 'collateralRatioBps', 'rationale', 'riskFlags'],
    properties: {
      tier: { type: 'integer', minimum: 0, maximum: MAX_TIER, description: 'Credit tier, 0 declines' },
      limitUsdg: { type: 'integer', minimum: 0, maximum: 10_000, description: 'Credit limit in whole USDG' },
      collateralRatioBps: { type: 'integer', minimum: 0, maximum: MAX_COLLATERAL_BPS, description: 'Collateral ratio in basis points (15000 = 150%)' },
      rationale: { type: 'string', minLength: 1, maxLength: RATIONALE_MAX_CHARS, description: 'Two plain-language sentences for the customer' },
      riskFlags: { type: 'array', maxItems: MAX_RISK_FLAGS, items: { type: 'string', maxLength: RISK_FLAG_MAX_CHARS } },
    },
  },
} as const

export class SchemaError extends Error {
  constructor(message: string) { super(`Model output rejected: ${message}`); this.name = 'SchemaError' }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const ADDRESS = /0x[0-9a-fA-F]{40}/

/** Validates a parsed object against the decision schema. Throws SchemaError on any deviation. */
export function validateDecision(value: unknown): CreditDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SchemaError('expected a JSON object')
  const o = value as Record<string, unknown>
  const keys = Object.keys(o)
  for (const k of keys) if (!(k in decisionJsonSchema.schema.properties)) throw new SchemaError(`unexpected field "${k}"`)
  for (const k of decisionJsonSchema.schema.required) if (!(k in o)) throw new SchemaError(`missing field "${k}"`)
  const { tier, limitUsdg, collateralRatioBps, rationale, riskFlags } = o
  if (!isInt(tier) || tier < 0 || tier > MAX_TIER) throw new SchemaError(`tier must be an integer 0..${MAX_TIER}`)
  if (!isInt(limitUsdg) || limitUsdg < 0 || limitUsdg > 10_000) throw new SchemaError('limitUsdg must be an integer 0..10000')
  if (!isInt(collateralRatioBps) || collateralRatioBps < 0 || collateralRatioBps > MAX_COLLATERAL_BPS) throw new SchemaError(`collateralRatioBps must be an integer 0..${MAX_COLLATERAL_BPS}`)
  if (typeof rationale !== 'string' || !rationale.trim() || rationale.length > RATIONALE_MAX_CHARS) throw new SchemaError(`rationale must be 1..${RATIONALE_MAX_CHARS} characters`)
  if (ADDRESS.test(rationale)) throw new SchemaError('rationale must not contain an address')
  if (!Array.isArray(riskFlags) || riskFlags.length > MAX_RISK_FLAGS || riskFlags.some(f => typeof f !== 'string' || f.length > RISK_FLAG_MAX_CHARS)) throw new SchemaError(`riskFlags must be at most ${MAX_RISK_FLAGS} strings of at most ${RISK_FLAG_MAX_CHARS} characters`)
  return { tier, limitUsdg, collateralRatioBps, rationale: rationale.trim(), riskFlags: riskFlags as string[] }
}

/**
 * Parses the assistant message into a decision. Accepts exactly one JSON object, optionally
 * preceded by a <think>...</think> block or wrapped in one ```json fence. Anything else is refused.
 */
export function parseDecision(content: string): CreditDecision {
  let text = content.trim().replace(/^<think>[\s\S]*?<\/think>\s*/, '')
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text)
  if (fence) text = fence[1].trim()
  if (!text.startsWith('{') || !text.endsWith('}')) throw new SchemaError('expected a single JSON object')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch (e) { throw new SchemaError(`invalid JSON (${(e as Error).message})`) }
  return validateDecision(parsed)
}

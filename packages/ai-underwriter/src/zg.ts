// Typed client for 0G Private Computer (the 0G Compute Router, OpenAI-compatible).
// Docs: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/overview
// Every request pins the private trust tier (TeeML providers only: the model runs inside an
// Intel TDX enclave with TEE GPUs) and asks the Router to verify the provider's TEE signature.

export const ZG_NETWORKS = {
  mainnet: {
    router: 'https://router-api.0g.ai/v1',
    chainId: 16661,
    rpc: 'https://evmrpc.0g.ai',
    explorer: 'https://chainscan.0g.ai',
    /** InferenceServing contract (from @0gfoundation/0g-compute-ts-sdk 0.9.0 CONTRACT_ADDRESSES.mainnet.inference). */
    inferenceServing: '0x47340d900bdFec2BD393c626E12ea0656F938d84',
  },
  testnet: {
    router: 'https://router-api-testnet.integratenetwork.work/v1',
    chainId: 16602,
    rpc: 'https://evmrpc-testnet.0g.ai',
    inferenceServing: '0xa79F4c8311FF93C06b8CfB403690cc987c93F91E',
  },
} as const
export type ZgNetwork = keyof typeof ZG_NETWORKS

/** 0GM-1.0, 0G's in-house model, served by a TeeML provider (verifiability "TeeML", tee_type TDX, verifier dstack). */
export const DEFAULT_MODEL = '0gm-1.0-35b-a3b'
export const TRUST_MODE_HEADER = 'X-0G-Provider-Trust-Mode'

export type ZgConfig = {
  apiKey?: string
  network?: ZgNetwork
  baseUrl?: string
  model?: string
  timeoutMs?: number
  responseFormat?: 'json_schema' | 'json_object'
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type ZgTrace = {
  request_id: string
  provider: string
  billing?: { input_cost?: string; output_cost?: string; total_cost?: string }
  tee_verified?: boolean | null
}

export type ZgCompletion = {
  content: string
  model: string
  /** x_0g_trace.request_id: 0G's ID for this inference. */
  requestId: string
  /** x_0g_trace.provider: on-chain address of the TeeML provider that served it. */
  provider: string
  /** x_0g_trace.tee_verified: the Router's check of the provider's TEE signature. */
  teeVerified: boolean | null
  /** ZG-Res-Key header (falls back to the body id): the chat ID the provider signed. */
  chatId: string
  billingNeuron: { input: string | null; output: string | null; total: string | null }
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null
  responseFormat: 'json_schema' | 'json_object'
}

export class SetupRequiredError extends Error {
  constructor(what = 'ZG_PC_API_KEY') {
    super(`Setup required: ${what} (create a private-mode API key at https://pc.0g.ai -> Dashboard -> API Keys, then put it in the gitignored .env as ZG_PC_API_KEY)`)
    this.name = 'SetupRequiredError'
  }
}

export class ZgApiError extends Error {
  constructor(public status: number, public code: string | undefined, public type: string | undefined, public requestId: string | undefined, message: string) {
    super(`0G Private Computer ${status}${code ? ` ${code}` : ''}: ${message}${requestId ? ` (request ${requestId})` : ''}`)
    this.name = 'ZgApiError'
  }
}

export function resolveConfig(cfg: ZgConfig = {}) {
  const network: ZgNetwork = cfg.network ?? (process.env.ZG_NETWORK === 'testnet' ? 'testnet' : 'mainnet')
  return {
    apiKey: cfg.apiKey ?? process.env.ZG_PC_API_KEY ?? '',
    network,
    baseUrl: (cfg.baseUrl ?? process.env.ZG_PC_BASE_URL ?? ZG_NETWORKS[network].router).replace(/\/$/, ''),
    model: cfg.model ?? process.env.ZG_PC_MODEL ?? DEFAULT_MODEL,
    timeoutMs: cfg.timeoutMs ?? 90_000,
    responseFormat: cfg.responseFormat ?? (process.env.ZG_PC_RESPONSE_FORMAT === 'json_object' ? 'json_object' as const : 'json_schema' as const),
  }
}

/** The exact request sent to 0G. Exposed so tests can prove the private tier and verify_tee are always set. */
export function buildChatRequest(messages: ChatMessage[], cfg: ReturnType<typeof resolveConfig>, schema: object, format = cfg.responseFormat) {
  if (!cfg.apiKey) throw new SetupRequiredError()
  if (!/^sk-/.test(cfg.apiKey)) throw new SetupRequiredError('ZG_PC_API_KEY must be an sk- API key (mk- management keys cannot run inference)')
  return {
    url: `${cfg.baseUrl}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      [TRUST_MODE_HEADER]: 'private',
    },
    body: {
      model: cfg.model,
      messages,
      temperature: 0,
      max_tokens: 800,
      stream: false,
      verify_tee: true,
      chat_template_kwargs: { enable_thinking: false },
      response_format: format === 'json_schema' ? { type: 'json_schema', json_schema: schema } : { type: 'json_object' },
    },
  }
}

async function post(req: ReturnType<typeof buildChatRequest>, timeoutMs: number) {
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { throw new ZgApiError(res.status, undefined, undefined, undefined, `non-JSON response: ${text.slice(0, 200)}`) }
  if (!res.ok || json?.error) {
    const e = json?.error ?? {}
    throw new ZgApiError(res.status, e.code, e.type, json?.request_id ?? json?.x_0g_trace?.request_id, String(e.message ?? text.slice(0, 200)))
  }
  return { res, json }
}

/** One chat completion on 0G Private Computer, private tier, TEE signature verified by the Router. */
export async function chatCompletion(messages: ChatMessage[], schema: object, config: ZgConfig = {}): Promise<ZgCompletion> {
  const cfg = resolveConfig(config)
  let format = cfg.responseFormat
  let out: Awaited<ReturnType<typeof post>>
  try {
    out = await post(buildChatRequest(messages, cfg, schema, format), cfg.timeoutMs)
  } catch (e) {
    // A provider that does not take json_schema answers 400; retry once with json_object. The
    // local validator still enforces the schema, so nothing is loosened.
    if (!(e instanceof ZgApiError && e.status === 400 && format === 'json_schema' && /response_format|json_schema/i.test(e.message))) throw e
    format = 'json_object'
    out = await post(buildChatRequest(messages, cfg, schema, format), cfg.timeoutMs)
  }
  const { res, json } = out
  const trace = json.x_0g_trace as ZgTrace | undefined
  if (!trace?.request_id || !trace.provider) throw new ZgApiError(res.status, 'missing_trace', undefined, undefined, 'response has no x_0g_trace.request_id/provider')
  const content = json.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new ZgApiError(res.status, 'empty_content', undefined, trace.request_id, 'response has no message content')
  return {
    content,
    model: String(json.model ?? cfg.model),
    requestId: trace.request_id,
    provider: trace.provider,
    teeVerified: trace.tee_verified ?? null,
    chatId: res.headers.get('ZG-Res-Key') ?? String(json.id ?? ''),
    billingNeuron: { input: trace.billing?.input_cost ?? null, output: trace.billing?.output_cost ?? null, total: trace.billing?.total_cost ?? null },
    usage: json.usage ?? null,
    responseFormat: format,
  }
}

export type RouterProvider = { address: string; model_id: string; canonical_id: string; verifiability: string; trust_mode?: string; tee_type?: string; tee_verifier?: string; is_healthy?: boolean; tee_acknowledged?: boolean }

/** Public, unauthenticated: the providers the Router lists for a model. */
export async function listProviders(model = DEFAULT_MODEL, network: ZgNetwork = 'mainnet'): Promise<RouterProvider[]> {
  const res = await fetch(`${ZG_NETWORKS[network].router}/providers?model=${encodeURIComponent(model)}`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`0G Router /providers returned HTTP ${res.status}`)
  return ((await res.json()) as { data: RouterProvider[] }).data
}

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { loadEnv } from './env.ts'
import { createCreditServer } from './server.ts'
import { resolveConfig } from './zg.ts'

loadEnv()
const port = Number(process.env.AI_UNDERWRITER_PORT ?? 8740)
if (port < 8740 || port > 8749) throw new Error(`AI_UNDERWRITER_PORT ${port} is outside the 8740-8749 block`)
const decisionsPath = process.env.AI_UNDERWRITER_DECISIONS ?? resolve(fileURLToPath(new URL('.', import.meta.url)), '../data/decisions.jsonl')
const server = createCreditServer({ decisionsPath, robinhoodUnderwriterUrl: process.env.ROBINHOOD_UNDERWRITER_URL ?? 'http://127.0.0.1:8721' })
server.listen(port, '127.0.0.1', () => {
  const cfg = resolveConfig()
  console.log(`Noren credit check (0G Private Computer, ${cfg.model}, private tier) on http://127.0.0.1:${port}`)
  if (!cfg.apiKey) console.log('Setup required: ZG_PC_API_KEY is not set; credit checks will be refused until it is.')
})

// Loads gitignored .env files (package first, then the repo root) without printing anything.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function loadEnv() {
  const here = fileURLToPath(new URL('.', import.meta.url))
  for (const p of [resolve(here, '../.env'), resolve(here, '../../../.env')]) if (existsSync(p)) process.loadEnvFile(p)
}

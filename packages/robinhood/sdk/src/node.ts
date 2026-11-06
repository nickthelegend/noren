import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { NorenAddresses } from './addresses.js'

export function loadForkDeployment(path = resolve(fileURLToPath(new URL('../../.fork/deployment.json', import.meta.url)))): NorenAddresses {
  try { return JSON.parse(readFileSync(path, 'utf8')) as NorenAddresses }
  catch { throw new Error('Setup required: sh scripts/fork.sh && sh scripts/deploy-fork.sh') }
}

/**
 * NOREN_WORLD_ATTESTER_KEY from the environment, else from the main checkout's gitignored .env
 * (NOREN_ENV_FILE overrides the path). Returns undefined when neither has it; never logs the value.
 */
export function loadWorldAttesterKey(envFile = process.env.NOREN_ENV_FILE): `0x${string}` | undefined {
  const fromEnv = process.env.NOREN_WORLD_ATTESTER_KEY
  if (fromEnv) return fromEnv as `0x${string}`
  const candidates = envFile ? [envFile] : [resolve(fileURLToPath(new URL('../../../../.env', import.meta.url))), mainCheckoutEnv()].filter(Boolean) as string[]
  for (const p of candidates) {
    try {
      const m = readFileSync(p, 'utf8').match(/^NOREN_WORLD_ATTESTER_KEY=(0x[0-9a-fA-F]{64})\s*$/m)
      if (m) return m[1] as `0x${string}`
    } catch {}
  }
  return undefined
}

function mainCheckoutEnv(): string | undefined {
  try {
    // a git worktree's .git file points at <main>/.git/worktrees/<name>
    const dotGit = readFileSync(resolve(fileURLToPath(new URL('../../../../.git', import.meta.url))), 'utf8')
    const m = dotGit.match(/^gitdir: (.+)\/\.git\/worktrees\/[^/]+\s*$/m)
    return m ? resolve(m[1], '.env') : undefined
  } catch {
    return undefined
  }
}

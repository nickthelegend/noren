import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { NorenAddresses } from './addresses.js'

export function loadForkDeployment(path = resolve(fileURLToPath(new URL('../../.fork/deployment.json', import.meta.url)))): NorenAddresses {
  try { return JSON.parse(readFileSync(path, 'utf8')) as NorenAddresses }
  catch { throw new Error('Setup required: sh scripts/fork.sh && sh scripts/deploy-fork.sh') }
}

// Reads the Reclaim proofs the Noren server verified (packages/server/src/reclaim.ts writes them). Only the proof
// identifier and provider reach the score; the store holds no raw values.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OffchainProof } from './score.js'

export const reclaimStorePath = () => process.env.NOREN_RECLAIM_STORE ?? resolve(fileURLToPath(new URL('../../../../data/reclaim-proofs.json', import.meta.url)))

export async function offchainProofOf(address: string, file = reclaimStorePath()): Promise<OffchainProof | null> {
  let rows: { address: string; proofId: string; provider: { name: string } }[]
  try {
    rows = JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`Reclaim proof store unreadable (${file}): ${(e as Error).message}`)
  }
  const r = rows.find((x) => x.address === address.toLowerCase())
  return r ? { provider: r.provider.name, proofId: r.proofId } : null
}

// Decision log. Each line holds the decision, the 0G request ID and the verification evidence,
// plus a SHA-256 of the features. The features themselves are never written.
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CreditCheckResult } from './credit-check.ts'

export type StoredDecision = CreditCheckResult & { subject: string | null }

const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x)

/** The record Noren keeps. `subject` is the borrower address when the caller supplied one (it is never sent to 0G). */
export function toStoredDecision(result: CreditCheckResult, subject: string | null = null): StoredDecision {
  return { ...result, subject }
}

export async function appendDecision(path: string, record: StoredDecision) {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, json(record) + '\n')
}

export async function readDecisions(path: string, limit = 50): Promise<StoredDecision[]> {
  let raw = ''
  try { raw = await readFile(path, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  return raw.trim().split('\n').filter(Boolean).slice(-limit).reverse().map(l => JSON.parse(l))
}

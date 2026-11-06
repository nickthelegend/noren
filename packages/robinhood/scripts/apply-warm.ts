// Persist the real mainnet state read by Warm.s.sol into a temporary Anvil fork so that
// anvil's state dump contains it. Input: forge script output with WARM_ACCOUNT / WARM_SLOT lines.
//   tsx scripts/apply-warm.ts <forge-output.txt> <rpc-url>
// Values come from the fork itself (which fetched them from Robinhood mainnet at the fork block);
// nothing is invented. Only for local forks.
import { readFileSync } from 'node:fs'

const [file, rpc] = process.argv.slice(2)
if (!file || !rpc || !/^http:\/\/127\.0\.0\.1:\d+$/.test(rpc)) {
  console.error('usage: tsx scripts/apply-warm.ts <forge-output.txt> http://127.0.0.1:<port>')
  process.exit(1)
}

const slots = new Map<string, { account: string; slot: string; value: string }>()
const accounts = new Set<string>()
for (const line of readFileSync(file, 'utf8').split('\n')) {
  const t = line.trim().split(/\s+/)
  if (t[0] === 'WARM_ACCOUNT') accounts.add(t[1].toLowerCase())
  if (t[0] === 'WARM_SLOT') {
    const key = `${t[1].toLowerCase()}:${t[2]}`
    if (!slots.has(key)) slots.set(key, { account: t[1], slot: t[2], value: t[3] }) // first access = pre-state
    accounts.add(t[1].toLowerCase())
  }
}
if (slots.size === 0) throw new Error('No WARM_SLOT lines found: did Warm.s.sol run?')

let id = 0
async function batch(calls: { method: string; params: unknown[] }[]): Promise<any[]> {
  const out: any[] = []
  for (let i = 0; i < calls.length; i += 200) {
    const body = calls.slice(i, i + 200).map((c) => ({ jsonrpc: '2.0', id: ++id, ...c }))
    const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = (await res.json()) as { id: number; result?: unknown; error?: { message: string } }[]
    json.sort((a, b) => a.id - b.id)
    for (const r of json) {
      if (r.error) throw new Error(`RPC error: ${r.error.message}`)
      out.push(r.result)
    }
  }
  return out
}

const list = [...accounts]
const [codes, balances, nonces] = await Promise.all([
  batch(list.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] }))),
  batch(list.map((a) => ({ method: 'eth_getBalance', params: [a, 'latest'] }))),
  batch(list.map((a) => ({ method: 'eth_getTransactionCount', params: [a, 'latest'] }))),
])
const writes: { method: string; params: unknown[] }[] = []
list.forEach((a, i) => {
  if (codes[i] && codes[i] !== '0x') writes.push({ method: 'anvil_setCode', params: [a, codes[i]] })
  if (balances[i] && balances[i] !== '0x0') writes.push({ method: 'anvil_setBalance', params: [a, balances[i]] })
  if (nonces[i] && nonces[i] !== '0x0') writes.push({ method: 'anvil_setNonce', params: [a, nonces[i]] })
})
for (const s of slots.values()) writes.push({ method: 'anvil_setStorageAt', params: [s.account, s.slot, s.value] })
await batch(writes)
console.error(`Persisted ${list.length} accounts and ${slots.size} storage slots of real mainnet state`)

import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMerchantServer } from './server.ts';
import { AuthState, hashSecret } from './auth.ts';
import { findStoreBySecret, mayAct, newSecretKey, validateMetadata, validateRedirect, type Store, type StoreKey } from './stores.ts';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const client = createPublicClient({ transport: http('http://127.0.0.1:1') });
const now = Date.now();
const auth = () => new AuthState(client, 5042002, ['localhost:5190'], () => now);
async function signed(state: AuthState, options: { domain?: string; chainId?: number; issuedAt?: Date; expirationTime?: Date } = {}) {
  const message = createSiweMessage({ address: account.address, chainId: options.chainId ?? 5042002, domain: options.domain ?? 'localhost:5190', nonce: state.nonce(), uri: 'http://localhost:5190', version: '1', issuedAt: options.issuedAt ?? new Date(now), expirationTime: options.expirationTime });
  return { message, signature: await account.signMessage({ message }) };
}
describe('SIWE and merchant credentials (offline)', () => {
  it('accepts a real EOA signature, hashes sessions, and consumes the nonce', async () => { const state = auth(); const input = await signed(state); const result = await state.siwe(input.message, input.signature); expect(result.session).toMatch(/^sess_[0-9a-f]{64}$/); expect(state.sessions[0].hash).toBe(hashSecret(result.session)); expect(state.address(result.session)).toBe(account.address); await expect(state.siwe(input.message, input.signature)).rejects.toThrow(/nonce/); state.logout(result.session); expect(state.address(result.session)).toBeUndefined(); });
  it('rejects wrong domain and chain', async () => { const a = auth(); await expect(a.siwe(...Object.values(await signed(a, { domain: 'evil.example' })) as [string, `0x${string}`])).rejects.toThrow(/domain/); const b = auth(); const input = await signed(b, { chainId: 1 }); await expect(b.siwe(input.message, input.signature)).rejects.toThrow(/chain/); });
  it('rejects expired messages and stale issuedAt', async () => { const a = auth(); const expired = await signed(a, { expirationTime: new Date(now - 1000) }); await expect(a.siwe(expired.message, expired.signature)).rejects.toThrow(/expired/); const b = auth(); const stale = await signed(b, { issuedAt: new Date(now - 601_000) }); await expect(b.siwe(stale.message, stale.signature)).rejects.toThrow(/issuedAt/); });
  it('expires sessions', async () => { const state = auth(); state.sessions = [{ hash: hashSecret('sess_old'), address: account.address, expiresAt: Math.floor(now / 1000) - 1 }]; expect(state.address('sess_old')).toBeUndefined(); });
  it('hashes and scopes secret keys, then revokes immediately', () => { const { secretKey, key: newKey } = newSecretKey(); const key: StoreKey = newKey; const merchantA = `0x${'aa'.repeat(20)}` as Address, merchantB = `0x${'bb'.repeat(20)}` as Address; const a = { merchant: merchantA, owner: account.address, keys: [key] } as Store; const b = { merchant: merchantB, owner: account.address, keys: [] } as unknown as Store; expect(key.hash).toBe(hashSecret(secretKey)); expect(findStoreBySecret([a, b], secretKey)).toBe(a); expect(mayAct({ kind: 'store', store: a }, merchantB, [a, b])).toBe(false); key.revokedAt = Math.floor(now / 1000); expect(findStoreBySecret([a, b], secretKey)).toBeUndefined(); });
  it('validates redirects and metadata', () => { expect(validateRedirect('https://shop.example/done', 'successUrl')).toBe('https://shop.example/done'); expect(() => validateRedirect('javascript:alert(1)', 'successUrl')).toThrow(/InvalidRedirect/); expect(() => validateRedirect('/relative', 'cancelUrl')).toThrow(/InvalidRedirect/); expect(validateMetadata({ orderId: '123' })).toEqual({ orderId: '123' }); expect(() => validateMetadata({ 'bad-key': 'x' })).toThrow(/InvalidMetadata/); expect(() => validateMetadata({ x: 123 })).toThrow(/InvalidMetadata/); });
  it('returns 403 for another store and 401 after key revocation, without RPC', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noren-auth-')), dataFile = join(dir, 'invoices.json');
    const { secretKey, key: newKey } = newSecretKey(); const key: StoreKey = newKey;
    const addrA = `0x${'aa'.repeat(20)}`, addrB = `0x${'bb'.repeat(20)}`;
    const stores = [{ id: 'st_' + '1'.repeat(16), owner: account.address, name: 'A', payout: addrA, merchant: addrA, relayerKey: `0x${'11'.repeat(32)}`, publishableKey: 'pk_test_' + '1'.repeat(32), keys: [key], createdAt: 1, registerTx: `0x${'11'.repeat(32)}` }, { id: 'st_' + '2'.repeat(16), owner: account.address, name: 'B', payout: addrB, merchant: addrB, relayerKey: `0x${'22'.repeat(32)}`, publishableKey: 'pk_test_' + '2'.repeat(32), keys: [], createdAt: 1, registerTx: `0x${'22'.repeat(32)}` }];
    await writeFile(dataFile + '.stores.json', JSON.stringify(stores));
    const server = createMerchantServer({ dataFile, rpcUrl: 'http://127.0.0.1:1', deployment: { chainId: 5042002 } as any });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try { const port = (server.address() as any).port; const call = (address: string) => fetch(`http://127.0.0.1:${port}/merchants/${address}/events`, { headers: { authorization: `Bearer ${secretKey}` } }); expect((await call(addrA)).status).toBe(200); expect((await call(addrB)).status).toBe(403); key.revokedAt = Math.floor(now / 1000); stores[0].keys = [key]; await writeFile(dataFile + '.stores.json', JSON.stringify(stores)); /* a new process loads the revoked sidecar */ }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    const restarted = createMerchantServer({ dataFile, rpcUrl: 'http://127.0.0.1:1', deployment: { chainId: 5042002 } as any });
    await new Promise<void>(resolve => restarted.listen(0, '127.0.0.1', resolve));
    try { const response = await fetch(`http://127.0.0.1:${(restarted.address() as any).port}/merchants/${addrA}/events`, { headers: { authorization: `Bearer ${secretKey}` } }); expect(response.status).toBe(401); }
    finally { await new Promise<void>(resolve => restarted.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
  });
});

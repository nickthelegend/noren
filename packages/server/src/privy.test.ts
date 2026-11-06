// MIT
// Offline: claim and binding checks, with an ES256 key pair made here and served to jose as a local key set.
// privy.live.test.ts runs the same verifier against Privy's real JWKS endpoint for the configured app.
import { describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPrivyToken } from './privy.ts';
import { AuthState } from './auth.ts';
import { createMerchantServer } from './server.ts';

const APP = 'cmtestnorenapp000000000000';
const DID = 'did:privy:cmtestuser0000000000000000';
const now = Date.now();
async function keySet() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'noren-test', alg: 'ES256', use: 'sig' };
  return { privateKey, keys: createLocalJWKSet({ keys: [jwk] }) };
}
const token = (key: CryptoKey, claims: { iss?: string; aud?: string; sub?: string; exp?: number } = {}) =>
  new SignJWT({ sid: 'session-1' }).setProtectedHeader({ alg: 'ES256', kid: 'noren-test', typ: 'JWT' })
    .setIssuer(claims.iss ?? 'privy.io').setAudience(claims.aud ?? APP).setSubject(claims.sub ?? DID)
    .setIssuedAt(Math.floor(now / 1000) - 10).setExpirationTime(claims.exp ?? Math.floor(now / 1000) + 3600).sign(key);

describe('Privy access token verification (offline key set)', () => {
  it('accepts a token signed by the key set, for this app, from privy.io', async () => {
    const { privateKey, keys } = await keySet();
    const c = await verifyPrivyToken(await token(privateKey), keys, APP, () => now);
    expect(c.userId).toBe(DID); expect(c.sessionId).toBe('session-1');
  });
  it('rejects another app, another issuer, an expired token and a non-Privy subject', async () => {
    const { privateKey, keys } = await keySet();
    await expect(verifyPrivyToken(await token(privateKey, { aud: 'other-app' }), keys, APP, () => now)).rejects.toThrow(/PrivyInvalid: token is for another Privy app/);
    await expect(verifyPrivyToken(await token(privateKey, { iss: 'evil.example' }), keys, APP, () => now)).rejects.toThrow(/PrivyInvalid: token was not issued by Privy/);
    await expect(verifyPrivyToken(await token(privateKey, { exp: Math.floor(now / 1000) - 5 }), keys, APP, () => now)).rejects.toThrow(/PrivyInvalid: access token expired/);
    await expect(verifyPrivyToken(await token(privateKey, { sub: 'user-1' }), keys, APP, () => now)).rejects.toThrow(/PrivyInvalid: subject is not a Privy user/);
  });
  it('rejects a token signed by a different key and malformed input', async () => {
    const { keys } = await keySet(); const other = await keySet();
    await expect(verifyPrivyToken(await token(other.privateKey), keys, APP, () => now)).rejects.toThrow(/PrivyInvalid: signature does not match/);
    await expect(verifyPrivyToken('not-a-jwt', keys, APP)).rejects.toThrow(/malformed/);
    await expect(verifyPrivyToken(undefined, keys, APP)).rejects.toThrow(/missing or malformed/);
  });
});

describe('Sign in with Privy: token plus a wallet signature bound to the Privy user', () => {
  const wallet = privateKeyToAccount(`0x${'42'.repeat(32)}`);
  const client = createPublicClient({ transport: http('http://127.0.0.1:1') });
  const state = () => new AuthState(client, 5042002, ['localhost:5190'], () => now);
  const signed = async (a: AuthState, resources: string[]) => {
    const message = createSiweMessage({ address: wallet.address, chainId: 5042002, domain: 'localhost:5190', nonce: a.nonce(), uri: 'http://localhost:5190', version: '1', issuedAt: new Date(now), resources });
    return { message, signature: await wallet.signMessage({ message }) };
  };
  it('issues a merchant session for the signing wallet', async () => {
    const { privateKey, keys } = await keySet(); const verifier = { verify: (t: unknown) => verifyPrivyToken(t, keys, APP, () => now) };
    const a = state(); const s = await signed(a, [DID]);
    const r = await a.privy(verifier, await token(privateKey), s.message, s.signature);
    expect(r.address).toBe(wallet.address); expect(r.via).toBe('privy'); expect(r.privyUserId).toBe(DID);
    expect(a.address(r.session)).toBe(wallet.address); expect(a.sessions[0].privyUserId).toBe(DID);
  });
  it('rejects a signature bound to another Privy user, a bad token, and a server without PRIVY_APP_ID', async () => {
    const { privateKey, keys } = await keySet(); const verifier = { verify: (t: unknown) => verifyPrivyToken(t, keys, APP, () => now) };
    const a = state(); const other = await signed(a, ['did:privy:someoneelse0000000000000']);
    await expect(a.privy(verifier, await token(privateKey), other.message, other.signature)).rejects.toThrow(/not bound to this Privy user/);
    const b = state(); const s = await signed(b, [DID]);
    await expect(b.privy(verifier, 'eyJhbGciOiJFUzI1NiJ9.e30.c2ln', s.message, s.signature)).rejects.toThrow(/PrivyInvalid/);
    expect(b.sessions).toHaveLength(0);
    await expect(state().privy(null, await token(privateKey), s.message, s.signature)).rejects.toThrow(/Setup required: PRIVY_APP_ID/);
  });
  it('serves GET/POST /auth/privy: setup state, 401 on a bad token, 503 when unconfigured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noren-privy-'));
    const prev = process.env.PRIVY_APP_ID; delete process.env.PRIVY_APP_ID;
    const on = createMerchantServer({ dataFile: join(dir, 'a.json'), rpcUrl: 'http://127.0.0.1:1', deployment: { chainId: 5042002 } as any, privyAppId: APP });
    const off = createMerchantServer({ dataFile: join(dir, 'b.json'), rpcUrl: 'http://127.0.0.1:1', deployment: { chainId: 5042002 } as any });
    if (prev !== undefined) process.env.PRIVY_APP_ID = prev;
    await Promise.all([on, off].map((s) => new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok))));
    const url = (s: typeof on, p: string) => `http://127.0.0.1:${(s.address() as any).port}${p}`;
    try {
      expect(await (await fetch(url(on, '/auth/privy'))).json()).toEqual({ configured: true });
      expect((await (await fetch(url(off, '/auth/privy'))).json()).error).toMatch(/Setup required: PRIVY_APP_ID/);
      const bad = await fetch(url(on, '/auth/privy'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessToken: 'nope', message: 'x', signature: '0x' }) });
      expect(bad.status).toBe(401); expect((await bad.json()).error).toMatch(/PrivyInvalid/);
      const unconfigured = await fetch(url(off, '/auth/privy'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessToken: 'nope', message: 'x', signature: '0x' }) });
      expect(unconfigured.status).toBe(503);
    } finally { await Promise.all([on, off].map((s) => new Promise<void>((ok) => s.close(() => ok())))); await rm(dir, { recursive: true, force: true }); }
  });
});

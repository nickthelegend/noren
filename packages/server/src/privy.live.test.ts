// MIT
// Live: fetches the configured Privy app's real public JWKS from auth.privy.io and checks that the verifier rejects
// tokens it did not sign. Needs PRIVY_APP_ID (read from the worktree's or main checkout's .env; never printed).
// Run: pnpm exec vitest run packages/server/src/privy.live.test.ts
import { describe, expect, it } from 'vitest';
import { SignJWT, generateKeyPair, decodeProtectedHeader } from 'jose';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPrivyVerifier, privyJwksUrl } from './privy.ts';

function loadEnv() {
  if (process.env.PRIVY_APP_ID) return;
  let main: string | null = null;
  try { main = resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim(), '..', '.env'); } catch { /* not a git checkout */ }
  for (const f of ['.env', main]) if (f && existsSync(f)) { process.loadEnvFile(f); break; }
}
loadEnv();
const APP = process.env.PRIVY_APP_ID;
if (!APP) throw new Error('Setup required: PRIVY_APP_ID (in the gitignored .env) for the live Privy JWKS test');

describe('Privy JWKS (live, auth.privy.io)', () => {
  it("publishes this app's ES256 verification keys", async () => {
    const r = await fetch(privyJwksUrl(APP));
    expect(r.status).toBe(200);
    const { keys } = (await r.json()) as { keys: { kty: string; crv: string; alg?: string; kid?: string }[] };
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) { expect(k.kty).toBe('EC'); expect(k.crv).toBe('P-256'); }
  });
  it("rejects a token with Privy's claims and kid but not signed by Privy", async () => {
    const { keys } = (await (await fetch(privyJwksUrl(APP))).json()) as { keys: { kid: string }[] };
    const { privateKey } = await generateKeyPair('ES256');
    const forged = await new SignJWT({ sid: 'forged' }).setProtectedHeader({ alg: 'ES256', kid: keys[0].kid, typ: 'JWT' })
      .setIssuer('privy.io').setAudience(APP).setSubject('did:privy:forged000000000000000000').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    expect(decodeProtectedHeader(forged).kid).toBe(keys[0].kid);
    await expect(createPrivyVerifier(APP)!.verify(forged)).rejects.toThrow(/PrivyInvalid: signature does not match/);
  });
  it('rejects a token for an unknown kid, a malformed token and an unsigned (alg none) token', async () => {
    const v = createPrivyVerifier(APP)!;
    const { privateKey } = await generateKeyPair('ES256');
    const unknownKid = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'not-a-privy-kid' }).setIssuer('privy.io').setAudience(APP).setSubject('did:privy:x').setExpirationTime('1h').sign(privateKey);
    await expect(v.verify(unknownKid)).rejects.toThrow(/PrivyInvalid/);
    await expect(v.verify('garbage')).rejects.toThrow(/PrivyInvalid: access token missing or malformed/);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    await expect(v.verify(`${b64({ alg: 'none' })}.${b64({ iss: 'privy.io', aud: APP, sub: 'did:privy:x', exp: 9e9 })}.`)).rejects.toThrow(/PrivyInvalid/);
  });
  it('fails loudly for an app ID Privy does not know', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const t = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k' }).setIssuer('privy.io').setAudience('cm0000000000000000000000x').setSubject('did:privy:x').setExpirationTime('1h').sign(privateKey);
    await expect(createPrivyVerifier('cm0000000000000000000000x')!.verify(t)).rejects.toThrow(/PrivyUnavailable/);
  });
});

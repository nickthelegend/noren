// MIT
/**
 * Privy access-token verification without the app secret: Privy signs access tokens (ES256 JWTs) with a per-app key
 * and publishes the public half at https://auth.privy.io/api/v1/apps/<appId>/jwks.json. A token is accepted only if
 * its signature checks against that key set, it was issued by "privy.io" for this app (aud = app ID) and it is unexpired.
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const PRIVY_ISSUER = 'privy.io';
export const privyJwksUrl = (appId: string) => `https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}/jwks.json`;
export type PrivyClaims = { userId: string; sessionId: string | null; issuedAt: number; expiresAt: number };

/** Verifies a Privy access token against a key set. Throws "PrivyInvalid: <reason>" on any failure. */
export async function verifyPrivyToken(token: unknown, keys: JWTVerifyGetKey, appId: string, now = () => Date.now()): Promise<PrivyClaims> {
  if (typeof token !== 'string' || token.split('.').length !== 3) throw new Error('PrivyInvalid: access token missing or malformed');
  try {
    const { payload } = await jwtVerify(token, keys, { issuer: PRIVY_ISSUER, audience: appId, algorithms: ['ES256'], currentDate: new Date(now()) });
    if (typeof payload.sub !== 'string' || !payload.sub.startsWith('did:privy:')) throw new Error('subject is not a Privy user');
    return { userId: payload.sub, sessionId: typeof payload.sid === 'string' ? payload.sid : null, issuedAt: payload.iat ?? 0, expiresAt: payload.exp ?? 0 };
  } catch (e) {
    if (e instanceof errors.JWTExpired) throw new Error('PrivyInvalid: access token expired');
    if (e instanceof errors.JWTClaimValidationFailed) throw new Error(`PrivyInvalid: ${e.claim === 'aud' ? 'token is for another Privy app' : e.claim === 'iss' ? 'token was not issued by Privy' : `bad ${e.claim} claim`}`);
    if (e instanceof errors.JWSSignatureVerificationFailed || e instanceof errors.JWKSNoMatchingKey) throw new Error('PrivyInvalid: signature does not match this app\'s Privy key');
    if (e instanceof errors.JWKSTimeout || e instanceof errors.JWKSInvalid || (e instanceof errors.JOSEError && /JSON Web Key Set/i.test(e.message)) || (e instanceof TypeError && /fetch/i.test(e.message)))
      throw new Error(`PrivyUnavailable: couldn't load Privy's public keys for this app (${(e as Error).message})`);
    throw new Error(`PrivyInvalid: ${(e as Error).message}`);
  }
}

/** A verifier bound to one Privy app, fetching (and caching) that app's public JWKS. Null when PRIVY_APP_ID isn't set. */
export function createPrivyVerifier(appId: string | undefined, jwksUrl = appId ? privyJwksUrl(appId) : '') {
  if (!appId) return null;
  const keys = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 8000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
  return { appId, jwksUrl, verify: (token: unknown) => verifyPrivyToken(token, keys, appId) };
}
export type PrivyVerifier = NonNullable<ReturnType<typeof createPrivyVerifier>>;

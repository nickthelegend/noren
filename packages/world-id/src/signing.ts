import { signRequest, computeRpSignatureMessage } from '@worldcoin/idkit-core/signing';
import { REQUEST_TTL_SECONDS } from './config.ts';

export type RpContextSigned = { nonce: string; created_at: number; expires_at: number; signature: string };

/**
 * Signs a World ID 4.0 proof request on the server with the RP signing key (EIP-191 over
 * version || nonce || created_at || expires_at || hash_to_field(action), per the RP signature spec).
 * The key never leaves this function; errors never include it.
 */
export function signNorenRequest(signingKey: string | undefined, action: string, ttl = REQUEST_TTL_SECONDS): RpContextSigned {
  if (!signingKey) throw new Error('Setup required: WORLD_RP_SIGNING_KEY');
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(signingKey)) throw new Error('WORLD_RP_SIGNING_KEY must be a 32-byte hex key');
  if (!action) throw new Error('action is required for a uniqueness request');
  const { sig, nonce, createdAt, expiresAt } = signRequest({ signingKeyHex: signingKey, action, ttl });
  return { nonce, created_at: createdAt, expires_at: expiresAt, signature: sig };
}

export { computeRpSignatureMessage };

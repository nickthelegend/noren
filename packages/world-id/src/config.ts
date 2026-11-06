import type { WorldCredential, WorldEnvironment } from './types.ts';

/** The one action Noren uses. One World ID nullifier per human per action = one starter line per human. */
export const NOREN_CREDIT_ACTION = 'noren-credit';
/** 25 USDC (6 decimals). Why this number: docs/WORLD.md, "Starter limit". */
export const DEFAULT_STARTER_LIMIT_USDC6 = 25_000_000n;
/** Hard ceiling the server refuses to go above, whatever the env says. */
export const MAX_STARTER_LIMIT_USDC6 = 100_000_000n;
export const DEFAULT_STARTER_DAYS = 30;
/** RP signature lifetime (World ID default). */
export const REQUEST_TTL_SECONDS = 300;
export const DEFAULT_VERIFY_BASE = 'https://developer.world.org';

export type WorldIdConfig = {
  appId?: `app_${string}`;
  rpId?: string;
  /** Server-only. Never sent to the client, never logged. */
  signingKey?: string;
  action: string;
  environment: WorldEnvironment;
  credential: WorldCredential;
  verifyBase: string;
  starterLimitUsdc6: bigint;
  starterDays: number;
};

const CREDENTIALS: WorldCredential[] = ['selfie', 'proof_of_human', 'passport'];

/**
 * Reads the World ID settings from the environment (names only; values live in the gitignored .env):
 *   WORLD_APP_ID          app_... from the Developer Portal
 *   WORLD_RP_ID           rp_...  from the Developer Portal (World ID 4.0)
 *   WORLD_RP_SIGNING_KEY  the RP signing key (hex), server only
 *   WORLD_ENVIRONMENT     production (default, real World App) | staging (World ID Simulator)
 *   WORLD_CREDENTIAL      selfie (default) | proof_of_human | passport
 *   NOREN_STARTER_LIMIT_USDC6, NOREN_STARTER_DAYS
 */
export function loadWorldIdConfig(env: Record<string, string | undefined> = process.env): WorldIdConfig {
  const environment = (env.WORLD_ENVIRONMENT ?? 'production') as WorldEnvironment;
  if (environment !== 'production' && environment !== 'staging') throw new Error('WORLD_ENVIRONMENT must be production or staging');
  const credential = (env.WORLD_CREDENTIAL ?? 'selfie') as WorldCredential;
  if (!CREDENTIALS.includes(credential)) throw new Error(`WORLD_CREDENTIAL must be one of ${CREDENTIALS.join(', ')}`);
  const appId = env.WORLD_APP_ID?.trim() || undefined;
  if (appId && !/^app_[A-Za-z0-9_]+$/.test(appId)) throw new Error('WORLD_APP_ID must look like app_...');
  const rpId = env.WORLD_RP_ID?.trim() || undefined;
  if (rpId && !/^rp_[A-Za-z0-9_]+$/.test(rpId)) throw new Error('WORLD_RP_ID must look like rp_...');
  const limit = BigInt(env.NOREN_STARTER_LIMIT_USDC6 ?? DEFAULT_STARTER_LIMIT_USDC6);
  if (limit <= 0n || limit > MAX_STARTER_LIMIT_USDC6) throw new Error(`NOREN_STARTER_LIMIT_USDC6 must be 1..${MAX_STARTER_LIMIT_USDC6}`);
  const days = Number(env.NOREN_STARTER_DAYS ?? DEFAULT_STARTER_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('NOREN_STARTER_DAYS must be 1..365');
  return {
    appId: appId as `app_${string}` | undefined,
    rpId,
    signingKey: env.WORLD_RP_SIGNING_KEY?.trim() || undefined,
    action: NOREN_CREDIT_ACTION,
    environment,
    credential,
    verifyBase: env.WORLD_VERIFY_BASE?.trim() || DEFAULT_VERIFY_BASE,
    starterLimitUsdc6: limit,
    starterDays: days,
  };
}

/** Names of the settings still missing (never their values). */
export function missingSettings(cfg: WorldIdConfig): string[] {
  const missing: string[] = [];
  if (!cfg.appId) missing.push('WORLD_APP_ID');
  if (!cfg.rpId) missing.push('WORLD_RP_ID');
  if (!cfg.signingKey) missing.push('WORLD_RP_SIGNING_KEY');
  return missing;
}

export const setupRequired = (missing: string[]) =>
  `Setup required: ${missing.join(', ')} (create a World Developer Portal app with action "${NOREN_CREDIT_ACTION}"; see docs/WORLD.md)`;

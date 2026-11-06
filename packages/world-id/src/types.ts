// Shared types for Noren's World ID check. Browser-safe: no Node imports.

/** The World ID credentials Noren can ask for. `selfie` is the default (see docs/WORLD.md for why). */
export type WorldCredential = 'selfie' | 'proof_of_human' | 'passport';
export type WorldEnvironment = 'production' | 'staging';

/** What the Noren server sends the app so it can open IDKit. Contains no secret. */
export type HumanRequest = {
  app_id: `app_${string}`;
  action: string;
  environment: WorldEnvironment;
  credential: WorldCredential;
  /** The wallet the proof is bound to. IDKit hashes it into the proof's signal; the server checks the hash. */
  signal: string;
  rp_context: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };
  starterLimitUsdc6: string;
};

/** Where the starter credit line write to Arc stands. */
export type StarterLine =
  | { status: 'submitted'; lineId: `0x${string}`; limitUsdc6: string; expiry: number; txHash: `0x${string}` }
  | { status: 'setup_required'; lineId: `0x${string}`; limitUsdc6: string; expiry: number; detail: string }
  | { status: 'failed'; lineId: `0x${string}`; limitUsdc6: string; expiry: number; detail: string };

/**
 * Every way "prove you're human" can end. The server returns all of these except `cancelled` and
 * `unavailable`, which only the app can see (the person closed World ID, or has no such credential).
 */
export type VerifyHumanResult =
  | { status: 'verified'; credential: WorldCredential; nullifier: `0x${string}`; starter: StarterLine }
  | { status: 'already_used'; detail: string }
  | { status: 'invalid'; code: string; detail: string }
  | { status: 'expired'; detail: string }
  | { status: 'cancelled'; detail: string }
  | { status: 'unavailable'; code: string; detail: string }
  | { status: 'setup_required'; detail: string }
  | { status: 'error'; code: string; detail: string };

export type VerifyHumanStatus = VerifyHumanResult['status'];

/** GET /world-id/status/:wallet */
export type HumanStatus =
  | { verified: false }
  | { verified: true; credential: WorldCredential; verifiedAt: number; starter: StarterLine };

/** GET /world-id/config */
export type WorldConfigInfo = {
  configured: boolean;
  missing: string[];
  action: string;
  environment: WorldEnvironment;
  credential: WorldCredential;
  starterLimitUsdc6: string;
  starterDays: number;
  starterSink: 'cre-simulate' | 'none';
};

export const HTTP_STATUS: Record<VerifyHumanStatus, number> = {
  verified: 200, already_used: 409, invalid: 400, expired: 410, cancelled: 400, unavailable: 400, setup_required: 503, error: 502,
};

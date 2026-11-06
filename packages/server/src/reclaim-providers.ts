/**
 * The Reclaim providers Noren offers under "Raise your limit", grouped by what they prove. Provider IDs are public
 * (Reclaim's provider catalogue); the app ID and secret are not and stay in the gitignored .env. RECLAIM_PROVIDER_IDS
 * ("label:id,label:id") replaces an ID per label; RECLAIM_PROVIDER_ID is the default one shown first.
 *
 * Boost per verified proof on the history underwriter's score (documented in docs/RECLAIM.md), capped at
 * RECLAIM_MAX_POINTS in total: a credit score counts most, exchange KYC and balances are medium, identity is small.
 */
export type ReclaimGroup = 'credit-score' | 'kyc' | 'balance' | 'identity';
export type ReclaimProvider = { label: string; id: string; name: string; group: ReclaimGroup; points: number };

export const GROUP_POINTS: Record<ReclaimGroup, number> = { 'credit-score': 15, kyc: 8, balance: 8, identity: 3 };
export const GROUP_TITLE: Record<ReclaimGroup, string> = { 'credit-score': 'Credit score', kyc: 'Exchange KYC', balance: 'Balances', identity: 'Identity' };
export const RECLAIM_MAX_POINTS = 20;

const P = (label: string, id: string, name: string, group: ReclaimGroup): ReclaimProvider => ({ label, id, name, group, points: GROUP_POINTS[group] });
/** Public provider IDs (Reclaim catalogue, Nov 6 2026). Names are Noren's plain labels for each provider. */
export const DEFAULT_PROVIDERS: ReclaimProvider[] = [
  P('credit_score_bankbazaar', '047db3af-9f36-4e73-bb93-ed762b9e2094', 'Credit Score - Bank Bazaar (Experian India)', 'credit-score'),
  P('credit_score_experian_us', '8149b711-aff6-4882-a98e-036253d52129', 'Experian credit score (US)', 'credit-score'),
  P('credit_karma', 'add9a3cc-a13e-4572-818d-62446bcae8ef', 'Credit Karma score', 'credit-score'),
  P('binance_kyc', '2b22db5c-78d9-4d82-84f0-a9e0a4ed0470', 'Binance KYC', 'kyc'),
  P('coinbase_kyc', '285a345c-c6a6-4b9f-9e1e-23432082c0a8', 'Coinbase KYC', 'kyc'),
  P('coinbase_assets', 'f7a26442-ba57-416d-a303-18baec555b13', 'Coinbase assets', 'balance'),
  P('binance_balance', 'aeeb5c0e-a9df-4eed-ab68-87e127c9dd1b', 'Binance balance', 'balance'),
  P('bofa_balance', '831f6210-015d-458a-b0aa-accf9b76694c', 'Bank of America balance', 'balance'),
  P('wise_balance', 'fbe865ee-ad0d-4e59-88bc-10352dcc0427', 'Wise balance', 'balance'),
  P('github', '6d3f6753-7ee6-49ee-a545-62f1b1822ae5', 'GitHub account', 'identity'),
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The catalogue with env overrides applied; the default provider (RECLAIM_PROVIDER_ID) first. */
export function reclaimProviders(env: { RECLAIM_PROVIDER_ID?: string; RECLAIM_PROVIDER_IDS?: string }): ReclaimProvider[] {
  const list = DEFAULT_PROVIDERS.map((p) => ({ ...p }));
  for (const pair of (env.RECLAIM_PROVIDER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [label, id] = pair.split(':').map((s) => s.trim());
    const known = list.find((p) => p.label === label);
    if (known && id && UUID.test(id)) known.id = id;
  }
  const def = env.RECLAIM_PROVIDER_ID?.trim();
  const i = def ? list.findIndex((p) => p.id === def) : -1;
  if (i > 0) list.unshift(...list.splice(i, 1));
  return list;
}

/**
 * The minimal claim Noren keeps: a coarse statement computed from the proved values in memory, then discarded.
 * Credit scores round down to 50 points, balances to a power of ten; KYC and identity keep only that they hold.
 */
export function minimalStatement(group: ReclaimGroup, params: Record<string, unknown>): string {
  const nums = Object.entries(params).map(([k, v]) => [k, Number(String(v).replace(/[^0-9.]/g, ''))] as const).filter(([, n]) => Number.isFinite(n) && n > 0);
  if (group === 'credit-score') {
    const s = nums.find(([k]) => /score/i.test(k)) ?? nums[0];
    return s ? `credit score ≥ ${Math.floor(s[1] / 50) * 50}` : 'credit score proved';
  }
  if (group === 'balance') {
    const b = nums.find(([k]) => /bal|amount|asset|total|value/i.test(k)) ?? nums[0];
    return b && b[1] >= 1 ? `balance ≥ ${(10 ** Math.floor(Math.log10(b[1]))).toLocaleString('en-US')}` : 'balance proved';
  }
  if (group === 'kyc') return 'KYC level ≥ 1';
  return 'account exists';
}

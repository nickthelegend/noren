/**
 * The Tsuke calls that depend on contracts and services owned by other packages:
 * - packages/tsuke: underwriter (EIP-712 attestation) and TsukeCredit's lock/open/schedule functions
 * - packages/arc-credit: NorenCreditLine's per-line view
 * Until those land on this branch every call fails with "Setup required", so the page never shows invented numbers.
 */
import type { Hex } from "viem";
import type { Config } from "./api";
import type { Holding, Line, Tsuke } from "./tsuke";

export type Underwriting = { tier: string; tierIndex: number; tiers: { name: string }[]; ltvBps: number; factors: { label: string; value: string; note?: string }[]; signer: string; expires?: number };
export type Quote = { collateral8: bigint; ltvBps: number; limitUsdc6: bigint; installments: number; termDays: number; liquidation8?: bigint };
export type Position = { live: boolean; closed: boolean; limit: bigint; expiry: number; drawn: bigint; repaid: bigint; updatedAt: number; available: bigint };

const pending = (what: string) => Promise.reject(new Error(`Setup required: ${what}`));

export function tsukeActions(_cfg: Config, _tk: Tsuke) {
  return {
    underwrite: (): Promise<Underwriting> => pending("the Tsuke underwriter isn't running (packages/tsuke)"),
    quote: (_s: Holding, _amount: string): Promise<Quote> => pending("TsukeCredit isn't deployed on the Robinhood fork (packages/tsuke)"),
    open: (_s: Holding, _amount: string): Promise<string> => pending("TsukeCredit isn't deployed on the Robinhood fork (packages/tsuke)"),
    arcLine: (lineId: Hex): Promise<Position> => _tk.arcLine(lineId),
    schedule: (_line: Line): Promise<{ due: number; amount: bigint; paid: boolean }[]> => pending("TsukeCredit's installment schedule isn't available (packages/tsuke)"),
  };
}

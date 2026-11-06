/** Earn: deposit into a NorenDepositVault (ERC-4626 receipt shares) that backs its own 1inch Aqua maker; withdraw with realised yield. */
import type { Wallet } from "./NorenApp";
import { Card, SetupCard } from "./kit";

export function EarnTab({ w }: { w: Wallet }) {
  const vaults = w.oc.credit?.depositVaults as unknown[] | undefined;
  return (
    <div className="nk-col">
      <Card title="Earn" sub="Deposit stock, ETH or USDG. Your deposit backs a 1inch Aqua maker; its spread is your yield." pill={<span className="nk-pill">Robinhood Chain</span>}>
        <div className="nk-pad">
          {!vaults?.length && <SetupCard title="The deposit vaults aren't deployed on this stack" text="NorenDepositVault (per-asset ERC-4626 vaults with receipt shares) isn't in this stack's config yet. Deposits, receipts and realised yield appear here once it is; nothing is shown in their place." />}
        </div>
        <button className="nk-cta" disabled>Deposit</button>
      </Card>
    </div>
  );
}

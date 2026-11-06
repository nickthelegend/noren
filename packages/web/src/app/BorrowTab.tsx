/** Borrow: lock deposit shares and borrow USDG at your reputation LTV; Chainlink prices the collateral. */
import type { Wallet } from "./NorenApp";
import { Card, SetupCard } from "./kit";

export function BorrowTab({ w }: { w: Wallet }) {
  const borrow = w.oc.credit?.borrow as string | undefined;
  return (
    <div className="nk-col">
      <Card title="Borrow" sub="USDG against your deposits, priced by Chainlink" pill={<span className="nk-pill">Robinhood Chain</span>}>
        <div className="nk-pad">
          {!borrow && <SetupCard title="NorenBorrow isn't deployed on this stack" text="Borrowing against deposit shares (LTV from your reputation tier, health factor, liquidation price) appears here once NorenBorrow is in this stack's config. Nothing is shown in its place." />}
        </div>
        <button className="nk-cta" disabled>Borrow</button>
      </Card>
    </div>
  );
}

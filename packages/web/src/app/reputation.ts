/** Reputation milestones from NorenReputation (earn-borrow). Until it is deployed on this stack, the card says so. */
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { msgOf } from "../ui";
import type { Wallet } from "./NorenApp";
import { readReputation, type Milestone } from "./earn";

export function useReputation(w: Wallet, nonce: number): { items: Milestone[] | null; error: string | null; source: string } {
  const addr = (w.oc.credit?.reputation as Address | undefined) ?? null;
  const [items, setItems] = useState<Milestone[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!addr) { setError("NorenReputation isn't deployed on this stack yet (it comes with the Earn and Borrow contracts). Milestones appear here once it is; nothing is shown in their place."); return; }
    let on = true;
    readReputation(w, addr).then((r) => on && (setItems(r), setError(null))).catch((e) => on && setError(msgOf(e)));
    return () => { on = false; };
  }, [addr, w.tick, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  return { items, error, source: addr ? "NorenReputation on Robinhood Chain: each milestone raises your LTV tier" : "NorenReputation on Robinhood Chain" };
}

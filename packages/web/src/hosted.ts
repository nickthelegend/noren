/**
 * Hosted build (Vercel, public Arc testnet). Set at build time:
 *   VITE_NOREN_HOSTED=1, VITE_NOREN_SURFACE=merchant|app, VITE_NOREN_MERCHANT_URL, VITE_NOREN_APP_URL, VITE_NOREN_SHOP_URL.
 * The merchant surface (Noren Merchant) owns #/dashboard; the app surface owns the landing (#/) and the Noren app (#/app).
 * Checkout (#/pay/<id>) and transaction pages (#/tx/...) work on both.
 */
export const HOSTED = import.meta.env.VITE_NOREN_HOSTED === "1";
export const SURFACE = ((import.meta.env.VITE_NOREN_SURFACE as string | undefined) ?? "all") as "merchant" | "app" | "all";
export const MERCHANT_URL = ((import.meta.env.VITE_NOREN_MERCHANT_URL as string | undefined) ?? "").replace(/\/+$/, "");
export const APP_URL = ((import.meta.env.VITE_NOREN_APP_URL as string | undefined) ?? "").replace(/\/+$/, "");
export const SHOP_URL = ((import.meta.env.VITE_NOREN_SHOP_URL as string | undefined) ?? "").replace(/\/+$/, "");

export const README_URL = "https://github.com/nickthelegend/noren#readme";
export const CIRCLE_FAUCET_URL = "https://faucet.circle.com";
export const FORK_NOTICE = "Runs on the local Robinhood mainnet snapshot: see the demo video and README";

/** Which surface owns a hash route; null when it works on both (checkout, tx pages, in-page anchors). */
const ownerOf = (hash: string): "merchant" | "app" | null => {
  if (/^#\/(dashboard|merchant)\b/.test(hash)) return "merchant";
  if (/^#\/(app|credit)\b/.test(hash) || hash === "#/" || hash === "#" || hash === "") return "app";
  return null;
};

/** A link to `route`: the plain hash on the surface that owns it, an absolute URL to the other Vercel project otherwise. */
export function surfaceHref(route: string): string {
  const owner = ownerOf(route);
  if (SURFACE === "all" || !owner || owner === SURFACE) return route;
  const base = owner === "merchant" ? MERCHANT_URL : APP_URL;
  return base ? `${base}/${route}` : route;
}

// Dry run against the hosted deployment: loads each surface with the injected test wallet and prints what the takes
// will look for. Records nothing.
import { chromium } from "playwright";
import { installWallet } from "./wallet.mjs";
const S = "/private/tmp/claude-501/-Volumes-Extreme-SSD-Projects-grokbot/e39dcfb4-756b-4b8b-8ac3-212b41325e21/scratchpad/probe";
const b = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=1"] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
const w = await installWallet(ctx, { net: "live", log: () => {} });
console.log("wallet", w.address);
const p = await ctx.newPage();
const look = async (name, url, wait = 8000) => {
  await p.goto(url); await p.waitForTimeout(wait);
  await p.screenshot({ path: `${S}-${name}.png` });
  const t = (await p.locator("body").innerText()).replace(/\n+/g, " | ");
  console.log(`== ${name}: ${t.slice(0, 600)}`);
  return t;
};
await look("merchant", "https://noren-merchant.vercel.app/#/dashboard/onboard");
await look("app", "https://noren-app-beta.vercel.app/#/app");
await look("landing", "https://noren-app-beta.vercel.app/#/", 5000);
const shop = await look("shop", "https://noren-shop.vercel.app/#/", 5000);
await look("dresses", "https://noren-shop.vercel.app/#/c/dresses", 4000).catch(() => {});
const prices = await p.evaluate(() => [...document.querySelectorAll("a.card")].map((a) => [a.getAttribute("href"), a.innerText.replace(/\n+/g, " ")]).slice(0, 40));
console.log("cards", JSON.stringify(prices).slice(0, 2000));
await b.close();

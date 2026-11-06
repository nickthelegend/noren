/**
 * Noren film takes, recorded live against `pnpm dev:all` (local Arc testnet fork + Robinhood Chain mainnet snapshot)
 * and the public Arc testnet explorer. Nothing here is replayed or edited: each take drives the real UI and the
 * Chrome DevTools screencast writes every painted frame to disk; ffmpeg turns the frames into takes/<take>.mp4.
 *
 *   node record.mjs landing     the Noren website
 *   node record.mjs onboard     Noren Merchant: sign in with a wallet, create a store, first payment link, API keys
 *   node record.mjs app         the Noren app: faucet, Earn, Swap (fills the vault's Aqua maker), Borrow, Bridge
 *   node record.mjs credit      the Noren app, same wallet: lock 1 NVDA, the signed terms, the line bridged to Arc by CRE
 *   node record.mjs shop        Aubelle: browse, add a dress, the integration file, checkout, pay with stocks
 *   ORDER=AUB-x node record.mjs order   the shop's order page: paid, confirmed by a signed Noren webhook
 *   node record.mjs private     the store's payment link, paid privately from the Kohaku pool
 *   node record.mjs explorer    the live Arc testnet payment and refund on the public explorer
 *   node record.mjs later       a second payment link paid in 3 from the credit line, then the first repayment
 *   node record.mjs world       the World ID card; waits (up to WORLD_WAIT_MIN minutes) for a real World App verification
 *
 * Takes after `landing` share one browser profile (state/state.json): the same customer key, merchant session and
 * private notes, as one person would have. The credit line is opened exactly once (`credit`): that is the one paid 0G call.
 * Each take also writes takes/<take>.events.json (clicks, typing, results) used to place sound on visible actions.
 */
import { chromium } from "playwright";
import { mkdirSync, existsSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const take = process.argv[2];
const HERE = fileURLToPath(new URL(".", import.meta.url));
const TAKES = `${HERE}takes/`, STATE = `${HERE}state/state${process.env.WALLET_KEY ? "-" + process.env.WALLET_KEY.replace(/[^a-z0-9-]/gi, "") : ""}.json`;
mkdirSync(TAKES, { recursive: true }); mkdirSync(`${HERE}state`, { recursive: true });
// v6 records the hosted deployment: NOREN_APP_URL / NOREN_SHOP_URL / NOREN_SERVER_URL (defaults: the local dev stack)
const APP = (process.env.NOREN_APP_URL ?? "http://localhost:5190").replace(/\/$/, ""), SHOP = (process.env.NOREN_SHOP_URL ?? "http://127.0.0.1:8780").replace(/\/$/, ""), SERVER = (process.env.NOREN_SERVER_URL ?? "http://127.0.0.1:8790").replace(/\/$/, "");
// Noren Merchant and the hosted checkout can live on their own origin (NOREN_MERCHANT_URL), apart from the app
const MERCH = (process.env.NOREN_MERCHANT_URL ?? APP).replace(/\/$/, "");
const appUrlRe = new RegExp("^" + APP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/#/pay/");
const ARC_EXPLORER = "https://explorer.testnet.arc.io";
const LIVE_PAY = "0x1ce6858a82a86d309d41f4639d9c958a3d50a82804ed6b2efc7d82435780776a";
const LIVE_REFUND = "0x890ab6a618a3caf187eb26a3071660ef2f2f2d8de9298b8c71658f66c2ee016a";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const VIEW = { width: 1280, height: 720 }, DSF = 1.5; // a 1280x720 layout painted at 1920x1080 (browser scale 150%)

// A visible pointer (headless Chrome draws none) and a ring on each press. It changes no text on the page.
const CURSOR = () => {
  const mk = () => {
    if (document.getElementById("__nc")) return;
    const c = document.createElement("div"); c.id = "__nc";
    c.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform";
    c.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))"><path d="M2 2 L2 21 L7.2 16.4 L10.6 24 L14 22.5 L10.7 15 L18 15 Z" fill="#fff" stroke="#14213d" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const at = (x, y) => { c.style.transform = `translate(${x - 2}px,${y - 2}px)`; try { sessionStorage.setItem("__nc", JSON.stringify([x, y])); } catch {} };
    try { const s = JSON.parse(sessionStorage.getItem("__nc") ?? "null"); if (s) at(s[0], s[1]); else at(-50, -50); } catch { at(-50, -50); }
    addEventListener("mousemove", (e) => at(e.clientX, e.clientY), true);
    addEventListener("mousedown", (e) => {
      const r = document.createElement("div");
      r.style.cssText = `position:fixed;left:${e.clientX - 18}px;top:${e.clientY - 18}px;width:36px;height:36px;border-radius:50%;border:2px solid #e8643c;z-index:2147483646;pointer-events:none;transition:transform .45s ease-out,opacity .45s ease-out;transform:scale(.3);opacity:1`;
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = "scale(1.4)"; r.style.opacity = "0"; });
      setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", mk); else mk();
};

// The World ID take runs in a visible window, so the QR code can be scanned from the Mac's screen.
const b = await chromium.launch({ headless: take !== "world", ...(take === "world" ? { channel: "chrome" } : {}), args: ["--hide-scrollbars", `--force-device-scale-factor=${DSF}`] });
const ctx = await b.newContext({ viewport: VIEW, ...(take !== "landing" && existsSync(STATE) ? { storageState: STATE } : {}) });
// WALLET=fork|live injects the film's test wallet (wallet.mjs: EIP-1193 + EIP-6963, key kept in Node)
const TW = process.env.WALLET ? await (await import("./wallet.mjs")).installWallet(ctx, { net: process.env.WALLET, log }) : null;
if (TW) log("test wallet (injected)", TW.address);
await ctx.addInitScript(CURSOR);
const p = await ctx.newPage();
p.on("dialog", (d) => { log("dialog refused:", d.message()); d.dismiss(); }); // never accept a paid 0G re-check

// ---- camera: DevTools screencast -> JPEG frames -> mp4 (constant 30 fps, each frame held until the next paint)
const events = []; let t0 = 0, frames = [], dir = "", cdp;
const T = () => (Date.now() - t0) / 1000;
const ev = (type, label, extra = {}) => { events.push({ t: +T().toFixed(3), type, label, ...extra }); };
async function rollCamera() {
  dir = `${TAKES}${take}.frames/`; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  cdp = await ctx.newCDPSession(p);
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const n = frames.length; frames.push(metadata.timestamp);
    writeFileSync(`${dir}${String(n).padStart(6, "0")}.jpg`, Buffer.from(data, "base64"));
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: VIEW.width * DSF, maxHeight: VIEW.height * DSF, everyNthFrame: 1 });
  t0 = Date.now(); ev("start", take);
}
async function cut() {
  ev("end", take);
  await sleep(400); await cdp.send("Page.stopScreencast").catch(() => {});
  const wall0 = t0 / 1000; // screencast timestamps are wall-clock seconds
  const list = frames.map((ts, i) => {
    const next = i + 1 < frames.length ? frames[i + 1] : Date.now() / 1000;
    return `file '${String(i).padStart(6, "0")}.jpg'\nduration ${Math.max(0.001, next - ts).toFixed(4)}`;
  });
  const lead = frames.length ? Math.max(0, frames[0] - wall0) : 0;
  writeFileSync(`${dir}list.txt`, list.join("\n") + `\nfile '${String(frames.length - 1).padStart(6, "0")}.jpg'\n`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${dir}list.txt`, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "17", `${TAKES}${take}.mp4`]);
  writeFileSync(`${TAKES}${take}.events.json`, JSON.stringify({ take, lead: +lead.toFixed(3), frames: frames.length, view: VIEW, dsf: DSF, events }, null, 1));
  rmSync(dir, { recursive: true, force: true });
  log("saved", `${take}.mp4`, frames.length, "frames,", T().toFixed(1), "s");
}

const until = async (fn, what, ms = 180000) => { const s = Date.now(); while (Date.now() - s < ms) { try { const v = await fn(); if (v) return v; } catch { /* keep waiting */ } await sleep(500); } throw new Error(`timed out waiting for ${what}`); };
// ---- hands: a moving pointer, human-paced clicks and typing; every action is logged with its time in the take
let mx = VIEW.width / 2, my = VIEW.height / 2;
// every pointer move is logged (CSS px of the 1280x720 view) so the edit can drive a camera that follows the cursor
async function moveTo(x, y, steps = 22) { const from = t0 ? T() : null; await p.mouse.move(x, y, { steps }); mx = x; my = y; if (t0) ev("move", "pointer", { x: Math.round(x), y: Math.round(y), from }); }
// The apps have fixed headers (~80 px): anything under them, or near the bottom edge, is scrolled to the middle first.
async function point(loc) {
  await loc.scrollIntoViewIfNeeded();
  let r = await loc.boundingBox(); if (!r) throw new Error("not visible");
  if (r.y < 90 || r.y + Math.min(r.height, 120) > VIEW.height - 12) {
    await loc.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "smooth" })); await sleep(900);
    r = await loc.boundingBox(); if (!r) throw new Error("not visible");
  }
  await moveTo(r.x + r.width / 2, r.y + Math.min(r.height / 2, 60)); return r;
}
async function click(loc, label, hold = 350) { await until(() => loc.isEnabled(), `${label} enabled`, 120000); await point(loc); await sleep(hold); ev("click", label); await p.mouse.down(); await sleep(70); await p.mouse.up(); await sleep(250); }
async function typeIn(loc, text, label) { await click(loc, `focus ${label}`); await loc.press("ControlOrMeta+A"); await loc.press("Backspace"); ev("type", label, { text }); await p.keyboard.type(text, { delay: 85 }); await sleep(300); }
async function scrollBy(dy, ms = 900) { const n = Math.max(1, Math.round(ms / 30)); ev("scroll", String(dy)); for (let i = 0; i < n; i++) { await p.mouse.wheel(0, dy / n); await sleep(30); } }
const status = (scope = ".nk-col") => p.locator(`${scope} [role=status]`).first().innerText().catch(() => "");
const result = (label, value) => { ev("result", label, { value }); log(label, value); };
async function save() { await ctx.storageState({ path: STATE }); }

// Privy is a third-party sign-in that only Nick completes: open its modal, hold it on camera, close it, never log in.
async function privyGlimpse(button, hold = 2200) {
  await click(button, "sign in with Privy");
  const modal = p.getByText("Sign in to Noren", { exact: true });
  const shown = await until(() => modal.isVisible(), "Privy modal", 15000).then(() => true).catch(() => false);
  if (!shown) { ev("privy-missing", "Privy modal did not open"); log("Privy modal did not open on this origin"); await p.keyboard.press("Escape").catch(() => {}); await sleep(800); return false; }
  ev("privy-modal", "Privy modal open"); await sleep(hold);
  ev("privy-close", "Privy modal closed (not signed in)");
  await p.keyboard.press("Escape"); await sleep(900);
  if (await modal.isVisible().catch(() => false)) { const x = p.locator("[aria-label*='close' i]").first(); if (await x.count()) await x.click().catch(() => {}); await sleep(900); }
}

try {
  // ---------------------------------------------------------------- v3 takes (one browser profile, state/state.json)
  if (take === "merchant3") {
    // Noren Merchant onboarding with the injected test wallet: Browser wallet -> SIWE (signed in Node) -> business ->
    // payouts -> first payment link -> API keys. Needs WALLET=fork (or live). The secret key is redacted in the edit.
    if (!TW) throw new Error("merchant3 needs WALLET=fork");
    await p.goto(`${MERCH}/#/dashboard/onboard`); await sleep(3500);
    await moveTo(900, 420, 1);
    await rollCamera(); await sleep(1500);
    await privyGlimpse(p.getByRole("button", { name: /Sign in with Privy/ }));
    const bw = p.getByRole("button", { name: /Test wallet \(injected\)/ });
    await until(() => bw.isVisible(), "the injected wallet in the EIP-6963 list", 20000);
    result("browser wallet option", (await bw.innerText()).replace(/\n+/g, " | "));
    await click(bw, "browser wallet");
    await until(() => p.getByText("What's your business called?").isVisible(), "signed in with the injected wallet", 60000);
    result("signed in", await p.locator(".ob-who").innerText().catch(() => ""));
    await sleep(900);
    await typeIn(p.locator(".ob-field input").first(), "Juhu Chai House", "business name");
    await click(p.getByRole("button", { name: /Continue/ }), "continue"); await sleep(1200);
    await click(p.getByRole("radio", { name: /USDC on Arc to my wallet/ }), "payout to my wallet"); await sleep(600);
    await click(p.getByRole("button", { name: /Create store/ }), "create store");
    await until(() => p.getByText("Create your first payment link").isVisible(), "store created", 90000);
    result("store", await p.locator(".ob-card p").first().innerText()); await sleep(1200);
    if (process.env.LINK_AMOUNT) await typeIn(p.locator(".ob-field input").nth(0), process.env.LINK_AMOUNT, "amount");
    await typeIn(p.locator(".ob-field input").nth(1), "Masala chai for the team", "description");
    await click(p.getByRole("button", { name: /Create link/ }), "create link");
    await until(() => p.locator(".ob-link").isVisible(), "link", 60000);
    const link = await p.locator(".ob-url").innerText(); result("link", link); await sleep(2000);
    writeFileSync(`${HERE}state/link-merchant3.txt`, link);
    await click(p.getByRole("button", { name: /^Continue/ }), "continue to keys"); await sleep(1200);
    await point(p.locator(".ob-keys")); await sleep(2500);
    await scrollBy(320, 1200); await sleep(2000);
    await cut(); await save();
  }

  if (take === "applogin3") {
    // The Noren app signed out: Privy shown, then "Use a browser wallet" -> the injected test wallet -> Home
    await p.goto(`${APP}/#/app`); await sleep(6000);
    await moveTo(640, 360, 1);
    await rollCamera(); await sleep(1500);
    result("signin", (await p.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 300));
    await privyGlimpse(p.locator(".nk-signin .nk-cta").first());
    await click(p.getByRole("button", { name: /Use a browser wallet/ }), "use a browser wallet"); await sleep(1500);
    await click(p.getByRole("button", { name: /Connect Test wallet \(injected\)/ }), "connect the injected wallet");
    await until(async () => /TOTAL BALANCE|Total balance/i.test(await p.locator("main").innerText()), "home", 60000); await sleep(3500);
    result("home", (await p.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 400));
    await cut(); await save();
  }

  if (take === "appsetup3") {
    // Off camera: connect the injected wallet if signed out, then fork faucets to its address (Robinhood stock/ETH/USDG, Arc USDC)
    await p.goto(`${APP}/#/app`); await sleep(7000);
    if (await p.getByRole("button", { name: /Use a browser wallet/ }).isVisible().catch(() => false)) {
      if (TW) {
        await p.getByRole("button", { name: /Use a browser wallet/ }).click(); await sleep(1500);
        await p.getByRole("button", { name: /Connect Test wallet \(injected\)/ }).click();
      } else {
        // the app's own test wallet (a key kept in this browser), which every checkout method uses on the forks
        await p.getByRole("button", { name: /Use a test wallet/ }).click();
      }
      await until(async () => /TOTAL BALANCE/i.test(await p.locator("main").innerText()), "home", 60000); await sleep(2000);
    }
    await p.locator(".nk-chip").click(); await sleep(1500);
    const rhF = p.getByRole("button", { name: /Get test stock/ });
    if (await rhF.count()) { await rhF.first().click(); await until(async () => /faucet|moved|sent/i.test(await p.locator(".nk-menu [role=status]").innerText()), "robinhood faucet", 180000).catch(() => log("robinhood faucet: no status")); }
    const arcF = p.getByRole("button", { name: /Get test USDC \(Arc fork\)/ });
    if (await arcF.count()) { await arcF.first().click(); await until(async () => /Arc fork faucet/.test(await p.locator(".nk-menu [role=status]").innerText()), "arc faucet", 60000).catch(() => {}); }
    log("faucets", (await p.locator(".nk-menu").innerText()).replace(/\n+/g, " | ").slice(0, 300));
    log("address", (await p.locator(".nk-menu-row span").first().innerText()).trim()); await save();
  }

  if (take === "apphome3") {
    // Home at full width, then Pay: paste the merchant's link, pay privately (shielding from the wallet if needed)
    const link = (await import("node:fs")).readFileSync(`${HERE}state/link-merchant3.txt`, "utf8").trim();
    await p.goto(`${APP}/#/app`); await sleep(8000);
    await moveTo(700, 200, 1);
    await rollCamera(); await sleep(2500);
    result("home", (await p.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 500));
    await moveTo(300, 250, 25); await sleep(700); await moveTo(560, 300, 25); await sleep(700);
    await scrollBy(420, 1300); await sleep(1800); await scrollBy(-420, 900); await sleep(600);
    await click(p.locator(".nk-actions button").first(), "pay action"); await sleep(1500);
    await click(p.locator("#nk-paylink"), "focus link");
    ev("type", "paste invoice link", { text: link }); await p.locator("#nk-paylink").fill(link); await sleep(2500);
    const top = p.getByRole("button", { name: /Shield [\d.]+ USDC from your wallet|Add [\d.]+ test USDC privately/ });
    if (await top.count() && await top.first().isVisible()) {
      await click(top.first(), "shield 20 USDC");
      await until(async () => !(await p.locator(".nk-paycard .nk-cta").isDisabled()), "private balance ready", 240000); await sleep(1200);
    }
    result("pay panel", (await p.locator(".nk-paycard").innerText()).replace(/\n+/g, " | ").slice(0, 400));
    await click(p.locator(".nk-paycard .nk-cta"), "pay privately");
    await until(async () => /Paid privately/.test(await p.locator(".nk-paycard").innerText()), "paid privately", 240000); await sleep(1500);
    result("private paid", (await p.locator(".nk-paycard").innerText()).replace(/\n+/g, " | ").slice(0, 400)); await sleep(4000);
    await cut(); await save();
  }

  if (take === "selfrepay3") {
    // Loans that pay themselves down (fork): deposit 1 ETH (Aqua liquidity), lock it, borrow 500 USDG, the demo
    // trader's real Aqua fills earn fees, "Use earnings to pay down loan" lowers the debt.
    await p.goto(`${APP}/#/app/earn`); await sleep(8000);
    await moveTo(640, 300, 1);
    await rollCamera(); await sleep(1800);
    const ne = p.getByRole("radio", { name: /nETH/ });
    if (await ne.count()) { await click(ne.first(), "nETH vault"); await sleep(1500); }
    await typeIn(p.locator("#nk-earn"), "0.9", "deposit amount"); await sleep(1000);
    await click(p.locator(".nk-cta").first(), "deposit");
    await until(async () => /Deposited|reverted|rror/.test(await status()), "deposit", 180000); result("deposit", await status()); await sleep(1500);
    await point(p.locator(".nk-aqua").first()); await sleep(2500);
    result("aqua maker", (await p.locator(".nk-aqua").first().innerText()).replace(/\n+/g, " | ").slice(0, 600));
    await click(p.getByRole("tab", { name: "Borrow" }), "borrow tab"); await sleep(5000);
    const row = p.locator(".nk-items li", { hasText: "nETH" }).first();
    await typeIn(row.locator("input"), "0.9", "lock amount");
    await click(row.getByRole("button", { name: "Lock", exact: true }), "lock");
    await until(async () => /Locked|reverted|rror/.test(await status()), "lock", 180000); result("lock", await status());
    await scrollBy(-600, 600); await sleep(2500);
    await typeIn(p.locator("#nk-borrow"), "500", "borrow amount"); await sleep(1200);
    await click(p.locator(".nk-cta").first(), "borrow");
    await until(async () => /Borrowed|reverted|rror/.test(await status()), "borrow", 180000); result("borrow", await status()); await sleep(2000);
    const card = p.locator("section, .nk-card", { hasText: "Your collateral keeps earning" }).last();
    await point(card); await sleep(1000);
    await until(async () => /from [3-9] Aqua fills|from \d{2} Aqua fills/.test(await card.innerText()), "three demo fills", 180000).catch(() => log("fewer than 3 fills shown"));
    await sleep(2000);
    result("earning", (await card.innerText()).replace(/\n+/g, " | ").slice(0, 600));
    const use = card.getByRole("button", { name: /Use earnings to pay down loan/ });
    await point(use); await sleep(1200);
    await click(use, "use earnings to pay down loan");
    await until(async () => /Paid [\d.]+ USDG from \d+ Aqua fill|reverted|rror/.test(await card.innerText()), "pay down", 120000); await sleep(2000);
    result("paid down", (await card.innerText()).replace(/\n+/g, " | ").slice(0, 700));
    await scrollBy(-500, 1000); await sleep(2500);
    result("position", (await p.locator("main").innerText()).match(/Health[\s\S]{0,200}/i)?.[0]?.replace(/\n+/g, " | "));
    await sleep(2000);
    await cut(); await save();
  }

  if (take === "setup3") {
    // Off camera, nothing recorded: a store with a 12.50 link (Noren Merchant), then the same browser as the customer
    // with the fork faucets. Prints the test key's public address (for scripts/live/fund-test-key.ts).
    await p.goto(`${MERCH}/#/dashboard/onboard`); await sleep(3000);
    await p.getByRole("button", { name: /Use a test wallet/ }).click();
    await until(() => p.getByText("What's your business called?").isVisible(), "signed in");
    await p.locator(".ob-field input").first().fill("Juhu Chai House");
    await p.getByRole("button", { name: /Continue/ }).click(); await sleep(1000);
    await p.getByRole("radio", { name: /USDC on Arc to my wallet/ }).click();
    await p.getByRole("button", { name: /Create store/ }).click();
    await until(() => p.getByText("Create your first payment link").isVisible(), "store created", 60000);
    await p.locator(".ob-field input").nth(1).fill("Masala chai for the team");
    await p.getByRole("button", { name: /Create link/ }).click();
    await until(() => p.locator(".ob-link").isVisible(), "link", 60000);
    const link = await p.locator(".ob-url").innerText(); log("link", link);
    writeFileSync(`${HERE}state/link-home.txt`, link); await save();
    await p.goto(`${APP}/#/app`); await sleep(6000);
    await p.locator(".nk-chip").click(); await sleep(1500);
    log("address", (await p.locator(".nk-menu-row span").first().innerText()).trim());
    const rhF = p.getByRole("button", { name: /Get test stock/ });
    if (await rhF.count()) { await rhF.first().click(); await until(async () => /faucet|moved|sent/i.test(await p.locator(".nk-menu [role=status]").innerText()), "robinhood faucet", 180000).catch(() => log("robinhood faucet: no status")); }
    const arcF = p.getByRole("button", { name: /Get test USDC \(Arc fork\)/ });
    if (await arcF.count()) { await arcF.first().click(); await until(async () => /Arc fork faucet/.test(await p.locator(".nk-menu [role=status]").innerText()), "arc faucet", 60000).catch(() => {}); }
    log("faucets", (await p.locator(".nk-menu").innerText()).replace(/\n+/g, " | ").slice(0, 400));
    await save();
  }

  if (take === "home3") {
    // The Noren app at full width: Home (balance, actions, activity), then Pay: paste a Noren link, pay privately.
    const link = (await import("node:fs")).readFileSync(`${HERE}state/link-home.txt`, "utf8").trim();
    // Off camera: shield 20 of this key's fork USDC from the hosted checkout (the faucet was already used in setup3)
    if (!process.env.NO_SHIELD) {
      await p.goto(link.replace(/^.*#/, `${MERCH}/#`)); await sleep(5000);
      await p.getByRole("button", { name: /Shield 20 USDC/ }).click();
      await until(async () => /Pay 12.50 USDC/.test(await p.locator(".btn.ink.full").innerText()) && !(await p.locator(".btn.ink.full").isDisabled()), "ASP approval", 180000);
      log("shielded", await p.locator(".co-bal").innerText()); await save();
    }
    await p.goto(`${APP}/#/app`); await sleep(7000);
    await moveTo(700, 200, 1);
    await rollCamera(); await sleep(2500);
    result("home", (await p.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 500));
    await moveTo(300, 250, 25); await sleep(800); await moveTo(560, 300, 25); await sleep(800);
    await point(p.locator(".nk-actions")); await sleep(1500);
    await click(p.locator(".nk-actions button").first(), "pay action"); await sleep(1500);
    await click(p.locator("#nk-paylink"), "focus link");
    ev("type", "paste invoice link", { text: link }); await p.locator("#nk-paylink").fill(link); await sleep(2500);
    const top = p.getByRole("button", { name: /Add 20 test USDC privately/ });
    if (await top.count() && await top.first().isVisible()) {
      await click(top.first(), "add 20 test USDC privately");
      await until(async () => !(await p.locator(".nk-paycard .nk-cta").isDisabled()), "private balance ready", 180000); await sleep(1200);
    }
    result("pay panel", (await p.locator(".nk-paycard").innerText()).replace(/\n+/g, " | ").slice(0, 400));
    await click(p.locator(".nk-paycard .nk-cta"), "pay privately");
    await until(async () => /Paid privately/.test(await p.locator(".nk-paycard").innerText()), "paid privately", 180000); await sleep(1500);
    result("private paid", (await p.locator(".nk-paycard").innerText()).replace(/\n+/g, " | ").slice(0, 400)); await sleep(3500);
    await scrollBy(500, 1200); await sleep(3000);
    await cut(); await save();
  }

  if (take === "shop3") {
    // Aubelle: a dress into the bag, the hosted checkout with the four ways to pay, then Pay with stocks
    await p.goto(`${SHOP}/#/`); await sleep(3500);
    await moveTo(640, 360, 1);
    await rollCamera(); await sleep(2000);
    await scrollBy(700, 1400); await sleep(800);
    await click(p.getByRole("link", { name: "Dresses" }).first(), "dresses"); await sleep(1800);
    await scrollBy(380, 900); await sleep(1000);
    await click(p.locator('a.card[href="#/p/amelie-gingham"]'), "Amélie Gingham"); await sleep(2000);
    await click(p.getByRole("button", { name: "S", exact: true }), "size S"); await sleep(600);
    await click(p.getByRole("button", { name: /Add to bag/ }), "add to bag"); await sleep(2000);
    await click(p.locator(".drawer").getByRole("link", { name: "View bag" }), "view bag"); await sleep(1800);
    await click(p.getByRole("button", { name: /Checkout with/ }), "checkout with Noren");
    await p.waitForURL(/#\/pay\//, { timeout: 60000 }); result("checkout", p.url()); await sleep(4000);
    const tabs = p.locator("[role=tablist][aria-label='Payment method'] [role=tab]");
    result("methods", (await tabs.allInnerTexts()).map((t) => t.replace(/\n+/g, " ")).join(" || "));
    for (let i = 0; i < Math.min(await tabs.count(), 6); i++) { await point(tabs.nth(i)); await sleep(900); }
    await click(p.getByRole("tab", { name: /Pay with stocks/ }), "pay with stocks");
    await until(async () => /Pay with [\d.]+ NVDA/.test(await p.locator("body").innerText()), "stock quote", 90000); await sleep(2000);
    result("stock panel", (await p.locator("body").innerText()).match(/You pay[\s\S]{0,600}/)?.[0]?.replace(/\n+/g, " | "));
    const pay = p.getByRole("button", { name: /Pay with [\d.]+ NVDA/ }).first();
    await point(pay); await sleep(1500);
    await click(pay, "pay with stock");
    await until(async () => /Paid with/.test(await p.locator("body").innerText()), "stock payment", 180000); await sleep(2500);
    result("stock paid", (await p.locator("body").innerText()).match(/Paid with[\s\S]{0,600}/)?.[0]?.replace(/\n+/g, " | "));
    await sleep(3000);
    await p.waitForURL(/8780\/#\/order\//, { timeout: 40000 }).catch(() => {});
    await until(async () => /Paid/.test(await p.locator(".status").innerText()), "order paid", 60000).catch(() => {});
    result("order", (await p.locator("body").innerText()).slice(0, 400).replace(/\n+/g, " | ")); await sleep(4500);
    await cut(); await save();
  }

  if (take === "earn3") {
    // Earn = Aqua liquidity: the nNVDA vault is an Aqua maker (fees from the stock payment's fill), a deposit, then Borrow.
    await p.goto(`${APP}/#/app/earn`); await sleep(8000);
    await moveTo(640, 300, 1);
    await rollCamera(); await sleep(2000);
    const nv = p.getByRole("radio", { name: /nNVDA/ });
    if (await nv.count()) { await click(nv.first(), "nNVDA vault"); await sleep(2000); }
    result("vaults", (await p.locator("[aria-label=Vault]").innerText()).replace(/\n+/g, " | "));
    await typeIn(p.locator("#nk-earn"), "1", "deposit amount"); await sleep(1200);
    await click(p.locator(".nk-cta").first(), "deposit");
    await until(async () => /Deposited|reverted|rror/.test(await status()), "deposit", 120000); result("deposit", await status()); await sleep(2000);
    await point(p.locator(".nk-aqua").first()); await sleep(2000);
    result("aqua maker", (await p.locator(".nk-aqua").first().innerText()).replace(/\n+/g, " | ").slice(0, 800));
    await scrollBy(420, 1400); await sleep(3000);
    await scrollBy(420, 1400); await sleep(3000);
    await click(p.getByRole("tab", { name: "Borrow" }), "borrow tab"); await sleep(5000);
    const row = p.locator(".nk-items li", { hasText: "nNVDA" }).first();
    if (await row.count()) {
      await typeIn(row.locator("input"), "1.5", "lock amount");
      await click(row.getByRole("button", { name: "Lock", exact: true }), "lock");
      await until(async () => /Locked|reverted|rror/.test(await status()), "lock", 120000); result("lock", await status());
      await scrollBy(-600, 600); await sleep(4000);
    }
    await typeIn(p.locator("#nk-borrow"), "25", "borrow amount"); await sleep(1500);
    await click(p.locator(".nk-cta").first(), "borrow");
    await until(async () => /Borrowed|reverted|rror/.test(await status()), "borrow", 120000); result("borrow", await status()); await sleep(2500);
    const lp = p.locator(".nk-aqua", { hasText: "lender pool" }).first();
    await point(lp); await sleep(1500);
    result("lender pool", (await lp.innerText()).replace(/\n+/g, " | ").slice(0, 900));
    await scrollBy(300, 1200); await sleep(4000);
    await cut(); await save();
  }

  if (take === "swap3") {
    await p.goto(`${APP}/#/app/swap`); await sleep(7000);
    await moveTo(640, 300, 1);
    await rollCamera(); await sleep(2000);
    const inp = p.locator("#nk-in");
    if (await inp.count()) { await typeIn(inp, "100", "swap amount"); await sleep(5000); }
    result("swap", (await p.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 900));
    const r = p.locator(".nk-routes").first(); if (await r.count()) await point(r); await sleep(3500);
    await cut(); await save();
  }

  if (take === "repay3") {
    // Repay in the Noren app (public: the line is tied to the borrower's wallet)
    await p.goto(`${APP}/#/app/credit`); await sleep(7000);
    await moveTo(640, 300, 1);
    await rollCamera(); await sleep(1500);
    await point(p.locator(".nk-card").first()); await sleep(1800);
    const repay = p.getByRole("button", { name: /Repay [\d.]+ USDC/ }).first();
    result("before", (await p.locator(".nk-card").first().innerText()).replace(/\n+/g, " | ").slice(0, 600));
    await click(repay, "repay");
    await until(async () => /Repaid [\d.]+ USDC|reverted|rror/.test(await p.locator(".nk-col").innerText()), "repayment", 120000);
    result("repaid", (await p.locator(".nk-col").innerText()).match(/Repaid [^\n]*/)?.[0]); await sleep(4500);
    await cut(); await save();
  }

  if (take === "stocks3") {
    // The Bridge tab's "Stocks → USDC": the cross-chain Aqua order (fork demo), its three steps
    await p.goto(`${APP}/#/app/bridge`); await sleep(8000);
    await moveTo(640, 300, 1);
    await rollCamera(); await sleep(1500);
    const hero = p.locator(".nk-rharc");
    await click(hero.getByRole("tab", { name: "Stocks → USDC" }), "Stocks to USDC"); await sleep(2500);
    const steps = hero.locator(".nk-path li");
    for (let i = 0; i < await steps.count(); i++) { await point(steps.nth(i)); await sleep(1400); }
    result("stocks", (await hero.innerText()).replace(/\n+/g, " | ").slice(0, 900));
    await scrollBy(300, 1200); await sleep(3000);
    await cut();
  }

  if (take === "arcout3" || take === "bridge3") {
    // LIVE on public testnets from the app: Arc -> Robinhood (arcout3), then Robinhood -> Arc (bridge3)
    await p.goto(`${APP}/#/app/bridge`); await sleep(8000);
    await moveTo(640, 300, 1);
    await rollCamera(); await sleep(2500);
    const hero = p.locator(".nk-rharc");
    if (take === "arcout3") { await click(hero.getByRole("tab", { name: "Arc → Robinhood" }), "Arc to Robinhood"); await sleep(2500); }
    const steps = hero.locator(".nk-path li");
    for (let i = 0; i < await steps.count(); i++) { await point(steps.nth(i)); await sleep(1600); }
    const amountBox = hero.locator(take === "arcout3" ? "input[aria-label='USDC to send from Arc']" : "input[aria-label='USDC to bring to Arc']");
    await typeIn(amountBox, process.env.AMOUNT ?? "0.5", "amount"); await sleep(2500);
    result("before", (await hero.innerText()).replace(/\n+/g, " | ").slice(0, 900));
    const cta = hero.locator(".nk-cta").first();
    await click(cta, take === "arcout3" ? "send to Robinhood" : "bring to Arc");
    await until(async () => /USDC landed on (Arc|Robinhood)|landed on|Transfer stopped/.test(await hero.innerText()), "mint", 480000);
    await sleep(3000);
    result("after", (await p.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 1500));
    const links = await p.evaluate(() => [...document.querySelectorAll(".nk-rharc a[href], main a[href]")].map((a) => a.href).filter((h) => /\/tx\//.test(h)).slice(0, 12));
    result("tx links", links.join(" "));
    await point(hero.locator(".nk-result, [class*=result]").first()).catch(() => {}); await sleep(5000);
    await cut(); await save();
  }

  // ---------------------------------------------------------------- v4 takes
  const V4 = process.env.NOREN_REPO ?? "/Volumes/Extreme SSD/Projects/grokbot/projects/_wt/noren-v4";
  const forkScript = (args) => { log("fork script:", args.join(" ")); const out = execFileSync("pnpm", ["exec", "tsx", ...args], { cwd: V4, encoding: "utf8", timeout: 600000, stdio: ["ignore", "pipe", "pipe"] }); writeFileSync(`${HERE}state/fork-${args[0].split("/").pop()}-${Date.now()}.log`, out); return out; };
  const walletAddr = async () => { await p.locator(".nk-chip").click(); await sleep(1200); const a = (await p.locator(".nk-menu-row span").first().innerText()).trim(); await p.locator(".nk-x").click(); await sleep(600); return a; };

  if (take === "link4") {
    // Off camera: Noren Merchant (merchant persona, injected wallet) sets up its store on this stack and makes a 20 USDC link
    await p.goto(`${MERCH}/#/dashboard/onboard`); await sleep(5000);
    const inj = p.getByRole("button", { name: /Test wallet \(injected\)/ });
    await until(() => inj.isVisible(), "injected wallet option", 30000);
    await inj.click();
    await until(() => p.getByText("What's your business called?").isVisible(), "signed in", 60000);
    await p.locator(".ob-field input").first().fill("Juhu Chai House");
    await p.getByRole("button", { name: /Continue/ }).click(); await sleep(1000);
    await p.getByRole("radio", { name: /USDC on Arc to my wallet/ }).click();
    await p.getByRole("button", { name: /Create store/ }).click();
    await until(() => p.getByText("Create your first payment link").isVisible(), "store created", 90000);
    await p.locator(".ob-field input").nth(0).fill(process.env.LINK_AMOUNT ?? "20");
    await p.locator(".ob-field input").nth(1).fill("Chai and samosas, office order");
    await p.getByRole("button", { name: /Create link/ }).click();
    await until(() => p.locator(".ob-link").isVisible(), "link", 60000);
    const link = await p.locator(".ob-url").innerText(); log("link4", link, (await p.locator(".ob-link").innerText()).replace(/\n+/g, " | ").slice(0, 120));
    writeFileSync(`${HERE}state/link4.txt`, link); await save();
  }

  if (take === "credit4a") {
    // Stocks -> credit, part 1: Home -> Earn (deposit 2 NVDA, the Aqua maker card) -> Credit (limit at 66%) ->
    // Raise your limit: the World ID QR and one Reclaim provider's QR (shown, never completed)
    await p.goto(`${APP}/#/app`); await sleep(8000);
    await moveTo(640, 420, 1);
    await rollCamera(); await sleep(2000);
    await click(p.getByRole("tab", { name: "Earn" }), "earn tab"); await sleep(3000);
    const nv = p.getByRole("radio", { name: /nNVDA/ });
    await click(nv.first(), "nNVDA vault"); await sleep(1500);
    await typeIn(p.locator("#nk-earn"), "2", "deposit amount"); await sleep(1200);
    await click(p.locator(".nk-cta").first(), "deposit");
    await until(async () => /Deposited|reverted|rror/.test(await status()), "deposit", 180000); result("deposit", await status()); await sleep(1800);
    result("vault row", (await p.locator("[aria-label=Vault]").innerText()).replace(/\n+/g, " | ").slice(0, 300));
    const aq = p.locator(".nk-aqua").first();
    await point(aq); await sleep(1500);
    await point(aq.locator(".nk-jobs")); await sleep(3500);
    result("aqua maker", (await aq.innerText()).replace(/\n+/g, " | ").slice(0, 700));
    await click(p.getByRole("tab", { name: "Credit" }), "credit tab"); await sleep(5000);
    await scrollBy(-2000, 300); await sleep(1500);
    result("credit top", (await p.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 900));
    const raise = p.locator("#nk-raise");
    await point(raise.locator(".nk-raise-now")); await sleep(3000);
    result("raise now", (await raise.locator(".nk-raise-now").innerText()).replace(/\n+/g, " | "));
    // World ID: the real IDKit request, its QR on screen (nobody scans it here)
    await click(raise.getByRole("button", { name: "Verify", exact: true }), "world id task"); await sleep(1500);
    const vw = p.getByRole("button", { name: /Verify with World ID/ }).first();
    await click(vw, "verify with World ID");
    await sleep(4500); ev("result", "world qr", { value: "IDKit request open" });
    await sleep(3000);
    await p.keyboard.press("Escape").catch(() => {}); await sleep(1200);
    // Reclaim: one provider -> its QR -> waiting (not completed)
    await click(raise.getByRole("button", { name: "Prove", exact: true }), "reclaim task"); await sleep(1800);
    const prov = raise.getByRole("button", { name: /^Prove / }).first();
    result("reclaim provider", await prov.getAttribute("aria-label"));
    await click(prov, "reclaim provider");
    await until(async () => (await p.locator("[role=dialog] canvas, [role=dialog] svg, [role=dialog] img").count()) > 0, "reclaim QR", 60000).catch(() => {});
    await sleep(6000);
    result("reclaim modal", (await p.locator("[role=dialog]").last().innerText().catch(() => "")).replace(/\n+/g, " | ").slice(0, 500));
    await click(p.locator("[role=dialog] .nk-x").last(), "close reclaim"); await sleep(1500);
    const me = await walletAddr(); writeFileSync(`${HERE}state/stocks-wallet.txt`, me);
    await cut(); await save();
  }

  if (take === "credit4b") {
    // Stocks -> credit, part 2 (after the real fork repayment steps): the limit at 70% with the on-chain record,
    // more NVDA deposited (limit up), then the credit line opened with nNVDA shares
    await p.goto(`${APP}/#/app/credit`); await sleep(9000);
    await moveTo(640, 400, 1);
    await rollCamera(); await sleep(1500);
    const raise = p.locator("#nk-raise");
    await point(raise.locator(".nk-raise-now")); await sleep(2500);
    result("raise now", (await raise.locator(".nk-raise-now").innerText()).replace(/\n+/g, " | "));
    const rec = p.locator(".nk-onchain, .nk-rc-chain").first();
    if (await rec.count()) { await point(rec); await sleep(2500); result("onchain", (await rec.innerText()).replace(/\n+/g, " | ")); }
    else { const ot = raise.getByText("Repay on time").first(); await point(ot); await sleep(2500); result("ontime", (await raise.locator("li", { hasText: "Repay on time" }).first().innerText()).replace(/\n+/g, " | ").slice(0, 400)); }
    // lock more NVDA: one more NVDA into the nNVDA Aqua pool
    await click(p.getByRole("tab", { name: "Earn" }), "earn tab"); await sleep(3000);
    await click(p.getByRole("radio", { name: /nNVDA/ }).first(), "nNVDA vault"); await sleep(1200);
    await typeIn(p.locator("#nk-earn"), "1", "deposit amount"); await sleep(1000);
    await click(p.locator(".nk-cta").first(), "deposit");
    await until(async () => /Deposited|reverted|rror/.test(await status()), "deposit", 180000); result("deposit2", await status()); await sleep(1500);
    await click(p.getByRole("tab", { name: "Credit" }), "credit tab"); await sleep(6000);
    await point(p.locator("#nk-raise .nk-raise-now")); await sleep(2500);
    result("raise after lock", (await p.locator("#nk-raise .nk-raise-now").innerText()).replace(/\n+/g, " | "));
    // open the credit line with nNVDA shares
    const line = p.locator("#nk-line");
    await point(line); await sleep(1200);
    await click(line.getByRole("radio", { name: /^nNVDA/ }).first(), "nNVDA collateral"); await sleep(1500);
    const max = line.locator(".nk-box .nk-sub button").first();
    if (await max.count()) { await click(max, "all nNVDA"); await sleep(1500); }
    result("open form", (await line.innerText()).replace(/\n+/g, " | ").slice(0, 700));
    const cta = line.locator(".nk-cta").first();
    await click(cta, "lock and open the line");
    await until(async () => /Live on Arc|reverted|Declined|rror|Setup required/.test(await line.innerText()) && !/Locking on Robinhood/.test(await cta.innerText().catch(() => "")), "line opened", 300000);
    await sleep(2500); result("line", (await line.innerText()).replace(/\n+/g, " | ").slice(0, 700));
    await until(async () => /Live on Arc/.test(await line.innerText()) && !/Bridging|reporting…/.test(await line.innerText()), "live on Arc", 240000).catch(() => log("line not live on Arc yet"));
    await sleep(3000); result("line live", (await line.innerText()).replace(/\n+/g, " | ").slice(0, 700));
    await cut(); await save();
  }

  if (take === "credit4c") {
    // Pay later at the checkout (20 USDC link) from the credit line, then Noren app: the line owes 20
    const link = (await import("node:fs")).readFileSync(`${HERE}state/link4.txt`, "utf8").trim();
    await p.goto(`${APP}/#/app`); await sleep(8000);   // the app reconnects the browser wallet first
    log("app account", await p.locator(".nk-chip").innerText().catch(() => "?"));
    // hold /config so the browser-wallet restore lands before makeWallet() binds the account (else "active wallet changed")
    await p.route(/\/config(\?|$)/, async (r) => { await sleep(2500); await r.continue(); });
    await p.goto(link.replace(/^.*#/, `${MERCH}/#`)); await p.reload(); await sleep(8000);
    await moveTo(900, 300, 1);
    await rollCamera(); await sleep(1500);
    await click(p.getByRole("tab", { name: /Pay in 3 \/ Pay later/ }), "pay later"); await sleep(4000);
    result("later panel", (await p.locator("body").innerText()).match(/Pay later[\s\S]{0,600}/)?.[0]?.replace(/\n+/g, " | "));
    const go = p.locator(".btn.ink.full, .btn.kaki").first();
    await until(async () => !(await go.isDisabled()), "pay later enabled", 90000);
    result("button", await go.innerText());
    await click(go, "pay later");
    await until(async () => /Paid\s*(later|on credit)/i.test(await p.locator("body").innerText()), "paid later", 300000); await sleep(2000);
    result("paid", (await p.locator("body").innerText()).match(/Paid[\s\S]{0,500}/)?.[0]?.replace(/\n+/g, " | ")); await sleep(4000);
    await cut(); await save();
  }

  if (take === "credit4d") {
    // After real Aqua fills (dev-maker-fill.ts): the line's NVDA fees pay it down
    await p.goto(`${APP}/#/app/credit`); await sleep(9000);
    await moveTo(640, 400, 1);
    await rollCamera(); await sleep(1500);
    const y = p.locator(".nk-yield").first();
    await point(y); await sleep(2500);
    result("yield before", (await y.innerText()).replace(/\n+/g, " | ").slice(0, 500));
    const b = y.getByRole("button", { name: /Pay down with/ });
    await click(b, "pay down with fees");
    await until(async () => /paid down the line|reverted|rror/.test(await p.locator("#nk-line").innerText()), "pay down", 120000); await sleep(3000);
    result("yield after", (await y.innerText()).replace(/\n+/g, " | ").slice(0, 500));
    result("line after", (await p.locator("#nk-line").innerText()).replace(/\n+/g, " | ").slice(0, 700));
    await sleep(3000);
    await cut(); await save();
  }

  if (take === "ethpay4") {
    // Pay with stocks or crypto: Aubelle's checkout, the stock/ETH picker, pay with ETH
    await p.goto(`${SHOP}/#/p/amelie-gingham`); await sleep(4000);
    await p.getByRole("button", { name: "S", exact: true }).click(); await sleep(500);
    await p.getByRole("button", { name: /Add to bag/ }).click(); await sleep(1500);
    await p.locator(".drawer").getByRole("link", { name: "View bag" }).click(); await sleep(1500);
    await p.getByRole("button", { name: /Checkout with/ }).click();
    await p.waitForURL(/#\/pay\//, { timeout: 60000 }); await sleep(5000);
    await moveTo(900, 300, 1);
    await rollCamera(); await sleep(1500);
    await click(p.getByRole("tab", { name: /Pay with stocks/ }), "pay with stocks or crypto"); await sleep(3000);
    const pick = p.locator("[aria-label='Stock Token or ETH']");
    await until(() => pick.isVisible(), "picker", 240000);
    result("picker", (await pick.innerText()).replace(/\n+/g, " | "));
    await point(pick); await sleep(1500);
    await click(pick.getByRole("radio", { name: /^ETH/ }), "ETH"); await sleep(3000);
    const pay = p.getByRole("button", { name: /Pay with [\d.]+ ETH/ }).first();
    await until(() => pay.isEnabled(), "eth quote", 90000);
    result("eth quote", (await p.locator("body").innerText()).match(/You pay[\s\S]{0,300}/)?.[0]?.replace(/\n+/g, " | "));
    await point(pay); await sleep(1500);
    await click(pay, "pay with ETH");
    await until(async () => /Paid with/.test(await p.locator("body").innerText()), "eth payment", 180000); await sleep(2500);
    result("eth paid", (await p.locator("body").innerText()).match(/Paid with[\s\S]{0,500}/)?.[0]?.replace(/\n+/g, " | ")); await sleep(4000);
    await cut(); await save();
  }

  if (take === "bridge4") {
    // USDC from any chain to Arc: the chain chips (Ethereum, Base, Arbitrum, Robinhood…), the path, the recent live runs
    await p.goto(`${APP}/#/app/bridge`); await sleep(9000);
    await moveTo(640, 360, 1);
    await rollCamera(); await sleep(2000);
    const hero = p.locator(".nk-rharc");
    const chips = hero.locator("[role=radiogroup] [role=radio]");
    result("chains", (await chips.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).join(" | "));
    for (let i = 0; i < Math.min(await chips.count(), 5); i++) { await click(chips.nth(i), `chain ${i}`); await sleep(1600); }
    await click(chips.first(), "chain 0 again"); await sleep(1200);
    await point(hero.locator(".nk-path")); await sleep(2500);
    const recent = p.locator("[aria-label='Recent live transfers into Arc']").first();
    if (await recent.count()) { await point(recent); await sleep(2000); await scrollBy(320, 1400); await sleep(2500); result("recent", (await recent.innerText()).replace(/\n+/g, " | ").slice(0, 900)); }
    await cut();
  }

  // ---------------------------------------------------------------- v6 takes (hosted URLs; full frame, one action per shot)
  if (take === "shop6") {
    // The shopping flow, unhurried: Aubelle -> a dress -> size -> add to bag -> the bag -> checkout -> Noren's checkout
    await p.goto(`${SHOP}/#/`); await sleep(4000);
    await moveTo(640, 360, 1);
    await rollCamera(); await sleep(2500);
    await click(p.getByRole("link", { name: "Dresses" }).first(), "dresses"); await sleep(2500);
    await click(p.locator('a.card[href="#/p/amelie-gingham"]'), "Amélie Gingham"); await sleep(3000);
    await click(p.getByRole("button", { name: "S", exact: true }), "size S"); await sleep(1200);
    await click(p.getByRole("button", { name: /Add to bag/ }), "add to bag"); await sleep(3000);
    await click(p.locator(".drawer").getByRole("link", { name: "View bag" }), "view bag"); await sleep(3000);
    await click(p.getByRole("button", { name: /Checkout with|Proceed to checkout|Checkout/ }).first(), "checkout");
    await p.waitForURL(/#\/pay\//, { timeout: 60000 }); result("checkout", p.url()); await sleep(5000);
    const tabs = p.locator("[role=tablist][aria-label='Payment method'] [role=tab]");
    result("methods", (await tabs.allInnerTexts()).map((t) => t.replace(/\n+/g, " ")).join(" || "));
    for (let i = 0; i < Math.min(await tabs.count(), 5); i++) { await point(tabs.nth(i)); await sleep(1100); }
    await sleep(1500);
    writeFileSync(`${HERE}state/checkout6.txt`, p.url());
    await cut(); await save();
  }

  if (take === "stockpay6") {
    // Pay with stocks or crypto from the checkout opened by shop6: the whole token list, then pay with one
    const url = (await import("node:fs")).readFileSync(`${HERE}state/checkout6.txt`, "utf8").trim();
    if (TW) {
      // as in privpay6: the checkout restores the injected wallet (signer.ts) once the stored mode is read on a fresh load
      await p.goto(`${MERCH}/#/`); await sleep(2500);
      await p.evaluate(() => { localStorage.setItem("noren.wallet.mode", "browser"); localStorage.setItem("noren.wallet.browser", "dev.noren.film.testwallet"); });
      await p.route(/\/config(\?|$)/, async (r) => { await sleep(2500); await r.continue(); });
      await p.goto(url); await sleep(1500); await p.reload();
    } else await p.goto(url);
    await sleep(6000);
    await moveTo(900, 300, 1);
    await rollCamera(); await sleep(1500);
    await click(p.getByRole("tab", { name: /Pay with stocks/ }), "pay with stocks or crypto"); await sleep(2500);
    const pick = p.locator("[aria-label='Stock Token or ETH']");
    await until(() => pick.isVisible(), "picker", 240000);
    await point(pick); await sleep(1000);
    result("tokens", (await pick.innerText()).replace(/\n+/g, " | "));
    const opts = pick.getByRole("radio");
    for (let i = 0; i < await opts.count(); i++) { await point(opts.nth(i)); await sleep(450); }
    const sym = process.env.PAY_WITH ?? "NVDA";
    await click(pick.getByRole("radio", { name: new RegExp("^" + sym) }), `pick ${sym}`); await sleep(2500);
    const pay = p.getByRole("button", { name: new RegExp(`Pay with [\\d.]+ ${sym}`) }).first();
    await until(() => pay.isEnabled(), "quote", 120000);
    result("quote", (await p.locator("body").innerText()).match(/You pay[\s\S]{0,300}/)?.[0]?.replace(/\n+/g, " | "));
    await sleep(1500);
    await click(pay, `pay with ${sym}`);
    await until(async () => /Paid with/.test(await p.locator("body").innerText()), "paid", 240000); await sleep(2500);
    result("paid", (await p.locator("body").innerText()).match(/Paid with[\s\S]{0,400}/)?.[0]?.replace(/\n+/g, " | ")); await sleep(4000);
    await cut(); await save();
  }

  if (take === "privpay6") {
    // Hosted checkout for a small link (state/link4.txt): opens on Pay privately, shields what it needs from the wallet
    // (real Arc testnet USDC), proves in the browser, paid
    const link = (await import("node:fs")).readFileSync(`${HERE}state/link4.txt`, "utf8").trim();
    await p.goto(`${APP}/#/app`); await sleep(7000);
    if (TW) {
      // the checkout restores a browser wallet the customer connected before (signer.ts): the injected test wallet
      await p.goto(`${MERCH}/#/`); await sleep(2500);
      await p.evaluate(() => { localStorage.setItem("noren.wallet.mode", "browser"); localStorage.setItem("noren.wallet.browser", "dev.noren.film.testwallet"); });
      // makeWallet() binds the active account when /config arrives; hold that response briefly so the EIP-6963 restore
      // (250 ms discovery + eth_accounts) has finished and the checkout signs with the injected wallet, not a fresh test key
      await p.route(/\/config(\?|$)/, async (r) => { await sleep(2500); await r.continue(); });
    }
    await p.goto(link.replace(/^.*#/, `${MERCH}/#`)); await sleep(1500);
    if (TW) { await p.reload(); }   // a hash-only goto keeps the document: reload so signer.ts reads the stored mode
    await sleep(8000);
    log("checkout wallet", (await p.locator(".co-fund").innerText().catch(() => "")).match(/0x[0-9a-fA-F]{40}/)?.[0] ?? "(no fund panel)");
    await moveTo(900, 300, 1);
    await rollCamera(); await sleep(2000);
    result("default", await p.locator(".co-methods [aria-selected=true]").innerText().catch(() => ""));
    const sh = p.getByRole("button", { name: /Shield|Add .*private/ }).first();
    if (await sh.isVisible().catch(() => false)) {
      result("shield button", await sh.innerText());
      await click(sh, "shield");
      await until(async () => { const bt = p.locator(".btn.ink.full"); return /Pay [\d.]+ USDC/.test(await bt.innerText()) && !(await bt.isDisabled()); }, "private balance ready", 300000);
    }
    await sleep(1500);
    await click(p.locator(".btn.ink.full"), "pay privately");
    await until(async () => /Paid\s*privately/.test(await p.locator("body").innerText()), "paid privately", 300000); await sleep(2000);
    result("paid", (await p.locator("body").innerText()).match(/Paid\s*privately[\s\S]{0,400}/)?.[0]?.replace(/\n+/g, " | ")); await sleep(4000);
    await cut(); await save();
  }

  if (take === "borrow6") {
    // Loans that pay themselves down on the hosted Robinhood snapshot: lock nNVDA, borrow, real Aqua fills
    // (dev-maker-fill.ts through the VPS tunnel), "Use earnings to pay down loan"
    await p.goto(`${APP}/#/app/borrow`); await sleep(9000);
    await moveTo(640, 360, 1);
    await rollCamera(); await sleep(1500);
    const row = p.locator(".nk-items li", { hasText: "nNVDA" }).first();
    await typeIn(row.locator("input"), process.env.LOCK_AMOUNT ?? "1.5", "lock amount");
    await click(row.getByRole("button", { name: "Lock", exact: true }), "lock");
    await until(async () => /Locked|reverted|rror/.test(await status()), "lock", 180000); result("lock", await status());
    await scrollBy(-600, 600); await sleep(2500);
    await typeIn(p.locator("#nk-borrow"), process.env.BORROW_AMOUNT ?? "100", "borrow amount"); await sleep(1200);
    await click(p.locator(".nk-cta").first(), "borrow");
    await until(async () => /Borrowed|reverted|rror/.test(await status()), "borrow", 180000); result("borrow", await status()); await sleep(2000);
    ev("result", "fills start", { value: "dev-maker-fill.ts" });
    try { const out = forkScript(["scripts/dev-maker-fill.ts", "3", "0.2"]); result("fills", out.split("\n").filter((l) => /fork tx/.test(l)).join(" | ").slice(0, 600)); } catch (e) { log("maker fill failed:", String(e.message).slice(0, 300)); }
    const card = p.locator("section, .nk-card", { hasText: "Your collateral keeps earning" }).last();
    await point(card); await sleep(1500);
    await until(async () => /from \d+ Aqua fill/.test(await card.innerText()), "fills shown", 120000).catch(() => log("no fills shown"));
    await sleep(2000); result("earning", (await card.innerText()).replace(/\n+/g, " | ").slice(0, 600));
    const use = card.getByRole("button", { name: /Use earnings to pay down loan/ });
    if (await use.count() && await use.isEnabled()) {
      await click(use, "use earnings");
      await until(async () => /Paid [\d.]+ USDG from \d+ Aqua fill|reverted|rror/.test(await card.innerText()), "pay down", 120000); await sleep(2500);
      result("paid down", (await card.innerText()).replace(/\n+/g, " | ").slice(0, 700));
    }
    await sleep(3000);
    await cut(); await save();
  }

  if (take === "raise6") {
    // After the real repayment record (dev-reputation-ladder.ts loan + attest via the VPS tunnel): the raised tier, the
    // on-chain record, then one Reclaim provider's QR (shown, never completed). World ID is the separate World App take.
    await p.goto(`${APP}/#/app/credit`); await sleep(9000);
    const raise = p.locator("#nk-raise");
    await raise.scrollIntoViewIfNeeded(); await sleep(1500);
    await moveTo(640, 400, 1);
    await rollCamera(); await sleep(1500);
    await point(raise.locator(".nk-raise-now")); await sleep(3000);
    result("raise now", (await raise.locator(".nk-raise-now").innerText()).replace(/\n+/g, " | "));
    const rec = p.locator(".nk-onchain, .nk-rc-chain").first();
    if (await rec.count()) { await point(rec); await sleep(3000); result("onchain", (await rec.innerText()).replace(/\n+/g, " | ").slice(0, 400)); }
    else { const ot = raise.locator("li", { hasText: "Repay on time" }).first(); await point(ot); await sleep(3000); result("ontime", (await ot.innerText()).replace(/\n+/g, " | ").slice(0, 400)); }
    await click(raise.getByRole("button", { name: "Prove", exact: true }), "reclaim task"); await sleep(1800);
    const prov = raise.getByRole("button", { name: /^Prove / }).first();
    result("reclaim provider", await prov.getAttribute("aria-label"));
    await click(prov, "reclaim provider");
    await until(async () => (await p.locator("[role=dialog] canvas, [role=dialog] svg, [role=dialog] img").count()) > 0, "reclaim QR", 60000).catch(() => {});
    await sleep(6000);
    result("reclaim modal", (await p.locator("[role=dialog]").last().innerText().catch(() => "")).replace(/\n+/g, " | ").slice(0, 500));
    await cut(); await save();
  }

  // ---------------------------------------------------------------- v6-final2: the credit section on the local stack
  if (take === "lockup7") {
    // Lock NVDA into the Aqua pool in two steps and read the credit limit after each (the number has to visibly grow)
    await p.goto(`${APP}/#/app`); await sleep(8000);
    await moveTo(640, 420, 1);
    await rollCamera(); await sleep(1500);
    const dep = async (amt, tag) => {
      await click(p.getByRole("tab", { name: "Earn" }), "earn tab"); await sleep(2500);
      await click(p.getByRole("radio", { name: /nNVDA/ }).first(), "nNVDA vault"); await sleep(1200);
      await typeIn(p.locator("#nk-earn"), amt, `deposit ${amt}`); await sleep(1000);
      await click(p.locator(".nk-cta").first(), `deposit ${amt}`);
      await until(async () => /Deposited|reverted|rror/.test(await status()), "deposit", 180000); result(tag, await status()); await sleep(2500);
    };
    const limit = async (tag) => {
      await click(p.getByRole("tab", { name: "Credit" }), "credit tab"); await sleep(4500);
      const now = p.locator("#nk-raise .nk-raise-now");
      await now.scrollIntoViewIfNeeded(); await sleep(800);
      await point(now); await sleep(3500);
      result(tag, (await now.innerText()).replace(/\n+/g, " | "));
    };
    await dep(process.env.LOCK1 ?? "1", "deposit 1"); await limit("limit after first lock");
    await dep(process.env.LOCK2 ?? "2", "deposit 2"); await limit("limit after second lock");
    await cut(); await save();
  }

  if (take === "qr7") {
    // Raise your limit: the real World ID request (IDKit QR on screen, nobody scans it here) and one Reclaim provider QR
    await p.goto(`${APP}/#/app/credit`); await sleep(9000);
    const raise = p.locator("#nk-raise");
    await raise.scrollIntoViewIfNeeded(); await sleep(1200);
    await moveTo(640, 400, 1);
    await rollCamera(); await sleep(1500);
    await click(raise.getByRole("button", { name: "Verify", exact: true }), "world id task"); await sleep(1500);
    const vw = p.getByRole("button", { name: /Verify with World ID/ }).first();
    await click(vw, "verify with World ID");
    await sleep(6000); ev("result", "world qr", { value: "IDKit request open" });
    await p.keyboard.press("Escape").catch(() => {}); await sleep(1500);
    await click(raise.getByRole("button", { name: "Prove", exact: true }), "reclaim task"); await sleep(1800);
    const prov = raise.getByRole("button", { name: /^Prove / }).first();
    result("reclaim provider", await prov.getAttribute("aria-label"));
    await click(prov, "reclaim provider");
    await until(async () => (await p.locator("[role=dialog] canvas, [role=dialog] svg, [role=dialog] img").count()) > 0, "reclaim QR", 60000).catch(() => {});
    await sleep(6000);
    result("reclaim modal", (await p.locator("[role=dialog]").last().innerText().catch(() => "")).replace(/\n+/g, " | ").slice(0, 400));
    await cut(); await save();
  }

  if (take === "payin3") {
    // Pay in 3 at the checkout (public, from the credit line) for state/link-payin3.txt
    const link = (await import("node:fs")).readFileSync(`${HERE}state/link-payin3.txt`, "utf8").trim();
    await p.goto(`${APP}/#/app`); await sleep(8000);
    await p.goto(link.replace(/^.*#/, `${MERCH}/#`)); await p.reload(); await sleep(8000);
    await moveTo(900, 300, 1);
    await rollCamera(); await sleep(1500);
    await click(p.getByRole("tab", { name: /Pay in 3 \/ Pay later/ }), "pay in 3 / later"); await sleep(2000);
    await click(p.getByRole("radio", { name: /Pay in 3/ }), "pay in 3"); await sleep(3000);
    const go = p.locator(".btn.kaki").first();
    await until(async () => !(await go.isDisabled()), "pay in 3 enabled", 90000);
    result("button", await go.innerText()); await sleep(1200);
    await click(go, "pay in 3 from the line");
    await until(async () => /Paid on\s*credit/i.test(await p.locator("body").innerText()), "paid on credit", 300000); await sleep(2000);
    result("paid", (await p.locator("body").innerText()).match(/Paid on[\s\S]{0,400}/)?.[0]?.replace(/\n+/g, " | ")); await sleep(4000);
    await cut(); await save();
  }

  if (take === "landing4") {
    // The website with one slow, eased, continuous scroll (easeInOutCubic, ~2.5 viewport heights over 10 s),
    // driven by requestAnimationFrame in the page so every painted frame is on the curve. Shown at 1.0x in the film.
    await p.goto(`${APP}/#/`); await sleep(3000);
    await moveTo(1180, 680, 1);
    await rollCamera(); await sleep(1600);
    ev("scroll", "eased 2.5 viewports / 10 s");
    await p.evaluate(() => new Promise((done) => {
      const y0 = scrollY, dist = innerHeight * 2.5, ms = 10000, t0 = performance.now();
      const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
      const step = (now) => { const k = Math.min(1, (now - t0) / ms); scrollTo(0, y0 + dist * ease(k)); if (k < 1) requestAnimationFrame(step); else done(); };
      requestAnimationFrame(step);
    }));
    await sleep(1800);
    await cut();
  }

  if (take === "landing") {
    await p.goto(`${APP}/#/`); await sleep(2500);
    await rollCamera(); await sleep(3500);
    const H = await p.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < Math.min(H, 7600); y += 40) { await p.mouse.wheel(0, 40); await sleep(55); }
    await sleep(1500);
    await cut();
  }

  if (take === "onboard") {
    await p.goto(`${MERCH}/#/dashboard/onboard`); await sleep(3000);
    await moveTo(900, 420, 1);
    await rollCamera(); await sleep(1500);
    await click(p.getByRole("button", { name: /Use a test wallet/ }), "sign in with a test wallet");
    await until(() => p.getByText("What's your business called?").isVisible(), "signed in"); result("signed in", await p.locator(".ob-who").innerText());
    await sleep(900);
    await typeIn(p.locator(".ob-field input").first(), "Juhu Chai House", "business name");
    await click(p.getByRole("button", { name: /Continue/ }), "continue");
    await sleep(1200);
    await click(p.getByRole("radio", { name: /USDC on Arc to my wallet/ }), "payout to my wallet"); await sleep(600);
    await click(p.getByRole("button", { name: /Create store/ }), "create store");
    await until(() => p.getByText("Create your first payment link").isVisible(), "store created", 60000);
    result("store", await p.locator(".ob-card p").first().innerText()); await sleep(1200);
    await typeIn(p.locator(".ob-field input").nth(1), "Masala chai for the team", "description");
    await click(p.getByRole("button", { name: /Create link/ }), "create link");
    await until(() => p.locator(".ob-link").isVisible(), "link", 60000);
    const link = await p.locator(".ob-url").innerText(); result("link", link); await sleep(2200);
    await click(p.getByRole("button", { name: /^Continue/ }), "continue to keys"); await sleep(1200);
    await point(p.locator(".ob-keys")); await sleep(1500);
    await moveTo(mx + 220, my + 60, 30); await sleep(1200);
    await scrollBy(320, 1200); await sleep(2500);
    await click(p.getByRole("button", { name: /Go to your dashboard/ }), "go to dashboard"); await sleep(4000);
    writeFileSync(`${HERE}state/link1.txt`, link);
    await cut(); await save();
  }

  if (take === "app") {
    await p.goto(`${APP}/#/app/earn`); await sleep(5000);
    await moveTo(900, 300, 1);
    await rollCamera(); await sleep(1200);
    // sign in: this browser's test key; fork faucets for stock, USDG and Arc USDC
    await click(p.locator(".nk-chip"), "wallet"); await sleep(1500);
    await click(p.getByRole("button", { name: /Get test stock and USDG/ }), "robinhood faucet");
    await until(async () => /faucet:/i.test(await p.locator(".nk-menu [role=status]").innerText()), "robinhood faucet", 120000);
    result("rh faucet", await p.locator(".nk-menu [role=status]").innerText()); await sleep(1200);
    await click(p.getByRole("button", { name: /Get test USDC \(Arc fork\)/ }), "arc faucet");
    await until(async () => /Arc fork faucet/.test(await p.locator(".nk-menu [role=status]").innerText()), "arc faucet", 60000);
    result("arc faucet", await p.locator(".nk-menu [role=status]").innerText()); await sleep(1500);
    await click(p.locator(".nk-x"), "close wallet"); await sleep(6000);
    // Earn: deposit ETH into nETH, whose Aqua maker sells ETH at Chainlink + 0.40%
    await click(p.getByRole("radio", { name: /nETH/ }), "nETH vault"); await sleep(1000);
    await typeIn(p.locator("#nk-earn"), "0.5", "deposit amount"); await sleep(1500);
    await click(p.locator(".nk-cta"), "deposit");
    await until(async () => /Deposited|reverted|rror/.test(await status()), "deposit", 120000); result("deposit", await status()); await sleep(2500);
    // Swap: buy ETH with USDG; best execution picks the cheapest venue (here the nETH vault's Aqua maker)
    await click(p.getByRole("tab", { name: "Swap" }), "swap tab"); await sleep(2000);
    await click(p.locator(".nk-flip"), "flip"); await sleep(800);
    await click(p.locator(".nk-box").nth(1).locator("button").first(), "receive token"); await sleep(900);
    await click(p.getByText("Ether", { exact: true }), "pick ETH"); await sleep(900);
    await typeIn(p.locator("#nk-in"), "100", "swap amount"); await sleep(4500);
    result("routes", (await p.locator(".nk-routes").innerText()).replace(/\n+/g, " | "));
    await point(p.locator(".nk-routes")); await sleep(2500);
    await click(p.locator(".nk-cta"), "swap");
    await until(async () => /Received|did not complete/.test(await p.locator(".nk-col").innerText()), "swap", 120000);
    result("swap", (await p.locator(".nk-col").innerText()).match(/Received[^\n]*|Swap did not complete/)?.[0]); await sleep(3500);
    // Earn again: the fill's spread is now the vault's realised fees
    await click(p.getByRole("tab", { name: "Earn" }), "earn tab"); await sleep(9000);
    result("earn rows", (await p.locator(".nk-routes").innerText()).replace(/\n+/g, " | "));
    await point(p.getByRole("radio", { name: /nETH/ })); await sleep(2500);
    await scrollBy(560, 1200); await sleep(3000); await scrollBy(-560, 800);
    // Borrow: lock the receipt shares, borrow USDG at the Chainlink value
    await click(p.getByRole("tab", { name: "Borrow" }), "borrow tab"); await sleep(4000);
    const row = p.locator(".nk-items li").first();
    await typeIn(row.locator("input"), "0.5", "lock amount");
    await click(row.getByRole("button", { name: "Lock", exact: true }), "lock");
    await until(async () => /Locked|reverted|rror/.test(await status()), "lock", 120000); result("lock", await status());
    await scrollBy(-600, 600); await sleep(8500);
    await typeIn(p.locator("#nk-borrow"), "25", "borrow amount"); await sleep(1800);
    await click(p.locator(".nk-cta"), "borrow");
    await until(async () => /Borrowed|reverted|rror/.test(await status()), "borrow", 120000); result("borrow", await status()); await sleep(3500);
    // Bridge: USDG on Robinhood -> USDC on Arc; live Relay and Across quotes; Chainlink CRE approves on-chain
    await click(p.getByRole("tab", { name: "Bridge" }), "bridge tab"); await sleep(6000);
    result("bridge quotes", (await p.locator(".nk-routes").innerText()).replace(/\n+/g, " | "));
    await click(p.locator(".nk-cta"), "bridge");
    await until(async () => /Approved by Chainlink CRE|Rejected|Did not complete|Deposited into/.test(await p.locator(".nk-col").innerText()), "CRE decision", 180000);
    await sleep(1500); await scrollBy(420, 900);
    result("bridge", (await p.locator(".nk-col").innerText()).match(/(Approved by Chainlink CRE|Rejected[^\n]*|Did not complete|Deposited into Relay)[\s\S]{0,300}/)?.[0]); await sleep(4000);
    await cut(); await save();
  }

  if (take === "credit") {
    await p.goto(`${APP}/#/app/bridge`); await sleep(6000);
    await moveTo(640, 360, 1);
    await rollCamera(); await sleep(1500);
    // Credit: lock 1 NVDA, the underwriter (with the sealed 0G check) signs the terms, NorenCredit opens the line,
    // Chainlink CRE writes it to NorenCreditLine on Arc. This is the one paid 0G call.
    await click(p.getByRole("tab", { name: "Credit" }), "credit tab"); await sleep(5000);
    await until(async () => /Lock 1 NVDA and open the line/.test(await p.locator(".nk-cta").first().innerText()), "credit quote", 60000);
    await point(p.locator(".nk-card").first()); await sleep(1500);
    await click(p.locator(".nk-cta").first(), "open credit line");
    await until(async () => /Locked 1 NVDA|reverted|Declined|rror|Setup required/.test(await p.locator(".nk-col").innerText()), "credit line", 240000);
    result("credit open", (await p.locator(".nk-col").innerText()).match(/(Locked 1 NVDA[^\n]*|Declined[^\n]*|[^\n]*reverted[^\n]*|Setup required[^\n]*)/)?.[0]);
    await save();
    await until(async () => /Live on Arc/.test(await p.locator(".nk-card").first().innerText()), "line live on Arc", 180000);
    result("line", (await p.locator(".nk-card").first().innerText()).replace(/\n+/g, " | ")); await sleep(3500);
    await scrollBy(700, 1400); await sleep(3000);
    await point(p.getByText("Your credit limit grows with reputation")); await sleep(2500);
    await scrollBy(500, 1000); await sleep(3000);
    await scrollBy(900, 1400); await sleep(3500);
    result("credit page", (await p.locator(".nk-col").innerText()).replace(/\n+/g, " | ").slice(0, 3000));
    await cut(); await save();
  }

  if (take === "shop") {
    await p.goto(`${SHOP}/#/`); await sleep(3500);
    await moveTo(640, 360, 1);
    await rollCamera(); await sleep(2500);
    await scrollBy(700, 1600); await sleep(1200);
    await click(p.getByRole("link", { name: "Dresses" }).first(), "dresses"); await sleep(2000);
    await scrollBy(380, 900); await sleep(1500);
    await click(p.locator('a.card[href="#/p/amelie-gingham"]'), "Amélie Gingham"); await sleep(2500);
    await click(p.getByRole("button", { name: "S", exact: true }), "size S"); await sleep(700);
    await click(p.getByRole("button", { name: /Add to bag/ }), "add to bag"); await sleep(2500);
    await click(p.locator(".drawer").getByRole("link", { name: "View bag" }), "view bag"); await sleep(2000);
    await click(p.getByRole("link", { name: "Atelier notes" }), "how this shop added Noren"); await sleep(3000);
    await point(p.locator("figure.code")); await sleep(1500);
    await scrollBy(260, 1400); await sleep(4000);
    await click(p.getByRole("button", { name: /Open bag/ }), "bag"); await sleep(1500);
    await click(p.locator(".drawer").getByRole("link", { name: "View bag" }), "view bag"); await sleep(2000);
    await click(p.getByRole("button", { name: /Checkout with/ }), "checkout with Noren");
    await p.waitForURL(/#\/pay\//, { timeout: 60000 }); result("checkout", p.url()); await sleep(4500);
    await click(p.getByRole("tab", { name: /Pay with stocks/ }), "pay with stocks");
    await until(async () => /Pay with [\d.]+ NVDA/.test(await p.locator(".btn.kaki").innerText()), "stock quote", 90000); await sleep(2000);
    result("stock quote", (await p.locator(".co-credit").innerText()).replace(/\n+/g, " | "));
    await point(p.locator(".co-routes")); await sleep(2000);
    await click(p.locator(".co-routes button").first(), "Aqua maker route"); await sleep(1200);
    await click(p.locator(".btn.kaki"), "pay with stock");
    await until(async () => /Paid with/.test(await p.locator("body").innerText()), "stock payment", 120000); await sleep(2500);
    result("stock paid", (await p.locator("body").innerText()).match(/Paid with stocks[\s\S]{0,500}/)?.[0]);
    await sleep(4000);
    // the checkout counts down and returns to the shop's order page (successUrl)
    await p.waitForURL(/8780\/#\/order\//, { timeout: 30000 });
    await until(async () => /Paid/.test(await p.locator(".status").innerText()), "order paid", 60000);
    result("order", (await p.locator(".order").innerText()).replace(/\n+/g, " | ")); await sleep(5000);
    await cut(); await save();
  }

  if (take === "order") {
    // the shop's own order page for an order paid in an earlier take (ORDER=AUB-xxxxxx)
    await p.goto(`${SHOP}/#/order/${process.env.ORDER}`); await sleep(3000);
    await moveTo(900, 500, 1);
    await rollCamera(); await sleep(1500);
    await until(async () => /Paid/.test(await p.locator(".status").innerText()), "order paid", 60000);
    result("order", (await p.locator(".order").innerText()).replace(/\n+/g, " | "));
    await point(p.locator(".facts")); await sleep(4000); await scrollBy(250, 900); await sleep(3000);
    await cut();
  }

  if (take === "private") {
    const link = (await import("node:fs")).readFileSync(`${HERE}state/link1.txt`, "utf8").trim();
    await p.goto(link.replace(/^.*#/, `${MERCH}/#`)); await sleep(4500);
    await moveTo(1000, 300, 1);
    await rollCamera(); await sleep(1500);
    await click(p.getByRole("tab", { name: /Pay privately/ }), "pay privately"); await sleep(2500);
    await click(p.getByRole("button", { name: /Shield 20 USDC/ }), "shield 20 USDC");
    await until(async () => { const bt = p.locator(".btn.ink.full"); return /Pay 12.50 USDC/.test(await bt.innerText()) && !(await bt.isDisabled()); }, "ASP approval", 180000);
    await sleep(2000); result("private balance", await p.locator(".co-bal").innerText());
    await click(p.locator(".btn.ink.full"), "pay privately 12.50");
    await until(async () => /Paid\s*privately/.test(await p.locator("body").innerText()), "private payment", 180000); await sleep(1500);
    result("private paid", (await p.locator("body").innerText()).match(/Paid\s*privately[\s\S]{0,400}/)?.[0]); await sleep(5000);
    // the store's view: Noren Merchant, customers identified 0
    await p.goto(`${MERCH}/#/dashboard`); await sleep(5000);
    result("dashboard", (await p.locator("main, body").first().innerText()).slice(0, 800)); await sleep(3000);
    await cut(); await save();
  }

  if (take === "privdefault") {
    // A fresh merchant and a fresh customer (one browser profile). Off camera: sign in, create the store and a 12.50 link.
    await p.goto(`${MERCH}/#/dashboard/onboard`); await sleep(3000);
    await p.getByRole("button", { name: /Use a test wallet/ }).click();
    await until(() => p.getByText("What's your business called?").isVisible(), "signed in");
    await p.locator(".ob-field input").first().fill("Juhu Chai House");
    await p.getByRole("button", { name: /Continue/ }).click(); await sleep(1000);
    await p.getByRole("radio", { name: /USDC on Arc to my wallet/ }).click();
    await p.getByRole("button", { name: /Create store/ }).click();
    await until(() => p.getByText("Create your first payment link").isVisible(), "store created", 60000);
    await p.locator(".ob-field input").nth(1).fill("Masala chai for the team");
    await p.getByRole("button", { name: /Create link/ }).click();
    await until(() => p.locator(".ob-link").isVisible(), "link", 60000);
    const link = await p.locator(".ob-url").innerText(); log("link", link);
    writeFileSync(`${HERE}state/link-priv.txt`, link); await save();
    // On camera: the hosted checkout opens on "Pay privately" (the default), funds, shields and pays.
    await p.goto(link.replace(/^.*#/, `${MERCH}/#`)); await sleep(5000);
    await moveTo(900, 260, 1);
    await rollCamera(); await sleep(1800);
    result("default method", await p.locator(".co-methods [aria-selected=true]").innerText());
    await point(p.locator(".co-methods [aria-selected=true]")); await sleep(1800);
    await click(p.getByRole("button", { name: /Get test USDC/ }), "get test USDC");
    await until(async () => /Shield 20 USDC/.test(await p.locator(".co-fund").innerText()) && !(await p.getByRole("button", { name: /Sending/ }).count()), "faucet", 60000); await sleep(1200);
    await click(p.getByRole("button", { name: /Shield 20 USDC/ }), "shield 20 USDC");
    await until(async () => { const bt = p.locator(".btn.ink.full"); return /Pay 12.50 USDC/.test(await bt.innerText()) && !(await bt.isDisabled()); }, "ASP approval", 180000);
    await sleep(1500); result("private balance", await p.locator(".co-bal").innerText());
    await click(p.locator(".btn.ink.full"), "pay privately 12.50");
    await until(async () => /Paid\s*privately/.test(await p.locator("body").innerText()), "private payment", 180000); await sleep(1500);
    result("private paid", (await p.locator("body").innerText()).match(/Paid\s*privately[\s\S]{0,400}/)?.[0]); await sleep(4000);
    // The store's view in Noren Merchant: the payment, and who paid it ("Private")
    await p.goto(`${MERCH}/#/dashboard/payments`); await sleep(4500);
    const row = p.locator("tr", { hasText: "Masala chai" }).first();
    result("payments row", (await row.innerText()).replace(/\s+/g, " "));
    await point(row); await sleep(1800);
    await click(row, "open payment");
    await until(async () => /Customer/.test(await p.locator("main").innerText()), "payment detail", 30000); await sleep(1200);
    const who = p.locator(".sd-private").first();
    result("customer", await p.locator("main").innerText().then((t) => t.match(/Customer\s*\n?\s*[^\n]+/)?.[0]));
    if (await who.count()) { await point(who); } await sleep(4500);
    await cut(); await save();
  }

  if (take === "privcredit") {
    // Pay later, privately. Off camera, one fresh person: a store with a 12.50 link (Noren Merchant), then the same
    // browser as the customer: fork faucets, lock 1 NVDA and open a credit line (one 0G credit check), wait until CRE
    // has the line live on Arc. On camera: the checkout's "Pay later, privately", paid, then Noren Merchant.
    await p.goto(`${MERCH}/#/dashboard/onboard`); await sleep(3000);
    await p.getByRole("button", { name: /Use a test wallet/ }).click();
    await until(() => p.getByText("What's your business called?").isVisible(), "signed in");
    await p.locator(".ob-field input").first().fill("Juhu Chai House");
    await p.getByRole("button", { name: /Continue/ }).click(); await sleep(1000);
    await p.getByRole("radio", { name: /USDC on Arc to my wallet/ }).click();
    await p.getByRole("button", { name: /Create store/ }).click();
    await until(() => p.getByText("Create your first payment link").isVisible(), "store created", 60000);
    await p.locator(".ob-field input").nth(1).fill("Masala chai for the team");
    await p.getByRole("button", { name: /Create link/ }).click();
    await until(() => p.locator(".ob-link").isVisible(), "link", 60000);
    const link = await p.locator(".ob-url").innerText(); log("link", link);
    writeFileSync(`${HERE}state/link-privcredit.txt`, link); await save();
    await p.goto(`${APP}/#/app/earn`); await sleep(6000);
    await p.locator(".nk-chip").click(); await sleep(1500);
    await p.getByRole("button", { name: /Get test stock and USDG/ }).click();
    await until(async () => /faucet:/i.test(await p.locator(".nk-menu [role=status]").innerText()), "robinhood faucet", 120000);
    await p.getByRole("button", { name: /Get test USDC \(Arc fork\)/ }).click();
    await until(async () => /Arc fork faucet/.test(await p.locator(".nk-menu [role=status]").innerText()), "arc faucet", 60000);
    await p.locator(".nk-x").click(); await sleep(2000);
    await p.getByRole("tab", { name: "Credit" }).click(); await sleep(5000);
    await until(async () => /Lock 1 NVDA and open the line/.test(await p.locator(".nk-cta").first().innerText()), "credit quote", 90000);
    await p.locator(".nk-cta").first().click();
    await until(async () => /Locked 1 NVDA|reverted|Declined|rror|Setup required/.test(await p.locator(".nk-col").innerText()), "credit line", 240000);
    log("credit open", (await p.locator(".nk-col").innerText()).match(/(Locked 1 NVDA[^\n]*|Declined[^\n]*|[^\n]*reverted[^\n]*|Setup required[^\n]*)/)?.[0]);
    await until(async () => /Live on Arc\s*\n?\s*Limit|Available on Arc\s*\n?\s*[\d.]+/.test(await p.locator(".nk-card").first().innerText()) && !/Bridging/.test(await p.locator(".nk-card").first().innerText()), "line live on Arc", 240000);
    log("line", (await p.locator(".nk-card").first().innerText()).replace(/\n+/g, " | ").slice(0, 300)); await save();
    // On camera
    await p.goto(link.replace(/^.*#/, `${MERCH}/#`)); await sleep(5000);
    await moveTo(900, 260, 1);
    await rollCamera(); await sleep(1200);
    await click(p.getByRole("tab", { name: /Pay later, privately/ }), "pay later, privately"); await sleep(2500);
    result("privcredit panel", (await p.locator("body").innerText()).match(/never learns who paid[\s\S]{0,300}/)?.[0]);
    const gas = p.getByRole("button", { name: /gas/i });
    if (await gas.count() && await gas.first().isVisible()) { await click(gas.first(), "gas for the draw"); await sleep(3000); }
    const go = p.locator(".btn.ink.full");
    await until(async () => !(await go.isDisabled()), "pay later privately enabled", 60000);
    result("button", await go.innerText());
    await click(go, "pay later, privately");
    await until(async () => /Paid\s*later,?\s*privately/.test(await p.locator("body").innerText()), "private credit payment", 240000); await sleep(1500);
    result("private paid", (await p.locator("body").innerText()).match(/Paid\s*later,?\s*privately[\s\S]{0,500}/)?.[0]); await sleep(3500);
    await cut(); await save();
  }

  if (take === "privcredit-m") {
    // Noren Merchant after the "Pay later, privately" payment of the privcredit take (same browser profile)
    await p.goto(`${MERCH}/#/dashboard/payments`); await sleep(5000);
    await moveTo(900, 300, 1);
    await rollCamera(); await sleep(1500);
    const row = p.locator("tr", { hasText: process.env.ROW_TEXT ?? "Masala chai" }).first();
    result("payments row", (await row.innerText()).replace(/\s+/g, " "));
    await point(row); await sleep(1200);
    await click(row, "open payment");
    await until(async () => /Customer/.test(await p.locator("main").innerText()), "payment detail", 30000); await sleep(1000);
    result("customer", await p.locator("main").innerText().then((t) => t.match(/Customer\s*\n?\s*[^\n]+/)?.[0]));
    const who = p.locator(".sd-private").first();
    if (await who.count()) await point(who); await sleep(4000);
    await cut(); await save();
  }

  if (take === "xchain") {
    // The Noren app's Bridge tab (CCTP from 10 chains, the runs already done on testnets), then Noren Merchant's live
    // view: "From other chains into Arc", read from the public Arc testnet and the source chains' records.
    await p.addInitScript(() => { try { localStorage.setItem("noren.net", "fork"); } catch {} });
    await p.goto(`${APP}/#/app/bridge`); await sleep(7000);
    await moveTo(640, 300, 1);
    await rollCamera(); await sleep(2500);
    result("bridge", (await p.locator("main").innerText()).slice(0, 300).replace(/\n+/g, " | "));
    await point(p.getByText("Already done on testnets")); await sleep(1500);
    await scrollBy(260, 900); await sleep(3000);
    await p.goto(`${MERCH}/#/dashboard/payments`); await sleep(4500);
    await click(p.getByRole("radio", { name: "Arc testnet (live)" }), "Arc testnet (live)");
    await until(async () => /From other chains into Arc/.test(await p.locator("main").innerText()), "live panel", 60000); await sleep(3000);
    await point(p.getByText("From other chains into Arc")); await sleep(1500);
    result("live list", (await p.locator("main").innerText()).match(/From other chains into Arc[\s\S]{0,1500}/)?.[0]?.replace(/\n+/g, " | "));
    await scrollBy(420, 1500); await sleep(3000);
    await scrollBy(380, 1500); await sleep(3000);
    await click(p.getByRole("radio", { name: "Local fork" }), "back to the local fork"); await sleep(1500);
    await cut();
  }

  if (take.startsWith("xexplorer")) {
    // The live cross-chain runs on public explorers (docs/PRIVACY.md, docs/AQUA-LIVE.md, docs/CCIP.md)
    const pages = (process.env.PAGES ?? "").split(",").filter(Boolean);
    await p.goto(pages[0]); await sleep(8000);
    await moveTo(640, 300, 1);
    await rollCamera();
    for (let i = 0; i < pages.length; i++) {
      if (i) { await p.goto(pages[i]).catch((e) => log("goto", e.message)); await sleep(8000); }
      ev("result", `page ${i}`, { value: pages[i] }); log("page", i, pages[i]);
      await sleep(3500); await scrollBy(260, 1200); await sleep(3500);
    }
    await cut();
  }

  if (take === "explorer") {
    await p.goto(`${ARC_EXPLORER}/tx/${LIVE_PAY}`); await sleep(6000);
    await moveTo(640, 300, 1);
    await rollCamera(); await sleep(6000);
    await scrollBy(300, 1500); await sleep(4000);
    await scrollBy(300, 1500); await sleep(3000);
    await p.goto(`${ARC_EXPLORER}/tx/${LIVE_REFUND}`); await sleep(7000);
    await scrollBy(300, 1500); await sleep(3500);
    await cut();
  }

  if (take === "later") {
    await p.goto(`${APP}/#/app/credit`); await sleep(6000);
    await moveTo(640, 300, 1);
    await rollCamera(); await sleep(1500);
    await point(p.getByText("Your credit limit grows with reputation")); await sleep(4000);
    result("ladder", (await p.locator(".nk-card", { hasText: "Your credit limit grows" }).innerText()).replace(/\n+/g, " | "));
    // the store makes a second link in Noren Merchant
    await p.goto(`${MERCH}/#/dashboard/links`); await sleep(4000);
    await click(p.getByRole("button", { name: /Create payment link/ }).first(), "create payment link"); await sleep(1500);
    await typeIn(p.locator("#cl-desc"), "Chai and samosas, office order", "description");
    await typeIn(p.locator("#cl-amt"), "24", "amount"); await sleep(1200);
    await click(p.locator("[role=dialog]").last().getByRole("button", { name: "Create link" }), "create link");
    await p.waitForURL(/#\/dashboard\/payments\/0x[0-9a-fA-F]{64}/, { timeout: 60000 });
    const id2 = p.url().match(/0x[0-9a-fA-F]{64}/)[0]; result("link2", id2); await sleep(3000);
    await p.goto(`${MERCH}/#/pay/${id2}`); await sleep(4500);
    await click(p.getByRole("tab", { name: /Pay in 3/ }), "pay in 3");
    await until(async () => /Use [\d.]+ USDC of my credit/.test(await p.locator(".btn.kaki").innerText()), "credit available", 60000); await sleep(3000);
    result("credit checkout", (await p.locator(".co-credit").innerText()).replace(/\n+/g, " | "));
    await click(p.locator(".btn.kaki"), "pay from credit line");
    await until(async () => /Paid on\s*credit/.test(await p.locator("body").innerText()), "credit payment", 120000); await sleep(3000);
    result("credit paid", (await p.locator("body").innerText()).match(/Paid on\s*credit[\s\S]{0,400}/)?.[0]); await sleep(3000);
    // repay the first part in the Noren app; CRE carries Repaid back to NorenCredit
    await p.goto(`${APP}/#/app/credit`); await sleep(6000);
    await point(p.locator(".nk-card").first()); await sleep(2500);
    const repay = p.getByRole("button", { name: /Repay [\d.]+ USDC/ });
    await click(repay, "repay first part");
    await until(async () => /Repaid [\d.]+ USDC on Arc|reverted|rror/.test(await p.locator(".nk-col").innerText()), "repayment", 120000);
    result("repaid", (await p.locator(".nk-col").innerText()).match(/Repaid [^\n]*/)?.[0]); await sleep(6000);
    result("line after", (await p.locator(".nk-card").first().innerText()).replace(/\n+/g, " | "));
    await cut(); await save();
  }

  if (take === "world") {
    const wait = Number(process.env.WORLD_WAIT_MIN ?? 30) * 60_000;
    await p.goto(`${APP}/#/app/credit`); await sleep(6000);
    const me = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem("noren.customer.v1") ?? "null") ? "ok" : null; } catch { return null; } });
    if (!me) throw new Error("no customer key in the saved profile: run the app take first");
    const addr = (await p.locator(".nk-chip").innerText()).trim();
    await moveTo(640, 300, 1);
    await rollCamera(); await sleep(1500);
    const card = p.locator(".nk-card", { hasText: "Verify you're human with World ID" });
    await point(card); await sleep(2000);
    const statusUrl = `${SERVER}/world-id/status/`;
    // the wallet address the server keys World ID by: read it from the wallet menu
    await click(p.locator(".nk-chip"), "wallet"); await sleep(800);
    const account = (await p.locator(".nk-menu-row span").first().innerText()).trim();
    await click(p.locator(".nk-x"), "close wallet"); await sleep(600);
    result("world wallet", `${addr} ${account}`);
    const started = Date.now();
    let verified = false, rounds = 0;
    while (Date.now() - started < wait && !verified) {
      rounds++;
      const btn = card.getByRole("button", { name: /Verify with World ID|Try again|Start again|Verify/ }).first();
      if (await btn.count()) { await click(btn, `verify with World ID (${rounds})`); await moveTo(1180, 660, 18); } // pointer off the QR
      await sleep(6000);
      await p.screenshot({ path: `${HERE}state/world-qr.png` }).catch(() => {});
      const links = await p.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => /world|idkit|wld/i.test(h))).catch(() => []);
      writeFileSync(`${HERE}state/world-ready.txt`, `${new Date().toISOString()}\n${links.join("\n")}\n`);
      log("World ID take ready: QR open on the Mac; waiting for World App");
      const roundEnd = Date.now() + 4.6 * 60_000; // IDKit requests expire after 5 minutes
      while (Date.now() < roundEnd && Date.now() - started < wait) {
        const s = await fetch(statusUrl + account).then((r) => r.json()).catch(() => ({}));
        if (s.verified) { verified = true; result("world status", JSON.stringify(s)); break; }
        await sleep(3000);
      }
      if (!verified) { await p.keyboard.press("Escape").catch(() => {}); await sleep(1500); }
    }
    ev(verified ? "world-verified" : "world-timeout", verified ? "World ID verified" : "World ID not verified in time");
    await sleep(8000);
    if (verified) { await p.reload(); await sleep(7000); await point(p.getByText("Your credit limit grows with reputation")); await sleep(5000); result("ladder after", (await p.locator(".nk-card", { hasText: "Your credit limit grows" }).innerText()).replace(/\n+/g, " | ")); }
    await cut(); await save();
  }
} catch (e) {
  log("TAKE FAILED:", e.message);
  await p.screenshot({ path: `${TAKES}${take}.failed.png` }).catch(() => {});
  if (t0) await cut().catch(() => {});
  await save().catch(() => {});
  process.exitCode = 1;
} finally {
  await b.close();
}

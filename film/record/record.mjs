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
const TAKES = `${HERE}takes/`, STATE = `${HERE}state/state.json`;
mkdirSync(TAKES, { recursive: true }); mkdirSync(`${HERE}state`, { recursive: true });
const APP = "http://localhost:5190", SHOP = "http://127.0.0.1:8780", SERVER = "http://127.0.0.1:8790";
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
async function moveTo(x, y, steps = 22) { await p.mouse.move(x, y, { steps }); mx = x; my = y; }
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

try {
  if (take === "landing") {
    await p.goto(`${APP}/#/`); await sleep(2500);
    await rollCamera(); await sleep(3500);
    const H = await p.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < Math.min(H, 7600); y += 40) { await p.mouse.wheel(0, 40); await sleep(55); }
    await sleep(1500);
    await cut();
  }

  if (take === "onboard") {
    await p.goto(`${APP}/#/dashboard/onboard`); await sleep(3000);
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
    await p.waitForURL(/localhost:5190\/#\/pay\//, { timeout: 30000 }); result("checkout", p.url()); await sleep(4500);
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
    await p.goto(link.replace(/^.*#/, `${APP}/#`)); await sleep(4500);
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
    await p.goto(`${APP}/#/dashboard`); await sleep(5000);
    result("dashboard", (await p.locator("main, body").first().innerText()).slice(0, 800)); await sleep(3000);
    await cut(); await save();
  }

  if (take === "privdefault") {
    // A fresh merchant and a fresh customer (one browser profile). Off camera: sign in, create the store and a 12.50 link.
    await p.goto(`${APP}/#/dashboard/onboard`); await sleep(3000);
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
    await p.goto(link.replace(/^.*#/, `${APP}/#`)); await sleep(5000);
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
    await p.goto(`${APP}/#/dashboard/payments`); await sleep(4500);
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
    await p.goto(`${APP}/#/dashboard/onboard`); await sleep(3000);
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
    await p.goto(link.replace(/^.*#/, `${APP}/#`)); await sleep(5000);
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
    await p.goto(`${APP}/#/dashboard/payments`); await sleep(5000);
    await moveTo(900, 300, 1);
    await rollCamera(); await sleep(1500);
    const row = p.locator("tr", { hasText: "Masala chai" }).first();
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
    await p.goto(`${APP}/#/dashboard/payments`); await sleep(4500);
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
    await p.goto(`${APP}/#/dashboard/links`); await sleep(4000);
    await click(p.getByRole("button", { name: /Create payment link/ }).first(), "create payment link"); await sleep(1500);
    await typeIn(p.locator("#cl-desc"), "Chai and samosas, office order", "description");
    await typeIn(p.locator("#cl-amt"), "24", "amount"); await sleep(1200);
    await click(p.locator("[role=dialog]").last().getByRole("button", { name: "Create link" }), "create link");
    await p.waitForURL(/#\/dashboard\/payments\/0x[0-9a-fA-F]{64}/, { timeout: 60000 });
    const id2 = p.url().match(/0x[0-9a-fA-F]{64}/)[0]; result("link2", id2); await sleep(3000);
    await p.goto(`${APP}/#/pay/${id2}`); await sleep(4500);
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

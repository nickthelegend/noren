# Film v6 plan (record on the hosted deployment, 180.0 s, real time, voice only)

Rules carried over from v5: every shot at 1.0× (no speed-ups, no badges), no music (voice + the UI's own clicks), jump
cuts only between whole actions. New for v6 (Nick, Nov 7):

- **One action per shot, full frame, steady.** No camera zoom or pan in the app (at most one very slow push on a single
  shot); no "follow" camera; no click-around micro-cuts. Fewer, longer real-time takes joined by clean hard cuts.
- **Shop beat is the shopping flow**, not the code file: Aubelle → dress → size → add to bag → bag → checkout → Noren
  checkout. Code at most 2–3 s (or dropped).
- **Hosted deployment only.** Record on the hosted app/shop/server URLs (env `NOREN_APP_URL`, `NOREN_SHOP_URL`,
  `NOREN_SERVER_URL` in `record/record.mjs`). The consumer app has no "Local fork" toggle in the hosted mode.
- **Badges:** "Arc testnet · live" and "Robinhood Chain · mainnet snapshot". Never the word "fork"; never "mainnet"
  alone. Explorer shots keep "<chain> · live · public explorer".
- **Pay with stocks:** the checkout's whole token list (TSLA, AAPL, NVDA, SPY, MSFT, GOOGL, AMZN, META, QQQ, COIN, ETH),
  then one payment (`PAY_WITH=<symbol>`, default NVDA).

## Timeline and narration

| Time | Shot(s) (each one whole action, full frame) | Take | Badge | Voice (start → end) |
|---|---|---|---|---|
| 0–5 | Problem card → "Stablecoins, stocks or credit — privately." | drawn | — | v1 0.0 → 15.5 |
| 5–15 | Website, one slow eased scroll | `landing4` re-take on the hosted URL | the real website | |
| 15–35 | Noren Merchant: Privy modal (2.5) · injected wallet → SIWE (3) · business name (3.5) · payouts → store (3.5) · first link (4) · API keys, secret redacted (3.5) | `merchant3` re-take, hosted | Arc testnet · live | v2 15.5 → 32.4 |
| 35–54 | Aubelle home → Dresses (3) · dress page, size S, add to bag (5) · bag drawer → bag page (3) · "Checkout with Noren" → Noren checkout (3) · four ways to pay, pointer over each (4) · `server/noren.ts` (≤1 s, or dropped) | `shop6` (new), hosted | Arc testnet · live | v3 35.3 → 50.3 (15.0 s, new) |
| 54–66 | App: Privy modal (2.5) · browser wallet connect (2.5) · Home (3.5) · paste link → paid privately (3.5) | `applogin3`/`apphome3` re-takes, hosted | Arc testnet · live | v4 54.2 → 64.2 |
| 66–86 | Bridge: chain picker (5) · Ethereum Sepolia burn (3) + Arc mint (3) · Base burn + mint (2+2) · Arbitrum burn + mint (2+2) · one live transfer from the hosted app if its test key is funded, else Robinhood → Arc from v4 (3) | `bridge4` re-take + `xexplorer4` | Arc testnet · live / each chain · live · public explorer | v4e 66.4 → 79.0 |
| 86–90 | Stocks → USDC on Arc (whole tab, one shot) | `stocks3` re-take, hosted | Robinhood Chain · mainnet snapshot | v4c 86.2 → 98.4 |
| 90–98 | Any chain ⇄ Arc diagram (Ethereum, Base, Arbitrum, Robinhood logos) | drawn | — | |
| 98–131 | Stocks → credit, 8–9 full-frame shots of ~3.7 s: deposit 2 NVDA · "your stock is now 1inch Aqua liquidity" (maker card, three jobs) · limit at 66% · World ID QR · Reclaim QR waiting · repayment record → 70% · open the line · pay later at checkout · fees pay it down | `credit4a`–`credit4d` re-takes on hosted (Robinhood Chain · mainnet snapshot) | Robinhood Chain · mainnet snapshot; World ID · production; Reclaim · real request · not completed | v4b 99.8 → 116.4, v4d 124.6 → 129.7 |
| 131–134 | Swap (one shot) | `swap3` re-take | Arc testnet · live | v4s 130.6 → 134.7 |
| 134–146 | Checkout on Pay privately → shield → pay → paid (8) · Noren Merchant "Customer: Private" (4) | `privdefault` re-take, hosted | Arc testnet · live | v5a 134.1 → 147.3 |
| 146–158.5 | Pay with stocks or crypto: the full token list (5) · pick one, quote (3.5) · paid (4) | `stockpay6` (new) | Robinhood Chain · mainnet snapshot | v5b 147.4 → 159.8 (12.4 s, new) |
| 158.5–167 | Pay later privately: Noren Merchant "Private" (3) · World ID Orb (2) · live CCIP explorer (3.5) | existing | Arc testnet · live / World ID · production / CCIP · live | v5c 159.9 → 167.2 |
| 167–180 | Live-on-public-testnets card → end card with the tagline | drawn | — | v6 167.4 → 179.8 |

Re-voiced now: v3 (shopping flow, 15.0 s) and v5b (any stock or crypto, 12.4 s at 1.15). Everything else keeps its
current audio.

## What the hosted recording needs

- The hosted app, shop and server URLs, and the Robinhood mainnet-snapshot RPC the server uses.
- `dev-reputation-ladder.ts` and `dev-maker-fill.ts` only accept a `127.0.0.1` Anvil RPC. For the hosted snapshot, run
  them through an SSH tunnel to the VPS (`NOREN_RH_RPC=http://127.0.0.1:<tunnel port>`), or skip the 70% step and the
  fee pay-down if the deploy agent offers no tunnel.
- If the hosted Arc side is the public testnet, the in-app pay and private checkout use real testnet USDC. The test key
  needs funding with `scripts/live/fund-test-key.ts` (≤1 USDC on Arc) under the deployer lock.
- Credit beat budget: at most one paid 0G check (open the line once).

Deadline: record and render by 07:00 IST (submission 09:00, live judging 09:30).

## Narration: Nick's voice (ElevenLabs), confident take

Voice: Nick's instant clone `MjGt6kOSu6JUWZqpE0Z3` (his choice). Three v1 variants were measured (pace, loudness,
loudness range, pauses, pitch spread, and a transcript for pronunciation):

| Variant | Pace (words/s) | Loudness (LUFS) | LRA | Pauses | Pitch spread | Notes |
|---|---|---|---|---|---|---|
| a `eleven_multilingual_v2`, stability 0.35, similarity 0.85, style 0.45, speaker boost | 1.94 | -11.3 | 3.1 | 6, at full stops | 4.71 st | "Noren", "Aqua" clear; ends each statement |
| b `eleven_v3`, same | 2.45 | -12.6 | 1.8 | 0 | 4.58 st | flattest; "No run", "Arkwa" |
| c `eleven_turbo_v2_5`, stability 0.4, style 0.35 | 2.34 | -10.8 | 2.9 | 3 | 4.57 st | runs sentences together |

**Chosen: (a)**, the most dynamic and the only one that lands each short statement. The lines were rewritten as short
declaratives (full stops, no hedging) so the slower, firmer delivery still fits every slot without speeding up:

| Line | s | Placed at |
|---|---|---|
| v1 | 14.33 | 0.0 |
| v2 | 17.76 | 15.9 |
| v3 | 13.98 | 35.3 |
| v4 | 7.41 | 54.2 |
| v4e | 13.36 | 66.4 |
| v4c | 11.33 | 86.2 |
| v4b | 20.49 | 99.8 |
| v4d | 4.03 | 124.6 |
| v4s | 3.44 | 130.2 |
| v5a | 8.34 | 134.4 |
| v5b | 10.33 | 146.6 |
| v5c | 6.20 | 159.0 |
| v6 | 11.79 | 167.6 (ends 179.4) |

Characters used on Nov 7: about 5,650 in all (two full passes, the re-dos, the pronunciation test and the 3-variant test).

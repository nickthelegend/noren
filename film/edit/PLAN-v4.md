# Film v4: edit plan (180.0 s exactly)

Done on `film-v4` now: the smooth landing take (`landing4`: one easeInOutCubic scroll, 2.5 viewport heights over 10 s,
shown at 1.0× with no speed badge), the new v1 ("Pay a shop in crypto today… Noren lets merchants accept stablecoins,
stocks or credit — privately. Underneath: a payment network on Arc, lending pools that are 1inch Aqua liquidity, and USDC
from any chain."), the problem → positioning title card, and the end card tagline "Pay with stablecoins, stocks or
credit — privately." (logo, "Noren", "MIT · ETHGlobal Mumbai 2026" kept). Waiting for branch `v4` for everything below.

| Time | Section | Source | Status |
|---|---|---|---|
| 0–5 | Problem card → "Stablecoins, stocks or credit — privately." | drawn | done |
| 5–15 | Website, smooth scroll, 1.0× | `landing4` (re-take on v4 if the landing copy changes) | done |
| 15–35 | Noren Merchant: Privy modal glimpse, injected wallet, SIWE, store, link, keys (redacted) | `merchant3` | keep |
| 35–55 | Aubelle + SDK file + the four ways to pay. Stocks card: "pay with stocks or crypto" if v4 confirms ETH works, else "pay with any stock you hold" | `shop3` / new take on v4 | v4 |
| 55–67 | App: Privy glimpse → browser wallet → Home → in-app private pay | `applogin3`, `apphome3` | keep |
| 67–98 | **USDC from any chain to Arc** (replaces the Robinhood⇄Arc niche): the chain picker with Ethereum, Base, Arbitrum, Robinhood logos; live transfers from Ethereum, Base and Arbitrum Sepolia (v4's live txs, explorer pages); one Robinhood → Arc; diagram "any chain → Circle → Arc" (CCTP), plus the stock order and CCIP lanes | new takes on v4 (`bridge4`, `xexplorer4`), `@xchain` card redrawn | v4 |
| 98–111 | **Earn / Borrow, lead with stocks (NVDA), loans that pay themselves down.** Not pre-zoomed: start full width, the cursor travels to the Earn tab and clicks; then a camera that follows the logged cursor (`move` events, below) through: deposit NVDA into the Aqua pool → "your stock is now 1inch Aqua liquidity" → the maker card's three jobs (backs loans / earns fees / runs liquidations) → the borrow limit at 66% → credit tasks (World ID QR, repay milestone) → limit rises to 80% → borrow → "earned X USDG from N fills" → "Use earnings" → debt drops. Caption with the real numbers on screen: "$100 of NVDA → borrow up to $80" only if the deposit is exactly $100, otherwise "borrow up to 80% of your NVDA" (or the real ratio shown). Badge "Local fork · Robinhood Chain snapshot", caption "fork demo · fees from real Aqua fills". No APY. 66% → 80% must come from real fork actions (v4 product agent). | new take `selfrepay4` (NVDA) | v4 |
| 111–119.5 | **World ID / credit tasks:** the IDKit QR on screen ("Scan with World App"), the verified state, then "Raise your limit": the limit visibly increases per task (World ID, repay on time, Reclaim proof, collateral). **Reclaim** as a fast beat (QR → verified → limit up) only with Nick's Reclaim credentials; otherwise the honest "Setup required" or the beat is dropped and its seconds go to the task list. Swap stays a 2–3 s mention. | new takes on v4 | v4 + Nick |
| 119.5–167 | Payments: 05a private USDC, 05b stocks (or crypto), 05c pay later privately + repay + live CCIP | existing takes | keep |
| 167–180 | Live-on-public-testnets card (counts re-checked against v4 docs) → end card with the tagline | drawn | done (re-check counts) |

**Cursor-following camera.** `record.mjs` now logs every pointer move (`{type: "move", x, y, from}` in the take's
events, CSS px of the 1280×720 view). For the Earn beat the edit gets a zoom mode `("follow", scale)`: build.py reads the
take's move events inside the segment, maps them to film time, and writes a GSAP tween per move that pans
`transformOrigin` to the pointer at a fixed scale (1.0× at the tab click, easing up to ~1.6× while the cursor works,
back to 1.0× at the end). The cursor itself is the recorder's drawn overlay, so it moves smoothly between targets.

**Narration to re-voice once v4 lands:** v3 (four ways, stocks or crypto), v4 (any-chain bridge), v4c (diagram), v4b
(Earn → credit tasks → World ID → Reclaim → swap). v4b opens with Nick's line: "Don't sell your stocks. Deposit NVDA
into Noren's Aqua pool, borrow up to 80% of its value, and the fees it earns pay your loan back." Kokoro af_heart, transcribe for timings, update caption data-start
and the matching GSAP tweens together.

## As cut (v4 render)

0–5 problem → positioning card · 5–15 website (1.0×) · 15–35 Noren Merchant (Privy glimpse → injected wallet) ·
35–52 Aubelle, SDK file, four ways · 52–64 app sign-in, Home, in-app private pay · 64–86 USDC from any chain (chain
chips; live Ethereum/Base/Arbitrum Sepolia → Arc explorer pages; Robinhood → Arc live from the app) · 86–90 stocks → USDC
(fork) · 90–98 any-chain diagram · 98–133 stocks → credit on the v4 stack (2 NVDA → Aqua pool; $245.97 at 66%; World ID
and Reclaim QRs shown, not completed; real fork repayment steps → 70%; lock more $391.63 → $522.07; 391.51 USDC line live
on Arc; pay later 20.00 privately; 3 real Aqua fills pay it down 20.00 → 19.75), pointer-following camera · 133–136 swap
· 136–149.5 private by default + live SHIELD · 149.5–160 pay with NVDA, then ETH · 160–167 pay later privately, World ID
Orb, live CCIP · 167–180 live-on-testnets card, tagline end card. 80% is captioned as reachable with World ID and
repayment history, never shown as reached.

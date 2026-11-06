"""
The Noren film's edit decision list (v3): which real take, which seconds, how fast, and what the caption says.
Every shot is a cut of a live recording in record/takes/ (record/record.mjs); nothing is re-staged.
Speed-ups are shown on screen ("1.6x"); captions state facts read from the takes' own logs and docs/*.md.
{usdc} {usdg} {nvda} {eth} {eurc} in a caption become the token's real logo (assets/logos, SOURCES.md).

HOLD (Nick, Nov 6): the merchant onboarding (02), the app's home and in-app pay, and Earn/Borrow are placeholders
from the current takes; they are re-recorded once Privy login and the new Earn/Borrow land.
"""
import json as _json, os as _os

FPS = 30
TOTAL = 180.0

FORK = "Local forks · Arc testnet + Robinhood Chain"
RH = "Local fork · Robinhood Chain snapshot"
ARC_FORK = "Local fork · Arc testnet"
LIVE = "Arc testnet · live · public explorer"
ARB_LIVE = "Arbitrum Sepolia · live · public explorer"
RH_LIVE = "Robinhood Chain testnet · live · public explorer"
BRIDGE_LIVE = "Robinhood ⇄ Arc testnets · live · from the app"
STOCK_DEMO = "Fork demo · cross-chain Aqua order"
SWAP_LIVE = "Arc testnet · live quotes"
WORLD = "World ID · production · World App"
CCIP_LIVE = "CCIP · live · Robinhood testnet → Base → Arc"
ETH_LIVE = "Ethereum Sepolia · live · public explorer"
BASE_LIVE = "Base Sepolia · live · public explorer"
ANY_LIVE = "Any chain → Arc · CCTP V2 testnets"
RECLAIM = "Reclaim · real request · not completed"

# scene id -> (start, duration, chapter label, default network label)
SCENES = [
    ("intro", 0.0, 15.0, "01 · Noren", None),
    ("merchant", 15.0, 20.0, "02 · Noren Merchant", ARC_FORK),
    ("shop", 35.0, 17.0, "03 · Aubelle × Noren SDK", FORK),
    ("app", 52.0, 84.0, "04 · Noren app", FORK),
    ("private", 136.0, 13.5, "05a · USDC on Arc · private by default", ARC_FORK),
    ("stocks", 149.5, 10.5, "05b · Pay with stocks or crypto", RH),
    ("later", 160.0, 7.0, "05c · Pay later, privately", FORK),
    ("tech", 167.0, 13.0, "06 · Live on public testnets", None),
]

APP_CARD = (1.42, 50, 30)
OFFSET = {"intro": 5.0}
# Segments: (scene, take, in, out, rate, zoom[, network label]). zoom = (scale, x%, y%) or (from, to); None = full frame.
# A take named "@card" is a drawn card (CARDS below), "in"/"out" only give its length.
SEGMENTS = [
    # 01 the website: one slow eased scroll, 1.0x
    ("intro", "landing4", 0.9, 10.9, 1.0, None),
    # 02 Noren Merchant: the Privy modal (not completed), then the injected test wallet: SIWE, store, link, keys
    ("merchant", "merchant3", 2.0, 4.6, 1.0, None),
    ("merchant", "merchant3", 5.6, 33.0, 27.4 / 17.4, None),
    # 03 Aubelle: browse, the integration file, the hosted checkout's four ways to pay
    ("shop", "shop3", 0.5, 20.0, 2.6, None),
    ("shop", "shop", 25.5, 36.3, 2.0, ((1.0, 50, 50), (1.25, 74, 52))),
    ("shop", "shop3", 22.4, 32.0, 9.6 / (17.0 - 7.5 - 5.4), ((1.0, 50, 50), (1.18, 72, 34))),
    # 04 the Noren app at full width: Privy shown, browser wallet connected, Home, Pay privately
    ("app", "applogin3", 2.0, 4.3, 1.0, None, ARC_FORK),
    ("app", "applogin3", 6.2, 9.8, 2.0, None, ARC_FORK),
    ("app", "apphome3", 1.0, 9.4, 2.4, None, ARC_FORK),
    ("app", "apphome3", 10.5, 27.0, 16.5 / 4.4, None, ARC_FORK),
    # USDC from any chain to Arc: the chain chips, then the live transfers made from the app (public testnets)
    ("app", "bridge4", 2.0, 14.0, 2.0, None, ANY_LIVE),
    ("app", "xexplorer4", 0.5, 2.5, 1.0, (1.4, 0, 10), ETH_LIVE),
    ("app", "xexplorer4", 18.6, 20.6, 1.0, (1.12, 30, 30), LIVE),
    ("app", "xexplorer4", 36.1, 37.85, 1.0, (1.45, 30, 12), BASE_LIVE),
    ("app", "xexplorer4", 53.7, 55.45, 1.0, (1.12, 30, 30), LIVE),
    ("app", "xexplorer4", 71.1, 72.85, 1.0, (1.45, 30, 12), ARB_LIVE),
    ("app", "xexplorer4", 88.7, 90.45, 1.0, (1.12, 30, 30), LIVE),
    ("app", "bridge3", 13.4, 32.3, 18.9 / 5.0, None, BRIDGE_LIVE),
    ("app", "stocks3", 2.2, 11.6, 9.4 / 3.823, None, STOCK_DEMO),
    ("app", "@xchain", 0.0, 8.2, 1.0, None, ""),
    # Stocks -> credit (fork; real fork txs): full width, then a camera that follows the pointer
    ("app", "credit4a", 2.0, 23.0, 3.5, ("follow", 1.45, 4.2), RH),
    ("app", "credit4a", 24.3, 35.9, 3.0, ("follow", 1.45, None), RH),
    ("app", "credit4a", 36.0, 47.0, 3.0, ("follow", 1.3, None), WORLD),
    ("app", "credit4a", 49.0, 60.0, 3.0, ("follow", 1.3, None), RECLAIM),
    ("app", "credit4b", 1.5, 8.9, 2.5, ("follow", 1.45, None), RH),
    ("app", "credit4b", 8.9, 33.0, 6.0, ("follow", 1.45, None), RH),
    ("app", "credit4b", 33.0, 86.0, 53.0 / 3.8, ("follow", 1.45, None), FORK),
    ("app", "credit4c", 1.0, 19.0, 4.5, None, FORK),
    ("app", "credit4d", 2.0, 12.0, 10.0 / 3.0, ("follow", 1.45, None), RH),
    ("app", "swap3", 0.5, 5.95, 5.45 / 3.0, None, SWAP_LIVE),
    # 05a USDC on Arc, private by default, then the live CCTP SHIELD run (docs/PRIVACY.md)
    ("private", "privdefault", 0.3, 20.3, 20.0 / 8.09, None),
    ("private", "privdefault", 27.2, 33.2, 2.0, (1.9, 40, 8)),
    ("private", "xexplorer", 17.6, 18.85, 1.0, (1.12, 30, 30), ARB_LIVE),
    ("private", "xexplorer", 53.0, 54.16, 1.0, (1.12, 30, 30), LIVE),
    # 05b Aubelle's dress paid with NVDA (the lender pool's Aqua maker), then with ETH
    ("stocks", "shop3", 32.0, 45.0, 13.0 / 5.25, None),
    ("stocks", "ethpay4", 5.0, 22.5, 17.5 / 5.25, None),
    # 05c pay later, privately (Noren Merchant sees "Private"), the World ID Orb check, the live CCIP run
    ("later", "privcredit-m", 1.5, 9.5, 4.0, None, ARC_FORK),
    ("later", "@world", 0.0, 2.0, 1.0, None, WORLD),
    ("later", "xexplorer", 88.0, 91.0, 1.0, (1.2, 50, 10), CCIP_LIVE),
]

# The World ID shot: the real verification in World App (record/takes/world.events.json)
_W = _os.path.join(_os.path.dirname(__file__), "..", "record", "takes", "world.events.json")
_wev = _json.load(open(_W))["events"] if _os.path.exists(_W) else []
WORLD_VERIFIED = next((e["t"] for e in _wev if e["type"] == "world-verified"), None)
if WORLD_VERIFIED is None:
    raise SystemExit("record/takes/world.events.json has no world-verified event")
SEGMENTS = [(s[0], "world", WORLD_VERIFIED - 0.3, WORLD_VERIFIED + 1.7, 1.0, None, WORLD) if s[1] == "@world" else s for s in SEGMENTS]

# Captions: (absolute start, duration, text)
CAPTIONS = [
    (15.1, 2.5, "Privy sign-in (email or wallet)"),
    (17.7, 2.9, "demo continues with an injected test wallet on local forks"),
    (20.7, 3.2, "Signed in with SIWE (EIP-4361): a signature, no transaction"),
    (24.0, 4.0, "Store registered on Arc: <em>NorenCheckout.registerMerchant</em>"),
    (28.1, 1.9, "First payment link: 12.50 {usdc} USDC"),
    (30.1, 4.7, "API keys; the secret is shown once <em>(redacted here)</em>"),
    (35.3, 7.0, "Aubelle: a demo shop in <em>examples/shop</em>"),
    (42.6, 5.2, "<em>server/noren.ts</em>: the whole integration"),
    (48.0, 3.9, "Four ways to pay: private · USDC · <em>stocks or crypto</em> · later"),
    (52.2, 3.8, "Noren app: Privy sign-in shown · connect the injected test wallet"),
    (56.2, 3.3, "Home: private, Arc, Robinhood and credit balances"),
    (59.7, 4.2, "Paste a Noren link · pay 12.50 {usdc} privately in the app"),
    (64.1, 5.8, "USDC from any chain to Arc: Ethereum · Base · Arbitrum · Robinhood"),
    (70.05, 3.9, "Live: Ethereum Sepolia → Arc, 0.5 {usdc} USDC in 31 s"),
    (74.05, 3.4, "Live: Base Sepolia → Arc in 19 s"),
    (77.55, 3.4, "Live: Arbitrum Sepolia → Arc in 16 s"),
    (81.05, 4.9, "Live from the app: Robinhood → Arc, minted by NorenArcHook"),
    (86.1, 3.65, "Stocks → USDC on Arc: a cross-chain Aqua order (fork demo)"),
    (98.1, 3.0, "Deposit 2 {nvda} NVDA into the Aqua pool"),
    (101.15, 2.8, "Your stock is now <em>1inch Aqua liquidity</em>"),
    (104.1, 3.75, "Credit limit $245.97: 66% of your NVDA"),
    (107.95, 3.55, "World ID QR · up to 80% with World ID and repayment history"),
    (111.6, 3.55, "Reclaim (zkTLS): a credit-score proof · waiting for the phone"),
    (115.3, 2.85, "Repaid on time (real fork txs) → 70% · on-chain: proof type only"),
    (118.25, 3.9, "Lock more NVDA: limit $391.63 → $522.07"),
    (122.25, 3.7, "Credit line 391.51 {usdc} USDC, live on Arc via Chainlink CRE"),
    (126.05, 3.9, "Pay later at checkout: 20.00 {usdc} USDC, privately"),
    (130.05, 2.9, "Fees from 3 real Aqua fills pay it down: 20.00 → 19.75"),
    (133.1, 2.85, "Swap: Uniswap v4 first; Noren's Aqua maker when it's better"),
    (136.1, 3.6, "Checkout opens on <em>Pay privately</em>, the default"),
    (139.8, 4.2, "Shield 20 {usdc} · proof in the browser · payer in the tx: <em>none</em>"),
    (144.1, 2.9, "Noren Merchant: Customer: <em>Private</em>"),
    (147.1, 2.35, "Live: Arbitrum SHIELD burn → private invoice on Arc"),
    (149.6, 5.1, "Pay $148 with 0.788045 {nvda} NVDA at $188.41"),
    (154.8, 5.15, "Or with ETH: 0.06693 {eth} ETH at $2,217.87 · paid"),
    (160.05, 1.9, "Pay later, privately · Customer: <em>Private</em>"),
    (162.05, 1.9, "World ID verified in World App (Orb)"),
    (164.05, 2.9, "Live over CCIP: Robinhood testnet → Base hub → Arc"),
]

# Drawn cards (facts copied from the named source)
CARDS = {
    "xchain": {
        "kind": "diagram",
        "source": "docs/CCTP.md · docs/AQUA-LIVE.md · docs/CCIP.md",
        "title": "Any chain ⇄ Arc",
        "left": (["eth.svg", "base.svg", "arbitrum.svg", "robinhood-chain.png"], "Any chain"),
        "right": ("arc.svg", "Arc"),
        "lanes": [
            ("circle.svg", "usdc.svg", "Circle CCTP V2", "USDC from any chain: burn → Circle attests → NorenArcHook mints on Arc", "live on testnets", ["eth.svg", "base.svg", "arbitrum.svg", "robinhood-chain.png"]),
            ("1inch.svg", "nvda.svg", "Cross-chain Aqua order", "Stocks → USDC: escrow → Chainlink CRE → Aqua maker settles on Arc", "fork demo", ["robinhood-chain.png"]),
            ("chainlink.svg", None, "Chainlink CCIP", "Credit messages: Robinhood → Base Sepolia hub → Arc", "live on testnets", ["robinhood-chain.png", "base.svg"]),
        ],
    },

}

# Voice-over clips (absolute start). v4 is split at a sentence: v4 (home, pay, bridge) and v4c (stocks, the three rails).
VO = [("v1", 0.0), ("v2", 15.5), ("v3", 35.2), ("v4", 52.2), ("v4c", 86.2), ("v4b", 98.4), ("v4d", 123.3), ("v4s", 132.6), ("v5a", 136.3), ("v5b", 149.6), ("v5c-verified", 160.15), ("v6", 167.4)]

POPS = []

# Redaction boxes over the Noren Merchant secret key (onboard take), in take seconds and take pixels (1920x1080).
REDACT_TAKE = "merchant3"
REDACT = {
    "from": 25.1,
    "boxes": [(984, 422, 545, 70), (1284, 790, 196, 38)],
    "shift": [(29.3, 0), (29.467, -12), (29.533, -24), (29.567, -36), (29.6, -48), (29.633, -60), (29.667, -72), (29.733, -84), (29.767, -108), (29.8, -120), (29.833, -132), (29.867, -144), (29.933, -156), (29.967, -168), (30.0, -180), (30.033, -192), (30.067, -204), (30.133, -216), (30.167, -240), (30.233, -252), (30.267, -264), (30.333, -276), (30.367, -300), (30.433, -312), (30.467, -330), (30.533, -331), (30.567, -332), (30.667, -331), (30.8, -332)],
}

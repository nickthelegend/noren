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

# scene id -> (start, duration, chapter label, default network label)
SCENES = [
    ("intro", 0.0, 15.0, "01 · Noren", None),
    ("merchant", 15.0, 20.0, "02 · Noren Merchant", ARC_FORK),
    ("shop", 35.0, 20.0, "03 · Aubelle × Noren SDK", FORK),
    ("app", 55.0, 64.5, "04 · Noren app", FORK),
    ("private", 119.5, 15.0, "05a · USDC on Arc · private by default", ARC_FORK),
    ("stocks", 134.5, 15.0, "05b · Pay with stocks", RH),
    ("later", 149.5, 17.5, "05c · Pay later, privately · repay", FORK),
    ("tech", 167.0, 13.0, "06 · Live on public testnets", None),
]

APP_CARD = (1.42, 50, 30)
OFFSET = {"intro": 5.0}
# Segments: (scene, take, in, out, rate, zoom[, network label]). zoom = (scale, x%, y%) or (from, to); None = full frame.
# A take named "@card" is a drawn card (CARDS below), "in"/"out" only give its length.
SEGMENTS = [
    # 01 the website (re-recorded on the v3 landing)
    ("intro", "landing4", 0.9, 10.9, 1.0, None),
    # 02 Noren Merchant onboarding: the Privy modal (not completed), then the injected test wallet: SIWE, store, link, keys
    ("merchant", "merchant3", 2.0, 4.6, 1.0, None),
    ("merchant", "merchant3", 5.6, 33.0, 27.4 / 17.4, None),
    # 03 Aubelle: browse, the integration file, the hosted checkout's four ways to pay
    ("shop", "shop3", 0.5, 20.0, 2.6, None),
    ("shop", "shop", 25.5, 36.3, 1.6, ((1.0, 50, 50), (1.25, 74, 52))),
    ("shop", "shop3", 22.4, 32.0, 9.6 / (20.0 - 7.5 - 6.75), ((1.0, 50, 50), (1.18, 72, 34))),
    # 04 the Noren app at full width: Privy shown, browser wallet connected, Home, Pay privately
    ("app", "applogin3", 2.0, 4.3, 1.0, None, ARC_FORK),
    ("app", "applogin3", 6.2, 9.8, 2.0, None, ARC_FORK),
    ("app", "apphome3", 1.0, 9.4, 2.4, None, ARC_FORK),
    ("app", "apphome3", 10.5, 27.0, 16.5 / 4.5, None, ARC_FORK),
    # the hero: Robinhood -> Arc, live on public testnets from the app (CCTP V2, minted by NorenArcHook)
    ("app", "bridge3", 1.0, 13.4, 2.0, ((1.0, 50, 50), (1.3, 50, 26)), BRIDGE_LIVE),
    ("app", "bridge3", 13.4, 32.3, 3.5, None, BRIDGE_LIVE),
    ("app", "bridge3", 32.8, 36.2, 1.0, (1.25, 50, 62), BRIDGE_LIVE),
    ("app", "xexplorer3", 0.4, 2.65, 1.0, (1.12, 30, 30), RH_LIVE),
    ("app", "xexplorer3", 18.1, 20.35, 1.0, (1.12, 30, 30), LIVE),
    ("app", "stocks3", 2.2, 10.6, 2.4, None, STOCK_DEMO),
    ("app", "@xchain", 0.0, 8.5, 1.0, None, ""),
    # Loans that pay themselves down (fork): deposit = Aqua liquidity, lock, borrow 500, fees from 3 real fills repay
    ("app", "selfrepay3", 1.5, 13.5, 2.4, (1.45, 50, 32), RH),
    ("app", "selfrepay3", 20.0, 31.0, 4.4, (1.45, 50, 42), RH),
    ("app", "selfrepay3", 31.0, 50.5, 3.9, (1.45, 50, 58), RH),
    ("app", "credit", 27.0, 37.0, 10.0 / 3.0, None),
    ("app", "@world", 0.0, 2.5, 1.0, None, WORLD),
    ("app", "swap3", 0.5, 5.95, 5.45 / 2.9, None, SWAP_LIVE),
    # 05a USDC on Arc, private by default, then the live CCTP SHIELD run (docs/PRIVACY.md)
    ("private", "privdefault", 0.3, 20.3, 2.2, None),
    ("private", "privdefault", 27.2, 33.2, 2.0, (1.9, 40, 8)),
    ("private", "xexplorer", 17.6, 19.1, 1.0, (1.12, 30, 30), ARB_LIVE),
    ("private", "xexplorer", 53.0, 54.41, 1.0, (1.12, 30, 30), LIVE),
    # 05b Aubelle's dress, paid with NVDA (filled by the lender pool's Aqua maker), the shop's order page
    ("stocks", "shop3", 32.0, 45.0, 1.6, None),
    ("stocks", "shop3", 84.0, 90.875, 1.0, None),
    # 05c pay later, privately; Noren Merchant; repay (public); the live runs: Arc testnet and CCIP
    ("later", "privcredit", 1.0, 13.0, 2.0, None),
    ("later", "privcredit-m", 1.5, 9.5, 8 / 3.0, None, ARC_FORK),
    ("later", "repay3", 3.5, 9.5, 2.0, APP_CARD),
    ("later", "xexplorer2", 0.3, 2.8, 1.0, (1.12, 30, 30), LIVE),
    ("later", "xexplorer", 88.0, 91.0, 1.0, (1.2, 50, 10), CCIP_LIVE),
]

# The World ID shot: the real verification in World App (record/takes/world.events.json)
_W = _os.path.join(_os.path.dirname(__file__), "..", "record", "takes", "world.events.json")
_wev = _json.load(open(_W))["events"] if _os.path.exists(_W) else []
WORLD_VERIFIED = next((e["t"] for e in _wev if e["type"] == "world-verified"), None)
if WORLD_VERIFIED is None:
    raise SystemExit("record/takes/world.events.json has no world-verified event")
SEGMENTS = [("app", "world", WORLD_VERIFIED - 0.5, WORLD_VERIFIED + 2.0, 1.0, None, WORLD) if s[1] == "@world" else s for s in SEGMENTS]

# Captions: (absolute start, duration, text)
CAPTIONS = [
    (15.1, 2.5, "Privy sign-in (email or wallet)"),
    (17.7, 2.9, "demo continues with an injected test wallet on local forks"),
    (20.7, 3.2, "Signed in with SIWE (EIP-4361): a signature, no transaction"),
    (24.0, 4.0, "Store registered on Arc: <em>NorenCheckout.registerMerchant</em>"),
    (28.1, 1.9, "First payment link: 12.50 {usdc} USDC"),
    (30.1, 4.7, "API keys; the secret is shown once <em>(redacted here)</em>"),
    (35.3, 7.3, "Aubelle: a demo shop in <em>examples/shop</em>"),
    (42.7, 6.6, "<em>server/noren.ts</em>: the whole integration"),
    (49.4, 5.4, "Noren checkout: <em>four ways to pay</em>"),
    (55.1, 3.8, "Noren app: Privy sign-in shown · connect the injected test wallet"),
    (59.1, 3.3, "Home: private, Arc, Robinhood and credit balances"),
    (62.6, 4.3, "Paste a Noren link · pay 12.50 {usdc} privately in the app"),
    (67.1, 6.0, "Live: 0.50 {usdc} USDC, Robinhood Chain testnet → Arc testnet"),
    (73.3, 5.3, "Burn on Robinhood · Circle attests · NorenArcHook mints on Arc"),
    (78.7, 3.3, "Landed on Arc in 16 s · minted by this browser"),
    (82.1, 2.2, "Robinhood testnet: depositForBurn 0x2529…4855"),
    (84.35, 2.1, "Arc testnet: Mint 0.49993 {usdc} · 0xb360…8293"),
    (86.6, 3.3, "Stocks → USDC on Arc: a cross-chain Aqua order (fork demo)"),
    (98.6, 4.9, "Deposit 0.9 {eth} ETH: Aqua liquidity · backs loans · earns fees · runs liquidations"),
    (103.6, 2.4, "Lock it · borrow 500 {usdg} USDG"),
    (106.1, 2.4, "Your collateral keeps earning: 1.6162 {usdg} from 3 Aqua fills"),
    (108.6, 2.35, "Use earnings: debt 500 → 498.38 {usdg} USDG"),
    (111.1, 2.85, "Lock 1 {nvda} NVDA: a credit line, live on Arc via Chainlink CRE"),
    (114.05, 2.4, "World ID (Orb) verified in World App"),
    (116.55, 2.9, "Swap: Uniswap v4 first; Noren's Aqua maker when it's better"),
    (119.6, 3.8, "Checkout opens on <em>Pay privately</em>, the default"),
    (123.5, 5.0, "Shield 20 {usdc} · proof in the browser · payer in the tx: <em>none</em>"),
    (128.6, 3.0, "Noren Merchant: Customer: <em>Private</em>"),
    (131.6, 2.85, "Live: Arbitrum burn with SHIELD hook → private invoice on Arc"),
    (134.6, 7.9, "Pay $148 with 0.788045 {nvda} NVDA at $188.41"),
    (142.6, 6.8, "Filled by the lender pool's Aqua maker · order paid"),
    (149.6, 5.9, "Pay later, privately: your lender knows you, Noren Merchant doesn't"),
    (155.6, 2.9, "Noren Merchant: 12.50 {usdc} paid · Customer: <em>Private</em>"),
    (158.6, 2.9, "Repay 4.17 {usdc} in the Noren app · repayments are public"),
    (161.6, 2.4, "Live on Arc: 0.40 {usdc} paid · no borrower, no line in the tx"),
    (164.1, 2.85, "Live over CCIP: Robinhood testnet → Base hub → Arc"),
]

# Drawn cards (facts copied from the named source)
CARDS = {
    "xchain": {
        "kind": "diagram",
        "source": "docs/CCTP.md · docs/AQUA-LIVE.md · docs/CCIP.md",
        "title": "Robinhood Chain ⇄ Arc",
        "left": ("robinhood-chain.png", "Robinhood Chain"),
        "right": ("arc.svg", "Arc"),
        "lanes": [
            ("circle.svg", "usdc.svg", "Circle CCTP V2", "USDC both ways: burn → Circle attests → NorenArcHook mints", "live on testnets", ["robinhood-chain.png", "eth.svg", "base.svg", "arbitrum.svg"]),
            ("1inch.svg", "nvda.svg", "Cross-chain Aqua order", "Stocks → USDC: escrow → Chainlink CRE → Aqua maker settles on Arc", "fork demo", ["robinhood-chain.png"]),
            ("chainlink.svg", None, "Chainlink CCIP", "Credit messages: Robinhood → Base Sepolia hub → Arc", "live on testnets", ["robinhood-chain.png", "base.svg", "eth.svg"]),
        ],
    },
}

# Voice-over clips (absolute start). v4 is split at a sentence: v4 (home, pay, bridge) and v4c (stocks, the three rails).
VO = [("v1", 0.0), ("v2", 15.5), ("v3", 35.3), ("v4", 55.2), ("v4c", 86.6), ("v4b", 100.6), ("v5a", 119.6), ("v5b", 134.6), ("v5c-verified", 149.6), ("v6", 167.2)]

POPS = []

# Redaction boxes over the Noren Merchant secret key (onboard take), in take seconds and take pixels (1920x1080).
REDACT_TAKE = "merchant3"
REDACT = {
    "from": 25.1,
    "boxes": [(984, 422, 545, 70), (1284, 790, 196, 38)],
    "shift": [(29.3, 0), (29.467, -12), (29.533, -24), (29.567, -36), (29.6, -48), (29.633, -60), (29.667, -72), (29.733, -84), (29.767, -108), (29.8, -120), (29.833, -132), (29.867, -144), (29.933, -156), (29.967, -168), (30.0, -180), (30.033, -192), (30.067, -204), (30.133, -216), (30.167, -240), (30.233, -252), (30.267, -264), (30.333, -276), (30.367, -300), (30.433, -312), (30.467, -330), (30.533, -331), (30.567, -332), (30.667, -331), (30.8, -332)],
}

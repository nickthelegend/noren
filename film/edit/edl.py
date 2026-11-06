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
# ETHGlobal rules: every shot plays at 1.0x (no speed-ups), so beats are built from real-time windows of the takes,
# joined by hard jump cuts that drop the waiting. BEATS = (scene, take, [(in, out), ...], zoom, network, captions);
# captions are (seconds from the beat's start, duration, text). Segments and captions are derived below.
BEATS = [
    ("intro", "landing4", [(0.9, 10.9)], None, None, []),
    # 02 Noren Merchant: Privy modal (not completed), then the injected test wallet: SIWE, store, link, keys
    ("merchant", "merchant3", [(2.0, 4.6)], None, ARC_FORK, [(0.1, 2.5, "Privy sign-in (email or wallet)")]),
    ("merchant", "merchant3", [(5.6, 7.8), (8.9, 12.1)], None, ARC_FORK, [(0.1, 2.9, "demo continues with an injected test wallet on local forks"), (3.1, 2.3, "Signed in with SIWE (EIP-4361): no transaction")]),
    ("merchant", "merchant3", [(13.6, 16.9)], None, ARC_FORK, [(0.1, 3.1, "Store registered on Arc: <em>NorenCheckout.registerMerchant</em>")]),
    ("merchant", "merchant3", [(18.4, 22.8)], None, ARC_FORK, [(0.1, 4.2, "First payment link: 12.50 {usdc} USDC")]),
    ("merchant", "merchant3", [(25.0, 29.3)], None, ARC_FORK, [(0.1, 4.1, "API keys; the secret is shown once <em>(redacted here)</em>")]),
    # 03 Aubelle: browse, the integration file, the hosted checkout's four ways to pay
    ("shop", "shop3", [(4.0, 7.0), (10.8, 16.8)], None, FORK, [(0.1, 8.8, "Aubelle: a demo shop in <em>examples/shop</em>")]),
    ("shop", "shop", [(27.0, 31.5)], (1.25, 74, 52), FORK, [(0.1, 4.3, "<em>server/noren.ts</em>: the whole integration")]),
    ("shop", "shop3", [(25.0, 28.5)], (1.15, 72, 34), FORK, [(0.1, 3.3, "Four ways to pay: private · USDC · <em>stocks or crypto</em> · later")]),
    # 04 the Noren app: Privy shown, browser wallet connected, Home, in-app private pay
    ("app", "applogin3", [(2.0, 4.3), (6.1, 7.0), (8.7, 10.3)], None, ARC_FORK, [(0.1, 4.6, "Noren app: Privy sign-in shown · connect the injected test wallet")]),
    ("app", "apphome3", [(1.0, 4.0)], None, ARC_FORK, [(0.1, 2.8, "Home: private, Arc, Robinhood and credit balances")]),
    ("app", "apphome3", [(10.4, 13.9), (16.6, 17.4), (21.5, 22.3), (26.0, 27.4)], None, ARC_FORK, [(0.1, 6.3, "Paste a Noren link · pay 12.50 {usdc} privately in the app")]),
    # USDC from any chain to Arc: the chain chips, the live transfers from the app (public testnets)
    ("app", "bridge4", [(2.5, 8.9)], None, ANY_LIVE, [(0.1, 6.2, "USDC from any chain to Arc: Ethereum · Base · Arbitrum · Robinhood")]),
    ("app", "xexplorer4", [(0.5, 2.3)], (1.4, 0, 10), ETH_LIVE, [(0.05, 3.3, "Live: Ethereum Sepolia → Arc, 0.5 {usdc} USDC in 31 s")]),
    ("app", "xexplorer4", [(18.6, 20.2)], (1.12, 30, 30), LIVE, []),
    ("app", "xexplorer4", [(36.1, 37.6)], (1.45, 30, 12), BASE_LIVE, [(0.05, 2.85, "Live: Base Sepolia → Arc in 19 s")]),
    ("app", "xexplorer4", [(53.7, 55.1)], (1.12, 30, 30), LIVE, []),
    ("app", "xexplorer4", [(71.1, 72.6)], (1.45, 30, 12), ARB_LIVE, [(0.05, 2.85, "Live: Arbitrum Sepolia → Arc in 16 s")]),
    ("app", "xexplorer4", [(88.7, 90.1)], (1.12, 30, 30), LIVE, []),
    ("app", "bridge3", [(12.9, 14.6), (30.6, 33.0)], None, BRIDGE_LIVE, [(0.05, 1.6, "Live from the app: Robinhood → Arc"), (1.75, 2.3, "cut: 16 s for Circle · minted by NorenArcHook")]),
    ("app", "stocks3", [(2.0, 5.8)], None, STOCK_DEMO, [(0.1, 3.6, "Stocks → USDC on Arc: a cross-chain Aqua order (fork demo)")]),
    ("app", "@xchain", [(0.0, 8.2)], None, "", []),
    # Stocks -> credit (fork, real fork txs), full width with a camera that follows the pointer
    ("app", "credit4a", [(2.8, 4.6), (7.3, 8.4), (11.0, 14.5)], ("follow", 1.45, 4.2), RH, [(0.1, 6.2, "Deposit 2 {nvda} NVDA into the Aqua pool")]),
    ("app", "credit4a", [(16.0, 19.5)], ("follow", 1.45, None), RH, [(0.1, 3.3, "Your stock is now <em>1inch Aqua liquidity</em>")]),
    ("app", "credit4a", [(24.0, 25.2), (34.0, 35.9)], ("follow", 1.45, None), RH, [(0.1, 3.0, "Credit limit $245.97: 66% of your NVDA")]),
    ("app", "credit4a", [(38.9, 39.6), (42.5, 45.0)], ("follow", 1.3, None), WORLD, [(0.05, 3.1, "World ID QR · up to 80% with World ID and repayment history")]),
    ("app", "credit4a", [(51.7, 52.4), (54.0, 56.5)], ("follow", 1.3, None), RECLAIM, [(0.05, 3.1, "Reclaim (zkTLS): a credit-score proof · waiting for the phone")]),
    ("app", "credit4b", [(3.8, 5.6), (6.8, 8.6)], ("follow", 1.45, None), RH, [(0.05, 3.5, "Repaid on time (real fork txs) → 70% · on-chain: proof type only")]),
    ("app", "credit4b", [(18.3, 19.5), (30.9, 32.4)], ("follow", 1.45, None), RH, [(0.05, 2.6, "Lock more NVDA: limit $391.63 → $522.07")]),
    ("app", "credit4b", [(38.9, 40.4), (82.0, 84.0)], ("follow", 1.45, None), FORK, [(0.05, 1.4, "Open a credit line with nNVDA"), (1.55, 1.9, "cut: 42 s · 391.51 {usdc} USDC live on Arc via CRE")]),
    ("app", "credit4c", [(6.8, 7.8), (15.6, 17.4)], None, FORK, [(0.05, 2.7, "Pay later at checkout: 20.00 {usdc} USDC, privately")]),
    ("app", "credit4d", [(4.0, 5.6), (8.3, 9.7)], ("follow", 1.45, None), RH, [(0.05, 2.9, "Fees from 3 real Aqua fills pay it down: 20.00 → 19.75")]),
    ("app", "swap3", [(0.5, 3.5)], None, SWAP_LIVE, [(0.1, 2.85, "Swap: Uniswap v4 first; Noren's Aqua maker when it's better")]),
    # 05a USDC on Arc, private by default, then the live CCTP SHIELD run (docs/PRIVACY.md)
    ("private", "privdefault", [(0.5, 2.5), (4.4, 5.2), (7.7, 8.6), (14.6, 15.9), (18.6, 22.3)], None, ARC_FORK, [(0.1, 2.6, "Checkout opens on <em>Pay privately</em>, the default"), (2.8, 5.8, "Shield 20 {usdc} · proof in the browser · payer in the tx: <em>none</em>")]),
    ("private", "privdefault", [(30.2, 32.6)], (1.9, 40, 8), ARC_FORK, [(0.1, 2.25, "Noren Merchant: Customer: <em>Private</em>")]),
    ("private", "xexplorer", [(17.6, 18.85)], (1.12, 30, 30), ARB_LIVE, [(0.05, 2.35, "Live: Arbitrum SHIELD burn → private invoice on Arc")]),
    ("private", "xexplorer", [(53.0, 54.15)], (1.12, 30, 30), LIVE, []),
    # 05b Aubelle's dress paid with NVDA (the lender pool's Aqua maker), then with ETH
    ("stocks", "shop3", [(31.9, 33.0), (34.6, 36.6), (36.9, 37.6), (43.0, 44.95)], None, RH, [(0.1, 5.6, "Pay $148 with 0.788045 {nvda} NVDA at $188.41")]),
    ("stocks", "ethpay4", [(8.8, 9.6), (12.3, 13.8), (14.8, 15.4), (21.8, 23.65)], None, RH, [(0.05, 4.6, "Or with ETH: 0.06693 {eth} ETH at $2,217.87 · paid")]),
    # 05c pay later, privately (Noren Merchant sees "Private"), the World ID Orb check, the live CCIP run
    ("later", "privcredit-m", [(3.6, 5.6)], None, ARC_FORK, [(0.05, 1.9, "Pay later, privately · Customer: <em>Private</em>")]),
    ("later", "@world", [(0.0, 2.0)], None, WORLD, [(0.05, 1.9, "World ID verified in World App (Orb)")]),
    ("later", "xexplorer", [(88.0, 91.0)], (1.2, 50, 10), CCIP_LIVE, [(0.05, 2.9, "Live over CCIP: Robinhood testnet → Base hub → Arc")]),
]

# The World ID shot: the real verification in World App (record/takes/world.events.json)
_W = _os.path.join(_os.path.dirname(__file__), "..", "record", "takes", "world.events.json")
_wev = _json.load(open(_W))["events"] if _os.path.exists(_W) else []
WORLD_VERIFIED = next((e["t"] for e in _wev if e["type"] == "world-verified"), None)
if WORLD_VERIFIED is None:
    raise SystemExit("record/takes/world.events.json has no world-verified event")
_starts = {sc[0]: sc[1] + OFFSET.get(sc[0], 0.0) for sc in SCENES}
SEGMENTS, CAPTIONS = [], []
for sc, take, wins, zoom, net, caps in BEATS:
    t0 = _starts[sc]
    for (a, b) in wins:
        if take == "@world":
            seg = (sc, "world", WORLD_VERIFIED - 0.3 + a, WORLD_VERIFIED - 0.3 + b, 1.0, zoom)
        else:
            seg = (sc, take, a, b, 1.0, zoom)
        SEGMENTS.append(seg + ((net,) if net is not None else ()))
        _starts[sc] += b - a
    CAPTIONS += [(round(t0 + r, 3), d, txt) for (r, d, txt) in caps]

# Captions: (absolute start, duration, text)
# CAPTIONS are derived from BEATS above

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
VO = [("v1", 0.0), ("v2", 15.9), ("v3", 35.3), ("v4", 54.2), ("v4e", 66.4), ("v4c", 86.2), ("v4b", 99.8), ("v4d", 124.6), ("v4s", 130.2), ("v5a", 134.4), ("v5b", 146.6), ("v5c-verified", 159.0), ("v6", 167.6)]   # v6: Nick's cloned voice (ElevenLabs)

POPS = []

# Redaction boxes over the Noren Merchant secret key (onboard take), in take seconds and take pixels (1920x1080).
REDACT_TAKE = "merchant3"
REDACT = {
    "from": 25.1,
    "boxes": [(984, 422, 545, 70), (1284, 790, 196, 38)],
    "shift": [(29.3, 0), (29.467, -12), (29.533, -24), (29.567, -36), (29.6, -48), (29.633, -60), (29.667, -72), (29.733, -84), (29.767, -108), (29.8, -120), (29.833, -132), (29.867, -144), (29.933, -156), (29.967, -168), (30.0, -180), (30.033, -192), (30.067, -204), (30.133, -216), (30.167, -240), (30.233, -252), (30.267, -264), (30.333, -276), (30.367, -300), (30.433, -312), (30.467, -330), (30.533, -331), (30.567, -332), (30.667, -331), (30.8, -332)],
}

"""
The Noren film's edit decision list (v6): which real take, which seconds, and what the caption says.
Every shot is a cut of a live recording in record/takes/ (record/record.mjs), recorded on the hosted deployment
(Arc testnet; a Robinhood Chain mainnet snapshot for stocks and credit); nothing is re-staged, nothing is sped up.
{usdc} {usdg} {nvda} {eth} {eurc} in a caption become the token's real logo (assets/logos, SOURCES.md).
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

# Hosted v6 badges (never "fork"; the Robinhood side is a mainnet snapshot, not mainnet)
ARC = "Arc testnet · live"
RHS = "Robinhood Chain · mainnet snapshot"

# scene id -> (start, duration, chapter label, default network label)
SCENES = [
    ("intro", 0.0, 15.0, "01 · Noren", None),
    ("merchant", 15.0, 20.0, "02 · Noren Merchant", ARC),
    ("shop", 35.0, 19.0, "03 · Aubelle × Noren SDK", ARC),
    ("app", 54.0, 14.0, "04 · Noren app", ARC),
    ("bridge", 68.0, 28.0, "05 · USDC from any chain", ANY_LIVE),
    ("credit", 96.0, 25.3, "06 · Stocks → credit", RHS),
    ("swap", 121.3, 4.3, "07 · Swap", ARC),
    ("private", 125.6, 12.0, "08a · Pay privately, by default", ARC),
    ("stocks", 137.6, 14.4, "08b · Pay with stocks or crypto", RHS),
    ("later", 152.0, 15.0, "08c · Pay later, privately", ARC),
    ("tech", 167.0, 13.0, "09 · Live on public testnets", None),
]

APP_CARD = (1.42, 50, 30)
OFFSET = {"intro": 5.0}
# Segments: (scene, take, in, out, rate, zoom[, network label]). zoom = (scale, x%, y%) or (from, to); None = full frame.
# A take named "@card" is a drawn card (CARDS below), "in"/"out" only give its length.
# ETHGlobal rules: every shot plays at 1.0x (no speed-ups). v6 (Nick): recorded on the hosted deployment, full frame,
# one action per shot; from 1:41 no camera moves and no cuts inside an action (explorer pages keep one fixed crop that
# hides the explorer's ad slots). BEATS = (scene, take, [(in, out), ...], zoom, network, captions); captions are
# (seconds from the beat's start, duration, text). Segments and captions are derived below.
BEATS = [
    ("intro", "landing4", [(0.9, 10.9)], None, None, []),
    # 02 Noren Merchant (hosted): Privy modal (not completed), the injected test wallet (SIWE), store on Arc testnet, API keys
    ("merchant", "merchant3", [(2.0, 5.6)], None, ARC, [(0.1, 3.4, "Privy sign-in (email or wallet)")]),
    ("merchant", "merchant3", [(6.6, 12.5)], None, ARC, [(0.1, 2.6, "demo continues with an injected test wallet"), (2.8, 3.0, "Signed in with SIWE (EIP-4361): no transaction")]),
    ("merchant", "merchant3", [(13.6, 20.2)], None, ARC, [(0.1, 6.4, "Store registered on Arc testnet: <em>NorenCheckout.registerMerchant</em>")]),
    ("merchant", "merchant3", [(33.6, 37.5)], None, ARC, [(0.1, 3.7, "First link made · API keys: the secret is shown once <em>(redacted)</em>")]),
    # 03 Aubelle (hosted shop): a dress -> size -> add to bag -> bag -> Noren checkout, four ways to pay
    ("shop", "shop6", [(0.8, 3.8)], None, ARC, [(0.1, 2.8, "Aubelle: a demo shop in <em>examples/shop</em>")]),
    ("shop", "shop6", [(7.6, 15.6)], None, ARC, [(0.1, 7.8, "Pick a dress · size S · add to bag")]),
    ("shop", "shop6", [(18.0, 22.4)], None, ARC, [(0.1, 4.2, "The bag → <em>Checkout with Noren</em>")]),
    ("shop", "shop6", [(27.0, 30.6)], None, ARC, [(0.1, 3.4, "Four ways to pay: private · USDC · <em>stocks or crypto</em> · later")]),
    # 04 the Noren app (hosted): Privy shown, browser wallet, Home, in-app private pay of the merchant's link
    ("app", "applogin3", [(2.2, 4.8), (6.6, 8.2), (9.3, 12.8)], None, ARC, [(0.1, 2.4, "Noren app: Privy sign-in shown"), (2.6, 5.0, "connect the injected test wallet · Home")]),
    ("app", "apphome3", [(13.2, 17.4), (32.9, 35.0)], None, ARC, [(0.1, 6.1, "Paste the link · pay 0.50 {usdc} privately: <em>paid</em>")]),
    # 05 USDC from any chain to Arc: the chain chips, then the live CCTP runs on public explorers, then the rails card
    ("bridge", "bridge4", [(2.5, 8.9)], None, ANY_LIVE, [(0.1, 6.2, "USDC from any chain to Arc: Ethereum · Base · Arbitrum · Robinhood")]),
    ("bridge", "xexplorer4", [(0.5, 2.3)], (1.4, 0, 10), ETH_LIVE, [(0.05, 3.3, "Live: Ethereum Sepolia → Arc, 0.5 {usdc} USDC in 31 s")]),
    ("bridge", "xexplorer4", [(18.6, 20.2)], (1.12, 30, 30), LIVE, []),
    ("bridge", "xexplorer4", [(36.1, 37.6)], (1.45, 30, 12), BASE_LIVE, [(0.05, 2.85, "Live: Base Sepolia → Arc in 19 s")]),
    ("bridge", "xexplorer4", [(53.7, 55.1)], (1.12, 30, 30), LIVE, []),
    ("bridge", "xexplorer4", [(71.1, 72.6)], (1.45, 30, 12), ARB_LIVE, [(0.05, 2.85, "Live: Arbitrum Sepolia → Arc in 16 s")]),
    ("bridge", "xexplorer4", [(88.7, 90.1)], (1.12, 30, 30), LIVE, []),
    ("bridge", "@xchain", [(0.0, 12.4)], None, "", []),
    # 06 Stocks -> credit on the Robinhood Chain mainnet snapshot (hosted), one action per shot
    ("credit", "credit4a", [(4.0, 7.7)], None, RHS, [(0.1, 3.5, "Deposit stock, get credit: 66% → up to 80%")]),
    ("credit", "credit4a", [(11.5, 16.0)], None, RHS, [(0.1, 4.3, "Deposit 2 {nvda} NVDA into the Aqua pool")]),
    ("credit", "credit4a", [(17.6, 21.6)], None, RHS, [(0.1, 3.8, "Your stock is now <em>1inch Aqua liquidity</em>")]),
    ("credit", "@world", [(-3.7, 0.3)], None, WORLD, [(0.05, 3.9, "World ID: a real Orb verification in World App")]),
    ("credit", "credit4a", [(31.0, 35.2)], None, RHS, [(0.1, 1.9, "Credit limit $248.53 · tier 0 · 66%"), (2.1, 2.0, "then a repaid loan + the on-chain record → tier 1 · 70%")]),
    ("credit", "credit4a", [(24.3, 29.2)], None, RHS, [(0.1, 4.7, "Next: open the line · Pay later · NVDA fees pay it down")]),
    ("swap", "swap3", [(0.8, 5.1)], None, SWAP_LIVE, [(0.1, 4.1, "Swap: Uniswap v4 first; Noren's Aqua maker when it's better")]),
    # 08a private by default (hosted checkout, live on Arc testnet), the merchant's view, the live Arbitrum SHIELD run
    ("private", "privpay6", [(0.3, 3.3)], None, ARC, [(0.1, 2.8, "Checkout opens on <em>Pay privately</em>, the default")]),
    ("private", "privpay6", [(45.0, 49.0)], None, ARC, [(0.1, 3.8, "Shielded 1 {usdc} · proof on this device · payer in the tx: <em>none</em>")]),
    ("private", "privcredit-m", [(3.6, 6.6)], None, ARC, [(0.1, 2.8, "Noren Merchant: Customer: <em>Private</em>")]),
    ("private", "xexplorer", [(17.6, 19.6)], (1.12, 30, 30), ARB_LIVE, [(0.05, 1.9, "Live: Arbitrum SHIELD burn → private invoice on Arc")]),
    # 08b pay with stocks or crypto (hosted checkout, Robinhood Chain mainnet snapshot): the token list, one payment
    ("stocks", "stockpay6", [(4.0, 16.2)], None, RHS, [(0.1, 6.0, "Every Stock Token you hold, and ETH, at its Chainlink price"), (6.3, 5.8, "hosted snapshot today: quotes paused (stale price round)")]),
    # the hosted quote is refused today (StalePrice: the snapshot's clock was moved 24 h ahead by a test script), so the
    # payment itself is the earlier local run on the same mainnet snapshot, cropped to the checkout, and captioned so
    ("stocks", "shop3", [(42.85, 45.05)], (1.25, 50, 100), RHS + " · earlier local run", [(0.05, 2.15, "Earlier local run: paid 0.788045 {nvda} NVDA at $188.41")]),
    # 08c pay later, privately: the live Arc testnet payment, then the live CCIP run
    ("later", "xexplorer2", [(0.3, 8.3)], None, ARC, [(0.05, 7.8, "Pay later, privately: live on Arc testnet · tx 0xf3b7…723a")]),
    ("later", "xexplorer", [(88.0, 95.0)], (1.2, 50, 10), CCIP_LIVE, [(0.05, 6.9, "Live over CCIP: Robinhood testnet → Base hub → Arc")]),
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
            ("1inch.svg", "nvda.svg", "Cross-chain Aqua order", "Stocks → USDC: escrow → Chainlink CRE → Aqua maker settles on Arc", "local demo", ["robinhood-chain.png"]),
            ("chainlink.svg", None, "Chainlink CCIP", "Credit messages: Robinhood → Base Sepolia hub → Arc", "live on testnets", ["robinhood-chain.png", "base.svg"]),
        ],
    },

}

# Voice-over clips (absolute start). v4 is split at a sentence: v4 (home, pay, bridge) and v4c (stocks, the three rails).
VO = [("v1", 0.0), ("v2", 15.9), ("v3", 35.3), ("v4", 54.2), ("v4e", 68.4), ("v4c", 83.8), ("v4b", 96.3), ("v4d", 117.4), ("v4s", 121.6), ("v5a", 125.8), ("v5b", 137.9), ("v5c-verified", 152.3), ("v6", 167.6)]   # Nick's cloned voice (ElevenLabs), placed on the v6 cut

POPS = []

# Redaction boxes over the Noren Merchant secret key (onboard take), in take seconds and take pixels (1920x1080).
REDACT_TAKE = "merchant3"
REDACT = {
    "from": 33.0,
    "boxes": [(984, 424, 540, 62), (1288, 792, 186, 36)],
    "shift": [(33.0, 0)],
}

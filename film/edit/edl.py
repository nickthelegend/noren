"""
The Noren film's edit decision list (v6): which real take, which seconds, and what the caption says.
Every shot is a cut of a live recording in record/takes/ (record/record.mjs), recorded on the hosted deployment
(Arc testnet; a Robinhood Chain mainnet snapshot for stocks and credit); nothing is re-staged, nothing is sped up.
{usdc} {usdg} {nvda} {eth} {eurc} in a caption become the token's real logo (assets/logos, SOURCES.md).
"""
import json as _json, os as _os

FPS = 30
TOTAL = 229.3

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

LOCAL = "Local stack · Arc testnet fork + Robinhood Chain mainnet snapshot"

# scene id -> (start, duration, chapter label, default network label)
SCENES = [
    ("intro", 0.0, 18.8, "01 · Noren", None),
    ("merchant", 18.8, 20.0, "02 · Noren Merchant", ARC),
    ("shop", 38.8, 19.0, "03 · Aubelle × Noren SDK", ARC),
    ("app", 57.8, 14.0, "04 · Noren app", ARC),
    ("bridge", 71.8, 28.0, "05 · USDC from any chain", ANY_LIVE),
    ("earn", 99.8, 11.2, "06 · Earn: stocks as 1inch Aqua liquidity", RHS),
    ("credit", 111.0, 67.6, "07 · Stocks → credit", LOCAL),
    ("swap", 178.6, 4.3, "08 · Swap", ARC),
    ("private", 182.9, 12.0, "09a · Pay privately, by default", ARC),
    ("stocks", 194.9, 14.4, "09b · Pay with stocks or crypto", RHS),
    ("ccip", 209.3, 7.0, "09c · Credit across chains", CCIP_LIVE),
    ("tech", 216.3, 13.0, "10 · Live on public testnets", None),
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
    ("intro", "landing4", [(0.0, 13.8)], None, None, []),
    # 02 Noren Merchant (hosted): Privy modal (not completed), the injected test wallet (SIWE), store on Arc testnet, API keys
    ("merchant", "merchant3", [(2.0, 5.6)], None, ARC, [(0.1, 3.4, "Juhu Chai House signs in: Privy (email or wallet)")]),
    ("merchant", "merchant3", [(6.6, 12.5)], None, ARC, [(0.1, 2.6, "demo continues with an injected test wallet"), (2.8, 3.0, "Signed in with SIWE (EIP-4361): no transaction")]),
    ("merchant", "merchant3", [(13.6, 20.2)], None, ARC, [(0.1, 6.4, "Store registered on Arc testnet: <em>NorenCheckout.registerMerchant</em>")]),
    ("merchant", "merchant3", [(33.6, 37.5)], None, ARC, [(0.1, 3.7, "First link made · API keys: the secret is shown once <em>(redacted)</em>")]),
    # 03 Aubelle (hosted shop): a dress -> size -> add to bag -> bag -> Noren checkout, four ways to pay
    ("shop", "shop6", [(0.8, 3.8)], None, ARC, [(0.1, 2.8, "<em>Riya</em> shops at Aubelle, a demo boutique")]),
    ("shop", "shop6", [(7.6, 15.6)], None, ARC, [(0.1, 7.8, "Pick a dress · size S · add to bag")]),
    ("shop", "shop6", [(18.0, 22.4)], None, ARC, [(0.1, 4.2, "The bag → <em>Checkout with Noren</em>")]),
    ("shop", "shop6", [(27.0, 30.6)], None, ARC, [(0.1, 3.4, "Four ways to pay: private · USDC · <em>stocks or crypto</em> · later")]),
    # 04 the Noren app (hosted): Privy shown, browser wallet, Home, in-app private pay of the merchant's link
    ("app", "applogin3", [(2.2, 4.8), (6.6, 8.2), (8.5, 9.8)], None, ARC, [(0.1, 2.4, "Noren app: Privy sign-in shown"), (2.6, 2.8, "connect the injected test wallet")]),
    ("app", "apphome3", [(2.6, 4.8)], None, ARC, [(0.1, 2.1, "Home: private, Arc, Robinhood and credit balances")]),
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
    # 06 Earn (hosted snapshot): the vaults, then the Aqua maker card (backs loans, earns fees, runs liquidations)
    ("earn", "credit4a", [(8.0, 11.8)], None, RHS, [(0.1, 3.6, "Earn: deposit stock into an Aqua pool vault")]),
    ("earn", "credit4a", [(16.4, 23.8)], None, RHS, [(0.1, 7.2, "<em>1inch Aqua liquidity</em>: backs loans · earns fees · runs liquidations")]),
    # 07 Stocks -> credit, the whole flow on the local stack (real fork transactions; World ID footage is production)
    ("credit", "lockup7", [(10.8, 15.0)], None, LOCAL, [(0.1, 4.0, "Lock 1 {nvda} NVDA into the Aqua pool")]),
    ("credit", "lockup7", [(22.6, 25.6)], None, LOCAL, [(0.1, 2.8, "Credit limit: <em>$124.26</em> (66%)")]),
    ("credit", "lockup7", [(35.6, 40.0)], None, LOCAL, [(0.1, 4.2, "Lock 2 more {nvda} NVDA")]),
    ("credit", "lockup7", [(47.6, 50.6)], None, LOCAL, [(0.1, 2.8, "Credit limit: <em>$372.79</em>: it grows with every share")]),
    ("credit", "qr7", [(6.0, 10.0)], None, LOCAL, [(0.1, 3.8, "Raise your limit: World ID, the real IDKit request")]),
    ("credit", "@world", [(-2.7, 0.3)], None, WORLD, [(0.05, 2.9, "verified once per human: Nick's real Orb check, Nov 6")]),
    ("credit", "qr7", [(17.5, 21.5)], None, LOCAL, [(0.1, 3.8, "Reclaim (zkTLS): a credit-score proof · waiting for the phone")]),
    ("credit", "credit4b", [(2.6, 8.6)], None, LOCAL, [(0.1, 2.8, "On-time repayments: tier 1 · 70% · limit <em>$527.91</em>"), (3.0, 2.9, "Recorded on-chain: proof type only")]),
    ("credit", "credit4b", [(38.0, 42.2)], None, LOCAL, [(0.1, 4.0, "Lock 3.9986 nNVDA: open a 527.71 {usdc} USDC line")]),
    ("credit", "credit4b", [(81.0, 85.0)], None, LOCAL, [(0.05, 3.9, "cut: 39 s · 527.70 {usdc} USDC line opened; Chainlink CRE brings it to Arc")]),
    ("credit", "payin3", [(8.0, 11.2), (17.8, 21.0)], None, LOCAL, [(0.1, 3.0, "Pay in 3: 24.00 {usdc} USDC from the credit line"), (3.3, 3.0, "cut: 7 s · paid on credit")]),
    ("credit", "credit4c", [(5.0, 8.0), (14.2, 17.7)], None, LOCAL, [(0.1, 2.9, "Pay later, privately: 20.00 {usdc} USDC"), (3.1, 3.3, "cut: 6 s · proof 1.25 s · your address in it: <em>none</em>")]),
    ("credit", "privcredit-m7", [(3.6, 6.6)], None, LOCAL, [(0.1, 2.8, "Juhu Chai House: Customer: <em>Private</em>")]),
    ("credit", "repay3", [(3.6, 8.0)], None, LOCAL, [(0.1, 4.2, "Repay an installment: 21.33 {usdc} USDC · CRE reports it")]),
    ("credit", "credit4d", [(2.0, 9.5)], None, LOCAL, [(0.1, 7.3, "Real Aqua fills: NVDA fees pay the line down by 0.54 {usdc} USDC")]),
    ("swap", "swap3", [(0.8, 5.1)], None, SWAP_LIVE, [(0.1, 4.1, "Swap: Uniswap v4 first; Noren's Aqua maker when it's better")]),
    # 08a private by default (hosted checkout, live on Arc testnet), the merchant's view, the live Arbitrum SHIELD run
    ("private", "privpay6", [(0.3, 3.3)], None, ARC, [(0.1, 2.8, "Checkout opens on <em>Pay privately</em>, the default")]),
    ("private", "privpay6", [(45.0, 49.0)], None, ARC, [(0.1, 3.8, "Shielded 1 {usdc} · proof on this device · payer in the tx: <em>none</em>")]),
    ("private", "privcredit-m", [(3.6, 6.6)], None, ARC, [(0.1, 2.8, "Noren Merchant: Customer: <em>Private</em>")]),
    ("private", "xexplorer", [(17.6, 19.6)], (1.12, 30, 30), ARB_LIVE, [(0.05, 1.9, "Live: Arbitrum SHIELD burn → private invoice on Arc")]),
    # 08b pay with stocks or crypto (hosted checkout, Robinhood Chain mainnet snapshot): the token list, one payment
    ("stocks", "stockpay6", [(6.0, 11.0)], None, RHS, [(0.1, 4.8, "Every Stock Token you hold, and ETH, at its Chainlink price")]),
    ("stocks", "stockpay6", [(17.2, 22.9)], None, RHS, [(0.1, 5.5, "Pay 12.50 with 0.067024 {nvda} NVDA at $187.10 · 1inch Aqua maker")]),
    ("stocks", "stockpay6", [(26.6, 30.3)], None, RHS, [(0.05, 3.6, "Paid with stocks, 4 s later · tx 0x2524…46ad")]),
    # 09c credit messages across chains: the CCIP run on the public explorer
    ("ccip", "xexplorer", [(88.0, 95.0)], (1.2, 50, 10), CCIP_LIVE, [(0.05, 6.9, "Live over CCIP: Robinhood testnet → Base hub → Arc")]),
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
VO = [("v1", 0.2), ("v2", 19.1), ("v3", 39.1), ("v4", 58.1), ("v4e", 72.0), ("v4c", 87.6), ("ve", 100.0), ("c0", 111.2), ("c1", 121.0), ("c2", 128.0), ("c3", 133.0), ("c4", 136.8), ("c5", 143.9), ("c6", 151.0), ("c7", 159.3), ("c8", 167.0), ("c9", 171.5), ("v4s", 178.9), ("v5a", 183.2), ("v5b", 195.2), ("v5c", 209.6), ("v6", 216.6)]   # the story read (ElevenLabs, Nick's clone, stitched)

POPS = []

# Redaction boxes over the Noren Merchant secret key (onboard take), in take seconds and take pixels (1920x1080).
REDACT_TAKE = "merchant3"
REDACT = {
    "from": 33.0,
    "boxes": [(984, 424, 540, 62), (1288, 792, 186, 36)],
    "shift": [(33.0, 0)],
}

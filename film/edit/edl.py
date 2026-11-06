"""
The Noren film's edit decision list: which real take, which seconds, how fast, and what the caption says.
Every shot is a cut of a live recording in record/takes/ (record/record.mjs); nothing is re-staged.
Speed-ups are shown on screen ("2.4x"); captions state facts read from the takes' own logs.
"""

FPS = 30
TOTAL = 180.0

FORK = "Local forks · Arc testnet + Robinhood Chain"
RH = "Local fork · Robinhood Chain snapshot"
ARC_FORK = "Local fork · Arc testnet"
LIVE = "Arc testnet · live · public explorer"

# scene id -> (start, duration, chapter label, network label)
SCENES = [
    ("intro", 0.0, 15.0, "01 · Noren", None),
    ("merchant", 15.0, 20.0, "02 · Noren Merchant", ARC_FORK),
    ("shop", 35.0, 30.0, "03 · Aubelle × Noren SDK", FORK),
    ("app", 65.0, 45.0, "04 · Noren app", FORK),
    ("private", 110.0, 21.0, "05a · Pay privately", ARC_FORK),
    ("stocks", 131.0, 16.0, "05b · Pay with stocks", RH),
    ("later", 147.0, 18.0, "05c · Pay in 3", FORK),
    ("tech", 165.0, 15.0, "06 · Built with", None),
]

# Segments: (scene, take, in, out, rate, zoom), laid end to end from the scene start (+ OFFSET[scene])
# zoom = (scale, x%, y%) of the window to fill, or a pair (from, to) for a slow push. None = whole frame.
APP_CARD = (1.42, 50, 30)
OFFSET = {"intro": 4.0}
SEGMENTS = [
    # 01 the website (real landing page, scrolled live)
    ("intro", "landing", 2.0, 19.6, 1.6, None),
    # 02 Noren Merchant onboarding: SIWE sign-in, store, first link, API keys
    ("merchant", "onboard", 1.6, 35.6, 1.7, None),
    # 03 Aubelle: browse, Amélie Gingham, bag, the integration file, checkout
    ("shop", "shop", 0.5, 12.5, 2.4, None),
    ("shop", "shop", 12.5, 23.0, 1.5, None),
    ("shop", "shop", 25.5, 36.3, 1.2, ((1.0, 50, 50), (1.3, 74, 52))),
    ("shop", "shop", 41.0, 50.0, 1.0, None),
    # 04 Noren app
    ("app", "app", 1.5, 13.5, 1.412, ((1.0, 50, 50), (1.25, 78, 8))),     # wallet menu: test key, fork faucets
    ("app", "app", 18.0, 28.0, 2.222, APP_CARD),                         # Earn: deposit 0.5 ETH into nETH
    ("app", "app", 37.5, 42.4, 2.0, APP_CARD),                           # Swap: 100 USDG -> ETH
    ("app", "app", 42.4, 51.4, 1.8, (1.42, 50, 42)),                     # routes: Aqua maker vs Uniswap v4, swap
    ("app", "app", 56.0, 62.0, 2.0, (1.6, 50, 72)),                      # Earn: realised fees from that fill
    ("app", "app", 76.5, 80.5, 2.0, (1.42, 50, 62)),                     # Borrow: lock 0.5 nETH
    ("app", "app", 88.5, 97.5, 3.6, APP_CARD),                           # borrow 25 USDG
    ("app", "app", 98.5, 119.5, 3.0, APP_CARD),                          # Bridge: Relay/Across quotes, CRE approval
    ("app", "credit", 15.0, 37.0, 2.2, None),                            # Credit: lock 1 NVDA, signed terms, line opened
    # 05a private payment on the Arc fork, then the live payment and refund on Arc testnet
    ("private", "private", 1.0, 22.6, 1.6, None),
    ("private", "explorer", 0.3, 4.8, 1.0, (1.12, 30, 30)),
    ("private", "explorer", 18.5, 21.5, 1.0, (1.12, 30, 30)),
    # 05b pay with stocks (the Aubelle order), then the shop's order page
    ("stocks", "shop", 49.5, 70.5, 1.6, None),
    ("stocks", "order", 1.0, 3.875, 1.0, (1.15, 50, 40)),
    # 05c the credit ladder, pay in 3 from the line, the first repayment
]

# Captions: (absolute start, duration, text). <em> = serif italic accent. Facts come from the takes' logs.
CAPTIONS = [
    (15.3, 5.0, "Sign in with Ethereum (EIP-4361): a signature, no transaction"),
    (20.6, 4.6, "Store registered on Arc: <em>NorenCheckout.registerMerchant</em>"),
    (25.6, 4.8, "First payment link: 12.50 USDC"),
    (30.6, 4.2, "API keys; the secret is shown once <em>(redacted here)</em>"),
    (35.3, 4.6, "Aubelle: a demo shop in <em>examples/shop</em>"),
    (40.1, 6.6, "Amélie Gingham, size S, $148"),
    (47.1, 8.8, "<em>server/noren.ts</em>: the whole integration"),
    (56.1, 8.6, "Checkout with Noren → Noren's hosted checkout"),
    (65.3, 8.0, "A test key in this browser · fork faucets: 6 NVDA, 120 USDG, 50 USDC"),
    (73.5, 4.3, "Deposit 0.5 ETH into nETH, which backs its own 1inch Aqua maker"),
    (78.0, 7.4, "Buy ETH: the Aqua maker (0.40%) beats Uniswap v4"),
    (85.6, 3.4, "Realised: <em>0.398407 USDG</em> from 1 fill · no APY shown"),
    (89.1, 3.9, "Borrow 25 USDG against 0.5 nETH at the Chainlink price"),
    (93.1, 6.7, "Bridge: live Relay 9.97 / Across 9.99 · approved by Chainlink CRE"),
    (100.1, 5.3, "Lock 1 NVDA: 0G sealed model + EIP-712 terms → 123.15 USDC"),
    (105.5, 4.4, "Chainlink CRE writes the line to Arc: live in 6.7 s"),
    (110.3, 5.4, "Shield 20 USDC · the ASP screens the deposit"),
    (115.8, 7.0, "Proof made in the browser in 1.25 s · your address in the tx: <em>none</em>"),
    (123.6, 4.4, "Live: 2.50 USDC paid privately · tx 0x1ce6…776a"),
    (128.1, 2.8, "Live: 1.00 USDC refund to the shielded inbox"),
    (131.2, 4.6, "Pay $148 with 0.805179 NVDA at $184.59"),
    (135.9, 6.0, "Filled by a 1inch Aqua maker · Aubelle gets 148 USDG"),
    (142.0, 4.8, "Order paid · signed Noren webhook verified"),
]

# Redaction boxes over the Noren Merchant secret key (onboard take), in take seconds and take pixels (1920x1080).
# Measured from the frames: the key row sits at y=428..482 until the page scrolls at 25.5 s, then moves up 332 px.
REDACT_TAKE = "onboard"
REDACT = {
    "from": 20.45,
    "boxes": [(990, 424, 545, 64), (1192, 794, 290, 36)],
    "shift": [(25.5, 0), (25.7, -36), (26.0, -108), (26.3, -192), (26.6, -288), (26.9, -332)],
}

# ---- 05c depends on the World ID take (record/takes/world.events.json): verified, or still waiting for a scan.
import json as _json, os as _os
_W = _os.path.join(_os.path.dirname(__file__), "..", "record", "takes", "world.events.json")
_wev = _json.load(open(_W))["events"] if _os.path.exists(_W) else []
WORLD_VERIFIED = next((e["t"] for e in _wev if e["type"] == "world-verified"), None)
_first_qr = next((e["t"] for e in _wev if e["type"] == "click" and e["label"].startswith("verify with World ID")), 0.0)

if WORLD_VERIFIED is not None:
    LATER = [
        ("later", "later", 1.5, 9.5, 2.667, APP_CARD),                         # 3.0 s: the live ladder
        ("later", "world", WORLD_VERIFIED - 1.5, WORLD_VERIFIED + 3.5, 1.0, None),  # 5.0 s: the real verification lands
        ("later", "later", 26.0, 48.0, 2.75, None),                              # 8.0 s: pay in 3 from the line
        ("later", "later", 50.0, 58.0, 4.0, APP_CARD),                           # 2.0 s: repay the first part
    ]
    LATER_CAPS = [
        (147.2, 2.9, "Credit limit by reputation: $732.62 → $888.02"),
        (150.2, 4.9, "World ID verified in World App · +50 points, starter line"),
        (155.2, 7.8, "Pay in 3: 24.00 USDC from the credit line on Arc"),
        (163.1, 1.9, "Repay 8.00 USDC"),
    ]
    V5C = "v5c-verified"
else:
    LATER = [
        ("later", "later", 1.5, 9.5, 2.667, APP_CARD),                         # 3.0 s: the live ladder
        ("later", "world", _first_qr + 3.0, _first_qr + 5.5, 1.0, None),        # 2.5 s: the real IDKit request, waiting
        ("later", "@ladder", 0.0, 3.0, 1.0, None),                              # 3.0 s: every step reached, in the earn demo's fork txs
        ("later", "later", 26.0, 48.0, 2.933, None),                             # 7.5 s: pay in 3 from the line
        ("later", "later", 50.0, 58.0, 4.0, APP_CARD),                           # 2.0 s: repay the first part
    ]
    LATER_CAPS = [
        (147.2, 2.9, "Credit limit by reputation: $732.62 → $888.02"),
        (150.1, 2.4, "World ID: a real request · <em>verification pending</em>"),
        (152.6, 2.9, "Every step reached in the recorded earn demo (fork)"),
        (155.6, 7.4, "Pay in 3: 24.00 USDC from the credit line on Arc"),
        (163.1, 1.9, "Repay 8.00 USDC"),
    ]
    V5C = "v5c-wait"

# Cards drawn over the window where a segment's take is "@name" (facts copied from the named source)
CARDS = {
    "ladder": {
        "source": "packages/robinhood/demo/earn-demo-transcript.txt · fork of Robinhood Chain mainnet",
        "title": "Credit limit, every step reached",
        "rows": [
            ("Deposits only", "66%", "$1,708.82", "depositETH 0x9cad4717…"),
            ("+ World ID", "70%", "$1,839.95", "verifyHuman 0xf880f869…"),
            ("+ 3 on-time installments", "75%", "$1,969.59", "0x149fdea5…"),
            ("+ a repaid loan", "80%", "$2,099.23", "0x9a760b40…"),
        ],
    }
}

# Voice-over clips (absolute start). Text lives in vo/*.txt; assets/vo/*.wav are Kokoro af_heart.
VO = [("v1", 0.5), ("v2", 15.4), ("v3", 38.4), ("v4", 65.4), ("v5a", 110.2), ("v5b", 131.4), (V5C, 147.4), ("v6", 165.6)]

# Extra sound on visible results (absolute seconds): a soft pop when a real result lands on screen.
POPS = []

SEGMENTS += LATER
CAPTIONS += LATER_CAPS
